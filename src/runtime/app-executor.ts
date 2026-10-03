/** Gateway-opened channel streams as HTTP exchanges: one stream is one request to the agent's own
 *  app server, dialled by the agent — the gateway never holds the upstream address. Every request
 *  carries this process's key, which is how that server tells them from any other caller's. */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { ClientRequest, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex, Readable, Writable } from "node:stream";

import {
    APP_CHUNK,
    APP_CREDIT,
    APP_DETAIL_MAX,
    APP_HEADER_COUNT,
    APP_HEADER_MAX,
    APP_IDLE_MS,
    APP_MAX_STREAMS,
    APP_STALL_MS,
    APP_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    decodeAppRequestHeader,
} from "@mimi-os/protocol";
import type { AppStreamError, AppStreamPort, ChannelStreamFrame } from "@mimi-os/protocol";

export interface AppExecutorOptions {
    /** The one app this agent registered; the executor serves nothing else. */
    app: { appId: string; upstream: string };
    log: (msg: string) => void;
    /** Tests only: the upstream's deadline to answer with a head. Default APP_IDLE_MS. */
    idleMs?: number | undefined;
    /** Tests only: how long one stream may sit on an empty window. Default APP_STALL_MS. */
    stallMs?: number | undefined;
}

export interface AppExecutor {
    /** `port` is the same instance for every frame of `stream`. */
    frame(stream: number, frame: ChannelStreamFrame, port: AppStreamPort): void;
    /** The channel socket went: abort every live upstream request. */
    closed(): void;
}

/** Not a second cleanHeaders: the agent refuses to be wedged by what it hands node:http. */
const HOP_BY_HOP = new Set(["connection", "transfer-encoding", "upgrade"]);
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
// x-mimi-* is the gateway's namespace: it drops every client-sent one, so only this process can set it
const APP_KEY_HEADER = "x-mimi-app-key";
const APP_KEY = randomBytes(32).toString("base64url");
const upstreamHosts = new Set<string>();

/** True only for a request this process's executor sent: its key, and the Host of an upstream it dials. */
export function fromGateway(req: IncomingMessage): boolean {
    const key = req.headers[APP_KEY_HEADER];
    if (typeof key !== "string" || !upstreamHosts.has(req.headers.host ?? "")) return false;
    const given = Buffer.from(key);
    const expected = Buffer.from(APP_KEY);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `listener` behind fromGateway(); any other caller gets a bare 403. An Express app is a listener too. */
export function gatewayOnly(
    listener: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        if (fromGateway(req)) listener(req, res);
        else res.writeHead(403).end();
    };
}

/** Tests only: count `upstream` as one this process dials, and return the header its executor sends. */
export function gatewayHeaders(upstream: string): Record<string, string> {
    upstreamHosts.add(new URL(upstream).host);
    return { [APP_KEY_HEADER]: APP_KEY };
}

interface Live {
    stream: number;
    port: AppStreamPort;
    /** The upstream request until a 101 reply, the raw socket after it. */
    sink: Writable | null;
    /** The upstream reply once there is one — paused while the gateway withholds credit. */
    source: Readable | null;
    upgrade: boolean;
    head: boolean;
    /** The last sink.write() returned true, or a drain has fired since. */
    ready: boolean;
    /** Request bytes taken from the gateway and not yet credited back. */
    sinceCredit: number;
    inEnded: boolean;
    outEnded: boolean;
    idle: NodeJS.Timeout | null;
    /** Armed while the reply is blocked on an empty window: the gateway stopped crediting. */
    stall: NodeJS.Timeout | null;
    done: boolean;
}

export function createAppExecutor(opts: AppExecutorOptions): AppExecutor {
    const base = new URL(opts.app.upstream);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new Error(`app.upstream must be an http(s) URL — got ${opts.app.upstream}`);
    }
    if (base.username !== "" || base.password !== "") throw new Error("app.upstream must carry no credentials");
    upstreamHosts.add(base.host);
    const basePath = base.pathname.replace(/\/+$/, "");
    const idleMs = opts.idleMs ?? APP_IDLE_MS;
    const stallMs = opts.stallMs ?? APP_STALL_MS;
    const streams = new Map<number, Live>();

    /** Local teardown — the deadlines, the slot and the upstream socket. Idempotent. */
    const close = (live: Live): void => {
        if (live.idle) clearTimeout(live.idle);
        if (live.stall) clearTimeout(live.stall);
        live.idle = null;
        live.stall = null;
        live.done = true;
        streams.delete(live.stream);
        live.sink?.destroy();
        live.source?.destroy();
    };

    const reset = (live: Live): void => {
        if (live.done) return;
        close(live);
        live.port.reset();
    };

    /** Before a head the agent names the failure; after one, a reset is its only way out. */
    const fail = (live: Live, code: AppStreamError, detail: string): void => {
        if (live.done) return;
        if (live.head) {
            reset(live);
            return;
        }
        opts.log(`[app] stream ${live.stream} ${code} — ${detail}\n`);
        const reply = { t: "error", code, detail: detail.slice(0, APP_DETAIL_MAX) };
        live.port.send({ flags: FLAG_DATA, payload: encoder.encode(JSON.stringify(reply)) });
        live.port.send({ flags: FLAG_END, payload: EMPTY });
        close(live);
    };

    const arm = (live: Live): void => {
        if (live.idle) clearTimeout(live.idle);
        live.idle = setTimeout(() => fail(live, "upstream_timeout", "the app's server stopped answering"), idleMs);
        live.idle.unref();
    };

    /** One credit per quantum the upstream took, so the gateway never has more than a window in flight. */
    const credit = (live: Live): void => {
        while (!live.done && live.ready && live.sinceCredit >= APP_CREDIT) {
            live.sinceCredit -= APP_CREDIT;
            live.port.send({ flags: FLAG_DATA, payload: EMPTY });
        }
    };

    const pump = (live: Live, chunk: Uint8Array): void => {
        let ready = true;
        let offset = 0;
        while (offset < chunk.length && ready) {
            ready = live.port.send({ flags: FLAG_DATA, payload: chunk.subarray(offset, offset + APP_CHUNK) });
            offset += APP_CHUNK;
        }
        if (ready || live.source === null) return;
        live.source.pause();
        // the window closed mid-chunk: what is left goes back, so the wire never passes APP_WINDOW + APP_CHUNK
        if (offset < chunk.length) live.source.unshift(chunk.subarray(offset));
        live.stall ??= setTimeout(() => reset(live), stallMs).unref();
        live.port.onDrain(() => {
            if (live.stall) clearTimeout(live.stall);
            live.stall = null;
            live.source?.resume();
        });
    };

    const end = (live: Live): void => {
        if (live.done || live.outEnded) return;
        live.outEnded = true;
        // the reply is over: only the request side is left, and the gateway's own deadlines cover it
        if (live.idle) clearTimeout(live.idle);
        live.idle = null;
        live.port.send({ flags: FLAG_END, payload: EMPTY });
        if (live.inEnded) close(live);
    };

    /** One frame is one record: an oversized head is refused here, never handed to session.send. */
    const head = (live: Live, status: number, raw: IncomingHttpHeaders): boolean => {
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(raw)) if (value !== undefined) headers[name] = value;
        const clamped = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502;
        const payload = encoder.encode(JSON.stringify({ t: "head", status: clamped, headers }));
        if (payload.length > APP_HEADER_MAX || Object.keys(headers).length > APP_HEADER_COUNT) {
            fail(live, "bad_upstream", `the app answered a ${payload.length}-byte head of ${Object.keys(headers).length} entries`);
            return false;
        }
        live.head = true;
        live.port.send({ flags: FLAG_DATA, payload });
        return true;
    };

    const respond = (live: Live, reply: IncomingMessage): void => {
        if (live.done) {
            reply.destroy();
            return;
        }
        if (!head(live, reply.statusCode ?? 0, reply.headers)) return;
        // past the head a quiet reply is legitimate (SSE, a long poll): only the stall deadline or a reset ends it
        if (live.idle) clearTimeout(live.idle);
        live.idle = null;
        live.source = reply;
        reply.on("data", (chunk: Buffer) => pump(live, chunk));
        reply.on("end", () => end(live));
        reply.on("close", () => {
            if (!reply.complete) reset(live);
        });
    };

    const upgraded = (live: Live, reply: IncomingMessage, socket: Duplex, first: Buffer): void => {
        if (live.done) {
            socket.destroy();
            return;
        }
        // past a 101 a quiet socket is legitimate, and every frame either way is raw bytes
        if (live.idle) clearTimeout(live.idle);
        live.idle = null;
        if (!head(live, reply.statusCode ?? 101, reply.headers)) {
            socket.destroy();
            return;
        }
        live.sink = socket;
        live.source = socket;
        // after an upgrade Node emits drain on the socket, not on the request
        socket.on("drain", () => {
            live.ready = true;
            credit(live);
        });
        if (first.length > 0) pump(live, first);
        socket.on("data", (chunk: Buffer) => pump(live, chunk));
        socket.on("end", () => end(live));
        socket.on("error", () => reset(live));
        socket.on("close", () => reset(live));
    };

    const open = (stream: number, frame: ChannelStreamFrame, port: AppStreamPort): void => {
        if ((frame.flags & FLAG_RESET) !== 0) return; // a reset for a stream nobody holds is never answered
        if (frame.flags !== FLAG_DATA || frame.payload.length === 0 || streams.size >= APP_MAX_STREAMS) {
            port.reset();
            return;
        }
        let header;
        try {
            header = decodeAppRequestHeader(frame.payload);
        } catch (error) {
            opts.log(`[app] stream ${stream} — ${String(error)}\n`);
            port.reset();
            return;
        }
        const live: Live = {
            stream,
            port,
            sink: null,
            source: null,
            upgrade: header.mode === "upgrade",
            head: false,
            ready: true,
            sinceCredit: 0,
            inEnded: false,
            outEnded: false,
            idle: null,
            stall: null,
            done: false,
        };
        streams.set(stream, live);
        if (header.appId !== opts.app.appId) {
            fail(live, "no_app", `this agent serves ${opts.app.appId}, not ${header.appId}`);
            return;
        }
        // the agent holds the real address, so it is the only side that can check the path against it
        const url = new URL(basePath + header.path, base.origin);
        const inside = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
        if (url.origin !== base.origin || !inside) {
            fail(live, "no_app", `${header.path} leaves ${basePath}/`);
            return;
        }
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(header.headers)) {
            const lower = name.toLowerCase();
            if ((!live.upgrade && HOP_BY_HOP.has(lower)) || lower === "host" || lower === APP_KEY_HEADER) continue;
            headers[name] = value;
        }
        headers["host"] = base.host;
        headers[APP_KEY_HEADER] = APP_KEY;
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = send({
            protocol: url.protocol,
            // an IPv6 host is bracketed in a URL and unbracketed in request options
            hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
            port: url.port,
            method: header.method,
            path: `${url.pathname}${url.search}`,
            headers,
        });
        live.sink = req;
        req.on("error", (error) => fail(live, "unreachable", error.message));
        req.on("drain", () => {
            live.ready = true;
            credit(live);
        });
        req.on("response", (reply) => respond(live, reply));
        if (live.upgrade) {
            req.on("upgrade", (reply, socket, first) => upgraded(live, reply, socket, first));
            req.end(); // a handshake carries no body, and the gateway sends no END before the 101
        }
        arm(live);
    };

    return {
        frame(stream, frame, port): void {
            const live = streams.get(stream);
            if (!live) {
                open(stream, frame, port);
                return;
            }
            if ((frame.flags & FLAG_RESET) !== 0) {
                close(live);
                return;
            }
            if (frame.flags === FLAG_DATA && frame.payload.length === 0) return; // credit, applied by the port
            // a handshake carries no body and no END: before the 101 the request is already ended
            if (live.inEnded || live.sink === null || (live.upgrade && !live.head)) {
                reset(live);
                return;
            }
            if (frame.payload.length > 0) {
                live.sinceCredit += frame.payload.length;
                if (live.sinceCredit > APP_WINDOW + APP_CHUNK) {
                    reset(live); // the gateway ignored the window
                    return;
                }
                const sink = live.sink;
                // node:http frames no body for DELETE or OPTIONS unless it is sized: an unsized one goes chunked
                if (sink instanceof ClientRequest && !sink.headersSent && !sink.hasHeader("content-length")) {
                    sink.setHeader("transfer-encoding", "chunked");
                }
                live.ready = sink.write(frame.payload);
                // an upload still flowing before the head is not idle; after the head nothing is armed
                if (live.idle) arm(live);
                credit(live);
            }
            if ((frame.flags & FLAG_END) === 0) return;
            live.inEnded = true;
            live.sink.end();
            if (live.outEnded) close(live);
        },
        closed(): void {
            for (const live of [...streams.values()]) close(live);
        },
    };
}

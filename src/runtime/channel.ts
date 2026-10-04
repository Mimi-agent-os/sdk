/** The agent's transport: a binary WebSocket driven by the channel core's ClientSession, and the pairing flow that enrolls a fresh identity with the gateway. */

import {
    APP_CREDIT,
    APP_WINDOW,
    ClientSession,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    PairingInitiator,
    PROTOCOL_VERSION,
    parseInviteUri,
} from "@mimi-os/protocol";
import type { AppStreamPort, ChannelStreamFrame, ClientEvent } from "@mimi-os/protocol";

import { RefusedError, type SocketLike } from "../client.ts";
import type { AppExecutor } from "./app-executor.ts";

/** The slice of the WebSocket API both a real socket and the in-memory test double implement. */
export interface BinarySocket {
    binaryType?: string;
    readyState: number;
    send(data: Uint8Array): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
}

export type BinarySocketFactory = new (url: string) => BinarySocket;

export interface ChannelSocketOptions {
    url: string;
    secret: Uint8Array;
    gatewayPub: Uint8Array;
    log?: (msg: string) => void;
    /** Streams > 0 the gateway opens for this agent's app. Absent ⇒ they are RESET. */
    appStreams?: AppExecutor | undefined;
    /** Test seam: an in-memory WebSocket double instead of the global one. */
    WebSocket?: BinarySocketFactory;
}

export interface EnrollOptions {
    /** ws://host:port/channel/pair?invite=<id> */
    url: string;
    secret: Uint8Array;
    /** mimi://pair/v2 uri */
    invite: string;
    name: string;
    log?: (msg: string) => void;
    WebSocket?: BinarySocketFactory;
}

const MAX_CHUNK = 16 * 1024;
// The gateway closes stream-0 messages above 1 MiB; enforce the same boundary before buffering or sending them.
const MAX_MESSAGE = 1024 * 1024;
const PAIRING_TIMEOUT_MS = 15_000;
const EMPTY = new Uint8Array(0);

/** One gateway-opened stream's transport state: the window it writes into, and where it stands. */
interface AppStreamState {
    port: AppStreamPort;
    /** A zero-payload DATA frame from the gateway: the window is open again. */
    credit(): void;
    inEnded: boolean;
    outEnded: boolean;
}

function openBinary(url: string, ctor: BinarySocketFactory | undefined): BinarySocket {
    const Ctor =
        ctor ?? (globalThis as unknown as { WebSocket?: BinarySocketFactory }).WebSocket;
    if (!Ctor) throw new Error("no global WebSocket — the SDK needs Node 24+");
    const ws = new Ctor(url);
    ws.binaryType = "arraybuffer";
    return ws;
}

function toBytes(data: unknown): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError("channel socket received a non-binary message");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/** WebSocket.close accepts only 1000 or 3000-4999; any other code throws InvalidAccessError. Coerce
 *  an illegal or absent code to a clean no-code close, and never let closing a dead socket throw. */
function safeClose(ws: BinarySocket, code?: number, reason?: string): void {
    try {
        if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) ws.close(code, reason);
        else ws.close();
    } catch {
        /* the socket may already be gone */
    }
}

/** A SocketLike over `/channel`: frames each send() as one stream-0 message, reassembles the reply the same way. */
export function channelSocket(options: ChannelSocketOptions): SocketLike {
    const log = options.log ?? ((): void => undefined);
    const session = new ClientSession({
        s: options.secret,
        gatewayPub: options.gatewayPub,
        protocol: PROTOCOL_VERSION,
    });
    let ws: BinarySocket;
    try {
        ws = openBinary(options.url, options.WebSocket);
    } catch (error) {
        session.destroy();
        throw error;
    }
    let pieces: Uint8Array[] = [];
    let pieceBytes = 0;
    const ports = new Map<number, AppStreamState>();
    let closed = false;
    let closeNotified = false;
    let wsOpened = false;
    let received = false;

    const self: SocketLike = {
        readyState: 0, // WebSocket.CONNECTING — stays so until the session itself reports ready
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(text: string): void {
            if (closed || self.readyState !== 1) throw new Error("channel socket is not open");
            const bytes = new TextEncoder().encode(text);
            if (bytes.length > MAX_MESSAGE) throw new Error(`channel message exceeds ${MAX_MESSAGE} bytes`);
            let offset = 0;
            try {
                do {
                    const end = Math.min(offset + MAX_CHUNK, bytes.length);
                    const flags = end === bytes.length ? FLAG_END : FLAG_DATA;
                    const frame: ChannelStreamFrame = { stream: 0, flags, payload: bytes.subarray(offset, end) };
                    for (const chunk of session.send(frame)) ws.send(chunk);
                    offset = end;
                } while (offset < bytes.length);
            } catch (error) {
                fail(error);
                throw asError(error);
            }
        },
        close(code, reason): void {
            if (closed) return;
            cleanup();
            safeClose(ws, code, reason);
        },
    };

    function cleanup(): void {
        if (closed) return;
        closed = true;
        self.readyState = 3; // WebSocket.CLOSED
        pieces = [];
        pieceBytes = 0;
        ports.clear();
        options.appStreams?.closed();
        session.destroy();
    }

    function notifyClose(event: unknown): void {
        cleanup();
        if (closeNotified) return;
        closeNotified = true;
        self.onclose?.(event);
    }

    function fail(error: unknown): void {
        if (closed) return;
        const reason = asError(error);
        cleanup();
        try {
            self.onerror?.(reason);
        } finally {
            safeClose(ws); // 1002 is not a legal close() code — close cleanly instead of throwing
        }
    }

    /** One stream frame out; false means it never went, and a seal failure took the channel with it. */
    function sendFrame(frame: ChannelStreamFrame): boolean {
        if (closed) return false;
        try {
            for (const chunk of session.send(frame)) ws.send(chunk);
            return true;
        } catch (error) {
            fail(error);
            return false;
        }
    }

    function openPort(stream: number): AppStreamState {
        let unacked = 0;
        let headSent = false;
        let resume: (() => void) | null = null;
        const entry: AppStreamState = {
            inEnded: false,
            outEnded: false,
            credit(): void {
                unacked = Math.max(0, unacked - APP_CREDIT);
                if (unacked >= APP_WINDOW) return;
                const waiting = resume;
                resume = null;
                waiting?.();
            },
            port: {
                send(frame): boolean {
                    if ((frame.flags & FLAG_END) !== 0) entry.outEnded = true;
                    if (!sendFrame({ stream, ...frame })) return false;
                    // the reply head is not body, and the gateway credits body bytes only
                    if (headSent) unacked += frame.payload.length;
                    else headSent = frame.payload.length > 0;
                    if (entry.inEnded && entry.outEnded) ports.delete(stream);
                    return unacked < APP_WINDOW;
                },
                onDrain(next): void {
                    resume = next;
                },
                reset(): void {
                    ports.delete(stream);
                    sendFrame({ stream, flags: FLAG_RESET, payload: EMPTY });
                },
            },
        };
        return entry;
    }

    /** Streams > 0 are the gateway's app requests: one port per stream, for every frame of it. */
    function appFrame(frame: ChannelStreamFrame): void {
        const executor = options.appStreams;
        const stream = frame.stream;
        if (!executor) {
            if ((frame.flags & FLAG_RESET) === 0) sendFrame({ stream, flags: FLAG_RESET, payload: EMPTY });
            return;
        }
        let entry = ports.get(stream);
        if (!entry) {
            if ((frame.flags & FLAG_RESET) !== 0) return; // a reset for a stream nobody holds is never answered
            if (frame.flags === FLAG_DATA && frame.payload.length === 0) return; // a late credit opens nothing
            entry = openPort(stream);
            ports.set(stream, entry);
        }
        if ((frame.flags & FLAG_END) !== 0) entry.inEnded = true;
        if (frame.flags === FLAG_DATA && frame.payload.length === 0) entry.credit();
        executor.frame(stream, frame, entry.port);
        if ((frame.flags & FLAG_RESET) !== 0 || (entry.inEnded && entry.outEnded)) ports.delete(stream);
    }

    function handle(events: ClientEvent[]): void {
        for (const ev of events) {
            if (closed) return;
            if (ev.type === "ready") {
                // a "pending" gate exists for devices awaiting owner approval — an agent's pin is approved or it is nothing
                if (ev.info.activation === "pending") {
                    fail(new RefusedError("activation pending — not valid for an agent", "agent-key"));
                    log("[channel] gateway reports activation pending — not valid for an agent, refusing\n");
                    return;
                }
                self.readyState = 1; // WebSocket.OPEN
                self.onopen?.(undefined);
            } else if (ev.type === "frame") {
                if (ev.frame.stream !== 0) {
                    appFrame(ev.frame);
                    continue;
                }
                if ((ev.frame.flags & FLAG_RESET) !== 0) {
                    pieces = [];
                    pieceBytes = 0;
                    continue;
                }
                pieces.push(ev.frame.payload);
                pieceBytes += ev.frame.payload.length;
                if (pieceBytes > MAX_MESSAGE) {
                    fail(new Error(`channel message exceeds ${MAX_MESSAGE} bytes`));
                    return;
                }
                if ((ev.frame.flags & FLAG_END) === 0) continue;
                const joined = new Uint8Array(pieceBytes);
                let off = 0;
                for (const p of pieces) {
                    joined.set(p, off);
                    off += p.length;
                }
                pieces = [];
                pieceBytes = 0;
                self.onmessage?.({ data: new TextDecoder().decode(joined) });
            } else if (ev.type === "error") {
                const why = ev.peer === undefined
                    ? `channel: ${ev.code}`
                    : `gateway speaks protocol ${ev.peer}, this agent ${PROTOCOL_VERSION}: update one of them`;
                fail(new RefusedError(why, "protocol"));
                return;
            } else {
                // the session closes on its own only before ready, on a server info it cannot use
                fail(new RefusedError("channel: the gateway sent a server info this agent cannot use", "protocol"));
                return;
            }
        }
    }

    ws.onopen = (): void => {
        if (closed) return;
        wsOpened = true;
        try {
            for (const chunk of session.start()) ws.send(chunk);
        } catch (error) {
            fail(error);
        }
    };
    ws.onmessage = (ev): void => {
        if (closed) return;
        received = true;
        let result: ReturnType<ClientSession["feed"]>;
        try {
            result = session.feed(toBytes(ev.data));
            for (const chunk of result.out) ws.send(chunk);
        } catch (error) {
            fail(error);
            return;
        }
        const { events } = result;
        handle(events);
    };
    ws.onerror = (): void => {
        if (!closed) fail(new Error("socket error"));
    };
    ws.onclose = (event): void => {
        // both refusals close with CLOSE_NOT_PAIRED; the step the handshake reached tells a refused pin (msg2 came) from another gateway's key (nothing came)
        if (wsOpened && self.readyState === 0) {
            fail(
                received
                    ? new RefusedError("the gateway refused this agent's key — its pin was revoked, blocked, or never approved", "agent-key")
                    : new RefusedError("the gateway dropped the handshake — its key is not the one pinned in data/gateway.pub", "gateway-key"),
            );
        }
        notifyClose(event);
    };

    return self;
}

/** Runs PairingInitiator to completion and resolves with the gateway's static key, or rejects after 15 seconds. */
export async function enrollAgent(options: EnrollOptions): Promise<Uint8Array> {
    const gatewayPub = parseInviteUri(options.invite).gwPub;
    const initiator = new PairingInitiator({
        s: options.secret,
        uri: options.invite,
        deviceName: options.name,
    });
    let ws: BinarySocket;
    try {
        ws = openBinary(options.url, options.WebSocket);
    } catch (error) {
        initiator.destroy();
        throw asError(error);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error("pairing timed out")), PAIRING_TIMEOUT_MS);

        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            initiator.destroy();
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            if (error) reject(error);
            else resolve(gatewayPub);
            try {
                ws.close();
            } catch (closeError) {
                options.log?.(`[pair] socket close failed — ${String(closeError)}\n`);
            }
        };

        ws.onopen = (): void => {
            try {
                for (const chunk of initiator.start()) ws.send(chunk);
            } catch (error) {
                finish(asError(error));
            }
        };
        ws.onmessage = (ev): void => {
            let result: ReturnType<PairingInitiator["feed"]>;
            try {
                result = initiator.feed(toBytes(ev.data));
                for (const chunk of result.out) ws.send(chunk);
            } catch (error) {
                finish(asError(error));
                return;
            }
            for (const event of result.events) {
                if (event.type === "enrolled") {
                    finish();
                    options.log?.(`[pair] enrolled — sas ${event.sas}\n`);
                } else {
                    finish(new Error("pairing closed before enrollment completed"));
                }
                return;
            }
        };
        ws.onerror = (): void => finish(new Error("socket error during pairing"));
        ws.onclose = (): void => finish(new Error("socket closed before enrollment completed"));
    });
}

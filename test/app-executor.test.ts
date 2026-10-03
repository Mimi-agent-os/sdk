import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { test, type TestContext } from "node:test";

import {
    APP_CHUNK,
    APP_CREDIT,
    APP_HEADER_COUNT,
    APP_HEADER_MAX,
    APP_MAX_STREAMS,
    APP_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    decodeAppReply,
} from "@mimi-os/protocol";
import type { AppErrorReply, AppHeadReply, AppStreamPort, ChannelStreamFrame } from "@mimi-os/protocol";

import { createAppExecutor, fromGateway, gatewayHeaders, gatewayOnly, type AppExecutor } from "../src/runtime/app-executor.ts";

const EMPTY = new Uint8Array(0);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** The gateway end of one stream: it records what the executor sends and honours the same window. */
class Port implements AppStreamPort {
    sent: Array<{ flags: number; payload: Uint8Array }> = [];
    resets = 0;
    unacked = 0;
    headSent = false;
    waiting: (() => void) | null = null;

    send(frame: Omit<ChannelStreamFrame, "stream">): boolean {
        this.sent.push({ flags: frame.flags, payload: Uint8Array.from(frame.payload) });
        // the head is not body, and the gateway credits body bytes only — bridge.ts counts the same set
        if (this.headSent) this.unacked += frame.payload.length;
        else this.headSent = frame.payload.length > 0;
        return this.unacked < APP_WINDOW;
    }

    onDrain(resume: () => void): void {
        this.waiting = resume;
    }

    reset(): void {
        this.resets += 1;
    }

    /** The gateway's own credit frame: one quantum of the reply direction has room again. */
    credit(): void {
        this.unacked = Math.max(0, this.unacked - APP_CREDIT);
        if (this.unacked >= APP_WINDOW) return;
        const resume = this.waiting;
        this.waiting = null;
        resume?.();
    }

    get credits(): number {
        return this.sent.filter((f) => f.flags === FLAG_DATA && f.payload.length === 0).length;
    }

    get ended(): boolean {
        return this.sent.some((f) => (f.flags & FLAG_END) !== 0);
    }

    /** Everything after the reply head: credit frames carry no payload and never count. */
    get body(): Buffer {
        const head = this.sent.findIndex((f) => f.payload.length > 0);
        return Buffer.concat(this.sent.slice(head + 1).filter((f) => f.payload.length > 0).map((f) => Buffer.from(f.payload)));
    }
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 600; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
}

function replyOf(port: Port): AppHeadReply | AppErrorReply {
    const head = port.sent.find((f) => f.payload.length > 0);
    assert.ok(head, "the executor sent no reply");
    return decodeAppReply(head.payload);
}

function headOf(port: Port): AppHeadReply {
    const reply = replyOf(port);
    if (reply.t !== "head") assert.fail(`expected a head, got ${reply.code}`);
    return reply;
}

function errorOf(port: Port): AppErrorReply {
    const reply = replyOf(port);
    if (reply.t !== "error") assert.fail(`expected an error, got status ${reply.status}`);
    return reply;
}

/** The agent's own HTTP server, as the executor will dial it. */
async function upstream(
    t: TestContext,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; hits: IncomingMessage[] }> {
    const hits: IncomingMessage[] = [];
    const server = createServer((req, res) => {
        hits.push(req);
        handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    stopWith(t, server);
    const address = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${address.port}`, hits };
}

function stopWith(t: TestContext, server: Server): void {
    t.after(async () => {
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
}

/** One {t:"req"} header frame; the caller feeds the body and the END itself. */
function request(exec: AppExecutor, port: Port, header: Record<string, unknown>, stream = 1): void {
    const payload = encode({ t: "req", appId: "board", method: "GET", path: "/", headers: {}, ...header });
    exec.frame(stream, { stream, flags: FLAG_DATA, payload }, port);
}

function feed(exec: AppExecutor, port: Port, flags: number, payload: Uint8Array, stream = 1): void {
    exec.frame(stream, { stream, flags, payload }, port);
}

/** A caller other than the executor, on node:http because fetch never sends a Host of its own. */
function call(base: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(base, { headers }, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("a request reaches the declared upstream with its path and query, and the reply comes back as frames", async (t) => {
    const up = await upstream(t, (req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-seen": `${req.method} ${req.url ?? ""}` });
        res.end("hello");
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();

    request(exec, port, { method: "POST", path: "/orders?q=1&x=2" });
    feed(exec, port, FLAG_END, new TextEncoder().encode("{}"));
    await until(() => port.ended, "the reply to end");

    const head = headOf(port);
    assert.equal(head.status, 200);
    assert.equal(head.headers["x-seen"], "POST /orders?q=1&x=2");
    assert.equal(head.headers["content-type"], "text/plain");
    assert.equal(port.body.toString(), "hello");
    assert.equal(port.resets, 0);
});

test("an unsized body reaches the app under every method, DELETE and OPTIONS included", async (t) => {
    const up = await upstream(t, (req, res) => {
        let got = "";
        req.on("data", (chunk: Buffer) => (got += chunk.toString()));
        req.on("end", () => res.end(`${req.method} ${got}`));
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    for (const [index, method] of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].entries()) {
        const port = new Port();
        request(exec, port, { method, path: "/any" }, index + 1);
        feed(exec, port, FLAG_DATA, new TextEncoder().encode("the body"), index + 1);
        feed(exec, port, FLAG_END, EMPTY, index + 1);
        await until(() => port.ended, `${method} to be answered`);
        assert.equal(port.body.toString(), `${method} the body`);
    }
});

test("a foreign appId and a path outside the registered prefix are refused without dialling", async (t) => {
    const up = await upstream(t, (_req, res) => res.end("secret"));
    const exec = createAppExecutor({ app: { appId: "board", upstream: `${up.base}/app` }, log: () => undefined });

    const headers = [{ appId: "other" }, { path: "/../secret" }, { path: "/%2e%2e/secret" }];
    for (const [index, header] of headers.entries()) {
        const port = new Port();
        request(exec, port, header, index + 1);
        assert.equal(errorOf(port).code, "no_app");
        assert.ok(port.ended, "the refusal ends the stream");
        assert.equal(port.resets, 0);
    }
    assert.equal(up.hits.length, 0, "a refused request never reaches the app");
});

test("an IPv6 upstream is dialled with an unbracketed hostname", async (t) => {
    const server = createServer((_req, res) => {
        res.writeHead(200);
        res.end("v6 ok");
    });
    stopWith(t, server);
    const supported = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") resolve(false);
            else reject(error);
        });
        server.listen(0, "::1", () => resolve(true));
    });
    if (!supported) return;

    const address = server.address() as AddressInfo;
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://[::1]:${address.port}` },
        log: () => undefined,
    });
    const port = new Port();
    request(exec, port, { path: "/" });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the reply to end");

    assert.equal(headOf(port).status, 200);
    assert.equal(port.body.toString(), "v6 ok");
});

test("a refused connection is unreachable, a silent upstream times out, and a quiet one past its head stays open", async (t) => {
    const idle = await upstream(t, () => undefined);
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const gone = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const refused = new Port();
    const exec = createAppExecutor({ app: { appId: "board", upstream: gone }, log: () => undefined });
    request(exec, refused, { path: "/" });
    feed(exec, refused, FLAG_END, EMPTY);
    await until(() => refused.ended, "the unreachable reply");
    assert.equal(errorOf(refused).code, "unreachable");

    const slow = createAppExecutor({ app: { appId: "board", upstream: idle.base }, log: () => undefined, idleMs: 80 });
    const stalled = new Port();
    request(slow, stalled, { path: "/slow" });
    feed(slow, stalled, FLAG_END, EMPTY);
    await until(() => stalled.ended, "the idle deadline before a head");
    assert.equal(errorOf(stalled).code, "upstream_timeout");

    const streaming = await upstream(t, (_req, res) => {
        res.writeHead(200);
        res.write("first");
    });
    const midway = createAppExecutor({
        app: { appId: "board", upstream: streaming.base },
        log: () => undefined,
        idleMs: 80,
    });
    const quiet = new Port();
    request(midway, quiet, { path: "/sse" });
    feed(midway, quiet, FLAG_END, EMPTY);
    await until(() => quiet.body.toString() === "first", "the first event");
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(headOf(quiet).status, 200);
    assert.equal(quiet.resets, 0, "an SSE stream or a long poll is quiet by design once its head is out");
    assert.ok(!quiet.ended);
    midway.closed();
});

test("the idle deadline is idle, not total: a body still trickling in keeps the exchange alive", async (t) => {
    const up = await upstream(t, (req, res) => {
        let got = 0;
        req.on("data", (chunk: Buffer) => {
            got += chunk.length;
        });
        req.on("end", () => {
            res.writeHead(200);
            res.end(`got ${got}`);
        });
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined, idleMs: 120 });
    const port = new Port();
    request(exec, port, { method: "POST", path: "/write" });

    const chunk = Buffer.alloc(1024, 0x75);
    for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        feed(exec, port, FLAG_DATA, chunk);
    }
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the reply to end");

    assert.equal(headOf(port).status, 200, "an upload slower than idleMs is not an upstream_timeout");
    assert.equal(port.body.toString(), `got ${8 * chunk.length}`);
    assert.equal(port.resets, 0);
});

test("an upstream that answers before the body is done is not reset when the deadline passes", async (t) => {
    const up = await upstream(t, (req, res) => {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("too big");
        req.resume(); // the upload keeps arriving at a reply that is already finished
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined, idleMs: 80 });
    const port = new Port();
    request(exec, port, { method: "POST", path: "/write" });
    feed(exec, port, FLAG_DATA, Buffer.alloc(1024, 0x76));
    await until(() => port.ended, "the early reply to end");

    assert.equal(headOf(port).status, 413);
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(port.resets, 0, "a delivered reply must not be reset by the upstream deadline");
});

test("an upstream head past the caps is bad_upstream, and no oversized frame is ever sent", async (t) => {
    const up = await upstream(t, (_req, res) => {
        const headers: Record<string, string> = {};
        for (let i = 0; i <= APP_HEADER_COUNT; i += 1) headers[`x-pad-${i}`] = "x";
        res.writeHead(200, headers);
        res.end("body");
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();

    request(exec, port, { path: "/" });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the bad_upstream reply");

    assert.equal(errorOf(port).code, "bad_upstream");
    assert.equal(port.body.length, 0);
    for (const frame of port.sent) assert.ok(frame.payload.length <= APP_HEADER_MAX, "a frame over the cap seals no record");
});

test("a request body larger than the window streams through, credited as the upstream drains", async (t) => {
    let received = 0;
    const up = await upstream(t, (req, res) => {
        req.on("data", (chunk: Buffer) => {
            received += chunk.length;
            req.pause();
            setTimeout(() => req.resume(), 5);
        });
        req.on("end", () => {
            res.writeHead(200);
            res.end(`got ${received}`);
        });
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();
    request(exec, port, { method: "POST", path: "/write" });

    const chunk = Buffer.alloc(APP_CHUNK, 0x61);
    const total = 8 * APP_WINDOW;
    let sent = 0;
    let outstanding = 0;
    let applied = 0;
    while (sent < total) {
        while (outstanding >= APP_WINDOW) {
            await until(() => port.credits > applied, "a credit frame");
            outstanding -= (port.credits - applied) * APP_CREDIT;
            applied = port.credits;
        }
        feed(exec, port, FLAG_DATA, chunk);
        outstanding += chunk.length;
        sent += chunk.length;
    }
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the reply to end");

    assert.equal(port.body.toString(), `got ${total}`);
    assert.ok(port.credits >= 3, `the window was credited in steps, not once: ${port.credits}`);
    assert.equal(port.resets, 0);
});

test("credit is a fixed quantum: one frame per APP_CREDIT the upstream took, whatever the frame sizes", async (t) => {
    let received = 0;
    const up = await upstream(t, (req) => req.on("data", (chunk: Buffer) => (received += chunk.length)));
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    t.after(() => exec.closed());
    const port = new Port();
    request(exec, port, { method: "POST", path: "/upload" });

    for (let i = 0; i < 7; i += 1) feed(exec, port, FLAG_DATA, Buffer.alloc(10 * 1024, 0x71));
    await until(() => received === 70 * 1024, "the first 70 KiB at the upstream");
    assert.equal(port.credits, 2, "70 KiB taken is two whole quanta; the 6 KiB left over is kept, not dropped");
    feed(exec, port, FLAG_DATA, Buffer.alloc(26 * 1024, 0x72));
    await until(() => received === 96 * 1024, "the next 26 KiB");
    assert.equal(port.credits, 3);
    assert.equal(port.resets, 0);
});

test("a gateway that sends past the window without waiting is reset", async (t) => {
    const server = createSocketServer((socket) => socket.pause());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        log: () => undefined,
    });
    const port = new Port();
    request(exec, port, { method: "POST", path: "/upload" });

    const chunk = Buffer.alloc(APP_CHUNK, 0x62);
    let pushed = 0;
    while (port.resets === 0 && pushed < 8 * APP_WINDOW) {
        feed(exec, port, FLAG_DATA, chunk);
        pushed += chunk.length;
    }
    assert.equal(port.resets, 1);
    assert.ok(pushed <= 2 * APP_WINDOW, `reset after ${pushed} unacknowledged bytes`);
    assert.ok(port.sent.every((f) => f.payload.length === 0), "an ignored window is a reset, never a reply");
});

test("a reply pauses when the window closes and resumes on a credit frame", async (t) => {
    const total = 8 * APP_WINDOW;
    const up = await upstream(t, (_req, res) => {
        res.writeHead(200);
        res.end(Buffer.alloc(total, 0x63));
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();

    request(exec, port, { path: "/big" });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.body.length >= APP_WINDOW - APP_CHUNK, "the first window of the reply");
    const stalled = port.body.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(port.body.length, stalled, "nothing moves until the gateway credits");
    assert.ok(stalled <= APP_WINDOW + APP_CHUNK, `a paused reply stays inside the receiver's tolerance, got ${stalled}`);
    assert.ok(!port.ended);

    while (!port.ended) {
        port.credit();
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(port.body.length, total);
    assert.equal(port.resets, 0);
});

test("a gateway that never credits loses that stream after the stall deadline", async (t) => {
    const up = await upstream(t, (_req, res) => {
        res.writeHead(200);
        res.end(Buffer.alloc(8 * APP_WINDOW, 0x65));
    });
    const exec = createAppExecutor({
        app: { appId: "board", upstream: up.base },
        log: () => undefined,
        stallMs: 120,
    });
    const port = new Port();

    request(exec, port, { path: "/big" });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.resets === 1, "the stall deadline on a stream nobody credits");
    assert.ok(!port.ended, "a stalled stream is reset, never ended");
    assert.ok(port.body.length < 8 * APP_WINDOW, "the reply was cut, not delivered");
});

test("a reset from the gateway destroys the upstream request, and closed() aborts every live one", async (t) => {
    const gone: string[] = [];
    const up = await upstream(t, (req) => req.on("close", () => gone.push(req.url ?? "")));
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const first = new Port();
    const second = new Port();

    request(exec, first, { path: "/a" }, 1);
    feed(exec, first, FLAG_END, EMPTY, 1);
    request(exec, second, { path: "/b" }, 2);
    feed(exec, second, FLAG_END, EMPTY, 2);
    await until(() => up.hits.length === 2, "both requests at the upstream");

    feed(exec, first, FLAG_RESET, EMPTY, 1);
    await until(() => gone.includes("/a"), "the reset request's upstream socket to close");
    assert.equal(first.resets, 0, "a reset the gateway sent is never echoed back");

    exec.closed();
    await until(() => gone.includes("/b"), "the remaining upstream socket to close");
    assert.equal(second.resets, 0);
});

test("an upgrade is forwarded as a 101 and bytes pipe both ways", async (t) => {
    const server = createServer((_req, res) => {
        res.writeHead(500);
        res.end();
    });
    const raw: Duplex[] = [];
    const handshakes: IncomingMessage[] = [];
    server.on("upgrade", (req, socket) => {
        handshakes.push(req);
        raw.push(socket);
        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: abc\r\n\r\n",
        );
        socket.on("data", (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        log: () => undefined,
    });
    t.after(async () => {
        // an upgraded socket is detached from the server, so both ends outlive the exchange
        exec.closed();
        for (const socket of raw) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = new Port();

    request(exec, port, {
        path: "/ws",
        mode: "upgrade",
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" },
    });
    await until(() => port.sent.some((f) => f.payload.length > 0), "the 101 head");

    const head = headOf(port);
    assert.equal(head.status, 101);
    assert.equal(head.headers["sec-websocket-accept"], "abc");
    assert.equal(handshakes[0]!.headers["connection"], "Upgrade", "an upgrade keeps the headers http mode drops");
    assert.equal(handshakes[0]!.headers["upgrade"], "websocket");
    feed(exec, port, FLAG_DATA, new TextEncoder().encode("ping"));
    await until(() => port.body.toString().includes("echo:ping"), "the echoed socket bytes");
});

test("an upgrade takes no body and no END before its 101", async (t) => {
    const sockets: Duplex[] = [];
    const server = createServer();
    server.on("upgrade", (_req, socket: Duplex) => void sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        log: () => undefined,
    });
    const upgrade = { path: "/ws", mode: "upgrade", headers: { connection: "Upgrade", upgrade: "websocket" } };
    const early = new Port();
    request(exec, early, upgrade, 1);
    feed(exec, early, FLAG_DATA, new TextEncoder().encode("too soon"), 1);
    assert.equal(early.resets, 1);
    const ended = new Port();
    request(exec, ended, upgrade, 3);
    feed(exec, ended, FLAG_END, EMPTY, 3);
    assert.equal(ended.resets, 1);
    assert.ok([...early.sent, ...ended.sent].every((f) => f.payload.length === 0), "nothing is answered");
});

test("an upgraded socket that backs up is credited again once it drains", async (t) => {
    const TOTAL = 8 * 1024 * 1024;
    let received = 0;
    const server = createServer();
    const raw: Duplex[] = [];
    server.on("upgrade", (_req, socket: Duplex) => {
        raw.push(socket);
        socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
        // the app reads nothing until the test has seen the agent's writes back up into the socket
        socket.pause();
        socket.on("data", (chunk: Buffer) => (received += chunk.length));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        log: () => undefined,
        stallMs: 5000,
    });
    t.after(async () => {
        exec.closed();
        for (const socket of raw) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = new Port();
    request(exec, port, { path: "/ws", mode: "upgrade", headers: { connection: "Upgrade", upgrade: "websocket" } });
    await until(() => port.sent.some((f) => f.payload.length > 0), "the 101 head");

    const chunk = Buffer.alloc(APP_CHUNK, 0x77);
    let outstanding = 0;
    let applied = 0;
    let backedUp = false;
    for (let sent = 0; sent < TOTAL; sent += chunk.length) {
        while (outstanding >= APP_WINDOW) {
            for (let i = 0; i < 400 && port.credits === applied; i += 1) {
                // credit that stops while the app reads nothing is the backup under test: now let the app drain it
                if (i === 20 && !backedUp) {
                    backedUp = true;
                    raw[0]!.resume();
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.ok(port.credits > applied, `credit stopped after ${sent} bytes`);
            outstanding -= (port.credits - applied) * APP_CREDIT;
            applied = port.credits;
        }
        feed(exec, port, FLAG_DATA, chunk);
        outstanding += chunk.length;
    }
    assert.ok(backedUp, "the agent's writes never backed up into the paused socket");
    await until(() => received === TOTAL, "every byte at the app");
    assert.equal(port.resets, 0);
});

test("the executor keeps its own APP_MAX_STREAMS ceiling", async (t) => {
    const up = await upstream(t, () => undefined);
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    t.after(() => exec.closed());

    for (let stream = 1; stream <= APP_MAX_STREAMS; stream += 1) {
        const port = new Port();
        request(exec, port, { path: `/${stream}` }, stream);
        feed(exec, port, FLAG_END, EMPTY, stream);
    }
    await until(() => up.hits.length === APP_MAX_STREAMS, "every accepted stream to reach the app");

    const refused = new Port();
    request(exec, refused, { path: "/one-too-many" }, APP_MAX_STREAMS + 1);
    assert.equal(refused.resets, 1);
    assert.equal(refused.sent.length, 0, "a stream over the ceiling is reset, never answered");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(up.hits.length, APP_MAX_STREAMS, "the 65th is never dialled");
});

test("hop-by-hop request headers are dropped before node:http sees them", async (t) => {
    const up = await upstream(t, (_req, res) => {
        res.writeHead(200);
        res.end("ok");
    });
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();

    request(exec, port, {
        path: "/",
        headers: { connection: "close", "transfer-encoding": "chunked", upgrade: "websocket", "x-keep": "1" },
    });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the reply to end");

    const seen = up.hits[0]!.headers;
    assert.equal(seen["x-keep"], "1");
    assert.equal(seen["transfer-encoding"], undefined);
    assert.equal(seen["upgrade"], undefined);
    assert.notEqual(seen["connection"], "close");
});

test("a non-101 answer to an upgrade request comes back as an ordinary head", async (t) => {
    const server = createSocketServer((socket) => {
        socket.on("data", () => socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-length: 2\r\n\r\nno"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const exec = createAppExecutor({
        app: { appId: "board", upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
        log: () => undefined,
    });
    const port = new Port();

    request(exec, port, { path: "/ws", mode: "upgrade", headers: { connection: "Upgrade", upgrade: "websocket" } });
    await until(() => port.ended, "the reply to end");

    assert.equal(headOf(port).status, 426);
    assert.equal(port.body.toString(), "no");
    assert.equal(port.resets, 0);
});

test("an upstream carrying credentials is refused when the executor is built", () => {
    assert.throws(
        () => createAppExecutor({ app: { appId: "board", upstream: "http://user:secret@127.0.0.1:3377" }, log: () => undefined }),
        /credentials/,
    );
});

test("the executor sends its own key and the upstream's own Host, never the copies the gateway handed it", async (t) => {
    const up = await upstream(t, gatewayOnly((_req, res) => res.end("through")));
    const exec = createAppExecutor({ app: { appId: "board", upstream: up.base }, log: () => undefined });
    const port = new Port();

    request(exec, port, { headers: { host: "rebind.example", "X-Mimi-App-Key": "forged" } });
    feed(exec, port, FLAG_END, EMPTY);
    await until(() => port.ended, "the reply to end");

    assert.equal(headOf(port).status, 200);
    assert.equal(port.body.toString(), "through");
    assert.equal(up.hits[0]!.headers["host"], new URL(up.base).host);
    assert.notEqual(up.hits[0]!.headers["x-mimi-app-key"], "forged");
});

test("an upgrade carries the key too, so an upgrade listener can refuse every other caller", async (t) => {
    const sockets: Duplex[] = [];
    const server = createServer();
    server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
        sockets.push(socket);
        if (fromGateway(req)) socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
        else socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const exec = createAppExecutor({ app: { appId: "board", upstream: base }, log: () => undefined });
    t.after(async () => {
        exec.closed();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = new Port();

    const handshake = { connection: "Upgrade", upgrade: "websocket" };
    request(exec, port, { path: "/ws", mode: "upgrade", headers: { ...handshake, "x-mimi-app-key": "forged" } });
    await until(() => port.sent.some((f) => f.payload.length > 0), "the 101 head");

    assert.equal(headOf(port).status, 101);
    assert.equal((await call(base, handshake)).status, 403);
});

test("gatewayOnly gives a bare 403 to a caller with no key, a wrong one or another Host, and serves the executor's", async (t) => {
    const up = await upstream(t, gatewayOnly((_req, res) => res.end("the owner's files")));
    const key = gatewayHeaders(up.base);
    const [name, value] = Object.entries(key)[0]!;

    const refused = [
        {},
        { [name]: "wrong" },
        { [name]: "x".repeat(value.length) },
        { ...key, host: `rebind.example:${new URL(up.base).port}` },
        { connection: "Upgrade", upgrade: "websocket" },
    ];
    for (const headers of refused) {
        assert.deepEqual(await call(up.base, headers), { status: 403, body: "" }, JSON.stringify(headers));
    }
    assert.deepEqual(await call(up.base, key), { status: 200, body: "the owner's files" });
});

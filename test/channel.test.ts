import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { x25519 } from "@noble/curves/ed25519.js";

import {
    APP_CHUNK,
    APP_WINDOW,
    FLAG_DATA,
    FLAG_END,
    FLAG_RESET,
    PROTOCOL_VERSION,
    PairingResponder,
    ServerSession,
    decodeAppReply,
    makeInviteUri,
    newInvite,
} from "@mimi-os/protocol";
import type { AppStreamPort, ChannelStreamFrame } from "@mimi-os/protocol";

import { GatewayClient, RefusedError, type Dispatch } from "../src/client.ts";
import { createAppExecutor, type AppExecutor } from "../src/runtime/app-executor.ts";
import { channelSocket, enrollAgent } from "../src/runtime/channel.ts";
import type { BinarySocket, BinarySocketFactory } from "../src/runtime/channel.ts";

const GATEWAY_SECRET = new Uint8Array(32).fill(0x11);
const GATEWAY_PUB = x25519.getPublicKey(GATEWAY_SECRET);
const AGENT_SECRET = new Uint8Array(32).fill(0x22);

const toBytes = (data: unknown): Uint8Array =>
    data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);

/** Both ends of an in-memory duplex: send() delivers straight to the peer's onmessage, no real network involved. */
class FakeBinarySocket implements BinarySocket {
    binaryType?: string;
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    peer: FakeBinarySocket | null = null;

    send(data: Uint8Array): void {
        if (this.readyState !== 1) throw new Error("fake socket not open");
        const peer = this.peer;
        if (!peer || peer.readyState !== 1) return;
        peer.onmessage?.({ data: new Uint8Array(data).buffer });
    }

    close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.(undefined);
        const peer = this.peer;
        if (peer && peer.readyState !== 3) {
            peer.readyState = 3;
            peer.onclose?.(undefined);
        }
    }
}

/** The constructor seam: `onServer` wires whatever gateway-side machine (ServerSession, PairingResponder) drives the other end. */
function fakeWebSocket(onServer: (server: FakeBinarySocket) => void): BinarySocketFactory {
    return class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
            const server = new FakeBinarySocket();
            server.readyState = 1;
            server.peer = this;
            this.peer = server;
            onServer(server);
            // deferred so channelSocket()/enrollAgent() have already attached their handlers by the time this fires
            setTimeout(() => {
                if (this.readyState !== 0) return; // already closed before connecting
                this.readyState = 1;
                this.onopen?.(undefined);
            }, 0);
        }
    };
}

function wireServerSession(
    server: FakeBinarySocket,
    session: ServerSession,
    onFrame?: (frame: ChannelStreamFrame) => void,
): void {
    server.onmessage = (ev): void => {
        const { out, events } = session.feed(toBytes(ev.data));
        for (const chunk of out) server.send(chunk);
        for (const e of events) {
            if (e.type === "close") server.close();
            else if (e.type === "frame") onFrame?.(e.frame);
        }
    };
}

// wired like the gateway's devices.ts: a throwing feed or a session close ends the socket, a tick later
function gatewayLike(session: () => ServerSession): BinarySocketFactory {
    return fakeWebSocket((server) => {
        const s = session();
        const close = (): void => void setTimeout(() => server.close(), 0);
        server.onmessage = (ev): void => {
            let r: ReturnType<ServerSession["feed"]>;
            try {
                r = s.feed(toBytes(ev.data));
            } catch {
                close();
                return;
            }
            for (const chunk of r.out) server.send(chunk);
            if (r.events.some((e) => e.type === "close")) close();
        };
    });
}

function sendStream0(session: ServerSession, server: FakeBinarySocket, text: string): void {
    const bytes = new TextEncoder().encode(text);
    const CHUNK = 16 * 1024;
    let offset = 0;
    do {
        const end = Math.min(offset + CHUNK, bytes.length);
        const flags = end === bytes.length ? FLAG_END : FLAG_DATA;
        for (const chunk of session.send({ stream: 0, flags, payload: bytes.subarray(offset, end) })) {
            server.send(chunk);
        }
        offset = end;
    } while (offset < bytes.length);
}

test("ready → onopen, with readyState following the WebSocket constants", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((server) => wireServerSession(server, session)),
    });
    assert.equal(sock.readyState, 0);
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    assert.equal(sock.readyState, 1);
    sock.close();
});

test("a 200 KiB JSON text round-trips as chunked stream-0 messages both ways", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let serverChunks = 0;
    const pieces: Uint8Array[] = [];
    const factory = fakeWebSocket((server) => {
        wireServerSession(server, session, (frame) => {
            serverChunks++;
            pieces.push(frame.payload);
            if ((frame.flags & FLAG_END) === 0) return;
            const total = pieces.reduce((n, p) => n + p.length, 0);
            const joined = new Uint8Array(total);
            let off = 0;
            for (const p of pieces) {
                joined.set(p, off);
                off += p.length;
            }
            sendStream0(session, server, new TextDecoder().decode(joined)); // echo it straight back
        });
    });
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: factory,
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });

    const big = JSON.stringify({ id: "1", type: "chat", payload: { text: "x".repeat(200 * 1024) } });
    const reply = new Promise<string>((resolve) => {
        sock.onmessage = (ev) => resolve(ev.data as string);
    });
    sock.send(big);
    assert.equal(await reply, big);
    assert.ok(serverChunks > 1, "the message must have arrived as more than one stream-0 chunk");
    sock.close();
});

test("a stream reset discards the partial message before the next payload", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session);
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    const received = new Promise<string>((resolve) => {
        sock.onmessage = (event) => resolve(event.data as string);
    });
    const send = (frame: ChannelStreamFrame): void => {
        for (const chunk of session.send(frame)) server!.send(chunk);
    };

    send({ stream: 0, flags: FLAG_DATA, payload: new TextEncoder().encode("discard") });
    send({ stream: 0, flags: FLAG_RESET, payload: new Uint8Array() });
    send({ stream: 0, flags: FLAG_END, payload: new TextEncoder().encode("kept") });

    assert.equal(await received, "kept");
    sock.close();
});

test("a stream > 0 is reset when the agent serves no app", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    const frames: ChannelStreamFrame[] = [];
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session, (frame) => frames.push(frame));
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });

    for (const chunk of session.send({ stream: 4, flags: FLAG_DATA, payload: new TextEncoder().encode("{}") })) {
        server!.send(chunk);
    }

    assert.deepEqual(
        frames.map((f) => [f.stream, f.flags, f.payload.length]),
        [[4, FLAG_RESET, 0]],
    );
    sock.close();
});

test("an executor is handed every frame of a stream, through one port instance", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    const frames: ChannelStreamFrame[] = [];
    const seen: Array<{ stream: number; port: AppStreamPort }> = [];
    let closedCalls = 0;
    const appStreams: AppExecutor = {
        frame: (stream, _frame, port) => seen.push({ stream, port }),
        closed: () => {
            closedCalls += 1;
        },
    };
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        appStreams,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session, (frame) => frames.push(frame));
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    const send = (frame: ChannelStreamFrame): void => {
        for (const chunk of session.send(frame)) server!.send(chunk);
    };

    send({ stream: 3, flags: FLAG_DATA, payload: new TextEncoder().encode("head") });
    send({ stream: 3, flags: FLAG_DATA, payload: new TextEncoder().encode("body") });
    send({ stream: 5, flags: FLAG_DATA, payload: new TextEncoder().encode("other") });
    send({ stream: 3, flags: FLAG_END, payload: new Uint8Array() });

    assert.deepEqual(seen.map((call) => call.stream), [3, 3, 5, 3]);
    assert.equal(seen[0]!.port, seen[1]!.port, "one port for the life of the stream");
    assert.equal(seen[0]!.port, seen[3]!.port);
    assert.notEqual(seen[0]!.port, seen[2]!.port, "another stream is another port");

    seen[0]!.port.send({ flags: FLAG_DATA, payload: new TextEncoder().encode("reply") });
    assert.deepEqual(
        frames.map((f) => [f.stream, new TextDecoder().decode(f.payload)]),
        [[3, "reply"]],
    );

    sock.close();
    assert.equal(closedCalls, 1);
});

test("a port's window counts body bytes only, closes at APP_WINDOW, and a credit frame reopens one quantum", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    let port: AppStreamPort | undefined;
    const opened: number[] = [];
    const frames: ChannelStreamFrame[] = [];
    const appStreams: AppExecutor = {
        frame: (stream, _frame, given) => {
            opened.push(stream);
            port = given;
        },
        closed: () => undefined,
    };
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        appStreams,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session, (frame) => frames.push(frame));
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    const send = (frame: ChannelStreamFrame): void => {
        for (const chunk of session.send(frame)) server!.send(chunk);
    };

    // a credit that outlived its stream is dropped: it opens no port and draws no RESET
    send({ stream: 9, flags: FLAG_DATA, payload: new Uint8Array() });
    assert.deepEqual(opened, []);
    assert.deepEqual(frames, []);

    send({ stream: 1, flags: FLAG_DATA, payload: new TextEncoder().encode("head") });
    // a reply head past half the window: the gateway credits body bytes only, so it must not count here
    assert.equal(port!.send({ flags: FLAG_DATA, payload: new Uint8Array(APP_WINDOW / 2 + 1) }), true);
    const chunk = new Uint8Array(APP_CHUNK);
    let written = 0;
    while (port!.send({ flags: FLAG_DATA, payload: chunk })) written += chunk.length;
    assert.equal(written, APP_WINDOW - APP_CHUNK, "the window is what bounds an unacknowledged stream");

    let resumed = 0;
    port!.onDrain(() => {
        resumed += 1;
    });
    send({ stream: 1, flags: FLAG_DATA, payload: new Uint8Array() });

    assert.equal(resumed, 1);
    assert.equal(port!.send({ flags: FLAG_DATA, payload: chunk }), true);
    assert.equal(port!.send({ flags: FLAG_DATA, payload: chunk }), false, "one credit is APP_CREDIT, not a whole window");
    sock.close();
});

test("an app stream is served end to end by the real executor", async () => {
    const upstream = createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`seen ${req.url ?? ""}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    const frames: ChannelStreamFrame[] = [];
    const finished = Promise.withResolvers<void>();
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        appStreams: createAppExecutor({ app: { appId: "board", upstream: base }, log: () => undefined }),
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session, (frame) => {
                frames.push(frame);
                if ((frame.flags & FLAG_END) !== 0) finished.resolve();
            });
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    const send = (frame: ChannelStreamFrame): void => {
        for (const chunk of session.send(frame)) server!.send(chunk);
    };

    const header = { t: "req", appId: "board", method: "GET", path: "/orders?q=1", headers: {} };
    send({ stream: 2, flags: FLAG_DATA, payload: new TextEncoder().encode(JSON.stringify(header)) });
    send({ stream: 2, flags: FLAG_END, payload: new Uint8Array() });
    await finished.promise;

    assert.ok(frames.every((f) => f.stream === 2));
    const reply = decodeAppReply(frames[0]!.payload);
    if (reply.t !== "head") assert.fail(`expected a head, got ${reply.code}`);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-type"], "text/plain");
    const body = frames.slice(1).filter((f) => f.payload.length > 0);
    assert.equal(new TextDecoder().decode(body[0]?.payload), "seen /orders?q=1");

    sock.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

test("pending activation is refused before the channel opens", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "pending" });
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((server) => wireServerSession(server, session)),
    });
    let opened = false;
    sock.onopen = () => {
        opened = true;
    };
    const failed = new Promise<Error>((resolve) => {
        sock.onerror = (error) => resolve(error as Error);
    });

    const error = await failed;
    assert.ok(error instanceof RefusedError);
    assert.equal(error.kind, "agent-key");
    assert.match(error.message, /activation pending/);
    assert.equal(opened, false);
    assert.equal(sock.readyState, 3);
});

test("each way the gateway turns an agent away reaches onerror as a named refusal before onclose", async () => {
    const stalePub = x25519.getPublicKey(new Uint8Array(32).fill(0x33));
    const cases: Array<{ gatewayPub: Uint8Array; session: () => ServerSession; reason: RegExp }> = [
        {
            gatewayPub: stalePub,
            session: () => new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" }),
            reason: /^refused gateway-key: the gateway dropped the handshake — its key is not the one pinned in data\/gateway\.pub$/,
        },
        {
            gatewayPub: GATEWAY_PUB,
            session: () => new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "reject" }),
            reason: /^refused agent-key: the gateway refused this agent's key — its pin was revoked, blocked, or never approved$/,
        },
        {
            gatewayPub: GATEWAY_PUB,
            session: () => new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION + 1, lookup: () => "active" }),
            reason: new RegExp(`^refused protocol: gateway speaks protocol ${PROTOCOL_VERSION + 1}, this agent ${PROTOCOL_VERSION}: update one of them$`),
        },
    ];
    for (const { gatewayPub, session, reason } of cases) {
        const seen: string[] = [];
        const sock = channelSocket({ url: "ws://fake/channel", secret: AGENT_SECRET, gatewayPub, WebSocket: gatewayLike(session) });
        sock.onopen = () => seen.push("open");
        sock.onerror = (error) =>
            seen.push(error instanceof RefusedError ? `refused ${error.kind}: ${error.message}` : `error: ${String(error)}`);
        await new Promise<void>((resolve) => {
            sock.onclose = () => {
                seen.push("close");
                resolve();
            };
        });
        assert.equal(seen.length, 2, seen.join(" | "));
        assert.match(seen[0]!, reason);
        assert.equal(seen[1], "close");
    }
});

test("each kind of refusal logs its own hint once, on its third time, however long it keeps refusing", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const stalePub = x25519.getPublicKey(new Uint8Array(32).fill(0x33));
    let gateway: "refuses the key" | "has a new key" | "is unreachable" = "refuses the key";
    const unreachable = class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
            setTimeout(() => {
                this.onerror?.(undefined);
                this.onclose?.(undefined);
            }, 0);
        }
    };
    const logs: string[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => {
            throw new Error("a refused agent never reaches describe");
        },
        dispatch: {} as Dispatch,
        log: (m) => logs.push(m),
        socket: (url) =>
            channelSocket({
                url,
                secret: AGENT_SECRET,
                gatewayPub: gateway === "has a new key" ? stalePub : GATEWAY_PUB,
                WebSocket:
                    gateway === "is unreachable"
                        ? unreachable
                        : gatewayLike(
                              () =>
                                  new ServerSession({
                                      s: GATEWAY_SECRET,
                                      protocol: PROTOCOL_VERSION,
                                      lookup: () => (gateway === "refuses the key" ? "reject" : "active"),
                                  }),
                          ),
            }),
    });
    t.after(() => client.close());
    const attempt = async (): Promise<void> => {
        t.mock.timers.tick(10_000);
        await settle();
    };
    const hints = (): string[] => logs.filter((l) => l.includes("turned this agent away"));

    client.start();
    await attempt();
    gateway = "is unreachable";
    await attempt();
    gateway = "refuses the key";
    await attempt();
    assert.deepEqual(hints(), [], "an unreachable gateway is no refusal");
    await attempt();
    await attempt();
    await attempt();
    assert.equal(hints().length, 1);
    gateway = "has a new key";
    await attempt();
    await attempt();
    await attempt();
    await attempt();

    assert.equal(logs.filter((l) => l.includes("refused this agent's key — its pin was revoked, blocked, or never approved")).length, 5);
    assert.equal(logs.filter((l) => l.includes("dropped the handshake")).length, 4);
    assert.ok(logs.includes("[client] socket error\n"));
    const [pin, key, ...more] = hints();
    assert.deepEqual(more, []);
    assert.match(pin!, /it was revoked, blocked, or never paired/);
    assert.match(pin!, /A re-pair keeps a block, so a blocked agent's pin must first be revoked in the app\. Then re-pair: delete data\/gateway\.pub/);
    assert.match(key!, /The gateway's key changed since this agent pinned it/);
    assert.match(key!, /delete data\/gateway\.pub, put a fresh MIMI_INVITE in \.env and restart the agent/);
    assert.doesNotMatch(key!, /blocked/);
});

test("an agent that meets another protocol version names both versions and keeps retrying on its backoff", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(Math, "random", () => 0.5);
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const logs: string[] = [];
    let sockets = 0;
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => {
            throw new Error("a refused agent never reaches describe");
        },
        dispatch: {} as Dispatch,
        log: (m) => logs.push(m),
        socket: (url) => {
            sockets++;
            return channelSocket({
                url,
                secret: AGENT_SECRET,
                gatewayPub: GATEWAY_PUB,
                WebSocket: gatewayLike(() => new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION + 1, lookup: () => "active" })),
            });
        },
    });
    t.after(() => client.close());
    const refusal = `[client] gateway speaks protocol ${PROTOCOL_VERSION + 1}, this agent ${PROTOCOL_VERSION}: update one of them\n`;

    client.start();
    t.mock.timers.tick(0);
    await settle();
    assert.deepEqual(logs, [refusal]);
    // the normal backoff: 500 ms, then 1 s, then 2 s — never a tight loop, never a stop
    for (const wait of [500, 1000, 2000]) {
        t.mock.timers.tick(wait - 1);
        await settle();
        assert.equal(sockets, logs.filter((l) => l === refusal).length, "no retry before its delay");
        t.mock.timers.tick(1);
        await settle();
    }
    assert.equal(sockets, 4);
    assert.equal(logs.filter((l) => l === refusal).length, 4);
    assert.equal(logs.filter((l) => l.includes("speak different protocol versions")).length, 1);
    assert.equal(client.connected, false);
});

test("an agent whose pinned gateway key is stale logs the refusal, not a bare socket close", async () => {
    const stalePub = x25519.getPublicKey(new Uint8Array(32).fill(0x33));
    const logs: string[] = [];
    const logged = Promise.withResolvers<void>();
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => {
            throw new Error("a refused agent never reaches describe");
        },
        dispatch: {} as Dispatch,
        log: (m) => {
            logs.push(m);
            if (m.includes("[client]")) logged.resolve();
        },
        socket: (url) =>
            channelSocket({
                url,
                secret: AGENT_SECRET,
                gatewayPub: stalePub,
                WebSocket: gatewayLike(() => new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" })),
            }),
    });
    client.start();
    try {
        await logged.promise;
        assert.deepEqual(logs, ["[client] the gateway dropped the handshake — its key is not the one pinned in data/gateway.pub\n"]);
        assert.equal(client.connected, false);
    } finally {
        client.close();
    }
});

test("a non-binary transport message reports an error, closes once, and releases the socket", async () => {
    let server: FakeBinarySocket | undefined;
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
        }),
    });
    let closes = 0;
    let errors = 0;
    sock.onclose = () => {
        closes++;
    };
    const failed = new Promise<Error>((resolve) => {
        sock.onerror = (error) => {
            errors++;
            assert.equal(sock.readyState, 3);
            assert.throws(() => sock.send("after failure"), /not open/);
            resolve(error as Error);
        };
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    server!.peer!.onmessage?.({ data: "not binary" });

    assert.match((await failed).message, /non-binary/);
    assert.equal(sock.readyState, 3);
    assert.equal(server!.readyState, 3);
    assert.equal(closes, 1);
    server!.peer!.onmessage?.({ data: "still not binary" });
    server!.peer!.onerror?.(new Error("late error"));
    assert.equal(errors, 1);
    assert.equal(closes, 1);
});

test("close destroys channel state and never throws even when the transport close throws", () => {
    let transport: FakeBinarySocket | undefined;
    const ThrowingClose = class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
            transport = this;
        }

        override close(): void {
            throw new Error("close failed");
        }
    };
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: ThrowingClose,
    });
    let errors = 0;
    sock.onerror = () => {
        errors++;
    };

    assert.doesNotThrow(() => sock.close()); // a throwing transport close must not crash the caller
    assert.equal(sock.readyState, 3);
    transport!.onmessage?.({ data: "late message" });
    transport!.onerror?.(new Error("late error"));
    assert.equal(errors, 0);
});

test("close() coerces an illegal WebSocket close code instead of handing it to the transport", () => {
    // a real WebSocket throws InvalidAccessError on any close code that is not 1000 or 3000-4999, and FakeBinarySocket ignores the code
    const seen: (number | undefined)[] = [];
    const CodeChecking = class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
        }
        override close(code?: number): void {
            seen.push(code);
            if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
                throw new Error("invalid code");
            }
            super.close();
        }
    };
    const mk = (): { close(code?: number, reason?: string): void } =>
        channelSocket({ url: "ws://fake/channel", secret: AGENT_SECRET, gatewayPub: GATEWAY_PUB, WebSocket: CodeChecking });

    assert.doesNotThrow(() => mk().close(1002)); // reserved code → coerced to a no-code close
    assert.doesNotThrow(() => mk().close(1000)); // legal → passed through
    assert.doesNotThrow(() => mk().close(4001)); // app range → passed through
    assert.deepEqual(seen, [undefined, 1000, 4001]);
});

test("a failed transport write closes the channel instead of reusing advanced crypto state", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    const BaseSocket = fakeWebSocket((server) => wireServerSession(server, session));
    let transport: { failWrites: boolean; readyState: number } | undefined;
    const ThrowingSend = class extends BaseSocket {
        failWrites = false;

        constructor(url: string) {
            super(url);
            transport = this;
        }

        override send(data: Uint8Array): void {
            if (this.failWrites) throw new Error("send failed");
            super.send(data);
        }
    };
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: ThrowingSend,
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });
    const failed = new Promise<Error>((resolve) => {
        sock.onerror = (error) => resolve(error as Error);
    });
    transport!.failWrites = true;

    assert.throws(() => sock.send("message"), /send failed/);
    assert.match((await failed).message, /send failed/);
    assert.equal(sock.readyState, 3);
    assert.equal(transport!.readyState, 3);
});

test("stream-0 messages are capped at the gateway's 1 MiB boundary in both directions", async () => {
    const session = new ServerSession({ s: GATEWAY_SECRET, protocol: PROTOCOL_VERSION, lookup: () => "active" });
    let server: FakeBinarySocket | undefined;
    const sock = channelSocket({
        url: "ws://fake/channel",
        secret: AGENT_SECRET,
        gatewayPub: GATEWAY_PUB,
        WebSocket: fakeWebSocket((peer) => {
            server = peer;
            wireServerSession(peer, session);
        }),
    });
    await new Promise<void>((resolve) => {
        sock.onopen = () => resolve();
    });

    const oversized = "x".repeat(1024 * 1024 + 1);
    assert.throws(() => sock.send(oversized), /exceeds 1048576 bytes/);
    const failed = new Promise<Error>((resolve) => {
        sock.onerror = (error) => resolve(error as Error);
    });
    sendStream0(session, server!, oversized);

    assert.match((await failed).message, /exceeds 1048576 bytes/);
    assert.equal(sock.readyState, 3);
});

function fakePairing(responder: PairingResponder): BinarySocketFactory {
    return fakeWebSocket((server) => {
        server.onmessage = (ev): void => {
            const { out, events } = responder.feed(toBytes(ev.data));
            for (const chunk of out) server.send(chunk);
            for (const e of events) if (e.type === "closed") server.close();
        };
    });
}

test("enrollment returns the gateway key", async () => {
    const invite = newInvite(0);
    const uri = makeInviteUri(GATEWAY_PUB, invite);
    const responder = new PairingResponder({ s: GATEWAY_SECRET, invite, now: () => 0 });

    const gatewayPub = await enrollAgent({
        url: `ws://fake/channel/pair?invite=${invite.id}`,
        secret: AGENT_SECRET,
        invite: uri,
        name: "test-agent",
        WebSocket: fakePairing(responder),
    });
    assert.deepEqual(gatewayPub, GATEWAY_PUB);
});

test("a wrong invite secret rejects", async () => {
    const invite = newInvite(0);
    const responder = new PairingResponder({ s: GATEWAY_SECRET, invite, now: () => 0 });
    const wrongUri = makeInviteUri(GATEWAY_PUB, { ...invite, secret: new Uint8Array(32).fill(0x99) });

    await assert.rejects(
        enrollAgent({
            url: `ws://fake/channel/pair?invite=${invite.id}`,
            secret: AGENT_SECRET,
            invite: wrongUri,
            name: "test-agent",
            WebSocket: fakePairing(responder),
        }),
    );
});

test("a malformed invite fails before allocating a socket", async () => {
    let sockets = 0;
    const MustNotOpen = class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
            sockets++;
        }
    };
    const enrollment = enrollAgent({
        url: "ws://fake/channel/pair?invite=bad",
        secret: AGENT_SECRET,
        invite: "not-an-invite",
        name: "test-agent",
        WebSocket: MustNotOpen,
    });
    await assert.rejects(enrollment, /malformed invite uri/);
    assert.equal(sockets, 0);
});

test("a stalled enrollment times out and closes its socket", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const invite = newInvite(0);
    const uri = makeInviteUri(GATEWAY_PUB, invite);
    let transport: FakeBinarySocket | undefined;
    const NeverOpen = class extends FakeBinarySocket {
        constructor(_url: string) {
            super();
            transport = this;
        }
    };
    const enrollment = enrollAgent({
        url: `ws://fake/channel/pair?invite=${invite.id}`,
        secret: AGENT_SECRET,
        invite: uri,
        name: "test-agent",
        WebSocket: NeverOpen,
    });

    t.mock.timers.tick(15_000);

    await assert.rejects(enrollment, /pairing timed out/);
    assert.equal(transport?.readyState, 3);
});

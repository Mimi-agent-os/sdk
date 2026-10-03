import assert from "node:assert/strict";
import { test } from "node:test";

import type { DescribePayload, ModelGrant } from "@mimi-os/protocol";
import { DeniedError, GatewayClient, RefusedError, type Dispatch, type SocketLike } from "../src/client.ts";

interface AnyFrame {
    id: string;
    type: string;
    status?: string;
    payload?: unknown;
    error?: { message: string };
    deadline?: number;
}

class FakeSocket implements SocketLike {
    readyState = 0;
    closed = false;
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    send(data: string): void {
        if (this.closed) throw new Error("socket is closed");
        this.sent.push(data);
    }

    close(): void {
        this.closed = true;
        this.readyState = 3;
    }

    /** The server side of the fake. */
    accept(): void {
        this.readyState = 1;
        this.onopen?.(null);
    }

    deliver(frame: AnyFrame): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    deliverRaw(data: unknown): void {
        this.onmessage?.({ data });
    }

    drop(): void {
        this.closed = true;
        this.readyState = 3;
        this.onclose?.(null);
    }

    frames(): AnyFrame[] {
        return this.sent.map((s) => JSON.parse(s) as AnyFrame);
    }

    last(): AnyFrame {
        const f = this.frames().at(-1);
        assert.ok(f, "no frame was sent");
        return f;
    }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const DESCRIBE: DescribePayload = {
    manifest: { name: "alpha", chain: false },
    prompt: [],
    tools: [],
};

function stubDispatch(over?: Partial<Dispatch>): Dispatch {
    const nope = (): never => {
        throw new Error("not expected in this test");
    };
    return {
        invoke: nope,
        a2aInvoke: nope,
        sessionHead: nope,
        eventsAfter: nope,
        append: nope,
        sessionCreate: nope,
        sessionList: nope,
        sessionUpdate: nope,
        sessionDelete: nope,
        health: nope,
        ...over,
    };
}

function harness(
    dispatch: Dispatch,
    describeCount?: { n: number },
    onReady?: (models: ModelGrant[]) => void,
) {
    const sockets: FakeSocket[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => {
            if (describeCount) describeCount.n++;
            return DESCRIBE;
        },
        dispatch,
        onReady,
        socket: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
    });
    return { client, sockets };
}

/** Take one socket all the way to ready: hello → describe. */
async function handshake(sock: FakeSocket): Promise<void> {
    sock.accept();
    const hello = sock.frames()[0];
    assert.equal(hello?.type, "hello");
    sock.deliver({
        id: hello!.id,
        type: "hello_ok",
        status: "ok",
        payload: {},
    });
    await tick();
    const describe = sock.frames()[1];
    assert.equal(describe?.type, "describe");
    sock.deliver({
        id: describe!.id,
        type: "describe_ok",
        status: "ok",
        payload: { models: [{ id: "m1" }] },
    });
    await tick();
}

test("hello, then describe — in that order and no other", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    s.accept();

    assert.deepEqual(s.frames().map((f) => f.type), ["hello"]);
    assert.equal(client.connected, false);
    const hello = s.frames()[0]!;
    assert.deepEqual(hello.payload, { agent: "alpha" });

    s.deliver({ id: hello.id, type: "hello_ok", status: "ok", payload: {} });
    await tick();
    assert.deepEqual(s.frames().map((f) => f.type), ["hello", "describe"]);
    assert.equal(client.connected, false); // describe_ok has not landed yet

    s.deliver({ id: s.frames()[1]!.id, type: "describe_ok", status: "ok", payload: { models: [{ id: "m1" }] } });
    await tick();
    assert.equal(client.connected, true);
    assert.deepEqual(client.models(), [{ id: "m1" }]);
    assert.deepEqual(s.frames().map((f) => f.type), ["hello", "describe"]);
    client.close();
});

test("start is idempotent while a socket is active", () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    client.start();
    assert.equal(sockets.length, 1);
    client.close();
});

test("start does not open a second socket while reconnect is already scheduled", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    await handshake(sockets[0]!);

    sockets[0]!.drop();
    client.start();
    assert.equal(sockets.length, 1);
    client.close();
});

test("model grants exposed to consumers are snapshots, not mutable client state", async () => {
    let readyModels: ModelGrant[] | undefined;
    const { client, sockets } = harness(
        stubDispatch(),
        undefined,
        (models) => {
            readyModels = models;
            models[0]!.id = "changed-by-callback";
            models.push({ id: "injected" });
        },
    );
    client.start();
    await handshake(sockets[0]!);

    assert.equal(readyModels?.length, 2);
    const snapshot = client.models();
    snapshot[0]!.id = "changed-by-caller";
    snapshot.push({ id: "another" });
    assert.deepEqual(client.models(), [{ id: "m1" }]);
    client.close();
});

test("a request arriving before the handshake finishes is refused, not dispatched", async () => {
    let invoked = 0;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: () => {
                invoked++;
                return { text: "ran" };
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    s.accept();
    s.deliver({
        id: "early",
        type: "invoke",
        payload: { tool: "t", args: {} },
    });
    await tick();
    assert.equal(invoked, 0);
    const reply = s.last();
    assert.equal(reply.type, "result");
    assert.equal(reply.status, "error");
    assert.match(reply.error?.message ?? "", /handshake/);
    client.close();
});

test("invoke runs the tool and answers a result frame carrying its id", async () => {
    const seen: string[] = [];
    const { client, sockets } = harness(
        stubDispatch({
            invoke: (p) => {
                seen.push(p.tool);
                return { text: "42", data: { n: 42 } };
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({
        id: "inv-1",
        type: "invoke",
        payload: { tool: "get_time", args: {} },
    });
    await tick();
    const reply = s.last();
    assert.deepEqual(seen, ["get_time"]);
    assert.equal(reply.id, "inv-1");
    assert.equal(reply.type, "result");
    assert.equal(reply.status, "ok");
    assert.deepEqual(reply.payload, { text: "42", data: { n: 42 } });
    client.close();
});

test("the same request id is never dispatched twice", async () => {
    let invoked = 0;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: () => {
                invoked++;
                return { text: "once" };
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const frame: AnyFrame = {
        id: "inv-dup",
        type: "invoke",
        payload: { tool: "t", args: {} },
    };
    s.deliver(frame);
    s.deliver(frame);
    await tick();
    assert.equal(invoked, 1);
    assert.equal(s.frames().filter((f) => f.type === "result").length, 1);

    s.deliver(frame);
    await tick();
    assert.equal(invoked, 1);
    assert.equal(s.frames().filter((f) => f.type === "result").length, 1);
    client.close();
});

test("a passed deadline aborts the tool and answers status timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: (_p, ctx) =>
                new Promise((resolve) => {
                    ctx.signal.addEventListener("abort", () => {
                        aborted = true;
                        resolve({ text: "too late" });
                    });
                }),
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({
        id: "inv-slow",
        type: "invoke",
        payload: { tool: "slow", args: {} },
        deadline: 20,
    });
    await tick();
    t.mock.timers.tick(20);
    await tick();
    assert.equal(aborted, true);
    const reply = s.last();
    assert.equal(reply.id, "inv-slow");
    assert.equal(reply.status, "timeout");
    client.close();
});

test("a zero deadline times out without starting the tool", async () => {
    let invoked = false;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: () => {
                invoked = true;
                return { text: "must not run" };
            },
        }),
    );
    client.start();
    const socket = sockets[0]!;
    await handshake(socket);

    socket.deliver({
        id: "already-expired",
        type: "invoke",
        payload: { tool: "side_effect", args: {} },
        deadline: 0,
    });
    await tick();

    assert.equal(invoked, false);
    assert.equal(socket.last().status, "timeout");
    client.close();
});

test("deadline expiry remains a timeout when an abort-aware tool denies", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, sockets } = harness(
        stubDispatch({
            invoke: (_payload, { signal }) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(new DeniedError("stopped")), { once: true });
                }),
        }),
    );
    client.start();
    const socket = sockets[0]!;
    await handshake(socket);

    socket.deliver({
        id: "deny-on-abort",
        type: "invoke",
        payload: { tool: "slow", args: {} },
        deadline: 1,
    });
    await tick();
    t.mock.timers.tick(1);
    await tick();

    assert.equal(socket.last().status, "timeout");
    client.close();
});

test("an aborted approval request rejects without waiting for a later user decision", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const ac = new AbortController();
    const pending = client.askApprove({ label: "continue", detail: {} }, undefined, ac.signal);
    const sent = s.last();
    ac.abort(new Error("deadline"));
    await assert.rejects(pending, /deadline/);

    s.deliver({ id: sent.id, type: "ask_approve_ok", status: "ok", payload: { approved: true } });
    client.close();
});

test("store frames are answered from the dispatch table", async () => {
    const head = { session: 1, revision: 2, headSeq: 2, headHash: "ff" };
    const { client, sockets } = harness(
        stubDispatch({
            sessionHead: (p) => ({ heads: p.sessions.map(() => head) }),
            append: () => ({ head, seqs: [2] }),
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({
        id: "h1",
        type: "session_head",
        payload: { sessions: [1] },
    });
    await tick();
    assert.equal(s.last().type, "session_head_ok");
    assert.deepEqual(s.last().payload, { heads: [head] });

    s.deliver({
        id: "a1",
        type: "append",
        payload: { session: 1, events: [] },
    });
    await tick();
    assert.equal(s.last().type, "append_ok");
    assert.equal(s.last().status, "ok");
    client.close();
});

test("handler failures preserve denied vs error status without killing the socket", async () => {
    const { client, sockets } = harness(
        stubDispatch({
            invoke: (payload) => {
                if (payload.tool === "refused") throw new DeniedError("not approved");
                throw new Error("no such tool");
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);
    s.deliver({
        id: "boom",
        type: "invoke",
        payload: { tool: "nope", args: {} },
    });
    await tick();
    assert.equal(s.last().status, "error");
    assert.equal(s.last().error?.message, "no such tool");

    s.deliver({
        id: "denied",
        type: "invoke",
        payload: { tool: "refused", args: {} },
    });
    await tick();
    assert.equal(s.last().status, "denied");
    assert.equal(s.last().error?.message, "not approved");
    assert.equal(client.connected, true);
    client.close();
});

test("a dropped socket clears grants before reconnecting", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const describeCount = { n: 0 };
    const { client, sockets } = harness(stubDispatch(), describeCount);
    client.start();
    await handshake(sockets[0]!);
    assert.equal(client.connected, true);
    assert.deepEqual(client.models(), [{ id: "m1" }]);
    assert.equal(describeCount.n, 1);

    sockets[0]!.drop();
    assert.equal(client.connected, false);
    assert.deepEqual(client.models(), []);
    assert.equal(sockets.length, 1); // the retry is on a timer, not immediate

    t.mock.timers.tick(1_000); // the first backoff is 500 ms ± jitter
    assert.equal(sockets.length, 2);
    await handshake(sockets[1]!);
    assert.equal(client.connected, true);
    assert.equal(describeCount.n, 2);
    client.close();
});

test("a socket that dies mid-request rejects what was in flight instead of hanging", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const pending = client.chat({ messages: [{ role: "user", content: "hi" }] });
    const settled = pending.then(
        () => "resolved",
        (e: Error) => e.message,
    );
    s.drop();
    assert.match(await settled, /socket closed/);
    await assert.rejects(client.chat({ messages: [] }), /not connected/);
    client.close();
});

test("close() cancels automatic reconnect until start() is called again", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, sockets } = harness(stubDispatch());
    client.start();
    await handshake(sockets[0]!);
    sockets[0]!.drop();
    client.close();
    assert.equal(client.connected, false);
    t.mock.timers.tick(60_000);
    assert.equal(sockets.length, 1);

    client.start();
    assert.equal(sockets.length, 2);
    await handshake(sockets[1]!);
    assert.equal(client.connected, true);
    client.close();
});

test("a2a_call sends the payload as given and resolves to the unwrapped result", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const pending = client.a2aCall({ agent: "beta", command: "orders_recent", args: { limit: 5 } });
    const sent = s.last();
    assert.equal(sent.type, "a2a_call");
    assert.deepEqual(sent.payload, { agent: "beta", command: "orders_recent", args: { limit: 5 } });

    s.deliver({
        id: sent.id,
        type: "a2a_call_ok",
        status: "ok",
        payload: { result: { text: "3 pages", data: { count: 3 } } },
    });
    assert.deepEqual(await pending, { text: "3 pages", data: { count: 3 } });
    client.close();
});

test("a2a_call rejects with the gateway's own error message", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const pending = client.a2aCall({ agent: "beta", command: "nope", args: {} });
    const sent = s.last();
    s.deliver({
        id: sent.id,
        type: "a2a_call_ok",
        status: "denied",
        error: { message: "beta does not list command \"nope\"" },
    });
    await assert.rejects(pending, /beta does not list command "nope"/);
    client.close();
});

test("an incoming a2a_invoke is dispatched and answered as a2a_invoke_ok carrying its id", async () => {
    const seen: Array<{ from: string; command: string }> = [];
    const { client, sockets } = harness(
        stubDispatch({
            a2aInvoke: (p) => {
                seen.push({ from: p.from, command: p.command });
                return { result: { text: "done" } };
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({
        id: "ai-1",
        type: "a2a_invoke",
        payload: { from: "gamma", command: "orders_recent", args: { limit: 5 } },
    });
    await tick();
    const reply = s.last();
    assert.deepEqual(seen, [{ from: "gamma", command: "orders_recent" }]);
    assert.equal(reply.id, "ai-1");
    assert.equal(reply.type, "a2a_invoke_ok");
    assert.equal(reply.status, "ok");
    assert.deepEqual(reply.payload, { result: { text: "done" } });
    client.close();
});

test("chat sends the payload as given — model included — and resolves on chat_ok", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    const pending = client.chat({ messages: [{ role: "user", content: "hi" }], model: "m2" });
    const sent = s.last();
    assert.equal(sent.type, "chat");
    assert.deepEqual(sent.payload, { messages: [{ role: "user", content: "hi" }], model: "m2" });

    s.deliver({
        id: sent.id,
        type: "chat_ok",
        status: "ok",
        payload: { text: "hello", thinking: "", toolCalls: [], finishReason: "stop" },
    });
    const ok = await pending;
    assert.equal(ok.text, "hello");
    assert.equal(ok.finishReason, "stop");
    client.close();
});

test("an already expired outbound timeout does not send the request", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const socket = sockets[0]!;
    await handshake(socket);
    const sentBefore = socket.frames().length;

    await assert.rejects(
        client.chat({ messages: [{ role: "user", content: "do not send" }] }, 0),
        /no reply within 0ms/,
    );
    assert.equal(socket.frames().length, sentBefore);
    client.close();
});


test("invalid or unrelated replies do not settle a pending request", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    let state: "pending" | "resolved" | "rejected" = "pending";
    const observed = client.chat({ messages: [{ role: "user", content: "hi" }] }).then(
        (value) => {
            state = "resolved";
            return value;
        },
        (error: Error) => {
            state = "rejected";
            return error;
        },
    );
    const sent = s.last();
    const ignored = [
        "null",
        "42",
        '"hello"',
        JSON.stringify({ id: sent.id, type: "describe_ok", status: "ok", payload: { models: [] } }),
        JSON.stringify({ id: sent.id, type: "chat_ok", status: "wat", error: { message: "bad status" } }),
        JSON.stringify({ id: sent.id, type: "chat_ok", status: "ok" }),
        JSON.stringify({ id: sent.id, type: "chat_ok", status: "error", error: {} }),
    ];
    for (const raw of ignored) assert.doesNotThrow(() => s.deliverRaw(raw));
    await tick();
    assert.equal(state, "pending");

    s.deliver({
        id: sent.id,
        type: "chat_ok",
        status: "ok",
        payload: { text: "correct", thinking: "", toolCalls: [], finishReason: "stop" },
    });
    assert.equal((await observed as { text: string }).text, "correct");
    client.close();
});

test("an inbound invoke that finishes after close and restart does not write to the new socket", async () => {
    const release = Promise.withResolvers<{ text: string }>();
    const { client, sockets } = harness(
        stubDispatch({
            invoke: () => release.promise,
        }),
    );
    client.start();
    const first = sockets[0]!;
    await handshake(first);

    first.deliver({ id: "old-invoke", type: "invoke", payload: { tool: "slow", args: {} } });
    await tick();
    client.close();
    client.start();
    const second = sockets[1]!;
    await handshake(second);

    release.resolve({ text: "late" });
    await tick();
    assert.equal(second.frames().some((frame) => frame.id === "old-invoke"), false);
    client.close();
});

test("closing the client aborts an in-flight inbound invoke signal", async () => {
    let aborted = false;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: (_p, ctx) =>
                new Promise((resolve) => {
                    ctx.signal.addEventListener("abort", () => {
                        aborted = true;
                        resolve({ text: "aborted" });
                    });
                }),
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({ id: "abort-me", type: "invoke", payload: { tool: "slow", args: {} } });
    await tick();
    client.close();
    await tick();
    assert.equal(aborted, true);
});

test("an onReady callback failure does not discard a completed handshake", async (t) => {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => DESCRIBE,
        dispatch: stubDispatch(),
        socket: () => socket,
        log: (message) => logs.push(message),
        onReady: () => { throw new Error("consumer failed"); },
    });
    t.after(() => client.close());
    client.start();
    await handshake(socket);
    assert.equal(client.connected, true);
    assert.equal(socket.closed, false);
    assert.match(logs.join(""), /onReady.*consumer failed/);
});

test("a socket that never opens is closed and retried", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, sockets } = harness(stubDispatch());
    t.after(() => client.close());
    client.start();
    t.mock.timers.tick(15_000);
    assert.equal(sockets[0]!.closed, true);
    t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 2);
    client.close();
    t.mock.timers.tick(60_000);
    assert.equal(sockets.length, 2);
});

test("a hello the gateway denies is a refusal: the hint comes once, on the third, an error reply or a timeout never counts, and a session starts the count over", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const logs: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => DESCRIBE,
        dispatch: stubDispatch(),
        log: (m) => logs.push(m),
        socket: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
    });
    t.after(() => client.close());
    client.start();
    const hints = (): string[] => logs.filter((l) => l.includes("turned this agent away"));
    const answerHello = async (status: "denied" | "error" | "silence", message = ""): Promise<void> => {
        const s = sockets.at(-1)!;
        s.accept();
        const hello = s.frames()[0]!;
        assert.equal(hello.type, "hello");
        if (status === "silence") t.mock.timers.tick(15_000);
        else s.deliver({ id: hello.id, type: "hello_ok", status, error: { message } });
        await settle();
        t.mock.timers.tick(10_000);
    };
    const denial = 'hello: agent name "alpha" does not match the pinned identity';

    await answerHello("denied", denial);
    await answerHello("error", "hello: this socket already greeted");
    await answerHello("silence");
    await answerHello("denied", denial);
    assert.deepEqual(hints(), []);
    await answerHello("denied", denial);
    assert.equal(hints().length, 1);
    await answerHello("denied", denial);

    const text = logs.join("");
    assert.match(text, /\[client\] handshake failed — RefusedError: hello_ok: hello: agent name "alpha" does not match the pinned identity\n/);
    assert.match(text, /\[client\] handshake failed — Error: hello_ok: hello: this socket already greeted\n/);
    assert.match(text, /\[client\] handshake failed — Error: hello: no reply within 15000ms\n/);
    assert.equal(hints().length, 1, "a refusal that never clears logs its hint once, not every backoff");
    assert.match(hints()[0]!, /3 times since its last session/);
    assert.match(hints()[0]!, /denied this agent's handshake/);
    assert.match(hints()[0]!, /revoke the old pin in the app and re-pair under the new one/);

    const s = sockets.at(-1)!;
    s.accept();
    s.deliver({ id: s.frames()[0]!.id, type: "hello_ok", status: "ok", payload: {} });
    await settle();
    s.deliver({ id: s.frames()[1]!.id, type: "describe_ok", status: "ok", payload: { models: [] } });
    await settle();
    assert.equal(client.connected, true);
    s.drop();
    t.mock.timers.tick(10_000);
    await answerHello("denied", denial);
    await answerHello("denied", denial);
    assert.equal(hints().length, 1);
    await answerHello("denied", denial);
    assert.equal(hints().length, 2, "the next run of refusals after a session gets its own hint");
    assert.equal(sockets.length, 11);
});

test("a denial after ready fails only its own call: a tool that lets it through answers error with the gateway's reason", async () => {
    let calls: Promise<unknown> | undefined;
    const { client, sockets } = harness(
        stubDispatch({
            invoke: async () => {
                calls = client.chat({ messages: [] });
                await calls;
                return { text: "unreachable" };
            },
        }),
    );
    client.start();
    const s = sockets[0]!;
    await handshake(s);
    s.deliver({ id: "inv-1", type: "invoke", payload: { tool: "summarize", args: {} } });
    await tick();
    const chat = s.last();
    assert.equal(chat.type, "chat");
    s.deliver({
        id: chat.id,
        type: "chat_ok",
        status: "denied",
        error: { message: '"alpha" is paused — no model calls until it is resumed' },
    });
    await assert.rejects(calls!, (e) => !(e instanceof RefusedError) && e instanceof Error && (e as { status?: unknown }).status === "denied");
    await tick();
    const reply = s.last();
    assert.equal(reply.id, "inv-1");
    assert.equal(reply.status, "error");
    assert.equal(reply.error?.message, 'chat_ok: "alpha" is paused — no model calls until it is resumed');
    assert.equal(client.connected, true);
    client.close();
});

test("a non-ok reply after ready rejects its call with the reply's status, so a caller can tell a denial from a failure", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);
    for (const status of ["denied", "error", "timeout"] as const) {
        const call = client.chat({ messages: [] });
        const chat = s.last();
        assert.equal(chat.type, "chat");
        s.deliver({ id: chat.id, type: "chat_ok", status, error: { message: `the gateway said ${status}` } });
        await assert.rejects(call, (e) => {
            assert.ok(!(e instanceof RefusedError));
            assert.equal((e as Error).message, `chat_ok: the gateway said ${status}`);
            assert.equal((e as { status?: unknown }).status, status);
            return true;
        });
    }
    assert.equal(client.connected, true);
    client.close();
});

test("a describe that throws on redescribe is logged, and the connection stays up", async () => {
    let failing = false;
    const logs: string[] = [];
    const sockets: FakeSocket[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => {
            if (failing) throw new Error("prompt.md is a directory");
            return DESCRIBE;
        },
        dispatch: stubDispatch(),
        log: (m) => logs.push(m),
        socket: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
    });
    client.start();
    await handshake(sockets[0]!);
    failing = true;
    assert.doesNotThrow(() => client.redescribe());
    assert.match(logs.join(""), /re-describe failed — Error: prompt\.md is a directory/);
    assert.equal(sockets[0]!.frames().length, 2); // hello and describe, nothing more
    assert.equal(client.connected, true);
    client.close();
});

test("recent-request eviction cannot dispatch an in-flight tool a second time", async (t) => {
    let invoked = 0;
    const pending = Promise.withResolvers<{ text: string }>();
    const { client, sockets } = harness(stubDispatch({
        invoke: () => { invoked++; return pending.promise; },
        health: () => ({ uptimeMs: 1, sessions: 0 }),
    }));
    t.after(() => { pending.resolve({ text: "finished" }); client.close(); });
    client.start();
    const socket = sockets[0]!;
    await handshake(socket);
    const slow: AnyFrame = { id: "slow", type: "invoke", payload: { tool: "slow", args: {} } };
    socket.deliver(slow);
    for (let id = 0; id < 513; id++) socket.deliver({ id: `health-${id}`, type: "health", payload: {} });
    await tick();
    socket.deliver(slow);
    assert.equal(invoked, 1);
    pending.resolve({ text: "finished" });
    await tick();
    assert.equal(socket.frames().filter((frame) => frame.id === "slow").length, 1);
});

test("a frame type that is an Object.prototype key is answered as a parseable result reply", async () => {
    const { client, sockets } = harness(stubDispatch());
    client.start();
    const s = sockets[0]!;
    await handshake(s);

    s.deliver({ id: "proto-1", type: "constructor", payload: {} });
    await tick();
    const reply = s.last();
    assert.equal(reply.id, "proto-1");
    assert.equal(reply.type, "result");
    assert.equal(reply.status, "error");
    assert.match(reply.error!.message, /unknown frame type "constructor"/);
    client.close();
});

test("a reply the transport refuses comes back as an error reply with the same id", async () => {
    const sock = new FakeSocket();
    const accepted = sock.send.bind(sock);
    let limit = Number.POSITIVE_INFINITY;
    sock.send = (data: string): void => {
        if (data.length > limit) throw new Error("channel message exceeds 1048576 bytes");
        accepted(data);
    };
    const logs: string[] = [];
    const client = new GatewayClient({
        url: "ws://fake/channel",
        agent: "alpha",
        describe: () => DESCRIBE,
        dispatch: stubDispatch({ invoke: () => ({ text: "x".repeat(4_000) }) }),
        socket: () => sock,
        log: (msg) => logs.push(msg),
    });
    client.start();
    await handshake(sock);

    limit = 1_000;
    sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "big", args: {} } });
    await tick();
    const reply = sock.last();
    assert.equal(reply.id, "inv-1");
    assert.equal(reply.type, "result");
    assert.equal(reply.status, "error");
    assert.match(reply.error!.message, /reply not sent — channel message exceeds/);
    assert.match(logs.join(""), /result inv-1 not sent/);
    client.close();
});

test("redescribe re-sends describe so a prompt change reaches the gateway", async () => {
    const describeCount = { n: 0 };
    const { client, sockets } = harness(stubDispatch(), describeCount);
    client.start();
    const s = sockets[0]!;
    await handshake(s);
    assert.equal(describeCount.n, 1);

    client.redescribe();
    await tick();
    const redescribe = s.frames()[2]; // hello=0, describe=1, redescribe=2
    assert.equal(redescribe?.type, "describe");
    assert.equal(describeCount.n, 2); // opts.describe() re-read to build the fresh snapshot
    s.deliver({ id: redescribe!.id, type: "describe_ok", status: "ok", payload: { models: [{ id: "m2" }] } });
    await tick();
    assert.equal(client.connected, true);
    assert.deepEqual(client.models(), [{ id: "m2" }]); // fresh grants from the re-describe
    client.close();
});

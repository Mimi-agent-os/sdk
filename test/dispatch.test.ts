import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { GatewayClient } from "../src/client.ts";
import { buildDispatch, type DispatchCtx } from "../src/dispatch.ts";
import { Chat } from "../src/store/chat.ts";
import { openStore } from "../src/store/store.ts";
import type { ToolInstance } from "../src/runtime/tool.ts";

function harness(
    t: TestContext,
    tools: ToolInstance[],
    a2aCommands: string[],
    client: GatewayClient = {} as GatewayClient,
    unasked: ReadonlySet<string> = new Set(),
): ReturnType<typeof buildDispatch> {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-dispatch-"));
    const store = openStore("alpha", dir);
    t.after(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const ctx: DispatchCtx = {
        name: "alpha",
        chat: new Chat(store),
        tools: new Map(tools.map((t) => [t.definition.function.name, t])),
        a2aCommands: new Set(a2aCommands),
        unasked,
        bootedAt: Date.now(),
        getClient: () => client,
        getLastError: () => undefined,
    };
    return buildDispatch(ctx);
}

const echoFrom: ToolInstance = {
    definition: { type: "function", function: { name: "echo_from" } },
    execute: (_args, ctx) => ({ text: ctx?.from ?? "none" }),
};

test("a2a_invoke runs a listed command's tool and exposes the caller as ctx.from", async (t) => {
    const dispatch = harness(t, [echoFrom], ["echo_from"]);
    const ac = new AbortController();
    const ok = await dispatch.a2aInvoke(
        { from: "peer", command: "echo_from", args: {} },
        { signal: ac.signal },
    );
    assert.deepEqual(ok, { result: { text: "peer" } });
});

test("a2a_invoke on a command not in a2a.commands is refused before the tool ever runs", async (t) => {
    let ran = false;
    const guarded: ToolInstance = {
        definition: { type: "function", function: { name: "echo_from" } },
        execute: () => {
            ran = true;
            return { text: "ran" };
        },
    };
    const dispatch = harness(t, [guarded], []);
    const ac = new AbortController();
    await assert.rejects(
        Promise.resolve(dispatch.a2aInvoke({ from: "peer", command: "echo_from", args: {} }, { signal: ac.signal })),
        /"echo_from" is not an a2a command of agent "alpha"/,
    );
    assert.equal(ran, false);
});

test("invoke (a normal model call) leaves ctx.from undefined — only a2a_invoke sets it", async (t) => {
    const dispatch = harness(t, [echoFrom], ["echo_from"]);
    const ac = new AbortController();
    const result = await dispatch.invoke(
        { tool: "echo_from", args: {} },
        { signal: ac.signal },
    );
    assert.deepEqual(result, { text: "none" });
});

test("a tool sees the chat its invoke came from as ctx.session; a room invoke and an a2a_invoke name none", async (t) => {
    const echoSession: ToolInstance = {
        definition: { type: "function", function: { name: "echo_session" } },
        execute: (_args, ctx) => String(ctx?.session),
    };
    const dispatch = harness(t, [echoSession], ["echo_session"]);
    const signal = new AbortController().signal;
    assert.deepEqual(await dispatch.invoke({ tool: "echo_session", args: {}, session: 7 }, { signal }), { text: "7" });
    assert.deepEqual(await dispatch.invoke({ tool: "echo_session", args: {} }, { signal }), { text: "undefined" });
    const ok = await dispatch.a2aInvoke({ from: "peer", command: "echo_session", args: {} }, { signal });
    assert.deepEqual(ok, { result: { text: "undefined" } });
});

test("invoke rejects a tool result that cannot be sent as JSON", async (t) => {
    const invalid: ToolInstance = {
        definition: { type: "function", function: { name: "invalid" } },
        execute: () => ({ text: "not sendable", data: 1n }),
    };
    const dispatch = harness(t, [invalid], []);

    await assert.rejects(
        Promise.resolve(dispatch.invoke(
            { tool: "invalid", args: {} },
            { signal: new AbortController().signal },
        )),
        /BigInt/,
    );
});

test("an unasked tool's mid-execution approval answers yes without reaching the gateway", async (t) => {
    const client = {
        askApprove: async () => {
            throw new Error("the gateway must not be asked");
        },
    } as unknown as GatewayClient;
    const guarded: ToolInstance = {
        definition: { type: "function", function: { name: "guarded" } },
        execute: async (_args, ctx) => String(await ctx?.approve?.("Publish", {})),
    };
    const dispatch = harness(t, [guarded], [], client, new Set(["guarded"]));
    const result = await dispatch.invoke(
        { tool: "guarded", args: {} },
        { signal: new AbortController().signal },
    );
    assert.deepEqual(result, { text: "true" });
});

test("a tool approval carries its session and shares the invoke signal", async (t) => {
    const ac = new AbortController();
    let approval: unknown;
    let approvalSignal: AbortSignal | undefined;
    const client = {
        askApprove: async (payload: unknown, _timeout: undefined, signal: AbortSignal) => {
            approval = payload;
            approvalSignal = signal;
            return { approved: true };
        },
    } as unknown as GatewayClient;
    const guarded: ToolInstance = {
        definition: { type: "function", function: { name: "guarded" } },
        execute: async (_args, ctx) =>
            String(await ctx?.approve?.("Publish", { target: "report" })),
    };
    const dispatch = harness(t, [guarded], [], client);

    const result = await dispatch.invoke(
        { tool: "guarded", args: {}, session: 7 },
        { signal: ac.signal },
    );

    assert.deepEqual(result, { text: "true" });
    assert.deepEqual(approval, {
        label: "Publish",
        detail: { target: "report" },
        session: 7,
    });
    assert.equal(approvalSignal, ac.signal);
});

test("session_update pins and renames without moving updatedAt; an append still moves it", (t) => {
    const dispatch = harness(t, [], []);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const updatedAt = (session: number): number | undefined =>
        dispatch.sessionList({ includeArchived: true }).sessions.find((s) => s.session === session)?.updatedAt;

    const { head } = dispatch.sessionCreate({ title: "first" });
    now = 2_000;
    assert.deepEqual(dispatch.sessionUpdate({ session: head.session, pinned: true }), { applied: true });
    assert.deepEqual(dispatch.sessionUpdate({ session: head.session, title: "renamed", titleByUser: true }), { applied: true });
    assert.deepEqual(dispatch.sessionUpdate({ session: head.session, archived: true }), { applied: true });
    assert.equal(updatedAt(head.session), 1_000);

    now = 3_000;
    dispatch.append({ session: head.session, events: [{ type: "message", payload: { role: "user", content: "hi" } }] });
    assert.equal(updatedAt(head.session), 3_000);
});

test("session_list carries the 100 most recently active chats, pinned first, whatever the store holds", (t) => {
    const dispatch = harness(t, [], []);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const ids: number[] = [];
    for (let i = 0; i < 105; i++) {
        now += 1;
        ids.push(dispatch.sessionCreate({ title: `chat ${i}` }).head.session);
    }
    dispatch.sessionUpdate({ session: ids[0]!, pinned: true });
    now += 1;
    dispatch.append({ session: ids[3]!, events: [{ type: "message", payload: { role: "user", content: "back to this one" } }] });

    const listed = dispatch.sessionList({ includeArchived: true }).sessions.map((s) => s.session);
    assert.equal(listed.length, 100);
    assert.deepEqual(listed.slice(0, 3), [ids[0], ids[3], ids[104]], "pinned, then the one just written to, then the newest");
    assert.ok(!listed.includes(ids[5]!) && listed.includes(ids[9]!), "the least recently active drop out of the list, not out of the store");
});

test("session_list keeps every owner chat above a flood of newer delegation threads, pinned still first", (t) => {
    const dispatch = harness(t, [], []);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const own: number[] = [];
    for (let i = 0; i < 5; i++) {
        now += 1;
        own.push(dispatch.sessionCreate(i === 0 ? {} : { title: `my chat ${i}` }).head.session);
    }
    const threads: number[] = [];
    for (let i = 0; i < 150; i++) {
        now += 1;
        threads.push(dispatch.sessionCreate({ title: `← task ${i}`, titleByUser: true }).head.session);
    }
    dispatch.sessionUpdate({ session: threads[0]!, pinned: true });
    now += 1;
    dispatch.append({ session: own[1]!, events: [{ type: "message", payload: { role: "user", content: "back to this one" } }] });

    const listed = dispatch.sessionList({ includeArchived: true }).sessions.map((s) => s.session);
    assert.equal(listed.length, 100);
    assert.deepEqual(
        listed.slice(0, 6),
        [threads[0], own[1], own[4], own[3], own[2], own[0]],
        "the pinned thread, then the owner's chats by last activity, the untitled one included",
    );
    assert.deepEqual(listed.slice(6, 9), [threads[149], threads[148], threads[147]], "then the newest delegation threads");
    assert.ok(!listed.includes(threads[1]!), "the oldest threads drop out of the list, not out of the store");
});

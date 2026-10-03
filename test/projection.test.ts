import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EventBody, Message } from "@mimi-os/protocol";
import { Chat } from "../src/store/chat.ts";
import { Projection } from "../src/store/projection.ts";
import { openStore, type AgentStore } from "../src/store/store.ts";

const dirs: string[] = [];

function fresh(): { store: AgentStore; chat: Chat; view: Projection; session: number } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-projection-"));
    dirs.push(dir);
    const store = openStore("alpha", dir);
    const chat = new Chat(store);
    return { store, chat, view: new Projection(chat), session: chat.createSession() };
}

process.on("exit", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const msg = (role: Message["role"], content: string | null, extra?: object): EventBody =>
    ({ type: "message", payload: { role, content, ...extra } }) as EventBody;

const calls = (...ids: string[]): EventBody => ({
    type: "message",
    payload: {
        role: "assistant",
        content: null,
        tool_calls: ids.map((id) => ({ id, name: "get_time", arguments: "{}" })),
    },
});

const said = (m: Message): string => `${m.role}:${m.content ?? ""}`;

test("stored private metadata survives the log but not the prompt projection", () => {
    const { store, chat, view, session } = fresh();
    const meta = { callId: "k1", registryModel: "local", actor: { kind: "agent", agent: "alpha" } };
    chat.append(session, msg("user", "hi", { meta: { actor: { kind: "human" } } }));
    chat.append(session, msg("assistant", "yo", { meta, thinking: "secret" }));

    assert.deepEqual(view.project(session), [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
    ]);
    const events = chat.events(session);
    assert.deepEqual((events[0]!.payload as Message).meta, { actor: { kind: "human" } });
    assert.deepEqual((events[1]!.payload as Message).meta, meta);
    store.close();
});

test("the SQLite log reaches the folded projection without deleting history", () => {
    const { store, chat, view, session } = fresh();
    for (const t of ["one", "two", "three", "four"]) chat.append(session, msg("user", t));
    chat.append(session, { type: "compaction", payload: { summary: "1-2", covers: [1, 2] } });
    chat.append(session, { type: "truncate", payload: { fromSeq: 4 } });
    chat.append(session, msg("user", "after the cut"));
    assert.deepEqual(view.project(session).map(said), [
        "assistant:1-2",
        "user:three",
        "user:after the cut",
    ]);
    assert.equal(chat.events(session).length, 7);
    store.close();
});

test("a trailing tool_call with no result is repaired as a REAL event", () => {
    const { store, chat, view, session } = fresh();
    chat.append(session, msg("user", "do it"));
    chat.append(session, calls("call_1", "call_2"));
    chat.append(session, msg("tool", "42", { tool_call_id: "call_1" }));

    const before = chat.head(session);
    assert.equal(view.repairParity(session), 1);
    const head = chat.head(session);
    assert.equal(head?.headSeq, (before?.headSeq ?? 0) + 1);
    assert.notEqual(head?.headHash, before?.headHash);

    const last = chat.events(session).at(-1);
    assert.equal(last?.type, "message");
    assert.deepEqual(last?.payload, {
        role: "tool",
        content: "[interrupted — the tool never returned a result]",
        tool_call_id: "call_2",
    });

    // idempotent: the second pass finds the pair closed
    assert.equal(view.repairParity(session), 0);
    assert.equal(chat.head(session)?.headSeq, head?.headSeq);
    store.close();
});

test("an unpaired group in the MIDDLE is repaired in the projection, not by appending", () => {
    const { store, chat, view, session } = fresh();
    chat.append(session, calls("call_1"));
    chat.append(session, msg("user", "never mind")); // closes the group unanswered
    assert.equal(view.repairParity(session), 0);
    assert.equal(chat.events(session).length, 2);

    const out = view.project(session);
    assert.deepEqual(out.map((m) => m.role), ["assistant", "tool", "user"]);
    assert.equal(out[1]?.tool_call_id, "call_1");
    store.close();
});

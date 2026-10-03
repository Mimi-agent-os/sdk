import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GENESIS_HASH, chainHash } from "@mimi-os/protocol";
import type { EventBody, SessionHead } from "@mimi-os/protocol";
import { Chat } from "../src/store/chat.ts";
import { openStore, type AgentStore } from "../src/store/store.ts";

const dirs: string[] = [];

function fresh(agent = "alpha"): { store: AgentStore; chat: Chat } {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-chat-"));
    dirs.push(dir);
    const store = openStore(agent, dir);
    return { store, chat: new Chat(store) };
}

process.on("exit", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const msg = (role: "user" | "assistant", content: string): EventBody => ({
    type: "message",
    payload: { role, content },
});

/** The chain the way a verifier outside the SDK would recompute it. */
const expectedHead = (bodies: EventBody[]): string =>
    bodies.reduce(
        (prev, b, i) => chainHash(prev, { seq: i + 1, type: b.type, payload: b.payload }),
        GENESIS_HASH,
    );

test("append walks seq from 1 and chains the hash onto the empty string", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    const bodies = [msg("user", "one"), msg("assistant", "two"), msg("user", "three")];

    const first = chat.append(id, bodies[0]!);
    assert.deepEqual(first, {
        seq: 1,
        revision: 1,
        hash: chainHash(GENESIS_HASH, { seq: 1, type: "message", payload: bodies[0]!.payload }),
    });
    const second = chat.append(id, bodies[1]!);
    const third = chat.append(id, bodies[2]!);
    assert.equal(second.seq, 2);
    assert.equal(third.seq, 3);
    assert.equal(third.revision, 3);
    assert.equal(third.hash, expectedHead(bodies));

    const head = chat.head(id);
    assert.deepEqual(head, {
        session: id,
        revision: 3,
        headSeq: 3,
        headHash: expectedHead(bodies),
    } satisfies SessionHead);
    store.close();
});

test("a batch lands the same sequence and hash chain as individual appends", () => {
    const { store, chat } = fresh();
    const a = chat.createSession();
    const b = chat.createSession();
    const bodies = [msg("user", "one"), msg("assistant", "two"), msg("user", "three")];

    for (const body of bodies) chat.append(a, body);
    const batch = chat.appendMany(b, bodies);

    assert.deepEqual(
        batch.results.map((r) => r.seq),
        [1, 2, 3],
    );
    assert.equal(batch.head.headHash, chat.head(a)?.headHash);
    assert.equal(batch.head.revision, 3);
    store.close();
});

test("each session carries its own seq and its own chain", () => {
    const { store, chat } = fresh();
    const a = chat.createSession();
    const b = chat.createSession();
    chat.append(a, msg("user", "a1"));
    const onB = chat.append(b, msg("user", "b1"));
    assert.equal(onB.seq, 1);
    assert.notEqual(chat.head(a)?.headHash, chat.head(b)?.headHash);
    assert.deepEqual(
        chat.sessionHead([a, b, 9999]).map((h) => h.session),
        [a, b],
    );
    store.close();
});

test("a Date anywhere in a payload is refused, and refused BEFORE anything is written", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    chat.append(id, msg("user", "one"));
    const before = chat.head(id);

    assert.throws(
        () =>
            chat.appendMany(id, [
                msg("user", "two"),
                { type: "message", payload: { role: "user", content: "x", at: new Date() } as never },
            ]),
        /Date/,
    );
    assert.deepEqual(chat.head(id), before);
    assert.equal(chat.events(id).length, 1);
    store.close();
});

test("append hashes the JSON value it persists", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    const payload = {
        role: "user",
        content: "one",
        extra: {
            source: "memory",
            toJSON: () => ({ source: "wire" }),
        },
    };

    chat.append(id, { type: "message", payload } as never);
    const event = chat.events(id)[0]!;
    assert.deepEqual(event.payload, { role: "user", content: "one", extra: { source: "wire" } });
    assert.equal(
        event.hash,
        chainHash(GENESIS_HASH, { seq: event.seq, type: event.type, payload: event.payload }),
    );
    store.close();
});

test("eventsAfter returns the delta, its head, and whether more is waiting", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    for (let i = 1; i <= 5; i++) chat.append(id, msg("user", `m${i}`));

    const all = chat.eventsAfter(id, 0);
    assert.equal(all.events.length, 5);
    assert.equal(all.more, false);
    assert.equal(all.head.headSeq, 5);

    const tail = chat.eventsAfter(id, 3);
    assert.deepEqual(
        tail.events.map((e) => e.seq),
        [4, 5],
    );

    const page = chat.eventsAfter(id, 0, 2);
    assert.deepEqual(
        page.events.map((e) => e.seq),
        [1, 2],
    );
    assert.equal(page.more, true);
    assert.equal(chat.eventsAfter(id, 5).events.length, 0);
    assert.throws(() => chat.eventsAfter(9999, 0), /No session/);
    store.close();
});

test("session metadata changes do NOT move revision — a valid cache stays valid", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    chat.append(id, msg("user", "one"));
    const before = chat.head(id);
    assert.equal(chat.updateSession(id, { title: "named", titleByUser: true }), true);
    assert.equal(chat.updateSession(id, { pinned: true, archived: true }), true);
    assert.deepEqual(chat.head(id), before);
    const info = chat.getSession(id);
    assert.equal(info?.title, "named");
    assert.equal(info?.pinned, true);
    assert.equal(info?.events, 1);
    store.close();
});

test("a machine title never overwrites one the human set", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    chat.updateSession(id, { title: "mine", titleByUser: true });
    assert.equal(chat.updateSession(id, { title: "auto" }), false);
    assert.equal(chat.getSession(id)?.title, "mine");

    assert.equal(chat.updateSession(id, { title: "auto", archived: true, pinned: true }), true);
    const info = chat.getSession(id);
    assert.equal(info?.title, "mine");
    assert.equal(info?.archived, true);
    assert.equal(info?.pinned, true);
    store.close();
});

test("listSessions hides archived unless asked, pinned first", () => {
    const { store, chat } = fresh();
    const a = chat.createSession();
    const b = chat.createSession();
    const c = chat.createSession();
    chat.updateSession(b, { archived: true });
    chat.updateSession(a, { pinned: true });
    assert.deepEqual(
        chat.listSessions().map((s) => s.id),
        [a, c],
    );
    assert.equal(chat.sessionCount(), 3);
    assert.equal(chat.listSessions(true).length, 3);
    store.close();
});

test("deleting a session takes its events with it", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    chat.append(id, msg("user", "one"));
    assert.equal(chat.deleteSession(id), true);
    assert.equal(chat.head(id), null);
    assert.equal(chat.events(id).length, 0);
    assert.equal(chat.deleteSession(id), false);
    assert.throws(() => chat.append(id, msg("user", "two")), /No session/);
    store.close();
});

test("session_changed reports the new head, and a throwing pusher cannot fail the write", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    const seen: SessionHead[] = [];
    chat.onChange((head) => seen.push(head));
    chat.append(id, msg("user", "one"));
    assert.deepEqual(seen, [{ session: id, revision: 1, headSeq: 1, headHash: chat.head(id)!.headHash }]);

    chat.onChange(() => {
        throw new Error("socket is gone");
    });
    assert.doesNotThrow(() => chat.append(id, msg("user", "two")));
    assert.equal(chat.head(id)?.headSeq, 2);

    // the gateway's own append must not be echoed straight back at it
    chat.onChange((head) => seen.push(head));
    chat.appendMany(id, [msg("user", "three")], { notify: false });
    assert.equal(seen.length, 1);
    store.close();
});

test("an events_after page stops at a byte budget, and paging still returns every event", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    const big = "y".repeat(20_000);
    for (let i = 0; i < 120; i++) chat.append(id, msg("assistant", big));

    const page = chat.eventsAfter(id, 0, 500);
    assert.equal(page.more, true);
    assert.ok(page.events.length < 120);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 1024 * 1024);

    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
        const p = chat.eventsAfter(id, cursor, 500);
        assert.ok(p.events.length > 0);
        for (const e of p.events) seen.push(e.seq);
        cursor = p.events.at(-1)!.seq;
        if (!p.more) break;
    }
    assert.deepEqual(seen, Array.from({ length: 120 }, (_, i) => i + 1));
    store.close();
});

test("one event bigger than the page budget is still returned alone", () => {
    const { store, chat } = fresh();
    const id = chat.createSession();
    chat.append(id, msg("assistant", "z".repeat(700_000)));
    chat.append(id, msg("assistant", "after"));

    const page = chat.eventsAfter(id, 0, 500);
    assert.equal(page.events.length, 1);
    assert.equal(page.more, true);
    assert.deepEqual(
        chat.eventsAfter(id, page.events[0]!.seq, 500).events.map((e) => e.seq),
        [2],
    );
    store.close();
});

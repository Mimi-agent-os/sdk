import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Chat } from "../src/store/chat.ts";
import { openStore } from "../src/store/store.ts";
import { dataDir, dbFile } from "../src/runtime/paths.ts";

const dirs: string[] = [];

function fresh(): string {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-store-"));
    dirs.push(dir);
    return dir;
}

process.on("exit", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tables = (file: string): string[] => {
    const db = new DatabaseSync(file);
    const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all()
        .map((r) => String((r as Record<string, unknown>)["name"]));
    db.close();
    return rows;
};

test("a fresh db is created as agent.db in the data folder, which defaults to the agent folder's data/", () => {
    const dir = fresh();
    const data = dataDir(dir);
    assert.equal(data, join(dir, "data"));
    assert.equal(dataDir(dir, ".mimi-dev/agent-data"), join(dir, ".mimi-dev", "agent-data"));
    const store = openStore("alpha", data);
    store.close();
    const file = dbFile(data);
    assert.equal(file, join(dir, "data", "agent.db"));
    for (const t of ["sessions", "events"]) {
        assert.ok(tables(file).includes(t), `missing table ${t}`);
    }
});

test("a recreated agent.db never hands out a chat id the deleted file already used", (t) => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const dir = fresh();
    const first = openStore("alpha", dir);
    const chatA = new Chat(first).createSession();
    const chatB = new Chat(first).createSession();
    first.close();
    rmSync(dbFile(dir));
    for (const side of ["-wal", "-shm"]) rmSync(`${dbFile(dir)}${side}`, { force: true });
    now = 2_000; // the seed is the clock: a real reset is never within the same ms

    const second = openStore("alpha", dir);
    const chat = new Chat(second);
    const reborn = chat.createSession();
    second.close();
    assert.ok(Number.isSafeInteger(reborn));
    assert.ok(reborn > chatB, `chat ${reborn} repeats an id at or below ${chatB}`);
    assert.equal(chatB, chatA + 1, "ids inside one file still count up by one");
});

test(
    "opening a store restricts an existing data directory on POSIX",
    { skip: process.platform === "win32" },
    () => {
        const dir = fresh();
        const data = join(dir, "data");
        mkdirSync(data);
        chmodSync(data, 0o755);

        const store = openStore("alpha", data);
        assert.equal(statSync(data).mode & 0o777, 0o700);
        store.close();
    },
);

test(
    "store hardening refuses a data symlink without chmodding its target",
    { skip: process.platform === "win32" },
    () => {
        const dir = fresh();
        const target = join(dir, "elsewhere");
        mkdirSync(target);
        chmodSync(target, 0o755);
        symlinkSync(target, join(dir, "data"));

        assert.throws(() => openStore("alpha", join(dir, "data")), /must not be a symbolic link/);
        assert.equal(statSync(target).mode & 0o777, 0o755);
    },
);

test(
    "opening a store refuses an agent.db symlink",
    { skip: process.platform === "win32" },
    () => {
        const dir = fresh();
        const data = join(dir, "data");
        const target = join(dir, "elsewhere.db");
        mkdirSync(data);
        new DatabaseSync(target).close();
        symlinkSync(target, dbFile(data));

        assert.throws(() => openStore("alpha", data), /database must be a regular file/);
        assert.deepEqual(tables(target), []);
    },
);

test("reopening keeps the data, and chat ids count on from where they were", () => {
    const dir = fresh();
    const first = openStore("beta", dir);
    const before = new Chat(first).createSession();
    first.close();

    const again = openStore("beta", dir);
    const chat = new Chat(again);
    assert.deepEqual(chat.listSessions(true, 10).map((s) => s.id), [before]);
    assert.equal(chat.createSession(), before + 1);
    again.close();
});

test("agent names that are not wire-safe are refused", () => {
    const dir = fresh();
    assert.throws(() => openStore("Main", dir), /Invalid agent name/);
    assert.throws(() => openStore("../escape", dir), /Invalid agent name/);
    assert.throws(() => openStore("temp", dir), /Invalid agent name/);
    // the pairing layer refuses a device name over 64 code points, so an unpairable agent must never get a store
    assert.doesNotThrow(() => openStore(`a${"b".repeat(63)}`, dir).close());
    assert.throws(() => openStore(`a${"b".repeat(64)}`, dir), /at most 64 characters/);
});

test("two agents in two folders keep two databases", () => {
    const one = openStore("alpha", fresh());
    const two = openStore("alpha", fresh());
    one.db
        .prepare(`INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)`)
        .run("only here", Date.now(), Date.now());
    const oneCount = one.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    const twoCount = two.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    assert.equal(oneCount.n, 1);
    assert.equal(twoCount.n, 0);
    one.close();
    two.close();
});

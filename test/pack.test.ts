import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HealthOkPayload } from "@mimi-os/protocol";
import { runAgent } from "../src/agent.ts";
import { definePack } from "../src/runtime/pack.ts";
import type { PackRuntime } from "../src/runtime/pack.ts";
import { defineTool } from "../src/runtime/tool.ts";
import type { ToolInstance } from "../src/runtime/tool.ts";
import { HandshakeSocket } from "../src/testing/handshake-socket.ts";

const tool = (name: string, run: () => string = () => name): ToolInstance =>
    defineTool(name, "", { type: "object", properties: {} }, run);

function agentDir(manifest: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-pack-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify(manifest));
    return dir;
}

test("definePack bakes forced writes and pack-wide fold onto the tool instances", () => {
    const def = definePack({
        name: "sample",
        tools: [tool("save"), tool("read")],
        writes: ["save"],
        fold: true,
    });
    const byName = new Map(def.tools.map((t) => [t.definition.function.name, t]));
    assert.equal(byName.get("save")!.writes, true);
    assert.equal(byName.get("read")!.writes, undefined);
    assert.equal(byName.get("save")!.fold, true);
    assert.equal(byName.get("read")!.fold, true);
});

test("definePack rejects a bad name, reserved prefix, dup tools, stray prefix, and unknown writes", () => {
    assert.throws(() => definePack({ name: "Bad", tools: [] }), /Invalid pack name "Bad"/);
    assert.throws(() => definePack({ name: "a2a_x", tools: [] }), /reserved prefix "a2a_"/);
    assert.throws(
        () => definePack({ name: "dup", tools: [tool("same"), tool("same")] }),
        /duplicate tool "same"/,
    );
    assert.throws(
        () => definePack({ name: "pfx", toolPrefix: "todo", tools: [tool("todo_add"), tool("remove")] }),
        /do not use it: remove/,
    );
    assert.throws(
        () => definePack({ name: "wr", tools: [tool("save")], writes: ["typo"] }),
        /unknown tools in writes: typo/,
    );
});

test("runAgent mounts an enabled pack's tools and skill and carries fold on the describe schema", async () => {
    const dir = agentDir({ name: "alpha" });
    const sock = new HandshakeSocket();
    const agent = await runAgent({
        dir,
        socket: () => sock,
        packs: [
            definePack({
                name: "todo",
                toolPrefix: "todo",
                skill: "Use the todo tools.",
                fold: true,
                tools: [tool("todo_add")],
            }),
        ],
        log: () => undefined,
    });
    try {
        await sock.open();
        assert.ok(agent.tools.has("todo_add"));
        assert.equal(sock.describe?.tools.find((t) => t.name === "todo_add")?.fold, true);
        assert.ok(
            sock.describe?.prompt.some((p) => p.name === "pack:todo" && p.text === "Use the todo tools."),
        );
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a pack whose required env is missing is disabled, its tools are not mounted, and describe names it", async () => {
    const dir = agentDir({ name: "alpha" });
    const logs: string[] = [];
    const sock = new HandshakeSocket();
    const agent = await runAgent({
        dir,
        socket: () => sock,
        packs: [definePack({ name: "gh", env: ["TOKEN", "OWNER"], tools: [tool("gh_star")] })],
        log: (m) => logs.push(m),
    });
    try {
        await sock.open();
        assert.equal(agent.tools.has("gh_star"), false);
        assert.match(logs.join(""), /gh: disabled — set TOKEN, OWNER/);
        assert.deepEqual(sock.describe?.packsDisabled, [{ name: "gh", missing: ["TOKEN", "OWNER"] }]);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a pack starts once, on the first ready session, and its stop runs on agent.stop()", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dir = agentDir({ name: "alpha" });
    const events: string[] = [];
    let seen: PackRuntime | undefined;
    const socks: HandshakeSocket[] = [];
    const agent = await runAgent({
        dir,
        socket: () => {
            const sock = new HandshakeSocket();
            socks.push(sock);
            return sock;
        },
        packs: [
            definePack({
                name: "beat",
                tools: [tool("beat_ping")],
                start: (rt) => {
                    events.push(`start connected=${rt.connected()}`);
                    seen = rt;
                    return () => events.push("stop");
                },
            }),
        ],
        log: () => undefined,
    });
    try {
        assert.deepEqual(events, [], "nothing starts before the handshake");
        await socks[0]!.open();
        assert.deepEqual(events, ["start connected=true"]);
        assert.equal(typeof seen?.ask, "function");
        assert.equal(typeof seen?.notify, "function");
        assert.equal(typeof seen?.redescribe, "function");
        assert.ok(seen?.dataDir.endsWith(join("data", "packs", "beat")));

        socks[0]!.onclose?.(null);
        assert.equal(seen?.connected(), false);
        t.mock.timers.tick(1_000);
        assert.equal(socks.length, 2, "one backoff later the client dialed again");
        await socks[1]!.open();
        assert.equal(seen?.connected(), true);
        assert.deepEqual(events, ["start connected=true"], "a reconnect does not start it again");
    } finally {
        await agent.stop();
    }
    assert.deepEqual(events, ["start connected=true", "stop"]);
    rmSync(dir, { recursive: true, force: true });
});

/** A pack in the shape the memory pack takes: files under its dataDir, a prompt re-read per describe. */
function notesPack(): { pack: ReturnType<typeof definePack>; mounted: () => PackRuntime | undefined; started: () => boolean } {
    let rt: PackRuntime | undefined;
    let started = false;
    const file = (): string => join(rt!.dataDir, "notes.md");
    const pack = definePack({
        name: "notes",
        toolPrefix: "notes",
        skill: "Keep notes with notes_add.",
        tools: [
            defineTool("notes_add", "", { type: "object", properties: {} }, (args) => {
                mkdirSync(rt!.dataDir, { recursive: true });
                writeFileSync(file(), `${existsSync(file()) ? readFileSync(file(), "utf8") : ""}- ${String(args["note"])}\n`);
                rt!.redescribe();
                return "Noted.";
            }),
        ],
        prompt: () => (existsSync(file()) ? readFileSync(file(), "utf8").trim() : ""),
        mount: (r) => {
            rt = r;
        },
        start: () => {
            started = true;
        },
    });
    return { pack, mounted: () => rt, started: () => started };
}

test("mount runs at boot with the dataDir, before the first describe and before start", async () => {
    const dir = agentDir({ name: "alpha" });
    const notes = notesPack();
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, packs: [notes.pack], log: () => undefined });
    try {
        assert.equal(sock.sent.length, 0, "runAgent resolved and nothing has been sent yet");
        assert.equal(notes.mounted()?.dataDir, join(dir, "data", "packs", "notes"));
        assert.equal(notes.mounted()?.connected(), false);
        assert.equal(notes.started(), false);

        await sock.open();
        assert.equal(notes.started(), true);
        sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "notes_add", args: { note: "tea" } } });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(sock.replyTo("inv-1")?.payload, { text: "Noted." });
        assert.equal(readFileSync(join(dir, "data", "packs", "notes", "notes.md"), "utf8"), "- tea\n");
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("prompt() is re-read on every describe and redescribe() sends the change at once", async () => {
    const dir = agentDir({ name: "alpha" });
    const notes = notesPack();
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, packs: [notes.pack], log: () => undefined });
    try {
        await sock.open();
        assert.deepEqual(sock.describes[0]!.prompt, [{ name: "pack:notes", text: "Keep notes with notes_add." }]);

        sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "notes_add", args: { note: "tea" } } });
        await new Promise((r) => setImmediate(r));
        assert.equal(sock.describes.length, 2, "the write re-described without a reconnect");
        assert.deepEqual(sock.describes[1]!.prompt, [{ name: "pack:notes", text: "Keep notes with notes_add.\n\n- tea" }]);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a pack whose mount throws mounts no tools, and health names it", async () => {
    const dir = agentDir({ name: "alpha" });
    const sock = new HandshakeSocket();
    const agent = await runAgent({
        dir,
        socket: () => sock,
        packs: [
            definePack({
                name: "broken",
                tools: [tool("broken_ping")],
                mount: () => {
                    throw new Error("no disk");
                },
            }),
        ],
        log: () => undefined,
    });
    try {
        assert.equal(agent.tools.has("broken_ping"), false);
        await sock.open();
        sock.deliver({ id: "h-1", type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        assert.equal((sock.replyTo("h-1")?.payload as HealthOkPayload).lastError, "pack broken: no disk");
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a second pack with a taken name mounts nothing, so two packs never share a data folder", async () => {
    const dir = agentDir({ name: "alpha" });
    const sock = new HandshakeSocket();
    const seen: string[] = [];
    const agent = await runAgent({
        dir,
        socket: () => sock,
        packs: [
            definePack({ name: "notes", tools: [tool("first_ping")], mount: (rt) => void seen.push(rt.dataDir) }),
            definePack({ name: "notes", tools: [tool("second_ping")], mount: (rt) => void seen.push(rt.dataDir) }),
        ],
        log: () => undefined,
    });
    try {
        assert.equal(agent.tools.has("first_ping"), true);
        assert.equal(agent.tools.has("second_ping"), false);
        assert.equal(seen.length, 1, "the duplicate is refused before its mount runs");
        await sock.open();
        sock.deliver({ id: "h-1", type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        assert.equal((sock.replyTo("h-1")?.payload as HealthOkPayload).lastError, 'pack notes: a pack named "notes" is already mounted');
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a prompt() that throws leaves the handshake up, keeps the skill, and health names it until it recovers", async () => {
    const dir = agentDir({ name: "alpha" });
    let broken = true;
    const sock = new HandshakeSocket();
    const agent = await runAgent({
        dir,
        socket: () => sock,
        packs: [
            definePack({
                name: "flaky",
                skill: "Static part.",
                tools: [tool("flaky_ping")],
                prompt: () => {
                    if (broken) throw new Error("not a real directory");
                    return "Live part.";
                },
            }),
        ],
        log: () => undefined,
    });
    const health = async (id: string): Promise<string | undefined> => {
        sock.deliver({ id, type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        return (sock.replyTo(id)?.payload as HealthOkPayload).lastError;
    };
    try {
        await sock.open();
        assert.equal(agent.client.connected, true);
        assert.deepEqual(sock.describe?.prompt, [{ name: "pack:flaky", text: "Static part." }]);
        assert.equal(await health("h-1"), "describe: pack flaky: prompt() failed — not a real directory");

        broken = false;
        agent.client.redescribe();
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(sock.describe?.prompt, [{ name: "pack:flaky", text: "Static part.\n\nLive part." }]);
        assert.equal(await health("h-2"), undefined);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

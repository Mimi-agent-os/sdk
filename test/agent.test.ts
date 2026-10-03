import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChatPayload, HealthOkPayload } from "@mimi-os/protocol";
import { runAgent } from "../src/agent.ts";
import type { AgentRuntime, RunOptions } from "../src/agent.ts";
import { ensureIdentity, gatewayKeyFile, identityFile } from "../src/runtime/identity.ts";
import { dataDir, dbFile } from "../src/runtime/paths.ts";
import { Chat } from "../src/store/chat.ts";
import { definePack } from "../src/runtime/pack.ts";
import type { PackRuntime } from "../src/runtime/pack.ts";
import { defineTool } from "../src/runtime/tool.ts";
import type { ToolInstance } from "../src/runtime/tool.ts";
import { openStore } from "../src/store/store.ts";
import { HandshakeSocket } from "../src/testing/handshake-socket.ts";

function agentDir(manifest: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-agent-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify(manifest));
    return dir;
}

test("an injected socket does not create an agent identity", async () => {
    const dir = agentDir({ name: "alpha" });
    try {
        const agent = await runAgent({ dir, socket: () => new HandshakeSocket(), log: () => undefined });
        try {
            assert.equal(existsSync(identityFile(dataDir(dir))), false);
        } finally {
            await agent.stop();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the agent's .env names its gateway and its data folder, and explicit options win over it", async () => {
    const dir = agentDir({ name: "alpha" });
    writeFileSync(join(dir, ".env"), "MIMI_GATEWAY_URL=ws://127.0.0.1:46470/channel\nMIMI_DATA_DIR=.mimi-dev/agent-data\n");
    const urls: string[] = [];
    const boot = (opts: RunOptions): Promise<AgentRuntime> =>
        runAgent({
            dir,
            socket: (url) => {
                urls.push(url);
                return new HandshakeSocket();
            },
            log: () => undefined,
            ...opts,
        });
    try {
        await (await boot({})).stop();
        assert.deepEqual(urls, ["ws://127.0.0.1:46470/channel"]);
        assert.equal(existsSync(join(dir, ".mimi-dev", "agent-data", "agent.db")), true);
        assert.equal(existsSync(join(dir, "data")), false);

        await (await boot({ port: 46999, dataDir: "elsewhere" })).stop();
        assert.equal(urls.at(-1), "ws://127.0.0.1:46999/channel");
        assert.equal(existsSync(join(dir, "elsewhere", "agent.db")), true);

        writeFileSync(join(dir, ".env"), "");
        await (await boot({})).stop();
        assert.equal(urls.at(-1), "ws://127.0.0.1:46464/channel");
        assert.equal(existsSync(join(dir, "data", "agent.db")), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an agent waiting for its invite does not enroll into data/ once .env names another data folder", async (t) => {
    const dir = agentDir({ name: "alpha" });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const logs: string[] = [];
    const until = async (text: string): Promise<void> => {
        for (let i = 0; i < 1000 && !logs.some((l) => l.includes(text)); i++) await new Promise((r) => setImmediate(r));
        assert.ok(logs.some((l) => l.includes(text)), `no log line with "${text}" in ${JSON.stringify(logs)}`);
    };
    // never resolves: the agent keeps waiting, as a developer's does until they restart it
    void runAgent({ dir, log: (m) => logs.push(m) });
    await until("no MIMI_INVITE");

    writeFileSync(join(dir, ".env"), "MIMI_INVITE=mimi://pair/v2?id=X\nMIMI_GATEWAY_URL=ws://127.0.0.1:1/channel\nMIMI_DATA_DIR=.mimi-dev/agent-data\n");
    t.mock.timers.tick(30_000);
    await until(`MIMI_DATA_DIR now names ${join(dir, ".mimi-dev", "agent-data")}, but this agent booted with ${join(dir, "data")} — restart it`);
    assert.equal(logs.some((l) => l.includes("[pair]") || l.includes("enrollment failed")), false);
    assert.equal(existsSync(gatewayKeyFile(join(dir, "data"))), false);
});

test("tools passed in code are mounted and clash with built-ins at boot", async () => {
    const dir = agentDir({ name: "alpha" });
    const hello: ToolInstance = {
        definition: { type: "function", function: { name: "hello" } },
        execute: () => "hi",
    };
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, tools: [hello], log: () => undefined });
    try {
        await sock.open();
        assert.ok(sock.describe?.tools.some((t) => t.name === "hello"));
        await assert.rejects(
            runAgent({ dir, socket: () => new HandshakeSocket(), tools: [{ ...hello, definition: { type: "function", function: { name: "notify_user" } } }], log: () => undefined }),
            /duplicate tool "notify_user" from code/,
        );
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a colliding pack is skipped without partially mounting its tools", async () => {
    const dir = agentDir({ name: "alpha" });
    const tool = (name: string): ToolInstance => ({
        definition: { type: "function", function: { name } },
        execute: () => name,
    });
    const logs: string[] = [];
    try {
        const agent = await runAgent({
            dir,
            socket: () => new HandshakeSocket(),
            packs: [definePack({ name: "collision", tools: [tool("partial"), tool("notify_user")] })],
            log: (message) => logs.push(message),
        });
        try {
            assert.equal(agent.tools.has("partial"), false);
            assert.ok(agent.tools.has("notify_user"));
            assert.match(logs.join(""), /duplicate tool "notify_user" from pack "collision"/);
        } finally {
            await agent.stop();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a gateway key path that is a directory fails before enrollment", async () => {
    const dir = agentDir({ name: "alpha" });
    try {
        ensureIdentity(dataDir(dir));
        mkdirSync(gatewayKeyFile(dataDir(dir)));
        await assert.rejects(
            runAgent({ dir, log: () => undefined }),
            /gateway\.pub is a directory, not a gateway key/,
        );
        assert.equal(existsSync(gatewayKeyFile(dataDir(dir))), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a failed boot closes the store", async () => {
    const dir = agentDir({ name: "alpha" });
    const seeded = openStore("alpha", dataDir(dir));
    const chat = new Chat(seeded);
    const session = chat.createSession();
    chat.append(session, { type: "message", payload: { role: "user", content: "hello" } });
    seeded.db.prepare("UPDATE events SET payload = '{'").run();
    seeded.close();
    try {
        await assert.rejects(
            runAgent({ dir, socket: () => new HandshakeSocket(), log: () => undefined }),
            /Expected property name/,
        );
        const db = new DatabaseSync(dbFile(dataDir(dir)));
        try {
            const row = db.prepare("PRAGMA journal_mode = DELETE").get() as {
                journal_mode: string;
            };
            assert.equal(row.journal_mode, "delete");
        } finally {
            db.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("unasked tools are described as read-only and notify: false drops notify_user", async () => {
    const save = (name: string): ToolInstance =>
        defineTool(name, "", { type: "object", properties: {} }, () => "saved", { writes: true });
    const cases: Array<[RunOptions, Record<string, boolean | undefined>]> = [
        [{}, { remember: true, forget: true, notify_user: false }],
        [{ unasked: ["remember"], notify: false }, { remember: false, forget: true, notify_user: undefined }],
    ];
    for (const [extra, writes] of cases) {
        const dir = agentDir({ name: "alpha" });
        const sock = new HandshakeSocket();
        const agent = await runAgent({
            dir,
            socket: () => sock,
            tools: [save("remember"), save("forget")],
            log: () => undefined,
            ...extra,
        });
        try {
            await sock.open();
            for (const [tool, expected] of Object.entries(writes)) {
                assert.equal(sock.describe?.tools.find((t) => t.name === tool)?.writes, expected, `${tool} under ${JSON.stringify(extra)}`);
            }
        } finally {
            await agent.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

test("an a2a command that names no mounted tool fails boot before anything is created", async () => {
    const dir = agentDir({ name: "alpha" });
    try {
        await assert.rejects(
            runAgent({ dir, socket: () => new HandshakeSocket(), a2a: ["missing"], log: () => undefined }),
            /a2a command "missing" does not name a mounted tool/,
        );
        assert.equal(existsSync(join(dir, "data")), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("describe carries agent.json's description and the RunOptions manifest, with the app beside it", async () => {
    const dir = agentDir({ name: "alpha", description: "Keeps the owner's week in order." });
    const sock = new HandshakeSocket();
    const agent = await runAgent({
        dir,
        socket: () => sock,
        log: () => undefined,
        model: "qwen",
        chain: true,
        policy: { allowedTools: ["week"] },
        a2a: ["week"],
        app: { title: " Week ", upstream: "http://127.0.0.1:3377" },
        tools: [defineTool("week", "", { type: "object", properties: {} }, () => "mon")],
    });
    try {
        await sock.open();
        assert.deepEqual(sock.describe?.manifest, {
            name: "alpha",
            description: "Keeps the owner's week in order.",
            chain: true,
            model: "qwen",
            policy: { allowedTools: ["week"] },
            a2a: { commands: ["week"] },
        });
        assert.deepEqual(sock.describe?.app, { title: "Week", upstream: "http://127.0.0.1:3377" });
        assert.deepEqual(agent.manifest, sock.describe?.manifest);

        // the a2a option is what dispatch serves to other agents
        sock.deliver({ id: "a-1", type: "a2a_invoke", payload: { from: "beta", command: "week", args: {} } });
        await new Promise((r) => setImmediate(r));
        const reply = sock.replyTo("a-1");
        assert.equal(reply?.type, "a2a_invoke_ok");
        assert.deepEqual(reply?.payload, { result: { text: "mon" } });
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("describe drops a part over the byte budget and health names what was left out", async () => {
    const dir = agentDir({ name: "alpha" });
    writeFileSync(join(dir, "prompt.md"), "p".repeat(600 * 1024));
    const logs: string[] = [];
    const sock = new HandshakeSocket();
    const small = definePack({ name: "small", skill: "ok", tools: [] });
    const agent = await runAgent({ dir, socket: () => sock, packs: [small], log: (msg) => logs.push(msg) });
    try {
        await sock.open();
        assert.deepEqual(sock.describe?.prompt, [{ name: "pack:small", text: "ok" }]);
        assert.match(logs.join(""), /omitted prompt section persona \(614428 bytes\)/);

        sock.deliver({ id: "h-1", type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        assert.match(String((sock.replyTo("h-1")?.payload as HealthOkPayload).lastError), /omitted prompt section persona /);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a reconnect whose describe fits clears the omission from health", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dir = agentDir({ name: "alpha" });
    writeFileSync(join(dir, "prompt.md"), "p".repeat(600 * 1024));
    const socks: HandshakeSocket[] = [];
    const agent = await runAgent({
        dir,
        log: () => undefined,
        socket: () => {
            const sock = new HandshakeSocket();
            socks.push(sock);
            setImmediate(() => sock.accept());
            return sock;
        },
    });
    const health = async (sock: HandshakeSocket, id: string): Promise<string | undefined> => {
        await new Promise((r) => setImmediate(r));
        sock.deliver({ id, type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        return (sock.replyTo(id)?.payload as HealthOkPayload).lastError;
    };
    try {
        assert.match(String(await health(socks[0]!, "h-1")), /omitted prompt section persona/);

        rmSync(join(dir, "prompt.md"));
        socks[0]!.onclose?.(null);
        t.mock.timers.tick(1_000);
        assert.equal(socks.length, 2, "one backoff later the client dialed again");
        assert.equal(await health(socks[1]!, "h-2"), undefined);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a prompt part is charged its JSON-escaped size, so escaping cannot blow the channel limit", async () => {
    const dir = agentDir({ name: "alpha" });
    // 200 KiB of U+0001 fits the budget raw and serializes to six bytes a character — 1.17 MiB on the wire
    writeFileSync(join(dir, "prompt.md"), "\u0001".repeat(200 * 1024));
    const logs: string[] = [];
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, log: (msg) => logs.push(msg) });
    try {
        await sock.open();
        assert.deepEqual(sock.describe?.prompt, []);
        assert.match(logs.join(""), /omitted prompt section persona \(1228828 bytes\)/);
        assert.ok(Buffer.byteLength(JSON.stringify(sock.describe), "utf8") < 1024 * 1024);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ask forwards timeoutMs to client.chat as the outbound deadline", async () => {
    const dir = agentDir({ name: "alpha" });
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, log: () => undefined });
    try {
        await sock.open();
        // timeoutMs: 0 is an already-expired outbound deadline: client.chat rejects before it writes
        // the frame, which happens only if ask() passed the value as chat's second argument.
        const before = sock.sent.filter((f) => f.type === "chat").length;
        await assert.rejects(agent.ask("hello", { timeoutMs: 0 }), /chat: no reply within 0ms/);
        assert.equal(sock.sent.filter((f) => f.type === "chat").length, before);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ask forwards withPrompt and a named model to the chat payload, and leaves out what was not asked", async () => {
    const dir = agentDir({ name: "alpha" });
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, log: () => undefined });
    try {
        await sock.open();
        const unanswered = [agent.ask("brief", { withPrompt: true, model: "qwen" }), agent.ask("plain", { model: "auto" })];
        for (const call of unanswered) call.catch(() => undefined);
        const chats = sock.sent.filter((f) => f.type === "chat").map((f) => f.payload as ChatPayload);
        assert.equal(chats.length, 2);
        assert.equal(chats[0]!.withPrompt, true);
        assert.deepEqual(chats[0]!.messages, [{ role: "user", content: "brief" }]);
        assert.equal("withPrompt" in chats[1]!, false);
        assert.equal(chats[0]!.model, "qwen");
        assert.equal("model" in chats[1]!, false, '"auto" leaves the model to the gateway');
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a pack write still lands when the re-describe it triggers cannot be built", async () => {
    const dir = agentDir({ name: "alpha" });
    const logs: string[] = [];
    let rt: PackRuntime | undefined;
    const note = definePack({
        name: "note",
        tools: [
            defineTool("note_save", "", { type: "object", properties: {} }, (args) => {
                mkdirSync(rt!.dataDir, { recursive: true });
                writeFileSync(join(rt!.dataDir, "note.md"), String(args["text"]));
                rt!.redescribe();
                return "Saved.";
            }),
        ],
        prompt: () => (rt && existsSync(join(rt.dataDir, "note.md")) ? readFileSync(join(rt.dataDir, "note.md"), "utf8") : ""),
        mount: (r) => {
            rt = r;
        },
    });
    const sock = new HandshakeSocket();
    const agent = await runAgent({ dir, socket: () => sock, packs: [note], log: (msg) => logs.push(msg) });
    try {
        await sock.open();
        // a persona path that turned into a directory makes every describe throw EISDIR
        mkdirSync(join(dir, "prompt.md"));
        sock.deliver({ id: "inv-1", type: "invoke", payload: { tool: "note_save", args: { text: "tea, no sugar" } } });
        await new Promise((r) => setImmediate(r));
        const reply = sock.replyTo("inv-1");
        assert.equal(reply?.status, "ok");
        assert.deepEqual(reply?.payload, { text: "Saved." });
        assert.match(readFileSync(join(dir, "data", "packs", "note", "note.md"), "utf8"), /tea, no sugar/);
        assert.match(logs.join(""), /re-describe failed — Error: EISDIR/);
        assert.equal(agent.client.connected, true);
    } finally {
        await agent.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("tool schemas over the describe budget stop the boot instead of looping on handshake", async () => {
    const dir = agentDir({ name: "alpha" });
    const fat: ToolInstance = {
        definition: {
            type: "function",
            function: { name: "fat", description: "d".repeat(600 * 1024) },
        },
        execute: () => "",
    };
    try {
        await assert.rejects(
            runAgent({
                dir,
                socket: () => new HandshakeSocket(),
                packs: [definePack({ name: "fat", tools: [fat] })],
                log: () => undefined,
            }),
            /manifest, app and tool schemas serialize to \d+ bytes, over the 524288-byte limit for what an agent sends the gateway on connect/,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

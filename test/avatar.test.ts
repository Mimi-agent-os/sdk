import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HealthOkPayload } from "@mimi-os/protocol";
import { runAgent } from "../src/agent.ts";
import type { AgentRuntime, RunOptions } from "../src/agent.ts";
import { HandshakeSocket } from "../src/testing/handshake-socket.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (fill: string, size = 200): Buffer => Buffer.concat([PNG, Buffer.alloc(size, fill)]);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function agentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-avatar-"));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    return dir;
}

async function boot(dir: string, opts: RunOptions = {}): Promise<{ agent: AgentRuntime; sock: HandshakeSocket; logs: string[] }> {
    const sock = new HandshakeSocket();
    const logs: string[] = [];
    const agent = await runAgent({ dir, socket: () => sock, log: (m) => logs.push(m), ...opts });
    await sock.open();
    return { agent, sock, logs };
}

// fs.watch delivers on the real clock, then the agent settles for 100 ms before it re-describes
async function describesUntil(sock: HandshakeSocket, done: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(done(), `no matching describe in ${sock.describes.length} sent`);
}

test("an avatar beside agent.json rides describe as its sniffed type, its hash and its bytes", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bytes = png("a");
    writeFileSync(join(dir, "avatar.png"), bytes);
    // avatar.png wins over avatar.webp, and the extension never names the type
    writeFileSync(join(dir, "avatar.webp"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const { agent, sock } = await boot(dir);
    try {
        assert.deepEqual(sock.describe?.avatar, { type: "image/png", sha256: sha(bytes), data: bytes.toString("base64") });
    } finally {
        await agent.stop();
    }

    rmSync(join(dir, "avatar.png"));
    const jpeg = await boot(dir);
    try {
        assert.equal(jpeg.sock.describe?.avatar?.type, "image/jpeg");
    } finally {
        await jpeg.agent.stop();
    }
});

test("runAgent({ avatar }) names the file, relative to the agent folder", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "art"));
    const webp = Buffer.concat([Buffer.from("RIFF\x10\0\0\0WEBPVP8 ", "latin1"), Buffer.alloc(8, 7)]);
    writeFileSync(join(dir, "art", "face.bin"), webp);
    writeFileSync(join(dir, "avatar.png"), png("x"));
    const { agent, sock } = await boot(dir, { avatar: "art/face.bin" });
    try {
        assert.deepEqual(sock.describe?.avatar, { type: "image/webp", sha256: sha(webp), data: webp.toString("base64") });
    } finally {
        await agent.stop();
    }
});

test("an agent with no avatar file describes none", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { agent, sock } = await boot(dir);
    try {
        assert.ok(sock.describe);
        assert.equal("avatar" in sock.describe, false);
    } finally {
        await agent.stop();
    }
});

test("an avatar of the wrong type, over 64 KiB, or named and missing refuses the boot before anything is created", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const refuse = (opts: RunOptions = {}): Promise<AgentRuntime> => runAgent({ dir, socket: () => new HandshakeSocket(), log: () => undefined, ...opts });

    writeFileSync(join(dir, "avatar.png"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await assert.rejects(refuse(), /avatar .*avatar\.png is not a PNG, WebP or JPEG image \(judged by its bytes; SVG is refused\)/);

    writeFileSync(join(dir, "avatar.png"), png("a", 64 * 1024 - PNG.length + 1));
    await assert.rejects(refuse(), /avatar .*avatar\.png is 65537 bytes — over the 65536-byte limit/);

    rmSync(join(dir, "avatar.png"));
    await assert.rejects(refuse({ avatar: "face.png" }), /Agent "alpha": avatar .*face\.png does not exist/);
    assert.equal(existsSync(join(dir, "data")), false);

    writeFileSync(join(dir, "avatar.png"), png("a", 64 * 1024 - PNG.length));
    await (await refuse()).stop();
});

test("an avatar that resolves outside the agent folder, a FIFO or a huge file refuses the boot without reading it; a symlink inside is read", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mimi-sdk-avatar-root-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, "agent");
    mkdirSync(dir);
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    writeFileSync(join(root, "private.png"), png("s"));
    const refuse = (opts: RunOptions = {}): Promise<AgentRuntime> => runAgent({ dir, socket: () => new HandshakeSocket(), log: () => undefined, ...opts });

    symlinkSync(join(root, "private.png"), join(dir, "avatar.png"));
    await assert.rejects(refuse(), /avatar .*avatar\.png resolves to .*private\.png, outside the agent folder/);
    await assert.rejects(refuse({ avatar: "../private.png" }), /outside the agent folder/);
    rmSync(join(dir, "avatar.png"));

    // a sparse 3 GiB file: refused by its size, never loaded (reading it would fail past 2 GiB)
    writeFileSync(join(dir, "avatar.png"), "");
    truncateSync(join(dir, "avatar.png"), 3 * 1024 ** 3);
    await assert.rejects(refuse(), /avatar .*avatar\.png is 3221225472 bytes — over the 65536-byte limit/);
    rmSync(join(dir, "avatar.png"));

    if (process.platform !== "win32") {
        // opening a FIFO blocks until a writer comes, which would freeze the agent
        execFileSync("mkfifo", [join(dir, "avatar.png")]);
        await assert.rejects(refuse(), /avatar .*avatar\.png: not a regular file/);
        rmSync(join(dir, "avatar.png"));
    }

    const inside = png("i");
    mkdirSync(join(dir, "art"));
    writeFileSync(join(dir, "art", "v3.png"), inside);
    symlinkSync(join(dir, "art", "v3.png"), join(dir, "avatar.png"));
    const { agent, sock } = await boot(dir);
    try {
        assert.equal(sock.describe?.avatar?.sha256, sha(inside));
    } finally {
        await agent.stop();
    }
});

test("a symlink out of the agent folder swapped in while running is dropped and named in health", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mimi-sdk-avatar-root-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, "agent");
    mkdirSync(dir);
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
    writeFileSync(join(dir, "avatar.png"), png("a"));
    writeFileSync(join(root, "private.png"), png("s"));
    const { agent, sock } = await boot(dir);
    try {
        symlinkSync(join(root, "private.png"), join(dir, ".avatar.tmp"));
        renameSync(join(dir, ".avatar.tmp"), join(dir, "avatar.png"));
        await describesUntil(sock, () => sock.describes.length > 1 && sock.describe?.avatar === undefined);
        assert.equal(sock.describes.some((d) => d.avatar?.sha256 === sha(png("s"))), false);
        sock.deliver({ id: "h-1", type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        assert.match(String((sock.replyTo("h-1")?.payload as HealthOkPayload).lastError), /outside the agent folder/);
    } finally {
        await agent.stop();
    }
});

test("replacing the avatar by write-and-rename re-describes with the new hash", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "avatar.png"), png("a"));
    const { agent, sock } = await boot(dir);
    try {
        const next = png("b");
        writeFileSync(join(dir, ".avatar.png.swp"), next);
        renameSync(join(dir, ".avatar.png.swp"), join(dir, "avatar.png"));
        await describesUntil(sock, () => sock.describe?.avatar?.sha256 === sha(next));
        assert.equal(sock.describe?.avatar?.data, next.toString("base64"));

        // a file the agent does not read as its avatar wakes nothing
        const sent = sock.describes.length;
        writeFileSync(join(dir, "notes.txt"), "x");
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(sock.describes.length, sent);
    } finally {
        await agent.stop();
    }
});

test("deleting the avatar re-describes with none, and adding one later sends it", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "avatar.png"), png("a"));
    const { agent, sock } = await boot(dir);
    try {
        rmSync(join(dir, "avatar.png"));
        await describesUntil(sock, () => sock.describes.length > 1 && sock.describe?.avatar === undefined);

        const later = png("c");
        writeFileSync(join(dir, "avatar.jpg"), later);
        await describesUntil(sock, () => sock.describe?.avatar?.sha256 === sha(later));
    } finally {
        await agent.stop();
    }
});

test("an avatar edited into a bad file is dropped from describe and named in health", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "avatar.png"), png("a"));
    const { agent, sock } = await boot(dir);
    try {
        writeFileSync(join(dir, "avatar.png"), "<svg/>");
        await describesUntil(sock, () => sock.describes.length > 1 && sock.describe?.avatar === undefined);
        sock.deliver({ id: "h-1", type: "health", payload: {} });
        await new Promise((r) => setImmediate(r));
        assert.match(String((sock.replyTo("h-1")?.payload as HealthOkPayload).lastError), /avatar .*is not a PNG, WebP or JPEG image/);
    } finally {
        await agent.stop();
    }
});

test("the avatar is charged to the describe budget after the prompt, and dropped by name when it does not fit", async (t) => {
    const dir = agentDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "avatar.png"), png("a", 60 * 1024));
    writeFileSync(join(dir, "prompt.md"), "p".repeat(480 * 1024));
    const { agent, sock, logs } = await boot(dir);
    try {
        assert.equal(sock.describe?.prompt[0]?.name, "persona");
        assert.equal(sock.describe?.avatar, undefined);
        assert.match(logs.join(""), /omitted avatar \(\d+ bytes\): over the 524288-byte limit/);
    } finally {
        await agent.stop();
    }
});

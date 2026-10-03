import assert from "node:assert/strict";
import {
    chmodSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentEnvKeys, deleteAgentEnv, loadAgentEnv, setAgentEnv } from "../src/runtime/env.ts";

function withEnv(text: string, run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-env-"));
    try {
        writeFileSync(join(dir, ".env"), text);
        run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("deleteAgentEnv removes whitespace-prefixed and duplicate definitions", () => {
    withEnv("KEEP=yes\n  export DROP = first\nDROP=second\n", (dir) => {
        assert.equal(loadAgentEnv(dir)["DROP"], "second");
        assert.equal(deleteAgentEnv(dir, "DROP"), true);
        assert.equal(loadAgentEnv(dir)["DROP"], undefined);
        assert.deepEqual(agentEnvKeys(dir), ["KEEP"]);
        assert.equal(deleteAgentEnv(dir, "DROP"), false);
    });
});

test("loadAgentEnv rejects a secret it cannot decrypt", () => {
    withEnv('SECRET="encrypted:not-valid"\n', (dir) => {
        assert.throws(() => loadAgentEnv(dir), /could not decrypt SECRET/);
    });
});

test("setAgentEnv keeps the encrypted value and private key owner-only", {
    skip: process.platform === "win32",
}, () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-env-"));
    const previousUmask = process.umask(0o022);
    try {
        setAgentEnv(dir, "SECRET", "hidden");
        assert.equal(loadAgentEnv(dir)["SECRET"], "hidden");
        assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
        assert.equal(statSync(join(dir, ".env.keys")).mode & 0o777, 0o600);
    } finally {
        process.umask(previousUmask);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadAgentEnv tightens a hand-written .env to owner-only", {
    skip: process.platform === "win32",
}, () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-env-"));
    const env = join(dir, ".env");
    const keys = join(dir, ".env.keys");
    try {
        writeFileSync(env, "VISIBLE=value\n");
        writeFileSync(keys, "");
        chmodSync(env, 0o644);
        chmodSync(keys, 0o644);

        assert.equal(loadAgentEnv(dir)["VISIBLE"], "value");
        assert.equal(statSync(env).mode & 0o777, 0o600);
        assert.equal(statSync(keys).mode & 0o777, 0o600);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("env writes create and update a dangling symlink target without replacing the link", {
    skip: process.platform === "win32",
}, () => {
    const dir = mkdtempSync(join(tmpdir(), "mimi-sdk-env-"));
    const target = join(dir, "shared.env");
    symlinkSync(target, join(dir, ".env"));
    try {
        setAgentEnv(dir, "SECRET", "hidden");
        assert.equal(lstatSync(join(dir, ".env")).isSymbolicLink(), true);
        assert.equal(statSync(target).mode & 0o777, 0o600);
        assert.equal(statSync(join(dir, ".env.keys")).mode & 0o777, 0o600);
        assert.equal(loadAgentEnv(dir)["SECRET"], "hidden");
        assert.equal(deleteAgentEnv(dir, "SECRET"), true);
        assert.equal(lstatSync(join(dir, ".env")).isSymbolicLink(), true);
        assert.equal(loadAgentEnv(dir)["SECRET"], undefined);
        assert.doesNotMatch(readFileSync(target, "utf8"), /^SECRET=/m);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("setAgentEnv writes plain text with encrypt: false, and the package root exports it with readManifest", async () => {
    const root = await import("../src/index.ts");
    assert.equal(root.setAgentEnv, setAgentEnv);
    withEnv("", (dir) => {
        writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "alpha" }));
        assert.equal(root.readManifest(dir).name, "alpha");
        setAgentEnv(dir, "MIMI_DATA_DIR", ".mimi-dev/agent-data", { encrypt: false });
        setAgentEnv(dir, "SECRET", "hidden");
        const text = readFileSync(join(dir, ".env"), "utf8");
        assert.match(text, /^MIMI_DATA_DIR="?\.mimi-dev\/agent-data"?$/m);
        assert.doesNotMatch(text, /hidden/);
        assert.equal(loadAgentEnv(dir)["MIMI_DATA_DIR"], ".mimi-dev/agent-data");
        assert.equal(loadAgentEnv(dir)["SECRET"], "hidden");
    });
});

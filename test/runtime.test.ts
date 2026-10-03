import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureIdentity, gatewayKeyFile, identityFile } from "../src/runtime/identity.ts";
import { dataDir } from "../src/runtime/paths.ts";

const tempAgent = (): string => mkdtempSync(join(tmpdir(), "mimi-runtime-"));

test("a symlinked agent path works while a symlinked data directory is rejected", (t) => {
    if (process.platform === "win32") {
        t.skip("directory symlinks require privileges on Windows");
        return;
    }
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const alias = join(dir, "agent-link");
    symlinkSync(".", alias, "dir");
    const identity = ensureIdentity(dataDir(alias));
    assert.deepEqual(ensureIdentity(dataDir(`${alias}/`)).secret, identity.secret);

    rmSync(dataDir(dir), { recursive: true });
    const outside = join(dir, "outside-data");
    mkdirSync(outside);
    symlinkSync("outside-data", dataDir(dir), "dir");
    assert.throws(() => ensureIdentity(dataDir(dir)), /real directory/);
    assert.deepEqual(readdirSync(outside), []);
});

test("ensureIdentity enforces canonical, owner-only, regular credential files", (t) => {
    const dir = tempAgent();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const data = dataDir(dir);
    const file = identityFile(data);
    mkdirSync(data, { recursive: true });
    const original = new Uint8Array(32).fill(0x42);
    const encoded = Buffer.from(original).toString("base64");
    writeFileSync(file, `x25519:${encoded}\n`, { mode: 0o644 });
    chmodSync(file, 0o644);

    const reused = ensureIdentity(data);

    assert.deepEqual(reused.secret, original);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    writeFileSync(file, `x25519:${encoded}!\n`);
    writeFileSync(gatewayKeyFile(data), `${encoded}\n`);
    const rotated = ensureIdentity(data);

    assert.notDeepEqual(rotated.secret, original);
    assert.equal(existsSync(gatewayKeyFile(data)), false);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    writeFileSync(file, "invalid\n");
    mkdirSync(gatewayKeyFile(data));
    assert.throws(() => ensureIdentity(data), /gateway key.*directory/i);
    assert.equal(readFileSync(file, "utf8"), "invalid\n");
    rmSync(gatewayKeyFile(data), { recursive: true });
    ensureIdentity(data);

    if (process.platform !== "win32") {
        const outside = join(dir, "outside.key");
        const outsideText = `x25519:${encoded}\n`;
        writeFileSync(outside, outsideText, { mode: 0o644 });
        rmSync(file);
        symlinkSync(outside, file);
        writeFileSync(gatewayKeyFile(data), `${encoded}\n`);

        ensureIdentity(data);

        assert.equal(readFileSync(outside, "utf8"), outsideText);
        assert.equal(statSync(outside).mode & 0o777, 0o644);
        assert.equal(lstatSync(file).isFile(), true);
        assert.equal(existsSync(gatewayKeyFile(data)), false);
    }

    rmSync(file);
    mkdirSync(file);
    writeFileSync(gatewayKeyFile(data), `${encoded}\n`);
    assert.throws(() => ensureIdentity(data), /identity key.*directory/i);
    assert.equal(existsSync(gatewayKeyFile(data)), true);
});

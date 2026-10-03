/** The agent's own X25519 identity key: generated once into its folder, the credential the channel proves by Noise IK, not by a wire field. */

import { chmodSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { x25519 } from "@noble/curves/ed25519.js";

import { ensureDataDir, writeAtomic } from "./paths.ts";

export interface AgentIdentity {
    secret: Uint8Array;
    publicKey: Uint8Array;
    /** base64 public half — the only part that ever leaves this folder. */
    pubkey: string;
}

export const identityFile = (data: string): string => join(data, "identity.key");
export const gatewayKeyFile = (data: string): string => join(data, "gateway.pub");

export const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
export const unb64 = (s: string): Uint8Array => {
    const decoded = Buffer.from(s, "base64");
    return decoded.toString("base64") === s ? new Uint8Array(decoded) : new Uint8Array();
};

function removeGatewayKey(data: string): void {
    const file = gatewayKeyFile(data);
    try {
        if (lstatSync(file).isDirectory()) {
            throw new Error(`Cannot invalidate gateway key "${file}": the path is a directory.`);
        }
        rmSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/** <data>/identity.key = "x25519:<base64 secret>\n", mode 0600. Any other content is replaced by a fresh key. */
export function ensureIdentity(data: string, log: (msg: string) => void = () => undefined): AgentIdentity {
    ensureDataDir(data);
    const file = identityFile(data);
    let existing: string | undefined;
    let invalidEntry = false;
    try {
        const entry = lstatSync(file);
        if (entry.isDirectory()) {
            throw new Error(`Cannot replace identity key "${file}": the path is a directory.`);
        }
        if (entry.isFile()) existing = readFileSync(file, "utf8").trim();
        else invalidEntry = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parts = existing?.split(":");
    if (parts?.length === 2 && parts[0] === "x25519") {
        const secret = unb64(parts[1]!);
        if (secret.length === 32) {
            if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600);
            const publicKey = x25519.getPublicKey(secret);
            return { secret, publicKey, pubkey: b64(publicKey) };
        }
    }
    if (existing !== undefined || invalidEntry) {
        log(`[identity] ${file} held no usable x25519 key — generating a fresh one\n`);
    }
    removeGatewayKey(data); // a fresh identity invalidates any prior enrollment
    const pair = x25519.keygen();
    writeAtomic(file, `x25519:${b64(pair.secretKey)}\n`, 0o600);
    return { secret: pair.secretKey, publicKey: pair.publicKey, pubkey: b64(pair.publicKey) };
}

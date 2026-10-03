/** The agent's folder is the root: code beside it, everything it accumulates in its data folder. */

import { randomUUID } from "node:crypto";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { isAgentName } from "@mimi-os/protocol";

export const SLUG_NAME = /^[a-z][a-z0-9_-]*$/;

export const agentDir = (dir?: string): string => resolve(dir ?? process.cwd());

export const manifestFile = (dir: string): string => join(dir, "agent.json");
export const promptFile = (dir: string): string => join(dir, "prompt.md");
export const envFile = (dir: string): string => join(dir, ".env");
export const envKeysFile = (dir: string): string => join(dir, ".env.keys");

/** Everything the agent accumulates, so the code folder stays disposable: `configured` resolves against the agent folder, else <agent>/data. */
export const dataDir = (dir: string, configured?: string): string => resolve(dir, configured || "data");
export const dbFile = (data: string): string => join(data, "agent.db");

/** The name still travels the wire and keys the gateway's registry — keep it addressable. */
export function assertAgentName(agent: string): void {
    if (!isAgentName(agent) || agent === "main" || agent === "temp") {
        throw new Error(
            `Invalid agent name "${agent}" — lowercase letters/digits/underscore/dash, ` +
                `starting with a letter, at most 64 characters, and not "main"/"temp".`,
        );
    }
}

/** True only for an existing directory entry, never for a symlink that resolves to one. */
export function realDirExists(dir: string): boolean {
    const path = resolve(dir);
    try {
        if (!lstatSync(path).isDirectory()) {
            throw new Error(`Directory must be a real directory; it must not be a symbolic link or file: ${path}`);
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export function ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    if (!realDirExists(dir)) throw new Error(`Directory was not created: ${dir}`);
    return dir;
}

/** Private root for credentials, conversations, and pack state. */
export function ensureDataDir(data: string): string {
    const storage = ensureDir(data);
    if (process.platform !== "win32") chmodSync(storage, 0o700);
    return storage;
}

/** Write a config file whole or not at all; `mode` is applied at creation, so a secret is never world-readable for even an instant. */
export function writeAtomic(path: string, text: string, mode?: number): void {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const target = mode === undefined ? lstatSync(path, { throwIfNoEntry: false }) : undefined;
    const createMode = mode ?? (target?.isFile() ? target.mode & 0o777 : undefined);
    let created = false;
    try {
        writeFileSync(tmp, text, { encoding: "utf8", flag: "wx", mode: createMode });
        created = true;
        renameSync(tmp, path); // rename is atomic only within one filesystem — hence a sibling
    } catch (e) {
        if (created || (e as NodeJS.ErrnoException).code !== "EEXIST") {
            rmSync(tmp, { force: true });
        }
        throw e;
    }
}

/** The agent's OWN .env as an isolated, frozen bag — decrypted by dotenvx, never process.env. */

import { chmodSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";

import { config as dotenvxConfig, set as dotenvxSet, type SetOptions } from "@dotenvx/dotenvx";

import { envFile, envKeysFile, writeAtomic } from "./paths.ts";

export type AgentEnv = Readonly<Record<string, string | undefined>>;

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const EMPTY_ENV: AgentEnv = Object.freeze({});
const cache = new Map<string, { stamp: string; env: AgentEnv }>();

function isInfraKey(key: string): boolean {
    return key.startsWith("DOTENV_PUBLIC_KEY") || key.startsWith("DOTENV_PRIVATE_KEY");
}

// mtime alone is coarse on some filesystems, so size+inode join it to make the stamp honest
function fileStamp(file: string): string | undefined {
    try {
        const s = statSync(file);
        return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function secureExistingEnvFile(file: string): boolean {
    try {
        const entry = statSync(file);
        if (!entry.isFile()) throw new Error(`Environment path must be a regular file: ${file}`);
        if (process.platform !== "win32" && (entry.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function secureEnvFiles(dir: string): [string, string] {
    const files: [string, string] = [envFile(dir), envKeysFile(dir)];
    for (const file of files) secureExistingEnvFile(file);
    return files;
}

function ensureSecureEnvFiles(dir: string): [string, string] {
    const files: [string, string] = [envFile(dir), envKeysFile(dir)];
    for (const file of files) {
        if (!secureExistingEnvFile(file)) {
            // Append-create follows a supported dangling symlink without truncating an existing target.
            writeFileSync(file, "", { encoding: "utf8", flag: "a", mode: 0o600 });
            secureExistingEnvFile(file);
        }
    }
    return files;
}

/** Memoized on the identity of BOTH .env and .env.keys — the private key decides whether a value resolves at all. */
export function loadAgentEnv(dir: string): AgentEnv {
    const [file, keysFile] = secureEnvFiles(dir);
    const envStamp = fileStamp(file);
    if (envStamp === undefined) {
        cache.delete(dir);
        return EMPTY_ENV;
    }
    const stamp = `${envStamp}|${fileStamp(keysFile) ?? "-"}`;
    const hit = cache.get(dir);
    if (hit && hit.stamp === stamp) return hit.env;

    const throwaway: Record<string, string> = {};
    const { parsed } = dotenvxConfig({ path: file, quiet: true, processEnv: throwaway, strict: true });
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(parsed ?? {})) {
        if (!isInfraKey(k)) env[k] = v;
    }
    const bag: AgentEnv = Object.freeze(env);
    cache.set(dir, { stamp, env: bag });
    return bag;
}

/** Write KEY=VALUE into the agent's .env, dotenvx-encrypted unless `encrypt: false`. Takes effect on the next load. */
export function setAgentEnv(dir: string, key: string, value: string, opts: { encrypt?: boolean } = {}): void {
    if (!ENV_KEY.test(key)) {
        throw new Error(`Invalid env key "${key}" — UPPER_SNAKE_CASE, starting with a letter.`);
    }
    const files = ensureSecureEnvFiles(dir);
    let result: { processedEnvs?: Array<{ error?: Error }> };
    try {
        // dotenvx's .d.ts omits { quiet: true } though it honors it, and reports failures in processedEnvs[].error instead of throwing
        result = dotenvxSet(key, value, { path: files[0], quiet: true, encrypt: opts.encrypt ?? true } as SetOptions) as typeof result;
    } finally {
        // dotenvx may replace either file internally; never trust the replacement's creation mode.
        ensureSecureEnvFiles(dir);
    }
    const failed = result.processedEnvs?.find((p) => p.error);
    if (failed?.error) throw failed.error;
    cache.delete(dir);
}

/** Drop KEY from the agent's .env (plaintext or encrypted alike). False when it was not there. */
export function deleteAgentEnv(dir: string, key: string): boolean {
    if (!ENV_KEY.test(key)) return false;
    const [file] = secureEnvFiles(dir);
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8");
    const assignment = new RegExp(
        `^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*(?:=|:[ \\t]+)[^\\r\\n]*(?:\\r?\\n|$)`,
        "gm",
    );
    const next = text.replace(assignment, "");
    if (next === text) return false;
    // Atomic replacement must target the shared file, not replace a supported .env symlink itself.
    writeAtomic(realpathSync(file), next);
    cache.delete(dir);
    return true;
}

/** Every key the agent's .env defines (infra keys excluded) — for the env editor. */
export function agentEnvKeys(dir: string): string[] {
    const [file] = secureEnvFiles(dir);
    const { parsed } = dotenvxConfig({ path: file, quiet: true, processEnv: {} });
    return Object.keys(parsed ?? {}).filter((k) => !isInfraKey(k));
}

/** <agent>/agent.json (name + description), and the wire manifest built from it and RunOptions. */

import { existsSync, readFileSync } from "node:fs";

import { A2A_PREFIX, AGENT_DESCRIPTION_MAX, isAgentDescription } from "@mimi-os/protocol";
import type { AgentApp, AgentManifest } from "@mimi-os/protocol";

import type { RunOptions } from "./agent.ts";
import { assertAgentName, manifestFile } from "./runtime/paths.ts";

/** Everything agent.json holds: the name and one line a gateway orchestrator routes by. */
export type LocalManifest = Pick<AgentManifest, "name" | "description">;

/** Read + validate <dir>/agent.json. Throws with a clear message on any problem. */
export function readManifest(dir: string): LocalManifest {
    const file = manifestFile(dir);
    if (!existsSync(file)) throw new Error(`No agent.json in ${dir}.`);
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (e) {
        throw new Error(`${file} does not parse — ${(e as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file} must contain an object.`);
    }
    const json = parsed as Record<string, unknown>;
    for (const key of Object.keys(json)) {
        if (key === "name" || key === "description") continue;
        throw new Error(
            `${file}: "${key}" is not an agent.json field. agent.json holds only "name" and ` +
                `"description"; everything else is a runAgent() option.`,
        );
    }
    const name = json["name"];
    if (typeof name !== "string") throw new Error(`${file}: "name" must be a string.`);
    assertAgentName(name);
    const manifest: LocalManifest = { name };
    const description = json["description"];
    if (description !== undefined) {
        if (typeof description !== "string" || !isAgentDescription(description.trim())) {
            throw new Error(`${file}: "description" must be one non-empty line of at most ${AGENT_DESCRIPTION_MAX} characters.`);
        }
        manifest.description = description.trim();
    }
    return manifest;
}

/** Validate the manifest half of RunOptions against the mounted tools, and build what describe sends. */
export function buildManifest(
    local: LocalManifest,
    opts: RunOptions,
    toolNames: ReadonlySet<string>,
): { manifest: AgentManifest; app: AgentApp | undefined } {
    const { name } = local;
    // the SDK owns A2A_PREFIX: no mounted tool and no listed command may use it
    for (const tool of toolNames) {
        if (tool.startsWith(A2A_PREFIX)) {
            throw new Error(`Agent "${name}": tool "${tool}" uses the reserved prefix "${A2A_PREFIX}".`);
        }
    }
    for (const command of opts.a2a ?? []) {
        if (command.startsWith(A2A_PREFIX)) {
            throw new Error(`Agent "${name}": a2a command "${command}" uses the reserved prefix "${A2A_PREFIX}".`);
        }
        if (!toolNames.has(command)) {
            throw new Error(`Agent "${name}": a2a command "${command}" does not name a mounted tool.`);
        }
    }
    for (const tool of opts.unasked ?? []) {
        if (!toolNames.has(tool)) throw new Error(`Agent "${name}": "unasked" names no mounted tool "${tool}".`);
    }

    const manifest: AgentManifest = { name, chain: opts.chain ?? false };
    if (local.description !== undefined) manifest.description = local.description;
    if (opts.model !== undefined) {
        if (!opts.model.trim()) throw new Error(`Agent "${name}": "model" must be a non-empty string.`);
        manifest.model = opts.model;
    }
    if (opts.policy !== undefined) manifest.policy = opts.policy;
    if (opts.a2a !== undefined) manifest.a2a = { commands: opts.a2a };

    const app = opts.app;
    if (app === undefined) return { manifest, app };
    const title = app.title.trim();
    if (!title) throw new Error(`Agent "${name}": "app.title" must be a non-empty string.`);
    const upstream = URL.parse(app.upstream);
    if (!upstream || (upstream.protocol !== "http:" && upstream.protocol !== "https:")) {
        throw new Error(
            `Agent "${name}": "app.upstream" must be an http(s) URL of the server this agent runs, ` +
                `e.g. "http://127.0.0.1:3377".`,
        );
    }
    if (app.entry !== undefined && !app.entry.startsWith("/")) {
        throw new Error(`Agent "${name}": "app.entry" must be a path starting with "/".`);
    }
    for (const [i, page] of (app.pages ?? []).entries()) {
        if (!page.id || !page.title) {
            throw new Error(`Agent "${name}": "app.pages[${i}]" must be { id, title, path? } with non-empty strings.`);
        }
        if (page.path !== undefined && !page.path.startsWith("/")) {
            throw new Error(`Agent "${name}": "app.pages[${i}].path" must be a path starting with "/".`);
        }
    }
    return { manifest, app: { ...app, title } };
}

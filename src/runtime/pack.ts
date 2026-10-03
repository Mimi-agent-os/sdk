/** Packs: the unit of ability, defined in code and passed to runAgent({ packs }). */

import { A2A_PREFIX } from "@mimi-os/protocol";

import type { AgentRuntime } from "../agent.ts";
import { SLUG_NAME } from "./paths.ts";
import type { ToolInstance } from "./tool.ts";

/** One per pack, built at boot: mount() receives it, and start() receives the same object later. */
export interface PackRuntime {
    ask: AgentRuntime["ask"];
    notify: AgentRuntime["notify"];
    /** True while the gateway session is ready; a job that needs the gateway waits for it. */
    connected: () => boolean;
    /** <agent>/data/packs/<name>/ — not created for you; a pack that never writes leaves no folder. */
    dataDir: string;
    /** Re-send describe so a change to what prompt() returns reaches the model now; a no-op while disconnected. */
    redescribe: () => void;
    log: (m: string) => void;
}

export interface PackDef {
    name: string;
    toolPrefix?: string;
    tools: ToolInstance[];
    /** Static text added to the system prompt as the section `pack:<name>`, before prompt()'s text. */
    skill?: string;
    /** Called each time the agent sends its prompt to the gateway; its text follows the skill in the section `pack:<name>`. */
    prompt?: () => string;
    /** Force fold:true on every tool this pack mounts. */
    fold?: boolean;
    /** Required env keys; a missing one disables the whole pack. */
    env?: string[];
    /** Tool names forced through the approval gate on top of each tool's own flag. */
    writes?: string[];
    /** Called once at boot, before the first describe and before any tool can run; wiring only: keep rt, call nothing on it but log. */
    mount?: (rt: PackRuntime) => void;
    /** Called once, on the agent's first ready session; return a stop fn to unwind at shutdown. */
    start?: (rt: PackRuntime) => (() => void) | void;
}

/** Validate a pack in isolation and bake its writes/fold flags onto the tool instances. */
export function definePack(def: PackDef): PackDef {
    const { name } = def;
    if (!SLUG_NAME.test(name)) {
        throw new Error(
            `Invalid pack name "${name}" — lowercase letters/digits/underscore/dash, starting with a letter.`,
        );
    }
    if (name.startsWith(A2A_PREFIX)) {
        throw new Error(`Pack "${name}" uses the reserved prefix "${A2A_PREFIX}".`);
    }

    const toolNames = def.tools.map((t) => t.definition.function.name);
    const names = new Set<string>();
    for (const toolName of toolNames) {
        if (names.has(toolName)) throw new Error(`Pack "${name}": duplicate tool "${toolName}".`);
        names.add(toolName);
    }

    if (def.toolPrefix) {
        const stray = toolNames.filter((t) => !t.startsWith(`${def.toolPrefix}_`));
        if (stray.length) {
            throw new Error(
                `Pack "${name}" declares toolPrefix "${def.toolPrefix}" but these tools do not use it: ${stray.join(", ")}.`,
            );
        }
    }

    const forceWrites = new Set(def.writes ?? []);
    const unknownWrites = [...forceWrites].filter((t) => !names.has(t));
    if (unknownWrites.length) {
        throw new Error(`Pack "${name}" lists unknown tools in writes: ${unknownWrites.join(", ")}.`);
    }

    const tools = def.tools.map((t) => {
        let next = t;
        if (forceWrites.has(t.definition.function.name) && next.writes !== true) next = { ...next, writes: true };
        if (def.fold && next.fold !== true) next = { ...next, fold: true };
        return next;
    });
    return { ...def, tools };
}

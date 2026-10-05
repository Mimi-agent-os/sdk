/** An executable tool: the schema the model sees plus the execute() the gateway's loop invokes. */

import type { Message, ResultPayload, SessionId, Tool, ToolCall, ToolSchema } from "@mimi-os/protocol";

export interface ToolContext {
    /** Aborts the tool when a deadline the gateway put on the request passes, or the connection to it
     *  drops. A model's invoke carries no deadline by default, so the tool runs until it is done. */
    signal?: AbortSignal | undefined;
    /** Ask the user MID-EXECUTION; missing approver = denied, same deny-by-default rule as the gate. */
    approve?: ((label: string, detail: Record<string, unknown>) => Promise<boolean>) | undefined;
    /** The calling agent's name, set only when this run came in through a2a_invoke; undefined for a normal model invoke. */
    from?: string | undefined;
    /** The chat the invoke came from; undefined for a room turn, an a2a_invoke and a run from the agent's own code. */
    session?: SessionId | undefined;
}

/** `text` is the projection the model reads; `data` is the machine channel a chain substitutes from — the model never sees `data`. */
export interface ToolOutput {
    text: string;
    data?: unknown;
}

export type ToolResult = string | ToolOutput;

export interface ToolInstance {
    definition: Tool;
    execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult> | ToolResult;
    /** True for tools that CHANGE something out there — the gateway gates these. */
    writes?: boolean;
    /** True for tools whose call/result the gateway folds out of the visible transcript. */
    fold?: boolean;
}

// canonicalized once inside dispatch, where an invalid result can still become an error reply; JSON drops an undefined data
export const toResultPayload = (r: ToolResult): ResultPayload =>
    JSON.parse(JSON.stringify(typeof r === "string" ? { text: r } : { text: r.text, data: r.data })) as ResultPayload;

/** What `describe` advertises for one tool. */
export const toolSchema = (t: ToolInstance): ToolSchema => {
    const f = t.definition.function;
    return { name: f.name, description: f.description, parameters: f.parameters, writes: t.writes === true, fold: t.fold === true };
};

/** Schema + run fn → a ToolInstance. Its result reaches the model whole: neither side caps its size, only
 *  the channel's 1 MiB message limit bounds it — the reply that carries it and the history event that
 *  stores it each travel as one message, and a result too big for that is refused whole, never cut. */
export function defineTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (args: Record<string, unknown>, ctx?: ToolContext) => unknown | Promise<unknown>,
    opts?: { writes?: boolean; fold?: boolean },
): ToolInstance {
    return {
        definition: { type: "function", function: { name, description, parameters } },
        execute: async (args, ctx) => {
            const out = await run(args, ctx);
            if (typeof out === "string") return out;
            if (typeof out === "object" && out !== null && typeof (out as ToolOutput).text === "string")
                return out as ToolOutput;
            // stringify returns undefined for undefined/functions — String() keeps the contract
            return JSON.stringify(out, null, 2) ?? String(out);
        },
        ...(opts?.writes ? { writes: true } : {}),
        ...(opts?.fold ? { fold: true } : {}),
    };
}

/** Run one model round's tool calls against `tools` (no approver, so a mid-execution ask is denied) and return the tool messages to append. */
export async function runToolCalls(tools: readonly ToolInstance[], calls: readonly ToolCall[]): Promise<Message[]> {
    const byName = new Map(tools.map((t) => [t.definition.function.name, t]));
    const out: Message[] = [];
    for (const call of calls) {
        const tool = byName.get(call.name);
        let content: string;
        try {
            const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
            const result = tool ? await tool.execute(args) : `unknown tool: ${call.name}`;
            content = typeof result === "string" ? result : result.text;
        } catch (e) {
            content = `error: ${(e as Error).message}`;
        }
        out.push({ role: "tool", tool_call_id: call.id, content });
    }
    return out;
}

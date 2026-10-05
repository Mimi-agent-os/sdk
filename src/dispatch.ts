/** The Dispatch table: routes gateway frames into store/chat/tool operations. */

import type {
    A2aInvokeOkPayload,
    AskApprovePayload,
    HealthOkPayload,
    ResultPayload,
    SessionId,
} from "@mimi-os/protocol";

import type { Chat } from "./store/chat.ts";
import type { Dispatch, GatewayClient } from "./client.ts";
import { toResultPayload } from "./runtime/tool.ts";
import type { ToolInstance } from "./runtime/tool.ts";

export interface DispatchCtx {
    name: string;
    chat: Chat;
    tools: Map<string, ToolInstance>;
    /** RunOptions.a2a — every entry already checked at boot to name a mounted tool. */
    a2aCommands: ReadonlySet<string>;
    /** RunOptions.unasked: these tools get yes to a mid-execution ask without reaching the gateway. */
    unasked: ReadonlySet<string>;
    bootedAt: number;
    getClient: () => GatewayClient;
    getLastError: () => string | undefined;
}

// the owner's lists show 100 chats (pinned, then the owner's own ahead of delegation threads); the rest stay in agent.db, and one reply stays far under a channel frame
const SESSION_LIST_MAX = 100;

export function buildDispatch(ctx: DispatchCtx): Dispatch {
    const { name, chat, tools } = ctx;
    const runTool = async (
        tool: ToolInstance,
        toolName: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
        extra: { session?: SessionId | undefined; from?: string | undefined },
    ): Promise<ResultPayload> => {
        const result = await tool.execute(args, {
            signal,
            from: extra.from,
            session: extra.session,
            approve: async (label, detail) => {
                if (ctx.unasked.has(toolName)) return true;
                const payload: AskApprovePayload = { label, detail };
                if (extra.session !== undefined) payload.session = extra.session;
                const answer = await ctx.getClient().askApprove(payload, undefined, signal);
                return answer.approved;
            },
        });
        return toResultPayload(result);
    };
    return {
        invoke: async (p, reqCtx) => {
            const tool = tools.get(p.tool);
            if (!tool) throw new Error(`No tool "${p.tool}" in agent "${name}".`);
            return runTool(tool, p.tool, p.args, reqCtx.signal, { session: p.session });
        },
        a2aInvoke: async (p, reqCtx): Promise<A2aInvokeOkPayload> => {
            if (!ctx.a2aCommands.has(p.command)) {
                throw new Error(`"${p.command}" is not an a2a command of agent "${name}".`);
            }
            const tool = tools.get(p.command);
            if (!tool) throw new Error(`No tool "${p.command}" in agent "${name}".`);
            const result = await runTool(tool, p.command, p.args, reqCtx.signal, { from: p.from });
            return { result };
        },
        sessionHead: (p) => ({ heads: chat.sessionHead(p.sessions) }),
        eventsAfter: (p) => chat.eventsAfter(p.session, p.afterSeq, p.limit),
        // the gateway caused this write, so no session_changed is pushed back at it
        append: (p) => {
            const { head, results } = chat.appendMany(p.session, p.events, { notify: false });
            return { head, seqs: results.map((r) => r.seq) };
        },
        sessionCreate: (p) => {
            const id = chat.createSession(p);
            const head = chat.head(id);
            if (!head) throw new Error("session_create: the new session vanished.");
            return { head };
        },
        sessionList: (p) => ({
            sessions: chat.listSessions(p.includeArchived === true, SESSION_LIST_MAX).map((s) => ({
                session: s.id,
                title: s.title,
                titleByUser: s.titleByUser,
                archived: s.archived,
                pinned: s.pinned,
                events: s.events,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                head: {
                    session: s.id,
                    revision: s.revision,
                    headSeq: s.headSeq,
                    headHash: s.headHash,
                },
            })),
        }),
        sessionUpdate: (p) => ({
            applied: chat.updateSession(p.session, p),
        }),
        sessionDelete: (p) => ({ deleted: chat.deleteSession(p.session) }),
        health: (): HealthOkPayload => ({
            uptimeMs: Date.now() - ctx.bootedAt,
            sessions: chat.sessionCount(),
            lastError: ctx.getLastError(),
        }),
    };
}

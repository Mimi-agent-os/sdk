/** events → the Message[] a prompt is built from: compaction replaces, truncate hides, parity repaired. */

import { foldEvents, INTERRUPTED_TOOL_RESULT, sanitizeHistory } from "@mimi-os/protocol";
import type { Message, SessionId } from "@mimi-os/protocol";
import type { Chat } from "./chat.ts";

export { sanitizeHistory };

/** The call ids of a trailing tool_calls group nothing has answered ([] when history is paired). */
function danglingTail(messages: readonly Message[]): string[] {
    // only the last non-tool message can open a trailing group; sanitizeHistory backfills anything earlier
    const last = messages.findLastIndex((m) => m.role !== "tool");
    const group = messages[last];
    const answered = new Set(messages.slice(last + 1).map((m) => m.tool_call_id));
    const calls = group?.role === "assistant" ? (group.tool_calls ?? []) : [];
    return calls.map((c) => c.id).filter((id) => !answered.has(id));
}

export class Projection {
    private readonly chat: Chat;

    constructor(chat: Chat) {
        this.chat = chat;
    }

    /** Compaction/truncate applied, parity untouched — what repairParity inspects. */
    folded(session: SessionId): Message[] {
        return foldEvents(this.chat.events(session)).map((e) => e.message);
    }

    /** The prompt history: folded, then paired (in memory) so no request can carry a broken pair. */
    project(session: SessionId): Message[] {
        return sanitizeHistory(this.folded(session));
    }

    /** Invariant #4, on disk: a died turn's unanswered tool_calls get error results appended as real events; idempotent. */
    repairParity(session: SessionId): number {
        const missing = danglingTail(this.folded(session));
        if (!missing.length) return 0;
        this.chat.appendMany(
            session,
            missing.map((id) => ({
                type: "message" as const,
                payload: { role: "tool" as const, content: INTERRUPTED_TOOL_RESULT, tool_call_id: id },
            })),
        );
        return missing.length;
    }
}

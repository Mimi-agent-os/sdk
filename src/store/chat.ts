/** The one event-write path: every append joins one hash chain in one transaction. */

import { chainHash, MAX_EVENT_BYTES } from "@mimi-os/protocol";
import type {
    EventBody,
    EventsAfterOkPayload,
    SessionHead,
    SessionId,
    StoredEvent,
} from "@mimi-os/protocol";
import { transaction, type AgentStore } from "./store.ts";

export interface AppendResult {
    seq: number;
    revision: number;
    hash: string;
}

export interface SessionInfo {
    id: SessionId;
    title: string | null;
    titleByUser: boolean;
    archived: boolean;
    pinned: boolean;
    revision: number;
    headSeq: number;
    headHash: string;
    createdAt: number;
    updatedAt: number;
    events: number;
}

export interface SessionPatch {
    title?: string | undefined;
    titleByUser?: boolean | undefined;
    archived?: boolean | undefined;
    pinned?: boolean | undefined;
}

const EVENTS_PAGE_MAX = 1000;
// Keeps what a reader holds per page small; one event up to MAX_EVENT_BYTES still travels alone in its own page.
const EVENTS_PAGE_BYTES = 512 * 1024;
// seq, type, hash and createdAt, serialized around each event's stored payload text.
const EVENT_ENVELOPE_BYTES = 160;
const EVENT_TYPES = new Set<string>(["message", "compaction", "truncate"] satisfies EventBody["type"][]);
const SESSION_SELECT = `SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS events
                        FROM sessions s`;
// A thread the gateway opened for a delegation (gateway-tools.ts); a real kind column would replace this title rule.
const DELEGATION_THREAD = "(s.title_by_user = 1 AND IFNULL(s.title, '') LIKE '← %')";

// canon() has no toJSON hook, so a Date would hash differently than it reloads — payloads carry epoch-ms numbers, not Date objects.
function assertNoDates(value: unknown, path = "payload"): void {
    if (value instanceof Date) {
        throw new Error(`${path} is a Date — payloads carry epoch-ms numbers, not Date objects.`);
    }
    if (Array.isArray(value)) {
        value.forEach((v, i) => assertNoDates(v, `${path}[${i}]`));
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            assertNoDates(v, `${path}.${k}`);
        }
    }
}

function toStored(r: unknown): StoredEvent {
    const row = r as Record<string, unknown>;
    const type = String(row["type"]);
    if (!EVENT_TYPES.has(type)) throw new Error(`Event ${row["seq"]}: unknown type "${type}".`);
    return {
        seq: Number(row["seq"]),
        type,
        payload: JSON.parse(String(row["payload"])),
        hash: String(row["hash"]),
        createdAt: Number(row["created_at"]),
    } as StoredEvent;
}

function toInfo(r: unknown): SessionInfo {
    const row = r as Record<string, unknown>;
    return {
        id: Number(row["id"]),
        title: row["title"] === null ? null : String(row["title"]),
        titleByUser: Number(row["title_by_user"]) === 1,
        archived: Number(row["archived"]) === 1,
        pinned: Number(row["pinned"]) === 1,
        revision: Number(row["revision"]),
        headSeq: Number(row["head_seq"]),
        headHash: String(row["head_hash"]),
        createdAt: Number(row["created_at"]),
        updatedAt: Number(row["updated_at"]),
        events: Number(row["events"] ?? 0),
    };
}

/** Sessions and their event log. Nothing else in the SDK writes to those two tables. */
export class Chat {
    private readonly store: AgentStore;
    private notify: ((head: SessionHead) => void) | undefined;

    constructor(store: AgentStore) {
        this.store = store;
    }

    /** Where session_changed goes once a gateway connection exists. Best-effort, never awaited. */
    onChange(fn: ((head: SessionHead) => void) | undefined): void {
        this.notify = fn;
    }

    createSession(opts?: { title?: string | undefined; titleByUser?: boolean | undefined }): SessionId {
        const now = Date.now();
        return Number(
            this.store.db
                .prepare(
                    `INSERT INTO sessions (title, title_by_user, created_at, updated_at)
                     VALUES (?, ?, ?, ?)`,
                )
                .run(opts?.title ?? null, opts?.titleByUser ? 1 : 0, now, now).lastInsertRowid,
        );
    }

    /** Pinned first, then the owner's chats, then delegation threads, each by last activity; `limit` bounds the page (SQLite reads -1 as no limit). */
    listSessions(includeArchived = false, limit = -1): SessionInfo[] {
        const where = includeArchived ? "" : "WHERE s.archived = 0";
        return this.store.db
            .prepare(
                `${SESSION_SELECT} ${where}
                 ORDER BY s.pinned DESC, ${DELEGATION_THREAD} ASC, s.updated_at DESC, s.id DESC LIMIT ?`,
            )
            .all(limit)
            .map(toInfo);
    }

    sessionCount(): number {
        const row = this.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
            count: number;
        };
        return Number(row.count);
    }

    getSession(id: SessionId): SessionInfo | null {
        const row = this.store.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
        return row === undefined ? null : toInfo(row);
    }

    /** Metadata only — moves neither `revision` nor `updated_at`: a cache that matched still matches, and a pin or rename never reorders the list. */
    updateSession(id: SessionId, patch: SessionPatch): boolean {
        const sets: string[] = [];
        const args: Array<string | number> = [];
        const hasNonTitleChanges = patch.archived !== undefined || patch.pinned !== undefined;
        if (patch.title !== undefined) {
            // Keep independent metadata writable when a machine title loses to a human one.
            sets.push(
                !patch.titleByUser && hasNonTitleChanges
                    ? "title = CASE WHEN title_by_user = 0 THEN ? ELSE title END"
                    : "title = ?",
            );
            args.push(patch.title);
            if (patch.titleByUser) sets.push("title_by_user = 1");
        }
        if (patch.archived !== undefined) {
            sets.push("archived = ?");
            args.push(patch.archived ? 1 : 0);
        }
        if (patch.pinned !== undefined) {
            sets.push("pinned = ?");
            args.push(patch.pinned ? 1 : 0);
        }
        if (!sets.length) return this.getSession(id) !== null;
        args.push(id);
        const guard =
            patch.title !== undefined && !patch.titleByUser && !hasNonTitleChanges
                ? " AND title_by_user = 0"
                : "";
        const r = this.store.db
            .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?${guard}`)
            .run(...args);
        return Number(r.changes) > 0;
    }

    /** Whole-session delete, events included — accounting is the gateway's job, not this module's. */
    deleteSession(id: SessionId): boolean {
        const db = this.store.db;
        return transaction(db, () => {
            db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
            return Number(db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes) > 0;
        });
    }

    head(id: SessionId): SessionHead | null {
        return this.sessionHead([id])[0] ?? null;
    }

    /** Heads for the ids the caller holds; sessions this agent does not know are simply absent. */
    sessionHead(ids: readonly SessionId[]): SessionHead[] {
        return this.store.db
            .prepare(
                `SELECT id, revision, head_seq, head_hash FROM sessions
                 WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .all(JSON.stringify(ids))
            .map((r) => {
                const row = r as Record<string, unknown>;
                return {
                    session: Number(row["id"]),
                    revision: Number(row["revision"]),
                    headSeq: Number(row["head_seq"]),
                    headHash: String(row["head_hash"]),
                };
            });
    }

    /** Every event of a session, in seq order — the projection's raw material. `images: false` strips message images inside SQLite; no hash is ever recomputed from such a read. */
    events(session: SessionId, opts?: { images?: boolean }): StoredEvent[] {
        const payload =
            opts?.images === false
                ? "CASE type WHEN 'message' THEN json_remove(payload, '$.images') ELSE payload END AS payload"
                : "payload";
        return this.store.db
            .prepare(
                `SELECT seq, type, ${payload}, hash, created_at FROM events
                 WHERE session_id = ? ORDER BY seq`,
            )
            .all(session)
            .map(toStored);
    }

    eventsAfter(session: SessionId, afterSeq: number, limit?: number): EventsAfterOkPayload {
        const head = this.head(session);
        if (!head) throw new Error(`No session ${session}.`);
        const n = Math.max(1, Math.min(EVENTS_PAGE_MAX, Math.floor(limit ?? EVENTS_PAGE_MAX)));
        const after = Math.max(0, Math.floor(afterSeq));
        // row by row: at most one row past the byte budget is ever read
        const rows = this.store.db
            .prepare(
                `SELECT seq, type, payload, hash, created_at FROM events
                 WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
            )
            .iterate(session, after, n);
        const events: StoredEvent[] = [];
        let bytes = 0;
        for (const row of rows) {
            // the stored payload text is what travels; the rest of the event is the fixed envelope around it
            const stored = (row as Record<string, unknown>)["payload"];
            bytes += Buffer.byteLength(String(stored), "utf8") + EVENT_ENVELOPE_BYTES;
            // the page must carry at least one event, however big that one is
            if (bytes > EVENTS_PAGE_BYTES && events.length > 0) break;
            events.push(toStored(row));
        }
        return { events, head, more: (events.at(-1)?.seq ?? after) < head.headSeq };
    }

    /** One event: INSERT + head/revision bump in a single transaction. */
    append(session: SessionId, body: EventBody): AppendResult {
        const first = this.appendMany(session, [body]).results[0];
        if (!first) throw new Error("append: the transaction produced no event.");
        return first;
    }

    /** One transaction, all or nothing: seq runs head_seq+1.., each hash chains onto the previous one, revision counts events appended. */
    appendMany(
        session: SessionId,
        bodies: readonly EventBody[],
        opts?: { notify?: boolean },
    ): { head: SessionHead; results: AppendResult[] } {
        const storedBodies = bodies.map((body) => {
            if (!EVENT_TYPES.has(body.type)) throw new Error(`Unknown event type "${body.type}".`);
            assertNoDates(body.payload);
            const json = JSON.stringify(body.payload);
            if (json === undefined) throw new Error("Event payload must be JSON-serializable.");
            // no events_after page could carry it back
            const bytes = Buffer.byteLength(json, "utf8");
            if (bytes > MAX_EVENT_BYTES) {
                throw new Error(`Event payload is ${bytes} bytes, over the ${MAX_EVENT_BYTES} one event may carry.`);
            }
            return { type: body.type, payload: JSON.parse(json), json };
        });
        if (bodies.length === 0) {
            const current = this.head(session);
            if (!current) throw new Error(`No session ${session}.`);
            return { head: current, results: [] };
        }
        const db = this.store.db;
        const now = Date.now();
        const results: AppendResult[] = [];
        const head = transaction(db, (): SessionHead => {
            const current = this.head(session);
            if (!current) throw new Error(`No session ${session}.`);
            let { revision, headSeq: seq, headHash: hash } = current;
            const insert = db.prepare(
                `INSERT INTO events (session_id, seq, type, payload, hash, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            );
            for (const body of storedBodies) {
                seq += 1;
                revision += 1;
                hash = chainHash(hash, { seq, type: body.type, payload: body.payload });
                insert.run(session, seq, body.type, body.json, hash, now);
                results.push({ seq, revision, hash });
            }
            db.prepare(
                `UPDATE sessions SET revision = ?, head_seq = ?, head_hash = ?, updated_at = ?
                 WHERE id = ?`,
            ).run(revision, seq, hash, now, session);
            return { session, revision, headSeq: seq, headHash: hash };
        });
        // the push is an optimisation, the HEAD check is the truth — a dead socket must not fail a write
        if (opts?.notify !== false) {
            try {
                this.notify?.(head);
            } catch {
                /* a lost session_changed costs latency, never correctness */
            }
        }
        return { head, results };
    }
}

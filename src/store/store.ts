/** The agent's own SQLite file: sessions + append-only events. */

import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { assertAgentName, dbFile, ensureDataDir } from "../runtime/paths.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT,
    title_by_user INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    revision      INTEGER NOT NULL DEFAULT 0,
    head_seq      INTEGER NOT NULL DEFAULT 0,
    head_hash     TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    session_id INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    hash       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;

/** BEGIN IMMEDIATE → fn → COMMIT; a throw rolls back and rethrows the original error. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const out = fn();
        db.exec("COMMIT");
        return out;
    } catch (e) {
        try {
            db.exec("ROLLBACK");
        } catch {
            /* the original error is the one worth throwing */
        }
        throw e;
    }
}

/** One agent's database, in its data folder. One process = one agent = one of these. */
export class AgentStore {
    readonly agent: string;
    readonly data: string;
    readonly db: DatabaseSync;

    constructor(agent: string, data: string) {
        assertAgentName(agent);
        this.agent = agent;
        this.data = data;
        ensureDataDir(data); // open creates the file, not the dir
        const file = dbFile(data);
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (entry && !entry.isFile()) {
            throw new Error(`agent database must be a regular file: ${file}`);
        }
        this.db = new DatabaseSync(file);
        try {
            this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
            transaction(this.db, () => {
                this.db.exec(SCHEMA);
                // a new file never hands out an old chat id again: the gateway keys call history by (agent, chat id)
                this.db
                    .prepare(
                        "INSERT INTO sqlite_sequence (name, seq) SELECT 'sessions', ? " +
                            "WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'sessions')",
                    )
                    .run(Date.now());
            });
        } catch (e) {
            try {
                this.db.close();
            } catch {
                /* already dead */
            }
            throw e;
        }
    }

    close(): void {
        try {
            this.db.close();
        } catch {
            // a close failure must not block shutdown
        }
    }
}

export const openStore = (agent: string, data: string): AgentStore => new AgentStore(agent, data);

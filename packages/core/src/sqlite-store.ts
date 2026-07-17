import Database from "better-sqlite3";

import {
  type RegisterEntry,
  type VectorClock,
  cloneEntry,
  mergeClocks,
  resolveEntry,
} from "./crdt.js";
import type { ChangeLogEntry, RemoteMergeStore, SyncStore } from "./storage.js";

interface StateRow {
  key: string;
  value: string;
  timestamp: number;
  vector_clock: string;
  client_id: string;
}

interface LogRow extends StateRow {
  id: number;
  applied_at: number;
}

class BetterSqliteSyncStore<T> implements SyncStore<T>, RemoteMergeStore<T> {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly clientId: string,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.createSchema();
  }

  applyLocalWrite(key: string, value: T): void {
    const currentClock = this.getClockForLocalWrite(key);
    currentClock[this.clientId] = (currentClock[this.clientId] ?? 0) + 1;

    const entry: RegisterEntry<T> = {
      value,
      timestamp: Date.now(),
      vectorClock: currentClock,
      clientId: this.clientId,
    };

    this.persistEntry(key, entry, Date.now());
  }

  getFullState(): Record<string, RegisterEntry<T>> {
    const rows = this.db
      .prepare(
        "SELECT key, value, timestamp, vector_clock, client_id FROM current_state ORDER BY key",
      )
      .all() as StateRow[];

    return Object.fromEntries(rows.map((row) => [row.key, this.rowToEntry(row)]));
  }

  getChangesSince(lastLogId: number): ChangeLogEntry<T>[] {
    const rows = this.db
      .prepare(
        `SELECT id, key, value, timestamp, vector_clock, client_id, applied_at
         FROM change_log
         WHERE id > ?
         ORDER BY id ASC`,
      )
      .all(lastLogId) as LogRow[];

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      entry: this.rowToEntry(row),
      appliedAt: row.applied_at,
    }));
  }

  getLatestLogId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM change_log").get() as {
      id: number;
    };

    return row.id;
  }

  applyRemoteState(remoteState: Record<string, RegisterEntry<T>>): void {
    const localState = this.getFullState();
    const appliedAt = Date.now();

    const merge = this.db.transaction(() => {
      for (const [key, remoteEntry] of Object.entries(remoteState)) {
        const localEntry = localState[key];

        if (!localEntry) {
          this.persistEntry(key, remoteEntry, appliedAt);
          continue;
        }

        const winner = resolveEntry(localEntry, remoteEntry);
        const mergedEntry = {
          ...cloneEntry(winner)!,
          vectorClock: mergeClocks(localEntry.vectorClock, remoteEntry.vectorClock),
        };

        if (!entriesEqual(localEntry, mergedEntry)) {
          this.persistEntry(key, mergedEntry, appliedAt);
        }
      }
    });

    merge();
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS current_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        vector_clock TEXT NOT NULL,
        client_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        vector_clock TEXT NOT NULL,
        client_id TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  }

  private persistEntry(key: string, entry: RegisterEntry<T>, appliedAt: number): void {
    const value = JSON.stringify(entry.value);
    const vectorClock = JSON.stringify(entry.vectorClock);

    this.db
      .prepare(
        `INSERT INTO current_state (key, value, timestamp, vector_clock, client_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           timestamp = excluded.timestamp,
           vector_clock = excluded.vector_clock,
           client_id = excluded.client_id`,
      )
      .run(key, value, entry.timestamp, vectorClock, entry.clientId);

    this.db
      .prepare(
        `INSERT INTO change_log (key, value, timestamp, vector_clock, client_id, applied_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, value, entry.timestamp, vectorClock, entry.clientId, appliedAt);
  }

  private rowToEntry(row: StateRow): RegisterEntry<T> {
    return {
      value: JSON.parse(row.value) as T,
      timestamp: row.timestamp,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
      clientId: row.client_id,
    };
  }

  private getClockForLocalWrite(key: string): VectorClock {
    const previous = this.db
      .prepare(
        "SELECT key, value, timestamp, vector_clock, client_id FROM current_state WHERE key = ?",
      )
      .get(key) as StateRow | undefined;
    const clock = previous ? { ...this.rowToEntry(previous).vectorClock } : {};
    const localCounter = Object.values(this.getFullState()).reduce(
      (highest, entry) => Math.max(highest, entry.vectorClock[this.clientId] ?? 0),
      0,
    );

    clock[this.clientId] = Math.max(clock[this.clientId] ?? 0, localCounter);
    return clock;
  }
}

export function openStore<T>(dbPath: string, clientId: string): SyncStore<T> {
  return new BetterSqliteSyncStore<T>(dbPath, clientId);
}

function entriesEqual<T>(left: RegisterEntry<T>, right: RegisterEntry<T>): boolean {
  return (
    JSON.stringify(left.value) === JSON.stringify(right.value) &&
    left.timestamp === right.timestamp &&
    left.clientId === right.clientId &&
    JSON.stringify(left.vectorClock) === JSON.stringify(right.vectorClock)
  );
}

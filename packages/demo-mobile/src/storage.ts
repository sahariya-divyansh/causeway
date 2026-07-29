import * as SQLite from "expo-sqlite";
import {
  type RegisterEntry,
  type VectorClock,
  resolveEntry,
  cloneEntry,
  mergeClocks,
} from "@causeway-sync/core";

export interface ChangeLogEntry<T> {
  id: number;
  key: string;
  entry: RegisterEntry<T>;
  appliedAt: number;
}

/**
 * AsyncSyncStore represents an asynchronous sync store interface, designed to support
 * asynchronous storage engines like expo-sqlite on mobile platforms.
 * 
 * NOTE ON ARCHITECTURE (v1 known limitation):
 * The core SyncStore interface in packages/core is synchronous because better-sqlite3
 * on desktop is synchronous. Rather than refactoring the desktop codebase and tests
 * to return Promises, we maintain this separate AsyncSyncStore interface specifically
 * for mobile platforms in v1.
 */
export interface AsyncSyncStore<T> {
  applyLocalWrite(key: string, value: T): Promise<void>;
  getFullState(): Promise<Record<string, RegisterEntry<T>>>;
  getChangesSince(lastLogId: number): Promise<ChangeLogEntry<T>[]>;
  getLatestLogId(): Promise<number>;
  applyRemoteState(remoteState: Record<string, RegisterEntry<T>>): Promise<void>;
  close(): Promise<void>;
}

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

export class ExpoSqliteSyncStore<T> implements AsyncSyncStore<T> {
  private constructor(
    private readonly db: SQLite.SQLiteDatabase,
    private readonly clientId: string,
  ) {}

  static async open<T>(dbName: string, clientId: string): Promise<ExpoSqliteSyncStore<T>> {
    const db = await SQLite.openDatabaseAsync(dbName);

    await db.execAsync(`
      PRAGMA journal_mode = WAL;
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

    return new ExpoSqliteSyncStore<T>(db, clientId);
  }

  async applyLocalWrite(key: string, value: T): Promise<void> {
    const currentClock = await this.getClockForLocalWrite(key);
    currentClock[this.clientId] = (currentClock[this.clientId] ?? 0) + 1;

    const entry: RegisterEntry<T> = {
      value,
      timestamp: Date.now(),
      vectorClock: currentClock,
      clientId: this.clientId,
    };

    await this.persistEntry(key, entry, Date.now());
  }

  async getFullState(): Promise<Record<string, RegisterEntry<T>>> {
    const rows = await this.db.getAllAsync<StateRow>(
      "SELECT key, value, timestamp, vector_clock, client_id FROM current_state ORDER BY key"
    );

    return Object.fromEntries(rows.map((row) => [row.key, this.rowToEntry(row)]));
  }

  async getChangesSince(lastLogId: number): Promise<ChangeLogEntry<T>[]> {
    const rows = await this.db.getAllAsync<LogRow>(
      `SELECT id, key, value, timestamp, vector_clock, client_id, applied_at
       FROM change_log
       WHERE id > ?
       ORDER BY id ASC`,
      [lastLogId]
    );

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      entry: this.rowToEntry(row),
      appliedAt: row.applied_at,
    }));
  }

  async getLatestLogId(): Promise<number> {
    const row = await this.db.getFirstAsync<{ id: number }>(
      "SELECT COALESCE(MAX(id), 0) AS id FROM change_log"
    );

    return row?.id ?? 0;
  }

  async applyRemoteState(remoteState: Record<string, RegisterEntry<T>>): Promise<void> {
    const localState = await this.getFullState();
    const appliedAt = Date.now();

    await this.db.withTransactionAsync(async () => {
      for (const [key, remoteEntry] of Object.entries(remoteState)) {
        const localEntry = localState[key];

        if (!localEntry) {
          await this.persistEntry(key, remoteEntry, appliedAt);
          continue;
        }

        const winner = resolveEntry(localEntry, remoteEntry);
        const mergedEntry = {
          ...cloneEntry(winner)!,
          vectorClock: mergeClocks(localEntry.vectorClock, remoteEntry.vectorClock),
        };

        if (!entriesEqual(localEntry, mergedEntry)) {
          await this.persistEntry(key, mergedEntry, appliedAt);
        }
      }
    });
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }

  private async persistEntry(key: string, entry: RegisterEntry<T>, appliedAt: number): Promise<void> {
    const value = JSON.stringify(entry.value);
    const vectorClock = JSON.stringify(entry.vectorClock);

    await this.db.runAsync(
      `INSERT INTO current_state (key, value, timestamp, vector_clock, client_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         timestamp = excluded.timestamp,
         vector_clock = excluded.vector_clock,
         client_id = excluded.client_id`,
      [key, value, entry.timestamp, vectorClock, entry.clientId]
    );

    await this.db.runAsync(
      `INSERT INTO change_log (key, value, timestamp, vector_clock, client_id, applied_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [key, value, entry.timestamp, vectorClock, entry.clientId, appliedAt]
    );
  }

  private rowToEntry(row: StateRow): RegisterEntry<T> {
    return {
      value: JSON.parse(row.value) as T,
      timestamp: row.timestamp,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
      clientId: row.client_id,
    };
  }

  private async getClockForLocalWrite(key: string): Promise<VectorClock> {
    const previous = await this.db.getFirstAsync<StateRow>(
      "SELECT key, value, timestamp, vector_clock, client_id FROM current_state WHERE key = ?",
      [key]
    );
    const clock = previous ? { ...this.rowToEntry(previous).vectorClock } : {};

    const fullState = await this.getFullState();
    const localCounter = Object.values(fullState).reduce(
      (highest, entry) => Math.max(highest, entry.vectorClock[this.clientId] ?? 0),
      0,
    );

    clock[this.clientId] = Math.max(clock[this.clientId] ?? 0, localCounter);
    return clock;
  }
}

function entriesEqual<T>(left: RegisterEntry<T>, right: RegisterEntry<T>): boolean {
  return (
    JSON.stringify(left.value) === JSON.stringify(right.value) &&
    left.timestamp === right.timestamp &&
    left.clientId === right.clientId &&
    JSON.stringify(left.vectorClock) === JSON.stringify(right.vectorClock)
  );
}

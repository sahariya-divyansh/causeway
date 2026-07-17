import type { RegisterEntry } from "./crdt.js";

export interface ChangeLogEntry<T> {
  id: number;
  key: string;
  entry: RegisterEntry<T>;
  appliedAt: number;
}

export interface SyncStore<T> {
  applyLocalWrite(key: string, value: T): void;
  getFullState(): Record<string, RegisterEntry<T>>;
  getChangesSince(lastLogId: number): ChangeLogEntry<T>[];
  getLatestLogId(): number;
  close(): void;
}

export interface RemoteMergeStore<T> {
  applyRemoteState(remoteState: Record<string, RegisterEntry<T>>): void;
}

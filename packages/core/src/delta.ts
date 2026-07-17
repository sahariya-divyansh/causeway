import { decode, encode } from "cbor-x";

import type { RegisterEntry } from "./crdt.js";
import type { ChangeLogEntry, RemoteMergeStore, SyncStore } from "./storage.js";

export function computeDelta<T>(
  changes: ChangeLogEntry<T>[],
): Record<string, RegisterEntry<T>> {
  return Object.fromEntries(changes.map((change) => [change.key, change.entry]));
}

export function encodeDelta<T>(delta: Record<string, RegisterEntry<T>>): Buffer {
  return Buffer.from(encode(delta));
}

export function decodeDelta<T>(buf: Buffer): Record<string, RegisterEntry<T>> {
  return decode(buf) as Record<string, RegisterEntry<T>>;
}

export function applyRemoteDelta<T>(store: SyncStore<T>, encodedDelta: Buffer): void {
  const remoteState = decodeDelta<T>(encodedDelta);
  const remoteMergeStore = store as SyncStore<T> & Partial<RemoteMergeStore<T>>;

  if (!remoteMergeStore.applyRemoteState) {
    throw new Error("This SyncStore implementation does not support applying remote deltas.");
  }

  remoteMergeStore.applyRemoteState(remoteState);
}

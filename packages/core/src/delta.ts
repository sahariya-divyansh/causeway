import { decode, encode } from "cbor-x";

import type { RegisterEntry } from "./crdt.js";
import type { ChangeLogEntry, RemoteMergeStore, SyncStore } from "./storage.js";

type WireRegisterEntry<T> = [
  value: T,
  timestamp: number,
  vectorClock: RegisterEntry<T>["vectorClock"],
  clientId: string,
];

export function computeDelta<T>(changes: ChangeLogEntry<T>[]): Record<string, RegisterEntry<T>> {
  return Object.fromEntries(changes.map((change) => [change.key, change.entry]));
}

export function encodeDelta<T>(delta: Record<string, RegisterEntry<T>>): Buffer {
  const wireDelta = Object.fromEntries(
    Object.entries(delta).map(([key, entry]) => [
      key,
      [
        entry.value,
        entry.timestamp,
        entry.vectorClock,
        entry.clientId,
      ] satisfies WireRegisterEntry<T>,
    ]),
  );

  return Buffer.from(encode(wireDelta));
}

export function decodeDelta<T>(buf: Buffer): Record<string, RegisterEntry<T>> {
  const wireDelta = decode(buf) as Record<string, WireRegisterEntry<T>>;

  return Object.fromEntries(
    Object.entries(wireDelta).map(([key, [value, timestamp, vectorClock, clientId]]) => [
      key,
      {
        value,
        timestamp,
        vectorClock,
        clientId,
      },
    ]),
  );
}

export function applyRemoteDelta<T>(store: SyncStore<T>, encodedDelta: Buffer): void {
  const remoteState = decodeDelta<T>(encodedDelta);
  const remoteMergeStore = store as SyncStore<T> & Partial<RemoteMergeStore<T>>;

  if (!remoteMergeStore.applyRemoteState) {
    throw new Error("This SyncStore implementation does not support applying remote deltas.");
  }

  remoteMergeStore.applyRemoteState(remoteState);
}

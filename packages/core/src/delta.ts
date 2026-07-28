import { decode, encode } from "cbor-x";

import type { RegisterEntry } from "./crdt.js";
import type { ChangeLogEntry, RemoteMergeStore, SyncStore } from "./storage.js";

type WireRegisterEntryIndexed<T> = [
  value: T,
  timestamp: number,
  vectorClock: [number, number][],
  clientIdIndex: number,
];

interface WireDelta<T> {
  c: string[]; // Client ID dictionary (c is for clients)
  d: Record<string, WireRegisterEntryIndexed<T>>; // Delta entries (d is for delta)
}

export function computeDelta<T>(changes: ChangeLogEntry<T>[]): Record<string, RegisterEntry<T>> {
  return Object.fromEntries(changes.map((change) => [change.key, change.entry]));
}

export function encodeDelta<T>(delta: Record<string, RegisterEntry<T>>): Buffer {
  const clientIdsSet = new Set<string>();
  for (const entry of Object.values(delta)) {
    clientIdsSet.add(entry.clientId);
    for (const cid of Object.keys(entry.vectorClock)) {
      clientIdsSet.add(cid);
    }
  }
  const clientIds = Array.from(clientIdsSet);
  const clientIdToIndex = new Map<string, number>(
    clientIds.map((cid, index) => [cid, index])
  );

  const d: Record<string, WireRegisterEntryIndexed<T>> = {};
  for (const [key, entry] of Object.entries(delta)) {
    const vcIndexed: [number, number][] = Object.entries(entry.vectorClock).map(
      ([cid, counter]) => {
        const idx = clientIdToIndex.get(cid);
        if (idx === undefined) {
          throw new Error(`Client ID ${cid} not found in intern table`);
        }
        return [idx, counter];
      }
    );
    const clientIdIndex = clientIdToIndex.get(entry.clientId);
    if (clientIdIndex === undefined) {
      throw new Error(`Client ID ${entry.clientId} not found in intern table`);
    }
    d[key] = [
      entry.value,
      entry.timestamp,
      vcIndexed,
      clientIdIndex,
    ];
  }

  const wireDelta: WireDelta<T> = {
    c: clientIds,
    d,
  };

  return Buffer.from(encode(wireDelta));
}

export function decodeDelta<T>(buf: Buffer): Record<string, RegisterEntry<T>> {
  const wireDelta = decode(buf) as WireDelta<T>;
  const clientIds = wireDelta.c;

  return Object.fromEntries(
    Object.entries(wireDelta.d).map(([key, [value, timestamp, vcIndexed, clientIdIndex]]) => {
      const vectorClock: Record<string, number> = {};
      for (const [idx, counter] of vcIndexed) {
        const cid = clientIds[idx];
        if (cid === undefined) {
          throw new Error(`Client ID index ${idx} not found in intern table`);
        }
        vectorClock[cid] = counter;
      }

      const clientId = clientIds[clientIdIndex];
      if (clientId === undefined) {
        throw new Error(`Client ID index ${clientIdIndex} not found in intern table`);
      }

      return [
        key,
        {
          value,
          timestamp,
          vectorClock,
          clientId,
        },
      ];
    }),
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

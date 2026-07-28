import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openStore } from "../src/sqlite-store.js";
import { computeDelta } from "../src/delta.js";
import type { RemoteMergeStore, SyncStore } from "../src/storage.js";

interface Invoice {
  status: string;
  amount: number;
}

describe("better-sqlite3 SyncStore", () => {
  let dbPath: string;
  let store: SyncStore<Invoice>;

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = join(tmpdir(), `causeway-core-${randomUUID()}.sqlite`);
    store = openStore<Invoice>(dbPath, "A");
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
      }
    }
  });

  it("opens a store, applies writes, and returns the full state", () => {
    vi.setSystemTime(1000);
    store.applyLocalWrite("invoice:1", { status: "draft", amount: 500 });
    vi.setSystemTime(2000);
    store.applyLocalWrite("invoice:2", { status: "paid", amount: 750 });

    expect(store.getFullState()).toMatchObject({
      "invoice:1": {
        value: { status: "draft", amount: 500 },
        timestamp: 1000,
        vectorClock: { A: 1 },
        clientId: "A",
      },
      "invoice:2": {
        value: { status: "paid", amount: 750 },
        timestamp: 2000,
        vectorClock: { A: 2 },
        clientId: "A",
      },
    });
  });

  it("creates change log entries in order with correct IDs", () => {
    vi.setSystemTime(1000);
    store.applyLocalWrite("invoice:1", { status: "draft", amount: 500 });
    vi.setSystemTime(2000);
    store.applyLocalWrite("invoice:2", { status: "paid", amount: 750 });

    const changes = store.getChangesSince(0);

    expect(changes.map((change) => change.id)).toEqual([1, 2]);
    expect(changes.map((change) => change.key)).toEqual(["invoice:1", "invoice:2"]);
    expect(changes.map((change) => change.entry.value.status)).toEqual(["draft", "paid"]);
  });

  it("persists state after closing and reopening the same file", () => {
    vi.setSystemTime(1000);
    store.applyLocalWrite("invoice:1", { status: "draft", amount: 500 });
    store.close();

    store = openStore<Invoice>(dbPath, "A");

    expect(store.getFullState()["invoice:1"]).toMatchObject({
      value: { status: "draft", amount: 500 },
      timestamp: 1000,
      vectorClock: { A: 1 },
      clientId: "A",
    });
  });

  it("returns only changes after the provided log id in order", () => {
    vi.setSystemTime(1000);
    store.applyLocalWrite("invoice:1", { status: "draft", amount: 500 });
    vi.setSystemTime(2000);
    store.applyLocalWrite("invoice:2", { status: "paid", amount: 750 });
    vi.setSystemTime(3000);
    store.applyLocalWrite("invoice:3", { status: "void", amount: 0 });

    expect(store.getLatestLogId()).toBe(3);
    expect(store.getChangesSince(1).map((change) => change.key)).toEqual([
      "invoice:2",
      "invoice:3",
    ]);
  });

  it("keeps local write vector clocks scoped to the written key history", () => {
    const mergeStore = store as SyncStore<Invoice> & RemoteMergeStore<Invoice>;

    vi.setSystemTime(1000);
    mergeStore.applyRemoteState({
      "invoice:remote-only": {
        value: { status: "sent", amount: 900 },
        timestamp: 1000,
        vectorClock: { B: 1, C: 1 },
        clientId: "B",
      },
    });

    vi.setSystemTime(2000);
    store.applyLocalWrite("invoice:local-only", { status: "draft", amount: 500 });

    expect(store.getFullState()["invoice:local-only"].vectorClock).toEqual({ A: 1 });

    vi.setSystemTime(3000);
    mergeStore.applyRemoteState({
      "invoice:shared": {
        value: { status: "review", amount: 750 },
        timestamp: 3000,
        vectorClock: { B: 2 },
        clientId: "B",
      },
    });

    vi.setSystemTime(4000);
    store.applyLocalWrite("invoice:shared", { status: "approved", amount: 750 });

    expect(store.getFullState()["invoice:shared"].vectorClock).toEqual({ B: 2, A: 2 });
  });

  it("coalesces multiple writes to the same key in computeDelta", () => {
    store.applyLocalWrite("invoice:1", { status: "draft", amount: 100 });
    store.applyLocalWrite("invoice:1", { status: "review", amount: 200 });
    store.applyLocalWrite("invoice:1", { status: "approved", amount: 300 });
    store.applyLocalWrite("invoice:1", { status: "sent", amount: 400 });
    store.applyLocalWrite("invoice:1", { status: "paid", amount: 500 });

    const changes = store.getChangesSince(0);
    expect(changes.length).toBe(5);

    const delta = computeDelta(changes);
    const keys = Object.keys(delta);
    expect(keys).toEqual(["invoice:1"]);
    expect(delta["invoice:1"].value).toEqual({ status: "paid", amount: 500 });
  });
});

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyRemoteDelta, computeDelta, encodeDelta } from "../src/delta.js";
import { openStore } from "../src/sqlite-store.js";
import type { SyncStore } from "../src/storage.js";

interface Task {
  title: string;
  status: string;
}

describe("store convergence over encoded deltas", () => {
  let dbPaths: string[];
  let storeA: SyncStore<Task>;
  let storeB: SyncStore<Task>;

  beforeEach(() => {
    vi.useFakeTimers();
    dbPaths = [
      join(tmpdir(), `setu-a-${randomUUID()}.sqlite`),
      join(tmpdir(), `setu-b-${randomUUID()}.sqlite`),
    ];
    storeA = openStore<Task>(dbPaths[0], "A");
    storeB = openStore<Task>(dbPaths[1], "B");
  });

  afterEach(() => {
    storeA.close();
    storeB.close();
    vi.useRealTimers();
    for (const dbPath of dbPaths) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(path)) {
          rmSync(path, { force: true });
        }
      }
    }
  });

  it("converges two stores after exchanging CBOR-encoded deltas", () => {
    vi.setSystemTime(1000);
    storeA.applyLocalWrite("task:shared", { title: "Collect payment", status: "draft" });
    vi.setSystemTime(1100);
    storeA.applyLocalWrite("task:a-only", { title: "Sync receipts", status: "queued" });

    vi.setSystemTime(2000);
    storeB.applyLocalWrite("task:shared", { title: "Collect payment", status: "sent" });
    vi.setSystemTime(2100);
    storeB.applyLocalWrite("task:b-only", { title: "Upload stock", status: "queued" });

    const deltaFromA = encodeDelta(computeDelta(storeA.getChangesSince(0)));
    applyRemoteDelta(storeB, deltaFromA);

    const deltaFromB = encodeDelta(computeDelta(storeB.getChangesSince(0)));
    applyRemoteDelta(storeA, deltaFromB);

    expect(storeA.getFullState()).toEqual(storeB.getFullState());
    expect(storeA.getFullState()["task:shared"].value.status).toBe("sent");
  });
});

import { vi, describe, it, expect, beforeEach } from "vitest";
import { ExpoSqliteSyncStore } from "../src/storage";

// Define mock in-memory DB tables
const mockCurrentState = new Map<string, any>();
let mockChangeLog: any[] = [];
let nextLogId = 1;

// Define Mock Database methods mimicking modern expo-sqlite
const mockDb = {
  execAsync: vi.fn(async (sql: string) => {
    // No-op for schema setup in unit tests
  }),
  runAsync: vi.fn(async (sql: string, params: any[]) => {
    if (sql.includes("INSERT INTO current_state")) {
      const [key, value, timestamp, vectorClock, clientId] = params;
      mockCurrentState.set(key, {
        key,
        value,
        timestamp,
        vector_clock: vectorClock,
        client_id: clientId,
      });
    } else if (sql.includes("INSERT INTO change_log")) {
      const [key, value, timestamp, vectorClock, clientId, appliedAt] = params;
      mockChangeLog.push({
        id: nextLogId++,
        key,
        value,
        timestamp,
        vector_clock: vectorClock,
        client_id: clientId,
        applied_at: appliedAt,
      });
    }
    return { lastInsertRowId: nextLogId - 1, changes: 1 };
  }),
  getAllAsync: vi.fn(async (sql: string, params?: any[]) => {
    if (sql.includes("FROM current_state")) {
      return Array.from(mockCurrentState.values()).sort((a, b) => a.key.localeCompare(b.key));
    }
    if (sql.includes("FROM change_log")) {
      const lastLogId = params ? params[0] : 0;
      return mockChangeLog.filter((log) => log.id > lastLogId);
    }
    return [];
  }),
  getFirstAsync: vi.fn(async (sql: string, params?: any[]) => {
    if (sql.includes("MAX(id)")) {
      const maxId = mockChangeLog.reduce((max, log) => Math.max(max, log.id), 0);
      return { id: maxId };
    }
    if (sql.includes("FROM current_state WHERE key = ?")) {
      const key = params ? params[0] : "";
      return mockCurrentState.get(key) || null;
    }
    return null;
  }),
  withTransactionAsync: vi.fn(async (callback: () => Promise<void>) => {
    await callback();
  }),
  closeAsync: vi.fn(async () => {}),
};

// Mock expo-sqlite module
vi.mock("expo-sqlite", () => {
  return {
    openDatabaseAsync: vi.fn(async () => mockDb),
  };
});

describe("ExpoSqliteSyncStore (Mocked expo-sqlite)", () => {
  beforeEach(() => {
    mockCurrentState.clear();
    mockChangeLog = [];
    nextLogId = 1;
    vi.clearAllMocks();
  });

  it("opens store, applies writes, and returns full state", async () => {
    const store = await ExpoSqliteSyncStore.open<any>("test.db", "client-A");
    await store.applyLocalWrite("todo:1", { title: "Task 1", completed: false });
    await store.applyLocalWrite("todo:2", { title: "Task 2", completed: true });

    const state = await store.getFullState();
    expect(Object.keys(state)).toEqual(["todo:1", "todo:2"]);
    expect(state["todo:1"].value).toEqual({ title: "Task 1", completed: false });
    expect(state["todo:2"].value).toEqual({ title: "Task 2", completed: true });
    expect(state["todo:1"].clientId).toBe("client-A");
  });

  it("creates change log entries in order with correct IDs", async () => {
    const store = await ExpoSqliteSyncStore.open<any>("test.db", "client-A");
    await store.applyLocalWrite("todo:1", { title: "Task 1", completed: false });
    await store.applyLocalWrite("todo:2", { title: "Task 2", completed: true });

    const changes = await store.getChangesSince(0);
    expect(changes.length).toBe(2);
    expect(changes[0].id).toBe(1);
    expect(changes[0].key).toBe("todo:1");
    expect(changes[1].id).toBe(2);
    expect(changes[1].key).toBe("todo:2");
  });

  it("returns only changes after the provided log ID", async () => {
    const store = await ExpoSqliteSyncStore.open<any>("test.db", "client-A");
    await store.applyLocalWrite("todo:1", { title: "Task 1", completed: false });
    await store.applyLocalWrite("todo:2", { title: "Task 2", completed: true });

    const changes = await store.getChangesSince(1);
    expect(changes.length).toBe(1);
    expect(changes[0].id).toBe(2);
    expect(changes[0].key).toBe("todo:2");
  });

  it("applies remote state and resolves conflicts correctly", async () => {
    const store = await ExpoSqliteSyncStore.open<any>("test.db", "client-A");

    // Write locally
    await store.applyLocalWrite("todo:1", { title: "Task 1 (Local)", completed: false });
    const localState = await store.getFullState();
    const localEntry = localState["todo:1"];

    // Remote entry has higher timestamp and client-B vector clock
    const remoteEntry = {
      value: { title: "Task 1 (Remote wins)", completed: true },
      timestamp: localEntry.timestamp + 1000,
      vectorClock: { "client-B": 1 },
      clientId: "client-B",
    };

    await store.applyRemoteState({ "todo:1": remoteEntry });

    const mergedState = await store.getFullState();
    expect(mergedState["todo:1"].value).toEqual({ title: "Task 1 (Remote wins)", completed: true });
    // Vector clocks should be merged
    expect(mergedState["todo:1"].vectorClock).toEqual({
      "client-A": 1,
      "client-B": 1,
    });
  });
});

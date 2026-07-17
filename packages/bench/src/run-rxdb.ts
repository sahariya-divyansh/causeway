import { performance } from "node:perf_hooks";

import {
  createScenario,
  stableJsonByteLength,
  stableStateJson,
  type BenchmarkResult,
  type ScenarioEdit,
} from "./scenario.js";

interface RxDocumentState {
  id: string;
  title: string;
  status: string;
  amount: number;
  notes: string;
  updatedAt: number;
  clientId: string;
}

function resolveWinner(left: RxDocumentState, right: RxDocumentState): RxDocumentState {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? left : right;
  }

  return left.clientId > right.clientId ? left : right;
}

function editToDocument(edit: ScenarioEdit): RxDocumentState {
  return {
    id: edit.key,
    ...edit.value,
    updatedAt: edit.timestamp,
    clientId: edit.clientId,
  };
}

export async function runRxdbBenchmark(): Promise<BenchmarkResult> {
  const { createRxDatabase } = await import("rxdb");
  const { getRxStorageMemory } = await import("rxdb/plugins/storage-memory");
  const startedAt = performance.now();
  const dbA = await createRxDatabase({
    name: `setubenchrxdba${Date.now()}`,
    storage: getRxStorageMemory(),
  });
  const dbB = await createRxDatabase({
    name: `setubenchrxdbb${Date.now()}`,
    storage: getRxStorageMemory(),
  });

  try {
    const schema = {
      title: "scenario record",
      version: 0,
      primaryKey: "id",
      type: "object",
      properties: {
        id: { type: "string", maxLength: 100 },
        title: { type: "string" },
        status: { type: "string" },
        amount: { type: "number" },
        notes: { type: "string" },
        updatedAt: { type: "number" },
        clientId: { type: "string" },
      },
      required: ["id", "title", "status", "amount", "notes", "updatedAt", "clientId"],
    };

    await dbA.addCollections({ records: { schema } });
    await dbB.addCollections({ records: { schema } });

    const documentsA: RxDocumentState[] = [];
    const documentsB: RxDocumentState[] = [];

    for (const edit of createScenario()) {
      const document = editToDocument(edit);
      if (edit.clientId === "A") {
        documentsA.push(document);
      } else {
        documentsB.push(document);
      }
    }

    await dbA.records.bulkInsert(documentsA);
    await dbB.records.bulkInsert(documentsB);

    const exportedA = new Map(documentsA.map((document) => [document.id, document]));
    const exportedB = new Map(documentsB.map((document) => [document.id, document]));
    const mergeInto = (
      target: Map<string, RxDocumentState>,
      source: Map<string, RxDocumentState>,
    ) => {
      for (const [key, document] of source) {
        const existing = target.get(key);
        target.set(key, existing ? resolveWinner(existing, document) : document);
      }
    };

    const stateAfterAReceivesB = new Map<string, RxDocumentState>(exportedA);
    const stateAfterBReceivesA = new Map<string, RxDocumentState>(exportedB);

    mergeInto(stateAfterAReceivesB, exportedB);
    mergeInto(stateAfterBReceivesA, exportedA);

    // Caveat: RxDB's production replication plugins expect a replication endpoint
    // or storage-specific setup. This harness uses RxDB's document model and an
    // explicit deterministic exchange of JSON document states, so it excludes
    // attachment data, checkpoint protocol overhead, and live replication timers.
    const bytesTransferred =
      stableJsonByteLength([...exportedA.values()]) + stableJsonByteLength([...exportedB.values()]);
    const converged =
      stableStateJson([...stateAfterAReceivesB].map(([key, document]) => [key, document])) ===
      stableStateJson([...stateAfterBReceivesA].map(([key, document]) => [key, document]));

    return {
      engine: "RxDB",
      bytesTransferred,
      timeToConvergenceMs: performance.now() - startedAt,
      converged,
    };
  } finally {
    await dbA.remove();
    await dbB.remove();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const result = await runRxdbBenchmark();
  console.log(result);
}

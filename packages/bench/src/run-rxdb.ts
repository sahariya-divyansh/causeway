import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  createScenario,
  stableStateJson,
  type BenchmarkResult,
  type ScenarioEdit,
} from "./scenario.js";
import { exchangeViaRelay, withBenchmarkRelay } from "./relay.js";

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
  const dbA = await createRxDatabase({
    name: `causewaybenchrxdba${Date.now()}`,
    storage: getRxStorageMemory(),
  });
  const dbB = await createRxDatabase({
    name: `causewaybenchrxdbb${Date.now()}`,
    storage: getRxStorageMemory(),
  });

  try {
    return await withBenchmarkRelay(async (relayUrl) => {
      const startedAt = performance.now();

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

      const payloadA = Buffer.from(JSON.stringify(documentsA));
      const payloadB = Buffer.from(JSON.stringify(documentsB));
      const deliveredAToB = await exchangeViaRelay(relayUrl, payloadA, "rxdb-a-to-b");
      const deliveredBToA = await exchangeViaRelay(relayUrl, payloadB, "rxdb-b-to-a");
      const exportedA = new Map(
        (JSON.parse(deliveredAToB.payload.toString("utf8")) as RxDocumentState[]).map(
          (document) => [document.id, document],
        ),
      );
      const exportedB = new Map(
        (JSON.parse(deliveredBToA.payload.toString("utf8")) as RxDocumentState[]).map(
          (document) => [document.id, document],
        ),
      );
      const mergeInto = (
        target: Map<string, RxDocumentState>,
        source: Map<string, RxDocumentState>,
      ) => {
        for (const [key, document] of source) {
          const existing = target.get(key);
          target.set(key, existing ? resolveWinner(existing, document) : document);
        }
      };

      const localA = new Map(documentsA.map((document) => [document.id, document]));
      const localB = new Map(documentsB.map((document) => [document.id, document]));
      const stateAfterAReceivesB = new Map<string, RxDocumentState>(localA);
      const stateAfterBReceivesA = new Map<string, RxDocumentState>(localB);

      mergeInto(stateAfterAReceivesB, exportedB);
      mergeInto(stateAfterBReceivesA, exportedA);

      // Caveat: RxDB's production replication plugins expect a replication endpoint
      // or storage-specific setup. This harness uses RxDB's document model, but sends
      // JSON document states through the same HTTP relay as Causeway so netem latency/loss
      // applies. It still excludes RxDB checkpoint protocol overhead and live timers.
      const bytesTransferred = deliveredAToB.bytesTransferred + deliveredBToA.bytesTransferred;
      const relayRequests = deliveredAToB.relayRequests + deliveredBToA.relayRequests;
      const relayElapsedMs = deliveredAToB.relayElapsedMs + deliveredBToA.relayElapsedMs;
      const converged =
        stableStateJson([...stateAfterAReceivesB].map(([key, document]) => [key, document])) ===
        stableStateJson([...stateAfterBReceivesA].map(([key, document]) => [key, document]));

      return {
        engine: "RxDB",
        bytesTransferred,
        timeToConvergenceMs: performance.now() - startedAt,
        converged,
        relayRequests,
        relayElapsedMs,
      };
    });
  } finally {
    await dbA.remove();
    await dbB.remove();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRxdbBenchmark();
  console.log(result);
}

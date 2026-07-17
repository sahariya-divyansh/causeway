import { performance } from "node:perf_hooks";

import * as Y from "yjs";

import { createScenario, stableStateJson, type BenchmarkResult } from "./scenario.js";

export async function runYjsBenchmark(): Promise<BenchmarkResult> {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const mapA = docA.getMap("records");
  const mapB = docB.getMap("records");
  const startedAt = performance.now();

  for (const edit of createScenario()) {
    const target = edit.clientId === "A" ? mapA : mapB;
    target.set(edit.key, {
      ...edit.value,
      updatedAt: edit.timestamp,
      clientId: edit.clientId,
    });
  }

  const updateA = Y.encodeStateAsUpdate(docA);
  const updateB = Y.encodeStateAsUpdate(docB);
  Y.applyUpdate(docB, updateA);
  Y.applyUpdate(docA, updateB);

  const bytesTransferred = updateA.byteLength + updateB.byteLength;
  const stateA = stableStateJson(mapA.entries());
  const stateB = stableStateJson(mapB.entries());

  // Caveat: this uses Yjs document update exchange directly, not a Yjs provider
  // with awareness, reconnect bookkeeping, or HTTP overhead. It measures the CRDT
  // update payload for the same scenario, so it is useful but not perfectly
  // apples-to-apples with Setu's relay HTTP transport.
  return {
    engine: "Yjs",
    bytesTransferred,
    timeToConvergenceMs: performance.now() - startedAt,
    converged: stateA === stateB,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const result = await runYjsBenchmark();
  console.log(result);
}

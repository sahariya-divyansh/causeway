import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import * as Y from "yjs";

import { createScenario, stableStateJson, type BenchmarkResult } from "./scenario.js";
import { exchangeViaRelay, withBenchmarkRelay } from "./relay.js";

export async function runYjsBenchmark(): Promise<BenchmarkResult> {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const mapA = docA.getMap("records");
  const mapB = docB.getMap("records");

  return withBenchmarkRelay(async (relayUrl) => {
    const startedAt = performance.now();

    for (const edit of createScenario()) {
      const target = edit.clientId === "A" ? mapA : mapB;
      target.set(edit.key, {
        ...edit.value,
        updatedAt: edit.timestamp,
        clientId: edit.clientId,
      });
    }

    const updateA = Buffer.from(Y.encodeStateAsUpdate(docA));
    const updateB = Buffer.from(Y.encodeStateAsUpdate(docB));
    const deliveredAToB = await exchangeViaRelay(relayUrl, updateA, "yjs-a-to-b");
    const deliveredBToA = await exchangeViaRelay(relayUrl, updateB, "yjs-b-to-a");

    Y.applyUpdate(docB, deliveredAToB.payload);
    Y.applyUpdate(docA, deliveredBToA.payload);

    const bytesTransferred = deliveredAToB.bytesTransferred + deliveredBToA.bytesTransferred;
    const relayRequests = deliveredAToB.relayRequests + deliveredBToA.relayRequests;
    const relayElapsedMs = deliveredAToB.relayElapsedMs + deliveredBToA.relayElapsedMs;
    const stateA = stableStateJson(mapA.entries());
    const stateB = stableStateJson(mapB.entries());

    // Caveat: this uses Yjs' native binary document update format, but transports it
    // through Setu's HTTP relay rather than a Yjs provider. That makes the network
    // conditions real and identical, while excluding provider-specific awareness and
    // reconnect protocol overhead.
    return {
      engine: "Yjs",
      bytesTransferred,
      timeToConvergenceMs: performance.now() - startedAt,
      converged: stateA === stateB,
      relayRequests,
      relayElapsedMs,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runYjsBenchmark();
  console.log(result);
}

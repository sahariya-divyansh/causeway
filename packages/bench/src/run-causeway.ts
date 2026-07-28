import { existsSync, rmSync } from "node:fs";
import { inspect, isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  applyRemoteDelta,
  computeDelta,
  downloadDelta,
  encodeDelta,
  openStore,
  uploadDelta,
  DEFAULT_CHUNK_SIZE,
  type SyncStore,
} from "@causeway-sync/core";

import { createScenario, type BenchmarkResult, type ScenarioValue } from "./scenario.js";
import { withBenchmarkRelay } from "./relay.js";

function applyAt<T>(timestamp: number, write: () => T): T {
  const originalDateNow = Date.now;
  Date.now = () => timestamp;

  try {
    return write();
  } finally {
    Date.now = originalDateNow;
  }
}

function cleanupDb(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      rmSync(candidate, { force: true });
    }
  }
}

function formatStateDiff<T>(
  stateA: Record<string, T>,
  stateB: Record<string, T>,
): string {
  const keys = new Set([...Object.keys(stateA), ...Object.keys(stateB)]);
  const differingKeys = [...keys].filter((key) => !isDeepStrictEqual(stateA[key], stateB[key]));

  return differingKeys
    .map((key) =>
      [
        key,
        `  A: ${inspect(stateA[key], { depth: null, breakLength: 120 })}`,
        `  B: ${inspect(stateB[key], { depth: null, breakLength: 120 })}`,
      ].join("\n"),
    )
    .join("\n");
}

export async function runCausewayBenchmark(): Promise<BenchmarkResult> {
  const dbAPath = join(tmpdir(), `causeway-bench-a-${randomUUID()}.sqlite`);
  const dbBPath = join(tmpdir(), `causeway-bench-b-${randomUUID()}.sqlite`);
  const storeA: SyncStore<ScenarioValue> = openStore(dbAPath, "bench-a");
  const storeB: SyncStore<ScenarioValue> = openStore(dbBPath, "bench-b");
  let bytesTransferred = 0;
  let relayRequests = 0;
  let relayElapsedMs = 0;

  try {
    return await withBenchmarkRelay(async (relayUrl) => {
      const startedAt = performance.now();
      const fetchImpl: typeof fetch = async (input, init) => {
        relayRequests += 1;
        const fetchStartedAt = performance.now();

        try {
          return await fetch(input, init);
        } finally {
          relayElapsedMs += performance.now() - fetchStartedAt;
        }
      };

      for (const edit of createScenario()) {
        const store = edit.clientId === "A" ? storeA : storeB;
        applyAt(edit.timestamp, () => {
          store.applyLocalWrite(edit.key, edit.value);
        });
      }

      const deltaFromA = encodeDelta(computeDelta(storeA.getChangesSince(0)));
      const deltaFromB = encodeDelta(computeDelta(storeB.getChangesSince(0)));
      const chunkSize = Number(process.env.CAUSEWAY_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
      const trackBytes = ({ bytes }: { bytes: number }) => {
        bytesTransferred += bytes;
      };

      const sessionAToB = `bench-${randomUUID()}-a-to-b`;
      await uploadDelta(sessionAToB, deltaFromA, chunkSize, {
        relayUrl,
        fetchImpl,
        onUploadChunk: trackBytes,
      });
      applyRemoteDelta(
        storeB,
        await downloadDelta(sessionAToB, chunkSize, {
          relayUrl,
          fetchImpl,
          onDownloadChunk: trackBytes,
        }),
      );

      const sessionBToA = `bench-${randomUUID()}-b-to-a`;
      await uploadDelta(sessionBToA, deltaFromB, chunkSize, {
        relayUrl,
        fetchImpl,
        onUploadChunk: trackBytes,
      });
      applyRemoteDelta(
        storeA,
        await downloadDelta(sessionBToA, chunkSize, {
          relayUrl,
          fetchImpl,
          onDownloadChunk: trackBytes,
        }),
      );

      const timeToConvergenceMs = performance.now() - startedAt;
      const stateA = storeA.getFullState();
      const stateB = storeB.getFullState();
      const converged = isDeepStrictEqual(stateA, stateB);

      if (!converged) {
        throw new Error(
          `Causeway stores did not converge.\n${formatStateDiff(stateA, stateB) || "No differing keys found."}`,
        );
      }

      return {
        engine: "Causeway",
        bytesTransferred,
        timeToConvergenceMs,
        converged,
        relayRequests,
        relayElapsedMs,
      };
    });
  } finally {
    storeA.close();
    storeB.close();
    cleanupDb(dbAPath);
    cleanupDb(dbBPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCausewayBenchmark();
  console.log(result);
}

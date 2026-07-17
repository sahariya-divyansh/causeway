import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import {
  applyRemoteDelta,
  computeDelta,
  downloadDelta,
  encodeDelta,
  openStore,
  uploadDelta,
  type SyncStore,
} from "@setu/core";
import { createRelayServer } from "@setu/relay-server";

import { createScenario, type BenchmarkResult, type ScenarioValue } from "./scenario.js";

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

async function listen(
  app: ReturnType<typeof createRelayServer>,
): Promise<{ relayUrl: string; server: Server }> {
  let server: Server | undefined;

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  if (!server) {
    throw new Error("relay server did not start");
  }

  const address = server.address() as AddressInfo;
  return {
    relayUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
}

export async function runSetuBenchmark(): Promise<BenchmarkResult> {
  const dbAPath = join(tmpdir(), `setu-bench-a-${randomUUID()}.sqlite`);
  const dbBPath = join(tmpdir(), `setu-bench-b-${randomUUID()}.sqlite`);
  const storeA: SyncStore<ScenarioValue> = openStore(dbAPath, "bench-a");
  const storeB: SyncStore<ScenarioValue> = openStore(dbBPath, "bench-b");
  const app = createRelayServer();
  let server: Server | undefined;
  let bytesTransferred = 0;

  try {
    const listened = await listen(app);
    const relayUrl = listened.relayUrl;
    server = listened.server;
    const startedAt = performance.now();

    for (const edit of createScenario()) {
      const store = edit.clientId === "A" ? storeA : storeB;
      applyAt(edit.timestamp, () => {
        store.applyLocalWrite(edit.key, edit.value);
      });
    }

    const deltaFromA = encodeDelta(computeDelta(storeA.getChangesSince(0)));
    const deltaFromB = encodeDelta(computeDelta(storeB.getChangesSince(0)));
    const chunkSize = 1024;
    const trackBytes = ({ bytes }: { bytes: number }) => {
      bytesTransferred += bytes;
    };

    const sessionAToB = `bench-${randomUUID()}-a-to-b`;
    await uploadDelta(sessionAToB, deltaFromA, chunkSize, {
      relayUrl,
      onUploadChunk: trackBytes,
    });
    applyRemoteDelta(
      storeB,
      await downloadDelta(sessionAToB, chunkSize, {
        relayUrl,
        onDownloadChunk: trackBytes,
      }),
    );

    const sessionBToA = `bench-${randomUUID()}-b-to-a`;
    await uploadDelta(sessionBToA, deltaFromB, chunkSize, {
      relayUrl,
      onUploadChunk: trackBytes,
    });
    applyRemoteDelta(
      storeA,
      await downloadDelta(sessionBToA, chunkSize, {
        relayUrl,
        onDownloadChunk: trackBytes,
      }),
    );

    const timeToConvergenceMs = performance.now() - startedAt;
    const converged = JSON.stringify(storeA.getFullState()) === JSON.stringify(storeB.getFullState());

    return {
      engine: "Setu",
      bytesTransferred,
      timeToConvergenceMs,
      converged,
    };
  } finally {
    storeA.close();
    storeB.close();
    if (server) {
      const startedServer = server;
      await new Promise<void>((resolve, reject) => {
        startedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    cleanupDb(dbAPath);
    cleanupDb(dbBPath);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const result = await runSetuBenchmark();
  console.log(result);
}

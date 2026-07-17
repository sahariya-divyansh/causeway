import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRelayServer } from "@setu/relay-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyRemoteDelta, computeDelta, encodeDelta } from "../src/delta.js";
import { openStore } from "../src/sqlite-store.js";
import type { SyncStore } from "../src/storage.js";
import { downloadDelta, uploadDelta } from "../src/transport.js";

interface AppRecord {
  title: string;
  status: string;
  amount: number;
}

describe("end-to-end two-client sync", () => {
  let server: Server;
  let relayUrl: string;
  let dbPaths: string[];
  let storeA: SyncStore<AppRecord>;
  let storeB: SyncStore<AppRecord>;

  beforeEach(async () => {
    vi.useFakeTimers();
    dbPaths = [
      join(tmpdir(), `setu-e2e-a-${randomUUID()}.sqlite`),
      join(tmpdir(), `setu-e2e-b-${randomUUID()}.sqlite`),
    ];
    storeA = openStore<AppRecord>(dbPaths[0], "client-a");
    storeB = openStore<AppRecord>(dbPaths[1], "client-b");

    const app = createRelayServer();

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        relayUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    storeA.close();
    storeB.close();
    vi.useRealTimers();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    for (const dbPath of dbPaths) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(path)) {
          rmSync(path, { force: true });
        }
      }
    }
  });

  it("converges two SQLite clients through the relay transport", async () => {
    vi.setSystemTime(1000);
    storeA.applyLocalWrite("invoice:1", {
      title: "Village school supplies",
      status: "draft",
      amount: 1200,
    });
    storeA.applyLocalWrite("task:a-only", {
      title: "Collect signatures",
      status: "queued",
      amount: 4,
    });

    vi.setSystemTime(1000);
    storeB.applyLocalWrite("invoice:1", {
      title: "Village school supplies",
      status: "approved",
      amount: 1250,
    });
    storeB.applyLocalWrite("task:b-only", {
      title: "Upload receipt photo",
      status: "queued",
      amount: 1,
    });

    vi.setSystemTime(2000);
    storeA.applyLocalWrite("shared:status", {
      title: "Health camp",
      status: "scheduled by A",
      amount: 48,
    });

    vi.setSystemTime(2000);
    storeB.applyLocalWrite("shared:status", {
      title: "Health camp",
      status: "scheduled by B",
      amount: 52,
    });

    const deltaFromA = encodeDelta(computeDelta(storeA.getChangesSince(0)));
    const deltaFromB = encodeDelta(computeDelta(storeB.getChangesSince(0)));
    const metrics = {
      clientA: { uploaded: 0, downloaded: 0 },
      clientB: { uploaded: 0, downloaded: 0 },
    };
    const chunkSize = 256;
    const sessionAToB = `e2e-${randomUUID()}-a-to-b`;
    const sessionBToA = `e2e-${randomUUID()}-b-to-a`;

    await uploadDelta(sessionAToB, deltaFromA, chunkSize, {
      relayUrl,
      onUploadChunk: ({ bytes }) => {
        metrics.clientA.uploaded += bytes;
      },
    });
    const downloadedByB = await downloadDelta(sessionAToB, chunkSize, {
      relayUrl,
      onDownloadChunk: ({ bytes }) => {
        metrics.clientB.downloaded += bytes;
      },
    });
    applyRemoteDelta(storeB, downloadedByB);

    await uploadDelta(sessionBToA, deltaFromB, chunkSize, {
      relayUrl,
      onUploadChunk: ({ bytes }) => {
        metrics.clientB.uploaded += bytes;
      },
    });
    const downloadedByA = await downloadDelta(sessionBToA, chunkSize, {
      relayUrl,
      onDownloadChunk: ({ bytes }) => {
        metrics.clientA.downloaded += bytes;
      },
    });
    applyRemoteDelta(storeA, downloadedByA);

    console.info(
      `E2E byte counts: clientA uploaded=${metrics.clientA.uploaded} downloaded=${metrics.clientA.downloaded}; clientB uploaded=${metrics.clientB.uploaded} downloaded=${metrics.clientB.downloaded}`,
    );

    expect(storeA.getFullState()).toEqual(storeB.getFullState());
  });
});

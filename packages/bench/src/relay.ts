import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { downloadDelta, uploadDelta, DEFAULT_CHUNK_SIZE } from "@causeway-sync/core";
import { createRelayServer } from "@causeway-sync/relay-server";

export interface RelayExchangeResult {
  payload: Buffer;
  bytesTransferred: number;
  relayRequests: number;
  relayElapsedMs: number;
}

export async function withBenchmarkRelay<T>(
  run: (relayUrl: string) => Promise<T>,
): Promise<T> {
  const app = createRelayServer();
  let server: Server | undefined;

  try {
    const relayUrl = await new Promise<string>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server?.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    return await run(relayUrl);
  } finally {
    if (server) {
      const startedServer = server;
      await new Promise<void>((resolve, reject) => {
        startedServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

export async function exchangeViaRelay(
  relayUrl: string,
  payload: Buffer,
  label: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<RelayExchangeResult> {
  const sessionId = `bench-${randomUUID()}-${label}`;
  let bytesTransferred = 0;
  let relayRequests = 0;
  let relayElapsedMs = 0;
  const trackBytes = ({ bytes }: { bytes: number }) => {
    bytesTransferred += bytes;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    relayRequests += 1;
    const startedAt = performance.now();

    try {
      return await fetch(input, init);
    } finally {
      relayElapsedMs += performance.now() - startedAt;
    }
  };

  await uploadDelta(sessionId, payload, chunkSize, {
    relayUrl,
    fetchImpl,
    onUploadChunk: trackBytes,
  });
  const downloaded = await downloadDelta(sessionId, chunkSize, {
    relayUrl,
    fetchImpl,
    onDownloadChunk: trackBytes,
  });

  return {
    payload: downloaded,
    bytesTransferred,
    relayRequests,
    relayElapsedMs,
  };
}

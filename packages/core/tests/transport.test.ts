import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createRelayServer } from "@causeway-sync/relay-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { downloadDelta, uploadDelta } from "../src/transport.js";

describe("relay transport", () => {
  let server: Server;
  let relayUrl: string;

  beforeAll(async () => {
    const app = createRelayServer();

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        relayUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("uploads and downloads a delta byte-for-byte", async () => {
    const payload = randomBytes(128 * 1024 + 77);
    const sessionId = "happy-path";

    await uploadDelta(sessionId, payload, 16 * 1024, { relayUrl });

    const downloaded = await downloadDelta(sessionId, 16 * 1024, { relayUrl });

    expect(downloaded.equals(payload)).toBe(true);
  });

  it("resumes after a mid-upload disconnect without resending confirmed chunks", async () => {
    const payload = randomBytes(96 * 1024 + 13);
    const chunkSize = 16 * 1024;
    const totalChunks = Math.ceil(payload.length / chunkSize);
    const sessionId = "resume-after-drop";
    const originalFetch = globalThis.fetch;
    let successfulPostsBeforeDrop = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === "POST" && url.includes("/upload")) {
        if (successfulPostsBeforeDrop >= 2) {
          throw new TypeError("simulated dropped connection");
        }

        successfulPostsBeforeDrop += 1;
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    await expect(
      uploadDelta(sessionId, payload, chunkSize, {
        relayUrl,
        initialBackoffMs: 1,
      }),
    ).rejects.toThrow("simulated dropped connection");

    globalThis.fetch = originalFetch;

    const statusResponse = await fetch(`${relayUrl}/sync/${sessionId}/upload-status`);
    const status = (await statusResponse.json()) as { receivedChunks: number[] };
    expect(status.receivedChunks).toEqual([0, 1]);

    let resumedPostCount = 0;
    const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === "POST" && url.includes("/upload")) {
        resumedPostCount += 1;
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    await uploadDelta(sessionId, payload, chunkSize, {
      relayUrl,
      fetchImpl: countingFetch,
      initialBackoffMs: 1,
    });

    expect(resumedPostCount).toBe(totalChunks - 2);

    const downloaded = await downloadDelta(sessionId, chunkSize, { relayUrl });
    expect(downloaded.equals(payload)).toBe(true);
  });
});

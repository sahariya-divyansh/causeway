import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRelayServer } from "../src/server.js";

describe("relay server", () => {
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

  it("returns empty upload status for a new session", async () => {
    const response = await fetch(`${relayUrl}/sync/new-session/upload-status`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      sessionId: "new-session",
      receivedChunks: [],
      highestContiguousChunkIndex: -1,
      totalChunks: null,
      complete: false,
    });
  });
});

import { describe, expect, it } from "vitest";
import { decode } from "cbor-x";

import { decodeDelta, encodeDelta } from "../src/delta.js";
import type { RegisterEntry } from "../src/crdt.js";

interface Task {
  title: string;
  status: string;
}

describe("delta wire format", () => {
  it("round-trips tuple-encoded register entries without changing the public shape", () => {
    const delta: Record<string, RegisterEntry<Task>> = {
      "task:1": {
        value: {
          title: "Collect payment",
          status: "queued",
        },
        timestamp: 1234,
        vectorClock: {
          A: 2,
          B: 1,
        },
        clientId: "A",
      },
    };

    expect(decodeDelta<Task>(encodeDelta(delta))).toEqual(delta);
  });

  it("encodes each register entry as a fixed-position tuple on the wire", () => {
    const delta: Record<string, RegisterEntry<Task>> = {
      "task:1": {
        value: {
          title: "Collect payment",
          status: "queued",
        },
        timestamp: 1234,
        vectorClock: {
          A: 2,
          B: 1,
        },
        clientId: "A",
      },
    };

    const wireDelta = decode(encodeDelta(delta)) as Record<string, unknown>;

    expect(wireDelta["task:1"]).toEqual([
      {
        title: "Collect payment",
        status: "queued",
      },
      1234,
      {
        A: 2,
        B: 1,
      },
      "A",
    ]);
  });
});

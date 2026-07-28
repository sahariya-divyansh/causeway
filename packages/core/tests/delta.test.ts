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

  it("encodes each register entry as a fixed-position tuple on the wire with interned client IDs", () => {
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

    const wireDelta = decode(encodeDelta(delta)) as any;

    expect(wireDelta.c).toEqual(["A", "B"]);
    expect(wireDelta.d["task:1"]).toEqual([
      {
        title: "Collect payment",
        status: "queued",
      },
      1234,
      [
        [0, 2],
        [1, 1],
      ],
      0,
    ]);
  });

  it("handles when a new client ID is seen for the first time", () => {
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
          C: 1, // C is a new client ID
        },
        clientId: "C",
      },
    };

    const encoded = encodeDelta(delta);
    const decoded = decodeDelta<Task>(encoded);

    expect(decoded).toEqual(delta);
    expect(decoded["task:1"].clientId).toBe("C");
    expect(decoded["task:1"].vectorClock).toEqual({ A: 2, B: 1, C: 1 });
  });
});

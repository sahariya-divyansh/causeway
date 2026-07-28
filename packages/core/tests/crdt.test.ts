import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LWWMap } from "../src/crdt.js";

describe("LWWMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("supports basic set/get on a single client", () => {
    vi.setSystemTime(1000);
    const map = new LWWMap<string>("A");

    map.set("name", "Causeway");

    expect(map.get("name")).toBe("Causeway");
    expect(map.getEntry("name")).toMatchObject({
      value: "Causeway",
      timestamp: 1000,
      vectorClock: { A: 1 },
      clientId: "A",
    });
  });

  it("lets a sequential write win when its vector clock dominates", () => {
    vi.setSystemTime(1000);
    const clientA = new LWWMap<string>("A");
    clientA.set("status", "draft");

    const clientB = new LWWMap<string>("B");
    clientB.merge(clientA.getState());

    vi.setSystemTime(900);
    clientB.set("status", "submitted");
    clientA.merge(clientB.getState());

    expect(clientA.get("status")).toBe("submitted");
    expect(clientA.getEntry("status")?.vectorClock).toEqual({ A: 1, B: 1 });
  });

  it("uses timestamp tie-breaking for truly concurrent writes", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");

    vi.setSystemTime(1000);
    clientA.set("status", "from-a");
    vi.setSystemTime(2000);
    clientB.set("status", "from-b");

    clientA.merge(clientB.getState());
    clientB.merge(clientA.getState());

    expect(clientA.get("status")).toBe("from-b");
    expect(clientB.getState()).toEqual(clientA.getState());
  });

  it("uses clientId tie-breaking for concurrent writes with identical timestamps", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");

    vi.setSystemTime(1000);
    clientA.set("status", "from-a");
    clientB.set("status", "from-b");

    clientA.merge(clientB.getState());
    clientB.merge(clientA.getState());

    expect(clientA.get("status")).toBe("from-b");
    expect(clientB.getState()).toEqual(clientA.getState());
  });

  it("is idempotent when the same state is merged repeatedly", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");

    vi.setSystemTime(1000);
    clientA.set("status", "from-a");
    vi.setSystemTime(2000);
    clientB.set("status", "from-b");

    clientA.merge(clientB.getState());
    const once = clientA.getState();
    clientA.merge(clientB.getState());

    expect(clientA.getState()).toEqual(once);
  });

  it("is commutative across merge order", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");

    vi.setSystemTime(1000);
    clientA.set("shared", "from-a");
    vi.setSystemTime(2000);
    clientB.set("shared", "from-b");

    const mergeAB = new LWWMap<string>("merge-ab");
    mergeAB.merge(clientA.getState());
    mergeAB.merge(clientB.getState());

    const mergeBA = new LWWMap<string>("merge-ba");
    mergeBA.merge(clientB.getState());
    mergeBA.merge(clientA.getState());

    expect(mergeAB.getState()).toEqual(mergeBA.getState());
  });

  it("is associative across three merge groupings", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");
    const clientC = new LWWMap<string>("C");

    vi.setSystemTime(1000);
    clientA.set("shared", "from-a");
    vi.setSystemTime(2000);
    clientB.set("shared", "from-b");
    vi.setSystemTime(1500);
    clientC.set("other", "from-c");

    const left = new LWWMap<string>("left");
    left.merge(clientA.getState());
    left.merge(clientB.getState());
    left.merge(clientC.getState());

    const rightInner = new LWWMap<string>("right-inner");
    rightInner.merge(clientB.getState());
    rightInner.merge(clientC.getState());
    const right = new LWWMap<string>("right");
    right.merge(clientA.getState());
    right.merge(rightInner.getState());

    expect(left.getState()).toEqual(right.getState());
  });

  it("converges through a longer divergent chain with overlapping and distinct keys", () => {
    const clientA = new LWWMap<string>("A");
    const clientB = new LWWMap<string>("B");

    vi.setSystemTime(1000);
    clientA.set("invoice:1", "a-draft");
    vi.setSystemTime(1100);
    clientA.set("invoice:2", "a-only");

    vi.setSystemTime(1200);
    clientB.set("invoice:1", "b-draft");
    vi.setSystemTime(1300);
    clientB.set("invoice:3", "b-only");

    clientA.merge(clientB.getState());
    clientB.merge(clientA.getState());

    vi.setSystemTime(1400);
    clientA.set("invoice:4", "a-after-merge");
    vi.setSystemTime(1500);
    clientB.set("invoice:4", "b-after-merge");

    clientA.merge(clientB.getState());
    clientB.merge(clientA.getState());

    expect(clientA.getState()).toEqual(clientB.getState());
    expect(clientA.get("invoice:1")).toBe("b-draft");
    expect(clientA.get("invoice:2")).toBe("a-only");
    expect(clientA.get("invoice:3")).toBe("b-only");
    expect(clientA.get("invoice:4")).toBe("b-after-merge");
  });
});

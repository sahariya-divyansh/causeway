export type VectorClock = Record<string, number>;

export interface RegisterEntry<T> {
  value: T;
  timestamp: number;
  vectorClock: VectorClock;
  clientId: string;
}

type Dominance = "left" | "right" | "concurrent";

export class LWWMap<T> {
  private readonly state = new Map<string, RegisterEntry<T>>();
  private readonly vectorClock: VectorClock = {};

  constructor(private readonly clientId: string) {
    this.vectorClock[clientId] = 0;
  }

  set(key: string, value: T): void {
    this.vectorClock[this.clientId] = (this.vectorClock[this.clientId] ?? 0) + 1;

    this.state.set(key, {
      value,
      timestamp: Date.now(),
      vectorClock: cloneClock(this.vectorClock),
      clientId: this.clientId,
    });
  }

  get(key: string): T | undefined {
    return this.state.get(key)?.value;
  }

  getEntry(key: string): RegisterEntry<T> | undefined {
    return cloneEntry(this.state.get(key));
  }

  getState(): Record<string, RegisterEntry<T>> {
    return Object.fromEntries(
      Array.from(this.state.entries()).map(([key, entry]) => [key, cloneEntry(entry)!]),
    );
  }

  merge(remoteState: Record<string, RegisterEntry<T>>): void {
    for (const [key, remoteEntry] of Object.entries(remoteState)) {
      this.observeClock(remoteEntry.vectorClock);
      const localEntry = this.state.get(key);

      if (!localEntry) {
        this.state.set(key, cloneEntry(remoteEntry)!);
        continue;
      }

      const mergedClock = mergeClocks(localEntry.vectorClock, remoteEntry.vectorClock);
      const winner = resolveEntry(localEntry, remoteEntry);

      this.state.set(key, {
        ...cloneEntry(winner)!,
        vectorClock: mergedClock,
      });
    }
  }

  private observeClock(remoteClock: VectorClock): void {
    const merged = mergeClocks(this.vectorClock, remoteClock);
    for (const [clientId, counter] of Object.entries(merged)) {
      this.vectorClock[clientId] = counter;
    }
  }
}

export function resolveEntry<T>(
  localEntry: RegisterEntry<T>,
  remoteEntry: RegisterEntry<T>,
): RegisterEntry<T> {
  const dominance = compareVectorClocks(localEntry.vectorClock, remoteEntry.vectorClock);

  if (dominance === "right") {
    return remoteEntry;
  }

  if (dominance === "left") {
    return localEntry;
  }

  if (remoteEntry.timestamp > localEntry.timestamp) {
    return remoteEntry;
  }

  if (localEntry.timestamp > remoteEntry.timestamp) {
    return localEntry;
  }

  return remoteEntry.clientId > localEntry.clientId ? remoteEntry : localEntry;
}

export function compareVectorClocks(left: VectorClock, right: VectorClock): Dominance {
  /*
   * A vector clock records "how many writes from each client this value has seen."
   *
   * left strictly dominates right when every counter in left is >= right and at least
   * one counter is greater. That means left includes all causal history known by
   * right, plus something newer, so it is safe to keep left without looking at wall
   * time. The reverse is true when right dominates left.
   *
   * If each clock is greater in a different client slot, neither write has seen the
   * other. Those writes are concurrent, so causality cannot decide the winner and
   * the register falls back to deterministic Last-Write-Wins tie-breaking.
   */
  let leftGreater = false;
  let rightGreater = false;
  const clientIds = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const clientId of clientIds) {
    const leftCounter = left[clientId] ?? 0;
    const rightCounter = right[clientId] ?? 0;

    if (leftCounter > rightCounter) {
      leftGreater = true;
    } else if (rightCounter > leftCounter) {
      rightGreater = true;
    }
  }

  if (leftGreater && !rightGreater) {
    return "left";
  }

  if (rightGreater && !leftGreater) {
    return "right";
  }

  return "concurrent";
}

export function mergeClocks(left: VectorClock, right: VectorClock): VectorClock {
  const merged: VectorClock = {};
  const clientIds = new Set([...Object.keys(left), ...Object.keys(right)]);

  for (const clientId of clientIds) {
    merged[clientId] = Math.max(left[clientId] ?? 0, right[clientId] ?? 0);
  }

  return merged;
}

export function cloneEntry<T>(entry: RegisterEntry<T> | undefined): RegisterEntry<T> | undefined {
  if (!entry) {
    return undefined;
  }

  return {
    value: entry.value,
    timestamp: entry.timestamp,
    vectorClock: cloneClock(entry.vectorClock),
    clientId: entry.clientId,
  };
}

function cloneClock(clock: VectorClock): VectorClock {
  return { ...clock };
}

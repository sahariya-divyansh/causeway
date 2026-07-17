export type ScenarioClientId = "A" | "B";

export interface ScenarioValue {
  title: string;
  status: string;
  amount: number;
  notes: string;
}

export interface ScenarioEdit {
  clientId: ScenarioClientId;
  key: string;
  value: ScenarioValue;
  timestamp: number;
}

export interface BenchmarkResult {
  engine: string;
  bytesTransferred: number;
  timeToConvergenceMs: number;
  converged: boolean;
  errorMessage?: string;
  relayRequests?: number;
  relayElapsedMs?: number;
}

export function createScenario(): ScenarioEdit[] {
  const edits: ScenarioEdit[] = [];

  for (let index = 0; index < 25; index += 1) {
    edits.push({
      clientId: "A",
      key: index % 5 === 0 ? `shared:${index / 5}` : `client-a:${index}`,
      timestamp: 1000 + index * 10,
      value: {
        title: `Field visit ${index + 1}`,
        status: index % 3 === 0 ? "draft" : "queued",
        amount: 100 + index,
        notes: `A edit ${index + 1}`,
      },
    });

    edits.push({
      clientId: "B",
      key: index % 5 === 0 ? `shared:${index / 5}` : `client-b:${index}`,
      timestamp: 1000 + index * 10,
      value: {
        title: `Field visit ${index + 1}`,
        status: index % 2 === 0 ? "review" : "queued",
        amount: 200 + index,
        notes: `B edit ${index + 1}`,
      },
    });
  }

  return edits;
}

export function stableJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function stableStateJson(entries: Iterable<[string, unknown]>): string {
  return JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

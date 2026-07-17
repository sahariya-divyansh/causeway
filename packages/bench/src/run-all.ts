import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runRxdbBenchmark } from "./run-rxdb.js";
import { runSetuBenchmark } from "./run-setu.js";
import { runYjsBenchmark } from "./run-yjs.js";
import type { BenchmarkResult } from "./scenario.js";

function formatDuration(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function toMarkdown(results: BenchmarkResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${result.engine}${result.converged ? "" : " (not converged)"} | ${result.bytesTransferred} | ${formatDuration(result.timeToConvergenceMs)} | ${result.relayRequests ?? 0} | ${formatDuration(result.relayElapsedMs ?? 0)} | ${result.errorMessage ?? ""} |`,
  );

  return [
    "| Engine | Bytes Transferred | Time to Convergence | Relay Requests | Relay Fetch Time | Error |",
    "|---|---:|---:|---:|---:|---|",
    ...rows,
    "",
  ].join("\n");
}

export async function runAllBenchmarks(): Promise<string> {
  const runners = [runSetuBenchmark, runRxdbBenchmark, runYjsBenchmark];
  const results: BenchmarkResult[] = [];

  for (const runner of runners) {
    try {
      results.push(await runner());
    } catch (error) {
      results.push({
        engine: runner.name.replace(/^run|Benchmark$/g, "") || "Unknown",
        bytesTransferred: 0,
        timeToConvergenceMs: 0,
        converged: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        relayRequests: 0,
        relayElapsedMs: 0,
      });
      console.error(error);
    }
  }

  const markdown = toMarkdown(results);
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await writeFile(join(packageRoot, "results.md"), markdown, "utf8");
  return markdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await runAllBenchmarks());
}

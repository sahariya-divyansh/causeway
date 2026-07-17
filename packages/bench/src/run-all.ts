import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      `| ${result.engine}${result.converged ? "" : " (not converged)"} | ${result.bytesTransferred} | ${formatDuration(result.timeToConvergenceMs)} |`,
  );

  return [
    "| Engine | Bytes Transferred | Time to Convergence |",
    "|---|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}

export async function runAllBenchmarks(): Promise<string> {
  const results = [await runSetuBenchmark(), await runRxdbBenchmark(), await runYjsBenchmark()];
  const markdown = toMarkdown(results);
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await writeFile(join(packageRoot, "results.md"), markdown, "utf8");
  return markdown;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  console.log(await runAllBenchmarks());
}

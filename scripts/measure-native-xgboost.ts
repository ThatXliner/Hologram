import { statSync } from "node:fs";
import { parseModelResult, prepareNativeInput, runProduction, type NativeInput, type ModelResult } from "./xgboost-evaluation.ts";
import { availableParallelism, loadavg, platform, arch } from "node:os";

const executable = Bun.argv[2];
if (!executable) throw new Error("Pass the release evaluator executable path");
let seed = 36;
const vector = () => Array.from({ length: 267 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
});
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), samples: values };
}
const workloads = [];
for (const count of [100, 500]) {
  const features = Array.from({ length: count }, vector);
  const input: NativeInput = { schema_version: 1, dimensions: 267,
    pointwise: features.map(features => ({ features, target: features[0] > 0.5 ? 0.95 : 0.05, weight: 1 })),
    pairs: Array.from({ length: count / 10 }, (_, i) => ({ winner: features[i], loser: features[count - 1 - i], weight: 1 })),
    predict: Array.from({ length: 500 }, vector),
  };
  const runs: Record<"typescript" | "xgboost", (ModelResult & { wall_ms: number; resident_bytes: number | null })[]> = { typescript: [], xgboost: [] };
  for (let repeat = 0; repeat < 5; repeat++) {
    const order = repeat % 2 === 0 ? ["typescript", "xgboost"] as const : ["xgboost", "typescript"] as const;
    for (const learner of order) {
      const start = performance.now();
      let result: ModelResult;
      let resident_bytes: number | null = null;
      if (learner === "typescript") result = runProduction(input);
      else {
        const command = process.platform === "darwin" ? ["/usr/bin/time", "-l", executable] : [executable];
        const child = Bun.spawnSync(command, { stdin: new TextEncoder().encode(JSON.stringify(prepareNativeInput(input))), stdout: "pipe", stderr: "pipe" });
        if (child.exitCode !== 0) throw new Error(`Native measurement failed: ${child.stderr.toString()}`);
        result = parseModelResult(JSON.parse(child.stdout.toString()), input.predict.length);
        const resident = child.stderr.toString().match(/^\s*(\d+)\s+maximum resident set size/m);
        if (process.platform === "darwin" && !resident) throw new Error("Native process memory counter unavailable");
        resident_bytes = resident ? Number(resident[1]) : null;
      }
      if (result.scores.some(score => score === null || !Number.isFinite(score))) throw new Error("Measured predictions are missing or invalid");
      const previous = runs[learner][0];
      if (previous && JSON.stringify(previous.scores) !== JSON.stringify(result.scores)) throw new Error("Measured scores are not reproducible");
      runs[learner].push({ ...result, wall_ms: performance.now() - start, resident_bytes });
    }
  }
  const report = (learner: "typescript" | "xgboost") => ({
    train_ms: summary(runs[learner].map(run => run.train_ms)), predict_ms: summary(runs[learner].map(run => run.predict_ms)), wall_ms: summary(runs[learner].map(run => run.wall_ms)),
    native_process_resident_bytes: learner === "xgboost" && process.platform === "darwin" ? summary(runs[learner].map(run => run.resident_bytes ?? 0)) : null,
    prediction_count: runs[learner][0].scores.length, score_checksum: runs[learner][0].scores.reduce<number>((sum, score) => sum + (score ?? 0), 0),
  });
  workloads.push({ pointwise: count, pairs: input.pairs.length, predictions: 500, typescript: report("typescript"), xgboost: report("xgboost") });
}
process.stdout.write(`${JSON.stringify({ kind: "synthetic-resource-measurement", verdict: "inconclusive", method: "Five alternating runs per learner and volume. Native wall time includes process launch, serialization and resource-counter wrapper. Native RSS is the standalone scorer process, not application growth. Internal train/predict timers cover learner operations. No preview extraction, full application IPC or human-quality comparison. No speedup or adoption claim.", environment: { platform: platform(), arch: arch(), cpus: availableParallelism(), load_average: loadavg() }, executable_bytes: statSync(executable).size, workloads }, null, 2)}\n`);

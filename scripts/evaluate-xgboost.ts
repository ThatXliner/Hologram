import { availableParallelism, cpus, loadavg, platform, arch, release } from 'node:os';
import { readFileSync } from 'node:fs';
import { agreement, buildFolds, parseDataset, parseModelResult, runProduction, syntheticDataset, prepareNativeInput, type ModelResult, type NativeInput } from './xgboost-evaluation.ts';

declare const Bun: { argv: string[]; version: string; spawnSync(command: string[], options: { stdin: Uint8Array; stdout: 'pipe'; stderr: 'pipe' }): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } };

function options(args: string[]) {
  let native: string | undefined, dataset: string | undefined, synthetic = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--synthetic') synthetic = true;
    else if (arg === '--native' || arg === '--dataset') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      if (arg === '--native') native = value;
      else dataset = value;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!native || Number(synthetic) + Number(dataset !== undefined) !== 1) throw new Error('Usage: bun scripts/evaluate-xgboost.ts --native /path/to/hologram-xgboost-eval (--synthetic | --dataset file.json)');
  return { native, dataset, synthetic };
}
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), samples: values };
}
function nativeRunner(executable: string, input: NativeInput): ModelResult {
  const result = Bun.spawnSync([executable], { stdin: new TextEncoder().encode(JSON.stringify(prepareNativeInput(input))), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`Native evaluator failed (${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`);
  return parseModelResult(JSON.parse(new TextDecoder().decode(result.stdout)), input.predict.length);
}
function main() {
  const args = options(Bun.argv.slice(2));
  const data = args.synthetic ? syntheticDataset() : parseDataset(JSON.parse(readFileSync(args.dataset ?? '', 'utf8')));
  const folds = buildFolds(data);
  const results = folds.map(fold => {
    const runs: Record<'typescript' | 'xgboost', ModelResult[]> = { typescript: [], xgboost: [] };
    const wall: Record<'typescript' | 'xgboost', number[]> = { typescript: [], xgboost: [] };
    for (let repeat = 0; repeat < 5; repeat++) {
      const order: ('typescript' | 'xgboost')[] = repeat % 2 === 0 ? ['typescript', 'xgboost'] : ['xgboost', 'typescript'];
      for (const implementation of order) {
        const start = performance.now();
        const result = implementation === 'typescript' ? runProduction(fold.input) : nativeRunner(args.native, fold.input);
        wall[implementation].push(performance.now() - start);
        const previous = runs[implementation][0];
        if (previous && JSON.stringify(previous.scores) !== JSON.stringify(result.scores)) throw new Error(`${implementation} predictions were not deterministic`);
        if (result.scores.some(score => score === null) && fold.input.pointwise.length + fold.input.pairs.length > 0) throw new Error(`${implementation} returned missing predictions after training`);
        runs[implementation].push(result);
      }
    }
    const report = (implementation: 'typescript' | 'xgboost') => {
      const model = runs[implementation][0];
      if (!model) throw new Error('Missing evaluation run');
      return { ...agreement(fold, model), xgboost_version: model.xgboost_version, scores: model.scores, train_ms: summary(runs[implementation].map(run => run.train_ms)), predict_ms: summary(runs[implementation].map(run => run.predict_ms)), wall_ms: summary(wall[implementation]) };
    };
    return { shoot_id: fold.shootId, train_photos: fold.trainPhotoIds.length, test_photos: fold.testPhotoIds.length, train_pointwise: fold.input.pointwise.length, train_pairs: fold.input.pairs.length, typescript: report('typescript'), xgboost: report('xgboost') };
  });
  const aggregate = (implementation: 'typescript' | 'xgboost') => {
    const totals = results.reduce((sum, result) => {
      const value = result[implementation];
      return { pointwiseCredit: sum.pointwiseCredit + value.pointwiseCredit, pointwiseCount: sum.pointwiseCount + value.pointwiseCount, pairCredit: sum.pairCredit + value.pairCredit, pairCount: sum.pairCount + value.pairCount, pointwiseTotal: sum.pointwiseTotal + value.pointwiseTotal, pairTotal: sum.pairTotal + value.pairTotal };
    }, { pointwiseCredit: 0, pointwiseCount: 0, pairCredit: 0, pairCount: 0, pointwiseTotal: 0, pairTotal: 0 });
    return { ...totals, pointwise_accuracy: totals.pointwiseCount ? totals.pointwiseCredit / totals.pointwiseCount : null, pair_agreement: totals.pairCount ? totals.pairCredit / totals.pairCount : null };
  };
  process.stdout.write(JSON.stringify({
    schema_version: 1, xgboost_version: results[0]?.xgboost.xgboost_version, dataset_kind: data.kind, feature_version: data.feature_version, backend: data.backend, profile_id: data.profile_id,
    verdict: 'inconclusive',
    interpretation: data.kind === 'synthetic' ? 'Synthetic correctness and harness smoke check only. Cannot conclude human taste quality or production performance.' : 'Held-out shoot agreement on supplied manual feedback. Observational evidence only; requires representative independent shoots before adoption.',
    methodology: { split: 'leave-one-shoot-out; global training from all other shoots', repeats: 5, ordering: 'alternating implementation order per repeat', deterministic_predictions: true, score: 'probability centered on training prior; threshold 0.5; differences within 1e-6 receive half credit; neutral pointwise targets ignored', confidence_weighting: 'training only; reported agreement is unweighted', timing: 'train and predict cover learner operations only; wall includes runner overhead and native subprocess startup; no performance winner claimed', grouping: 'caller must put bursts, duplicates, and related frames in the same shoot; pixel-level independence is not verified', automatic_feedback: 'excluded from both training and held-out agreement' },
    environment: { runtime: Bun.version, platform: platform(), release: release(), arch: arch(), logical_cpus: cpus().length, available_parallelism: availableParallelism(), load_average: loadavg() },
    volume: { shoots: data.shoots.length, photos: data.photos.length, manual_pointwise: data.pointwise.filter(row => row.provenance === 'manual').length, manual_pairs: data.pairs.filter(row => row.provenance === 'manual').length, automatic_excluded: data.pointwise.filter(row => row.provenance === 'automatic').length + data.pairs.filter(row => row.provenance === 'automatic').length },
    agreement: { typescript: aggregate('typescript'), xgboost: aggregate('xgboost') }, folds: results,
  }, null, 2) + '\n');
}
try { main(); } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

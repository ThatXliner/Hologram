import { parseDataset, type EvaluationDataset } from './xgboost-evaluation.ts';

type EvaluationSource =
  | { kind: 'synthetic' }
  | { kind: 'dataset'; path: string }
  | { kind: 'decision-book'; path: string; datasetIndex?: number; confirmSourceGroups: boolean };

export interface EvaluationOptions {
  native: string;
  source: EvaluationSource;
}

const usage = 'Usage: bun scripts/evaluate-xgboost.ts --native /path/to/hologram-xgboost-eval (--synthetic | --dataset file.json | --decision-book book.json [--dataset-index N] --confirm-source-groups)';

export function parseEvaluationOptions(args: string[]): EvaluationOptions {
  let native: string | undefined;
  let source: EvaluationSource | undefined;
  let datasetIndex: number | undefined;
  let confirmSourceGroups = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Duplicate argument ${arg}`);
    seen.add(arg);
    if (arg === '--synthetic') {
      if (source) throw new Error(usage);
      source = { kind: 'synthetic' };
    } else if (arg === '--confirm-source-groups') {
      confirmSourceGroups = true;
    } else if (arg === '--native' || arg === '--dataset' || arg === '--decision-book' || arg === '--dataset-index') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--native') native = value;
      else if (arg === '--dataset-index') {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--dataset-index requires a nonnegative integer');
        datasetIndex = Number(value);
      } else {
        if (source) throw new Error(usage);
        source = arg === '--dataset' ? { kind: 'dataset', path: value } : { kind: 'decision-book', path: value, confirmSourceGroups: false };
      }
    } else throw new Error(`Unknown argument ${arg}`);
  }
  if (!native || !source) throw new Error(usage);
  if (source.kind === 'decision-book') return { native, source: { ...source, datasetIndex, confirmSourceGroups } };
  if (datasetIndex !== undefined || confirmSourceGroups) throw new Error('--dataset-index and --confirm-source-groups require --decision-book');
  return { native, source };
}

export function selectDecisionBookDataset(
  value: unknown,
  options: { datasetIndex?: number; confirmSourceGroups: boolean },
): { dataset: EvaluationDataset; datasetIndex: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('schema_version' in value) || value.schema_version !== 1
    || !('kind' in value) || value.kind !== 'hologram-decision-book'
    || !('grouping' in value) || value.grouping !== 'source-folder-unverified'
    || !('datasets' in value) || !Array.isArray(value.datasets)) {
    throw new Error('Unsupported decision book schema or grouping');
  }
  if (!options.confirmSourceGroups) {
    throw new Error('Confirm that source folders represent independent shoots, with bursts and near-duplicates kept together, then pass --confirm-source-groups');
  }
  if (!value.datasets.length) throw new Error('Decision book has no compatible review datasets');
  if (options.datasetIndex === undefined && value.datasets.length > 1) {
    throw new Error(`Decision book has ${value.datasets.length} datasets. Select one with --dataset-index N`);
  }
  const datasetIndex = options.datasetIndex ?? 0;
  if (!Number.isSafeInteger(datasetIndex) || datasetIndex < 0 || datasetIndex >= value.datasets.length) {
    throw new Error('--dataset-index is outside this decision book');
  }
  const dataset = parseDataset(value.datasets[datasetIndex]);
  if (dataset.kind !== 'human') throw new Error('Decision books require human review data');
  return { dataset, datasetIndex };
}

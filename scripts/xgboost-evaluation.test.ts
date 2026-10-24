import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agreement, buildFolds, parseDataset, parseModelResult, runProduction, syntheticDataset, prepareNativeInput } from './xgboost-evaluation.ts';

describe('held-out taste evaluation', () => {
  test('global training includes every other shoot and excludes every held-out photo', () => {
    const data = syntheticDataset();
    for (const fold of buildFolds(data)) {
      assert.equal(fold.trainPhotoIds.length, 24);
      assert.equal(fold.input.pointwise.length, 24);
      assert.equal(fold.input.pairs.length, 3);
      assert.equal(fold.trainPhotoIds.some(id => fold.testPhotoIds.includes(id)), false);
      for (const vector of fold.input.pointwise.map(row => row.features)) assert.equal(fold.input.predict.includes(vector), false);
    }
  });
  test('automatic choices cannot change train inputs or held-out agreement', () => {
    const data = syntheticDataset();
    data.pointwise[0].provenance = 'automatic';
    data.pairs[0].provenance = 'automatic';
    const folds = buildFolds(parseDataset(data));
    assert.equal(folds[0].pointwise.length, 7);
    assert.equal(folds[0].pairs.length, 0);
    assert.equal(folds[1].input.pointwise.length, 23);
    assert.equal(folds[1].input.pairs.length, 2);
  });
  test('cross-boundary pairs are neither training leakage nor held-out pair choices', () => {
    const data = syntheticDataset();
    data.pairs.push({ winnerId: 'shoot-a-7', loserId: 'shoot-b-0', confidence: 1, provenance: 'manual' });
    const folds = buildFolds(parseDataset(data));
    assert.equal(folds[0].input.pairs.length, 3);
    assert.equal(folds[1].input.pairs.length, 3);
    assert.equal(folds[2].input.pairs.length, 4);
    assert.equal(folds[0].pairs.length, 1);
  });
  test('actual production learner returns deterministic predictions with positive agreement', () => {
    const fold = buildFolds(syntheticDataset())[0];
    const first = runProduction(fold.input);
    assert.deepEqual(runProduction(fold.input).scores, first.scores);
    assert.ok(agreement(fold, first).pointwiseCredit > 4);
    assert.equal(agreement(fold, first).pairCredit, 1);
  });
  test('empty and sparse training remain explicit', () => {
    const data = syntheticDataset();
    data.pointwise = data.pointwise.filter(row => row.photoId === 'shoot-a-7');
    data.pairs = [];
    const folds = buildFolds(parseDataset(data));
    assert.deepEqual(runProduction(folds[0].input).scores, Array(8).fill(null));
    assert.equal(agreement(folds[0], runProduction(folds[0].input)).pointwiseCount, 0);
    assert.equal(runProduction(folds[1].input).scores.every(value => value !== null), true);
  });
  test('pair-only feedback trains production learner', () => {
    const data = syntheticDataset();
    data.pointwise = [];
    const fold = buildFolds(parseDataset(data))[0];
    assert.equal(agreement(fold, runProduction(fold.input)).pairCredit, 1);
  });
  test('ties receive half credit; missing predictions do not enter denominators', () => {
    const fold = buildFolds(syntheticDataset())[0];
    const tied = agreement(fold, { scores: Array(8).fill(0.5), train_ms: 0, predict_ms: 0 });
    assert.equal(tied.pointwiseCredit, 4);
    assert.equal(tied.pairCredit, 0.5);
    const missing = agreement(fold, { scores: Array(8).fill(null), train_ms: 0, predict_ms: 0 });
    assert.equal(missing.pointwiseCount, 0);
    assert.equal(missing.pointwiseTotal, 8);
  });
  test('neutral floating-point drift receives tie credit for both metrics', () => {
    const fold = buildFolds(syntheticDataset())[0];
    const result = { scores: fold.testPhotoIds.map(() => 0.5000000215070957), train_ms: 0, predict_ms: 0 };
    result.scores[0] = 0.49999997849;
    const metrics = agreement(fold, result);
    assert.equal(metrics.pointwiseCredit, metrics.pointwiseCount / 2);
    assert.equal(metrics.pairCredit, metrics.pairCount / 2);
  });
  test('neutral manual choices are excluded from directional agreement', () => {
    const data = syntheticDataset();
    data.pointwise[0].signal = 0.5;
    assert.equal(buildFolds(parseDataset(data))[0].pointwise.length, 7);
  });
  test('invalid versions, profiles, vectors, identities, and references fail at input boundary', () => {
    const mutate = (change: (data: ReturnType<typeof syntheticDataset>) => unknown) => {
      const data = syntheticDataset();
      change(data);
      assert.throws(() => parseDataset(data));
    };
    assert.throws(() => parseDataset({ ...syntheticDataset(), schema_version: 2 }));
    mutate(data => { data.feature_version = 'unknown'; });
    mutate(data => { data.backend = 'other'; });
    mutate(data => { data.profile_id = ''; });
    mutate(data => { data.photos[0].features[0] = NaN; });
    mutate(data => { data.photos[0].features[0] = Number.MAX_VALUE; });
    mutate(data => { data.photos[0].features.pop(); });
    mutate(data => { data.photos[0].id = data.photos[1].id; });
    mutate(data => { data.photos[0].shootId = 'unknown'; });
    mutate(data => { data.pointwise[0].photoId = 'unknown'; });
    mutate(data => { data.pairs[0].loserId = data.pairs[0].winnerId; });
    mutate(data => { data.pointwise.push(data.pointwise[0]); });
    mutate(data => { data.shoots = ['shoot-a']; });
    assert.throws(() => parseDataset({ ...syntheticDataset(), profile_id: ['a', 'b'] }));
    assert.throws(() => parseDataset({ ...syntheticDataset(), photos: [{ ...syntheticDataset().photos[0], profile_id: 'other' }] }));
  });
  test('human input requires held-out manual choices', () => {
    const data = syntheticDataset();
    data.kind = 'human';
    data.pointwise = data.pointwise.map(row => ({ ...row, provenance: 'automatic' }));
    data.pairs = [];
    assert.throws(() => parseDataset(data), /held-out manual choices/);
  });
  test('native adapter matches production target clipping and pair confidence scaling', () => {
    const input = buildFolds(syntheticDataset())[0].input;
    input.pointwise[0].target = 0;
    input.pointwise[1].target = 1;
    const adapted = prepareNativeInput(input);
    assert.equal(adapted.pointwise[0].target, 0.03);
    assert.equal(adapted.pointwise[1].target, 0.97);
    assert.equal(adapted.pairs[0].weight, input.pairs[0].weight * 0.9);
    assert.equal(input.pairs[0].weight, 1);
  });
  test('native result validation rejects malformed or missing work', () => {
    assert.throws(() => parseModelResult({ scores: [], train_ms: 0, predict_ms: 0 }, 1));
    assert.throws(() => parseModelResult({ scores: [Infinity], train_ms: 0, predict_ms: 0 }, 1));
    assert.throws(() => parseModelResult({ scores: [0.5], train_ms: -1, predict_ms: 0, xgboost_version: '3.1.1' }, 1));
    assert.throws(() => parseModelResult({ schema_version: 99, scores: [0.5], train_ms: 0, predict_ms: 0, xgboost_version: '3.1.1' }, 1));
    assert.throws(() => parseModelResult({ schema_version: 1, scores: [0.5], train_ms: 0, predict_ms: 0, xgboost_version: '0.0.0' }, 1));
    assert.equal(parseModelResult({ schema_version: 1, scores: [0.5], train_ms: 1, predict_ms: 0, xgboost_version: '3.1.1' }, 1).xgboost_version, '3.1.1');
  });
});


describe('comparison CLI boundary', () => {
  const cli = fileURLToPath(new URL('./evaluate-xgboost.ts', import.meta.url));
  test('missing or ambiguous dataset selection fails without reporting success', () => {
    const missing = spawnSync(process.execPath, [cli, '--synthetic'], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Usage:/);
    const ambiguous = spawnSync(process.execPath, [cli, '--synthetic', '--dataset', 'x.json', '--native', process.execPath], { encoding: 'utf8' });
    assert.equal(ambiguous.status, 1);
    assert.equal(ambiguous.stdout, '');
  });
  test('unavailable native executable fails without a report', () => {
    const failed = spawnSync(process.execPath, [cli, '--synthetic', '--native', fileURLToPath(new URL('./missing-xgboost-executable', import.meta.url))], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.ok(failed.stderr.length > 0);
  });
});

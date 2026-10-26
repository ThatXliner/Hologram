import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvaluationOptions, selectDecisionBookDataset } from './decision-book-input.ts';
import { syntheticDataset } from './xgboost-evaluation.ts';
import { buildDecisionBook } from '../src/lib/autocullDecisionBook.ts';
import { PREFERENCE_FEATURE_VERSION, type PreferenceFeatureSnapshot } from '../src/lib/autocull.ts';

function book() {
  const dataset = syntheticDataset();
  dataset.kind = 'human';
  return { schema_version: 1, kind: 'hologram-decision-book', grouping: 'source-folder-unverified', datasets: [dataset] };
}

describe('decision book evaluation input', () => {
  test('preserves existing synthetic and dataset modes', () => {
    assert.deepEqual(parseEvaluationOptions(['--native', 'runner', '--synthetic']), { native: 'runner', source: { kind: 'synthetic' } });
    assert.deepEqual(parseEvaluationOptions(['--dataset', 'data.json', '--native', 'runner']), { native: 'runner', source: { kind: 'dataset', path: 'data.json' } });
  });

  test('book options can appear in any order', () => {
    assert.deepEqual(parseEvaluationOptions(['--dataset-index', '1', '--confirm-source-groups', '--native', 'runner', '--decision-book', 'book.json']), {
      native: 'runner', source: { kind: 'decision-book', path: 'book.json', datasetIndex: 1, confirmSourceGroups: true },
    });
  });

  test('rejects ambiguous, duplicate, missing, and misplaced arguments', () => {
    for (const args of [
      ['--native', 'runner'],
      ['--synthetic'],
      ['--native', 'runner', '--synthetic', '--decision-book', 'book.json'],
      ['--native', 'runner', '--synthetic', '--synthetic'],
      ['--native', 'runner', '--native', 'other', '--synthetic'],
      ['--native', 'runner', '--dataset'],
      ['--native', 'runner', '--synthetic', '--dataset-index', '0'],
      ['--native', 'runner', '--dataset', 'data.json', '--confirm-source-groups'],
      ['--native', 'runner', '--decision-book', 'book.json', '--dataset-index', '-1'],
      ['--native', 'runner', '--decision-book', 'book.json', '--dataset-index', '1.5'],
      ['--native', 'runner', '--decision-book', 'book.json', '--dataset-index', 'NaN'],
      ['--native', 'runner', '--synthetic', '--unknown'],
    ]) assert.throws(() => parseEvaluationOptions(args));
  });

  test('requires the independent shoot grouping acknowledgement before evaluation', () => {
    assert.throws(() => selectDecisionBookDataset(book(), { confirmSourceGroups: false }), /independent shoots/);
  });

  test('selects the only dataset without an index', () => {
    const input = book();
    const selected = selectDecisionBookDataset(input, { confirmSourceGroups: true });
    assert.deepEqual(selected.dataset, input.datasets[0]);
    assert.equal(selected.datasetIndex, 0);
  });

  test('requires an explicit index when a book has multiple feature datasets', () => {
    const input = book();
    input.datasets.push({ ...input.datasets[0], profile_id: 'profile-2' });
    assert.throws(() => selectDecisionBookDataset(input, { confirmSourceGroups: true }), /--dataset-index/);
    assert.equal(selectDecisionBookDataset(input, { confirmSourceGroups: true, datasetIndex: 1 }).dataset.profile_id, 'profile-2');
  });

  test('rejects invalid book schemas, groups, and dataset indexes', () => {
    for (const value of [null, [], {}, { ...book(), schema_version: 2 }, { ...book(), kind: 'other' }, { ...book(), grouping: 'verified' }, { ...book(), datasets: null }]) {
      assert.throws(() => selectDecisionBookDataset(value, { confirmSourceGroups: true }), /Unsupported decision book/);
    }
    assert.throws(() => selectDecisionBookDataset({ ...book(), datasets: [] }, { confirmSourceGroups: true }), /no compatible/);
    for (const datasetIndex of [-1, 1, 1.2, NaN, Infinity]) {
      assert.throws(() => selectDecisionBookDataset(book(), { confirmSourceGroups: true, datasetIndex }), /outside/);
    }
  });

  test('validates selected dataset features and human provenance declaration', () => {
    const invalid = book();
    invalid.datasets[0].photos[0].features[0] = NaN;
    assert.throws(() => selectDecisionBookDataset(invalid, { confirmSourceGroups: true }), /finite/);
    assert.throws(() => selectDecisionBookDataset({ ...book(), datasets: [syntheticDataset()] }, { confirmSourceGroups: true }), /human review/);
  });

  test('a single shoot or no held-out human labels cannot pass the readiness gate', () => {
    const single = book();
    single.datasets[0].shoots = single.datasets[0].shoots.slice(0, 1);
    assert.throws(() => selectDecisionBookDataset(single, { confirmSourceGroups: true }), /two unique shoots/);
    const empty = book();
    empty.datasets[0].pointwise = [];
    empty.datasets[0].pairs = [];
    assert.throws(() => selectDecisionBookDataset(empty, { confirmSourceGroups: true }), /held-out manual choices/);
  });

  test('consumes the actual exported book without reshaping the data', () => {
    const ids = ['private-photo-a', 'private-photo-b'];
    const snapshots = new Map<string, PreferenceFeatureSnapshot>(ids.map((photoId, index) => [photoId, {
      photoId, version: PREFERENCE_FEATURE_VERSION, backend: 'perceptual-dct-focus-v4',
      rankerFeatures: Array.from({ length: 267 }, (_, feature) => feature === 0 ? index : 0),
      embedding: [1, index], sourceGroup: `folder-sha256:${String(index).repeat(64)}`,
    }]));
    const exported = buildDecisionBook({
      refinements: ids.map((photo_id, index) => ({ photo_id, flag: index === 0 ? 'pick' : 'reject', rating: 0, confidence: 1, source: 'manual_decision', updated_at: '2026-01-01T00:00:00Z' })),
      pairs: [], snapshots, createdAt: '2026-01-01T00:00:00Z',
    });
    const selected = selectDecisionBookDataset(JSON.parse(JSON.stringify(exported)), { confirmSourceGroups: true });
    assert.equal(selected.dataset.kind, 'human');
    assert.equal(selected.dataset.shoots.length, 2);
    assert.equal(selected.dataset.pointwise.length, 2);
    assert.deepEqual(selected.dataset, exported.datasets[0]);
    assert.equal(JSON.stringify(selected).includes('private-photo'), false);
  });
});

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { selectDecisionBookDataset } from './decision-book-input.ts';

const evidenceRoot = join(tmpdir(), 'hologram-decision-book-evidence');
await mkdir(evidenceRoot, { recursive: true });
const output = await mkdtemp(join(evidenceRoot, 'browser-'));
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/.cache/**', '**/scripts/**', '**/crates/**', '**/src-tauri/**'] } } });
await server.listen();
const browser = await chromium.launch({
  headless: true,
  executablePath: [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const checks: string[] = [];
try {
  await page.addInitScript(() => {
    const state: { mode: string; writes: { path: string; contents: string }[] } = { mode: 'cancel', writes: [] };
    const tauri = {
      invoke: async (command: string, args: { path?: string; contents?: string } = {}) => {
        if (command === 'plugin:dialog|save') return state.mode === 'cancel' ? null : '/fixture/decision-book.json';
        if (command === 'save_decision_book') {
          if (state.mode === 'error') throw new Error('Fixture disk is full');
          if (!args.path || !args.contents) throw new Error('Missing save arguments');
          state.writes.push({ path: args.path, contents: args.contents });
          return null;
        }
        if (['find_missing_photo_ids', 'read_autocull_feature_cache'].includes(command)) return [];
        if (command === 'plugin:event|listen') return 1;
        if (command === 'get_photo_metadata') return {};
        return null;
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (path: string) => path,
    };
    Object.assign(window, {
      __HOLOGRAM_DISABLE_TRANSFORMER_EMBEDDINGS__: true,
      __decisionBookIPC: state,
      __decisionBookTauri: tauri,
      __TAURI_INTERNALS__: tauri,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.evaluate(async (imageData: string) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${imageData}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    ctx.drawImage(image, 0, 0, 160, 160);
    const thumbnail = canvas.toDataURL('image/png').split(',')[1];
    const storePath = '/src/lib/stores/photoStore.ts';
    const tastePath = '/src/lib/autocull.ts';
    const planPath = '/src/lib/autocullPlan.ts';
    const { photoStore } = await import(storePath);
    const taste = await import(tastePath);
    const { saveAutomaticDecisions } = await import(planPath);
    const photos = Array.from({ length: 5 }, (_, index) => ({
      id: `private-book-${index}`, file_name: `original-${index}.jpg`,
      file_path: `/private/photographer/${index < 2 ? 'shoot-one' : 'shoot-two'}/original-${index}.jpg`,
      file_size: 100, file_type: 'JPEG', created_at: '2026-01-01', modified_at: '2026-01-01', thumbnail,
      flag: index === 4 ? 'pick' : 'none', rating: 0,
      exif: { date_taken: new Date(Date.UTC(2026, 0, index + 1)).toISOString() },
    }));
    const timestamp = '2026-01-01T00:00:00Z';
    taste.savePreferenceProfiles([
      { id: 'default', name: 'Default', created_at: timestamp, updated_at: timestamp },
      { id: 'empty-profile', name: 'Empty profile', created_at: timestamp, updated_at: timestamp },
    ]);
    taste.saveActivePreferenceProfileId('default');
    taste.savePreferenceFeedback('default', [...photos.slice(0, 4).map((photo, index) => ({
      photo_id: photo.id, flag: index % 2 === 0 ? 'pick' : 'reject', rating: index % 2 === 0 ? 5 : 1,
      confidence: 1, source: 'manual_decision', updated_at: timestamp,
    })), { photo_id: 'private-book-missing', flag: 'pick', rating: 4, confidence: 1, source: 'manual_decision', updated_at: timestamp }], [
      { winner_photo_id: photos[0].id, loser_photo_id: photos[1].id, confidence: 1, source: 'cluster_winner', created_at: timestamp },
      { winner_photo_id: photos[2].id, loser_photo_id: photos[3].id, confidence: 1, source: 'manual', created_at: timestamp },
    ]);
    taste.savePreferenceFeedback('empty-profile', [], []);
    saveAutomaticDecisions(localStorage, null, { [photos[4].id]: { flag: 'pick', rating: 0 } });
    const features = new Map(photos.map((photo, index) => [photo.id, {
      embedding: index % 2 === 0 ? [1, 0] : [0, 1], technicalScore: index % 2 === 0 ? 0.9 : 0.2,
      backend: 'perceptual-dct-focus-v4',
    }]));
    await taste.capturePreferenceFeatures(photos, taste.rankAutoCullPhotos(photos, features));
    photoStore.setPhotos(photos);
  }, readFileSync(new URL('./fixtures/stock/portrait.jpg', import.meta.url)).toString('base64'));
  await page.getByRole('button', { name: 'AutoCull', exact: true }).click();
  const view = page.locator('[data-autocull-view]');
  await page.waitForFunction(() => document.querySelector('[data-autocull-view]')?.getAttribute('data-autocull-mode') === 'overview');
  await view.getByRole('button', { name: /Review manually instead|Browse all stacks|Review .*exception/ }).first().click();
  await page.locator('[data-autocull-advanced]').evaluate((element) => { if (element instanceof HTMLDetailsElement) element.open = true; });
  const prepare = page.locator('[data-autocull-prepare-decision-book]');
  const save = page.locator('[data-autocull-save-decision-book]');
  const summary = page.locator('[data-autocull-decision-book-summary]');
  await page.evaluate(async () => {
    const modulePath = '/src/lib/stores/photoStore.ts';
    const { photoStore } = await import(modulePath);
    photoStore.setPhotoFlag('private-book-4', 'none');
  });
  await view.getByRole('button', { name: 'Refresh analysis', exact: true }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-autocull-prepare-decision-book]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  assert.equal(await page.evaluate(() => Object.hasOwn(JSON.parse(localStorage.getItem('hologram.autocull.automatic.v2') ?? '{}'), 'private-book-4')), true, 'loading neutral metadata cannot erase known automatic provenance');
  await page.evaluate(async () => {
    const modulePath = '/src/lib/stores/photoStore.ts';
    const { photoStore } = await import(modulePath);
    photoStore.setPhotoFlag('private-book-4', 'pick');
  });
  await view.getByRole('button', { name: 'Refresh analysis', exact: true }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-autocull-prepare-decision-book]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  const metadataScopeBook = await page.evaluate(async () => {
    const modulePath = '/src/lib/autocullDecisionBook.ts';
    const { createDecisionBook } = await import(modulePath);
    return createDecisionBook('default');
  });
  assert.equal(metadataScopeBook.summary.manual_decisions, 4);
  checks.push('metadata from another folder cannot erase automatic provenance or turn its returning flag into human feedback');
  await prepare.click();
  await save.waitFor();
  assert.match(await summary.innerText(), /4 labels · 2 comparisons · 4 photos/);
  assert.match(await summary.innerText(), /2 provisional shoots/);
  assert.match(await summary.innerText(), /1 labels and 0 comparisons omitted/);
  assert.match(await summary.innerText(), /No original images or file paths/);
  checks.push('preparation reads saved human reviews, groups two shoots, and reports unavailable evidence');
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'prepared.png'), fullPage: true });
  await page.evaluate(() => Reflect.deleteProperty(window, '__TAURI_INTERNALS__'));
  const downloadEvent = page.waitForEvent('download');
  await save.click();
  const download = await downloadEvent;
  const bookPath = join(output, download.suggestedFilename());
  await download.saveAs(bookPath);
  const encoded = await readFile(bookPath, 'utf8');
  const book: unknown = JSON.parse(encoded);
  const selected = selectDecisionBookDataset(book, { confirmSourceGroups: true });
  assert.equal(selected.dataset.photos.length, 4);
  assert.equal(selected.dataset.shoots.length, 2);
  assert.equal(selected.dataset.pointwise.length, 4);
  assert.equal(selected.dataset.pairs.length, 2);
  assert.ok(selected.dataset.pointwise.every((row) => row.provenance === 'manual'));
  for (const privateValue of ['private-book-', '/private/', 'photographer', 'original-', 'empty-profile', 'folder-sha256']) assert.ok(!encoded.includes(privateValue), privateValue);
  assert.throws(() => selectDecisionBookDataset(book, { confirmSourceGroups: false }), /Confirm/);
  checks.push('actual browser download contains replayable datasets and anonymous human evidence only');
  await page.evaluate(() => Reflect.set(window, '__TAURI_INTERNALS__', Reflect.get(window, '__decisionBookTauri')));
  await view.getByRole('button', { name: 'Refresh analysis', exact: true }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-autocull-prepare-decision-book]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  const absentSourceBook = await page.evaluate(async () => {
    const modulePath = '/src/lib/autocullDecisionBook.ts';
    const { createDecisionBook } = await import(modulePath);
    return createDecisionBook('default');
  });
  assert.equal(absentSourceBook.summary.shoots, 2);
  assert.equal(absentSourceBook.summary.missing_shoot, 0);
  assert.equal(absentSourceBook.summary.manual_decisions, 4);
  checks.push('analysis refresh preserves durable source groups without needing original source photos at export');
  await prepare.click();
  await save.waitFor();
  await save.click();
  await page.waitForFunction(() => document.querySelector('[data-autocull-save-decision-book]')?.textContent === 'Save JSON');
  assert.equal(await page.evaluate(() => Reflect.get(window, '__decisionBookIPC').writes.length), 0);
  assert.equal(await summary.count(), 1);
  checks.push('native save cancellation preserves the prepared book without writing');
  await page.evaluate(() => { Reflect.get(window, '__decisionBookIPC').mode = 'error'; });
  await save.click();
  await summary.getByRole('alert').waitFor();
  assert.match(await summary.innerText(), /Fixture disk is full/);
  assert.equal(await save.isEnabled(), true);
  await page.evaluate(() => { Reflect.get(window, '__decisionBookIPC').mode = 'save'; });
  await save.click();
  await page.locator('[data-autocull-decision-book-saved]').waitFor();
  const saved = await page.evaluate(() => Reflect.get(window, '__decisionBookIPC').writes[0].contents);
  assert.equal(selectDecisionBookDataset(JSON.parse(saved), { confirmSourceGroups: true }).dataset.photos.length, 4);
  checks.push('native save errors retain retry and successful retry sends the generated book');
  await prepare.click();
  await save.waitFor();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('x');
  await page.waitForFunction(() => !document.querySelector('[data-autocull-save-decision-book]'));
  checks.push('manual correction invalidates a prepared book');
  await prepare.click();
  await save.waitFor();
  await view.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-autocull-save-decision-book]'));
  checks.push('undo invalidates a prepared book');
  await prepare.click();
  await save.waitFor();
  await view.getByRole('button', { name: 'Empty profile', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-autocull-save-decision-book]'));
  await prepare.click();
  await save.waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.match(await summary.innerText(), /No exportable human reviews yet/);
  checks.push('profile changes discard prepared evidence and empty profiles cannot save');
  await page.screenshot({ path: join(output, 'empty-profile.png'), fullPage: true });
  await writeFile(join(output, 'report.json'), JSON.stringify({ ok: true, checks, book: bookPath }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks, output, book: bookPath }, null, 2));
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await server.close();
}

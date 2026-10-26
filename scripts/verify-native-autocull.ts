import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';

const args = Bun.argv.slice(2);
if (args.length !== 2 || args[0] !== '--binary') {
  throw new Error('Usage: bun scripts/verify-native-autocull.ts --binary /path/to/smoke-feature/hologram');
}
const binary = resolve(args[1]);
assert.ok(existsSync(binary), 'Build the Tauri application with --features native-autocull-smoke first');
const output = await mkdtemp(join(tmpdir(), 'hologram-native-autocull-'));
const server = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
await server.listen();
const log = Bun.file(join(output, 'app.log'));
const child = Bun.spawn([binary], {
  env: { ...process.env, HOLOGRAM_AUTOCULL_SMOKE_DIR: output },
  stdout: log,
  stderr: log,
});
const timeout = setTimeout(() => child.kill(), 120_000);
try {
  const status = await child.exited;
  const reportPath = join(output, 'report.json');
  assert.ok(existsSync(reportPath), `Native workflow did not report a result; inspect ${join(output, 'app.log')}`);
  const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
  console.log(`Native workflow artifacts: ${output}`);
  assert.ok(typeof report === 'object' && report !== null && 'ok' in report && report.ok === true, JSON.stringify(report));
  assert.equal(status, 0, 'Native verification process exits successfully');
  assert.ok('decision_book_path' in report && typeof report.decision_book_path === 'string', 'Native workflow reports its saved decision book');
  assert.equal(resolve(report.decision_book_path), join(output, 'shoot-a', 'decision-book.json'), 'Native export stays in the disposable fixture');
  const contents = await readFile(report.decision_book_path, 'utf8');
  const book: unknown = JSON.parse(contents);
  assert.ok(typeof book === 'object' && book !== null && 'kind' in book && book.kind === 'hologram-decision-book'
    && 'schema_version' in book && book.schema_version === 1, 'Actual native output is a versioned decision book');
  assert.ok('summary' in book && typeof book.summary === 'object' && book.summary !== null, 'Saved book has review counts');
  assert.ok('decision_book_summary' in report, 'Native workflow reports expected review counts');
  assert.deepEqual(book.summary, report.decision_book_summary, 'Actual native file preserves the generated review counts');
  assert.ok('reviews' in book && Array.isArray(book.reviews) && 'manual_decisions' in book.summary
    && book.reviews.length === book.summary.manual_decisions && book.reviews.length > 0, 'Saved native file retains human review rows');
  assert.ok(!contents.includes(output) && !contents.includes('native-smoke-'), 'Saved native file excludes source paths and original photo IDs');
  console.log(JSON.stringify({ output, report }, null, 2));
} finally {
  clearTimeout(timeout);
  child.kill();
  await server.close();
}

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { createServer } from 'vite';

const args = Bun.argv.slice(2);
if (args.length !== 2 || args[0] !== '--binary') {
  throw new Error('Usage: bun scripts/verify-native-xmp.ts --binary /path/to/smoke-feature/hologram');
}
const binary = resolve(args[1]);
assert.ok(existsSync(binary), 'Build with --features native-autocull-smoke first');
const output = await mkdtemp(join(tmpdir(), 'hologram-native-xmp-'));
const folder = join(output, 'shoot-a');
await mkdir(folder);
const portrait = await readFile(new URL('./fixtures/stock/portrait.jpg', import.meta.url));
const originals = ['original.jpg', 'duplicate.jpg', 'blurred.jpg', 'black.jpg', 'white.jpg',
  'stars.jpg', 'unrated.jpg', 'colors.jpg', 'broken.jpg', 'pair.CR2', 'pair.JPG'];
const sources = new Map<string, Uint8Array>();
const writeSource = async (filename: string, bytes: Uint8Array | string) => {
  const content = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  sources.set(filename, content);
  await writeFile(join(folder, filename), content);
};
for (const filename of originals) await writeSource(filename, portrait);
const packet = (attributes: string, children = '') => `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:darktable="http://darktable.sf.net/" ${attributes}>
   ${children}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
const ratings = new Map([
  ['original.jpg', 4], ['duplicate.jpg', 0], ['blurred.jpg', -1], ['black.jpg', -1],
  ['white.jpg', -1], ['stars.jpg', 3], ['unrated.jpg', 0], ['pair.CR2', 5], ['pair.JPG', -1],
]);
for (const [filename, rating] of ratings) {
  await writeSource(`${filename}.xmp`, packet(`xmp:Rating="${rating}"`, filename === 'stars.jpg'
    ? '<dc:subject><rdf:Bag><rdf:li>client &amp; review</rdf:li></rdf:Bag></dc:subject><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Imported &#9733;</rdf:li></rdf:Alt></dc:description>'
    : ''));
}
await writeSource('colors.jpg.xmp', packet('xmp:Label="Red"', '<darktable:colorlabels><rdf:Seq><rdf:li>0</rdf:li></rdf:Seq></darktable:colorlabels><darktable:history><rdf:Seq><rdf:li><rdf:Description xmp:Rating="5"/></rdf:li></rdf:Seq></darktable:history>'));
await writeSource('broken.jpg.xmp', packet('xmp:Rating="5"').replace('</rdf:RDF>', ''));
await writeFile(join(output, 'source-files.json'), JSON.stringify([...sources.keys()], null, 2));
const server = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
await server.listen();
const log = Bun.file(join(output, 'app.log'));
const child = Bun.spawn([binary], {
  env: { ...process.env, HOLOGRAM_AUTOCULL_SMOKE_DIR: output, HOLOGRAM_SMOKE_SCENARIO: 'xmp' },
  stdout: log,
  stderr: log,
});
const timeout = setTimeout(() => child.kill(), 120_000);
try {
  const status = await child.exited;
  const reportPath = join(output, 'report.json');
  console.log(`Native XMP artifacts: ${output}`);
  assert.ok(existsSync(reportPath), `Native workflow did not report a result; inspect ${join(output, 'app.log')}`);
  const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.ok(typeof report === 'object' && report !== null && 'ok' in report && report.ok === true, JSON.stringify(report));
  assert.equal(status, 0, 'Native verification process exits successfully');
  for (const [filename, expected] of sources) {
    assert.deepEqual(new Uint8Array(await readFile(join(folder, filename))), new Uint8Array(expected), `${filename} retains every source byte`);
  }
  const db = new Database(join(folder, 'hologram.sql'), { readonly: true });
  try {
    const read = db.query('SELECT rating, flag, xmp_cull_revision FROM photo_metadata WHERE photo_id = ?');
    for (const [filename, rating] of ratings) {
      const row = read.get(`xmp-smoke-${filename}`);
      assert.ok(row && typeof row === 'object' && 'rating' in row && row.rating === Math.max(0, rating), `${filename} has its imported rating in the reopened catalog`);
      assert.ok('flag' in row && (rating < 0 ? row.flag === 'reject' : row.flag === 'none'), `${filename} has its imported rejection state in the reopened catalog`);
      assert.ok('xmp_cull_revision' in row && typeof row.xmp_cull_revision === 'string' && row.xmp_cull_revision.length > 0, `${filename} retains durable import provenance`);
    }
    assert.deepEqual(read.get('xmp-smoke-colors.jpg'), { rating: 2, flag: 'pick', xmp_cull_revision: null });
    assert.deepEqual(read.get('xmp-smoke-broken.jpg'), { rating: 2, flag: 'pick', xmp_cull_revision: null });
    await writeFile(join(output, 'persisted-metadata.json'), JSON.stringify(db.query('SELECT * FROM photo_metadata ORDER BY photo_id').all(), null, 2));
  } finally {
    db.close();
  }
  console.log(JSON.stringify({ output, report, immutable_source_files: sources.size }, null, 2));
} finally {
  clearTimeout(timeout);
  child.kill();
  await server.close();
}

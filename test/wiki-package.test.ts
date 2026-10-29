import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { validateWikiTree, verifyWikiBlob, validateWikiPackage } =
  await import(new URL('../tools/fetch-wiki.mjs', import.meta.url).href);
const paths = [
  '.nojekyll', 'README.md', 'index.html', 'export-manifest.json', 'docs/sla-draft.md',
  'assets/app.js', 'assets/locale.js', 'assets/styles.css', 'assets/brand.css', 'assets/fonts.css',
  'assets/onelaser-logo-black.svg', 'assets/x-series.jpg', 'assets/hydra-series.png', 'assets/cobra.webp', 'assets/vertigo.png',
  ...['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'].map(name => `assets/fonts/Certia-${name}.otf`),
  'data/library.json', 'data/search-index.json',
  ...Array.from({ length: 236 }, (_, i) => `data/articles/en-${i + 1}.json`),
];
const tree = () => ({ truncated: false, tree: paths.map(path => ({ path, mode: '100644', type: 'blob', size: 100, sha: 'a'.repeat(40) })) });

test('Wiki package requires its complete public inventory and rejects new/private/unsafe paths', () => {
  assert.equal(validateWikiTree(tree()).length, 259);
  for (const mutate of [
    (t: ReturnType<typeof tree>) => { t.truncated = true; },
    (t: ReturnType<typeof tree>) => { t.tree.pop(); },
    (t: ReturnType<typeof tree>) => { t.tree[0]!.path = '../local.env'; },
    (t: ReturnType<typeof tree>) => { t.tree[0]!.path = '.env'; },
    (t: ReturnType<typeof tree>) => { t.tree[0]!.mode = '120000'; },
    (t: ReturnType<typeof tree>) => { t.tree[0]!.size = 2 * 1024 * 1024 + 1; },
    (t: ReturnType<typeof tree>) => { t.tree.forEach(file => { file.size = 100000; }); },
    (t: ReturnType<typeof tree>) => { t.tree[0]!.sha = 'unknown'; },
    (t: ReturnType<typeof tree>) => { t.tree.push(t.tree[1]!); },
  ]) { const candidate = tree(); mutate(candidate); assert.throws(() => validateWikiTree(candidate)); }
});

test('Wiki downloads must match the Git blob bytes and declared length', () => {
  const bytes = Buffer.from('public original');
  const file = { path: 'index.html', size: bytes.length,
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
  assert.doesNotThrow(() => verifyWikiBlob(file, bytes));
  assert.throws(() => verifyWikiBlob(file, Buffer.from('public changed!')), /mismatch/);
  assert.throws(() => verifyWikiBlob({ ...file, size: bytes.length + 1 }, bytes), /mismatch/);
});

function packageFixture() {
  const articles = Array.from({ length: 236 }, (_, i) => ({ id: `en-${i + 1}` }));
  const buffers = new Map<string, Buffer>();
  const set = (name: string, value: unknown) => buffers.set(name, Buffer.from(JSON.stringify(value)));
  set('export-manifest.json', { type: 'public_knowledge_center_preview', unique_source_pages: 236,
    private_operations_included: false, customer_send_enabled: false });
  set('data/library.json', { articles, publication_enabled: false, source_status: 'unreviewed' });
  set('data/search-index.json', articles);
  articles.forEach(({ id }) => set(`data/articles/${id}.json`, { id, body_html: '<p>Public source</p>', source_url: `https://wiki.1laser.com/${id}` }));
  return { buffers, set, articles };
}

test('Wiki export preserves all article/search coverage without private operation fields or approval', () => {
  assert.doesNotThrow(() => validateWikiPackage(packageFixture().buffers));
  for (const mutate of [
    (p: ReturnType<typeof packageFixture>) => { p.buffers.delete('data/articles/en-1.json'); },
    (p: ReturnType<typeof packageFixture>) => { p.set('data/search-index.json', p.articles.slice(1)); },
    (p: ReturnType<typeof packageFixture>) => { p.set('data/articles/en-1.json', { id: 'en-1', body_html: '', source_url: 'https://wiki.1laser.com/en-1', privateReview: 'never publish' }); },
    (p: ReturnType<typeof packageFixture>) => { p.set('export-manifest.json', { type: 'public_knowledge_center_preview', unique_source_pages: 236, private_operations_included: true, customer_send_enabled: false }); },
    (p: ReturnType<typeof packageFixture>) => { p.set('data/library.json', { articles: p.articles, publication_enabled: true, source_status: 'unreviewed' }); },
  ]) { const candidate = packageFixture(); mutate(candidate); assert.throws(() => validateWikiPackage(candidate.buffers)); }
});

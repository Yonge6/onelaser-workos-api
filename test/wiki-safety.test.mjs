import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hardenWikiApp } from '../tools/wiki-safety.mjs';

// Self-contained renderer fixture. The vulnerable catalog declaration is the
// exact line from public support-center d82691e, with its hash/query routing and
// the affected link interpolation retained. No network, DOM or provider is used.
const source = String.raw`(async () => {
  const library={families:[{id:'x-series',name:'X Series'},{id:'hydra-series',name:'Hydra Series'}]};
  const calls=[];
  let output='',heading='';
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function catalog(route,params){
    const fid=route.startsWith('family/')?decodeURIComponent(route.slice(7)):params.get('family')||'',isDownloads=route==='downloads',q=params.get('q')||'',top=isDownloads?'downloads':params.get('topic')||'';
    const f=library.families.find(f=>f.id===fid);
    heading=isDownloads?'Software, firmware & manuals.':f?f.name:'Find your next step.';
    const request=new URLSearchParams({q,family:fid,topic:top});
    calls.push(Object.fromEntries(request));
    output='<h1>'+heading+'</h1><input value="'+esc(q)+'">';
    for(const topic of ['', 'guides', 'downloads', 'troubleshooting', 'getting-started']){
      output+='<a href="/#/'+(fid?'family/'+fid:'search')+'?'+new URLSearchParams({q,topic})+'">topic</a>';
    }
  }
  const hash=location.hash.slice(1).replace(/^\//,''),[part]=hash.split('#'),[path,query='']=part.split('?'),params=new URLSearchParams(query);
  await catalog(path,params);
  window.wikiProbe={html:output,heading,request:calls[0]};
})();`;

async function render(code, hash) {
  const context = { location: { hash }, URLSearchParams, window: {} };
  await vm.runInNewContext(code, context, { timeout: 1000 });
  return JSON.parse(JSON.stringify(context.window.wikiProbe));
}

const maliciousFamily = '"><img src=x onerror="parent.document.body.dataset.wikiProbe=1">';

test('pinned catalog patch changes one exact line and refuses drift or double application', () => {
  const hardened = hardenWikiApp(source);
  const before = source.split('\n'), after = hardened.split('\n');
  assert.equal(before.length, after.length);
  const changed = before.flatMap((line, index) => line === after[index] ? [] : [index]);
  assert.equal(changed.length, 1);
  assert.match(after[changed[0]], /const requestedFid=/);
  const originalLine = before[changed[0]];
  assert.throws(() => hardenWikiApp(source.replace(originalLine, originalLine.trim())), /exactly once/);
  assert.throws(() => hardenWikiApp(source + '\n' + originalLine), /exactly once/);
  assert.throws(() => hardenWikiApp(hardened), /exactly once/);
  assert.throws(() => hardenWikiApp(''), /exactly once/);
  assert.throws(() => hardenWikiApp(undefined), TypeError);
});

test('malicious family hash cannot introduce HTML or parent-access event handlers', async () => {
  const hash = '#/family/' + encodeURIComponent(maliciousFamily) + '?q=firmware';
  const original = await render(source, hash);
  assert.equal(original.html.split('<img src=x onerror=').length - 1, 5);
  const hardened = await render(hardenWikiApp(source), hash);
  assert.equal(hardened.html.includes('<img'), false);
  assert.equal(hardened.html.includes('onerror'), false);
  assert.equal(hardened.html.includes('parent.document'), false);
  assert.deepEqual(hardened.request, { q: 'firmware', family: '', topic: '' });
});

test('malicious family query is filtered while the search text is preserved', async () => {
  const hash = '#/search?' + new URLSearchParams({ family: maliciousFamily, q: 'air assist' });
  assert.equal((await render(source, hash)).html.includes('<img src=x'), true);
  const hardened = await render(hardenWikiApp(source), hash);
  assert.equal(hardened.html.includes('<img'), false);
  assert.deepEqual(hardened.request, { q: 'air assist', family: '', topic: '' });
});

test('known family hash preserves its product page, topic and search', async () => {
  const hash = '#/family/x-series?q=firmware&topic=guides';
  const hardened = await render(hardenWikiApp(source), hash);
  assert.deepEqual(hardened, await render(source, hash));
  assert.equal(hardened.heading, 'X Series');
  assert.deepEqual(hardened.request, { q: 'firmware', family: 'x-series', topic: 'guides' });
});

test('known family query and downloads keep the original behavior', async () => {
  for (const hash of ['#/search?family=hydra-series&q=autofocus', '#/downloads?q=firmware']) {
    assert.deepEqual(await render(hardenWikiApp(source), hash), await render(source, hash));
  }
  const downloads = await render(hardenWikiApp(source), '#/downloads?q=firmware');
  assert.equal(downloads.request.topic, 'downloads');
});

test('plain search remains unchanged and unknown/prototype family values select all products', async () => {
  const hash = '#/search?' + new URLSearchParams({ q: 'air & cooling "settings"' });
  assert.deepEqual(await render(hardenWikiApp(source), hash), await render(source, hash));
  for (const family of ['unknown-product', 'constructor', '__proto__']) {
    const rendered = await render(hardenWikiApp(source), '#/search?' + new URLSearchParams({ family, q: 'laser' }));
    assert.deepEqual(rendered.request, { q: 'laser', family: '', topic: '' });
    assert.equal(rendered.heading, 'Find your next step.');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPinnedFrontend, createGateway, acquireProfile } from '../tools/mac-integration.js';

async function fixture(t:any){
  const base=resolve('.runtime');await mkdir(base,{recursive:true});const root=await mkdtemp(resolve(base,'mac-gateway-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(resolve(root,'dist'));
  await writeFile(resolve(root,'dist/index.html'),'<!doctype html><title>Fixture</title>');
  await writeFile(resolve(root,'dist/live-app.js'),'window.fixture=true;');
  await writeFile(resolve(root,'dist/runtime-config.js'),"window.WORKOS_CONFIG={mode:'demo'};");
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('add','dist');git('-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','fixture');
  return {root,git,revision:git('rev-parse','HEAD')};
}
async function listen(t:any,server:Server){
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const a=server.address();assert(a&&typeof a!=='string');return {port:a.port,url:`http://127.0.0.1:${a.port}`};
}
test('Mac profile publishes only pinned frontend bytes and overlays live configuration',async t=>{
  const f=await fixture(t);await writeFile(resolve(f.root,'dist/local.env'),'PRIVATE_FIXTURE_VALUE');
  const assets=await loadPinnedFrontend(f.root,f.revision);assert(!assets.has('/local.env'));assert.match(assets.get('/runtime-config.js')!.body.toString(),/mode:'live'/);assert(!assets.get('/runtime-config.js')!.body.includes('syntheticHarness'));
  await writeFile(resolve(f.root,'dist/live-app.js'),'window.modified=true;');await assert.rejects(loadPinnedFrontend(f.root,f.revision),/differs from pinned/);
});
test('Mac gateway keeps cookies and API paths while refusing private static paths and oversized bodies',async t=>{
  const f=await fixture(t),assets=await loadPinnedFrontend(f.root,f.revision);
  const api=await listen(t,createServer((req,res)=>{res.writeHead(401,{'Content-Type':'application/json','Set-Cookie':'fixture=opaque; HttpOnly; SameSite=Lax'});res.end(JSON.stringify({path:req.url,cookie:req.headers.cookie,origin:req.headers.origin}));}));
  const edge=await listen(t,createGateway(api.port,assets));
  const response=await fetch(edge.url+'/api/me?view=x',{headers:{cookie:'fixture=input',origin:'https://fixture.example'}});assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),'fixture=opaque; HttpOnly; SameSite=Lax');assert.deepEqual(await response.json(),{path:'/me?view=x',cookie:'fixture=input',origin:'https://fixture.example'});
  assert.match(response.headers.get('content-security-policy')!,/form-action 'self' https:\/\/login.dingtalk.com/);
  assert.equal((await fetch(edge.url+'/.well-known/oauth-protected-resource')).status,401);
  for(const path of ['/local.env','/.runtime/state.json','/%2e%2e/local.env','/%252e%252e/local.env'])assert.equal((await fetch(edge.url+path)).status,404);
  assert.equal((await fetch(edge.url+'/live-app.js',{method:'POST'})).status,405);
  const head=await fetch(edge.url+'/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(edge.url+'/api/token',{method:'POST',body:'x'.repeat(128*1024+1)})).status,413);
});
test('Mac pinned frontend loader refuses Git-tracked symlinks',async t=>{
  const f=await fixture(t);await writeFile(resolve(f.root,'private.txt'),'PRIVATE_FIXTURE_VALUE');await symlink('../private.txt',resolve(f.root,'dist/exposed.txt'));
  f.git('add','dist/exposed.txt');f.git('-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-qm','symlink fixture');
  await assert.rejects(loadPinnedFrontend(f.root,f.git('rev-parse','HEAD')),/Unexpected frontend Git entry/);
});
test('Mac profile refuses a second process before opening its persistent database',async t=>{
  const f=await fixture(t);const release=await acquireProfile(f.root);await assert.rejects(acquireProfile(f.root),/already in use/);await release();const again=await acquireProfile(f.root);await again();
});

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, realpath, stat, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { buildApp } from '../src/app.js';
import { createDatabase, schema } from '../src/db.js';
import { integrationOptionsFromEnv } from '../src/integrations/routes.js';

const volume='/Volumes/DevSSD';
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.otf':'font/otf','.json':'application/json; charset=utf-8'};
const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://login.dingtalk.com";
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
type Asset={body:Buffer;contentType:string};

export async function acquireProfile(profile:string){
  const lock=resolve(profile,'run.lock'),nonce=randomUUID();
  try{const file=await open(lock,'wx',0o600);try{await file.writeFile(JSON.stringify({pid:process.pid,nonce}));}finally{await file.close();}}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Local profile is already in use; verify its owner before clearing a stale lock');throw error;}
  return async()=>{const owner=JSON.parse(await readFile(lock,'utf8'));if(owner.pid===process.pid&&owner.nonce===nonce)await unlink(lock);};
}

export async function loadPinnedFrontend(root:string,revision:string):Promise<Map<string,Asset>>{
  if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Invalid pinned frontend revision');
  const tree=execFileSync('git',['ls-tree','-r',revision,'--','dist'],{cwd:root,encoding:'utf8'}).trim().split('\n');
  const assets=new Map<string,Asset>();let total=0;
  for(const line of tree){
    const match=/^100644 blob ([a-f0-9]{40})\t(dist\/[a-zA-Z0-9_./-]+)$/.exec(line);
    if(!match)throw new Error('Unexpected frontend Git entry');
    const relative=match[2].slice(5);if(relative==='.nojekyll')continue;
    if(relative.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new Error('Unexpected frontend path');
    const body=await readFile(resolve(root,match[2]));total+=body.length;
    if(body.length>2*1024*1024||total>5*1024*1024||assets.size>=100)throw new Error('Frontend size limit exceeded');
    if(createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')!==match[1])throw new Error('Frontend asset differs from pinned revision');
    assets.set('/'+relative,{body,contentType:mime[extname(relative)]||'application/octet-stream'});
  }
  if(!assets.has('/index.html')||!assets.has('/live-app.js'))throw new Error('Live frontend is missing');
  assets.set('/runtime-config.js',{body:Buffer.from("'use strict';window.WORKOS_CONFIG=Object.freeze({mode:'live',apiBase:'/api'});\n"),contentType:mime['.js']});
  assets.set('/build-info.json',{body:Buffer.from(JSON.stringify({frontendCommit:revision,profile:'mac-integration'})+'\n'),contentType:mime['.json']});
  return assets;
}

function reply(res:ServerResponse,status:number,body:string){if(res.headersSent){res.destroy();return;}res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:body}));}
function proxy(req:IncomingMessage,res:ServerResponse,apiPort:number,path:string){
  if(Number(req.headers['content-length']||0)>128*1024){reply(res,413,'BODY_TOO_LARGE');req.resume();return;}
  const headers={...req.headers};for(const key of hopHeaders)delete headers[key];delete headers.host;
  const upstream=request({host:'127.0.0.1',port:apiPort,path,method:req.method,headers,timeout:60000},response=>{
    const responseHeaders={...response.headers};for(const key of hopHeaders)delete responseHeaders[key];
    res.writeHead(response.statusCode||502,responseHeaders);response.on('error',()=>res.destroy());response.pipe(res);
  });
  let size=0;
  req.on('data',chunk=>{size+=chunk.length;if(size>128*1024&&!res.writableEnded){upstream.destroy();reply(res,413,'BODY_TOO_LARGE');req.resume();}});
  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.writableEnded)reply(res,502,'LOCAL_API_UNAVAILABLE');});
  req.on('aborted',()=>upstream.destroy());req.on('error',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
}
export function createGateway(apiPort:number,assets:Map<string,Asset>){
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',csp);
    try{
      if(!req.url?.startsWith('/')||req.url.startsWith('//')){reply(res,400,'INVALID_PATH');return;}
      const url=new URL(req.url,'http://127.0.0.1');const path=decodeURIComponent(url.pathname);
      if(path==='/api'){res.writeHead(308,{Location:'/api/'});res.end();return;}
      if(path.startsWith('/api/')){proxy(req,res,apiPort,path.slice(4)+url.search);return;}
      if(path.startsWith('/.well-known/')){proxy(req,res,apiPort,path+url.search);return;}
      if(path==='/healthz'){proxy(req,res,apiPort,'/health');return;}
      if(!['GET','HEAD'].includes(req.method||'')){res.setHeader('Allow','GET, HEAD');reply(res,405,'METHOD_NOT_ALLOWED');return;}
      const asset=assets.get(path==='/'?'/index.html':path);if(!asset){reply(res,404,'NOT_FOUND');return;}
      res.writeHead(200,{'Content-Type':asset.contentType});res.end(req.method==='HEAD'?undefined:asset.body);
    }catch{reply(res,400,'INVALID_PATH');}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;server.keepAliveTimeout=5000;server.maxHeadersCount=100;
  return server;
}

async function main(){
  if(process.platform!=='darwin')throw new Error('This launcher is for Mac integration only');
  const volumeUuid=process.env.WORKOS_DEVSSD_VOLUME_UUID?.trim().toUpperCase();
  if(!volumeUuid||! /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/.test(volumeUuid))throw new Error('Set the verified DevSSD volume UUID');
  const info=execFileSync('/usr/sbin/diskutil',['info','-plist',volume],{encoding:'utf8'});
  if(!new RegExp(`<key>VolumeUUID</key>\\s*<string>${volumeUuid}</string>`).test(info)||!info.includes('<string>/Volumes/DevSSD</string>'))throw new Error('Required DevSSD volume is not mounted');
  const root=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
  if(!root.startsWith(volume+'/'))throw new Error('The checkout must reside on DevSSD');
  const profile=resolve(root,'.runtime/mac-integration');await mkdir(profile,{recursive:true,mode:0o700});await chmod(profile,0o700);
  const envFile=resolve(profile,'local.env');
  const settings:NodeJS.ProcessEnv={};
  try{const s=await stat(envFile);if(s.mode&0o077)throw new Error('local.env must have mode 0600');Object.assign(settings,parseEnv(await readFile(envFile,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const port=Number(settings.WORKOS_LOCAL_PORT||18767);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port');
  const publicUrl=settings.APP_PUBLIC_URL||`http://127.0.0.1:${port}`;const secure=new URL(publicUrl).protocol==='https:';
  // Only this profile's file supplies integration credentials, never another workflow's ambient environment.
  const env={...settings,NODE_ENV:secure?'production':'development',ALLOW_DEV_LOGIN:'false',SEED_DEMO:'false',AI_REVIEW_MODE:'bot',GROK_BOT_MCP_AUTH_MODE:'oauth',WORKOS_TEAM_MODE:'company',FRONTEND_CONNECTED:'true',DINGTALK_NOTIFICATIONS_ENABLED:'false',APP_PUBLIC_URL:secure?publicUrl:undefined};
  const revision=(await readFile(resolve(root,'deploy/frontend-revision.txt'),'utf8')).trim();
  const assets=await loadPinnedFrontend(resolve(root,'../onelaser-workos'),revision);
  const release=await acquireProfile(profile);let db:Awaited<ReturnType<typeof createDatabase>>|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined,gateway:ReturnType<typeof createGateway>|undefined;
  try{
    db=await createDatabase({dataDir:resolve(profile,'data')});await db.exec(schema);
    app=await buildApp({db,environment:'local-integration',allowDevLogin:false,closeDatabase:false,integrations:{...integrationOptionsFromEnv(env),secureCookies:secure}});
    await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Local API failed to listen');
    gateway=createGateway(address.port,assets);await new Promise<void>((done,fail)=>{gateway!.once('error',fail);gateway!.listen(port,'127.0.0.1',done);});
    const state={pid:process.pid,localUrl:`http://127.0.0.1:${port}`,publicUrl:secure?publicUrl:null,profile:'mac-integration',database:'pglite',dataDir:resolve(profile,'data'),frontendCommit:revision,startedAt:new Date().toISOString(),demo:false,devLogin:false,notifications:false};
    await writeFile(resolve(profile,'state.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600});
    console.log(`Work OS local integration: ${state.localUrl}; persistent PGlite on DevSSD; no demo identities or development login.`);
    await new Promise<void>(done=>{const close=()=>done();process.once('SIGTERM',close);process.once('SIGINT',close);});
  }finally{
    if(gateway){gateway.closeAllConnections();if(gateway.listening)await new Promise<void>(done=>gateway!.close(()=>done()));}
    await app?.close();await db?.close();await release();
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Mac integration startup failed. Check DevSSD, the pinned frontend, local.env permissions and port availability.');process.exitCode=1;});

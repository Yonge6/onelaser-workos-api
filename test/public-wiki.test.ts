import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo, type Database } from '../src/db.js';
import { retrievePublicArticles, publicWikiOptionsFromEnv, type PublicArticle } from '../src/public-wiki.js';

let db:Database,app:Awaited<ReturnType<typeof buildApp>>,admin:Database|undefined,namespace:string|undefined,staffToken:string,employeeToken:string;
const secret=randomBytes(40).toString('hex'),articles:PublicArticle[]=[{id:'en-1',title:'Hydra installation guide',family:'hydra-series',body_text:'Follow the complete Hydra installation guide. Confirm your exact machine model before selecting a guide.'},{id:'en-2',title:'X Series firmware download',family:'x-series',body_text:'The firmware download guide describes the supported models and versions. Do not choose a file before confirming the model.'}];
let calls=0,invalidModel=false;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});namespace='public_wiki_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${namespace}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${namespace}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);await seedDemo(db);
 app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,support:{orgId:'demo',userIds:['m1'],reviewerIds:['m1']},publicWiki:{orgId:'demo',publicUrl:'https://craftos.app',articles,model:{apiKey:'synthetic-only',id:'synthetic',dailyLimit:2},fetcher:(async(_url:any,init:any)=>{calls++;const input=JSON.parse(init.body);assert.equal(input.messages[0].content.includes('No tools'),true);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({claims:[{text:'Open the Hydra installation guide and confirm your machine model.',articleId:'en-1',quote:invalidModel?'This quotation does not exist':'Follow the complete Hydra installation guide.'}]})}}]}),{status:200});}) as typeof fetch}});
 staffToken=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId:'m1',secret}})).json().accessToken;employeeToken=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId:'m2',secret}})).json().accessToken;
});
after(async()=>{await app?.close();if(admin&&namespace){await admin.exec(`DROP SCHEMA ${namespace} CASCADE`);await admin.close();}});
const post=(url:string,payload:any,token?:string)=>app.inject({method:'POST',url,payload,headers:token?{authorization:'Bearer '+token}:{}});
const get=(url:string,token?:string)=>app.inject({url,headers:token?{authorization:'Bearer '+token}:{}});
const start=async()=>{const r=await post('/public/wiki-assistant/sessions',{});assert.equal(r.statusCode,201,r.body);const {sessionId,sessionToken}=r.json();return {sessionId,sessionToken};};
const message=(s:any,extra:any={})=>post('/public/wiki-assistant/messages',{...s,requestId:randomUUID(),message:'Hydra installation guide',context:{},language:'en',...extra});
test('public routes remain narrow and employee data requires real authentication',async()=>{
 assert.equal((await get('/public/wiki-assistant/config')).statusCode,200);
 for(const url of ['/support/tickets','/support/public-inbox','/support/knowledge-candidates','/tasks','/me','/public/wiki-assistant/unknown'])assert.equal((await get(url)).statusCode,401,url);
 const config=(await get('/public/wiki-assistant/config')).json();assert.equal(config.scope,'public_knowledge_only');assert.equal(JSON.stringify(config).includes('synthetic-only'),false);
});
test('sessions are isolated, token hashes only, strict input and origin checked',async()=>{
 const s=await start(),other=await start();const row=(await db.query('SELECT * FROM public_wiki_sessions WHERE id=$1',[s.sessionId])).rows[0];assert.notEqual(row.token_hash,s.sessionToken);
 assert.equal((await message({...s,sessionToken:other.sessionToken})).statusCode,401);
 assert.equal((await message(s,{employeeId:'m1'})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/public/wiki-assistant/sessions',payload:{},headers:{origin:'https://untrusted.invalid'}})).statusCode,403);
 await db.query("UPDATE public_wiki_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",[s.sessionId]);assert.equal((await message(s)).statusCode,401);
});
test('unapproved content produces honest source recommendations without a model call',async()=>{
 const s=await start(),r=await message(s);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'sources_only');assert.equal(r.json().modelUsed,false);assert.equal(r.json().sources[0].articleId,'en-1');assert.equal(r.json().sources[0].url,'#knowledge/article/en-1');assert.equal(calls,0);
});
test('message retries reuse persisted response and reject changed input',async()=>{
 const s=await start(),requestId=randomUUID(),a=await message(s,{requestId}),b=await message(s,{requestId});assert.equal(a.json().messageId,b.json().messageId);assert.equal((await message(s,{requestId,message:'Different question'})).statusCode,409);
});
test('unsafe and unsupported requests use human path without inventing advice',async()=>{
 const s=await start();for(const text of ['There is smoke and fire','refund compensation','somethingentirelynotincorpus']){const r=await message(s,{message:text});assert.equal(r.json().status,'needs_human');assert.equal(r.json().modelUsed,false);}assert.equal(calls,0);
});
test('feedback and customer-confirmed handoff are private and preserve request identity',async()=>{
 const s=await start(),other=await start(),r=(await message(s)).json();
 assert.equal((await post('/public/wiki-assistant/feedback',{...other,messageId:r.messageId,helpful:false})).statusCode,404);
 assert.equal((await post('/public/wiki-assistant/feedback',{...s,messageId:r.messageId,helpful:false,comment:'Synthetic test: guide is unclear'})).json().recorded,true);
 const input={...s,requestId:randomUUID(),contactEmail:'synthetic@example.invalid',summary:'Synthetic handoff request only',consent:true};
 const a=await post('/public/wiki-assistant/handoffs',input),b=await post('/public/wiki-assistant/handoffs',input);assert.equal(a.statusCode,200,a.body);assert.equal(a.json().requestId,b.json().requestId);assert.match(a.json().reference,/^OL-/);assert.equal('ticketId' in a.json(),false);
 assert.equal((await post('/public/wiki-assistant/handoffs',{...input,summary:'Changed synthetic request'})).statusCode,409);
 assert.equal((await post('/public/wiki-assistant/handoffs',{...input,requestId:randomUUID(),consent:false})).statusCode,400);
 assert.equal((await get('/support/public-inbox',employeeToken)).statusCode,403);
 const inbox=(await get('/support/public-inbox',staffToken)).json();assert.equal(inbox.items.some((x:any)=>x.kind==='handoff'&&x.contactEmail==='synthetic@example.invalid'),true);
});
test('approved exact public sources permit cited model output; revoked or changed sources do not',async()=>{
 const rows=(await get('/support/public-knowledge',staffToken)).json().items,item=rows.find((x:any)=>x.id==='en-1');
 assert.equal((await post('/support/public-knowledge/en-1/reviews',{contentHash:item.contentHash,decision:'approved',note:'Synthetic approved source',humanConfirmation:true},employeeToken)).statusCode,403);
 assert.equal((await post('/support/public-knowledge/en-1/reviews',{contentHash:'0'.repeat(64),decision:'approved',note:'Synthetic changed source',humanConfirmation:true},staffToken)).statusCode,409);
 assert.equal((await post('/support/public-knowledge/en-1/reviews',{contentHash:item.contentHash,decision:'approved',note:'Synthetic approved source',humanConfirmation:true},staffToken)).statusCode,200);
 const r=(await message(await start())).json();assert.equal(r.status,'answered');assert.equal(r.modelUsed,true);assert.equal(calls,1);
 invalidModel=true;const invalid=(await message(await start())).json();assert.equal(invalid.status,'sources_only');assert.equal(invalid.modelUsed,false);assert.equal(calls,2);
 // The model budget is persistent and counts attempts, including invalid answers.
 invalidModel=false;assert.equal((await message(await start())).json().modelUsed,false);assert.equal(calls,2);
 await post('/support/public-knowledge/en-1/reviews',{contentHash:item.contentHash,decision:'changes_requested',note:'Synthetic source revoked',humanConfirmation:true},staffToken);
 assert.equal((await message(await start())).json().modelUsed,false);
});
test('knowledge candidates require exact source-bound review, never publish automatically',async()=>{
 const request={requestId:randomUUID(),title:'Synthetic knowledge candidate',body:'Synthetic useful content for human review.'};
 const a=await post('/support/knowledge-candidates',request,staffToken),b=await post('/support/knowledge-candidates',request,staffToken);assert.equal(a.statusCode,200,a.body);assert.equal(a.json().id,b.json().id);
 const c=(await get('/support/knowledge-candidates',staffToken)).json().items.find((x:any)=>x.id===a.json().id);assert.equal(c.status,'pending');
 assert.equal((await post('/support/knowledge-candidates/'+c.id+'/reviews',{contentHash:'0'.repeat(64),decision:'approved',note:'Synthetic review',humanConfirmation:true},staffToken)).statusCode,409);
 const review=await post('/support/knowledge-candidates/'+c.id+'/reviews',{contentHash:c.contentHash,decision:'approved',note:'Synthetic review',humanConfirmation:true},staffToken);assert.equal(review.json().publiclyPublished,false);
});
test('search has bilingual hints and model is disabled without explicit complete configuration',()=>{
 assert.equal(retrievePublicArticles(articles,'固件 下载')[0].id,'en-2');assert.equal(publicWikiOptionsFromEnv({AI_PROVIDER_API_KEY:'do-not-inherit',AI_MODEL_ID:'private-model'}).model,undefined);
 assert.equal(publicWikiOptionsFromEnv({PUBLIC_WIKI_MODEL_ENABLED:'true',PUBLIC_WIKI_API_KEY:'synthetic',PUBLIC_WIKI_MODEL_ID:'synthetic'}).model?.dailyLimit,50);
});

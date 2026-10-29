import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import type {PublicArticle} from '../src/public-wiki.js';

let db:Database,admin:Database|undefined,namespace:string|undefined,app:Awaited<ReturnType<typeof buildApp>>,otherApp:Awaited<ReturnType<typeof buildApp>>,staffToken:string,otherToken:string;
const secret=randomBytes(40).toString('hex');
const quote='Follow the complete Hydra installation guide.';
const articles:PublicArticle[]=[{id:'en-1',title:'Hydra installation guide',family:'hydra-series',body_text:quote+' Confirm your exact machine model before selecting a guide.'},{id:'en-2',title:'X Series installation and firmware',family:'x-series',body_text:'Read the X Series installation and firmware guide before choosing a download.'}];
let provider:((input:any)=>Promise<Response>)|undefined,providerCalls=0;
const modelResponse=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({claims:[{text:'A deliberately unsupported model paraphrase that must never be displayed.',articleId:'en-1',quote}]})}}]}),{status:200});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});namespace='public_wiki_security_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${namespace}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${namespace}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);await seedDemo(db);await db.query("INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('foreign-manager','foreign','foreign','Synthetic foreign manager','manager')");
 const fetcher=(async(_url:any,init:any)=>{providerCalls++;const input=JSON.parse(init.body);return provider?provider(input):modelResponse();}) as typeof fetch;
 app=await buildApp({db,closeDatabase:false,allowDevLogin:true,devLoginSecret:secret,support:{orgId:'demo',userIds:['m1'],reviewerIds:['m1']},publicWiki:{orgId:'demo',publicUrl:'https://craftos.app',articles,model:{apiKey:'synthetic-only',id:'synthetic',dailyLimit:100},fetcher}});
 otherApp=await buildApp({db,closeDatabase:false,allowDevLogin:true,devLoginSecret:secret,support:{orgId:'foreign',userIds:['foreign-manager'],reviewerIds:['foreign-manager']},publicWiki:{orgId:'foreign',publicUrl:'https://craftos.app',articles}});
 staffToken=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId:'m1',secret}})).json().accessToken;otherToken=(await otherApp.inject({method:'POST',url:'/auth/dev-login',payload:{userId:'foreign-manager',secret}})).json().accessToken;
});
after(async()=>{await app?.close();await otherApp?.close();await db?.close();if(admin&&namespace){await admin.exec(`DROP SCHEMA ${namespace} CASCADE`);await admin.close();}});
const post=(target:typeof app,url:string,payload:any,token?:string)=>target.inject({method:'POST',url,payload,headers:token?{authorization:'Bearer '+token}:{}});
const get=(target:typeof app,url:string,token?:string)=>target.inject({url,headers:token?{authorization:'Bearer '+token}:{}});
const start=async(target=app)=>{const r=await post(target,'/public/wiki-assistant/sessions',{});assert.equal(r.statusCode,201,r.body);const {sessionId,sessionToken}=r.json();return {sessionId,sessionToken};};
const message=(s:any,extra:any={},target=app)=>post(target,'/public/wiki-assistant/messages',{...s,requestId:randomUUID(),message:'Hydra installation',context:{},language:'en',...extra});
const approve=async(value:boolean)=>{const item=(await get(app,'/support/public-knowledge',staffToken)).json().items.find((a:any)=>a.id==='en-1');const r=await post(app,'/support/public-knowledge/en-1/reviews',{contentHash:item.contentHash,decision:value?'approved':'changes_requested',note:'Synthetic security review',humanConfirmation:true},staffToken);assert.equal(r.statusCode,200,r.body);return item;};

test('public sessions and private visitor inbox are bound to the configured organization',async()=>{
 const a=await start(),b=await start(otherApp);
 assert.equal((await message(a,{},otherApp)).statusCode,401);assert.equal((await message(b)).statusCode,401);
 const pa={...a,requestId:randomUUID(),contactEmail:'demo-only@example.invalid',summary:'Synthetic request for demo organization',consent:true};const pb={...b,requestId:randomUUID(),contactEmail:'foreign-only@example.invalid',summary:'Synthetic request for foreign organization',consent:true};
 assert.equal((await post(app,'/public/wiki-assistant/handoffs',pa)).statusCode,200);assert.equal((await post(otherApp,'/public/wiki-assistant/handoffs',pb)).statusCode,200);
 const own=(await get(app,'/support/public-inbox',staffToken)).json().items,foreign=(await get(otherApp,'/support/public-inbox',otherToken)).json().items;
 assert.equal(own.some((r:any)=>r.contactEmail==='demo-only@example.invalid'),true);assert.equal(own.some((r:any)=>r.contactEmail==='foreign-only@example.invalid'),false);
 assert.equal(foreign.some((r:any)=>r.contactEmail==='foreign-only@example.invalid'),true);assert.equal(foreign.some((r:any)=>r.contactEmail==='demo-only@example.invalid'),false);
 assert.equal((await get(app,'/support/public-inbox',otherToken)).statusCode,403);
});
test('public model output displays verified source quotations, never arbitrary paraphrase',async()=>{
 await approve(true);const r=await message(await start());assert.equal(r.statusCode,200,r.body);assert.equal(r.json().modelUsed,true);assert.equal(r.json().answer,quote);assert.equal(r.json().sources[0].excerpt,quote);assert.equal(r.body.includes('deliberately unsupported'),false);
});
test('source revoked during a provider request cannot be emitted as an approved model answer',async()=>{
 await approve(true);const pending=deferred<Response>(),entered=deferred<void>();provider=async()=>{entered.resolve();return pending.promise;};
 try{const flight=message(await start()).then(r=>r);await entered.promise;await approve(false);pending.resolve(modelResponse());const r=await flight;assert.equal(r.statusCode,200,r.body);assert.equal(r.json().modelUsed,false);assert.equal(r.json().status,'sources_only');assert.notEqual(r.json().answer,quote);}finally{provider=undefined;}
});
test('cached reply retry rechecks source approval after revocation',async()=>{
 await approve(true);const s=await start(),requestId=randomUUID(),first=await message(s,{requestId});assert.equal(first.json().modelUsed,true);await approve(false);const before=providerCalls,replayed=await message(s,{requestId});assert.equal(replayed.json().messageId,first.json().messageId);assert.equal(replayed.json().modelUsed,false);assert.notEqual(replayed.json().answer,quote);assert.equal(providerCalls,before);
});
test('expired retention purges messages, feedback and handoff contact information',async()=>{
 const s=await start(),r=(await message(s)).json();await post(app,'/public/wiki-assistant/feedback',{...s,messageId:r.messageId,helpful:false,comment:'Synthetic feedback'});await post(app,'/public/wiki-assistant/handoffs',{...s,requestId:randomUUID(),contactEmail:'expiry@example.invalid',summary:'Synthetic contact information to purge',consent:true});
 await db.query("UPDATE public_wiki_sessions SET created_at=now()-interval '31 days' WHERE id=$1",[s.sessionId]);await start();
 for(const table of ['public_wiki_sessions','public_wiki_messages','public_wiki_feedback','public_wiki_handoffs']){const key=table==='public_wiki_sessions'?'id':'session_id';assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key}=$1`,[s.sessionId])).rows[0].n,0,table);}
 assert.equal((await message(s)).statusCode,401);
});
test('full valid 6000-character Chinese handoff fits the documented input limit',async()=>{
 const s=await start(),summary='安装问题'.repeat(1500);assert.equal(summary.length,6000);assert.ok(Buffer.byteLength(summary)>12000);const r=await post(app,'/public/wiki-assistant/handoffs',{...s,requestId:randomUUID(),contactEmail:'chinese@example.invalid',summary,consent:true});assert.equal(r.statusCode,200,r.body);
});
test('follow-up model context overrides the page family and persists into the next question',async()=>{
 const s=await start();await message(s,{message:'How do I install the software?',context:{articleId:'en-2',family:'x-series'}});const second=await message(s,{message:'Actually I have a Hydra 7',context:{}});assert.equal(second.json().sources.every((a:any)=>a.articleId==='en-1'),true);
 const third=await message(s,{message:'What is the next installation step?',context:{}});assert.ok(third.json().sources.length);assert.equal(third.json().sources.every((a:any)=>a.articleId==='en-1'),true);
 const latest=(await db.query('SELECT input_context FROM public_wiki_messages WHERE id=$1',[third.json().messageId])).rows[0];assert.equal(latest.input_context.family,'hydra-series');
});
test('safety incidents remain on the human path across a follow-up question',async()=>{
 const s=await start(),before=providerCalls;const first=await message(s,{message:'My Hydra is smoking'});assert.equal(first.json().status,'needs_human');const followup=await message(s,{message:'How do I turn on the machine again?'});assert.equal(followup.json().status,'needs_human');assert.equal(followup.json().modelUsed,false);assert.equal(providerCalls,before);
 for(const question of ['How do I align the laser mirrors?','How to disable the interlock?']){const r=await message(await start(),{message:question});assert.equal(r.json().status,'needs_human');assert.equal(r.json().modelUsed,false);}
});

test('approving an article for one organization does not approve it for another',async()=>{
 await approve(true);const own=(await get(app,'/support/public-knowledge',staffToken)).json().items.find((a:any)=>a.id==='en-1'),foreign=(await get(otherApp,'/support/public-knowledge',otherToken)).json().items.find((a:any)=>a.id==='en-1');
 assert.equal(own.eligible,true);assert.equal(foreign.eligible,false);
});

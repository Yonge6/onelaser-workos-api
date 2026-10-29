import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
let db:Database,admin:Database|undefined,ns:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const secret=randomBytes(32).toString('hex'),token=randomBytes(48).toString('hex'),tokens:Record<string,string>={};
const snapshot=(at=Date.now())=>({version:1,observedAt:new Date(at).toISOString(),runtime:'mac-pilot',pollerLastSuccess:null,watchLastSuccess:null,dispatchPaused:true,articles:[{id:'en-1',title:'Synthetic knowledge',family:'general',body:'<script>fake script</script> Text only',sourceUrl:'https://wiki.1laser.com/test',sourceVersion:'v1'}],answers:[{id:'SA-001',title:'Acknowledgement',family:'general',body:'Synthetic candidate',note:'Check source',sources:[]}],tickets:[{id:'ticket-1',number:'TEST-1',subject:'Synthetic ticket',status:'Open',revision:1,reasons:[],observedAt:new Date(at).toISOString(),responseDueAt:null,resolutionDueAt:null}],drafts:[{id:'draft-1',ticketId:'ticket-1',revision:1,version:1,status:'pending',body:'Synthetic draft only',sources:[],createdAt:new Date(at).toISOString()}],jobs:{pending:0,attention:0},sla:{status:'draft',body:'Pending review'}});
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});ns='support_test_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${ns}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${ns}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);await seedDemo(db);const org=(await db.query('SELECT org_id FROM users WHERE id=$1',['m1'])).rows[0].org_id;
 app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,support:{orgId:org,ingestToken:token,userIds:['m1'],reviewerIds:['m1']},integrations:{executiveUserIds:['m4']}});
 for(const userId of ['m1','m2','m4'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;
});
after(async()=>{await app?.close();if(admin&&ns){await admin.exec(`DROP SCHEMA ${ns} CASCADE`);await admin.close();}});
const call=(who:string,url:string,payload?:any)=>app.inject({method:payload?'POST':'GET',url,payload,headers:{authorization:'Bearer '+tokens[who]}});
const ingest=(payload:any,credential=token)=>app.inject({method:'POST',url:'/support/ingest',payload,headers:{authorization:'Bearer '+credential}});
test('ingest is isolated from employee sessions and grants no read access',async()=>{
 assert.equal((await ingest(snapshot(),tokens.m1)).statusCode,401);
 assert.equal((await app.inject({url:'/support/tickets',headers:{authorization:'Bearer '+token}})).statusCode,401);
 assert.equal((await ingest(snapshot())).statusCode,200);
 assert.equal((await app.inject('/support/tickets')).statusCode,401);
 assert.equal((await call('m2','/support/tickets')).statusCode,403);
 assert.equal((await call('m1','/support/tickets')).json().items.length,1);
});
test('knowledge is available to employees but support customer details are not',async()=>{
 assert.equal((await call('m2','/support/library')).json().items.length,1);
 assert.equal((await call('m2','/support/tickets/ticket-1')).statusCode,403);
 const me=(await call('m2','/me')).json();assert.equal(me.supportAccess.read,false);
});
test('forged org, duplicates and old snapshot cannot overwrite trusted scope',async()=>{
 assert.equal((await ingest({...snapshot(),orgId:'other'})).statusCode,400);
 const duplicate=snapshot();duplicate.articles.push(duplicate.articles[0]);assert.equal((await ingest(duplicate)).statusCode,400);
 assert.equal((await ingest(snapshot(Date.now()-60000))).statusCode,409);
 assert.equal((await ingest(snapshot(Date.now()+120000))).statusCode,400);
});
test('review binds authenticated actor and exact content, never send or publish',async()=>{
 const item=(await call('m1','/support/tickets/ticket-1')).json().drafts[0];
 const payload={kind:'draft',id:item.id,contentHash:item.contentHash,decision:'reviewed',note:'Synthetic human check',humanConfirmation:true};
 assert.equal((await call('m2','/support/reviews',payload)).statusCode,403);
 assert.equal((await call('m1','/support/reviews',{...payload,actorId:'m4'})).statusCode,400);
 assert.equal((await call('m1','/support/reviews',{...payload,contentHash:'0'.repeat(64)})).statusCode,409);
 const result=await call('m1','/support/reviews',payload);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().customerSendEnabled,false);
 const history=(await call('m1','/support/reviews/draft/draft-1')).json().items;assert.equal(history[0].actor_id,'m1');
 assert.equal((await call('m1','/support/tickets/ticket-1/send',{})).statusCode,404);
});
test('staff comparison saves exact source, retains versions, retries idempotently and rejects conflicts',async()=>{
 const current=snapshot();assert.equal((await ingest(current)).statusCode,200);
 const detail=(await call('m1','/support/tickets/ticket-1')).json(),d=detail.drafts[0];
 const payload={requestId:randomUUID(),baseId:null,ticketRevision:1,draftId:d.id,draftHash:d.contentHash,body:'Fictional final response <script>literal</script>'};
 assert.equal((await call('m4','/support/tickets/ticket-1/reply-edits',payload)).statusCode,403);
 assert.equal((await call('m2','/support/tickets/ticket-1/reply-edits',payload)).statusCode,403);
 const saved=await call('m1','/support/tickets/ticket-1/reply-edits',payload);assert.equal(saved.statusCode,200,saved.body);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',payload)).json().id,saved.json().id);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,body:'Different replay'})).statusCode,409);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,requestId:randomUUID()})).statusCode,409);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,requestId:randomUUID(),baseId:saved.json().id,draftHash:'0'.repeat(64)})).statusCode,409);
 const history=(await call('m1','/support/tickets/ticket-1')).json().edits;assert.equal(history.length,1);assert.equal(history[0].draft_body,d.body);assert.equal(history[0].draft_version,1);assert.equal(history[0].body,payload.body);assert.equal(history[0].actor_id,'m1');assert.equal(saved.json().customerSendEnabled,false);
 const next=await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,requestId:randomUUID(),baseId:saved.json().id,body:'Second fictional revision'});assert.equal(next.statusCode,200,next.body);
 assert.equal((await call('m1','/support/tickets/ticket-1')).json().edits.length,2);
 assert.equal((await call('m1','/support/tickets/ticket-1/send',{})).statusCode,404);
});
test('sent reply snapshots are ticket-scoped and reject forged references',async()=>{
 const s=snapshot() as any;s.sentReplies=[{id:'sent-fixture',ticketId:'ticket-1',inReplyToThreadId:null,body:'Fictional sent response',sentAt:new Date().toISOString(),agentName:'Agent fixture',observedAt:new Date().toISOString(),source:'zoho_sent_email',complete:true}];s.replySync={status:'ready',observedAt:new Date().toISOString()};
 assert.equal((await ingest(s)).statusCode,200);const detail=(await call('m1','/support/tickets/ticket-1')).json();assert.equal(detail.sentReplies.length,1);assert.equal(detail.replySync.status,'ready');assert.equal(detail.edits.length,2);
 s.sentReplies[0].ticketId='foreign-ticket';assert.equal((await ingest(s)).statusCode,400);
});
test('obsolete draft revision and stale source block review',async()=>{
 const s=snapshot();s.tickets[0].revision=2;assert.equal((await ingest(s)).statusCode,200);
 const item=(await call('m1','/support/tickets/ticket-1')).json().drafts[0];assert.equal(item.reviewable,false);
 assert.equal((await call('m1','/support/reviews',{kind:'draft',id:item.id,contentHash:item.contentHash,decision:'reviewed',note:'Current content',humanConfirmation:true})).statusCode,409);
 await db.query("UPDATE support_snapshots SET observed_at=now()-interval '1 hour'");
 const article=(await call('m1','/support/articles/en-1')).json();
 assert.equal((await call('m1','/support/summary')).json().stale,true);
 assert.equal((await call('m1','/support/reviews',{kind:'article',id:'en-1',contentHash:article.contentHash,decision:'reviewed',note:'Verified source',humanConfirmation:true})).statusCode,409);
});
test('stale ticket source also blocks comparison writes',async()=>{
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{requestId:randomUUID(),baseId:null,ticketRevision:2,draftId:null,draftHash:null,body:'Fixture stale edit'})).statusCode,409);
});
test('another organization cannot see or review source records',async()=>{
 await db.query("UPDATE users SET org_id='foreign-org' WHERE id='m1'");
 assert.equal((await call('m1','/support/tickets')).statusCode,403);
 assert.equal((await call('m1','/support/library')).json().items.length,0);
});

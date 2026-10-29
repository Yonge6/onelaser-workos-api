import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {supportQuality} from '../src/support.js';
let db:Database,admin:Database|undefined,ns:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const secret=randomBytes(32).toString('hex'),token=randomBytes(48).toString('hex'),tokens:Record<string,string>={};
const snapshot=(at=Date.now())=>({version:1,observedAt:new Date(at).toISOString(),runtime:'mac-pilot',pollerLastSuccess:null,watchLastSuccess:null,dispatchPaused:true,articles:[{id:'en-1',title:'Synthetic knowledge',family:'general',body:'<script>fake script</script> Text only',sourceUrl:'https://wiki.1laser.com/test',sourceVersion:'v1'}],answers:[{id:'SA-001',title:'Acknowledgement',family:'general',body:'Synthetic candidate',note:'Check source',sources:[]}],tickets:[{id:'ticket-1',number:'TEST-1',subject:'Synthetic ticket',status:'Open',revision:1,reasons:[],observedAt:new Date(at).toISOString(),responseDueAt:null,resolutionDueAt:null}],drafts:[{id:'draft-1',ticketId:'ticket-1',revision:1,version:1,status:'pending',body:'Synthetic draft only',sources:[],createdAt:new Date(at).toISOString()}],jobs:{pending:0,attention:0},sla:{status:'draft',body:'Pending review'}});
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});ns='support_test_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${ns}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${ns}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);await seedDemo(db);const org=(await db.query('SELECT org_id FROM users WHERE id=$1',['m1'])).rows[0].org_id;
 app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,support:{orgId:org,ingestToken:token,userIds:['m1','m5'],reviewerIds:['m1']},integrations:{executiveUserIds:['m4']}});
 for(const userId of ['m1','m2','m4','m5'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;
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
test('reply pairing binds exact incoming thread, captures reasons and preserves sent evidence',async()=>{
 const s=snapshot() as any;s.tickets[0].inboundId='inbound-current';s.drafts[0].inboundId='inbound-current';s.sentReplies=[{id:'sent-current',ticketId:'ticket-1',inReplyToThreadId:'inbound-current',body:'Exact fictional sent response',sentAt:new Date().toISOString(),agentName:'Agent fixture',observedAt:new Date().toISOString(),source:'zoho_sent_email',complete:true}];
 assert.equal((await ingest(s)).statusCode,200);
 const detail=(await call('m1','/support/tickets/ticket-1')).json(),d=detail.drafts[0];
 const payload={requestId:randomUUID(),baseId:detail.edits[0].id,ticketRevision:1,draftId:d.id,draftHash:d.contentHash,body:'Fictional staff version',sentReplyId:'sent-current',pairingConfirmed:false,reasonCodes:['facts','tone'],reasonNote:'Corrected the unsupported example.',outcome:'unresolved'};
 const saved=await call('m1','/support/tickets/ticket-1/reply-edits',payload);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().pairingStatus,'thread_confirmed');
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',payload)).json().id,saved.json().id);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,reasonCodes:['technical']})).statusCode,409);
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,outcome:'resolved'})).statusCode,409);
 const edit=(await call('m1','/support/tickets/ticket-1')).json().edits[0];assert.equal(edit.inbound_id,'inbound-current');assert.equal(edit.sent_reply_id,'sent-current');assert.equal(edit.sent_reply_body,s.sentReplies[0].body);assert.equal(edit.sent_reply_hash.length,64);assert.deepEqual(edit.reason_codes,['facts','tone']);assert.equal(edit.reason_note,payload.reasonNote);assert.equal(edit.outcome,'unresolved');
 const audit=(await db.query("SELECT details FROM audit_events WHERE object_id=$1 AND action='support.reply_edit.saved'",[saved.json().id])).rows[0].details;assert.equal(audit.outcomeVerification,'human_reported');assert.ok(!JSON.stringify(audit).includes(payload.body));
 // Source can rotate out of the three-message snapshot; immutable saved evidence stays available.
 s.observedAt=new Date().toISOString();s.sentReplies=[];assert.equal((await ingest(s)).statusCode,200);
 assert.equal((await call('m1','/support/tickets/ticket-1')).json().edits[0].sent_reply_body,'Exact fictional sent response');
});
test('known wrong-thread pair cannot be overridden by a human checkbox, and cross-ticket mail is rejected',async()=>{
 const s=snapshot() as any;s.tickets[0].inboundId='new-inbound';s.drafts[0].inboundId='new-inbound';s.tickets.push({...s.tickets[0],id:'ticket-2',inboundId:'other-inbound'});s.sentReplies=[{id:'wrong-thread',ticketId:'ticket-1',inReplyToThreadId:'old-inbound',body:'Fictional old reply',sentAt:new Date().toISOString(),agentName:'Agent fixture',observedAt:new Date().toISOString(),source:'zoho_sent_email',complete:true},{id:'other-ticket',ticketId:'ticket-2',inReplyToThreadId:'other-inbound',body:'Fictional foreign reply',sentAt:new Date().toISOString(),agentName:'Agent fixture',observedAt:new Date().toISOString(),source:'zoho_sent_email',complete:true}];
 assert.equal((await ingest(s)).statusCode,200);const detail=(await call('m1','/support/tickets/ticket-1')).json(),d=detail.drafts[0],payload={requestId:randomUUID(),baseId:detail.edits[0].id,ticketRevision:1,draftId:d.id,draftHash:d.contentHash,body:'Fixture only',sentReplyId:'wrong-thread',pairingConfirmed:true};
 const bad=await call('m1','/support/tickets/ticket-1/reply-edits',payload);assert.equal(bad.statusCode,409);assert.equal(bad.json().error.code,'SUPPORT_PAIRING_THREAD_MISMATCH');
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,requestId:randomUUID(),sentReplyId:'other-ticket'})).statusCode,409);
});
test('unknown reply parent needs explicit human pairing and cannot silently prove AI adoption',async()=>{
 const s=snapshot() as any;s.sentReplies=[{id:'unknown-parent',ticketId:'ticket-1',inReplyToThreadId:null,body:'Fictional known sent mail',sentAt:new Date().toISOString(),agentName:'Agent fixture',observedAt:new Date().toISOString(),source:'zoho_sent_email',complete:true}];
 assert.equal((await ingest(s)).statusCode,200);const detail=(await call('m1','/support/tickets/ticket-1')).json(),d=detail.drafts[0],payload={requestId:randomUUID(),baseId:detail.edits[0].id,ticketRevision:1,draftId:d.id,draftHash:d.contentHash,body:'Fixture response',sentReplyId:'unknown-parent'};
 assert.equal((await call('m1','/support/tickets/ticket-1/reply-edits',payload)).statusCode,400);
 const saved=await call('m1','/support/tickets/ticket-1/reply-edits',{...payload,pairingConfirmed:true});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().pairingStatus,'human_confirmed');
 const summary=(await call('m4','/support/summary')).json();assert.equal(summary.quality.engine,'rules');assert.equal(summary.quality.confirmedPairs,2);assert.equal(summary.workflow.pairedRevisions,2);assert.equal(summary.coverage.ticketsWithInboundId,0);assert.equal(summary.coverage.totalTickets,1);
});
test('quality rules expose evidence and unknowns without claiming truth or misclassifying a clear prohibition',()=>{
 const quality=supportQuality({body:'We will refund the order. Please bypass the door interlock. Your package will arrive tomorrow.',sources:[{title:'Fixture',url:'https://wiki.1laser.com/test',version:'unknown'}],inboundId:null});
 assert.equal(quality.engine,'rules');assert.equal(quality.status,'needs_review');assert.equal(quality.truthVerified,false);
 assert.deepEqual(new Set(quality.flags.map(f=>f.code)),new Set(['source_version_unverified','financial_commitment_review','safety_instruction_review','delivery_commitment_review']));assert.ok(quality.flags.find(f=>f.code==='safety_instruction_review')?.excerpt);
 const negative=supportQuality({body:'Do not bypass the door interlock.',sources:[{title:'Fixture',url:'https://wiki.1laser.com/test',version:'v1'}],inboundId:null});assert.equal(negative.flags.length,0);assert.equal(negative.truthVerified,false);
});
test('handovers are source-bound, append-only, role-scoped and require receiver acceptance',async()=>{
 assert.equal((await ingest(snapshot())).statusCode,200);let detail=(await call('m1','/support/tickets/ticket-1')).json();
 const payload={requestId:randomUUID(),baseId:null,ticketRevision:1,ticketHash:detail.ticket.contentHash,confirmedFacts:'Fictional verified context',triedSteps:'Read the guide',commitments:'No customer commitment',blockers:'Need a version',nextAction:'Confirm the firmware version',ownerId:'m1',receiverId:'m5',nextFollowupAt:new Date(Date.now()+3600000).toISOString(),status:'open'};
 assert.deepEqual(detail.handoverPeople.map((p:any)=>p.id).sort(),['m1','m4','m5']);assert.equal(detail.handoverPeople.find((p:any)=>p.id==='m4').canAccept,false);
 assert.equal((await call('m2','/support/tickets/ticket-1/handovers',payload)).statusCode,403);
 assert.equal((await call('m4','/support/tickets/ticket-1/handovers',payload)).statusCode,403);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,ownerId:'m2'})).statusCode,400);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,receiverId:'m4'})).statusCode,400);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,ticketHash:'0'.repeat(64)})).statusCode,409);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,status:'accepted'})).statusCode,403);
 const opened=await call('m1','/support/tickets/ticket-1/handovers',payload);assert.equal(opened.statusCode,200,opened.body);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',payload)).json().id,opened.json().id);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,blockers:'Different replay'})).statusCode,409);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID()})).statusCode,409);
 const accepted={...payload,requestId:randomUUID(),baseId:opened.json().id,status:'accepted'};
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',accepted)).statusCode,403);
 // Reassign to an authorized editor so the actual receiver can accept.
 const assigned=await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:opened.json().id,receiverId:'m1'});assert.equal(assigned.statusCode,200,assigned.body);
 const acceptedByReceiver=await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:assigned.json().id,receiverId:'m1',status:'accepted'});assert.equal(acceptedByReceiver.statusCode,200,acceptedByReceiver.body);
 const completed=await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:acceptedByReceiver.json().id,receiverId:'m1',status:'completed'});assert.equal(completed.statusCode,200,completed.body);
 detail=(await call('m1','/support/tickets/ticket-1')).json();assert.equal(detail.handovers.length,4);assert.equal(detail.handovers[0].status,'completed');assert.equal(detail.handovers[0].source_hash,payload.ticketHash);assert.equal(detail.handovers[0].actor_id,'m1');
 const summary=(await call('m4','/support/summary')).json();assert.equal(summary.workflow.handovers,4);assert.equal(summary.quality.handoversOpen,0);
 const altered=snapshot();altered.tickets[0].subject='Changed fixture without new incoming mail';assert.equal((await ingest(altered)).statusCode,200);
 assert.equal((await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:completed.json().id})).statusCode,409);
});
test('handover acceptance survives observation refresh but rejects a new customer message',async()=>{
 const s=snapshot() as any;s.tickets[0].inboundId='handover-incoming-1';assert.equal((await ingest(s)).statusCode,200);
 let detail=(await call('m1','/support/tickets/ticket-1')).json();const payload={requestId:randomUUID(),baseId:detail.handovers[0].id,ticketRevision:1,ticketHash:detail.ticket.contentHash,nextAction:'Synthetic follow-up',ownerId:'m1',receiverId:'m5',status:'open'};
 const opened=await call('m1','/support/tickets/ticket-1/handovers',payload);assert.equal(opened.statusCode,200,opened.body);
 s.observedAt=new Date().toISOString();s.tickets[0].observedAt=new Date().toISOString();assert.equal((await ingest(s)).statusCode,200);detail=(await call('m5','/support/tickets/ticket-1')).json();assert.equal(detail.ticket.contentHash,payload.ticketHash);
 const accepted=await call('m5','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:opened.json().id,status:'accepted'});assert.equal(accepted.statusCode,200,accepted.body);
 s.observedAt=new Date().toISOString();s.tickets[0].revision=2;s.tickets[0].inboundId='handover-incoming-2';assert.equal((await ingest(s)).statusCode,200);detail=(await call('m1','/support/tickets/ticket-1')).json();
 const completed=await call('m1','/support/tickets/ticket-1/handovers',{...payload,requestId:randomUUID(),baseId:accepted.json().id,ticketRevision:2,ticketHash:detail.ticket.contentHash,status:'completed'});assert.equal(completed.statusCode,409);assert.equal(completed.json().error.code,'SUPPORT_CHANGED');
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

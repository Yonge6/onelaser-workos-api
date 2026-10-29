import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { sameSecret } from './auth.js';
import { deny } from './errors.js';

const id=z.string().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/);
const text=z.string().max(100000);
const url=z.string().max(2000).url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;});
const source=z.object({title:z.string().max(500),url,version:z.string().max(200)}).strict();
const article=z.object({id,title:z.string().max(500),family:z.string().max(100),body:text,sourceUrl:url,sourceVersion:z.string().max(200)}).strict();
const answer=z.object({id,title:z.string().max(500),family:z.string().max(100),body:text,note:text,sources:z.array(source).max(50)}).strict();
const ticket=z.object({id,number:z.string().max(50),subject:z.string().max(500),status:z.string().max(100),revision:z.number().int().positive(),inboundId:id.nullable().optional(),reasons:z.array(z.string().max(100)).max(20),observedAt:z.string().datetime().nullable(),responseDueAt:z.string().max(100).nullable(),resolutionDueAt:z.string().max(100).nullable()}).strict();
const sentReply=z.object({id,ticketId:id,inReplyToThreadId:id.nullable(),body:text,sentAt:z.string().datetime(),agentName:z.string().max(200),observedAt:z.string().datetime(),source:z.literal('zoho_sent_email'),complete:z.literal(true)}).strict();
const draft=z.object({id,ticketId:id,revision:z.number().int().positive(),inboundId:id.nullable().optional(),version:z.number().int().positive(),status:z.string().max(60),body:text,sources:z.array(source).max(50),createdAt:z.string().datetime()}).strict();
export const snapshotInput=z.object({version:z.literal(1),observedAt:z.string().datetime(),runtime:z.literal('mac-pilot'),pollerLastSuccess:z.string().datetime().nullable(),watchLastSuccess:z.string().datetime().nullable(),dispatchPaused:z.boolean(),articles:z.array(article).max(500),answers:z.array(answer).max(100),tickets:z.array(ticket).max(500),drafts:z.array(draft).max(1000),sentReplies:z.array(sentReply).max(1000).default([]),replySync:z.object({status:z.enum(['ready','partial','unavailable']),observedAt:z.string().datetime().nullable()}).strict().optional(),jobs:z.object({pending:z.number().int().nonnegative(),attention:z.number().int().nonnegative()}).strict(),sla:z.object({status:z.literal('draft'),body:text}).strict()}).strict();
export type SupportSnapshot=z.infer<typeof snapshotInput>;
export type SupportOptions={orgId?:string; ingestToken?:string; userIds?:string[]; reviewerIds?:string[]};
export const supportSchema=`
CREATE TABLE IF NOT EXISTS support_snapshots(org_id text PRIMARY KEY,observed_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),digest text NOT NULL,data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS support_reviews(id text PRIMARY KEY,org_id text NOT NULL,kind text NOT NULL,entity_id text NOT NULL,content_hash text NOT NULL,actor_id text NOT NULL REFERENCES users(id),decision text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS support_reply_edits(id text PRIMARY KEY,org_id text NOT NULL,ticket_id text NOT NULL,ticket_revision integer NOT NULL,draft_id text,draft_hash text,draft_body text,draft_version integer,body text NOT NULL,actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS inbound_id text;
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS sent_reply_id text;
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS sent_reply_hash text;
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS sent_reply_body text;
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS pairing_status text NOT NULL DEFAULT 'unpaired';
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS pairing_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS reason_codes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS reason_note text NOT NULL DEFAULT '';
ALTER TABLE support_reply_edits ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'unknown';
CREATE TABLE IF NOT EXISTS support_handovers(id text PRIMARY KEY,org_id text NOT NULL,ticket_id text NOT NULL,ticket_revision integer NOT NULL,source_hash text NOT NULL,base_id text,confirmed_facts text NOT NULL,tried_steps text NOT NULL,commitments text NOT NULL,blockers text NOT NULL,next_action text NOT NULL,owner_id text REFERENCES users(id),receiver_id text REFERENCES users(id),next_followup_at timestamptz,status text NOT NULL,actor_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS support_reply_ticket ON support_reply_edits(org_id,ticket_id,created_at);
CREATE INDEX IF NOT EXISTS support_review_entity ON support_reviews(org_id,kind,entity_id,created_at);
CREATE INDEX IF NOT EXISTS support_handover_ticket ON support_handovers(org_id,ticket_id,created_at);
`;
export function supportOptionsFromEnv(env:NodeJS.ProcessEnv):SupportOptions{return {orgId:env.WORKOS_SUPPORT_ORG_ID,ingestToken:env.WORKOS_SUPPORT_INGEST_TOKEN,userIds:env.WORKOS_SUPPORT_USER_IDS?.split(',').filter(Boolean)||[],reviewerIds:env.WORKOS_SUPPORT_REVIEWER_IDS?.split(',').filter(Boolean)||[]};}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ticketContentHash=({observedAt,...content}:SupportSnapshot['tickets'][number])=>hash(content);
export function supportPermissions(user:User,o:SupportOptions,executiveIds:string[]=[]){const sameOrg=user.org_id===o.orgId;return {edit:sameOrg&&o.userIds?.includes(user.id)===true,read:sameOrg&&(o.userIds?.includes(user.id)===true||executiveIds.includes(user.id)),review:sameOrg&&o.reviewerIds?.includes(user.id)===true,executive:sameOrg&&executiveIds.includes(user.id)};}
function currentDraft(s:SupportSnapshot,d:SupportSnapshot['drafts'][number]){const t=s.tickets.find(t=>t.id===d.ticketId);return t?.revision===d.revision&&d.status==='pending'&&Date.now()-Date.parse(d.createdAt)<86400000;}
function state(row:any){const age=row?Math.max(0,(Date.now()-new Date(row.observed_at).getTime())/1000):null;return {connected:!!row,stale:age===null||age>180,observedAt:row?.observed_at||null,receivedAt:row?.received_at||null,ageSeconds:age,runtime:'mac-pilot',customerSendEnabled:false,policyActivationEnabled:false};}
export const replyReasonCodes=['facts','technical','policy','tone','missing_information','source_conflict','other'] as const;
type QualityFlag={code:string;severity:'warning'|'high';message:string;excerpt?:string};
/** Explainable triage only. These rules do not determine truth, approval or safety. */
export function supportQuality(d:Pick<SupportSnapshot['drafts'][number],'body'|'sources'|'inboundId'>){
  const flags:QualityFlag[]=[];
  if(!d.sources.length)flags.push({code:'missing_sources',severity:'warning',message:'No source is attached. Verify factual and technical claims.'});
  if(d.sources.some(s=>!s.version.trim()||/unknown|unverified|unreviewed|needs_information|pending|source snapshot/i.test(s.version)))flags.push({code:'source_version_unverified',severity:'warning',message:'At least one source version has not been verified.'});
  const lines=d.body.split(/[\n.!?]+/).map(s=>s.trim()).filter(Boolean);
  const add=(code:string,severity:'warning'|'high',message:string,re:RegExp)=>{const line=lines.find(s=>re.test(s)&&!/^\s*(?:do not|don't|never)\b/i.test(s));if(line)flags.push({code,severity,message,excerpt:line.slice(0,240)});};
  add('safety_instruction_review','high','Potentially hazardous instruction: a qualified person must check the exact context.',/\b(?:bypass|disable|defeat)\b.{0,50}\b(?:interlock|safety|door sensor)\b|\b(?:open|touch|test|adjust|repair)\b.{0,50}\b(?:high[- ]voltage|live wire|energized)\b|绕过.{0,10}(?:安全|联锁)|带电.{0,10}(?:维修|检查|操作)/i);
  add('financial_commitment_review','high','Verify policy and authorization before making a refund, replacement or compensation commitment.',/\b(?:we (?:will|guarantee|can)|you (?:will|are entitled to))\b.{0,70}\b(?:refund|replace(?:ment)?|compensat(?:e|ion)|free (?:part|machine))|(?:保证|承诺|将为您|我们会).{0,25}(?:退款|换机|免费|赔偿)/i);
  add('delivery_commitment_review','warning','Verify current order and carrier evidence before promising a delivery date.',/\b(?:will|guaranteed to)\b.{0,40}\b(?:arrive|be delivered|ship)\b|\bdeliver(?:y|ed)\b.{0,25}\b(?:tomorrow|within \d+|on (?:monday|tuesday|wednesday|thursday|friday))|(?:保证|一定|将).{0,20}(?:送达|发货|到货)/i);
  return {engine:'rules' as const,status:flags.length?'needs_review':'no_rule_flags',flags,checkedAt:new Date().toISOString(),truthVerified:false};
}
const handoverText=z.string().max(8000);
const handoverInput=z.object({requestId:z.string().uuid(),baseId:z.string().uuid().nullable(),ticketRevision:z.number().int().positive(),ticketHash:z.string().regex(/^[a-f0-9]{64}$/),confirmedFacts:handoverText.default(''),triedSteps:handoverText.default(''),commitments:handoverText.default(''),blockers:handoverText.default(''),nextAction:handoverText.trim().min(1),ownerId:id.nullable().default(null),receiverId:id.nullable().default(null),nextFollowupAt:z.string().datetime().nullable().default(null),status:z.enum(['draft','open','accepted','completed']).default('open')}).strict();
function handoverValues(v:z.infer<typeof handoverInput>){return {ticketRevision:v.ticketRevision,ticketHash:v.ticketHash,baseId:v.baseId,confirmedFacts:v.confirmedFacts,triedSteps:v.triedSteps,commitments:v.commitments,blockers:v.blockers,nextAction:v.nextAction,ownerId:v.ownerId,receiverId:v.receiverId,nextFollowupAt:v.nextFollowupAt,status:v.status};}
function storedHandoverValues(r:any){return {ticketRevision:r.ticket_revision,ticketHash:r.source_hash,baseId:r.base_id,confirmedFacts:r.confirmed_facts,triedSteps:r.tried_steps,commitments:r.commitments,blockers:r.blockers,nextAction:r.next_action,ownerId:r.owner_id,receiverId:r.receiver_id,nextFollowupAt:r.next_followup_at?new Date(r.next_followup_at).toISOString():null,status:r.status};}
export function registerSupportRoutes(app:FastifyInstance,db:Database,o:SupportOptions={},executiveIds:string[]=[]){
  const can=(user:User|null,review=false)=>{if(!user||!(review?supportPermissions(user,o,executiveIds).review:supportPermissions(user,o,executiveIds).read))deny(403,'SUPPORT_FORBIDDEN','Support workspace access is required');return user!;};
  const rowFor=async(org:string)=>(await db.query('SELECT * FROM support_snapshots WHERE org_id=$1',[org])).rows[0];
  const peopleIds=[...new Set([...(o.userIds||[]),...(o.reviewerIds||[]),...executiveIds])];
  const handoverPeople=async(tx:Queryable,org:string)=>(await tx.query('SELECT id,display_name FROM users WHERE org_id=$1 AND active=true AND id=ANY($2::text[]) ORDER BY display_name,id',[org,peopleIds])).rows.map(p=>({...p,canAccept:o.userIds?.includes(p.id)===true}));
  const audit=async(user:User,kind:string,objectId:string,details:unknown)=>db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),user.org_id,user.department_id,user.id,kind,objectId,JSON.stringify(details)]);
  app.post('/support/ingest',{bodyLimit:8*1024*1024},async(req,reply)=>{
    if(!o.orgId||!o.ingestToken||o.ingestToken.length<32||!sameSecret(String(req.headers.authorization||''),'Bearer '+o.ingestToken))deny(401,'UNAUTHENTICATED','Authentication is required');
    const s=snapshotInput.parse(req.body),ts=Date.parse(s.observedAt),now=Date.now();
    if(ts>now+60000||ts<now-10*60000)deny(400,'SUPPORT_TIME_INVALID','Snapshot timestamp is outside the allowed window');
    for(const values of [s.tickets,s.drafts,s.articles,s.answers,s.sentReplies])if(new Set(values.map(x=>x.id)).size!==values.length)deny(400,'SUPPORT_DUPLICATE_ID','Snapshot contains duplicate records');
    if(s.sentReplies.some(r=>!s.tickets.some(t=>t.id===r.ticketId)))deny(400,'SUPPORT_INVALID_REFERENCE','Reply ticket is absent');
    if(s.drafts.some(d=>!s.tickets.some(t=>t.id===d.ticketId)))deny(400,'SUPPORT_INVALID_REFERENCE','Draft ticket is absent');
    const digest=hash(s);
    const result=await db.query(`INSERT INTO support_snapshots(org_id,observed_at,digest,data) VALUES($1,$2,$3,$4)
      ON CONFLICT(org_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=now(),digest=excluded.digest,data=excluded.data
      WHERE support_snapshots.observed_at<excluded.observed_at OR (support_snapshots.observed_at=excluded.observed_at AND support_snapshots.digest=excluded.digest) RETURNING org_id`,[o.orgId,s.observedAt,digest,JSON.stringify(s)]);
    if(!result.rows.length)deny(409,'SUPPORT_REPLAY','A newer or conflicting snapshot is already stored');
    return reply.send({stored:true,observedAt:s.observedAt,customerSendEnabled:false});
  });
  app.get('/support/summary',async req=>{
    const user=can(req.actor),row=await rowFor(user.org_id),status=state(row),s:SupportSnapshot|undefined=row?.data;
    const edits=(await db.query('SELECT count(*)::int total,count(*) FILTER(WHERE sent_reply_id IS NOT NULL)::int paired,count(*) FILTER(WHERE outcome=\'resolved\')::int resolved FROM support_reply_edits WHERE org_id=$1',[user.org_id])).rows[0];
    const handovers=(await db.query("SELECT count(*)::int total,max(created_at) latest FROM support_handovers WHERE org_id=$1",[user.org_id])).rows[0];
    const openHandovers=(await db.query("SELECT count(*)::int total FROM (SELECT DISTINCT ON(ticket_id) status FROM support_handovers WHERE org_id=$1 ORDER BY ticket_id,created_at DESC,id DESC) h WHERE status IN ('draft','open','accepted')",[user.org_id])).rows[0].total;
    const checked=s?.drafts.filter(d=>currentDraft(s,d));
    return {...status,counts:s?{tickets:s.tickets.length,drafts:checked!.length,attention:s.tickets.filter(t=>t.reasons.length).length,articles:s.articles.length,answers:s.answers.length}:null,jobs:s?.jobs||null,pollerLastSuccess:s?.pollerLastSuccess||null,watchLastSuccess:s?.watchLastSuccess||null,dispatchPaused:s?.dispatchPaused??null,permissions:supportPermissions(user,o,executiveIds),scope:'tracked_pilot_tickets_only',quality:s?{engine:'rules',draftsChecked:checked!.length,flaggedDrafts:checked!.filter(d=>supportQuality(d).flags.length).length,unknownInboundDrafts:checked!.filter(d=>!d.inboundId).length,confirmedPairs:edits.paired,unpairedEdits:edits.total-edits.paired,handoversOpen:openHandovers,coverageLabel:'Tracked pilot records only; rule flags are not verified errors.'}:null,workflow:{savedRevisions:edits.total,pairedRevisions:edits.paired,resolvedRevisions:edits.resolved,handovers:handovers.total,latestHandoverAt:handovers.latest},coverage:s?{ticketsWithInboundId:s.tickets.filter(t=>!!t.inboundId).length,totalTickets:s.tickets.length,scope:'tracked_pilot_tickets_only'}:null};
  });
  app.get('/support/tickets',async req=>{const user=can(req.actor),row=await rowFor(user.org_id);return {...state(row),items:row?.data.tickets||[]};});
  app.get<{Params:{id:string}}>('/support/tickets/:id',async req=>{
    const user=can(req.actor),row=await rowFor(user.org_id),s:SupportSnapshot|undefined=row?.data,t=s?.tickets.find(t=>t.id===req.params.id);
    if(!t||!s)deny(404,'NOT_FOUND','Ticket not found');
    await audit(user,'support.ticket.viewed',t.id,{});
    const drafts=s.drafts.filter(d=>d.ticketId===t.id).map(d=>({...d,contentHash:hash(d),reviewable:!state(row).stale&&currentDraft(s,d),quality:supportQuality(d)}));
    const reviews=(await db.query("SELECT r.*,u.display_name FROM support_reviews r JOIN users u ON r.actor_id=u.id WHERE r.org_id=$1 AND r.kind='draft' AND r.entity_id=ANY($2::text[]) ORDER BY r.created_at DESC",[user.org_id,drafts.map(d=>d.id)])).rows;
    const edits=(await db.query('SELECT e.*,u.display_name FROM support_reply_edits e JOIN users u ON u.id=e.actor_id WHERE e.org_id=$1 AND e.ticket_id=$2 ORDER BY e.created_at DESC,e.id DESC',[user.org_id,t.id])).rows;
    const handovers=(await db.query('SELECT h.*,u.display_name FROM support_handovers h JOIN users u ON u.id=h.actor_id WHERE h.org_id=$1 AND h.ticket_id=$2 ORDER BY h.created_at DESC,h.id DESC',[user.org_id,t.id])).rows;
    return {...state(row),ticket:{...t,contentHash:ticketContentHash(t)},drafts,reviews,edits,handovers,handoverPeople:await handoverPeople(db,user.org_id),sentReplies:(s.sentReplies||[]).filter(r=>r.ticketId===t.id),replySync:s.replySync||{status:'unavailable',observedAt:null}};
  });
  app.post<{Params:{id:string}}>('/support/tickets/:id/reply-edits',async req=>{
    const user=can(req.actor);if(!supportPermissions(user,o,executiveIds).edit)deny(403,'SUPPORT_FORBIDDEN','Support editing access is required');
    const v=z.object({requestId:z.string().uuid(),baseId:z.string().uuid().nullable(),ticketRevision:z.number().int().positive(),draftId:id.nullable(),draftHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),body:z.string().min(1).max(100000).refine(v=>!!v.trim()),sentReplyId:id.nullable().default(null),pairingConfirmed:z.boolean().default(false),reasonCodes:z.array(z.enum(replyReasonCodes)).max(replyReasonCodes.length).refine(a=>new Set(a).size===a.length).default([]),reasonNote:z.string().max(4000).default(''),outcome:z.enum(['unknown','resolved','unresolved']).default('unknown')}).strict().parse(req.body);
    return db.transaction(async tx=>{
      const row=(await tx.query('SELECT * FROM support_snapshots WHERE org_id=$1 FOR UPDATE',[user.org_id])).rows[0],s:SupportSnapshot|undefined=row?.data;
      const existing=(await tx.query('SELECT * FROM support_reply_edits WHERE id=$1',[v.requestId])).rows[0];
      if(existing){if(existing.org_id!==user.org_id||existing.ticket_id!==req.params.id||existing.actor_id!==user.id||existing.body!==v.body||existing.ticket_revision!==v.ticketRevision||existing.draft_id!==v.draftId||existing.draft_hash!==v.draftHash||existing.sent_reply_id!==v.sentReplyId||existing.pairing_confirmed!==v.pairingConfirmed||JSON.stringify(existing.reason_codes)!==JSON.stringify(v.reasonCodes)||existing.reason_note!==v.reasonNote||existing.outcome!==v.outcome)deny(409,'SUPPORT_REQUEST_CONFLICT','Request already used');return {id:existing.id,recorded:true,pairingStatus:existing.pairing_status,customerSendEnabled:false};}
      const t=s?.tickets.find(t=>t.id===req.params.id);if(!t)deny(404,'NOT_FOUND','Ticket not found');
      if(state(row).stale||t.revision!==v.ticketRevision)deny(409,'SUPPORT_CHANGED','Ticket source changed or expired');
      const d=s!.drafts.find(d=>d.id===v.draftId&&d.ticketId===t.id);
      if(v.draftId?( !d||hash(d)!==v.draftHash ):v.draftHash!==null)deny(409,'SUPPORT_CHANGED','Draft source changed');
      const inboundId=d?.inboundId||(d&&d.revision!==t.revision?null:t.inboundId)||null;
      const sent=v.sentReplyId?(s!.sentReplies||[]).find(r=>r.id===v.sentReplyId&&r.ticketId===t.id):null;
      if(v.sentReplyId&&!sent)deny(409,'SUPPORT_PAIRING_SOURCE_CHANGED','Sent reply is absent from this ticket');
      if(sent&&inboundId&&sent.inReplyToThreadId&&sent.inReplyToThreadId!==inboundId)deny(409,'SUPPORT_PAIRING_THREAD_MISMATCH','The sent reply belongs to a different incoming thread');
      const threadMatched=!!sent&&!!inboundId&&sent.inReplyToThreadId===inboundId;
      if(sent&&!threadMatched&&!v.pairingConfirmed)deny(400,'SUPPORT_PAIRING_CONFIRMATION_REQUIRED','A person must confirm this pairing because the reply chain cannot prove it');
      const pairingStatus=!sent?'unpaired':threadMatched?'thread_confirmed':'human_confirmed';
      const latest=(await tx.query('SELECT id FROM support_reply_edits WHERE org_id=$1 AND ticket_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[user.org_id,t.id])).rows[0];
      if((latest?.id||null)!==v.baseId)deny(409,'SUPPORT_EDIT_CONFLICT','A newer edit exists; reload before saving');
      await tx.query('INSERT INTO support_reply_edits(id,org_id,ticket_id,ticket_revision,draft_id,draft_hash,draft_body,draft_version,body,actor_id,inbound_id,sent_reply_id,sent_reply_hash,sent_reply_body,pairing_status,pairing_confirmed,reason_codes,reason_note,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',[v.requestId,user.org_id,t.id,t.revision,v.draftId,v.draftHash,d?.body||null,d?.version||null,v.body,user.id,inboundId,v.sentReplyId,sent?hash(sent):null,sent?.body||null,pairingStatus,v.pairingConfirmed,JSON.stringify(v.reasonCodes),v.reasonNote,v.outcome]);
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),user.org_id,user.department_id,user.id,'support.reply_edit.saved',v.requestId,JSON.stringify({ticketId:t.id,draftId:v.draftId,contentHash:hash(v.body),sentReplyId:v.sentReplyId,pairingStatus,reasonCodes:v.reasonCodes,outcome:v.outcome,outcomeVerification:'human_reported',customerSendEnabled:false})]);
      return {id:v.requestId,recorded:true,pairingStatus,customerSendEnabled:false};
    });
  });
  app.post<{Params:{id:string}}>('/support/tickets/:id/handovers',async req=>{
    const user=can(req.actor);if(!supportPermissions(user,o,executiveIds).edit)deny(403,'SUPPORT_FORBIDDEN','Support editing access is required');
    const v=handoverInput.parse(req.body);
    return db.transaction(async tx=>{
      const row=(await tx.query('SELECT * FROM support_snapshots WHERE org_id=$1 FOR UPDATE',[user.org_id])).rows[0],s:SupportSnapshot|undefined=row?.data;
      const existing=(await tx.query('SELECT * FROM support_handovers WHERE id=$1',[v.requestId])).rows[0];
      if(existing){if(existing.org_id!==user.org_id||existing.ticket_id!==req.params.id||existing.actor_id!==user.id||JSON.stringify(storedHandoverValues(existing))!==JSON.stringify(handoverValues(v)))deny(409,'SUPPORT_REQUEST_CONFLICT','Request already used');return {id:existing.id,recorded:true,status:existing.status,customerSendEnabled:false};}
      const t=s?.tickets.find(t=>t.id===req.params.id);if(!t)deny(404,'NOT_FOUND','Ticket not found');
      if(state(row).stale||t.revision!==v.ticketRevision||ticketContentHash(t)!==v.ticketHash)deny(409,'SUPPORT_CHANGED','Ticket source changed or expired');
      const people=await handoverPeople(tx,user.org_id);
      if([v.ownerId,v.receiverId].some(person=>person&&!people.some(p=>p.id===person)))deny(400,'SUPPORT_HANDOVER_PERSON_INVALID','Select an active authorized colleague from this organization');
      if(v.receiverId&&!people.some(p=>p.id===v.receiverId&&p.canAccept))deny(400,'SUPPORT_HANDOVER_PERSON_INVALID','The receiver needs support editing access to accept a handover');
      const latest=(await tx.query('SELECT * FROM support_handovers WHERE org_id=$1 AND ticket_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[user.org_id,t.id])).rows[0];
      if((latest?.id||null)!==v.baseId)deny(409,'SUPPORT_HANDOVER_CONFLICT','A newer handover exists; reload before saving');
      if(['accepted','completed'].includes(v.status)&&latest&&(latest.ticket_revision!==t.revision||latest.source_hash!==v.ticketHash))deny(409,'SUPPORT_CHANGED','The handover context changed; refresh its open record before accepting');
      if(v.status==='accepted'&&(!latest||!['open','accepted'].includes(latest.status)||latest.receiver_id!==user.id||v.receiverId!==latest.receiver_id||v.ownerId!==latest.owner_id))deny(403,'SUPPORT_HANDOVER_RECEIVER_REQUIRED','Only the assigned receiver can accept the current handover');
      if(v.status==='completed'&&(!latest||latest.status!=='accepted'||![latest.receiver_id,latest.owner_id].includes(user.id)||v.receiverId!==latest.receiver_id||v.ownerId!==latest.owner_id))deny(403,'SUPPORT_HANDOVER_ACCEPTANCE_REQUIRED','The owner or receiver can complete an accepted handover');
      await tx.query('INSERT INTO support_handovers(id,org_id,ticket_id,ticket_revision,source_hash,base_id,confirmed_facts,tried_steps,commitments,blockers,next_action,owner_id,receiver_id,next_followup_at,status,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[v.requestId,user.org_id,t.id,t.revision,v.ticketHash,v.baseId,v.confirmedFacts,v.triedSteps,v.commitments,v.blockers,v.nextAction,v.ownerId,v.receiverId,v.nextFollowupAt,v.status,user.id]);
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),user.org_id,user.department_id,user.id,'support.handover.saved',v.requestId,JSON.stringify({ticketId:t.id,sourceHash:v.ticketHash,status:v.status,ownerId:v.ownerId,receiverId:v.receiverId,contentHash:hash(handoverValues(v)),customerSendEnabled:false})]);
      return {id:v.requestId,recorded:true,status:v.status,customerSendEnabled:false};
    });
  });
  // Public Wiki source material is still reached through the company session.
  app.get('/support/library',async req=>{const row=await rowFor(req.actor!.org_id);return {...state(row),items:(row?.data.articles||[]).map(({body,...a}:any)=>a)};});
  app.get<{Params:{id:string}}>('/support/articles/:id',async req=>{const row=await rowFor(req.actor!.org_id),a=row?.data.articles.find((a:any)=>a.id===req.params.id);if(!a)deny(404,'NOT_FOUND','Article not found');return {...a,contentHash:hash(a),sourceStatus:'unreviewed',publisherEnabled:false};});
  app.get('/support/answers',async req=>{const user=can(req.actor),row=await rowFor(user.org_id);return {...state(row),items:(row?.data.answers||[]).map((a:any)=>({...a,contentHash:hash(a)})),autoReuseEnabled:false};});
  app.get('/support/sla',async req=>{const user=can(req.actor),row=await rowFor(user.org_id);return {...state(row),policy:row?.data.sla||null,activated:false};});
  app.get<{Params:{kind:string;id:string}}>('/support/reviews/:kind/:id',async req=>{const user=can(req.actor);return {items:(await db.query('SELECT r.*,u.display_name FROM support_reviews r JOIN users u ON u.id=r.actor_id WHERE r.org_id=$1 AND r.kind=$2 AND r.entity_id=$3 ORDER BY r.created_at DESC',[user.org_id,req.params.kind,req.params.id])).rows};});
  app.post('/support/reviews',async req=>{
    const user=can(req.actor,true),v=z.object({kind:z.enum(['draft','article','answer']),id,contentHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['reviewed','changes_requested']),note:z.string().trim().min(3).max(4000),humanConfirmation:z.literal(true)}).strict().parse(req.body);
    return db.transaction(async tx=>{
      const row=(await tx.query('SELECT * FROM support_snapshots WHERE org_id=$1 FOR UPDATE',[user.org_id])).rows[0],s:SupportSnapshot|undefined=row?.data;
      if(!s||state(row).stale)deny(409,'SUPPORT_STALE','Refresh the support connector before reviewing');
      const item=(v.kind==='draft'?s.drafts:v.kind==='article'?s.articles:s.answers).find(x=>x.id===v.id);
      if(!item||hash(item)!==v.contentHash)deny(409,'SUPPORT_CHANGED','Source content changed; reload before reviewing');
      if(v.kind==='draft'&&!currentDraft(s,item as SupportSnapshot['drafts'][number]))deny(409,'SUPPORT_CHANGED','Draft is no longer current');
      const rid=randomUUID();await tx.query('INSERT INTO support_reviews(id,org_id,kind,entity_id,content_hash,actor_id,decision,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[rid,user.org_id,v.kind,v.id,v.contentHash,user.id,v.decision,v.note]);
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),user.org_id,user.department_id,user.id,'support.review.recorded',rid,JSON.stringify({kind:v.kind,id:v.id,hash:v.contentHash,decision:v.decision,customerSendEnabled:false})]);
      return {id:rid,recorded:true,customerSendEnabled:false,publisherEnabled:false,policyActivationEnabled:false};
    });
  });
}

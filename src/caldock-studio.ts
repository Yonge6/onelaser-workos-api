import type {FastifyInstance, FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {isDeepStrictEqual} from 'node:util';
import pg from 'pg';
import {z} from 'zod';
import type {Database, Queryable} from './db.js';
import {hash, readCookie, sameSecret} from './auth.js';
import {deny} from './errors.js';
import {studioSeed, studioRanges} from './caldock-studio-seed.js';

// Public viewing was explicitly requested; writes always require a CalDock
// session AND studio membership. Commerce admin alone cannot edit a plan.
export const studioSchema=`
CREATE TABLE IF NOT EXISTS caldock_studio_state (
 id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL DEFAULT 0,
 state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caldock_studio_members (
 user_id text PRIMARY KEY REFERENCES caldock_users(id),
 role text NOT NULL CHECK(role IN ('owner','editor','viewer'))
);
CREATE TABLE IF NOT EXISTS caldock_studio_history (
 id text PRIMARY KEY, revision integer NOT NULL UNIQUE, actor_id text NOT NULL REFERENCES caldock_users(id),
 path jsonb NOT NULL, before_value jsonb, after_value jsonb,
 operation text NOT NULL CHECK(operation IN ('patch','import','restore')),
 restored_from text REFERENCES caldock_studio_history(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caldock_studio_access_audit (
 id text PRIMARY KEY, actor_id text NOT NULL REFERENCES caldock_users(id),
 member_id text NOT NULL REFERENCES caldock_users(id), before_role text, after_role text,
 created_at timestamptz NOT NULL DEFAULT now()
);`;
const bilingual=z.object({zh:z.string().max(30000),en:z.string().max(30000)}).strict();
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).refine(v=>!['__proto__','prototype','constructor'].includes(v));
const record=<T extends z.ZodType>(type:T,max:number)=>z.record(id,type).refine(o=>Object.keys(o).length<=max);
const numbers=z.object(Object.fromEntries(Object.entries(studioRanges).map(([k,[min,max]])=>[k,z.number().finite().min(min).max(max)]))).strict();
const scenario=z.object({name:bilingual,values:numbers}).strict();
const task=z.object({title:bilingual,owner:z.string().max(200),due:z.string().refine(v=>v===''||/^\d{4}-\d{2}-\d{2}$/.test(v)),done:z.boolean()}).strict();
const nonnegative=z.number().finite().min(0).max(1000000);
export const studioStateSchema=z.object({schema:z.literal(4),scenarios:record(scenario,30).refine(o=>Object.keys(o).length>0),marketing:z.object({
 strategy:bilingual,outreach:bilingual,pitch:bilingual,content:bilingual,automation:bilingual,stopRules:bilingual,
 channels:record(z.object({name:bilingual,budget:nonnegative,leads:nonnegative}).strict(),20),
 funnel:z.object({leads:nonnegative,demo:z.number().min(0).max(100),trial:z.number().min(0).max(100),close:z.number().min(0).max(100)}).strict(),tasks:record(task,100)
}).strict()}).strict();
const patchInput=z.object({path:z.array(id).min(2).max(6),before:z.unknown(),value:z.unknown(),remove:z.boolean().default(false),revision:z.number().int().nonnegative(),requestId:z.string().uuid()}).strict();
const mutationInput=z.object({revision:z.number().int().nonnegative(),requestId:z.string().uuid()}).strict();
const buses=new WeakMap<Database,EventEmitter>();
function localBus(db:Database){let bus=buses.get(db);if(!bus){bus=new EventEmitter();bus.setMaxListeners(1000);buses.set(db,bus);}return bus;}
const clone=(v:any)=>structuredClone(v),get=(obj:any,path:string[])=>path.reduce((o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined,obj)??null;
function set(obj:any,path:string[],value:any,remove=false){let o=obj;for(const k of path.slice(0,-1)){if(!o[k]||typeof o[k]!=='object')deny(409,'STUDIO_PARENT_REMOVED','The parent item no longer exists');o=o[k];}if(remove)delete o[path.at(-1)!];else o[path.at(-1)!]=clone(value);}
const overlap=(a:string[],b:string[])=>a.slice(0,Math.min(a.length,b.length)).every((k,i)=>k===b[i]);
export type StudioOptions={publicUrl?:string;secureCookies?:boolean;connectionString?:string;ownerUserIds?:string[];heartbeatMs?:number};
export async function registerCaldockStudio(app:FastifyInstance,db:Database,options:StudioOptions={}){
 const origin=new URL(options.publicUrl||'http://localhost:4173').origin,secure=options.secureCookies===true;
 await db.query('INSERT INTO caldock_studio_state(id,state) VALUES(1,$1) ON CONFLICT DO NOTHING',[JSON.stringify(studioSeed)]);
 // Explicit private deployment configuration only; never first-visitor ownership.
 for(const userId of options.ownerUserIds||[])await db.query("INSERT INTO caldock_studio_members(user_id,role) SELECT id,'owner' FROM caldock_users WHERE id=$1 ON CONFLICT DO NOTHING",[userId]);
 const bus=localBus(db),streams=new Set<()=>void>();
 let listener:pg.Client|undefined,retry:ReturnType<typeof setTimeout>|undefined,closing=false;
 async function connectBus(){
  if(!options.connectionString||closing)return;
  const client=new pg.Client({connectionString:options.connectionString,connectionTimeoutMillis:5000});listener=client;
  const reconnect=()=>{if(listener!==client||closing)return;listener=undefined;void client.end().catch(()=>{});clearTimeout(retry);retry=setTimeout(()=>void connectBus(),2000);retry.unref();};
  client.on('error',reconnect);client.on('end',reconnect);
  client.on('notification',()=>bus.emit('change'));
  try{await client.connect();await client.query('LISTEN caldock_studio_changed');bus.emit('change');}catch{reconnect();}
 }
 await connectBus();
 app.addHook('preClose',async()=>{closing=true;clearTimeout(retry);for(const close of streams)close();await listener?.end().catch(()=>{});});
 const snapshot=async(tx:Queryable=db)=>{const row=(await tx.query('SELECT revision,state FROM caldock_studio_state WHERE id=1')).rows[0];return {revision:row.revision,state:row.state};};
 type Member={id:string;name:string;username:string;role:string;csrf:string;sessionHash:string};
 async function member(req:FastifyRequest):Promise<Member|null>{
  const cookie=readCookie(req.headers.cookie,(secure?'__Host-':'')+'caldock_session');if(!cookie)return null;
  const row=(await db.query('SELECT u.id,u.display_name,u.email,s.csrf_token,m.role FROM caldock_sessions s JOIN caldock_users u ON u.id=s.user_id LEFT JOIN caldock_studio_members m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(cookie)])).rows[0];
  return row?.role?{id:row.id,name:row.display_name,username:row.email||row.id,role:row.role,csrf:row.csrf_token,sessionHash:hash(cookie)}:null;
 }
 async function requireMember(req:FastifyRequest,write=false,owner=false){const m=await member(req);if(!m)deny(403,'STUDIO_MEMBERSHIP_REQUIRED','Studio editing access has not been granted');if(owner&&m.role!=='owner'||write&&m.role==='viewer')deny(403,'STUDIO_READ_ONLY','This role cannot make this change');if(write&&(req.headers.origin!==origin||typeof req.headers['x-csrf-token']!=='string'||!sameSecret(req.headers['x-csrf-token'],m.csrf)))deny(403,'STUDIO_CSRF_INVALID','Request origin or security token is invalid');return m;}
 async function authorizeTx(tx:Queryable,m:Member,owner=false){
  // Lock the membership row inside the write transaction so revocation cannot
  // race a write that checked permissions earlier in the request.
  const row=(await tx.query('SELECT m.role FROM caldock_studio_members m JOIN caldock_users u ON u.id=m.user_id JOIN caldock_sessions s ON s.user_id=u.id WHERE m.user_id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.active=true FOR UPDATE OF m',[m.id,m.sessionHash])).rows[0];
  if(!row||row.role==='viewer'||owner&&row.role!=='owner')deny(403,'STUDIO_READ_ONLY','Studio write permission is no longer available');
 }
 async function duplicate(tx:Queryable,requestId:string,m:Member){const row=(await tx.query('SELECT actor_id FROM caldock_studio_history WHERE id=$1',[requestId])).rows[0];if(row&&row.actor_id!==m.id)deny(409,'STUDIO_REQUEST_ID_REUSED','Request ID was already used');return !!row;}
 async function commit(tx:Queryable,m:Member,state:any,rev:number,path:string[],before:any,value:any,requestId:string,operation='patch',restoredFrom:string|null=null){
  const parsed=studioStateSchema.parse(state);
  await tx.query('UPDATE caldock_studio_state SET state=$1,revision=$2,updated_at=now() WHERE id=1',[JSON.stringify(parsed),rev]);
  await tx.query('INSERT INTO caldock_studio_history(id,revision,actor_id,path,before_value,after_value,operation,restored_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[requestId,rev,m.id,JSON.stringify(path),JSON.stringify(before),JSON.stringify(value),operation,restoredFrom]);
  if(db.kind==='postgres')await tx.query("SELECT pg_notify('caldock_studio_changed',$1)",[String(rev)]);
  return {revision:rev,state:parsed};
 }
 const conflict=(reply:any,current:any)=>reply.code(409).send({error:'STUDIO_FIELD_CONFLICT',detail:'The field changed. Choose a version explicitly.',current});
 app.register(async routes=>{
  routes.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.headers.origin&&req.headers.origin!==origin)deny(403,'STUDIO_ORIGIN_INVALID','Request origin is not permitted');});
  routes.get('/health',async()=>({app:'caldock-decision-studio',version:4,publicView:true,transport:'sse',teamUrl:origin+'/decision-studio/'}));
  routes.get('/me',async req=>{const {sessionHash,...user}=await requireMember(req);return {user};});
  routes.get('/state',async()=>snapshot());
  routes.get('/history',async()=>({history:(await db.query('SELECT h.id,h.revision,h.path,h.before_value AS before,h.after_value AS value,h.operation,h.restored_from,h.created_at,u.display_name AS actor FROM caldock_studio_history h JOIN caldock_users u ON u.id=h.actor_id ORDER BY revision DESC LIMIT 100')).rows}));
  routes.get('/members',async req=>{await requireMember(req);return {members:(await db.query('SELECT u.id,u.display_name AS name,u.email AS username,m.role FROM caldock_studio_members m JOIN caldock_users u ON u.id=m.user_id ORDER BY u.display_name')).rows};});
  routes.patch('/state',async(req,reply)=>{
   const m=await requireMember(req,true),input=patchInput.parse(req.body);
   if(!['scenarios','marketing'].includes(input.path[0]))deny(400,'STUDIO_INVALID_PATH','Only planning fields may be changed');
   const result=await db.transaction(async tx=>{
    await tx.query('SELECT id FROM caldock_studio_state WHERE id=1 FOR UPDATE');await authorizeTx(tx,m);
    const current=await snapshot(tx);if(await duplicate(tx,input.requestId,m))return {ok:current};
    const changed=(await tx.query('SELECT path FROM caldock_studio_history WHERE revision>$1',[input.revision])).rows.some(r=>overlap(r.path,input.path));
    if(input.revision>current.revision||changed||!isDeepStrictEqual(get(current.state,input.path),input.before))return {conflict:current};
    const next=clone(current.state);set(next,input.path,input.value,input.remove);
    return {ok:await commit(tx,m,next,current.revision+1,input.path,get(current.state,input.path),get(next,input.path),input.requestId)};
   });
   if(result.conflict)return conflict(reply,result.conflict);bus.emit('change');return result.ok;
  });
  routes.post('/import',async(req,reply)=>{
   const m=await requireMember(req,true,true),input=mutationInput.extend({state:studioStateSchema}).parse(req.body);
   const result=await db.transaction(async tx=>{await tx.query('SELECT id FROM caldock_studio_state WHERE id=1 FOR UPDATE');await authorizeTx(tx,m,true);const current=await snapshot(tx);if(await duplicate(tx,input.requestId,m))return {ok:current};if(current.revision!==input.revision)return {conflict:current};return {ok:await commit(tx,m,input.state,current.revision+1,[],current.state,input.state,input.requestId,'import')};});
   if(result.conflict)return conflict(reply,result.conflict);bus.emit('change');return result.ok;
  });
  routes.post<{Params:{id:string}}>('/history/:id/restore',async(req,reply)=>{
   const m=await requireMember(req,true),input=mutationInput.parse(req.body),restoreId=z.string().uuid().parse(req.params.id);
   const result=await db.transaction(async tx=>{await tx.query('SELECT id FROM caldock_studio_state WHERE id=1 FOR UPDATE');await authorizeTx(tx,m);const current=await snapshot(tx);if(await duplicate(tx,input.requestId,m))return {ok:current};
    const h=(await tx.query('SELECT * FROM caldock_studio_history WHERE id=$1',[restoreId])).rows[0];if(!h)deny(404,'STUDIO_HISTORY_NOT_FOUND','Revision not found');
    if(current.revision!==input.revision)return {conflict:current};
    if(!h.path.length){await authorizeTx(tx,m,true);return {ok:await commit(tx,m,h.before_value,current.revision+1,[],current.state,h.before_value,input.requestId,'restore',h.id)};}
    const next=clone(current.state);set(next,h.path,h.before_value,h.before_value===null);return {ok:await commit(tx,m,next,current.revision+1,h.path,get(current.state,h.path),h.before_value,input.requestId,'restore',h.id)};
   });if(result.conflict)return conflict(reply,result.conflict);bus.emit('change');return result.ok;
  });
  routes.put('/members/:id',async req=>{
   const m=await requireMember(req,true,true),userId=z.string().uuid().parse((req.params as any).id),input=z.object({role:z.enum(['owner','editor','viewer']).nullable(),expectedRole:z.enum(['owner','editor','viewer']).nullable()}).strict().parse(req.body);
   return db.transaction(async tx=>{await tx.query('SELECT id FROM caldock_studio_state WHERE id=1 FOR UPDATE');await authorizeTx(tx,m,true);
    const user=(await tx.query('SELECT id FROM caldock_users WHERE id=$1 AND active=true',[userId])).rows[0];if(!user)deny(404,'STUDIO_MEMBER_NOT_FOUND','The CalDock account must sign in before access can be granted');
    const old=(await tx.query('SELECT role FROM caldock_studio_members WHERE user_id=$1',[userId])).rows[0]?.role||null;
    if(old!==input.expectedRole)deny(409,'STUDIO_MEMBER_CONFLICT','Membership changed; refresh before updating');
    if(old==='owner'&&input.role!=='owner'&&Number((await tx.query("SELECT count(*) AS n FROM caldock_studio_members WHERE role='owner'")).rows[0].n)<=1)deny(409,'STUDIO_LAST_OWNER','The last owner cannot be removed');
    if(input.role)await tx.query('INSERT INTO caldock_studio_members(user_id,role) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role',[userId,input.role]);else await tx.query('DELETE FROM caldock_studio_members WHERE user_id=$1',[userId]);
    await tx.query('INSERT INTO caldock_studio_access_audit(id,actor_id,member_id,before_role,after_role) VALUES($1,$2,$3,$4,$5)',[randomUUID(),m.id,userId,old,input.role]);return {updated:true};
   });
  });
  routes.get('/live',async(req,reply)=>{
   // Public stream carries only the explicitly public planning document.
   // Member information and cookies are never sent to anonymous viewers.
   reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});reply.raw.flushHeaders();
   let ended=false,busy=false,last=-1;
   const close=()=>{if(ended)return;ended=true;clearInterval(timer);bus.off('change',push);streams.delete(close);reply.raw.end();};
   const push=async()=>{if(ended||busy)return;busy=true;try{const data=await snapshot();if(!ended&&data.revision!==last){last=data.revision;if(!reply.raw.write(`id: ${last}\ndata: ${JSON.stringify({type:'state',...data})}\n\n`))close();}}catch{close();}finally{busy=false;}};
   const timer=setInterval(()=>{if(!ended)reply.raw.write(': heartbeat\n\n');void push();},options.heartbeatMs||15000);timer.unref();
   streams.add(close);bus.on('change',push);req.raw.on('close',close);reply.raw.on('error',close);await push();
  });
 },{prefix:'/caldock/studio'});
}

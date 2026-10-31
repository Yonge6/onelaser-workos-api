import {randomUUID} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import type {Database,Queryable} from './db.js';
import {hash,readCookie,sessionCookieName} from './auth.js';
import {deny} from './errors.js';

// This bridge is confined to Studio. It creates neither a commerce identity
// provider nor a CalDock session, and never merges accounts by name or email.
export type StudioDingTalkOptions={corpId:string;allowedDepartmentIds:string[];additionalUserIds:string[];managerUserIds:string[]};
export type StudioMember={id:string;name:string;username:string;role:string;csrf:string;sessionHash:string;provider:'dingtalk'|'caldock'};

export function studioAuthentication(db:Database,secure:boolean,dingtalk?:StudioDingTalkOptions){
 async function sourceSession(tx:Queryable,sessionHash:string){
  if(!dingtalk)return null;
  return (await tx.query(`SELECT u.id,u.display_name,u.role,s.csrf_token,e.external_user_id
   FROM sessions s JOIN users u ON u.id=s.user_id
   JOIN external_identities e ON e.user_id=u.id AND e.provider='dingtalk'
   WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true
   AND u.org_id=$2 AND e.corp_id=$2
   AND (e.external_department_id=ANY($3::text[]) OR e.external_user_id=ANY($4::text[]))
   FOR UPDATE OF s,u,e`,[sessionHash,dingtalk.corpId,dingtalk.allowedDepartmentIds,dingtalk.additionalUserIds])).rows[0]||null;
 }
 const canBootstrap=(source:any)=>source.role==='manager'&&dingtalk!.managerUserIds.includes(source.external_user_id);
 async function mappedMember(tx:Queryable,source:any,sessionHash:string,enroll:boolean):Promise<StudioMember|null>{
  let mapping=(await tx.query('SELECT * FROM caldock_studio_dingtalk_members WHERE workos_user_id=$1 FOR UPDATE',[source.id])).rows[0];
  if(!mapping&&enroll){
   const actorId=randomUUID(),bootstrap=canBootstrap(source);
   await tx.query('INSERT INTO caldock_users(id,display_name) VALUES($1,$2)',[actorId,source.display_name]);
   await tx.query('INSERT INTO caldock_studio_dingtalk_members(workos_user_id,caldock_user_id,bootstrap_owner) VALUES($1,$2,$3)',[source.id,actorId,bootstrap]);
   await tx.query('INSERT INTO caldock_studio_members(user_id,role) VALUES($1,$2)',[actorId,bootstrap?'owner':'viewer']);
   mapping={caldock_user_id:actorId,bootstrap_owner:bootstrap};
  }
  if(!mapping)return null;
  // The mapping survives member removal. Re-login never re-enrolls a revoked
  // member. Automatic owner grants are permanently downgraded once ineligible;
  // an owner's later explicit Studio grant is tracked separately.
  if(mapping.bootstrap_owner&&!canBootstrap(source)){
   await tx.query("UPDATE caldock_studio_members SET role='viewer' WHERE user_id=$1 AND role='owner'",[mapping.caldock_user_id]);
   await tx.query('UPDATE caldock_studio_dingtalk_members SET bootstrap_owner=false WHERE workos_user_id=$1',[source.id]);
  }
  const row=(await tx.query(`SELECT u.id,u.display_name,m.role FROM caldock_users u
   JOIN caldock_studio_members m ON m.user_id=u.id
   WHERE u.id=$1 AND u.active=true FOR UPDATE OF u,m`,[mapping.caldock_user_id])).rows[0];
  if(!row)return null;
  if(row.display_name!==source.display_name)await tx.query('UPDATE caldock_users SET display_name=$2 WHERE id=$1',[row.id,source.display_name]);
  return {id:row.id,name:source.display_name,username:row.id,role:row.role,csrf:source.csrf_token,sessionHash,provider:'dingtalk'};
 }
 async function member(req:FastifyRequest):Promise<StudioMember|null>{
  const workosCookie=readCookie(req.headers.cookie,sessionCookieName(secure));
  if(workosCookie&&dingtalk){
   const result=await db.transaction(async tx=>{const tokenHash=hash(workosCookie),source=await sourceSession(tx,tokenHash);return source?mappedMember(tx,source,tokenHash,true):null;});
   if(result)return result;
  }
  const caldockCookie=readCookie(req.headers.cookie,(secure?'__Host-':'')+'caldock_session');if(!caldockCookie)return null;
  const sessionHash=hash(caldockCookie);
  const row=(await db.query(`SELECT u.id,u.display_name,u.email,s.csrf_token,m.role FROM caldock_sessions s
   JOIN caldock_users u ON u.id=s.user_id JOIN caldock_studio_members m ON m.user_id=u.id
   WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[sessionHash])).rows[0];
  return row?{id:row.id,name:row.display_name,username:row.email||row.id,role:row.role,csrf:row.csrf_token,sessionHash,provider:'caldock'}:null;
 }
 async function authorizeTx(tx:Queryable,m:StudioMember,owner=false){
  let role:string|undefined;
  if(m.provider==='dingtalk'){
   const source=await sourceSession(tx,m.sessionHash);
   const current=source?await mappedMember(tx,source,m.sessionHash,false):null;
   if(current?.id===m.id)role=current.role;
  }else{
   // Lock the session and active user as well as membership so source logout,
   // account deactivation and membership revocation serialize with the write.
   role=(await tx.query(`SELECT m.role FROM caldock_studio_members m
    JOIN caldock_users u ON u.id=m.user_id JOIN caldock_sessions s ON s.user_id=u.id
    WHERE m.user_id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND u.active=true
    FOR UPDATE OF m,u,s`,[m.id,m.sessionHash])).rows[0]?.role;
  }
  if(!role||role==='viewer'||owner&&role!=='owner')deny(403,'STUDIO_READ_ONLY','Studio write permission is no longer available');
 }
 async function eligibleOwnerCount(tx:Queryable,excludeUserId:string){
  // A stored owner who cannot pass the source policy must not let the last
  // usable owner remove themselves. Login/session presence is not required.
  const rows=(await tx.query(`SELECT d.workos_user_id,d.bootstrap_owner,u.active,u.org_id,u.role,e.corp_id,e.external_user_id,e.external_department_id
   FROM caldock_studio_members m JOIN caldock_users c ON c.id=m.user_id AND c.active=true
   LEFT JOIN caldock_studio_dingtalk_members d ON d.caldock_user_id=c.id
   LEFT JOIN users u ON u.id=d.workos_user_id
   LEFT JOIN external_identities e ON e.user_id=u.id AND e.provider='dingtalk' AND e.corp_id=u.org_id
   WHERE m.role='owner' AND m.user_id<>$1`,[excludeUserId])).rows;
  return rows.filter(row=>!row.workos_user_id||!!dingtalk&&row.active&&row.org_id===dingtalk.corpId&&row.corp_id===dingtalk.corpId
   &&(dingtalk.allowedDepartmentIds.includes(row.external_department_id)||dingtalk.additionalUserIds.includes(row.external_user_id))
   &&(!row.bootstrap_owner||canBootstrap(row))).length;
 }
 return {member,authorizeTx,eligibleOwnerCount};
}

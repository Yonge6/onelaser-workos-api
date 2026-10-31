import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,type Database,type Queryable} from '../src/db.js';
import {hash,issueSession} from '../src/auth.js';
import {issueCaldockSession} from '../src/caldock.js';
import type {DingTalkProfile} from '../src/integrations/dingtalk.js';
import type {IntegrationOptions} from '../src/integrations/routes.js';

const origin='https://craftos.example.test',corp='studio-test-corp',prefix='/caldock/studio';
let db:Database,admin:Database|undefined,namespace:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const profiles=new Map<string,DingTalkProfile>();
const integrations:IntegrationOptions={corpId:corp,appPublicUrl:origin,teamMode:'company',allowedDepartmentIds:['42'],additionalUserIds:['additional'],managerUserIds:['owner','demoted','config-removed','guard-owner','late-manager'],dingtalk:{
 authorizationUrl(state){return 'https://login.dingtalk.com/oauth2/auth?state='+state;},
 async authenticate(code){const profile=profiles.get(code);assert(profile);return profile;},
 async listDepartmentUsers(){return [...profiles.values()];},async sendWorkNotification(){return {taskId:'unused'};}
}};
before(async()=>{
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});namespace='studio_ding_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${namespace}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+namespace);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);app=await buildApp({db,environment:'production',closeDatabase:false,integrations,caldock:{publicUrl:origin}});
});
after(async()=>{await app?.close();await db?.close();if(admin&&namespace){await admin.exec(`DROP SCHEMA ${namespace} CASCADE`);await admin.close();}});
function profile(code:string,role:'manager'|'employee'='employee',departmentId='42'){
 profiles.set(code,{externalUserId:code,unionId:'union-'+code,name:'Person '+code,departmentId,departmentName:'Verified team',role});
}
async function start(query='destination=caldock-studio&lang=en',application=app){
 const response=await application.inject('/auth/dingtalk/start?'+query);assert.equal(response.statusCode,302,response.body);
 return {state:new URL(response.headers.location!).searchParams.get('state')!,nonce:String(response.headers['set-cookie']).split(';')[0]};
}
async function login(code:string,application=app){
 const state=await start(undefined,application),response=await application.inject({url:'/auth/dingtalk/callback?'+new URLSearchParams({state:state.state,authCode:code}),headers:{cookie:state.nonce}});
 assert.equal(response.statusCode,302,response.body);assert.equal(response.headers.location,origin+'/decision-studio/?tab=team&lang=en');
 const cookie=[response.headers['set-cookie']].flat().map(String).find(v=>v.startsWith('__Host-workos_session='))!.split(';')[0];
 const session=(await db.query('SELECT user_id,csrf_token FROM sessions WHERE token_hash=$1',[hash(cookie.split('=')[1])])).rows[0];
 return {cookie,csrf:session.csrf_token as string,sourceId:session.user_id as string};
}
type Session=Awaited<ReturnType<typeof login>>;
const me=(session:Session,application=app)=>application.inject({url:prefix+'/me',headers:{cookie:session.cookie}});
const send=(s:Session,method:any,path:string,payload?:any,extra:Record<string,string>={})=>app.inject({method,url:prefix+path,payload,headers:{cookie:s.cookie,origin,'x-csrf-token':s.csrf,...extra}});
async function patch(s:Session,extra:Record<string,string>={}){const snapshot=(await app.inject(prefix+'/state')).json(),path=['scenarios','pilot','values','monthly'];return send(s,'PATCH','/state',{path,before:snapshot.state.scenarios.pilot.values.monthly,value:snapshot.state.scenarios.pilot.values.monthly+1,revision:snapshot.revision,requestId:randomUUID()},extra);}
let owner:Session,ownerId:string;
test('health advertises existing DingTalk login; public reading stays anonymous',async()=>{
 const health=(await app.inject(prefix+'/health')).json();assert.deepEqual(health.auth,{provider:'dingtalk',loginEnabled:true,loginUrl:'/api/auth/dingtalk/start?destination=caldock-studio'});assert.equal(health.publicView,true);
 assert.equal((await app.inject(prefix+'/state')).statusCode,200);assert.equal((await app.inject(prefix+'/history')).statusCode,200);assert.equal((await app.inject(prefix+'/members')).statusCode,403);
});
test('Studio OAuth destination and language are nonce-bound, fixed, one-use, and separate from Bot returns',async()=>{
 profile('oauth');
 for(const query of ['destination=https://evil.example','destination=caldock-studio&lang=fr','destination=caldock-studio&oauth_request=anything','destination=caldock-studio&lang=zh&lang=en'])assert.equal((await app.inject('/auth/dingtalk/start?'+query)).statusCode,400);
 const s=await start('destination=caldock-studio&lang=en&returnTo=https://evil.example'),url='/auth/dingtalk/callback?'+new URLSearchParams({state:s.state,authCode:'oauth',lang:'zh',destination:'other',returnTo:'https://evil.example',oauth_request:'attacker'});
 assert.equal((await app.inject(url)).statusCode,400);
 assert.equal((await app.inject({url,headers:{cookie:'__Host-workos_oauth='+randomBytes(32).toString('base64url')}})).statusCode,400);
 const response=await app.inject({url,headers:{cookie:s.nonce}});assert.equal(response.statusCode,302,response.body);assert.equal(response.headers.location,origin+'/decision-studio/?tab=team&lang=en');
 const cookies=[response.headers['set-cookie']].flat().map(String);assert(cookies.some(v=>v.startsWith('__Host-workos_session=')&&v.includes('HttpOnly')&&v.includes('Secure')&&v.includes('SameSite=Lax')));assert(!cookies.some(v=>v.includes('caldock_session')));
 assert.equal((await app.inject({url,headers:{cookie:s.nonce}})).statusCode,400);
 const defaults=await start('destination=caldock-studio'),post=await app.inject({method:'POST',url:'/auth/dingtalk/callback',headers:{cookie:defaults.nonce},payload:{state:defaults.state,authCode:'oauth',returnTo:'https://evil.example'}});assert.equal(post.headers.location,origin+'/decision-studio/?tab=team&lang=zh');
 const workos=await start('lang=en'),normal=await app.inject({url:'/auth/dingtalk/callback?'+new URLSearchParams({state:workos.state,authCode:'oauth',destination:'caldock-studio'}),headers:{cookie:workos.nonce}});assert.equal(normal.headers.location,origin);
});
test('only explicit configured managers bootstrap owner; verified staff are viewers with stable separate actors',async()=>{
 profile('owner','manager');owner=await login('owner');const user=(await me(owner)).json().user;ownerId=user.id;assert.equal(user.role,'owner');assert.equal(user.provider,'dingtalk');assert.equal(user.csrf,owner.csrf);assert.equal(user.sessionHash,undefined);assert.notEqual(user.id,owner.sourceId);
 profile('employee');profile('unlisted-manager','manager');
 for(const code of ['employee','unlisted-manager']){const s=await login(code),user=(await me(s)).json().user;assert.equal(user.role,'viewer');assert.equal((await patch(s)).statusCode,403);assert.notEqual(user.id,s.sourceId);}
 const same=await login('employee'),first=(await me(same)).json().user;
 profiles.get('employee')!.name='Updated display name';const later=await login('employee'),second=(await me(later)).json().user;assert.equal(first.id,second.id);assert.equal(second.name,'Updated display name');
 const members=(await send(owner,'GET','/members')).json().members;assert(members.some((m:any)=>m.id===second.id&&m.provider==='dingtalk'&&m.role==='viewer'));
 const count=await db.query('SELECT count(*) AS n FROM caldock_studio_dingtalk_members WHERE workos_user_id=$1',[later.sourceId]);assert.equal(Number(count.rows[0].n),1);
});
test('first enrollment is stable across concurrent sessions and later source manager promotion does not auto-grant ownership',async()=>{
 profile('late-manager');const one=await login('late-manager'),two=await login('late-manager'),responses=await Promise.all([me(one),me(two)]);
 const first=responses[0].json().user;assert.equal(first.role,'viewer');assert.equal(responses[1].json().user.id,first.id);
 profiles.get('late-manager')!.role='manager';const promoted=(await me(await login('late-manager'))).json().user;assert.equal(promoted.id,first.id);assert.equal(promoted.role,'viewer');
});
test('explicit owner promotion enables editing with WorkOS CSRF and stable history, without commerce privileges',async()=>{
 const employee=await login('employee'),actor=(await me(employee)).json().user;
 const grant=await send(owner,'PUT','/members/'+actor.id,{role:'editor',expectedRole:'viewer'});assert.equal(grant.statusCode,200,grant.body);
 assert.equal((await patch(employee,{'x-csrf-token':'wrong'})).statusCode,403);assert.equal((await patch(employee,{origin:'https://evil.example'})).statusCode,403);
 const result=await patch(employee);assert.equal(result.statusCode,200,result.body);
 const history=(await db.query('SELECT actor_id FROM caldock_studio_history ORDER BY revision DESC LIMIT 1')).rows[0];assert.equal(history.actor_id,actor.id);
 for(const path of ['/caldock/me','/caldock/admin/summary'])assert.equal((await app.inject({url:path,headers:{cookie:employee.cookie}})).statusCode,401,path);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM caldock_sessions WHERE user_id=$1',[actor.id])).rows[0].n),0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM caldock_identities WHERE user_id=$1',[actor.id])).rows[0].n),0);
});
test('removed membership is never auto-regranted after re-login or reactivation; owner can explicitly restore it',async()=>{
 const employee=await login('employee'),actor=(await me(employee)).json().user;
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:null,expectedRole:'editor'})).statusCode,200);
 assert.equal((await me(employee)).statusCode,403);await db.query('UPDATE users SET active=false WHERE id=$1',[employee.sourceId]);assert.equal((await me(employee)).statusCode,403);
 const relogin=await login('employee');assert.equal((await me(relogin)).statusCode,403);
 const members=(await send(owner,'GET','/members')).json().members;assert(members.some((m:any)=>m.id===actor.id&&m.role===null&&m.provider==='dingtalk'));
 const viewer=await login('unlisted-manager');assert(!(await send(viewer,'GET','/members')).json().members.some((m:any)=>m.id===actor.id));
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:'editor',expectedRole:null})).statusCode,200);assert.equal((await me(relogin)).json().user.id,actor.id);assert.equal((await patch(relogin)).statusCode,200);
});
test('bootstrap owners permanently fall back to viewer after source demotion; explicit grants remain independent',async()=>{
 profile('demoted','manager');const s=await login('demoted'),actor=(await me(s)).json().user;assert.equal(actor.role,'owner');
 await db.query("UPDATE users SET role='employee' WHERE id=$1",[s.sourceId]);assert.equal((await me(s)).json().user.role,'viewer');assert.equal((await patch(s)).statusCode,403);
 await db.query("UPDATE users SET role='manager' WHERE id=$1",[s.sourceId]);assert.equal((await me(s)).json().user.role,'viewer');
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:'owner',expectedRole:'viewer'})).statusCode,200);
 await db.query("UPDATE users SET role='employee' WHERE id=$1",[s.sourceId]);assert.equal((await me(s)).json().user.role,'owner');
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:null,expectedRole:'owner'})).statusCode,200);assert.equal((await me(await login('demoted'))).statusCode,403);
});
test('removing configured manager allowlist authority downgrades bootstrap owner without regrant on config restoration',async()=>{
 profile('config-removed','manager');const s=await login('config-removed');assert.equal((await me(s)).json().user.role,'owner');
 const without=await buildApp({db,environment:'production',closeDatabase:false,integrations:{...integrations,managerUserIds:[]},caldock:{publicUrl:origin}});
 try{assert.equal((await me(s,without)).json().user.role,'viewer');}finally{await without.close();}
 assert.equal((await me(s)).json().user.role,'viewer');
});
test('last-owner protection counts only other usable owners and does not turn no-op grants into explicit bootstrap overrides',async()=>{
 profile('guard-owner','manager');const backup=await login('guard-owner'),actor=(await me(backup)).json().user;assert.equal(actor.role,'owner');
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:'owner',expectedRole:'owner'})).statusCode,200);
 assert.equal((await db.query('SELECT bootstrap_owner FROM caldock_studio_dingtalk_members WHERE workos_user_id=$1',[backup.sourceId])).rows[0].bootstrap_owner,true);
 for(const [sql,params,undo,undoParams] of [
  ['UPDATE users SET active=false WHERE id=$1',[backup.sourceId],'UPDATE users SET active=true WHERE id=$1',[backup.sourceId]],
  ['UPDATE caldock_users SET active=false WHERE id=$1',[actor.id],'UPDATE caldock_users SET active=true WHERE id=$1',[actor.id]],
  ['UPDATE users SET org_id=$2 WHERE id=$1',[backup.sourceId,'other-corp'],'UPDATE users SET org_id=$2 WHERE id=$1',[backup.sourceId,corp]],
  ['UPDATE external_identities SET external_department_id=$2 WHERE user_id=$1',[backup.sourceId,'outside'],'UPDATE external_identities SET external_department_id=$2 WHERE user_id=$1',[backup.sourceId,'42']],
  ["UPDATE users SET role='employee' WHERE id=$1",[backup.sourceId],"UPDATE users SET role='manager' WHERE id=$1",[backup.sourceId]],
 ] as [string,unknown[],string,unknown[]][]){await db.query(sql,params);const response=await send(owner,'PUT','/members/'+ownerId,{role:'viewer',expectedRole:'owner'});assert.equal(response.statusCode,409,sql+' '+response.body);assert.equal(response.json().error.code,'STUDIO_LAST_OWNER');await db.query(undo,undoParams);}
 const narrower=await buildApp({db,environment:'production',closeDatabase:false,integrations:{...integrations,managerUserIds:['owner']},caldock:{publicUrl:origin}});
 try{const response=await narrower.inject({method:'PUT',url:prefix+'/members/'+ownerId,headers:{cookie:owner.cookie,origin,'x-csrf-token':owner.csrf},payload:{role:null,expectedRole:'owner'}});assert.equal(response.statusCode,409,response.body);}finally{await narrower.close();}
 // Removing an unusable other owner is allowed: the requesting owner remains.
 await db.query('UPDATE users SET active=false WHERE id=$1',[backup.sourceId]);assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:null,expectedRole:'owner'})).statusCode,200);
});
test('source enterprise, actual department, active status and one-hour session are checked on every request',async()=>{
 profile('scope-check');let s=await login('scope-check');const actor=(await me(s)).json().user;
 assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:'editor',expectedRole:'viewer'})).statusCode,200);
 for(const [sql,params,undo,undoParams] of [
  ['UPDATE users SET active=false WHERE id=$1',[s.sourceId],'UPDATE users SET active=true WHERE id=$1',[s.sourceId]],
  ['UPDATE users SET org_id=$2 WHERE id=$1',[s.sourceId,'other-corp'],'UPDATE users SET org_id=$2 WHERE id=$1',[s.sourceId,corp]],
  ['UPDATE external_identities SET corp_id=$2 WHERE user_id=$1',[s.sourceId,'other-corp'],'UPDATE external_identities SET corp_id=$2 WHERE user_id=$1',[s.sourceId,corp]],
  ['UPDATE external_identities SET external_department_id=$2 WHERE user_id=$1',[s.sourceId,'outside'],'UPDATE external_identities SET external_department_id=$2 WHERE user_id=$1',[s.sourceId,'42']],
 ] as [string,unknown[],string,unknown[]][]){await db.query(sql,params);assert.equal((await me(s)).statusCode,403,sql);assert.equal((await patch(s)).statusCode,403,sql);await db.query(undo,undoParams);}
 const tokenHash=hash(s.cookie.split('=')[1]);await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[tokenHash]);assert.equal((await me(s)).statusCode,403);assert.equal((await patch(s)).statusCode,403);
 s=await login('scope-check');assert.equal((await me(s)).json().user.id,actor.id);
 const malformed=await issueSession(db,s.sourceId);await db.query('DELETE FROM external_identities WHERE user_id=$1',[s.sourceId]);assert.equal((await me({...s,cookie:'__Host-workos_session='+malformed.accessToken})).statusCode,403);
});
test('explicit additional members qualify without extending access to the rest of their department',async()=>{
 profile('additional','employee','outside');const s=await login('additional');assert.equal((await me(s)).json().user.role,'viewer');
 const id=randomUUID();await db.query('INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5)',[id,corp,'company','Other outside employee','employee']);
 await db.query('INSERT INTO external_identities(provider,corp_id,external_user_id,union_id,user_id,external_department_id) VALUES($1,$2,$3,$4,$5,$6)',['dingtalk',corp,'other-outside','union-other',id,'outside']);
 const token=await issueSession(db,id);assert.equal((await me({sourceId:id,csrf:'unused',cookie:'__Host-workos_session='+token.accessToken})).statusCode,403);
});
test('write transaction rechecks source session after preliminary authorization',async()=>{
 profile('race');const s=await login('race'),actor=(await me(s)).json().user;assert.equal((await send(owner,'PUT','/members/'+actor.id,{role:'editor',expectedRole:'viewer'})).statusCode,200);
 const before=(await app.inject(prefix+'/state')).json(),original=db.transaction.bind(db);let injected=false;
 db.transaction=async<T>(fn:(tx:Queryable)=>Promise<T>)=>original(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{const result=await tx.query<T>(sql,params);if(!injected&&sql==='SELECT id FROM caldock_studio_state WHERE id=1 FOR UPDATE'){injected=true;await tx.query('DELETE FROM sessions WHERE token_hash=$1',[hash(s.cookie.split('=')[1])]);}return result;}}));
 try{assert.equal((await patch(s)).statusCode,403);assert(injected);}finally{db.transaction=original;}
 assert.deepEqual((await app.inject(prefix+'/state')).json(),before);
});
test('WorkOS logout uses its own CSRF and immediately removes Studio editing access',async()=>{
 profile('logout');const s=await login('logout');assert.equal((await me(s)).statusCode,200);
 const reject=await app.inject({method:'DELETE',url:'/auth/session',headers:{cookie:s.cookie,origin,'x-csrf-token':'wrong'}});assert.equal(reject.statusCode,403);
 const response=await app.inject({method:'DELETE',url:'/auth/session',headers:{cookie:s.cookie,origin,'x-csrf-token':s.csrf}});assert.equal(response.statusCode,200,response.body);assert.equal((await me(s)).statusCode,403);
});
test('legacy CalDock membership still works and its identity is never merged by name or email',async()=>{
 const id=randomUUID();await db.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[id,'Person owner','owner@example.test']);await db.query("INSERT INTO caldock_studio_members(user_id,role) VALUES($1,'editor')",[id]);
 const s=await issueCaldockSession(db,id),response=await app.inject({url:prefix+'/me',headers:{cookie:'__Host-caldock_session='+s.token}});assert.equal(response.json().user.id,id);assert.equal(response.json().user.provider,'caldock');assert.notEqual(id,ownerId);
 const disabled=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin}});try{assert.equal((await disabled.inject(prefix+'/health')).json().auth.loginEnabled,false);assert.equal((await me(owner,disabled)).statusCode,403);}finally{await disabled.close();}
});
test('additive schema migration is repeatable and preserves mappings, explicit permissions and plan history',async()=>{
 const mappings=(await db.query('SELECT * FROM caldock_studio_dingtalk_members ORDER BY workos_user_id')).rows;
 const members=(await db.query('SELECT * FROM caldock_studio_members ORDER BY user_id')).rows;
 const state=(await app.inject(prefix+'/state')).json(),history=(await app.inject(prefix+'/history')).json();
 await db.exec(schema);
 assert.deepEqual((await db.query('SELECT * FROM caldock_studio_dingtalk_members ORDER BY workos_user_id')).rows,mappings);
 assert.deepEqual((await db.query('SELECT * FROM caldock_studio_members ORDER BY user_id')).rows,members);
 assert.deepEqual((await app.inject(prefix+'/state')).json(),state);assert.deepEqual((await app.inject(prefix+'/history')).json(),history);
});

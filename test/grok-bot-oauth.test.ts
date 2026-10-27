import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase,schema,seedDemo,type Database } from '../src/db.js';
import { issueSession,hash } from '../src/auth.js';
import { GrokBotAdapter } from '../src/integrations/grok-bot.js';
import { BotOAuthService,BOT_OAUTH_PREFIX,BOT_OAUTH_WELL_KNOWN,validatedBotRedirects,type BotOAuthConfig } from '../src/integrations/grok-bot-oauth.js';
import { integrationOptionsFromEnv } from '../src/integrations/routes.js';

const origin='https://work.example',resource=origin+'/api/integrations/grok-bot/mcp',scope='workos.review';
const callback='https://bot.example/callback?from=workos',verifier='a'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
const prefix=BOT_OAUTH_PREFIX,worker='synthetic-old-static-worker-token-with-32-characters';
const fromExternal=(value:string)=>value.startsWith('/api/')?value.slice(4):value;
const decoded=(value:string)=>value.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
function callbackIn(html:string){const match=/href="((?:https?|cursor):[^\"]+)"/.exec(html);assert(match,'Completion must contain an explicit verified callback link');return new URL(decoded(match[1]));}
async function harness(t:TestContext,override:Partial<BotOAuthConfig>={},webhook=true){
  let admin:Database|undefined,db:Database|undefined,isolated:string|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{try{if(app)await app.close();else if(db)await db.close();}finally{if(admin){try{if(isolated)await admin.exec(`DROP SCHEMA ${isolated} CASCADE`);}finally{await admin.close();}}}});
  if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});isolated='workos_oauth_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${isolated}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${isolated}`);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
  await db.exec(schema);await seedDemo(db);
  await db.query('INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5)',['other-manager','other','marketing','Foreign manager','manager']);
  for(const id of ['m1','m2','m3','m4','m5','other-manager'])await db.query('INSERT INTO external_identities(provider,corp_id,external_user_id,union_id,user_id) VALUES($1,$2,$3,$4,$5)',['dingtalk',id==='other-manager'?'other':'demo',id,'union-'+id,id]);
  let dispatches=0;
  const bot=webhook?new GrokBotAdapter({webhookUrl:'https://hooks.synthetic.example/workos',allowedHost:'hooks.synthetic.example',webhookSecret:'synthetic-routine-secret',workerToken:worker,orgId:'demo'},async()=>{dispatches++;return new Response('{}',{status:200});}):undefined;
  const config:BotOAuthConfig={publicUrl:origin,orgId:'demo',redirectUris:[callback],secureCookies:true,...override};
  const ding={authorizationUrl:(state:string)=>'https://login.dingtalk.com/oauth2/auth?state='+state,async authenticate(){return {externalUserId:'m1',unionId:'union-m1',name:'Manager',departmentId:'42',departmentName:'Synthetic department',role:'manager' as const};},async listDepartmentUsers(){return [];},async sendWorkNotification(){throw new Error('No real notifications');}};
  app=await buildApp({db,environment:'production',integrations:{aiReviewMode:'bot',botMcpAuthMode:'oauth',botOAuth:config,bot,dingtalk:ding,corpId:'demo',appPublicUrl:origin}});
  const sessions:Record<string,{token:string;cookie:string;csrf:string}>={};
  for(const id of ['m1','m2','m3','m4','m5','other-manager']){const s=await issueSession(db,id);const csrf=(await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1',[hash(s.accessToken)])).rows[0].csrf_token;sessions[id]={token:s.accessToken,cookie:'__Host-workos_session='+s.accessToken,csrf};}
  const call=(user:string,method:'GET'|'POST',url:string,payload?:unknown,headers:Record<string,string>={})=>app!.inject({method,url,payload:payload as any,headers:{authorization:'Bearer '+sessions[user].token,'accept-language':'en',...headers}});
  const form=(url:string,body:Record<string,string>,headers:Record<string,string>={})=>app!.inject({method:'POST',url:fromExternal(url),payload:new URLSearchParams(body).toString(),headers:{'content-type':'application/x-www-form-urlencoded','accept-language':'en',...headers}});
  async function register(redirectUris=config.redirectUris){const response=await app!.inject({method:'POST',url:prefix+'/register',payload:{client_name:'Synthetic Bot <not verified>',redirect_uris:redirectUris,token_endpoint_auth_method:'none'}});assert.equal(response.statusCode,201,response.body);return response.json();}
  async function pending(clientId:string,extra:Record<string,string>={}){
    const input={response_type:'code',client_id:clientId,redirect_uri:config.redirectUris[0],resource,scope,state:'state + 中文 &?=%',code_challenge:challenge,code_challenge_method:'S256',...extra};
    const response=await app!.inject(prefix+'/authorize?'+new URLSearchParams(input));assert.equal(response.statusCode,302,response.body);
    const path=String(response.headers.location),nonce=String(response.headers['set-cookie']).split(';')[0];return {input,path:fromExternal(path),externalPath:path,nonce};
  }
  async function approve(clientId?:string,extra:Record<string,string>={}){
    const client=clientId|| (await register()).client_id,p=await pending(client,extra),response=await form(p.path,{decision:'approve',csrf_token:sessions.m1.csrf,lang:'en',theme:'dark'},{cookie:p.nonce+'; '+sessions.m1.cookie,origin});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.headers.location,undefined);const redirect=callbackIn(response.body);return {...p,clientId:client,code:redirect.searchParams.get('code')!,redirect};
  }
  const exchange=(approved:Awaited<ReturnType<typeof approve>>,extra:Record<string,string>={})=>form(prefix+'/token',{grant_type:'authorization_code',client_id:approved.clientId,resource,code:approved.code,redirect_uri:approved.input.redirect_uri,code_verifier:verifier,...extra});
  const refresh=(clientId:string,token:string,extra:Record<string,string>={})=>form(prefix+'/token',{grant_type:'refresh_token',client_id:clientId,resource,refresh_token:token,...extra});
  const mcp=(token:string,method='tools/list',params:unknown={})=>app!.inject({method:'POST',url:'/integrations/grok-bot/mcp',headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},payload:{jsonrpc:'2.0',id:1,method,params}});
  return {db,app,config,sessions,call,form,register,pending,approve,exchange,refresh,mcp,dispatches:()=>dispatches};
}

test('OAuth mode fails closed without an explicit redirect allowlist; no worker secret or webhook is needed for discovery',async t=>{
  const h=await harness(t,{redirectUris:[]},false);for(const path of BOT_OAUTH_WELL_KNOWN)assert.equal((await h.app.inject(path)).statusCode,503);
  assert.equal((await h.mcp(worker)).statusCode,503);const capabilities=(await h.app.inject('/capabilities')).json();assert.equal(capabilities.botMcpAuthMode,'oauth');assert.equal(capabilities.aiReview,'not_integrated');assert.equal(capabilities.devLogin,false);
  const env=integrationOptionsFromEnv({AI_REVIEW_MODE:'bot',GROK_BOT_MCP_AUTH_MODE:'oauth',DINGTALK_CORP_ID:'demo',APP_PUBLIC_URL:origin});assert(env.setup?.aiMissing.includes('GROK_BOT_OAUTH_REDIRECT_URIS'));assert(!env.setup?.aiMissing.includes('GROK_BOT_WORKER_TOKEN'));
});
test('Discovery binds complete public API resource, issuer and safe public-client PKCE endpoints',async t=>{
  const h=await harness(t,{},false),pr=(await h.app.inject('/.well-known/oauth-protected-resource/api/integrations/grok-bot/mcp')).json(),as=(await h.app.inject('/.well-known/oauth-authorization-server')).json();
  assert.equal(pr.resource,resource);assert.deepEqual(pr.authorization_servers,[origin]);assert.deepEqual(pr.scopes_supported,[scope]);assert.equal(as.authorization_endpoint,origin+'/api'+prefix+'/authorize');assert.equal(as.token_endpoint,origin+'/api'+prefix+'/token');assert.equal(as.registration_endpoint,origin+'/api'+prefix+'/register');assert.equal(as.authorization_response_iss_parameter_supported,true);assert.equal(as.client_id_metadata_document_supported,false);assert.deepEqual(as.code_challenge_methods_supported,['S256']);
  const response=await h.mcp('invalid');assert.equal(response.statusCode,401);assert.match(String(response.headers['www-authenticate']),/resource_metadata="https:\/\/work.example\/\.well-known\/oauth-protected-resource"/);
});
test('Redirect configuration allows only exact pinned HTTPS, one Cursor scheme, and explicit literal loopback port/path',()=>{
  for(const uri of [callback,'cursor://anysphere.cursor-mcp/oauth/callback','http://localhost:8787/callback','http://127.0.0.1:8787/callback','http://[::1]:8787/callback','http://localhost:80/callback'])assert.deepEqual(validatedBotRedirects(uri),[uri]);
  for(const uri of ['https://bot.example/callback#','https://user:secret@bot.example/callback','https://bot.example/*','cursor://other/oauth/callback','cursor://anysphere.cursor-mcp/oauth/callback?x=1','Cursor://anysphere.cursor-mcp/oauth/callback','cursor://anysphere.cursor-mcp:99/oauth/callback','cursor://anysphere.cursor-mcp/oauth/other','http://localhost/callback','http://localhost:8787','http://localhost.:8787/callback','http://localhost.evil:8787/callback','http://127.1:8787/callback','http://2130706433:8787/callback','http://0x7f000001:8787/callback','http://0.0.0.0:8787/callback','http://[::ffff:127.0.0.1]:8787/callback','http://127.0.0.1:8787/../callback','javascript:alert(1)'])assert.throws(()=>validatedBotRedirects(uri),uri);
});
test('DCR grants no permission, rejects unapproved redirects/auth/grants, and is durably bounded',async t=>{
  const h=await harness(t);for(const payload of [{redirect_uris:['https://evil.example/callback']},{redirect_uris:[callback],token_endpoint_auth_method:'client_secret_basic'},{redirect_uris:[callback],grant_types:['client_credentials']}])assert.equal((await h.app.inject({method:'POST',url:prefix+'/register',payload})).statusCode,400);
  const client=await h.register();assert.equal(client.token_endpoint_auth_method,'none');assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),0);assert.equal((await h.mcp(client.client_id)).statusCode,401);
  await h.db.query('UPDATE bot_oauth_registration_budgets SET attempts=10');const limited=await h.app.inject({method:'POST',url:prefix+'/register',payload:{redirect_uris:[callback]}});assert.equal(limited.statusCode,429);
  await h.db.query('UPDATE bot_oauth_registration_budgets SET attempts=1');
  for(let index=0;index<49;index++)await h.db.query('INSERT INTO bot_oauth_clients(id,org_id,name,redirect_uris,grant_types) VALUES($1,$2,$3,$4,$5)',['wos_client_'+randomUUID(),'demo','Synthetic unused client',JSON.stringify([callback]),JSON.stringify(['authorization_code','refresh_token'])]);
  assert.equal((await h.app.inject({method:'POST',url:prefix+'/register',payload:{redirect_uris:[callback]}})).statusCode,429);
});
test('Expired unused DCR clients release capacity without deleting active requests, grant history or the pinned client',async t=>{
  const pinned='https://client.example/pinned.json',h=await harness(t,{preRegisteredClientId:pinned}),authorized=await h.register(),approved=await h.approve(authorized.client_id),active=await h.register(),pending=await h.pending(active.client_id),expired=await h.register(),expiredRequest=await h.pending(expired.client_id);
  await h.db.query('UPDATE bot_oauth_requests SET expires_at=$2 WHERE id=$1',[expiredRequest.path.split('/').at(-1),'2000-01-01T00:00:00Z']);
  for(let index=0;index<47;index++)await h.db.query('INSERT INTO bot_oauth_clients(id,org_id,name,redirect_uris,grant_types) VALUES($1,$2,$3,$4,$5)',['wos_client_'+randomUUID(),'demo','Synthetic abandoned client',JSON.stringify([callback]),JSON.stringify(['authorization_code','refresh_token'])]);
  await h.db.query("UPDATE bot_oauth_clients SET created_at=now()-interval '2 hours'");
  const fresh=await h.register();assert(fresh.client_id);
  const remaining=(await h.db.query('SELECT id FROM bot_oauth_clients')).rows.map(row=>row.id);
  assert.equal(remaining.length,4);assert(remaining.includes(pinned));assert(remaining.includes(authorized.client_id));assert(remaining.includes(active.client_id));assert(!remaining.includes(expired.client_id));
  assert.equal((await h.app.inject({url:pending.path,headers:{cookie:pending.nonce+'; '+h.sessions.m1.cookie}})).statusCode,200);assert.equal((await h.exchange(approved)).statusCode,200);
  assert.equal((await h.db.query('SELECT clients FROM bot_oauth_client_capacity')).rows[0].clients,3);
});
test('Unknown client IDs never fetch metadata; explicit pre-registration is a local exact mapping',async t=>{
  const id='https://client.example/mcp-client.json',h=await harness(t,{preRegisteredClientId:id});
  const response=await h.app.inject(prefix+'/authorize?'+new URLSearchParams({response_type:'code',client_id:'https://unknown.example/private.json',redirect_uri:callback,resource,scope,state:'state',code_challenge:challenge,code_challenge_method:'S256'}));assert.equal(response.statusCode,400);assert.equal(response.headers.location,undefined);assert.equal(h.dispatches(),0);
  const approved=await h.approve(id);assert.equal((await h.exchange(approved)).statusCode,200);assert.equal((await h.db.query('SELECT id FROM bot_oauth_clients')).rows[0].id,id);
});
test('Invalid state, scope, PKCE method, resource or redirect fail locally without issuing a grant or redirecting',async t=>{
  const h=await harness(t),client=await h.register(),base={response_type:'code',client_id:client.client_id,redirect_uri:callback,resource,scope,state:'safe',code_challenge:challenge,code_challenge_method:'S256'};
  for(const extra of [{state:''},{scope:'admin'},{code_challenge_method:'plain'},{resource:origin+'/api/tasks'},{redirect_uri:'https://evil.example/callback'},{redirect_uri:callback+'&extra=1'}]){const response=await h.app.inject(prefix+'/authorize?'+new URLSearchParams({...base,...extra}));assert.equal(response.statusCode,400,response.body);assert.equal(response.headers.location,undefined);}
  assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),0);
});
test('Consent is explicit, bilingual/themed and cookie-only; employees and foreign organizations cannot approve',async t=>{
  const h=await harness(t),p=await h.pending((await h.register()).client_id);
  const login=await h.app.inject({url:p.path,headers:{cookie:p.nonce}});assert.equal(login.statusCode,200);assert.match(login.body,/Sign in|登录/);assert.doesNotMatch(login.body,/name="decision"/);
  assert.equal((await h.app.inject({url:p.path,headers:{cookie:p.nonce+'; '+h.sessions.m2.cookie}})).statusCode,403);assert.equal((await h.app.inject({url:p.path,headers:{cookie:p.nonce+'; '+h.sessions['other-manager'].cookie}})).statusCode,403);
  const page=await h.app.inject({url:p.path+'?lang=en&theme=dark',headers:{cookie:p.nonce+'; '+h.sessions.m1.cookie}});assert.equal(page.statusCode,200);assert.match(page.body,/data-theme="dark"/);assert.match(page.body,/Approve connection/);assert.match(page.body,/&lt;not verified&gt;/);assert.doesNotMatch(page.body,/<script|<style|\sonclick=/i);
  assert.equal((await h.app.inject('/'+prefix.slice(1)+'/consent.css')).statusCode,200);
  const payload={decision:'approve',csrf_token:h.sessions.m1.csrf};
  for(const headers of [{cookie:p.nonce+'; '+h.sessions.m1.cookie},{cookie:p.nonce+'; '+h.sessions.m1.cookie,origin:'https://evil.example'},{cookie:h.sessions.m1.cookie,origin},{cookie:p.nonce+'; '+h.sessions.m1.cookie,origin,authorization:'Bearer '+h.sessions.m1.token}] as Record<string,string>[])assert.notEqual((await h.form(p.path,payload,headers)).statusCode,200);
  assert.equal((await h.form(p.path,{...payload,csrf_token:'b'.repeat(43)},{cookie:p.nonce+'; '+h.sessions.m1.cookie,origin})).statusCode,403);
  assert.equal((await h.form(p.path,payload,{cookie:p.nonce,origin})).statusCode,401);
  assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),0);
});
test('Approval returns an explicit CSP-safe completion link with exact state/iss/static query, and stores only code digests',async t=>{
  const h=await harness(t),approved=await h.approve();assert.equal(approved.redirect.searchParams.get('from'),'workos');assert.equal(approved.redirect.searchParams.get('state'),approved.input.state);assert.equal(approved.redirect.searchParams.get('iss'),origin);assert.match(approved.code,/^wos_code_/);
  const rows=(await h.db.query('SELECT * FROM bot_oauth_codes')).rows;assert.equal(rows.length,1);assert.equal(rows[0].code_hash,hash(approved.code));assert(!JSON.stringify(rows).includes(approved.code));
  const replay=await h.form(approved.path,{decision:'approve',csrf_token:h.sessions.m1.csrf},{cookie:approved.nonce+'; '+h.sessions.m1.cookie,origin});assert.equal(replay.statusCode,400);assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),1);
});
test('Deny never creates a grant; expired requests and browser nonce swaps cannot approve',async t=>{
  const h=await harness(t),client=await h.register(),p=await h.pending(client.client_id),other=await h.pending(client.client_id);
  assert.equal((await h.form(p.path,{decision:'approve',csrf_token:h.sessions.m1.csrf},{cookie:other.nonce+'; '+h.sessions.m1.cookie,origin})).statusCode,400);
  const denied=await h.form(p.path,{decision:'deny',csrf_token:h.sessions.m1.csrf},{cookie:p.nonce+'; '+h.sessions.m1.cookie,origin});assert.equal(denied.statusCode,200);assert.equal(callbackIn(denied.body).searchParams.get('error'),'access_denied');
  await h.db.query('UPDATE bot_oauth_requests SET expires_at=$1',['2000-01-01T00:00:00Z']);assert.equal((await h.app.inject({url:other.path,headers:{cookie:other.nonce+'; '+h.sessions.m1.cookie}})).statusCode,400);assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),0);
});
test('DingTalk login resumes only the nonce-bound opaque request, never callback returnTo values',async t=>{
  const h=await harness(t),p=await h.pending((await h.register()).client_id),id=p.path.split('/').at(-1)!;
  assert.equal((await h.app.inject('/auth/dingtalk/start?oauth_request='+id)).statusCode,400);
  const start=await h.app.inject({url:'/auth/dingtalk/start?oauth_request='+id+'&returnTo=https://evil.example',headers:{cookie:p.nonce}});assert.equal(start.statusCode,302,start.body);
  const state=new URL(String(start.headers.location)).searchParams.get('state')!,dingNonce=String(start.headers['set-cookie']).split(';')[0];
  const result=await h.app.inject({url:'/auth/dingtalk/callback?'+new URLSearchParams({state,authCode:'manager',returnTo:'https://evil.example',oauth_request:'c'.repeat(43)}),headers:{cookie:p.nonce+'; '+dingNonce}});assert.equal(result.statusCode,302,result.body);assert.equal(result.headers.location,p.externalPath);
  const cookies=[result.headers['set-cookie']].flat().map(String),session=cookies.find(value=>value.startsWith('__Host-workos_session='))!.split(';')[0];
  const consent=await h.app.inject({url:p.path,headers:{cookie:p.nonce+'; '+session}});assert.equal(consent.statusCode,200);assert.match(consent.body,/name="decision"/);assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),0);
});
test('Code exchange requires the bound public client, exact callback, resource and S256 verifier; code replay fails',async t=>{
  const h=await harness(t),approved=await h.approve();
  for(const extra of [{code_verifier:'z'.repeat(64)},{client_id:'wos_client_other'},{redirect_uri:'https://evil.example/callback'},{resource:origin+'/api/tasks'},{scope:'admin'}] as Record<string,string>[])assert.equal((await h.exchange(approved,extra)).statusCode,400);
  const response=await h.exchange(approved);assert.equal(response.statusCode,200,response.body);const token=response.json();assert.match(token.access_token,/^wos_at_/);assert.match(token.refresh_token,/^wos_rt_/);assert(token.expires_in<=900&&token.expires_in>0);assert.equal((await h.exchange(approved)).statusCode,400);
  const rows=(await h.db.query('SELECT * FROM bot_oauth_tokens')).rows;assert(rows.every(row=>!JSON.stringify(row).includes(token.access_token)&&!JSON.stringify(row).includes(token.refresh_token)));
  assert.equal((await h.mcp(token.access_token)).statusCode,200);for(const value of [token.access_token,token.refresh_token,worker])assert.equal((await h.app.inject({url:'/me',headers:{authorization:'Bearer '+value}})).statusCode,401);
  assert.equal((await h.mcp(h.sessions.m1.token)).statusCode,401);assert.equal((await h.mcp(worker)).statusCode,401);assert.equal((await h.mcp(token.refresh_token)).statusCode,401);
});
test('Expired codes and access tokens cannot authenticate; business cookies cannot substitute at token endpoint',async t=>{
  const h=await harness(t),approved=await h.approve();await h.db.query('UPDATE bot_oauth_codes SET expires_at=$1',['2000-01-01T00:00:00Z']);assert.equal((await h.exchange(approved)).statusCode,400);
  const current=await h.approve(),tokens=(await h.exchange(current)).json();await h.db.query('UPDATE bot_oauth_tokens SET expires_at=$1 WHERE kind=$2',['2000-01-01T00:00:00Z','access']);assert.equal((await h.mcp(tokens.access_token)).statusCode,401);
  const response=await h.form(prefix+'/token',{grant_type:'authorization_code',client_id:current.clientId,resource},{cookie:h.sessions.m1.cookie,origin});assert.equal(response.statusCode,400);
});
test('Refresh binds resource/client/scope, rotates atomically, and replay commits family revocation',async t=>{
  const h=await harness(t),approved=await h.approve(),first=(await h.exchange(approved)).json();
  for(const extra of [{client_id:'other'},{resource:origin+'/api/tasks'},{scope:'admin'}] as Record<string,string>[])assert.equal((await h.refresh(approved.clientId,first.refresh_token,extra)).statusCode,400);
  const rotated=await h.refresh(approved.clientId,first.refresh_token);assert.equal(rotated.statusCode,200,rotated.body);assert.notEqual(rotated.json().refresh_token,first.refresh_token);
  assert.equal((await h.refresh(approved.clientId,first.refresh_token)).statusCode,400);assert((await h.db.query('SELECT revoked_at FROM bot_oauth_grants')).rows[0].revoked_at);
  assert.equal((await h.mcp(first.access_token)).statusCode,401);assert.equal((await h.mcp(rotated.json().access_token)).statusCode,401);assert.equal((await h.refresh(approved.clientId,rotated.json().refresh_token)).statusCode,400);
});
test('Concurrent refresh requests yield one rotation then revoke the family rather than leaving replay usable',async t=>{
  const h=await harness(t),approved=await h.approve(),first=(await h.exchange(approved)).json();
  const results=await Promise.all([h.refresh(approved.clientId,first.refresh_token),h.refresh(approved.clientId,first.refresh_token)]);assert.deepEqual(results.map(item=>item.statusCode).sort(),[200,400]);
  const issued=results.find(item=>item.statusCode===200)!.json();assert.equal((await h.mcp(issued.access_token)).statusCode,401);assert.equal((await h.refresh(approved.clientId,issued.refresh_token)).statusCode,400);
});
test('Manager deactivation, demotion, workspace change and explicit grant revoke invalidate access immediately',async t=>{
  const h=await harness(t),approved=await h.approve(),tokens=(await h.exchange(approved)).json();
  for(const [sql,params,undo]of [
    ['UPDATE users SET active=false WHERE id=$1',['m1'],'UPDATE users SET active=true WHERE id=$1'],
    ["UPDATE users SET role='employee' WHERE id=$1",['m1'],"UPDATE users SET role='manager' WHERE id=$1"],
    ["UPDATE users SET department_id='product' WHERE id=$1",['m1'],"UPDATE users SET department_id='marketing' WHERE id=$1"]
  ]as const){await h.db.query(sql,[...params]);assert.equal((await h.mcp(tokens.access_token)).statusCode,401);assert.equal((await h.refresh(approved.clientId,tokens.refresh_token)).statusCode,400);await h.db.query(undo,['m1']);}
  const list=await h.app.inject({url:prefix+'/grants',headers:{cookie:h.sessions.m1.cookie}});assert.equal(list.statusCode,200);assert.equal(list.json().items.length,1);assert(!JSON.stringify(list.json()).includes(tokens.access_token));const id=list.json().items[0].id;
  assert.equal((await h.app.inject({method:'POST',url:prefix+'/grants/'+id+'/revoke',payload:{},headers:{cookie:h.sessions.m1.cookie,origin}})).statusCode,403);
  const revoked=await h.app.inject({method:'POST',url:prefix+'/grants/'+id+'/revoke',payload:{},headers:{cookie:h.sessions.m1.cookie,origin,'x-csrf-token':h.sessions.m1.csrf}});assert.equal(revoked.statusCode,200,revoked.body);assert.equal((await h.mcp(tokens.access_token)).statusCode,401);
  assert.equal((await h.call('m2','GET',prefix+'/grants')).statusCode,403);assert.equal((await h.call('other-manager','GET',prefix+'/grants')).statusCode,403);
});
test('Token revocation requires possession and correct client but does not disclose unknown tokens',async t=>{
  const h=await harness(t),approved=await h.approve(),tokens=(await h.exchange(approved)).json();
  assert.equal((await h.form(prefix+'/revoke',{token:tokens.refresh_token,client_id:'other'})).statusCode,200);assert.equal((await h.mcp(tokens.access_token)).statusCode,200);
  assert.equal((await h.form(prefix+'/revoke',{token:tokens.refresh_token,client_id:approved.clientId})).statusCode,200);assert.equal((await h.mcp(tokens.access_token)).statusCode,401);
});
test('Configuration changes invalidate prior grants and local pre-registration never survives removal or remapping',async t=>{
  const id='https://client.example/mcp-client.json',h=await harness(t,{preRegisteredClientId:id}),approved=await h.approve(id),tokens=(await h.exchange(approved)).json();
  for(const config of [{...h.config,redirectUris:[]},{...h.config,redirectUris:[callback,'https://bot.example/new']},{...h.config,preRegisteredClientId:undefined},{...h.config,preRegisteredClientId:'https://client.example/new.json'},{...h.config,orgId:'other'}]){
    const service=new BotOAuthService(h.db,config);assert.equal(await service.resolveAccess(tokens.access_token),null);if(service.configured)await assert.rejects(service.token({grant_type:'refresh_token',client_id:id,resource,refresh_token:tokens.refresh_token}));
  }
  const restored=new BotOAuthService(h.db,h.config);assert(await restored.resolveAccess(tokens.access_token));assert.equal(Number((await h.db.query('SELECT count(*) AS total FROM bot_oauth_grants')).rows[0].total),1);
  await h.db.query('UPDATE bot_oauth_grants SET revoked_at=now()');assert.equal(await restored.resolveAccess(tokens.access_token),null);
});
test('Pinned Cursor custom/loopback callbacks remain exact through consent and code exchange',async t=>{
  const redirects=['cursor://anysphere.cursor-mcp/oauth/callback','http://localhost:8787/callback','http://127.0.0.1:8787/callback','http://[::1]:8787/callback','http://localhost:80/callback'],h=await harness(t,{redirectUris:redirects}),client=await h.register();
  for(const redirect_uri of redirects){const approved=await h.approve(client.client_id,{redirect_uri});assert.equal(approved.redirect.searchParams.get('state'),approved.input.state);assert.equal(approved.redirect.searchParams.get('iss'),origin);assert.equal((await h.exchange(approved,{code_verifier:'z'.repeat(64)})).statusCode,400);assert.equal((await h.exchange(approved)).statusCode,200);}
});
test('OAuth keeps job, lease, evidence validation and human acceptance boundaries intact',async t=>{
  const h=await harness(t),approved=await h.approve(),tokens=(await h.exchange(approved)).json();
  const created=await h.call('m1','POST','/tasks',{title:'Synthetic OAuth evidence task',description:'Inspect sources only.',ownerId:'m2',criteria:['Provide evidence'],dueAt:'2026-12-01T12:00:00Z'});assert.equal(created.statusCode,201);const id=created.json().id;
  const submitted=await h.call('m2','POST',`/tasks/${id}/submissions`,{expectedVersion:1,title:'Synthetic submitted work',description:'Evidence text for a human to verify.'});assert.equal(submitted.statusCode,201);
  const queued=await h.call('m2','POST',`/tasks/${id}/analyze`,{});assert.equal(queued.statusCode,202,queued.body);const jobId=queued.json().job.id;
  const get=await h.mcp(tokens.access_token,'tools/call',{name:'workos_get_review_job',arguments:{jobId}});assert.equal(get.statusCode,200,get.body);assert.equal(get.json().result.isError,false,get.body);const lease=get.json().result.structuredContent;
  const result={summary:'Synthetic OAuth assessment.',criteria:[{criterionId:'C1',finding:'supported',reason:'Provided source text.',evidenceRefs:[lease.sources[1].id],quotes:[lease.sources[1].text]}],missingEvidence:[],uncertainties:[],humanReviewRequired:true};
  const complete=await h.mcp(tokens.access_token,'tools/call',{name:'workos_submit_review',arguments:{jobId,leaseToken:lease.leaseToken,result}});assert.equal(complete.json().result.isError,false,complete.body);
  const detail=(await h.call('m1','GET',`/tasks/${id}`)).json();assert.equal(detail.status,'submitted');assert.equal(detail.currentReview,null);assert.equal((await h.call('m1','GET',`/tasks/${id}/evaluations`)).json().items[0].model,'grok-bot');
  const other=await h.call('m4','POST','/tasks',{title:'Other workspace task',description:'Must remain invisible to this grant.',ownerId:'m5',criteria:['Check'],dueAt:'2026-12-01T12:00:00Z'});assert.equal(other.statusCode,201);const otherId=other.json().id;
  assert.equal((await h.call('m5','POST',`/tasks/${otherId}/submissions`,{expectedVersion:1,title:'Other department evidence',description:'This belongs to another authorized workspace.'})).statusCode,201);
  const otherJob=(await h.call('m5','POST',`/tasks/${otherId}/analyze`,{})).json().job;
  const forbidden=await h.mcp(tokens.access_token,'tools/call',{name:'workos_get_review_job',arguments:{jobId:otherJob.id}});assert.equal(forbidden.json().result.isError,true);assert.equal(forbidden.json().result.structuredContent.error.code,'NOT_FOUND');assert.equal((await h.db.query('SELECT status FROM ai_review_jobs WHERE id=$1',[otherJob.id])).rows[0].status,'pending');
  const service=new BotOAuthService(h.db,h.config),principal=await service.resolveAccess(tokens.access_token);assert(principal);await h.db.query('UPDATE bot_oauth_grants SET revoked_at=now()');await assert.rejects(h.db.transaction(tx=>service.validatePrincipal(tx,principal)),(error:any)=>error.code==='BOT_OAUTH_INVALID_TOKEN');
});

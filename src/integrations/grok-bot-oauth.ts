import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cookie, hash, readCookie, sameSecret, sessionCookieName, type User } from '../auth.js';
import type { Database, Queryable } from '../db.js';
import { ApiError } from '../errors.js';
import { renderConsentPage, consentCss } from './grok-bot-consent.js';

export const BOT_OAUTH_PREFIX='/integrations/grok-bot/oauth';
export const BOT_OAUTH_SCOPE='workos.review';
export const BOT_OAUTH_WELL_KNOWN=[
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/integrations/grok-bot/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/api/integrations/grok-bot/oauth'
];
export type BotOAuthConfig={publicUrl?:string;orgId?:string;redirectUris:string[];secureCookies?:boolean;preRegisteredClientId?:string};
export type BotOAuthPrincipal={grantId:string;tokenHash:string;orgId:string;departmentId:string};
type Grant={id:string;org_id:string;department_id:string;manager_id:string;client_id:string;redirect_uri:string;resource:string;scope:string;expires_at:Date|string;revoked_at:Date|string|null};
type Pending={id:string;org_id:string;client_id:string;redirect_uri:string;resource:string;scope:string;state:string;code_challenge:string;nonce_hash:string;policy_hash:string;expires_at:Date|string;consumed_at:Date|string|null};
const opaque=()=>randomBytes(32).toString('base64url');
const pendingId=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const future=(time:string|Date)=>new Date(time).getTime()>Date.now();
const pkce=(value:string)=>createHash('sha256').update(value).digest('base64url');
export class BotOAuthError extends Error{
  constructor(public error:string,public status=400,public description='The OAuth request could not be verified'){super(error);}
}
function fail(error:string,status=400,description?:string):never{throw new BotOAuthError(error,status,description);}
export function validatedBotRedirects(raw:string|undefined):string[]{
  if(!raw?.trim())return [];
  const values=raw.split(',').map(value=>value.trim());
  if(values.length>20||values.some(value=>!value))throw new Error('Invalid Bot OAuth redirect allowlist');
  for(const value of values){
    const url=new URL(value);
    const custom=value==='cursor://anysphere.cursor-mcp/oauth/callback';
    const portMatch=/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\//.exec(value);
    const loopback=url.protocol==='http:'&&!!portMatch&&Number(portMatch[2])<=65535&&url.pathname!=='/';
    const canonical=value===url.toString()||(loopback&&portMatch![2]==='80'&&value.replace(/:80\//,'/')===url.toString());
    if(!canonical||(!custom&&url.protocol!=='https:'&&!loopback)||url.username||url.password||value.includes('#')||value.includes('*')||value.length>2000||[...url.searchParams.keys()].some(key=>['code','state','iss','error'].includes(key)))throw new Error('Invalid Bot OAuth redirect allowlist');
  }
  return [...new Set(values)];
}
export class BotOAuthService{
  readonly issuer:string;readonly resource:string;readonly configured:boolean;readonly cookieName:string;readonly policyHash:string;
  private limits=new Map<string,{count:number;until:number}>();
  constructor(private db:Database,readonly config:BotOAuthConfig){
    const publicUrl=config.publicUrl?new URL(config.publicUrl):undefined;
    this.issuer=publicUrl?.origin||'';
    if(publicUrl&&(publicUrl.protocol!=='https:'||publicUrl.username||publicUrl.password||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash))throw new Error('Bot OAuth requires an HTTPS origin');
    validatedBotRedirects(config.redirectUris.join(','));
    this.resource=this.issuer?this.issuer+'/api/integrations/grok-bot/mcp':'';
    this.policyHash=hash(JSON.stringify({issuer:this.issuer,orgId:config.orgId,redirectUris:[...config.redirectUris].sort(),preRegisteredClientId:config.preRegisteredClientId||null,scope:BOT_OAUTH_SCOPE}));
    this.configured=!!this.issuer&&!!config.orgId&&config.redirectUris.length>0;
    this.cookieName=config.secureCookies?'__Host-workos_bot_oauth':'workos_bot_oauth';
    if(config.preRegisteredClientId){const client=new URL(config.preRegisteredClientId);if(client.protocol!=='https:'||client.username||client.password||client.search||client.hash||client.toString()!==config.preRegisteredClientId||config.preRegisteredClientId.length>2000)throw new Error('Invalid pre-registered Bot client ID');}
  }
  async initialize(){
    if(!this.configured||!this.config.preRegisteredClientId)return;
    const id=this.config.preRegisteredClientId;
    const row=(await this.db.query('INSERT INTO bot_oauth_clients(id,org_id,name,redirect_uris,grant_types) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET redirect_uris=excluded.redirect_uris,grant_types=excluded.grant_types WHERE bot_oauth_clients.org_id=excluded.org_id RETURNING id',[id,this.config.orgId,'Explicitly configured Work OS Bot client',JSON.stringify(this.config.redirectUris),JSON.stringify(['authorization_code','refresh_token'])])).rows[0];
    if(!row)throw new Error('Pre-registered Bot client belongs to another organization');
  }
  publicUrl(path:string){return this.issuer+'/api'+BOT_OAUTH_PREFIX+path;}
  ready(){if(!this.configured)fail('temporarily_unavailable',503,'Bot OAuth requires an explicit organization, HTTPS origin and exact redirect allowlist');}
  challenge(){return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource", scope="${BOT_OAUTH_SCOPE}"`;}
  limited(key:string,max:number){
    const now=Date.now();if(this.limits.size>=1000)for(const[k,value]of this.limits)if(value.until<=now)this.limits.delete(k);
    let value=this.limits.get(key);if(!value||value.until<=now){if(this.limits.size>=1000)fail('temporarily_unavailable',429);value={count:0,until:now+60000};this.limits.set(key,value);}
    if(++value.count>max)fail('temporarily_unavailable',429,'OAuth request limit exceeded');
  }
  origin(req:FastifyRequest,required=false){if((required||req.headers.origin!==undefined)&&req.headers.origin!==this.issuer)fail('invalid_request',403,'Request origin could not be verified');}
  metadata(resource=false){
    this.ready();
    if(resource)return {resource:this.resource,authorization_servers:[this.issuer],scopes_supported:[BOT_OAUTH_SCOPE],bearer_methods_supported:['header']};
    return {issuer:this.issuer,authorization_endpoint:this.publicUrl('/authorize'),token_endpoint:this.publicUrl('/token'),registration_endpoint:this.publicUrl('/register'),revocation_endpoint:this.publicUrl('/revoke'),response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:[BOT_OAUTH_SCOPE],authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:false};
  }
  private resourceScope(resource:unknown,scope:unknown){
    if(resource!==this.resource)fail('invalid_target');
    if(scope!==undefined&&scope!==BOT_OAUTH_SCOPE)fail('invalid_scope');
  }
  private clientAllowed(clientId:string){return /^wos_client_[a-f0-9-]{36}$/.test(clientId)||clientId===this.config.preRegisteredClientId;}
  async register(input:unknown){
    this.ready();
    const parsed=z.object({redirect_uris:z.array(z.string().max(2000)).min(1).max(10),client_name:z.string().trim().min(1).max(100).default('Work OS Bot client'),token_endpoint_auth_method:z.literal('none').default('none'),grant_types:z.array(z.enum(['authorization_code','refresh_token'])).min(1).max(2).default(['authorization_code','refresh_token']),response_types:z.array(z.literal('code')).length(1).default(['code']),scope:z.literal(BOT_OAUTH_SCOPE).optional()}).safeParse(input);
    if(!parsed.success)fail('invalid_client_metadata');const data=parsed.data;
    if(!data.grant_types.includes('authorization_code')||new Set(data.grant_types).size!==data.grant_types.length||data.redirect_uris.some(uri=>!this.config.redirectUris.includes(uri)))fail('invalid_redirect_uri');
    return this.db.transaction(async tx=>{
      const hour=new Date(Math.floor(Date.now()/3600000)*3600000).toISOString();
      if(!(await tx.query('INSERT INTO bot_oauth_registration_budgets(org_id,hour_start,attempts) VALUES($1,$2,1) ON CONFLICT(org_id,hour_start) DO UPDATE SET attempts=bot_oauth_registration_budgets.attempts+1 WHERE bot_oauth_registration_budgets.attempts<10 RETURNING attempts',[this.config.orgId,hour])).rows.length)fail('temporarily_unavailable',429,'Client registration limit exceeded');
      await tx.query('INSERT INTO bot_oauth_client_capacity(org_id,clients) VALUES($1,0) ON CONFLICT DO NOTHING',[this.config.orgId]);
      await tx.query('SELECT org_id FROM bot_oauth_client_capacity WHERE org_id=$1 FOR UPDATE',[this.config.orgId]);
      await tx.query('DELETE FROM bot_oauth_codes WHERE expires_at<now() AND request_id IN (SELECT id FROM bot_oauth_requests WHERE org_id=$1)',[this.config.orgId]);
      await tx.query('DELETE FROM bot_oauth_requests r WHERE r.org_id=$1 AND (r.expires_at<now() OR r.consumed_at IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM bot_oauth_codes c WHERE c.request_id=r.id)',[this.config.orgId]);
      // Reclaim only never-authorized dynamic clients after one hour. Existing grant
      // history, pre-registered IDs and any still-valid browser request are preserved.
      await tx.query("DELETE FROM bot_oauth_clients c WHERE c.org_id=$1 AND c.id LIKE 'wos_client_%' AND c.created_at<now()-interval '1 hour' AND NOT EXISTS (SELECT 1 FROM bot_oauth_grants g WHERE g.client_id=c.id) AND NOT EXISTS (SELECT 1 FROM bot_oauth_requests r WHERE r.client_id=c.id)",[this.config.orgId]);
      const count=Number((await tx.query("SELECT count(*) AS total FROM bot_oauth_clients WHERE org_id=$1 AND id LIKE 'wos_client_%'",[this.config.orgId])).rows[0].total);
      if(count>=50)fail('temporarily_unavailable',429,'Client registration capacity exceeded');
      await tx.query('UPDATE bot_oauth_client_capacity SET clients=$2 WHERE org_id=$1',[this.config.orgId,count+1]);
      const clientId='wos_client_'+randomUUID();await tx.query('INSERT INTO bot_oauth_clients(id,org_id,name,redirect_uris,grant_types) VALUES($1,$2,$3,$4,$5)',[clientId,this.config.orgId,data.client_name,JSON.stringify([...new Set(data.redirect_uris)]),JSON.stringify(data.grant_types)]);
      return {client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),client_name:data.client_name,redirect_uris:[...new Set(data.redirect_uris)],token_endpoint_auth_method:'none',grant_types:data.grant_types,response_types:['code'],scope:BOT_OAUTH_SCOPE};
    });
  }
  async authorize(input:unknown){
    this.ready();
    const parsed=z.object({response_type:z.literal('code'),client_id:z.string().max(2000),redirect_uri:z.string().max(2000),resource:z.string().max(2000),scope:z.string().max(100).optional(),state:z.string().min(1).max(1024),code_challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code_challenge_method:z.literal('S256')}).safeParse(input);
    if(!parsed.success)fail('invalid_request');const value=parsed.data;this.resourceScope(value.resource,value.scope);
    return this.db.transaction(async tx=>{
      const client=(await tx.query('SELECT * FROM bot_oauth_clients WHERE id=$1 AND org_id=$2 FOR UPDATE',[value.client_id,this.config.orgId])).rows[0];
      if(!client||!this.clientAllowed(value.client_id)||!client.redirect_uris.includes(value.redirect_uri)||!this.config.redirectUris.includes(value.redirect_uri))fail('invalid_request');
      await tx.query('DELETE FROM bot_oauth_codes WHERE expires_at<now()');
      await tx.query('DELETE FROM bot_oauth_requests WHERE expires_at<now() AND id NOT IN (SELECT request_id FROM bot_oauth_codes)');
      if(Number((await tx.query('SELECT count(*) AS total FROM bot_oauth_requests WHERE client_id=$1 AND consumed_at IS NULL AND expires_at>now()',[client.id])).rows[0].total)>=30)fail('temporarily_unavailable',429,'Pending authorization capacity exceeded');
      const id=opaque(),nonce=opaque();
      await tx.query('INSERT INTO bot_oauth_requests(id,org_id,client_id,redirect_uri,resource,scope,state,code_challenge,nonce_hash,policy_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,this.config.orgId,value.client_id,value.redirect_uri,this.resource,BOT_OAUTH_SCOPE,value.state,value.code_challenge,hash(nonce),this.policyHash,new Date(Date.now()+600000).toISOString()]);
      return {id,nonce,path:'/api'+BOT_OAUTH_PREFIX+'/requests/'+id};
    });
  }
  async pending(requestId:string,nonce:string|undefined,tx:Queryable=this.db,lock=false):Promise<Pending>{
    this.ready();if(!pendingId.safeParse(requestId).success||!nonce)fail('invalid_request');
    const row=(await tx.query<Pending>('SELECT * FROM bot_oauth_requests WHERE id=$1 AND org_id=$2'+(lock?' FOR UPDATE':''),[requestId,this.config.orgId])).rows[0];
    if(!row||row.consumed_at||!future(row.expires_at)||!sameSecret(row.nonce_hash,hash(nonce))||row.resource!==this.resource||row.scope!==BOT_OAUTH_SCOPE||row.policy_hash!==this.policyHash||!this.clientAllowed(row.client_id)||!this.config.redirectUris.includes(row.redirect_uri))fail('invalid_request');return row;
  }
  async resume(requestId:string,header:string|undefined){await this.pending(requestId,readCookie(header,this.cookieName));return '/api'+BOT_OAUTH_PREFIX+'/requests/'+requestId;}
  async manager(req:FastifyRequest,tx:Queryable=this.db,lock=false):Promise<{user:User;csrf:string}|null>{
    if(req.headers.authorization)fail('access_denied',403);
    const token=readCookie(req.headers.cookie,sessionCookieName(this.config.secureCookies===true));if(!token)return null;
    const row=(await tx.query<User&{csrf_token:string}>('SELECT u.*,s.csrf_token FROM users u JOIN sessions s ON s.user_id=u.id JOIN external_identities e ON e.user_id=u.id AND e.provider=$2 AND e.corp_id=u.org_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true'+(lock?' FOR SHARE OF u,s,e':''),[hash(token),'dingtalk'])).rows[0];
    if(!row)return null;
    if(row.org_id!==this.config.orgId||row.role!=='manager')fail('access_denied',403);
    return {user:row,csrf:row.csrf_token};
  }
  async consent(req:FastifyRequest,requestId:string,input:unknown){
    this.ready();this.origin(req,true);
    const parsed=z.object({csrf_token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),decision:z.enum(['approve','deny']),lang:z.enum(['zh','en']).optional(),theme:z.enum(['light','dark']).optional()}).safeParse(input);
    if(!parsed.success)fail('invalid_request');
    return this.db.transaction(async tx=>{
      const pending=await this.pending(requestId,readCookie(req.headers.cookie,this.cookieName),tx,true),manager=await this.manager(req,tx,true);
      if(!manager)fail('access_denied',401);
      if(!manager.csrf||!sameSecret(manager.csrf,parsed.data.csrf_token))fail('access_denied',403);
      await tx.query('UPDATE bot_oauth_requests SET consumed_at=now() WHERE id=$1',[pending.id]);
      const redirect=new URL(pending.redirect_uri);redirect.searchParams.set('state',pending.state);redirect.searchParams.set('iss',this.issuer);
      const completionUrl=()=>pending.redirect_uri.split('?')[0]+'?'+redirect.searchParams.toString();
      if(parsed.data.decision==='deny'){redirect.searchParams.set('error','access_denied');return {completionUrl:completionUrl()};}
      const grantId=randomUUID(),code='wos_code_'+opaque();
      await tx.query('INSERT INTO bot_oauth_grants(id,org_id,department_id,manager_id,client_id,redirect_uri,resource,scope,policy_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[grantId,this.config.orgId,manager.user.department_id,manager.user.id,pending.client_id,pending.redirect_uri,this.resource,BOT_OAUTH_SCOPE,this.policyHash,new Date(Date.now()+30*86400000).toISOString()]);
      await tx.query('INSERT INTO bot_oauth_codes(code_hash,request_id,grant_id,expires_at) VALUES($1,$2,$3,$4)',[hash(code),pending.id,grantId,new Date(Date.now()+120000).toISOString()]);
      await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),manager.user.org_id,manager.user.department_id,manager.user.id,'bot.oauth_authorized',grantId,JSON.stringify({clientId:pending.client_id,scope:BOT_OAUTH_SCOPE})]);
      redirect.searchParams.set('code',code);return {completionUrl:completionUrl()};
    });
  }
  private async activeGrant(tx:Queryable,grantId:string,lock='FOR SHARE OF g,u'):Promise<Grant|null>{
    const row=(await tx.query<Grant>('SELECT g.* FROM bot_oauth_grants g JOIN users u ON u.id=g.manager_id JOIN external_identities e ON e.user_id=u.id AND e.provider=$7 AND e.corp_id=g.org_id WHERE g.id=$1 AND g.org_id=$2 AND g.resource=$3 AND g.scope=$4 AND g.revoked_at IS NULL AND g.expires_at>now() AND u.active=true AND u.role=$5 AND u.org_id=g.org_id AND u.department_id=g.department_id AND g.policy_hash=$6 '+lock,[grantId,this.config.orgId,this.resource,BOT_OAUTH_SCOPE,'manager',this.policyHash,'dingtalk'])).rows[0];return row&&this.clientAllowed(row.client_id)&&this.config.redirectUris.includes(row.redirect_uri)?row:null;
  }
  private async tokens(tx:Queryable,grant:Grant,refreshAllowed=true){
    const access='wos_at_'+opaque(),refresh=refreshAllowed?'wos_rt_'+opaque():undefined;
    const accessExpires=new Date(Math.min(Date.now()+900000,new Date(grant.expires_at).getTime()));
    await tx.query('INSERT INTO bot_oauth_tokens(token_hash,kind,grant_id,expires_at) VALUES($1,$2,$3,$4)',[hash(access),'access',grant.id,accessExpires.toISOString()]);
    if(refresh)await tx.query('INSERT INTO bot_oauth_tokens(token_hash,kind,grant_id,expires_at) VALUES($1,$2,$3,$4)',[hash(refresh),'refresh',grant.id,grant.expires_at]);
    return {access_token:access,token_type:'Bearer',expires_in:Math.max(0,Math.floor((accessExpires.getTime()-Date.now())/1000)),scope:BOT_OAUTH_SCOPE,...(refresh?{refresh_token:refresh}:{})};
  }
  async token(input:unknown){
    this.ready();
    const parsed=z.object({grant_type:z.enum(['authorization_code','refresh_token']),client_id:z.string().min(1).max(2000),resource:z.string().max(2000),scope:z.string().max(100).optional(),code:z.string().max(200).optional(),redirect_uri:z.string().max(2000).optional(),code_verifier:z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/).optional(),refresh_token:z.string().max(200).optional()}).strict().safeParse(input);
    if(!parsed.success)fail('invalid_request');const value=parsed.data;this.resourceScope(value.resource,value.scope);
    if(value.grant_type==='authorization_code'){
      if(!value.code||!value.redirect_uri||!value.code_verifier||value.refresh_token)fail('invalid_request');
      return this.db.transaction(async tx=>{
        const row=(await tx.query('SELECT c.*,r.client_id,r.redirect_uri,r.code_challenge FROM bot_oauth_codes c JOIN bot_oauth_requests r ON r.id=c.request_id WHERE c.code_hash=$1 FOR UPDATE OF c',[hash(value.code!)])).rows[0];
        if(!row||row.consumed_at||!future(row.expires_at)||row.client_id!==value.client_id||row.redirect_uri!==value.redirect_uri||!this.config.redirectUris.includes(row.redirect_uri)||!sameSecret(row.code_challenge,pkce(value.code_verifier!)))fail('invalid_grant');
        const grant=await this.activeGrant(tx,row.grant_id);if(!grant)fail('invalid_grant');
        const client=(await tx.query('SELECT grant_types FROM bot_oauth_clients WHERE id=$1',[grant.client_id])).rows[0];
        await tx.query('UPDATE bot_oauth_codes SET consumed_at=now() WHERE code_hash=$1',[hash(value.code!)]);return this.tokens(tx,grant,client.grant_types.includes('refresh_token'));
      });
    }
    if(!value.refresh_token||value.code||value.redirect_uri||value.code_verifier)fail('invalid_request');
    const outcome=await this.db.transaction(async tx=>{
      const found=(await tx.query('SELECT grant_id FROM bot_oauth_tokens WHERE token_hash=$1 AND kind=$2',[hash(value.refresh_token!),'refresh'])).rows[0];
      if(!found)return {error:true as const};
      await tx.query('SELECT id FROM bot_oauth_grants WHERE id=$1 FOR UPDATE',[found.grant_id]);
      const row=(await tx.query('SELECT * FROM bot_oauth_tokens WHERE token_hash=$1 AND kind=$2 FOR UPDATE',[hash(value.refresh_token!),'refresh'])).rows[0];
      const grant=await this.activeGrant(tx,found.grant_id);
      if(!row||!grant||grant.client_id!==value.client_id||!future(row.expires_at))return {error:true as const};
      if(row.used_at){await tx.query('UPDATE bot_oauth_grants SET revoked_at=now() WHERE id=$1',[grant.id]);return {error:true as const};}
      await tx.query('UPDATE bot_oauth_tokens SET used_at=now() WHERE token_hash=$1',[hash(value.refresh_token!)]);
      return {tokens:await this.tokens(tx,grant)};
    });
    // Replay revocation has already committed. Throwing inside the transaction would roll it back.
    if(outcome.error)fail('invalid_grant');return outcome.tokens!;
  }
  async resolveAccess(token:string):Promise<BotOAuthPrincipal|null>{
    if(!this.configured||!/^wos_at_[A-Za-z0-9_-]{43}$/.test(token))return null;
    const row=(await this.db.query('SELECT grant_id FROM bot_oauth_tokens WHERE token_hash=$1 AND kind=$2 AND expires_at>now()',[hash(token),'access'])).rows[0];
    if(!row)return null;const grant=await this.activeGrant(this.db,row.grant_id);if(!grant)return null;
    return {grantId:grant.id,tokenHash:hash(token),orgId:grant.org_id,departmentId:grant.department_id};
  }
  async validatePrincipal(tx:Queryable,principal:BotOAuthPrincipal){
    this.ready();const grant=await this.activeGrant(tx,principal.grantId);
    const token=(await tx.query('SELECT token_hash FROM bot_oauth_tokens WHERE token_hash=$1 AND kind=$2 AND grant_id=$3 AND expires_at>now() FOR SHARE',[principal.tokenHash,'access',principal.grantId])).rows[0];
    if(!grant||!token||grant.org_id!==principal.orgId||grant.department_id!==principal.departmentId)throw new ApiError(401,'BOT_OAUTH_INVALID_TOKEN','Authentication is required');
  }
  async revokeToken(input:unknown){
    this.ready();const parsed=z.object({token:z.string().min(1).max(200),client_id:z.string().min(1).max(2000),token_type_hint:z.string().max(30).optional()}).strict().safeParse(input);
    if(!parsed.success)fail('invalid_request');
    await this.db.query('UPDATE bot_oauth_grants SET revoked_at=now() WHERE client_id=$1 AND org_id=$2 AND id IN (SELECT grant_id FROM bot_oauth_tokens WHERE token_hash=$3)',[parsed.data.client_id,this.config.orgId,hash(parsed.data.token)]);return {};
  }
  async grants(user:User){
    this.ready();if(user.org_id!==this.config.orgId||user.role!=='manager')throw new ApiError(403,'FORBIDDEN','A designated manager must review evidence');
    return {items:(await this.db.query('SELECT g.id,g.client_id,c.name AS client_name,g.scope,g.resource,g.created_at,g.expires_at,g.revoked_at FROM bot_oauth_grants g JOIN bot_oauth_clients c ON c.id=g.client_id WHERE g.org_id=$1 AND g.department_id=$2 AND g.manager_id=$3 ORDER BY g.created_at DESC,g.id DESC LIMIT 50',[user.org_id,user.department_id,user.id])).rows};
  }
  async revokeGrant(user:User,grantId:string){
    this.ready();if(user.org_id!==this.config.orgId||user.role!=='manager')throw new ApiError(403,'FORBIDDEN','A designated manager must review evidence');
    const rows=(await this.db.query('UPDATE bot_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND org_id=$2 AND department_id=$3 AND manager_id=$4 RETURNING id',[grantId,user.org_id,user.department_id,user.id])).rows;
    if(!rows.length)throw new ApiError(404,'NOT_FOUND','Task not found');return {revoked:true};
  }
}

const safeError=(error:unknown)=>error instanceof BotOAuthError?error:new BotOAuthError('invalid_request');
export async function registerBotOAuthRoutes(app:FastifyInstance,db:Database,service:BotOAuthService|undefined){
  const ready=()=>{if(!service)fail('temporarily_unavailable',503,'Bot OAuth mode is not enabled');service.ready();return service;};
  const boundary=(handler:(req:FastifyRequest,reply:any)=>Promise<unknown>|unknown)=>async(req:FastifyRequest,reply:any)=>{
    reply.header('Cache-Control','no-store').header('Pragma','no-cache');
    try{return await handler(req,reply);}catch(error){const safe=safeError(error);return reply.code(safe.status).send({error:safe.error,error_description:safe.description});}
  };
  for(const path of BOT_OAUTH_WELL_KNOWN)app.get(path,boundary(()=>ready().metadata(path.includes('oauth-protected-resource'))));
  app.post(BOT_OAUTH_PREFIX+'/register',{bodyLimit:16384},boundary(async(req,reply)=>{const s=ready();s.origin(req);s.limited('register:'+req.ip,10);if(!req.headers['content-type']?.startsWith('application/json'))fail('invalid_client_metadata',415);return reply.code(201).send(await s.register(req.body));}));
  const bodyEndpoint=(method:'token'|'revokeToken')=>boundary(async req=>{const s=ready();s.origin(req);s.limited('token:'+req.ip,60);if(req.headers.authorization)fail('invalid_client',401);if(!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))fail('invalid_request',415);return s[method](req.body);});
  app.post(BOT_OAUTH_PREFIX+'/token',{bodyLimit:16384},bodyEndpoint('token'));
  app.post(BOT_OAUTH_PREFIX+'/revoke',{bodyLimit:16384},bodyEndpoint('revokeToken'));
  app.get(BOT_OAUTH_PREFIX+'/consent.css',async(_req,reply)=>reply.type('text/css; charset=utf-8').send(consentCss));
  app.get(BOT_OAUTH_PREFIX+'/authorize',boundary(async(req,reply)=>{
    const s=ready();s.origin(req);s.limited('authorize:'+req.ip,30);const pending=await s.authorize(req.query);
    reply.header('Set-Cookie',cookie(s.cookieName,pending.nonce,s.config.secureCookies===true,600));return reply.redirect(pending.path);
  }));
  const pageInput=(req:FastifyRequest)=>{const input=(req.method==='POST'?req.body:req.query)||{};const value=z.object({lang:z.enum(['zh','en']).optional(),theme:z.enum(['light','dark']).optional()}).passthrough().safeParse(input);return {language:value.success?(value.data.lang||req.language):req.language,theme:value.success?(value.data.theme||'light' as const):'light' as const};};
  app.get<{Params:{requestId:string}}>(BOT_OAUTH_PREFIX+'/requests/:requestId',boundary(async(req,reply)=>{
    // no-referrer makes browser form POSTs send Origin: null. Preserve same-origin
    // CSRF validation while still withholding referrers from external callbacks.
    reply.header('Referrer-Policy','same-origin');
    const s=ready(),requestId=(req.params as any).requestId,pending=await s.pending(requestId,readCookie(req.headers.cookie,s.cookieName));
    const manager=await s.manager(req),client=(await db.query('SELECT name FROM bot_oauth_clients WHERE id=$1',[pending.client_id])).rows[0];
    return reply.type('text/html; charset=utf-8').send(renderConsentPage({requestId,path:'/api'+BOT_OAUTH_PREFIX+'/requests/'+requestId,...pageInput(req),status:manager?'consent':'login',clientName:client.name,redirectUri:pending.redirect_uri,organization:s.config.orgId!,managerName:manager?.user.display_name,csrfToken:manager?.csrf,loginUrl:'/api/auth/dingtalk/start?oauth_request='+requestId}));
  }));
  app.post<{Params:{requestId:string}}>(BOT_OAUTH_PREFIX+'/requests/:requestId',{bodyLimit:16384},boundary(async(req,reply)=>{
    const s=ready(),requestId=(req.params as any).requestId,result=await s.consent(req,requestId,req.body);
    // Keep strict form-action CSP: an explicit anchor completes navigation instead of a form redirect to another origin.
    return reply.type('text/html; charset=utf-8').send(renderConsentPage({requestId,path:'/api'+BOT_OAUTH_PREFIX+'/requests/'+requestId,...pageInput(req),status:'complete',clientName:'Work OS Bot',redirectUri:'',organization:s.config.orgId!,completionUrl:result.completionUrl}));
  }));
  const managerReady=()=>{if(!service?.configured)throw new ApiError(503,'BOT_OAUTH_NOT_CONFIGURED','The request could not be completed');return service;};
  app.get(BOT_OAUTH_PREFIX+'/grants',async req=>{const user=req.actor;if(!user)throw new ApiError(401,'UNAUTHENTICATED','Authentication is required');return managerReady().grants(user);});
  app.post<{Params:{id:string}}>(BOT_OAUTH_PREFIX+'/grants/:id/revoke',async req=>{const user=req.actor;if(!user)throw new ApiError(401,'UNAUTHENTICATED','Authentication is required');const s=managerReady();if(req.cookieAuthenticated&&req.headers.origin!==s.issuer)throw new ApiError(403,'CSRF_INVALID','Request origin or security token is invalid');return s.revokeGrant(user,z.string().uuid().parse(req.params.id));});
}

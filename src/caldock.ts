import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db.js';
import { hash, sameSecret, readCookie } from './auth.js';
import { deny } from './errors.js';
import { createCaldockGateway, type CaldockGateway, type CaldockProvider } from './caldock-oidc.js';
import { caldockAudit, CALDOCK_PRICES, createCaldockOrder } from './caldock-domain.js';

type Customer = {id:string;display_name:string;email:string|null;active:boolean;created_at:string};
type Session = {user:Customer;csrf:string;token:string};
export type CaldockOptions = {publicUrl?:string;marketingUrl?:string;secureCookies?:boolean;adminUserIds?:string[];providers?:Partial<Record<CaldockProvider,CaldockGateway>>};
const id=z.string().uuid(),providerName=z.enum(['google','apple']);
const status=z.enum(['pending_payment','paid','provisioning','active','cancelled','refunded']);
const interval=z.enum(['month','year']);
const nextView=z.enum(['account','orders','affiliate','checkout','admin']);
const token=()=>randomBytes(32).toString('base64url');
export const caldockCookieName=(secure:boolean,kind='session')=>(secure?'__Host-':'')+'caldock_'+kind;
function sessionCookie(secure:boolean,value:string,maxAge=604800,kind='session',crossSite=false) {
  return `${caldockCookieName(secure,kind)}=${value}; Path=/; HttpOnly; SameSite=${crossSite?'None':'Lax'}; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
function appendCookie(reply:any,value:string) {const old=reply.getHeader('set-cookie');reply.header('Set-Cookie',[...(old?[old].flat():[]),value]);}
export async function issueCaldockSession(db:Queryable,userId:string) {
  const value=token(),csrf=token();
  await db.query("INSERT INTO caldock_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[hash(value),userId,csrf]);
  return {token:value,csrf};
}
export function caldockOptionsFromEnv(env:NodeJS.ProcessEnv):CaldockOptions {
  const providers:NonNullable<CaldockOptions['providers']>={};
  if(env.CALDOCK_GOOGLE_CLIENT_ID&&env.CALDOCK_GOOGLE_CLIENT_SECRET) providers.google=createCaldockGateway('google',{clientId:env.CALDOCK_GOOGLE_CLIENT_ID,clientSecret:env.CALDOCK_GOOGLE_CLIENT_SECRET});
  if(env.CALDOCK_APPLE_SERVICE_ID&&env.CALDOCK_APPLE_TEAM_ID&&env.CALDOCK_APPLE_KEY_ID&&env.CALDOCK_APPLE_PRIVATE_KEY) providers.apple=createCaldockGateway('apple',{clientId:env.CALDOCK_APPLE_SERVICE_ID,teamId:env.CALDOCK_APPLE_TEAM_ID,keyId:env.CALDOCK_APPLE_KEY_ID,privateKey:env.CALDOCK_APPLE_PRIVATE_KEY});
  return {publicUrl:env.APP_PUBLIC_URL||env.RENDER_EXTERNAL_URL||'http://localhost:4173',secureCookies:env.NODE_ENV==='production',marketingUrl:env.CALDOCK_MARKETING_URL||'https://yonge6.github.io/mac-mini-rental/',adminUserIds:(env.CALDOCK_ADMIN_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),providers};
}
export async function registerCaldockRoutes(app:FastifyInstance,db:Database,options:CaldockOptions={}) {
  const publicUrl=new URL(options.publicUrl||'http://localhost:4173');
  if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password)throw new Error('Invalid CalDock public URL');
  const origin=publicUrl.origin,secure=options.secureCookies===true,providers=options.providers||{};
  const admins=new Set(options.adminUserIds||[]);
  const market=new URL(options.marketingUrl||'https://yonge6.github.io/mac-mini-rental/');
  if(!['http:','https:'].includes(market.protocol)||market.username||market.password)throw new Error('Invalid CalDock marketing URL');
  const sessions=new WeakMap<FastifyRequest,Session>();
  const actor=(req:FastifyRequest)=>sessions.get(req)||deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to CalDock to continue');
  const admin=(req:FastifyRequest)=>{const current=actor(req);if(!admins.has(current.user.id))deny(403,'CALDOCK_ADMIN_REQUIRED','CalDock administrator access is required');return current;};
  const checkOrigin=(req:FastifyRequest)=>{if(req.headers.origin!==origin)deny(403,'CALDOCK_CSRF_INVALID','Request origin or security token is invalid');};
  const attempts=new Map<string,{count:number;expires:number}>();
  const limit=(req:FastifyRequest)=>{
    const now=Date.now(),key=hash(req.ip),record=attempts.get(key);
    if(record&&record.expires>now){if(++record.count>100)deny(429,'CALDOCK_RATE_LIMITED','Too many requests; try again shortly');}
    else attempts.set(key,{count:1,expires:now+60000});
    if(attempts.size>1000)for(const[k,v]of attempts)if(v.expires<=now)attempts.delete(k);
  };
  const returnUrl=(view:string,language:string,billing:string,error?:string)=>{const u=new URL('/caldock/',origin);u.searchParams.set('view',view);u.searchParams.set('lang',language);u.searchParams.set('interval',billing);if(error)u.searchParams.set('error',error);return u.toString();};
  async function referral(req:FastifyRequest,reply:any,code?:string) {
    const old=readCookie(req.headers.cookie,caldockCookieName(secure,'ref'));
    if(old){const row=(await db.query('SELECT token_hash FROM caldock_referral_visits WHERE token_hash=$1 AND expires_at>now()',[hash(old)])).rows[0];if(row)return row.token_hash;}
    if(!code)return null;
    const affiliate=(await db.query('SELECT user_id FROM caldock_affiliates WHERE code=$1 AND active=true',[code])).rows[0];
    if(!affiliate)return null;
    const value=token();
    await db.query("INSERT INTO caldock_referral_visits(token_hash,affiliate_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(value),affiliate.user_id]);
    appendCookie(reply,sessionCookie(secure,value,30*86400,'ref'));
    return hash(value);
  }
  app.register(async routes=>{
    routes.addHook('onRequest',async(req,reply)=>{
      reply.header('Cache-Control','no-store');
      const path=req.url.split('?')[0];
      if(path==='/caldock/capabilities'||path==='/caldock/referral-visits'||/^\/caldock\/auth\/(google|apple)\/(start|callback)$/.test(path))return;
      const value=readCookie(req.headers.cookie,caldockCookieName(secure));
      if(!value)deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to CalDock to continue');
      const row=(await db.query('SELECT u.*,s.csrf_token FROM caldock_sessions s JOIN caldock_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(value)])).rows[0];
      if(!row)deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to CalDock to continue');
      const {csrf_token,...user}=row;sessions.set(req,{user,csrf:csrf_token,token:value});
      if(!['GET','HEAD','OPTIONS'].includes(req.method)){
        checkOrigin(req);const supplied=req.headers['x-csrf-token'];
        if(typeof supplied!=='string'||!sameSecret(supplied,csrf_token))deny(403,'CALDOCK_CSRF_INVALID','Request origin or security token is invalid');
      }
    });
    routes.get('/capabilities',async()=>({service:'caldock',accountApp:origin+'/caldock/',providers:{google:!!providers.google,apple:!!providers.apple},payments:false,currency:'USD',prices:CALDOCK_PRICES,auth:{session:'httpOnlyCookie',csrf:true},referrals:{attributionDays:30,automaticPayouts:false}}));
    routes.post('/referral-visits',async(req,reply)=>{checkOrigin(req);limit(req);const input=z.object({code:z.string().regex(/^[A-Z0-9]{12}$/)}).strict().parse(req.body);await referral(req,reply,input.code);return {recorded:true};});
    for(const provider of ['google','apple'] as const){
      routes.get(`/auth/${provider}/start`,async(req,reply)=>{
        limit(req);const gateway=providers[provider];if(!gateway)deny(503,'CALDOCK_PROVIDER_NOT_CONFIGURED','This sign-in method is not available yet');
        const input=z.object({next:nextView.default('account'),lang:z.enum(['zh','en']).default('zh'),interval:interval.default('month'),ref:z.string().regex(/^[A-Z0-9]{12}$/).optional()}).strict().parse(req.query);
        const state=token(),browser=token(),nonce=token(),verifier=token();
        const referralHash=await referral(req,reply,input.ref);
        await db.query('DELETE FROM caldock_oauth_states WHERE expires_at<now()');
        await db.query("INSERT INTO caldock_oauth_states(state_hash,browser_hash,provider,nonce,verifier,next_view,interval,language,referral_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes')",[hash(state),hash(browser),provider,nonce,verifier,input.next,input.interval,input.lang,referralHash]);
        appendCookie(reply,sessionCookie(secure,browser,600,'oauth_'+provider,provider==='apple'&&secure));
        return reply.redirect(gateway.authorizationUrl({state,nonce,challenge:createHash('sha256').update(verifier).digest('base64url'),redirectUri:origin+`/api/caldock/auth/${provider}/callback`}));
      });
      routes.route({method:provider==='apple'?'POST':'GET',url:`/auth/${provider}/callback`,handler:async(req,reply)=>{
        limit(req);const gateway=providers[provider];if(!gateway)deny(503,'CALDOCK_PROVIDER_NOT_CONFIGURED','This sign-in method is not available yet');
        const input=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code:z.string().min(1).max(4096).optional(),error:z.string().max(100).optional(),user:z.string().max(4000).optional(),id_token:z.string().max(16000).optional()}).parse(provider==='apple'?req.body:req.query);
        const browser=readCookie(req.headers.cookie,caldockCookieName(secure,'oauth_'+provider));
        if(!browser)deny(400,'CALDOCK_OAUTH_STATE_INVALID','Sign-in expired; please start again');
        const state=(await db.query('DELETE FROM caldock_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND expires_at>now() RETURNING *',[hash(input.state),hash(browser),provider])).rows[0];
        if(!state)deny(400,'CALDOCK_OAUTH_STATE_INVALID','Sign-in expired; please start again');
        appendCookie(reply,sessionCookie(secure,'',0,'oauth_'+provider,provider==='apple'&&secure));
        if(input.error||!input.code)return reply.redirect(returnUrl('login',state.language,state.interval,'oauth_cancelled'));
        let identity;
        try {identity=await gateway.authenticate({code:input.code,nonce:state.nonce,verifier:state.verifier,redirectUri:origin+`/api/caldock/auth/${provider}/callback`});}
        catch {return reply.redirect(returnUrl('login',state.language,state.interval,'oauth_failed'));}
        if(identity.provider!==provider||!identity.subject||identity.subject.length>255)deny(400,'CALDOCK_IDENTITY_INVALID','Identity could not be verified');
        const user=await db.transaction(async tx=>{
          // One insert wins concurrent first logins; provider subject, never email, is the key.
          const newId=randomUUID();
          const prior=(await tx.query('SELECT u.* FROM caldock_identities i JOIN caldock_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2',[provider,identity.subject])).rows[0];
          if(prior){if(!prior.active)deny(403,'CALDOCK_ACCOUNT_DISABLED','This CalDock account is disabled');return prior;}
          await tx.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[newId,identity.name.slice(0,100)||'CalDock user',identity.email]);
          const linked=await tx.query('INSERT INTO caldock_identities(provider,subject,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[provider,identity.subject,newId]);
          if(!linked.rows.length){await tx.query('DELETE FROM caldock_users WHERE id=$1',[newId]);const current=(await tx.query('SELECT u.* FROM caldock_identities i JOIN caldock_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2',[provider,identity.subject])).rows[0];if(!current?.active)deny(403,'CALDOCK_ACCOUNT_DISABLED','This CalDock account is disabled');return current;}
          if(state.referral_hash){const visit=(await tx.query('SELECT v.affiliate_id FROM caldock_referral_visits v JOIN caldock_affiliates a ON a.user_id=v.affiliate_id WHERE v.token_hash=$1 AND v.expires_at>now() AND a.active=true AND v.affiliate_id<>$2',[state.referral_hash,newId])).rows[0];if(visit)await tx.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[newId,visit.affiliate_id]);}
          await caldockAudit(tx,newId,'account.created',newId,{provider});return (await tx.query('SELECT * FROM caldock_users WHERE id=$1',[newId])).rows[0];
        });
        const issued=await issueCaldockSession(db,user.id);appendCookie(reply,sessionCookie(secure,issued.token));
        return reply.redirect(returnUrl(state.next_view,state.language,state.interval));
      }});
    }
    routes.get('/me',async req=>{const current=actor(req);return {user:current.user,isAdmin:admins.has(current.user.id),csrfToken:current.csrf};});
    routes.delete('/session',async(req,reply)=>{const current=actor(req);await db.query('DELETE FROM caldock_sessions WHERE token_hash=$1',[hash(current.token)]);reply.header('Set-Cookie',sessionCookie(secure,'',0));return {signedOut:true};});
    routes.patch('/profile',async req=>{const current=actor(req),input=z.object({displayName:z.string().trim().min(1).max(100)}).strict().parse(req.body);return (await db.query('UPDATE caldock_users SET display_name=$2 WHERE id=$1 RETURNING id,display_name,email',[current.user.id,input.displayName])).rows[0];});
    routes.get('/orders',async req=>({items:(await db.query('SELECT * FROM caldock_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[actor(req).user.id])).rows}));
    routes.get<{Params:{id:string}}>('/orders/:id',async req=>{const row=(await db.query('SELECT * FROM caldock_orders WHERE id=$1 AND customer_id=$2',[id.parse(req.params.id),actor(req).user.id])).rows[0];if(!row)deny(404,'NOT_FOUND','Order not found');return row;});
    routes.post('/orders',async(req,reply)=>{const input=z.object({interval,requestKey:id}).strict().parse(req.body);return reply.code(201).send(await createCaldockOrder(db,actor(req).user.id,input.interval,input.requestKey));});
    routes.patch<{Params:{id:string}}>('/orders/:id',async req=>{
      const current=actor(req),input=z.object({action:z.enum(['cancel_pending','stop_renewal']),expectedVersion:z.number().int().positive()}).strict().parse(req.body);
      return db.transaction(async tx=>{const row=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',[id.parse(req.params.id),current.user.id])).rows[0];if(!row)deny(404,'NOT_FOUND','Order not found');if(row.version!==input.expectedVersion)deny(409,'VERSION_CONFLICT','Order changed; reload before continuing');if(input.action==='cancel_pending'&&row.status!=='pending_payment'||input.action==='stop_renewal'&&!['paid','provisioning','active'].includes(row.status))deny(409,'INVALID_ORDER_STATE','This order cannot perform the requested action');const updated=(await tx.query("UPDATE caldock_orders SET status=CASE WHEN $2='cancel_pending' THEN 'cancelled' ELSE status END,renewal_enabled=false,version=version+1 WHERE id=$1 RETURNING *",[row.id,input.action])).rows[0];await caldockAudit(tx,current.user.id,'order.'+input.action,row.id);return updated;});
    });
    routes.post('/affiliate',async req=>{const current=actor(req);await db.query('INSERT INTO caldock_affiliates(user_id,code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[current.user.id,randomBytes(6).toString('hex').toUpperCase()]);return {joined:true};});
    routes.get('/affiliate',async req=>{
      const current=actor(req),affiliate=(await db.query('SELECT * FROM caldock_affiliates WHERE user_id=$1',[current.user.id])).rows[0];
      const settings=(await db.query('SELECT commission_bps,commission_mode FROM caldock_settings WHERE id=1')).rows[0];
      if(!affiliate)return {affiliate:null,settings,commissions:[],stats:{registrations:0,orders:0,pendingCents:0,settledCents:0}};
      const link=new URL(market);link.searchParams.set('ref',affiliate.code);
      const counts=(await db.query('SELECT (SELECT count(*)::int FROM caldock_referrals WHERE affiliate_id=$1) AS registrations,(SELECT count(*)::int FROM caldock_orders WHERE affiliate_id=$1) AS orders',[current.user.id])).rows[0];
      const commissions=(await db.query('SELECT c.*,o.interval FROM caldock_commissions c JOIN caldock_orders o ON o.id=c.order_id WHERE c.affiliate_id=$1 ORDER BY c.created_at DESC LIMIT 100',[current.user.id])).rows;
      const sums=(await db.query("SELECT COALESCE(sum(amount_cents) FILTER(WHERE status IN ('pending','approved')),0)::bigint AS pending,COALESCE(sum(amount_cents) FILTER(WHERE status='settled'),0)::bigint AS settled FROM caldock_commissions WHERE affiliate_id=$1",[current.user.id])).rows[0];
      return {affiliate:{...affiliate,url:link.toString()},settings,commissions,stats:{...counts,pendingCents:Number(sums.pending),settledCents:Number(sums.settled)}};
    });
    routes.get('/admin/summary',async req=>{admin(req);return (await db.query("SELECT count(*)::int AS total_orders,count(*) FILTER(WHERE status IN ('paid','provisioning'))::int AS awaiting_delivery,count(*) FILTER(WHERE status='active')::int AS active_macs,COALESCE(sum(amount_cents) FILTER(WHERE status IN ('paid','provisioning','active')),0)::bigint AS paid_cents,(SELECT count(*)::int FROM caldock_users) AS customers,(SELECT COALESCE(sum(amount_cents),0)::bigint FROM caldock_commissions WHERE status IN ('pending','approved')) AS pending_commission_cents FROM caldock_orders")).rows[0];});
    routes.get('/admin/orders',async req=>{admin(req);const q=z.object({status:status.optional(),search:z.string().max(100).default(''),page:z.coerce.number().int().min(0).max(100000).default(0)}).strict().parse(req.query);const where="WHERE ($1::text IS NULL OR o.status=$1) AND ($2='' OR o.id ILIKE $3 OR u.email ILIKE $3 OR u.display_name ILIKE $3)";const params=[q.status||null,q.search,'%'+q.search+'%'];return {items:(await db.query(`SELECT o.*,u.email,u.display_name,a.code AS referral_code FROM caldock_orders o JOIN caldock_users u ON u.id=o.customer_id LEFT JOIN caldock_affiliates a ON a.user_id=o.affiliate_id ${where} ORDER BY o.created_at DESC,o.id LIMIT 50 OFFSET $4`,[...params,q.page*50])).rows,total:Number((await db.query(`SELECT count(*) FROM caldock_orders o JOIN caldock_users u ON u.id=o.customer_id ${where}`,params)).rows[0].count)};});
    routes.patch<{Params:{id:string}}>('/admin/orders/:id',async req=>{
      const current=admin(req),input=z.object({status:z.enum(['provisioning','active']),expectedVersion:z.number().int().positive(),deliveryNote:z.string().trim().max(1000).default('')}).strict().parse(req.body);
      return db.transaction(async tx=>{const order=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 FOR UPDATE',[id.parse(req.params.id)])).rows[0];if(!order)deny(404,'NOT_FOUND','Order not found');if(order.version!==input.expectedVersion)deny(409,'VERSION_CONFLICT','Order changed; reload before continuing');if(!(order.status==='paid'&&input.status==='provisioning'||order.status==='provisioning'&&input.status==='active'))deny(409,'INVALID_ORDER_STATE','Only verified paid orders can be provisioned and delivered');const row=(await tx.query("UPDATE caldock_orders SET status=$2,version=version+1,delivery_note=$3,delivered_at=CASE WHEN $2='active' THEN now() ELSE delivered_at END,billing_ends_at=CASE WHEN $2='active' THEN now()+CASE WHEN interval='year' THEN interval '1 year' ELSE interval '1 month' END ELSE billing_ends_at END WHERE id=$1 RETURNING *",[order.id,input.status,input.deliveryNote])).rows[0];await caldockAudit(tx,current.user.id,'order.'+input.status,order.id);return row;});
    });
    routes.get('/admin/settings',async req=>{admin(req);return (await db.query('SELECT * FROM caldock_settings WHERE id=1')).rows[0];});
    routes.get('/admin/customers',async req=>{admin(req);return {items:(await db.query('SELECT u.id,u.display_name,u.email,u.active,u.created_at,(SELECT count(*)::int FROM caldock_orders o WHERE o.customer_id=u.id) AS orders FROM caldock_users u ORDER BY u.created_at DESC LIMIT 100')).rows};});
    routes.patch('/admin/settings',async req=>{const current=admin(req),input=z.object({commissionBps:z.number().int().min(0).max(10000),commissionMode:z.enum(['first_order','each_order']),expectedVersion:z.number().int().positive()}).strict().parse(req.body);return db.transaction(async tx=>{const row=(await tx.query('UPDATE caldock_settings SET commission_bps=$1,commission_mode=$2,version=version+1,updated_at=now() WHERE id=1 AND version=$3 RETURNING *',[input.commissionBps,input.commissionMode,input.expectedVersion])).rows[0];if(!row)deny(409,'VERSION_CONFLICT','Settings changed; reload before continuing');await caldockAudit(tx,current.user.id,'affiliate.settings','1',{commissionBps:input.commissionBps,commissionMode:input.commissionMode});return row;});});
    routes.get('/admin/affiliates',async req=>{admin(req);return {items:(await db.query('SELECT a.*,u.display_name,u.email,(SELECT count(*)::int FROM caldock_referrals r WHERE r.affiliate_id=a.user_id) AS registrations,(SELECT count(*)::int FROM caldock_orders o WHERE o.affiliate_id=a.user_id) AS orders FROM caldock_affiliates a JOIN caldock_users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100')).rows};});
    routes.get('/admin/commissions',async req=>{admin(req);return {items:(await db.query('SELECT c.*,u.display_name,u.email FROM caldock_commissions c JOIN caldock_users u ON u.id=c.affiliate_id ORDER BY c.created_at DESC LIMIT 200')).rows};});
    routes.patch<{Params:{id:string}}>('/admin/commissions/:id',async req=>{
      const current=admin(req),input=z.object({status:z.enum(['approved','settled']),expectedStatus:z.enum(['pending','approved']),reference:z.string().trim().max(200).optional()}).strict().parse(req.body);
      if(input.status==='settled'&&(!input.reference||input.expectedStatus!=='approved')||input.status==='approved'&&input.expectedStatus!=='pending')deny(400,'SETTLEMENT_REFERENCE_REQUIRED','Record an approved offline settlement reference');
      return db.transaction(async tx=>{const row=(await tx.query("UPDATE caldock_commissions SET status=$2,settlement_reference=CASE WHEN $2='settled' THEN $4 ELSE settlement_reference END,settled_at=CASE WHEN $2='settled' THEN now() ELSE settled_at END WHERE id=$1 AND status=$3 RETURNING *",[id.parse(req.params.id),input.status,input.expectedStatus,input.reference||null])).rows[0];if(!row)deny(409,'VERSION_CONFLICT','Commission changed; reload before continuing');await caldockAudit(tx,current.user.id,'commission.'+input.status,row.id,{reference:input.reference||null,automaticTransfer:false});return row;});
    });
  },{prefix:'/caldock'});
}

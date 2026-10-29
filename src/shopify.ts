import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import type { SupportOptions } from './support.js';
import type { User } from './auth.js';
import { supportPermissions } from './support.js';
import { deny } from './errors.js';

export type ShopifyOptions={shopDomain?:string;clientId?:string;clientSecret?:string;accessToken?:string;fetcher?:typeof fetch;clock?:()=>number};
export const SHOPIFY_API_VERSION='2026-10';
const orderNumberInput=z.string().trim().min(1).max(64).regex(/^#?[A-Za-z0-9][A-Za-z0-9_-]*$/);
const lookupInput=z.object({orderNumber:orderNumberInput}).strict();
const shopHost=(value:string|undefined)=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(value)?value:null;
const present=(value:string|undefined)=>typeof value==='string'&&value.trim().length>0&&value.length<=4096;
const normalizedName=(value:string)=>value.startsWith('#')?value.slice(1):value;
const bounded=(v:unknown,max=500)=>typeof v==='string'?v.slice(0,max):'';
const iso=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const quantity=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const gid=(v:unknown,kind:string)=>typeof v==='string'&&new RegExp('^gid://shopify/'+kind+'/[0-9]+$').test(v)?v:null;
function trackingUrl(value:unknown){
  if(typeof value!=='string'||value.length>2000)return null;
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)return null;for(const key of u.searchParams.keys())if(/email|address|phone|customer|secret|password/i.test(key))return null;return u.href;}catch{return null;}
}
const ORDER_QUERY=`query WorkOSReadOrder($search: String!) {
  orders(first: 5, query: $search) {
    nodes {
      id name createdAt updatedAt displayFulfillmentStatus
      lineItems(first: 50) { nodes { title quantity currentQuantity } pageInfo { hasNextPage } }
      fulfillments(first: 51) {
        id status displayStatus deliveredAt estimatedDeliveryAt
        trackingInfo { company number url }
      }
    }
  }
}`;

async function jsonBounded(response:Response){
  if(!response.ok)throw new Error('shopify_unavailable');
  const limit=1024*1024,declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit)throw new Error('shopify_unavailable');
  const reader=response.body?.getReader();if(!reader)throw new Error('shopify_unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('shopify_unavailable');}chunks.push(value);}}finally{reader.releaseLock();}
  const data=Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8');
  try{return JSON.parse(data);}catch{throw new Error('shopify_unavailable');}
}

export class ShopifyReadClient {
  readonly shop:string|null;
  readonly configured:boolean;
  private readonly fetcher:typeof fetch;
  private readonly clock:()=>number;
  private token:string|null=null;
  private expiresAt=0;
  private refreshing:Promise<string>|null=null;
  constructor(private options:ShopifyOptions={}){
    this.shop=shopHost(options.shopDomain);this.fetcher=options.fetcher||fetch;this.clock=options.clock||Date.now;
    this.configured=!!this.shop&&(present(options.accessToken)||(present(options.clientId)&&present(options.clientSecret)));
  }
  private async accessToken(){
    if(!this.configured||!this.shop)throw new Error('shopify_not_configured');
    if(present(this.options.accessToken))return this.options.accessToken!;
    if(this.token&&this.clock()<this.expiresAt-60000)return this.token;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      const response=await this.fetcher('https://'+this.shop+'/admin/oauth/access_token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({grant_type:'client_credentials',client_id:this.options.clientId!,client_secret:this.options.clientSecret!}),signal:AbortSignal.timeout(10000)});
      const value=await jsonBounded(response);
      if(!present(value.access_token)||!Number.isFinite(value.expires_in)||value.expires_in<=0||value.expires_in>86400)throw new Error('shopify_unavailable');
      this.token=value.access_token;this.expiresAt=this.clock()+value.expires_in*1000;return this.token!;
    })();
    try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async lookup(orderNumber:string){
    const requested=normalizedName(orderNumberInput.parse(orderNumber));
    const token=await this.accessToken();
    const response=await this.fetcher('https://'+this.shop+'/admin/api/'+SHOPIFY_API_VERSION+'/graphql.json',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query:ORDER_QUERY,variables:{search:'name:'+JSON.stringify(requested)}}),signal:AbortSignal.timeout(10000)});
    // Expired client credentials are cleared for the next authorized lookup.
    // This request is not retried and no mutation or broadened query exists.
    if(response.status===401&&!present(this.options.accessToken)&&this.token===token){this.token=null;this.expiresAt=0;throw new Error('shopify_unavailable');}
    const value=await jsonBounded(response);
    if(value.errors?.length||!Array.isArray(value.data?.orders?.nodes)||value.data.orders.nodes.length>5)throw new Error('shopify_unavailable');
    const orders=[];
    for(const raw of value.data.orders.nodes){
      if(typeof raw?.name!=='string'||normalizedName(raw.name)!==requested)continue;
      if(!gid(raw.id,'Order')||!iso(raw.createdAt)||!iso(raw.updatedAt)||typeof raw.displayFulfillmentStatus!=='string'||!Array.isArray(raw.lineItems?.nodes)||raw.lineItems.nodes.length>50||typeof raw.lineItems.pageInfo?.hasNextPage!=='boolean'||!Array.isArray(raw.fulfillments)||raw.fulfillments.length>51)throw new Error('shopify_unavailable');
      const warnings:string[]=[];
      if(raw.lineItems.pageInfo.hasNextPage)warnings.push('line_items_truncated');
      if(raw.fulfillments.length>50)warnings.push('fulfillments_truncated');
      orders.push({id:raw.id,name:bounded(raw.name,128),createdAt:iso(raw.createdAt),updatedAt:iso(raw.updatedAt),fulfillmentStatus:bounded(raw.displayFulfillmentStatus,80),lineItems:raw.lineItems.nodes.map((item:any)=>({title:bounded(item?.title,500),quantity:quantity(item?.quantity),currentQuantity:quantity(item?.currentQuantity)})),lineItemsComplete:!raw.lineItems.pageInfo.hasNextPage,fulfillmentsComplete:raw.fulfillments.length<=50,fulfillments:raw.fulfillments.slice(0,50).map((item:any)=>{
        if(!gid(item?.id,'Fulfillment')||!Array.isArray(item?.trackingInfo)||item.trackingInfo.length>100)throw new Error('shopify_unavailable');
        return {id:item.id,status:bounded(item.status,80),displayStatus:typeof item.displayStatus==='string'?bounded(item.displayStatus,80):null,trackingInfo:item.trackingInfo.map((tracking:any)=>({company:typeof tracking?.company==='string'?bounded(tracking.company,200):null,number:typeof tracking?.number==='string'?bounded(tracking.number,200):null,url:trackingUrl(tracking?.url)})),deliveredAt:iso(item.deliveredAt),estimatedDeliveryAt:iso(item.estimatedDeliveryAt)};
      }),customerReceiptConfirmed:false,warnings});
    }
    return orders;
  }
}

export function shopifyOptionsFromEnv(env:NodeJS.ProcessEnv):ShopifyOptions{return {shopDomain:env.SHOPIFY_SHOP_DOMAIN,clientId:env.SHOPIFY_CLIENT_ID,clientSecret:env.SHOPIFY_CLIENT_SECRET,accessToken:env.SHOPIFY_ACCESS_TOKEN};}

export function registerShopifyRoutes(app:FastifyInstance,db:Database,options:ShopifyOptions={},support:SupportOptions={},executiveIds:string[]=[]){
  const client=new ShopifyReadClient(options);
  const actor=(user:User|null)=>{if(!user||!user.active||!supportPermissions(user,support,executiveIds).read)deny(403,'SUPPORT_FORBIDDEN','Support workspace access is required');return user;};
  app.get('/support/shopify/config',async req=>{actor(req.actor);return {configured:client.configured,shop:client.shop,mode:'read_only'};});
  app.post('/support/shopify/lookup',async req=>{
    const user=actor(req.actor),v=lookupInput.parse(req.body);
    if(!client.configured)return {status:'not_configured',orders:[],observedAt:null};
    const digest=createHash('sha256').update(normalizedName(v.orderNumber)).digest('hex');
    // The audit contains only an identifier hash and outcome. Order details and
    // upstream errors are neither persisted nor copied into audit/log records.
    let orders:Awaited<ReturnType<ShopifyReadClient['lookup']>>=[];let status:'ready'|'unavailable'='unavailable';
    try{orders=await client.lookup(v.orderNumber);status='ready';}catch{/* Deliberately discard provider bodies, credentials and exceptions. */}
    await db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$4,$5,$6,$7)',[randomUUID(),user.org_id,user.department_id,user.id,'support.shopify.lookup',digest,JSON.stringify({status,matchedOrders:orders.length,mode:'read_only'})]);
    return {status,orders,observedAt:status==='ready'?new Date((options.clock||Date.now)()).toISOString():null};
  });
}

import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {ZodError} from 'zod';
import {ApiError} from '../src/errors.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {ShopifyReadClient,registerShopifyRoutes,shopifyOptionsFromEnv,SHOPIFY_API_VERSION,type ShopifyOptions} from '../src/shopify.js';

const sampleOrder=(name='#1001')=>({id:'gid://shopify/Order/1001',name,createdAt:'2026-10-20T10:00:00Z',updatedAt:'2026-10-29T11:00:00Z',displayFulfillmentStatus:'PARTIALLY_FULFILLED',email:'CUSTOMER_EMAIL_SENTINEL',shippingAddress:{address1:'PRIVATE_ADDRESS_SENTINEL'},totalPriceSet:{shopMoney:{amount:'PAYMENT_SENTINEL'}},lineItems:{nodes:[{title:'Synthetic accessory',quantity:2,currentQuantity:1,customerComment:'PRIVATE_COMMENT_SENTINEL'}],pageInfo:{hasNextPage:false}},fulfillments:[{id:'gid://shopify/Fulfillment/2001',status:'SUCCESS',displayStatus:'DELIVERED',deliveredAt:'2026-10-28T12:00:00Z',estimatedDeliveryAt:null,trackingInfo:[{company:'Synthetic carrier',number:'TRACKING-FIXTURE',url:'https://carrier.example/track?id=TRACKING-FIXTURE'}]}]});
const response=(orders:any[]=[])=>new Response(JSON.stringify({data:{orders:{nodes:orders}}}),{status:200,headers:{'Content-Type':'application/json'}});
async function harness(t:TestContext,options:ShopifyOptions){
 let db:Database,admin:Database|undefined,ns:string|undefined;
 if(process.env.TEST_DATABASE_URL){admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});ns='shopify_test_'+randomUUID().replaceAll('-','');await admin.exec(`CREATE SCHEMA ${ns}`);const u=new URL(process.env.TEST_DATABASE_URL);u.searchParams.set('options',`-c search_path=${ns}`);db=await createDatabase({connectionString:u.toString()});}else db=await createDatabase();
 await db.exec(schema);await seedDemo(db);
 const app=Fastify({logger:false});app.decorateRequest('actor',null);
 // This is a module-level permission fixture, not a production authentication adapter.
 app.addHook('onRequest',async req=>{const fixture=String(req.headers['x-fixture-user']||'');req.actor=(await db.query('SELECT * FROM users WHERE id=$1',[fixture])).rows[0]||null;});
 app.setErrorHandler((error,_req,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR'}});if(error instanceof ApiError)return reply.code(error.status).send({error:{code:error.code}});return reply.code(500).send({error:{code:'INTERNAL_ERROR'}});});
 registerShopifyRoutes(app,db,options,{orgId:'demo',userIds:['m1']},['m4']);
 t.after(async()=>{await app.close();await db.close();if(admin&&ns){await admin.exec(`DROP SCHEMA ${ns} CASCADE`);await admin.close();}});
 return {app,db,call:(user:string,path:string,payload?:any)=>app.inject({method:payload?'POST':'GET',url:path,payload,headers:{'x-fixture-user':user}})};
}

test('Shopify restricts credentials to one exact myshopify host',async()=>{
 let calls=0;const fetcher=(async()=>{calls++;return response();}) as typeof fetch;
 for(const shopDomain of ['https://shop.myshopify.com','shop.myshopify.com.evil.example','shop.myshopify.com:443','shop.myshopify.com/path','shop.myshopify.com@evil.example','sub.shop.myshopify.com','localhost','-shop.myshopify.com','shop-.myshopify.com']){
  const client=new ShopifyReadClient({shopDomain,accessToken:'fixture-token',fetcher});assert.equal(client.configured,false);assert.equal(client.shop,null);await assert.rejects(()=>client.lookup('1001'));
 }
 assert.equal(calls,0);assert.equal(new ShopifyReadClient({shopDomain:'shop-1.myshopify.com',accessToken:'fixture-token'}).configured,true);
 const env=shopifyOptionsFromEnv({SHOPIFY_SHOP_DOMAIN:'shop.myshopify.com',SHOPIFY_CLIENT_ID:'fixture-id',SHOPIFY_CLIENT_SECRET:'fixture-secret'});assert.equal(env.shopDomain,'shop.myshopify.com');assert.equal(new ShopifyReadClient(env).configured,true);
});

test('lookup uses a fixed read query, escaped variable and exact order name; exports no customer or payment data',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(input),init:init!});return response([sampleOrder(),{...sampleOrder('#10010'),id:'gid://shopify/Order/10010'}]);}) as typeof fetch;
 const client=new ShopifyReadClient({shopDomain:'shop.myshopify.com',accessToken:'STATIC_SECRET_SENTINEL',fetcher});
 for(const invalid of ['1001 OR email:*','1001" OR name:*','1001:1002','1001\n1002','##1001'])await assert.rejects(()=>client.lookup(invalid));assert.equal(calls.length,0);
 const orders=await client.lookup(' #1001 ');assert.equal(orders.length,1);assert.equal(orders[0].name,'#1001');assert.equal(orders[0].customerReceiptConfirmed,false);assert.equal(orders[0].fulfillments[0].displayStatus,'DELIVERED');assert.equal(orders[0].fulfillments[0].estimatedDeliveryAt,null);
 const req=JSON.parse(String(calls[0].init.body));assert.equal(req.variables.search,'name:"1001"');assert.ok(req.query.startsWith('query WorkOSReadOrder'));assert.ok(!/mutation|email|shippingAddress|totalPriceSet|customer\s*\{/i.test(req.query));assert.equal(calls[0].url,'https://shop.myshopify.com/admin/api/'+SHOPIFY_API_VERSION+'/graphql.json');assert.equal(calls[0].init.redirect,'error');
 const serialized=JSON.stringify(orders);for(const sentinel of ['CUSTOMER_EMAIL_SENTINEL','PRIVATE_ADDRESS_SENTINEL','PAYMENT_SENTINEL','PRIVATE_COMMENT_SENTINEL','STATIC_SECRET_SENTINEL'])assert.ok(!serialized.includes(sentinel));
});

test('client credentials exchange refreshes before expiry and is shared across concurrent requests',async()=>{
 let now=1000000000000,tokens=0,queries=0;const headers:string[]=[];
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/admin/oauth/access_token')){tokens++;const fields=new URLSearchParams(String(init?.body));assert.equal(fields.get('grant_type'),'client_credentials');assert.equal(fields.get('client_id'),'fixture-client');assert.equal(fields.get('client_secret'),'fixture-secret');assert.equal(init?.redirect,'error');return new Response(JSON.stringify({access_token:'token-fixture-'+tokens,expires_in:120}));}
  queries++;headers.push(String((init?.headers as Record<string,string>)['X-Shopify-Access-Token']));return response([sampleOrder()]);
 }) as typeof fetch;
 const client=new ShopifyReadClient({shopDomain:'shop.myshopify.com',clientId:'fixture-client',clientSecret:'fixture-secret',fetcher,clock:()=>now});
 await Promise.all([client.lookup('1001'),client.lookup('#1001')]);assert.equal(tokens,1);assert.equal(queries,2);
 now+=10000;await client.lookup('1001');assert.equal(tokens,1);
 now+=51000;await client.lookup('1001');assert.equal(tokens,2);assert.deepEqual(headers,['token-fixture-1','token-fixture-1','token-fixture-1','token-fixture-2']);
});

test('failed tokens, redirects, invalid provider shapes and GraphQL errors do not return an empty ready result',async()=>{
 const options={shopDomain:'shop.myshopify.com',accessToken:'fixture-static'};
 for(const fetcher of [async()=>new Response('UPSTREAM_SECRET',{status:401}),async()=>new Response('UPSTREAM_SECRET',{status:302,headers:{Location:'https://evil.example'}}),async()=>new Response(JSON.stringify({errors:[{message:'UPSTREAM_SECRET'}],data:{orders:{nodes:[]}}})),async()=>new Response(JSON.stringify({data:{orders:{nodes:'invalid'}}})),async()=>{throw new Error('UPSTREAM_SECRET');}])await assert.rejects(()=>new ShopifyReadClient({...options,fetcher:fetcher as typeof fetch}).lookup('1001'));
 await assert.rejects(()=>new ShopifyReadClient({shopDomain:'shop.myshopify.com',clientId:'id',clientSecret:'secret',fetcher:(async()=>new Response(JSON.stringify({access_token:'fixture',expires_in:0}))) as typeof fetch}).lookup('1001'));
});

test('tracking links are HTTPS-only and partial item or package lists are explicitly marked',async()=>{
 const raw=sampleOrder() as any;raw.lineItems.pageInfo.hasNextPage=true;raw.fulfillments=Array.from({length:51},(_,i)=>({...raw.fulfillments[0],id:'gid://shopify/Fulfillment/'+(3000+i),trackingInfo:[{company:'Fixture',number:'FIXTURE-'+i,url:i===0?'javascript:alert(1)':i===1?'https://carrier.example/track?email=PRIVATE_EMAIL':'https://carrier.example/track?id='+i}]}));
 const result=await new ShopifyReadClient({shopDomain:'shop.myshopify.com',accessToken:'fixture',fetcher:(async()=>response([raw])) as typeof fetch}).lookup('1001');
 assert.equal(result[0].fulfillments.length,50);assert.equal(result[0].lineItemsComplete,false);assert.equal(result[0].fulfillmentsComplete,false);assert.deepEqual(result[0].warnings,['line_items_truncated','fulfillments_truncated']);assert.equal(result[0].fulfillments[0].trackingInfo[0].url,null);assert.equal(result[0].fulfillments[1].trackingInfo[0].url,null);assert.equal(result[0].customerReceiptConfirmed,false);
});

test('internal Shopify routes check identity, organization and active support scope before provider requests',async t=>{
 let calls=0;const h=await harness(t,{shopDomain:'shop.myshopify.com',accessToken:'fixture',fetcher:(async()=>{calls++;return response([sampleOrder()]);}) as typeof fetch});
 for(const who of ['','m2']){assert.equal((await h.call(who,'/support/shopify/config')).statusCode,403);assert.equal((await h.call(who,'/support/shopify/lookup',{orderNumber:'1001'})).statusCode,403);}assert.equal(calls,0);
 await h.db.query("UPDATE users SET org_id='other' WHERE id='m1'");assert.equal((await h.call('m1','/support/shopify/lookup',{orderNumber:'1001'})).statusCode,403);assert.equal(calls,0);
 await h.db.query("UPDATE users SET org_id='demo',active=false WHERE id='m1'");assert.equal((await h.call('m1','/support/shopify/lookup',{orderNumber:'1001'})).statusCode,403);assert.equal(calls,0);
 const config=(await h.call('m4','/support/shopify/config')).json();assert.deepEqual(config,{configured:true,shop:'shop.myshopify.com',mode:'read_only'});
 assert.equal((await h.call('m4','/support/shopify/lookup',{orderNumber:'1001',actorId:'m1'})).statusCode,400);assert.equal(calls,0);
 const result=await h.call('m4','/support/shopify/lookup',{orderNumber:'#1001'});assert.equal(result.statusCode,200);assert.equal(result.json().status,'ready');assert.equal(calls,1);
 const audit=(await h.db.query("SELECT * FROM audit_events WHERE action='support.shopify.lookup'")).rows;assert.equal(audit.length,1);assert.equal(audit[0].actor_id,'m4');assert.equal(audit[0].object_id.length,64);assert.deepEqual(audit[0].details,{status:'ready',matchedOrders:1,mode:'read_only'});assert.ok(!JSON.stringify(audit).includes('CUSTOMER_EMAIL_SENTINEL'));
});

test('unconfigured and failed lookup responses stay explicit and redact provider secrets',async t=>{
 const empty=await harness(t,{});const missing=(await empty.call('m1','/support/shopify/lookup',{orderNumber:'1001'})).json();assert.deepEqual(missing,{status:'not_configured',orders:[],observedAt:null});
 const failing=await harness(t,{shopDomain:'shop.myshopify.com',accessToken:'fixture',fetcher:(async()=>{throw new Error('PROVIDER_SECRET_SENTINEL');}) as typeof fetch});const failed=await failing.call('m1','/support/shopify/lookup',{orderNumber:'1001'});assert.deepEqual(failed.json(),{status:'unavailable',orders:[],observedAt:null});assert.ok(!failed.body.includes('PROVIDER_SECRET_SENTINEL'));
 const emptyMatch=await harness(t,{shopDomain:'shop.myshopify.com',accessToken:'fixture',fetcher:(async()=>response([sampleOrder('#10010')])) as typeof fetch});const noExact=(await emptyMatch.call('m1','/support/shopify/lookup',{orderNumber:'1001'})).json();assert.equal(noExact.status,'ready');assert.deepEqual(noExact.orders,[]);assert.ok(noExact.observedAt);
});

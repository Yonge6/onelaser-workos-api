import { request, type RequestOptions } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type BotConfig = {webhookUrl:string;webhookSecret:string;allowedHost:string;workerToken:string;orgId:string};
export type DispatchOutcome = {status:'pending'|'dispatch_unknown'|'failed';errorCode?:'BOT_DISPATCH_UNKNOWN'|'BOT_DISPATCH_REJECTED'};
const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)blocked.addSubnet(ip,bits,'ipv4');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
const blockedV6=new BlockList();for(const [ip,bits]of [['2001::',32],['2001:db8::',32],['2002::',16]]as const)blockedV6.addSubnet(ip,bits,'ipv6');
export function isPublicAddress(address:string){
  const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!blockedV6.check(address,'ipv6');
}
/** Resolve and pin a public address for TLS; never follow redirects or forward credentials to another host. */
async function secureWebhook(url:URL,secret:string,jobId:string):Promise<number>{
  const signal=AbortSignal.timeout(15000);
  const addresses=await Promise.race([lookup(url.hostname,{all:true}),new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))]);
  if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new Error('Invalid webhook address');
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({jobId});
    const options:RequestOptions&{autoSelectFamily:boolean}={method:'POST',signal,autoSelectFamily:false,
      lookup:(_host,_options,callback)=>callback(null,addresses[0].address,addresses[0].family),
      headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}};
    const req=request(url,options,res=>{resolve(res.statusCode||0);res.destroy();});
    req.once('error',reject);req.end(body);
  });
}
export class GrokBotAdapter {
  readonly workerToken:string;readonly orgId:string;private url:URL;
  constructor(private config:BotConfig,private fetcher?:typeof fetch){
    this.url=new URL(config.webhookUrl);
    const host=config.allowedHost.toLowerCase();
    if(this.url.protocol!=='https:'||this.url.username||this.url.password||this.url.search||this.url.hash||this.url.port||this.url.hostname!==host||!host.includes('.')||host.endsWith('.')||isIP(host)||!/^[a-z0-9.-]+$/.test(host)||host.split('.').some(part=>!part||part.startsWith('-')||part.endsWith('-'))||/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)||!config.webhookSecret||/[\r\n]/.test(config.webhookSecret)||config.webhookSecret.length>4096||config.workerToken.length<32||config.workerToken.length>4096||/\s/.test(config.workerToken)||config.workerToken===config.webhookSecret||!config.orgId||config.orgId.length>128)throw new Error('Invalid Grok Bot configuration');
    this.workerToken=config.workerToken;this.orgId=config.orgId;
  }
  async dispatch(jobId:string):Promise<DispatchOutcome>{
    try{
      // Official routines: authenticated POST starts a run; HTTP 200 does not indicate completion.
      // https://cursor.com/help/grok-bot/routines
      let status:number;
      if(this.fetcher){const response=await this.fetcher(this.url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${this.config.webhookSecret}`,'Content-Type':'application/json'},body:JSON.stringify({jobId}),signal:AbortSignal.timeout(15000)});status=response.status;await response.body?.cancel();}
      else status=await secureWebhook(this.url,this.config.webhookSecret,jobId);
      return status===200?{status:'pending'}:{status:'failed',errorCode:'BOT_DISPATCH_REJECTED'};
    }catch{return {status:'dispatch_unknown',errorCode:'BOT_DISPATCH_UNKNOWN'};}
  }
}

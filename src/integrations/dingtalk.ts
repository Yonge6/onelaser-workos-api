/** Fixed DingTalk vendor endpoints; no user-supplied upstream URLs. */
export type DingTalkConfig = {
  clientId: string; clientSecret: string; corpId: string; agentId?: string;
  allowedDepartmentIds: string[]; managerUserIds: string[]; redirectUri: string;
};
export type DingTalkProfile = {
  externalUserId: string; unionId: string; name: string; departmentId: string;
  departmentName: string; role: 'employee' | 'manager';
};
export class DingTalkError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
type Json = Record<string, any>;
const numericId = /^\d{1,20}$/;
const userId = /^[A-Za-z0-9_.@-]{1,128}$/;
export class DingTalkClient {
  private token?: { value: string; expires: number };
  private pendingToken?: Promise<string>;
  private readonly allowed: Set<string>;
  private readonly managers: Set<string>;
  constructor(private readonly config: DingTalkConfig, private readonly fetcher: typeof fetch = fetch) {
    const redirect = new URL(config.redirectUri);
    if (!config.clientId || !config.clientSecret || !config.corpId || redirect.protocol !== 'https:' || redirect.username || redirect.password || !config.allowedDepartmentIds.length || config.allowedDepartmentIds.some(x => !numericId.test(x) || !Number.isSafeInteger(Number(x)) || Number(x) < 1)) throw new DingTalkError('DINGTALK_CONFIGURATION_INVALID', 503);
    if (config.agentId && !numericId.test(config.agentId)) throw new DingTalkError('DINGTALK_CONFIGURATION_INVALID', 503);
    this.allowed = new Set(config.allowedDepartmentIds); this.managers = new Set(config.managerUserIds);
  }
  authorizationUrl(state: string) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(state)) throw new DingTalkError('OAUTH_STATE_INVALID',400);
    const url = new URL('https://login.dingtalk.com/oauth2/auth');
    url.search = new URLSearchParams({ redirect_uri:this.config.redirectUri,response_type:'code',client_id:this.config.clientId,scope:'openid corpid',state,prompt:'consent' }).toString();
    return url.toString();
  }
  private async request(url: string, init: RequestInit = {}): Promise<Json> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, signal:AbortSignal.timeout(15000) }); }
    catch { throw new DingTalkError('DINGTALK_UNAVAILABLE',502); }
    let data: Json;
    try { data = await response.json() as Json; }
    catch { throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502); }
    if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data) || (data.errcode !== undefined && data.errcode !== 0)) throw new DingTalkError('DINGTALK_REQUEST_FAILED',502);
    return data;
  }
  private json(body: unknown): RequestInit { return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}; }
  private async appToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      const data = await this.request('https://api.dingtalk.com/v1.0/oauth2/accessToken',this.json({appKey:this.config.clientId,appSecret:this.config.clientSecret}));
      if (typeof data.accessToken !== 'string' || !data.accessToken || !Number.isFinite(data.expireIn) || data.expireIn <= 0) throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
      this.token = {value:data.accessToken,expires:Date.now()+Math.max(1,data.expireIn-60)*1000};return data.accessToken;
    })();
    try { return await this.pendingToken; } finally { this.pendingToken = undefined; }
  }
  private async enterprise(path: string, body: unknown): Promise<Json> {
    const token = await this.appToken();
    const url = new URL('https://oapi.dingtalk.com'+path);url.searchParams.set('access_token',token);
    return this.request(url.toString(),this.json(body));
  }
  private async member(externalUserId: string, expectedUnionId?: string): Promise<DingTalkProfile> {
    if (!userId.test(externalUserId)) throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
    const response=await this.enterprise('/topapi/v2/user/get',{userid:externalUserId});
    const member=response.result;
    if (!member || member.active !== true || member.userid !== externalUserId || typeof member.unionid !== 'string' || !member.unionid || (expectedUnionId && member.unionid !== expectedUnionId)) throw new DingTalkError('DINGTALK_MEMBERSHIP_REJECTED',403);
    const departmentId=this.config.allowedDepartmentIds.find(id=>Array.isArray(member.dept_id_list)&&member.dept_id_list.some((v:unknown)=>String(v)===id));
    if (!departmentId) throw new DingTalkError('DINGTALK_DEPARTMENT_FORBIDDEN',403);
    const department=await this.enterprise('/topapi/v2/department/get',{dept_id:Number(departmentId),language:'zh_CN'});
    if (typeof department.result?.name !== 'string' || String(department.result.dept_id)!==departmentId || typeof member.name !== 'string' || !member.name) throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
    return {externalUserId,unionId:member.unionid,name:member.name,departmentId,departmentName:department.result.name,role:this.managers.has(externalUserId)?'manager':'employee'};
  }
  async authenticate(authCode: string): Promise<DingTalkProfile> {
    if (typeof authCode !== 'string' || authCode.length<1 || authCode.length>2048) throw new DingTalkError('OAUTH_CODE_INVALID',400);
    const token=await this.request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',this.json({clientId:this.config.clientId,clientSecret:this.config.clientSecret,code:authCode,grantType:'authorization_code'}));
    if (typeof token.accessToken !== 'string' || !token.accessToken) throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
    if (token.corpId!==this.config.corpId) throw new DingTalkError('DINGTALK_CORPORATION_FORBIDDEN',403);
    const profile=await this.request('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':token.accessToken}});
    if (typeof profile.unionId!=='string' || !profile.unionId) throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
    const mapping=await this.enterprise('/topapi/user/getbyunionid',{unionid:profile.unionId});
    // Official schema uses Number, its example uses "0": https://open.dingtalk.com/document/orgapp/query-a-user-by-the-union-id.md
    const contactType=mapping.result?.contact_type;
    if ((contactType!==0 && contactType!=='0') || typeof mapping.result?.userid!=='string') throw new DingTalkError('DINGTALK_MEMBERSHIP_REJECTED',403);
    return this.member(mapping.result.userid,profile.unionId);
  }
  async listDepartmentUsers(deptId: string): Promise<DingTalkProfile[]> {
    if (!this.allowed.has(deptId)) throw new DingTalkError('DINGTALK_DEPARTMENT_FORBIDDEN',403);
    const ids=new Set<string>();let cursor=0;const seenCursors=new Set<number>();
    for(let page=0;page<20;page++){
      if(seenCursors.has(cursor)) throw new DingTalkError('DINGTALK_PAGINATION_INVALID',502);seenCursors.add(cursor);
      const data=await this.enterprise('/topapi/v2/user/list',{dept_id:Number(deptId),cursor,size:100});
      const result=data.result;if(!result||!Array.isArray(result.list))throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
      for(const item of result.list){if(typeof item.userid!=='string'||!userId.test(item.userid))throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);ids.add(item.userid);}
      if(ids.size>2000)throw new DingTalkError('DINGTALK_DIRECTORY_LIMIT',502);
      if(!result.has_more){const profiles:DingTalkProfile[]=[];for(const id of ids)profiles.push(await this.member(id));return profiles;}
      if(!Number.isSafeInteger(result.next_cursor)||result.next_cursor<0)throw new DingTalkError('DINGTALK_PAGINATION_INVALID',502);cursor=result.next_cursor;
    }
    throw new DingTalkError('DINGTALK_DIRECTORY_LIMIT',502);
  }
  async sendWorkNotification(userIds: string[], content: string): Promise<{taskId: string}> {
    if(!this.config.agentId)throw new DingTalkError('DINGTALK_NOTIFICATIONS_NOT_CONFIGURED',503);
    if(!Array.isArray(userIds)||userIds.length<1||userIds.length>100||userIds.some(id=>!userId.test(id))||typeof content!=='string'||!content.trim()||content.length>4000)throw new DingTalkError('DINGTALK_NOTIFICATION_INVALID',400);
    const data=await this.enterprise('/topapi/message/corpconversation/asyncsend_v2',{agent_id:this.config.agentId,userid_list:[...new Set(userIds)].join(','),to_all_user:false,msg:{msgtype:'text',text:{content}}});
    if(typeof data.task_id!=='number'&&typeof data.task_id!=='string')throw new DingTalkError('DINGTALK_INVALID_RESPONSE',502);
    return {taskId:String(data.task_id)};
  }
}

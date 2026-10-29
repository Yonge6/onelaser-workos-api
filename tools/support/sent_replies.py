"""Read successful public agent emails only; no customer delivery or remote writes."""
import datetime,json,os,pathlib,re,sqlite3,sys,time
BASE='https://desk.zoho.com/api/v1'
def stamp(value):
    d=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if d.tzinfo is None:raise ValueError('timestamp_missing_zone')
    if d.timestamp()>time.time()+300:raise ValueError('future_source')
    return d.timestamp()
def sent(t):
    return t.get('channel')=='EMAIL' and t.get('direction')=='out' and t.get('status')=='SUCCESS' and t.get('isForward') is False and t.get('visibility')=='public' and t.get('author',{}).get('type')=='AGENT'
def identifier(v):
    if not isinstance(v,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,120}',v):raise ValueError('invalid_id')
    return v
def read_ticket(reader,config,ticket_id,body_parser,cached=()):
    ident=identifier(ticket_id);ticket=reader._get(BASE+'/tickets/'+ident)
    if str(ticket.get('id'))!=ident or str(ticket.get('departmentId')) not in config.allowed_departments or ('orgId' in ticket and str(ticket['orgId'])!=config.org_id):raise ValueError('source_scope_mismatch')
    rows=[];seen=set()
    for offset in range(0,1000,100):
        page=reader._get(BASE+'/tickets/'+ident+'/threads?from='+str(offset)+'&limit=100').get('data')
        if not isinstance(page,list) or len(page)>100:raise ValueError('invalid_threads')
        for t in page:
            tid=identifier(str(t.get('id','')))
            if tid in seen:raise ValueError('duplicate_thread')
            seen.add(tid)
            if sent(t):stamp(t['createdTime']);rows.append(t)
        if len(page)<100:break
    else:raise ValueError('thread_page_limit')
    result=[];known={r['id']:r for r in cached}
    for t in sorted(rows,key=lambda t:stamp(t['createdTime']),reverse=True)[:3]:
        tid=identifier(str(t['id']))
        prior=known.get(tid)
        if prior and prior['sentAt']==t['createdTime'] and stamp(prior['observedAt'])>time.time()-86400:
            result.append(prior);continue
        detail=reader._get(BASE+'/tickets/'+ident+'/threads/'+tid+'?include=plainText')
        if str(detail.get('id'))!=tid or not sent(detail) or detail['createdTime']!=t['createdTime']:raise ValueError('thread_binding_mismatch')
        # Get Thread explicitly includes its plainText body, never the list summary.
        body=detail.get('plainText')
        if not isinstance(body,str) or not body.strip() or detail.get('isTruncated') is True:
            original=reader._get(BASE+'/tickets/'+ident+'/threads/'+tid+'/originalContent')
            body=body_parser(ticket,detail,original)['body']
        if not body.strip() or len(body)>100000:raise ValueError('body_missing_or_too_large')
        parent=detail.get('inReplyToThreadId')
        result.append({'id':tid,'ticketId':ident,'inReplyToThreadId':identifier(str(parent)) if parent else None,'body':body,'sentAt':detail['createdTime'],'agentName':str(detail['author'].get('name') or '')[:200],'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'source':'zoho_sent_email','complete':True})
    return result

def collect(root,ticket_ids,max_tickets=1):
    root=pathlib.Path(root).resolve();private=root/'.private';cfgpath=private/'bridge-env.json'
    sys.path.insert(0,str(root/'support-agent-bridge'))
    from bridge import Config
    from zoho_native import ZohoReadAdapter
    from mail_forwarding import snapshot_from_original
    # Pass only the existing read credential fields; never import dispatcher secrets into the environment.
    if cfgpath.stat().st_mode&0o077:raise ValueError('private_permissions_required')
    cfg=json.loads(cfgpath.read_text());keys={'ZOHO_ORG_ID':'org_id','ZOHO_CLIENT_ID':'zoho_client_id','ZOHO_CLIENT_SECRET':'zoho_client_secret','ZOHO_REFRESH_TOKEN':'zoho_refresh_token','ZOHO_ACCESS_TOKEN':'zoho_access_token'}
    config=Config(**{name:cfg.get(key,'') for key,name in keys.items()},allowed_departments=tuple(x.strip() for x in cfg.get('ZOHO_ALLOWED_DEPARTMENTS','').split(',') if x.strip()))
    if not config.org_id or not config.allowed_departments:raise ValueError('read_scope_unconfigured')
    reader=ZohoReadAdapter(config);path=private/'workos-sent-replies.sqlite3';db=sqlite3.connect(path);os.chmod(path,0o600)
    db.execute('CREATE TABLE IF NOT EXISTS cache(ticket_id TEXT PRIMARY KEY,checked_at REAL NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)')
    cached={r[0]:r for r in db.execute('SELECT ticket_id,checked_at,status,data FROM cache')}
    due=sorted(ticket_ids,key=lambda tid:cached.get(tid,(None,0))[1])
    for tid in [t for t in due if cached.get(t,(None,0))[1]<time.time()-300][:max_tickets]:
        try:values=read_ticket(reader,config,tid,snapshot_from_original,json.loads(cached.get(tid,(None,0,None,'[]'))[3]));status='ready'
        except Exception:values=json.loads(cached.get(tid,(None,0,None,'[]'))[3]);status='unavailable'
        db.execute('INSERT INTO cache VALUES(?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,data=excluded.data',(tid,time.time(),status,json.dumps(values,ensure_ascii=False)));db.commit()
    rows=[r for r in db.execute('SELECT ticket_id,checked_at,status,data FROM cache') if r[0] in ticket_ids];db.close()
    records=sorted([x for r in rows for x in json.loads(r[3])],key=lambda r:r['sentAt'],reverse=True)[:1000]
    budget=2*1024*1024;bounded=[]
    for record in records:
        size=len(json.dumps(record,ensure_ascii=False).encode())
        if size<=budget:bounded.append(record);budget-=size
    truncated=len(bounded)<len(records);records=bounded
    complete=not truncated and len(rows)==len(ticket_ids) and all(r[2]=='ready' and r[1]>time.time()-600 for r in rows)
    return records,{'status':'ready' if complete else 'partial' if records else 'unavailable','observedAt':max((x['observedAt'] for x in records),default=None)}

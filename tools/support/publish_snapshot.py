"""Read-only connector for the existing Mac support pilot. Never sends customer mail.
Run with a private JSON config path; no credential values in command arguments.
"""
import argparse, datetime, hashlib, json, os, pathlib, sqlite3, subprocess, sys, time
import urllib.request, urllib.error
UUID='4782005C-E75C-406A-A195-A4A2AA8369C5'
def iso(value):
    return datetime.datetime.fromtimestamp(float(value),datetime.timezone.utc).isoformat().replace('+00:00','Z') if value else None

def deadline(value):
    if isinstance(value,(int,float)):return iso(value)
    return value if isinstance(value,str) else None

def snapshot(root):
    root=pathlib.Path(root).resolve()
    sys.path.insert(0,str(root/'support-knowledge'))
    from preview_data import Library
    from standard_answers import Catalogue
    library=Library();catalogue=Catalogue(library)
    db=sqlite3.connect('file:'+str(root/'.private/bridge.sqlite3')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    db.execute('BEGIN')
    tickets=[dict(r) for r in db.execute('SELECT * FROM tickets ORDER BY occurred_at DESC LIMIT 500')]
    cases={r['ticket_id']:{**json.loads(r['data']),'observed_at':r['observed_at']} for r in db.execute('SELECT * FROM support_watch_cases')}
    ids={t['id'] for t in tickets}
    drafts=[dict(r) for r in db.execute('SELECT * FROM drafts ORDER BY created_at DESC LIMIT 1000') if r['ticket_id'] in ids]
    jobs={r['status']:r['n'] for r in db.execute('SELECT j.status,count(*) n FROM jobs j JOIN tickets t ON j.ticket_id=t.id AND j.revision=t.revision GROUP BY j.status')}
    poller=db.execute('SELECT last_success FROM poller_state ORDER BY last_success DESC LIMIT 1').fetchone()
    watch=db.execute("SELECT last_success FROM support_watch_state WHERE name='main'").fetchone()
    db.rollback();db.close()
    def sources(items):return [{'title':str(x.get('title',''))[:500],'url':x['url'],'version':str(x.get('version') or x.get('body_sha256') or 'source snapshot')[:200]} for x in items]
    return {'version':1,'observedAt':iso(time.time()),'runtime':'mac-pilot','pollerLastSuccess':iso(poller[0]) if poller else None,'watchLastSuccess':iso(watch[0]) if watch else None,
      'dispatchPaused':(root/'.private/grok-dispatch.pause').exists(),
      'articles':[{'id':a['id'],'title':a['title'][:500],'family':a['family'],'body':a['body_text'][:100000],'sourceUrl':a['source_url'],'sourceVersion':str(a['source_updated_at'] or a['body_sha256'])[:200]} for a in library.articles.values()],
      'answers':[{'id':a['id'],'title':a['title'],'family':a['family'],'body':a['reply_en'],'note':'\n'.join(a['review_notes']) if isinstance(a['review_notes'],list) else str(a['review_notes']),'sources':sources(a['sources'])} for a in (catalogue.material(i) for i in catalogue.items)],
      'tickets':[{'id':t['id'],'number':str(cases.get(t['id'],{}).get('ticket_number','')),'subject':str(cases.get(t['id'],{}).get('subject',''))[:500],'status':str(cases.get(t['id'],{}).get('status',t['state']))[:100],'revision':t['revision'],'reasons':cases.get(t['id'],{}).get('reasons',[]),'observedAt':iso(cases.get(t['id'],{}).get('observed_at')),'responseDueAt':deadline(cases.get(t['id'],{}).get('response_due_at')),'resolutionDueAt':deadline(cases.get(t['id'],{}).get('resolution_due_at'))} for t in tickets],
      'drafts':[{'id':d['id'],'ticketId':d['ticket_id'],'revision':d['revision'],'version':d['version'],'status':d['status'],'body':d['content'],'sources':sources(json.loads(d['sources'])),'createdAt':iso(d['created_at'])} for d in drafts],
      'jobs':{'pending':sum(jobs.get(k,0) for k in ['pending','awaiting_callback','running']), 'attention':sum(jobs.get(k,0) for k in ['stalled','ambiguous','blocked','failed'])},
      'sla':{'status':'draft','body':(root/'support-agent-bridge/docs/SLA与SOP草案.md').read_text()[:100000]}}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def run(config_path,once=False,dry_run=False):
    cfgpath=pathlib.Path(config_path)
    if cfgpath.stat().st_mode&0o077:raise ValueError('private_config_permissions_required')
    cfg=json.loads(cfgpath.read_text())
    if cfg['origin'] not in ('https://craftos.app','https://onelaser-workos.onrender.com'):raise ValueError('origin_not_allowed')
    if len(cfg['token'])<32:raise ValueError('token_invalid')
    import fcntl
    lock=open(cfgpath.with_suffix('.lock'),'a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    while True:
        try:
            info=subprocess.run(['/usr/sbin/diskutil','info','/Volumes/DevSSD'],capture_output=True,text=True,check=True).stdout
            if UUID not in info:raise ValueError('devssd_unavailable')
            data=snapshot(cfg['projectRoot']);raw=json.dumps(data,ensure_ascii=False).encode()
            if len(raw)>8*1024*1024:raise ValueError('snapshot_too_large')
            if not dry_run:
                req=urllib.request.Request(cfg['origin']+'/api/support/ingest',data=raw,headers={'Authorization':'Bearer '+cfg['token'],'Content-Type':'application/json'},method='POST')
                with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as response:
                    result=json.load(response)
                    if not result.get('stored'):raise ValueError('snapshot_not_accepted')
            print(json.dumps({'status':'validated' if dry_run else 'synced','at':data['observedAt'],'articles':len(data['articles']),'tickets':len(data['tickets']),'drafts':len(data['drafts']),'bytes':len(raw),'customerSendEnabled':False}),flush=True)
        except Exception as e:
            # Fixed categories only: never include provider bodies, URLs, credentials or customer content.
            print(json.dumps({'status':'failed','category':'http_'+str(e.code) if isinstance(e,urllib.error.HTTPError) else 'connector_unavailable'}),flush=True)
            if once:return 1
        if once or dry_run:return 0
        time.sleep(60)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--once',action='store_true');p.add_argument('--dry-run',action='store_true');a=p.parse_args();sys.exit(run(a.config,a.once,a.dry_run))

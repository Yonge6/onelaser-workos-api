import unittest,types,time,datetime
from sent_replies import read_ticket,sent
class SentReplies(unittest.TestCase):
 def row(self,**kw):return {'id':'reply-1','channel':'EMAIL','direction':'out','status':'SUCCESS','isForward':False,'visibility':'public','author':{'type':'AGENT','name':'Fixture'},'createdTime':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),**kw}
 def test_only_successful_public_agent_emails(self):
  self.assertTrue(sent(self.row()))
  for change in [{'status':'DRAFT'},{'status':'FAILED'},{'visibility':'private'},{'isForward':True},{'direction':'in'},{'author':{'type':'SYSTEM'}},{'channel':'WEB'}]:self.assertFalse(sent(self.row(**change)))
 def test_scope_and_complete_original_binding(self):
  paths=[];row=self.row();config=types.SimpleNamespace(org_id='org',allowed_departments=('dept',))
  def get(url):
   paths.append(url)
   if url.endswith('/tickets/t1'):return {'id':'t1','orgId':'org','departmentId':'dept'}
   if '/threads?' in url:return {'data':[row,self.row(id='draft',status='DRAFT')]}
   if url.endswith('/originalContent'):return {'content':'Fictional complete MIME'}
   return row
  reader=types.SimpleNamespace(_get=get)
  replies=read_ticket(reader,config,'t1',lambda t,d,o:{'body':o['content']})
  self.assertEqual(len(replies),1);self.assertTrue(replies[0]['complete']);self.assertEqual(replies[0]['source'],'zoho_sent_email');self.assertTrue(paths[-1].endswith('/originalContent'))
  with self.assertRaises(ValueError):read_ticket(reader,types.SimpleNamespace(org_id='foreign',allowed_departments=('dept',)),'t1',lambda *a:None)
 def test_failed_read_does_not_make_up_body_or_fetch_untrusted_url(self):
  row=self.row();config=types.SimpleNamespace(org_id='org',allowed_departments=('dept',))
  def get(url):
   if url.endswith('/tickets/t1'):return {'id':'t1','departmentId':'dept'}
   if '/threads?' in url:return {'data':[row]}
   if url.endswith('/originalContent'):raise RuntimeError('Unavailable')
   return dict(row,fullContentURL='https://untrusted.invalid')
  with self.assertRaises(RuntimeError):read_ticket(types.SimpleNamespace(_get=get),config,'t1',lambda *a:None)
if __name__=='__main__':unittest.main()

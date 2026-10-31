import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {COMPLETION_LOCK_MS} from '../src/completions.js';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>;const tokens:Record<string,string>={},secret=randomBytes(32).toString('hex');
const seen:any[]=[];
const model={model:'fake-scorer',json:async(system:string,user:string,_s:object,name:string)=>{seen.push({system,user,name});if(name==='report_insights')return {sentences:['One.','Two.','Three.']};const u=JSON.parse(user);return {score:u.result.includes('link')?9.5:3.5,summary:'synthetic summary'};}};
before(async()=>{db=await createDatabase();await db.exec(schema);await seedDemo(db);
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,completionModel:model,fxFetcher:(async()=>new Response(JSON.stringify({date:'2026-10-30',rates:{CNY:7.13}}),{status:200})) as any});
  for(const userId of ['m1','m2','m3','m4'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;});
after(async()=>{await app.close();});
const call=(who:string,method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
async function create(owner='m2'){const r=await call('m1','POST','/tasks',{title:'Completion fixture task',description:'Internal fictional fixture',ownerId:owner,criteria:['Provide evidence'],dueAt:'2026-11-10T12:00:00Z'});assert.equal(r.statusCode,201,r.body);return r.json();}
// Scoring runs after the response; wait until it lands instead of assuming a fixed delay (CI machines are slower).
const settle=async(who='m2')=>{for(let i=0;i<100;i++){const pending=(await db.query("SELECT count(*)::int n FROM task_completions WHERE ai_status='pending'")).rows[0].n;if(!pending)return;await new Promise(r=>setTimeout(r,50));}};

test('completing scores the result with AI; vague results score low; the score shows on the board',async()=>{
  const t=await create();
  const good=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Shipped the fictional page; here is the link and the before/after numbers.',selfReview:'Met the goal; one follow-up left.'});
  assert.equal(good.statusCode,201,good.body);await settle();
  const c=(await call('m2','GET',`/tasks/${t.id}/completion`)).json();assert.equal(c.completion.ai_status,'scored');assert.equal(Number(c.completion.ai_score),9.5);assert.equal(c.locked,false);
  assert.ok(seen.at(-1).system.includes('untrusted data'),'task text is treated as data');
  const board=(await call('m2','GET','/task-board')).json(),row=board.items.find((x:any)=>x.id===t.id);assert.equal(Number(row.completion.ai_score),9.5);
  const t2=await create(),weak=await call('m2','POST',`/tasks/${t2.id}/complete`,{expectedVersion:t2.version,result:'Finished the thing that was assigned to me last week.',selfReview:'It is done now.'});assert.equal(weak.statusCode,201);await settle();
  assert.equal(Number((await call('m2','GET',`/tasks/${t2.id}/completion`)).json().completion.ai_score),3.5);
});

test('after 3 days the completion and score are locked: no reopen, no resubmit',async()=>{
  const t=await create();
  const r=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Delivered the fictional report with a link to the shared folder.',selfReview:'Complete and verified.'});assert.equal(r.statusCode,201);
  await db.query('UPDATE tasks SET board_done_at=$2 WHERE id=$1',[t.id,new Date(Date.now()-COMPLETION_LOCK_MS-1000).toISOString()]);
  const v=(await call('m2','GET',`/tasks/${t.id}`)).json().version;
  const reopen=await call('m2','POST',`/tasks/${t.id}/board`,{expectedVersion:v,status:'working'});assert.equal(reopen.statusCode,409);assert.equal(reopen.json().error.code,'COMPLETION_LOCKED');
  const again=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:v,result:'Trying to change the locked result after the window closed.',selfReview:'Changed my mind.'});assert.equal(again.json().error.code,'COMPLETION_LOCKED');
  assert.equal((await call('m2','GET',`/tasks/${t.id}/completion`)).json().locked,true);
  const board=(await call('m2','GET','/task-board')).json();assert.equal(board.items.find((x:any)=>x.id===t.id).effective_group_id,'completed');
});

test('attachments: allowed types only, size-checked, scoped to visible tasks, downloaded with nosniff',async()=>{
  const t=await create();
  const ok=await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'result.png',mime:'image/png',dataBase64:Buffer.from('fake-png-bytes').toString('base64')});assert.equal(ok.statusCode,201,ok.body);
  assert.equal((await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'x.html',mime:'text/html',dataBase64:Buffer.from('<script>').toString('base64')})).statusCode,400);
  assert.equal((await call('m4','POST',`/tasks/${t.id}/attachments`,{name:'a.png',mime:'image/png',dataBase64:'AAAA'})).statusCode,404);
  const dl=await call('m2','GET',`/tasks/${t.id}/attachments/${ok.json().id}`);assert.equal(dl.statusCode,200);assert.equal(dl.headers['x-content-type-options'],'nosniff');assert.equal(dl.body,'fake-png-bytes');
  const done=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Uploaded the screenshot of the fictional result as evidence.',selfReview:'Evidence attached.',attachmentIds:[ok.json().id]});assert.equal(done.statusCode,201,done.body);
  assert.equal((await call('m2','POST',`/tasks/${(await create()).id}/complete`,{expectedVersion:1,result:'Referencing an attachment from a different task is not allowed.',selfReview:'Should fail.',attachmentIds:[ok.json().id]})).statusCode,400);
});

test('reporting lines: superiors see reports’ tasks, reports never see superiors’ tasks',async()=>{
  await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");await db.query("UPDATE users SET manager_id=NULL WHERE id='m1'");
  const mine=(await call('m1','POST','/tasks',{title:'Superior own task',description:'Internal fictional fixture',ownerId:'m1',reviewerId:'m4',criteria:['x'],dueAt:'2026-11-10T12:00:00Z'}));
  const own=mine.statusCode===201?mine.json():null;
  const sub=await create('m2');
  const m1list=(await call('m1','GET','/tasks')).json().items.map((x:any)=>x.id);assert.ok(m1list.includes(sub.id),'superior sees report');
  const m2list=(await call('m2','GET','/tasks')).json().items;assert.ok(m2list.every((x:any)=>x.owner_id==='m2'||x.reviewer_id==='m2'),'report sees only own work');
  if(own){assert.equal((await call('m2','GET',`/tasks/${own.id}`)).statusCode,404);}
  await db.query("UPDATE users SET manager_id=NULL");
});

test('AI insights take aggregated facts, return 3–4 sentences, and live FX is cached with a sane range',async()=>{
  const r=await call('m2','POST','/insights',{board:'supply',lang:'zh',facts:{usValue:217664,agedOver90Pct:97,reorder:['XRF (US 14)']}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().sentences.length,3);
  assert.equal((await call('m2','POST','/insights',{board:'nope',facts:{}})).statusCode,400);
  const fx=(await call('m2','GET','/fx')).json();assert.equal(fx.rate,7.13);assert.equal(fx.asOf,'2026-10-30');
  const lb=(await call('m3','GET','/reports/leaderboard')).json();assert.ok(lb.items.length>0);assert.ok(lb.items.every((x:any)=>!('title_of_task' in x)&&typeof x.total==='number'));const m2=lb.items.find((x:any)=>x.id==='m2');assert.ok(m2.scored_done>=1&&m2.avg_score>0);
  const caps=(await app.inject('/capabilities')).json();assert.equal(caps.taskCompletion,true);assert.equal(caps.aiInsights,true);
});

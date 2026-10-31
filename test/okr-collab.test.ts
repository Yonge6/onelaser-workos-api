import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';

async function setup(){
 const db=await createDatabase();await db.exec(schema);await db.exec(schema);await seedDemo(db);
 const secret=randomBytes(32).toString('hex'),app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret});
 const tokens:Record<string,string>={};
 for(const userId of ['m1','m2','m3','m4'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;
 const call=(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
 const planning={period:'2026-11',weight:60,location:'',description:'',type:'mandatory',bonusIncluded:false,scoringDueDate:'2026-12-03'};
 const objective=(await call('m2','POST','/objectives',{title:'Grow dealers',level:'personal',planning})).json();
 const kr=(await call('m2','POST',`/objectives/${objective.id}/key-results`,{title:'Sign dealers',baseline:0,target:30,direction:'increase',unit:'dealers',planning:{weight:60,description:''}})).json();
 return {app,call,objective,kr};
}

test('capabilities advertise OKR collaboration and new fields are returned',async()=>{
 const {app,call,objective,kr}=await setup();
 try{
  assert.equal((await call('m2','GET','/capabilities')).json().okrCollaboration,true);
  const o=(await call('m2','GET','/objectives')).json().items.find((x:any)=>x.id===objective.id);
  assert.equal(o.version,1);assert.equal(o.parent_objective_id,null);
  const k=(await call('m2','GET','/key-results')).json().items.find((x:any)=>x.id===kr.id);
  assert.equal(k.meta_version,1);assert.equal(k.confidence,null);
 }finally{await app.close();}
});

test('owner edits objective title and weight with version checks; others cannot',async()=>{
 const {app,call,objective}=await setup();
 try{
  const ok=await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:1,title:'Grow dealers in the West',weight:50});
  assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().title,'Grow dealers in the West');assert.equal(ok.json().planning.weight,50);assert.equal(ok.json().planning.period,'2026-11');assert.equal(ok.json().version,2);
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:1,title:'Stale'})).statusCode,409);
  assert.equal((await call('m3','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,title:'Not mine'})).statusCode,404);
  assert.equal((await call('m4','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,title:'Other department'})).statusCode,404);
  assert.equal((await call('m1','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,title:'Manager fix'})).statusCode,200);
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:3})).statusCode,400);
 }finally{await app.close();}
});

test('alignment to a visible parent objective; cycles and invisible parents are rejected',async()=>{
 const {app,call,objective}=await setup();
 try{
  const aligned=await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:1,parentObjectiveId:'o2'});
  assert.equal(aligned.statusCode,200,aligned.body);assert.equal(aligned.json().parent_objective_id,'o2');
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,parentObjectiveId:'o5'})).statusCode,400,'other department objective is not visible');
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,parentObjectiveId:objective.id})).statusCode,400,'self alignment');
  const child=(await call('m1','POST','/objectives',{title:'Child',level:'department',parentObjectiveId:objective.id})).json();
  assert.equal(child.parent_objective_id,objective.id);
  const parentOfParent=await call('m1','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,parentObjectiveId:child.id});
  assert.equal(parentOfParent.statusCode,400,'cycle');assert.equal(parentOfParent.json().error.code,'ALIGNMENT_CYCLE');
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,parentObjectiveId:null})).json().parent_objective_id,null);
 }finally{await app.close();}
});

test('KR text and status edits keep appraisals; metric edits bump the metric version',async()=>{
 const {app,call,kr}=await setup();
 try{
  const self=await call('m2','POST',`/key-results/${kr.id}/self-evaluation`,{expectedVersion:1,score:80,note:'Complete',evidence:'Synthetic dealer contracts list.'});
  assert.equal(self.statusCode,201);
  const approved=await call('m1','POST',`/key-results/${kr.id}/manager-evaluation`,{expectedVersion:2,score:80,note:'Checked evidence',selfAppraisalId:self.json().self.id,verifiedEvidence:true});
  assert.equal(approved.statusCode,201);
  const edited=await call('m2','PATCH',`/key-results/${kr.id}`,{expectedMetaVersion:1,title:'Sign 30 dealers',confidence:'at_risk',weight:40});
  assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().confidence,'at_risk');assert.equal(edited.json().version,3,'metric version unchanged by text edits');assert.equal(edited.json().meta_version,2);
  assert.equal((await call('m1','GET',`/key-results/${kr.id}/appraisal`)).json().manager.score,80,'manager score survives text edits');
  assert.equal((await call('m2','PATCH',`/key-results/${kr.id}`,{expectedMetaVersion:1,title:'Stale'})).statusCode,409);
  assert.equal((await call('m2','PATCH',`/key-results/${kr.id}`,{expectedMetaVersion:2,confidence:'unknown'})).statusCode,400);
  const bad=await call('m2','PATCH',`/key-results/${kr.id}`,{expectedMetaVersion:2,metric:{expectedVersion:3,baseline:10,target:5,direction:'increase',unit:'dealers'}});
  assert.equal(bad.statusCode,400);
  const metric=await call('m2','PATCH',`/key-results/${kr.id}`,{expectedMetaVersion:2,metric:{expectedVersion:3,baseline:0,target:40,direction:'increase',unit:'dealers'}});
  assert.equal(metric.statusCode,200,metric.body);assert.equal(metric.json().version,4);assert.equal(metric.json().target,40);
  assert.equal((await call('m1','GET',`/key-results/${kr.id}/appraisal`)).json().manager,null,'metric change requires re-confirmation');
 }finally{await app.close();}
});

test('progress updates form a timeline and can set KR status',async()=>{
 const {app,call,objective,kr}=await setup();
 try{
  const posted=await call('m2','POST',`/objectives/${objective.id}/updates`,{body:'Signed 3 new dealers this week',krId:kr.id,confidence:'on_track'});
  assert.equal(posted.statusCode,201,posted.body);assert.equal(posted.json().author_name,'陈一');assert.equal(posted.json().progress,0);
  await call('m1','POST',`/objectives/${objective.id}/updates`,{body:'Manager note: push CA region'});
  const list=(await call('m2','GET',`/objectives/${objective.id}/updates`)).json().items;
  assert.equal(list.length,2);assert.equal(list[0].body,'Manager note: push CA region');
  assert.equal((await call('m2','GET','/key-results')).json().items.find((x:any)=>x.id===kr.id).confidence,'on_track');
  assert.equal((await call('m3','POST',`/objectives/${objective.id}/updates`,{body:'Not my goal'})).statusCode,404);
  assert.equal((await call('m2','POST',`/objectives/${objective.id}/updates`,{body:'x'})).statusCode,400);
  assert.equal((await call('m2','POST',`/objectives/${objective.id}/updates`,{body:'Status without KR',confidence:'at_risk'})).statusCode,400);
  assert.equal((await call('m2','POST','/objectives/o2/updates',{body:'Employee on department goal'})).statusCode,403);
 }finally{await app.close();}
});

test('archiving hides objectives and KRs but keeps history; archived items reject writes',async()=>{
 const {app,call,objective,kr}=await setup();
 try{
  const child=(await call('m1','POST','/objectives',{title:'Aligned child',level:'department',parentObjectiveId:objective.id})).json();
  const krArchive=await call('m2','POST',`/key-results/${kr.id}/archive`,{expectedMetaVersion:1});
  assert.equal(krArchive.statusCode,200,krArchive.body);
  assert.ok(!(await call('m2','GET','/key-results')).json().items.some((x:any)=>x.id===kr.id));
  assert.equal((await call('m2','GET',`/key-results/${kr.id}/appraisal`)).statusCode,404);
  assert.equal((await call('m1','POST',`/key-results/${kr.id}/measurements`,{expectedVersion:1,actual:3,source:'Synthetic',note:'Should fail'})).statusCode,404);
  assert.equal((await call('m3','POST',`/objectives/${objective.id}/archive`,{expectedVersion:1})).statusCode,404);
  assert.equal((await call('m2','POST',`/objectives/${objective.id}/archive`,{expectedVersion:1})).statusCode,200);
  assert.ok(!(await call('m2','GET','/objectives')).json().items.some((x:any)=>x.id===objective.id));
  assert.equal((await call('m1','GET','/objectives')).json().items.find((x:any)=>x.id===child.id).parent_objective_id,null,'children are detached, not deleted');
  assert.equal((await call('m2','POST',`/objectives/${objective.id}/key-results`,{title:'Late',baseline:0,target:1,direction:'increase',unit:'x'})).statusCode,404);
  assert.equal((await call('m2','PATCH',`/objectives/${objective.id}`,{expectedVersion:2,title:'Revive'})).statusCode,404);
  assert.equal((await call('m1','PATCH','/objectives/o1',{expectedVersion:1,title:'Company goal'})).statusCode,403,'company objectives are read-only here');
 }finally{await app.close();}
});

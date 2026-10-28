import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';

test('DingTalk-shaped planning and self/manager evidence reviews preserve scope, versions and unknowns',async()=>{
 const db=await createDatabase();await db.exec(schema);await db.exec(schema);await seedDemo(db);
 const secret=randomBytes(32).toString('hex'),app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret});
 try{
 const tokens:Record<string,string>={};for(const userId of ['m1','m2','m3','m4'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;
 const call=(who:string,method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
 const planning={period:'2026-10',weight:50,location:'Example office',description:'A synthetic monthly objective',type:'mandatory',bonusIncluded:false,scoringDueDate:'2026-11-03'};
 const created=await call('m2','POST','/objectives',{title:'Verified outcomes',level:'personal',planning});assert.equal(created.statusCode,201,created.body);assert.deepEqual(created.json().planning,planning);
 assert.equal((await call('m2','POST','/objectives',{title:'Invalid period',level:'personal',planning:{...planning,period:'2026-13'}})).statusCode,400);
 const result=await call('m2','POST',`/objectives/${created.json().id}/key-results`,{title:'Delivery accepted',baseline:0,target:2,direction:'increase',unit:'items',planning:{weight:30,description:'Acceptance criteria'}});assert.equal(result.statusCode,201,result.body);const kr=result.json();
 const url=`/key-results/${kr.id}`;
 const initial=await call('m2','GET',url+'/appraisal');assert.equal(initial.json().self,null);assert.equal(initial.json().manager,null);
 for(const who of ['m3','m4'])assert.equal((await call(who,'GET',url+'/appraisal')).statusCode,404);
 const self={expectedVersion:1,score:80,note:'Complete, with evidence',evidence:'Synthetic delivery records with checkable outcomes.'};
 assert.equal((await call('m1','POST',url+'/self-evaluation',self)).statusCode,403);
 assert.equal((await call('m2','POST',url+'/self-evaluation',{...self,score:85})).statusCode,400);
 const submitted=await call('m2','POST',url+'/self-evaluation',self);assert.equal(submitted.statusCode,201,submitted.body);assert.equal(submitted.json().version,2);
 const review={expectedVersion:2,score:80,note:'Evidence manually checked',selfAppraisalId:submitted.json().self.id,verifiedEvidence:true};
 assert.equal((await call('m2','POST',url+'/manager-evaluation',review)).statusCode,403);
 assert.equal((await call('m1','POST',url+'/manager-evaluation',{...review,verifiedEvidence:false})).statusCode,400);
 const approved=await call('m1','POST',url+'/manager-evaluation',review);assert.equal(approved.statusCode,201,approved.body);assert.equal(approved.json().manager.score,80);
 assert.equal((await call('m1','POST',url+'/manager-evaluation',review)).statusCode,409);
 const refreshed=await call('m2','POST',url+'/self-evaluation',{...self,score:0,expectedVersion:3});assert.equal(refreshed.statusCode,201);assert.equal(refreshed.json().manager,null);assert.equal(refreshed.json().self.score,0);assert.equal(refreshed.json().history.length,3);
 const measured=await call('m1','POST',url+'/measurements',{expectedVersion:4,actual:1,source:'Synthetic source',note:'Verified actual count'});assert.equal(measured.statusCode,201);
 assert.equal((await call('m1','POST',url+'/manager-evaluation',{...review,expectedVersion:5,selfAppraisalId:refreshed.json().self.id})).statusCode,409);
 assert.equal((await call('m1','GET',url+'/appraisal')).json().manager,null);
 const shared=await call('m1','POST','/objectives',{title:'Department objective',level:'department'});
 const sharedKr=await call('m1','POST',`/objectives/${shared.json().id}/key-results`,{title:'Team outcome',baseline:0,target:2,direction:'increase',unit:'items'});
 assert.equal((await call('m2','GET',`/key-results/${sharedKr.json().id}/appraisal`)).statusCode,404);
 assert.ok((await call('m2','GET','/key-results')).json().items.every((k:any)=>!('self' in k)&&!('evidence' in k)));
 }finally{await app.close();}
});

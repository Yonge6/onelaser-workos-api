import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {issueSession} from '../src/auth.js';
import {integrationOptionsFromEnv} from '../src/integrations/routes.js';

test('executive summary requires explicit access, isolates tenants, counts beyond task list cap and leaves task permissions unchanged',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.exec(`INSERT INTO departments VALUES('demo','marketing','1','Marketing'),('demo','product','2','Product');
 INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('other','other-org','product','Private person','manager');
 INSERT INTO departments VALUES('other-org','product','1','Private department');
 INSERT INTO objectives(id,org_id,level,title) VALUES('other-goal','other-org','company','Private goal');
 INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at)
 VALUES('other-task','other-org','product','other','other','other','Private title','Private evidence','[]',now(),now());
 UPDATE tasks SET due_at=now()-interval '1 day' WHERE id='t1';
 UPDATE tasks SET status='submitted',submission_version=1 WHERE id='t3';
 INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at)
 SELECT 'bulk-'||i,'demo','product','m5','m4','m4','Bulk task','Test only','[]',now()+interval '1 day',now()+interval '1 day' FROM generate_series(1,101) AS i;`);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']}});
 const token=async(id:string)=>({authorization:'Bearer '+(await issueSession(db,id)).accessToken});
 try{
  assert.equal((await app.inject('/executive/summary')).statusCode,401);
  for(const id of ['m2','m4','other'])assert.equal((await app.inject({url:'/executive/summary',headers:await token(id)})).statusCode,403);
  const headers=await token('m1');const response=await app.inject({url:'/executive/summary',headers});assert.equal(response.statusCode,200,response.body);
  const body=response.json();assert.equal(body.totals.total,104);assert.equal(body.totals.waiting,1);assert.equal(body.totals.overdue,1);assert.equal(body.companyProgress,null);
  assert.equal(body.departments.length,2);assert.equal(body.departments.reduce((n:number,d:any)=>n+d.total,0),104);
  assert.ok(body.risks.some((r:any)=>r.id==='t3'));assert.ok(!response.body.includes('Private'));assert.ok(!response.body.includes('criteria'));
  assert.equal((await app.inject({url:'/tasks/t3',headers})).statusCode,404);
  assert.equal((await app.inject({url:'/me',headers})).json().executiveAccess,true);
  assert.equal((await app.inject({url:'/me',headers:await token('m4')})).json().executiveAccess,false);
  await db.query('UPDATE users SET active=false WHERE id=$1',['m1']);assert.equal((await app.inject({url:'/executive/summary',headers})).statusCode,401);
 }finally{await app.close();}
});
test('executive access defaults off and reads only an explicit server-side list',()=>{
 assert.deepEqual(integrationOptionsFromEnv({}).executiveUserIds,[]);
 assert.deepEqual(integrationOptionsFromEnv({WORKOS_EXECUTIVE_USER_IDS:' verified-id, ,second-id '}).executiveUserIds,['verified-id','second-id']);
});

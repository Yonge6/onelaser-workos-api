import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createDatabase,schema,type Database} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {importOkrSnapshot,parseOkrImportManifest,type OkrImportManifest} from '../src/okr-import.js';
import {parseImportArguments,readManifestInput} from '../src/cli/import-okr.js';

function manifest():OkrImportManifest {
  const source:OkrImportManifest['source']={provider:'dingtalk',corpId:'test-corp',documentId:'test-document',tableId:'test-october',period:'2026-10',url:'https://docs.example.test/okr',exportedAt:'2026-10-29T00:00:00Z',snapshotSha256:'a'.repeat(64),rowIdStrategy:'verified-identity-parent-item'};
  const common={ownerExternalUserId:'external-one',title:'Original  description with spaces',metrics:null,
    rawFields:[{name:'Employee self score',value:null},{name:'Manager note',value:'Private source text'},{name:'Legacy formula result',value:0}]} as const;
  return {version:1,source,records:[
    {...common,rawFields:common.rawFields.map(field=>({...field})),kind:'objective',sourceKey:'external-one:O1',parentSourceKey:null,itemLabel:'O1',planning:{weight:100,description:common.title,location:'Example office',type:'mandatory',bonusIncluded:false,scoringDueDate:'2026-08-27'}},
    {...common,rawFields:common.rawFields.map(field=>({...field})),kind:'key_result',sourceKey:'external-one:O1:KR1',parentSourceKey:'external-one:O1',itemLabel:'KR1',planning:{weight:60,description:null,scoringDueDate:'2026-08-03'}},
    {...common,rawFields:common.rawFields.map(field=>({...field})),kind:'key_result',sourceKey:'external-one:O1:KR2',parentSourceKey:'external-one:O1',itemLabel:'KR2',planning:{weight:40,description:'A second result',scoringDueDate:null}},
  ]};
}

async function setup(t:TestContext) {
  let db:Database|undefined,admin:Database|undefined,isolatedSchema:string|undefined;
  let activeApp:Awaited<ReturnType<typeof buildApp>>|undefined;
  t.after(async()=>{
    try{if(activeApp)await activeApp.close();else if(db)await db.close();}
    finally{if(admin&&isolatedSchema){try{await admin.exec(`DROP SCHEMA ${isolatedSchema} CASCADE`);}finally{await admin.close();}}}
  });
  if(process.env.TEST_DATABASE_URL){
    // All DDL/fixtures/locks run in this generated schema, never public.
    isolatedSchema='workos_okr_import_test_'+randomUUID().replaceAll('-','');
    admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});
    await admin.exec(`CREATE SCHEMA ${isolatedSchema}`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${isolatedSchema}`);
    db=await createDatabase({connectionString:url.toString()});
  }else db=await createDatabase();
  await db.exec(schema);await db.exec(schema);
  for(const [id,org,department,role,active,external] of [
    ['manager','test-corp','company','manager',true,'external-manager'],
    ['employee','test-corp','company','employee',true,'external-one'],
    ['peer','test-corp','company','employee',true,'external-peer'],
    ['other-department','test-corp','another','manager',true,'external-other'],
    ['foreign','another-corp','company','manager',true,'external-foreign'],
    ['inactive','test-corp','company','employee',false,'external-inactive'],
  ] as const) {
    await db.query('INSERT INTO users(id,org_id,department_id,display_name,role,active) VALUES($1,$2,$3,$4,$5,$6)',[id,org,department,'Synthetic '+id,role,active]);
    await db.query("INSERT INTO external_identities(provider,corp_id,external_user_id,union_id,user_id) VALUES('dingtalk',$1,$2,$3,$4)",[org,external,'union-'+id,id]);
  }
  const secret=randomBytes(32).toString('hex'),app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret});
  activeApp=app;
  const call=async(user:string,method:'GET'|'POST',url:string,payload?:Record<string,unknown>)=>{
    const auth=await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId:user,secret}});
    return app.inject({method,url,payload,headers:{authorization:'Bearer '+auth.json().accessToken}});
  };
  return {db,app,call};
}
const apply=(db:Database,input=manifest())=>importOkrSnapshot(db,input,{actorUserId:'manager',mode:'apply',expectedCorpId:'test-corp'});
const count=async(db:Database,table:string)=>Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

test('dry-run validates mappings and warnings without writing schema, OKRs, source history or audit',async t=>{
  const {db}=await setup(t),before=await count(db,'audit_events');
  const result=await importOkrSnapshot(db,manifest(),{actorUserId:'manager'});
  assert.equal(result.mode,'dry-run');assert.equal(result.applied,false);assert.equal(result.batchId,null);
  assert.equal(result.objectivesToCreate,1);assert.equal(result.keyResultsToCreate,2);
  assert.equal(result.unknownMetricKeyResults,2);assert.equal(result.warnings.filter(w=>w.code==='SCORING_DATE_OUTSIDE_PERIOD').length,2);
  for(const table of ['objectives','key_results','okr_import_batches','okr_source_records','kr_appraisals'])assert.equal(await count(db,table),0);
  assert.equal(await count(db,'audit_events'),before);
});

test('apply preserves hierarchy, absolute weights, dates, nulls and original source while attributing the real operator',async t=>{
  const {db}=await setup(t),input=manifest(),result=await apply(db,input);
  assert.equal(result.applied,true);assert.equal(result.create,3);
  const objective=(await db.query('SELECT * FROM objectives')).rows[0];
  assert.equal(objective.level,'personal');assert.equal(objective.owner_id,'employee');assert.equal(objective.department_id,'company');
  assert.equal(objective.title,input.records[0].title);assert.equal(objective.planning.weight,100);assert.equal(objective.planning.period,'2026-10');assert.equal(objective.planning.scoringDueDate,'2026-08-27');
  const krs=(await db.query('SELECT * FROM key_results ORDER BY planning->>\'weight\'')).rows;
  assert.deepEqual(krs.map(k=>k.planning.weight),[40,60]);
  for(const kr of krs){assert.equal(kr.objective_id,objective.id);for(const key of ['baseline','target','actual','direction','unit'])assert.equal(kr[key],null);}
  const sources=(await db.query('SELECT * FROM okr_source_records ORDER BY source_key')).rows;
  assert.equal(sources.length,3);assert.deepEqual(sources[0].record_payload.rawFields,input.records[0].rawFields);
  assert.equal(sources[1].original_scoring_due_date,'2026-08-03');
  assert.equal(await count(db,'kr_appraisals'),0);assert.equal(await count(db,'measurements'),0);
  const audit=(await db.query("SELECT * FROM audit_events WHERE action='okr.imported'")).rows;
  assert.equal(audit.length,3);assert.ok(audit.every(a=>a.actor_id==='manager'&&a.owner_id==='employee'));
  assert.ok(audit.every(a=>a.details.policy==='legacy_source_not_verified'&&!JSON.stringify(a.details).includes('Private source')));
});

test('same source is a no-op across snapshot changes and never overwrites later native edits',async t=>{
  const {db}=await setup(t);await apply(db);
  await db.query("UPDATE objectives SET title='Later employee edit'");
  await db.query("UPDATE key_results SET title='Later result edit',version=version+1");
  const input=manifest();input.source.snapshotSha256='b'.repeat(64);input.source.exportedAt='2026-10-30T00:00:00Z';
  const result=await apply(db,input);assert.equal(result.applied,false);assert.equal(result.skipped,3);
  assert.equal(await count(db,'okr_import_batches'),1);assert.equal(await count(db,'audit_events'),3);
  assert.equal((await db.query('SELECT title FROM objectives')).rows[0].title,'Later employee edit');
  assert.ok((await db.query('SELECT title,version FROM key_results')).rows.every(row=>row.title==='Later result edit'&&row.version===2));
});

test('changed source conflicts before any new rows or audit are written',async t=>{
  const {db}=await setup(t);await apply(db);
  const input=manifest();input.records[1].rawFields[0].value=80;
  input.records.push({...input.records[2],sourceKey:'external-one:O1:KR3',itemLabel:'KR3'});
  await assert.rejects(apply(db,input),(error:any)=>error.code==='SOURCE_RECORD_CONFLICT'&&error.conflicts===1);
  assert.equal(await count(db,'key_results'),2);assert.equal(await count(db,'okr_source_records'),3);assert.equal(await count(db,'audit_events'),3);
});

test('concurrent repeated imports create one source batch and one set of native rows',async t=>{
  const {db}=await setup(t);const results=await Promise.all([apply(db),apply(db)]);
  assert.equal(results.filter(result=>result.applied).length,1);assert.equal(await count(db,'objectives'),1);
  assert.equal(await count(db,'key_results'),2);assert.equal(await count(db,'okr_source_records'),3);assert.equal(await count(db,'okr_import_batches'),1);
});

test('a failed transactional write leaves no partial batch, objectives, KRs, source or audit',async t=>{
  const {db}=await setup(t);
  await db.exec("ALTER TABLE okr_source_records ADD CONSTRAINT test_reject_kr CHECK(record_kind <> 'key_result')");
  await assert.rejects(apply(db));
  for(const table of ['objectives','key_results','okr_import_batches','okr_source_records','audit_events'])assert.equal(await count(db,table),0);
});

test('actor, corporation and owner identity checks reject guessed names, missing mappings and outside scopes',async t=>{
  const {db}=await setup(t);
  for(const actorUserId of ['employee','peer','foreign','other-department','missing'])await assert.rejects(importOkrSnapshot(db,manifest(),{actorUserId,mode:'apply'}));
  await assert.rejects(importOkrSnapshot(db,manifest(),{actorUserId:'manager',expectedCorpId:'wrong-corp'}),/CORPORATION_MISMATCH/);
  for(const external of ['Synthetic employee','external-inactive','external-other','unknown-external']){
    const input=manifest();input.records.forEach(row=>row.ownerExternalUserId=external);
    await assert.rejects(apply(db,input),/IMPORT_OWNER_UNMAPPED_OR_OUT_OF_SCOPE/);
  }
  await db.query("DELETE FROM external_identities WHERE user_id='manager'");
  await assert.rejects(apply(db),/IMPORT_ACTOR_FORBIDDEN/);
  assert.equal(await count(db,'objectives'),0);
});

test('public OKR responses contain only metadata; legacy records remain owner/manager scoped',async t=>{
  const {db,call,app}=await setup(t);await apply(db);
  const objective=(await db.query('SELECT id FROM objectives')).rows[0].id,kr=(await db.query('SELECT id FROM key_results')).rows[0].id;
  for(const user of ['employee','manager']){
    const objectives=(await call(user,'GET','/objectives')).json().items;
    assert.equal(objectives[0].importSource.provider,'dingtalk');assert.equal(objectives[0].importSource.originalScoringDueDate,'2026-08-27');
    assert.equal(objectives[0].importSource.deadlinePeriodMismatch,true);assert.equal('rawFields' in objectives[0],false);
    assert.ok(!JSON.stringify(objectives).includes('Private source text'));
    const krs=(await call(user,'GET','/key-results')).json().items;assert.ok(krs.every((k:any)=>k.progress===null));assert.ok(!JSON.stringify(krs).includes('Private source text'));
    const source=await call(user,'GET',`/objectives/${objective}/source`);assert.equal(source.statusCode,200);assert.equal(source.json().classification,'legacy_source');assert.deepEqual(source.json().rawFields,manifest().records[0].rawFields);
    const appraisal=(await call(user,'GET',`/key-results/${kr}/appraisal`)).json();assert.equal(appraisal.self,null);assert.equal(appraisal.manager,null);assert.deepEqual(appraisal.history,[]);assert.equal(appraisal.legacySource.formulaVerified,false);
  }
  for(const user of ['peer','foreign','other-department']){
    assert.equal((await call(user,'GET',`/objectives/${objective}/source`)).statusCode,404);
    assert.equal((await call(user,'GET',`/key-results/${kr}/appraisal`)).statusCode,404);
  }
  assert.equal((await app.inject({url:`/objectives/${objective}/source`})).statusCode,401);
  const denied=await call('manager','POST',`/key-results/${kr}/measurements`,{expectedVersion:1,actual:1,source:'Example evidence',note:'Synthetic verified measurement'});
  assert.equal(denied.statusCode,400);assert.equal(denied.json().error.code,'METRIC_NOT_CONFIGURED');assert.equal(await count(db,'measurements'),0);
});

test('valid quantitative imports preserve zero, support later measurements and do not infer missing actual',async t=>{
  const {db,call}=await setup(t),input=manifest();
  input.records[1].metrics={baseline:0,target:10,actual:0,direction:'increase',unit:'items'};
  input.records[2].metrics={baseline:100,target:50,actual:null,direction:'decrease',unit:'minutes'};
  await apply(db,input);
  const items=(await call('manager','GET','/key-results')).json().items;
  assert.equal(items.find((k:any)=>k.target===10).progress,0);
  const missing=items.find((k:any)=>k.target===50);assert.equal(missing.actual,null);assert.equal(missing.progress,null);
  const measured=await call('manager','POST',`/key-results/${missing.id}/measurements`,{expectedVersion:1,actual:75,source:'Example evidence',note:'Synthetic verified measurement'});
  assert.equal(measured.statusCode,201);assert.equal(measured.json().progress,0.5);
});

test('manifest rejects forged fields/duplicates/hierarchy and preserves warnings without adjusting weights',async t=>{
  for(const mutate of [
    (m:any)=>{m.records.push(m.records[0]);},(m:any)=>{m.records[1].parentSourceKey='missing';},
    (m:any)=>{m.records[1].ownerExternalUserId='different';},(m:any)=>{m.records[1].employeeRole='manager';},
    (m:any)=>{m.source.url='https://user:secret@example.test/';},(m:any)=>{m.records[1].metrics={baseline:0,target:0,actual:0,direction:'increase',unit:'items'};},
  ]){const input=manifest();mutate(input);assert.throws(()=>parseOkrImportManifest(input));}
  const {db}=await setup(t),input=manifest();input.records[0].planning.weight=50;input.records[1].planning.weight=30;input.records[2].planning.weight=10;
  const preview=await importOkrSnapshot(db,input,{actorUserId:'manager'});
  assert.ok(preview.warnings.some(w=>w.code==='KR_WEIGHT_TOTAL_MISMATCH'));assert.ok(preview.warnings.some(w=>w.code==='MANDATORY_WEIGHT_TOTAL_NOT_100'));
  await apply(db,input);assert.equal((await db.query('SELECT planning FROM objectives')).rows[0].planning.weight,50);
});

test('CLI defaults to dry-run, accepts bounded stdin, and rejects ambiguous or oversized inputs',async()=>{
  assert.equal(parseImportArguments(['--stdin','--actor-user-id','manager']).mode,'dry-run');
  assert.equal(parseImportArguments(['--file','private.json','--actor-user-id','manager','--apply']).mode,'apply');
  for(const args of [[],['--stdin','--file','x','--actor-user-id','manager'],['--stdin','--actor-user-id','manager','--apply','--dry-run'],['--stdin','--actor-user-id','manager','--unknown']])assert.throws(()=>parseImportArguments(args));
  assert.deepEqual(await readManifestInput(Readable.from([JSON.stringify(manifest())])),manifest());
  await assert.rejects(readManifestInput(Readable.from(['not JSON'])),/INVALID_MANIFEST_JSON/);
  await assert.rejects(readManifestInput(Readable.from([Buffer.alloc(4*1024*1024),Buffer.alloc(1)])),/MANIFEST_TOO_LARGE/);
});

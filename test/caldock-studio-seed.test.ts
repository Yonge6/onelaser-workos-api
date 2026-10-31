import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,schema,type Database} from '../src/db.js';
import {studioSchema} from '../src/caldock-studio.js';
import {studioSeed} from '../src/caldock-studio-seed.js';

let db:Database,admin:Database|undefined,namespace:string|undefined;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){
  admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});
  namespace='studio_seed_'+randomUUID().replaceAll('-','');
  await admin.exec(`CREATE SCHEMA ${namespace}`);
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+namespace);
  db=await createDatabase({connectionString:url.toString()});
 }else db=await createDatabase();
 await db.exec(schema);
});
after(async()=>{
 await db?.close();
 if(admin&&namespace){await admin.exec(`DROP SCHEMA ${namespace} CASCADE`);await admin.close();}
});
const legacy=()=>{
 const state=structuredClone(studioSeed);
 for(const id of ['pilot','scale50','scale100'] as const){
  const values=state.scenarios[id].values;
  Object.assign(values,{purchase:899,monthlyFirst:20,monthlyRepeat:10,quarterCommission:8,annualCommission:8});
  delete (values as Partial<typeof values>).monthlyCommissionMonths;
 }
 return state;
};
const snapshot=async()=>(await db.query('SELECT revision,state,updated_at FROM caldock_studio_state WHERE id=1')).rows[0];
const install=async(state:typeof studioSeed,revision=0)=>{
 await db.query("UPDATE caldock_studio_state SET state=$1,revision=$2,updated_at='2000-01-01T00:00:00Z' WHERE id=1",[JSON.stringify(state),revision]);
};

test('fresh studio seed uses the estimated used-device cost and 20 percent commissions on every order',async()=>{
 const current=await snapshot();assert.deepEqual(current.state,studioSeed);assert.equal(current.revision,0);
 for(const {values} of Object.values(current.state.scenarios) as {values:Record<string,number>}[]){
  assert.equal(values.purchase,719.2);assert.equal(values.monthlyCommissionMonths,0);
  for(const key of ['monthlyFirst','monthlyRepeat','quarterCommission','annualCommission'])assert.equal(values[key],20);
 }
});

test('untouched legacy seed upgrades once without creating editing history',async()=>{
 await install(legacy());const old=await snapshot();
 await db.exec(studioSchema);const migrated=await snapshot();
 assert.deepEqual(migrated.state,studioSeed);assert.equal(migrated.revision,0);
 assert.notEqual(String(migrated.updated_at),String(old.updated_at));
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM caldock_studio_history')).rows[0].n),0);
 await db.exec(studioSchema);assert.deepEqual(await snapshot(),migrated);
});

test('a revision-zero custom price or unrelated edited text prevents the entire seed replacement',async()=>{
 const price=legacy();price.scenarios.pilot.values.purchase=450;
 const text=legacy();text.marketing.strategy.zh='Keep this custom operating plan.';
 const commission=legacy();commission.scenarios.pilot.values.monthlyRepeat=15;
 for(const custom of [price,text,commission]){
  await install(custom);const before=await snapshot();await db.exec(studioSchema);
  assert.deepEqual(await snapshot(),before);
  assert.equal(Object.hasOwn((await snapshot()).state.scenarios.pilot.values,'monthlyCommissionMonths'),false);
 }
});

test('a revision-one legacy-valued document and its history are preserved',async()=>{
 const state=legacy(),actor=randomUUID(),historyId=randomUUID();
 await db.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[actor,'Fictional seed test editor','studio-seed@example.test']);
 await install(state,1);
 await db.query("INSERT INTO caldock_studio_history(id,revision,actor_id,path,before_value,after_value,operation) VALUES($1,1,$2,'[]'::jsonb,$3,$4,'import')",[historyId,actor,JSON.stringify(studioSeed),JSON.stringify(state)]);
 const before=await snapshot(),history=(await db.query('SELECT * FROM caldock_studio_history')).rows;
 await db.exec(studioSchema);
 assert.deepEqual(await snapshot(),before);
 assert.deepEqual((await db.query('SELECT * FROM caldock_studio_history')).rows,history);
});

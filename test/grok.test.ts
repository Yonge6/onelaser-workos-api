import test from 'node:test';
import assert from 'node:assert/strict';
import { AiIntegrationError, GrokReviewer, type ReviewInput } from '../src/integrations/grok.js';

const input:ReviewInput={taskId:'t',submissionVersion:1,title:'Task',description:'Inspect provided evidence only.',criteria:['Check'],submission:{id:'s',title:'Evidence',description:'Verified text evidence.',evidenceUrl:null},language:'en'};
const valid=()=>({summary:'The supplied source supports this criterion; a human must verify the result.',criteria:[{criterionId:'C1',finding:'supported',reason:'The declared evidence text is present.',evidenceRefs:['submission:s:description'],quotes:['Verified text evidence.']}],missingEvidence:[],uncertainties:[],humanReviewRequired:true});
const completion=(output:unknown,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(output)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
const configured=(output:unknown)=>new GrokReviewer({apiKey:'test-placeholder-key',model:'test-configured-model'},async()=>completion(output));
const invalidOutput=(error:unknown)=>error instanceof AiIntegrationError&&error.code==='AI_INVALID_OUTPUT'&&error.status===502;

test('Grok sends structured schema with configured model, exact sources and an explicit human-review boundary',async()=>{
 let request:{url:string;headers:Headers;body:any}|undefined;
 const reviewer=new GrokReviewer({apiKey:'test-placeholder-key',model:'test-configured-model'},async(url,init)=>{
  request={url:String(url),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))};return completion(valid());
 });
 const result=await reviewer.assess(input);
 assert.deepEqual(result,valid());assert.equal(request!.url,'https://api.x.ai/v1/chat/completions');
 assert.equal(request!.headers.get('Authorization'),'Bearer test-placeholder-key');assert.equal(request!.body.model,'test-configured-model');
 assert.equal(request!.body.response_format.type,'json_schema');assert.equal(request!.body.response_format.json_schema.strict,true);
 const taskData=JSON.parse(request!.body.messages[1].content);assert.equal(taskData.sources[1].id,'submission:s:description');assert.equal(taskData.sources[1].text,'Verified text evidence.');
 assert.equal(taskData.urlContentsFetched,false);assert.match(request!.body.messages[0].content,/Human review is always required/);
 assert(!JSON.stringify(result).includes('test-placeholder-key'));
});

test('Grok independently rejects invented source IDs and verbatim quotes absent from the cited source',async()=>{
 const source=valid();source.criteria[0].evidenceRefs=['submission:not-authorized:description'];await assert.rejects(configured(source).assess(input),invalidOutput);
 const quote=valid();quote.criteria[0].quotes=['An invented business result'];await assert.rejects(configured(quote).assess(input),invalidOutput);
 const wrongSource=valid();wrongSource.criteria[0].evidenceRefs=['submission:s:title'];await assert.rejects(configured(wrongSource).assess(input),invalidOutput);
});

test('Every acceptance criterion must appear exactly once',async()=>{
 const twoCriteria={...input,criteria:['Check','Second check']};
 const missing=valid();await assert.rejects(configured(missing).assess(twoCriteria),invalidOutput);
 const duplicate=valid();duplicate.criteria.push({...duplicate.criteria[0]});await assert.rejects(configured(duplicate).assess(twoCriteria),invalidOutput);
 const unknown=valid();unknown.criteria[0].criterionId='C999';await assert.rejects(configured(unknown).assess(input),invalidOutput);
});

test('Supported findings require evidence, while genuinely missing evidence remains unknown',async()=>{
 const unsupported=valid();unsupported.criteria[0].evidenceRefs=[];unsupported.criteria[0].quotes=[];await assert.rejects(configured(unsupported).assess(input),invalidOutput);
 const mismatched=valid();mismatched.criteria[0].quotes=[];await assert.rejects(configured(mismatched).assess(input),invalidOutput);
 const unknown={...valid(),criteria:[{criterionId:'C1',finding:'insufficient_evidence',reason:'The required source was not provided.',evidenceRefs:[],quotes:[]}],missingEvidence:['Provide the outcome evidence.']};
 assert.equal((await configured(unknown).assess(input)).criteria[0].finding,'insufficient_evidence');
});

test('Human review cannot be disabled and model-generated quality scores are not accepted',async()=>{
 await assert.rejects(configured({...valid(),humanReviewRequired:false}).assess(input),invalidOutput);
 await assert.rejects(configured({...valid(),quality:0}).assess(input),invalidOutput);
});

test('Provider HTTP and timeout failures expose safe integration errors, never upstream secrets',async()=>{
 const secret='DO_NOT_EXPOSE_PROVIDER_SECRET';
 const fetchers:typeof fetch[]=[async()=>new Response(secret,{status:429}),async()=>{throw new Error(secret);},async()=>{throw new DOMException(secret,'TimeoutError');}];
 for(const fetcher of fetchers){
  const reviewer=new GrokReviewer({apiKey:secret,model:'configured-model'},fetcher);
  await assert.rejects(reviewer.assess(input),(error:unknown)=>error instanceof AiIntegrationError&&error.code==='AI_UPSTREAM_FAILED'&&!error.message.includes(secret)&&error.status===502);
 }
});

test('Truncated or tool-call completions are not treated as successful assessments',async()=>{
 for(const reason of ['length','tool_calls']){
  const reviewer=new GrokReviewer({apiKey:'test-key',model:'configured-model'},async()=>completion(valid(),reason));
  await assert.rejects(reviewer.assess(input),invalidOutput);
 }
});

test('Input hashes bind task, submission version, rubric and provided evidence',()=>{
 const reviewer=configured(valid()),hash=reviewer.inputHash(input);
 assert.equal(hash,reviewer.inputHash(structuredClone(input)));
 assert.notEqual(hash,reviewer.inputHash({...input,submissionVersion:2}));
 assert.notEqual(hash,reviewer.inputHash({...input,criteria:['Changed acceptance criterion']}));
 assert.notEqual(hash,reviewer.inputHash({...input,submission:{...input.submission,description:'Changed evidence'}}));
});

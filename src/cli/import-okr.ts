import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { createDatabase } from '../db.js';
import { importOkrSnapshot, OkrImportError } from '../okr-import.js';

const maxBytes = 4 * 1024 * 1024;
export function parseImportArguments(args: string[]) {
  let file: string | undefined, actorUserId: string | undefined, stdin = false, apply = false, dryRun = false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--stdin'&&!stdin)stdin=true;
    else if(arg==='--apply'&&!apply)apply=true;
    else if(arg==='--dry-run'&&!dryRun)dryRun=true;
    else if(arg==='--file'&&!file&&args[i+1]&&!args[i+1].startsWith('--'))file=args[++i];
    else if(arg==='--actor-user-id'&&!actorUserId&&args[i+1]&&!args[i+1].startsWith('--'))actorUserId=args[++i];
    else throw new OkrImportError('INVALID_CLI_ARGUMENTS');
  }
  if((stdin?1:0)+(file?1:0)!==1||!actorUserId||!/^[A-Za-z0-9_-]{1,100}$/.test(actorUserId)||(apply&&dryRun))throw new OkrImportError('INVALID_CLI_ARGUMENTS');
  return { file, stdin, actorUserId, mode:apply?'apply' as const:'dry-run' as const };
}
export async function readManifestInput(stream: AsyncIterable<Buffer|string>) {
  const chunks:Buffer[]=[];let bytes=0;
  for await(const value of stream){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;if(bytes>maxBytes)throw new OkrImportError('MANIFEST_TOO_LARGE');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new OkrImportError('INVALID_MANIFEST_JSON');}
}
export async function runImportCli(args: string[], env:NodeJS.ProcessEnv=process.env) {
  if(args.length===1&&args[0]==='--help'){
    console.log('Usage: node build/src/cli/import-okr.js (--stdin | --file PATH) --actor-user-id ID [--apply | --dry-run]\nDefaults to dry-run. Requires DATABASE_URL and DINGTALK_CORP_ID from the service environment. Does not initialize schema or seed data.');return;
  }
  const options=parseImportArguments(args);
  if(!env.DATABASE_URL||!env.DINGTALK_CORP_ID)throw new OkrImportError('PRODUCTION_DATABASE_AND_CORPORATION_REQUIRED');
  const input=await readManifestInput(options.stdin?process.stdin:createReadStream(options.file!));
  const db=await createDatabase({connectionString:env.DATABASE_URL});
  try{
    const result=await importOkrSnapshot(db,input,{actorUserId:options.actorUserId,mode:options.mode,expectedCorpId:env.DINGTALK_CORP_ID});
    const warningCounts:Record<string,number>={};for(const warning of result.warnings)warningCounts[warning.code]=(warningCounts[warning.code]||0)+1;
    console.log(JSON.stringify({dryRun:options.mode==='dry-run',applied:result.applied,batchId:result.batchId,period:result.period,
      sourceSnapshotSha256:result.sourceSnapshotSha256,totalRows:result.total,owners:result.owners,
      plannedObjectives:result.objectivesToCreate,plannedKeyResults:result.keyResultsToCreate,
      createdObjectives:result.applied?result.objectivesToCreate:0,createdKeyResults:result.applied?result.keyResultsToCreate:0,
      skipped:result.skipped,conflicts:0,dateMismatchCount:warningCounts.SCORING_DATE_OUTSIDE_PERIOD||0,
      unknownMetricKeyResults:result.unknownMetricKeyResults,warningCounts}));
  }finally{await db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runImportCli(process.argv.slice(2)).catch(error=>{
  // Do not print database URLs, original employee fields, or upstream error text.
  console.error(JSON.stringify({ok:false,code:error instanceof OkrImportError?error.code:error instanceof ZodError?'INVALID_MANIFEST_SCHEMA':'IMPORT_FAILED',
    conflicts:error instanceof OkrImportError?error.conflicts:0}));process.exitCode=1;
});

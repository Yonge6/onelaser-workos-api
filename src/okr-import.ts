import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { hasKrMetric } from './domain.js';

const text = (max: number) => z.string().min(1).max(max);
const date = z.string().date();
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const planning = z.object({
  weight: z.number().finite().min(0).max(100).nullable(),
  description: z.string().max(20000).nullable(),
  scoringDueDate: date.nullable().optional(),
  location: optionalText(100), type: z.enum(['mandatory', 'bonus']).nullable().optional(),
  bonusIncluded: z.boolean().nullable().optional(),
}).strict();
const metrics = z.object({ baseline: z.number().finite(), target: z.number().finite(),
  actual: z.number().finite().nullable(), direction: z.enum(['increase', 'decrease']), unit: text(30),
}).strict().refine(hasKrMetric, 'Metric target must differ from baseline in its declared direction');
export const okrImportManifest = z.object({
  version: z.literal(1),
  source: z.object({ provider: z.literal('dingtalk'), corpId: text(200), documentId: text(200), tableId: text(200),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    url: z.string().max(2048).url().refine(value => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }),
    exportedAt: z.string().datetime({ offset: true }), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    rowIdStrategy: z.literal('verified-identity-parent-item'),
  }).strict(),
  records: z.array(z.object({ sourceKey: text(300), kind: z.enum(['objective', 'key_result']),
    parentSourceKey: text(300).nullable(), ownerExternalUserId: text(128), itemLabel: text(100), title: text(4000),
    planning, metrics: metrics.nullable(),
    rawFields: z.array(z.object({ name: text(200), value: z.json() }).strict()).min(1).max(100),
  }).strict()).min(1).max(1000),
}).strict();
export type OkrImportManifest = z.infer<typeof okrImportManifest>;
type ImportRecord = OkrImportManifest['records'][number];
export class OkrImportError extends Error {
  constructor(public code: string, public conflicts = 0) { super(code); }
}
const fail = (code: string): never => { throw new OkrImportError(code); };

export const okrImportSchema = `
CREATE TABLE IF NOT EXISTS okr_import_batches (
 id text PRIMARY KEY, org_id text NOT NULL, actor_id text NOT NULL REFERENCES users(id),
 source_document_id text NOT NULL, source_table_id text NOT NULL, period text NOT NULL,
 snapshot_sha256 text NOT NULL, manifest_sha256 text NOT NULL, source_metadata jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,source_document_id,source_table_id,manifest_sha256)
);
CREATE TABLE IF NOT EXISTS okr_source_records (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES okr_import_batches(id),
 org_id text NOT NULL, owner_id text NOT NULL REFERENCES users(id), department_id text NOT NULL,
 source_document_id text NOT NULL, source_table_id text NOT NULL, source_key text NOT NULL,
 record_kind text NOT NULL CHECK(record_kind IN ('objective','key_result')),
 objective_id text NOT NULL REFERENCES objectives(id), kr_id text REFERENCES key_results(id),
 record_sha256 text NOT NULL, source_period text NOT NULL, item_label text NOT NULL,
 source_url text NOT NULL, source_exported_at timestamptz NOT NULL, snapshot_sha256 text NOT NULL,
 original_scoring_due_date text, record_payload jsonb NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(),
 CHECK((record_kind='objective' AND kr_id IS NULL) OR (record_kind='key_result' AND kr_id IS NOT NULL)),
 UNIQUE(org_id,source_document_id,source_table_id,source_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS okr_source_objective_idx ON okr_source_records(objective_id) WHERE record_kind='objective';
CREATE UNIQUE INDEX IF NOT EXISTS okr_source_kr_idx ON okr_source_records(kr_id) WHERE record_kind='key_result';
`;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function parseOkrImportManifest(input: unknown): OkrImportManifest {
  const manifest = okrImportManifest.parse(input), records = new Map<string, ImportRecord>();
  if (Buffer.byteLength(JSON.stringify(manifest)) > 4 * 1024 * 1024) fail('MANIFEST_TOO_LARGE');
  for (const record of manifest.records) {
    if (records.has(record.sourceKey)) fail('DUPLICATE_SOURCE_KEY');
    records.set(record.sourceKey, record);
    if (record.kind === 'objective' && (record.parentSourceKey !== null || record.metrics !== null)) fail('INVALID_OBJECTIVE');
    if (new Set(record.rawFields.map(field => field.name)).size !== record.rawFields.length) fail('DUPLICATE_SOURCE_FIELD');
  }
  for (const record of manifest.records) if (record.kind === 'key_result') {
    const parent = record.parentSourceKey ? records.get(record.parentSourceKey) : null;
    if (!parent || parent.kind !== 'objective' || parent.ownerExternalUserId !== record.ownerExternalUserId) fail('INVALID_PARENT');
    if (record.planning.location !== undefined || record.planning.type !== undefined || record.planning.bonusIncluded !== undefined) fail('INVALID_KR_PLANNING');
  }
  return manifest;
}

type SourceRow = {
  id: string; record_kind: string; objective_id: string; kr_id: string | null; source_key: string;
  record_sha256: string; owner_id: string; source_period: string; item_label: string;
  source_url: string; source_exported_at: string | Date; imported_at: string | Date;
  original_scoring_due_date: string | null; record_payload: ImportRecord;
};
const iso = (value: string | Date) => new Date(value).toISOString();
export function importSourceMetadata(row: SourceRow) {
  return { provider: 'dingtalk' as const, period: row.source_period, itemLabel: row.item_label,
    sourceUrl: row.source_url, importedAt: iso(row.imported_at), sourceExportedAt: iso(row.source_exported_at),
    originalScoringDueDate: row.original_scoring_due_date,
    deadlinePeriodMismatch: !!row.original_scoring_due_date && row.original_scoring_due_date.slice(0, 7) !== row.source_period };
}
export async function attachOkrImportMetadata(tx: Queryable, kind: 'objective' | 'key_result', records: any[]) {
  if (!records.length) return records;
  const field = kind === 'objective' ? 'objective_id' : 'kr_id';
  const rows = (await tx.query<SourceRow>(`SELECT * FROM okr_source_records WHERE record_kind=$1 AND ${field}=ANY($2::text[])`, [kind, records.map(row => row.id)])).rows;
  const indexed = new Map(rows.map(row => [kind === 'objective' ? row.objective_id : row.kr_id, importSourceMetadata(row)]));
  return records.map(row => ({ ...row, importSource: indexed.get(row.id) || null }));
}
// Call only after the same owner/manager permission check used for appraisals.
export async function readOkrLegacySource(tx: Queryable, kind: 'objective' | 'key_result', id: string) {
  const field = kind === 'objective' ? 'objective_id' : 'kr_id';
  const row = (await tx.query<SourceRow>(`SELECT * FROM okr_source_records WHERE record_kind=$1 AND ${field}=$2`, [kind, id])).rows[0];
  return row ? { classification: 'legacy_source' as const, formulaVerified: false,
    importSource: importSourceMetadata(row), rawFields: row.record_payload.rawFields } : null;
}

export type ImportOptions = { actorUserId: string; mode?: 'dry-run' | 'apply'; expectedCorpId?: string };
export async function importOkrSnapshot(db: Database, input: unknown, options: ImportOptions) {
  const manifest = parseOkrImportManifest(input), { source, records } = manifest;
  if (options.mode && !['dry-run', 'apply'].includes(options.mode)) fail('INVALID_MODE');
  if (options.expectedCorpId && options.expectedCorpId !== source.corpId) fail('CORPORATION_MISMATCH');
  const mode = options.mode || 'dry-run';
  return db.transaction(async tx => {
    // Serialize imports only. A dry-run performs no writes or schema changes.
    if (mode === 'apply') await tx.query('LOCK TABLE okr_source_records IN SHARE ROW EXCLUSIVE MODE');
    const actor = (await tx.query<User>(`SELECT u.* FROM users u JOIN external_identities e ON e.user_id=u.id
      WHERE u.id=$1 AND u.org_id=$2 AND u.active=true AND e.provider='dingtalk' AND e.corp_id=$2`, [options.actorUserId, source.corpId])).rows[0];
    if (!actor || actor.role !== 'manager') fail('IMPORT_ACTOR_FORBIDDEN');
    const owners = (await tx.query<User & { external_user_id: string }>(`SELECT u.*,e.external_user_id FROM users u
      JOIN external_identities e ON e.user_id=u.id WHERE u.org_id=$1 AND u.active=true
      AND e.provider='dingtalk' AND e.corp_id=$1 AND e.external_user_id=ANY($2::text[])`,
      [source.corpId, [...new Set(records.map(row => row.ownerExternalUserId))]])).rows;
    const ownerMap = new Map(owners.map(owner => [owner.external_user_id, owner]));
    if (records.some(row => !ownerMap.has(row.ownerExternalUserId) || ownerMap.get(row.ownerExternalUserId)!.department_id !== actor.department_id)) fail('IMPORT_OWNER_UNMAPPED_OR_OUT_OF_SCOPE');
    const existing = (await tx.query<SourceRow>(`SELECT * FROM okr_source_records
      WHERE org_id=$1 AND source_document_id=$2 AND source_table_id=$3 AND source_key=ANY($4::text[])`,
      [source.corpId, source.documentId, source.tableId, records.map(row => row.sourceKey)])).rows;
    const existingMap = new Map(existing.map(row => [row.source_key, row]));
    const stableSource = { provider: source.provider, corpId: source.corpId, documentId: source.documentId,
      tableId: source.tableId, period: source.period, url: source.url, rowIdStrategy: source.rowIdStrategy };
    const hashes = new Map(records.map(row => [row.sourceKey, digest({ source: stableSource, record: row })]));
    const conflicts = records.filter(row => {
      const previous = existingMap.get(row.sourceKey);
      return previous && (previous.record_sha256 !== hashes.get(row.sourceKey) || previous.owner_id !== ownerMap.get(row.ownerExternalUserId)!.id);
    });
    if(conflicts.length) throw new OkrImportError('SOURCE_RECORD_CONFLICT', conflicts.length);
    const pending = records.filter(row => !existingMap.has(row.sourceKey));
    const warnings: { sourceKey: string; code: string }[] = [];
    for (const row of records) {
      if (row.planning.scoringDueDate && row.planning.scoringDueDate.slice(0, 7) !== source.period) warnings.push({ sourceKey: row.sourceKey, code: 'SCORING_DATE_OUTSIDE_PERIOD' });
      if (row.planning.weight === null) warnings.push({ sourceKey: row.sourceKey, code: 'WEIGHT_UNKNOWN' });
    }
    for(const objective of records.filter(row=>row.kind==='objective')) {
      const children=records.filter(row=>row.parentSourceKey===objective.sourceKey);
      if(objective.planning.weight===null||children.some(row=>row.planning.weight===null)) warnings.push({sourceKey:objective.sourceKey,code:'KR_WEIGHT_TOTAL_UNKNOWN'});
      else if(Math.abs(children.reduce((sum,row)=>sum+row.planning.weight!,0)-objective.planning.weight)>0.000001) warnings.push({sourceKey:objective.sourceKey,code:'KR_WEIGHT_TOTAL_MISMATCH'});
    }
    for(const externalId of ownerMap.keys()) {
      const objectives=records.filter(row=>row.kind==='objective'&&row.ownerExternalUserId===externalId);
      const representative=objectives[0]?.sourceKey;
      if(!representative)continue;
      if(objectives.some(row=>row.planning.type===undefined||row.planning.type===null||(row.planning.type==='mandatory'&&row.planning.weight===null))) warnings.push({sourceKey:representative,code:'MANDATORY_WEIGHT_TOTAL_UNKNOWN'});
      else if(Math.abs(objectives.filter(row=>row.planning.type==='mandatory').reduce((sum,row)=>sum+row.planning.weight!,0)-100)>0.000001) warnings.push({sourceKey:representative,code:'MANDATORY_WEIGHT_TOTAL_NOT_100'});
    }
    const summary = { mode, period: source.period, sourceSnapshotSha256: source.snapshotSha256,
      owners: ownerMap.size, total: records.length, create: pending.length, skipped: records.length - pending.length,
      objectivesToCreate: pending.filter(row => row.kind === 'objective').length,
      keyResultsToCreate: pending.filter(row => row.kind === 'key_result').length,
      unknownMetricKeyResults: records.filter(row => row.kind === 'key_result' && row.metrics === null).length, warnings };
    if (mode === 'dry-run' || !pending.length) return { ...summary, applied: false, batchId: null };
    const batchId = randomUUID();
    await tx.query(`INSERT INTO okr_import_batches(id,org_id,actor_id,source_document_id,source_table_id,period,snapshot_sha256,manifest_sha256,source_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [batchId, source.corpId, actor.id, source.documentId, source.tableId, source.period,
      source.snapshotSha256, digest(manifest), JSON.stringify(source)]);
    const objectiveIds = new Map(existing.filter(row => row.record_kind === 'objective').map(row => [row.source_key, row.objective_id]));
    for (const row of [...pending.filter(row => row.kind === 'objective'), ...pending.filter(row => row.kind === 'key_result')]) {
      const owner = ownerMap.get(row.ownerExternalUserId)!, targetId = randomUUID();
      const objectiveId = row.kind === 'objective' ? targetId : objectiveIds.get(row.parentSourceKey!);
      if (!objectiveId) fail('INVALID_PARENT');
      if (row.kind === 'objective') {
        await tx.query(`INSERT INTO objectives(id,org_id,department_id,owner_id,level,title,planning) VALUES($1,$2,$3,$4,'personal',$5,$6)`,
          [targetId, source.corpId, owner.department_id, owner.id, row.title, JSON.stringify({ ...row.planning, period: source.period })]);
        objectiveIds.set(row.sourceKey, targetId);
      } else {
        const m = row.metrics;
        await tx.query(`INSERT INTO key_results(id,objective_id,title,baseline,target,actual,direction,unit,planning) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [targetId, objectiveId, row.title, m?.baseline ?? null, m?.target ?? null, m?.actual ?? null,
            m?.direction ?? null, m?.unit ?? null, JSON.stringify(row.planning)]);
      }
      await tx.query(`INSERT INTO okr_source_records(id,batch_id,org_id,owner_id,department_id,source_document_id,source_table_id,source_key,record_kind,
        objective_id,kr_id,record_sha256,source_period,item_label,source_url,source_exported_at,snapshot_sha256,original_scoring_due_date,record_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [randomUUID(), batchId, source.corpId, owner.id, owner.department_id, source.documentId, source.tableId, row.sourceKey, row.kind,
          objectiveId, row.kind === 'key_result' ? targetId : null, hashes.get(row.sourceKey), source.period, row.itemLabel,
          source.url, source.exportedAt, source.snapshotSha256, row.planning.scoringDueDate ?? null, JSON.stringify(row)]);
      await tx.query(`INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details)
        VALUES($1,$2,$3,$4,$5,'okr.imported',$6,$7)`, [randomUUID(), source.corpId, owner.department_id, owner.id, actor.id,
        targetId, JSON.stringify({ batchId, recordKind: row.kind, sourceRecordHash: hashes.get(row.sourceKey),
          sourceSnapshotSha256: source.snapshotSha256, policy: 'legacy_source_not_verified' })]);
    }
    return { ...summary, applied: true, batchId };
  });
}

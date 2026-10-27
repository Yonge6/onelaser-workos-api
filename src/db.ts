import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'pglite' | 'postgres';
}
export async function createDatabase(options: { connectionString?: string; dataDir?: string } = {}): Promise<Database> {
  if (options.connectionString) {
    const pool = new pg.Pool({ connectionString: options.connectionString, max: 5 });
    const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
      async query<T>(sql: string, params: unknown[] = []) { return { rows: (await client.query(sql, params)).rows as T[] }; }
    });
    return {
      ...wrap(pool), kind: 'postgres',
      async exec(sql) { await pool.query(sql); },
      async transaction(fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); }
    };
  }
  const db = await PGlite.create(options.dataDir || 'memory://');
  const wrap = (client: Pick<PGlite, 'query'>): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) { return { rows: (await client.query(sql, params)).rows as T[] }; }
  });
  return {
    ...wrap(db), kind: 'pglite',
    async exec(sql) { await db.exec(sql); },
    async transaction(fn) { return db.transaction(tx => fn(wrap(tx))); },
    async close() { await db.close(); }
  };
}

export const schema = `
CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL,
 display_name text NOT NULL, role text NOT NULL CHECK (role IN ('employee','manager')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS objectives (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text,
 owner_id text REFERENCES users(id), level text NOT NULL CHECK(level IN ('company','department','personal')), title text NOT NULL
);
CREATE TABLE IF NOT EXISTS key_results (
 id text PRIMARY KEY, objective_id text NOT NULL REFERENCES objectives(id), title text NOT NULL,
 baseline double precision NOT NULL, target double precision NOT NULL, actual double precision NOT NULL,
 direction text NOT NULL CHECK(direction IN ('increase','decrease')), unit text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version >= 1)
);
CREATE TABLE IF NOT EXISTS tasks (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL,
 owner_id text NOT NULL REFERENCES users(id), reviewer_id text NOT NULL REFERENCES users(id), created_by text NOT NULL REFERENCES users(id),
 title text NOT NULL, description text NOT NULL, criteria jsonb NOT NULL,
 baseline_due_at timestamptz NOT NULL, due_at timestamptz NOT NULL, kr_id text REFERENCES key_results(id),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','submitted','accepted','revision')),
 version integer NOT NULL DEFAULT 1, submission_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS submissions (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id), version integer NOT NULL,
 submitted_by text NOT NULL REFERENCES users(id), title text NOT NULL, description text NOT NULL, evidence_url text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id, version)
);
CREATE TABLE IF NOT EXISTS reviews (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id), submission_version integer NOT NULL,
 reviewer_id text NOT NULL REFERENCES users(id), decision text NOT NULL CHECK(decision IN ('accept','return')),
 quality integer CHECK(quality BETWEEN 0 AND 100), note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id, submission_version) REFERENCES submissions(task_id, version)
);
CREATE TABLE IF NOT EXISTS measurements (
 id text PRIMARY KEY, kr_id text NOT NULL REFERENCES key_results(id), actual double precision NOT NULL,
 source text NOT NULL, note text NOT NULL, recorded_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL, owner_id text NOT NULL,
 actor_id text NOT NULL REFERENCES users(id), action text NOT NULL, object_id text NOT NULL,
 details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_scope_idx ON tasks(org_id, department_id, owner_id);
CREATE INDEX IF NOT EXISTS audit_scope_idx ON audit_events(org_id, department_id, owner_id);
`;
export async function seedDemo(db: Database) {
  const users = [
    ['m1','marketing','林楠','manager'], ['m2','marketing','陈一','employee'], ['m3','marketing','许夏','employee'],
    ['m4','product','周明','manager'], ['m5','product','赵然','employee'], ['m6','product','顾安','employee']
  ];
  await db.transaction(async tx => {
    for (const [id, dept, name, role] of users) await tx.query(
      'INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id,'demo',dept,name,role]);
    const objs = [
      ['o1',null,null,'company','以可核验的客户价值推动增长'],
      ['o2','marketing','m1','department','提升有效获客效率'],
      ['o3','marketing','m2','personal','交付可验收的产品内容'],
      ['o4','marketing','m3','personal','完善增长实验复盘'],
      ['o5','product','m4','department','改善产品交付可靠性']
    ];
    for (const [id,dept,owner,level,title] of objs) await tx.query(
      'INSERT INTO objectives(id,org_id,department_id,owner_id,level,title) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [id,'demo',dept,owner,level,title]);
    for (const [id, obj, title, target, actual, unit] of [
      ['kr1','o2','有效询盘',30,18,'条'], ['kr2','o3','通过验收的内容',20,12,'篇'],
      ['kr3','o4','有效实验',5,2,'次'], ['kr4','o5','完成验证的发布',10,5,'次']
    ]) await tx.query('INSERT INTO key_results(id,objective_id,title,baseline,target,actual,direction,unit) VALUES($1,$2,$3,0,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [id,obj,title,target,actual,'increase',unit]);
    for (const [id,owner,reviewer,dept,kr,title] of [
      ['t1','m2','m1','marketing','kr2','产品内容初稿'],
      ['t2','m3','m1','marketing','kr3','获客实验复盘'],
      ['t3','m5','m4','product','kr4','发布验证记录']
    ]) await tx.query('INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT DO NOTHING', [id,'demo',dept,owner,reviewer,title,'仅为 API 开发测试的虚构任务',JSON.stringify(['提供可核对的成果记录','逐项说明验收标准']), '2026-11-01T10:00:00Z',kr]);
  });
}

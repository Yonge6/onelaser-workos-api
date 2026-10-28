import type { Queryable } from './db.js';
import { krProgress } from './domain.js';

// Read-only company reporting; this does not expand task mutation/review permissions.
export async function executiveSummary(db: Queryable, orgId: string) {
  const counts = `count(*)::int AS total,
    count(*) FILTER (WHERE status='accepted')::int AS accepted,
    count(*) FILTER (WHERE status='submitted')::int AS waiting,
    count(*) FILTER (WHERE status<>'accepted' AND due_at<now())::int AS overdue`;
  const totals=(await db.query(`SELECT ${counts} FROM tasks WHERE org_id=$1`,[orgId])).rows[0];
  const departments=(await db.query(`SELECT d.id,d.name,
    (SELECT count(*)::int FROM users u WHERE u.org_id=d.org_id AND u.department_id=d.id AND u.active=true) AS members,
    COALESCE(t.total,0)::int AS total,COALESCE(t.accepted,0)::int AS accepted,
    COALESCE(t.waiting,0)::int AS waiting,COALESCE(t.overdue,0)::int AS overdue
    FROM departments d LEFT JOIN (SELECT department_id,${counts} FROM tasks WHERE org_id=$1 GROUP BY department_id) t ON t.department_id=d.id
    WHERE d.org_id=$1 ORDER BY d.name,d.id`,[orgId])).rows;
  const objectives=(await db.query(`SELECT o.id,o.title,o.level,o.department_id,k.id AS kr_id,k.baseline,k.actual,k.target,k.direction
    FROM objectives o LEFT JOIN key_results k ON k.objective_id=o.id
    WHERE o.org_id=$1 AND o.level IN ('company','department') ORDER BY o.id,k.id`,[orgId])).rows;
  const grouped=new Map<string,any>();
  for(const row of objectives){
    if(!grouped.has(row.id))grouped.set(row.id,{id:row.id,title:row.title,level:row.level,departmentId:row.department_id,values:[]});
    const progress=row.kr_id?krProgress(row as any):null;
    if(progress!==null)grouped.get(row.id).values.push(progress*100);
  }
  const goals=[...grouped.values()].map(({values,...goal})=>({...goal,progress:values.length?Math.round(values.reduce((a:number,b:number)=>a+b,0)/values.length):null}));
  const company=goals.filter(g=>g.level==='company'&&g.progress!==null);
  const risks=(await db.query(`SELECT t.id,t.title,t.status,t.due_at AS due,u.display_name AS owner,d.name AS department,
    (t.due_at<now()) AS overdue FROM tasks t JOIN users u ON u.id=t.owner_id AND u.org_id=t.org_id
    JOIN departments d ON d.id=t.department_id AND d.org_id=t.org_id
    WHERE t.org_id=$1 AND t.status<>'accepted' AND (t.due_at<now() OR t.status IN ('submitted','revision'))
    ORDER BY (t.due_at<now()) DESC,t.due_at,t.id LIMIT 50`,[orgId])).rows;
  return {generatedAt:new Date().toISOString(),totals,departments,goals,
    companyProgress:company.length?Math.round(company.reduce((sum,g)=>sum+g.progress,0)/company.length):null,
    risks,riskLimit:50,scope:'all_recorded',demo:false};
}

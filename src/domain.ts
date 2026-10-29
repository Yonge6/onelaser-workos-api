import type { User } from './auth.js';
export function visibleTask(user: User, task: any) {
  return task && task.org_id === user.org_id && (user.role === 'manager' ? task.department_id === user.department_id : task.owner_id === user.id);
}
export function visibleObjective(user: User, objective: any) {
  return objective && objective.org_id === user.org_id && (objective.level === 'company' || (objective.department_id === user.department_id && (objective.level === 'department' || user.role === 'manager' || objective.owner_id === user.id)));
}
type KrMetric = { baseline?: number | null; target?: number | null; actual?: number | null; direction?: string | null; unit?: string | null };
export function hasKrMetric(kr: KrMetric): kr is KrMetric & { baseline: number; target: number; direction: 'increase' | 'decrease' } {
  if (typeof kr.baseline !== 'number' || !Number.isFinite(kr.baseline) ||
      typeof kr.target !== 'number' || !Number.isFinite(kr.target) ||
      (kr.direction !== 'increase' && kr.direction !== 'decrease')) return false;
  const distance = kr.direction === 'decrease' ? kr.baseline - kr.target : kr.target - kr.baseline;
  return Number.isFinite(distance) && distance > 0;
}
export function krProgress(kr: KrMetric) {
  if (!hasKrMetric(kr) || typeof kr.actual !== 'number' || !Number.isFinite(kr.actual)) return null;
  const distance = kr.direction === 'decrease' ? kr.baseline - kr.target : kr.target - kr.baseline;
  const achieved = kr.direction === 'decrease' ? kr.baseline - kr.actual : kr.actual - kr.baseline;
  return Math.max(0,Math.min(1,achieved / distance));
}

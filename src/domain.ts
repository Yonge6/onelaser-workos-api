import type { User } from './auth.js';
export function visibleTask(user: User, task: any) {
  return task && task.org_id === user.org_id && (user.role === 'manager' ? task.department_id === user.department_id : task.owner_id === user.id);
}
export function visibleObjective(user: User, objective: any) {
  return objective && objective.org_id === user.org_id && (objective.level === 'company' || (objective.department_id === user.department_id && (objective.level === 'department' || user.role === 'manager' || objective.owner_id === user.id)));
}
export function krProgress(kr: { baseline: number; target: number; actual: number; direction: string }) {
  const distance = kr.direction === 'decrease' ? kr.baseline - kr.target : kr.target - kr.baseline;
  if (!Number.isFinite(distance) || distance <= 0) return null;
  const achieved = kr.direction === 'decrease' ? kr.baseline - kr.actual : kr.actual - kr.baseline;
  return Math.max(0,Math.min(1,achieved / distance));
}

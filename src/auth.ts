import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './db.js';

export type User = { id: string; org_id: string; department_id: string; display_name: string; role: 'employee' | 'manager'; active: boolean };
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function sameSecret(a: string, b: string) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export async function issueSession(db: Queryable, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash(token),userId,expiresAt]);
  return { accessToken: token, tokenType: 'Bearer', expiresAt };
}
export async function resolveSession(db: Queryable, header?: string): Promise<User | null> {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
  if (!token) return null;
  const { rows } = await db.query<User>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [hash(token)]);
  return rows[0] || null;
}

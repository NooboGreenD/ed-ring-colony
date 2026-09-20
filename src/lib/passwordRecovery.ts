import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RECOVERY_COOKIE = 'edrc-password-recovery';
export const RECOVERY_TTL = 10 * 60;
type Grant = { userId: string; sessionId: string; expiresAt: number; nonce: string };
function key() {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('Recovery signing key unavailable');
  return value;
}
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`edrc-password-recovery:v1:${payload}`).digest('base64url');
}
// Only call after getUser() has validated the session, or on a verified OTP response.
export function sessionId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null;
  } catch { return null; }
}
export function createRecoveryGrant(userId: string, sid: string, now = Date.now(), secret = key()) {
  const grant: Grant = { userId, sessionId: sid, expiresAt: now + RECOVERY_TTL * 1000, nonce: randomBytes(16).toString('hex') };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}
export function readRecoveryGrant(value: string | undefined, now = Date.now(), secret?: string): Grant | null {
  if (!value || value.length > 2048) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const expected = Buffer.from(signature(parts[0], secret ?? key()));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const result = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!Number.isFinite(result.expiresAt) || result.expiresAt <= now ||
        typeof result.userId !== 'string' || !result.userId ||
        typeof result.sessionId !== 'string' || !result.sessionId ||
        typeof result.nonce !== 'string') return null;
    return result;
  } catch { return null; }
}

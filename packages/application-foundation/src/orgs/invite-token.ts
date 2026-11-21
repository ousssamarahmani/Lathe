import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url without padding: always 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new invite token. Shown to the inviter once, never stored. */
export function newInviteToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url');
}

/** sha256 of the token, hex. This is what the database stores and looks up. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True if `value` has the shape of a token. Lets callers reject junk without a query. */
export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

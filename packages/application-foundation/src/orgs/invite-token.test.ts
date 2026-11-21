import { describe, expect, it } from 'vitest';
import { hashInviteToken, isInviteToken, newInviteToken } from './invite-token.js';

describe('invite tokens', () => {
  it('are 43 url-safe characters and differ each time', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(isInviteToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('hash to 64 hex characters, deterministically, without containing the token', () => {
    const token = newInviteToken();
    const hash = hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('uses the injected random source', () => {
    expect(newInviteToken(() => Buffer.alloc(32, 0))).toBe('A'.repeat(43));
  });

  it.each([
    '',
    'short',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}=`,
    "x' OR '1'='1",
    42,
    null,
  ])('rejects %j', (value) => {
    expect(isInviteToken(value)).toBe(false);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, verifyChain, type EvidenceEntry } from './chain.js';
import { InMemoryEvidenceLog } from './evidence-log.js';
import { REDACTED, redactString, redactValue } from './redact.js';

const clock = () => {
  let t = Date.UTC(2026, 0, 1);
  return { now: () => new Date((t += 1000)) };
};

async function seeded(n = 4) {
  const log = new InMemoryEvidenceLog(clock());
  for (let i = 0; i < n; i += 1) await log.append('run-1', 'step', { i, b: 2, a: 1 });
  return { log, entries: await log.list('run-1') };
}

describe('hash chain', () => {
  it('links entries from genesis and verifies', async () => {
    const { entries } = await seeded();
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    const v = verifyChain(entries);
    expect(v).toMatchObject({ ok: true, length: 4, head: entries[3]?.hash });
  });

  it('hash is independent of payload key order', async () => {
    const a = new InMemoryEvidenceLog(clock());
    const b = new InMemoryEvidenceLog(clock());
    const ea = await a.append('r', 'k', { x: 1, y: { p: 1, q: 2 } });
    const eb = await b.append('r', 'k', { y: { q: 2, p: 1 }, x: 1 });
    expect(ea.hash).toBe(eb.hash);
  });

  it('detects a modified payload', async () => {
    const { entries } = await seeded();
    const t = entries.map((e) => ({ ...e }));
    t[1] = { ...(t[1] as EvidenceEntry), payload: { forged: true } };
    expect(verifyChain(t)).toMatchObject({ ok: false, index: 1, reason: 'bad_hash' });
  });

  it('detects a recomputed-looking edit via the next link', async () => {
    const { entries } = await seeded();
    const t = [...entries];
    t[1] = { ...(t[1] as EvidenceEntry), hash: 'f'.repeat(64) };
    expect(verifyChain(t)).toMatchObject({ ok: false, index: 1 });
  });

  it('detects reordering', async () => {
    const { entries } = await seeded();
    const t = [entries[0], entries[2], entries[1], entries[3]] as EvidenceEntry[];
    expect(verifyChain(t)).toMatchObject({ ok: false, index: 1, reason: 'bad_sequence' });
  });

  it('detects a deleted middle entry', async () => {
    const { entries } = await seeded();
    const t = [entries[0], entries[2], entries[3]] as EvidenceEntry[];
    expect(verifyChain(t)).toMatchObject({ ok: false, index: 1 });
  });

  it('detects a deleted first entry', async () => {
    const { entries } = await seeded();
    expect(verifyChain(entries.slice(1))).toMatchObject({ ok: false, index: 0 });
  });

  it('detects truncation only with the recorded head or length', async () => {
    const { entries } = await seeded();
    const cut = entries.slice(0, 3);
    expect(verifyChain(cut).ok).toBe(true);
    expect(verifyChain(cut, { length: 4 })).toMatchObject({ ok: false, reason: 'truncated' });
    expect(verifyChain(cut, { head: entries[3]?.hash ?? 'missing' })).toMatchObject({
      ok: false,
      reason: 'head_mismatch',
    });
  });

  it('detects an entry spliced from another run', async () => {
    const { entries } = await seeded();
    const other = new InMemoryEvidenceLog(clock());
    await other.append('run-2', 'step', {});
    const foreign = (await other.list('run-2'))[0] as EvidenceEntry;
    const t = [...entries];
    t[1] = foreign;
    expect(verifyChain(t).ok).toBe(false);
  });

  it('verifies via the log and stores frozen entries', async () => {
    const { log, entries } = await seeded(2);
    expect(await log.verify('run-1')).toMatchObject({ ok: true });
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(await log.verify('missing')).toMatchObject({ ok: true, length: 0 });
  });

  it('property: any single-entry mutation or swap is detected', async () => {
    const { entries } = await seeded(6);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.string(), (i, junk) => {
        const t = [...entries];
        t[i] = { ...(t[i] as EvidenceEntry), kind: `${(t[i] as EvidenceEntry).kind}${junk}x` };
        expect(verifyChain(t).ok).toBe(false);
      }),
    );
  });
});

describe('redaction', () => {
  const cases: [string, string][] = [
    ['bearer', 'Authorization: Bearer abcDEF123456.token-value_xyz'],
    ['password', 'db password=hunter2hunter2 end'],
    ['gh token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws key', 'key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP' + ' here'],
    [
      'private key',
      'x -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nabc\n-----END RSA PRIVATE KEY----- y',
    ],
  ];
  it.each(cases)('redacts %s', (_n, input) => {
    const out = redactString(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/hunter2|abcDEF123456|ghp_abc|AKIAABCD|MIIBOgIB/);
  });

  it('is idempotent and leaves clean text alone', () => {
    expect(redactString('nothing secret here')).toBe('nothing secret here');
    const once = redactString('password=abc12345');
    expect(redactString(once)).toBe(once);
  });

  it('redacts nested values and keys and stores redacted payloads', async () => {
    const out = redactValue({ a: ['Bearer abcdefghij123'], 'password=k9k9k9k9k9': 1 });
    expect(JSON.stringify(out)).not.toMatch(/abcdefghij123|k9k9k9k9k9/);
    const log = new InMemoryEvidenceLog(clock());
    const e = await log.append('r', 'k', { out: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(JSON.stringify(e)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect((await log.verify('r')).ok).toBe(true);
  });

  const alnum = (min: number, max: number) =>
    fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${min},${max}}$`));
  const secret = fc.oneof(
    alnum(20, 40).map((s) => ({ secret: `x${s}`, text: `Authorization: Bearer x${s}` })),
    alnum(8, 30).map((s) => ({ secret: `x${s}`, text: `password=x${s}` })),
    alnum(36, 40).map((s) => ({ secret: `ghp_${s}`, text: `t=ghp_${s}` })),
    fc.stringMatching(/^[A-Z0-9]{16}$/).map((s) => ({ secret: `AKIA${s}`, text: `k=AKIA${s}` })),
    alnum(20, 60).map((s) => ({
      secret: `Z${s}`,
      text: `-----BEGIN PRIVATE KEY-----\nZ${s}\n-----END PRIVATE KEY-----`,
    })),
  );

  it('property: redacted output never contains the planted secret', () => {
    fc.assert(
      fc.property(
        secret,
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (s, pre, post) => {
          const text = `${pre.replace(/[A-Za-z0-9]$/, '')} ${s.text} ${post}`;
          expect(redactString(text)).not.toContain(s.secret);
          expect(JSON.stringify(redactValue({ nested: [text] }))).not.toContain(s.secret);
        },
      ),
      { numRuns: 300 },
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  KIRO_EGRESS_HOSTS,
  buildNetworkCreateArgs,
  buildProxyConfig,
  buildProxyFilter,
  buildProxyRunArgs,
  isHostAllowed,
} from './egress-proxy.js';

const IMAGE = `lathe/egress-proxy@sha256:${'b'.repeat(64)}`;

describe('egress proxy', () => {
  it('allows exactly the listed hosts and denies everything else', () => {
    for (const h of KIRO_EGRESS_HOSTS) expect(isHostAllowed(KIRO_EGRESS_HOSTS, h)).toBe(true);
    for (const h of [
      'github.com',
      'api.github.com',
      'evil-runtime.us-east-1.kiro.dev',
      'runtime.us-east-1.kiro.dev.evil.com',
      'xruntime.us-east-1.kiro.dev',
      'runtimeXus-east-1.kiro.dev',
      'kiro.dev',
    ])
      expect(isHostAllowed(KIRO_EGRESS_HOSTS, h)).toBe(false);
  });

  it('allows nothing for an empty allow-list', () => {
    expect(isHostAllowed([], 'app.kiro.dev')).toBe(false);
  });

  it('rejects wildcards and malformed hosts', () => {
    expect(() => buildProxyFilter(['*.kiro.dev'])).toThrow(/plain hostname/);
    expect(() => buildProxyFilter(['a.com\nb.com'])).toThrow();
  });

  it('config is deny-by-default and CONNECT-only to 443', () => {
    const c = buildProxyConfig();
    expect(c).toContain('FilterDefaultDeny Yes');
    expect(c).toContain('ConnectPort 443');
    expect(c).not.toMatch(/ConnectPort (?!443)/);
    expect(c).not.toMatch(/^Allow /m);
  });

  it('builds hardened proxy args on the internal network with the allow-list in env', () => {
    const a = buildProxyRunArgs({
      name: 'lathe-proxy-abc123',
      network: 'lathe-net-abc123',
      image: IMAGE,
      allowlist: ['app.kiro.dev'],
    });
    expect(a).toEqual(
      expect.arrayContaining(['--cap-drop', 'ALL', '--read-only', '--user', '10002:10002']),
    );
    expect(a).not.toContain('--privileged');
    const filterEnv = a.find((x) => x.startsWith('TINYPROXY_FILTER_B64='));
    expect(Buffer.from(filterEnv?.split('=')[1] ?? '', 'base64').toString()).toBe(
      '^app\\.kiro\\.dev$\n',
    );
    expect(() =>
      buildProxyRunArgs({ name: 'p', network: 'n', image: 'alpine:3', allowlist: [] }),
    ).toThrow();
  });

  it('creates the network as internal', () => {
    expect(buildNetworkCreateArgs('lathe-net-abc123')).toContain('--internal');
    expect(() => buildNetworkCreateArgs('bad name')).toThrow();
  });
});

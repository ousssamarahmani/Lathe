import { join } from 'node:path';
import { GATE_ORDER, type GateId } from '@lathe/shared-contracts';
import { notImplementedGate, type Gate } from './gate.js';
import { staticGate, testsGate } from './gates/build-gates.js';
import { protectedPathsGate } from './gates/protected-paths.js';

/** Task that implements each gate. Until then the gate reports `error`. */
const PENDING: Record<GateId, string> = {
  'protected-paths': 'P2-02',
  static: 'P2-03',
  tests: 'P2-03',
  // static and tests are implemented by P2-03; the entries remain for the Record type.
  'tenant-isolation': 'P2-04',
  rbac: 'P2-05',
  properties: 'P2-06',
  security: 'P2-07',
};

/** The gates `lathe-verify` runs, keyed by id. `policyDir` holds the policy files. */
export function defaultGates(policyDir: string): Record<GateId, Gate> {
  const gates = Object.fromEntries(
    GATE_ORDER.map((id) => [id, notImplementedGate(id, PENDING[id])]),
  ) as Record<GateId, Gate>;
  gates['protected-paths'] = protectedPathsGate(join(policyDir, 'protected-paths.json'));
  const staticTests = join(policyDir, 'static-tests.json');
  gates.static = staticGate(staticTests);
  gates.tests = testsGate(staticTests);
  return gates;
}

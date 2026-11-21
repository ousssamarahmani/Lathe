export const PACKAGE_NAME = '@lathe/verification-harness';
export function packageName(): string {
  return PACKAGE_NAME;
}

export { notImplementedGate, type Gate, type GateContext, type GateOutcome } from './gate.js';
export { hashTree, resultHash, sha256 } from './hash.js';
export { defaultGates } from './registry.js';
export { runVerification, type RunInput } from './runner.js';
export { main, parseArgs, USAGE, type CliDeps } from './cli.js';
export { parsePatch, unquote, type ParsedPatch, type PatchFile } from './gates/patch-parser.js';
export {
  checkPatch,
  foldPath,
  loadPolicy,
  protectedPathsGate,
  ProtectedPathsPolicy,
  RULES as PROTECTED_PATH_RULES,
} from './gates/protected-paths.js';

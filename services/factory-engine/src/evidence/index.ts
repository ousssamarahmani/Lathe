export { canonicalJson, sha256Hex } from './canonical.js';
export {
  GENESIS_HASH,
  buildEntry,
  computeEntryHash,
  verifyChain,
  type ChainFailure,
  type ChainVerification,
  type EvidenceEntry,
} from './chain.js';
export { InMemoryEvidenceLog, type EvidenceClock, type EvidenceLog } from './evidence-log.js';
export { REDACTED, redactString, redactValue } from './redact.js';

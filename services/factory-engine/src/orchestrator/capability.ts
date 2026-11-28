/**
 * Engine-internal capability. Moving a run into a passing state needs one of
 * these. The module is deliberately NOT re-exported from the package index:
 * only Engine code (pipeline, approvals) imports it. Agent output and API
 * input can never produce one, because the check is by object identity.
 */
declare const engineCapabilityBrand: unique symbol;
export type EngineCapability = { readonly [engineCapabilityBrand]: 'EngineCapability' };

const issued = new WeakSet<object>();

/** Issued once by the Engine composition root, then passed to the pipeline. */
export function issueEngineCapability(): EngineCapability {
  const capability = Object.freeze({}) as EngineCapability;
  issued.add(capability);
  return capability;
}

export function isEngineCapability(value: unknown): value is EngineCapability {
  return typeof value === 'object' && value !== null && issued.has(value);
}

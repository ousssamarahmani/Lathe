/**
 * Expected failures of the orgs module, each with a stable code.
 *
 * `not_found` covers "does not exist", "belongs to another org", "you are not a
 * member" and "invite is used, expired or unknown" on purpose: callers cannot
 * tell them apart (`security.md`: a foreign resource is a 404).
 */
export type OrgErrorCode = 'not_found' | 'conflict' | 'last_owner' | 'validation_failed';

export class OrgError extends Error {
  readonly code: OrgErrorCode;

  constructor(code: OrgErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OrgError';
    this.code = code;
  }
}

/**
 * Error envelope: every CLI failure is emitted as a JSON object on stderr
 * and a non-zero exit code. Space API errors pass through Space's own
 * `error` / `error_description` codes verbatim.
 */
export interface ErrorEnvelope {
  /** Machine-readable error code. */
  error: string;
  /** Human-readable explanation. */
  error_description: string;
  /** HTTP status from the Space API, when the error originated there. */
  status?: number;
}

/** Error codes emitted by the CLI itself (Space codes pass through as-is). */
export const CLI_ERROR_CODES = [
  'config-error',
  'usage-error',
  'network-error',
  'http-error',
  'protocol-error',
  'unexpected-error',
] as const;

export class SpaceCliError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status?: number;

  constructor(code: string, description: string, status?: number) {
    super(`${code}: ${description}`);
    this.name = 'SpaceCliError';
    this.code = code;
    this.description = description;
    this.status = status;
  }

  toEnvelope(): ErrorEnvelope {
    const envelope: ErrorEnvelope = {
      error: this.code,
      error_description: this.description,
    };
    if (this.status !== undefined) envelope.status = this.status;
    return envelope;
  }
}

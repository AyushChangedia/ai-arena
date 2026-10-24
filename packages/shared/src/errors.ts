/** Thrown by any code path that is deliberately not built yet. Listed in PROGRESS.md. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** A configuration or environment problem. `fix` tells the human what to do. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Base class for classified errors. `kind` is a stable code; `publicMessage` is safe for the site. */
export class ClassifiedError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly publicMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ClassifiedError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

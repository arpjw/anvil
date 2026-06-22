export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = opts.details;
    if (opts.cause) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

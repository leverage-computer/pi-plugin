import { Data } from "effect";

/** Leverage answered with a failing HTTP status. */
export class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  action: string;
  message: string;
  request?: string;
  correlationId?: string;
}> {
  constructor(
    status: number,
    action = "request",
    details?: { request: string; message?: string; correlationId?: string },
  ) {
    super({
      status,
      action,
      message:
        `Leverage ${action} failed (${status})${details?.message ? `: ${details.message}` : ""}` +
        (details
          ? `\n${details.request}${details.correlationId ? `\nRequest ID: ${details.correlationId}` : ""}`
          : ""),
      ...(details?.request ? { request: details.request } : {}),
      ...(details?.correlationId
        ? { correlationId: details.correlationId }
        : {}),
    });
  }
}

/** Leverage answered with data this client cannot read. */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  message: string;
  cause?: unknown;
}> {
  constructor(message: string, options?: { cause?: unknown }) {
    super({ message, ...(options?.cause ? { cause: options.cause } : {}) });
  }
}

/** The caller asked for something this client refuses to send. */
export class InputError extends Data.TaggedError("InputError")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

/** The device credential or login settings are unusable. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

/** The local setup, like the remote workspace, is not ready for the request. */
export class StateError extends Data.TaggedError("StateError")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

export type LeverageError =
  | ApiError
  | ProtocolError
  | InputError
  | ConfigError
  | StateError;

/** Turns an abort reason into the error a caller sees. */
export function failure(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Leverage request cancelled");
}

/** Whether an HTTP failure is worth another attempt later. */
export function isTransient(error: unknown): boolean {
  if (error instanceof ProtocolError) {
    return false;
  }
  if (error instanceof ApiError) {
    return error.status >= 500 || error.status === 429;
  }
  return true;
}

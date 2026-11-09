export type ControlErrorCode =
  | "LIVE_DISABLED"
  | "AUTHORIZATION_REQUIRED"
  | "INVALID_GRANT"
  | "INVALID_REQUEST"
  | "AUTHENTICATION"
  | "STATE_FAILURE"
  | "BUSY"
  | "HALTED"
  | "ALLOWANCE_EXHAUSTED"
  | "PRICING_STALE"
  | "PRICING_CHANGED"
  | "DUPLICATE_OPERATION"
  | "CANCELLED";

/** Messages originate in this library, never from provider bodies or credential values. */
export class ControlError extends Error {
  constructor(
    public readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}
export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ControlError(
      "CANCELLED",
      "The operation was cancelled before reservation.",
    );
}

// SPDX-License-Identifier: AGPL-3.0
// Adapted from upstream gobifrost/bifrost client/src/lib/api-error.ts
// (reference: vendor/upstream). Structure borrowed; Wrangnarök error shape only.

/** Structured error body served by the Worker: { error: { code, message } }.
 * Form validation failures add an optional details list of per-field
 * failures; the client passes it through without interpreting it. */
export interface WorkerErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  /** Structured per-field failures from the Worker 422 envelope (forms).
   * Absent for non-validation failures; the renderer reads it read-only. */
  public readonly details: unknown;

  constructor(code: string, message: string, status: number, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  isUnimplemented(): boolean {
    return this.code === "UNIMPLEMENTED";
  }
}

/** Parse a failed fetch Response into an ApiError. Never throws. */
export async function parseApiError(response: Response): Promise<ApiError> {
  let code = "REQUEST_FAILED";
  let message = `Request failed with status ${response.status}.`;
  let details: unknown = null;
  try {
    const body = (await response.json()) as Partial<WorkerErrorBody>;
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (body.error?.details !== undefined) details = body.error.details;
  } catch {
    // Keep the status-based fallback.
  }
  return new ApiError(code, message, response.status, details);
}

/** Extract a human-readable message from any error value. */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

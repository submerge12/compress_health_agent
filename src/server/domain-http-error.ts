/**
 * WO-HS-03 / M18: typed domain HTTP errors.
 *
 * Domain services throw these; display-server maps them to real status codes
 * instead of collapsing everything into RangeError-400 / everything-else-500.
 * The BFF preserves status + structured body downstream (plan §六 mapping).
 */
export class DomainHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "DomainHttpError";
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new DomainHttpError(400, "bad_request", message, details),
  unauthorized: (message = "missing or invalid bearer token") => new DomainHttpError(401, "unauthorized", message),
  forbidden: (message = "not allowed for current user") => new DomainHttpError(403, "forbidden", message),
  notFound: (what = "resource") => new DomainHttpError(404, "not_found", `${what} not found`),
  conflict: (code: string, message: string, details?: unknown) => new DomainHttpError(409, code, message, details),
  needsConfirmation: (details: unknown) =>
    new DomainHttpError(422, "needs_confirmation", "estimate has unresolved segments; confirm candidates first", details),
  unavailable: (what: string) => new DomainHttpError(503, "unavailable", `${what} is not available`),
};

/** Domain errors carry an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Resource") {
    super(`${what} not found`, 404, "not_found");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You are not allowed to perform this action") {
    super(message, 403, "forbidden");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "unauthorized");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 422, "validation_error", details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict", details?: Record<string, unknown>) {
    super(message, 409, code, details);
  }
}

/** A business rule (e.g. 24h reschedule notice) blocks the action. */
export class PolicyError extends AppError {
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message, 422, code, details);
  }
}

/** Map PostgreSQL errors that encode business rules to domain errors. */
export function translatePgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === "23P01") {
    const c = e.constraint ?? "";
    const who = c.includes("instructor") ? "instructor" : c.includes("vehicle") ? "vehicle" : "student";
    return new ConflictError(
      `This time slot is no longer available (the ${who} is already booked).`,
      "slot_taken",
      { constraint: c },
    );
  }
  if (e?.code === "23505") return new ConflictError("A record with these details already exists.", "duplicate", { constraint: e.constraint });
  return err;
}

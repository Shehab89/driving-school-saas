import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";

/** JSON route wrapper with consistent error bodies: { error: { code, message, details } }. */
export async function jsonRoute(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, { status: err.status });
    }
    if (err instanceof ZodError) {
      return NextResponse.json({ error: { code: "validation_error", message: "Invalid input", details: err.issues } }, { status: 422 });
    }
    log.error("api.failed", { err });
    return NextResponse.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
  }
}

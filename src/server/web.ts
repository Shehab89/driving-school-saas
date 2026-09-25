import "server-only";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AppError } from "@/lib/errors";
import { ZodError } from "zod";

function withParam(path: string, key: string, value: string) {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("error");
  params.delete("ok");
  params.set(key, value);
  return `${base}?${params.toString()}`;
}

/**
 * Server-action wrapper: runs fn, then redirects back with ?ok= or ?error=.
 * Domain errors become user-facing messages; unexpected errors are logged and
 * shown generically.
 */
export async function runAction(fn: () => Promise<unknown>, opts: { back: string; success?: string; okMessage?: string }): Promise<never> {
  let target: string;
  try {
    await fn();
    target = withParam(opts.success ?? opts.back, "ok", opts.okMessage ?? "Saved");
  } catch (err) {
    if (isRedirectError(err)) throw err;
    let message = "Something went wrong. Please try again.";
    if (err instanceof AppError) message = err.message;
    else if (err instanceof ZodError) message = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    else console.error("[action]", err);
    target = withParam(opts.back, "error", message);
  }
  redirect(target);
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}
export function optStr(fd: FormData, key: string): string | undefined {
  return str(fd, key) || undefined;
}
export function num(fd: FormData, key: string): number | undefined {
  const s = str(fd, key);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
export function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true";
}

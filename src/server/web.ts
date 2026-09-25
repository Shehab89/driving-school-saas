import "server-only";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { AppError } from "@/lib/errors";
import { ZodError } from "zod";
import { tryTranslate } from "@/i18n";
import { getLocale } from "@/i18n/server";

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
export async function runAction(fn: () => Promise<unknown>, opts: { back: string; success?: string; okMessage?: string | (() => string) }): Promise<never> {
  let target: string;
  try {
    await fn();
    const ok = typeof opts.okMessage === "function" ? opts.okMessage() : opts.okMessage;
    target = withParam(opts.success ?? opts.back, "ok", ok ?? "Saved");
  } catch (err) {
    if (isRedirectError(err)) throw err;
    const locale = await getLocale();
    let message = tryTranslate(locale, "errors.generic")!;
    if (err instanceof AppError) {
      // Prefer the translated message for the error code; fall back to the (English) service message.
      const params = Object.fromEntries(
        Object.entries(err.details ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number"),
      ) as Record<string, string | number>;
      message = tryTranslate(locale, `errors.${err.code}`, params) ?? err.message;
    } else if (err instanceof ZodError) {
      message = locale === "en" ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : tryTranslate(locale, "errors.validation_error")!;
    } else console.error("[action]", err);
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

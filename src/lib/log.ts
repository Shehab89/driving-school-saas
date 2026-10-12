/**
 * Structured JSON logging with personal-data redaction.
 *
 * One JSON object per line on stdout/stderr, which every host (Docker, Railway,
 * Render, Vercel) collects as-is and log tools can filter by `level`/`event`.
 * E-mail addresses, phone numbers and bearer-like tokens are masked so logs do
 * not become a second copy of customer data.
 */
type Level = "debug" | "info" | "warn" | "error";

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const TOKEN = /\b(sk|pk|rk|whsec|re|EAA)[_A-Za-z0-9-]{12,}\b/g;
const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|activation_url|reset_url|code/i;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.replace(EMAIL, "$1***@$2").replace(TOKEN, "$1_***").replace(PHONE, (m) => `${m.slice(0, 3)}***${m.slice(-2)}`);
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (Array.isArray(value)) return depth > 4 ? "[…]" : value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 4) return "[…]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
}

function write(level: Level, event: string, fields?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.NODE_ENV === "test" && level !== "error" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields ?? {}) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

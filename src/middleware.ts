import { NextResponse, type NextRequest } from "next/server";

/**
 * Content-Security-Policy with a per-request nonce. Next.js reads the nonce
 * from the request's CSP header and adds it to its own <script> tags, so only
 * scripts we ship can run; injected markup cannot execute JavaScript.
 * Inline style attributes are allowed (the UI uses them; they cannot run code).
 */
export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(process.env.APP_URL?.startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Pages only: skip static assets, icons and machine endpoints (webhooks, cron, health).
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|icons/|app-icons/|brand/|.*\\.webmanifest).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};

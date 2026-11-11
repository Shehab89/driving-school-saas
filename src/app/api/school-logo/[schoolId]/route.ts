import { loadLogo } from "@/server/services/branding";

/** GET /api/school-logo/<school id> — the school's logo (public: it appears in e-mails and on the login screens). */
export async function GET(_req: Request, { params }: { params: Promise<{ schoolId: string }> }) {
  const { schoolId } = await params;
  const logo = await loadLogo(schoolId);
  if (!logo) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.content_type,
      // The URL carries ?v=<last change>, so a new logo gets a new URL.
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Last-Modified": logo.updated_at.toUTCString(),
    },
  });
}

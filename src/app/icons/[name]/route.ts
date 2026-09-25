import { appIcon } from "@/server/manifest";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const app = name.replace(/\.svg$/, "");
  if (app !== "student" && app !== "instructor") return new Response("not found", { status: 404 });
  return new Response(appIcon(app), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}

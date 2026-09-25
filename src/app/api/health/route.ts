import { NextResponse } from "next/server";
import { withPlatform } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await withPlatform((tx) => tx.query("SELECT 1"));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

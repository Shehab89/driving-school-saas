import { NextResponse } from "next/server";
import { destroySession } from "@/server/auth/session";
import { env } from "@/lib/env";

/** Log out and return to the sign-in page of the app the user came from. */
export async function POST(req: Request) {
  await destroySession();
  let path = "";
  try {
    path = new URL(req.headers.get("referer") ?? "").pathname;
  } catch {}
  const target = path.startsWith("/student") ? "/login/student" : path.startsWith("/instructor") || path.startsWith("/lessons") ? "/login/instructor" : "/login";
  return NextResponse.redirect(`${env.appUrl}${target}`, 303);
}

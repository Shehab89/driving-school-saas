import { redirect } from "next/navigation";
import { getActor } from "@/server/auth/session";
import { homePathFor } from "@/lib/rbac";

export default async function Home() {
  const actor = await getActor();
  redirect(actor ? homePathFor(actor.role) : "/login");
}

import { redirect } from "next/navigation";
import { getActor } from "@/server/auth/session";
import { homePathForActor } from "@/server/auth/home";

export default async function Home() {
  const actor = await getActor();
  redirect(actor ? await homePathForActor(actor) : "/login");
}

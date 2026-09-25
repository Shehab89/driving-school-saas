import { redirect } from "next/navigation";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { createSession, getActor } from "@/server/auth/session";
import { login } from "@/server/services/auth";
import { homePathFor } from "@/lib/rbac";
import { str } from "@/server/web";

async function loginAction(fd: FormData) {
  "use server";
  const school = str(fd, "school");
  const result = await login(str(fd, "email"), str(fd, "password"), school || undefined);
  if (!result.ok) {
    const msg = result.reason === "choose_school" ? "This e-mail is used at several schools. Please enter your school ID." : "Invalid e-mail or password.";
    redirect(`/login?error=${encodeURIComponent(msg)}${result.reason === "choose_school" ? "&school=1" : ""}`);
  }
  await createSession({ sub: result.userId, sid: result.schoolId, role: result.role, tv: result.tokenVersion });
  redirect(homePathFor(result.role));
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await sp(searchParams);
  const actor = await getActor();
  if (actor) redirect(homePathFor(actor.role));
  return (
    <main className="container narrow" style={{ paddingTop: 48 }}>
      <h1>Sign in</h1>
      <Flash searchParams={params} />
      <form action={loginAction} className="card">
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <div className="field">
          <label htmlFor="school">School ID <span className="muted small">(only if asked)</span></label>
          <input id="school" name="school" placeholder="e.g. abc-driving" autoFocus={params.school === "1"} />
        </div>
        <button className="primary block" type="submit">Sign in</button>
      </form>
    </main>
  );
}

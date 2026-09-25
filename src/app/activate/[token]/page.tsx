import { redirect } from "next/navigation";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { createSession } from "@/server/auth/session";
import { acceptInvite } from "@/server/services/auth";
import { homePathFor } from "@/lib/rbac";
import { AppError } from "@/lib/errors";
import { str } from "@/server/web";

export default async function ActivatePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: SearchParams }) {
  const { token } = await params;
  const q = await sp(searchParams);

  async function activate(fd: FormData) {
    "use server";
    const password = str(fd, "password");
    if (password !== str(fd, "confirm")) redirect(`/activate/${token}?error=${encodeURIComponent("Passwords do not match.")}`);
    let user;
    try {
      user = await acceptInvite(token, password);
    } catch (err) {
      redirect(`/activate/${token}?error=${encodeURIComponent(err instanceof AppError ? err.message : "Could not activate account.")}`);
    }
    await createSession({ sub: user.id, sid: user.school_id, role: user.role, tv: user.token_version });
    redirect(homePathFor(user.role));
  }

  return (
    <main className="container narrow" style={{ paddingTop: 48 }}>
      <h1>Set your password</h1>
      <Flash searchParams={q} />
      <form action={activate} className="card">
        <div className="field">
          <label htmlFor="password">New password (min. 10 characters)</label>
          <input id="password" name="password" type="password" minLength={10} autoComplete="new-password" required />
        </div>
        <div className="field">
          <label htmlFor="confirm">Repeat password</label>
          <input id="confirm" name="confirm" type="password" minLength={10} autoComplete="new-password" required />
        </div>
        <button className="primary block" type="submit">Activate account</button>
      </form>
    </main>
  );
}

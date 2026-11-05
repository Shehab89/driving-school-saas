import Link from "next/link";
import { notFound } from "next/navigation";
import { many, one, withTenant } from "@/lib/db";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { getPt } from "@/i18n/server";
import { CONVERSATION_STATUS } from "../status";
import { sendStaffReply, setConversationStatus } from "@/server/whatsapp/inbound";
import { runAction, str, idOr404 } from "@/server/web";
import { AppError } from "@/lib/errors";

async function reply(fd: FormData) {
  "use server";
  const pt = await getPt();
  const id = str(fd, "conversationId");
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    try {
      await sendStaffReply(actor.schoolId, id, actor.userId, str(fd, "body"));
    } catch (e) {
      throw new AppError((e as Error).message, 422, "whatsapp_send_failed");
    }
  }, { back: `/admin/whatsapp/${id}`, okMessage: pt("Sent") });
}

async function setStatus(fd: FormData) {
  "use server";
  const pt = await getPt();
  const id = str(fd, "conversationId");
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    await setConversationStatus(actor.schoolId, id, str(fd, "status") as "open", actor.userId);
  }, { back: `/admin/whatsapp/${id}`, okMessage: pt("Saved") });
}

export default async function Conversation({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const id = idOr404((await params).id);
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("whatsapp:inbox");
  const { f, pt } = await schoolI18n(actor.schoolId);
  const d = await withTenant(actor.schoolId, async (tx) => ({
    c: await one<{ id: string; wa_phone_e164: string; wa_profile_name: string | null; status: string; handoff_reason: string | null; student_id: string | null; student: string | null }>(
      tx,
      `SELECT c.*, s.first_name || ' ' || s.last_name AS student FROM whatsapp_conversations c LEFT JOIN students s ON s.id = c.student_id WHERE c.id = $1`,
      [id],
    ),
    msgs: await many<{ id: string; direction: string; sender: string; body: string | null; intent: string | null; created_at: Date; delivery_status: string | null; metadata: { tool_calls?: Array<{ name: string }> } }>(
      tx,
      `SELECT id, direction, sender, body, intent, created_at, delivery_status, metadata FROM whatsapp_messages WHERE conversation_id = $1 ORDER BY created_at LIMIT 500`,
      [id],
    ),
  }));
  if (!d.c) notFound();
  const c = d.c;
  const hidden = <input type="hidden" name="conversationId" value={c.id} />;
  const SENDER: Record<string, string> = { contact: pt("Contact"), ai_agent: pt("Assistant"), staff: pt("Staff"), system: pt("System") };
  return (
    <div className="narrow" style={{ maxWidth: 760 }}>
      <p><Link href="/admin/whatsapp"><span className="flip">←</span> {pt("WhatsApp")}</Link></p>
      <div className="page-title">
        <div>
          <h1>{c.student ?? c.wa_profile_name ?? c.wa_phone_e164}</h1>
          <p>
            <span dir="ltr">{c.wa_phone_e164}</span> {c.student_id && <>· <Link href={`/students/${c.student_id}`}>{pt("Student profile")}</Link></>}
            {c.handoff_reason && <> · {pt("Why a person is needed")}: {c.handoff_reason}</>}
          </p>
        </div>
        <Badge value={c.status} label={pt(CONVERSATION_STATUS[c.status] ?? c.status)} />
      </div>
      <Flash searchParams={q} />
      <div className="card chat">
        {d.msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === "inbound" ? "in" : "out"}`}>
            {m.body}
            <div className="meta">
              {SENDER[m.sender] ?? m.sender} · {f.dateTime(m.created_at)}
              {m.delivery_status && ` · ${m.delivery_status}`}
            </div>
          </div>
        ))}
      </div>
      <form action={reply} className="card">
        {hidden}
        <label htmlFor="body">{pt("Reply as the school")}</label>
        <textarea id="body" name="body" required maxLength={4000} />
        <button className="primary" style={{ marginTop: 8 }}>{pt("Send")}</button>
      </form>
      <div className="row">
        {c.status !== "open" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="open" /><button className="sm">{pt("Let the assistant answer again")}</button></form>}
        {c.status !== "handoff" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="handoff" /><button className="sm">{pt("I'll take over (pause the assistant)")}</button></form>}
        {c.status !== "closed" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="closed" /><button className="sm">{pt("Close conversation")}</button></form>}
      </div>
    </div>
  );
}

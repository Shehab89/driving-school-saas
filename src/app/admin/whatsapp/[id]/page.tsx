import Link from "next/link";
import { many, one, withTenant } from "@/lib/db";
import { formatDateTime } from "@/lib/time";
import { Badge, Flash, sp, type SearchParams } from "@/components/ui";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";
import { sendStaffReply, setConversationStatus } from "@/server/whatsapp/inbound";
import { runAction, str } from "@/server/web";
import { AppError } from "@/lib/errors";

async function reply(fd: FormData) {
  "use server";
  const id = str(fd, "conversationId");
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    try {
      await sendStaffReply(actor.schoolId, id, actor.userId, str(fd, "body"));
    } catch (e) {
      throw new AppError((e as Error).message, 422, "whatsapp_send_failed");
    }
  }, { back: `/admin/whatsapp/${id}`, okMessage: "Sent" });
}

async function setStatus(fd: FormData) {
  "use server";
  const id = str(fd, "conversationId");
  await runAction(async () => {
    const actor = await requireSchoolActor("whatsapp:inbox");
    await setConversationStatus(actor.schoolId, id, str(fd, "status") as "open", actor.userId);
  }, { back: `/admin/whatsapp/${id}` });
}

export default async function Conversation({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("whatsapp:inbox");
  const school = await schoolHeader(actor.schoolId);
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
  if (!d.c) return <p>Conversation not found.</p>;
  const c = d.c;
  const hidden = <input type="hidden" name="conversationId" value={c.id} />;
  return (
    <div className="narrow">
      <p><Link href="/admin/whatsapp">← Inbox</Link></p>
      <div className="spread">
        <h1>{c.student ?? c.wa_profile_name ?? c.wa_phone_e164}</h1>
        <Badge value={c.status} />
      </div>
      <p className="muted small">
        {c.wa_phone_e164} {c.student_id && <>· <Link href={`/students/${c.student_id}`}>student profile</Link></>}
        {c.handoff_reason && <> · handoff: {c.handoff_reason}</>}
      </p>
      <Flash searchParams={q} />
      <div className="card chat">
        {d.msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.direction === "inbound" ? "in" : "out"}`}>
            {m.body}
            <div className="meta">
              {m.sender.replace("_", " ")} · {formatDateTime(m.created_at, school.timezone)}
              {m.intent && ` · intent: ${m.intent}`}
              {m.metadata?.tool_calls?.length ? ` · tools: ${m.metadata.tool_calls.map((t) => t.name).join(", ")}` : ""}
              {m.delivery_status && ` · ${m.delivery_status}`}
            </div>
          </div>
        ))}
      </div>
      <form action={reply} className="card">
        {hidden}
        <label htmlFor="body">Reply as the school</label>
        <textarea id="body" name="body" required maxLength={4000} />
        <button className="primary" style={{ marginTop: 8 }}>Send</button>
      </form>
      <div className="row">
        {c.status !== "open" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="open" /><button>Hand back to AI assistant</button></form>}
        {c.status !== "handoff" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="handoff" /><button>Take over (pause AI)</button></form>}
        {c.status !== "closed" && <form action={setStatus}>{hidden}<input type="hidden" name="status" value="closed" /><button>Close</button></form>}
      </div>
    </div>
  );
}

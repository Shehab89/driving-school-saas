import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { Badge, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolI18n } from "@/server/school";
import { CONVERSATION_STATUS } from "./status";

export default async function Inbox({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("whatsapp:inbox");
  const { f, pt } = await schoolI18n(actor.schoolId);
  const rows = await withTenant(actor.schoolId, (tx) =>
    many<{ id: string; wa_phone_e164: string; wa_profile_name: string | null; status: string; student: string | null; last_message_at: Date | null; last_body: string | null }>(
      tx,
      `SELECT c.id, c.wa_phone_e164, c.wa_profile_name, c.status, s.first_name || ' ' || s.last_name AS student, c.last_message_at,
              (SELECT body FROM whatsapp_messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_body
         FROM whatsapp_conversations c LEFT JOIN students s ON s.id = c.student_id
        WHERE ($1 = '' OR c.status = $1)
        ORDER BY c.status = 'handoff' DESC, c.last_message_at DESC NULLS LAST LIMIT 200`,
      [q.status ?? ""],
    ),
  );
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("WhatsApp")}</h1>
          <p>{pt("The assistant answers students and new contacts. Conversations that need a person are shown first.")}</p>
        </div>
      </div>
      <div className="seg seg-scroll" style={{ marginBottom: 12 }}>
        {[["", pt("All")], ["handoff", pt("Needs a person")], ["open", pt("Assistant is answering")], ["closed", pt("Closed")]].map(([v, l]) => (
          <Link key={v} href={`/admin/whatsapp?status=${v}`} className={(q.status ?? "") === v ? "active" : ""}>{l}</Link>
        ))}
      </div>
      <div className="card">
        {rows.length === 0 && <p className="empty">{pt("No conversations yet.")}</p>}
        {rows.map((c) => (
          <Link key={c.id} href={`/admin/whatsapp/${c.id}`} className={`list-row conv ${c.status}`}>
            <span className="avatar" aria-hidden>{(c.student ?? c.wa_profile_name ?? "#").slice(0, 1).toUpperCase()}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="spread"><strong>{c.student ?? c.wa_profile_name ?? c.wa_phone_e164}</strong><span className="small muted">{c.last_message_at ? f.dateTime(c.last_message_at) : ""}</span></span>
              <span className="sub ellipsis">{(c.last_body ?? "").slice(0, 140)}</span>
            </span>
            <Badge value={c.status} label={pt(CONVERSATION_STATUS[c.status] ?? c.status)} />
          </Link>
        ))}
      </div>
    </>
  );
}

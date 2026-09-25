import Link from "next/link";
import { many, withTenant } from "@/lib/db";
import { formatDateTime } from "@/lib/time";
import { Badge, sp, type SearchParams } from "@/components/ui";
import { requireSchoolPage } from "@/server/auth/session";
import { schoolHeader } from "@/server/school";

export default async function Inbox({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("whatsapp:inbox");
  const school = await schoolHeader(actor.schoolId);
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
      <h1>WhatsApp</h1>
      <div className="seg" style={{ marginBottom: 12 }}>
        {[["", "All"], ["handoff", "Needs human"], ["open", "AI handling"], ["closed", "Closed"]].map(([v, l]) => (
          <Link key={v} href={`/admin/whatsapp?status=${v}`} className={(q.status ?? "") === v ? "active" : ""}>{l}</Link>
        ))}
      </div>
      <div className="card">
        {rows.length === 0 && <p className="muted">No conversations yet.</p>}
        {rows.map((c) => (
          <Link key={c.id} href={`/admin/whatsapp/${c.id}`} className="lesson" style={{ borderLeftColor: c.status === "handoff" ? "var(--warning)" : undefined }}>
            <div className="spread"><strong>{c.student ?? c.wa_profile_name ?? c.wa_phone_e164}</strong><Badge value={c.status} /></div>
            <div className="small muted">{c.wa_phone_e164} · {c.last_message_at ? formatDateTime(c.last_message_at, school.timezone) : ""}</div>
            <div className="small">{(c.last_body ?? "").slice(0, 120)}</div>
          </Link>
        ))}
      </div>
    </>
  );
}

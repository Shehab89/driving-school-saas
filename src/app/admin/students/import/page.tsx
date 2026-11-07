import Link from "next/link";
import { after } from "next/server";
import { withTenant } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { MAX_IMPORT_ROWS, type ImportField, type Mapping, IMPORT_FIELDS } from "@/lib/student-import";
import { Flash, sp, type SearchParams } from "@/components/ui";
import { ImportStudents, type ImportLabels } from "@/components/import-students";
import { getPt } from "@/i18n/server";
import { requireSchoolActor, requireSchoolPage } from "@/server/auth/session";
import { userPrincipal } from "@/server/principal";
import { schoolI18n } from "@/server/school";
import { importStudents, type ImportResult } from "@/server/services/student-import";
import { deliverNotifications } from "@/server/jobs";
import { bool, runAction, str } from "@/server/web";

async function importAction(fd: FormData) {
  "use server";
  const pt = await getPt();
  let r: ImportResult | null = null;
  await runAction(async () => {
    const actor = await requireSchoolActor("students:write");
    let payload: { table?: unknown; mapping?: unknown; hasHeader?: unknown };
    try { payload = JSON.parse(str(fd, "payload")); } catch { throw new ValidationError(pt("Paste or choose a list first.")); }
    const table = Array.isArray(payload.table) ? (payload.table as unknown[]).slice(0, MAX_IMPORT_ROWS + 1).map((row) => (Array.isArray(row) ? row.slice(0, 30).map((c) => String(c ?? "").slice(0, 500)) : [])) : [];
    const mapping = (Array.isArray(payload.mapping) ? payload.mapping : []).slice(0, 30).map((m) => ((IMPORT_FIELDS as readonly string[]).includes(String(m)) ? m : "")) as Mapping;
    r = await withTenant(actor.schoolId, (tx) => importStudents(tx, userPrincipal(actor), { table, mapping, hasHeader: payload.hasHeader === true, sendInvites: bool(fd, "sendInvites") }));
    after(() => deliverNotifications(50).catch(() => undefined));
  }, {
    back: "/admin/students/import",
    success: "/admin/students",
    okMessage: () => {
      const x = r!;
      return [
        pt("{count} students imported", { count: x.created }),
        x.skippedExisting ? pt("{count} were already in DriveDesk", { count: x.skippedExisting }) : "",
        x.invalid.length ? pt("{count} rows skipped (check name, e-mail or date)", { count: x.invalid.length }) : "",
        x.creditsAdded ? pt("{count} lesson credits carried over", { count: x.creditsAdded }) : "",
      ].filter(Boolean).join(" · ");
    },
  });
}

export default async function ImportPage({ searchParams }: { searchParams: SearchParams }) {
  const q = await sp(searchParams);
  const actor = await requireSchoolPage("students:write");
  const { pt } = await schoolI18n(actor.schoolId);
  const field: Record<ImportField, string> = {
    firstName: pt("First name"), lastName: pt("Last name"), fullName: pt("Full name"), email: pt("E-mail"), phone: pt("Phone"),
    dateOfBirth: pt("Date of birth"), credits: pt("Lessons left"), notes: pt("Notes"),
  };
  const labels: ImportLabels = {
    paste: pt("Paste your list"),
    pasteHint: pt("In Excel or Google Sheets: select the rows (with the title row), copy, and paste here. A CSV file works too."),
    file: pt("Or choose a CSV file"),
    columns: pt("Check the columns"),
    ignore: pt("(skip this column)"),
    firstRow: pt("The first row holds the column titles"),
    preview: pt("Preview"),
    ready: pt("{count} students ready to import"),
    problems: pt("{count} rows will be skipped"),
    invites: pt("Send each student an e-mail to start using the app"),
    invitesHint: pt("Leave this off to tell students yourself first. You can send the invitation later from the student's page."),
    submit: pt("Import {count} students"),
    line: pt("Row {line}"),
    field,
    error: {
      name_missing: pt("no name"),
      email_invalid: pt("e-mail address looks wrong"),
      date_invalid: pt("date of birth not understood (use 31-12-2006)"),
      credits_invalid: pt("lessons left must be a whole number"),
    },
  };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>{pt("Import students")}</h1>
          <p>{pt("Move your students from Excel, another app or a paper list in a few minutes. Students already in DriveDesk (same e-mail) are skipped, so you can run it again safely.")}</p>
        </div>
        <div className="actions"><Link className="btn" href="/admin/students">{pt("Students")}</Link></div>
      </div>
      <Flash searchParams={q} />
      <section className="card">
        <ImportStudents action={importAction} labels={labels} />
      </section>
      <section className="card small muted">
        <p>{pt("Columns we recognise: first name, last name (or one name column), e-mail, phone, date of birth, lessons left, notes. Dutch and English titles both work (Voornaam, Achternaam, Telefoon, Geboortedatum, Tegoed).")}</p>
        <p>{pt("“Lessons left” becomes lesson credit, so a student who prepaid at your old system keeps those lessons.")}</p>
      </section>
    </>
  );
}

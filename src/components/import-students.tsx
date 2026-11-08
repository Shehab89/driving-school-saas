"use client";
import { useMemo, useState } from "react";
import { buildRows, guessMapping, IMPORT_FIELDS, looksLikeHeader, MAX_IMPORT_ROWS, parseTable, type ImportField, type Mapping } from "@/lib/student-import";

export type ImportLabels = {
  paste: string; pasteHint: string; file: string; columns: string; ignore: string; firstRow: string; preview: string;
  ready: string; problems: string; invites: string; invitesHint: string; submit: string; field: Record<ImportField, string>; error: Record<string, string>; line: string;
};

/**
 * Paste from Excel or pick a CSV file, check the guessed columns, see a
 * preview, import. Parsing runs here for the preview; the server parses the
 * same table again and never trusts what this page computed.
 */
export function ImportStudents({ action, labels: L }: { action: (fd: FormData) => Promise<void>; labels: ImportLabels }) {
  const [text, setText] = useState("");
  const table = useMemo(() => (text.trim() ? parseTable(text) : []), [text]);
  const width = Math.max(0, ...table.map((r) => r.length));
  const [hasHeader, setHasHeader] = useState<boolean | null>(null);
  const header = hasHeader ?? (table[0] ? looksLikeHeader(table[0]) : true);
  const [override, setOverride] = useState<Mapping | null>(null);
  const guessed = useMemo(() => (header && table[0] ? guessMapping(table[0]) : Array.from({ length: width }, (_, i) => (["fullName", "email", "phone"] as const)[i] ?? "")), [table, header, width]);
  const mapping: Mapping = Array.from({ length: width }, (_, i) => (override?.[i] ?? guessed[i] ?? "") as ImportField | "");
  const rows = useMemo(() => buildRows(table, mapping, header), [table, mapping, header]);
  const ok = rows.filter((r) => !r.error);
  const bad = rows.filter((r) => r.error);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setOverride(null); setHasHeader(null);
    setText(await f.text());
  };

  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="import-text">{L.paste}</label>
        <textarea id="import-text" rows={7} value={text} onChange={(e) => { setText(e.target.value); setOverride(null); setHasHeader(null); }} placeholder={"Voornaam\tAchternaam\tE-mail\tTelefoon\nSanne\tde Vries\tsanne@example.nl\t0612345678"} dir="ltr" style={{ fontFamily: "ui-monospace, monospace", fontSize: ".85rem" }} />
        <p className="small muted" style={{ margin: "4px 0 0" }}>{L.pasteHint}</p>
      </div>
      <div className="field">
        <label htmlFor="import-file">{L.file}</label>
        <input id="import-file" type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      {table.length > 0 && (
        <>
          <h3>{L.columns}</h3>
          <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={header} onChange={(e) => setHasHeader(e.target.checked)} /> {L.firstRow}</label>
          <div className="table-wrap">
            <table className="import-preview">
              <thead>
                <tr>
                  {mapping.map((m, i) => (
                    <th key={i}>
                      <select aria-label={`${L.columns} ${i + 1}`} value={m} onChange={(e) => { const next = [...mapping]; next[i] = e.target.value as ImportField | ""; setOverride(next); }}>
                        <option value="">{L.ignore}</option>
                        {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{L.field[f]}</option>)}
                      </select>
                      {header && <div className="small muted">{table[0]?.[i]}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(header ? table.slice(1) : table).slice(0, 5).map((r, i) => <tr key={i}>{Array.from({ length: width }, (_, j) => <td key={j} className="small">{r[j] ?? ""}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 10 }}><strong>{L.ready.replace("{count}", String(ok.length))}</strong>{rows.length >= MAX_IMPORT_ROWS && " (max " + MAX_IMPORT_ROWS + ")"}</p>
          {bad.length > 0 && (
            <details className="small">
              <summary>{L.problems.replace("{count}", String(bad.length))}</summary>
              <ul>{bad.slice(0, 20).map((r) => <li key={r.line}>{L.line.replace("{line}", String(r.line))}: {L.error[r.error!]}</li>)}</ul>
            </details>
          )}
          <label className="check" style={{ margin: "10px 0" }}><input type="checkbox" name="sendInvites" /> {L.invites}</label>
          <p className="small muted" style={{ marginTop: -6 }}>{L.invitesHint}</p>
          <input type="hidden" name="payload" value={JSON.stringify({ table, mapping, hasHeader: header })} />
          <button className="primary" type="submit" disabled={ok.length === 0}>{L.submit.replace("{count}", String(ok.length))}</button>
        </>
      )}
    </form>
  );
}

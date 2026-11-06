"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PortalIcon } from "./portal-nav";

export interface Command {
  href: string;
  label: string;
  group: string;
  icon: string;
}

/** Lower-case and strip accents so "eleve" finds "élève". */
const norm = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Quick jump (Ctrl/⌘ K or "/"): type a few letters to open any screen or start
 * a task, and "search students for …" for names. Keyboard first, but the
 * search button in the sidebar and top bar opens it too.
 */
export function CommandPalette({
  commands,
  labels,
}: {
  commands: Command[];
  labels: { open: string; placeholder: string; empty: string; searchStudents: string; studentsGroup: string; hint: string };
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const results = useMemo(() => {
    const n = norm(q.trim());
    const hits = n ? commands.filter((c) => norm(c.label).includes(n) || norm(c.group).includes(n)) : commands;
    const extra: Command[] = n ? [{ href: `/admin/students?q=${encodeURIComponent(q.trim())}`, label: labels.searchStudents.replace("{query}", q.trim()), group: labels.studentsGroup, icon: "students" }] : [];
    return [...hits, ...extra];
  }, [q, commands, labels]);

  const open = useCallback(() => {
    setQ("");
    setSel(0);
    ref.current?.showModal();
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        if (ref.current?.open) ref.current.close();
        else open();
      }
    };
    const onOpen = () => open();
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, [open]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    ref.current?.close();
    router.push(c.href);
  };

  let lastGroup = "";
  return (
    <dialog ref={ref} className="cmdk" aria-label={labels.open} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <div className="cmdk-box">
        <div className="cmdk-input">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4" /></svg>
          <input
            ref={input}
            value={q}
            placeholder={labels.placeholder}
            aria-label={labels.placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[sel] ? `cmdk-${sel}` : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); go(results[sel]); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="cmdk-list" role="listbox" className="cmdk-list">
          {results.length === 0 && <li className="cmdk-empty">{labels.empty}</li>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.href + c.label} role="presentation">
                {head && <div className="cmdk-group">{head}</div>}
                <button
                  type="button"
                  id={`cmdk-${i}`}
                  role="option"
                  aria-selected={i === sel}
                  className="cmdk-item"
                  onMouseMove={() => setSel(i)}
                  onClick={() => go(c)}
                >
                  <PortalIcon name={c.icon} />
                  <span>{c.label}</span>
                  <span className="flip cmdk-go" aria-hidden="true">↵</span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="cmdk-hint">{labels.hint}</p>
      </div>
    </dialog>
  );
}

/** Button that opens the palette (sidebar and phone top bar). */
export function CommandButton({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <button type="button" className={compact ? "sm cmdk-btn compact" : "cmdk-btn"} aria-label={label} aria-keyshortcuts="Control+K Meta+K" onClick={() => window.dispatchEvent(new Event("open-command-palette"))}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4-4" /></svg>
      {!compact && <><span>{label}</span><kbd>Ctrl K</kbd></>}
    </button>
  );
}

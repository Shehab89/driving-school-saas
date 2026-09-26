"use client";
import { useRef, useState } from "react";

/** Textarea with tap-to-add suggestion chips. */
export function PhraseField({
  id,
  name,
  label,
  defaultValue,
  phrases,
  hint,
  tone,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
  phrases: string[];
  hint: string;
  tone: "good" | "improve" | "practice" | "focus";
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const add = (p: string) => {
    const el = ref.current;
    if (!el) return;
    el.value = el.value.trim() ? `${el.value.trim()} ${p}` : p;
    el.focus();
  };
  return (
    <div className={`fb-item ${tone === "good" ? "good" : tone === "improve" ? "improve" : tone === "focus" ? "focus" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <textarea ref={ref} id={id} name={name} defaultValue={defaultValue} rows={3} style={{ background: "var(--surface)" }} />
      {phrases.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }} aria-label={hint}>
          {phrases.map((p) => (
            <button key={p} type="button" className="chip" onClick={() => add(p)} title={hint}>
              <span aria-hidden="true">+</span>
              <span className="txt">{p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const CYCLE = ["", "in_progress", "needs_improvement", "completed"] as const;

/** Skill chips: tap to cycle not changed → in progress → needs improvement → completed. */
export function SkillChips({
  skills,
  labels,
}: {
  skills: Array<{ id: string; name: string; status: string | null }>;
  labels: Record<string, string>;
}) {
  const [state, setState] = useState<Record<string, string>>({});
  return (
    <div className="chips">
      {skills.map((s) => {
        const chosen = state[s.id] ?? "";
        const shown = chosen || s.status || "not_started";
        const tone = shown === "completed" ? "success" : shown === "needs_improvement" ? "warning" : shown === "in_progress" ? "info" : "";
        return (
          <button
            key={s.id}
            type="button"
            className="chip"
            aria-pressed={Boolean(chosen)}
            onClick={() => setState((st) => ({ ...st, [s.id]: CYCLE[(CYCLE.indexOf((st[s.id] ?? "") as (typeof CYCLE)[number]) + 1) % CYCLE.length]! }))}
          >
            <span className={`badge ${tone}`} style={{ padding: "0 6px" }}>{labels[shown]}</span> {s.name}
            {chosen && <input type="hidden" name={`skill_${s.id}`} value={chosen} />}
          </button>
        );
      })}
    </div>
  );
}

"use client";
import { useState } from "react";

export interface PickerTopic { id: string; name: string; level_position: number; level_name: string }

/**
 * Multi-select dropdown for lesson topics. Submits one `name` value per chosen
 * topic (read with formData.getAll(name)). Topics are grouped by level.
 */
export function TopicPicker({
  name,
  topics,
  defaultSelected = [],
  label,
  placeholder,
  id,
}: {
  name: string;
  topics: PickerTopic[];
  defaultSelected?: string[];
  label: string;
  placeholder: string;
  id?: string;
}) {
  const [chosen, setChosen] = useState<string[]>(defaultSelected.filter((x) => topics.some((t) => t.id === x)));
  const toggle = (tid: string) => setChosen((c) => (c.includes(tid) ? c.filter((x) => x !== tid) : [...c, tid]));
  const levels = [...new Map(topics.map((t) => [t.level_position, t.level_name])).entries()];
  const names = topics.filter((t) => chosen.includes(t.id));
  const pid = id ?? `tp-${name}`;
  return (
    <details className="ms" id={pid}>
      <summary aria-label={label}>
        {names.length ? names.map((t) => <span key={t.id} className="tag">{t.name}</span>) : <span className="ph">{placeholder}</span>}
      </summary>
      <div className="ms-panel" role="group" aria-label={label}>
        {levels.map(([pos, lname]) => (
          <fieldset key={pos}>
            <legend>{lname}</legend>
            {topics.filter((t) => t.level_position === pos).map((t) => (
              <label key={t.id}>
                <input type="checkbox" name={name} value={t.id} checked={chosen.includes(t.id)} onChange={() => toggle(t.id)} /> {t.name}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </details>
  );
}

/** Read-only list of topic names as small tags. */
export function TopicTags({ topics }: { topics: Array<{ id: string; name: string }> }) {
  if (!topics.length) return null;
  return <span className="tags">{topics.map((t) => <span key={t.id} className="tag">{t.name}</span>)}</span>;
}

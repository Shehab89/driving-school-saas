"use client";
/**
 * A day (the shared date picker pop-up) plus a time, posted together as one
 * "YYYY-MM-DDTHH:mm" value, the same shape a datetime-local input sends.
 * Used wherever a form needs a moment in time, so no native date box remains.
 */
import { useState } from "react";
import { TimeSelect } from "./time-select";

import { DateField } from "./date-field";
import type { DateFieldLabels } from "./date-field-labels";

export function DateTimeField({ id, name, locale, labels, timeLabel, required, min, defaultValue = "" }: {
  id: string; name: string; locale: string; labels: DateFieldLabels; timeLabel: string; required?: boolean; min?: string;
  /** "YYYY-MM-DDTHH:mm" (school time) to start with. */
  defaultValue?: string;
}) {
  const [day, setDay] = useState(defaultValue.slice(0, 10));
  const [time, setTime] = useState(defaultValue.slice(11, 16));
  return (
    <div className="dt-field">
      <DateField id={id} value={day} onChange={setDay} locale={locale} labels={labels} min={min} />
      <TimeSelect aria-label={timeLabel} value={time} onChange={(e) => setTime(e.target.value)} required={required} emptyLabel={required ? undefined : "—"} />
      <input type="hidden" name={name} value={day && time ? `${day}T${time}` : ""} />
    </div>
  );
}

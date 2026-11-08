/**
 * A time of day as a plain list (07:00, 07:15, …). Used instead of the browser's
 * time box, which shows AM/PM on some phones and gets cut off in narrow rows.
 * Posts "HH:mm" like <input type="time">; the empty choice posts "".
 */
export function timeOptions(step = 15, from = 5, to = 23) {
  const out: string[] = [];
  for (let m = from * 60; m <= to * 60 + 59; m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

type Props = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  /** Text of the empty choice; leave out to make a time required. */
  emptyLabel?: string;
  step?: number;
};

export function TimeSelect({ emptyLabel, step = 15, defaultValue, value, ...rest }: Props) {
  const opts = timeOptions(step);
  const current = String(value ?? defaultValue ?? "").slice(0, 5);
  // Keep a saved time that is not on the list (e.g. 08:10) selectable.
  if (current && !opts.includes(current)) { opts.push(current); opts.sort(); }
  const v = value !== undefined ? { value: current } : { defaultValue: current };
  return (
    <select className="time-select" dir="ltr" {...v} {...rest}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

/** Half-open millisecond intervals [start, end) and set operations on sorted lists of them. */
export interface Interval {
  start: number;
  end: number;
}

export function normalize(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const A = normalize(a);
  const B = normalize(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i]!.start, B[j]!.start);
    const e = Math.min(A[i]!.end, B[j]!.end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i]!.end < B[j]!.end) i++;
    else j++;
  }
  return out;
}

export function subtract(from: Interval[], remove: Interval[]): Interval[] {
  let result = normalize(from);
  for (const r of normalize(remove)) {
    const next: Interval[] = [];
    for (const f of result) {
      if (r.end <= f.start || r.start >= f.end) {
        next.push(f);
        continue;
      }
      if (r.start > f.start) next.push({ start: f.start, end: r.start });
      if (r.end < f.end) next.push({ start: r.end, end: f.end });
    }
    result = next;
  }
  return result;
}

export function overlapsAny(list: Interval[], start: number, end: number): boolean {
  return list.some((i) => i.start < end && start < i.end);
}

export function expand(list: Interval[], byMs: number): Interval[] {
  return byMs === 0 ? list : list.map((i) => ({ start: i.start - byMs, end: i.end + byMs }));
}

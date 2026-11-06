"use client";
/** A select that submits its form as soon as the choice changes (filters without a "Show" button). */
import type { SelectHTMLAttributes } from "react";

export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}

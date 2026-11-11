"use client";
import { useState } from "react";

/** Copies a text to the clipboard; the label briefly changes to confirm. */
export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 2000);
        } catch {
          // Clipboard blocked: the link is still in the text box to copy by hand.
        }
      }}
    >
      {ok ? done : label}
    </button>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions/locale";

const OPTIONS = [
  { code: "en", label: "EN", name: "English" },
  { code: "nl", label: "NL", name: "Nederlands" },
  { code: "ar", label: "ع", name: "العربية" },
] as const;

export function LanguageSwitcher({ current, label }: { current: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      {OPTIONS.map((o) => (
        <button
          key={o.code}
          type="button"
          lang={o.code}
          title={o.name}
          aria-label={o.name}
          aria-pressed={o.code === current}
          disabled={pending}
          onClick={() =>
            start(async () => {
              await setLocaleAction(o.code);
              router.refresh();
            })
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

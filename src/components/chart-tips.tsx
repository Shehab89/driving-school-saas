"use client";
/** One tooltip for every chart mark: anything with [data-tip] shows it on hover, tap or focus. */
import { useEffect, useRef } from "react";

export function ChartTips() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = ref.current!;
    let current: Element | null = null;
    const show = (el: Element) => {
      current = el;
      tip.textContent = el.getAttribute("data-tip");
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
      tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    const hide = () => {
      current = null;
      tip.hidden = true;
    };
    const find = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-tip]") : null);
    const over = (e: Event) => {
      const el = find(e);
      if (el) show(el);
      else if (current) hide();
    };
    const out = (e: PointerEvent | FocusEvent) => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-tip]") : null;
      if (!to) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", over);
    document.addEventListener("focusout", out);
    window.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", over);
      document.removeEventListener("focusout", out);
      window.removeEventListener("scroll", hide);
    };
  }, []);
  return <div ref={ref} className="ch-tip" role="tooltip" hidden />;
}

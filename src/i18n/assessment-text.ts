import { ptKey, type PortalTranslate } from "./portal";

/** The WhatsApp assistant's level suggestion, in the reader's language. */
const BANDS: Record<string, string> = {
  beginner: ptKey("Beginner"),
  basic: ptKey("Basic"),
  intermediate: ptKey("Intermediate"),
  advanced: ptKey("Advanced"),
};
export const bandLabel = (band: string, pt: PortalTranslate) => (BANDS[band] ? pt(BANDS[band]!) : band);

const SENTENCES: string[] = [
  ptKey("No previous driving experience."),
  ptKey("Low comfort in traffic."),
  ptKey("Has not yet learned to drive a manual car."),
  ptKey("Some answers look inconsistent; an instructor should check."),
];

/** The stored reasons are English sentences (see assessment-scoring.ts); show them translated. */
export function rationaleText(text: string | null, pt: PortalTranslate) {
  if (!text) return "";
  return text
    .split(/(?<=\.)\s+/)
    .map((s) => {
      const score = /^Experience score (-?\d+)\.$/.exec(s);
      if (score) return pt("Experience score {points}.", { points: score[1]! });
      return SENTENCES.includes(s) ? pt(s) : s;
    })
    .join(" ");
}

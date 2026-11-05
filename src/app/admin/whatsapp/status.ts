import { ptKey } from "@/i18n/portal";

/** Labels for WhatsApp conversation states (translated with pt). */
export const CONVERSATION_STATUS: Record<string, string> = {
  open: ptKey("Assistant is answering"),
  handoff: ptKey("Needs a person"),
  closed: ptKey("Closed"),
};

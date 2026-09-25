import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWebhook, verifyMetaSignature } from "@/server/whatsapp/webhook";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "31600000000", phone_number_id: "PNID1" },
            contacts: [{ profile: { name: "Anna" }, wa_id: "31612345678" }],
            messages: [{ from: "31612345678", id: "wamid.1", timestamp: "1726000000", type: "text", text: { body: "Hi" } }],
            statuses: [{ id: "wamid.out", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

describe("WhatsApp webhook", () => {
  it("verifies the X-Hub-Signature-256 header", () => {
    const body = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyMetaSignature("secret", body, sig)).toBe(true);
    expect(verifyMetaSignature("other", body, sig)).toBe(false);
    expect(verifyMetaSignature("secret", body + " ", sig)).toBe(false);
    expect(verifyMetaSignature("secret", body, null)).toBe(false);
    expect(verifyMetaSignature("secret", body, "sha256=zz")).toBe(false);
  });

  it("parses messages and statuses", () => {
    const { messages, statuses } = parseWebhook(payload);
    expect(messages).toEqual([
      { phoneNumberId: "PNID1", from: "+31612345678", waMessageId: "wamid.1", timestamp: new Date(1726000000 * 1000), type: "text", text: "Hi", profileName: "Anna" },
    ]);
    expect(statuses).toEqual([{ phoneNumberId: "PNID1", waMessageId: "wamid.out", status: "delivered" }]);
  });

  it("ignores other objects", () => {
    expect(parseWebhook({ object: "page" }).messages).toEqual([]);
  });
});

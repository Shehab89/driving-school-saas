import { describe, expect, it } from "vitest";
import { redact } from "@/lib/log";

describe("log redaction", () => {
  it("masks e-mails, phone numbers, API keys and secret fields", () => {
    const out = redact({
      msg: "sent to anna.jansen@example.com and +31 6 1234 5678 using sk_live_abcdefghijklmnop",
      nested: { password: "hunter2hunter2", reset_url: "https://x/reset/abc", ok: 3 },
    }) as Record<string, unknown>;
    expect(out.msg).toBe("sent to a***@example.com and +31***78 using sk_***");
    expect(out.nested).toEqual({ password: "[redacted]", reset_url: "[redacted]", ok: 3 });
  });

  it("keeps error messages but redacts their content", () => {
    const out = redact(new Error("no user bob@example.com")) as { message: string };
    expect(out.message).toBe("no user b***@example.com");
  });
});

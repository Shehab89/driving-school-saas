import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePools, many, one, withPlatform, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { setAgentLlm, type AgentLlm } from "@/server/agent/runner";
import { ConsoleEmailProvider, setEmailProvider } from "@/server/email/provider";
import { renderEmail } from "@/server/email/templates";
import { handleResendEvent, verifySvixSignature, WebhookSignatureError } from "@/server/email/webhook";
import { deliverNotifications, scheduleLessonReminders } from "@/server/jobs";
import { bookLesson } from "@/server/services/lessons";
import { enqueueNotification } from "@/server/services/notifications";
import { setWhatsAppConsent, updateStudentPrefs, updateUserPrefs } from "@/server/services/notification-prefs";
import { saveTemplateOverride, saveWhatsAppTemplates } from "@/server/services/notification-settings";
import { RecordingSender, setWhatsAppSender } from "@/server/whatsapp/client";
import { ingestWebhook, optKeyword, processConversation } from "@/server/whatsapp/inbound";
import { asUser, createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

let f: Fixture;
const sender = new RecordingSender();
const PHONE_ID = `pnid-n-${Date.now()}`;
const phone = `+3161${String(Date.now()).slice(-7)}`;
let wamid = 0;
const student = () => asUser(f.studentActor);

async function drain() {
  setEmailProvider(new ConsoleEmailProvider());
  while ((await deliverNotifications()).claimed > 0);
}

async function inbound(body: string) {
  const convs = await ingestWebhook(
    [{ phoneNumberId: PHONE_ID, from: phone.slice(1), waMessageId: `wamid.n.${++wamid}.${Date.now()}`, timestamp: new Date(), type: "text", text: body, profileName: "S" }],
    [],
  );
  await processConversation(convs[0]!.schoolId, convs[0]!.conversationId);
}

beforeAll(async () => {
  f = await createFixture();
  setWhatsAppSender(sender);
  await withPlatform((tx) => tx.query(`UPDATE students SET phone = $2, phone_e164 = $2 WHERE id = $1`, [f.studentId, phone]));
  await withTenant(f.schoolId, (tx) =>
    tx.query(`INSERT INTO whatsapp_accounts (school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted) VALUES ($1,$2,'waba','+31000000001',$3)`, [
      f.schoolId,
      PHONE_ID,
      encryptSecret("test-token"),
    ]),
  );
  await drain();
});
afterAll(closePools);

const rowsFor = (lessonId: string) =>
  withPlatform((tx) => many<{ channel: string; status: string; type: string }>(tx, `SELECT channel, status, type FROM notifications WHERE lesson_id = $1 ORDER BY channel`, [lessonId]));

describe("student preferences", () => {
  it("a student who switched reminders off gets none, and the lesson is not re-checked every tick", async () => {
    await withTenant(f.schoolId, (tx) => updateStudentPrefs(tx, student(), f.studentId, { reminders: { email: false, whatsapp: false }, lesson_updates: { email: true, whatsapp: false } }));
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 5, 9), bookedVia: "staff" }));
    const soon = new Date(Date.now() + 2 * 3600_000);
    await setLessonTime(f, lesson.id, soon, new Date(soon.getTime() + 3600_000));
    await scheduleLessonReminders();
    expect((await rowsFor(lesson.id)).filter((r) => r.type === "lesson_reminder")).toEqual([]);
    const handled = await withPlatform((tx) => one<{ reminder_handled_at: Date | null }>(tx, `SELECT reminder_handled_at FROM lessons WHERE id = $1`, [lesson.id]));
    expect(handled!.reminder_handled_at).not.toBeNull();
  });

  it("students cannot change another student's preferences", async () => {
    await expect(withTenant(f.schoolId, (tx) => updateStudentPrefs(tx, f.owner, f.studentId, {}))).rejects.toThrow(/not allowed/i);
  });

  it("WhatsApp without consent or template falls back to e-mail", async () => {
    await withTenant(f.schoolId, (tx) => updateStudentPrefs(tx, student(), f.studentId, { reminders: { email: false, whatsapp: true }, lesson_updates: { email: false, whatsapp: true } }));
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 6, 9), bookedVia: "staff" }));
    expect((await rowsFor(lesson.id)).map((r) => `${r.type}:${r.channel}`)).toEqual(["lesson_booked:email"]);
  });

  it("staff cannot give WhatsApp consent on a student's behalf", async () => {
    await expect(withTenant(f.schoolId, (tx) => setWhatsAppConsent(tx, f.owner, f.studentId, true, "app"))).rejects.toThrow(/Only the student/);
  });

  it("with consent and an approved template, lesson updates go out on WhatsApp", async () => {
    await withTenant(f.schoolId, async (tx) => {
      await setWhatsAppConsent(tx, student(), f.studentId, true, "app");
      await saveWhatsAppTemplates(tx, f.owner, { lesson_booked: { name: "lesson_booked_v1", language: "nl" }, lesson_reminder: { name: "", language: "nl" } });
    });
    await drain();
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 7, 9), bookedVia: "staff" }));
    expect((await rowsFor(lesson.id)).map((r) => `${r.type}:${r.channel}`)).toEqual(["lesson_booked:whatsapp"]);
    await deliverNotifications();
    const t = sender.templates.at(-1)!;
    expect(t).toMatchObject({ to: phone, name: "lesson_booked_v1", language: "nl" });
    expect(t.params).toHaveLength(4);
    expect((await rowsFor(lesson.id))[0]!.status).toBe("sent");
  });

  it("consent withdrawn after queueing: the message is suppressed at send time", async () => {
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 8, 9), bookedVia: "staff" }));
    await withTenant(f.schoolId, (tx) => setWhatsAppConsent(tx, student(), f.studentId, false, "app"));
    const before = sender.templates.length;
    await deliverNotifications();
    expect(sender.templates.length).toBe(before);
    expect((await rowsFor(lesson.id)).map((r) => r.status)).toEqual(["suppressed"]);
  });
});

describe("WhatsApp STOP / START", () => {
  it("recognises keywords only as whole messages", () => {
    expect(optKeyword(" stop ")).toBe("opt_out");
    expect(optKeyword("STOPPEN!")).toBe("opt_out");
    expect(optKeyword("start")).toBe("opt_in");
    expect(optKeyword("please stop the lesson")).toBeNull();
  });

  it("STOP records the opt-out and confirms; START restores consent", async () => {
    await inbound("STOP");
    let s = await withPlatform((tx) => one<{ whatsapp_opt_out_at: Date | null; whatsapp_opt_in_at: Date | null }>(tx, `SELECT whatsapp_opt_in_at, whatsapp_opt_out_at FROM students WHERE id = $1`, [f.studentId]));
    expect(s!.whatsapp_opt_out_at).not.toBeNull();
    expect(sender.sent.at(-1)!.body).toMatch(/no longer get lesson messages/);
    const conv = await withPlatform((tx) => one<{ opted_out_at: Date | null }>(tx, `SELECT opted_out_at FROM whatsapp_conversations WHERE wa_phone_e164 = $1`, [phone]));
    expect(conv!.opted_out_at).not.toBeNull();

    await inbound("START");
    s = await withPlatform((tx) => one(tx, `SELECT whatsapp_opt_in_at, whatsapp_opt_out_at FROM students WHERE id = $1`, [f.studentId]));
    expect(s!.whatsapp_opt_in_at! > s!.whatsapp_opt_out_at!).toBe(true);
    const audit = await withTenant(f.schoolId, (tx) => many<{ action: string }>(tx, `SELECT action FROM audit_logs WHERE action LIKE 'whatsapp.consent_%' AND changes->>'source' = 'keyword'`));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["whatsapp.consent_withdrawn", "whatsapp.consent_given"]));
  });
});

describe("AI fallback", () => {
  it("when the model fails, the student gets real lesson data and the chat is handed to a person", async () => {
    const failing: AgentLlm = { create: async () => { throw new Error("529 overloaded"); } };
    setAgentLlm(failing);
    const before = await withPlatform((tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM lessons WHERE student_id = $1`, [f.studentId]));
    await inbound("When is my next lesson?");
    const reply = sender.sent.at(-1)!.body;
    expect(reply).toMatch(/not available right now/);
    expect(reply).toMatch(/Your next lessons:/);
    const conv = await withPlatform((tx) => one<{ status: string; handoff_reason: string }>(tx, `SELECT status, handoff_reason FROM whatsapp_conversations WHERE wa_phone_e164 = $1`, [phone]));
    expect(conv).toMatchObject({ status: "handoff", handoff_reason: "AI assistant unavailable" });
    // Nothing was booked or changed.
    const after = await withPlatform((tx) => one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM lessons WHERE student_id = $1`, [f.studentId]));
    expect(after!.n).toBe(before!.n);
    const msg = await withPlatform((tx) => one<{ metadata: { fallback: boolean } }>(tx, `SELECT metadata FROM whatsapp_messages WHERE body = 'When is my next lesson?' ORDER BY created_at DESC LIMIT 1`));
    expect(msg!.metadata.fallback).toBe(true);
  });
});

describe("e-mail delivery tracking", () => {
  const secret = `whsec_${Buffer.from("test-secret-key-0123456789").toString("base64")}`;
  const sign = (body: string, id = "msg_1", ts = Math.floor(Date.now() / 1000)) => {
    const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
    return new Headers({ "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` });
  };

  it("verifies Svix signatures and rejects tampering or replays", () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "x" } });
    expect(() => verifySvixSignature(body, sign(body), secret)).not.toThrow();
    expect(() => verifySvixSignature(body + " ", sign(body), secret)).toThrow(WebhookSignatureError);
    expect(() => verifySvixSignature(body, sign(body, "msg_1", Math.floor(Date.now() / 1000) - 3600), secret)).toThrow(/tolerance/);
  });

  it("a hard bounce suppresses the address for later e-mails", async () => {
    const addr = `bounce-${Date.now()}@example.com`;
    const send = () =>
      withTenant(f.schoolId, (tx) => enqueueNotification(tx, { schoolId: f.schoolId, type: "payment_succeeded", to: addr, payload: { amount_cents: 100, currency: "EUR" } }));
    const first = (await send())!;
    await deliverNotifications();
    const sent = (await withPlatform((tx) => one<{ provider_message_id: string }>(tx, `SELECT provider_message_id FROM notifications WHERE id = $1`, [first])))!;
    await withPlatform((tx) => tx.query(`UPDATE notifications SET provider = 'resend' WHERE id = $1`, [first]));
    expect(await handleResendEvent({ type: "email.bounced", data: { email_id: sent.provider_message_id, bounce: { type: "Permanent" } } })).toEqual({ applied: true });
    // A late "delayed" event does not overwrite the final state.
    await handleResendEvent({ type: "email.delivery_delayed", data: { email_id: sent.provider_message_id } });
    const row = await withPlatform((tx) => one<{ delivery_status: string }>(tx, `SELECT delivery_status FROM notifications WHERE id = $1`, [first]));
    expect(row!.delivery_status).toBe("bounced");

    const second = (await send())!;
    await deliverNotifications();
    const r2 = await withPlatform((tx) => one<{ status: string; last_error: string }>(tx, `SELECT status, last_error FROM notifications WHERE id = $1`, [second]));
    expect(r2).toMatchObject({ status: "suppressed" });
    expect(r2!.last_error).toMatch(/bounced/);
  });
});

describe("school wording and staff preferences", () => {
  it("uses the school's subject and opening text but keeps the system details", async () => {
    await withTenant(f.schoolId, (tx) => saveTemplateOverride(tx, f.owner, "payment_succeeded", "Bedankt {name}!", "Hoi {name}, dank voor je betaling aan {school}."));
    const o = await withTenant(f.schoolId, (tx) => one<{ subject: string; intro: string }>(tx, `SELECT subject, intro FROM notification_template_overrides WHERE type = 'payment_succeeded'`));
    const r = renderEmail("payment_succeeded", { name: "Sam", amount_cents: 5500, currency: "EUR", reference: "INV-1" }, { name: "ABC", timezone: "Europe/Amsterdam", currency: "EUR", locale: "nl", email: null, phone: null, address: null }, o);
    expect(r.subject).toBe("Bedankt Sam!");
    expect(r.text).toMatch(/Hoi Sam, dank voor je betaling aan ABC\./);
    expect(r.text).toMatch(/INV-1/);
    // Security e-mails cannot be reworded.
    await expect(withTenant(f.schoolId, (tx) => saveTemplateOverride(tx, f.owner, "password_reset", "x", ""))).rejects.toThrow(/cannot be reworded/);
    await expect(withTenant(f.schoolId, (tx) => saveTemplateOverride(tx, asUser(f.instructorActor), "payment_succeeded", "x", ""))).rejects.toThrow(/not allowed/i);
  });

  it("staff who switched off handoff e-mails do not get them", async () => {
    await withTenant(f.schoolId, (tx) => updateUserPrefs(tx, f.owner, { handoff: false }));
    const id = await withTenant(f.schoolId, (tx) =>
      enqueueNotification(tx, { schoolId: f.schoolId, type: "handoff_requested", to: f.ownerActor.email, userId: f.ownerActor.userId, payload: {} }),
    );
    expect(id).toBeNull();
  });
});

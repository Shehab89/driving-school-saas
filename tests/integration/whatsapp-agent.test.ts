import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type Anthropic from "@anthropic-ai/sdk";
import { closePools, many, one, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { setAgentLlm, type AgentLlm } from "@/server/agent/runner";
import { RecordingSender, setWhatsAppSender } from "@/server/whatsapp/client";
import { ingestWebhook, processConversation } from "@/server/whatsapp/inbound";
import { bookLesson } from "@/server/services/lessons";
import { createFixture, setLessonTime, slotAt, type Fixture } from "./helpers";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
type Step = (params: Params) => Anthropic.Beta.BetaContentBlock[];

/** Deterministic stand-in for Claude: each create() call plays the next scripted step. */
class ScriptedLlm implements AgentLlm {
  steps: Step[] = [];
  calls: Params[] = [];
  async create(params: Params) {
    this.calls.push(structuredClone(params));
    const step = this.steps.shift();
    if (!step) throw new Error("script exhausted");
    const content = step(params);
    return {
      id: `msg_${this.calls.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

let n = 0;
const tool = (name: string, input: unknown) => ({ type: "tool_use", id: `tu_${++n}`, name, input }) as Anthropic.Beta.BetaContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaContentBlock;
/** The tool results the agent sent back in the last request. */
function lastToolResults(params: Params): Array<Record<string, unknown>> {
  const last = params.messages[params.messages.length - 1]!;
  return (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).map((r) => JSON.parse(r.content as string));
}

let f: Fixture;
const llm = new ScriptedLlm();
const sender = new RecordingSender();
const PHONE_ID = `pnid-${Date.now()}`;
let wamid = 0;

async function inbound(from: string, body: string) {
  const convs = await ingestWebhook(
    [{ phoneNumberId: PHONE_ID, from, waMessageId: `wamid.in.${++wamid}.${Date.now()}`, timestamp: new Date(), type: "text", text: body, profileName: "Test" }],
    [],
  );
  expect(convs).toHaveLength(1);
  await processConversation(convs[0]!.schoolId, convs[0]!.conversationId);
  return convs[0]!.conversationId;
}

beforeAll(async () => {
  f = await createFixture();
  setAgentLlm(llm);
  setWhatsAppSender(sender);
  await withTenant(f.schoolId, (tx) =>
    tx.query(`INSERT INTO whatsapp_accounts (school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted) VALUES ($1,$2,'waba','+31000000000',$3)`, [
      f.schoolId,
      PHONE_ID,
      encryptSecret("test-token"),
    ]),
  );
});
afterAll(closePools);

describe("WhatsApp agent", () => {
  it("onboards a new student and stores a suggested (unconfirmed) level", async () => {
    const newNumber = "+31699988877";
    llm.steps.push(
      () => [tool("record_intent", { intent: "greeting" })],
      () => [text("Hi! Welcome. Are you already a student with us?")],
    );
    const conversationId = await inbound(newNumber.slice(1), "Hi");
    expect(sender.sent.at(-1)).toEqual({ to: newNumber, body: "Hi! Welcome. Are you already a student with us?" });
    // Unknown contacts don't get student tools.
    expect(llm.calls[0]!.tools!.map((t) => (t as { name: string }).name)).not.toContain("get_my_lessons");

    llm.steps.push(
      () => [
        tool("record_intent", { intent: "new_student" }),
        tool("register_new_student", {
          first_name: "Maria",
          last_name: "Lopez",
          email: "maria@example.com",
          phone: null,
          license_category: "B",
          transmission: "manual",
          previous_experience: "Drove a bit with my dad",
          preferred_times_text: "weekday mornings",
          preferred_windows: [{ weekday: 1, start: "08:00", end: "12:00" }],
        }),
      ],
      () => [
        tool("submit_assessment", {
          has_driven_before: true,
          previous_lessons: "few",
          approx_driving_hours: 6,
          can_drive_manual: "unsure",
          traffic_comfort: 3,
          has_foreign_license: false,
          wants_transmission: "manual",
        }),
      ],
      (params) => {
        const [res] = lastToolResults(params);
        return [text(`Based on your answers, your suggested starting level is ${String(res!.suggested_level)}. An instructor can confirm this during your first lesson.`)];
      },
    );
    await inbound(newNumber.slice(1), "No I'm new. Maria Lopez, maria@example.com, B manual, weekday mornings. Yes that's all correct.");

    const s = await withTenant(f.schoolId, async (tx) => ({
      student: await one<{ id: string; status: string; source: string; phone_e164: string; level_confirmed: boolean; current_level_id: string | null }>(
        tx,
        `SELECT id, status, source, phone_e164, level_confirmed, current_level_id FROM students WHERE email = 'maria@example.com'`,
      ),
      conv: await one<{ student_id: string }>(tx, `SELECT student_id FROM whatsapp_conversations WHERE id = $1`, [conversationId]),
      assessment: await one<{ suggested_band: string; status: string; confidence: string }>(tx, `SELECT suggested_band, status, confidence FROM assessments`),
      lastInbound: await one<{ intent: string; ai_response: string }>(
        tx,
        `SELECT intent, ai_response FROM whatsapp_messages WHERE conversation_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      ),
    }));
    expect(s.student).toMatchObject({ status: "lead", source: "whatsapp", phone_e164: newNumber, level_confirmed: false });
    expect(s.student!.current_level_id).not.toBeNull();
    expect(s.conv!.student_id).toBe(s.student!.id);
    expect(s.assessment).toMatchObject({ suggested_band: "basic", status: "suggested" });
    expect(s.lastInbound!.intent).toBe("new_student");
    expect(s.lastInbound!.ai_response).toContain("suggested starting level is Level 2");
  });

  it("books a lesson only after the student confirms in a later message", async () => {
    const phone = (await withTenant(f.schoolId, (tx) => one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM students WHERE id = $1`, [f.studentId])))!.phone_e164;
    const tz = f.timezone;
    const day = DateTime.now().setZone(tz).plus({ days: 8 }).toISODate()!;

    llm.steps.push(
      () => [tool("record_intent", { intent: "book_lesson" }), tool("find_available_slots", { from_date: day, to_date: day, part_of_day: "morning", purpose: "book", lesson_id: null })],
      (params) => {
        const [, slots] = lastToolResults(params);
        expect((slots!.options as unknown[]).length).toBeGreaterThan(0);
        return [tool("propose_booking", { slot_label: "A" })];
      },
      // A model that tries to confirm in the same turn is refused by the tool.
      () => [tool("confirm_pending_action", {})],
      (params) => {
        expect(lastToolResults(params)[0]!.ok).toBe(false);
        return [text("I can book option A for you. Shall I go ahead?")];
      },
    );
    await inbound(phone.slice(1), "I want a lesson next week in the morning");
    const before = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM lessons WHERE booked_via = 'whatsapp_agent'`));
    expect(before).toHaveLength(0);

    llm.steps.push(
      () => [tool("record_intent", { intent: "book_lesson" }), tool("confirm_pending_action", {})],
      (params) => {
        const [, res] = lastToolResults(params);
        expect(res!.ok).toBe(true);
        return [text("Booked! See you then.")];
      },
    );
    await inbound(phone.slice(1), "yes");
    const after = await withTenant(f.schoolId, (tx) => many<{ student_id: string }>(tx, `SELECT student_id FROM lessons WHERE booked_via = 'whatsapp_agent'`));
    expect(after).toEqual([{ student_id: f.studentId }]);
  });

  it("the agent cannot reschedule within 24 hours and can hand over to a human", async () => {
    const phone = (await withTenant(f.schoolId, (tx) => one<{ phone_e164: string }>(tx, `SELECT phone_e164 FROM students WHERE id = $1`, [f.studentId])))!.phone_e164;
    const lesson = await withTenant(f.schoolId, (tx) => bookLesson(tx, f.owner, { studentId: f.studentId, slot: slotAt(f, 15, 16), bookedVia: "staff" }));
    const soon = DateTime.now().plus({ hours: 5 }).startOf("hour");
    await setLessonTime(f, lesson.id, soon.toJSDate(), soon.plus({ hours: 1 }).toJSDate());
    const day = DateTime.now().setZone(f.timezone).plus({ days: 3 }).toISODate()!;

    llm.steps.push(
      () => [
        tool("record_intent", { intent: "reschedule_lesson" }),
        tool("find_available_slots", { from_date: day, to_date: day, part_of_day: "any", purpose: "reschedule", lesson_id: lesson.id }),
      ],
      (params) => {
        const [, res] = lastToolResults(params);
        expect(res!.ok).toBe(false);
        expect(String(res!.error)).toContain("24 hours");
        return [tool("request_human", { reason: "Wants to reschedule within 24h" })];
      },
      () => [text("That's within 24 hours, so I've asked the school to help you here.")],
    );
    const conversationId = await inbound(phone.slice(1), "Can I move today's lesson?");
    const conv = await withTenant(f.schoolId, (tx) => one<{ status: string }>(tx, `SELECT status FROM whatsapp_conversations WHERE id = $1`, [conversationId]));
    expect(conv!.status).toBe("handoff");
    const note = await withTenant(f.schoolId, (tx) => many(tx, `SELECT 1 FROM notifications WHERE type = 'handoff_requested'`));
    expect(note.length).toBeGreaterThan(0);

    // While handed off, the AI stays silent.
    const sentBefore = sender.sent.length;
    const callsBefore = llm.calls.length;
    await inbound(phone.slice(1), "hello?");
    expect(sender.sent.length).toBe(sentBefore);
    expect(llm.calls.length).toBe(callsBefore);
  });

  it("does not let an unknown number act as a student (no student tools, identity by code)", async () => {
    llm.steps.push(
      () => [tool("record_intent", { intent: "existing_student" }), tool("get_my_lessons", { include_history: false })],
      (params) => {
        const results = lastToolResults(params);
        expect(results[1]).toMatchObject({ error: expect.stringContaining("not available") });
        return [text("Please tell me the e-mail you registered with.")];
      },
    );
    await inbound("31611122233", "What's my next lesson?");
  });
});

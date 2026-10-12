/**
 * Inbound WhatsApp pipeline:
 *   webhook -> ingest (store message, idempotent on wa_message_id, 200 fast)
 *           -> processConversation (identify contact, run agent, reply, log)
 *
 * Processing happens after the HTTP response (next/server `after`) and is
 * retried by the cron tick for anything left 'pending'.
 */
import { DateTime } from "luxon";
import { many, one, withPlatform, withTenant } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { runAgentTurn, type AgentTurnResult } from "../agent/runner";
import { deterministicReply } from "../agent/fallback";
import { setWhatsAppConsent } from "../services/notification-prefs";
import { contextBlock, systemPrompt } from "../agent/prompt";
import type { AgentState, Intent, ToolContext } from "../agent/tools";
import { enqueueNotification } from "../services/notifications";
import { toE164 } from "../services/students";
import { getWhatsAppSender } from "./client";
import type { InboundMessage, StatusUpdate } from "./webhook";
import { log } from "@/lib/log";

export async function ingestWebhook(messages: InboundMessage[], statuses: StatusUpdate[]) {
  const toProcess: Array<{ schoolId: string; conversationId: string }> = [];
  const phoneIds = [...new Set([...messages, ...statuses].map((m) => m.phoneNumberId))];
  if (phoneIds.length === 0) return toProcess;

  // Routing is the only cross-tenant step: phone_number_id -> school.
  const accounts = await withPlatform((tx) =>
    many<{ phone_number_id: string; school_id: string }>(
      tx,
      `SELECT phone_number_id, school_id FROM whatsapp_accounts WHERE phone_number_id = ANY($1) AND status = 'active'`,
      [phoneIds],
    ),
  );
  const schoolFor = new Map(accounts.map((a) => [a.phone_number_id, a.school_id]));

  for (const m of messages) {
    const schoolId = schoolFor.get(m.phoneNumberId);
    const from = toE164(m.from);
    if (!schoolId || !from) continue;
    const conversationId = await withTenant(schoolId, async (tx) => {
      const student = await one<{ id: string }>(tx, `SELECT id FROM students WHERE phone_e164 = $1 AND status <> 'archived'`, [from]);
      const conv = (await one<{ id: string }>(
        tx,
        `INSERT INTO whatsapp_conversations (school_id, wa_phone_e164, wa_profile_name, student_id, last_inbound_at, last_message_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (school_id, wa_phone_e164) DO UPDATE SET
           wa_profile_name = COALESCE(EXCLUDED.wa_profile_name, whatsapp_conversations.wa_profile_name),
           student_id = COALESCE(whatsapp_conversations.student_id, EXCLUDED.student_id),
           last_inbound_at = GREATEST(whatsapp_conversations.last_inbound_at, EXCLUDED.last_inbound_at),
           last_message_at = GREATEST(whatsapp_conversations.last_message_at, EXCLUDED.last_message_at),
           status = CASE WHEN whatsapp_conversations.status = 'closed' THEN 'open' ELSE whatsapp_conversations.status END
         RETURNING id`,
        [schoolId, from, m.profileName, student?.id ?? null, m.timestamp],
      ))!;
      await tx.query(
        `INSERT INTO whatsapp_messages (school_id, conversation_id, direction, sender, wa_message_id, message_type, body, processing_status, created_at)
         VALUES ($1,$2,'inbound','contact',$3,$4,$5,'pending',$6)
         ON CONFLICT (wa_message_id) DO NOTHING`,
        [schoolId, conv.id, m.waMessageId, m.type, m.text, m.timestamp],
      );
      return conv.id;
    });
    toProcess.push({ schoolId, conversationId });
  }

  for (const s of statuses) {
    const schoolId = schoolFor.get(s.phoneNumberId);
    if (!schoolId) continue;
    await withTenant(schoolId, async (tx) => {
      await tx.query(`UPDATE whatsapp_messages SET delivery_status = $2 WHERE wa_message_id = $1 AND direction = 'outbound'`, [s.waMessageId, s.status]);
      // Proactive template messages are tracked on the notification itself.
      if (s.status !== "sent") {
        await tx.query(
          `UPDATE notifications SET delivery_status = $2, delivery_updated_at = now()
            WHERE provider = 'whatsapp' AND provider_message_id = $1 AND (delivery_status IS NULL OR delivery_status = 'delivered')`,
          [s.waMessageId, s.status],
        );
      }
    });
  }
  // Dedupe (several messages in one webhook for the same conversation).
  return [...new Map(toProcess.map((t) => [t.conversationId, t])).values()];
}

interface ConversationRow {
  id: string;
  wa_phone_e164: string;
  wa_profile_name: string | null;
  student_id: string | null;
  status: "open" | "handoff" | "closed";
  agent_state: AgentState;
}

const LEASE_SECONDS = 120;

/**
 * Answer all pending inbound messages of one conversation in a single agent
 * turn. A short lease in agent_state prevents two workers answering the same
 * conversation concurrently.
 */
export async function processConversation(schoolId: string, conversationId: string): Promise<"done" | "busy" | "nothing"> {
  const claimed = await withTenant(schoolId, async (tx) => {
    const conv = await one<ConversationRow>(
      tx,
      `UPDATE whatsapp_conversations
          SET agent_state = jsonb_set(agent_state, '{lock_until}', to_jsonb((now() + make_interval(secs => $2))::text))
        WHERE id = $1 AND (agent_state->>'lock_until' IS NULL OR (agent_state->>'lock_until')::timestamptz < now())
        RETURNING id, wa_phone_e164, wa_profile_name, student_id, status, agent_state`,
      [conversationId, LEASE_SECONDS],
    );
    if (!conv) return null;
    const pending = await many<{ id: string; body: string | null }>(
      tx,
      `UPDATE whatsapp_messages SET processing_status = 'processing'
        WHERE id IN (SELECT id FROM whatsapp_messages WHERE conversation_id = $1 AND direction = 'inbound' AND processing_status = 'pending'
                     ORDER BY created_at FOR UPDATE SKIP LOCKED)
        RETURNING id, body`,
      [conversationId],
    );
    return { conv, pending };
  });
  if (!claimed) return "busy";
  const { conv, pending } = claimed;

  const release = (state: AgentState, extra: Partial<{ status: string; handoff_reason: string | null; student_id: string | null }> = {}) =>
    withTenant(schoolId, async (tx) => {
      delete state.lock_until;
      await tx.query(
        `UPDATE whatsapp_conversations SET agent_state = $2, status = COALESCE($3, status), handoff_reason = COALESCE($4, handoff_reason),
                student_id = COALESCE($5, student_id)
          WHERE id = $1`,
        [conversationId, JSON.stringify(state), extra.status ?? null, extra.handoff_reason ?? null, extra.student_id ?? null],
      );
    });

  if (pending.length === 0) {
    await release(conv.agent_state);
    return "nothing";
  }
  const latestId = pending[pending.length - 1]!.id;
  const markInbound = (status: "done" | "skipped" | "failed", fields: { intent?: string | null; ai_response?: string | null; metadata?: unknown } = {}) =>
    withTenant(schoolId, (tx) =>
      tx.query(
        `UPDATE whatsapp_messages SET processing_status = $2,
                intent = CASE WHEN id = $3 THEN COALESCE($4, intent) ELSE intent END,
                ai_response = CASE WHEN id = $3 THEN $5 ELSE ai_response END,
                metadata = CASE WHEN id = $3 THEN metadata || $6::jsonb ELSE metadata END
          WHERE id = ANY($1)`,
        [pending.map((p) => p.id), status, latestId, fields.intent ?? null, fields.ai_response ?? null, JSON.stringify(fields.metadata ?? {})],
      ),
    );

  try {
    const setup = await withTenant(schoolId, async (tx) => {
      const school = (await one<{ name: string; timezone: string; locale: string; ai_agent_enabled: boolean }>(
        tx,
        `SELECT s.name, s.timezone, s.locale, ss.ai_agent_enabled FROM schools s JOIN school_settings ss ON ss.school_id = s.id WHERE s.id = $1`,
        [schoolId],
      ))!;
      const account = await one<{ phone_number_id: string; access_token_encrypted: string }>(
        tx,
        `SELECT phone_number_id, access_token_encrypted FROM whatsapp_accounts WHERE status = 'active'`,
      );
      const student = conv.student_id
        ? await one<{ first_name: string; student_number: string; status: string; level: string | null; level_confirmed: boolean }>(
            tx,
            `SELECT s.first_name, s.student_number, s.status, ld.name AS level, s.level_confirmed
               FROM students s LEFT JOIN level_definitions ld ON ld.id = s.current_level_id WHERE s.id = $1`,
            [conv.student_id],
          )
        : null;
      // Recent transcript (excluding the messages being answered now).
      const history = await many<{ direction: string; body: string | null }>(
        tx,
        `SELECT direction, body FROM (
           SELECT direction, body, created_at FROM whatsapp_messages
            WHERE conversation_id = $1 AND NOT (id = ANY($2)) ORDER BY created_at DESC LIMIT 30) h
         ORDER BY created_at`,
        [conversationId, pending.map((p) => p.id)],
      );
      return { school, account, student, history };
    });

    // STOP / START work whatever the conversation state (handoff, AI switched off).
    const keyword = optKeyword(pending.map((p) => p.body ?? "").join(" "));
    if (keyword && setup.account) {
      const reply = await applyOptKeyword(schoolId, conv, keyword, setup.school.name, setup.school.locale);
      const sent = await getWhatsAppSender().sendText({
        phoneNumberId: setup.account.phone_number_id,
        accessToken: decryptSecret(setup.account.access_token_encrypted),
        to: conv.wa_phone_e164,
        body: reply,
      });
      await withTenant(schoolId, (tx) =>
        tx.query(
          `INSERT INTO whatsapp_messages (school_id, conversation_id, direction, sender, wa_message_id, body, processing_status, delivery_status)
           VALUES ($1,$2,'outbound','system',$3,$4,'done','sent')`,
          [schoolId, conversationId, sent.waMessageId, reply],
        ),
      );
      await markInbound("done", { intent: keyword, ai_response: reply });
      await release(conv.agent_state);
      return "done";
    }

    // Humans own the conversation after a handoff, and the AI can be switched off per school.
    if (conv.status === "handoff" || !setup.school.ai_agent_enabled) {
      await markInbound("skipped");
      if (conv.status !== "handoff") await notifyHandoff(schoolId, conv, "AI assistant is disabled", pending[pending.length - 1]!.body);
      await release(conv.agent_state, conv.status === "handoff" ? {} : { status: "handoff", handoff_reason: "AI assistant disabled" });
      return "done";
    }
    if (!setup.account) throw new Error("School has no active WhatsApp account");

    const now = DateTime.now().setZone(setup.school.timezone);
    const state: AgentState = { ...conv.agent_state };
    const ctx: ToolContext = {
      schoolId,
      conversationId,
      waPhone: conv.wa_phone_e164,
      messageId: latestId,
      studentId: conv.student_id,
      state,
      intents: [],
      handoff: null,
    };
    const userText =
      pending.map((p) => p.body ?? "").join("\n") +
      "\n\n" +
      contextBlock({
        nowLocal: now.toFormat("yyyy-LL-dd HH:mm"),
        weekday: now.toFormat("cccc"),
        timezone: setup.school.timezone,
        contactName: conv.wa_profile_name,
        waPhone: conv.wa_phone_e164,
        student: setup.student
          ? {
              firstName: setup.student.first_name,
              studentNumber: setup.student.student_number,
              status: setup.student.status,
              level: setup.student.level,
              levelConfirmed: setup.student.level_confirmed,
            }
          : null,
        pendingAction: state.pending_action?.summary ?? null,
        offeredOptions: Object.keys(state.offered_slots ?? {}),
      });

    const inboundText = pending.map((p) => p.body ?? "").join("\n");
    let result: AgentTurnResult;
    let fallbackIntent: Intent | null = null;
    try {
      result = await runAgentTurn({
        system: systemPrompt(setup.school.name),
        history: setup.history.map((h) => ({ role: h.direction === "inbound" ? "user" : "assistant", text: h.body ?? "" })),
        latestUserText: userText,
        ctx,
      });
    } catch (err) {
      // The model is unavailable: answer with facts we can look up, and hand over to a person.
      log.error("whatsapp.agent_unavailable", { conversationId, err });
      const fb = await deterministicReply(ctx, inboundText, setup.school.locale, "AI assistant unavailable");
      fallbackIntent = fb.intent;
      result = { reply: fb.reply, stopReason: "fallback", toolCalls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, model: "deterministic-fallback" };
    }

    const sent = await getWhatsAppSender().sendText({
      phoneNumberId: setup.account.phone_number_id,
      accessToken: decryptSecret(setup.account.access_token_encrypted),
      to: conv.wa_phone_e164,
      body: result.reply,
    });
    const intent: Intent = fallbackIntent ?? ctx.intents[ctx.intents.length - 1] ?? "other";
    await withTenant(schoolId, async (tx) => {
      await tx.query(
        `INSERT INTO whatsapp_messages (school_id, conversation_id, direction, sender, wa_message_id, body, processing_status, delivery_status, metadata)
         VALUES ($1,$2,'outbound','ai_agent',$3,$4,'done','sent',$5)`,
        [schoolId, conversationId, sent.waMessageId, result.reply, JSON.stringify({ model: result.model, usage: result.usage, in_reply_to: latestId })],
      );
      await tx.query(`UPDATE whatsapp_conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      await tx.query(
        `INSERT INTO audit_logs (school_id, actor_type, action, entity_type, entity_id, changes) VALUES ($1,'ai_agent','whatsapp.agent_replied','whatsapp_conversation',$2,$3)`,
        [schoolId, conversationId, JSON.stringify({ intent, tools: result.toolCalls.map((t) => t.name), stop_reason: result.stopReason })],
      );
    });
    await markInbound("done", {
      intent: ctx.intents.includes("human_support") ? "human_support" : intent,
      ai_response: result.reply,
      metadata: { tool_calls: result.toolCalls, stop_reason: result.stopReason, intents: ctx.intents, fallback: fallbackIntent !== null },
    });
    if (ctx.handoff) await notifyHandoff(schoolId, conv, ctx.handoff.reason, pending[pending.length - 1]!.body);
    await release(state, {
      student_id: ctx.studentId,
      ...(ctx.handoff ? { status: "handoff", handoff_reason: ctx.handoff.reason } : {}),
    });
    return "done";
  } catch (err) {
    log.error("whatsapp.processing_failed", { conversationId, err });
    // Put messages back for retry by the cron tick (bounded by attempts in metadata).
    await withTenant(schoolId, (tx) =>
      tx.query(
        `UPDATE whatsapp_messages
            SET metadata = jsonb_set(metadata, '{attempts}', to_jsonb(COALESCE((metadata->>'attempts')::int, 0) + 1)),
                processing_status = CASE WHEN COALESCE((metadata->>'attempts')::int, 0) + 1 >= 3 THEN 'failed' ELSE 'pending' END
          WHERE id = ANY($1)`,
        [pending.map((p) => p.id)],
      ),
    ).catch(() => {});
    await release(conv.agent_state).catch(() => {});
    throw err;
  }
}

async function notifyHandoff(schoolId: string, conv: ConversationRow, reason: string, lastMessage: string | null) {
  await withTenant(schoolId, async (tx) => {
    const owners = await many<{ id: string; email: string }>(
      tx,
      `SELECT id, email FROM users WHERE role IN ('school_owner','school_admin') AND status = 'active'`,
    );
    for (const o of owners) {
      await enqueueNotification(tx, {
        schoolId,
        type: "handoff_requested",
        to: o.email,
        userId: o.id,
        payload: {
          reason,
          contact: `${conv.wa_profile_name ?? ""} ${conv.wa_phone_e164}`.trim(),
          last_message: (lastMessage ?? "").slice(0, 300),
          inbox_url: `${env.appUrl}/admin/whatsapp/${conv.id}`,
        },
        // One e-mail per handoff episode, not per message.
        dedupeKey: `handoff:${conv.id}:${o.id}:${DateTime.now().toFormat("yyyyLLddHH")}`,
      });
    }
  });
}

/** Staff reply from the inbox (inside Meta's 24h customer-service window). */
export async function sendStaffReply(schoolId: string, conversationId: string, userId: string, body: string) {
  const { conv, account } = await withTenant(schoolId, async (tx) => ({
    conv: await one<{ wa_phone_e164: string; last_inbound_at: Date | null }>(tx, `SELECT wa_phone_e164, last_inbound_at FROM whatsapp_conversations WHERE id = $1`, [conversationId]),
    account: await one<{ phone_number_id: string; access_token_encrypted: string }>(tx, `SELECT phone_number_id, access_token_encrypted FROM whatsapp_accounts WHERE status = 'active'`),
  }));
  if (!conv || !account) throw new Error("Conversation or WhatsApp account not found");
  if (!conv.last_inbound_at || Date.now() - conv.last_inbound_at.getTime() > 24 * 3600_000) {
    throw new Error("Outside WhatsApp's 24-hour window: a pre-approved template message is required.");
  }
  const sent = await getWhatsAppSender().sendText({
    phoneNumberId: account.phone_number_id,
    accessToken: decryptSecret(account.access_token_encrypted),
    to: conv.wa_phone_e164,
    body,
  });
  await withTenant(schoolId, async (tx) => {
    await tx.query(
      `INSERT INTO whatsapp_messages (school_id, conversation_id, direction, sender, sender_user_id, wa_message_id, body, processing_status, delivery_status)
       VALUES ($1,$2,'outbound','staff',$3,$4,$5,'done','sent')`,
      [schoolId, conversationId, userId, sent.waMessageId, body],
    );
    await tx.query(`UPDATE whatsapp_conversations SET last_message_at = now(), assigned_user_id = COALESCE(assigned_user_id, $2) WHERE id = $1`, [conversationId, userId]);
  });
}

export async function setConversationStatus(schoolId: string, conversationId: string, status: "open" | "handoff" | "closed", userId: string) {
  await withTenant(schoolId, async (tx) => {
    await tx.query(`UPDATE whatsapp_conversations SET status = $2, handoff_reason = CASE WHEN $2 = 'open' THEN NULL ELSE handoff_reason END WHERE id = $1`, [conversationId, status]);
    await tx.query(
      `INSERT INTO audit_logs (school_id, actor_type, actor_user_id, action, entity_type, entity_id, changes) VALUES ($1,'user',$2,'whatsapp.status_changed','whatsapp_conversation',$3,$4)`,
      [schoolId, userId, conversationId, JSON.stringify({ status })],
    );
  });
}

/** Retry anything left pending (e.g. the process died after ingest). */
export async function processPendingConversations(limit = 20) {
  const rows = await withPlatform((tx) =>
    many<{ school_id: string; conversation_id: string }>(
      tx,
      `SELECT DISTINCT school_id, conversation_id FROM whatsapp_messages
        WHERE processing_status = 'pending' AND created_at < now() - interval '30 seconds' LIMIT $1`,
      [limit],
    ),
  );
  for (const r of rows) await processConversation(r.school_id, r.conversation_id).catch(() => {});
  // Recover messages stuck in 'processing' after a crash.
  await withPlatform((tx) =>
    tx.query(`UPDATE whatsapp_messages SET processing_status = 'pending' WHERE processing_status = 'processing' AND created_at < now() - interval '10 minutes'`),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// STOP / START
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["STOP", "STOPPEN", "UNSUBSCRIBE", "AFMELDEN", "UITSCHRIJVEN", "ايقاف", "إيقاف"]);
const START_WORDS = new Set(["START", "AANMELDEN", "SUBSCRIBE", "ابدأ", "ابدا"]);

/** A message consisting of just an opt-out / opt-in keyword. */
export function optKeyword(text: string): "opt_out" | "opt_in" | null {
  const w = text.trim().replace(/[.!?\s]+$/u, "").toUpperCase();
  if (STOP_WORDS.has(w)) return "opt_out";
  if (START_WORDS.has(w)) return "opt_in";
  return null;
}

const OPT_REPLIES: Record<string, { opt_out: string; opt_in: string }> = {
  en: {
    opt_out: "You will no longer get lesson messages from {school} on WhatsApp. Send START to get them again. You can still message us here.",
    opt_in: "You will get lesson messages from {school} on WhatsApp again. Send STOP at any time to stop them.",
  },
  nl: {
    opt_out: "Je ontvangt geen lesberichten meer van {school} via WhatsApp. Stuur START om ze weer te ontvangen. Je kunt ons hier nog steeds een bericht sturen.",
    opt_in: "Je ontvangt weer lesberichten van {school} via WhatsApp. Stuur STOP om ze op elk moment te stoppen.",
  },
  ar: {
    opt_out: "لن تصلك رسائل الدروس من {school} عبر واتساب بعد الآن. أرسل START لاستلامها مرة أخرى. ما زال بإمكانك مراسلتنا هنا.",
    opt_in: "ستصلك رسائل الدروس من {school} عبر واتساب مرة أخرى. أرسل STOP في أي وقت لإيقافها.",
  },
};

async function applyOptKeyword(schoolId: string, conv: ConversationRow, keyword: "opt_out" | "opt_in", schoolName: string, locale: string) {
  await withTenant(schoolId, async (tx) => {
    await tx.query(`UPDATE whatsapp_conversations SET opted_out_at = $2 WHERE id = $1`, [conv.id, keyword === "opt_out" ? new Date() : null]);
    if (conv.student_id) {
      await setWhatsAppConsent(tx, { type: "system", schoolId }, conv.student_id, keyword === "opt_in", "keyword");
    } else {
      await tx.query(
        `INSERT INTO audit_logs (school_id, actor_type, action, entity_type, entity_id, changes) VALUES ($1,'system',$2,'whatsapp_conversation',$3,'{}')`,
        [schoolId, keyword === "opt_out" ? "whatsapp.consent_withdrawn" : "whatsapp.consent_given", conv.id],
      );
    }
  });
  return (OPT_REPLIES[locale] ?? OPT_REPLIES.en)![keyword].replace("{school}", schoolName);
}

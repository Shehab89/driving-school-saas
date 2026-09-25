/**
 * Claude tool-use loop for one WhatsApp turn. We own the loop (rather than the
 * beta tool runner) because each tool call must run against per-conversation
 * state and we persist a trace of every call for the audit trail.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { executeTool, toolsFor, type ToolContext } from "./tools";

export interface AgentLlm {
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.BetaMessage>;
}

export class AnthropicAgentLlm implements AgentLlm {
  private client = new Anthropic({ timeout: 60_000, maxRetries: 2 });
  create(params: Anthropic.Beta.MessageCreateParamsNonStreaming) {
    return this.client.beta.messages.create(params);
  }
}

let llm: AgentLlm | null = null;
export function getAgentLlm(): AgentLlm {
  return (llm ??= new AnthropicAgentLlm());
}
export function setAgentLlm(l: AgentLlm) {
  llm = l;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentTurnResult {
  reply: string;
  stopReason: string | null;
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  model: string;
}

const MAX_ITERATIONS = 8;
const FALLBACK_REPLY = "Sorry, I can't help with that here. I've asked someone from the school to reply to you in this chat.";

/** Merge consecutive same-role turns and make sure the transcript starts with the user. */
export function buildTranscript(history: HistoryMessage[], latestUserText: string): Anthropic.Beta.BetaMessageParam[] {
  const merged: HistoryMessage[] = [];
  for (const m of history) {
    if (!m.text.trim()) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text += `\n${m.text}`;
    else merged.push({ ...m });
  }
  while (merged[0]?.role === "assistant") merged.shift();
  if (merged[merged.length - 1]?.role === "user") {
    merged[merged.length - 1]!.text += `\n${latestUserText}`;
  } else {
    merged.push({ role: "user", text: latestUserText });
  }
  return merged.map((m) => ({ role: m.role, content: m.text }));
}

export async function runAgentTurn(args: {
  system: string;
  history: HistoryMessage[];
  latestUserText: string;
  ctx: ToolContext;
}): Promise<AgentTurnResult> {
  const model = env.agentModel;
  const messages = buildTranscript(args.history, args.latestUserText);
  const toolCalls: AgentTurnResult["toolCalls"] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // The tool set changes once the contact is identified (e.g. after verify_link_code).
    const tools = toolsFor(Boolean(args.ctx.studentId));
    const response = await getAgentLlm().create({
      model,
      max_tokens: 4000,
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      thinking: { type: "adaptive" },
      // Chat is latency-sensitive and the tools carry the hard logic.
      output_config: { effort: "medium" },
      // If a safety classifier declines, let the API retry on its recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      args.ctx.handoff ??= { reason: "Assistant declined to answer" };
      return { reply: FALLBACK_REPLY, stopReason: "refusal", toolCalls, usage, model: response.model };
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: text || FALLBACK_REPLY, stopReason: response.stop_reason, toolCalls, usage, model: response.model };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    // Sequential on purpose: tools share conversation state (offered slots, pending action).
    for (const tu of toolUses) {
      let result: unknown;
      let isError = false;
      try {
        // Only tools offered for this contact may run (e.g. no student tools for unknown numbers).
        if (!tools.some((t) => t.name === tu.name)) throw new Error(`Tool ${tu.name} is not available for this contact`);
        result = await executeTool(tu.name, tu.input, args.ctx);
      } catch (err) {
        isError = true;
        result = { error: err instanceof Error ? err.message : "Tool failed" };
      }
      toolCalls.push({ name: tu.name, input: tu.input, result });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result), is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  args.ctx.handoff ??= { reason: "Assistant could not finish the request" };
  return { reply: FALLBACK_REPLY, stopReason: "max_iterations", toolCalls, usage, model };
}

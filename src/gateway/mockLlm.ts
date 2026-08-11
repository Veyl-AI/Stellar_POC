import type { ModelId, ReasoningEffort } from "../pricing/costTable.js";

/**
 * One prior turn in a conversation. `model` is set on assistant turns so a
 * later turn (possibly on a different model) can reference what answered
 * before it — this is what makes a model switch inside one conversation
 * visibly context-aware rather than just budget-aware.
 */
export interface ChatTurn {
  role: "user" | "assistant";
  model?: ModelId;
  content: string;
}

export interface ChatRequest {
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  /** Prior turns, oldest first. Empty for the first turn of a conversation. */
  history: ChatTurn[];
}

/**
 * Stand-in for a real open-weight model API (Groq/Together/Fireworks/etc.).
 * Deterministic so the POC is reproducible without a paid provider key: the
 * same request (including the same history) always yields the same word
 * list. Counts a "token" as one whitespace-delimited word, which is close
 * enough for demonstrating metering mechanics — a real integration reads the
 * provider's own usage field from its streaming response instead (see
 * docs/SECURITY_AUDIT.md LOW-1).
 *
 * The client resends the full conversation history on every turn, the same
 * way real stateless chat-completion APIs work (OpenAI, Anthropic, etc.) —
 * the server holds no transcript of its own. A client that misreports its
 * own history only degrades the *content* it receives (the mock loses
 * context), never the payment integrity: input tokens are priced from
 * whatever history the paying client actually sent, so under-reporting
 * hurts nobody but the party doing it. See docs/TECHNICAL_DESIGN.md §3.3.
 */
export function buildResponseWords(req: ChatRequest): string[] {
  const priorAssistantTurns = req.history.filter((t) => t.role === "assistant");
  const contextNote =
    priorAssistantTurns.length > 0
      ? `Continuing our conversation across ${priorAssistantTurns.length} prior turn(s) — most recently ` +
        `answered by ${priorAssistantTurns[priorAssistantTurns.length - 1].model}, now switching to ${req.model} ` +
        `with full context carried forward — `
      : "";

  return (
    `${contextNote}you asked: "${req.prompt}". Here is a metered response from ${req.model} ` +
    `running at ${req.reasoningEffort} reasoning effort, streamed token by token so the gateway ` +
    `can price and settle exactly what was generated, no more and no less.`
  ).split(/\s+/);
}

/**
 * Bounded variant for the MPP Charge (one-off) flow — see
 * docs/TECHNICAL_DESIGN.md §3.2. The Charge gateway must be able to guarantee it
 * never generates past the `maxOutputTokens` cap it already charged the
 * caller for, so the cap is enforced here, at generation, not left as an
 * assumption the caller of this function has to remember to apply.
 */
export function buildBoundedResponseWords(req: ChatRequest, maxOutputTokens: number): string[] {
  return buildResponseWords(req).slice(0, maxOutputTokens);
}

export function countTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Total token count of a conversation's history, for input-cost pricing (see server.ts). */
export function countHistoryTokens(history: ChatTurn[]): number {
  return history.reduce((sum, turn) => sum + countTokens(turn.content), 0);
}

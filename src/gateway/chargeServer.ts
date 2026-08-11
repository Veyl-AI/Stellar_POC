import "../env.js"; // must be first — see src/env.ts. Defensive: also correct if this module is ever imported before server.ts.
import { Mppx, stellar, Store } from "@stellar/mpp/charge/server";
import { usageToBaseUnits, baseUnitsToDecimalString } from "../pricing/pricingEngine.js";
import { buildBoundedResponseWords, countTokens } from "./mockLlm.js";
import { isModelId, isReasoningEffort, type ModelId, type ReasoningEffort } from "../pricing/costTable.js";
import { BadRequestError } from "./errors.js";

const MAX_OUTPUT_TOKENS_CAP = 2_000;
const MAX_PROMPT_CHARS = 4_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const chargeMppx = Mppx.create({
  secretKey: requireEnv("RECIPIENT_SECRET"),
  methods: [
    stellar.charge({
      recipient: requireEnv("RECIPIENT_PUBLIC"),
      currency: requireEnv("TOKEN_XLM_SAC"),
      network: (process.env.STELLAR_NETWORK ?? "stellar:testnet") as "stellar:testnet",
      feePayer: { envelopeSigner: requireEnv("RECIPIENT_SECRET") },
      store: Store.memory(),
    }),
  ],
});

export interface CompleteBody {
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  maxOutputTokens: number;
}

export function parseCompleteBody(raw: unknown): CompleteBody {
  if (typeof raw !== "object" || raw === null) throw new BadRequestError("body must be a JSON object");
  const body = raw as Record<string, unknown>;

  if (!isModelId(body.model)) throw new BadRequestError("model must be one of the supported model ids");
  if (!isReasoningEffort(body.reasoningEffort)) throw new BadRequestError("reasoningEffort must be one of: none, low, medium, high");
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new BadRequestError("prompt must be a non-empty string");
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) throw new BadRequestError(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (
    typeof body.maxOutputTokens !== "number" ||
    !Number.isInteger(body.maxOutputTokens) ||
    body.maxOutputTokens < 1 ||
    body.maxOutputTokens > MAX_OUTPUT_TOKENS_CAP
  ) {
    throw new BadRequestError(`maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS_CAP}`);
  }

  return {
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    prompt: body.prompt,
    maxOutputTokens: body.maxOutputTokens,
  };
}

/**
 * MPP Charge handler for one-off, bounded agent access — see
 * TECHNICAL_DESIGN.md §3.2 and SECURITY_AUDIT.md [DESIGN-1].
 *
 * Payment is priced and verified against the worst case (maxOutputTokens)
 * BEFORE any generation happens — deliberately the reverse order from the
 * Session tick loop, which prices *after* generating because a tick is
 * small and bounded by construction. A one-off call has no such bound
 * without this ordering: generating first would let a caller trigger real
 * upstream inference cost and simply never complete payment.
 */
export async function handleComplete(request: Request, body: CompleteBody): Promise<Response> {
  const inputTokens = countTokens(body.prompt);

  const priceBaseUnits = usageToBaseUnits({
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    inputTokens,
    outputTokens: body.maxOutputTokens,
  });
  const amount = baseUnitsToDecimalString(priceBaseUnits);

  const result = await chargeMppx.charge({
    amount,
    description: `one-off inference: ${body.model}, up to ${body.maxOutputTokens} output tokens`,
  })(request);
  if (result.status === 402) return result.challenge;

  // Payment settled on-chain — safe to generate now. Charge calls are
  // single-shot with no session, so there's no conversation history to carry.
  const words = buildBoundedResponseWords(
    { model: body.model, reasoningEffort: body.reasoningEffort, prompt: body.prompt, history: [] },
    body.maxOutputTokens,
  );

  return result.withReceipt(
    Response.json({
      text: words.join(""),
      model: body.model,
      inputTokens,
      maxOutputTokens: body.maxOutputTokens,
      actualOutputTokens: words.length,
      priceBaseUnits: priceBaseUnits.toString(),
      priceXlm: amount,
    }),
  );
}

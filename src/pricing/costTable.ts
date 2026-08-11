/**
 * Model inventory for the multi-model AI service, priced from real inference
 * costs, expressed as exact integers so pricing never touches floating point
 * (see pricingEngine.ts for why).
 *
 * This is the "one inference inventory" referenced throughout the docs: the
 * same table prices usage regardless of whether the caller is a human on a
 * continuous MPP Session chat or an agent making a one-off MPP Charge call
 * (see src/gateway/server.ts and src/gateway/chargeServer.ts) — one pricing
 * engine, one settlement layer, multiple upstream models.
 *
 * Source: Together AI published per-model rates, Aug-2026 (the intended real
 * upstream — see docs/TECHNICAL_ARCHITECTURE.md §1). These are open-weight models, not
 * frontier-proprietary ones: the economic argument for pay-per-request on
 * Stellar only holds if the underlying compute is cheap enough that a
 * $0.00001 network fee doesn't dominate, and it's real providers like these
 * — not a hypothetical cost table — that make that true.
 *
 * `*NanoUsdPerToken` = USD per single token, scaled by 1e9 (1 nano-USD =
 * 1e-9 USD). Every published "$/1M tokens" rate below divides evenly into
 * this unit, so these are exact, not rounded, integers.
 * `reasoningMultiplierBps` = multiplier on OUTPUT cost only, scaled by 1e4
 * (10000 = 1.0000x), approximating the extra cost of a model's
 * higher-reasoning-effort / "thinking" mode where the provider doesn't
 * price it as a distinct SKU.
 */
export type ModelId =
  | "qwen3-235b"
  | "deepseek-v3.1"
  | "deepseek-v4-pro"
  | "kimi-k2.6"
  | "glm-5.2";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ModelCost {
  readonly displayName: string;
  readonly family: string;
  readonly provider: string;
  readonly inputNanoUsdPerToken: number;
  readonly outputNanoUsdPerToken: number;
  readonly reasoningMultiplierBps: Record<ReasoningEffort, number>;
}

export const COST_TABLE: Record<ModelId, ModelCost> = {
  "qwen3-235b": {
    // $0.20 / $0.60 per 1M tokens (Together AI, Aug 2026)
    displayName: "Qwen3 235B",
    family: "Qwen",
    provider: "together-ai",
    inputNanoUsdPerToken: 200,
    outputNanoUsdPerToken: 600,
    reasoningMultiplierBps: { none: 10_000, low: 11_000, medium: 14_000, high: 18_000 },
  },
  "deepseek-v3.1": {
    // $0.60 / $1.70 per 1M tokens (Together AI, Aug 2026)
    displayName: "DeepSeek V3.1",
    family: "DeepSeek",
    provider: "together-ai",
    inputNanoUsdPerToken: 600,
    outputNanoUsdPerToken: 1_700,
    reasoningMultiplierBps: { none: 10_000, low: 11_000, medium: 14_000, high: 18_000 },
  },
  "deepseek-v4-pro": {
    // $2.10 / $4.40 per 1M tokens (Together AI, Aug 2026)
    displayName: "DeepSeek V4 Pro",
    family: "DeepSeek",
    provider: "together-ai",
    inputNanoUsdPerToken: 2_100,
    outputNanoUsdPerToken: 4_400,
    reasoningMultiplierBps: { none: 10_000, low: 12_000, medium: 16_000, high: 22_000 },
  },
  "kimi-k2.6": {
    // $1.20 / $4.50 per 1M tokens (Together AI, Aug 2026)
    displayName: "Kimi K2.6",
    family: "Kimi (Moonshot AI)",
    provider: "together-ai",
    inputNanoUsdPerToken: 1_200,
    outputNanoUsdPerToken: 4_500,
    reasoningMultiplierBps: { none: 10_000, low: 11_000, medium: 15_000, high: 20_000 },
  },
  "glm-5.2": {
    // $1.40 / $4.40 per 1M tokens (Together AI, Aug 2026)
    displayName: "GLM 5.2",
    family: "GLM (Zhipu AI)",
    provider: "together-ai",
    inputNanoUsdPerToken: 1_400,
    outputNanoUsdPerToken: 4_400,
    reasoningMultiplierBps: { none: 10_000, low: 11_000, medium: 15_000, high: 20_000 },
  },
};

export const MODEL_IDS = Object.keys(COST_TABLE) as ModelId[];
export const REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COST_TABLE, value);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as string[]).includes(value);
}

/** Cheapest model, in USD/1M-output terms, at a given reasoning effort — used for auto-routing. */
export function cheapestModelFor(effort: ReasoningEffort): ModelId {
  let best: ModelId = MODEL_IDS[0];
  let bestScore = Infinity;
  for (const id of MODEL_IDS) {
    const m = COST_TABLE[id];
    const score = m.outputNanoUsdPerToken * m.reasoningMultiplierBps[effort];
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

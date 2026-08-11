import { COST_TABLE, type ModelId, type ReasoningEffort } from "./costTable.js";

/**
 * All pricing math below is done in BigInt, in fixed integer units, all the
 * way from token counts to settlement-token base units. This is deliberate:
 * this is a payment path, and JS floating point (a) can't represent most
 * decimal literals exactly (0.1 + 0.2 !== 0.3) and (b) compounds rounding
 * error across additions. A pricing bug that silently over- or under-charges
 * by a few base units per call is exactly the kind of thing that's invisible
 * in a demo and expensive at volume. Token counts and cost-table rates are
 * integers already (see costTable.ts); nothing here needs to leave that
 * domain until the very last step, and even then we round in the provider's
 * favor (ceiling), never the payer's.
 */

const NANO = 1_000_000_000n; // 1 USD = 1e9 nano-USD
const BPS = 10_000n; // fixed-point scale for multipliers (10000 = 1.0000x)

export interface Rational {
  numerator: number;
  denominator: number;
}

export interface PricingConfig {
  /**
   * Full multiplier applied on top of raw inference cost, in basis points
   * scaled by 1e4 (12000 = 1.2000x = a 20% margin). Using an integer instead
   * of a float margin percentage keeps the whole cost path free of decimal
   * literals that can't be represented exactly in binary floating point.
   */
  marginMultiplierBps: number;
  /**
   * USD -> settlement-token exchange rate, as an exact rational (token units
   * per 1 USD) rather than a float, for the same reason. The POC channel
   * settles in native XLM, which is not USD-pegged, so a real deployment
   * must source this from an on-chain price oracle (e.g. Reflector on
   * Stellar) rather than hardcode it — kept as an injectable rational here
   * so that swap is a one-line change, not a rewrite.
   */
  usdToTokenRate: Rational;
  /** Decimal places of the settlement token (7 for XLM and USDC SACs on Stellar). */
  tokenDecimals: number;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  marginMultiplierBps: 12_000, // 20% margin
  usdToTokenRate: { numerator: 10, denominator: 1 }, // illustrative placeholder: 1 USD ~= 10 testnet XLM
  tokenDecimals: 7,
};

export interface UsageSnapshot {
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  inputTokens: number;
  outputTokens: number;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/** Raw inference cost (no margin), in nano-USD scaled by BPS (i.e. nanoUSD * 1e4). */
function rawNanoUsdCostScaled(usage: UsageSnapshot): bigint {
  assertNonNegativeInteger(usage.inputTokens, "inputTokens");
  assertNonNegativeInteger(usage.outputTokens, "outputTokens");
  const cost = COST_TABLE[usage.model];
  const multiplierBps = BigInt(cost.reasoningMultiplierBps[usage.reasoningEffort]);
  const inputPart = BigInt(usage.inputTokens) * BigInt(cost.inputNanoUsdPerToken) * BPS;
  const outputPart = BigInt(usage.outputTokens) * BigInt(cost.outputNanoUsdPerToken) * multiplierBps;
  return inputPart + outputPart;
}

/** Billed cost (with margin), in nano-USD scaled by BPS^2. */
function billedNanoUsdCostScaled(usage: UsageSnapshot, config: PricingConfig): bigint {
  return rawNanoUsdCostScaled(usage) * BigInt(config.marginMultiplierBps);
}

/** Raw USD cost of a usage snapshot, before margin. Display/testing convenience — see module docs. */
export function rawUsdCost(usage: UsageSnapshot): number {
  return Number(rawNanoUsdCostScaled(usage)) / Number(BPS) / 1e9;
}

/** USD cost including provider margin. Display/testing convenience — see module docs. */
export function billedUsdCost(usage: UsageSnapshot, config: PricingConfig = DEFAULT_PRICING_CONFIG): number {
  return Number(billedNanoUsdCostScaled(usage, config)) / Number(BPS * BPS) / 1e9;
}

/**
 * Converts a usage snapshot into a settlement-token amount, expressed as a
 * decimal string in the token's smallest unit ("base units" / stroops),
 * exactly the string format @stellar/mpp expects for channel commitment /
 * charge amounts. Rounds up (ceiling) so the provider is never underpaid for
 * metered usage already served.
 */
export function usageToBaseUnits(usage: UsageSnapshot, config: PricingConfig = DEFAULT_PRICING_CONFIG): bigint {
  const billedScaled = billedNanoUsdCostScaled(usage, config); // nanoUSD * BPS^2
  const numerator =
    billedScaled * BigInt(config.usdToTokenRate.numerator) * 10n ** BigInt(config.tokenDecimals);
  const denominator = BigInt(config.usdToTokenRate.denominator) * NANO * BPS * BPS;
  return ceilDiv(numerator, denominator);
}

export function baseUnitsToDecimalString(baseUnits: bigint, tokenDecimals: number = DEFAULT_PRICING_CONFIG.tokenDecimals): string {
  if (baseUnits < 0n) {
    throw new RangeError(`baseUnitsToDecimalString: refusing to format a negative amount (${baseUnits}) — this indicates a pricing bug upstream, never a legitimate charge`);
  }
  const s = baseUnits.toString().padStart(tokenDecimals + 1, "0");
  const whole = s.slice(0, s.length - tokenDecimals);
  const frac = s.slice(s.length - tokenDecimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

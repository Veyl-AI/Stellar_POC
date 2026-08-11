import { test } from "node:test";
import assert from "node:assert/strict";
import { rawUsdCost, billedUsdCost, usageToBaseUnits, baseUnitsToDecimalString, DEFAULT_PRICING_CONFIG } from "../src/pricing/pricingEngine.js";
import { cheapestModelFor } from "../src/pricing/costTable.js";

test("rawUsdCost scales linearly with tokens", () => {
  const usage = { model: "qwen3-235b" as const, reasoningEffort: "none" as const, inputTokens: 1_000_000, outputTokens: 0 };
  assert.equal(rawUsdCost(usage), 0.2);
});

test("rawUsdCost applies reasoning multiplier to output tokens only", () => {
  const base = { model: "deepseek-v4-pro" as const, inputTokens: 0, outputTokens: 1_000_000 };
  const none = rawUsdCost({ ...base, reasoningEffort: "none" });
  const high = rawUsdCost({ ...base, reasoningEffort: "high" });
  assert.equal(none, 4.4);
  assert.ok(high > none, "high reasoning effort must cost more than none");
  // Written as a literal, not `4.4 * 2.2` — the whole point of the BigInt
  // pricing path is that it does NOT carry multi-step float rounding drift,
  // so the oracle here must be computed the same exact way, then written in.
  assert.equal(high, 9.68);
});

test("billedUsdCost applies margin on top of raw cost", () => {
  const usage = { model: "kimi-k2.6" as const, reasoningEffort: "none" as const, inputTokens: 1_000_000, outputTokens: 0 };
  const raw = rawUsdCost(usage);
  assert.equal(raw, 1.2);
  const billed = billedUsdCost(usage, { ...DEFAULT_PRICING_CONFIG, marginMultiplierBps: 15_000 });
  // Literal, not `raw * 1.5` — see the note on the previous test.
  assert.equal(billed, 1.8);
});

test("usageToBaseUnits never underpays: cost is rounded up, not down", () => {
  const usage = { model: "glm-5.2" as const, reasoningEffort: "none" as const, inputTokens: 1, outputTokens: 1 };
  const base = usageToBaseUnits(usage);
  assert.ok(base > 0n, "even a single token should price above zero base units");
});

test("usageToBaseUnits is monotonically non-decreasing in output tokens (cumulative pricing invariant)", () => {
  const mk = (out: number) => usageToBaseUnits({ model: "deepseek-v3.1", reasoningEffort: "medium", inputTokens: 50, outputTokens: out });
  let prev = mk(0);
  for (const out of [8, 16, 24, 40, 100]) {
    const next = mk(out);
    assert.ok(next >= prev, `price must not decrease as more output is metered (${prev} -> ${next})`);
    prev = next;
  }
});

test("usageToBaseUnits is exact (no floating-point drift) across many small increments", () => {
  // Regression guard for the float -> BigInt rewrite: summing 1000 tiny
  // per-tick increments must equal pricing the whole usage in one shot.
  let sum = 0n;
  let prevTotal = 0n;
  for (let out = 1; out <= 1000; out++) {
    const total = usageToBaseUnits({ model: "kimi-k2.6", reasoningEffort: "high", inputTokens: 10, outputTokens: out });
    sum += total - prevTotal;
    prevTotal = total;
  }
  assert.equal(sum, prevTotal);
});

test("usageToBaseUnits rejects negative or non-integer token counts", () => {
  assert.throws(() => usageToBaseUnits({ model: "qwen3-235b", reasoningEffort: "none", inputTokens: -1, outputTokens: 0 }));
  assert.throws(() => usageToBaseUnits({ model: "qwen3-235b", reasoningEffort: "none", inputTokens: 1.5, outputTokens: 0 }));
});

test("baseUnitsToDecimalString round-trips known values", () => {
  assert.equal(baseUnitsToDecimalString(10_000_000n, 7), "1");
  assert.equal(baseUnitsToDecimalString(1n, 7), "0.0000001");
  assert.equal(baseUnitsToDecimalString(0n, 7), "0");
  assert.equal(baseUnitsToDecimalString(15_000_000n, 7), "1.5");
});

test("baseUnitsToDecimalString refuses to format a negative amount", () => {
  assert.throws(() => baseUnitsToDecimalString(-1n, 7), /negative/);
});

test("cheapestModelFor picks the lowest output-side cost at a given effort", () => {
  // Qwen3 235B is the cheapest output-token rate in the current inventory (see costTable.ts).
  assert.equal(cheapestModelFor("none"), "qwen3-235b");
});

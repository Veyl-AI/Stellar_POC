# Security & Correctness Audit — Veyl AI

Reviewed as: senior Stellar auditor / developer
Scope: `src/pricing/`, `src/gateway/`, `src/client/`, the deployed testnet channel contract, and the
`@stellar/mpp`/`mppx` integration. Out of scope: the `one-way-channel` Soroban contract's own internal
logic (SDF-maintained, explicitly unaudited upstream — see §5).
Date: 2026-08-09/11. Method: manual code review + adversarial testing against a live testnet
deployment (not static analysis only — every finding below that's marked Fixed was re-verified end to
end on-chain after the fix, not just unit-tested).

Severity follows standard usage: **Critical** (funds/settlement integrity), **High** (exploitable
availability/integrity issue), **Medium** (real but bounded impact), **Low** (defense-in-depth /
best practice), **Informational** (no action required now, worth tracking).

## Findings

### [CRITICAL-1] Unclamped tick index could produce a negative payment amount — FIXED

**Location:** `src/gateway/server.ts`, `handleTick` (pre-fix).
**Issue:** `amount` sent to `@stellar/mpp`'s channel is the *increment* added to the channel's running
total for this call (confirmed empirically — see TECHNICAL_DESIGN.md §3.1's first failed run). The
increment was computed as `totalAfter - totalBefore`, where `totalBefore` used
`start = tickIndex * TICK_WORDS` **without clamping** to the conversation's actual length, while
`totalAfter` used `end`, which *was* clamped (`Math.min(start + TICK_WORDS, allWords.length)`). A
client sending a `tickIndex` far beyond the conversation's real length (accidentally, or adversarially)
would make `start > end`, so `totalBefore > totalAfter`, so `tickIncrementBaseUnits` went negative.
**Impact:** A negative decimal string handed to `mppx.channel({ amount })` is, at best, an unhandled
exception (denial of service — every subsequent tick on that conversation key would 500); at worst, if
some layer coerced or partially accepted it, a mechanism for a payer to reduce what they're being
charged rather than increase it — the opposite of the intended invariant.
**Fix:** `start` is now clamped identically to `end` (`Math.min(tickIndex * TICK_WORDS,
allWords.length)`), and `baseUnitsToDecimalString` now throws instead of silently formatting a
negative amount, so this class of bug fails loudly at its origin instead of producing a bad number
downstream. Independently, [HIGH-1] below makes it structurally unreachable in normal operation.
**Verified:** re-ran the full demo end-to-end on a freshly deployed channel post-fix; also probed with
`tickIndex: -1` and `tickIndex: 5` directly via curl — both rejected with a 400, never reach the
pricing math (see [HIGH-1]).

### [HIGH-1] No replay / ordering protection on tick requests — FIXED

**Location:** `src/gateway/server.ts`.
**Issue:** Because each tick's price and content were pure functions of `(model, reasoningEffort,
prompt, tickIndex)` with no server-side session state, nothing stopped a client from requesting the
same `tickIndex` twice (double-charged for the same tokens — `amount` is additive, so a replay is a
second real charge, not a no-op) or requesting an out-of-order `tickIndex` (which is also what made
[CRITICAL-1] reachable from client input in the first place).
**Fix:** Added an in-memory `conversationProgress` map tracking the last successfully *paid*
`tickIndex` per conversation key; a request is rejected with 400 unless its `tickIndex` is exactly
`lastPaid + 1`. Progress only advances after `mppx.channel(...)` returns 200 (i.e. payment actually
verified), so a request that fails mid-payment remains retryable at the same index rather than getting
stuck.
**Known limitation (documented, not fixed here):** this map, like the mppx `Store.memory()` it sits
next to, is single-process and keyed on conversation *content* rather than an explicit session id — a
production deployment should use a client-supplied conversation id and a shared, atomic backing store
(Redis/Postgres — same requirement `@stellar/mpp`'s own docs state for its `Store`). Flagged in
TECHNICAL_DESIGN.md rather than silently left as a surprise.

### [HIGH-2] Floating-point arithmetic in the payment-amount path — FIXED

**Location:** `src/pricing/pricingEngine.ts` (pre-fix), `src/pricing/costTable.ts` (pre-fix).
**Issue:** Cost-table rates were stored as JS float literals (`0.01`, `0.28`, …) and combined via
float multiplication/division before a final `Math.ceil`. Binary floating point cannot represent most
decimal literals exactly, and error compounds across operations — a classic, well-documented bug class
in payment systems (`0.1 + 0.2 !== 0.3`). At the volumes and margins here the practical exposure was
small, but "small, non-zero, and silently wrong in a settlement path" is exactly the profile that's
easy to wave off pre-launch and expensive post-launch.
**Fix:** Rewrote the entire cost path in exact integer/BigInt arithmetic: cost-table rates are now
integers in nano-USD-per-token (every published `$/1M tokens` rate in the table happens to convert to
an exact integer at this scale — verified by hand, not just assumed), multipliers and margin are
integer basis points, and the USD→token exchange rate is an exact rational (`{numerator,
denominator}`) rather than a float. `usageToBaseUnits` never touches `Number` until the final,
single, intentional rounding step (ceiling, in the provider's favor). Display-only helpers
(`rawUsdCost`/`billedUsdCost`) still return `Number` for human-readable output, but nothing on the
settlement path (`usageToBaseUnits`) depends on them.
**Verified:** added a regression test (`usageToBaseUnits is exact ... across many small increments`)
that sums 1,000 incremental prices and asserts the sum equals the one-shot total exactly, no epsilon
tolerance. Also caught two of the *test suite's own* assertions computing their expected values via
float expressions (`0.28 * 2.2`, `raw * 1.5`) — both silently "passed" against a float implementation
that had matching drift, and both failed loudly against the new exact implementation until corrected
to literal expected values. That failure was the fix working as intended, not a regression.

### [MEDIUM-1] Unvalidated request body enabled type-confusion crashes and raw error disclosure — FIXED

**Location:** `src/gateway/server.ts` (pre-fix).
**Issue:** `model`, `reasoningEffort`, `prompt`, and `tickIndex` were used directly from the parsed
JSON body with no shape/range validation. An unrecognized `model` string would make
`COST_TABLE[usage.model]` `undefined`, and the next property access would throw a raw `TypeError`
from deep inside the pricing engine; the top-level handler then responded with `String(err)` — leaking
internal error text (potentially including stack-adjacent detail) to an untrusted caller.
**Fix:** Added `parseTickBody` at the HTTP boundary: `model` checked against `COST_TABLE`'s actual
keys (`isModelId`), `reasoningEffort` against the literal union (`isReasoningEffort`), `prompt`
required non-empty and capped at 4,000 characters, `tickIndex` required a non-negative integer.
Validation failures return a 400 with a short, safe message. Unexpected errors still get full detail
in server-side `console.error` logs but only a generic `{"error":"internal error"}` body to the client.
**Verified:** adversarial curl probes (bad model, bad reasoning effort, negative tickIndex, malformed
JSON) all now return clean 4xx JSON with no internal detail — see TECHNICAL_DESIGN.md §3.1 for the
transcript.

### [MEDIUM-2] Unbounded request body — FIXED

**Location:** `src/gateway/server.ts` (pre-fix).
**Issue:** The raw-body reader (`for await (const c of req) chunks.push(c)`) had no size limit — a
single client could stream an arbitrarily large body and exhaust server memory (a basic, low-effort
DoS vector on an otherwise-unauthenticated endpoint, since payment gating happens *after* the body is
fully buffered and parsed).
**Fix:** Added a 64 KB cap enforced while streaming (aborts and returns 413 as soon as the running
total crosses the limit, rather than buffering first and checking after), well above any legitimate
prompt size but far below a memory-exhaustion threshold.

### [LOW-1] Client trusts its own model/effort selection for pricing, by construction of the mock — DOCUMENTED, not a code fix

**Location:** `src/gateway/mockLlm.ts`, design-level.
**Issue:** In this POC, the same `(model, reasoningEffort)` values the client sends are used both to
generate the mock response *and* to price it, so they're consistent by construction — but this masks a
real integration requirement: in a production deployment, the model actually served and its actual
token usage must come from the **upstream provider's own response** (e.g. its `usage` field), never
be re-trusted from client-supplied request parameters. Otherwise a client could request routing to an
expensive model while claiming a cheap one for pricing purposes.
**Action:** Documented explicitly in TECHNICAL_DESIGN.md's security considerations rather than left
implicit; flagged here so it isn't lost when the mock is swapped for a real provider.

### [LOW-2] `commitment_key` constructor argument accepts a Stellar `G...` address without erroring, but breaks the channel — DOCUMENTED

**Location:** deployment procedure (`stellar contract deploy ... --commitment_key`), not application
code.
**Issue:** The `one-way-channel` contract's constructor takes `commitment_key` as a raw `BytesN<32>`.
Passing a Stellar `G...` address string (StrKey-encoded) rather than the raw hex pubkey from
`ed25519 pub` reproducibly traps the constructor (`Error(Context, InvalidAction)` /
`UnreachableCodeReached`) — encountered firsthand during deployment (see TECHNICAL_DESIGN.md §3). This
is an upstream ergonomics gap (silent-until-runtime-trap type confusion between two encodings of the
same 32 bytes), not something fixable from this repo, but costly to rediscover blind.
**Action:** Documented prominently in README.md's deployment section so it isn't rediscovered the
hard way a second time.

### [LOW-3] `.env` loaded too late for a sibling module's top-level code — FIXED

**Location:** `src/gateway/server.ts`, `src/gateway/chargeServer.ts` (introduced when the Charge
gateway was added).
**Issue:** `server.ts` called `process.loadEnvFile()` at its own top level, *after* its `import`
statements — including its import of `chargeServer.ts`, whose own top-level code
(`Mppx.create(...)`) reads required env vars immediately. ES module `import` statements are evaluated
before the importing module's own body runs, so `chargeServer.ts` read `process.env` before
`server.ts` had populated it, crashing the process at startup (`Missing required env var
RECIPIENT_SECRET`) the first time both gateways ran in one process.
**Fix:** Centralized env loading into `src/env.ts`, a side-effect-only module imported first (before
any other import) by every entrypoint (`server.ts`, `chargeServer.ts`, `demo.ts`, `demoAgent.ts`)
rather than relying on import-order side effects between sibling modules.
**Verified:** clean startup and a full end-to-end run (session + charge) after the fix — see
TECHNICAL_DESIGN.md §6.

### [LOW-4] `conversationId` was not scoped to the configured channel — FIXED FOR CURRENT BOUNDARY

**Location:** `src/gateway/server.ts`, added with multi-turn/multi-model conversation support (see
TECHNICAL_DESIGN.md §1, §3.3).
**Issue:** `conversations` is keyed purely by the client-supplied `conversationId` string, with no
binding to a specific funder or channel. Two different funders coincidentally (or deliberately)
choosing the same `conversationId` would have their turn/tick sequencing interfere — the second
request would either get rejected as out-of-order, or, worse, advance state the first funder's next
request then can't match, a denial-of-service against that conversation.
**Fix:** conversation progress is now keyed as `${CHANNEL_CONTRACT}:${conversationId}` instead of by
the caller-supplied `conversationId` alone. This matches the current gateway boundary, where a running
instance is configured for one channel and one commitment key.
**Residual production note:** a future multi-channel gateway should extend this namespacing to the
runtime payer/channel identity selected for that request, backed by a shared atomic store.

### [HIGH-3] Pinned `@stellar/stellar-sdk@15.x` could not parse current testnet XDR — FIXED (was INFORMATIONAL-1)

**Location:** `package.json` (transitive dependency via `@stellar/mpp@0.7.1`).
**This finding was originally logged as an Informational note about a transitive `axios` vulnerability
and a "left as-is, low priority for a testnet POC" decision. That decision turned out to be wrong, and
is left visible here rather than quietly edited away, because the reasoning error is the more useful
thing to record: "no real value at stake" is not the same as "no availability risk."**
**Issue actually encountered:** deploying a fourth channel and re-running verification, every payment
request began failing with `ChannelVerificationError: On-chain state check failed`, root-caused to
`XdrReaderError: unknown SorobanCredentialsType member for value 2` — `@stellar/stellar-sdk@15.x`'s
bundled XDR definitions don't include a `SorobanCredentials` union variant that Stellar testnet's
current ledger state now returns (independently reproduced via a standalone call to
`getChannelState`, isolating it from this project's own code). This is a **complete availability
failure**, not a latent security concern: with an unparseable on-chain state response, every single
channel payment verification failed, full stop.
**Fix:** Upgraded to `@stellar/stellar-sdk@16.2.0` (`npm install @stellar/stellar-sdk@16.2.0
--legacy-peer-deps` — `@stellar/mpp@0.7.1` still declares a `^15.1.0` peer range, so this is ahead of
its declared compatibility, not within it). This resolved the XDR parsing failure directly, and, as a
side effect, also resolved the originally-logged `axios` vulnerabilities (`npm audit`: 0 vulnerabilities
post-upgrade) — `@stellar/stellar-sdk@16.x` drops the vulnerable `axios` dependency entirely.
**Verified:** `getChannelState` succeeds against the live channel contract post-upgrade; a full
multi-turn, multi-model conversation and a separate MPP Charge call both settled correctly on-chain
afterward — see TECHNICAL_DESIGN.md §5–§6.
**Residual risk:** running ahead of `@stellar/mpp`'s declared peer range means future `@stellar/mpp`
patch releases are not guaranteed compatible with `@stellar/stellar-sdk@16.x`; re-verify on every
`@stellar/mpp` upgrade until its peer range officially moves to `^16.x`.

### [INFORMATIONAL-2] `mppx@0.6.31` client bug in its own error-diagnostics path

**Location:** `node_modules/mppx` (third-party, not this repo's code).
**Issue:** The polyfilled-fetch client (`Mppx.create({ polyfill: true })`) throws `TypeError:
Response.clone: Body has already been consumed` from inside its own `catch` block
(`wrappedFetch` → `createPaymentFailedPayload` → `snapshotResponse`) once a real error condition
occurs upstream, because it re-clones a challenge `Response` whose body an earlier internal step
already read — masking whatever the actual original error was. Reproduced deterministically once tick
amounts became genuinely dynamic per request (this project's whole point), so it isn't a hypothetical
edge case.
**This repo's mitigation:** `src/client/demo.ts` sets `polyfill: false` and drives the challenge →
sign → retry cycle manually via `mppx.rawFetch` + `mppx.createCredential(response)` — a pattern the
library's own type definitions document as intended for exactly this ("manual rawFetch +
createCredential flows"), avoiding the buggy code path entirely rather than papering over it. Every
commitment produced this way is still independently verified by the *server* using the SDK's normal
verification path, so this doesn't weaken what's actually being proven on-chain.
**Action:** Worth reporting upstream to the `mppx`/`@stellar/mpp` maintainers; not blocking for this
project since the workaround is in the documented public API, not a hack around internals.

## Design reviews (pre-implementation)

Everything above was found in code that already existed. The entry below is different in kind: it's a
review of a *specification*, conducted before the corresponding code was written, specifically because
[CRITICAL-1] and [HIGH-1] above showed that this class of mistake (unsafe ordering between "do the
expensive/risky thing" and "confirm payment for it") is exactly the kind of issue that's cheap to catch
on paper and expensive to catch after the fact. Recorded here rather than silently folded into the
design doc so the review itself is auditable.

### [DESIGN-1] MPP Charge (one-off agent access): payment-before-generation ordering — ADDRESSED AT SPEC STAGE

**Location:** `TECHNICAL_DESIGN.md` §3.2 (specification), implemented in `src/gateway/chargeServer.ts`.
**Question raised in review:** the Session gateway ([CRITICAL-1]'s home) generates a tick's tokens
*before* pricing and gating them, which is safe there only because a tick is small and bounded
(`TICK_WORDS`). A naive port of that same order to a single one-shot Charge call — generate a full
response, then price and gate it — would remove that bound: nothing would stop a caller from
triggering a full, real inference call (against the operator's actual upstream provider account) and
then simply never completing the resulting payment, since the compute would already have happened.
**Resolution:** specified the Charge flow to price a caller-declared `maxOutputTokens` worst-case
*before* any generation, gate generation behind that payment settling, then generate bounded to the
cap — see TECHNICAL_DESIGN.md §3.2 for the full reasoning and the sequence diagram. This also matches
HTTP-402/x402-style ordering: authorize first, then deliver. The review applied that payment-ordering
principle to a new code path before it existed, instead of rediscovering it from a live bug.
**Verification status: implemented and verified on-chain.** `src/gateway/chargeServer.ts` implements
exactly this ordering — see `handleComplete`. Verified with a real agent call against Stellar testnet:
a 40-output-token-capped GLM-5.2 request priced the worst case (0.0022632 XLM) *before* generating
anything, gated on that payment via `@stellar/mpp/charge/server`, and only generated content after the
transfer was confirmed. Independently confirmed via Horizon (not just trusting the 200 response): tx
[e6d667dc…](https://stellar.expert/explorer/testnet/tx/e6d667dcde8d3ebeb709577e48b722514acf404e599033e28becf95699b1be3f)
shows `GAY7ND...` (funder) debited exactly `0.0022632` XLM and `GDFDHK...` (recipient/operator)
credited the same amount, submitted by the recipient (fee-sponsored pull mode) — a real SEP-41
transfer, not a mock.

## Summary

| Severity | Count | Fixed | Documented / Deferred |
|---|---|---|---|
| Critical | 1 | 1 | 0 |
| High | 3 | 3 | 0 |
| Medium | 2 | 2 | 0 |
| Low | 4 | 2 | 2 (upstream/integration-boundary limitations) |
| Informational | 1 | 0 | 1 (tracked, third-party library bug) |
| Design review | 1 | 1 | addressed at spec stage, then implemented and re-verified on-chain |

All findings that were reachable and fixable within this codebase were fixed and re-verified against a
live testnet deployment (fresh channel contract, real on-chain close, exact settlement amount
matching the pricing engine's output — see TECHNICAL_DESIGN.md §5–§6). One of those fixes (HIGH-3) was
initially misjudged as low-priority when first logged, then found to be a full availability blocker
once it was actually hit — left visible in the findings above rather than quietly corrected, because
that misjudgment is worth remembering. Nothing in this table was fixed
by narrowing a test instead of the code: every fix was validated by re-running the real on-chain flow,
not just re-running unit tests.

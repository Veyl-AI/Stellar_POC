# Technical Design

Status: POC, testnet only, reviewed for security and correctness.

See also: [SECURITY_AUDIT.md](SECURITY_AUDIT.md) and [ROADMAP.md](ROADMAP.md).

## 1. Product Shape

Veyl AI is a Stellar-native multi-model AI inference service. It gives users direct access to models such as Qwen, DeepSeek, Kimi, and GLM while managing usage-based pricing and Stellar payments itself.

Two payment modes share one pricing engine:

- **MPP Session:** continuous chat for humans. A user funds a payment channel once, then spends it down per response chunk across multiple turns and models.
- **MPP Charge:** bounded one-off calls for autonomous agents. The caller declares a maximum output token cap, pays for the worst case, and receives content only after payment settles.

The operator is the merchant of record. Initially, the intended provider is Together AI. Over time, the objective is to operate inference infrastructure directly and reduce reliance on external providers.

The POC settles in native testnet XLM. Mainnet integration should use USDC, a real exchange-rate source, and production persistence.

## 2. Model Inventory

The cost table lives in `src/pricing/costTable.ts`. Rates are represented as exact integer nano-USD-per-token values so payment amounts never depend on floating-point arithmetic.

| Model | Family | Input $/1M tokens | Output $/1M tokens |
|---|---|---:|---:|
| `qwen3-235b` | Qwen | 0.20 | 0.60 |
| `deepseek-v3.1` | DeepSeek | 0.60 | 1.70 |
| `deepseek-v4-pro` | DeepSeek | 2.10 | 4.40 |
| `kimi-k2.6` | Kimi | 1.20 | 4.50 |
| `glm-5.2` | GLM | 1.40 | 4.40 |

The same inventory is used by Session and Charge. The POC uses deterministic mock responses, but the pricing structure is designed for a hosted upstream provider that returns authoritative usage data.

## 3. Payment Surfaces

### 3.1 MPP Session

`POST /v1/chat/tick` serves one response chunk at a time.

Request body:

```json
{
  "conversationId": "demo-conversation",
  "turnIndex": 0,
  "tickIndex": 0,
  "model": "qwen3-235b",
  "reasoningEffort": "low",
  "prompt": "What is a Stellar payment channel?",
  "history": []
}
```

Flow:

1. The client opens a channel outside the gateway.
2. The client sends a tick request.
3. The gateway validates the request and enforces strict turn/tick ordering.
4. The gateway generates a bounded mock tick.
5. The gateway prices only the newly released output tokens.
6. The gateway returns a 402 challenge.
7. The client signs an updated cumulative voucher.
8. The gateway verifies the voucher through `@stellar/mpp/channel/server`.
9. The gateway releases the tick content and advances conversation progress.

The client resends the full conversation history on every turn. That mirrors stateless chat-completion APIs and lets a conversation switch models without the server storing a transcript.

### 3.2 MPP Charge

`POST /v1/chat/complete` serves one bounded agent call.

Request body:

```json
{
  "model": "glm-5.2",
  "reasoningEffort": "none",
  "prompt": "Classify the sentiment of: 'Stellar fees are basically free.'",
  "maxOutputTokens": 40
}
```

Flow:

1. The client declares `maxOutputTokens`.
2. The gateway prices the worst case before generation.
3. The gateway returns a fixed-amount 402 challenge.
4. The client signs the transfer authorization.
5. The gateway verifies and submits payment through `@stellar/mpp/charge/server`.
6. The gateway generates content bounded by `maxOutputTokens`.
7. The gateway returns the response.

The pay-before-generate ordering is intentional. A one-off call has no small tick boundary, so generating first would let callers trigger upstream compute cost and abandon payment.

### 3.3 x402 Compatibility

The current agent implementation uses MPP Charge. A later HTTP-402/x402-facing endpoint can reuse the same request validation, model inventory, and pricing engine, with the payment verification adapter swapped at the boundary.

## 4. Pricing

The settlement path is implemented in `src/pricing/pricingEngine.ts`.

```text
raw cost = inputTokens * inputRate + outputTokens * outputRate * reasoningMultiplier
billed cost = raw cost * marginMultiplier
base units = ceil(billed cost * usdToTokenRate * 10^tokenDecimals)
```

Important properties:

- All settlement math uses `BigInt`.
- Rates are integer nano-USD-per-token values.
- Multipliers use basis points.
- The USD-to-token rate is an exact rational.
- Final conversion rounds up so already-served usage is never underpaid.
- Display helpers may return `number`, but `usageToBaseUnits` does not depend on floating point.

For Session, output tokens are metered per tick. For Charge, output tokens are the caller's declared maximum cap.

## 5. Architecture

```mermaid
flowchart LR
  Client[Client] --> Gateway[Inference Gateway]
  Gateway --> Pricing[Pricing Engine]
  Gateway --> Mock[Mock LLM]
  Gateway --> MPP[@stellar/mpp]
  MPP --> Stellar[Stellar Testnet]
```

Components:

- `src/env.ts`: loads `.env` before entrypoint dependencies read configuration.
- `src/pricing/`: model inventory and exact pricing conversion.
- `src/gateway/server.ts`: Node HTTP server and MPP Session handler.
- `src/gateway/chargeServer.ts`: MPP Charge handler.
- `src/gateway/mockLlm.ts`: deterministic, history-aware stand-in for a hosted model API.
- `src/client/demo.ts`: one conversation, three turns, three models, one funded channel.
- `src/client/demoAgent.ts`: one bounded agent call paid through Charge.

## 6. Verification Record

The POC has been exercised against Stellar testnet with real channel deployments and real settlement transactions. The current technical result is one continuous conversation over three turns and three models, plus separate bounded Charge calls using the same pricing engine and model inventory.

Representative deployed artifacts:

| Item | Value |
|---|---|
| Session channel | `CBQG4KHQKX2JTCKDA2NL3BJXLP5XECSJFBZDRSM467LBAPOZYBPJWUZH` |
| Session deploy tx | `3e299ecfa1b3457ec0b6f0f67926519f70178117bcaec85265f626c6a48a75d3` |
| Session close tx | `7b463590b721407c96c4f31b71e87505d98d63ff012946dbcb97eef80380812c` |
| Session settled amount | `106745` stroops |
| Charge tx | `661943090efec267118e2776464d6fabb0777c30f4715ab27a67f3f6773dc0fa` |
| Charge settled amount | `22632` stroops |

The testnet channel is closed. Running the demos again requires a freshly deployed channel and updated `.env`.

## 7. Security Notes

The detailed record is in [SECURITY_AUDIT.md](SECURITY_AUDIT.md). Key controls in the current POC:

- Request body size cap.
- HTTP-boundary validation for request shape, supported model IDs, prompt size, history size, and token caps.
- Strict turn/tick ordering to prevent replay and accidental double charging.
- Conversation progress is scoped by configured channel contract and conversation ID.
- Negative settlement amounts rejected before formatting.
- Charge path verifies payment before generation.
- Server logs unexpected internal errors without echoing raw internals to clients.

Known production gaps:

- In-memory MPP stores and conversation progress are single-process only.
- Mock LLM must be replaced with a provider integration that uses provider-returned usage fields.
- The placeholder exchange rate must be replaced with a trusted price source.
- The referenced payment-channel contract path needs independent review before material-value use.

## 8. POC Scope

In scope:

- Exact pricing engine.
- Testnet Session and Charge payment paths.
- Deterministic demos.
- Security review of this repository's gateway, client, and pricing code.

Out of scope:

- Mainnet readiness.
- Live Together AI or equivalent provider integration.
- Production persistence.
- Multi-tenant operation.
- Production wallet UX.
- Formal third-party review of upstream contracts or SDKs.

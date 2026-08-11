# Roadmap

This roadmap tracks the practical path from testnet POC to a production-grade service.

## Phase 1: POC Stabilization

- Keep the pricing engine pure and fully covered by unit tests.
- Keep the mock LLM deterministic for repeatable payment-flow tests.
- Add CI checks for tests and TypeScript.
- Document all required environment variables in `.env.example`.
- Keep testnet transaction references in the technical design for reproducibility.

## Phase 2: Provider Integration

- Replace `src/gateway/mockLlm.ts` with a real hosted-model adapter.
- Price requests from provider-returned usage fields, not client-supplied claims.
- Add integration tests with mocked provider responses.
- Add failure-mode tests for partial provider failures, retry behavior, and timeout handling.

## Phase 3: Production Persistence

- Replace `Store.memory()` with a shared backend supported by the deployment environment.
- Move conversation progress from an in-process `Map` to an atomic persistence layer.
- Namespace conversation state by payer or channel identity.
- Add operational logging that avoids storing prompt content by default.

## Phase 4: Settlement Hardening

- Replace the placeholder USD-to-token rate with a trusted price source.
- Select the intended settlement asset.
- Re-run end-to-end settlement tests after every SDK or protocol dependency upgrade.
- Complete independent review of the payment-channel contract path before material-value use.

## Phase 5: Product Surface

- Add a minimal chat UI for Session users.
- Add API documentation for agent callers.
- Add model routing based on task, cost, latency, and remaining budget.
- Add usage export and receipts for paid calls.

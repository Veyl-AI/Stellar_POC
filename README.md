# Veyl AI

Multi-model AI inference on Stellar.

Veyl AI is a Stellar-native inference service that gives users direct access to models such as Qwen, DeepSeek, Kimi, and GLM. The current implementation is a working testnet POC covering a human chat flow powered by MPP Session and an autonomous-agent call flow powered by MPP Charge.

## What Is Built

- TypeScript gateway with two paid inference endpoints.
- MPP Session flow for continuous human chat from a single funded channel.
- MPP Charge flow for bounded one-off agent calls.
- Shared model inventory and exact-integer pricing engine.
- Multi-turn demo that switches models while carrying context forward.
- Agent demo that pays before generation for a capped request.
- Security and correctness review with findings recorded in [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## How It Works

For human chat, users fund a Stellar channel once and spend the balance across conversation turns. Each response is streamed as small ticks. The gateway prices newly released output and the resent conversation context, then releases content only after the client signs a cumulative commitment verified against the channel.

For agents, callers use a bounded request. The gateway prices `maxOutputTokens` before generation, issues a 402 challenge, verifies and submits the SEP-41 transfer, then generates output within that bound.

The POC settles in XLM on Stellar testnet to avoid test-asset faucet dependency. The production path is to settle in USDC, use a Stellar oracle such as Reflector for exchange rates, replace the mock model with Together AI usage data, and move in-memory state to Redis or Postgres.

## Documentation

- [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md): architecture, payment flows, pricing model, verification notes, and POC limitations.
- [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md): review findings and current known risks.
- [docs/ROADMAP.md](docs/ROADMAP.md): suggested path from POC to production.

## Requirements

- Node.js 22+
- npm
- Stellar CLI and `ed25519` helper only if you want to deploy a fresh testnet channel.

## Setup

```bash
npm install --legacy-peer-deps
cp .env.example .env
```

Fill `.env` with testnet keys/contracts. The project intentionally ignores `.env`; never commit funded secrets.

## Scripts

```bash
npm test
npm run typecheck
npm run gateway
npm run demo
npm run demo:agent
```

`npm run gateway` starts both endpoints in one process:

```text
POST /v1/chat/tick      MPP Session chat ticks
POST /v1/chat/complete  MPP Charge bounded completions
```

## Fresh Channel Setup

The recorded testnet channels in the technical design are already closed. To run the Session demo again, deploy a new `one-way-channel` contract and update `.env`.

```bash
cd /tmp
git clone https://github.com/stellar-experimental/one-way-channel
cd one-way-channel
make install-tool-ed25519
stellar contract build
stellar keys generate my-funder --fund
stellar keys generate my-recipient --fund
stellar keys generate my-commitment
SKEY=$(ed25519 gen)
PKEY=$(ed25519 pub $SKEY)
WASM_HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/channel.wasm --source my-funder)
stellar contract deploy --wasm-hash "$WASM_HASH" --source my-funder -- \
  --token native --from my-funder --commitment_key "$PKEY" --to my-recipient \
  --amount 10000000 --refund_waiting_period 120
```

Use the raw hex public key from `ed25519 pub` for `commitment_key`. Passing a Stellar `G...` address there traps the contract constructor.

## Project Layout

```text
src/env.ts                   .env loader imported first by entrypoints
src/pricing/costTable.ts     model inventory and exact integer rate table
src/pricing/pricingEngine.ts token usage to settlement base units
src/gateway/server.ts        MPP Session endpoint and shared HTTP server
src/gateway/chargeServer.ts  MPP Charge endpoint
src/gateway/mockLlm.ts       deterministic history-aware mock model
src/client/demo.ts           multi-turn human chat demo
src/client/demoAgent.ts      bounded agent-call demo
test/                        pricing engine unit tests
.github/                     CI, issue templates, and PR template
```

## Current Traction

The POC has a TypeScript gateway, human and agent demos, exact-integer pricing, a model cost table, and an audit record. Four Soroban one-way-channel contracts were deployed and closed on testnet. The latest settled a continuous three-turn, three-model conversation from a single funded channel for exactly `106745` stroops. The MPP Charge path settled two bounded GLM agent calls as SEP-41 transfers of `22632` stroops each.

## Status

This is a testnet POC. It is not production-ready until the mocked model backend, in-memory stores, price oracle, multi-tenant scoping, and payment-channel contract review path are replaced or hardened.

## License

MIT. See [LICENSE](LICENSE).

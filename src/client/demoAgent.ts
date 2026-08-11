import "../env.js"; // must be first — see src/env.ts
import { Keypair } from "@stellar/stellar-sdk";
import { Mppx, stellar } from "@stellar/mpp/charge/client";
import type { ModelId, ReasoningEffort } from "../pricing/costTable.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const GATEWAY_URL = `http://localhost:${process.env.GATEWAY_PORT ?? 8787}/v1/chat/complete`;

// Manual rawFetch + createCredential, not the polyfilled auto-retry fetch —
// same reasoning as src/client/demo.ts (see docs/TECHNICAL_DESIGN.md §6.2): the
// polyfilled path's own error-diagnostics code has a body-double-consumption
// bug once real, non-trivial responses are involved. Sidestepping it here
// too rather than relying on the charge flow happening not to trigger it.
const mppx = Mppx.create({
  polyfill: false,
  methods: [
    stellar.charge({
      keypair: Keypair.fromSecret(requireEnv("FUNDER_SECRET")),
      mode: "pull",
      onProgress: (event) => {
        if (event.type === "challenge") {
          console.log(`  [mpp] 402 challenge: pay ${event.amount} ${event.currency} to ${event.recipient}`);
        } else if (event.type === "signed") {
          console.log(`  [mpp] signed transfer`);
        } else if (event.type === "paid") {
          console.log(`  [mpp] settled on-chain: ${event.hash}`);
        }
      },
    }),
  ],
});

interface CompleteResponse {
  text: string;
  model: ModelId;
  inputTokens: number;
  maxOutputTokens: number;
  actualOutputTokens: number;
  priceBaseUnits: string;
  priceXlm: string;
}

async function agentCall(model: ModelId, reasoningEffort: ReasoningEffort, prompt: string, maxOutputTokens: number) {
  console.log(`\n=== agent call (model=${model}, cap=${maxOutputTokens} tokens) ===`);
  console.log(`prompt: "${prompt}"`);

  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, reasoningEffort, prompt, maxOutputTokens }),
  };

  const first = await mppx.rawFetch(GATEWAY_URL, init);
  let res = first;
  if (first.status === 402) {
    const credential = await mppx.createCredential(first);
    res = await mppx.rawFetch(GATEWAY_URL, { ...init, headers: { ...init.headers, Authorization: credential } });
  }
  if (!res.ok) throw new Error(`gateway error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as CompleteResponse;
  console.log(data.text);
  console.log(
    `--- paid upfront for up to ${data.maxOutputTokens} tokens, actually used ${data.actualOutputTokens} ` +
      `(${data.priceXlm} XLM charged once, no channel, no session) ---`,
  );
  return data;
}

async function main() {
  console.log("Autonomous agent, single bounded call, no channel — MPP Charge against the same inventory");
  console.log("the human MPP Session gateway (src/client/demo.ts) draws from.");
  await agentCall("glm-5.2", "none", "Classify the sentiment of: 'Stellar fees are basically free.'", 40);
  console.log("\nAgent demo complete. One on-chain SEP-41 transfer, verified and settled before any content");
  console.log("was generated — see docs/TECHNICAL_DESIGN.md §3.2 for why that ordering is the whole point.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "../env.js"; // must be first — see src/env.ts
import { randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Mppx, stellar } from "@stellar/mpp/channel/client";
import type { ModelId, ReasoningEffort } from "../pricing/costTable.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const GATEWAY_URL = `http://localhost:${process.env.GATEWAY_PORT ?? 8787}/v1/chat/tick`;

const mppx = Mppx.create({
  // Manual orchestration below (rawFetch + createCredential) rather than the
  // polyfilled global-fetch auto-retry: mppx 0.6.31's wrappedFetch has a bug
  // where its own error-diagnostics path re-clones a challenge Response whose
  // body a prior step already consumed, throwing "Body has already been
  // consumed" and masking whatever the real condition was. createCredential()
  // is the same primitive minus that fetch-wrapping, and is the pattern the
  // library's own types document for "manual rawFetch + createCredential
  // flows" — so this sidesteps the bug rather than working around a guess.
  polyfill: false,
  methods: [
    stellar.channel({
      commitmentKey: Keypair.fromSecret(requireEnv("COMMITMENT_SECRET")),
      allowedChannels: [requireEnv("CHANNEL_CONTRACT")],
      network: (process.env.STELLAR_NETWORK ?? "stellar:testnet") as "stellar:testnet",
      onProgress: (event) => {
        if (event.type === "challenge") {
          console.log(`  [mpp] 402 challenge: pay up to ${event.amount} (cumulative ${event.cumulativeAmount})`);
        } else if (event.type === "signed") {
          console.log(`  [mpp] signed commitment, new cumulative = ${event.cumulativeAmount}`);
        }
      },
    }),
  ],
});

interface ChatTurn {
  role: "user" | "assistant";
  model?: ModelId;
  content: string;
}

interface TickResponse {
  conversationId: string;
  turnIndex: number;
  tickIndex: number;
  text: string;
  turnDone: boolean;
  cumulativeOutputTokensThisTurn: number;
  tickPriceBaseUnits: string;
  tickPriceXlm: string;
  turnTotalBaseUnits: string;
  turnTotalXlm: string;
  conversationTotalBaseUnits: string;
  conversationTotalXlm: string;
}

async function payAwareFetch(body: unknown): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  const first = await mppx.rawFetch(GATEWAY_URL, init);
  if (first.status !== 402) return first;

  const credential = await mppx.createCredential(first);
  return mppx.rawFetch(GATEWAY_URL, {
    ...init,
    headers: { ...init.headers, Authorization: credential },
  });
}

/**
 * Runs one turn of an ongoing conversation and appends it to `history` —
 * the caller drives `history` across calls, exactly like a real
 * stateless chat-completion client would. `model` can differ from every
 * prior turn's model; the gateway has no notion of "the conversation's
 * model," only "the conversation's accumulated price."
 */
async function turn(
  conversationId: string,
  turnIndex: number,
  model: ModelId,
  reasoningEffort: ReasoningEffort,
  prompt: string,
  history: ChatTurn[],
): Promise<TickResponse> {
  console.log(`\n=== turn ${turnIndex}: model=${model}, effort=${reasoningEffort} ===`);
  console.log(`prompt: "${prompt}"`);

  let tickIndex = 0;
  let full = "";
  let last: TickResponse | undefined;

  for (;;) {
    const res = await payAwareFetch({ conversationId, turnIndex, tickIndex, model, reasoningEffort, prompt, history });
    if (!res.ok) throw new Error(`gateway error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as TickResponse;
    full += data.text;
    last = data;
    process.stdout.write(data.text);
    if (data.turnDone) break;
    tickIndex++;
  }

  history.push({ role: "user", content: prompt });
  history.push({ role: "assistant", model, content: full.trim() });

  console.log(
    `\n--- turn settled: ${last!.turnTotalXlm} XLM this turn, ${last!.conversationTotalXlm} XLM conversation-to-date ` +
      `(${last!.conversationTotalBaseUnits} stroops) ---`,
  );
  return last!;
}

async function main() {
  const conversationId = randomUUID();
  console.log(`One funded Stellar channel, ONE continuous conversation (id=${conversationId}),`);
  console.log("switching models mid-thread with full context carried forward on every turn.");

  const history: ChatTurn[] = [];

  await turn(conversationId, 0, "qwen3-235b", "low", "What is a Stellar payment channel?", history);
  await turn(
    conversationId,
    1,
    "deepseek-v3.1",
    "medium",
    "Given what you just told me, why does per-token pricing beat flat subscriptions for AI APIs?",
    history,
  );
  const last = await turn(
    conversationId,
    2,
    "kimi-k2.6",
    "high",
    "Summarize everything we've covered so far and compare MPP Session to MPP Charge.",
    history,
  );

  console.log(`\nDemo complete. One conversation, three turns, three different models, one funded channel —`);
  console.log(`each turn's prompt priced the FULL resent history as input (context has real, growing cost, not`);
  console.log(`just simulated presence), and turn 3's response referenced turn 2's model by name (see output above).`);
  console.log(`Final conversation total: ${last.conversationTotalXlm} XLM, settled off-chain until close.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

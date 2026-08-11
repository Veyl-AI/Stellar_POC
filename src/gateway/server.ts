import "../env.js"; // must be first — see src/env.ts
import http from "node:http";
import { Mppx, stellar, Store } from "@stellar/mpp/channel/server";
import { usageToBaseUnits, baseUnitsToDecimalString } from "../pricing/pricingEngine.js";
import { buildResponseWords, countTokens, countHistoryTokens, type ChatTurn } from "./mockLlm.js";
import { isModelId, isReasoningEffort, type ModelId, type ReasoningEffort } from "../pricing/costTable.js";
import { handleComplete, parseCompleteBody } from "./chargeServer.js";
import { BadRequestError } from "./errors.js";

const TICK_WORDS = 8;
const MAX_BODY_BYTES = 64 * 1024; // defensive cap; a real conversation prompt is nowhere near this
const MAX_PROMPT_CHARS = 4_000;
const MAX_CONVERSATION_ID_CHARS = 128;
const MAX_HISTORY_TURNS = 50;
const MAX_HISTORY_CHARS_TOTAL = 20_000;
const DROP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding"]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const CHANNEL_CONTRACT = requireEnv("CHANNEL_CONTRACT");
const COMMITMENT_PUBLIC = requireEnv("COMMITMENT_PUBLIC");
const RECIPIENT_PUBLIC = requireEnv("RECIPIENT_PUBLIC");
const RECIPIENT_SECRET = requireEnv("RECIPIENT_SECRET");
const TOKEN_XLM_SAC = requireEnv("TOKEN_XLM_SAC");

const mppx = Mppx.create({
  secretKey: RECIPIENT_SECRET,
  methods: [
    stellar.channel({
      channel: CHANNEL_CONTRACT,
      commitmentKey: COMMITMENT_PUBLIC,
      network: (process.env.STELLAR_NETWORK ?? "stellar:testnet") as "stellar:testnet",
      recipient: RECIPIENT_PUBLIC,
      currency: TOKEN_XLM_SAC,
      feePayer: { envelopeSigner: RECIPIENT_SECRET },
      store: Store.memory(),
    }),
  ],
});

interface TickBody {
  conversationId: string;
  turnIndex: number;
  tickIndex: number;
  model: ModelId;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  /**
   * Prior turns, resent in full by the client on every request — the same
   * pattern real stateless chat-completion APIs use. This is what lets a
   * conversation switch models between turns while keeping context: the
   * server holds no transcript of its own, so there's nothing tying history
   * to a single model. See TECHNICAL_DESIGN.md §1 and §3.3.
   */
  history: ChatTurn[];
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) throw new BadRequestError("history must be an array");
  if (raw.length > MAX_HISTORY_TURNS) throw new BadRequestError(`history exceeds ${MAX_HISTORY_TURNS} turns`);

  let totalChars = 0;
  const history: ChatTurn[] = raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw new BadRequestError(`history[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    if (e.role !== "user" && e.role !== "assistant") throw new BadRequestError(`history[${i}].role must be "user" or "assistant"`);
    if (typeof e.content !== "string") throw new BadRequestError(`history[${i}].content must be a string`);
    if (e.role === "assistant" && e.model !== undefined && !isModelId(e.model)) {
      throw new BadRequestError(`history[${i}].model must be a supported model id if present`);
    }
    totalChars += e.content.length;
    return { role: e.role, content: e.content, model: e.role === "assistant" ? (e.model as ModelId | undefined) : undefined };
  });

  if (totalChars > MAX_HISTORY_CHARS_TOTAL) throw new BadRequestError(`history content exceeds ${MAX_HISTORY_CHARS_TOTAL} characters total`);
  return history;
}

function parseTickBody(raw: unknown): TickBody {
  if (typeof raw !== "object" || raw === null) throw new BadRequestError("body must be a JSON object");
  const body = raw as Record<string, unknown>;

  if (typeof body.conversationId !== "string" || body.conversationId.length === 0) {
    throw new BadRequestError("conversationId must be a non-empty string");
  }
  if (body.conversationId.length > MAX_CONVERSATION_ID_CHARS) {
    throw new BadRequestError(`conversationId exceeds ${MAX_CONVERSATION_ID_CHARS} characters`);
  }
  if (typeof body.turnIndex !== "number" || !Number.isInteger(body.turnIndex) || body.turnIndex < 0) {
    throw new BadRequestError("turnIndex must be a non-negative integer");
  }
  if (typeof body.tickIndex !== "number" || !Number.isInteger(body.tickIndex) || body.tickIndex < 0) {
    throw new BadRequestError("tickIndex must be a non-negative integer");
  }
  if (!isModelId(body.model)) throw new BadRequestError("model must be one of the supported model ids");
  if (!isReasoningEffort(body.reasoningEffort)) throw new BadRequestError("reasoningEffort must be one of: none, low, medium, high");
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw new BadRequestError("prompt must be a non-empty string");
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) throw new BadRequestError(`prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  const history = parseHistory(body.history ?? []);

  return {
    conversationId: body.conversationId,
    turnIndex: body.turnIndex,
    tickIndex: body.tickIndex,
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    prompt: body.prompt,
    history,
  };
}

/**
 * Per-conversation progress, enforcing strict turn/tick ordering so a
 * replayed or out-of-order request is rejected rather than silently
 * re-charged — generalizes the single-turn version of this check to a
 * conversation that can span many turns, each possibly on a different
 * model. Single-process, in-memory, same caveat as the mppx Store above
 * (see TECHNICAL_DESIGN.md and SECURITY_AUDIT.md HIGH-1).
 */
interface ConversationState {
  turnIndex: number;
  tickIndex: number;
  turnDone: boolean;
  /** Frozen total price (base units) of every turn that has already completed. */
  totalBaseUnitsThroughPriorTurns: bigint;
}

const conversations = new Map<string, ConversationState>();

function conversationStateKey(conversationId: string): string {
  return `${CHANNEL_CONTRACT}:${conversationId}`;
}

function checkSequencing(body: TickBody, state: ConversationState | undefined): void {
  if (!state) {
    if (body.turnIndex !== 0 || body.tickIndex !== 0) {
      throw new BadRequestError(
        `new conversation "${body.conversationId}" must start at turnIndex=0, tickIndex=0`,
      );
    }
    return;
  }
  if (!state.turnDone) {
    if (body.turnIndex !== state.turnIndex || body.tickIndex !== state.tickIndex + 1) {
      throw new BadRequestError(
        `expected turnIndex=${state.turnIndex}, tickIndex=${state.tickIndex + 1} (continuing the current turn); ` +
          `got turnIndex=${body.turnIndex}, tickIndex=${body.tickIndex}`,
      );
    }
    return;
  }
  if (body.turnIndex !== state.turnIndex + 1 || body.tickIndex !== 0) {
    throw new BadRequestError(
      `expected turnIndex=${state.turnIndex + 1}, tickIndex=0 (starting a new turn); ` +
        `got turnIndex=${body.turnIndex}, tickIndex=${body.tickIndex}`,
    );
  }
}

async function handleTick(request: Request, body: TickBody): Promise<Response> {
  const stateKey = conversationStateKey(body.conversationId);
  const state = conversations.get(stateKey);
  checkSequencing(body, state);

  const allWords = buildResponseWords({
    model: body.model,
    reasoningEffort: body.reasoningEffort,
    prompt: body.prompt,
    history: body.history,
  });

  // Full history is priced as input on every turn, the same way real
  // stateless chat-completion APIs charge for re-processing context on each
  // call — a longer conversation costs more per turn as it grows, which is
  // a real, not simulated, characteristic of this pricing model.
  const inputTokens = countHistoryTokens(body.history) + countTokens(body.prompt);

  // Clamped independently of the sequencing check above — see the
  // single-turn version of this comment in the pre-multi-turn implementation
  // (preserved in git history): usageToBaseUnits must never be called with
  // more output tokens than were actually generated, regardless of how
  // tickIndex was validated upstream. Defense in depth, not redundant.
  const start = Math.min(body.tickIndex * TICK_WORDS, allWords.length);
  const end = Math.min(start + TICK_WORDS, allWords.length);
  const tickWords = allWords.slice(start, end);
  const turnDone = end >= allWords.length;

  // `@stellar/mpp` channel `amount` is the INCREMENT added to the channel's
  // running cumulative total for this call, not the conversation's total
  // price — the server-side Store tracks the true cumulative.
  const turnPriceBefore = body.tickIndex === 0 ? 0n : usageToBaseUnits({ model: body.model, reasoningEffort: body.reasoningEffort, inputTokens, outputTokens: start });
  const turnPriceAfter = usageToBaseUnits({ model: body.model, reasoningEffort: body.reasoningEffort, inputTokens, outputTokens: end });
  const tickIncrementBaseUnits = turnPriceAfter - turnPriceBefore;
  const amount = baseUnitsToDecimalString(tickIncrementBaseUnits);

  const result = await mppx.channel({
    amount,
    description: `conversation ${body.conversationId} turn ${body.turnIndex} tick ${body.tickIndex} (${body.model})`,
  })(request);
  if (result.status === 402) return result.challenge;

  const priorTotal = state?.totalBaseUnitsThroughPriorTurns ?? 0n;
  const conversationTotalBaseUnits = priorTotal + turnPriceAfter;

  // Only advance progress once payment has actually verified — a request
  // that never completes payment must remain retryable at the same index.
  conversations.set(stateKey, {
    turnIndex: body.turnIndex,
    tickIndex: body.tickIndex,
    turnDone,
    totalBaseUnitsThroughPriorTurns: turnDone ? conversationTotalBaseUnits : priorTotal,
  });

  return result.withReceipt(
    Response.json({
      conversationId: body.conversationId,
      turnIndex: body.turnIndex,
      tickIndex: body.tickIndex,
      text: tickWords.join(""),
      turnDone,
      cumulativeOutputTokensThisTurn: end,
      tickPriceBaseUnits: tickIncrementBaseUnits.toString(),
      tickPriceXlm: amount,
      turnTotalBaseUnits: turnPriceAfter.toString(),
      turnTotalXlm: baseUnitsToDecimalString(turnPriceAfter),
      conversationTotalBaseUnits: conversationTotalBaseUnits.toString(),
      conversationTotalXlm: baseUnitsToDecimalString(conversationTotalBaseUnits),
    }),
  );
}

/** Reads the raw request body with a size cap, or returns null after writing a 413 response. */
async function readBodyWithCap(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      req.destroy();
      res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "request body too large" }));
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function buildFetchRequest(req: http.IncomingMessage, bodyBuffer: Buffer): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (DROP_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://localhost${req.url}`, { method: "POST", headers, body: new Uint8Array(bodyBuffer) });
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const responseBody = Buffer.from(await response.arrayBuffer());
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => (outHeaders[k] = v));
  res.writeHead(response.status, outHeaders);
  res.end(responseBody);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || (req.url !== "/v1/chat/tick" && req.url !== "/v1/chat/complete")) {
    res.writeHead(404).end();
    return;
  }

  const bodyBuffer = await readBodyWithCap(req, res);
  if (bodyBuffer === null) return; // 413 already sent

  let json: unknown;
  try {
    json = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    sendError(res, 400, "malformed JSON body");
    return;
  }

  try {
    if (req.url === "/v1/chat/tick") {
      const parsedBody = parseTickBody(json);
      const request = buildFetchRequest(req, bodyBuffer);
      await sendResponse(res, await handleTick(request, parsedBody));
    } else {
      const parsedBody = parseCompleteBody(json);
      const request = buildFetchRequest(req, bodyBuffer);
      await sendResponse(res, await handleComplete(request, parsedBody));
    }
  } catch (err) {
    if (err instanceof BadRequestError) {
      sendError(res, 400, err.message);
      return;
    }
    // Full detail server-side only — never echo raw error/stack text to an
    // untrusted client, since it can leak internal paths or config state.
    console.error(`[gateway] error handling ${req.url}:`, err);
    sendError(res, 500, "internal error");
  }
});

const port = Number(process.env.GATEWAY_PORT ?? 8787);
server.listen(port, () => {
  console.log(`Inference gateway listening on http://localhost:${port}`);
  console.log(`  POST /v1/chat/tick     — MPP Session, continuous multi-model chat (channel ${CHANNEL_CONTRACT})`);
  console.log(`  POST /v1/chat/complete — MPP Charge, one-off bounded agent access (recipient ${RECIPIENT_PUBLIC})`);
});

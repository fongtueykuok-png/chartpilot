import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Encodes the "risk-aware AI" rules from the product brief directly into the
// system prompt, since this is the one place that actually governs model
// output. Also told explicitly not to invent data outside what's passed in --
// indicators/trend are real now (see chart.js's M4 Analysis Engine slice),
// but the model should still say "not computed" if a field genuinely comes
// back empty rather than guessing.
//
// M5: two asset classes now share this one function (crypto via Kraken,
// stocks via Alpaca) -- the prompt is asset-class-neutral by default, with
// a short line appended per-request naming which market is active, since
// "trades 24/7" is true for crypto and false for stocks.
function buildSystemPrompt(assetClass: string): string {
  const marketNote =
    assetClass === "stocks"
      ? "This chart is a US stock (Alpaca/IEX feed, one exchange's volume, not the full consolidated tape). Markets have set trading hours -- don't assume 24/7 trading, and don't invent overnight price action outside market hours."
      : "This chart is a cryptocurrency (Kraken). Crypto trades 24/7 -- there is no market close.";

  return `You are the AI Copilot inside ChartPilot, a trading chart workspace. You answer questions about the chart context you're given below -- nothing else.

${marketNote}

Hard rules, never break these:
- Never say a trade is guaranteed, or that price "will" go up or down.
- Never tell the user to buy or sell.
- Never invent a confidence percentage.
- Never invent numbers, levels, or indicator values that are not present in the chart context. If something isn't in the context (e.g. no indicators computed yet), say that plainly instead of guessing.
- Frame analysis as scenarios, not predictions: "one reading is...", "this weakens if...".
- Mention what would invalidate the read when it's relevant to the question.
- You are an analysis assistant, not a financial adviser -- keep that in your tone, not as a repeated disclaimer.
- 2-4 sentences. This renders in a mobile chat panel, not a report.`;
}

interface ChartContext {
  symbol?: string | null;
  timeframe?: number | null;
  price?: number | null;
  recentHigh?: number | null;
  recentLow?: number | null;
  trend?: string | null;
  indicators?: Record<string, number>;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_ENTRIES = 10; // 5 exchanges
const MAX_MESSAGE_CHARS = 500; // same cheap cost guard as before, now per-turn
const PER_MINUTE_LIMIT = 6;
const PER_DAY_LIMIT_PER_IP = 60;
const GLOBAL_DAILY_LIMIT = 400; // hard circuit breaker on total spend if this URL ever gets shared/scraped

// Rate limiting via Netlify Blobs. Functions are stateless/ephemeral, so
// this is the only persistent place to count requests without standing up
// a database for a feature this small.
//
// No locking -- Blobs has none. Under real concurrency two requests can
// both read the same count and both write count+1, undercounting by one.
// That's fine for an abuse deterrent; it is not a precise ledger.
async function checkRateLimit(
  ip: string
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number; reason: string }> {
  const store = getStore("copilot-rate-limits", { consistency: "strong" });
  const now = new Date();
  const minuteBucket = now.toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
  const dayBucket = now.toISOString().slice(0, 10); // yyyy-mm-dd

  const ipKey = `ip:${ip}`;
  const globalKey = `global:${dayBucket}`;

  const [ipState, globalCount] = await Promise.all([
    store.get(ipKey, { type: "json" }),
    store.get(globalKey, { type: "json" }),
  ]);

  const minuteCount = ipState?.minuteBucket === minuteBucket ? ipState.minuteCount : 0;
  const dayCount = ipState?.dayBucket === dayBucket ? ipState.dayCount : 0;

  if (minuteCount >= PER_MINUTE_LIMIT) {
    return { ok: false, retryAfterSeconds: 60, reason: "You're sending messages a bit fast \u2014 wait a moment and try again." };
  }
  if (dayCount >= PER_DAY_LIMIT_PER_IP) {
    return { ok: false, retryAfterSeconds: 3600, reason: "Daily message limit reached for this connection. Try again tomorrow." };
  }
  if ((globalCount ?? 0) >= GLOBAL_DAILY_LIMIT) {
    return { ok: false, retryAfterSeconds: 3600, reason: "The copilot has hit its shared daily usage cap. Try again tomorrow." };
  }

  await Promise.all([
    store.setJSON(ipKey, { minuteBucket, minuteCount: minuteCount + 1, dayBucket, dayCount: dayCount + 1 }),
    store.setJSON(globalKey, (globalCount ?? 0) + 1),
  ]);

  return { ok: true };
}

// Never trust the client's own history cap -- this is a public POST
// endpoint, so a malformed or hand-crafted request has to degrade safely
// rather than reach the Anthropic call with bad shape.
function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: HistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as Record<string, unknown>).role;
    const content = (entry as Record<string, unknown>).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      cleaned.push({ role, content: content.trim().slice(0, MAX_MESSAGE_CHARS) });
    }
  }
  const capped = cleaned.slice(-MAX_HISTORY_ENTRIES);
  // The Anthropic Messages API requires the list to start with "user" --
  // drop any leading assistant turns that survive a tampered request.
  while (capped.length && capped[0].role !== "user") capped.shift();
  return capped;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY." }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const ip = context.ip || "unknown";
  const rateCheck = await checkRateLimit(ip);
  if (!rateCheck.ok) {
    return new Response(JSON.stringify({ error: rateCheck.reason }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(rateCheck.retryAfterSeconds) },
    });
  }

  let body: { history?: unknown; chartContext?: ChartContext; assetClass?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const history = sanitizeHistory(body.history);
  const lastTurn = history.at(-1);
  if (!lastTurn || lastTurn.role !== "user") {
    return new Response(JSON.stringify({ error: "No question found in the request." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const ctx = body.chartContext ?? {};
  const contextLine =
    `Chart context: symbol=${ctx.symbol ?? "unknown"}, timeframe=${ctx.timeframe ?? "unknown"}m, ` +
    `last price=${ctx.price ?? "unknown"}, recent high=${ctx.recentHigh ?? "unknown"}, ` +
    `recent low=${ctx.recentLow ?? "unknown"}, trend=${ctx.trend ?? "not computed"}, ` +
    `indicators=${JSON.stringify(ctx.indicators ?? {})}.`;

  // Fresh context rides on the newest question only -- earlier turns keep
  // whatever text they were sent with, instead of every turn being silently
  // rewritten with the latest price on every request.
  const messages = history.map((entry, i) => ({
    role: entry.role,
    content: i === history.length - 1 ? `${contextLine}\n\nTrader's question: ${entry.content}` : entry.content,
  }));

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: buildSystemPrompt(body.assetClass === "stocks" ? "stocks" : "crypto"),
        messages,
      }),
    });
  } catch {
    return new Response(JSON.stringify({ error: "Could not reach the model provider." }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    console.error("Anthropic API error:", anthropicRes.status, errText);
    return new Response(JSON.stringify({ error: "Model provider returned an error." }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await anthropicRes.json();
  const reply = data.content?.find((block: { type: string }) => block.type === "text")?.text ?? "No response generated.";

  return new Response(JSON.stringify({ reply }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/copilot",
};

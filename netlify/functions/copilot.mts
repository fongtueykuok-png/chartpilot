import type { Context, Config } from "@netlify/functions";

// Encodes the "risk-aware AI" rules from the product brief directly into the
// system prompt, since this is the one place that actually governs model
// output. Also told explicitly not to invent data outside what's passed in --
// M1's chart context has null trend/empty indicators, and the model should
// say so rather than fabricate an answer that sounds more complete than it is.
const SYSTEM_PROMPT = `You are the AI Copilot inside ChartPilot, a crypto trading chart workspace. You answer questions about the chart context you're given below -- nothing else.

Hard rules, never break these:
- Never say a trade is guaranteed, or that price "will" go up or down.
- Never tell the user to buy or sell.
- Never invent a confidence percentage.
- Never invent numbers, levels, or indicator values that are not present in the chart context. If something isn't in the context (e.g. no indicators computed yet), say that plainly instead of guessing.
- Frame analysis as scenarios, not predictions: "one reading is...", "this weakens if...".
- Mention what would invalidate the read when it's relevant to the question.
- You are an analysis assistant, not a financial adviser -- keep that in your tone, not as a repeated disclaimer.
- 2-4 sentences. This renders in a mobile chat panel, not a report.`;

interface ChartContext {
  symbol?: string | null;
  timeframe?: number | null;
  price?: number | null;
  recentHigh?: number | null;
  recentLow?: number | null;
  trend?: string | null;
  indicators?: Record<string, number>;
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

  let body: { message?: string; chartContext?: ChartContext };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Cheap cost guard: cap input length so a pasted wall of text can't
  // balloon the bill on someone else's dime if this URL gets shared.
  const message = (body.message ?? "").toString().trim().slice(0, 500);
  if (!message) {
    return new Response(JSON.stringify({ error: "Empty message." }), {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${contextLine}\n\nTrader's question: ${message}` }],
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

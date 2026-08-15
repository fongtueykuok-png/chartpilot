import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Proxies Alpaca's REST API for US equities. Alpaca's WebSocket needs the
// secret key sent FROM the browser to authenticate -- unlike Kraken's
// anonymous public WS, that would leak the key to anyone who opens devtools.
// So this polls REST server-side instead of a true push stream. Real
// tradeoff, not hidden: prices are as fresh as the client's poll interval
// (stocks-data.js polls every 8s), not tick-by-tick. See README note.
//
// Two Trading API bases are in play, verified against current docs rather
// than assumed, because they don't share a version: assets is v2, clock is
// v3, and both live on paper-api (not data.alpaca.markets -- assets/clock
// are account endpoints, not market-data ones).
const TRADING_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

const PER_MINUTE_LIMIT = 20; // generous vs copilot's 6 -- this just proxies quotes, cheap
const PER_DAY_LIMIT_PER_IP = 2000;
const GLOBAL_DAILY_LIMIT = 15000; // Alpaca free tier is 200 req/min shared across ALL visitors --
// this is a soft brake, not a promise; real headroom depends on concurrent traffic.

const ASSETS_CACHE_KEY = "assets-cache";
const ASSETS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Alpaca's tradable-asset list barely changes day to day

interface CachedAsset {
  s: string; // symbol
  n: string; // name
  e: string; // exchange
}

function authHeaders(keyId: string, secret: string) {
  return { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
}

// Same Blobs-counter pattern as copilot.mts's rate limiter, separate store
// so the two features don't share a budget. See that file for the
// no-locking/undercount-by-one caveat -- same tradeoff, same reasoning.
async function checkRateLimit(
  ip: string
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number; reason: string }> {
  const store = getStore("stocks-rate-limits", { consistency: "strong" });
  const now = new Date();
  const minuteBucket = now.toISOString().slice(0, 16);
  const dayBucket = now.toISOString().slice(0, 10);

  const ipKey = `ip:${ip}`;
  const globalKey = `global:${dayBucket}`;

  const [ipState, globalCount] = await Promise.all([
    store.get(ipKey, { type: "json" }),
    store.get(globalKey, { type: "json" }),
  ]);

  const minuteCount = ipState?.minuteBucket === minuteBucket ? ipState.minuteCount : 0;
  const dayCount = ipState?.dayBucket === dayBucket ? ipState.dayCount : 0;

  if (minuteCount >= PER_MINUTE_LIMIT) {
    return { ok: false, retryAfterSeconds: 60, reason: "Polling too fast." };
  }
  if (dayCount >= PER_DAY_LIMIT_PER_IP) {
    return { ok: false, retryAfterSeconds: 3600, reason: "Daily limit reached for this connection." };
  }
  if ((globalCount ?? 0) >= GLOBAL_DAILY_LIMIT) {
    return { ok: false, retryAfterSeconds: 3600, reason: "Shared daily usage cap reached." };
  }

  await Promise.all([
    store.setJSON(ipKey, { minuteBucket, minuteCount: minuteCount + 1, dayBucket, dayCount: dayCount + 1 }),
    store.setJSON(globalKey, (globalCount ?? 0) + 1),
  ]);

  return { ok: true };
}

function jsonError(message: string, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// Loads the tradable-assets list from Blobs, refreshing from Alpaca if
// missing or stale. Filtered to the major listed exchanges (NASDAQ, NYSE,
// ARCA, AMEX, BATS) -- Alpaca's raw list also includes thousands of OTC
// tickers, which would flood search results with illiquid names most
// people have never heard of. That's a real narrowing, not the literal
// entire market -- traded off deliberately for search quality.
async function loadAssets(keyId: string, secret: string): Promise<CachedAsset[]> {
  const store = getStore("stocks-assets-cache", { consistency: "strong" });
  const cached = await store.get(ASSETS_CACHE_KEY, { type: "json" });
  if (cached && Date.now() - cached.fetchedAt < ASSETS_CACHE_MAX_AGE_MS) {
    return cached.assets;
  }

  const res = await fetch(`${TRADING_BASE}/v2/assets?status=active&asset_class=us_equity`, {
    headers: authHeaders(keyId, secret),
  });
  if (!res.ok) {
    // Serve a stale cache rather than nothing, if one exists -- a slightly
    // old symbol list beats a broken search box.
    if (cached) return cached.assets;
    throw new Error(`Alpaca assets fetch failed: ${res.status}`);
  }

  const MAJOR_EXCHANGES = new Set(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"]);
  const raw: Array<{ symbol: string; name: string; exchange: string; tradable: boolean }> = await res.json();
  const assets: CachedAsset[] = raw
    .filter((a) => a.tradable && MAJOR_EXCHANGES.has(a.exchange))
    .map((a) => ({ s: a.symbol, n: a.name, e: a.exchange }));

  await store.setJSON(ASSETS_CACHE_KEY, { fetchedAt: Date.now(), assets });
  return assets;
}

function searchAssets(assets: CachedAsset[], query: string, limit = 20): CachedAsset[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const symbolExact: CachedAsset[] = [];
  const symbolPrefix: CachedAsset[] = [];
  const nameMatch: CachedAsset[] = [];
  for (const a of assets) {
    if (a.s === q) symbolExact.push(a);
    else if (a.s.startsWith(q)) symbolPrefix.push(a);
    else if (a.n.toUpperCase().includes(q)) nameMatch.push(a);
    if (symbolExact.length + symbolPrefix.length + nameMatch.length >= limit * 3) break; // don't scan the whole list once we clearly have enough
  }
  return [...symbolExact, ...symbolPrefix, ...nameMatch].slice(0, limit);
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  const keyId = Netlify.env.get("ALPACA_API_KEY_ID");
  const secret = Netlify.env.get("ALPACA_API_SECRET_KEY");
  if (!keyId || !secret) {
    return jsonError("Server is missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.", 500);
  }

  const ip = context.ip || "unknown";
  const rateCheck = await checkRateLimit(ip);
  if (!rateCheck.ok) {
    return jsonError(rateCheck.reason, 429, { "retry-after": String(rateCheck.retryAfterSeconds) });
  }

  try {
    if (action === "search") {
      const q = url.searchParams.get("q") ?? "";
      const assets = await loadAssets(keyId, secret);
      return new Response(JSON.stringify({ results: searchAssets(assets, q) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (action === "clock") {
      const res = await fetch(`${TRADING_BASE}/v3/clock`, { headers: authHeaders(keyId, secret) });
      if (!res.ok) return jsonError("Alpaca clock request failed.", 502);
      const clock = await res.json();
      return new Response(JSON.stringify(clock), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (action === "quote") {
      // Snapshots (not bars/latest) deliberately: one call gives latestTrade
      // (live price), minuteBar (feeds the chart's live-updating last
      // candle), and prevDailyBar (needed to compute correct %-change
      // against yesterday's close, not against today's own open).
      const symbols = url.searchParams.get("symbols") ?? "";
      if (!symbols) return jsonError("Missing symbols param.", 400);
      const res = await fetch(
        `${DATA_BASE}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols)}&feed=iex`,
        { headers: authHeaders(keyId, secret) }
      );
      if (!res.ok) return jsonError("Alpaca quote request failed.", 502);
      const snapshots: Record<string, any> = await res.json();

      const quotes: Record<string, { last: number | null; prevClose: number | null; minuteBar: unknown }> = {};
      for (const [symbol, snap] of Object.entries(snapshots ?? {})) {
        const last = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? null;
        const prevClose = snap?.prevDailyBar?.c ?? null;
        quotes[symbol] = { last, prevClose, minuteBar: snap?.minuteBar ?? null };
      }

      return new Response(JSON.stringify({ quotes }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (action === "history") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const timeframe = url.searchParams.get("timeframe") ?? "1Day";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
      if (!symbol) return jsonError("Missing symbol param.", 400);
      const res = await fetch(
        `${DATA_BASE}/v2/stocks/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(
          timeframe
        )}&limit=${limit}&sort=asc&feed=iex`,
        { headers: authHeaders(keyId, secret) }
      );
      if (!res.ok) return jsonError("Alpaca history request failed.", 502);
      const data = await res.json();
      return new Response(JSON.stringify({ bars: data.bars?.[symbol] ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return jsonError("Unknown action.", 400);
  } catch (err) {
    console.error("stocks.mts error:", err);
    return jsonError("Unexpected server error.", 500);
  }
};

export const config: Config = {
  path: "/api/stocks",
};

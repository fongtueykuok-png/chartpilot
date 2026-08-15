// stocks-data.js
// Polls Alpaca via /api/stocks (a Netlify Function proxy) instead of a
// direct browser WebSocket like market-data.js's Kraken connection.
// Reason: Alpaca's WS needs the secret key sent FROM the client to
// authenticate. Kraken's WS is anonymous/public -- no secret ever left the
// browser there. Doing the same for Alpaca would leak the key to anyone
// who opens devtools. Real tradeoff, not hidden: prices are as fresh as
// POLL_INTERVAL_MS below, not tick-by-tick. One combined request per poll
// covers the watchlist + active chart symbol, batched, to keep request
// count flat regardless of watchlist size (Alpaca bills by request, not by
// symbol, on this endpoint).

const POLL_INTERVAL_MS = 8000;
const API_BASE = '/api/stocks';

let status = 'connecting';
const statusListeners = new Set();
function setStatus(next) {
  if (next === status) return;
  status = next;
  statusListeners.forEach((fn) => fn(status));
}

let tickerSymbols = [];
let tickerCallback = null;
let ohlcSymbol = null;
let ohlcCallback = null;
let pollTimer = null;

async function fetchJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${url} -> ${res.status}`);
  return body;
}

// Alpaca timeframe strings are "<n>Min" / "<n>Hour" / "<n>Day" -- the
// app's timeframe list is in raw minutes, so this is a one-way mapping,
// not a general unit converter.
function alpacaTimeframe(minutes) {
  if (minutes < 60) return `${minutes}Min`;
  if (minutes < 1440) return `${minutes / 60}Hour`;
  return `${minutes / 1440}Day`;
}

// Alpaca bar fields are single-letter (t/o/h/l/c/v) -- normalized here to
// the same shape Kraken's bars use ({interval_begin, open, high, low,
// close, volume}) so chart.js never has to know which source it's reading.
function normalizeBar(b) {
  return { interval_begin: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0 };
}

async function loadHistory(symbol, minutes) {
  const timeframe = alpacaTimeframe(minutes);
  const data = await fetchJSON(
    `${API_BASE}?action=history&symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&limit=200`
  );
  return (data.bars ?? []).map(normalizeBar);
}

async function poll() {
  const symbols = Array.from(new Set([...tickerSymbols, ...(ohlcSymbol ? [ohlcSymbol] : [])]));
  if (symbols.length === 0) return;

  try {
    const data = await fetchJSON(`${API_BASE}?action=quote&symbols=${encodeURIComponent(symbols.join(','))}`);
    setStatus('live');

    for (const symbol of tickerSymbols) {
      const q = data.quotes?.[symbol];
      if (!q || q.last == null) continue;
      const changePct = q.prevClose ? ((q.last - q.prevClose) / q.prevClose) * 100 : 0;
      tickerCallback?.('update', { symbol, last: q.last, change_pct: changePct });
    }

    if (ohlcSymbol && ohlcCallback) {
      const q = data.quotes?.[ohlcSymbol];
      if (q?.minuteBar) {
        ohlcCallback('update', [{ symbol: ohlcSymbol, ...normalizeBar(q.minuteBar) }]);
      }
    }
  } catch {
    setStatus('reconnecting');
  }
}

export function connectAlpaca() {
  setStatus('connecting');
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  poll();
}

export function disconnectAlpaca() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function onStatusChange(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

export function subscribeTicker(symbols, callback) {
  tickerSymbols = symbols;
  tickerCallback = callback;
  return () => {
    tickerSymbols = [];
    tickerCallback = null;
  };
}

// Same signature as market-data.js's subscribeOHLC (symbol, minutes,
// callback) -> unsubscribe fn, so chart.js can treat both sources
// identically. First call fires an immediate history load as the
// 'snapshot' event; live updates arrive via the shared poll() above.
export function subscribeOHLC(symbol, minutes, callback) {
  ohlcSymbol = symbol;
  ohlcCallback = callback;
  loadHistory(symbol, minutes)
    .then((bars) => callback('snapshot', bars.map((b) => ({ ...b, symbol }))))
    .catch(() => setStatus('reconnecting'));
  return () => {
    if (ohlcSymbol === symbol) {
      ohlcSymbol = null;
      ohlcCallback = null;
    }
  };
}

export async function searchStocks(query) {
  if (!query.trim()) return [];
  const data = await fetchJSON(`${API_BASE}?action=search&q=${encodeURIComponent(query)}`);
  return data.results ?? [];
}

export async function getMarketClock() {
  return fetchJSON(`${API_BASE}?action=clock`);
}

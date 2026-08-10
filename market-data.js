// market-data.js
// Kraken WebSocket v2 public market data. This is REAL live data (no API key,
// no paid tier) -- not a simulation. Endpoint + message shapes verified against
// docs.kraken.com/api/docs/websocket-v2 (ohlc, ticker) on 2026-08-10.
//
// CAVEAT: not exercised against a live socket from the build environment --
// kraken.com is outside its network allowlist, so this has only been checked
// against documented examples, not a running connection. Test in a real
// browser before trusting it blindly.

const WS_URL = 'wss://ws.kraken.com/v2';
const MAX_BACKOFF_MS = 15000;

let socket = null;
let backoffMs = 1000;
let reconnectTimer = null;
let manuallyClosed = false;

const statusListeners = new Set();
const ohlcListeners = new Map(); // `${symbol}:${interval}` -> Set<fn(type, bars[])>
const tickerListeners = new Map(); // symbol -> Set<fn(type, tick)>
const activeSubscriptions = new Map(); // key -> subscribe params, replayed on reconnect

function setStatus(state) {
  statusListeners.forEach((fn) => fn(state));
}

export function onStatusChange(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function ohlcKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.channel === 'heartbeat') return;

  if (msg.method === 'subscribe' && msg.success === false) {
    console.warn('[market-data] subscribe failed:', msg.error || msg);
    return;
  }

  if (msg.channel === 'ohlc' && Array.isArray(msg.data)) {
    // A single message can carry bars for more than one (symbol, interval)
    // pair, so group by key before dispatching -- each listener gets only
    // the bars relevant to the subscription it registered.
    const byKey = new Map();
    for (const bar of msg.data) {
      const key = ohlcKey(bar.symbol, bar.interval);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(bar);
    }
    byKey.forEach((bars, key) => {
      ohlcListeners.get(key)?.forEach((fn) => fn(msg.type, bars));
    });
    return;
  }

  if (msg.channel === 'ticker' && Array.isArray(msg.data)) {
    for (const tick of msg.data) {
      tickerListeners.get(tick.symbol)?.forEach((fn) => fn(msg.type, tick));
    }
  }
}

function connect() {
  manuallyClosed = false;
  setStatus('connecting');
  socket = new WebSocket(WS_URL);

  socket.addEventListener('open', () => {
    backoffMs = 1000;
    setStatus('live');
    // Replay every subscription that was active before this (re)connect.
    activeSubscriptions.forEach((params) => send({ method: 'subscribe', params }));
  });

  socket.addEventListener('message', (event) => handleMessage(event.data));

  socket.addEventListener('close', () => {
    if (manuallyClosed) return;
    setStatus('offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' fires immediately after on a failed connection attempt;
    // that handler owns scheduling the reconnect.
    setStatus('offline');
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    connect();
  }, backoffMs);
}

export function connectKraken() {
  if (socket) return;
  connect();
}

export function subscribeOHLC(symbol, interval, onUpdate) {
  const key = ohlcKey(symbol, interval);
  if (!ohlcListeners.has(key)) ohlcListeners.set(key, new Set());
  ohlcListeners.get(key).add(onUpdate);

  const params = { channel: 'ohlc', symbol: [symbol], interval };
  activeSubscriptions.set(key, params);
  send({ method: 'subscribe', params });

  return () => unsubscribeOHLC(symbol, interval, onUpdate);
}

export function unsubscribeOHLC(symbol, interval, onUpdate) {
  const key = ohlcKey(symbol, interval);
  const listeners = ohlcListeners.get(key);
  if (!listeners) return;
  listeners.delete(onUpdate);
  if (listeners.size === 0) {
    ohlcListeners.delete(key);
    activeSubscriptions.delete(key);
    send({ method: 'unsubscribe', params: { channel: 'ohlc', symbol: [symbol], interval } });
  }
}

export function subscribeTicker(symbols, onUpdate) {
  const key = `ticker:${symbols.join(',')}`;
  symbols.forEach((s) => {
    if (!tickerListeners.has(s)) tickerListeners.set(s, new Set());
    tickerListeners.get(s).add(onUpdate);
  });

  const params = { channel: 'ticker', symbol: symbols };
  activeSubscriptions.set(key, params);
  send({ method: 'subscribe', params });

  return () => {
    symbols.forEach((s) => tickerListeners.get(s)?.delete(onUpdate));
    activeSubscriptions.delete(key);
    send({ method: 'unsubscribe', params: { channel: 'ticker', symbol: symbols } });
  };
}

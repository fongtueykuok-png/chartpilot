// app.js
import * as krakenData from './market-data.js';
import * as stocksData from './stocks-data.js';
import { createChartController } from './chart.js';
import { initCopilot } from './copilot.js';

const TIMEFRAMES = [
  { label: '1m', minutes: 1 },
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1H', minutes: 60 },
  { label: '4H', minutes: 240 },
  { label: '1D', minutes: 1440 },
];

// M5: multi-asset-class. Stocks (Alpaca, US equities, IEX feed, free) sit
// alongside the original crypto (Kraken) support -- neither replaces the
// other. Crypto's watchlist stays a fixed curated 5; stocks starts with a
// curated 18 across sectors but is searchable/extensible up to
// maxWatchlist, since Alpaca's tradable universe is thousands of tickers
// wide and a hardcoded list would undersell what's actually reachable.
const ASSET_CLASSES = {
  crypto: {
    label: 'Crypto',
    sourceLabel: 'Kraken',
    baseWatchlist: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'DOGE/USD'],
    defaultSymbol: 'BTC/USD',
    defaultInterval: 60,
    connect: krakenData.connectKraken,
    disconnect: null, // Kraken's WS is meant to stay open -- crypto is 24/7, no reason to tear it down
    subscribeTicker: krakenData.subscribeTicker,
    subscribeOHLC: krakenData.subscribeOHLC,
    onStatusChange: krakenData.onStatusChange,
    hasMarketHours: false,
    searchable: false,
    maxWatchlist: 5,
  },
  stocks: {
    label: 'Stocks',
    sourceLabel: 'Alpaca \u00b7 IEX',
    baseWatchlist: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'JPM', 'V', 'WMT', 'JNJ', 'PG', 'XOM', 'KO', 'DIS', 'NFLX', 'AMD', 'BA'],
    defaultSymbol: 'AAPL',
    defaultInterval: 60,
    connect: stocksData.connectAlpaca,
    disconnect: stocksData.disconnectAlpaca, // paused when not the active tab -- Alpaca's free-tier request budget is shared across every visitor
    subscribeTicker: stocksData.subscribeTicker,
    subscribeOHLC: stocksData.subscribeOHLC,
    onStatusChange: stocksData.onStatusChange,
    hasMarketHours: true,
    searchable: true,
    maxWatchlist: 40,
  },
};

const CLASS_STORAGE_KEY = 'chartpilot:asset-class';
const STOCKS_WATCHLIST_KEY = 'chartpilot:stocks-watchlist';

function viewStorageKey(cls) {
  return `chartpilot:last-view:${cls}`;
}

// Remembers the last symbol/timeframe per asset class across reloads.
// Validated against that class's current watchlist/timeframe lists so a
// stale value can't leave the app pointed at a combo it can't render.
function loadSavedView(cls) {
  try {
    const parsed = JSON.parse(localStorage.getItem(viewStorageKey(cls)));
    if (parsed && TIMEFRAMES.some((tf) => tf.minutes === parsed.interval)) return parsed;
  } catch {
    // corrupted or old-shape value -- fall back to defaults
  }
  return null;
}

function saveView() {
  try {
    localStorage.setItem(viewStorageKey(currentClass), JSON.stringify({ symbol: activeSymbol, interval: activeInterval }));
  } catch {
    // private browsing / storage disabled -- not worth surfacing to the user
  }
}

function loadStocksWatchlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STOCKS_WATCHLIST_KEY));
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
  } catch {
    // ignore
  }
  return ASSET_CLASSES.stocks.baseWatchlist.slice();
}

function saveStocksWatchlist() {
  try {
    localStorage.setItem(STOCKS_WATCHLIST_KEY, JSON.stringify(stocksWatchlist));
  } catch {
    // private browsing / storage disabled
  }
}

function loadSavedClass() {
  const v = localStorage.getItem(CLASS_STORAGE_KEY);
  return v === 'stocks' ? 'stocks' : 'crypto';
}

// --- State ---
let currentClass = loadSavedClass();
let stocksWatchlist = loadStocksWatchlist();
const initialSaved = loadSavedView(currentClass);
let activeSymbol = initialSaved?.symbol ?? ASSET_CLASSES[currentClass].defaultSymbol;
let activeInterval = initialSaved?.interval ?? ASSET_CLASSES[currentClass].defaultInterval;
let connectionStatus = 'connecting';
let lastHeaderPrice = null;
let unsubscribeTickerFn = null;
let marketClock = null;
let marketClockTimer = null;

function activeConfig() {
  return ASSET_CLASSES[currentClass];
}

function activeWatchlist() {
  return currentClass === 'stocks' ? stocksWatchlist : activeConfig().baseWatchlist;
}

// --- DOM ---
const chartContainer = document.getElementById('chart-container');
const chartLoading = document.getElementById('chart-loading');
const statusDot = document.querySelector('#conn-status .status-dot');
const statusText = document.querySelector('#conn-status .status-text');
const symbolNameEl = document.getElementById('active-symbol');
const livePriceEl = document.getElementById('live-price');
const priceChangeEl = document.getElementById('price-change');
const timeframeGroup = document.getElementById('timeframe-group');
const watchlistEl = document.getElementById('watchlist');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const copilotBadge = document.getElementById('copilot-badge');
const classToggleEl = document.getElementById('class-toggle');
const searchWrapEl = document.getElementById('symbol-search-wrap');
const searchInputEl = document.getElementById('symbol-search-input');
const searchResultsEl = document.getElementById('symbol-search-results');

let chartController = null;
try {
  chartController = createChartController(chartContainer, {
    onData: () => chartLoading.classList.add('hidden'),
  });
} catch (err) {
  console.error('Chart init failed:', err);
  chartLoading.textContent = 'Chart failed to load \u2014 try refreshing';
  chartLoading.classList.add('error');
}

const CHART_LOADING_TEXT = 'Loading chart data\u2026';

// Called right before every fresh subscribe (symbol/timeframe/class switch)
// so a leftover error message from a previous failed load doesn't linger
// on screen for a switch that hasn't even had a chance to succeed or fail
// yet. updateChartLoadingMessage() below is what escalates it back to an
// error state if this new attempt also fails.
function resetChartLoading() {
  chartLoading.textContent = CHART_LOADING_TEXT;
  chartLoading.classList.remove('error');
  chartLoading.classList.remove('hidden');
}

// --- Connection + market-hours status display ---
function formatClockTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function updateStatusDisplay() {
  const config = activeConfig();
  if (config.hasMarketHours && marketClock && marketClock.is_open === false) {
    statusDot.dataset.state = 'closed';
    statusText.textContent = marketClock.next_open ? `Market closed \u00b7 reopens ${formatClockTime(marketClock.next_open)}` : 'Market closed';
    copilotBadge.textContent = 'market closed';
    copilotBadge.dataset.live = 'false';
    return;
  }
  statusDot.dataset.state = connectionStatus;
  statusText.textContent =
    connectionStatus === 'live' ? `Live \u00b7 ${config.sourceLabel}` : connectionStatus === 'connecting' ? 'Connecting\u2026' : 'Reconnecting\u2026';
  copilotBadge.textContent = connectionStatus === 'live' ? 'watching chart' : 'not connected';
  copilotBadge.dataset.live = String(connectionStatus === 'live');
}

// Reflects connection trouble onto the chart pane itself, not just the
// topbar dot -- otherwise a hard failure (e.g. Alpaca creds not configured
// yet) just leaves "Loading chart data…" on screen forever with nothing to
// tell it apart from a normal brief load. Only touches the overlay while
// it's still showing (i.e. no data has come in yet for the current
// symbol) -- once real bars have rendered, a later poll hiccup shouldn't
// yank the chart back into an error state over a chart that's already
// live and up to date.
function updateChartLoadingMessage() {
  if (chartLoading.classList.contains('hidden')) return;
  if (connectionStatus === 'reconnecting' || connectionStatus === 'offline') {
    const detail = currentClass === 'stocks' ? stocksData.getLastError() : null;
    chartLoading.textContent = detail || 'Data unavailable \u2014 retrying\u2026';
    chartLoading.classList.add('error');
  } else {
    chartLoading.textContent = CHART_LOADING_TEXT;
    chartLoading.classList.remove('error');
  }
}

function handleStatus(cls, state) {
  if (cls !== currentClass) return; // ignore updates from the inactive data source
  connectionStatus = state;
  updateStatusDisplay();
  updateChartLoadingMessage();
}
krakenData.onStatusChange((state) => handleStatus('crypto', state));
stocksData.onStatusChange((state) => handleStatus('stocks', state));

async function refreshMarketClock() {
  if (!activeConfig().hasMarketHours) return;
  try {
    marketClock = await stocksData.getMarketClock();
  } catch {
    marketClock = null;
  }
  updateStatusDisplay();
}

function startMarketClockPolling() {
  stopMarketClockPolling();
  refreshMarketClock();
  marketClockTimer = setInterval(refreshMarketClock, 60000);
}

function stopMarketClockPolling() {
  if (marketClockTimer) clearInterval(marketClockTimer);
  marketClockTimer = null;
  marketClock = null;
}

// --- Timeframe controls ---
function renderTimeframes() {
  timeframeGroup.innerHTML = '';
  TIMEFRAMES.forEach((tf) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tf-btn';
    btn.textContent = tf.label;
    btn.setAttribute('aria-pressed', String(tf.minutes === activeInterval));
    btn.addEventListener('click', () => switchTimeframe(tf.minutes));
    timeframeGroup.appendChild(btn);
  });
}

function switchTimeframe(minutes) {
  if (minutes === activeInterval) return;
  activeInterval = minutes;
  renderTimeframes();
  resetChartLoading();
  chartController?.setSymbolTimeframe(activeSymbol, activeInterval, activeConfig().subscribeOHLC);
  saveView();
}

function switchSymbol(symbol) {
  if (symbol === activeSymbol) return;
  activeSymbol = symbol;
  symbolNameEl.textContent = symbol;
  lastHeaderPrice = null;
  resetChartLoading();
  chartController?.setSymbolTimeframe(activeSymbol, activeInterval, activeConfig().subscribeOHLC);
  document.querySelectorAll('.watch-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.symbol === symbol));
  });
  saveView();
}

// --- Asset class switching ---
function renderClassToggle() {
  classToggleEl.innerHTML = '';
  Object.entries(ASSET_CLASSES).forEach(([key, cfg]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'class-btn';
    btn.textContent = cfg.label;
    btn.setAttribute('aria-pressed', String(key === currentClass));
    btn.addEventListener('click', () => switchAssetClass(key));
    classToggleEl.appendChild(btn);
  });
}

function switchAssetClass(cls) {
  if (cls === currentClass || !ASSET_CLASSES[cls]) return;
  const prevConfig = activeConfig();
  prevConfig.disconnect?.();
  if (unsubscribeTickerFn) unsubscribeTickerFn();
  stopMarketClockPolling();
  closeSearchResults();

  currentClass = cls;
  localStorage.setItem(CLASS_STORAGE_KEY, cls);
  const config = activeConfig();

  const saved = loadSavedView(cls);
  activeSymbol = saved?.symbol ?? config.defaultSymbol;
  activeInterval = saved?.interval ?? config.defaultInterval;

  searchWrapEl.classList.toggle('hidden', !config.searchable);
  symbolNameEl.textContent = activeSymbol;
  lastHeaderPrice = null;
  connectionStatus = 'connecting';

  renderClassToggle();
  renderTimeframes();
  renderWatchlist();
  updateStatusDisplay();

  config.connect?.();
  if (config.hasMarketHours) startMarketClockPolling();

  resetChartLoading();
  chartController?.setSymbolTimeframe(activeSymbol, activeInterval, config.subscribeOHLC);
  unsubscribeTickerFn = config.subscribeTicker(activeWatchlist(), (type, tick) => updateWatchlistRow(tick));
  saveView();
}

// --- Watchlist ---
function renderWatchlist() {
  watchlistEl.innerHTML = '';
  activeWatchlist().forEach((symbol) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'watch-chip';
    chip.dataset.symbol = symbol;
    chip.setAttribute('aria-pressed', String(symbol === activeSymbol));
    chip.innerHTML = `
      <span class="wc-symbol">${symbol}</span>
      <span class="wc-price">\u2014</span>
      <span class="wc-change">\u2014</span>
    `;
    chip.addEventListener('click', () => switchSymbol(symbol));
    watchlistEl.appendChild(chip);
  });
}

function formatPrice(value) {
  if (value == null) return '\u2014';
  const decimals = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function updateHeaderPrice(tick) {
  livePriceEl.textContent = formatPrice(tick.last);
  priceChangeEl.textContent = `${tick.change_pct >= 0 ? '+' : ''}${tick.change_pct.toFixed(2)}%`;
  priceChangeEl.classList.toggle('up', tick.change_pct >= 0);
  priceChangeEl.classList.toggle('down', tick.change_pct < 0);

  if (lastHeaderPrice !== null) {
    livePriceEl.classList.remove('flash-up', 'flash-down');
    livePriceEl.classList.add(tick.last >= lastHeaderPrice ? 'flash-up' : 'flash-down');
  }
  lastHeaderPrice = tick.last;
}

function updateWatchlistRow(tick) {
  const chip = watchlistEl.querySelector(`[data-symbol="${tick.symbol}"]`);
  if (!chip) return;
  chip.querySelector('.wc-price').textContent = formatPrice(tick.last);
  const changeEl = chip.querySelector('.wc-change');
  changeEl.textContent = `${tick.change_pct >= 0 ? '+' : ''}${tick.change_pct.toFixed(2)}%`;
  changeEl.classList.toggle('up', tick.change_pct >= 0);
  changeEl.classList.toggle('down', tick.change_pct < 0);

  if (tick.symbol === activeSymbol) updateHeaderPrice(tick);
}

// --- Symbol search (stocks only) ---
// Alpaca's tradable universe is thousands of tickers -- searched server-side
// (see /api/stocks?action=search) rather than shipping the whole list to
// the browser. Selecting a result both charts it and pins it to the
// watchlist (capped at maxWatchlist) so it keeps ticking after the search
// box closes.
let searchDebounceTimer = null;

function closeSearchResults() {
  searchResultsEl.innerHTML = '';
  searchResultsEl.classList.add('hidden');
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (results.length === 0) {
    searchResultsEl.classList.add('hidden');
    return;
  }
  results.forEach((r) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-result';
    item.innerHTML = `<span class="sr-symbol">${r.s}</span><span class="sr-name">${r.n}</span>`;
    item.addEventListener('click', () => selectSearchResult(r.s));
    searchResultsEl.appendChild(item);
  });
  searchResultsEl.classList.remove('hidden');
}

function selectSearchResult(symbol) {
  if (!stocksWatchlist.includes(symbol) && stocksWatchlist.length < activeConfig().maxWatchlist) {
    stocksWatchlist = [...stocksWatchlist, symbol];
    saveStocksWatchlist();
    renderWatchlist();
    if (unsubscribeTickerFn) unsubscribeTickerFn();
    unsubscribeTickerFn = activeConfig().subscribeTicker(activeWatchlist(), (type, tick) => updateWatchlistRow(tick));
  }
  searchInputEl.value = '';
  closeSearchResults();
  switchSymbol(symbol);
}

searchInputEl.addEventListener('input', () => {
  const query = searchInputEl.value.trim();
  clearTimeout(searchDebounceTimer);
  if (!query) {
    closeSearchResults();
    return;
  }
  searchDebounceTimer = setTimeout(async () => {
    try {
      const results = await stocksData.searchStocks(query);
      renderSearchResults(results);
    } catch {
      closeSearchResults();
    }
  }, 250);
});

document.addEventListener('click', (e) => {
  if (!searchWrapEl.contains(e.target)) closeSearchResults();
});

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', () => chartController?.toggleFullscreen());

// --- Copilot responsive mode: popover (mobile sheet) vs static grid item (desktop) ---
const copilotEl = document.getElementById('copilot');
const desktopQuery = window.matchMedia('(min-width: 901px)');
function syncCopilotMode(e) {
  if (e.matches && copilotEl.hasAttribute('popover')) {
    if (copilotEl.matches(':popover-open')) copilotEl.hidePopover();
    copilotEl.removeAttribute('popover');
  } else if (!e.matches && !copilotEl.hasAttribute('popover')) {
    copilotEl.setAttribute('popover', 'manual');
  }
}
desktopQuery.addEventListener('change', syncCopilotMode);
syncCopilotMode(desktopQuery);

// --- Init ---
renderClassToggle();
renderTimeframes();
renderWatchlist();
searchWrapEl.classList.toggle('hidden', !activeConfig().searchable);
symbolNameEl.textContent = activeSymbol;
updateStatusDisplay();

initCopilot({
  getChartContext: () => chartController?.getContext() ?? null,
  getConnectionStatus: () => connectionStatus,
  getAssetClass: () => currentClass,
});

activeConfig().connect?.();
if (activeConfig().hasMarketHours) startMarketClockPolling();
unsubscribeTickerFn = activeConfig().subscribeTicker(activeWatchlist(), (type, tick) => updateWatchlistRow(tick));
chartController?.setSymbolTimeframe(activeSymbol, activeInterval, activeConfig().subscribeOHLC);

// app.js
import { connectKraken, subscribeTicker, onStatusChange } from './market-data.js';
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
const WATCHLIST_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'DOGE/USD'];
const DEFAULT_SYMBOL = 'BTC/USD';
const DEFAULT_TIMEFRAME_MINUTES = 60;

let activeSymbol = DEFAULT_SYMBOL;
let activeInterval = DEFAULT_TIMEFRAME_MINUTES;
let connectionStatus = 'connecting';
let lastHeaderPrice = null;

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

const chartController = createChartController(chartContainer, {
  onData: () => chartLoading.classList.add('hidden'),
});

// --- Connection status ---
onStatusChange((state) => {
  connectionStatus = state;
  statusDot.dataset.state = state;
  statusText.textContent =
    state === 'live' ? 'Live \u00b7 Kraken' : state === 'connecting' ? 'Connecting\u2026' : 'Reconnecting\u2026';
  copilotBadge.textContent = state === 'live' ? 'watching chart' : 'not connected';
  copilotBadge.dataset.live = String(state === 'live');
});

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
  chartLoading.classList.remove('hidden');
  chartController.setSymbolTimeframe(activeSymbol, activeInterval);
}

function switchSymbol(symbol) {
  if (symbol === activeSymbol) return;
  activeSymbol = symbol;
  symbolNameEl.textContent = symbol;
  lastHeaderPrice = null;
  chartLoading.classList.remove('hidden');
  chartController.setSymbolTimeframe(activeSymbol, activeInterval);
  document.querySelectorAll('.watch-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.symbol === symbol));
  });
}

// --- Watchlist ---
function renderWatchlist() {
  watchlistEl.innerHTML = '';
  WATCHLIST_SYMBOLS.forEach((symbol) => {
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

// --- Fullscreen ---
fullscreenBtn.addEventListener('click', () => chartController.toggleFullscreen());

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
renderTimeframes();
renderWatchlist();
initCopilot({
  getChartContext: () => chartController.getContext(),
  getConnectionStatus: () => connectionStatus,
});

connectKraken();
subscribeTicker(WATCHLIST_SYMBOLS, (type, tick) => updateWatchlistRow(tick));
chartController.setSymbolTimeframe(activeSymbol, activeInterval);

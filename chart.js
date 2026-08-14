// chart.js
// Wraps TradingView Lightweight Charts (v4.1.3, pinned via CDN script tag in
// index.html -- deliberately not "latest": v5 changed series creation to
// chart.addSeries(SeriesType, options), which this code doesn't use, so
// pinning avoids silently breaking on an untested API).
//
// M4 slice: a real (if minimal) Analysis Engine -- SMA9/21 crossover + RSI14,
// computed from a local bar buffer (Kraken pushes raw OHLCV only, never
// derived indicators). Both are standard, well-defined calculations, not
// invented signals, so the Copilot's "never invent an indicator value" rule
// in netlify/functions/copilot.mts stays true: a value here is either a real
// number or genuinely absent (buffer too short), never guessed.

import { subscribeOHLC } from './market-data.js';

const UP_COLOR = '#26a69a';
const DOWN_COLOR = '#ef5350';
const BUFFER_LIMIT = 200; // plenty for SMA21/RSI14; caps memory on long sessions

export function createChartController(container, { onData } = {}) {
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: 'solid', color: '#131722' },
      textColor: '#98a2b3',
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Consolas, monospace',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: '#1a2029' },
      horzLines: { color: '#1a2029' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#232938' },
    timeScale: { borderColor: '#232938', timeVisible: true, secondsVisible: false },
    handleScroll: true,
    handleScale: true,
  });

  const series = chart.addCandlestickSeries({
    upColor: UP_COLOR,
    downColor: DOWN_COLOR,
    borderUpColor: UP_COLOR,
    borderDownColor: DOWN_COLOR,
    wickUpColor: UP_COLOR,
    wickDownColor: DOWN_COLOR,
    priceLineVisible: true,
    lastValueVisible: true,
  });

  // Volume as a bottom-pane histogram on its own price scale, so it doesn't
  // compete with candles for vertical space. scaleMargins pins it to the
  // bottom ~18% of the pane -- standard Lightweight Charts idiom for this.
  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  const ro = new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    if (width > 0 && height > 0) chart.applyOptions({ width, height });
  });
  ro.observe(container);

  let currentSymbol = null;
  let currentInterval = null;
  let unsubscribeFn = null;
  let lastPrice = null;
  let recentHigh = null;
  let recentLow = null;
  let bars = []; // local buffer for indicator math -- the chart's own series is write-only

  function toBar(k) {
    return {
      time: Math.floor(Date.parse(k.interval_begin) / 1000),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume ?? 0,
    };
  }

  function volumeColor(bar) {
    return bar.close >= bar.open ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)';
  }

  function upsertBar(buffer, bar) {
    if (buffer.length && buffer[buffer.length - 1].time === bar.time) {
      buffer[buffer.length - 1] = bar;
    } else {
      buffer.push(bar);
      if (buffer.length > BUFFER_LIMIT) buffer.shift();
    }
  }

  function sma(values, period) {
    if (values.length < period) return null;
    const slice = values.slice(values.length - period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
  }

  // Wilder's RSI, recomputed over the whole buffer each call. Buffer is
  // capped at BUFFER_LIMIT bars so this is cheap -- avoids incremental
  // state that could silently drift out of sync across a reconnect.
  function rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change >= 0) avgGain += change;
      else avgLoss += -change;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (change >= 0 ? change : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  function round(n, dp = 2) {
    if (n === null || n === undefined) return null;
    const f = 10 ** dp;
    return Math.round(n * f) / f;
  }

  function computeIndicators() {
    const closes = bars.map((b) => b.close);
    const sma9 = sma(closes, 9);
    const sma21 = sma(closes, 21);
    const rsi14 = rsi(closes, 14);

    let trend = null;
    if (sma9 !== null && sma21 !== null && lastPrice !== null) {
      if (lastPrice > sma9 && sma9 > sma21) trend = 'bullish';
      else if (lastPrice < sma9 && sma9 < sma21) trend = 'bearish';
      else trend = 'mixed'; // genuinely ranging/whipsawing -- not a fabricated confident call
    }

    const indicators = {};
    if (sma9 !== null) indicators.sma9 = round(sma9);
    if (sma21 !== null) indicators.sma21 = round(sma21);
    if (rsi14 !== null) indicators.rsi14 = round(rsi14, 1);

    return { trend, indicators };
  }

  function handleKrakenUpdate(type, krakenBars) {
    const mapped = krakenBars.map(toBar).sort((a, b) => a.time - b.time);
    if (mapped.length === 0) return;

    if (type === 'snapshot') {
      series.setData(mapped);
      volumeSeries.setData(mapped.map((b) => ({ time: b.time, value: b.volume, color: volumeColor(b) })));
      bars = mapped.slice(-BUFFER_LIMIT);
      recentHigh = Math.max(...mapped.map((b) => b.high));
      recentLow = Math.min(...mapped.map((b) => b.low));
    } else {
      mapped.forEach((bar) => {
        series.update(bar);
        volumeSeries.update({ time: bar.time, value: bar.volume, color: volumeColor(bar) });
        upsertBar(bars, bar);
        recentHigh = recentHigh === null ? bar.high : Math.max(recentHigh, bar.high);
        recentLow = recentLow === null ? bar.low : Math.min(recentLow, bar.low);
      });
    }
    lastPrice = mapped.at(-1).close;
    onData?.();
  }

  function setSymbolTimeframe(symbol, interval) {
    if (unsubscribeFn) unsubscribeFn();
    currentSymbol = symbol;
    currentInterval = interval;
    lastPrice = null;
    recentHigh = null;
    recentLow = null;
    bars = [];
    series.setData([]);
    volumeSeries.setData([]);
    unsubscribeFn = subscribeOHLC(symbol, interval, handleKrakenUpdate);
  }

  return {
    setSymbolTimeframe,
    toggleFullscreen() {
      if (!document.fullscreenElement) {
        container.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
    },
    getContext() {
      const { trend, indicators } = computeIndicators();
      return {
        symbol: currentSymbol,
        timeframe: currentInterval,
        price: lastPrice,
        recentHigh,
        recentLow,
        trend,
        indicators,
      };
    },
    destroy() {
      if (unsubscribeFn) unsubscribeFn();
      ro.disconnect();
      chart.remove();
    },
  };
}

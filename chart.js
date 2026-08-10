// chart.js
// Wraps TradingView Lightweight Charts (v4.1.3, pinned via CDN script tag in
// index.html -- deliberately not "latest": v5 changed series creation to
// chart.addSeries(SeriesType, options), which this code doesn't use, so
// pinning avoids silently breaking on an untested API).
//
// getContext() is built now even though nothing calls it yet -- it's the
// read-only surface the AI Copilot integration needs in a later milestone,
// and it's nearly free to add while this module is already being written.

import { subscribeOHLC } from './market-data.js';

const UP_COLOR = '#26a69a';
const DOWN_COLOR = '#ef5350';

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

  function toBar(k) {
    return {
      time: Math.floor(Date.parse(k.interval_begin) / 1000),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    };
  }

  function handleKrakenUpdate(type, bars) {
    const mapped = bars.map(toBar).sort((a, b) => a.time - b.time);
    if (mapped.length === 0) return;

    if (type === 'snapshot') {
      series.setData(mapped);
      recentHigh = Math.max(...mapped.map((b) => b.high));
      recentLow = Math.min(...mapped.map((b) => b.low));
    } else {
      mapped.forEach((bar) => {
        series.update(bar);
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
    series.setData([]);
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
      return {
        symbol: currentSymbol,
        timeframe: currentInterval,
        price: lastPrice,
        recentHigh,
        recentLow,
        // Not computed yet -- these ship with the Analysis Engine
        // (Milestones 4+/6), not the chart workspace itself.
        trend: null,
        indicators: {},
      };
    },
    destroy() {
      if (unsubscribeFn) unsubscribeFn();
      ro.disconnect();
      chart.remove();
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// chart-terminal/chart-overlay-utils.js
//
// Shared, reusable primitives for drawing a canvas overlay on top of the
// Lightweight Charts main pane — synced to its pan/zoom, clipped per-candle,
// and safe against text-truncation bugs. Extracted out of footprint.js so
// that Order Flow and Liquidity (both structurally the same kind of problem
// — dense, price-level-based, custom-rendered, per-candle data) can reuse
// the SAME already-debugged logic instead of re-deriving and re-debugging
// it from scratch. Load this BEFORE footprint.js / order-flow.js /
// liquidity.js in index.html.
//
// This file owns no UI of its own — no buttons, no state, no WebSocket.
// It is pure geometry/canvas helpers, deliberately data-shape-agnostic
// (works with plain {price, ...} objects) so any of the three features can
// use it directly.
// ══════════════════════════════════════════════════════════════════════════

(function () {

  // ── Canvas lifecycle — creation, DPI-correct resizing, cleanup ─────────
  // Returns null if the container doesn't exist (caller should bail out).
  function createOverlayCanvas(containerId, className) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    const canvas = document.createElement('canvas');
    canvas.className = className || 'chart-overlay-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.pointerEvents = 'none';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      canvas.style.width = container.clientWidth + 'px';
      canvas.style.height = container.clientHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return {
      canvas,
      ctx,
      resize,
      clear: () => ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight),
      destroy: () => {
        resizeObserver.disconnect();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  // ── Per-candle hard clipping ────────────────────────────────────────────
  // Confines everything drawFn() paints to ONE candle's own horizontal
  // column. Wrap ANY per-candle drawing in this (footprint boxes, order
  // flow bars, liquidity cells) — it GUARANTEES no visual bleed into a
  // neighboring candle's column, regardless of any width/spacing bug
  // inside drawFn. This was the fix for footprint's "smeared blob" bug —
  // use it from day one on the next feature instead of hitting the same
  // bug and re-discovering this.
  function withColumnClip(ctx, x, columnWidth, canvasHeight, drawFn) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - columnWidth / 2, 0, columnWidth, canvasHeight);
    ctx.clip();
    drawFn();
    ctx.restore();
  }

  // ── Safe text drawing — measure BEFORE drawing, never truncate ─────────
  // Returns true if it drew the text, false if it skipped (didn't fit).
  // CRITICAL RULE, learned the hard way on footprint: never let clip()
  // silently chop a number's characters — e.g. "0.304" losing its leading
  // "0." to a clip boundary and rendering as a very misleading "304". A
  // trading tool must never show a half-truncated number. Always measure
  // first; either the full correct string draws, or nothing does.
  function drawTextIfFits(ctx, text, x, y, align, maxWidth) {
    const width = ctx.measureText(text).width;
    if (width > maxWidth) return false;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    return true;
  }

  // ── Non-overlapping row layout ──────────────────────────────────────────
  // Takes a list of items with a `.price` field (already sorted, e.g.
  // highest price first) and a priceToY(price) function (typically
  // series.priceToCoordinate). Returns only the subset spaced far enough
  // apart in pixels to draw without visually overlapping/garbling.
  //
  // This is what makes a price-level grid self-adjust to zoom instead of
  // requiring the user to zoom in extremely far just to read anything:
  // fewer, cleanly-spaced rows show at normal zoom, and more detail
  // appears automatically as the user zooms in — rather than forcing every
  // level to cram in regardless of available pixels.
  function layoutNonOverlappingRows(sortedItems, priceToY, minRowSpacing) {
    const out = [];
    let lastY = null;
    for (const item of sortedItems) {
      const y = priceToY(item.price);
      if (y === null || y === undefined) continue;
      if (lastY !== null && Math.abs(y - lastY) < minRowSpacing) continue;
      lastY = y;
      out.push(Object.assign({}, item, { y }));
    }
    return out;
  }

  // ── Chart redraw subscription ───────────────────────────────────────────
  // Wires a render callback to the chart's own pan/zoom events, returns an
  // unsubscribe function. Keeps the overlay in sync automatically —
  // no separate zoom/pan tracking needed in the feature module.
  function subscribeVisibleRangeRedraw(chart, callback) {
    chart.timeScale().subscribeVisibleTimeRangeChange(callback);
    return () => chart.timeScale().unsubscribeVisibleTimeRangeChange(callback);
  }

  // ── Offscreen culling ────────────────────────────────────────────────
  function isOffscreenX(x, canvasWidth, margin) {
    const m = margin == null ? 60 : margin;
    return x === null || x === undefined || x < -m || x > canvasWidth + m;
  }

  window.chartOverlayUtils = {
    createOverlayCanvas,
    withColumnClip,
    drawTextIfFits,
    layoutNonOverlappingRows,
    subscribeVisibleRangeRedraw,
    isOffscreenX,
  };

})();

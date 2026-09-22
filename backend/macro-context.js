// v2: staggered fetch + per-source TTL cache + 429 retry + Binance-sourced majors.
const fetch = globalThis.fetch;
const SRC_CACHE = {};
const TTL = { fng: 60000, global: 120000, trending: 300000, majors: 60000, news: 300000 };
function getCached(name) { const c = SRC_CACHE[name]; if (c && Date.now() - c.ts < TTL[name]) return c.data; return undefined; }
function setCache(name, data) { SRC_CACHE[name] = { ts: Date.now(), data }; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchJSON(url, timeoutMs = 8000, retries = 2) {
      for (let i = 0; i <= retries; i++) {
            const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), timeoutMs);
                    try {
                              const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'EdgeTrade/1.0' } });
                                    clearTimeout(t);
                                          if (r.status === 429 && i < retries) { await sleep(1200 * (i + 1)); continue; }
                                                if (!r.ok) return null;
                                                      return await r.json();
                    } catch (e) { clearTimeout(t); if (i < retries) { await sleep(800 * (i + 1)); continue; } return null; }
      }
        return null;
}
async function fetchFearGreed() {
      const hit = getCached('fng'); if (hit !== undefined) return hit;
        const j = await fetchJSON('https://api.alternative.me/fng/?limit=1&format=json');
          const out = j && j.data && j.data[0] ? { value: parseInt(j.data[0].value, 10), label: j.data[0].value_classification, ts: parseInt(j.data[0].time_stamp, 10) * 1000 } : null;
            setCache('fng', out); return out;
}
async function fetchGlobal() {
      const hit = getCached('global'); if (hit !== undefined) return hit;
        const j = await fetchJSON('https://api.coingecko.com/api/v3/global');
          const out = j && j.data ? {
                btcDominance: parseFloat(j.data.market_cap_percentage.btc),
                    ethDominance: parseFloat(j.data.market_cap_percentage.eth),
                        totalMarketCapUsd: parseFloat(j.data.total_market_cap.usd),
                            totalVolume24hUsd: parseFloat(j.data.total_volume.usd),
                                marketCapChange24hPct: parseFloat(j.data.market_cap_change_percentage_24h_usd),
          } : null;
            setCache('global', out); return out;
}
async function fetchTrending() {
      const hit = getCached('trending'); if (hit !== undefined) return hit;
        const j = await fetchJSON('https://api.coingecko.com/api/v3/search/trending');
          const out = j && j.coins ? j.coins.slice(0, 7).map(c => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: c.item.market_cap_rank, score: c.score })) : [];
            setCache('trending', out); return out;
}
// Majors ab Binance se — keyless, reliable, CoinGecko rate-limit se free
async function fetchMajorPrices() {
      const hit = getCached('majors'); if (hit !== undefined) return hit;
        const syms = encodeURIComponent('["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]');
          const j = await fetchJSON(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${syms}`);
            let out = null;
              if (Array.isArray(j)) {
                    out = {};
                        j.forEach(t => {
                                  const k = t.symbol.replace('USDT', '').toLowerCase();
                                        out[k] = { price: parseFloat(t.lastPrice), change24h: parseFloat(t.priceChangePercent), vol24h: parseFloat(t.quoteVolume) };
              });
              }
                setCache('majors', out); return out;
}
async function fetchNews() {
      const hit = getCached('news'); if (hit !== undefined) return hit;
        const j = await fetchJSON('https://min-api.cryptocompare.com/data/v2/news/?lang=EN');
          const now = Date.now();
            const out = j && j.Data ? j.Data.slice(0, 15).map(n => ({
                    title: n.title, body: (n.body || '').slice(0, 200), url: n.url, source: n.source, ts: n.published_on * 1000,
                        categories: (n.categories || '').split('|'),
                            isBreaking: /breaking|urgent|alert|just in/i.test(n.title) || (n.categories || '').toLowerCase().includes('breaking'),
})).filter(n => now - n.ts < 86400000) : [];
  setCache('news', out); return out;
}
function computeRegime(fg, global, news, majors) {
      let bias = 'neutral'; let confidence = 0; let reasons = [];
        if (fg) {
                if (fg.value <= 20) { bias = 'extreme_fear'; confidence += 0.3; reasons.push(`Fear ${fg.value} (extreme — contrarian buy zone)`); }
                    else if (fg.value <= 40) { bias = 'fear'; confidence += 0.15; reasons.push(`Fear ${fg.value}`); }
                        else if (fg.value >= 80) { bias = 'extreme_greed'; confidence += 0.3; reasons.push(`Greed ${fg.value} (extreme — caution)`); }
                            else if (fg.value >= 60) { bias = 'greed'; confidence += 0.15; reasons.push(`Greed ${fg.value}`); }
                                else reasons.push(`Neutral sentiment ${fg.value}`);
        }
          if (global) {
                if (global.marketCapChange24hPct > 3) { reasons.push(`Market +${global.marketCapChange24hPct.toFixed(1)}% 24h (risk-on)`); confidence += 0.1; }
                    else if (global.marketCapChange24hPct < -3) { reasons.push(`Market ${global.marketCapChange24hPct.toFixed(1)}% 24h (risk-off)`); confidence -= 0.1; }
                        if (global.btcDominance > 58) reasons.push(`BTC dominance ${global.btcDominance.toFixed(1)}% (alts weak)`);
                            else if (global.btcDominance < 48) reasons.push(`BTC dominance ${global.btcDominance.toFixed(1)}% (altseason)`);
          }
            const recentBreaking = news.filter(n => n.isBreaking && Date.now() - n.ts < 600000).length;
              const newsVol = news.filter(n => Date.now() - n.ts < 3600000).length;
                return { bias, confidence: Math.round(confidence * 100) / 100, reasons, breakingLast10m: recentBreaking, newsLast1h: newsVol, newsVolFlag: newsVol >= 6 || recentBreaking >= 2 };
}
async function getMacroContext() {
      // Stagger: CoinGecko free tier ek saath 3 calls bardasht nahi karta
        const fg = await fetchFearGreed();
          const global = await fetchGlobal();
            await sleep(400);
              const trending = await fetchTrending();
                const majors = await fetchMajorPrices();
                  await sleep(400);
                    const news = await fetchNews();
                      const regime = computeRegime(fg, global, news, majors);
                        return { ts: Date.now(), fearGreed: fg, global, trending, majors, news: news.slice(0, 10), regime };
}
function mount(app) {
      app.get('/api/macro-context', async (req, res) => {
            try { res.json(await getMacroContext()); }
                catch (e) { res.status(500).json({ error: e.message }); }
});
  app.get('/api/macro-hint', async (req, res) => {
        try {
                  const ctx = await getMacroContext();
                        const r = ctx.regime;
                              let hint = { tag: 'neutral', slWiden: 1, biasShift: 0, note: '' };
                                    if (r.bias === 'extreme_fear' && (ctx.majors && ctx.majors.btc ? ctx.majors.btc.change24h : 0) > 0) {
                                                hint = { tag: 'bull_fear_contrarian', slWiden: 1.2, biasShift: 8, note: 'extreme fear + BTC green = contrarian long bias' };
} else if (r.bias === 'extreme_greed') {
            hint = { tag: 'greed_caution', slWiden: 1.3, biasShift: -5, note: 'extreme greed — tighten size, widen SL' };
} else if (r.newsVolFlag) {
            hint = { tag: 'news_vol', slWiden: 1.5, biasShift: 0, note: `${r.breakingLast10m} breaking news / ${r.newsLast1h} in 1h — SL widen` };
}
      res.json(hint);
} catch (e) { res.status(500).json({ error: e.message }); }
});
}
module.exports = { mount, getMacroContext };

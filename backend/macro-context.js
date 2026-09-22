// Keyless APIs, 15-second cache, single endpoint /api/macro-context.
const fetch = globalThis.fetch;
const CACHE_MS = 15000;
let cache = { ts: 0, data: null };
async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'EdgeTrade/1.0' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { clearTimeout(t); return null; }
}
async function fetchFearGreed() {
  const j = await fetchJSON('https://api.alternative.me/fng/?limit=1&format=json');
  if (!j || !j.data || !j.data[0]) return null;
  const d = j.data[0];
  return { value: parseInt(d.value, 10), label: d.value_classification, ts: parseInt(d.time_stamp, 10) * 1000 };
}
async function fetchGlobal() {
  const j = await fetchJSON('https://api.coingecko.com/api/v3/global');
  if (!j || !j.data) return null;
  const d = j.data;
  return {
    btcDominance: parseFloat(d.market_cap_percentage.btc),
    ethDominance: parseFloat(d.market_cap_percentage.eth),
    totalMarketCapUsd: parseFloat(d.total_market_cap.usd),
    totalVolume24hUsd: parseFloat(d.total_volume.usd),
    marketCapChange24hPct: parseFloat(d.market_cap_change_percentage_24h_usd),
  };
}
async function fetchTrending() {
  const j = await fetchJSON('https://api.coingecko.com/api/v3/search/trending');
  if (!j || !j.coins) return [];
  return j.coins.slice(0, 7).map(c => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: c.item.market_cap_rank, score: c.score }));
}
async function fetchMajorPrices() {
  const j = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true');
  if (!j) return null;
  return {
    btc: { price: j.bitcoin.usd, change24h: j.bitcoin.usd_24h_change, vol24h: j.bitcoin.usd_24h_vol },
    eth: { price: j.ethereum.usd, change24h: j.ethereum.usd_24h_change, vol24h: j.ethereum.usd_24h_vol },
    sol: { price: j.solana.usd, change24h: j.solana.usd_24h_change, vol24h: j.solana.usd_24h_vol },
    bnb: { price: j.binancecoin.usd, change24h: j.binancecoin.usd_24h_change, vol24h: j.binancecoin.usd_24h_vol },
  };
}
async function fetchNews() {
  const j = await fetchJSON('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&extraParams=EdgeTrade');
  if (!j || !j.Data) return [];
  const now = Date.now();
  return j.Data.slice(0, 15).map(n => ({
    title: n.title,
    body: (n.body || '').slice(0, 200),
    url: n.url,
    source: n.source,
    ts: n.published_on * 1000,
    categories: (n.categories || '').split('|'),
    isBreaking: /breaking|urgent|alert|just in/i.test(n.title) || (n.categories || '').toLowerCase().includes('breaking'),
  })).filter(n => now - n.ts < 24 * 3600 * 1000);
}
function computeRegime(fg, global, news, majors) {
  let bias = 'neutral';
  let confidence = 0;
  let reasons = [];
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
  if (cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;
  const [fg, global, trending, majors, news] = await Promise.all([
    fetchFearGreed(), fetchGlobal(), fetchTrending(), fetchMajorPrices(), fetchNews(),
  ]);
  const regime = computeRegime(fg, global, news, majors);
  const data = { ts: Date.now(), fearGreed: fg, global, trending, majors, news: news.slice(0, 10), regime };
  cache = { ts: Date.now(), data };
  return data;
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
      if (r.bias === 'extreme_fear' && (ctx.majors?.btc?.change24h || 0) > 0) {
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

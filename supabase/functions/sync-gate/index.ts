import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function gateFetch(path: string, params: Record<string, string>, apiKey: string, apiSecret: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const qstr = new URLSearchParams(params).toString();
  const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // empty body SHA256
  const preSign = `GET
${path}
${qstr}
${bodyHash}
${ts}`;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`https://api.gateio.ws${path}?${qstr}`, {
    headers: {
      "KEY": apiKey, "SIGN": sig, "Timestamp": ts
    }
  });
  if (!res.ok) {
    console.error(`Gate.io API error [${path}] pair=${params.currency_pair || "n/a"}: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json();
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const from = Math.floor((Date.now() - 90 * 24 * 3600 * 1000) / 1000).toString();

  // NOTE (critical fix): Gate.io's spot orders endpoint only returns the last 24 HOURS of
  // finished orders when currency_pair is omitted, regardless of the `from` param. The old
  // code queried without currency_pair, silently limiting spot sync to ~1 day. Looping over
  // common pairs as a fix, similar to the MEXC/HTX pattern - expand list as needed.
  const spotPairs = ["BTC_USDT","ETH_USDT","SOL_USDT","XRP_USDT","BNB_USDT","DOGE_USDT","ADA_USDT"];
  for (const pair of spotPairs) {
    const spotOrders = await gateFetch("/api/v4/spot/orders", {
      currency_pair: pair, status: "finished", from, limit: "500"
    }, apiKey, apiSecret);
    if (!Array.isArray(spotOrders)) continue;
    for (const o of spotOrders) {
      if (o.status !== "closed") continue;
      const ts = parseFloat(o.update_time || o.create_time) * 1000;
      trades.push({
        external_trade_id: `gate-${o.id}`,
        symbol: pair.replace("_USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.amount),
        lot_unit: "qty",
        entry_price: parseFloat(o.avg_deal_price || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.fee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  // Futures closed positions (contract param optional here per docs, kept as-is)
  const futContracts = await gateFetch("/api/v4/futures/usdt/orders", { status: "finished", from, limit: "200" }, apiKey, apiSecret);
  if (Array.isArray(futContracts)) {
    for (const o of futContracts) {
      const ts = parseFloat(o.finish_time || o.create_time) * 1000;
      const pnl = parseFloat(o.pnl || "0");
      trades.push({
        external_trade_id: `gate-fut-${o.id}`,
        symbol: (o.contract || "").replace("_USDT", "/USDT"),
        direction: (o.size || 0) > 0 ? "long" : "short",
        lot_size: Math.abs(o.size),
        lot_unit: "qty",
        entry_price: parseFloat(o.fill_price || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        // NOTE: verify when live - futures order object doesn't expose fee directly;
        // real fee data may require a separate call to /futures/usdt/my_trades.
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

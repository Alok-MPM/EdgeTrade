// IMPORTANT: Bitget permanently discontinued the V1 API (api/mix/v1/*, api/spot/v1/*) on
// Nov 28, 2025. This file has been migrated to the V2 API. Field names below are based on
// V2 documentation but have NOT been live-tested - flag as "verify when live" and check the
// first real sync response carefully against api-doc/contract and api-doc/spot on bitget.com.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Base64 } from "../_utils/crypto.ts";

async function bitgetFetch(path: string, params: Record<string, string>, apiKey: string, apiSecret: string, passphrase: string) {
  const ts = Date.now().toString();
  const qstr = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const preSign = ts + "GET" + path + qstr;
  const sig = await hmacSha256Base64(apiSecret, preSign);
  const res = await fetch(`https://api.bitget.com${path}${qstr}`, {
    headers: {
      "ACCESS-KEY": apiKey, "ACCESS-SIGN": sig, "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": passphrase, "Content-Type": "application/json",
    }
  });
  if (!res.ok) {
    console.error(`Bitget API error [${path}]: ${res.status} ${await res.text()}`);
    return null;
  }
  const j = await res.json();
  return j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const passphrase = conn.api_passphrase_encrypted as string;
  const startTime = (Date.now() - 90 * 24 * 3600 * 1000).toString();
  const endTime = Date.now().toString();

  const trades: NormalizedTrade[] = [];

  // Futures fill history (V2) - productType changed from "UMCBL" (v1) to "USDT-FUTURES" (v2)
  const futData = await bitgetFetch("/api/v2/mix/order/fill-history", {
    productType: "USDT-FUTURES", startTime, endTime, limit: "100"
  }, apiKey, apiSecret, passphrase);

  const futFills = futData?.fillList || futData?.fills || (Array.isArray(futData) ? futData : null);
  if (Array.isArray(futFills)) {
    for (const o of futFills) {
      const ts = parseInt(o.cTime || o.ts);
      const pnl = parseFloat(o.profit || "0");
      trades.push({
        external_trade_id: `bitget-${o.tradeId || o.orderId}`,
        // v2 symbols no longer carry the _UMCBL suffix
        symbol: (o.symbol || "").replace("USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.baseVolume || o.size),
        lot_unit: "qty",
        entry_price: parseFloat(o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: Math.abs(parseFloat(o.feeDetail?.[0]?.totalFee || o.fee || "0")),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: msToDate(ts),
      });
    }
  }

  // Spot fill history (V2)
  const spotFills = await bitgetFetch("/api/v2/spot/trade/fills", {
    startTime, endTime, limit: "100"
  }, apiKey, apiSecret, passphrase);
  if (Array.isArray(spotFills)) {
    for (const o of spotFills) {
      const ts = parseInt(o.cTime || o.ts);
      trades.push({
        external_trade_id: `bitget-spot-${o.tradeId || o.orderId}`,
        symbol: (o.symbol || "").replace("USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.size || o.baseVolume),
        lot_unit: "qty",
        entry_price: parseFloat(o.priceAvg || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: Math.abs(parseFloat(o.feeDetail?.totalFee || o.fees || "0")),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

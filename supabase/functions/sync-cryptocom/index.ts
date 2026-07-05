// IMPORTANT: Crypto.com decommissioned the legacy Spot v2.1 API (api.crypto.com/v2/*) in
// July 2024. This file has been migrated to the Exchange v1 API (api.crypto.com/exchange/v1/*).
// Also fixes a real API limitation: private/get-order-history has a MAX 24-HOUR window per
// call - the old code requested a 90-day range in one call, which would silently return
// nothing or error. Now loops in 24h windows, capped to avoid Edge Function timeout.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function cryptoComFetch(method: string, params: Record<string, unknown> = {}) {
    const id = Date.now();
    const nonce = Date.now().toString();
    const paramStr = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}${v}`).join("");
    const preSign = method + id + apiKey + paramStr + nonce;
    const sig = await hmacSha256Hex(apiSecret, preSign);
    const body = JSON.stringify({ id, method, params, api_key: apiKey, sig, nonce: parseInt(nonce) });
    const res = await fetch("https://api.crypto.com/exchange/v1/" + method, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    if (!res.ok) {
      console.error(`Crypto.com API error [${method}]: ${res.status} ${await res.text()}`);
      return null;
    }
    const j = await res.json();
    return j?.result?.order_list || j?.result?.trade_list || null;
  }

  // 24h max window per docs - loop last 14 days (14 calls) to stay within Edge Function
  // timeout limits. Increase DAYS_TO_SYNC later if the function has headroom.
  const DAYS_TO_SYNC = 14;
  const ONE_DAY = 24 * 3600 * 1000;
  const now = Date.now();

  for (let i = 0; i < DAYS_TO_SYNC; i++) {
    const end_ts = now - i * ONE_DAY;
    const start_ts = end_ts - ONE_DAY;
    const orders = await cryptoComFetch("private/get-order-history", {
      start_ts, end_ts, limit: 200
    });
    if (!Array.isArray(orders)) continue;

    for (const o of orders) {
      if (o.status !== "FILLED") continue;
      const ts = parseInt(o.update_time || o.create_time);
      trades.push({
        external_trade_id: `cdc-${o.order_id}`,
        symbol: (o.instrument_name || "").replace("_", "/"),
        direction: o.side === "BUY" ? "long" : "short",
        lot_size: parseFloat(o.cumulative_quantity || o.quantity),
        lot_unit: "qty",
        entry_price: parseFloat(o.avg_price || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.cumulative_fee || o.fee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "breakeven",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

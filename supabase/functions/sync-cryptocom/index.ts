import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

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
    const res = await fetch("https://api.crypto.com/v2/private/" + method, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.result?.order_list || j?.result?.trade_list || null;
  }

  const start_ts = Date.now() - 30 * 24 * 3600 * 1000;
  const orders = await cryptoComFetch("private/get-order-history", {
    start_ts, count: 200
  });

  if (Array.isArray(orders)) {
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
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

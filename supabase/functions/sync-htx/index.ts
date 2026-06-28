import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Base64 } from "../_shared/crypto.ts";

async function htxFetch(path: string, params: Record<string, string>, apiKey: string, apiSecret: string) {
  const ts = new Date().toISOString().replace(/\..+/, "");
  const host = "api.huobi.pro";
  const sorted = Object.entries({ ...params, AccessKeyId: apiKey, SignatureMethod: "HmacSHA256", SignatureVersion: "2", Timestamp: ts })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const preSign = `GET
${host}
${path}
${sorted}`;
  const sig = await hmacSha256Base64(apiSecret, preSign);
  const res = await fetch(`https://${host}${path}?${sorted}&Signature=${encodeURIComponent(sig)}`);
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const startDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split("T")[0];

  const orders = await htxFetch("/v1/order/orders", {
    "start-date": startDate, states: "filled", size: "500"
  }, apiKey, apiSecret);

  if (Array.isArray(orders)) {
    for (const o of orders) {
      const ts = parseInt(o["finished-at"] || o["created-at"]);
      trades.push({
        external_trade_id: `htx-${o.id}`,
        symbol: (o.symbol || "").replace("usdt", "/USDT").replace("inr", "/INR").toUpperCase(),
        direction: o.type?.includes("buy") ? "long" : "short",
        lot_size: parseFloat(o["field-amount"] || o.amount),
        lot_unit: "qty",
        entry_price: parseFloat(o["field-cash-amount"] && o["field-amount"]
          ? (parseFloat(o["field-cash-amount"]) / parseFloat(o["field-amount"])).toFixed(8)
          : o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o["field-fees"] || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

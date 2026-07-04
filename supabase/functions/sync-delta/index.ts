import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_utils/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, NormalizedTrade } from "../_utils/utils.ts";
import { hmacSha256Hex } from "../_utils/crypto.ts";

async function deltaFetch(base: string, path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const method = "GET";
  const qstr = Object.keys(params).length ? new URLSearchParams(params as Record<string, string>).toString() : "";
  const body = "";
  const preSign = method + ts + path + (qstr ? "?" + qstr : "") + body;
  const sig = await hmacSha256Hex(apiSecret, preSign);
  const res = await fetch(`${base}${path}${qstr ? "?" + qstr : ""}`, {
    headers: { "api-key": apiKey, "signature": sig, "timestamp": ts }
  });
  if (!res.ok) {
    console.error("Delta API error:", res.status, await res.text());
    return null;
  }
  const j = await res.json();
  return j?.result || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const isDemo = conn.account_type === "demo";
  const base = isDemo ? "https://cdn-ind.testnet.deltaex.org" : "https://api.india.delta.exchange";
  const trades: NormalizedTrade[] = [];
  const cutoffMs = Date.now() - 90 * 24 * 3600 * 1000;

  const orders = await deltaFetch(base, "/v2/orders/history", { page_size: "200", state: "closed" }, apiKey, apiSecret);
  if (Array.isArray(orders)) {
    for (const o of orders) {
      if (o.state !== "closed" || !o.avg_fill_price) continue;
      const orderMs = new Date(o.updated_at || o.created_at).getTime();
      if (orderMs < cutoffMs) continue;
      const ts = new Date(o.updated_at || o.created_at);
      const pnl = parseFloat(o.pnl || "0");
      trades.push({
        external_trade_id: `delta-${o.id}`,
        symbol: (o.product?.symbol || o.product_symbol || "UNKNOWN").replace("USDT", "/USDT").replace("INR", "/INR"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.size),
        lot_unit: "qty",
        entry_price: parseFloat(o.avg_fill_price),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(o.paid_commission || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

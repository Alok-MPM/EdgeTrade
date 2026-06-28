import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Base64 } from "../_shared/crypto.ts";

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
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data?.orderList || j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const passphrase = conn.api_passphrase_encrypted as string;
  const isDemo = conn.account_type === "demo";
  const startTime = (Date.now() - 30 * 24 * 3600 * 1000).toString();
  const endTime = Date.now().toString();

  const trades: NormalizedTrade[] = [];

  // Futures history
  const futProd = isDemo ? "UMCBL" : "UMCBL";
  const futOrders = await bitgetFetch("/api/mix/v1/order/history", {
    productType: futProd, startTime, endTime, pageSize: "100"
  }, apiKey, apiSecret, passphrase);

  if (Array.isArray(futOrders)) {
    for (const o of futOrders) {
      if (o.state !== "full_fill") continue;
      const ts = parseInt(o.cTime || o.uTime);
      const pnl = parseFloat(o.pnl || "0");
      trades.push({
        external_trade_id: `bitget-${o.orderId}`,
        symbol: (o.symbol || "").replace("_UMCBL", "").replace("USDT", "/USDT"),
        direction: o.side?.includes("open_long") || o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.filledQty || o.size),
        lot_unit: "qty",
        entry_price: parseFloat(o.priceAvg || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.fee || "0") * -1,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: msToDate(ts),
      });
    }
  }

  // Spot orders
  const spotOrders = await bitgetFetch("/api/spot/v1/trade/history", {
    startTime, endTime, limit: "100"
  }, apiKey, apiSecret, passphrase);
  if (Array.isArray(spotOrders)) {
    for (const o of spotOrders) {
      if (o.status !== "full_fill") continue;
      const ts = parseInt(o.cTime);
      trades.push({
        external_trade_id: `bitget-spot-${o.orderId}`,
        symbol: (o.symbol || "").replace("_SPBL", "").replace("USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.fillQuantity || o.quantity),
        lot_unit: "qty",
        entry_price: parseFloat(o.fillPrice || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.fees || "0") * -1,
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, isoToDate, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Base64 } from "../_shared/crypto.ts";

async function okxFetch(base: string, path: string, apiKey: string, apiSecret: string, passphrase: string, params: Record<string, string> = {}) {
  const ts = new Date().toISOString();
  const qstr = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  const preSign = ts + "GET" + path + qstr;
  const sig = await hmacSha256Base64(apiSecret, preSign);
  const res = await fetch(`${base}${path}${qstr}`, {
    headers: {
      "OK-ACCESS-KEY": apiKey, "OK-ACCESS-SIGN": sig,
      "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": passphrase,
      "x-simulated-trading": base.includes("testnet") ? "1" : "0",
    }
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data || null;
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const passphrase = conn.api_passphrase_encrypted as string;
  const isDemo = conn.account_type === "demo";
  const base = isDemo ? "https://www.okx.com" : "https://www.okx.com"; // OKX uses x-simulated-trading header for demo

  const trades: NormalizedTrade[] = [];
  const after = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Closed orders
  const orders = await okxFetch(base, "/api/v5/trade/orders-history", apiKey, apiSecret, passphrase, {
    instType: "SWAP", after, limit: "100"
  });
  if (orders) {
    for (const o of orders) {
      if (o.state !== "filled") continue;
      const ts = new Date(parseInt(o.fillTime || o.uTime));
      const pnl = parseFloat(o.pnl || "0");
      trades.push({
        external_trade_id: `okx-${o.ordId}`,
        symbol: (o.instId || "").replace("-USDT-SWAP", "/USDT").replace("-USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.fillSz || o.sz),
        lot_unit: "qty",
        entry_price: parseFloat(o.avgPx || o.px),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(o.fee || "0") * -1,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  // Spot orders
  const spotOrders = await okxFetch(base, "/api/v5/trade/orders-history", apiKey, apiSecret, passphrase, {
    instType: "SPOT", after, limit: "100"
  });
  if (spotOrders) {
    for (const o of spotOrders) {
      if (o.state !== "filled") continue;
      const ts = new Date(parseInt(o.fillTime || o.uTime));
      trades.push({
        external_trade_id: `okx-spot-${o.ordId}`,
        symbol: (o.instId || "").replace("-USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.fillSz || o.sz),
        lot_unit: "qty",
        entry_price: parseFloat(o.avgPx || o.px),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(o.fee || "0") * -1,
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

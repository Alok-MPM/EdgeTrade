import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

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
  if (!res.ok) return null;
  return res.json();
}

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const isDemo = conn.account_type === "demo"; // Gate uses live API for both, demo is simulated
  const trades: NormalizedTrade[] = [];
  const from = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000).toString();

  // Spot orders
  const spotOrders = await gateFetch("/api/v4/spot/orders", { status: "finished", from, limit: "500" }, apiKey, apiSecret);
  if (Array.isArray(spotOrders)) {
    for (const o of spotOrders) {
      if (o.status !== "closed") continue;
      const ts = parseFloat(o.update_time || o.create_time) * 1000;
      trades.push({
        external_trade_id: `gate-${o.id}`,
        symbol: (o.currency_pair || "").replace("_USDT", "/USDT"),
        direction: o.side === "buy" ? "long" : "short",
        lot_size: parseFloat(o.amount),
        lot_unit: "qty",
        entry_price: parseFloat(o.avg_deal_price || o.price),
        exit_price: null,
        entry_time: msToTime(ts),
        fees: parseFloat(o.fee || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: msToDate(ts),
      });
    }
  }

  // Futures closed positions
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

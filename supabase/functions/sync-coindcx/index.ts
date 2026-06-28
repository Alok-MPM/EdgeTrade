import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const ts = Date.now();
  const body = JSON.stringify({ timestamp: ts });
  const sig = await hmacSha256Hex(apiSecret, body);

  const res = await fetch("https://api.coindcx.com/exchange/v1/orders/trade_history", {
    method: "POST",
    headers: { "X-AUTH-APIKEY": apiKey, "X-AUTH-SIGNATURE": sig, "Content-Type": "application/json" },
    body,
  });
  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data)) {
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      for (const t of data) {
        const tradeTs = parseInt(t.timestamp) || Date.now();
        if (tradeTs < cutoff) continue;
        trades.push({
          external_trade_id: `coindcx-${t.id}`,
          symbol: (t.market || "").replace("INR", "/INR").replace("USDT", "/USDT"),
          direction: t.side === "buy" ? "long" : "short",
          lot_size: parseFloat(t.quantity),
          lot_unit: "qty",
          entry_price: parseFloat(t.price),
          exit_price: null,
          entry_time: msToTime(tradeTs),
          fees: parseFloat(t.fee_amount || "0"),
          stop_loss: null,
          take_profit: null,
          conclusion: "target",
          date: msToDate(tradeTs),
        });
      }
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

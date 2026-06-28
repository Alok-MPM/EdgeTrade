import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, msToDate, msToTime, NormalizedTrade } from "../_shared/utils.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";

serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const apiSecret = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];
  const ts = Date.now();
  const params = `recvWindow=5000&timestamp=${ts}`;
  const sig = await hmacSha256Hex(apiSecret, params);
  const res = await fetch(`https://api.wazirx.com/sapi/v1/myTrades?${params}&signature=${sig}`, {
    headers: { "X-Api-Key": apiKey }
  });
  if (res.ok) {
    const data = await res.json();
    if (Array.isArray(data)) {
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      for (const t of data) {
        const tradeTs = parseInt(t.time);
        if (tradeTs < cutoff) continue;
        trades.push({
          external_trade_id: `wazirx-${t.id}`,
          symbol: (t.symbol || "").replace("inr", "/INR").replace("usdt", "/USDT").toUpperCase(),
          direction: t.isBuyer ? "long" : "short",
          lot_size: parseFloat(t.qty),
          lot_unit: "qty",
          entry_price: parseFloat(t.price),
          exit_price: null,
          entry_time: msToTime(tradeTs),
          fees: parseFloat(t.commission || "0"),
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

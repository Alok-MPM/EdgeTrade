import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, NormalizedTrade } from "../_shared/utils.ts";

// Alice Blue ANT API
// api_key_encrypted = client ID
// api_secret_encrypted = session_id (from ANT API login)
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const clientId = conn.api_key_encrypted as string;
  const sessionId = conn.api_secret_encrypted as string;
  const trades: NormalizedTrade[] = [];

  const authHeader = `${clientId} ${sessionId}`;
  const res = await fetch("https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/placeOrder/fetchTradeBook", {
    method: "GET",
    headers: { "Authorization": authHeader, "Content-Type": "application/json" }
  });

  if (res.ok) {
    const data = await res.json();
    const tradebook = Array.isArray(data) ? data : (data?.data || []);
    for (const t of tradebook) {
      const tsStr = t.Filltime || t.OrderTime || "";
      const ts = tsStr ? new Date(tsStr) : new Date();
      trades.push({
        external_trade_id: `alice-${t.Nstordno || t.OrderId}-${t.Fillid || "0"}`,
        symbol: t.Trsym || t.Symbol || "UNKNOWN",
        direction: t.Trantype === "B" ? "long" : "short",
        lot_size: parseFloat(t.Fillshares || t.Qty || "0"),
        lot_unit: "qty",
        entry_price: parseFloat(t.Flprc || t.Price || "0"),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: "target",
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

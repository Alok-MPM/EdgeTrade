import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "../_shared/utils.ts";

// Angel One SmartAPI
// api_key_encrypted = SmartAPI API Key
// api_secret_encrypted = client code (e.g. A123456)
// api_passphrase_encrypted = JWT token from SmartAPI login session
serve((req) => handleSyncRequest(req, async (conn, supabase) => {
  const apiKey = conn.api_key_encrypted as string;
  const jwtToken = conn.api_passphrase_encrypted as string;
  const trades: NormalizedTrade[] = [];

  async function angelFetch(path: string, body: Record<string, unknown>) {
    const res = await fetch(`https://apiconnect.angelbroking.com${path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwtToken}`,
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
        "X-CLIENT-LOCAL-IP": "127.0.0.1",
        "X-CLIENT-PUBLIC-IP": "127.0.0.1",
        "X-MAC-ADDRESS": "00:00:00:00:00:00",
        "X-PRIVATE-KEY": apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data || null;
  }

  // Trade book
  const tradebook = await angelFetch("/rest/secure/angelbroking/order/v1/getTradeBook", {});
  if (Array.isArray(tradebook)) {
    for (const t of tradebook) {
      const ts = new Date(t.filltime || t.updatetime || new Date());
      const pnl = parseFloat(t.pnl || "0");
      trades.push({
        external_trade_id: `angel-${t.uniqueorderid || t.orderid}-${t.tradeid || "0"}`,
        symbol: t.tradingsymbol || "UNKNOWN",
        direction: t.transactiontype === "BUY" ? "long" : "short",
        lot_size: parseFloat(t.fillsize || t.quantity),
        lot_unit: "qty",
        entry_price: parseFloat(t.fillprice || t.price),
        exit_price: null,
        entry_time: ts.toTimeString().slice(0, 5),
        fees: 0,
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl !== 0 ? pnl : null),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}));

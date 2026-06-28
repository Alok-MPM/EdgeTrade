// Shared MetaAPI logic for all MT4/MT5 brokers
// MetaAPI docs: https://metaapi.cloud/docs/client/
import { saveSyncedTrades, pnlToConclusion, NormalizedTrade } from "./utils.ts";

const META_API_BASE = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

async function metaApiFetch(path: string, token: string) {
  const res = await fetch(`${META_API_BASE}${path}`, {
    headers: { "auth-token": token }
  });
  if (!res.ok) return null;
  return res.json();
}

async function provisionMetaApiAccount(conn: Record<string, unknown>, token: string): Promise<string> {
  // Check if account already provisioned (stored in extra_data)
  const extra = conn.extra_data as Record<string, unknown> | null;
  if (extra?.metaapi_account_id) return extra.metaapi_account_id as string;

  // Create new MetaAPI account
  const isDemo = conn.account_type === "demo";
  const body = JSON.stringify({
    login: conn.mt_login,
    password: conn.mt_investor_password_encrypted,
    name: conn.account_label || "EdgeTrade Account",
    server: conn.mt_server,
    platform: "mt5",
    magic: 0,
    type: isDemo ? "cloud-g2" : "cloud-g2",
    region: "london",
  });

  const res = await fetch(`${META_API_BASE}/users/current/accounts`, {
    method: "POST",
    headers: { "auth-token": token, "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`MetaAPI account creation failed: ${err}`);
  }

  const data = await res.json();
  return data.id;
}

export async function syncMt5Account(conn: Record<string, unknown>, supabase: unknown): Promise<number> {
  const metaApiToken = Deno.env.get("METAAPI_TOKEN");
  if (!metaApiToken) throw new Error("METAAPI_TOKEN secret not configured. Please add it in Supabase Dashboard → Edge Functions → Secrets.");

  const accountId = await provisionMetaApiAccount(conn, metaApiToken);
  const trades: NormalizedTrade[] = [];

  // Wait for account to deploy (max 30s)
  let deployed = false;
  for (let i = 0; i < 6; i++) {
    const acc = await metaApiFetch(`/users/current/accounts/${accountId}`, metaApiToken);
    if (acc?.state === "DEPLOYED") { deployed = true; break; }
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!deployed) throw new Error("MetaAPI account not ready. Please retry in a minute.");

  // Fetch trade history
  const startTime = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const endTime = new Date().toISOString();
  const history = await metaApiFetch(
    `/users/current/accounts/${accountId}/history-deals/time/${encodeURIComponent(startTime)}/${encodeURIComponent(endTime)}`,
    metaApiToken
  );

  if (Array.isArray(history)) {
    for (const deal of history) {
      if (deal.type !== "DEAL_TYPE_BUY" && deal.type !== "DEAL_TYPE_SELL") continue;
      if (deal.entryType !== "DEAL_ENTRY_OUT" && deal.entryType !== "DEAL_ENTRY_INOUT") continue;

      const ts = new Date(deal.time);
      const pnl = parseFloat(deal.profit || "0");
      trades.push({
        external_trade_id: `mt5-${accountId}-${deal.id}`,
        symbol: deal.symbol || "UNKNOWN",
        direction: deal.type === "DEAL_TYPE_BUY" ? "long" : "short",
        lot_size: parseFloat(deal.volume || "0"),
        lot_unit: "lot",
        entry_price: parseFloat(deal.openPrice || deal.price || "0"),
        exit_price: parseFloat(deal.price || "0"),
        entry_time: ts.toTimeString().slice(0, 5),
        fees: parseFloat(deal.commission || "0") + parseFloat(deal.swap || "0"),
        stop_loss: null,
        take_profit: null,
        conclusion: pnlToConclusion(pnl),
        date: ts.toISOString().split("T")[0],
      });
    }
  }

  return await saveSyncedTrades(supabase as never, conn.user_id as string, conn.id as string, trades);
}

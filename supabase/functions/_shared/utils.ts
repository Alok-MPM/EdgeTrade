import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function decryptData(ciphertext: string, secret: string): Promise<string> {
  const decoder = new TextDecoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.padEnd(32, "0").slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyMaterial, encrypted);
  return decoder.decode(decrypted);
}

export function getSupabaseAdmin(): SupabaseClient {
  console.log("KEY CHECK:", !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), !!Deno.env.get("SUPABASE_ANON_KEY"));
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

export async function getConnection(supabase: SupabaseClient, connectionId: string) {
  const { data, error } = await supabase
    .from("user_broker_connections")
    .select("id, user_id, broker_id, account_label, account_type, api_key_encrypted, api_secret_encrypted, api_passphrase_encrypted, mt_server, mt_login, mt_investor_password_encrypted, sync_status, last_sync, is_active, extra_data")
    .eq("id", connectionId)
    .single();
  if (error || !data) throw new Error("Connection not found: " + (error?.message || "no data"));
  const secret = Deno.env.get("ENCRYPTION_SECRET") ?? "edgetrade-default-secret-key-2024";
  try { if (data.api_key_encrypted) data.api_key_encrypted = await decryptData(data.api_key_encrypted, secret); } catch { }
  try { if (data.api_secret_encrypted) data.api_secret_encrypted = await decryptData(data.api_secret_encrypted, secret); } catch { }
  try { if (data.api_passphrase_encrypted) data.api_passphrase_encrypted = await decryptData(data.api_passphrase_encrypted, secret); } catch { }
  try { if (data.mt_investor_password_encrypted) data.mt_investor_password_encrypted = await decryptData(data.mt_investor_password_encrypted, secret); } catch { }
  return data;
}

export async function getOrCreateTradingDay(
  supabase: SupabaseClient,
  userId: string,
  connectionId: string,
  date: string
): Promise<string> {
  const { data: existing } = await supabase
    .from("trading_days")
    .select("id")
    .eq("user_id", userId)
    .eq("broker_id", connectionId)
    .eq("date", date)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const { data: created, error } = await supabase
    .from("trading_days")
    .insert([{ user_id: userId, broker_id: connectionId, date }])
    .select("id")
    .single();

  if (error) {
    // Race condition: try fetching again
    const { data: retry } = await supabase
      .from("trading_days")
      .select("id")
      .eq("user_id", userId)
      .eq("broker_id", connectionId)
      .eq("date", date)
      .single();
    if (retry?.id) return retry.id;
    throw new Error("Failed to create trading day: " + error.message);
  }
  return created.id;
}

export interface NormalizedTrade {
  external_trade_id: string;
  symbol: string;
  direction: "long" | "short";
  lot_size: number | null;
  lot_unit: string;
  entry_price: number | null;
  exit_price: number | null;
  entry_time: string | null;
  fees: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  conclusion: "target" | "loss" | "breakeven";
  date: string; // YYYY-MM-DD
}

export async function saveSyncedTrades(
  supabase: SupabaseClient,
  userId: string,
  connectionId: string,
  trades: NormalizedTrade[]
): Promise<number> {
  let count = 0;
  for (const trade of trades) {
    if (!trade.external_trade_id || !trade.date) continue;

    const { data: existing } = await supabase
      .from("trades")
      .select("id")
      .eq("user_id", userId)
      .eq("external_trade_id", trade.external_trade_id)
      .maybeSingle();

    if (existing?.id) continue; // already synced

    const dayId = await getOrCreateTradingDay(supabase, userId, connectionId, trade.date);

    const { error } = await supabase.from("trades").insert([{
      day_id: dayId,
      user_id: userId,
      connection_id: connectionId,
      external_trade_id: trade.external_trade_id,
      chart_name: trade.symbol,
      direction: trade.direction,
      lot_size: trade.lot_size,
      lot_unit: trade.lot_unit || "qty",
      entry_price: trade.entry_price,
      exit_price: trade.exit_price,
      entry_time: trade.entry_time,
      fees: trade.fees,
      stop_loss: trade.stop_loss,
      take_profit: trade.take_profit,
      conclusion: trade.conclusion,
    }]);

    if (!error) count++;
  }
  return count;
}

export async function updateSyncStatus(
  supabase: SupabaseClient,
  connectionId: string,
  status: "success" | "error"
) {
  await supabase
    .from("user_broker_connections")
    .update({ sync_status: status, last_sync: new Date().toISOString() })
    .eq("id", connectionId);
}

// decryption enabled v2
export function pnlToConclusion(pnl: number | null): "target" | "loss" | "breakeven" {
  if (pnl === null || pnl === undefined) return "breakeven";
  if (pnl > 0) return "target";
  if (pnl < 0) return "loss";
  return "breakeven";
}

export function msToDate(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

export function isoToDate(iso: string): string {
  return iso.split("T")[0];
}

export function msToTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}
// updated Sun Jun 28 09:53:03 UTC 2026

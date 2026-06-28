// Reusable edge function wrapper - handles CORS, errors, and status updates
import { corsHeaders, getSupabaseAdmin, getConnection, updateSyncStatus } from "./utils.ts";

export async function handleSyncRequest(
  req: Request,
  brokerSyncFn: (conn: Record<string, unknown>, supabase: unknown) => Promise<number>
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let connectionId = "";
  try {
    const body = await req.json();
    connectionId = body.connection_id;
    if (!connectionId) throw new Error("connection_id is required");

    const supabase = getSupabaseAdmin();
    const conn = await getConnection(supabase, connectionId);
    const count = await brokerSyncFn(conn, supabase);
    await updateSyncStatus(supabase, connectionId, "success");

    return new Response(
      JSON.stringify({ trades_synced: count }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    if (connectionId) {
      try {
        const supabase = getSupabaseAdmin();
        await updateSyncStatus(supabase, connectionId, "error");
      } catch { /* ignore */ }
    }
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

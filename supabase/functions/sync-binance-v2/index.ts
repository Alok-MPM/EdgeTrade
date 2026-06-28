import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
      if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
        try {
                const { connection_id } = await req.json();
                    const supabase = createClient(
                              Deno.env.get("SUPABASE_URL")!,
                                    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
                    );
                        const { data, error } = await supabase
                              .from("user_broker_connections")
                                    .select("*")
                                          .eq("id", connection_id)
                                                .single();
                                                    console.log("RAW DATA:", JSON.stringify(data), "ERROR:", JSON.stringify(error));
                                                        if (error || !data) throw new Error("Connection not found");
                                                            await supabase.from("user_broker_connections").update({ sync_status: "success", last_sync: new Date().toISOString() }).eq("id", connection_id);
                                                                return new Response(JSON.stringify({ trades_synced: 0, message: "Connected! No trades yet." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        } catch (err) {
                return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
});

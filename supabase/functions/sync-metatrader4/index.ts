import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleSyncRequest } from "../_shared/edge-handler.ts";
import { syncMt5Account } from "../_shared/mt5-sync.ts";
serve((req) => handleSyncRequest(req, (conn, supabase) => syncMt5Account(conn, supabase)));

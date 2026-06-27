// supabase/functions/upload-avatar/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Auth check ──────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization header missing' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // User-scoped client (respects RLS)
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2. Parse file ──────────────────────────────────────────
    const formData = await req.formData()
    const file = formData.get('avatar') as File | null
    if (!file) {
      return new Response(
        JSON.stringify({ error: 'No file provided. Field name: "avatar"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: 'File too large. Max 2MB allowed.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate type
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (!allowed.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: 'Invalid type. Allowed: jpg, png, webp, gif' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
    const filePath = `${user.id}/avatar.${ext}`

    // ── 3. Admin client for storage (bypass RLS) ───────────────
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // ── 4. Upload to storage ───────────────────────────────────
    const bytes = await file.arrayBuffer()
    const { error: uploadError } = await adminClient.storage
      .from('avatars')
      .upload(filePath, bytes, {
        contentType: file.type,
        upsert: true,    // overwrite existing avatar
        cacheControl: '3600',
      })

    if (uploadError) {
      return new Response(
        JSON.stringify({ error: 'Upload failed: ' + uploadError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 5. Get public URL ──────────────────────────────────────
    const { data: { publicUrl } } = adminClient.storage
      .from('avatars')
      .getPublicUrl(filePath)

    // Add cache-busting timestamp so browser loads fresh image
    const urlWithTs = `${publicUrl}?t=${Date.now()}`

    // ── 6. Save URL to profiles table ─────────────────────────
    const { error: dbError } = await adminClient
      .from('profiles')
      .update({ avatar_url: urlWithTs })
      .eq('id', user.id)

    if (dbError) {
      return new Response(
        JSON.stringify({ error: 'DB update failed: ' + dbError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 7. Success ─────────────────────────────────────────────
    return new Response(
      JSON.stringify({ url: urlWithTs, user_id: user.id }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

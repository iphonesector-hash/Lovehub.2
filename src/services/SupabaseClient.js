// src/services/SupabaseClient.js
// Shared Supabase client for the Phase 1 ES-module services.
//
// Reuses the already-loaded UMD build (window.supabase from the CDN script in
// index.html) and the project config from supabase/config.js (SUPABASE_CONFIG).
// Session persistence is handled natively by supabase-js (localStorage);
// detectSessionInUrl processes email-confirmation / password-reset return links.

const url = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG.url : null;
const anonKey = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG.anonKey : null;
const sdkAvailable = (typeof window !== 'undefined') && !!window.supabase;

export const supabaseClient =
    (url && anonKey && sdkAvailable)
        ? window.supabase.createClient(url, anonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        })
        : null;

export const isSupabaseReady = () => !!supabaseClient;

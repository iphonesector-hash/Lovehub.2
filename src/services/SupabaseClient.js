// src/services/SupabaseClient.js
// Shared Supabase client for the Phase 1 ES-module services.
//
// Loads the SDK from the VENDORED copy in assets/vendor/supabase-js (no CDN
// dependency at runtime) and the project config from supabase/config.js.
// Session persistence is handled natively by supabase-js (localStorage);
// detectSessionInUrl processes email-confirmation / password-recovery links.
//
// Diagnostics: getInitStatus() explains exactly WHY the backend is not ready,
// so the UI never silently degrades to demo mode when Supabase is configured
// but broken.

const url = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG.url : null;
const anonKey = (typeof SUPABASE_CONFIG !== 'undefined') ? SUPABASE_CONFIG.anonKey : null;
const sdkAvailable = (typeof window !== 'undefined') && !!window.supabase;

let initStatus;
let client = null;

if (!url || !anonKey) {
    initStatus = {
        status: 'missing-config',
        reason: 'supabase/config.js is missing or incomplete. Copy supabase/config.example.js to supabase/config.js and fill in the URL + anon key.'
    };
} else if (!sdkAvailable) {
    initStatus = {
        status: 'missing-sdk',
        reason: 'The Supabase SDK failed to load (assets/vendor/supabase-js/umd/supabase.js). Check the script tag in index.html.'
    };
} else {
    try {
        client = window.supabase.createClient(url, anonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            }
        });
        initStatus = { status: 'ok', reason: null };
    } catch (error) {
        client = null;
        initStatus = {
            status: 'init-error',
            reason: `Supabase initialization failed: ${error.message || error}`
        };
    }
}

export const supabaseClient = client;
export const isSupabaseReady = () => initStatus.status === 'ok';
export const getInitStatus = () => initStatus;

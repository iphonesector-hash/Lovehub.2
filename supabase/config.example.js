// supabase/config.example.js
// Template for real project credentials.
//
// LOCAL development: copy this file to supabase/config.js and fill in your
// values. supabase/config.js is git-ignored so real keys are never committed.
//
// PRODUCTION deploys (Vercel / Freebuff hosting): config.js does not
// exist in the clean build checkout, so scripts/build.sh GENERATES
// dist/supabase/config.js from the SUPABASE_URL and SUPABASE_ANON_KEY
// environment variables (see supabase/README.md → "Production deploys"). No
// keys are committed to the repository in any case — use the anon/public key
// here, never the service_role key.
//
// Find both values in your Supabase Dashboard → Project Settings → API.

const SUPABASE_CONFIG = {
    url: 'https://YOUR_PROJECT_REF.supabase.co',
    anonKey: 'YOUR_ANON_KEY'
};

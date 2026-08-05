// src/main.js
// LoveHub ES-module boot entry (Phase 0: icons — Phase 1: auth —
// Phase 2: couple system + onboarding — Phase 2.1: init diagnostics + recovery).
//
// Loaded from index.html as <script type="module" src="src/main.js">.
// Module scripts run after HTML parsing, so DOM references below are safe.
// Future phases add the router, services, and page modules to this boot
// chain without touching the legacy scripts until each piece is verified.

import { installIcons } from './icons/IconService.js';
import { AuthService } from './services/AuthService.js';
import { ProfileService } from './services/ProfileService.js';
import { CoupleService } from './services/CoupleService.js';
import { OnboardingFlow } from './onboarding/OnboardingFlow.js';
import { getInitStatus } from './services/SupabaseClient.js';

installIcons();

// Phase 1: real Supabase auth + profiles.
// Phase 2: couple system + onboarding.
// Phase 2.1: init diagnostics — the UI can show the REAL reason when the
// backend is unavailable instead of silently falling back to demo mode.
const loveHubAuth = new AuthService();
const loveHubProfile = new ProfileService();
const loveHubCouple = new CoupleService();
window.LoveHubAuth = loveHubAuth;
window.LoveHubProfile = loveHubProfile;
window.LoveHubCouple = loveHubCouple;
window.LoveHubOnboarding = new OnboardingFlow();
window.LoveHubInit = getInitStatus();

// Set when a password-recovery link arrives before the legacy app exists
// (module scripts run before DOMContentLoaded). app.js checks it in init().
window.LoveHubPendingRecovery = false;

if (loveHubAuth.isReady()) {
    // Session persistence + email-confirmation / password-recovery return
    // flow: detectSessionInUrl processes the link tokens in the URL.
    loveHubAuth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') {
            if (window.app?.openRecovery) {
                window.app.openRecovery();
            } else {
                window.LoveHubPendingRecovery = true;
            }
            return;
        }
        if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && window.app?.refreshAuthFromSupabase) {
            window.app.refreshAuthFromSupabase();
        }
        if (event === 'SIGNED_OUT' && window.app) {
            window.app.currentUser = null;
            window.app.currentProfile = null;
            window.app.currentCouple = null;
            window.app.updateAuthUI();
            window.app.renderProfile();
        }
    });
    // Seed the cached session on boot (also auto-signs-in when arriving from
    // an email confirmation / recovery link).
    loveHubAuth.getSession();
}

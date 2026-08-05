// src/main.js
// LoveHub ES-module boot entry (Phase 0: icons — Phase 1: auth —
// Phase 2: couple system + onboarding).
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

installIcons();

// Phase 1: real Supabase auth + profiles.
// Phase 2: couple system + onboarding.
// Exposed on window so the legacy app.js can consume them without a rewrite
// (incremental migration — old services stay until each piece is verified).
const loveHubAuth = new AuthService();
const loveHubProfile = new ProfileService();
const loveHubCouple = new CoupleService();
window.LoveHubAuth = loveHubAuth;
window.LoveHubProfile = loveHubProfile;
window.LoveHubCouple = loveHubCouple;
window.LoveHubOnboarding = new OnboardingFlow();

if (loveHubAuth.isReady()) {
    // Session persistence + email-confirmation / password-reset return flow:
    // when the user clicks the link in the confirmation email, the page opens
    // and detectSessionInUrl signs them in — this listener refreshes the UI.
    loveHubAuth.onAuthStateChange((event) => {
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

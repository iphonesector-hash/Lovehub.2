// src/main.js
// LoveHub ES-module boot entry. The module owns the single Supabase auth
// listener and publishes state changes to the legacy UI shell.

import { installIcons } from './icons/IconService.js';
import { AuthService } from './services/AuthService.js';
import { ProfileService } from './services/ProfileService.js';
import { CoupleService } from './services/CoupleService.js';
import { ChatService } from './services/ChatService.js';
import { NotificationService } from './services/NotificationService.js';
import { OnboardingFlow } from './onboarding/OnboardingFlow.js';
import { getInitStatus } from './services/SupabaseClient.js';

installIcons();

const loveHubAuth = new AuthService();
const loveHubProfile = new ProfileService();
const loveHubCouple = new CoupleService();
const loveHubChat = new ChatService();
const loveHubNotifications = new NotificationService();
window.LoveHubAuth = loveHubAuth;
window.LoveHubProfile = loveHubProfile;
window.LoveHubCouple = loveHubCouple;
window.LoveHubChat = loveHubChat;
window.LoveHubNotifications = loveHubNotifications;
window.LoveHubOnboarding = new OnboardingFlow();
window.LoveHubInit = getInitStatus();
window.LoveHubPendingRecovery = false;

let appReady = false;
const queuedEvents = [];

function getApp() {
    return window.app || null;
}

function dispatchAuthEvent(event, session) {
    const app = getApp();
    if (!appReady || !app) {
        queuedEvents.push({ event, session });
        if (event === 'PASSWORD_RECOVERY') window.LoveHubPendingRecovery = true;
        return;
    }

    if (event === 'PASSWORD_RECOVERY') {
        app.openRecovery?.();
        return;
    }
    if (event === 'SIGNED_OUT') {
        app.handleSignedOut?.();
        return;
    }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        app.handleSignedIn?.(session, event);
    }
}

window.LoveHubMarkAppReady = (app) => {
    if (app) window.app = app;
    appReady = true;
    const events = queuedEvents.splice(0);
    for (const { event, session } of events) dispatchAuthEvent(event, session);
};

if (loveHubAuth.isReady()) {
    loveHubAuth.onAuthStateChange(dispatchAuthEvent);
    // Supabase emits INITIAL_SESSION from its own auth client. This explicit
    // read is only the shared boot promise; it does not create a second flow.
    loveHubAuth.initialize();
}

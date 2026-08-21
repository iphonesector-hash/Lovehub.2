// src/main.js
// LoveHub ES-module boot entry. The module owns the single Supabase auth
// listener and publishes state changes to the legacy UI shell.

import { installIcons } from './icons/IconService.js';
import { AuthService } from './services/AuthService.js';
import { installUsernameLoginFallback } from './services/UsernameLoginBridge.js';
import { ProfileService } from './services/ProfileService.js';
import { CoupleService } from './services/CoupleService.js';
import { ChatService } from './services/ChatService.js';
import { MusicService } from './services/MusicService.js';
import { LyricsService } from './services/LyricsService.js';
import { NotificationService } from './services/NotificationService.js';
import { SoundService } from './services/SoundService.js';
import { OnboardingFlow } from './onboarding/OnboardingFlow.js';
import { getInitStatus } from './services/SupabaseClient.js';
import { installItunesMusicProviderWhenReady } from './services/ItunesMusicProvider.js';

installIcons();
installItunesMusicProviderWhenReady();
installUsernameLoginFallback(AuthService);

const loveHubAuth = new AuthService();
const loveHubProfile = new ProfileService();
const loveHubCouple = new CoupleService();
const loveHubChat = new ChatService();
const loveHubMusic = new MusicService();
const loveHubLyrics = new LyricsService();
const loveHubNotifications = new NotificationService();
const loveHubSounds = new SoundService();
window.LoveHubAuth = loveHubAuth;
window.LoveHubProfile = loveHubProfile;
window.LoveHubCouple = loveHubCouple;
window.LoveHubChat = loveHubChat;
window.LoveHubMusic = loveHubMusic;
window.LoveHubLyrics = loveHubLyrics;
window.LoveHubNotifications = loveHubNotifications;
window.LoveHubSounds = loveHubSounds;
window.LoveHubOnboarding = new OnboardingFlow();
window.LoveHubInit = getInitStatus();
window.LoveHubPendingRecovery = false;

let appReady = false;
const queuedEvents = [];

function getApp() {
    return window.app || null;
}

function syncPersistedAvatar(app) {
    if (!app?.currentUser || !app?.currentProfile || !window.userService) return;
    if (app.currentProfile.avatar_url) {
        window.userService.saveAvatar(app.currentUser.id, app.currentProfile.avatar_url);
    } else {
        window.userService.removeAvatar(app.currentUser.id);
    }
    app.renderProfile?.();
    app.updateAvatars?.();
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
        Promise.resolve(app.handleSignedIn?.(session, event)).then(() => syncPersistedAvatar(app));
    }
}

window.LoveHubMarkAppReady = (app) => {
    if (app) window.app = app;
    appReady = true;
    syncPersistedAvatar(app);
    const events = queuedEvents.splice(0);
    for (const { event, session } of events) dispatchAuthEvent(event, session);
};

if (loveHubAuth.isReady()) {
    loveHubAuth.onAuthStateChange(dispatchAuthEvent);
    // Supabase emits INITIAL_SESSION from its own auth client. This explicit
    // read is only the shared boot promise; it does not create a second flow.
    loveHubAuth.initialize();
}

// Security hardening for the legacy account-settings modal. app.js historically
// collected the current password but discarded it for real Supabase users.
// Capture the click before the legacy bubble listener and route real accounts
// through AuthService.changePassword(), which reauthenticates first. Demo users
// continue through the unchanged legacy handler in app.js.
const passwordSubmit = document.getElementById('submitChangePassword');
if (passwordSubmit) {
    passwordSubmit.addEventListener('click', async (event) => {
        if (!loveHubAuth.isReady() || !loveHubAuth.isSupabaseUser()) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        const app = getApp();
        const current = document.getElementById('currentPassword')?.value || '';
        const newPass = document.getElementById('newPassword')?.value || '';
        const confirmPass = document.getElementById('confirmPassword')?.value || '';

        if (!current || !newPass || !confirmPass) {
            app?.showToast?.('Please fill all fields');
            return;
        }
        if (newPass !== confirmPass) {
            app?.showToast?.('Passwords do not match');
            return;
        }
        if (newPass.length < 6) {
            app?.showToast?.('Password must be at least 6 characters');
            return;
        }
        if (newPass === current) {
            app?.showToast?.('New password must be different');
            return;
        }

        const previousText = passwordSubmit.textContent;
        passwordSubmit.disabled = true;
        passwordSubmit.textContent = 'Changing...';
        try {
            const result = await loveHubAuth.changePassword(current, newPass);
            if (!result.success) {
                app?.showToast?.(result.error || 'Could not change password');
                return;
            }

            document.getElementById('changePasswordModal')?.classList.remove('active');
            const currentField = document.getElementById('currentPassword');
            const newField = document.getElementById('newPassword');
            const confirmField = document.getElementById('confirmPassword');
            if (currentField) currentField.value = '';
            if (newField) newField.value = '';
            if (confirmField) confirmField.value = '';
            app?.showToast?.('Password changed successfully');
        } finally {
            passwordSubmit.disabled = false;
            passwordSubmit.textContent = previousText || 'Change Password';
        }
    }, true);
}

// Real-account avatar bridge. The legacy shell still renders avatars from its
// local cache, so persist the source of truth in Supabase Storage/Profile and
// mirror only the resulting public URL into that cache for compatibility.
const avatarInput = document.getElementById('avatarFileInput');
if (avatarInput) {
    avatarInput.addEventListener('change', async (event) => {
        if (!loveHubAuth.isReady() || !loveHubAuth.isSupabaseUser()) return;

        event.stopImmediatePropagation();
        const app = getApp();
        const file = event.target.files?.[0];
        if (!file || !app?.currentUser?.id) return;

        const result = await loveHubProfile.uploadAvatar(app.currentUser.id, file);
        event.target.value = '';
        if (!result.success) {
            app.showToast?.(result.error || 'Could not upload photo');
            return;
        }

        app.currentProfile = result.profile;
        window.userService?.saveAvatar(app.currentUser.id, result.avatarUrl);
        document.getElementById('avatarModal')?.classList.remove('active');
        app.renderProfile?.();
        app.updateAvatars?.();
        app.showToast?.('Photo updated');
    }, true);
}

const removeAvatarButton = document.getElementById('removeAvatarBtn');
if (removeAvatarButton) {
    removeAvatarButton.addEventListener('click', async (event) => {
        if (!loveHubAuth.isReady() || !loveHubAuth.isSupabaseUser()) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        const app = getApp();
        if (!app?.currentUser?.id) return;

        const result = await loveHubProfile.removeAvatar(app.currentUser.id, app.currentProfile?.avatar_url || null);
        if (!result.success) {
            app.showToast?.(result.error || 'Could not remove photo');
            return;
        }

        app.currentProfile = result.profile;
        window.userService?.removeAvatar(app.currentUser.id);
        document.getElementById('avatarModal')?.classList.remove('active');
        app.renderProfile?.();
        app.updateAvatars?.();
        app.showToast?.('Photo removed');
    }, true);
}

// Real lyrics for the canonical player. Capture the existing Lyrics button so
// the old placeholder handler never wins when a track is loaded.
const lyricsButton = document.getElementById('npLyrics');
if (lyricsButton) {
    lyricsButton.addEventListener('click', async (event) => {
        const track = window.LoveHubMusicPlayer?.current || null;
        if (!track) {
            getApp()?.showToast?.('No track selected');
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        await loveHubLyrics.openForTrack(track);
    }, true);
}

// Phase 3 — service worker: offline shell + asset caching (sw.js). Safe in
// every modern browser (https or localhost); guarded so a missing SW API can
// never break the app.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('[SW] registration failed:', err);
        });
    });
}

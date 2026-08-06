// stickers.js — LoveHub animated sticker packs (Phase 3.2, fixed in 3.3).
// Classic (non-module) global so app.js can use it, mirroring icons.js.
// Stickers are emoji + CSS animation classes (style.css `@keyframes sticker-*`),
// so they are resolution-independent and work offline — no binary assets.
//
// A sticker message stores `content = sticker id`; the receiver renders the
// same definition from this registry (realtime-friendly).
//
// Phase 3.3 fix: the top-level consts below are *lexical* globals and are NOT
// properties of `window`. The chat layer reads `window.LoveHubStickers`,
// `window.LoveHubStickerCategories` and `window.LoveHubStickerById`, which were
// undefined — that made the sticker picker render empty and sticker bubbles
// fall back to a generic heart. We now mirror the registry onto window (while
// keeping the consts for any code that references the bare globals).

const LoveHubStickers = [
    // ❤️ Love
    { id: 'love-heartbeat', cat: 'love', emoji: '❤️', anim: 'heartbeat', label: 'Heartbeat' },
    { id: 'love-kiss', cat: 'love', emoji: '💋', anim: 'float', label: 'Kiss' },
    { id: 'love-dizzy', cat: 'love', emoji: '😍', anim: 'pulse', label: 'Adore' },
    { id: 'love-hug', cat: 'love', emoji: '🤗', anim: 'squish', label: 'Hug' },
    // 🥰 Cute
    { id: 'cute-blush', cat: 'cute', emoji: '🥰', anim: 'pulse', label: 'Blush' },
    { id: 'cute-cat', cat: 'cute', emoji: '😻', anim: 'wobble', label: 'Love cat' },
    { id: 'cute-bear', cat: 'cute', emoji: '🧸', anim: 'float', label: 'Teddy' },
    { id: 'cute-star', cat: 'cute', emoji: '⭐', anim: 'spin', label: 'Star' },
    // 💋 Romantic
    { id: 'rom-wine', cat: 'romantic', emoji: '🍷', anim: 'float', label: 'Cheers' },
    { id: 'rom-candle', cat: 'romantic', emoji: '🕯️', anim: 'flicker', label: 'Candle' },
    { id: 'rom-rose', cat: 'romantic', emoji: '🌹', anim: 'sway', label: 'Rose' },
    { id: 'rom-dinner', cat: 'romantic', emoji: '🍽️', anim: 'wobble', label: 'Dinner' },
    // 🌙 Night
    { id: 'night-moon', cat: 'night', emoji: '🌙', anim: 'float', label: 'Goodnight' },
    { id: 'night-stars', cat: 'night', emoji: '🌠', anim: 'spin', label: 'Stars' },
    { id: 'night-sleep', cat: 'night', emoji: '😴', anim: 'pulse', label: 'Sleepy' },
    // ☕ Together
    { id: 'tog-coffee', cat: 'together', emoji: '☕', anim: 'sway', label: 'Coffee date' },
    { id: 'tog-walk', cat: 'together', emoji: '🚶', anim: 'bob', label: 'Walk' },
    { id: 'tog-home', cat: 'together', emoji: '🏡', anim: 'bob', label: 'Home' },
    // 🎂 Special
    { id: 'spec-cake', cat: 'special', emoji: '🎂', anim: 'wobble', label: 'Celebrate' },
    { id: 'spec-balloon', cat: 'special', emoji: '🎈', anim: 'float', label: 'Balloon' },
    { id: 'spec-sparkle', cat: 'special', emoji: '✨', anim: 'spin', label: 'Sparkle' },
    { id: 'spec-confetti', cat: 'special', emoji: '🎉', anim: 'bounce', label: 'Yay' }
];

const LoveHubStickerCategories = [
    { id: 'love', label: 'Love', emoji: '❤️' },
    { id: 'cute', label: 'Cute', emoji: '🥰' },
    { id: 'romantic', label: 'Romantic', emoji: '💋' },
    { id: 'night', label: 'Night', emoji: '🌙' },
    { id: 'together', label: 'Together', emoji: '☕' },
    { id: 'special', label: 'Special', emoji: '🎂' }
];

const LoveHubStickerById = {};
LoveHubStickers.forEach((s) => { LoveHubStickerById[s.id] = s; });

// ---- window mirror (Phase 3.3 fix) ---------------------------------------
// The chat layer (chat-rich.js) reads these from `window`; without this the
// picker was empty and sticker bubbles rendered a fallback emoji.
if (typeof window !== 'undefined') {
    window.LoveHubStickers = LoveHubStickers;
    window.LoveHubStickerCategories = LoveHubStickerCategories;
    window.LoveHubStickerById = LoveHubStickerById;
}

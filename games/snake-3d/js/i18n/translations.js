/**
 * LoveHub Snake 3D — i18n translations
 * Persian (fa) + English (en)
 */

export const translations = {
  en: {
    play: 'PLAY',
    worlds: 'WORLDS',
    customize: 'CUSTOMIZE',
    settings: 'SETTINGS',
    score: 'Score',
    best_score: 'Best',
    level: 'Level',
    coins: 'Coins',
    paused: 'PAUSED',
    resume: 'RESUME',
    restart: 'RESTART',
    quit: 'QUIT',
    game_over: 'GAME OVER',
    retry: 'RETRY',
    menu: 'MENU',
    loading: 'Loading Sector City...',
    subtitle: 'LoveHub Edition',
    objective_collect: 'Collect food to grow',
    objective_survive: 'Survive as long as you can',
    tip_swipe: 'Swipe or use joystick to steer',
    tip_boost: 'Hold to boost',
    connection_lost: 'Connection lost',
    reconnecting: 'Reconnecting…',
  },
  fa: {
    play: 'شروع بازی',
    worlds: 'جهان‌ها',
    customize: 'شخصی‌سازی',
    settings: 'تنظیمات',
    score: 'امتیاز',
    best_score: 'بهترین',
    level: 'سطح',
    coins: 'سکه',
    paused: 'توقف',
    resume: 'ادامه',
    restart: 'شروع مجدد',
    quit: 'خروج',
    game_over: 'بازی تمام',
    retry: 'تلاش دوباره',
    menu: 'منو',
    loading: 'در حال بارگذاری شهر سکتور...',
    subtitle: 'نسخه لاوههاب',
    objective_collect: 'غذا جمع کن تا بزرگ‌تر بشی',
    objective_survive: 'تا جایی که می‌تونی زنده بمون',
    tip_swipe: 'با انگشت یا جوی‌استیک کنترل کن',
    tip_boost: 'نگه دار برای شتاب',
    connection_lost: 'اتصال قطع شد',
    reconnecting: 'در حال اتصال مجدد…',
  },
};

export function t(key, lang = 'en') {
  return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

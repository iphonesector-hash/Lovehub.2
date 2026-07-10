class LocalizationService {
    constructor() {
        this.currentLang = storage.get('language') || 'en';
        this.strings = {
            en: {
                greeting_morning: 'Good morning',
                greeting_afternoon: 'Good afternoon', // Fixed typo
                greeting_evening: 'Good evening',
                days_together: 'Days Together',
                in_relationship: 'In a relationship',
                latest_memory: 'Latest Memory',
                love_letter: 'Love Letter',
                write_feelings: 'Write your feelings', // Fixed typo
                memories: 'Memories',
                photos: 'photos',
                games: 'Games',
                play_together: 'Play together',
                messages: 'Messages',
                love: 'Love',
                game_center: 'Game Center', // Fixed typo
                timeline: 'Timeline',
                profile: 'Profile',
                health: 'Health',
                personal: 'Personal',
                account: 'Account',
                login: 'Login',
                logout: 'Logout',
                settings: 'Settings',
                theme: 'Theme',
                done: 'Done', // Fixed leading space
                cancel: 'Cancel',
                welcome_back: 'Welcome Back',
                login_subtitle: 'Login to your SECTOR LoveHub account',
                username: 'Username',
                password: 'Password',
                logging_in: 'Logging in...', // Fixed typo
                login_success: 'Login Successful',
                logout_success: 'Logged out successfully',
                logout_confirm: 'Are you sure you want to logout?',
                invalid_credentials: 'Please enter credentials', // Fixed typo
                edit_profile: 'Edit Profile',
                save: 'Save',
                saved: 'Saved',
                no_comments: 'No comments yet',
                coming_soon: 'Coming Soon',
                starting: 'Starting',
                change_password: 'Change Password', // Fixed typo
                current_password: 'Current Password',
                new_password: 'New Password',
                confirm_password: 'Confirm Password',
                password_changed: 'Password changed successfully',
                wrong_password: 'Current password is incorrect', // Fixed leading space
                export_data: 'Export Data',
                import_data: 'Import Data',
                reset_data: 'Reset Application Data',
                reset_confirm: 'This will delete all your data. Are you sure?', // Fixed extra space
                data_reset: 'All data has been reset'
            },
            fa: {
                greeting_morning: 'صبح بخیر',
                greeting_afternoon: 'ظهر بخیر',
                greeting_evening: 'عصر بخیر',
                days_together: 'روز با هم',
                in_relationship: 'در رابطه', // Fixed leading space
                latest_memory: 'آخرین خاطره',
                love_letter: 'نامه عاشقانه',
                write_feelings: 'احساساتت رو بنویس',
                memories: 'خاطرات',
                photos: 'عکس',
                games: 'بازی‌ها',
                play_together: 'با هم بازی کن', // Fixed typo
                messages: 'پیام‌ها',
                love: 'عشق',
                game_center: 'مرکز بازی',
                timeline: 'خط زمانی',
                profile: 'پروفایل',
                health: 'سلامت',
                personal: 'شخصی',
                account: 'حساب', // Fixed trailing space
                login: 'ورود',
                logout: 'خروج',
                settings: 'تنظیمات',
                theme: 'تم',
                done: 'انجام شد',
                cancel: 'لغو',
                welcome_back: 'خوش آمدید',
                login_subtitle: 'وارد حساب SECTOR LoveHub خود شوید',
                username: 'نام کاربری',
                password: 'رمز عبور',
                logging_in: 'در حال ورود...',
                login_success: 'ورود موفق',
                logout_success: 'با موفقیت خارج شدید',
                logout_confirm: 'آیا مطمئن هستید؟',
                invalid_credentials: 'لطفاً اطلاعات را وارد کنید', // Fixed leading space
                edit_profile: 'ویرایش پروفایل',
                save: 'ذخیره',
                saved: 'ذخیره شد',
                no_comments: 'هنوز نظری نیست',
                coming_soon: 'به زودی',
                starting: 'در حال شروع', // Fixed leading space
                change_password: 'تغییر رمز',
                current_password: 'رمز فعلی',
                new_password: 'رمز جدید',
                confirm_password: 'تایید رمز',
                password_changed: 'رمز با موفقیت تغییر کرد',
                wrong_password: 'رمز فعلی اشتباه است', // Fixed leading space
                export_data: 'خروجی داده',
                import_data: 'ورود داده',
                reset_data: 'بازنشانی داده‌ها',
                reset_confirm: 'تمام داده‌ها حذف می‌شوند. مطمئنید؟',
                data_reset: 'داده‌ها بازنشانی شدند' // Fixed typo
            }
        };
    }

    t(key) {
        return this.strings[this.currentLang]?.[key] || this.strings.en[key] || key;
    }

    setLanguage(lang) {
        this.currentLang = lang;
        storage.set('language', lang);
    }

    getLanguage() {
        return this.currentLang;
    }

    formatDate(date, locale) {
        return new Date(date).toLocaleDateString(locale || this.currentLang, {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    formatNumber(num) {
        return num.toLocaleString(this.currentLang);
    }
}

const i18n = new LocalizationService();


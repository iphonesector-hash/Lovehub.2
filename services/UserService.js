class UserService {
    constructor() {
        this.PROFILES_KEY = 'profiles';
        this.AVATARS_KEY = 'avatars';
    }

    getProfile(userId) {
        const profiles = storage.get(this.PROFILES_KEY) || {};
        return profiles[userId] || this.getDefaultProfile(userId);
    }

    saveProfile(userId, profileData) {
        const profiles = storage.get(this.PROFILES_KEY) || {};
        profiles[userId] = {
            ...profiles[userId],
            ...profileData,
            updatedAt: new Date().toISOString()
        };
        storage.set(this.PROFILES_KEY, profiles);
        return { success: true, profile: profiles[userId] };
    }

    getDefaultProfile(userId) {
        const user = authService.defaultUsers.find(u => u.id === userId);
        return {
            userId,
            firstName: user?.name || '',
            lastName: '',
            nickname: '',
            birthday: '',
            gender: '',
            height: '',
            weight: '',
            bloodType: '',
            favoriteColor: '',
            favoriteFood: '',
            favoriteDrink: '',
            favoriteMovie: '',
            favoriteMusic: '',
            favoriteArtist: '',
            favoriteBook: '',
            hobbies: '',
            city: '',
            country: '',
            occupation: '',
            languages: '',
            bio: '',
            relationshipRole: '',
            emergencyContact: '',
            interests: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    getAvatar(userId) {
        const avatars = storage.get(this.AVATARS_KEY) || {};
        return avatars[userId] || null;
    }

    saveAvatar(userId, imageData) {
        const avatars = storage.get(this.AVATARS_KEY) || {};
        avatars[userId] = {
            data: imageData,
            updatedAt: new Date().toISOString()
        };
        storage.set(this.AVATARS_KEY, avatars);
        return { success: true };
    }

    removeAvatar(userId) {
        const avatars = storage.get(this.AVATARS_KEY) || {};
        delete avatars[userId];
        storage.set(this.AVATARS_KEY, avatars);
        return { success: true };
    }

    getAllFieldDefinitions() {
        return [
            { key: 'firstName', label: 'First Name', type: 'text' },
            { key: 'lastName', label: 'Last Name', type: 'text' },
            { key: 'nickname', label: 'Nickname', type: 'text' },
            { key: 'birthday', label: 'Birthday', type: 'date' },
            { key: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other', 'Prefer not to say'] },
            { key: 'height', label: 'Height (cm)', type: 'number' },
            { key: 'weight', label: 'Weight (kg)', type: 'number' },
            { key: 'bloodType', label: 'Blood Type', type: 'select', options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
            { key: 'favoriteColor', label: 'Favorite Color', type: 'text' },
            { key: 'favoriteFood', label: 'Favorite Food', type: 'text' },
            { key: 'favoriteDrink', label: 'Favorite Drink', type: 'text' },
            { key: 'favoriteMovie', label: 'Favorite Movie', type: 'text' },
            { key: 'favoriteMusic', label: 'Favorite Music', type: 'text' },
            { key: 'favoriteArtist', label: 'Favorite Artist', type: 'text' },
            { key: 'favoriteBook', label: 'Favorite Book', type: 'text' },
            { key: 'hobbies', label: 'Hobbies', type: 'textarea' },
            { key: 'city', label: 'City', type: 'text' },
            { key: 'country', label: 'Country', type: 'text' },
            { key: 'occupation', label: 'Occupation', type: 'text' },
            { key: 'languages', label: 'Languages', type: 'text' },
            { key: 'bio', label: 'Bio', type: 'textarea' },
            { key: 'relationshipRole', label: 'Relationship Role', type: 'text' },
            { key: 'emergencyContact', label: 'Emergency Contact', type: 'text' },
            { key: 'interests', label: 'Interests', type: 'textarea' }
        ];
    }
}

const userService = new UserService();
window.userService = userService;


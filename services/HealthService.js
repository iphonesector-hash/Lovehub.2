class HealthService {
    constructor() {
        this.HEALTH_KEY = 'health_data';
        this.metrics = [
            { id: 'heart', name: 'Heart Rate', unit: 'BPM', icon: 'heartFill', color: '#FF375F' },
            { id: 'sleep', name: 'Sleep', unit: 'hours', icon: 'sleep', color: '#5E5CE6' },
            { id: 'activity', name: 'Steps', unit: 'steps', icon: 'activity', color: '#30D158' },
            { id: 'water', name: 'Water', unit: 'L', icon: 'water', color: '#0A84FF' },
            { id: 'calories', name: 'Active Energy', unit: 'kcal', icon: 'activity', color: '#FF9F0A' },
            { id: 'distance', name: 'Walking Distance', unit: 'km', icon: 'activity', color: '#30D158' },
            { id: 'exercise', name: 'Exercise Minutes', unit: 'min', icon: 'activity', color: '#30D158' },
            { id: 'standing', name: 'Standing Hours', unit: 'hrs', icon: 'activity', color: '#30D158' },
            { id: 'weight', name: 'Weight', unit: 'kg', icon: 'activity', color: '#BF5AF2' },
            { id: 'bmi', name: 'BMI', unit: '', icon: 'activity', color: '#BF5AF2' },
            { id: 'oxygen', name: 'Blood Oxygen', unit: '%', icon: 'activity', color: '#FF375F' },
            { id: 'restingHeart', name: 'Resting Heart Rate', unit: 'BPM', icon: 'heartFill', color: '#FF375F' }
        ];
    }

    getMetrics() {
        return this.metrics;
    }

    getTodayData() {
        const cached = storage.get(this.HEALTH_KEY);
        const today = new Date().toDateString();
        
        if (cached && cached.date === today) {
            return cached.data;
        }
        
        // Generate realistic mock data
        const mockData = this.generateMockData();
        storage.set(this.HEALTH_KEY, { date: today, data: mockData });
        return mockData;
    }

    generateMockData() {
        return {
            heart: Math.floor(70 + Math.random() * 20),
            sleep: (7 + Math.random() * 2).toFixed(1),
            activity: Math.floor(6000 + Math.random() * 5000),
            water: (1.5 + Math.random() * 1.5).toFixed(1),
            calories: Math.floor(300 + Math.random() * 400),
            distance: (3 + Math.random() * 5).toFixed(1),
            exercise: Math.floor(20 + Math.random() * 40),
            standing: Math.floor(6 + Math.random() * 4),
            weight: (70 + Math.random() * 5).toFixed(1),
            bmi: (22 + Math.random() * 3).toFixed(1),
            oxygen: Math.floor(95 + Math.random() * 4),
            restingHeart: Math.floor(60 + Math.random() * 15)
        };
    }

    // Future: integrate with HealthKit
    async syncFromHealthKit() {
        console.log('HealthKit sync not available in web version');
        return this.getTodayData();
    }

    async syncToHealthKit() {
        console.log('HealthKit write not available in web version');
        return false;
    }
}

const healthService = new HealthService();


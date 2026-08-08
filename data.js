const LoveHubData = {
    currentUser: {
        id: 'user1',
        name: 'Pourya',
        initial: 'P',
        avatar: '',
        status: 'online',
        email: '',
        isLoggedIn: false
    },
    partner: {
        id: 'user2',
        name: 'Sarina',
        initial: 'S',
        avatar: '',
        status: 'online'
    },
    relationship: {
        startDate: '2023-01-01',
        status: 'In a relationship',
        loveLetter: 'Every moment with you feels like a beautiful dream I never want to wake up from. You are my everything.',
        writtenBy: 'Pourya'
    },
    healthMetrics: [
        { id: 'heart', icon: 'heartFill', name: 'Heart', value: '78 BPM', color: '#FF375F' },
        { id: 'sleep', icon: 'sleep', name: 'Sleep', value: '7h 32m', color: '#5E5CE6' },
        { id: 'activity', icon: 'activity', name: 'Activity', value: '8,420 steps', color: '#30D158' },
        { id: 'water', icon: 'water', name: 'Water', value: '2.1 L', color: '#0A84FF' }
    ],
    personalInfo: [
        { key: 'Birthday', value: 'May 12, 1995' },
        { key: 'Height', value: '178 cm' },
        { key: 'Weight', value: '72 kg' },
        { key: 'Blood Type', value: 'O+' },
        { key: 'Love Language', value: 'Words of Affirmation' },
        { key: 'Favorite Food', value: 'Persian Kebab' },
        { key: 'Dream Trip', value: 'Kyoto, Japan' }
    ],
    milestones: [
        { id: 1, icon: 'ring', title: 'First Meeting', date: '2023-03-15', dateDisplay: 'March 15, 2023' },
        { id: 2, icon: 'rose', title: 'First Date', date: '2023-03-20', dateDisplay: 'March 20, 2023' },
        { id: 3, icon: 'heartFill', title: 'Said "I Love You"', date: '2023-04-02', dateDisplay: 'April 2, 2023' },
        { id: 4, icon: 'plane', title: 'First Trip Together', date: '2023-06-20', dateDisplay: 'June 20, 2023' }
    ],
    games: [
        {
            id: 'snake3d',
            name: 'Snake 3D',
            description: 'Sector Edition — premium 3D adventure',
            cover: 'snake-cover',
            rating: 5.0,
            wins: 0,
            lastPlayed: 'New',
            playable: true,
            href: 'games/snake-3d/',
            coverContent: '<div style="font-size:28px;line-height:1">🐍</div>'
        },
        {
            id: 'chess',
            name: 'Couple Chess',
            description: 'Classic strategy for two',
            cover: 'chess-cover',
            rating: 4.8,
            wins: 12,
            lastPlayed: '2 hours ago',
            coverContent: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2h8l-1 4H9L8 2z"></path><path d="M6 6h12l1 4H5l1-4z"></path><path d="M4 10h16v2H4z"></path><path d="M6 12l1 8h10l1-8"></path></svg>'
        },
        {
            id: 'uno',
            name: 'UNO',
            description: 'Fast couple match',
            cover: 'uno-cover',
            rating: 4.9,
            wins: 24,
            lastPlayed: 'Yesterday',
            coverContent: '<span class="uno-text">UNO</span>'
        },
        {
            id: 'connect4',
            name: 'Connect Four',
            description: 'Strategy & fun',
            cover: 'connect-cover',
            rating: 4.7,
            wins: 8,
            lastPlayed: '3 days ago',
            coverContent: '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:20px;"><span style="width:20px;height:20px;border-radius:50%;background:#ff5ca8;"></span><span style="width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.3);"></span><span style="width:20px;height:20px;border-radius:50%;background:#ff5ca8;"></span><span style="width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.3);"></span></div>'
        },
        {
            id: 'pool',
            name: 'Pool 8 Ball',
            description: 'Classic billiards',
            cover: 'pool-cover',
            rating: 4.6,
            wins: 15,
            lastPlayed: '1 week ago',
            coverContent: '<div style="display:flex;gap:10px;"><span style="width:40px;height:40px;border-radius:50%;background:#000;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;">8</span></div>'
        }
    ],
    memories: [
        {
            id: 1,
            date: '2026-07-06',
            dateDisplay: 'July 6, 2026',
            location: 'Shomal',
            music: 'Perfect - Ed Sheeran',
            notes: 'Beautiful sunset by the sea. Best day ever!',
            image: 'https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?w=800&q=80',
            gradient: 'linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)',
            comments: [{ author: 'Sarina', text: 'I love this memory' }]
        },
        {
            id: 2,
            date: '2026-07-01',
            dateDisplay: 'July 1, 2026',
            location: 'Tehran',
            music: 'All of Me - John Legend',
            notes: 'Anniversary dinner at our favorite restaurant',
            image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&q=80',
            gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            comments: []
        },
        {
            id: 3,
            date: '2026-06-28',
            dateDisplay: 'June 28, 2026',
            location: 'Park',
            music: 'Thinking Out Loud',
            notes: 'Long walk and deep conversations',
            image: 'https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?w=800&q=80',
            gradient: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
            comments: []
        }
    ],
    messages: [
        { id: 1, senderId: 'user2', text: 'Miss you', timestamp: '2026-07-07T12:40:00', type: 'received' },
        { id: 2, senderId: 'user1', text: 'Hi love', timestamp: '2026-07-07T12:42:00', type: 'sent' }
    ],
    settings: { theme: 'night', notifications: true }
};

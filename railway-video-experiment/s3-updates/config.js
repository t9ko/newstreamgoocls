// Your Firebase project. These values are not passwords; they only say which project to use.
export const firebaseConfig = {
  apiKey: 'AIzaSyA5e3qz7u5GHVbPz9Yxe4s9vt1QpqwMm7E',
  authDomain: 'sinning-c3bac.firebaseapp.com',
  projectId: 'sinning-c3bac',
  storageBucket: 'sinning-c3bac.firebasestorage.app',
  messagingSenderId: '36356587511',
  appId: '1:36356587511:web:46756684757ca0e075f8f2',
};

// The one account that can post in the News channel.
// If you change this, change it in firestore.rules too.
export const ADMIN_USER = 'kolton';

// Paste your movie/video site link between the quotes (keep the https://). Then the Videos tab shows it.
export const VIDEOS_URL = 'https://www.streamex.hn';

// After deploying Railway, paste its HTTPS URL here (no trailing slash).
export const VIDEO_PROXY_URL = '';

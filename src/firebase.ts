import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCHfH8OMl1GKxjjz9JJjZTlwRsaHJWzII0',
  authDomain: 'teasan-f4c17.firebaseapp.com',
  projectId: 'teasan-f4c17',
  storageBucket: 'teasan-f4c17.firebasestorage.app',
  messagingSenderId: '228309130032',
  appId: '1:228309130032:web:27d6703af4262e508ec6f5',
};

const app = initializeApp(firebaseConfig);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

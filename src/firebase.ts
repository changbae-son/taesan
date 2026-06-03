import { initializeApp } from 'firebase/app';
import { initializeFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCHfH8OMl1GKxjjz9JJjZTlwRsaHJWzII0',
  authDomain: 'teasan-f4c17.firebaseapp.com',
  projectId: 'teasan-f4c17',
  storageBucket: 'teasan-f4c17.firebasestorage.app',
  messagingSenderId: '228309130032',
  appId: '1:228309130032:web:27d6703af4262e508ec6f5',
};

const app = initializeApp(firebaseConfig);
// ignoreUndefinedProperties: setDoc 시 undefined 필드 자동 제거 (저장 silent fail 방지)
//   룰B 전환 시 bottomPriceDate/ruleBSignalDate 등 미설정 필드가 undefined여도 저장 가능
export const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
});

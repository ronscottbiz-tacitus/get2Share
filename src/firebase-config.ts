// Firebase web config. These values are public identifiers (not secrets);
// access is controlled by firestore.rules and Firebase Authentication.
//
// TEMPORARY: still pointing at the old AI Studio project until the new
// dedicated Get2Share Firebase project is created.
export const firebaseConfig = {
  apiKey: 'AIzaSyBh-Hsd6OFOiKxiSpkXwRCA3MDjt_gE2Sg',
  authDomain: 'gen-lang-client-0927699826.firebaseapp.com',
  projectId: 'gen-lang-client-0927699826',
  storageBucket: 'gen-lang-client-0927699826.firebasestorage.app',
  messagingSenderId: '384324268180',
  appId: '1:384324268180:web:ee39b0d94fa11ee2134481',
};

// Named Firestore database ID, or '' to use the project's default database.
export const firestoreDatabaseId = 'ai-studio-get2share-ddc6e1c1-20ed-4765-b2ee-cda7103acab8';

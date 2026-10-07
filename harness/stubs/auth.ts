const isHost = () => localStorage.getItem('h-host') === '1';
const user = () => isHost()
  ? { uid: 'host1', isAnonymous: false, emailVerified: true, email: 'ronscottbiz@gmail.com', providerData: [] }
  : { uid: 'guest1', isAnonymous: true, emailVerified: false, email: null, providerData: [] };
export const getAuth = () => ({ get currentUser() { return user(); } });
export class GoogleAuthProvider { setCustomParameters() {} }
export const onAuthStateChanged = (_a: any, cb: any) => { setTimeout(() => cb(localStorage.getItem('h-auth-fail') ? null : user()), 10); return () => {}; };
export const signInAnonymously = async () => { if (localStorage.getItem('h-auth-fail')) { const e: any = new Error('busy'); e.code = 'auth/too-many-requests'; throw e; } return { user: user() }; };
export const signInWithPopup = async () => ({ user: user() });
export const signOut = async () => {};
export type User = any;
export const linkWithPopup = async () => ({ user: {} });

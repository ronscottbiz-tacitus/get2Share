const isHost = () => localStorage.getItem('h-host') === '1';
const user = () => isHost()
  ? { uid: 'host1', isAnonymous: false, emailVerified: true, email: 'ronscottbiz@gmail.com', providerData: [], getIdToken: async () => 'harness-token' }
  : { uid: 'guest1', isAnonymous: true, emailVerified: false, email: null, providerData: [], metadata: { creationTime: new Date(newDevice() ? Date.now() : Date.now() - 86400000).toUTCString() } };
// h-new=1: a phone scanning for the first time (no saved sign-in yet). h-slow=<ms>: network delay per call.
const newDevice = () => localStorage.getItem('h-new') === '1';
const slow = () => new Promise((r) => setTimeout(r, Number(localStorage.getItem('h-slow') || 0)));
let listener: any = null;
let signedIn = !newDevice();
export const getAuth = () => ({ get currentUser() { return user(); } });
export class GoogleAuthProvider { setCustomParameters() {} }
export const onAuthStateChanged = (_a: any, cb: any) => { listener = cb; setTimeout(() => cb(localStorage.getItem('h-auth-fail') || !signedIn ? null : user()), 10); return () => { listener = null; }; };
export const signInAnonymously = async () => {
  await slow();
  if (localStorage.getItem('h-auth-fail')) { const e: any = new Error('busy'); e.code = 'auth/too-many-requests'; throw e; }
  const wasIn = signedIn; signedIn = true; const u = user();
  if (!wasIn) setTimeout(() => listener && listener(u), 0);
  return { user: u };
};
export const signInWithPopup = async () => ({ user: user() });
export const signOut = async () => {};
export type User = any;
export const linkWithPopup = async () => ({ user: {} });

// Addresses of the policy pages. No Firebase here, so the landing page and the pages themselves
// can use these without loading the app.
export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';
export const REFUNDS_PATH = '/refunds';
export const LEGAL_PATHS = [TERMS_PATH, PRIVACY_PATH, REFUNDS_PATH];

export const CONTACT_EMAIL = 'ron@get2studio.com';

export function isLegalPath(pathname: string): boolean {
  return LEGAL_PATHS.includes(pathname.replace(/\/+$/, '') || '/');
}

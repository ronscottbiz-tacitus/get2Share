// Addresses of the policy pages. No Firebase here, so the landing page and the pages themselves
// can use these without loading the app.
export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';
export const REFUNDS_PATH = '/refunds';
export const LEGAL_PATHS = [TERMS_PATH, PRIVACY_PATH, REFUNDS_PATH];

/** General questions and privacy requests. */
export const CONTACT_EMAIL = 'hello@get2studio.com';
/** Payments: refunds, billing problems, asking for an upgrade or pass by email. */
export const SUPPORT_EMAIL = 'support@get2studio.com';
/** Get2 Studio's Google Voice line. */
export const PHONE = '(510) 853-9676';
export const PHONE_TEL = 'tel:+15108539676';

export function isLegalPath(pathname: string): boolean {
  return LEGAL_PATHS.includes(pathname.replace(/\/+$/, '') || '/');
}

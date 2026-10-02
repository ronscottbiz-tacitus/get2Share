/**
 * Get2Share admins: can help with any event (and bring over photos from
 * before events existed).
 *
 * This list only controls what the app SHOWS. The real enforcement is
 * adminEmails() inside firestore.rules. Keep the two lists identical.
 * Emails must be lowercase.
 *
 * Hosting an event no longer needs this list: anyone signed in with Google
 * can create an event and becomes its host.
 */
export const ADMIN_EMAILS: string[] = [
  'ronaldscott.ca@gmail.com',
  'ronscottbiz@gmail.com',
];

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

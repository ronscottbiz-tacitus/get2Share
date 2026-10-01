/**
 * Google accounts allowed to run the Host Console.
 *
 * This list only controls what the app SHOWS. The real enforcement is the
 * HOST_EMAILS list inside firestore.rules — keep the two lists identical.
 * Emails must be lowercase.
 */
export const HOST_EMAILS: string[] = [
  'ronaldscott.ca@gmail.com',
  'ronscottbiz@gmail.com',
];

export function isHostEmail(email: string | null | undefined): boolean {
  return !!email && HOST_EMAILS.includes(email.toLowerCase());
}

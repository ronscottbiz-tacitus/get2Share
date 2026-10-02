// Share Spot pairing codes: 6 characters, no look-alikes (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** A random 6-character code (Share Spot pairing codes and event join codes). */
export function newCode(): string {
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function newPairingCode(): string {
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** "k7p 2q9" / "K7P-2Q9" → "K7P2Q9" */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** "K7P2Q9" → "K7P 2Q9" for display */
export function formatPairingCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export const SPOT_SETUP_PATH = '/spot';
export const STORED_SPOT_CODE_KEY = 'get2share-spot-code';

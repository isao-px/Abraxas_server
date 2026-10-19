// Code d'accès : le serveur ne connaît que son hash (scrypt), jamais le code en clair.
// Format de UPLOAD_CODE_HASH : scrypt:<sel en hexadécimal>:<hash en hexadécimal>
// Pour le générer : node scripts/hash_code.js
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 32;

export async function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(code.normalize('NFC'), salt, KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// Renvoie { salt, hash } ou null si la valeur n'a pas le bon format.
export function parseCodeHash(value) {
  const m = /^scrypt:([0-9a-f]{32}):([0-9a-f]{64})$/i.exec(String(value || '').trim());
  return m ? { salt: Buffer.from(m[1], 'hex'), hash: Buffer.from(m[2], 'hex') } : null;
}

export async function codeMatches(code, parsed) {
  if (!parsed) return false;
  const derived = await scrypt(String(code).normalize('NFC'), parsed.salt, KEY_LENGTH);
  return crypto.timingSafeEqual(derived, parsed.hash);
}

/** Password hashing and session tokens using the browser's WebCrypto API. */

const ITERATIONS = 210000;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function deriveHash(password, saltBase64) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toBase64(new Uint8Array(bits));
}

export async function hashPassword(password) {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await deriveHash(password, salt) };
}

export async function verifyPassword(password, salt, hash) {
  try {
    return (await deriveHash(password, salt)) === hash;
  } catch (ignored) {
    return false;
  }
}

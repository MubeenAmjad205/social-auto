/**
 * src/secrets.ts
 *
 * Token encryption at rest.
 *
 * WHY THIS FILE EXISTS
 * Cloudflare Workers have no static egress IP, so MongoDB Atlas Network Access
 * has to allow 0.0.0.0/0. That means the database holding your LinkedIn and
 * Instagram OAuth tokens — credentials that can post as you for 60 days — is
 * reachable from the entire internet behind a single password.
 *
 * Encrypting the tokens with a key that lives ONLY in `wrangler secret` turns
 * a database compromise from "someone owns your LinkedIn account" into
 * "someone has some ciphertext".
 *
 * This is not optional, and it must be in place BEFORE the first token is
 * written. Retrofitting means re-authorising both platforms.
 *
 *   openssl rand -base64 32
 *   wrangler secret put TOKEN_KEY
 *
 * WebCrypto is implemented in the runtime, not in JS, so the CPU cost here is
 * negligible — unlike the base64 image decode in generate.ts.
 */

export interface Sealed {
  ct: string; // base64 ciphertext
  iv: string; // base64 nonce, 12 bytes, unique per write
}

let cached: CryptoKey | null = null;

async function keyFrom(rawB64: string): Promise<CryptoKey> {
  if (cached) return cached;
  cached = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(rawB64),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  return cached;
}

export async function seal(plaintext: string, tokenKeyB64: string): Promise<Sealed> {
  const key = await keyFrom(tokenKeyB64);
  // A fresh IV per write is mandatory for GCM. Reusing one across two
  // encryptions with the same key breaks the cipher entirely.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { ct: bytesToB64(new Uint8Array(ct)), iv: bytesToB64(iv) };
}

export async function open(sealed: Sealed, tokenKeyB64: string): Promise<string> {
  const key = await keyFrom(tokenKeyB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(sealed.iv) },
    key,
    b64ToBytes(sealed.ct)
  );
  return new TextDecoder().decode(pt);
}

function b64ToBytes(b64: string): Uint8Array {
  const anyU8 = Uint8Array as any;
  if (typeof anyU8.fromBase64 === 'function') return anyU8.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  const anyBytes = bytes as any;
  if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * RULE: a decrypted token must never leave the Store. Do not log it, do not
 * put it in an error message, do not attach it to a Telegram notification.
 * The only place plaintext should exist is the Authorization header of an
 * outbound request.
 */

// Encrypted envelope for SamuBookMarker cloud sync.
// Runs on Chrome MV3 service worker, Firefox extension pages and Node 24 using only WebCrypto.

export const ENVELOPE_VERSION = 1;

export const KDF_DEFAULT = Object.freeze({
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 210000
});

const ALG = 'A256GCM';
const AAD_LABEL = 'SamuBookMarker/1';
const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class DecryptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecryptError';
    this.code = code;
  }
}

function additionalData() {
  return encoder.encode(AAD_LABEL);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBase64(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

async function deriveKey(passphrase, salt, iterations) {
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: KDF_DEFAULT.hash, iterations, salt },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function isEnvelope(value) {
  if (!isPlainObject(value)) return false;
  if (value.v !== ENVELOPE_VERSION) return false;
  if (value.alg !== ALG) return false;
  if (!isPlainObject(value.kdf)) return false;
  if (value.kdf.name !== KDF_DEFAULT.name) return false;
  if (value.kdf.hash !== KDF_DEFAULT.hash) return false;
  if (!Number.isInteger(value.kdf.iterations) || value.kdf.iterations <= 0) return false;
  if (!isBase64(value.kdf.salt)) return false;
  if (!isBase64(value.iv)) return false;
  if (typeof value.ciphertext !== 'string' || value.ciphertext.length === 0) return false;
  if (!isBase64(value.ciphertext)) return false;
  if (typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) return false;
  return true;
}

export async function encryptPayload(passphrase, plaintextObject, options = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('encryptPayload: passphrase must be a non-empty string');
  }
  if (plaintextObject === undefined) {
    throw new TypeError('encryptPayload: plaintextObject must be serializable');
  }

  const iterations = options.iterations === undefined ? KDF_DEFAULT.iterations : options.iterations;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new TypeError('encryptPayload: options.iterations must be a positive integer');
  }

  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = encoder.encode(JSON.stringify(plaintextObject));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData() },
    key,
    plaintext
  );

  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    kdf: {
      name: KDF_DEFAULT.name,
      hash: KDF_DEFAULT.hash,
      iterations,
      salt: bytesToBase64(salt)
    },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: nowIso(options.now)
  };
}

export async function decryptPayload(passphrase, envelope) {
  if (!isPlainObject(envelope)) {
    throw new DecryptError('BAD_ENVELOPE', 'Envelope must be an object');
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    if (typeof envelope.v === 'number') {
      throw new DecryptError('UNSUPPORTED_VERSION', `Unsupported envelope version: ${envelope.v}`);
    }
    throw new DecryptError('BAD_ENVELOPE', 'Envelope is missing a numeric version');
  }
  if (!isEnvelope(envelope)) {
    throw new DecryptError('BAD_ENVELOPE', 'Envelope is malformed');
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new DecryptError('BAD_PASSPHRASE', 'Passphrase must be a non-empty string');
  }

  let salt;
  let iv;
  let ciphertext;
  try {
    salt = base64ToBytes(envelope.kdf.salt);
    iv = base64ToBytes(envelope.iv);
    ciphertext = base64ToBytes(envelope.ciphertext);
  } catch {
    throw new DecryptError('BAD_ENVELOPE', 'Envelope contains invalid base64');
  }
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length === 0) {
    throw new DecryptError('BAD_ENVELOPE', 'Envelope field lengths are invalid');
  }

  let plaintext;
  try {
    const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData() },
      key,
      ciphertext
    );
  } catch {
    throw new DecryptError('BAD_PASSPHRASE', 'Unable to decrypt envelope with the given passphrase');
  }

  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new DecryptError('BAD_ENVELOPE', 'Decrypted payload is not valid JSON');
  }
}

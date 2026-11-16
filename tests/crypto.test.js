import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENVELOPE_VERSION,
  KDF_DEFAULT,
  DecryptError,
  isEnvelope,
  encryptPayload,
  decryptPayload
} from '../src/lib/crypto.js';

const PASSPHRASE = 'correct horse battery staple';

function decodeBase64(text) {
  return new Uint8Array(atob(text).split('').map((char) => char.charCodeAt(0)));
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function assertDecryptError(error, code) {
  assert.ok(error instanceof DecryptError, 'expected a DecryptError');
  assert.equal(error.code, code);
  return true;
}

const SAMPLE = {
  version: 3,
  bookmarks: [
    { title: '中文书签 🚀', url: 'https://example.com/路径?a=1&b=2' },
    { title: 'emoji 🧪🎉👨‍👩‍👧‍👦', url: 'https://example.org/' }
  ],
  settings: { theme: '暗色', nested: { list: [1, 2, 3], flag: true, empty: null } }
};

test('encrypts and decrypts a payload losslessly (CJK + emoji)', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  const restored = await decryptPayload(PASSPHRASE, envelope);
  assert.deepEqual(restored, SAMPLE);
});

test('produces an envelope with the documented shape', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  assert.equal(envelope.v, ENVELOPE_VERSION);
  assert.equal(envelope.alg, 'A256GCM');
  assert.deepEqual(Object.keys(envelope.kdf).sort(), ['hash', 'iterations', 'name', 'salt']);
  assert.equal(envelope.kdf.name, KDF_DEFAULT.name);
  assert.equal(envelope.kdf.hash, KDF_DEFAULT.hash);
  assert.equal(envelope.kdf.iterations, KDF_DEFAULT.iterations);
  assert.equal(decodeBase64(envelope.kdf.salt).length, 16);
  assert.equal(decodeBase64(envelope.iv).length, 12);
  assert.ok(typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > 0);
  assert.equal(new Date(envelope.updatedAt).toISOString(), envelope.updatedAt);
  assert.equal(isEnvelope(envelope), true);
});

test('honours options.iterations and options.now', async () => {
  const fixed = new Date('2024-05-06T07:08:09.000Z');
  const envelope = await encryptPayload(PASSPHRASE, { a: 1 }, {
    iterations: 1000,
    now: () => fixed
  });
  assert.equal(envelope.kdf.iterations, 1000);
  assert.equal(envelope.updatedAt, fixed.toISOString());
  assert.deepEqual(await decryptPayload(PASSPHRASE, envelope), { a: 1 });
});

test('never reuses salt, iv or ciphertext across encryptions', async () => {
  const first = await encryptPayload(PASSPHRASE, SAMPLE);
  const second = await encryptPayload(PASSPHRASE, SAMPLE);
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('rejects a wrong passphrase with BAD_PASSPHRASE', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  await assert.rejects(decryptPayload('wrong passphrase', envelope), (error) => {
    return assertDecryptError(error, 'BAD_PASSPHRASE');
  });
});

test('rejects tampered ciphertext with BAD_PASSPHRASE', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  const bytes = decodeBase64(envelope.ciphertext);
  bytes[0] ^= 0xff;
  const tampered = { ...envelope, ciphertext: encodeBase64(bytes) };
  await assert.rejects(decryptPayload(PASSPHRASE, tampered), (error) => {
    return assertDecryptError(error, 'BAD_PASSPHRASE');
  });
});

test('rejects tampered iv with BAD_PASSPHRASE', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  const bytes = decodeBase64(envelope.iv);
  bytes[1] ^= 0x01;
  await assert.rejects(decryptPayload(PASSPHRASE, { ...envelope, iv: encodeBase64(bytes) }), (error) => {
    return assertDecryptError(error, 'BAD_PASSPHRASE');
  });
});

test('rejects malformed envelopes with BAD_ENVELOPE', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  const broken = [
    null,
    'not-an-object',
    [],
    { ...envelope, iv: undefined },
    { ...envelope, ciphertext: '' },
    { ...envelope, kdf: { ...envelope.kdf, salt: 'not-base64!!' } },
    { ...envelope, kdf: { ...envelope.kdf, salt: encodeBase64(new Uint8Array(4)) } },
    { ...envelope, iv: encodeBase64(new Uint8Array(4)) },
    { ...envelope, alg: 'A128GCM' },
    { ...envelope, v: 'one' }
  ];
  for (const candidate of broken) {
    await assert.rejects(decryptPayload(PASSPHRASE, candidate), (error) => {
      return assertDecryptError(error, 'BAD_ENVELOPE');
    });
  }
});

test('rejects an unknown envelope version with UNSUPPORTED_VERSION', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  await assert.rejects(decryptPayload(PASSPHRASE, { ...envelope, v: 2 }), (error) => {
    return assertDecryptError(error, 'UNSUPPORTED_VERSION');
  });
});

test('isEnvelope accepts real envelopes and rejects look-alikes', async () => {
  const envelope = await encryptPayload(PASSPHRASE, SAMPLE);
  assert.equal(isEnvelope(envelope), true);
  assert.equal(isEnvelope(undefined), false);
  assert.equal(isEnvelope(null), false);
  assert.equal(isEnvelope('envelope'), false);
  assert.equal(isEnvelope([]), false);
  assert.equal(isEnvelope({}), false);
  assert.equal(isEnvelope({ ...envelope, v: 2 }), false);
  assert.equal(isEnvelope({ ...envelope, ciphertext: '' }), false);
  assert.equal(isEnvelope({ ...envelope, kdf: { ...envelope.kdf, iterations: 0 } }), false);
  assert.equal(isEnvelope({ ...envelope, updatedAt: '' }), false);
});

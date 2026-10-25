'use strict';

const crypto = require('crypto');

// DER SPKI prefixes for raw 32-byte Ed25519 / X25519 public keys.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function importRaw(prefix, raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('invalid public key');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}

const importEd25519 = (raw) => importRaw(ED25519_SPKI_PREFIX, raw);
const importX25519 = (raw) => importRaw(X25519_SPKI_PREFIX, raw);

/** Device ID: first 16 bytes of SHA-256 over the raw Ed25519 identity key, hex. */
function fingerprint(rawPub) {
  return crypto.createHash('sha256').update(rawPub).digest().subarray(0, 16).toString('hex');
}

/** Human-friendly grouping of a fingerprint, e.g. "3f2a 91c0 ...". */
function formatFingerprint(fp) {
  return fp.match(/.{1,4}/g).join(' ');
}

function makeIdentity(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const pub = rawPublicKey(publicKey);
  return { privateKey, publicKey, pub, fp: fingerprint(pub) };
}

function generateIdentity() {
  return makeIdentity(crypto.generateKeyPairSync('ed25519').privateKey);
}

function exportIdentity(identity) {
  return identity.privateKey.export({ format: 'pem', type: 'pkcs8' });
}

function importIdentity(pem) {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('identity key must be ed25519');
  return makeIdentity(key);
}

module.exports = {
  rawPublicKey,
  importEd25519,
  importX25519,
  fingerprint,
  formatFingerprint,
  generateIdentity,
  exportIdentity,
  importIdentity,
};

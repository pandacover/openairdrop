'use strict';

/*
 * Mutually authenticated key exchange with forward secrecy and a short
 * authentication string (SAS) that is resistant to grinding.
 *
 *   I -> R  COMMIT  c = H(id_I || eph_I || name_I)
 *   R -> I  HELLO   id_R, eph_R, name_R
 *   I -> R  HELLO   id_I, eph_I, name_I, sig_I("I" || T)      (R checks c)
 *   R -> I  AUTH    sig_R("R" || T)
 *
 *   T     = SHA-256(ctx || c || id_I || id_R || eph_I || eph_R || name_I || name_R)
 *   keys  = HKDF-SHA256(X25519(eph_I, eph_R), salt = T) -> k_I->R || k_R->I
 *   SAS   = 6 digits from HKDF(T)
 *
 * id_* are long-term Ed25519 keys, eph_* are fresh X25519 keys per connection.
 * The commitment forces the initiator to fix its keys before seeing the
 * responder's, so a man-in-the-middle cannot search for colliding SAS codes.
 */

const crypto = require('crypto');
const { PROTOCOL_CONTEXT, PROTOCOL_VERSION, HANDSHAKE_TIMEOUT_MS } = require('./constants');
const { rawPublicKey, importEd25519, importX25519, fingerprint } = require('./identity');
const { SecureChannel } = require('./framing');

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

function cleanName(name) {
  const s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 64);
  return s || 'Unnamed device';
}

function lp(buf) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function transcript({ commit, idI, idR, ephI, ephR, nameI, nameR }) {
  return sha256(
    Buffer.from(PROTOCOL_CONTEXT),
    Buffer.from([0]),
    commit,
    idI,
    idR,
    ephI,
    ephR,
    lp(Buffer.from(nameI, 'utf8')),
    lp(Buffer.from(nameR, 'utf8'))
  );
}

function commitment(id, eph, name) {
  return sha256(Buffer.from(PROTOCOL_CONTEXT + ':commit'), id, eph, lp(Buffer.from(name, 'utf8')));
}

function deriveSession(dh, T) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', dh, T, PROTOCOL_CONTEXT + ':keys', 64));
  const sasBytes = Buffer.from(crypto.hkdfSync('sha256', T, Buffer.alloc(0), PROTOCOL_CONTEXT + ':sas', 4));
  const sas = String(sasBytes.readUInt32BE(0) % 1000000).padStart(6, '0');
  return { kIR: okm.subarray(0, 32), kRI: okm.subarray(32, 64), sas };
}

const send = (framed, obj) => framed.write(Buffer.from(JSON.stringify(obj)));

async function recv(framed, expectType) {
  const frame = await framed.read(HANDSHAKE_TIMEOUT_MS);
  let msg;
  try {
    msg = JSON.parse(frame.toString('utf8'));
  } catch {
    throw new Error('malformed handshake');
  }
  if (!msg || msg.t !== expectType) throw new Error(`unexpected handshake message (wanted ${expectType})`);
  if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) throw new Error('incompatible protocol version');
  return msg;
}

const b64 = (b) => b.toString('base64');
function unb64(s, len) {
  if (typeof s !== 'string') throw new Error('malformed handshake field');
  const b = Buffer.from(s, 'base64');
  if (len !== undefined && b.length !== len) throw new Error('malformed handshake field');
  return b;
}

function verifySig(idRaw, role, T, sig) {
  const ok = crypto.verify(null, Buffer.concat([Buffer.from(role), T]), importEd25519(idRaw), sig);
  if (!ok) throw new Error('peer failed authentication');
}

function result(framed, sendKey, recvKey, peerId, peerName, sas) {
  return {
    channel: new SecureChannel(framed, sendKey, recvKey),
    peer: { pub: peerId, fp: fingerprint(peerId), name: peerName },
    sas,
  };
}

async function initiate(framed, identity, myName) {
  myName = cleanName(myName);
  const eph = crypto.generateKeyPairSync('x25519');
  const ephI = rawPublicKey(eph.publicKey);
  const idI = identity.pub;
  const commit = commitment(idI, ephI, myName);

  send(framed, { t: 'commit', v: PROTOCOL_VERSION, c: b64(commit) });

  const hello = await recv(framed, 'hello');
  const idR = unb64(hello.id, 32);
  const ephR = unb64(hello.eph, 32);
  const nameR = cleanName(hello.name);
  if (idR.equals(idI)) throw new Error('refusing to connect to self');

  const T = transcript({ commit, idI, idR, ephI, ephR, nameI: myName, nameR });
  const sigI = crypto.sign(null, Buffer.concat([Buffer.from('I'), T]), identity.privateKey);
  send(framed, { t: 'hello', id: b64(idI), eph: b64(ephI), name: myName, sig: b64(sigI) });

  const auth = await recv(framed, 'auth');
  verifySig(idR, 'R', T, unb64(auth.sig, 64));

  const dh = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: importX25519(ephR) });
  const { kIR, kRI, sas } = deriveSession(dh, T);
  return result(framed, kIR, kRI, idR, nameR, sas);
}

async function respond(framed, identity, myName) {
  myName = cleanName(myName);
  const commitMsg = await recv(framed, 'commit');
  const commit = unb64(commitMsg.c, 32);

  const eph = crypto.generateKeyPairSync('x25519');
  const ephR = rawPublicKey(eph.publicKey);
  const idR = identity.pub;
  send(framed, { t: 'hello', v: PROTOCOL_VERSION, id: b64(idR), eph: b64(ephR), name: myName });

  const hello = await recv(framed, 'hello');
  const idI = unb64(hello.id, 32);
  const ephI = unb64(hello.eph, 32);
  if (typeof hello.name !== 'string') throw new Error('malformed handshake field');
  const nameI = cleanName(hello.name);
  if (!commitment(idI, ephI, nameI).equals(commit)) throw new Error('handshake commitment mismatch');
  if (idI.equals(idR)) throw new Error('refusing to connect to self');

  const T = transcript({ commit, idI, idR, ephI, ephR, nameI, nameR: myName });
  verifySig(idI, 'I', T, unb64(hello.sig, 64));
  const sigR = crypto.sign(null, Buffer.concat([Buffer.from('R'), T]), identity.privateKey);
  send(framed, { t: 'auth', sig: b64(sigR) });

  const dh = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: importX25519(ephI) });
  const { kIR, kRI, sas } = deriveSession(dh, T);
  return result(framed, kRI, kIR, idI, nameI, sas);
}

module.exports = { initiate, respond, cleanName };

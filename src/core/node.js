'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('./constants');
const { FramedSocket, parseJson } = require('./framing');
const handshake = require('./handshake');
const { sanitizeFileName, reserveUniquePath } = require('./files');

const { MSG } = C;

class RemoteError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Resolve `promise` to its value, or to `fallback` on timeout / abort. */
function settleWithin(promise, ms, signal, fallback = false) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const finish = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    if (signal) {
      if (signal.aborted) return finish(fallback);
      signal.addEventListener('abort', () => finish(fallback), { once: true });
    }
    Promise.resolve(promise).then(finish, () => finish(fallback));
  });
}

function expectMsg(msg, type) {
  if (msg.type === MSG.ERROR) {
    const e = parseJson(msg.body);
    throw new RemoteError(e.code || 'remote_error', e.message);
  }
  if (msg.type !== type) throw new Error('protocol violation');
  return parseJson(msg.body);
}

/**
 * A Beam peer: accepts inbound encrypted connections and makes outbound ones.
 * Contains no Electron code so it can be tested with plain Node.
 */
class BeamNode extends EventEmitter {
  constructor(opts) {
    super();
    this.identity = opts.identity;
    this.getName = opts.getName;
    this.getDownloadDir = opts.getDownloadDir;
    this.isTrusted = opts.isTrusted;
    this.onTrust = opts.onTrust;
    this.onPairRequest = opts.onPairRequest || (async () => false);
    this.onOffer = opts.onOffer || (async () => true);
    this.server = null;
    this.inbound = new Set();
    this.pairPending = false;
  }

  listen(port = C.DEFAULT_TCP_PORT, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const server = net.createServer((s) => this._onInbound(s));
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        server.on('error', (e) => this.emit('error', e));
        this.server = server;
        resolve(server.address().port);
      });
    });
  }

  close() {
    for (const s of this.inbound) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---------------------------------------------------------------- outbound

  async _connect({ host, port, fp }) {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const framed = new FramedSocket(socket);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        socket.destroy();
        reject(new Error('could not reach device'));
      }, 5000);
      socket.once('connect', () => (clearTimeout(t), resolve()));
      socket.once('error', (e) => (clearTimeout(t), reject(new Error(`could not reach device (${e.code || e.message})`))));
    });
    try {
      const hs = await handshake.initiate(framed, this.identity, this.getName());
      if (fp && hs.peer.fp !== fp) {
        throw new Error('device identity mismatch: the device at this address is not the one you selected');
      }
      return hs;
    } catch (e) {
      framed.destroy(e);
      throw e;
    }
  }

  /** Connect, authenticate and disconnect: learns the identity behind an address. */
  async probe(target) {
    const { channel, peer } = await this._connect(target);
    channel.close();
    return peer;
  }

  /**
   * Pair with a device. `confirm({ peer, sas, signal })` must resolve true only
   * when the user verified the code matches the one shown on the other device.
   */
  async pair(target, confirm) {
    const { channel, peer, sas } = await this._connect(target);
    try {
      channel.send(MSG.PAIR_REQ, {});
      const ac = new AbortController();
      const remote = channel
        .recv(C.PROMPT_TIMEOUT_MS + 5000)
        .then((m) => expectMsg(m, MSG.PAIR_RES).accepted === true)
        .catch((e) => {
          ac.abort();
          if (e instanceof RemoteError) throw e;
          return false;
        });
      remote.then((ok) => ok || ac.abort(), () => {});
      const local = await settleWithin(confirm({ peer, sas, signal: ac.signal }), C.PROMPT_TIMEOUT_MS, ac.signal);
      channel.send(MSG.PAIR_RES, { accepted: !!local });
      const accepted = await remote;
      if (local && accepted) {
        this.onTrust(peer);
        this.emit('paired', peer);
        return { paired: true, peer };
      }
      return { paired: false, peer, reason: local ? 'rejected by the other device' : 'cancelled' };
    } finally {
      channel.close();
    }
  }

  /**
   * Send text and/or files to a paired device.
   * onProgress({ sent, total, file }) is called as bytes go out.
   */
  async send(target, { text, files = [] }, { onProgress, signal } = {}) {
    if (text !== undefined && text !== null && typeof text !== 'string') throw new Error('text must be a string');
    if (text && Buffer.byteLength(text) > C.MAX_TEXT_BYTES) throw new Error('text is too long');
    if (files.length > C.MAX_FILES_PER_BATCH) throw new Error('too many files');

    const items = [];
    for (const p of files) {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) throw new Error(`not a regular file: ${path.basename(p)}`);
      items.push({ path: p, name: path.basename(p), size: st.size });
    }
    const hasText = !!text;
    if (!hasText && !items.length) throw new Error('nothing to send');
    const total = items.reduce((a, f) => a + f.size, 0);

    const { channel, peer } = await this._connect(target);
    if (!this.isTrusted(peer.fp)) {
      channel.close();
      throw new RemoteError('not_paired', 'This device is not paired yet');
    }
    const onAbort = () => channel.destroy(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      channel.send(MSG.OFFER, {
        text: hasText ? Buffer.byteLength(text) : 0,
        files: items.map(({ name, size }) => ({ name, size })),
      });
      const res = expectMsg(await channel.recv(C.PROMPT_TIMEOUT_MS + 5000), MSG.OFFER_RES);
      if (!res.accepted) throw new RemoteError('declined', 'The other device declined the transfer');

      // From here on listen for the final ACK, or an ERROR sent mid-stream.
      let remoteFailure = null;
      const finished = new Promise((resolve, reject) => {
        channel.framed.onClose = (err) => reject(remoteFailure || err);
        channel.setHandler((type, body) => {
          if (type === MSG.ACK) return resolve(parseJson(body));
          if (type === MSG.ERROR) {
            const e = parseJson(body);
            remoteFailure = new RemoteError(e.code || 'remote_error', e.message);
            reject(remoteFailure);
            return;
          }
          throw new Error('protocol violation');
        });
      });
      finished.catch(() => {});

      if (hasText) channel.send(MSG.TEXT, { text });

      let sent = 0;
      onProgress?.({ sent, total, file: null });
      for (const f of items) {
        channel.send(MSG.FILE_START, { name: f.name, size: f.size });
        const hash = crypto.createHash('sha256');
        let fileBytes = 0;
        const rs = fs.createReadStream(f.path, { highWaterMark: C.CHUNK_BYTES });
        try {
          for await (const chunk of rs) {
            if (remoteFailure) throw remoteFailure;
            fileBytes += chunk.length;
            if (fileBytes > f.size) throw new Error(`${f.name} changed while sending`);
            hash.update(chunk);
            const ok = channel.send(MSG.FILE_CHUNK, chunk);
            sent += chunk.length;
            onProgress?.({ sent, total, file: f.name });
            if (!ok) await channel.drain();
          }
        } finally {
          rs.destroy();
        }
        if (fileBytes !== f.size) throw new Error(`${f.name} changed while sending`);
        channel.send(MSG.FILE_END, { sha256: hash.digest('hex') });
      }
      channel.send(MSG.DONE, {});
      await finished;
      return { peer, total };
    } catch (e) {
      if (signal?.aborted) throw new Error('cancelled');
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      channel.close();
    }
  }

  // ----------------------------------------------------------------- inbound

  _onInbound(socket) {
    if (this.inbound.size >= C.MAX_INBOUND_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.inbound.add(socket);
    socket.on('close', () => this.inbound.delete(socket));
    socket.setNoDelay(true);
    socket.on('error', () => {});
    const framed = new FramedSocket(socket);
    const address = socket.remoteAddress?.replace(/^::ffff:/, '');
    this._serve(framed, address).catch((e) => {
      framed.destroy(e);
    });
  }

  async _serve(framed, address) {
    const { channel, peer, sas } = await handshake.respond(framed, this.identity, this.getName());
    let first;
    try {
      first = await channel.recv(C.HANDSHAKE_TIMEOUT_MS);
    } catch {
      return; // probe: peer disconnected after the handshake
    }
    if (first.type === MSG.PAIR_REQ) return this._servePairing(channel, peer, sas, address);
    if (!this.isTrusted(peer.fp)) {
      channel.send(MSG.ERROR, { code: 'not_paired', message: 'This device is not paired with the receiver' });
      channel.close();
      return;
    }
    if (first.type === MSG.OFFER) return this._serveTransfer(channel, peer, address, parseJson(first.body));
    throw new Error('protocol violation');
  }

  async _servePairing(channel, peer, sas, address) {
    if (this.pairPending) {
      channel.send(MSG.ERROR, { code: 'busy', message: 'Another pairing request is in progress' });
      channel.close();
      return;
    }
    this.pairPending = true;
    try {
      const ac = new AbortController();
      const remote = channel
        .recv(C.PROMPT_TIMEOUT_MS + 5000)
        .then((m) => expectMsg(m, MSG.PAIR_RES).accepted === true)
        .catch(() => false);
      remote.then((ok) => ok || ac.abort());
      const local = await settleWithin(
        this.onPairRequest({ peer, sas, address, signal: ac.signal }),
        C.PROMPT_TIMEOUT_MS,
        ac.signal
      );
      channel.send(MSG.PAIR_RES, { accepted: !!local });
      if (local && (await remote)) {
        this.onTrust(peer);
        this.emit('paired', peer);
      }
    } finally {
      this.pairPending = false;
      channel.close();
    }
  }

  _validateOffer(offer) {
    if (!offer || typeof offer !== 'object' || !Array.isArray(offer.files)) throw new Error('malformed offer');
    if (offer.files.length > C.MAX_FILES_PER_BATCH) throw new Error('too many files');
    const textBytes = offer.text || 0;
    if (!Number.isSafeInteger(textBytes) || textBytes < 0 || textBytes > C.MAX_TEXT_BYTES) throw new Error('bad offer');
    const files = offer.files.map((f) => {
      if (!f || typeof f.name !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('bad offer');
      return { name: f.name, safeName: sanitizeFileName(f.name), size: f.size };
    });
    if (!textBytes && !files.length) throw new Error('empty offer');
    return { textBytes, files, total: files.reduce((a, f) => a + f.size, 0) };
  }

  async _serveTransfer(channel, peer, address, rawOffer) {
    const offer = this._validateOffer(rawOffer);
    const transferId = crypto.randomUUID();
    const socket = channel.framed.socket;

    const ac = new AbortController();
    channel.framed.onClose = () => ac.abort();
    const accepted = await settleWithin(
      this.onOffer({ peer, address, transferId, text: offer.textBytes > 0, files: offer.files, total: offer.total, signal: ac.signal }),
      C.PROMPT_TIMEOUT_MS,
      ac.signal
    );
    channel.send(MSG.OFFER_RES, { accepted: !!accepted });
    if (!accepted) {
      channel.close();
      return;
    }

    socket.setTimeout(C.IDLE_TIMEOUT_MS, () => channel.destroy(new Error('transfer stalled')));
    const dir = this.getDownloadDir();
    await fs.promises.mkdir(dir, { recursive: true });

    const state = { text: null, fileIndex: 0, current: null, received: 0, saved: [] };
    this.emit('incoming-start', { transferId, peer, files: offer.files.map((f) => f.safeName), total: offer.total });

    const cleanupCurrent = () => {
      const cur = state.current;
      state.current = null;
      if (!cur) return;
      cur.ws.destroy();
      fs.promises.unlink(cur.partPath).catch(() => {});
    };

    await new Promise((resolve) => {
      let done = false;
      channel.framed.onClose = (err) => {
        cleanupCurrent();
        if (!done) {
          done = true;
          this.emit('incoming-error', { transferId, peer, error: err?.message || 'connection lost' });
        }
        resolve();
      };
      const fail = (message) => {
        try {
          channel.send(MSG.ERROR, { code: 'receiver_error', message });
        } catch {}
        throw new Error(message);
      };

      channel.setHandler((type, body) => {
        switch (type) {
          case MSG.TEXT: {
            if (!offer.textBytes || state.text !== null) fail('unexpected text');
            const { text } = parseJson(body);
            if (typeof text !== 'string' || Buffer.byteLength(text) !== offer.textBytes) fail('text does not match offer');
            state.text = text;
            this.emit('text', { transferId, peer, text, address, ts: Date.now() });
            return;
          }
          case MSG.FILE_START: {
            if (state.current) fail('file already in progress');
            const spec = offer.files[state.fileIndex];
            const m = parseJson(body);
            if (!spec || m.name !== spec.name || m.size !== spec.size) fail('file does not match offer');
            const partPath = path.join(dir, `${spec.safeName}.${transferId.slice(0, 8)}.beampart`);
            const ws = fs.createWriteStream(partPath, { flags: 'wx' });
            ws.on('error', () => {});
            state.current = { spec, partPath, ws, bytes: 0, hash: crypto.createHash('sha256') };
            return new Promise((res, rej) => {
              ws.once('open', res);
              ws.once('error', (e) => {
                try {
                  fail(`cannot write file: ${e.code || e.message}`);
                } catch (err) {
                  rej(err);
                }
              });
            });
          }
          case MSG.FILE_CHUNK: {
            const cur = state.current;
            if (!cur) fail('chunk outside of a file');
            if (cur.bytes + body.length > cur.spec.size) fail('file larger than announced');
            cur.bytes += body.length;
            state.received += body.length;
            cur.hash.update(body);
            this.emit('incoming-progress', { transferId, peer, received: state.received, total: offer.total });
            if (!cur.ws.write(body)) return new Promise((r) => cur.ws.once('drain', r));
            return;
          }
          case MSG.FILE_END: {
            const cur = state.current;
            if (!cur) fail('unexpected end of file');
            const { sha256 } = parseJson(body);
            if (cur.bytes !== cur.spec.size) fail('file size mismatch');
            if (cur.hash.digest('hex') !== sha256) fail('file integrity check failed');
            return new Promise((res, rej) => {
              cur.ws.end(async () => {
                try {
                  const finalPath = await reserveUniquePath(dir, cur.spec.safeName);
                  await fs.promises.rename(cur.partPath, finalPath);
                  state.current = null;
                  state.fileIndex++;
                  const info = { transferId, peer, address, path: finalPath, name: path.basename(finalPath), size: cur.spec.size, ts: Date.now() };
                  state.saved.push(info);
                  this.emit('file', info);
                  res();
                } catch (e) {
                  try {
                    fail(`cannot save file: ${e.code || e.message}`);
                  } catch (err) {
                    rej(err);
                  }
                }
              });
            });
          }
          case MSG.DONE: {
            if (state.current || state.fileIndex !== offer.files.length) fail('transfer incomplete');
            if (offer.textBytes && state.text === null) fail('transfer incomplete');
            done = true;
            channel.send(MSG.ACK, { ok: true, files: state.saved.length });
            this.emit('incoming-done', { transferId, peer, text: state.text, files: state.saved });
            channel.close();
            return;
          }
          default:
            fail('protocol violation');
        }
      });
    });
  }
}

module.exports = { BeamNode, RemoteError };

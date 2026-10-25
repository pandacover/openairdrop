'use strict';

const crypto = require('crypto');
const { MAX_FRAME_BYTES } = require('./constants');

/**
 * Length-prefixed framing over a TCP socket: [u32 BE length][payload].
 *
 * Two consumption modes:
 *  - read(): promise for the next frame (used during the handshake)
 *  - setHandler(fn): every frame is pushed to fn. If fn returns a promise, frame
 *    processing (and the socket) is paused until it settles. This gives in-order,
 *    back-pressured processing for things like disk writes.
 */
class FramedSocket {
  constructor(socket, { maxFrame = MAX_FRAME_BYTES } = {}) {
    this.socket = socket;
    this.maxFrame = maxFrame;
    this.chunks = [];
    this.buffered = 0;
    this.queue = [];
    this.waiters = [];
    this.handler = null;
    this.busy = false;
    this.closed = false;
    this.error = null;

    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('connection closed')));
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
    if (this.onClose) this.onClose(err);
  }

  destroy(err) {
    this._fail(err || new Error('connection destroyed'));
    // end() flushes any queued frame (e.g. an ERROR explaining why we hang up).
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  _onData(data) {
    this.chunks.push(data);
    this.buffered += data.length;
    this._pump();
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const need = n - off;
      if (head.length <= need) {
        head.copy(out, off);
        off += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, off, 0, need);
        this.chunks[0] = head.subarray(need);
        off += need;
      }
    }
    this.buffered -= n;
    return out;
  }

  _peekLength() {
    const head = this.chunks[0];
    if (head.length >= 4) return head.readUInt32BE(0);
    const b = Buffer.alloc(4);
    let off = 0;
    for (const c of this.chunks) {
      const n = Math.min(4 - off, c.length);
      c.copy(b, off, 0, n);
      off += n;
      if (off === 4) break;
    }
    return b.readUInt32BE(0);
  }

  _pump() {
    while (!this.closed && !this.busy && this.buffered >= 4) {
      const len = this._peekLength();
      if (len > this.maxFrame) {
        this.destroy(new Error(`frame too large (${len} bytes)`));
        return;
      }
      if (this.buffered < 4 + len) return;
      this._take(4);
      this._deliver(this._take(len));
    }
  }

  _deliver(frame) {
    if (this.handler) {
      let result;
      try {
        result = this.handler(frame);
      } catch (e) {
        this.destroy(e);
        return;
      }
      if (result && typeof result.then === 'function') {
        this.busy = true;
        this.socket.pause();
        result.then(
          () => {
            this.busy = false;
            if (this.closed) return;
            this.socket.resume();
            this._pump();
          },
          (e) => this.destroy(e)
        );
      }
    } else if (this.waiters.length) {
      this.waiters.shift().resolve(frame);
    } else {
      this.queue.push(frame);
    }
  }

  read(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      let timer;
      if (timeoutMs) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('timed out waiting for peer'));
        }, timeoutMs);
        w.resolve = (v) => (clearTimeout(timer), resolve(v));
        w.reject = (e) => (clearTimeout(timer), reject(e));
      }
      this.waiters.push(w);
    });
  }

  setHandler(fn) {
    this.handler = fn;
    // Drain anything that arrived while still in read() mode, preserving order.
    const pending = this.queue.splice(0);
    const runQueued = async () => {
      for (const f of pending) {
        if (this.closed) return;
        const r = fn(f);
        if (r && typeof r.then === 'function') await r;
      }
    };
    if (pending.length) {
      this._deliverPromise(runQueued());
    } else {
      this._pump();
    }
  }

  _deliverPromise(p) {
    this.busy = true;
    this.socket.pause();
    p.then(
      () => {
        this.busy = false;
        if (this.closed) return;
        this.socket.resume();
        this._pump();
      },
      (e) => this.destroy(e)
    );
  }

  /** Returns false when the socket's write buffer is full (wait for 'drain'). */
  write(payload) {
    if (this.closed) throw this.error || new Error('connection closed');
    if (payload.length > this.maxFrame) throw new Error('frame too large to send');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    this.socket.cork();
    this.socket.write(header);
    const ok = this.socket.write(payload);
    this.socket.uncork();
    return ok;
  }

  drain() {
    if (this.closed) return Promise.reject(this.error);
    if (!this.socket.writableNeedDrain) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        this.socket.off('drain', onDrain);
        this.socket.off('close', onClose);
        err ? reject(err) : resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(this.error || new Error('connection closed'));
      this.socket.on('drain', onDrain);
      this.socket.on('close', onClose);
    });
  }
}

/**
 * AES-256-GCM channel with implicit per-direction 64-bit counters as nonces.
 * Counters are never sent: TCP is ordered, so any replayed, dropped, reordered
 * or modified frame fails authentication and the connection is torn down.
 */
class SecureChannel {
  constructor(framed, sendKey, recvKey) {
    this.framed = framed;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendCounter = 0n;
    this.recvCounter = 0n;
  }

  static nonce(counter) {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }

  seal(type, body) {
    const nonce = SecureChannel.nonce(this.sendCounter++);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonce);
    const head = cipher.update(Buffer.from([type]));
    const ct = body && body.length ? cipher.update(body) : Buffer.alloc(0);
    cipher.final();
    return Buffer.concat([head, ct, cipher.getAuthTag()]);
  }

  open(frame) {
    if (frame.length < 17) throw new Error('frame too short');
    const nonce = SecureChannel.nonce(this.recvCounter++);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, nonce);
    decipher.setAuthTag(frame.subarray(frame.length - 16));
    const pt = Buffer.concat([decipher.update(frame.subarray(0, frame.length - 16)), decipher.final()]);
    return { type: pt[0], body: pt.subarray(1) };
  }

  /** Send a message; body may be a Buffer or a JSON-serialisable object. */
  send(type, body) {
    const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return this.framed.write(this.seal(type, buf));
  }

  async recv(timeoutMs) {
    const msg = this.open(await this.framed.read(timeoutMs));
    return msg;
  }

  setHandler(fn) {
    this.framed.setHandler((frame) => {
      const msg = this.open(frame); // throws on tamper -> connection destroyed
      return fn(msg.type, msg.body);
    });
  }

  drain() {
    return this.framed.drain();
  }

  close() {
    this.framed.socket.end();
  }

  destroy(err) {
    this.framed.destroy(err);
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('malformed message');
  }
}

module.exports = { FramedSocket, SecureChannel, parseJson };

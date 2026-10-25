'use strict';

/*
 * LAN presence via UDP broadcast. Beacons only say "who is around and on which
 * port"; they carry no secrets and are never trusted. Identity is proven by
 * the handshake when a connection is actually made.
 */

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const C = require('./constants');

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) >>> 0).join('.'));
    }
  }
  return [...out];
}

class Discovery extends EventEmitter {
  constructor({ port = C.DISCOVERY_PORT } = {}) {
    super();
    this.port = port;
    this.socket = null;
    this.self = null;
    this.peers = new Map();
    this.timers = [];
    this.lastQueryReply = 0;
  }

  start(self) {
    this.self = self;
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      socket.on('error', (e) => this.emit('error', e));
      socket.bind(this.port, () => {
        try {
          socket.setBroadcast(true);
        } catch {}
        this._send('query');
        this._send('announce');
        this.timers.push(setInterval(() => this._send('announce'), C.BEACON_INTERVAL_MS));
        this.timers.push(setInterval(() => this._expire(), 1000));
        resolve();
      });
    });
  }

  update(self) {
    this.self = { ...this.self, ...self };
    this._send('announce');
  }

  /** Ask everyone to announce immediately. */
  refresh() {
    this._send('query');
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.socket) {
      try {
        this._send('bye');
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }

  _send(t) {
    if (!this.socket || !this.self) return;
    const msg = Buffer.from(
      JSON.stringify({
        app: C.APP_ID,
        v: C.PROTOCOL_VERSION,
        t,
        id: this.self.id,
        name: this.self.name,
        port: this.self.port,
        platform: this.self.platform,
      })
    );
    for (const addr of broadcastAddresses()) {
      this.socket.send(msg, this.port, addr, () => {});
    }
  }

  _onMessage(buf, rinfo) {
    if (buf.length > 1024) return;
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.app !== C.APP_ID || m.v !== C.PROTOCOL_VERSION) return;
    if (typeof m.id !== 'string' || !/^[0-9a-f]{32}$/.test(m.id)) return;
    if (this.self && m.id === this.self.id) return;

    if (m.t === 'bye') {
      if (this.peers.delete(m.id)) this.emit('lost', m.id);
      return;
    }
    if (m.t === 'query') {
      const now = Date.now();
      if (now - this.lastQueryReply > 500) {
        this.lastQueryReply = now;
        this._send('announce');
      }
    }
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;

    const peer = {
      id: m.id,
      name: String(m.name || 'Unknown').slice(0, 64),
      platform: String(m.platform || '').slice(0, 16),
      address: rinfo.address,
      port: m.port,
      lastSeen: Date.now(),
    };
    const prev = this.peers.get(m.id);
    this.peers.set(m.id, peer);
    if (!prev || prev.address !== peer.address || prev.port !== peer.port || prev.name !== peer.name) {
      this.emit('peer', peer);
    }
  }

  _expire() {
    const now = Date.now();
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > C.PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        this.emit('lost', id);
      }
    }
  }
}

module.exports = { Discovery, broadcastAddresses };

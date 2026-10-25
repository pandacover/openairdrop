'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { BeamNode } = require('../src/core/node');
const { generateIdentity, exportIdentity, importIdentity } = require('../src/core/identity');
const { FramedSocket, SecureChannel } = require('../src/core/framing');
const handshake = require('../src/core/handshake');
const { sanitizeFileName } = require('../src/core/files');
const { Discovery } = require('../src/core/discovery');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));

function makeNode(name, { pairAnswer = true, offerAnswer = true } = {}) {
  const trusted = new Map();
  const dir = path.join(tmp, name + '-' + crypto.randomBytes(3).toString('hex'));
  const node = new BeamNode({
    identity: generateIdentity(),
    getName: () => name,
    getDownloadDir: () => dir,
    isTrusted: (fp) => trusted.has(fp),
    onTrust: (peer) => trusted.set(peer.fp, peer),
    onPairRequest: async ({ sas }) => {
      node.lastSas = sas;
      return pairAnswer;
    },
    onOffer: async () => offerAnswer,
  });
  node.trusted = trusted;
  node.dir = dir;
  return node;
}

async function pairedPair() {
  const a = makeNode('Alice');
  const b = makeNode('Bob');
  const port = await b.listen(0, '127.0.0.1');
  let shownSas;
  const res = await a.pair({ host: '127.0.0.1', port }, async ({ sas }) => {
    shownSas = sas;
    return true;
  });
  return { a, b, port, res, shownSas };
}

test('identity round-trips through PEM', () => {
  const id = generateIdentity();
  const back = importIdentity(exportIdentity(id));
  assert.strictEqual(back.fp, id.fp);
  assert.ok(back.pub.equals(id.pub));
});

test('pairing: both sides see the same code and trust each other', async () => {
  const { a, b, res, shownSas } = await pairedPair();
  try {
    assert.strictEqual(res.paired, true);
    assert.match(shownSas, /^\d{6}$/);
    assert.strictEqual(shownSas, b.lastSas);
    // Give B a tick to record trust after receiving A's confirmation.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(a.trusted.has(b.identity.fp));
    assert.ok(b.trusted.has(a.identity.fp));
  } finally {
    await b.close();
  }
});

test('pairing rejected by receiver -> nobody trusts anybody', async () => {
  const a = makeNode('Alice');
  const b = makeNode('Bob', { pairAnswer: false });
  const port = await b.listen(0, '127.0.0.1');
  try {
    const res = await a.pair({ host: '127.0.0.1', port }, async () => true);
    assert.strictEqual(res.paired, false);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(a.trusted.size, 0);
    assert.strictEqual(b.trusted.size, 0);
  } finally {
    await b.close();
  }
});

test('sending to an unpaired device is refused', async () => {
  const a = makeNode('Alice');
  const b = makeNode('Bob');
  const port = await b.listen(0, '127.0.0.1');
  try {
    // A trusts B, but B never agreed.
    const peer = await a.probe({ host: '127.0.0.1', port });
    a.trusted.set(peer.fp, peer);
    await assert.rejects(a.send({ host: '127.0.0.1', port }, { text: 'hi' }), /not paired/);
  } finally {
    await b.close();
  }
});

test('identity mismatch is detected', async () => {
  const { a, b, port } = await pairedPair();
  try {
    await assert.rejects(
      a.send({ host: '127.0.0.1', port, fp: 'f'.repeat(32) }, { text: 'hi' }),
      /identity mismatch/
    );
  } finally {
    await b.close();
  }
});

test('text and files transfer intact', async () => {
  const { a, b, port } = await pairedPair();
  try {
    const big = path.join(tmp, 'big.bin');
    const bigData = crypto.randomBytes(8 * 1024 * 1024 + 123);
    fs.writeFileSync(big, bigData);
    const empty = path.join(tmp, 'empty.txt');
    fs.writeFileSync(empty, '');
    const weird = path.join(tmp, 'we ird ünï.txt');
    fs.writeFileSync(weird, 'hello ✓');

    const texts = [];
    const files = [];
    b.on('text', (t) => texts.push(t.text));
    b.on('file', (f) => files.push(f));
    const done = new Promise((r) => b.once('incoming-done', r));

    let lastProgress;
    const t0 = Date.now();
    await a.send(
      { host: '127.0.0.1', port, fp: b.identity.fp },
      { text: 'héllo 👋', files: [big, empty, weird] },
      { onProgress: (p) => (lastProgress = p) }
    );
    const ms = Date.now() - t0;
    await done;

    assert.deepStrictEqual(texts, ['héllo 👋']);
    assert.strictEqual(files.length, 3);
    assert.ok(fs.readFileSync(files[0].path).equals(bigData));
    assert.strictEqual(fs.readFileSync(files[1].path).length, 0);
    assert.strictEqual(fs.readFileSync(files[2].path, 'utf8'), 'hello ✓');
    assert.strictEqual(lastProgress.sent, lastProgress.total);
    assert.ok(!fs.readdirSync(b.dir).some((n) => n.endsWith('.beampart')));
    console.log(`  8 MiB over loopback in ${ms} ms (${(8 / (ms / 1000)).toFixed(0)} MiB/s)`);

    // Sending the same file again doesn't overwrite the first copy.
    const again = new Promise((r) => b.once('file', r));
    await a.send({ host: '127.0.0.1', port }, { files: [weird] });
    const second = await again;
    assert.notStrictEqual(second.path, files[2].path);
    assert.match(second.name, /\(1\)/);
  } finally {
    await b.close();
  }
});

test('declined offer is reported to the sender', async () => {
  const a = makeNode('Alice');
  const b = makeNode('Bob', { offerAnswer: false });
  const port = await b.listen(0, '127.0.0.1');
  try {
    await a.pair({ host: '127.0.0.1', port }, async () => true);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(a.send({ host: '127.0.0.1', port }, { text: 'x' }), /declined/);
  } finally {
    await b.close();
  }
});

test('secure channel rejects tampered, replayed and reordered frames', () => {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);
  const tx = new SecureChannel(null, k1, k2);
  const f1 = tx.seal(1, Buffer.from('one'));
  const f2 = tx.seal(1, Buffer.from('two'));

  const rx = () => new SecureChannel(null, k2, k1);
  const ok = rx();
  assert.strictEqual(ok.open(f1).body.toString(), 'one');
  assert.strictEqual(ok.open(f2).body.toString(), 'two');

  const tampered = Buffer.from(f1);
  tampered[3] ^= 1;
  assert.throws(() => rx().open(tampered));
  assert.throws(() => rx().open(f2), 'reordered frame must fail');
  const replay = rx();
  replay.open(f1);
  assert.throws(() => replay.open(f1), 'replayed frame must fail');
});

test('oversized frames kill the connection', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const closed = new Promise((resolve) => {
    server.on('connection', (s) => {
      const f = new FramedSocket(s);
      f.onClose = (e) => resolve(e.message);
    });
  });
  const c = net.connect(server.address().port, '127.0.0.1');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(0x7fffffff);
  c.write(h);
  assert.match(await closed, /too large/);
  c.destroy();
  server.close();
});

test('handshake fails if the initiator breaks its commitment', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const result = new Promise((resolve) => {
    server.on('connection', (s) => {
      handshake.respond(new FramedSocket(s), generateIdentity(), 'R').then(
        () => resolve('ok'),
        (e) => resolve(e.message)
      );
    });
  });
  const sock = net.connect(server.address().port, '127.0.0.1');
  const f = new FramedSocket(sock);
  const send = (o) => f.write(Buffer.from(JSON.stringify(o)));
  send({ t: 'commit', v: 1, c: crypto.randomBytes(32).toString('base64') });
  await f.read(2000);
  const id = generateIdentity();
  send({
    t: 'hello',
    id: id.pub.toString('base64'),
    eph: crypto.randomBytes(32).toString('base64'),
    name: 'X',
    sig: crypto.randomBytes(64).toString('base64'),
  });
  assert.match(await result, /commitment/);
  sock.destroy();
  server.close();
});

test('sanitizeFileName blocks traversal and reserved names', () => {
  assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFileName('..\\..\\win.ini'), 'win.ini');
  assert.strictEqual(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.strictEqual(sanitizeFileName('.bashrc'), '_bashrc');
  assert.strictEqual(sanitizeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.strictEqual(sanitizeFileName('..'), 'file');
  assert.strictEqual(sanitizeFileName('name. . '), 'name');
});

test('discovery: two instances see each other', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const d1 = new Discovery({ port });
  const d2 = new Discovery({ port });
  const seen = new Promise((resolve) => d1.on('peer', resolve));
  await d1.start({ id: 'a'.repeat(32), name: 'One', port: 1111, platform: 'test' });
  await d2.start({ id: 'b'.repeat(32), name: 'Two', port: 2222, platform: 'test' });
  try {
    const peer = await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error('no beacon')), 5000))]);
    assert.strictEqual(peer.id, 'b'.repeat(32));
    assert.strictEqual(peer.port, 2222);
  } finally {
    d1.stop();
    d2.stop();
  }
});

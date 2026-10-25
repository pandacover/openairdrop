'use strict';

// End-to-end check: runs two real Beam instances side by side (separate
// profiles), pairs them through the UI, sends text + a file from the quick-send
// popup and verifies the received file byte-for-byte.
// Run: node scripts/e2e.js   (requires devDependency playwright-core)

const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const work = path.join(root, '.profiles', 'e2e');
const shots = path.join(root, '.profiles', 'shots');

async function launch(name, port) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // BEAM_EXE=dist/win-unpacked/Beam.exe runs the test against a packaged build.
  const profileArgs = [`--beam-profile=${path.join(work, name)}`, `--beam-port=${port}`];
  const app = await electron.launch(
    process.env.BEAM_EXE
      ? { executablePath: path.resolve(process.env.BEAM_EXE), args: profileArgs, env }
      : { args: [root, ...profileArgs], env }
  );
  app.process().stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  const win = await waitForWindow(app, 'main/index.html');
  await win.waitForSelector('#me-name:not(:empty)');
  return { app, win };
}

async function waitForWindow(app, fragment) {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().replace(/\\/g, '/').includes(fragment));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`window ${fragment} not found`);
}

async function mockDialog(app, filePaths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, filePaths);
}

(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });

  const A = await launch('a', 47901);
  const B = await launch('b', 47902);
  try {
    await A.win.evaluate(() => window.beam.updateSettings({ deviceName: 'Laptop A' }));
    await B.win.evaluate(() => window.beam.updateSettings({ deviceName: 'Desktop B' }));
    const inbox = path.join(work, 'b-downloads');
    fs.mkdirSync(inbox, { recursive: true });
    await mockDialog(B.app, [inbox]);
    await B.win.evaluate(() => window.beam.chooseDownloadDir());

    // Discovery
    await A.win.waitForSelector('.device-card:has-text("Desktop B")', { timeout: 15000 });
    console.log('✓ A discovered B over UDP broadcast');

    // Pairing: both sides must show the same code and confirm.
    await A.win.click('.device-card:has-text("Desktop B") button:has-text("Pair")');
    await A.win.waitForSelector('#modal:not(.hidden) .sas');
    await B.win.waitForSelector('#modal:not(.hidden) .sas');
    const sasA = await A.win.textContent('.sas');
    const sasB = await B.win.textContent('.sas');
    assert.strictEqual(sasA, sasB);
    console.log(`✓ both devices show code ${sasA}`);
    await B.win.screenshot({ path: path.join(shots, 'pair-prompt.png') });
    await B.win.click('#modal button.primary');
    await A.win.click('#modal button.primary');
    await A.win.waitForSelector('.device-card:has-text("Desktop B") .tag.paired');
    await B.win.waitForSelector('.device-card:has-text("Laptop A") .tag.paired');
    console.log('✓ paired on both sides');
    await A.win.screenshot({ path: path.join(shots, 'devices.png') });

    // Quick-send popup (shown the same way the global shortcut does).
    const popup = await waitForWindow(A.app, 'popup/popup.html');
    await A.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Beam Quick Send');
      w.show();
      w.focus();
      w.webContents.send('popup-shown');
    });
    await popup.waitForSelector('.device[aria-checked="true"]:has-text("Desktop B")');

    const file = path.join(work, 'payload.bin');
    const data = crypto.randomBytes(20 * 1024 * 1024 + 7);
    fs.writeFileSync(file, data);
    await mockDialog(A.app, [file]);
    await popup.click('#attach');
    await popup.waitForSelector('.files .chip');
    await popup.fill('#text', 'Hello from the quick-send popup 👋');
    await popup.screenshot({ path: path.join(shots, 'popup.png') });
    const t0 = Date.now();
    await popup.keyboard.press('Enter');
    await popup.waitForSelector('.status.ok', { timeout: 30000 });
    console.log(`✓ popup sent text + 20 MiB file in ${Date.now() - t0} ms`);

    // Verify on B.
    await B.win.click('.nav[data-view="activity"]');
    await B.win.waitForSelector('.item .text:has-text("Hello from the quick-send popup")');
    await B.win.waitForSelector('.item .file:has-text("payload.bin")');
    const received = fs.readFileSync(path.join(inbox, 'payload.bin'));
    assert.ok(received.equals(data), 'received file differs');
    console.log('✓ B received the text and a byte-identical file');
    await B.win.screenshot({ path: path.join(shots, 'activity.png') });

    // Main-window composer works too (B -> A text).
    await B.win.click('.nav[data-view="devices"]');
    await B.win.click('.device-card:has-text("Laptop A") button:has-text("Send")');
    await B.win.fill('#composer-text', 'Reply from B');
    await B.win.click('#composer-send');
    await A.win.click('.nav[data-view="activity"]');
    await A.win.waitForSelector('.item .text:has-text("Reply from B")');
    console.log('✓ B -> A reply via main window composer');

    // Forgetting a device revokes it: A can no longer send to B.
    await B.win.evaluate(async () => {
      const s = await window.beam.getState();
      await window.beam.forgetDevice(s.devices.find((d) => d.name === 'Laptop A').id);
    });
    const res = await A.win.evaluate(async () => {
      const s = await window.beam.getState();
      return window.beam.send({ deviceId: s.devices.find((d) => d.name === 'Desktop B').id, text: 'should fail' });
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not paired/);
    console.log('✓ after B forgets A, A is refused:', res.error);

    console.log('\nE2E PASSED');
  } finally {
    await A.app.close().catch(() => {});
    await B.app.close().catch(() => {});
  }
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});

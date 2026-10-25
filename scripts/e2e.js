'use strict';

// End-to-end check: runs two real Beam instances side by side (separate
// profiles), pairs them through the UI, sends text + files from the quick-send
// popup, verifies the received file byte-for-byte, and captures screenshots
// (light + dark) into .profiles/shots.
// Run: npm run test:e2e   (BEAM_EXE=dist/win-unpacked/Beam.exe to test a packaged build)

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
  const profileArgs = [`--beam-profile=${path.join(work, name)}`, `--beam-port=${port}`];
  const app = await electron.launch(
    process.env.BEAM_EXE
      ? { executablePath: path.resolve(process.env.BEAM_EXE), args: profileArgs, env }
      : { args: [root, ...profileArgs], env }
  );
  app.process().stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  const win = await waitForWindow(app, 'main/index.html');
  await win.waitForSelector('#shortcut-hint kbd');
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

const trusted = async (name) => (await window.beam.getState()).devices.some((d) => d.name === name && d.trusted);

(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(shots, { recursive: true, force: true });
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
    await A.win.waitForSelector('.device-row:has-text("Desktop B")', { timeout: 15000 });
    console.log('✓ A discovered B over UDP broadcast');
    await A.win.click('.device-row:has-text("Desktop B")');
    await A.win.screenshot({ path: path.join(shots, 'light-pair-pane.png') });

    // Pairing: both sides must show the same code and confirm.
    await A.win.click('#pair-btn');
    await A.win.waitForSelector('#modal:not([hidden]) .code');
    await B.win.waitForSelector('#modal:not([hidden]) .code');
    const sasA = await A.win.textContent('#modal .code');
    const sasB = await B.win.textContent('#modal .code');
    assert.strictEqual(sasA, sasB);
    console.log(`✓ both devices show code ${sasA}`);
    await B.win.screenshot({ path: path.join(shots, 'light-pair-prompt.png') });
    await B.win.click('#modal [data-default]');
    await A.win.click('#modal [data-default]');
    await A.win.waitForSelector('#pane-thread:not([hidden]) #thread-name:has-text("Desktop B")');
    await B.win.waitForFunction(trusted, 'Laptop A');
    console.log('✓ paired on both sides');

    // Quick-send popup (shown the same way the global shortcut does).
    const popup = await waitForWindow(A.app, 'popup/popup.html');
    const showPopup = () =>
      A.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Beam Quick Send');
        w.show();
        w.focus();
        w.webContents.send('popup-shown');
      });
    await showPopup();
    await popup.waitForSelector('.device[aria-checked="true"]:has-text("Desktop B")');
    await popup.waitForTimeout(300);
    await popup.screenshot({ path: path.join(shots, 'light-popup-empty.png') });

    const file = path.join(work, 'payload.bin');
    const data = crypto.randomBytes(20 * 1024 * 1024 + 7);
    fs.writeFileSync(file, data);
    const notes = path.join(work, 'Meeting notes.pdf');
    fs.writeFileSync(notes, crypto.randomBytes(184 * 1024));
    const photo = path.join(work, 'IMG_2041.jpg');
    fs.writeFileSync(photo, crypto.randomBytes(3355443));
    const message = 'Here are the files from this morning, and the photo of the whiteboard.';
    await mockDialog(A.app, [file, notes, photo]);
    await popup.click('#attach');
    await popup.waitForSelector('.files .chip >> nth=2');
    await popup.fill('#text', message);
    await popup.waitForTimeout(300);
    await popup.screenshot({ path: path.join(shots, 'light-popup-files.png') });
    const t0 = Date.now();
    await popup.keyboard.press('Enter');
    await popup.waitForSelector('.status.ok', { timeout: 30000 });
    console.log(`✓ popup sent text + 3 files in ${Date.now() - t0} ms`);

    // Verify on B.
    await B.win.click('.device-row:has-text("Laptop A")');
    await B.win.waitForSelector('.bubble:has-text("files from this morning")');
    await B.win.waitForSelector('.file-name:has-text("payload.bin")');
    assert.ok(fs.readFileSync(path.join(inbox, 'payload.bin')).equals(data), 'received file differs');
    console.log('✓ B received the text and a byte-identical file');

    // Replies from B's main-window composer (Enter sends, same as the popup).
    await B.win.fill('#composer-text', 'Got them, thanks!');
    await B.win.press('#composer-text', 'Enter');
    await A.win.waitForSelector('.bubble:has-text("Got them, thanks!")');
    await B.win.fill('#composer-text', 'Can you also send the slides when you get a chance?');
    await B.win.press('#composer-text', 'Enter');
    await A.win.waitForSelector('.bubble:has-text("also send the slides")');
    console.log('✓ B -> A replies via main window composer');

    // Popup error state: folders can't be sent.
    await showPopup();
    await mockDialog(A.app, [work]);
    await popup.click('#attach');
    await popup.waitForSelector('.status.error');
    await popup.waitForTimeout(300);
    await popup.screenshot({ path: path.join(shots, 'light-popup-error.png') });
    await popup.keyboard.press('Escape');

    // Screenshots in both color schemes.
    const setSize = (app, w, h) =>
      app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Beam').setContentSize(w, h),
        [w, h]
      );
    for (const scheme of ['light', 'dark']) {
      for (const page of [A.win, B.win, popup]) await page.emulateMedia({ colorScheme: scheme });
      await setSize(B.app, 880, 580);
      await B.win.waitForTimeout(250);
      await B.win.screenshot({ path: path.join(shots, `${scheme}-thread.png`) });
      await setSize(B.app, 760, 520);
      await B.win.waitForTimeout(250);
      await B.win.screenshot({ path: path.join(shots, `${scheme}-thread-small.png`) });
      await setSize(B.app, 880, 580);
      await B.win.click('#open-settings');
      await B.win.waitForTimeout(200);
      await B.win.screenshot({ path: path.join(shots, `${scheme}-settings.png`) });
      await B.win.click('#open-settings');
      await B.win.click('#unpair');
      await B.win.waitForSelector('#modal:not([hidden])');
      await B.win.screenshot({ path: path.join(shots, `${scheme}-confirm.png`) });
      await B.win.keyboard.press('Escape');
      if (scheme === 'dark') {
        await showPopup();
        await mockDialog(A.app, [file, notes, photo]);
        await popup.click('#attach');
        await popup.waitForSelector('.files .chip >> nth=2');
        await popup.fill('#text', message);
        await popup.waitForTimeout(300);
        await popup.screenshot({ path: path.join(shots, 'dark-popup-files.png') });
        await popup.keyboard.press('Escape');
      }
    }

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

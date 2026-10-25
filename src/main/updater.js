'use strict';

/*
 * Automatic updates from GitHub Releases (electron-updater).
 *
 * - Windows (NSIS) and Linux AppImage: download in the background, install on
 *   quit or on "Restart to update".
 * - macOS: Squirrel.Mac only accepts updates for apps signed with a Developer ID.
 *   Ad-hoc signed builds can't self-update, so they only check and offer the
 *   download page.
 *
 * BEAM_UPDATE_URL=<url> points the updater at a self-hosted "generic" feed
 * (a folder containing latest.yml / latest-mac.yml and the installers).
 */

const { app, shell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const RELEASES_URL = 'https://github.com/pandacover/openairdrop/releases/latest';
const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function macIsDeveloperIdSigned() {
  const bundle = path.resolve(process.execPath, '../../..');
  return new Promise((resolve) => {
    // codesign prints signature details on stderr.
    execFile('codesign', ['-dv', '--verbose=2', bundle], (err, _stdout, stderr) => {
      resolve(!err && /Authority=Developer ID Application/.test(stderr));
    });
  });
}

class Updater extends EventEmitter {
  constructor({ autoInstallEnabled, enabled = true }) {
    super();
    this.autoInstallEnabled = autoInstallEnabled; // () => boolean, from settings
    this.enabled = enabled;
    this.updater = null;
    this.state = { status: 'idle', version: null, percent: 0, error: null, canAutoInstall: false, lastChecked: null };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  async start() {
    const feedOverride = process.env.BEAM_UPDATE_URL;
    if (!this.enabled || (!app.isPackaged && !feedOverride)) {
      this._set({ status: 'disabled' });
      return;
    }

    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    autoUpdater.logger = { info() {}, warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug() {} };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    if (feedOverride) {
      autoUpdater.forceDevUpdateConfig = !app.isPackaged;
      autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride });
    }

    let canAutoInstall = false;
    if (process.platform === 'win32') canAutoInstall = true;
    else if (process.platform === 'darwin') canAutoInstall = await macIsDeveloperIdSigned();
    else if (process.platform === 'linux') canAutoInstall = !!process.env.APPIMAGE;
    this._set({ canAutoInstall });

    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'up-to-date', lastChecked: Date.now() }));
    autoUpdater.on('update-available', (info) => {
      this._set({ status: 'available', version: info.version, lastChecked: Date.now() });
      if (canAutoInstall && this.autoInstallEnabled()) this.download();
      else this.emit('available', info.version);
    });
    autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this._set({ status: 'ready', version: info.version, percent: 100 });
      this.emit('ready', info.version);
    });
    // Offline or GitHub unreachable: record it quietly and try again later.
    autoUpdater.on('error', (e) => this._set({ status: 'error', error: e?.message?.split('\n')[0] || 'Update failed' }));

    setTimeout(() => this.check(), FIRST_CHECK_MS).unref();
    setInterval(() => this.check(), CHECK_EVERY_MS).unref();
  }

  async check() {
    if (!this.updater || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      this._set({ status: 'error', error: e?.message?.split('\n')[0] || 'Update check failed' });
    }
  }

  async download() {
    if (!this.updater || !this.state.canAutoInstall) return;
    this._set({ status: 'downloading', percent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (e) {
      this._set({ status: 'error', error: e?.message?.split('\n')[0] || 'Download failed' });
    }
  }

  /** Quit and install now. The caller must let windows close first. */
  installNow() {
    if (this.state.status !== 'ready') return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }

  openDownloadPage() {
    return shell.openExternal(RELEASES_URL);
  }
}

module.exports = { Updater };

'use strict';

/*
 * homebridge-pentair-poolcolor
 *
 * Exposes Pentair ScreenLogic pool light color control as a HomeKit Lightbulb
 * with ONLY Hue/Saturation — a pure color picker with no on/off. The user
 * already has per-circuit on/off switches; this accessory is just the wheel.
 *
 * The Pentair protocol only supports a handful of fixed colors, so the wheel
 * position is snapped to the nearest supported color:
 *   saturation < 15%            -> White
 *   hue near   0 deg (red)      -> Red
 *   hue near 120 deg (green)    -> Green
 *   hue near 240 deg (blue)     -> Blue
 *   hue near 285 deg (purple)   -> Purple
 *
 * Note: sending a color command powers the lights on — that is the Pentair
 * controller's own behavior. Color commands are controller-wide: every light
 * circuit that is on changes together. That is a Pentair limitation.
 */

const ScreenLogic = require('node-screenlogic');

const COLOR_CMDS = [
  // [name, ScreenLogic command]
  ['red', ScreenLogic.LIGHT_CMD_COLOR_RED],
  ['green', ScreenLogic.LIGHT_CMD_COLOR_GREEN],
  ['blue', ScreenLogic.LIGHT_CMD_COLOR_BLUE],
  ['purple', ScreenLogic.LIGHT_CMD_COLOR_PURPLE],
  ['white', ScreenLogic.LIGHT_CMD_COLOR_WHITE],
];

// Hue wheel centers for the fixed colors (degrees). White is picked by low saturation.
const HUE_CENTERS = [
  ['red', 0],
  ['green', 120],
  ['blue', 240],
  ['purple', 285],
];

const SATURATION_WHITE_THRESHOLD = 15; // % — below this, pick white
const COLOR_DEBOUNCE_MS = 700; // coalesce color-wheel drags into one command
const SEND_TIMEOUT_MS = 15000; // upper bound on discovery+connect+login+command; node-screenlogic has no timeouts of its own

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-pentair-poolcolor', 'PentairPoolColor', PoolColorAccessory);
};

function hueToColorName(hue, saturation) {
  if (saturation < SATURATION_WHITE_THRESHOLD) {
    return 'white';
  }
  const h = ((hue % 360) + 360) % 360;
  let best = HUE_CENTERS[0][0];
  let bestDist = 360;
  for (const [name, center] of HUE_CENTERS) {
    const dist = Math.min(Math.abs(h - center), 360 - Math.abs(h - center));
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

class PoolController {
  constructor(config) {
    this.ip_address = config.ip_address;
    this.port = config.port || 80;
    this.password = config.password;
  }

  // Runs fn with a fresh logged-in connection, always closing it afterwards.
  // The whole operation (discovery, connect, login, command) is bounded by
  // timeoutMs — node-screenlogic sets no timeouts itself, and an unreachable
  // adapter would otherwise hang the caller forever.
  async withConnection(fn, timeoutMs = SEND_TIMEOUT_MS) {
    let connection;
    const operation = (async () => {
      connection = await this._getConnection();
      await this._login(connection);
      return await fn(connection);
    })();
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`ScreenLogic operation timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (connection) {
        try { connection.close(); } catch (e) { /* ignore */ }
      }
      // A timed-out operation may still settle later; keep it from becoming
      // an unhandled rejection.
      operation.catch(() => {});
    }
  }

  _getConnection() {
    if (this.ip_address) {
      return Promise.resolve(
        new ScreenLogic.UnitConnection(this.port, this.ip_address, this.password),
      );
    }
    // UDP broadcast discovery on the LAN
    return new Promise((resolve, reject) => {
      const finder = new ScreenLogic.FindUnits();
      const timer = setTimeout(() => {
        try { finder.close(); } catch (e) { /* ignore */ }
        reject(new Error('no ScreenLogic unit found via broadcast'));
      }, 15000);
      finder
        .on('serverFound', (server) => {
          clearTimeout(timer);
          try { finder.close(); } catch (e) { /* ignore */ }
          resolve(new ScreenLogic.UnitConnection(server));
        })
        .on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      finder.search();
    });
  }

  _login(connection) {
    return new Promise((resolve, reject) => {
      connection
        .once('loggedIn', () => resolve())
        .once('loginFailed', () => reject(new Error('ScreenLogic login failed')))
        .once('error', (err) => reject(err));
      connection.connect();
    });
  }

  async sendLightCommand(cmd) {
    return this.withConnection((connection) => new Promise((resolve, reject) => {
      connection
        .once('sentLightCommand', () => resolve())
        .once('badParameter', () => reject(new Error('bad parameter in sendLightCommand')))
        .once('error', (err) => reject(err));
      connection.sendLightCommand(0, cmd);
    }));
  }
}

class PoolColorAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Pool Light Color';
    this.controller = new PoolController(config);

    this.currentHue = 0;
    this.currentSaturation = 100;
    this.colorTimer = null;
    this.sending = false;    // a color command is currently in flight
    this.queuedColor = null; // latest color requested while a send is in flight

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Pentair')
      .setCharacteristic(Characteristic.Model, 'ScreenLogic Color Picker')
      .setCharacteristic(Characteristic.SerialNumber, 'poolcolor');

    // Deliberately NO On characteristic: this tile is a pure color picker.
    // On/off stays on the per-circuit switches.
    this.lightService = new Service.Lightbulb(this.name);
    this.lightService.setCharacteristic(Characteristic.Name, this.name);

    this.lightService.getCharacteristic(Characteristic.Hue)
      .on('get', (cb) => cb(null, this.currentHue))
      .on('set', (value, cb) => this.handleSetColor(value, null, cb));

    this.lightService.getCharacteristic(Characteristic.Saturation)
      .on('get', (cb) => cb(null, this.currentSaturation))
      .on('set', (value, cb) => this.handleSetColor(null, value, cb));

    this.log.info(`"${this.name}" ready — color picker only, no on/off`);
  }

  getServices() {
    return [this.informationService, this.lightService];
  }

  handleSetColor(hue, saturation, callback) {
    if (hue !== null) {
      this.currentHue = hue;
    }
    if (saturation !== null) {
      this.currentSaturation = saturation;
    }
    callback(null);
    // Debounce: the Home app fires many sets while dragging the wheel.
    if (this.colorTimer) {
      clearTimeout(this.colorTimer);
    }
    this.colorTimer = setTimeout(() => {
      this.colorTimer = null;
      this.sendColor();
    }, COLOR_DEBOUNCE_MS);
  }

  sendColor() {
    const colorName = hueToColorName(this.currentHue, this.currentSaturation);
    const cmd = COLOR_CMDS.find(([name]) => name === colorName)[1];
    this.log.info(`setting pool color: ${colorName} (hue ${Math.round(this.currentHue)}, sat ${Math.round(this.currentSaturation)})`);
    // Latest-wins: intermediate colors are pointless (the lights only ever show
    // the final one), so a request that arrives mid-send replaces the queued
    // one instead of lining up behind it.
    this.queuedColor = { colorName, cmd };
    this._pumpSendQueue();
  }

  _pumpSendQueue() {
    if (this.sending) {
      return;
    }
    this.sending = true;
    (async () => {
      try {
        while (this.queuedColor) {
          const { colorName, cmd } = this.queuedColor;
          this.queuedColor = null;
          try {
            await this.controller.sendLightCommand(cmd);
            this.log.info(`pool color command sent: ${colorName}`);
          } catch (err) {
            this.log.error('sendLightCommand failed:', err.message);
          }
        }
      } finally {
        this.sending = false;
      }
    })();
  }
}

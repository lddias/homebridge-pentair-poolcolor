'use strict';

/*
 * homebridge-pentair-poolcolor
 *
 * Exposes Pentair ScreenLogic pool light color control as a HomeKit Lightbulb
 * with Hue/Saturation AND On/Off. The color wheel is still the main control;
 * On reflects whether any of the configured light circuits is on, and turning
 * it off switches all of them off.
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

// Hue wheel centers for the fixed colors (degrees). White is picked by low saturation,
// or by a warm (amber/yellow) hue: voice assistants send "warm white" as a saturated
// amber hue (~35 deg), and Pentair has no amber — white is the closest match, red is not.
const HUE_CENTERS = [
  ['red', 0],
  ['green', 120],
  ['blue', 240],
  ['purple', 285],
];

const SATURATION_WHITE_THRESHOLD = 15; // % — below this, pick white
const WARM_HUE_WHITE_MIN = 15; // deg — warm/amber hues map to white, not red
const WARM_HUE_WHITE_MAX = 60; // deg — up to the red/green midpoint
const COLOR_DEBOUNCE_MS = 700; // coalesce color-wheel drags into one command
const SEND_TIMEOUT_MS = 15000; // upper bound on discovery+connect+login+command; node-screenlogic has no timeouts of its own
const DEFAULT_POLL_INTERVAL_S = 30; // how often to refresh on/off state from the controller

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
  // Warm white from Siri arrives as a saturated amber hue (~35 deg). Pentair has
  // no amber/yellow, so map the warm band to white instead of snapping to red.
  if (h >= WARM_HUE_WHITE_MIN && h <= WARM_HUE_WHITE_MAX) {
    return 'white';
  }
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
    // node-screenlogic circuit IDs are the protocol wire IDs (e.g. 503, 504)
    // — used as-is everywhere, for config and for auto-detection.
    // If light_circuits is set, those are used as-is. Otherwise the plugin
    // auto-detects light circuits from the controller at startup.
    this.configuredCircuits = [...(config.light_circuits || [])];
    this.lightCircuits = [...this.configuredCircuits];
    this.hasOnOff = false; // set true once light circuits are known
    this._detectPromise = null;
  }

  // Discovers light circuits from the controller's circuit definitions.
  // A circuit counts as a light if its interface is "lights" (3) or its
  // function is the light type (16) — the values this controller reports
  // for its 503/504 light circuits. (A name fallback is deliberately NOT
  // used: circuit 506 "Waterfall Light" is a separate feature, not a pool
  // light.) Manual light_circuits config always wins over detection.
  // node-screenlogic is event-based: getControllerConfig() answers with a
  // 'controllerConfig' event carrying bodyArray (circuitId, name, function,
  // interface). There are no *Async methods and no .equipment object.
  async detectLightCircuits() {
    if (this.configuredCircuits.length > 0) {
      this.lightCircuits = [...this.configuredCircuits];
      this.hasOnOff = true;
      return this.lightCircuits;
    }
    if (this._detectPromise) {
      return this._detectPromise;
    }
    this._detectPromise = this.withConnection(
      (connection) => this._requestControllerConfig(connection),
    ).then((cfg) => {
      const circuits = cfg.bodyArray || [];
      const lights = circuits.filter((c) => {
        // interface 3 = lights, function 16 = light type
        if (c.interface === 3) return true;
        if (c.function === 16) return true;
        return false;
      }).map((c) => c.circuitId);
      this.lightCircuits = lights;
      this.hasOnOff = lights.length > 0;
      return lights;
    }).catch((err) => {
      this._detectPromise = null;
      throw err;
    });
    return this._detectPromise;
  }

  // Asks the controller for its config and resolves with the decoded
  // 'controllerConfig' message. Mirrors homebridge-pentair-screenlogic:
  // getVersion first, then getControllerConfig on the 'version' event.
  _requestControllerConfig(connection) {
    return new Promise((resolve, reject) => {
      connection
        .once('version', () => connection.getControllerConfig())
        .once('controllerConfig', resolve)
        .once('error', reject);
      connection.getVersion();
    });
  }

  // Asks the controller for live status and resolves with the decoded
  // 'poolStatus' message (circuitArray of {id, state}).
  _requestPoolStatus(connection) {
    return new Promise((resolve, reject) => {
      connection
        .once('poolStatus', resolve)
        .once('error', reject);
      connection.getPoolStatus();
    });
  }

  // Sets one circuit's state and resolves when the controller confirms
  // with 'circuitStateChanged'. circuitId is the protocol wire ID (503).
  _setCircuitState(connection, circuitId, state) {
    return new Promise((resolve, reject) => {
      connection
        .once('circuitStateChanged', resolve)
        .once('badParameter', () => reject(new Error('bad parameter in setCircuitState')))
        .once('error', reject);
      connection.setCircuitState(0, circuitId, state);
    });
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

  // Returns true if any of the light circuits is currently on.
  async anyLightOn() {
    await this.detectLightCircuits();
    if (this.lightCircuits.length === 0) {
      return false;
    }
    const status = await this.withConnection(
      (connection) => this._requestPoolStatus(connection),
    );
    const onIds = new Set(
      (status.circuitArray || []).filter((c) => c.state === 1).map((c) => c.id),
    );
    return this.lightCircuits.some((id) => onIds.has(id));
  }

  // Switches all light circuits on or off.
  async setLights(on) {
    await this.detectLightCircuits();
    if (this.lightCircuits.length === 0) {
      throw new Error('no light circuits found on the controller');
    }
    return this.withConnection(async (connection) => {
      for (const id of this.lightCircuits) {
        await this._setCircuitState(connection, id, on ? 1 : 0);
      }
    });
  }
}

class PoolColorAccessory {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || 'Pool Light Color';
    this.controller = new PoolController(config);
    this.pollIntervalMs = (config.poll_interval || DEFAULT_POLL_INTERVAL_S) * 1000;

    this.currentHue = 0;
    this.currentSaturation = 100;
    // Last hue/sat actually sent to the controller. Used to skip redundant
    // sends — e.g. the Home app writing back values it just read, which
    // would otherwise re-send the default red after every restart.
    this.lastSentHue = 0;
    this.lastSentSaturation = 100;
    this.isOn = false;
    this.colorTimer = null;
    this.sending = false;    // a color command is currently in flight
    this.queuedColor = null; // latest color requested while a send is in flight
    this.polling = false;    // a state poll is currently in flight
    this.switching = false;  // an on/off command is currently in flight

    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Pentair')
      .setCharacteristic(Characteristic.Model, 'ScreenLogic Color Picker')
      .setCharacteristic(Characteristic.SerialNumber, 'poolcolor');

    this.lightService = new Service.Lightbulb(this.name);
    this.lightService.setCharacteristic(Characteristic.Name, this.name);

    this.lightService.getCharacteristic(Characteristic.On)
      .on('get', (cb) => cb(null, this.isOn))
      .on('set', (value, cb) => this.handleSetOn(value, cb));

    this.lightService.getCharacteristic(Characteristic.Hue)
      .on('get', (cb) => cb(null, this.currentHue))
      .on('set', (value, cb) => this.handleSetColor(value, null, cb));

    this.lightService.getCharacteristic(Characteristic.Saturation)
      .on('get', (cb) => cb(null, this.currentSaturation))
      .on('set', (value, cb) => this.handleSetColor(null, value, cb));

    // Detect light circuits from the controller, then start polling.
    // Manual light_circuits config skips detection.
    this.controller.detectLightCircuits().then((circuits) => {
      if (circuits.length > 0) {
        this.log.info(`"${this.name}" ready — light circuits detected: ${circuits.join(', ')}`);
      } else {
        this.log.warn(`"${this.name}" ready — no light circuits found on the controller; on/off will not work`);
      }
      this.refreshOnState();
    }).catch((err) => {
      this.log.warn(`"${this.name}" ready — light circuit detection failed: ${err.message}; on/off will not work`);
    });

    // Periodic refresh so the tile tracks changes made from the per-circuit
    // switches or the physical controller. Each poll awaits detection.
    this.pollTimer = setInterval(() => this.refreshOnState(), this.pollIntervalMs);
    // Don't keep the Homebridge process alive for the poll timer alone.
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  getServices() {
    return [this.informationService, this.lightService];
  }

  async refreshOnState() {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const on = await this.controller.anyLightOn();
      if (on !== this.isOn) {
        this.isOn = on;
        this.lightService.updateCharacteristic(Characteristic.On, on);
        this.log.info(`pool lights ${on ? 'on' : 'off'} (from controller)`);
      }
    } catch (err) {
      this.log.warn('failed to refresh light state:', err.message);
    } finally {
      this.polling = false;
    }
  }

  handleSetOn(value, callback) {
    const on = !!value;
    callback(null);
    if (on === this.isOn) {
      return;
    }
    this.setLights(on);
  }

  async setLights(on) {
    if (this.switching) {
      return;
    }
    this.switching = true;
    try {
      await this.controller.setLights(on);
      this.isOn = on;
      this.lightService.updateCharacteristic(Characteristic.On, on);
      this.log.info(`pool lights turned ${on ? 'on' : 'off'}`);
    } catch (err) {
      this.log.error('setLights failed:', err.message);
      // Revert the tile so it reflects reality, not the failed request.
      this.lightService.updateCharacteristic(Characteristic.On, this.isOn);
    } finally {
      this.switching = false;
    }
  }

  handleSetColor(hue, saturation, callback) {
    if (hue !== null) {
      this.currentHue = hue;
    }
    if (saturation !== null) {
      this.currentSaturation = saturation;
    }
    callback(null);
    // Skip if nothing actually changed since the last successful send.
    // The Home app sometimes writes back the values it just read (e.g. on
    // tile tap); without this, those write-backs would re-send the color —
    // and after a restart, that means spuriously sending red (the default).
    if (this.currentHue === this.lastSentHue &&
        this.currentSaturation === this.lastSentSaturation) {
      return;
    }
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
            // Record what actually went out, so write-backs of the same
            // values don't trigger a redundant send.
            this.lastSentHue = this.currentHue;
            this.lastSentSaturation = this.currentSaturation;
            // The controller powers the lights on when a color is sent.
            if (!this.isOn) {
              this.isOn = true;
              this.lightService.updateCharacteristic(Characteristic.On, true);
            }
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

// Exported for tests / live verification against a real controller.
module.exports.PoolController = PoolController;
module.exports.hueToColorName = hueToColorName;

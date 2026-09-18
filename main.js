'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const qs = require('qs');
const Json2iob = require('json2iob');

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
/** Locales of the My Renault app as listed in renault-api const.py; the first match per country wins. */
const LOCALES = [
  'bg-BG',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'de-AT',
  'de-CH',
  'en-GB',
  'en-IE',
  'es-ES',
  'es-MX',
  'fi-FI',
  'fr-FR',
  'fr-BE',
  'fr-CH',
  'fr-LU',
  'hr-HR',
  'hu-HU',
  'it-IT',
  'it-CH',
  'nl-NL',
  'nl-BE',
  'no-NO',
  'pl-PL',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'sk-SK',
  'sl-SI',
  'sv-SE',
];
const KAMEREON_KEY_URL = 'https://raw.githubusercontent.com/hacf-fr/renault-api/main/src/renault_api/const.py';
// Kamereon key of the My Renault app; renault-api and db-EV/ZoePHP update theirs by hand after Renault changes it.
const BUNDLED_KAMEREON_KEY = 'YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J';
const KAMEREON_KEY = /^[A-Za-z0-9]{20,64}$/;
const KAMEREON_KEY_LINE = /^KAMEREON_APIKEY = "([A-Za-z0-9]{20,64})"\r?$/m;
const QUOTA_PAUSE_MINUTES = [15, 30, 60];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Home Assistant limits its Renault integration to 60 requests per hour for the same reason.
const QUOTA_PER_HOUR = 60;
const DEFAULT_TEMPERATURE = 21;
/** The car needs some time to upload its new state after a change at the wallbox. */
const BATTERY_REFRESH_DELAY_MS = 60 * 1000;
const BATTERY_REFRESH_GAP_MS = 3 * 60 * 1000;

/** @typedef {{ path: string, url: string, desc: string, channel?: string, isHistory?: boolean, hourly?: boolean }} Endpoint */

/** Units of known vehicle data keys; json2iob matches them by the last id segment. */
const DATA_UNITS = {
  batteryLevel: '%',
  batteryAutonomy: 'km',
  batteryAvailableEnergy: 'kWh',
  batteryTemperature: '°C',
  chargingRemainingTime: 'min',
  totalMileage: 'km',
  fuelAutonomy: 'km',
  fuelQuantity: 'l',
  externalTemperature: '°C',
  internalTemperature: '°C',
  socThreshold: '%',
  chargeStartBatteryLevel: '%',
  chargeEndBatteryLevel: '%',
  chargeBatteryLevelRecovered: '%',
};

/** Roles of known vehicle data keys; everything else keeps the role json2iob derives from the type. */
const DATA_ROLES = {
  batteryLevel: 'value.battery',
  batteryAutonomy: 'value.distance',
  totalMileage: 'value.distance',
  fuelAutonomy: 'value.distance',
  fuelQuantity: 'value.fill',
  batteryTemperature: 'value.temperature',
  externalTemperature: 'value.temperature',
  internalTemperature: 'value.temperature',
};

const KCA = 'kca/car-adapter/v1/cars/';
const KCM = 'kcm/v1/vehicles/';

/**
 * Endpoints per model code from renault-api (tools/updateVehicleEndpoints.js). A table key maps to
 * the request variant the model needs, or to null when the model does not support it.
 *
 * @type {Record<string, { name: string, endpoints: Record<string, string | null> }>}
 */
const VEHICLE_ENDPOINTS = require('./lib/vehicleEndpoints.json').models;

/** @typedef {{ base: string, endpoint: string, body: { type: string, attributes: Record<string, unknown> } }} CommandRequest */
/**
 * @typedef {object} RemoteCommand
 * @property {string} name what the command controls, for the state names
 * @property {string} start table key of the start request
 * @property {string} stop table key of the stop request
 * @property {(mode: string, on: boolean) => CommandRequest | 'settings' | null} request null when the
 *   variant cannot send this value, 'settings' for the ev/settings start of schedule-based vehicles
 */

/**
 * Remote commands, each with a start and a stop button below <vin>.remote (commandStateId). A model
 * gets only the buttons it supports. Endpoints and bodies follow renault-api (renault_vehicle.py).
 *
 * @type {Record<string, RemoteCommand>}
 */
const REMOTE_COMMANDS = {
  climate: {
    name: 'climate control',
    start: 'actions/hvac-start',
    stop: 'actions/hvac-stop',
    request: (mode, on) => ({
      base: KCA,
      endpoint: 'actions/hvac-start',
      body: { type: 'HvacStart', attributes: { action: on ? 'start' : mode === 'kca-stop' ? 'stop' : 'cancel' } },
    }),
  },
  charging: {
    name: 'charging',
    start: 'actions/charge-start',
    stop: 'actions/charge-stop',
    request: (mode, on) => {
      if (mode === 'kcm-settings') {
        return on ? 'settings' : null;
      }
      if (mode === 'kcm') {
        return on ? { base: KCM, endpoint: 'charge/start', body: { type: 'ChargingStart', attributes: { action: 'start' } } } : null;
      }
      if (mode === 'kcm-pause-resume') {
        return {
          base: KCM,
          endpoint: 'charge/pause-resume',
          body: { type: 'ChargePauseResume', attributes: { action: on ? 'resume' : 'pause' } },
        };
      }
      return {
        base: KCA,
        endpoint: 'actions/charging-start',
        body: { type: 'ChargingStart', attributes: { action: on ? 'start' : 'stop' } },
      };
    },
  },
};

/**
 * @param {string} command key of REMOTE_COMMANDS
 * @param {boolean} on
 */
function commandStateId(command, on) {
  return command + (on ? 'Start' : 'Stop');
}

/** Remote state ids of earlier versions and the states that replace them, removed once per vehicle. */
const LEGACY_REMOTE_IDS = {
  'actions/hvac-start': 'climateStart and climateStop',
  'actions/charging-start': 'chargingStart and chargingStop',
  'charge/pause-resume': 'chargingStart and chargingStop',
  'charge/start': 'chargingStart',
  'hvac-start': 'climateStart and climateStop',
  'hvac-temperature': 'climateTemperature',
  charging: 'chargingStart and chargingStop',
  refresh: 'refreshAll',
  lastError: 'lastCommandError',
};

/**
 * An answer that carries only a message instead of vehicle data.
 *
 * @param {unknown} body
 */
function isPlaceholder(body) {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    typeof (/** @type {Record<string, unknown>} */ (body).message) === 'string'
  );
}

/**
 * No source (renault-api, Home Assistant, ZoePHP) documents a range; like Home Assistant, only a
 * positive number is required and the cloud rejects the rest.
 *
 * @param {unknown} value
 * @returns {value is number}
 */
function isValidTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

class Renault extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'renault',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.json2iob = new Json2iob(this);
    /** @type {Record<string, Record<string, number>>} vin -> endpoint path -> time it was rejected */
    this.ignoreState = {};
    /** @type {Record<string, Set<string>>} vin -> endpoint paths that answered 2xx in this run */
    this.answered = {};
    /**
     * vin -> endpoint path -> start of an unbroken series of server errors, and whether the endpoint
     * is asked only hourly because the series lasts 24 hours
     *
     * @type {Record<string, Record<string, { since: number, hourly: boolean }>>}
     */
    this.serverErrors = {};
    /** @type {Record<string, string | undefined>} vin -> model code, e.g. X102VE */
    this.modelCodes = {};
    // Without a timeout a request the cloud never answers stalls every later poll.
    this.requestClient = axios.create({ timeout: 30 * 1000 });
    this.userAgent = 'okhttp/5.3.0';
    /** @type {string} */
    this.brand = 'renault';
    /** @type {string[]} */
    this.accountTypes = [];
    /** @type {ioBroker.Interval | undefined | null} */
    this.refreshTokenInterval = null;
    /** @type {ioBroker.Interval | undefined | null} */
    this.vehicleListInterval = null;
    /** @type {ioBroker.Timeout | undefined | null} */
    this.pollTimeout = null;
    this.polling = false;
    this.startAttempt = 0;
    this.loginRejected = false;
    this.apiKeyUpdate = BUNDLED_KAMEREON_KEY;
    this.country = 'de';
    this.locale = 'de-DE';
    this.quotaStrikes = 0;
    this.quotaPausedUntil = 0;
    this.lastHourlyPoll = -Infinity;
    this.budgetChecked = false;
    /** @type {Record<string, 'cockpit' | 'cockpitv2'>} */
    this.cockpitChoice = {};
    /** @type {Record<string, ioBroker.Timeout | undefined>} vin -> pending battery refresh */
    this.batteryRefreshTimeouts = {};
    /** @type {Record<string, number>} vin -> time of the last battery refresh */
    this.lastBatteryRefresh = {};
  }

  /** APK rI2.smali (WiredHeaderAppVersionInterceptor): build={brand}-android-{version};trId={uuid} on wired Kamereon host */
  buildTraceId() {
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    const brand = this.brand;
    const version = brand === 'alpine' ? '6.10.1' : '6.11.2';
    return 'build=' + brand + '-android-' + version + ';trId=' + uuid;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    const interval = Number(this.config.interval);
    const bounded = Number.isFinite(interval)
      ? Math.min(Math.max(interval, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES)
      : MIN_INTERVAL_MINUTES;
    if (bounded !== interval) {
      this.log.info(
        'Update interval ' +
          this.config.interval +
          ' is outside ' +
          MIN_INTERVAL_MINUTES +
          ' to ' +
          MAX_INTERVAL_MINUTES +
          ' minutes, using ' +
          bounded,
      );
    }
    this.config.interval = bounded;
    /** @type {ioBroker.Timeout | undefined | null} */
    this.reLoginTimeout = null;
    const country = String(this.config.country ?? '')
      .trim()
      .toLowerCase();
    if (/^[a-z]{2}$/.test(country)) {
      this.country = country;
    } else {
      if (country) {
        this.log.warn('Country "' + this.config.country + '" is not a two-letter code, using de');
      }
      this.country = 'de';
    }
    this.locale = LOCALES.find((locale) => locale.endsWith('-' + this.country.toUpperCase())) || 'de-DE';
    this.brand = this.config.brand || 'renault';
    this.session = {};
    //DE API Key (shared by Renault, Dacia and Alpine - same Gigya/Kamereon tenant)
    this.apiKey = '3_VgdkgtIRH3AdHvJm-cjV2ug2EFE0lxt0IJzMC4MFqZjFpn_GYFXVdNZ19L7wZX0N';
    if (this.brand === 'alpine') {
      this.product = 'MYALPINE';
      this.accountTypes = ['MYALPINE'];
    } else {
      this.product = 'MYRENAULT';
      this.accountTypes = ['MYRENAULT', 'MYDACIA'];
    }
    this.apiKeyUpdate = await this.resolveKamereonKey();

    this.subscribeStates('*.remote.*');

    await this.connectAndPoll();
  }

  /**
   * The Kamereon key comes from the settings, else from renault-api (repairs the adapter without a
   * release after Renault changes the key), else from this file. The key itself is never logged.
   *
   * @returns {Promise<string>}
   */
  async resolveKamereonKey() {
    const configured = String(this.config.apiKeyUpdate ?? '').trim();
    if (KAMEREON_KEY.test(configured)) {
      this.log.debug('Kamereon API key: adapter settings');
      return configured;
    }
    if (configured) {
      this.log.warn('The API key in the adapter settings is not valid (20 to 64 letters and digits), it is ignored');
    }
    try {
      const res = await this.requestClient({ method: 'get', url: KAMEREON_KEY_URL, responseType: 'text' });
      const match = typeof res.data === 'string' ? KAMEREON_KEY_LINE.exec(res.data) : null;
      if (match) {
        this.log.debug('Kamereon API key: renault-api lookup');
        return match[1];
      }
      this.log.debug('Kamereon API key lookup found no valid key');
    } catch (error) {
      this.log.debug('Kamereon API key lookup failed: ' + error);
    }
    this.log.debug('Kamereon API key: bundled');
    return BUNDLED_KAMEREON_KEY;
  }

  /**
   * Log in, load the vehicles and start polling. A network or server failure is retried with
   * growing delay (5 min doubling up to 60 min). A login the account service rejected is not
   * retried, so wrong credentials cannot lock the account.
   */
  async connectAndPoll() {
    if ((await this.login()) && (await this.getDeviceList())) {
      this.startAttempt = 0;
      await this.migrateChargeHistoryV1();
      await this.loadCockpitChoice();
      await this.runPoll();
      this.refreshTokenInterval = this.setInterval(() => {
        this.refreshToken();
      }, 3500 * 1000);
      // getDeviceList() catches its own errors
      this.vehicleListInterval = this.setInterval(() => this.getDeviceList(), DAY_MS);
      return;
    }
    if (this.loginRejected) {
      this.log.error('Login rejected. Check email and password in the adapter settings, then restart the instance.');
      return;
    }
    const delayMinutes = Math.min(5 * 2 ** this.startAttempt, 60);
    this.startAttempt++;
    this.log.warn('Connection to the Renault cloud failed. Next attempt in ' + delayMinutes + ' minutes');
    this.reLoginTimeout = this.setTimeout(
      () => this.connectAndPoll().catch((error) => this.log.error('Connection attempt failed: ' + error)),
      delayMinutes * 60 * 1000,
    );
  }

  /**
   * Schedule the next poll first, then poll. A slow poll therefore never stops the schedule, and
   * pollNow() skips a poll that would overlap.
   */
  async runPoll() {
    const intervalMs = this.config.interval * 60 * 1000;
    this.schedulePoll(intervalMs);
    await this.pollNow();
    const pauseMs = this.quotaPausedUntil - Date.now();
    if (pauseMs > 0) {
      this.schedulePoll(Math.max(pauseMs, intervalMs));
    }
  }

  /**
   * Replace the pending poll timer.
   *
   * @param {number} delayMs
   */
  schedulePoll(delayMs) {
    this.pollTimeout && this.clearTimeout(this.pollTimeout);
    this.pollTimeout = this.setTimeout(() => this.runPoll().catch((error) => this.log.error('Poll failed: ' + error)), delayMs);
  }

  /**
   * Ask battery-status of one vehicle one minute after the last call, and at most every three
   * minutes. A script that follows the wallbox so costs one request instead of a full poll.
   *
   * @param {string} vin
   */
  scheduleBatteryRefresh(vin) {
    this.batteryRefreshTimeouts[vin] && this.clearTimeout(this.batteryRefreshTimeouts[vin]);
    const due = Math.max(Date.now() + BATTERY_REFRESH_DELAY_MS, (this.lastBatteryRefresh[vin] ?? -Infinity) + BATTERY_REFRESH_GAP_MS);
    this.batteryRefreshTimeouts[vin] = this.setTimeout(async () => {
      delete this.batteryRefreshTimeouts[vin];
      // a running poll asks battery-status anyway
      if (this.polling) {
        return;
      }
      this.lastBatteryRefresh[vin] = Date.now();
      this.polling = true;
      try {
        await this.updateDevices(false, { vin, path: 'battery-status' });
      } catch (error) {
        this.log.error('Battery refresh failed: ' + error);
      } finally {
        this.polling = false;
      }
    }, due - Date.now());
  }

  /** Run one poll cycle unless one is already running. */
  async pollNow() {
    if (this.polling) {
      this.log.debug('Poll skipped, the previous poll is still running');
      return;
    }
    this.polling = true;
    try {
      await this.updateDevices();
    } finally {
      this.polling = false;
    }
  }

  /**
   * Log in and look up the account. Sets info.connection accordingly.
   *
   * @returns {Promise<boolean>} true when session, id token and account are available
   */
  async login() {
    const ok = await this.loginSteps();
    this.setState('info.connection', ok, true);
    return ok;
  }

  async loginSteps() {
    this.session_data = await this.requestClient({
      method: 'post',
      url: 'https://accounts.eu1.gigya.com/accounts.login',
      headers: {
        'User-Agent': this.userAgent,
        Accept: '*/*',
        'Accept-Language': this.locale.toLowerCase(),
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        apikey: this.apiKey,
        format: 'json',
        httpStatusCodes: 'false',
        loginID: this.config.username,
        password: this.config.password,
      }),
    })
      .then((res) => {
        if (res.data.errorMessage) {
          this.loginRejected = true;
          this.log.error(JSON.stringify(res.data));
          return;
        }
        return res.data.sessionInfo;
      })
      .catch((error) => {
        this.log.error('Login failed: ' + error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!this.session_data) {
      this.log.error('No session found for this account. Please login in the app. Maybe a new password is needed.');
      return false;
    }
    this.session = {};
    await this.requestClient({
      method: 'post',
      url: 'https://accounts.eu1.gigya.com/accounts.getJWT',
      headers: {
        'User-Agent': this.userAgent,
        Accept: '*/*',
        'Accept-Language': this.locale.toLowerCase(),
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: qs.stringify({
        format: 'json',
        login_token: this.session_data.cookieValue,
        sdk: 'js_latest',
        fields: 'data.personId,data.gigyaDataCenter',
        apikey: this.apiKey,
        expiration: '3600',
      }),
    })
      .then((res) => {
        this.session = res.data;
      })
      .catch((error) => {
        this.log.error('Getting the id token failed: ' + error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!this.session.id_token) {
      return false;
    }
    return await this.requestClient({
      method: 'post',
      url:
        'https://apis.renault.com/myr/api/v1/connection?&country=' +
        this.country.toUpperCase() +
        '&product=' +
        this.product +
        '&locale=' +
        this.locale +
        '&displayAccounts=' +
        this.product,
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': this.userAgent,
        apiKey: this.apiKeyUpdate,
        'Accept-Language': this.locale.toLowerCase(),
        'x-gigya-id_token': this.session.id_token,
      },
    })
      .then((res) => {
        const accountTypes = this.accountTypes;
        const filteredAccounts = res.data.currentUser.accounts.filter(function (el) {
          return accountTypes.includes(el.accountType) && el.accountStatus === 'ACTIVE';
        });
        if (filteredAccounts.length === 0) {
          this.log.error('No Account found');
          this.log.error(
            'Accounts of this login: ' + JSON.stringify(res.data.currentUser.accounts.map((el) => el.accountType + ' ' + el.accountStatus)),
          );
          return false;
        }

        this.account = filteredAccounts[0];
        return true;
      })
      .catch((error) => {
        this.log.error('Error while getting account: ' + error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.data && JSON.stringify(error.response.data).indexOf('apikey') !== -1) {
            this.log.error('Wrong API Key. Please update API Key in adapter settings');
          }
        }
        return false;
      });
  }

  /**
   * Load the vehicles of the account and create their objects.
   *
   * @returns {Promise<boolean>} true when the vehicle list was loaded
   */
  async getDeviceList() {
    return await this.requestClient({
      method: 'get',
      url:
        'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
        this.account.accountId +
        '/vehicles?country=' +
        this.country +
        '&oms=false',
      headers: {
        apikey: this.apiKeyUpdate,
        'content-type': 'application/json',
        accept: '*/*',
        'user-agent': this.userAgent,
        'accept-language': this.locale.toLowerCase(),
        'x-gigya-id_token': this.session.id_token,
        'X-Amzn-Trace-Id': this.buildTraceId(),
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        const vins = [];
        for (const device of res.data.vehicleLinks) {
          vins.push(device.vin);
          if (this.deviceArray.length && !this.deviceArray.includes(device.vin)) {
            this.log.info('New vehicle ' + device.vin + ' found, polling it from now on');
          }
          let name = device.vehicleDetails?.modelSCR || device.brand;
          if (device.vehicleDetails?.model?.label) {
            name += device.vehicleDetails.model.label;
          }

          this.ignoreState[device.vin] ??= {};
          this.answered[device.vin] ??= new Set();
          const modelCode = device.vehicleDetails?.model?.code;
          this.modelCodes[device.vin] = modelCode;
          if (!this.deviceArray.includes(device.vin)) {
            const model = VEHICLE_ENDPOINTS[modelCode ?? ''];
            if (model) {
              this.log.debug('Vehicle ' + device.vin + ' is a ' + model.name + ' (' + modelCode + ')');
            } else {
              this.log.info(
                'Vehicle ' +
                  device.vin +
                  ' has the model code ' +
                  modelCode +
                  ', which renault-api does not document yet. All endpoints are tried',
              );
            }
          }
          await this.setObjectNotExistsAsync(device.vin, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(device.vin + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });

          const remoteObjects = [];
          /** @type {string[]} */
          const unsupported = [];
          for (const [key, command] of Object.entries(REMOTE_COMMANDS)) {
            for (const on of [true, false]) {
              const id = commandStateId(key, on);
              if (!this.commandRequest(device.vin, command, on)) {
                unsupported.push(id);
                continue;
              }
              remoteObjects.push({
                id,
                name: (on ? 'Start ' : 'Stop ') + command.name,
                type: 'boolean',
                role: on ? 'button.start' : 'button.stop',
                read: false,
              });
            }
          }
          const climate = !unsupported.includes('climateStart');
          if (climate) {
            remoteObjects.push({
              id: 'climateTemperature',
              name: 'Climate control target temperature',
              type: 'number',
              role: 'level.temperature',
              unit: '°C',
              def: DEFAULT_TEMPERATURE,
            });
          } else {
            unsupported.push('climateTemperature');
          }
          remoteObjects.push(
            { id: 'refreshAll', name: 'Refresh all vehicle data', type: 'boolean', role: 'button', read: false },
            {
              id: 'refreshBattery',
              name: 'Refresh only the battery status, one minute later',
              type: 'boolean',
              role: 'button',
              read: false,
            },
            {
              id: 'lastCommandError',
              name: 'Error of the last command, empty after a success',
              type: 'string',
              role: 'text',
              write: false,
            },
          );
          // read before the old state is removed, so the chosen temperature survives the rename
          const legacyTemperature = (await this.getStateAsync(device.vin + '.remote.hvac-temperature'))?.val;
          const removed = [
            ...Object.entries(LEGACY_REMOTE_IDS).map(([legacy, replacement]) => ({ id: legacy, note: 'use ' + replacement })),
            ...unsupported.map((id) => ({ id, note: 'the model does not support it' })),
          ];
          if (await this.getObjectAsync(device.vin + '.cockpitv2')) {
            await this.delObjectAsync(device.vin + '.cockpitv2', { recursive: true });
            this.log.info('Removed ' + device.vin + '.cockpitv2, the data of both cockpit versions is now in ' + device.vin + '.cockpit');
          }
          for (const { id, note } of removed) {
            const objectId = device.vin + '.remote.' + id;
            if (await this.getObjectAsync(objectId)) {
              await this.delObjectAsync(objectId);
              this.log.info('Removed ' + objectId + ', ' + note);
            }
          }
          for (const remote of remoteObjects) {
            // extendObject, so installations of older versions get the new roles too
            await this.extendObjectAsync(device.vin + '.remote.' + remote.id, {
              type: 'state',
              common: {
                name: remote.name,
                type: /** @type {ioBroker.CommonType} */ (remote.type),
                role: remote.role,
                read: remote.read ?? true,
                write: remote.write ?? true,
                ...(remote.unit ? { unit: remote.unit } : {}),
                ...(remote.def !== undefined ? { def: remote.def } : {}),
              },
              native: {},
            });
          }
          if (climate) {
            const temperatureId = device.vin + '.remote.climateTemperature';
            if ((await this.getStateAsync(temperatureId))?.val == null) {
              await this.setState(temperatureId, isValidTemperature(legacyTemperature) ? legacyTemperature : DEFAULT_TEMPERATURE, true);
            }
          }
          delete device.mileage;
          await this.json2iob.parse(device.vin + '.general', device, { channelName: 'Vehicle details', write: false });
        }
        this.deviceArray = vins;
        return true;
      })
      .catch((error) => {
        this.log.error('Error while getting vehicle list: ' + error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        return false;
      });
  }

  /**
   * One-shot migration: with v0.0.24 the charge-history and charges endpoints switched from
   * date-named channels (e.g. `20220802`, `2022-04-22T11:46:38Z`) to numeric forceIndex slots.
   * Without cleanup the old objects would linger forever next to the new ones. The marker state
   * `info.migrationV1` ensures this only runs once per instance.
   */
  async migrateChargeHistoryV1() {
    try {
      const marker = await this.getStateAsync('info.migrationV1');
      if (marker && marker.val === true) {
        return;
      }
      this.log.info('Running charge history migration V1: cleaning up legacy date-named channels');
      for (const vin of this.deviceArray) {
        for (const path of ['charge-history', 'charges']) {
          await this.delObjectAsync(vin + '.' + path, { recursive: true }).catch(() => {});
        }
      }
      await this.setState('info.migrationV1', { val: true, ack: true });
      this.log.info('Charge history migration V1 done');
    } catch (e) {
      this.log.warn('Charge history migration V1 failed: ' + e);
    }
  }

  /**
   * @param {boolean} [isRetry] true for the single repeat after a token refresh
   * @param {{ vin: string, path: string }} [only] ask just this endpoint of this vehicle
   */
  async updateDevices(isRetry = false, only) {
    if (!this.account?.accountId) {
      this.log.error('No accountId found');
      return;
    }
    const now = Date.now();
    if (now < this.quotaPausedUntil) {
      this.log.debug('Poll skipped during the request quota pause');
      return;
    }
    const hourlyDue = now - this.lastHourlyPoll >= HOUR_MS;
    const curDate = new Date().toISOString().split('T')[0];
    // Charge history: limit start date to ~1 year back (My Renault app paginates yearly).
    // Keeping the range bounded prevents the API from returning years of data on every poll.
    const historyStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    /** @type {Endpoint[]} */
    const statusArray = [
      {
        path: 'battery-status',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v2/cars/$vin/battery-status?country=' +
          this.country,
        desc: 'Battery status of the car',
      },
      {
        path: 'battery-inhibition-status',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/battery-inhibition-status?country=' +
          this.country,
        desc: 'Battery inhibition status of the car',
      },
      // Both cockpit versions write to <vin>.cockpit. v2 comes first; v1 is asked only when v2 is
      // not supported (isPolled), so the channel never mixes the answers of both.
      {
        path: 'cockpitv2',
        channel: 'cockpit',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v2/cars/$vin/cockpit?country=' +
          this.country,
        desc: 'Status of the car',
      },
      {
        path: 'cockpit',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/cockpit?country=' +
          this.country,
        desc: 'Status of the car',
      },
      {
        path: 'charge-mode',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charge-mode?country=' +
          this.country,
        desc: 'Charge mode of the car',
      },
      {
        path: 'hvac-status',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/hvac-status?country=' +
          this.country,
        desc: 'HVAC status of the car',
      },
      {
        path: 'hvac-settings',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/hvac-settings?country=' +
          this.country,
        desc: 'HVAC settings of the car',
      },
      {
        path: 'charging-settings',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charging-settings?country=' +
          this.country,
        desc: 'Charging settings of the car',
      },

      {
        path: 'lock-status',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/lock-status?country=' +
          this.country,
        desc: 'Lock status of the car',
      },
      {
        path: 'res-state',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/res-state?country=' +
          this.country,
        desc: 'Res status of the car',
      },
      {
        path: 'location',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/location?country=' +
          this.country,
        desc: 'Location of the car',
      },
    ];

    if (!this.config.disableChargeFetching) {
      statusArray.push({
        path: 'charge-history',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charge-history?type=day&start=' +
          historyStart +
          '&end=' +
          curDate +
          '&country=' +
          this.country,
        desc: 'Charging history of the car',
        isHistory: true,
        hourly: true,
      });
      statusArray.push({
        path: 'charges',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charges?start=' +
          historyStart +
          '&end=' +
          curDate +
          '&country=' +
          this.country,
        desc: 'Charges of the car',
        isHistory: true,
        hourly: true,
      });
    }

    const headers = {
      apikey: this.apiKeyUpdate,
      'content-type': 'application/json',
      accept: '*/*',
      'user-agent': this.userAgent,
      'accept-language': this.locale.toLowerCase(),
      'x-gigya-id_token': this.session.id_token,
    };
    for (const vin of only ? [only.vin] : this.deviceArray) {
      for (const element of statusArray) {
        if (only && element.path !== only.path) {
          continue;
        }
        if (!this.isPolled(vin, element, now, hourlyDue)) {
          continue;
        }
        const outcome = await this.pollEndpoint(vin, element, headers);
        if (outcome === 'quota') {
          this.pauseForQuota();
          return;
        }
        if (outcome === 'unauthorized') {
          if (isRetry) {
            this.log.warn('The Renault cloud still answers 401 after a token refresh. Next attempt at the next poll');
            return;
          }
          this.log.info('Token expired during the poll, refreshing it');
          if (await this.refreshToken()) {
            await this.updateDevices(true, only);
          }
          return;
        }
      }
    }
    this.quotaStrikes = 0;
    if (only) {
      return;
    }
    if (hourlyDue) {
      this.lastHourlyPoll = now;
    }
    await this.chooseCockpit();
    if (!this.budgetChecked) {
      this.budgetChecked = true;
      let pollRequests = 0;
      let hourlyRequests = 0;
      for (const vin of this.deviceArray) {
        for (const element of statusArray) {
          if (element.hourly) {
            hourlyRequests += this.isPolled(vin, element, now, true) ? 1 : 0;
          } else {
            pollRequests += this.isPolled(vin, element, now, false) ? 1 : 0;
          }
        }
      }
      this.checkRequestBudget(pollRequests, hourlyRequests);
    }
  }

  /** Read the cockpit version kept per vehicle; anything malformed counts as no choice. */
  async loadCockpitChoice() {
    this.cockpitChoice = {};
    const state = await this.getStateAsync('info.cockpitVersion');
    let stored;
    try {
      stored = JSON.parse(String(state?.val ?? '{}'));
    } catch {
      return;
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return;
    }
    for (const [vin, version] of Object.entries(stored)) {
      if (version === 'cockpit' || version === 'cockpitv2') {
        this.cockpitChoice[vin] = version;
      }
    }
  }

  /**
   * Once per vehicle, keep the cockpit version that answers. v2 wins; v1 is kept only after v2 was
   * rejected as unsupported, so a 401, 429 or 5xx decides nothing.
   */
  async chooseCockpit() {
    let changed = false;
    for (const vin of this.deviceArray) {
      const chosen = this.cockpitChoice[vin];
      if (chosen && this.ignoreState[vin]?.[chosen] !== undefined) {
        // An earlier version kept a cockpit that does not deliver data; choose again.
        delete this.cockpitChoice[vin];
        changed = true;
        this.log.info('Vehicle ' + vin + ' gets no data from ' + chosen + ', trying the other cockpit version again');
      } else if (chosen) {
        continue;
      }
      const answered = this.answered[vin] ?? new Set();
      /** @type {'cockpit' | 'cockpitv2' | undefined} */
      let keep;
      if (answered.has('cockpitv2')) {
        keep = 'cockpitv2';
      } else if (answered.has('cockpit') && this.ignoreState[vin]?.cockpitv2 !== undefined) {
        keep = 'cockpit';
      } else {
        continue;
      }
      this.cockpitChoice[vin] = keep;
      changed = true;
      this.log.info('Vehicle ' + vin + ' uses cockpit ' + (keep === 'cockpitv2' ? 'v2' : 'v1'));
    }
    if (changed) {
      await this.setState('info.cockpitVersion', JSON.stringify(this.cockpitChoice), true);
    }
  }

  /**
   * Whether a cycle at `now` requests this endpoint for this vehicle.
   *
   * @param {string} vin
   * @param {Endpoint} element
   * @param {number} now
   * @param {boolean} hourlyDue
   */
  isPolled(vin, element, now, hourlyDue) {
    if (element.hourly && !hourlyDue) {
      return false;
    }
    if (this.endpointMode(vin, element.path === 'cockpitv2' ? 'cockpit' : element.path) === null) {
      return false;
    }
    const since = this.ignoreState[vin]?.[element.path];
    if (since !== undefined && now - since < DAY_MS) {
      return false;
    }
    const failing = this.serverErrors[vin]?.[element.path];
    if (failing && !hourlyDue && now - failing.since >= DAY_MS) {
      return false;
    }
    const cockpit = this.cockpitChoice[vin];
    if (element.path === 'cockpitv2') {
      return cockpit !== 'cockpit';
    }
    if (element.path === 'cockpit') {
      return cockpit === 'cockpit' || this.ignoreState[vin]?.cockpitv2 !== undefined;
    }
    return true;
  }

  /**
   * Request variant renault-api lists for this vehicle: 'default' for models or table keys it does
   * not list, null when the model does not support the endpoint.
   *
   * @param {string} vin
   * @param {string} key table key, e.g. 'actions/charge-start' or 'lock-status'
   * @returns {string | null}
   */
  endpointMode(vin, key) {
    const endpoints = VEHICLE_ENDPOINTS[this.modelCodes[vin] ?? '']?.endpoints;
    return endpoints && Object.hasOwn(endpoints, key) ? endpoints[key] : 'default';
  }

  /**
   * Warn when the planned requests exceed Renault's quota of about 60 per hour.
   *
   * @param {number} pollRequests requests per poll
   * @param {number} hourlyRequests requests per hour that do not depend on the interval
   */
  checkRequestBudget(pollRequests, hourlyRequests) {
    const perHour = (pollRequests * 60) / this.config.interval + hourlyRequests;
    if (perHour <= QUOTA_PER_HOUR) {
      return;
    }
    const room = QUOTA_PER_HOUR - hourlyRequests;
    const advice =
      room > 0
        ? ' Set the update interval to at least ' + Math.ceil((pollRequests * 60) / room) + ' minutes.'
        : ' Disable charge fetching or use fewer vehicles.';
    this.log.warn(
      'The adapter sends about ' +
        Math.ceil(perHour) +
        ' requests per hour, Renault allows about ' +
        QUOTA_PER_HOUR +
        ' requests per hour.' +
        advice,
    );
  }

  /**
   * Fetch one endpoint for one vehicle and write the answer.
   *
   * @param {string} vin
   * @param {Endpoint} element
   * @param {Record<string, string>} headers
   * @returns {Promise<'ok' | 'quota' | 'unauthorized' | 'failed'>}
   */
  async pollEndpoint(vin, element, headers) {
    let res;
    try {
      res = await this.requestClient({
        method: 'get',
        url: element.url.replace('$vin', vin),
        headers: { ...headers, 'X-Amzn-Trace-Id': this.buildTraceId() },
      });
    } catch (error) {
      return this.handlePollError(vin, element, error);
    }
    if (this.serverErrors[vin]?.[element.path]) {
      delete this.serverErrors[vin][element.path];
      this.log.info(element.path + ' of ' + vin + ' answers again');
    }
    if (isPlaceholder(res.data)) {
      // The gateway answers 200 with only a message for endpoints the car does not have
      // (cockpit v2 on the Zoe phase 2: "you should not be there but well done for the effort").
      this.log.debug(element.path + ' for ' + vin + ' answered without data: ' + JSON.stringify(res.data));
      this.rejectEndpoint(vin, element);
      return 'failed';
    }
    (this.answered[vin] ??= new Set()).add(element.path);
    if (this.ignoreState[vin]?.[element.path] !== undefined) {
      delete this.ignoreState[vin][element.path];
      this.log.info(element.path + ' answers again for ' + vin + ', polling it again');
    }
    this.log.debug(JSON.stringify(res.data));
    if (!res.data) {
      return 'ok';
    }
    let data = res.data;
    if (res.data.data && res.data.data.attributes) {
      data = res.data.data.attributes;
    }
    /** @type {boolean | undefined} */
    let forceIndex = undefined;
    // Charge history endpoints return arrays keyed by date. Without forceIndex json2iob creates a
    // channel per date and never removes it. Cap to the configured limit and use numeric indices,
    // so old entries are overwritten. migrateChargeHistoryV1() removed the date-named channels.
    if (element.isHistory) {
      forceIndex = true;
      const arrayKey = element.path === 'charge-history' ? 'chargeSummaries' : 'charges';
      const limit = Number(this.config.chargeHistoryLimit);
      const cap = Number.isFinite(limit) && limit > 0 ? limit : 0;
      if (cap > 0 && data && Array.isArray(data[arrayKey]) && data[arrayKey].length > cap) {
        data = { ...data, [arrayKey]: data[arrayKey].slice(-cap) };
      }
    }
    await this.json2iob.parse(vin + '.' + (element.channel ?? element.path), data, {
      forceIndex,
      channelName: element.desc,
      units: DATA_UNITS,
      roles: DATA_ROLES,
      write: false,
    });
    return 'ok';
  }

  /**
   * @param {string} vin
   * @param {Endpoint} element
   * @param {any} error
   * @returns {'quota' | 'unauthorized' | 'failed'}
   */
  handlePollError(vin, element, error) {
    const status = error.response?.status;
    if (status === 429 || JSON.stringify(error.response?.data ?? '').includes('err.func.wired.overloaded')) {
      return 'quota';
    }
    if (status === 401) {
      this.log.debug(element.path + ' for ' + vin + ' answered 401');
      return 'unauthorized';
    }
    if (status === 400 || status === 403 || status === 404) {
      this.log.debug(String(error));
      this.log.debug(JSON.stringify(error.response.data));
      this.rejectEndpoint(vin, element);
      return 'failed';
    }
    if (status >= 500) {
      const message = 'Renault server error ' + status + ' for ' + element.path + ' of ' + vin;
      const failing = (this.serverErrors[vin] ??= {});
      const series = failing[element.path];
      if (!series) {
        failing[element.path] = { since: Date.now(), hourly: false };
        this.log.warn(message + '. Repeats are logged at debug level until the endpoint answers again');
        return 'failed';
      }
      this.log.debug(message);
      if (!series.hourly && Date.now() - series.since >= DAY_MS) {
        series.hourly = true;
        this.log.info(element.path + ' of ' + vin + ' is asked hourly from now on, it has answered with server errors for 24 hours');
      }
      return 'failed';
    }
    this.log.error('Fetching ' + element.path + ' for ' + vin + ' failed: ' + error);
    error.response && this.log.error(JSON.stringify(error.response.data));
    return 'failed';
  }

  /**
   * The car does not offer this endpoint: skip it for 24 hours, unless it answered in this run.
   *
   * @param {string} vin
   * @param {Endpoint} element
   */
  rejectEndpoint(vin, element) {
    if (this.answered[vin]?.has(element.path)) {
      return;
    }
    const ignore = (this.ignoreState[vin] ??= {});
    if (ignore[element.path] === undefined) {
      this.log.info('Feature not found for ' + vin + '. Ignore ' + element.path + ' for 24 hours.');
    }
    ignore[element.path] = Date.now();
  }

  /** Stop polling for a while after Renault answered with its quota error; each pause in a row is longer. */
  pauseForQuota() {
    const minutes = QUOTA_PAUSE_MINUTES[Math.min(this.quotaStrikes, QUOTA_PAUSE_MINUTES.length - 1)];
    this.quotaStrikes++;
    this.quotaPausedUntil = Date.now() + minutes * 60 * 1000;
    this.log.warn(
      'Renault request quota used up (429 err.func.wired.overloaded). Polling pauses for ' +
        minutes +
        ' minutes. Raise the update interval if this repeats.',
    );
  }
  /**
   * Get a new id token with the login session.
   *
   * @returns {Promise<boolean>} true when a new id token was obtained
   */
  async refreshToken() {
    if (!this.session_data) {
      this.log.warn('No login session, logging in again');
      this.reconnect(0);
      return false;
    }
    try {
      const res = await this.requestClient({
        method: 'post',
        url: 'https://accounts.eu1.gigya.com/accounts.getJWT',
        headers: {
          'User-Agent': this.userAgent,
          Accept: '*/*',
          'Accept-Language': this.locale.toLowerCase(),
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: qs.stringify({
          format: 'json',
          login_token: this.session_data.cookieValue,
          sdk: 'js_latest',
          fields: 'data.personId,data.gigyaDataCenter',
          apikey: this.apiKey,
          expiration: '3600',
        }),
      });
      // Gigya answers 200 with an errorCode body when the session is no longer valid.
      if (!res.data?.id_token) {
        throw new Error('no id token in the answer' + (res.data?.errorCode ? ' (error ' + res.data.errorCode + ')' : ''));
      }
      this.session = res.data;
      this.setState('info.connection', true, true);
      return true;
    } catch (error) {
      this.setState('info.connection', false, true);
      this.log.error('Token refresh failed: ' + error + '. Logging in again in 1 minute');
      error.response && this.log.error(JSON.stringify(error.response.data));
      this.reconnect(60 * 1000);
      return false;
    }
  }

  /**
   * Stop polling and token refresh, then log in again after delayMs. connectAndPoll() restarts both
   * and owns the backoff, and it stops for good after a rejected login.
   *
   * @param {number} delayMs
   */
  reconnect(delayMs) {
    this.pollTimeout && this.clearTimeout(this.pollTimeout);
    this.pollTimeout = null;
    this.refreshTokenInterval && this.clearInterval(this.refreshTokenInterval);
    this.refreshTokenInterval = null;
    this.vehicleListInterval && this.clearInterval(this.vehicleListInterval);
    this.vehicleListInterval = null;
    this.reLoginTimeout && this.clearTimeout(this.reLoginTimeout);
    this.reLoginTimeout = this.setTimeout(
      () => this.connectAndPoll().catch((error) => this.log.error('Connection attempt failed: ' + error)),
      delayMs,
    );
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.pollTimeout && this.clearTimeout(this.pollTimeout);
      this.reLoginTimeout && this.clearTimeout(this.reLoginTimeout);
      Object.values(this.batteryRefreshTimeouts).forEach((timer) => timer && this.clearTimeout(timer));
      this.refreshTokenInterval && this.clearInterval(this.refreshTokenInterval);
      this.vehicleListInterval && this.clearInterval(this.vehicleListInterval);
      callback();
    } catch (e) {
      this.log.error('Error onUnload: ' + e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   *
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const [, , vin, channel, path] = id.split('.');
    if (channel !== 'remote' || !this.deviceArray.includes(vin)) {
      return;
    }
    if (path === 'climateTemperature') {
      if (isValidTemperature(state.val)) {
        await this.setState(id, state.val, true);
      } else {
        this.log.warn('climateTemperature must be a number above 0, got ' + JSON.stringify(state.val) + '. Value ignored');
      }
      return;
    }
    if (!this.account) {
      this.log.error('No account found');
      return;
    }
    if (path === 'refreshBattery') {
      if (state.val === true) {
        this.log.debug('Battery refresh of ' + vin + ' requested');
        this.scheduleBatteryRefresh(vin);
      }
      await this.setState(id, false, true);
      return;
    }
    if (path === 'refreshAll') {
      this.log.info('Force refresh');
      try {
        await this.pollNow();
      } catch (error) {
        this.log.error('Refresh failed: ' + error);
      } finally {
        // a button is confirmed by resetting it
        await this.setState(id, false, true);
      }
      return;
    }
    const [, key, action] = /^(.+)(Start|Stop)$/.exec(path) ?? [];
    if (!key || !Object.hasOwn(REMOTE_COMMANDS, key)) {
      this.log.debug('No command behind ' + path + ', nothing sent');
      return;
    }
    try {
      if (state.val === true) {
        await this.runCommand(vin, path, REMOTE_COMMANDS[key], action === 'Start');
      } else if (state.val !== false) {
        await this.reportCommandError(vin, path + ' is a button and takes true, got ' + JSON.stringify(state.val) + '. Nothing sent');
      }
    } finally {
      // a button is confirmed by resetting it; the outcome is in lastCommandError
      await this.setState(id, false, true);
    }
  }

  /**
   * The request that starts or stops a command on this vehicle, null when the model does not
   * support it. A model that cannot start a command cannot stop it either.
   *
   * @param {string} vin
   * @param {RemoteCommand} command
   * @param {boolean} on
   */
  commandRequest(vin, command, on) {
    const startMode = this.endpointMode(vin, command.start);
    const mode = on || startMode === null ? startMode : this.endpointMode(vin, command.stop);
    return mode === null ? null : command.request(mode, on);
  }

  /**
   * @param {string} vin
   * @param {string} path state id below remote, used as command name
   * @param {RemoteCommand} command
   * @param {boolean} on
   */
  async runCommand(vin, path, command, on) {
    const request = this.commandRequest(vin, command, on);
    if (!request) {
      await this.reportCommandError(vin, path + ' is not supported on this model. Nothing sent');
      return;
    }
    if (request === 'settings') {
      await this.startChargingViaSettings(vin, path);
      return;
    }
    const body = request.body;
    if (command === REMOTE_COMMANDS.climate && on) {
      const temperature = (await this.getStateAsync(vin + '.remote.climateTemperature'))?.val ?? DEFAULT_TEMPERATURE;
      if (!isValidTemperature(temperature)) {
        await this.reportCommandError(
          vin,
          'climateTemperature must be a number above 0, got ' + JSON.stringify(temperature) + '. Nothing sent',
        );
        return;
      }
      body.attributes = { ...body.attributes, targetTemperature: temperature };
    }
    await this.sendCommand(vin, path, this.kamereonUrl(request.base, vin, request.endpoint), { data: body });
  }

  /**
   * Vehicles that charge by schedule start charging when every program is switched off
   * (renault-api, same as the My Renault app). Only the app switches them on again.
   *
   * @param {string} vin
   * @param {string} name command name for log and lastCommandError
   */
  async startChargingViaSettings(vin, name) {
    const url = this.kamereonUrl(KCM, vin, 'ev/settings');
    let settings;
    try {
      settings = (await this.requestClient({ method: 'get', url, headers: this.commandHeaders() })).data;
    } catch (error) {
      await this.reportCommandError(vin, name + ' failed, reading the charge settings failed: ' + error.message);
      return;
    }
    if (!settings || typeof settings !== 'object' || !Array.isArray(settings.programs)) {
      await this.reportCommandError(vin, name + ' failed, the charge settings have no program list. Nothing sent');
      return;
    }
    const body = { ...settings, programs: settings.programs.map((program) => ({ ...program, programActivationStatus: false })) };
    await this.sendCommand(vin, name, url, body);
  }

  /**
   * @param {string} base KCA or KCM
   * @param {string} vin
   * @param {string} endpoint
   */
  kamereonUrl(base, vin, endpoint) {
    return (
      'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
      this.account.accountId +
      '/kamereon/' +
      base +
      vin +
      '/' +
      endpoint +
      '?country=' +
      this.country
    );
  }

  /** @returns {Record<string, string>} */
  commandHeaders() {
    return {
      apikey: this.apiKeyUpdate,
      'content-type': 'application/vnd.api+json',
      accept: '*/*',
      'user-agent': this.userAgent,
      'accept-language': this.locale.toLowerCase(),
      'x-gigya-id_token': this.session.id_token,
      'X-Amzn-Trace-Id': this.buildTraceId(),
    };
  }

  /**
   * POST a command and record the outcome in remote.lastCommandError.
   * Polls 20 seconds later, so the result shows up in the data states.
   *
   * @param {string} vin
   * @param {string} name command name for log and lastCommandError
   * @param {string} url
   * @param {unknown} data request body
   * @returns {Promise<boolean>} true when the cloud accepted the command
   */
  async sendCommand(vin, name, url, data) {
    this.log.debug(name + ' for ' + vin + ': ' + JSON.stringify(data));
    let accepted = false;
    try {
      const res = await this.requestClient({ method: 'post', url, headers: this.commandHeaders(), data });
      this.log.info('Command ' + name + ' for ' + vin + ' accepted');
      this.log.debug(JSON.stringify(res.data));
      await this.setState(vin + '.remote.lastCommandError', '', true);
      accepted = true;
    } catch (error) {
      const code = error.response?.data?.errors?.[0]?.errorCode;
      const message = 'Command ' + name + ' failed: ' + error.message + (code ? ' (' + code + ')' : '');
      this.log.error(message + ' for ' + vin);
      error.response && this.log.debug(JSON.stringify(error.response.data));
      await this.setState(vin + '.remote.lastCommandError', message, true);
    }
    this.schedulePoll(20 * 1000);
    return accepted;
  }

  /**
   * @param {string} vin
   * @param {string} message
   */
  async reportCommandError(vin, message) {
    this.log.warn(message + ' (' + vin + ')');
    await this.setState(vin + '.remote.lastCommandError', message, true);
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Renault(options);
} else {
  // otherwise start the instance directly
  new Renault();
}

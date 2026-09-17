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
    this.ignoreState = {};
    this.firstUpdate = true;
    // Without a timeout a request the cloud never answers stalls every later poll.
    this.requestClient = axios.create({ timeout: 30 * 1000 });
    this.userAgent = 'okhttp/5.3.0';
    /** @type {string} */
    this.brand = 'renault';
    /** @type {string[]} */
    this.accountTypes = [];
    /** @type {ioBroker.Interval | undefined | null} */
    this.refreshTokenInterval = null;
    /** @type {ioBroker.Timeout | undefined | null} */
    this.pollTimeout = null;
    this.polling = false;
    this.startAttempt = 0;
    this.loginRejected = false;
    this.apiKeyUpdate = BUNDLED_KAMEREON_KEY;
    this.country = 'de';
    this.locale = 'de-DE';
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
    /** @type {ioBroker.Timeout | undefined | null} */
    this.refreshTokenTimeout = null;
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
      await this.migrateChargeHistoryV1();
      await this.runPoll();
      this.refreshTokenInterval = this.setInterval(() => {
        this.refreshToken();
      }, 3500 * 1000);
      return;
    }
    if (this.loginRejected) {
      this.log.error('Login rejected. Check email and password in the adapter settings, then restart the instance.');
      return;
    }
    const delayMinutes = Math.min(5 * 2 ** this.startAttempt, 60);
    this.startAttempt++;
    this.log.warn('Connection to the Renault cloud failed. Next attempt in ' + delayMinutes + ' minutes');
    this.setTimeout(
      () => this.connectAndPoll().catch((error) => this.log.error('Connection attempt failed: ' + error)),
      delayMinutes * 60 * 1000,
    );
  }

  /**
   * Schedule the next poll first, then poll. A slow poll therefore never stops the schedule, and
   * pollNow() skips a poll that would overlap.
   */
  async runPoll() {
    this.schedulePoll(this.config.interval * 60 * 1000);
    await this.pollNow();
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

        this.deviceArray = [];
        for (const device of res.data.vehicleLinks) {
          this.deviceArray.push(device.vin);
          let name = device.vehicleDetails?.modelSCR || device.brand;
          if (device.vehicleDetails?.model?.label) {
            name += device.vehicleDetails.model.label;
          }

          this.ignoreState[device.vin] = [];
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
          await this.setObjectNotExistsAsync(device.vin + '.general', {
            type: 'channel',
            common: {
              name: 'WIRD NICHT AKTUALISIERT',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'actions/hvac-start', name: 'True = Start, False = Stop' },
            {
              command: 'hvac-temperature',
              name: 'HVAC Temperature',
              type: /** @type {ioBroker.CommonType} */ ('number'),
              role: 'value',
            },
            { command: 'actions/charging-start', name: 'True = Start, False = Stop' },
            { command: 'charge/pause-resume', name: 'True = Start, False = Stop' },
            { command: 'charge/start', name: 'True = Start, False = Stop' },
            { command: 'refresh', name: 'True = Refresh Data' },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(device.vin + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: /** @type {ioBroker.CommonType} */ (remote.type || 'boolean'),
                role: remote.role || 'button',
                write: true,
                read: true,
              },
              native: {},
            });
          });
          delete device.mileage;
          this.json2iob.parse(device.vin + '.general', device);
        }
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

  async updateDevices() {
    if (!this.account?.accountId) {
      this.log.error('No accountId found');
      return;
    }
    const curDate = new Date().toISOString().split('T')[0];
    // Charge history: limit start date to ~1 year back (My Renault app paginates yearly).
    // Keeping the range bounded prevents the API from returning years of data on every poll.
    const historyStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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
        path: 'cockpitv2',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v2/cars/$vin/cockpit?country=' +
          this.country,
        desc: 'Statusv2 of the car',
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
    for (const vin of this.deviceArray) {
      for (const element of statusArray) {
        if (this.ignoreState[vin] && this.ignoreState[vin].includes(element.path)) {
          continue;
        }
        const url = element.url.replace('$vin', vin);

        await this.requestClient({
          method: 'get',
          url: url,
          headers: { ...headers, 'X-Amzn-Trace-Id': this.buildTraceId() },
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            if (res.data.data && res.data.data.attributes) {
              data = res.data.data.attributes;
            }

            /** @type {boolean | undefined} */
            let forceIndex = undefined;
            const preferedArrayName = undefined;

            // Charge history endpoints return arrays keyed by date — without forceIndex
            // json2iob creates a new channel per date and never cleans them up. Cap to the
            // configured limit (default 100, matches the My Renault app pagination) and use
            // numeric indices so old entries are overwritten on each poll. The one-shot
            // migrateChargeHistoryV1() removes the legacy date-named channels on first start.
            if (element.isHistory) {
              forceIndex = true;
              const arrayKey = element.path === 'charge-history' ? 'chargeSummaries' : 'charges';
              const limit = Number(this.config.chargeHistoryLimit);
              const cap = Number.isFinite(limit) && limit > 0 ? limit : 0;
              if (cap > 0 && data && Array.isArray(data[arrayKey]) && data[arrayKey].length > cap) {
                data = { ...data, [arrayKey]: data[arrayKey].slice(-cap) };
              }
            }

            this.json2iob.parse(vin + '.' + element.path, data, {
              forceIndex: forceIndex,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 60 seconds');
                this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = this.setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
              if (this.firstUpdate) {
                if (error.response.status === 400 || error.response.status === 403 || error.response.status === 404) {
                  if (!this.ignoreState[vin]) {
                    this.ignoreState[vin] = [];
                  }
                  this.ignoreState[vin].push(element.path);
                  this.log.info('Feature not found for ' + vin + '. Ignore ' + element.path + ' for updates.');
                  this.log.debug(String(error));
                  error.response && this.log.debug(JSON.stringify(error.response.data));
                  return;
                }
              }
            }
            if (error.response && error.response.status >= 500) {
              this.log.warn(`Renault Server error: ${error.response.status} `);
              return;
            }
            this.log.error(url);
            this.log.error(String(error));
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
    this.firstUpdate = false;
  }
  async refreshToken() {
    if (!this.session_data) {
      this.log.error('No session found relogin');
      await this.login();
      return;
    }
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
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.setState('info.connection', false, true);
        this.log.error('refresh token failed: ' + error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error('Start relogin in 1min');
        this.reLoginTimeout = this.setTimeout(
          () => {
            this.login();
          },
          1000 * 60 * 1,
        );
      });
  }
  toCamelCase(string) {
    if (!string) {
      return;
    }
    string = string.replace('actions/', '');
    string = string.replace('/', '-');
    const camelC = string.replace(/-([a-z])/g, function (g) {
      return g[1].toUpperCase();
    });
    return camelC.charAt(0).toUpperCase() + camelC.slice(1);
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
      this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
      this.refreshTokenInterval && this.clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      this.log.error('Error onUnload: ' + e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split('.')[2];
        const path = id.split('.')[4];
        if (path === 'hvac-temperature') {
          return;
        }
        if (!this.account) {
          this.log.error('No account found');
          return;
        }
        if (path === 'refresh') {
          this.log.info('Force refresh');
          await this.pollNow();
          return;
        }
        const command = path.split('/')[1];
        let action = state.val ? 'start' : 'cancel';
        let midPart = 'kca/car-adapter/v1/cars/';
        if (path === 'charge/pause-resume') {
          action = state.val ? 'resume' : 'pause';
          midPart = 'kcm/v1/vehicles/';
        }
        const data = { data: { type: this.toCamelCase(path), attributes: { action: action } } };
        if (command === 'hvac-start') {
          const temperatureState = await this.getStateAsync(deviceId + '.remote.hvac-temperature');
          if (temperatureState) {
            data.data.attributes.targetTemperature = temperatureState.val ? temperatureState.val : 21;
          } else {
            data.data.attributes.targetTemperature = 21;
          }
        }
        const url =
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/' +
          midPart +
          deviceId +
          '/' +
          path +
          '?country=' +
          this.country;
        this.log.debug(JSON.stringify(data));
        this.log.debug(url);
        await this.requestClient({
          method: 'post',
          url: url,
          headers: {
            apikey: this.apiKeyUpdate,
            'content-type': 'application/vnd.api+json',
            accept: '*/*',
            'user-agent': this.userAgent,
            'accept-language': this.locale.toLowerCase(),
            'x-gigya-id_token': this.session.id_token,
            'X-Amzn-Trace-Id': this.buildTraceId(),
          },
          data: data,
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error('Command ' + path + ' failed: ' + error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        this.schedulePoll(20 * 1000);
      }
    }
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

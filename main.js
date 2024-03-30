'use strict';

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const qs = require('qs');
const Json2iob = require('json2iob');

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
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.country = this.config.country || 'de';
    this.session = {};
    //DE API Key
    this.apiKey = '3_7PLksOyBRkHv126x5WhHb-5pqC1qFR8pQjxSeLB6nhAnPERTUlwnYoznHSxwX668';
    this.apiKeyUpdate = 'YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J';
    try {
      await this.requestClient({
        method: 'get',
        url: 'https://raw.githubusercontent.com/hacf-fr/renault-api/main/src/renault_api/const.py',
      })

        .then((res) => {
          this.log.debug(JSON.stringify(res.data));

          if (res.data.split('KAMEREON_APIKEY = "')[2] && res.data.split('KAMEREON_APIKEY = "')[2].split('"')[0]) {
            this.apiKeyUpdate = res.data.split('KAMEREON_APIKEY = "')[2].split('"')[0];
          }
        })
        .catch((error) => {
          this.log.debug(error);
        });
    } catch (error) {
      this.log.debug(error);
    }
    if (this.config.apiKeyUpdate) {
      this.apiKeyUpdate = this.config.apiKeyUpdate;
    }

    this.subscribeStates('*');

    await this.login();

    if (this.session.id_token && this.session_data && this.account) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, 3500 * 1000);
    }
  }
  async login() {
    this.session_data = await this.requestClient({
      method: 'post',
      url: 'https://accounts.eu1.gigya.com/accounts.login',
      headers: {
        'User-Agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
        Accept: '*/*',
        'Accept-Language': 'de-de',
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
        this.log.debug(JSON.stringify(res.data));
        if (res.data.errorMessage) {
          this.log.error(JSON.stringify(res.data));
          return;
        }
        return res.data.sessionInfo;
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    if (!this.session_data) {
      this.log.error('No session found for this account');
      return;
    }
    await this.requestClient({
      method: 'post',
      url: 'https://accounts.eu1.gigya.com/accounts.getJWT',
      headers: {
        'User-Agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
        Accept: '*/*',
        'Accept-Language': 'de-de',
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
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
        }
      });
    await this.requestClient({
      method: 'post',
      url: 'https://apis.renault.com/myr/api/v1/connection?&country=DE&product=MYRENAULT&locale=de-DE&displayAccounts=MYRENAULT',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
        apiKey: this.apiKeyUpdate,
        'Accept-Language': 'de-de',
        'x-gigya-id_token': this.session.id_token,
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));

        const filteredAccounts = res.data.currentUser.accounts.filter(function (el) {
          return (el.accountType === 'MYRENAULT' || el.accountType === 'MYDACIA') && el.accountStatus === 'ACTIVE';
        });
        if (filteredAccounts.length === 0) {
          this.log.error('No Account found');
          this.log.error('All accounts: ' + res.data.currentUser.accounts);
          this.log.error('Filtered accounts: ' + filteredAccounts);
          return;
        }

        this.account = filteredAccounts[0];
      })
      .catch((error) => {
        this.log.error('Error while getting account');
        this.log.error(error);
        if (error.response) {
          this.log.error(JSON.stringify(error.response.data));
          if (error.response.data && JSON.stringify(error.response.data).indexOf('apikey') !== -1) {
            this.log.error('Wrong API Key. Please update API Key in adapter settings');
          }
        }
      });
  }
  async getDeviceList() {
    await this.requestClient({
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
        'user-agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
        'accept-language': 'de-de',
        'x-gigya-id_token': this.session.id_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        for (const device of res.data.vehicleLinks) {
          this.deviceArray.push(device.vin);
          let name = device.vehicleDetails?.modelSCR || device.brand;
          if (device.vehicleDetails.model && device.vehicleDetails.model.label) {
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
            { command: 'hvac-temperature', name: 'HVAC Temperature', type: 'number', role: 'value' },
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
                type: remote.type || 'boolean',
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
      })
      .catch((error) => {
        this.log.error('Error while getting vehicle list');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    if (!this.account.accountId) {
      this.log.error('No accountId found');
      return;
    }
    const curDate = new Date().toISOString().split('T')[0];

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
        path: 'charge-history',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charge-history?type=day&start=1970-01-01&end=' +
          curDate +
          '&country=' +
          this.country,
        desc: 'Charging history of the car',
      },
      {
        path: 'charges',
        url:
          'https://api-wired-prod-1-euw1.wrd-aws.com/commerce/v1/accounts/' +
          this.account.accountId +
          '/kamereon/kca/car-adapter/v1/cars/$vin/charges?start=1970-01-01&end=' +
          curDate +
          '&country=' +
          this.country,
        desc: 'Charges of the car',
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

    const headers = {
      apikey: this.apiKeyUpdate,
      'content-type': 'application/json',
      accept: '*/*',
      'user-agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
      'accept-language': 'de-de',
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
          headers: headers,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            let data = res.data;
            if (res.data.data && res.data.data.attributes) {
              data = res.data.data.attributes;
            }

            const forceIndex = null;
            const preferedArrayName = null;

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
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
              if (this.firstUpdate) {
                if (
                  error.response.status === 403 ||
                  error.response.status === 404 ||
                  error.response.status === 500 ||
                  error.response.status === 501 ||
                  error.response.status === 502 ||
                  error.response.status === 400
                ) {
                  if (!this.ignoreState[vin]) {
                    this.ignoreState[vin] = [];
                  }
                  this.ignoreState[vin].push(element.path);
                  this.log.info('Feature not found for ' + vin + '. Ignore ' + element.path + ' for updates.');
                  this.log.debug(error);
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
            this.log.error(error);
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
        'User-Agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
        Accept: '*/*',
        'Accept-Language': 'de-de',
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
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error('refresh token failed');
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.log.error('Start relogin in 1min');
        this.reLoginTimeout = setTimeout(() => {
          this.login();
        }, 1000 * 60 * 1);
      });
  }
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
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
        if (path === 'refresh') {
          this.log.info('Force refresh');
          this.updateDevices();
          return;
        }
        if (!this.account) {
          this.log.error('No account found');
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
            'user-agent': 'MYRenault/39 CFNetwork/1312 Darwin/21.0.0',
            'accept-language': 'de-de',
            'x-gigya-id_token': this.session.id_token,
          },
          data: data,
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
            return res.data;
          })
          .catch((error) => {
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices();
        }, 20 * 1000);
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

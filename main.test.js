'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { EventEmitter } = require('node:events');

// Replace @iobroker/adapter-core with a minimal in-memory adapter before main.js loads it.
class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.config = {};
    this.states = {};
    this.timeouts = [];
    this.intervals = [];
    this.log = { debug: sinon.spy(), info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
  }
  setState(id, state) {
    this.states[id] = state !== null && typeof state === 'object' ? state.val : state;
    return Promise.resolve();
  }
  getStateAsync(id) {
    return Promise.resolve(id in this.states ? { val: this.states[id] } : null);
  }
  setObjectNotExistsAsync() {
    return Promise.resolve();
  }
  setObjectNotExists() {}
  delObjectAsync() {
    return Promise.resolve();
  }
  subscribeStates() {}
  setTimeout(fn, ms) {
    const timer = { fn, ms };
    this.timeouts.push(timer);
    return timer;
  }
  clearTimeout() {}
  setInterval(fn, ms) {
    const timer = { fn, ms };
    this.intervals.push(timer);
    return timer;
  }
  clearInterval() {}
}
const corePath = require.resolve('@iobroker/adapter-core');
require.cache[corePath] = /** @type {NodeModule} */ (
  /** @type {unknown} */ ({
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: FakeAdapter },
  })
);
const createRenault = require('./main.js');

/**
 * @typedef {Omit<ReturnType<typeof createRenault>, 'requestClient' | 'json2iob' | 'log' | 'setState' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>
 *   & FakeAdapter
 *   & { requestClient: sinon.SinonSpy; json2iob: { parse: sinon.SinonSpy } }} TestAdapter
 */

/** @returns {TestAdapter} */
function createAdapter() {
  return /** @type {TestAdapter} */ (/** @type {unknown} */ (createRenault()));
}

/** @param {unknown} val */
function userWrite(val) {
  return /** @type {ioBroker.State} */ (/** @type {unknown} */ ({ val, ack: false }));
}

const ACCOUNT = { accountId: 'acc-1', accountType: 'MYRENAULT', accountStatus: 'ACTIVE' };
const VEHICLE = { vin: 'VIN1', brand: 'RENAULT', vehicleDetails: { modelSCR: 'ZOE', model: { label: ' R135' } } };

/** Build an HTTP error shaped like an axios error. */
function httpError(status, config = {}) {
  const error = new Error('Request failed with status code ' + status);
  Object.assign(error, { response: { status, data: { status } }, config });
  return error;
}

/**
 * Create an adapter whose HTTP client answers per URL fragment.
 * A route value is either a response body or an Error to reject with.
 */
function setup(routes = {}) {
  const adapter = createAdapter();
  adapter.config = { ...require('./io-package.json').native, username: 'user@example.com', password: 'secret' };
  const defaults = {
    'hacf-fr': new Error('offline'),
    'accounts.login': { sessionInfo: { cookieValue: 'COOKIE' } },
    'accounts.getJWT': { id_token: 'ID_TOKEN' },
    '/connection': { currentUser: { accounts: [ACCOUNT] } },
    '/vehicles?': { vehicleLinks: [VEHICLE] },
  };
  const all = { ...defaults, ...routes };
  adapter.requestClient = sinon.spy(async (request) => {
    const key = Object.keys(all).find((fragment) => request.url.includes(fragment));
    const answer = key === undefined ? {} : all[key];
    if (answer instanceof Error) {
      throw answer;
    }
    return { data: answer };
  });
  adapter.json2iob.parse = sinon.spy();
  return adapter;
}

const urls = (adapter) => adapter.requestClient.getCalls().map((call) => call.args[0].url);
const logged = (spy) => spy.getCalls().map((call) => String(call.args[0]));

describe('startup', () => {
  it('loads vehicles, polls and reports the connection after a successful login', async () => {
    const adapter = setup();
    await adapter.onReady();
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
    expect(urls(adapter).some((url) => url.includes('/cars/VIN1/battery-status'))).to.equal(true);
    expect(adapter.states['info.connection']).to.equal(true);
    expect(adapter.timeouts).to.have.length(0);
    expect(adapter.intervals.map((timer) => timer.ms)).to.deep.equal([adapter.config.interval * 60 * 1000, 3500 * 1000]);
  });

  it('retries with growing, capped delay when the cloud is unreachable', async () => {
    const adapter = setup({ 'accounts.login': new Error('ECONNRESET') });
    await adapter.onReady();
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const timer = adapter.timeouts.pop();
      delays.push(timer.ms / 60000);
      await timer.fn();
    }
    expect(delays).to.deep.equal([5, 10, 20, 40, 60, 60]);
    expect(adapter.states['info.connection']).to.equal(false);
    expect(adapter.updateInterval).to.equal(null);
  });

  it('starts polling once a retry succeeds', async () => {
    const adapter = setup({ '/vehicles?': httpError(503) });
    await adapter.onReady();
    expect(adapter.updateInterval).to.equal(null);
    expect(adapter.states['info.connection']).to.equal(true);

    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.pop().fn();
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
    expect(adapter.updateInterval).to.not.equal(null);
  });

  it('does not retry a login the account service rejected', async () => {
    const adapter = setup({ 'accounts.login': { errorCode: 403042, errorMessage: 'Invalid LoginID' } });
    await adapter.onReady();
    expect(adapter.timeouts).to.have.length(0);
    expect(adapter.states['info.connection']).to.equal(false);
    expect(logged(adapter.log.error).some((line) => line.includes('Check email and password'))).to.equal(true);
  });

  it('reports no connection when no matching account exists', async () => {
    const adapter = setup({ '/connection': { currentUser: { accounts: [{ ...ACCOUNT, accountType: 'OTHER' }] } } });
    await adapter.onReady();
    expect(adapter.states['info.connection']).to.equal(false);
    expect(adapter.timeouts).to.have.length(1);
    expect(logged(adapter.log.error).some((line) => line.includes('[object Object]'))).to.equal(false);
  });

  it('accepts vehicles without vehicleDetails', async () => {
    const adapter = setup({ '/vehicles?': { vehicleLinks: [{ vin: 'VIN2', brand: 'DACIA' }] } });
    await adapter.onReady();
    expect(adapter.deviceArray).to.deep.equal(['VIN2']);
    expect(adapter.json2iob.parse.calledWith('VIN2.general')).to.equal(true);
  });

  it('does not list a vehicle twice when the list is loaded again', async () => {
    const adapter = setup();
    await adapter.onReady();
    await adapter.getDeviceList();
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
  });
});

describe('token refresh', () => {
  it('clears info.connection when the refresh fails', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient = setup({ 'accounts.getJWT': httpError(500) }).requestClient;
    await adapter.refreshToken();
    expect(adapter.states['info.connection']).to.equal(false);
  });
});

describe('refresh command', () => {
  it('does not throw before an account is known', async () => {
    const adapter = setup();
    await adapter.onStateChange('renault.0.VIN1.remote.refresh', userWrite(true));
    expect(adapter.requestClient.called).to.equal(false);
  });

  it('polls nothing while no account is known', async () => {
    const adapter = setup();
    await adapter.updateDevices();
    expect(adapter.requestClient.called).to.equal(false);
  });
});

describe('polling errors', () => {
  async function firstPoll(status) {
    const adapter = setup({ '/cars/VIN1/cockpit?': httpError(status) });
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    await adapter.updateDevices();
    return urls(adapter).some((url) => url.includes('/cars/VIN1/cockpit?'));
  }

  for (const status of [500, 501, 502, 503]) {
    it(`keeps polling an endpoint after a temporary ${status}`, async () => {
      expect(await firstPoll(status)).to.equal(true);
    });
  }

  for (const status of [400, 403, 404]) {
    it(`stops polling an endpoint the car does not support (${status})`, async () => {
      expect(await firstPoll(status)).to.equal(false);
    });
  }
});

describe('logging', () => {
  it('never logs password, session cookie or id token', async () => {
    const leaky = httpError(500, { data: 'password=secret', headers: { 'x-gigya-id_token': 'ID_TOKEN' } });
    const failing = setup({ 'accounts.login': leaky });
    await failing.onReady();
    const working = setup({ '/cars/VIN1/location': leaky });
    await working.onReady();
    await working.refreshToken();

    for (const adapter of [failing, working]) {
      const lines = Object.values(adapter.log).flatMap((spy) => spy.getCalls().map((call) => require('node:util').inspect(call.args[0])));
      for (const secret of ['secret', 'COOKIE', 'ID_TOKEN']) {
        expect(lines.filter((line) => line.includes(secret))).to.deep.equal([]);
      }
    }
  });
});

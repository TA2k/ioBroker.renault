'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { createTestAdapter, httpError, ACCOUNT } = require('./test/fakeAdapter');
const createRenault = require('./main.js');

const setup = createTestAdapter;

/** @param {unknown} val */
function userWrite(val) {
  return /** @type {ioBroker.State} */ (/** @type {unknown} */ ({ val, ack: false }));
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
      if (!timer) {
        throw new Error('no retry timer');
      }
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
    await adapter.timeouts.pop()?.fn();
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

describe('http client', () => {
  it('aborts a request the cloud never answers', async () => {
    const server = require('node:http').createServer(() => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { requestClient } = createRenault();
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      const request = requestClient({ url: `http://127.0.0.1:${address.port}/` }).then(
        () => 'answered',
        (error) => error.code,
      );
      let outcome = 'pending';
      request.then((result) => (outcome = result));
      await new Promise((resolve) => setImmediate(resolve));
      await clock.tickAsync(30 * 1000 - 1);
      expect(outcome).to.equal('pending');
      await clock.tickAsync(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(outcome).to.equal('ECONNABORTED');
    } finally {
      clock.restore();
      server.closeAllConnections();
      server.close();
    }
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

describe('update interval', () => {
  const cases = [
    [0, 5],
    [4.9, 5],
    [5, 5],
    [15, 15],
    ['15', 15],
    [1440, 1440],
    [1441, 1440],
    [-1, 5],
    ['abc', 5],
    [null, 5],
  ];
  for (const [configured, expected] of cases) {
    it(`uses ${expected} minutes for a configured ${JSON.stringify(configured)}`, async () => {
      const adapter = setup();
      adapter.config.interval = /** @type {any} */ (configured);
      await adapter.onReady();
      expect(adapter.config.interval).to.equal(expected);
    });
  }

  it('defaults to 15 minutes for new installations', () => {
    expect(require('./io-package.json').native.interval).to.equal(15);
    expect(require('./admin/jsonConfig.json').items.interval.min).to.equal(5);
  });
});

describe('subscriptions', () => {
  it('subscribes only to the remote states', async () => {
    const adapter = setup();
    await adapter.onReady();
    expect(adapter.subscribeStates.args).to.deep.equal([['*.remote.*']]);
  });
});

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
    expect(adapter.timeouts.map((timer) => timer.ms)).to.deep.equal([adapter.config.interval * 60 * 1000]);
    expect(adapter.intervals.map((timer) => timer.ms)).to.deep.equal([3500 * 1000]);
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
    expect(adapter.pollTimeout).to.equal(null);
  });

  it('starts polling once a retry succeeds', async () => {
    const adapter = setup({ '/vehicles?': httpError(503) });
    await adapter.onReady();
    expect(adapter.pollTimeout).to.equal(null);
    expect(adapter.states['info.connection']).to.equal(true);

    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.pop()?.fn();
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
    expect(adapter.pollTimeout).to.not.equal(null);
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

describe('poll scheduling', () => {
  const battery = (adapter) => urls(adapter).filter((url) => url.includes('/battery-status'));

  it('schedules the next poll before it polls', async () => {
    const adapter = setup();
    await adapter.onReady();
    const first = adapter.timeouts[0];
    adapter.requestClient.resetHistory();
    await first.fn();
    expect(adapter.timeouts.map((timer) => timer.ms)).to.deep.equal([15 * 60 * 1000, 15 * 60 * 1000]);
    expect(adapter.clearTimeout.calledWith(first)).to.equal(true);
    expect(battery(adapter)).to.have.length(1);
  });

  it('skips a poll and a refresh while the previous poll still runs', async () => {
    const adapter = setup();
    await adapter.onReady();
    /** @type {(value: unknown) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    adapter.requestClient = setup({ '/battery-status': () => gate }).requestClient;
    const running = adapter.pollNow();
    await adapter.pollNow();
    await adapter.onStateChange('renault.0.VIN1.remote.refresh', userWrite(true));
    expect(battery(adapter)).to.have.length(1);
    release({});
    await running;
    await adapter.pollNow();
    expect(battery(adapter)).to.have.length(2);
  });

  it('polls 20 seconds after a command instead of at the pending time', async () => {
    const adapter = setup();
    await adapter.onReady();
    const pending = adapter.timeouts[0];
    await adapter.onStateChange('renault.0.VIN1.remote.actions/hvac-start', userWrite(true));
    expect(adapter.clearTimeout.calledWith(pending)).to.equal(true);
    expect(adapter.timeouts.at(-1)?.ms).to.equal(20 * 1000);
  });

  it('stops the poll timer on unload and clears no empty handle', async () => {
    const adapter = setup();
    await adapter.onReady();
    const callback = sinon.spy();
    adapter.onUnload(callback);
    expect(adapter.clearTimeout.calledWith(adapter.timeouts[0])).to.equal(true);
    expect(adapter.clearTimeout.getCalls().every((call) => call.args[0])).to.equal(true);
    expect(callback.calledOnce).to.equal(true);
  });
});

describe('Kamereon API key', () => {
  const BUNDLED = 'YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J';
  const KEY = 'LookedUpKey0123456789ab';
  /** Layout of renault-api const.py on 2026-09-17: the CONF_ line comes first. */
  const constPy = (line) =>
    ['CONF_KAMEREON_APIKEY = "kamereon-api-key"', '', line, '', '    CONF_KAMEREON_APIKEY: KAMEREON_APIKEY,'].join('\n');
  const keyUsed = (adapter) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .find((request) => request.url.includes('/connection')).headers.apiKey;
  const lookups = (adapter) => urls(adapter).filter((url) => url.includes('hacf-fr'));

  const cases = [
    ["today's layout", constPy(`KAMEREON_APIKEY = "${KEY}"`), KEY],
    ['Windows line endings', constPy(`KAMEREON_APIKEY = "${KEY}"`).replace(/\n/g, '\r\n'), KEY],
    ['a key of 20 characters', constPy(`KAMEREON_APIKEY = "${'a'.repeat(20)}"`), 'a'.repeat(20)],
    ['a key of 64 characters', constPy(`KAMEREON_APIKEY = "${'a'.repeat(64)}"`), 'a'.repeat(64)],
    ['only the CONF_ line', constPy(''), BUNDLED],
    ['a key of 19 characters', constPy(`KAMEREON_APIKEY = "${'a'.repeat(19)}"`), BUNDLED],
    ['a key of 65 characters', constPy(`KAMEREON_APIKEY = "${'a'.repeat(65)}"`), BUNDLED],
    ['invalid characters', constPy('KAMEREON_APIKEY = "LookedUp-Key0123456789"'), BUNDLED],
    ['an indented line', constPy(`    KAMEREON_APIKEY = "${KEY}"`), BUNDLED],
    ['a JSON body', { KAMEREON_APIKEY: KEY }, BUNDLED],
    ['a failed request', httpError(404), BUNDLED],
  ];
  for (const [name, body, expected] of cases) {
    it(`uses ${expected === BUNDLED ? 'the bundled key' : 'the looked-up key'} for ${name}`, async () => {
      const adapter = setup({ 'hacf-fr': body });
      await adapter.onReady();
      expect(keyUsed(adapter)).to.equal(expected);
    });
  }

  it('prefers a valid key from the settings and skips the lookup', async () => {
    const adapter = setup({ 'hacf-fr': constPy(`KAMEREON_APIKEY = "${KEY}"`) });
    adapter.config.apiKeyUpdate = ' SettingsKey0123456789ab ';
    await adapter.onReady();
    expect(keyUsed(adapter)).to.equal('SettingsKey0123456789ab');
    expect(lookups(adapter)).to.deep.equal([]);
  });

  it('ignores an invalid key from the settings with a warning', async () => {
    const adapter = setup({ 'hacf-fr': constPy(`KAMEREON_APIKEY = "${KEY}"`) });
    adapter.config.apiKeyUpdate = 'short';
    await adapter.onReady();
    expect(keyUsed(adapter)).to.equal(KEY);
    expect(logged(adapter.log.warn).some((line) => line.includes('API key'))).to.equal(true);
  });

  it('never logs a key', async () => {
    const adapter = setup({ 'hacf-fr': constPy(`KAMEREON_APIKEY = "${KEY}"`) });
    adapter.config.apiKeyUpdate = 'short';
    await adapter.onReady();
    const lines = Object.values(adapter.log).flatMap((spy) => logged(spy));
    expect(lines.filter((line) => line.includes(KEY) || line.includes(BUNDLED) || line.includes('short'))).to.deep.equal([]);
  });
});

describe('country and locale', () => {
  /** @type {[unknown, string, string, string][]} */
  const cases = [
    ['fr', 'FR', 'fr-FR', 'fr'],
    ['FR', 'FR', 'fr-FR', 'fr'],
    [' it ', 'IT', 'it-IT', 'it'],
    ['ch', 'CH', 'de-CH', 'ch'],
    ['be', 'BE', 'fr-BE', 'be'],
    ['us', 'US', 'de-DE', 'us'],
    ['', 'DE', 'de-DE', 'de'],
    ['FRA', 'DE', 'de-DE', 'de'],
    ['f', 'DE', 'de-DE', 'de'],
    ['1a', 'DE', 'de-DE', 'de'],
    [null, 'DE', 'de-DE', 'de'],
  ];
  for (const [configured, country, locale, kamereonCountry] of cases) {
    it(`uses ${country} / ${locale} for ${JSON.stringify(configured)}`, async () => {
      const adapter = setup();
      adapter.config.country = /** @type {any} */ (configured);
      await adapter.onReady();
      const requests = adapter.requestClient.getCalls().map((call) => call.args[0]);
      const connection = requests.find((request) => request.url.includes('/connection'));
      expect(connection.url)
        .to.include('country=' + country + '&')
        .and.to.include('locale=' + locale + '&');
      const battery = requests.find((request) => request.url.includes('/battery-status'));
      expect(battery.url).to.match(new RegExp('country=' + kamereonCountry + '$'));
      const languages = requests
        .map((request) => request.headers?.['Accept-Language'] ?? request.headers?.['accept-language'])
        .filter(Boolean);
      expect(new Set(languages)).to.deep.equal(new Set([locale.toLowerCase()]));
    });
  }

  it('warns about an invalid country but not about an empty one', async () => {
    const invalid = setup();
    invalid.config.country = 'FRA';
    await invalid.onReady();
    expect(logged(invalid.log.warn).some((line) => line.includes('FRA'))).to.equal(true);
    const empty = setup();
    empty.config.country = '';
    await empty.onReady();
    expect(logged(empty.log.warn).some((line) => line.includes('Country'))).to.equal(false);
  });
});

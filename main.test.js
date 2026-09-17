'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { createTestAdapter, httpError, ACCOUNT, VEHICLE } = require('./test/fakeAdapter');
const createRenault = require('./main.js');

const setup = createTestAdapter;

/** @param {unknown} val */
function userWrite(val) {
  return /** @type {ioBroker.State} */ (/** @type {unknown} */ ({ val, ack: false }));
}

/** @type {sinon.SinonFakeTimers | undefined} */
let clock;
/** Fake only Date; adapter timers are already recorded by FakeAdapter. */
function useClock(now = Date.parse('2026-09-17T10:00:00Z')) {
  clock = sinon.useFakeTimers({ now, toFake: ['Date'] });
  return clock;
}
afterEach(() => {
  clock?.restore();
  clock = undefined;
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
    expect(adapter.intervals.map((timer) => timer.ms)).to.deep.equal([3500 * 1000, DAY]);
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
    await adapter.onStateChange('renault.0.VIN1.remote.hvac-start', userWrite(true));
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

describe('request quota', () => {
  const QUOTA = { errors: [{ errorCode: 'err.func.wired.overloaded', errorMessage: 'You have reached your quota limit' }] };
  const kamereon = (adapter) => urls(adapter).filter((url) => url.includes('/kamereon/'));
  const pauses = (adapter) => logged(adapter.log.warn).filter((line) => line.includes('quota'));

  it('stops the cycle for all vehicles on the first 429 and warns once', async () => {
    useClock();
    const adapter = setup({
      '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] },
      '/cars/VIN1/battery-status': httpError(429, {}, QUOTA),
    });
    await adapter.onReady();
    expect(kamereon(adapter)).to.have.length(1);
    expect(pauses(adapter)).to.have.length(1);
    expect(pauses(adapter)[0]).to.include('15 minutes');
  });

  it('treats a quota error body with another status as quota', async () => {
    useClock();
    const adapter = setup({ '/battery-status': httpError(500, {}, QUOTA) });
    await adapter.onReady();
    expect(kamereon(adapter)).to.have.length(1);
    expect(pauses(adapter)).to.have.length(1);
  });

  it('skips polls during the pause and polls again when it ends', async () => {
    const now = useClock();
    const adapter = setup({ '/battery-status': httpError(429, {}, QUOTA) });
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    now.tick(15 * 60 * 1000 - 1);
    await adapter.updateDevices();
    expect(kamereon(adapter)).to.deep.equal([]);
    now.tick(1);
    await adapter.updateDevices();
    expect(kamereon(adapter)).to.have.length(1);
  });

  it('pauses 15, 30, 60 and 60 minutes in a row and starts at 15 again after a success', async () => {
    const now = useClock();
    let overloaded = true;
    const adapter = setup({ '/battery-status': () => (overloaded ? httpError(429, {}, QUOTA) : {}) });
    await adapter.onReady();
    for (let i = 0; i < 3; i++) {
      now.tick(DAY);
      await adapter.updateDevices();
    }
    overloaded = false;
    now.tick(DAY);
    await adapter.updateDevices();
    overloaded = true;
    now.tick(DAY);
    await adapter.updateDevices();
    expect(pauses(adapter).map((line) => line.match(/(\d+) minutes/)?.[1])).to.deep.equal(['15', '30', '60', '60', '15']);
  });

  it('does not ignore the endpoint after a 429', async () => {
    const now = useClock();
    const adapter = setup({ '/battery-status': httpError(429, {}, QUOTA) });
    await adapter.onReady();
    now.tick(15 * 60 * 1000);
    adapter.requestClient.resetHistory();
    await adapter.updateDevices();
    expect(kamereon(adapter)[0]).to.include('/battery-status');
  });

  it('schedules the next poll no earlier than the end of the pause', async () => {
    useClock();
    const adapter = setup({ '/battery-status': httpError(429, {}, QUOTA) });
    adapter.config.interval = 5;
    await adapter.onReady();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(15 * 60 * 1000);
  });

  it('keeps the configured interval when it is longer than the pause', async () => {
    useClock();
    const adapter = setup({ '/battery-status': httpError(429, {}, QUOTA) });
    adapter.config.interval = 60;
    await adapter.onReady();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(60 * 60 * 1000);
  });
});

describe('relogin', () => {
  async function connected() {
    const adapter = setup();
    await adapter.onReady();
    return adapter;
  }
  const failRefresh = (adapter, routes = {}) => {
    adapter.requestClient = setup({ 'accounts.getJWT': httpError(500), ...routes }).requestClient;
  };

  it('stops polling and logs in again one minute after a failed refresh', async () => {
    const adapter = await connected();
    const poll = adapter.pollTimeout;
    const refresh = adapter.refreshTokenInterval;
    failRefresh(adapter);
    expect(await adapter.refreshToken()).to.equal(false);
    expect(adapter.timeouts.at(-1)?.ms).to.equal(60 * 1000);
    expect(adapter.pollTimeout).to.equal(null);
    expect(adapter.clearTimeout.calledWith(poll)).to.equal(true);
    expect(adapter.clearInterval.calledWith(refresh)).to.equal(true);
  });

  it('keeps retrying with backoff when the relogin fails too', async () => {
    const adapter = await connected();
    failRefresh(adapter, { 'accounts.login': new Error('ECONNRESET') });
    await adapter.refreshToken();
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(5 * 60 * 1000);
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(10 * 60 * 1000);
    expect(adapter.states['info.connection']).to.equal(false);
  });

  it('stops after a relogin the account service rejected', async () => {
    const adapter = await connected();
    failRefresh(adapter, { 'accounts.login': { errorCode: 403042, errorMessage: 'Invalid LoginID' } });
    await adapter.refreshToken();
    const count = adapter.timeouts.length;
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.timeouts).to.have.length(count);
    expect(logged(adapter.log.error).some((line) => line.includes('Check email and password'))).to.equal(true);
  });

  it('runs exactly one poll timer and one refresh interval after a successful relogin', async () => {
    const adapter = await connected();
    const refresh = adapter.refreshTokenInterval;
    failRefresh(adapter);
    await adapter.refreshToken();
    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.pollTimeout).to.not.equal(null);
    expect(adapter.refreshTokenInterval).to.not.equal(refresh);
    const live = adapter.intervals.filter((timer) => timer.ms === 3500 * 1000 && !adapter.clearInterval.calledWith(timer));
    expect(live).to.have.length(1);
    expect(adapter.states['info.connection']).to.equal(true);
  });

  it('starts the backoff at 5 minutes again after a successful relogin', async () => {
    const adapter = setup({ '/vehicles?': httpError(503) });
    await adapter.onReady();
    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.at(-1)?.fn();
    failRefresh(adapter, { 'accounts.login': new Error('ECONNRESET') });
    await adapter.refreshToken();
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(5 * 60 * 1000);
  });

  it('treats an answer without id token as a failed refresh', async () => {
    const adapter = await connected();
    adapter.requestClient = setup({ 'accounts.getJWT': { errorCode: 403005, errorMessage: 'Unauthorized user' } }).requestClient;
    expect(await adapter.refreshToken()).to.equal(false);
    expect(adapter.states['info.connection']).to.equal(false);
    expect(adapter.session.id_token).to.equal('ID_TOKEN');
  });

  it('logs in again at once when there is no session', async () => {
    const adapter = await connected();
    adapter.session_data = undefined;
    adapter.requestClient.resetHistory();
    expect(await adapter.refreshToken()).to.equal(false);
    expect(adapter.timeouts.at(-1)?.ms).to.equal(0);
    expect(adapter.requestClient.called).to.equal(false);
  });
});

describe('expired token during a poll', () => {
  const battery = (adapter) => urls(adapter).filter((url) => url.includes('/battery-status'));
  const kamereon = (adapter) => urls(adapter).filter((url) => url.includes('/kamereon/'));
  const refreshes = (adapter) => urls(adapter).filter((url) => url.includes('accounts.getJWT'));

  async function afterStartup(routes) {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient = setup(routes).requestClient;
    return adapter;
  }

  it('stops the cycle, refreshes once and repeats the cycle once', async () => {
    let expired = true;
    const adapter = await afterStartup({ '/battery-status': () => (expired ? ((expired = false), httpError(401)) : {}) });
    await adapter.updateDevices();
    expect(refreshes(adapter)).to.have.length(1);
    expect(battery(adapter)).to.have.length(2);
    // nothing between the 401 and the repeat, and the repeat requests the other endpoints
    expect(
      kamereon(adapter)
        .slice(0, 2)
        .every((url) => url.includes('/battery-status')),
    ).to.equal(true);
    expect(
      kamereon(adapter)
        .slice(2)
        .some((url) => url.includes('/lock-status')),
    ).to.equal(true);
  });

  it('does not try a third time when the repeat gets a 401 too', async () => {
    const adapter = await afterStartup({ '/battery-status': httpError(401) });
    await adapter.updateDevices();
    expect(refreshes(adapter)).to.have.length(1);
    expect(kamereon(adapter)).to.have.length(2);
    expect(logged(adapter.log.warn).some((line) => line.includes('401'))).to.equal(true);
  });

  it('does not repeat the cycle when the refresh fails', async () => {
    const adapter = await afterStartup({ '/battery-status': httpError(401), 'accounts.getJWT': httpError(500) });
    await adapter.updateDevices();
    expect(kamereon(adapter)).to.have.length(1);
    expect(adapter.timeouts.at(-1)?.ms).to.equal(60 * 1000);
  });

  it('stops the endpoints of the other vehicles too', async () => {
    const adapter = setup({ '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] } });
    await adapter.onReady();
    adapter.requestClient = setup({ '/cars/VIN1/battery-status': httpError(401), 'accounts.getJWT': httpError(500) }).requestClient;
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('VIN2'))).to.deep.equal([]);
  });

  it('leaves no 60-second refresh timer behind', async () => {
    const adapter = await afterStartup({ '/battery-status': httpError(401) });
    await adapter.updateDevices();
    expect(adapter.timeouts.filter((timer) => timer.ms === 60 * 1000)).to.deep.equal([]);
  });
});

describe('request budget', () => {
  const history = (adapter) => urls(adapter).filter((url) => url.includes('/charge-history') || url.includes('/charges?'));
  const budget = (adapter) => logged(adapter.log.warn).filter((line) => line.includes('requests per hour'));

  it('fetches the charge history at most once per hour', async () => {
    const now = useClock();
    const adapter = setup();
    await adapter.onReady();
    expect(history(adapter)).to.have.length(2);
    now.tick(HOUR - 1);
    await adapter.updateDevices();
    expect(history(adapter)).to.have.length(2);
    now.tick(1);
    await adapter.updateDevices();
    expect(history(adapter)).to.have.length(4);
  });

  it('fetches the history in the next cycle when a cycle was aborted', async () => {
    const now = useClock();
    let overloaded = true;
    const adapter = setup({ '/battery-status': () => (overloaded ? httpError(429) : {}) });
    await adapter.onReady();
    expect(history(adapter)).to.have.length(0);
    overloaded = false;
    now.tick(15 * 60 * 1000);
    await adapter.updateDevices();
    expect(history(adapter)).to.have.length(2);
  });

  it('never fetches the history when charge fetching is disabled', async () => {
    useClock();
    const adapter = setup();
    adapter.config.disableChargeFetching = true;
    await adapter.onReady();
    expect(history(adapter)).to.have.length(0);
  });

  for (const [pollRequests, hourlyRequests, warns] of [
    [10, 0, false],
    [10, 1, true],
    [0, 60, false],
    [0, 61, true],
  ]) {
    it(`${warns ? 'warns' : 'does not warn'} at ${pollRequests} requests per poll and ${hourlyRequests} per hour (interval 10)`, () => {
      const adapter = setup();
      adapter.config.interval = 10;
      adapter.checkRequestBudget(Number(pollRequests), Number(hourlyRequests));
      expect(budget(adapter)).to.have.length(warns ? 1 : 0);
    });
  }

  it('recommends an interval that fits the quota', () => {
    const adapter = setup();
    adapter.config.interval = 10;
    adapter.checkRequestBudget(10, 1);
    expect(budget(adapter)[0]).to.include('at least 11 minutes');
  });

  it('checks the budget once, after the first cycle, with the endpoints that stay polled', async () => {
    useClock();
    const adapter = setup({ '/lock-status': httpError(404) });
    adapter.config.interval = 5;
    const check = sinon.spy(adapter, 'checkRequestBudget');
    await adapter.onReady();
    await adapter.updateDevices();
    // 11 non-history endpoints minus the ignored lock-status and minus cockpit v1, plus the two hourly history endpoints
    expect(check.args).to.deep.equal([[9, 2]]);
    expect(budget(adapter)).to.have.length(1);
  });

  it('does not warn at the default interval of 15 minutes', async () => {
    useClock();
    const adapter = setup();
    await adapter.onReady();
    expect(budget(adapter)).to.deep.equal([]);
  });
});

describe('ignored endpoints', () => {
  const lock = (adapter) => urls(adapter).filter((url) => url.includes('/lock-status'));
  const ignored = (adapter) => logged(adapter.log.info).filter((line) => line.includes('Ignore lock-status'));

  it('skips a rejected endpoint for 24 hours and asks again after that', async () => {
    const now = useClock();
    const adapter = setup({ '/lock-status': httpError(403) });
    await adapter.onReady();
    now.tick(DAY - 1);
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(1);
    now.tick(1);
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(2);
  });

  it('waits another 24 hours after a failed retry and logs the ignore only once', async () => {
    const now = useClock();
    const adapter = setup({ '/lock-status': httpError(404) });
    await adapter.onReady();
    now.tick(DAY);
    await adapter.updateDevices();
    now.tick(DAY - 1);
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(2);
    expect(ignored(adapter)).to.have.length(1);
  });

  it('polls the endpoint normally after a successful retry', async () => {
    const now = useClock();
    let rejected = true;
    const adapter = setup({ '/lock-status': () => (rejected ? httpError(403) : {}) });
    await adapter.onReady();
    rejected = false;
    now.tick(DAY);
    await adapter.updateDevices();
    now.tick(1);
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(3);
  });

  it('does not ignore an endpoint that answered before, even on a later 403', async () => {
    useClock();
    let rejected = false;
    const adapter = setup({ '/lock-status': () => (rejected ? httpError(403) : {}) });
    await adapter.onReady();
    rejected = true;
    await adapter.updateDevices();
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(3);
    expect(ignored(adapter)).to.deep.equal([]);
  });

  it('ignores a rejected endpoint of a vehicle that appears later', async () => {
    useClock();
    const adapter = setup({ '/cars/VIN2/lock-status': httpError(404) });
    await adapter.onReady();
    adapter.requestClient = setup({
      '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] },
      '/cars/VIN2/lock-status': httpError(404),
    }).requestClient;
    await adapter.getDeviceList();
    await adapter.updateDevices();
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('/cars/VIN2/lock-status'))).to.have.length(1);
  });

  it('keeps the ignore timing when the vehicle list is loaded again', async () => {
    const now = useClock();
    const adapter = setup({ '/lock-status': httpError(403) });
    await adapter.onReady();
    await adapter.getDeviceList();
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(lock(adapter)).to.have.length(1);
  });
});

describe('cockpit version', () => {
  const v1 = (adapter) => urls(adapter).filter((url) => url.includes('/v1/cars/VIN1/cockpit?'));
  const v2 = (adapter) => urls(adapter).filter((url) => url.includes('/v2/cars/VIN1/cockpit?'));
  const cockpitDeletes = (adapter) => adapter.deleted.filter((id) => id.includes('cockpit'));
  const choice = (adapter) => JSON.parse(adapter.states['info.cockpitVersion'] ?? '{}');

  it('keeps v2 when both versions answer and deletes the v1 channel once', async () => {
    useClock();
    const adapter = setup();
    await adapter.onReady();
    await adapter.updateDevices();
    expect(cockpitDeletes(adapter)).to.deep.equal(['VIN1.cockpit']);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
    expect(v1(adapter)).to.have.length(1);
    expect(v2(adapter)).to.have.length(2);
  });

  it('keeps v1 when v2 is not supported and deletes the v2 channel', async () => {
    useClock();
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    await adapter.updateDevices();
    expect(cockpitDeletes(adapter)).to.deep.equal(['VIN1.cockpitv2']);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpit' });
    expect(v1(adapter)).to.have.length(2);
  });

  it('keeps v2 when v1 is not supported', async () => {
    useClock();
    const adapter = setup({ '/v1/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    expect(cockpitDeletes(adapter)).to.deep.equal(['VIN1.cockpit']);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
  });

  for (const status of [401, 429, 503]) {
    it(`decides nothing and deletes nothing when v2 answers ${status}`, async () => {
      useClock();
      let tokens = 0;
      const adapter = setup({
        '/v2/cars/VIN1/cockpit?': httpError(status),
        // the login gets a token, the refresh after the 401 fails, so the cycle ends there
        'accounts.getJWT': () => (tokens++ === 0 ? { id_token: 'ID_TOKEN' } : httpError(500)),
      });
      await adapter.onReady();
      expect(v1(adapter)).to.have.length(1);
      expect(cockpitDeletes(adapter)).to.deep.equal([]);
      expect(choice(adapter)).to.deep.equal({});
    });
  }

  it('decides nothing when neither version is supported', async () => {
    useClock();
    const adapter = setup({ '/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    expect(cockpitDeletes(adapter)).to.deep.equal([]);
    expect(choice(adapter)).to.deep.equal({});
  });

  it('uses the stored choice after a restart without asking v1 again', async () => {
    useClock();
    const adapter = setup();
    adapter.states['info.cockpitVersion'] = JSON.stringify({ VIN1: 'cockpitv2' });
    await adapter.onReady();
    expect(v1(adapter)).to.deep.equal([]);
    expect(v2(adapter)).to.have.length(1);
    expect(cockpitDeletes(adapter)).to.deep.equal([]);
  });

  for (const stored of ['not json', '[]', 'null', JSON.stringify({ VIN1: 'cockpitv3' })]) {
    it(`ignores the invalid stored value ${stored}`, async () => {
      useClock();
      const adapter = setup();
      adapter.states['info.cockpitVersion'] = stored;
      await adapter.onReady();
      expect(v1(adapter)).to.have.length(1);
      expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
    });
  }

  it('declares the marker state', () => {
    const object = require('./io-package.json').instanceObjects.find((entry) => entry._id === 'info.cockpitVersion');
    expect(object?.common).to.include({ type: 'string', role: 'json', read: true, write: false, def: '{}' });
  });
});

describe('vehicle list', () => {
  const TWO = { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] };

  it('reloads the vehicle list every 24 hours and polls a new vehicle', async () => {
    const adapter = setup();
    await adapter.onReady();
    const reload = adapter.intervals.find((timer) => timer.ms === DAY);
    expect(reload).to.not.equal(undefined);
    adapter.requestClient = setup({ '/vehicles?': TWO }).requestClient;
    await reload?.fn();
    expect(adapter.deviceArray).to.deep.equal(['VIN1', 'VIN2']);
    expect(logged(adapter.log.info).some((line) => line.includes('New vehicle VIN2'))).to.equal(true);
    await adapter.updateDevices();
    expect(urls(adapter).some((url) => url.includes('/cars/VIN2/battery-status'))).to.equal(true);
  });

  it('stops polling a vehicle that left the account', async () => {
    const adapter = setup({ '/vehicles?': TWO });
    await adapter.onReady();
    adapter.requestClient = setup().requestClient;
    await adapter.getDeviceList();
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('VIN2'))).to.deep.equal([]);
  });

  it('keeps the known vehicles when the reload fails', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient = setup({ '/vehicles?': httpError(503) }).requestClient;
    expect(await adapter.getDeviceList()).to.equal(false);
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
  });

  it('names the details channel in English', async () => {
    const adapter = setup();
    await adapter.onReady();
    expect(adapter.json2iob.parse.calledWith('VIN1.general', sinon.match.object, sinon.match({ channelName: 'Vehicle details' }))).to.equal(
      true,
    );
  });

  it('stops the reload on unload and on reconnect', async () => {
    const adapter = setup();
    await adapter.onReady();
    const reload = adapter.intervals.find((timer) => timer.ms === DAY);
    adapter.reconnect(0);
    expect(adapter.clearInterval.calledWith(reload)).to.equal(true);
    const second = setup();
    await second.onReady();
    second.onUnload(() => {});
    expect(second.clearInterval.calledWith(second.intervals.find((timer) => timer.ms === DAY))).to.equal(true);
  });
});

/**
 * Vehicle list with one vehicle of the given renault-api model code.
 *
 * @param {string} [code]
 */
function vehicleOf(code) {
  return { vehicleLinks: [{ ...VEHICLE, vehicleDetails: { ...VEHICLE.vehicleDetails, model: { code, label: ' ' + code } } }] };
}

describe('commands', () => {
  /**
   * @param {Record<string, unknown>} [routes]
   * @param {string} [code] model code of VIN1
   */
  async function ready(routes = {}, code = undefined) {
    const adapter = setup(code ? { '/vehicles?': vehicleOf(code), ...routes } : routes);
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    return adapter;
  }
  const posts = (adapter) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .filter((request) => request.method === 'post');
  /** Like js-controller: store the user value unacknowledged, then call the handler. */
  const write = async (adapter, path, val) => {
    const id = 'renault.0.VIN1.remote.' + path;
    await adapter.setState(id, val, false);
    await adapter.onStateChange(id, userWrite(val));
  };

  const KCA_HVAC = '/kamereon/kca/car-adapter/v1/cars/VIN1/actions/hvac-start?';
  const KCA_CHARGE = '/kamereon/kca/car-adapter/v1/cars/VIN1/actions/charging-start?';
  const KCM_PAUSE = '/kamereon/kcm/v1/vehicles/VIN1/charge/pause-resume?';
  /** @type {[string | undefined, string, boolean, string, object][]} model code (undefined = not documented), state, value, url, body */
  const cases = [
    [undefined, 'hvac-start', true, KCA_HVAC, { type: 'HvacStart', attributes: { action: 'start', targetTemperature: 21 } }],
    [undefined, 'hvac-start', false, KCA_HVAC, { type: 'HvacStart', attributes: { action: 'cancel' } }],
    ['XBG1VE', 'hvac-start', false, KCA_HVAC, { type: 'HvacStart', attributes: { action: 'stop' } }],
    [undefined, 'charging', true, KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'start' } }],
    [undefined, 'charging', false, KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'stop' } }],
    ['X102VE', 'charging', true, KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'start' } }],
    ['X102VE', 'charging', false, KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'pause' } }],
    ['XBG1VE', 'charging', true, KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'resume' } }],
    ['XBG1VE', 'charging', false, KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'pause' } }],
    [
      'XCB1VE',
      'charging',
      true,
      '/kamereon/kcm/v1/vehicles/VIN1/charge/start?',
      { type: 'ChargingStart', attributes: { action: 'start' } },
    ],
  ];
  for (const [code, path, val, url, body] of cases) {
    it(`sends ${path} = ${val} for model ${code ?? 'unknown'} and confirms it`, async () => {
      const adapter = await ready({}, code);
      await write(adapter, path, val);
      expect(posts(adapter)).to.have.length(1);
      expect(posts(adapter)[0].url)
        .to.include(url)
        .and.to.match(/country=de$/);
      expect(posts(adapter)[0].data).to.deep.equal({ data: body });
      expect(adapter.states['VIN1.remote.' + path]).to.equal(val);
      expect(adapter.acks['VIN1.remote.' + path]).to.equal(true);
      expect(adapter.states['VIN1.remote.lastError']).to.equal('');
      expect(adapter.timeouts.at(-1)?.ms).to.equal(20 * 1000);
    });
  }

  for (const code of ['XCB1VE', 'R5E1VE', 'A5E1AE']) {
    it(`sends nothing for charging = false on model ${code}, which cannot stop`, async () => {
      const adapter = await ready({}, code);
      await write(adapter, 'charging', false);
      expect(adapter.requestClient.called).to.equal(false);
      expect(adapter.states['VIN1.remote.lastError']).to.include('charging cannot stop');
      expect(adapter.acks['VIN1.remote.charging']).to.equal(false);
    });
  }

  it('sends nothing for a command the model does not support', async () => {
    const adapter = await ready({}, 'XJA1VP');
    await write(adapter, 'charging', true);
    await write(adapter, 'hvac-start', true);
    expect(adapter.requestClient.called).to.equal(false);
    expect(adapter.states['VIN1.remote.lastError']).to.include('cannot start');
  });

  for (const val of ['true', 1, null]) {
    it(`rejects the non-boolean command value ${JSON.stringify(val)}`, async () => {
      const adapter = await ready();
      await write(adapter, 'charging', val);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastError']).to.include('true or false');
    });
  }

  it('records a failed command and leaves it unconfirmed', async () => {
    const error = httpError(403, {}, { errors: [{ errorCode: 'err.func.wired.forbidden' }] });
    const adapter = await ready({ '/actions/charging-start': error });
    await write(adapter, 'charging', true);
    expect(adapter.acks['VIN1.remote.charging']).to.equal(false);
    expect(adapter.states['VIN1.remote.lastError']).to.include('charging').and.to.include('err.func.wired.forbidden');
    expect(adapter.timeouts.at(-1)?.ms).to.equal(20 * 1000);
  });

  for (const temperature of [NaN, 'abc', 0, -1, Infinity, '21']) {
    it(`does not start the climate control with target temperature ${String(temperature)}`, async () => {
      const adapter = await ready();
      adapter.states['VIN1.remote.hvac-temperature'] = temperature;
      await write(adapter, 'hvac-start', true);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastError']).to.include('hvac-temperature');
    });
  }

  for (const temperature of [0.1, 21, 30]) {
    it(`starts the climate control with target temperature ${temperature}`, async () => {
      const adapter = await ready();
      adapter.states['VIN1.remote.hvac-temperature'] = temperature;
      await write(adapter, 'hvac-start', true);
      expect(posts(adapter)[0].data.data.attributes.targetTemperature).to.equal(temperature);
    });
  }

  it('does not check the temperature when the climate control is stopped', async () => {
    const adapter = await ready();
    adapter.states['VIN1.remote.hvac-temperature'] = NaN;
    await write(adapter, 'hvac-start', false);
    expect(posts(adapter)).to.have.length(1);
  });

  it('confirms a valid target temperature and rejects an invalid one', async () => {
    const adapter = await ready();
    await write(adapter, 'hvac-temperature', 22);
    expect(adapter.acks['VIN1.remote.hvac-temperature']).to.equal(true);
    await write(adapter, 'hvac-temperature', 0);
    expect(adapter.acks['VIN1.remote.hvac-temperature']).to.equal(false);
    expect(logged(adapter.log.warn).some((line) => line.includes('hvac-temperature'))).to.equal(true);
    expect(posts(adapter)).to.deep.equal([]);
  });

  for (const id of [
    'renault.0.VIN1.remote.unknown',
    'renault.0.VIN1.remote.lastError',
    'renault.0.VIN1.remote.toString',
    'renault.0.VIN1.general.vin',
    'renault.0.OTHER.remote.charging',
  ]) {
    it(`sends nothing for a write to ${id}`, async () => {
      const adapter = await ready();
      await adapter.onStateChange(id, userWrite(true));
      expect(posts(adapter)).to.deep.equal([]);
    });
  }

  it('ignores acknowledged values', async () => {
    const adapter = await ready();
    await adapter.onStateChange(
      'renault.0.VIN1.remote.charging',
      /** @type {ioBroker.State} */ (/** @type {unknown} */ ({ val: true, ack: true })),
    );
    expect(posts(adapter)).to.deep.equal([]);
  });
});

describe('remote objects', () => {
  const common = (adapter, id) => adapter.objects.get('renault.0.VIN1.remote.' + id)?.common;

  it('creates the remote states with roles that match their use', async () => {
    const adapter = setup();
    await adapter.onReady();
    for (const id of ['hvac-start', 'charging']) {
      expect(common(adapter, id)).to.include({ type: 'boolean', role: 'switch', read: true, write: true });
    }
    expect(common(adapter, 'hvac-temperature')).to.include({
      type: 'number',
      role: 'level.temperature',
      unit: '°C',
      read: true,
      write: true,
    });
    expect(common(adapter, 'refresh')).to.include({ type: 'boolean', role: 'button', read: false, write: true });
    expect(common(adapter, 'lastError')).to.include({ type: 'string', role: 'text', read: true, write: false });
  });

  it('updates states created by older versions', async () => {
    const adapter = setup();
    adapter.objects.set('renault.0.VIN1.remote.refresh', {
      _id: 'renault.0.VIN1.remote.refresh',
      type: 'state',
      common: { name: 'True = Refresh Data', type: 'boolean', role: 'button', read: true, write: true },
      native: {},
    });
    await adapter.onReady();
    expect(common(adapter, 'refresh')).to.include({ name: 'Refresh vehicle data', read: false });
  });

  it('replaces the command states with a slash in their id once', async () => {
    const legacy = ['actions/hvac-start', 'actions/charging-start', 'charge/pause-resume', 'charge/start'];
    const adapter = setup();
    for (const id of legacy) {
      adapter.objects.set('renault.0.VIN1.remote.' + id, {
        _id: 'renault.0.VIN1.remote.' + id,
        type: 'state',
        common: { role: 'button' },
        native: {},
      });
    }
    await adapter.onReady();
    expect(adapter.deleted.filter((id) => id.startsWith('VIN1.remote.'))).to.deep.equal(legacy.map((id) => 'VIN1.remote.' + id));
    expect([...adapter.objects.keys()].filter((id) => id.includes('/'))).to.deep.equal([]);
    for (const id of ['hvac-start', 'charging']) {
      expect(common(adapter, id)).to.not.equal(undefined);
    }
    await adapter.getDeviceList();
    expect(adapter.deleted.filter((id) => id.startsWith('VIN1.remote.'))).to.have.length(legacy.length);
  });

  it('creates only the commands the model supports, with the role its stop support allows', async () => {
    const roles = async (code) => {
      const adapter = setup({ '/vehicles?': vehicleOf(code) });
      await adapter.onReady();
      return Object.fromEntries(
        ['hvac-start', 'hvac-temperature', 'charging'].map((id) => [id, adapter.objects.get('renault.0.VIN1.remote.' + id)?.common.role]),
      );
    };
    expect(await roles('X102VE')).to.deep.equal({ 'hvac-start': 'switch', 'hvac-temperature': 'level.temperature', charging: 'switch' });
    expect(await roles('R5E1VE')).to.deep.equal({
      'hvac-start': 'switch',
      'hvac-temperature': 'level.temperature',
      charging: 'button.start',
    });
    expect(await roles('XJA1VP')).to.deep.equal({ 'hvac-start': undefined, 'hvac-temperature': undefined, charging: undefined });
  });

  it('removes command states the model does not support', async () => {
    const adapter = setup({ '/vehicles?': vehicleOf('XJA1VP') });
    for (const id of ['hvac-start', 'hvac-temperature', 'charging']) {
      adapter.objects.set('renault.0.VIN1.remote.' + id, { _id: 'renault.0.VIN1.remote.' + id, type: 'state', common: {}, native: {} });
    }
    await adapter.onReady();
    expect(adapter.deleted.filter((id) => id.startsWith('VIN1.remote.'))).to.deep.equal([
      'VIN1.remote.hvac-start',
      'VIN1.remote.charging',
      'VIN1.remote.hvac-temperature',
    ]);
    expect(common(adapter, 'refresh')).to.not.equal(undefined);
  });

  it('sends nothing for a write to a removed command state', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    await adapter.onStateChange('renault.0.VIN1.remote.actions/hvac-start', userWrite(true));
    expect(adapter.requestClient.called).to.equal(false);
  });
});

describe('vehicle data objects', () => {
  const Json2iob = require('json2iob');
  const { fixtureRoutes } = require('./test/fakeAdapter');
  // Strings that look numeric but are dates, clock times or codes, not measurements.
  const TEXT_KEYS = new Set(['day', 'month', 'startTime', 'code']);

  /** @returns {string[]} key=value of every numeric-looking string outside TEXT_KEYS */
  function numericStrings(value, key = '', found = []) {
    if (typeof value === 'string') {
      if (value.trim() !== '' && Number.isFinite(Number(value)) && !TEXT_KEYS.has(key)) {
        found.push(key + '=' + value);
      }
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        numericStrings(child, Array.isArray(value) ? key : childKey, found);
      }
    }
    return found;
  }

  const FIXTURES = {
    'battery-status': ['battery-status.1.json', 'battery-status.renault_5.json'],
    cockpit: ['cockpit.zoe_50.json', 'cockpit.captur_ii.json'],
    'hvac-status': ['hvac-status.zoe_50.json', 'hvac-status.renault_5.json'],
    'charge-history': ['charge-history.day.json'],
    charges: ['charges.json'],
    'charging-settings': ['charging-settings.single.json'],
    'res-state': ['res-state.1.json'],
  };
  for (const [path, files] of Object.entries(FIXTURES)) {
    for (const file of files) {
      it(`hands no numbers as strings to json2iob for ${file}`, async () => {
        useClock();
        const adapter = setup({ ['/cars/VIN1/' + path + '?']: require('./test/fixtures/renault-api/' + file) });
        await adapter.onReady();
        const payloads = adapter.json2iob.parse
          .getCalls()
          .filter((call) => call.args[0] === 'VIN1.' + path)
          .map((call) => call.args[1]);
        expect(payloads).to.not.be.empty;
        expect(payloads.flatMap((payload) => numericStrings(payload))).to.deep.equal([]);
      });
    }
  }

  async function withObjects() {
    useClock();
    const adapter = setup(fixtureRoutes());
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    return (id) => adapter.objects.get('renault.0.VIN1.' + id)?.common;
  }

  it('gives known measurements a unit and a specific role', async () => {
    const common = await withObjects();
    expect(common('battery-status.batteryLevel')).to.include({ type: 'number', role: 'value.battery', unit: '%', write: false });
    expect(common('battery-status.batteryAutonomy')).to.include({ type: 'number', role: 'value.distance', unit: 'km', write: false });
    expect(common('battery-status.chargingRemainingTime')).to.include({ type: 'number', unit: 'min' });
    expect(common('cockpitv2.totalMileage')).to.include({ type: 'number', role: 'value.distance', unit: 'km' });
    expect(common('cockpitv2.fuelQuantity')).to.include({ type: 'number', role: 'value.fill', unit: 'l' });
    // json2iob with forceIndex names array entries <key>01, <key>02, … (checked with json2iob 2.6.25)
    expect(common('charges.charges01.chargeStartBatteryLevel')).to.include({ type: 'number', unit: '%' });
  });

  // The fixtures contain no chargingInstantaneousPower, so this test builds its own answer.
  it('gives no unit to the charging power, whose unit differs by model', async () => {
    useClock();
    const adapter = setup({
      '/cars/VIN1/battery-status?': { data: { attributes: { batteryLevel: 50, chargingInstantaneousPower: 3100 } } },
    });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    const common = adapter.objects.get('renault.0.VIN1.battery-status.chargingInstantaneousPower')?.common;
    expect(common).to.include({ type: 'number', role: 'value' });
    expect(common.unit).to.equal(undefined);
  });
});

describe('model endpoint table', () => {
  const table = require('./lib/vehicleEndpoints.json');
  const polled = (adapter, path) => urls(adapter).filter((url) => url.includes('/cars/VIN1/' + path + '?'));

  it('skips the data endpoints the model does not support', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('X102VE') });
    await adapter.onReady();
    for (const path of ['lock-status', 'res-state', 'charge-mode']) {
      expect(polled(adapter, path), path).to.deep.equal([]);
    }
    for (const path of ['battery-status', 'hvac-status', 'location', 'charge-history', 'battery-inhibition-status']) {
      expect(polled(adapter, path), path).to.have.length(1);
    }
  });

  it('asks every endpoint of a model renault-api does not document and says so once', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('ZZ99ZZ') });
    await adapter.onReady();
    await adapter.getDeviceList();
    expect(polled(adapter, 'lock-status')).to.have.length(1);
    expect(logged(adapter.log.info).filter((line) => line.includes('ZZ99ZZ'))).to.have.length(1);
  });

  it('counts only the supported endpoints in the request budget', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('X102VE') });
    const check = sinon.spy(adapter, 'checkRequestBudget');
    await adapter.onReady();
    // 11 non-history endpoints minus lock-status, res-state, charge-mode and cockpit v1
    expect(check.args).to.deep.equal([[7, 2]]);
  });

  it('holds only request variants the adapter knows', () => {
    const known = new Set(['default', 'kcm', 'kcm-pause-resume', 'kcm-settings', 'kca-stop', null]);
    const unknown = Object.entries(table.models).flatMap(([code, model]) =>
      Object.entries(model.endpoints)
        .filter(([, mode]) => !known.has(mode))
        .map(([key, mode]) => code + ' ' + key + ' ' + mode),
    );
    expect(unknown).to.deep.equal([]);
    expect(table.models.X102VE.endpoints['actions/charge-stop']).to.equal('kcm-pause-resume');
  });

  it('parses the table of renault-api', () => {
    const { parseModels } = require('./tools/updateVehicleEndpoints');
    const source = [
      '_DEFAULT_ENDPOINTS: dict[str, EndpointDefinition] = {',
      '    "actions/charge-start": EndpointDefinition(',
      '        "/kca/car-adapter/v1/cars/{vin}/actions/charging-start"',
      '    ),',
      '    "lock-status": EndpointDefinition("/kca/car-adapter/v1/cars/{vin}/lock-status"),',
      '}',
      '_KCA_ALTERNATIVE_ENDPOINTS: dict[str, EndpointDefinition] = {',
      '}',
      '_KCM_ENDPOINTS: dict[str, EndpointDefinition] = {',
      '    "actions/charge-stop-via-pause-resume": EndpointDefinition(',
      '        "/kcm/v1/vehicles/{vin}/charge/pause-resume", mode="kcm-pause-resume"',
      '    ),',
      '}',
      '',
      '_VEHICLE_ENDPOINTS: dict[str, dict[str, EndpointDefinition | None]] = {',
      '    "X102VE": {  # ZOE phase 2',
      '        "actions/charge-start": _DEFAULT_ENDPOINTS["actions/charge-start"],',
      '        "actions/charge-stop": _KCM_ENDPOINTS[  # Uses KCM pause-resume',
      '            "actions/charge-stop-via-pause-resume"',
      '        ],',
      '        # a comment line',
      '        "lock-status": None,  # default => 404',
      '    },',
      '    "XBG1VE": {',
      '        "lock-status": None,',
      '    },',
      '}',
      'VEHICLE_SPECIFICATIONS = {',
      '    "XBG1VE": {  # DACIA SPRING',
      '        "control-charge-via-kcm": True,',
      '    },',
      '}',
    ].join('\n');
    expect(parseModels(source)).to.deep.equal({
      X102VE: {
        name: 'ZOE phase 2',
        endpoints: { 'actions/charge-start': 'default', 'actions/charge-stop': 'kcm-pause-resume', 'lock-status': null },
      },
      XBG1VE: { name: '', endpoints: { 'lock-status': null } },
    });
    expect(() =>
      parseModels(source.replace('"actions/charge-stop-via-pause-resume": EndpointDefinition', '"other": EndpointDefinition')),
    ).to.throw('Unknown endpoint definition');
    expect(() => parseModels('nothing')).to.throw('_DEFAULT_ENDPOINTS not found');
  });
});

describe('charging on schedule-based vehicles', () => {
  const SETTINGS = '/kamereon/kcm/v1/vehicles/VIN1/ev/settings?country=de';
  const CURRENT = {
    mode: 'scheduled',
    programs: [
      { programId: 1, programActivationStatus: true, programName: 'night' },
      { programId: 2, programActivationStatus: false },
    ],
  };
  async function ready(get) {
    const adapter = setup({ '/vehicles?': vehicleOf('R5E1VE'), '/ev/settings': (request) => (request.method === 'post' ? {} : get) });
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    return adapter;
  }
  const calls = (adapter, method) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .filter((request) => (request.method ?? 'get') === method && request.url.includes(SETTINGS));
  const press = async (adapter) => {
    const id = 'renault.0.VIN1.remote.charging';
    await adapter.setState(id, true, false);
    await adapter.onStateChange(id, userWrite(true));
  };

  it('posts the settings back with every program switched off', async () => {
    const adapter = await ready(CURRENT);
    await press(adapter);
    expect(calls(adapter, 'get')).to.have.length(1);
    expect(calls(adapter, 'post')).to.have.length(1);
    expect(calls(adapter, 'post')[0].data).to.deep.equal({
      mode: 'scheduled',
      programs: [
        { programId: 1, programActivationStatus: false, programName: 'night' },
        { programId: 2, programActivationStatus: false },
      ],
    });
    expect(adapter.acks['VIN1.remote.charging']).to.equal(true);
  });

  it('does not change the settings it read', async () => {
    const current = structuredClone(CURRENT);
    const adapter = await ready(current);
    await press(adapter);
    expect(current).to.deep.equal(CURRENT);
  });

  for (const [name, answer] of [
    ['no programs', { mode: 'scheduled' }],
    ['programs that are no list', { programs: {} }],
    ['an empty answer', null],
    ['a failed read', httpError(403)],
  ]) {
    it(`sends nothing after ${name}`, async () => {
      const adapter = await ready(answer);
      await press(adapter);
      expect(calls(adapter, 'post')).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastError']).to.include('charging');
      expect(adapter.acks['VIN1.remote.charging']).to.equal(false);
    });
  }
});

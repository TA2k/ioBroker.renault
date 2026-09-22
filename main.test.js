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

  for (const [errorCode, errorMessage] of [
    [401030, 'Old Password Used'],
    [401020, 'Login Failed Captcha Required'],
    ['403042', 'code as string'],
  ]) {
    it(`does not retry a login rejected with ${errorCode}`, async () => {
      const adapter = setup({ 'accounts.login': { errorCode, errorMessage } });
      await adapter.onReady();
      expect(adapter.timeouts).to.have.length(0);
    });
  }

  for (const body of [
    { errorCode: 500001, errorMessage: 'General Server Error' },
    { errorCode: 403120, errorMessage: 'Account temporarily locked out' },
    { errorMessage: 'no error code' },
    { errorCode: null, errorMessage: 'null error code' },
  ]) {
    it(`retries a login that failed with ${JSON.stringify(body)}`, async () => {
      const adapter = setup({ 'accounts.login': body });
      await adapter.onReady();
      expect(adapter.loginRejected).to.equal(false);
      expect(adapter.timeouts.at(-1)?.ms).to.equal(5 * 60 * 1000);
      expect(adapter.states['info.connection']).to.equal(false);
    });
  }

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
  const press = async (adapter) => {
    await adapter.setState('renault.0.VIN1.remote.refreshAll', true, false);
    await adapter.onStateChange('renault.0.VIN1.remote.refreshAll', userWrite(true));
  };

  it('resets the button to false with ack after the poll', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    await press(adapter);
    expect(urls(adapter).some((url) => url.includes('/battery-status'))).to.equal(true);
    expect(adapter.states['VIN1.remote.refreshAll']).to.equal(false);
    expect(adapter.acks['VIN1.remote.refreshAll']).to.equal(true);
  });

  it('resets the button also when the poll is skipped because one runs', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.polling = true;
    await press(adapter);
    expect(adapter.states['VIN1.remote.refreshAll']).to.equal(false);
    expect(adapter.acks['VIN1.remote.refreshAll']).to.equal(true);
  });

  it('resets the button also when the poll fails', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.updateDevices = () => Promise.reject(new Error('boom'));
    await press(adapter).catch(() => {});
    expect(adapter.states['VIN1.remote.refreshAll']).to.equal(false);
    expect(adapter.acks['VIN1.remote.refreshAll']).to.equal(true);
  });

  it('does not throw before an account is known', async () => {
    const adapter = setup();
    await adapter.onStateChange('renault.0.VIN1.remote.refreshAll', userWrite(true));
    expect(adapter.requestClient.called).to.equal(false);
  });

  it('polls nothing while no account is known', async () => {
    const adapter = setup();
    await adapter.updateDevices();
    expect(adapter.requestClient.called).to.equal(false);
  });
});

describe('battery refresh', () => {
  const MINUTE = 60 * 1000;
  const kamereon = (adapter) => urls(adapter).filter((url) => url.includes('/kamereon/'));
  const press = (adapter, vin = 'VIN1') => adapter.onStateChange('renault.0.' + vin + '.remote.refreshBattery', userWrite(true));
  /** The pending battery refresh timer of the vehicle */
  const pending = (adapter, vin = 'VIN1') => adapter.refreshTimeouts[vin + ' battery-status'];

  async function started(routes) {
    const adapter = setup(routes);
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    return adapter;
  }

  it('resets the button at once and asks only battery-status of that vehicle without delay', async () => {
    useClock();
    const adapter = await started({ '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] } });
    await press(adapter);
    expect(adapter.states['VIN1.remote.refreshBattery']).to.equal(false);
    expect(adapter.acks['VIN1.remote.refreshBattery']).to.equal(true);
    expect(pending(adapter).ms).to.equal(0);
    await pending(adapter).fn();
    expect(kamereon(adapter)).to.have.length(1);
    expect(kamereon(adapter)[0]).to.include('/cars/VIN1/battery-status');
  });

  it('merges presses before the read into one request', async () => {
    useClock();
    const adapter = await started();
    await press(adapter);
    const first = pending(adapter);
    await press(adapter);
    expect(adapter.clearTimeout.calledWith(first)).to.equal(true);
    expect(pending(adapter).ms).to.equal(0);
    await pending(adapter).fn();
    expect(kamereon(adapter)).to.have.length(1);
  });

  it('keeps three minutes between two battery refreshes of a vehicle', async () => {
    const now = useClock();
    const adapter = await started();
    await press(adapter);
    await pending(adapter).fn();
    now.tick(30 * 1000);
    await press(adapter);
    expect(pending(adapter).ms).to.equal(3 * MINUTE - 30 * 1000);
    now.tick(3 * MINUTE);
    await press(adapter);
    expect(pending(adapter).ms).to.equal(0);
  });

  it('keeps no pending timer after the refresh ran', async () => {
    useClock();
    const adapter = await started();
    await press(adapter);
    await pending(adapter).fn();
    expect(pending(adapter)).to.equal(undefined);
  });

  it('asks nothing during the request quota pause', async () => {
    useClock();
    const adapter = await started();
    adapter.quotaPausedUntil = Date.now() + 15 * MINUTE;
    await press(adapter);
    expect(pending(adapter)).to.equal(undefined);
    expect(kamereon(adapter)).to.deep.equal([]);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('quota');
  });

  it('asks again after a full poll that runs when the refresh is due', async () => {
    useClock();
    const adapter = await started();
    adapter.polling = true;
    await press(adapter);
    const first = pending(adapter);
    await first.fn();
    expect(kamereon(adapter)).to.deep.equal([]);
    expect(pending(adapter)).to.not.equal(first);
    expect(pending(adapter).ms).to.equal(30 * 1000);
    adapter.polling = false;
    await pending(adapter).fn();
    expect(kamereon(adapter)).to.have.length(1);
  });

  it('lets a full poll wait for a running battery refresh instead of skipping it', async () => {
    useClock();
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    let calls = 0;
    const adapter = await started();
    // only the battery refresh hangs until answered, the poll after it gets its answer at once
    adapter.requestClient = setup({
      '/battery-status': () => (calls++ === 0 ? new Promise((resolve) => (answer = resolve)) : {}),
    }).requestClient;
    await press(adapter);
    const refresh = pending(adapter).fn();
    const poll = adapter.pollNow();
    expect(kamereon(adapter)).to.have.length(1);
    answer({});
    await Promise.all([refresh, poll]);
    expect(kamereon(adapter).length).to.be.greaterThan(2);
    expect(logged(adapter.log.debug).some((line) => line.includes('Poll skipped'))).to.equal(false);
    expect(adapter.polling).to.equal(false);
    expect(adapter.refreshes.size).to.equal(0);
  });

  it('lets a full poll run after a failed battery refresh', async () => {
    useClock();
    const adapter = await started();
    adapter.requestClient = setup({ '/battery-status': new Error('ECONNRESET') }).requestClient;
    await press(adapter);
    const refresh = pending(adapter).fn();
    await Promise.all([refresh, adapter.pollNow()]);
    expect(kamereon(adapter).length).to.be.greaterThan(2);
    expect(adapter.refreshes.size).to.equal(0);
  });

  it('refreshes the token once and asks battery-status again after a 401', async () => {
    useClock();
    let expired = true;
    const adapter = await started();
    adapter.requestClient = setup({ '/battery-status': () => (expired ? ((expired = false), httpError(401)) : {}) }).requestClient;
    await press(adapter);
    await pending(adapter).fn();
    expect(kamereon(adapter)).to.have.length(2);
    expect(kamereon(adapter).every((url) => url.includes('/cars/VIN1/battery-status'))).to.equal(true);
  });

  it('does not change the hourly schedule or the request budget', async () => {
    useClock();
    const adapter = await started();
    const lastHourlyPoll = adapter.lastHourlyPoll;
    await press(adapter);
    await pending(adapter).fn();
    expect(adapter.lastHourlyPoll).to.equal(lastHourlyPoll);
  });

  it('ignores a write that is not true and a vehicle that does not exist', async () => {
    useClock();
    const adapter = await started();
    await adapter.onStateChange('renault.0.VIN1.remote.refreshBattery', userWrite(false));
    await adapter.onStateChange('renault.0.VIN1.remote.refreshBattery', userWrite('true'));
    await press(adapter, 'OTHER');
    expect(adapter.refreshTimeouts).to.deep.equal({});
  });

  it('clears a pending battery refresh on unload', async () => {
    useClock();
    const adapter = await started();
    await press(adapter);
    const timer = pending(adapter);
    adapter.onUnload(() => {});
    expect(adapter.clearTimeout.calledWith(timer)).to.equal(true);
  });
});

describe('server errors', () => {
  const warnings = (adapter) => logged(adapter.log.warn).filter((line) => line.includes('server error'));

  it('warns once per endpoint and vehicle, names it, and logs repeats at debug level', async () => {
    const adapter = setup({
      '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] },
      '/hvac-settings?': httpError(502),
      '/location?': httpError(503),
    });
    await adapter.onReady();
    await adapter.updateDevices();
    await adapter.updateDevices();
    expect(warnings(adapter)).to.have.length(4);
    expect(warnings(adapter)[0]).to.include('502').and.to.include('hvac-settings').and.to.include('VIN1');
    expect(logged(adapter.log.debug).filter((line) => line.includes('server error 502 for hvac-settings'))).to.have.length(4);
  });

  it('warns again after the endpoint answered in between', async () => {
    let failing = true;
    const adapter = setup({ '/hvac-settings?': () => (failing ? httpError(502) : {}) });
    await adapter.onReady();
    failing = false;
    await adapter.updateDevices();
    expect(logged(adapter.log.info).some((line) => line.includes('hvac-settings of VIN1 answers again'))).to.equal(true);
    failing = true;
    await adapter.updateDevices();
    await adapter.updateDevices();
    expect(warnings(adapter)).to.have.length(2);
  });

  it('asks an endpoint that failed for 24 hours only hourly until it answers again', async () => {
    const now = useClock();
    let failing = true;
    const adapter = setup({ '/hvac-settings?': () => (failing ? httpError(502) : {}) });
    const asked = () => urls(adapter).filter((url) => url.includes('/hvac-settings?')).length;
    const slowed = () => logged(adapter.log.info).filter((line) => line.includes('hvac-settings of VIN1 is asked hourly'));
    await adapter.onReady();
    for (let i = 0; i < 143; i++) {
      now.tick(10 * 60 * 1000);
      await adapter.updateDevices();
    }
    // 23 h 50 min after the first error: still asked on every poll
    expect(asked()).to.equal(144);
    expect(slowed()).to.deep.equal([]);
    now.tick(10 * 60 * 1000);
    await adapter.updateDevices();
    expect(asked()).to.equal(145);
    expect(slowed()).to.have.length(1);
    for (let i = 0; i < 5; i++) {
      now.tick(10 * 60 * 1000);
      await adapter.updateDevices();
    }
    expect(asked()).to.equal(145);
    now.tick(10 * 60 * 1000);
    await adapter.updateDevices();
    expect(asked()).to.equal(146);
    expect(slowed()).to.have.length(1);
    failing = false;
    now.tick(HOUR);
    await adapter.updateDevices();
    now.tick(10 * 60 * 1000);
    await adapter.updateDevices();
    expect(asked()).to.equal(148);
  });

  it('counts the 24 hours from the first error of an unbroken series', async () => {
    const now = useClock();
    let failing = true;
    const adapter = setup({ '/hvac-settings?': () => (failing ? httpError(502) : {}) });
    const asked = () => urls(adapter).filter((url) => url.includes('/hvac-settings?')).length;
    await adapter.onReady();
    now.tick(20 * HOUR);
    failing = false;
    await adapter.updateDevices();
    failing = true;
    now.tick(10 * 60 * 1000);
    await adapter.updateDevices();
    now.tick(5 * HOUR);
    await adapter.updateDevices();
    now.tick(10 * 60 * 1000);
    await adapter.updateDevices();
    expect(asked()).to.equal(5);
  });

  it('does not report an endpoint as answering again when it never failed', async () => {
    const adapter = setup();
    await adapter.onReady();
    await adapter.updateDevices();
    expect(logged(adapter.log.info).filter((line) => line.includes('answers again'))).to.deep.equal([]);
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
    await adapter.onStateChange('renault.0.VIN1.remote.refreshAll', userWrite(true));
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
    await adapter.onStateChange('renault.0.VIN1.remote.climateStart', userWrite(true));
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
  for (const { value } of require('./admin/jsonConfig.json').items.country.options) {
    it(`finds a locale of the My Renault app for the country ${value} of the settings`, async () => {
      const adapter = setup();
      adapter.config.country = value;
      await adapter.onReady();
      expect(adapter.locale).to.match(new RegExp('^[a-z]{2}-' + value.toUpperCase() + '$'));
    });
  }

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

  for (const [name, error] of [
    ['a 429', httpError(429, {}, {})],
    ['a quota error body', httpError(500, {}, QUOTA)],
  ]) {
    it(`pauses polling when a command gets ${name}`, async () => {
      const now = useClock();
      const adapter = setup({ '/actions/hvac-start': error });
      await adapter.onReady();
      await adapter.onStateChange('renault.0.VIN1.remote.climateStart', userWrite(true));
      expect(adapter.quotaPausedUntil).to.equal(now.now + 15 * 60 * 1000);
      expect(pauses(adapter)).to.have.length(1);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('quota');
    });
  }

  it('does not pause polling for a command that fails otherwise', async () => {
    useClock();
    const adapter = setup({ '/actions/hvac-start': httpError(500) });
    await adapter.onReady();
    await adapter.onStateChange('renault.0.VIN1.remote.climateStart', userWrite(true));
    expect(adapter.quotaPausedUntil).to.equal(0);
  });

  it('keeps the pause growing when only a single read succeeds between two quota errors', async () => {
    const now = useClock();
    let overloaded = true;
    const adapter = setup({ '/battery-status': () => (overloaded ? httpError(429, {}, QUOTA) : {}) });
    await adapter.onReady();
    now.tick(DAY);
    overloaded = false;
    await adapter.updateDevices(false, { vin: 'VIN1', path: 'battery-status' });
    overloaded = true;
    await adapter.updateDevices();
    expect(pauses(adapter).map((line) => line.match(/(\d+) minutes/)?.[1])).to.deep.equal(['15', '30']);
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

  it('keeps retrying a relogin that fails with a Gigya server error', async () => {
    const adapter = await connected();
    failRefresh(adapter, { 'accounts.login': { errorCode: 500001, errorMessage: 'General Server Error' } });
    await adapter.refreshToken();
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(5 * 60 * 1000);
    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.at(-1)?.fn();
    expect(adapter.states['info.connection']).to.equal(true);
  });

  it('sends no command and tries no login after the login was rejected', async () => {
    const adapter = await connected();
    failRefresh(adapter, { 'accounts.login': { errorCode: 403042, errorMessage: 'Invalid LoginID' } });
    await adapter.refreshToken();
    await adapter.timeouts.at(-1)?.fn();
    adapter.requestClient.resetHistory();
    const timers = adapter.timeouts.length;
    await adapter.onStateChange('renault.0.VIN1.remote.climateStart', userWrite(true));
    await adapter.onStateChange('renault.0.VIN1.remote.refreshAll', userWrite(true));
    await adapter.onStateChange('renault.0.VIN1.remote.chargeLimitTarget', userWrite(80));
    expect(adapter.requestClient.called).to.equal(false);
    expect(adapter.timeouts).to.have.length(timers);
    expect(adapter.states['VIN1.remote.climateStart']).to.equal(false);
    expect(adapter.acks['VIN1.remote.climateStart']).to.equal(true);
    expect(adapter.states['VIN1.remote.refreshAll']).to.equal(false);
    expect(adapter.states['VIN1.remote.chargeLimitTarget']).to.equal(undefined);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('login was rejected');
  });

  it('keeps the target temperature writable after the login was rejected', async () => {
    const adapter = await connected();
    adapter.loginRejected = true;
    await adapter.onStateChange('renault.0.VIN1.remote.climateTemperature', userWrite(19));
    expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(19);
    expect(adapter.acks['VIN1.remote.climateTemperature']).to.equal(true);
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

  it('leaves one refresh and one vehicle list interval when the first poll already needs a relogin', async () => {
    let tokens = 0;
    // the login gets a token, the refresh after the 401 of the first poll does not
    const adapter = setup({
      'accounts.getJWT': () => (++tokens === 1 ? { id_token: 'ID_TOKEN' } : httpError(500)),
      '/battery-status': httpError(401),
    });
    await adapter.onReady();
    expect(adapter.timeouts.at(-1)?.ms).to.equal(60 * 1000);
    adapter.requestClient = setup().requestClient;
    await adapter.timeouts.at(-1)?.fn();
    const live = (ms) => adapter.intervals.filter((timer) => timer.ms === ms && !adapter.clearInterval.calledWith(timer));
    expect(live(3500 * 1000)).to.have.length(1);
    expect(live(DAY)).to.have.length(1);
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
    // 11 non-hourly endpoints minus the ignored lock-status and minus cockpit v1, plus the hourly history, pressure, charge limits and alerts
    expect(check.args).to.deep.equal([[9, 5]]);
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
  const written = (adapter, channel) => adapter.json2iob.parse.getCalls().filter((call) => call.args[0] === 'VIN1.' + channel);

  it('asks v2 first, never asks v1 when v2 answers, and writes to the cockpit channel', async () => {
    useClock();
    const adapter = setup();
    await adapter.onReady();
    await adapter.updateDevices();
    expect(v1(adapter)).to.deep.equal([]);
    expect(v2(adapter)).to.have.length(2);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
    expect(written(adapter, 'cockpit')).to.have.length(2);
    expect(written(adapter, 'cockpit')[0].args[2]).to.include({ channelName: 'Status of the car' });
    expect(written(adapter, 'cockpitv2')).to.deep.equal([]);
    expect(cockpitDeletes(adapter)).to.deep.equal([]);
  });

  it('asks v1 in the same cycle when v2 is not supported and keeps it', async () => {
    useClock();
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    expect(v1(adapter)).to.have.length(1);
    await adapter.updateDevices();
    expect(v1(adapter)).to.have.length(2);
    expect(v2(adapter)).to.have.length(1);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpit' });
    expect(written(adapter, 'cockpit')).to.have.length(2);
    expect(cockpitDeletes(adapter)).to.deep.equal([]);
  });

  it('keeps v1 after the 24-hour ignore of v2 ends', async () => {
    const now = useClock();
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    now.tick(DAY);
    await adapter.updateDevices();
    expect(v2(adapter)).to.have.length(1);
    expect(v1(adapter)).to.have.length(2);
  });

  for (const status of [500, 503]) {
    it(`asks v1 but decides nothing while v2 answers ${status}`, async () => {
      useClock();
      let failing = true;
      const adapter = setup({ '/v2/cars/VIN1/cockpit?': () => (failing ? httpError(status) : {}) });
      await adapter.onReady();
      expect(v1(adapter)).to.have.length(1);
      expect(written(adapter, 'cockpit')).to.have.length(1);
      expect(choice(adapter)).to.deep.equal({});
      expect(cockpitDeletes(adapter)).to.deep.equal([]);
      failing = false;
      await adapter.updateDevices();
      expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
      await adapter.updateDevices();
      // v2 answers again, so v1 is not asked any more
      expect(v1(adapter)).to.have.length(1);
    });
  }

  it('asks v1 while a kept v2 answers with server errors', async () => {
    useClock();
    let failing = false;
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': () => (failing ? httpError(502) : {}) });
    await adapter.onReady();
    expect(v1(adapter)).to.deep.equal([]);
    failing = true;
    await adapter.updateDevices();
    expect(v1(adapter)).to.have.length(1);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
  });

  for (const status of [401, 429]) {
    it(`asks no v1, decides nothing and deletes nothing when v2 answers ${status}`, async () => {
      useClock();
      let tokens = 0;
      const adapter = setup({
        '/v2/cars/VIN1/cockpit?': httpError(status),
        // the login gets a token, the refresh after the 401 fails, so the cycle ends there
        'accounts.getJWT': () => (tokens++ === 0 ? { id_token: 'ID_TOKEN' } : httpError(500)),
      });
      await adapter.onReady();
      expect(v1(adapter)).to.deep.equal([]);
      expect(cockpitDeletes(adapter)).to.deep.equal([]);
      expect(choice(adapter)).to.deep.equal({});
    });
  }

  it('decides nothing when neither version is supported', async () => {
    useClock();
    const adapter = setup({ '/cars/VIN1/cockpit?': httpError(404) });
    await adapter.onReady();
    expect(v1(adapter)).to.have.length(1);
    expect(choice(adapter)).to.deep.equal({});
  });

  /** @type {[string, (adapter: any) => string[], (adapter: any) => string[]][]} */
  const storedChoices = [
    ['cockpitv2', v2, v1],
    ['cockpit', v1, v2],
  ];
  for (const [stored, asked, skipped] of storedChoices) {
    it(`uses the stored choice ${stored} after a restart without asking the other version`, async () => {
      useClock();
      const adapter = setup();
      adapter.states['info.cockpitVersion'] = JSON.stringify({ VIN1: stored });
      await adapter.onReady();
      expect(asked(adapter)).to.have.length(1);
      expect(skipped(adapter)).to.deep.equal([]);
      expect(written(adapter, 'cockpit')).to.have.length(1);
    });
  }

  for (const stored of ['not json', '[]', 'null', JSON.stringify({ VIN1: 'cockpitv3' })]) {
    it(`ignores the invalid stored value ${stored}`, async () => {
      useClock();
      const adapter = setup();
      adapter.states['info.cockpitVersion'] = stored;
      await adapter.onReady();
      expect(v1(adapter)).to.deep.equal([]);
      expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpitv2' });
    });
  }

  it('removes the cockpitv2 channel of older versions once and keeps the cockpit channel', async () => {
    useClock();
    const adapter = setup();
    for (const id of ['VIN1.cockpit', 'VIN1.cockpit.totalMileage', 'VIN1.cockpitv2', 'VIN1.cockpitv2.message']) {
      adapter.objects.set('renault.0.' + id, { _id: 'renault.0.' + id, type: 'state', common: {}, native: {} });
    }
    await adapter.onReady();
    await adapter.getDeviceList();
    expect(cockpitDeletes(adapter)).to.deep.equal(['VIN1.cockpitv2']);
    expect(adapter.objects.has('renault.0.VIN1.cockpitv2.message')).to.equal(false);
    expect(adapter.objects.has('renault.0.VIN1.cockpit.totalMileage')).to.equal(true);
  });

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
  /** @type {[string | undefined, string, string, object][]} model code (undefined = not documented), button, url, body */
  const cases = [
    [undefined, 'climateStart', KCA_HVAC, { type: 'HvacStart', attributes: { action: 'start', targetTemperature: 21 } }],
    [undefined, 'climateStop', KCA_HVAC, { type: 'HvacStart', attributes: { action: 'cancel' } }],
    ['XBG1VE', 'climateStop', KCA_HVAC, { type: 'HvacStart', attributes: { action: 'stop' } }],
    [undefined, 'chargingStart', KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'start' } }],
    [undefined, 'chargingStop', KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'stop' } }],
    ['X102VE', 'chargingStart', KCA_CHARGE, { type: 'ChargingStart', attributes: { action: 'start' } }],
    ['X102VE', 'chargingStop', KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'pause' } }],
    ['XBG1VE', 'chargingStart', KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'resume' } }],
    ['XBG1VE', 'chargingStop', KCM_PAUSE, { type: 'ChargePauseResume', attributes: { action: 'pause' } }],
    ['XCB1VE', 'chargingStart', '/kamereon/kcm/v1/vehicles/VIN1/charge/start?', { type: 'ChargingStart', attributes: { action: 'start' } }],
  ];
  for (const [code, path, url, body] of cases) {
    it(`sends ${path} for model ${code ?? 'unknown'} and resets the button`, async () => {
      const adapter = await ready({}, code);
      await write(adapter, path, true);
      expect(posts(adapter)).to.have.length(1);
      expect(posts(adapter)[0].url)
        .to.include(url)
        .and.to.match(/country=de$/);
      expect(posts(adapter)[0].data).to.deep.equal({ data: body });
      expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
      expect(adapter.acks['VIN1.remote.' + path]).to.equal(true);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.equal('');
      expect(adapter.timeouts.at(-1)?.ms).to.equal(20 * 1000);
    });
  }

  for (const code of ['XCB1VE', 'R5E1VE', 'A5E1AE']) {
    it(`creates no chargingStop and sends nothing for it on model ${code}, which cannot stop`, async () => {
      const adapter = await ready({}, code);
      expect(adapter.objects.has('renault.0.VIN1.remote.chargingStop')).to.equal(false);
      await write(adapter, 'chargingStop', true);
      expect(adapter.requestClient.called).to.equal(false);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargingStop is not supported');
      expect(adapter.acks['VIN1.remote.chargingStop']).to.equal(true);
    });
  }

  it('sends nothing for a command the model does not support', async () => {
    const adapter = await ready({}, 'XJA1VP');
    await write(adapter, 'chargingStart', true);
    await write(adapter, 'climateStart', true);
    expect(adapter.requestClient.called).to.equal(false);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('climateStart is not supported');
  });

  for (const val of ['true', 1, null]) {
    it(`rejects the button value ${JSON.stringify(val)} and resets the button`, async () => {
      const adapter = await ready();
      await write(adapter, 'chargingStart', val);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('takes true');
      expect(adapter.states['VIN1.remote.chargingStart']).to.equal(false);
      expect(adapter.acks['VIN1.remote.chargingStart']).to.equal(true);
    });
  }

  it('sends nothing and reports nothing for a button written with false', async () => {
    const adapter = await ready();
    await write(adapter, 'chargingStop', false);
    expect(posts(adapter)).to.deep.equal([]);
    expect(adapter.log.warn.called).to.equal(false);
    expect(adapter.acks['VIN1.remote.chargingStop']).to.equal(true);
  });

  it('records a failed command and resets the button', async () => {
    const error = httpError(403, {}, { errors: [{ errorCode: 'err.func.wired.forbidden' }] });
    const adapter = await ready({ '/actions/charging-start': error });
    await write(adapter, 'chargingStart', true);
    expect(adapter.states['VIN1.remote.chargingStart']).to.equal(false);
    expect(adapter.acks['VIN1.remote.chargingStart']).to.equal(true);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargingStart').and.to.include('err.func.wired.forbidden');
    expect(adapter.timeouts.at(-1)?.ms).to.equal(20 * 1000);
  });

  for (const temperature of [NaN, 'abc', 0, -1, Infinity, '21']) {
    it(`does not start the climate control with target temperature ${String(temperature)}`, async () => {
      const adapter = await ready();
      adapter.states['VIN1.remote.climateTemperature'] = temperature;
      await write(adapter, 'climateStart', true);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('climateTemperature');
    });
  }

  for (const temperature of [0.1, 21, 30]) {
    it(`starts the climate control with target temperature ${temperature}`, async () => {
      const adapter = await ready();
      adapter.states['VIN1.remote.climateTemperature'] = temperature;
      await write(adapter, 'climateStart', true);
      expect(posts(adapter)[0].data.data.attributes.targetTemperature).to.equal(temperature);
    });
  }

  it('does not check the temperature when the climate control is stopped', async () => {
    const adapter = await ready();
    adapter.states['VIN1.remote.climateTemperature'] = NaN;
    await write(adapter, 'climateStop', true);
    expect(posts(adapter)).to.have.length(1);
  });

  it('confirms a valid target temperature and rejects an invalid one', async () => {
    const adapter = await ready();
    await write(adapter, 'climateTemperature', 22);
    expect(adapter.acks['VIN1.remote.climateTemperature']).to.equal(true);
    await write(adapter, 'climateTemperature', 0);
    expect(adapter.acks['VIN1.remote.climateTemperature']).to.equal(false);
    expect(logged(adapter.log.warn).some((line) => line.includes('climateTemperature'))).to.equal(true);
    expect(posts(adapter)).to.deep.equal([]);
  });

  for (const id of [
    'renault.0.VIN1.remote.unknown',
    'renault.0.VIN1.remote.lastCommandError',
    'renault.0.VIN1.remote.toString',
    'renault.0.VIN1.remote.toStringStart',
    'renault.0.VIN1.remote.Start',
    'renault.0.VIN1.remote.hvac-start',
    'renault.0.VIN1.general.vin',
    'renault.0.OTHER.remote.chargingStart',
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
      'renault.0.VIN1.remote.chargingStart',
      /** @type {ioBroker.State} */ (/** @type {unknown} */ ({ val: true, ack: true })),
    );
    expect(posts(adapter)).to.deep.equal([]);
  });
});

describe('target temperature', () => {
  it('declares 21 °C as default and writes it when the state is empty', async () => {
    const adapter = setup();
    await adapter.onReady();
    expect(adapter.objects.get('renault.0.VIN1.remote.climateTemperature')?.common).to.include({ def: 21 });
    expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(21);
    expect(adapter.acks['VIN1.remote.climateTemperature']).to.equal(true);
  });

  for (const empty of [null, undefined]) {
    it(`writes the default over a stored ${empty}`, async () => {
      const adapter = setup();
      adapter.states['VIN1.remote.climateTemperature'] = empty;
      await adapter.onReady();
      expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(21);
    });
  }

  for (const kept of [18, 0]) {
    it(`keeps a stored value ${kept}`, async () => {
      const adapter = setup();
      adapter.states['VIN1.remote.climateTemperature'] = kept;
      await adapter.onReady();
      await adapter.getDeviceList();
      expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(kept);
    });
  }

  it('takes over the temperature of hvac-temperature from earlier versions', async () => {
    const adapter = setup();
    adapter.states['VIN1.remote.hvac-temperature'] = 18;
    await adapter.onReady();
    expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(18);
  });

  for (const invalid of [0, -1, NaN, '19', null]) {
    it(`writes the default instead of the earlier hvac-temperature ${String(invalid)}`, async () => {
      const adapter = setup();
      adapter.states['VIN1.remote.hvac-temperature'] = invalid;
      await adapter.onReady();
      expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(21);
    });
  }

  it('does not overwrite climateTemperature with the earlier hvac-temperature', async () => {
    const adapter = setup();
    adapter.states['VIN1.remote.hvac-temperature'] = 18;
    adapter.states['VIN1.remote.climateTemperature'] = 23;
    await adapter.onReady();
    expect(adapter.states['VIN1.remote.climateTemperature']).to.equal(23);
  });

  it('writes no temperature for a model without climate control', async () => {
    const adapter = setup({ '/vehicles?': vehicleOf('XJA1VP') });
    await adapter.onReady();
    expect(adapter.states).to.not.have.property('VIN1.remote.climateTemperature');
  });
});

describe('remote objects', () => {
  const common = (adapter, id) => adapter.objects.get('renault.0.VIN1.remote.' + id)?.common;
  const remoteIds = (adapter) =>
    [...adapter.objects.keys()]
      .filter((id) => id.startsWith('renault.0.VIN1.remote.'))
      .map((id) => id.slice('renault.0.VIN1.remote.'.length))
      .sort();
  const deletedRemote = (adapter) => adapter.deleted.filter((id) => id.startsWith('VIN1.remote.'));

  it('creates the remote states with roles that match their use', async () => {
    const adapter = setup();
    await adapter.onReady();
    for (const id of ['climateStart', 'chargingStart']) {
      expect(common(adapter, id)).to.include({ type: 'boolean', role: 'button.start', read: false, write: true });
    }
    for (const id of ['climateStop', 'chargingStop']) {
      expect(common(adapter, id)).to.include({ type: 'boolean', role: 'button.stop', read: false, write: true });
    }
    expect(common(adapter, 'climateTemperature')).to.include({
      type: 'number',
      role: 'level.temperature',
      unit: '°C',
      read: true,
      write: true,
    });
    expect(common(adapter, 'refreshAll')).to.include({ type: 'boolean', role: 'button', read: false, write: true });
    expect(common(adapter, 'refreshBattery')).to.include({ type: 'boolean', role: 'button', read: false, write: true });
    expect(common(adapter, 'lastCommandError')).to.include({ type: 'string', role: 'text', read: true, write: false });
  });

  it('keeps a renamed remote state and writes no unchanged object on the daily reload', async () => {
    const adapter = setup();
    await adapter.onReady();
    await adapter.extendObjectAsync('VIN1.remote.climateStart', { common: { name: 'Heizung an' } });
    const extend = sinon.spy(adapter, 'extendObjectAsync');
    await adapter.getDeviceList();
    expect(common(adapter, 'climateStart').name).to.equal('Heizung an');
    expect(extend.getCalls().filter((call) => String(call.args[0]).includes('.remote.'))).to.deep.equal([]);
  });

  it('replaces the states of 0.0.25 once', async () => {
    const legacy = ['actions/hvac-start', 'actions/charging-start', 'charge/pause-resume', 'charge/start', 'hvac-temperature', 'refresh'];
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
    expect(deletedRemote(adapter)).to.deep.equal(legacy.map((id) => 'VIN1.remote.' + id));
    expect(remoteIds(adapter)).to.deep.equal([
      'askForLocationRefresh',
      'chargeLimitMin',
      'chargeLimitTarget',
      'chargeMode',
      'chargingStart',
      'chargingStop',
      'climateStart',
      'climateStop',
      'climateTemperature',
      'hornStart',
      'lastCommandError',
      'lightsStart',
      'refreshAll',
      'refreshBattery',
      'refreshClimate',
      'refreshLocation',
    ]);
    const removals = logged(adapter.log.info).filter((line) => line.startsWith('Removed VIN1.remote.'));
    expect(removals).to.have.length(legacy.length);
    expect(removals.find((line) => line.includes('.actions/hvac-start,'))).to.include('climateStart and climateStop');
    await adapter.getDeviceList();
    expect(deletedRemote(adapter)).to.have.length(legacy.length);
  });

  it('creates only the buttons the model supports', async () => {
    const ids = async (code) => {
      const adapter = setup({ '/vehicles?': vehicleOf(code) });
      await adapter.onReady();
      return remoteIds(adapter);
    };
    const sorted = (...list) => list.sort();
    const always = ['lastCommandError', 'refreshAll'];
    const location = ['refreshLocation', 'askForLocationRefresh'];
    const battery = ['refreshBattery'];
    const climate = ['refreshClimate'];
    const commands = ['chargingStart', 'chargingStop', 'climateStart', 'climateStop', 'climateTemperature'];
    // renault-api does not list charge-set-mode for the Zoe phase 2 and the XJA1VP, nor
    // refresh-location for any of these, so they get the default
    expect(await ids('X102VE')).to.deep.equal(sorted('chargeMode', ...location, ...battery, ...climate, ...commands, ...always));
    expect(await ids('R5E1VE')).to.deep.equal(
      sorted(
        'chargeLimitMin',
        'chargeLimitTarget',
        'hornStart',
        'lightsStart',
        ...location,
        ...battery,
        ...climate,
        ...commands.filter((id) => id !== 'chargingStop'),
        ...always,
      ),
    );
    // the XJA1VP has neither battery-status nor hvac-status, so it gets no battery or climate button
    expect(await ids('XJA1VP')).to.deep.equal(sorted('chargeMode', ...location, ...always));
  });

  it('removes command states the model does not support', async () => {
    const adapter = setup({ '/vehicles?': vehicleOf('XJA1VP') });
    for (const id of ['climateStart', 'climateStop', 'climateTemperature', 'chargingStart', 'chargingStop']) {
      adapter.objects.set('renault.0.VIN1.remote.' + id, { _id: 'renault.0.VIN1.remote.' + id, type: 'state', common: {}, native: {} });
    }
    await adapter.onReady();
    expect(deletedRemote(adapter)).to.deep.equal([
      'VIN1.remote.climateStart',
      'VIN1.remote.climateStop',
      'VIN1.remote.chargingStart',
      'VIN1.remote.chargingStop',
      'VIN1.remote.climateTemperature',
    ]);
    expect(common(adapter, 'refreshAll')).to.not.equal(undefined);
  });

  it('sends nothing for a write to a removed command state', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    for (const id of ['actions/hvac-start', 'hvac-start', 'charging', 'refresh']) {
      await adapter.onStateChange('renault.0.VIN1.remote.' + id, userWrite(true));
    }
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
    pressure: ['pressure.json'],
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
    expect(common('cockpit.totalMileage')).to.include({ type: 'number', role: 'value.distance', unit: 'km' });
    expect(common('cockpit.fuelQuantity')).to.include({ type: 'number', role: 'value.fill', unit: 'l' });
    // json2iob with forceIndex names array entries <key>01, <key>02, … (checked with json2iob 2.6.25)
    expect(common('charges.charges01.chargeStartBatteryLevel')).to.include({ type: 'number', unit: '%' });
  });

  it('names the plug and charging status codes', async () => {
    const common = await withObjects();
    expect(common('battery-status.plugStatus').states).to.include({ 0: 'unplugged', 1: 'plugged', '-2147483648': 'unknown' });
    expect(common('battery-status.chargingStatus').states).to.include({
      0: 'not charging',
      0.1: 'waiting for a planned charge',
      1: 'charging',
      '-1.1': 'unavailable',
    });
  });

  it('keeps an unknown status code of one vehicle out of the states of the next', async () => {
    useClock();
    const adapter = setup({
      '/vehicles?': { vehicleLinks: [{ vin: 'VIN1' }, { vin: 'VIN2' }] },
      '/cars/VIN1/battery-status?': { data: { attributes: { chargingStatus: 0.7 } } },
      '/cars/VIN2/battery-status?': { data: { attributes: { chargingStatus: 1 } } },
    });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    const states = (vin) => adapter.objects.get('renault.0.' + vin + '.battery-status.chargingStatus')?.common.states;
    expect(states('VIN1')).to.include({ 0.7: 0.7 });
    expect(states('VIN2')).to.not.have.property('0.7');
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
    // 11 non-hourly endpoints minus lock-status, res-state, charge-mode and cockpit v1; history, pressure and alerts hourly
    expect(check.args).to.deep.equal([[7, 4]]);
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

  it('matches the model table in the README', () => {
    const { modelTable, replaceModelTable } = require('./tools/updateVehicleEndpoints');
    const readme = require('node:fs').readFileSync(require.resolve('./README.md'), 'utf8');
    expect(replaceModelTable(readme, modelTable(table.models))).to.equal(readme);
  });

  it('marks a column yes only when the model lists every key of it as supported', () => {
    const { modelTable, replaceModelTable } = require('./tools/updateVehicleEndpoints');
    const rows = modelTable({
      A: { name: 'All', endpoints: { 'actions/horn-start': 'default', 'actions/lights-start': 'default' } },
      B: { name: 'Half', endpoints: { 'actions/horn-start': 'default' } },
      C: { name: 'None', endpoints: { 'actions/horn-start': 'default', 'actions/lights-start': null } },
    }).split('\n');
    const horn = (row) => row.split('|')[9].trim();
    expect(rows.slice(4).map(horn)).to.deep.equal(['yes', '?', 'no']);
    expect(horn(rows[2])).to.equal('Horn / lights');
    expect(() => replaceModelTable('no markers', '')).to.throw('markers');
  });

  it('groups the model table by brand, with Renault for models named without one', () => {
    const { modelTable } = require('./tools/updateVehicleEndpoints');
    const names = ['Alpine A290', 'DACIA SPRING', 'ZOE phase 2', 'Dacia Duster III', 'Renault 5', 'Daciaville'];
    const table = modelTable(Object.fromEntries(names.map((name, index) => ['C' + index, { name, endpoints: {} }])));
    /** @type {Record<string, string[]>} */
    const byBrand = {};
    let brand = '';
    for (const line of table.split('\n')) {
      if (line.startsWith('### ')) {
        brand = line.slice(4);
        byBrand[brand] = [];
      } else if (/ \| C\d /.test(line)) {
        byBrand[brand].push(line.split('|')[1].trim());
      }
    }
    expect(byBrand).to.deep.equal({
      Renault: ['Daciaville', 'Renault 5', 'ZOE phase 2'],
      Dacia: ['Dacia Duster III', 'DACIA SPRING'],
      Alpine: ['Alpine A290'],
    });
    expect(modelTable({})).to.equal('');
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
    const id = 'renault.0.VIN1.remote.chargingStart';
    await adapter.setState(id, true, false);
    await adapter.onStateChange(id, userWrite(true));
  };

  it('pauses polling and posts nothing when reading the settings gets a 429', async () => {
    useClock();
    const adapter = await ready(httpError(429, {}, {}));
    await press(adapter);
    expect(calls(adapter, 'post')).to.deep.equal([]);
    expect(adapter.quotaPausedUntil).to.be.greaterThan(Date.now());
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('quota');
  });

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
    expect(adapter.acks['VIN1.remote.chargingStart']).to.equal(true);
    expect(adapter.states['VIN1.remote.chargingStart']).to.equal(false);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.equal('');
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
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargingStart');
      expect(adapter.acks['VIN1.remote.chargingStart']).to.equal(true);
    });
  }
});

describe('answers without data', () => {
  const PLACEHOLDER = { message: 'you should not be there but well done for the effort' };
  const v1 = (adapter) => urls(adapter).filter((url) => url.includes('/v1/cars/VIN1/cockpit?'));
  const v2 = (adapter) => urls(adapter).filter((url) => url.includes('/v2/cars/VIN1/cockpit?'));
  const choice = (adapter) => JSON.parse(adapter.states['info.cockpitVersion'] ?? '{}');
  const parsed = (adapter, path) => adapter.json2iob.parse.getCalls().filter((call) => call.args[0] === 'VIN1.' + path);

  it('keeps cockpit v1 when v2 answers with a message only (Zoe phase 2)', async () => {
    useClock();
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': PLACEHOLDER });
    await adapter.onReady();
    await adapter.updateDevices();
    expect(parsed(adapter, 'cockpitv2')).to.deep.equal([]);
    expect(parsed(adapter, 'cockpit')).to.have.length(2);
    expect(adapter.deleted.filter((id) => id.includes('cockpit'))).to.deep.equal([]);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpit' });
    expect(v1(adapter)).to.have.length(2);
    expect(v2(adapter)).to.have.length(1);
    expect(logged(adapter.log.info).some((line) => line.includes('Ignore cockpitv2 for 24 hours'))).to.equal(true);
  });

  it('drops a stored cockpit choice whose version answers without data and switches to v1', async () => {
    useClock();
    const adapter = setup({ '/v2/cars/VIN1/cockpit?': PLACEHOLDER });
    adapter.states['info.cockpitVersion'] = JSON.stringify({ VIN1: 'cockpitv2' });
    await adapter.onReady();
    expect(v1(adapter)).to.have.length(1);
    expect(choice(adapter)).to.deep.equal({ VIN1: 'cockpit' });
    await adapter.updateDevices();
    expect(v1(adapter)).to.have.length(2);
    expect(v2(adapter)).to.have.length(1);
  });

  it('ignores any endpoint that answers with a message only for 24 hours', async () => {
    const now = useClock();
    const adapter = setup({ '/location?': PLACEHOLDER });
    await adapter.onReady();
    now.tick(DAY - 1);
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('/location?'))).to.have.length(1);
    expect(parsed(adapter, 'location')).to.deep.equal([]);
    now.tick(1);
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('/location?'))).to.have.length(2);
  });

  it('keeps polling an endpoint that answered with data before', async () => {
    useClock();
    let empty = false;
    const adapter = setup({ '/location?': () => (empty ? PLACEHOLDER : { data: { attributes: { gpsLatitude: 1 } } }) });
    await adapter.onReady();
    empty = true;
    await adapter.updateDevices();
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes('/location?'))).to.have.length(3);
  });

  for (const [name, body] of [
    ['a message next to data', { message: 'note', data: { attributes: { gpsLatitude: 1 } } }],
    ['a message that is no string', { message: 5 }],
    ['an empty object', {}],
  ]) {
    it(`treats ${name} as an answer`, async () => {
      useClock();
      const adapter = setup({ '/location?': body });
      await adapter.onReady();
      expect(parsed(adapter, 'location')).to.have.length(1);
      expect(adapter.ignoreState.VIN1.location).to.equal(undefined);
    });
  }
});

describe('tyre pressure', () => {
  const Json2iob = require('json2iob');
  const { fixtureRoutes } = require('./test/fakeAdapter');
  const pressure = (adapter) => urls(adapter).filter((url) => url.includes('/kca/car-adapter/v1/cars/VIN1/pressure?'));

  it('reads the tyre pressure once per hour', async () => {
    const now = useClock();
    const adapter = setup();
    await adapter.onReady();
    now.tick(HOUR - 1);
    await adapter.updateDevices();
    expect(pressure(adapter)).to.have.length(1);
    now.tick(1);
    await adapter.updateDevices();
    expect(pressure(adapter)).to.have.length(2);
  });

  it('writes the pressures in mbar with the pressure role', async () => {
    useClock();
    const adapter = setup(fixtureRoutes());
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    for (const key of ['flPressure', 'frPressure', 'rlPressure', 'rrPressure']) {
      expect(adapter.objects.get('renault.0.VIN1.pressure.' + key)?.common, key).to.include({
        type: 'number',
        role: 'value.pressure',
        unit: 'mbar',
        write: false,
      });
    }
    expect(adapter.objects.get('renault.0.VIN1.pressure')?.common.name).to.equal('Tyre pressure');
  });

  it('does not ask a model without tyre pressure', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('R5E1VE') });
    await adapter.onReady();
    expect(pressure(adapter)).to.deep.equal([]);
  });

  it('stops asking a car that rejects the tyre pressure', async () => {
    const now = useClock();
    const adapter = setup({ '/pressure?': httpError(404) });
    await adapter.onReady();
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(pressure(adapter)).to.have.length(1);
  });
});

describe('charge limits', () => {
  const SOC = '/kamereon/kcm/v1/vehicles/VIN1/ev/soc-levels?country=de';
  const LEVELS = { socMin: 20, socTarget: 80 };
  async function ready(routes = {}) {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('R5E1VE'), '/ev/soc-levels': LEVELS, ...routes });
    await adapter.onReady();
    adapter.states['VIN1.soc-levels.socMin'] = 20;
    adapter.states['VIN1.soc-levels.socTarget'] = 80;
    adapter.requestClient.resetHistory();
    return adapter;
  }
  const posts = (adapter) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .filter((request) => request.method === 'post');
  const write = async (adapter, path, val) => {
    const id = 'renault.0.VIN1.remote.' + path;
    await adapter.setState(id, val, false);
    await adapter.onStateChange(id, userWrite(val));
  };

  it('reads the charge limits once per hour', async () => {
    const now = useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('R5E1VE'), '/ev/soc-levels': LEVELS });
    await adapter.onReady();
    expect(adapter.json2iob.parse.calledWith('VIN1.soc-levels', LEVELS)).to.equal(true);
    now.tick(HOUR - 1);
    await adapter.updateDevices();
    expect(urls(adapter).filter((url) => url.includes(SOC))).to.have.length(1);
  });

  it('does not ask or create the charge limits on a model without them', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('X102VE') });
    adapter.objects.set('renault.0.VIN1.remote.chargeLimitMin', { common: {} });
    await adapter.onReady();
    expect(urls(adapter).filter((url) => url.includes('/ev/soc-levels'))).to.deep.equal([]);
    expect(adapter.objects.has('renault.0.VIN1.remote.chargeLimitMin')).to.equal(false);
    expect(adapter.objects.has('renault.0.VIN1.remote.chargeLimitTarget')).to.equal(false);
  });

  it('shows the limits the car reports in the remote states', async () => {
    const adapter = await ready({ '/ev/soc-levels': { socMin: 15, socTarget: 100 } });
    expect(adapter.states['VIN1.remote.chargeLimitMin']).to.equal(15);
    expect(adapter.states['VIN1.remote.chargeLimitTarget']).to.equal(100);
    expect(adapter.acks['VIN1.remote.chargeLimitMin']).to.equal(true);
  });

  for (const levels of [{ socMin: 10, socTarget: 105 }, { socMin: 17, socTarget: 99 }, { socMin: '20', socTarget: null }, {}]) {
    it(`leaves the remote states alone when the car reports ${JSON.stringify(levels)}`, async () => {
      const adapter = await ready({ '/ev/soc-levels': levels });
      expect(adapter.states).to.not.have.property('VIN1.remote.chargeLimitMin');
      expect(adapter.states).to.not.have.property('VIN1.remote.chargeLimitTarget');
    });
  }

  it('sends the new target with the known minimum and confirms it', async () => {
    const adapter = await ready();
    await write(adapter, 'chargeLimitTarget', 90);
    expect(posts(adapter)).to.have.length(1);
    expect(posts(adapter)[0].url).to.include(SOC);
    expect(posts(adapter)[0].data).to.deep.equal({ socMin: 20, socTarget: 90 });
    expect(adapter.acks['VIN1.remote.chargeLimitTarget']).to.equal(true);
    expect(adapter.states['VIN1.soc-levels.socTarget']).to.equal(90);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.equal('');
  });

  it('sends the new minimum with the known target', async () => {
    const adapter = await ready();
    await write(adapter, 'chargeLimitMin', 30);
    expect(posts(adapter)[0].data).to.deep.equal({ socMin: 30, socTarget: 80 });
    expect(adapter.states['VIN1.soc-levels.socMin']).to.equal(30);
  });

  for (const [path, val] of [
    ['chargeLimitMin', 15],
    ['chargeLimitMin', 45],
    ['chargeLimitTarget', 55],
    ['chargeLimitTarget', 100],
  ]) {
    it(`accepts ${path} = ${val}`, async () => {
      const adapter = await ready();
      await write(adapter, path, val);
      expect(posts(adapter)).to.have.length(1);
    });
  }

  for (const [path, val] of [
    ['chargeLimitMin', 10],
    ['chargeLimitMin', 50],
    ['chargeLimitMin', 17],
    ['chargeLimitMin', 15.5],
    ['chargeLimitMin', '20'],
    ['chargeLimitMin', NaN],
    ['chargeLimitMin', Infinity],
    ['chargeLimitMin', null],
    ['chargeLimitMin', true],
    ['chargeLimitTarget', 50],
    ['chargeLimitTarget', 105],
    ['chargeLimitTarget', 99],
  ]) {
    it(`rejects ${path} = ${String(val)}`, async () => {
      const adapter = await ready();
      await write(adapter, path, val);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.acks['VIN1.remote.' + path]).to.equal(false);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include(path);
    });
  }

  for (const other of [undefined, null, '20', 12]) {
    it(`sends nothing while the other limit is ${String(other)}`, async () => {
      const adapter = await ready();
      adapter.states['VIN1.soc-levels.socMin'] = other;
      if (other === undefined) {
        delete adapter.states['VIN1.soc-levels.socMin'];
      }
      await write(adapter, 'chargeLimitTarget', 90);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('not known');
    });
  }

  it('keeps the read value when the cloud refuses the change', async () => {
    const adapter = await ready({ '/ev/soc-levels': (request) => (request.method === 'post' ? httpError(403) : LEVELS) });
    await write(adapter, 'chargeLimitTarget', 90);
    expect(adapter.acks['VIN1.remote.chargeLimitTarget']).to.equal(false);
    expect(adapter.states['VIN1.soc-levels.socTarget']).to.equal(80);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargeLimitTarget');
  });

  it('creates the limit states with range, step and unit', async () => {
    const adapter = await ready();
    expect(adapter.objects.get('renault.0.VIN1.remote.chargeLimitMin')?.common).to.include({
      type: 'number',
      role: 'level',
      unit: '%',
      min: 15,
      max: 45,
      step: 5,
      read: true,
      write: true,
    });
    expect(adapter.objects.get('renault.0.VIN1.remote.chargeLimitTarget')?.common).to.include({ min: 55, max: 100, step: 5 });
  });
});

describe('charge mode', () => {
  /**
   * @param {string} [code] model code of VIN1
   * @param {Record<string, unknown>} [routes]
   */
  async function ready(code = undefined, routes = {}) {
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
  const write = async (adapter, val) => {
    const id = 'renault.0.VIN1.remote.chargeMode';
    await adapter.setState(id, val, false);
    await adapter.onStateChange(id, userWrite(val));
  };

  it('shows the charge mode the car reports', async () => {
    const adapter = await ready(undefined, { '/charge-mode?': { data: { attributes: { chargeMode: 'always_charging' } } } });
    expect(adapter.states['VIN1.remote.chargeMode']).to.equal('always_charging');
    expect(adapter.acks['VIN1.remote.chargeMode']).to.equal(true);
  });

  for (const chargeMode of ['ALWAYS', '', 'toString', 7, null]) {
    it(`does not show the reported charge mode ${JSON.stringify(chargeMode)}`, async () => {
      const adapter = await ready(undefined, { '/charge-mode?': { data: { attributes: { chargeMode } } } });
      expect(adapter.states).to.not.have.property('VIN1.remote.chargeMode');
    });
  }

  it('writes no charge mode state without its object', async () => {
    useClock();
    const adapter = await ready(undefined, { '/charge-mode?': { data: { attributes: { chargeMode: 'always' } } } });
    delete adapter.states['VIN1.remote.chargeMode'];
    await adapter.delObjectAsync('VIN1.remote.chargeMode');
    await adapter.updateDevices();
    expect(adapter.states).to.not.have.property('VIN1.remote.chargeMode');
  });

  for (const mode of ['always', 'always_charging', 'schedule_mode', 'scheduled']) {
    it(`sets the charge mode ${mode} and confirms it`, async () => {
      const adapter = await ready();
      await write(adapter, mode);
      expect(posts(adapter)).to.have.length(1);
      expect(posts(adapter)[0].url).to.include('/kamereon/kca/car-adapter/v1/cars/VIN1/actions/charge-mode?country=de');
      expect(posts(adapter)[0].data).to.deep.equal({ data: { type: 'ChargeMode', attributes: { action: mode } } });
      expect(adapter.acks['VIN1.remote.chargeMode']).to.equal(true);
    });
  }

  for (const mode of ['ALWAYS', '', 'toString', 'always ', 1, null, true]) {
    it(`rejects the charge mode ${JSON.stringify(mode)}`, async () => {
      const adapter = await ready();
      await write(adapter, mode);
      expect(posts(adapter)).to.deep.equal([]);
      expect(adapter.acks['VIN1.remote.chargeMode']).to.equal(false);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargeMode');
    });
  }

  it('leaves the state unconfirmed when the cloud refuses the mode', async () => {
    const adapter = await ready(undefined, { '/actions/charge-mode': httpError(400) });
    await write(adapter, 'always');
    expect(adapter.acks['VIN1.remote.chargeMode']).to.equal(false);
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('chargeMode');
  });

  it('creates the state with the allowed values', async () => {
    const adapter = await ready();
    const common = adapter.objects.get('renault.0.VIN1.remote.chargeMode')?.common;
    expect(common).to.include({ type: 'string', role: 'text', read: true, write: true });
    expect(Object.keys(common.states)).to.deep.equal(['always', 'always_charging', 'schedule_mode', 'scheduled']);
  });

  it('does not create the state on a model without charge mode', async () => {
    const adapter = await ready('R5E1VE');
    expect(adapter.objects.has('renault.0.VIN1.remote.chargeMode')).to.equal(false);
    await adapter.onStateChange('renault.0.VIN1.remote.chargeMode', userWrite('always'));
    expect(posts(adapter)).to.deep.equal([]);
  });
});

describe('horn, lights and location', () => {
  const HORN_LIGHTS = '/kamereon/kca/car-adapter/v1/cars/VIN1/actions/horn-lights?';
  /** @type {[string, string, object][]} button, url, body */
  const cases = [
    ['hornStart', HORN_LIGHTS, { type: 'HornLights', attributes: { action: 'start', target: 'horn' } }],
    ['lightsStart', HORN_LIGHTS, { type: 'HornLights', attributes: { action: 'start', target: 'lights' } }],
    ['askForLocationRefresh', '/kamereon/kca/car-adapter/v1/cars/VIN1/actions/refresh-location?', { type: 'RefreshLocation' }],
  ];
  /** @param {string} [code] model code of VIN1 */
  async function ready(code = undefined) {
    const adapter = setup(code ? { '/vehicles?': vehicleOf(code) } : {});
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    return adapter;
  }
  const posts = (adapter) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .filter((request) => request.method === 'post');
  const write = async (adapter, path, val) => {
    const id = 'renault.0.VIN1.remote.' + path;
    await adapter.setState(id, val, false);
    await adapter.onStateChange(id, userWrite(val));
  };

  for (const [path, url, body] of cases) {
    it(`sends ${path} and resets the button`, async () => {
      const adapter = await ready();
      await write(adapter, path, true);
      expect(posts(adapter)).to.have.length(1);
      expect(posts(adapter)[0].url).to.include(url);
      expect(posts(adapter)[0].data).to.deep.equal({ data: body });
      expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
      expect(adapter.acks['VIN1.remote.' + path]).to.equal(true);
    });

    it(`ignores ${path} = false`, async () => {
      const adapter = await ready();
      await write(adapter, path, false);
      expect(posts(adapter)).to.deep.equal([]);
    });

    for (const val of [1, 'true', null]) {
      it(`sends nothing for ${path} = ${JSON.stringify(val)} and reports it`, async () => {
        const adapter = await ready();
        await write(adapter, path, val);
        expect(posts(adapter)).to.deep.equal([]);
        expect(adapter.states['VIN1.remote.lastCommandError']).to.include(path);
        expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
      });
    }
  }

  it('creates start buttons for horn and lights and a button for the location', async () => {
    const adapter = await ready();
    const common = (id) => adapter.objects.get('renault.0.VIN1.remote.' + id)?.common;
    expect(common('hornStart')).to.include({ type: 'boolean', role: 'button.start', read: false, write: true });
    expect(common('lightsStart')).to.include({ type: 'boolean', role: 'button.start', read: false, write: true });
    for (const id of ['refreshLocation', 'askForLocationRefresh', 'refreshBattery', 'refreshClimate']) {
      expect(common(id)).to.include({ type: 'boolean', role: 'button', read: false, write: true });
    }
    expect(common('hornStop')).to.equal(undefined);
    expect(common('lightsStop')).to.equal(undefined);
  });

  // renault-api marks no model as without refresh-location, so only horn and lights can be missing
  it('creates no horn or lights button on a model without them', async () => {
    const adapter = await ready('XJA1VP');
    for (const path of ['hornStart', 'lightsStart']) {
      expect(adapter.objects.has('renault.0.VIN1.remote.' + path), path).to.equal(false);
      await write(adapter, path, true);
    }
    expect(posts(adapter)).to.deep.equal([]);
  });
});

describe('refresh buttons', () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const LOCATION = '/cars/VIN1/location?';
  const kamereon = (adapter) => urls(adapter).filter((url) => url.includes('/kamereon/'));
  const posts = (adapter) =>
    adapter.requestClient
      .getCalls()
      .map((call) => call.args[0])
      .filter((request) => request.method === 'post');
  /** @type {(adapter: any, path: string, val?: unknown) => Promise<void>} */
  const press = (adapter, path, val = true) => adapter.onStateChange('renault.0.VIN1.remote.' + path, userWrite(val));
  const pending = (adapter, path) => adapter.refreshTimeouts['VIN1 ' + path];

  /** @param {Record<string, unknown>} [routes] */
  async function started(routes = {}) {
    useClock();
    const adapter = setup(routes);
    await adapter.onReady();
    adapter.requestClient.resetHistory();
    return adapter;
  }

  for (const [path, read] of [
    ['refreshBattery', 'battery-status'],
    ['refreshClimate', 'hvac-status'],
  ]) {
    it(`${path} reads only ${read} from the cloud at once, without asking the car`, async () => {
      const adapter = await started();
      await press(adapter, path);
      expect(posts(adapter)).to.deep.equal([]);
      expect(pending(adapter, read).ms).to.equal(0);
      await pending(adapter, read).fn();
      expect(kamereon(adapter)).to.have.length(1);
      expect(kamereon(adapter)[0]).to.include('/cars/VIN1/' + read + '?');
    });
  }

  it('refreshLocation reads only the location from the cloud, without asking the car', async () => {
    const adapter = await started();
    const poll = adapter.pollTimeout;
    await press(adapter, 'refreshLocation');
    expect(posts(adapter)).to.deep.equal([]);
    expect(pending(adapter, 'location').ms).to.equal(0);
    await pending(adapter, 'location').fn();
    expect(kamereon(adapter)).to.have.length(1);
    expect(kamereon(adapter)[0]).to.include(LOCATION);
    expect(adapter.pollTimeout).to.equal(poll);
  });

  for (const [path, action, endpoint, read] of [['askForLocationRefresh', '/actions/refresh-location?', LOCATION, 'location']]) {
    it(`${path} asks the car, then reads only ${read} 30 seconds later`, async () => {
      const adapter = await started();
      const poll = adapter.pollTimeout;
      await press(adapter, path);
      expect(posts(adapter)).to.have.length(1);
      expect(posts(adapter)[0].url).to.include(action);
      // no full poll after the command, only the single read
      expect(adapter.pollTimeout).to.equal(poll);
      expect(pending(adapter, read).ms).to.equal(30 * SECOND);
      adapter.requestClient.resetHistory();
      await pending(adapter, read).fn();
      expect(kamereon(adapter)).to.have.length(1);
      expect(kamereon(adapter)[0]).to.include(endpoint);
      expect(adapter.states['VIN1.remote.lastCommandError']).to.equal('');
      expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
      expect(adapter.acks['VIN1.remote.' + path]).to.equal(true);
    });

    it(`${path} reads nothing when the car refuses the request`, async () => {
      const adapter = await started({ [action]: httpError(403, {}, { errors: [{ errorCode: 'err.func.wired.forbidden' }] }) });
      await press(adapter, path);
      expect(adapter.refreshTimeouts).to.deep.equal({});
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include(path).and.include('err.func.wired.forbidden');
      expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
    });

    for (const val of [1, 'true', null]) {
      it(`${path} sends nothing for ${JSON.stringify(val)}`, async () => {
        const adapter = await started();
        await press(adapter, path, val);
        expect(posts(adapter)).to.deep.equal([]);
        expect(adapter.refreshTimeouts).to.deep.equal({});
        expect(adapter.states['VIN1.remote.lastCommandError']).to.include(path);
      });
    }
  }

  for (const path of ['refreshLocation', 'askForLocationRefresh']) {
    it(`${path} sends nothing and says why during the quota pause`, async () => {
      const adapter = await started();
      adapter.quotaPausedUntil = Date.now() + 10 * MINUTE;
      await press(adapter, path);
      expect(adapter.requestClient.called).to.equal(false);
      expect(adapter.refreshTimeouts).to.deep.equal({});
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('quota').and.include('10 more minutes');
      expect(adapter.states['VIN1.remote.' + path]).to.equal(false);
    });

    it(`${path} sends nothing and says why while the car does not offer the location`, async () => {
      const adapter = await started();
      adapter.ignoreState.VIN1.location = Date.now() - HOUR;
      await press(adapter, path);
      expect(adapter.requestClient.called).to.equal(false);
      expect(adapter.refreshTimeouts).to.deep.equal({});
      expect(adapter.states['VIN1.remote.lastCommandError']).to.include('location').and.include('23 hours');
    });
  }

  it('reads again once the quota pause ended and the ignored day is over', async () => {
    const adapter = await started();
    adapter.quotaPausedUntil = Date.now();
    adapter.ignoreState.VIN1.location = Date.now() - DAY;
    await press(adapter, 'refreshLocation');
    expect(pending(adapter, 'location').ms).to.equal(0);
  });

  it('keeps three minutes between two reads of the location, asked or not', async () => {
    const adapter = await started();
    await press(adapter, 'refreshLocation');
    await pending(adapter, 'location').fn();
    clock?.tick(MINUTE);
    await press(adapter, 'askForLocationRefresh');
    expect(pending(adapter, 'location').ms).to.equal(2 * MINUTE);
  });

  it('keeps the battery and the location read apart', async () => {
    const adapter = await started();
    await press(adapter, 'refreshBattery');
    await press(adapter, 'refreshLocation');
    await pending(adapter, 'battery-status').fn();
    expect(pending(adapter, 'location').ms).to.equal(0);
  });

  it('reads the location again 30 seconds after a full poll that runs when it is due', async () => {
    const adapter = await started();
    await press(adapter, 'refreshLocation');
    adapter.polling = true;
    await pending(adapter, 'location').fn();
    expect(kamereon(adapter)).to.deep.equal([]);
    expect(pending(adapter, 'location').ms).to.equal(30 * SECOND);
  });

  it('creates no battery button on a model without battery status', async () => {
    const adapter = setup({ '/vehicles?': vehicleOf('XJA1VP') });
    await adapter.onReady();
    expect(adapter.objects.has('renault.0.VIN1.remote.refreshBattery')).to.equal(false);
    adapter.requestClient.resetHistory();
    await press(adapter, 'refreshBattery');
    expect(adapter.refreshTimeouts).to.deep.equal({});
    expect(adapter.states['VIN1.remote.lastCommandError']).to.include('not supported');
  });

  it('asks the car for nothing but the location', async () => {
    const adapter = await started();
    for (const path of ['askForBatteryRefresh', 'askForClimateRefresh']) {
      expect(adapter.objects.has('renault.0.VIN1.remote.' + path)).to.equal(false);
      await press(adapter, path);
    }
    expect(posts(adapter)).to.deep.equal([]);
    expect(adapter.refreshTimeouts).to.deep.equal({});
  });
});

describe('alerts', () => {
  const Json2iob = require('json2iob');
  const ALERTS = '/kamereon/vehicles/VIN1/alerts?country=de';
  const alerts = (adapter) => urls(adapter).filter((url) => url.includes(ALERTS));

  it('reads the alerts once per hour', async () => {
    const now = useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('R5E1VE') });
    await adapter.onReady();
    now.tick(HOUR - 1);
    await adapter.updateDevices();
    expect(alerts(adapter)).to.have.length(1);
    now.tick(1);
    await adapter.updateDevices();
    expect(alerts(adapter)).to.have.length(2);
  });

  it('does not ask a model without alerts', async () => {
    useClock();
    const adapter = setup({ '/vehicles?': vehicleOf('XBG1VE') });
    await adapter.onReady();
    expect(alerts(adapter)).to.deep.equal([]);
  });

  it('stores a list of alerts with numeric indices and drops cleared ones', async () => {
    const now = useClock();
    let answer = [{ code: 'A1' }, { code: 'B2' }];
    const adapter = setup({ '/alerts?': () => answer });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    expect(adapter.objects.has('renault.0.VIN1.alerts.02.code')).to.equal(true);
    answer = [{ code: 'A1' }];
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(adapter.objects.has('renault.0.VIN1.alerts.01.code')).to.equal(true);
    expect(adapter.objects.has('renault.0.VIN1.alerts.02.code')).to.equal(false);
  });

  it('keeps the objects of alerts that stay, with their history settings', async () => {
    const now = useClock();
    let answer = [{ code: 'A1' }, { code: 'B2' }];
    const adapter = setup({ '/alerts?': () => answer });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    await adapter.extendObjectAsync('VIN1.alerts.01.code', { common: { custom: { 'history.0': { enabled: true } } } });
    answer = [{ code: 'A1' }];
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(adapter.objects.get('renault.0.VIN1.alerts.01.code')?.common.custom).to.deep.equal({ 'history.0': { enabled: true } });
    expect(adapter.deleted.filter((id) => id.startsWith('VIN1.alerts.01'))).to.deep.equal([]);
    expect(adapter.deleted).to.include('VIN1.alerts.02');
  });

  it('removes every alert when the answer is empty, and nothing when the request fails', async () => {
    const now = useClock();
    /** @type {unknown} */
    let answer = [{ code: 'A1' }];
    const adapter = setup({ '/alerts?': () => answer });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    answer = httpError(503);
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(adapter.objects.has('renault.0.VIN1.alerts.01.code')).to.equal(true);
    answer = [];
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(adapter.objects.has('renault.0.VIN1.alerts.01.code')).to.equal(false);
    expect(adapter.objects.has('renault.0.VIN1.alerts.01')).to.equal(false);
  });

  it('creates the objects of an alert again when it comes back', async () => {
    const now = useClock();
    let answer = [{ code: 'A1' }, { code: 'B2' }];
    const adapter = setup({ '/alerts?': () => answer });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    answer = [{ code: 'A1' }];
    now.tick(HOUR);
    await adapter.updateDevices();
    answer = [{ code: 'A1' }, { code: 'C3' }];
    now.tick(HOUR);
    await adapter.updateDevices();
    expect(adapter.objects.has('renault.0.VIN1.alerts.02.code')).to.equal(true);
    expect(adapter.states['VIN1.alerts.02.code']).to.equal('C3');
  });

  it('stores an object answer below the channel', async () => {
    useClock();
    const adapter = setup({ '/alerts?': { data: { attributes: { alerts: [{ code: 'A1' }] } } } });
    adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
    await adapter.onReady();
    expect(adapter.objects.has('renault.0.VIN1.alerts.alerts01.code')).to.equal(true);
    expect(adapter.objects.get('renault.0.VIN1.alerts')?.common.name).to.equal('Alerts');
  });
});

describe('vehicle name', () => {
  /**
   * @param {any} details
   * @param {string | null} [brand]
   * @param {string} [stored] name of an existing device object
   */
  const named = async (details, brand = 'RENAULT', stored = undefined) => {
    const adapter = setup({ '/vehicles?': { vehicleLinks: [{ vin: 'VIN1', brand, vehicleDetails: details }] } });
    if (stored !== undefined) {
      adapter.objects.set('renault.0.VIN1', { _id: 'renault.0.VIN1', type: 'device', common: { name: stored }, native: {} });
    }
    await adapter.onReady();
    return adapter.objects.get('renault.0.VIN1')?.common.name;
  };

  /** @type {[any, string][]} */
  const cases = [
    [{ modelSCR: 'ZOE', model: { label: 'ZOE' } }, 'ZOE'],
    [{ modelSCR: 'ZOE', model: { label: 'zoe' } }, 'ZOE'],
    [{ modelSCR: 'MEGANE', model: { label: 'MEGANE E-TECH' } }, 'MEGANE E-TECH'],
    [{ modelSCR: 'ZOE', model: { label: ' R135' } }, 'ZOE R135'],
    [{ modelSCR: 'ZOE', model: { label: '' } }, 'ZOE'],
    [{ modelSCR: 'ZOE' }, 'ZOE'],
    [{ model: { label: 'SPRING' } }, 'SPRING'],
    [{ modelSCR: '  ', model: { label: 5 } }, 'RENAULT'],
    [{}, 'RENAULT'],
  ];
  for (const [details, expected] of cases) {
    it(`names ${JSON.stringify(details)} ${expected}`, async () => {
      expect(await named(details)).to.equal(expected);
    });
  }

  it('names a vehicle without details after the VIN when the brand is missing too', async () => {
    expect(await named({}, null)).to.equal('VIN1');
  });

  it('repairs the doubled name of earlier versions', async () => {
    expect(await named({ modelSCR: 'ZOE', model: { label: 'ZOE' } }, 'RENAULT', 'ZOEZOE')).to.equal('ZOE');
  });

  it('keeps a name the user has given', async () => {
    expect(await named({ modelSCR: 'ZOE', model: { label: 'ZOE' } }, 'RENAULT', 'My car')).to.equal('My car');
  });
});

describe('startup failures', () => {
  it('keeps token refresh and vehicle reload when the first poll throws', async () => {
    const adapter = setup();
    adapter.json2iob.parse = sinon.spy(async (prefix) => {
      if (!prefix.endsWith('.general')) {
        throw new Error('boom');
      }
    });
    await adapter.onReady();
    expect(adapter.intervals.map((timer) => timer.ms)).to.deep.equal([3500 * 1000, DAY]);
    expect(adapter.timeouts.map((timer) => timer.ms)).to.deep.equal([adapter.config.interval * 60 * 1000]);
    expect(logged(adapter.log.error)).to.include('Poll failed: Error: boom');
  });

  it('logs a failed startup instead of rejecting', async () => {
    const adapter = setup();
    adapter.loadCockpitChoice = sinon.stub().rejects(new Error('database gone'));
    await adapter.onReady();
    expect(logged(adapter.log.error)).to.include('Startup failed: Error: database gone');
  });

  for (const [username, password] of [
    ['', 'secret'],
    ['   ', 'secret'],
    ['user@example.com', ''],
    [undefined, undefined],
    [null, null],
  ]) {
    it(`sends nothing and plans no retry for username ${JSON.stringify(username)} and password ${JSON.stringify(password)}`, async () => {
      const adapter = setup();
      adapter.config.username = /** @type {any} */ (username);
      adapter.config.password = /** @type {any} */ (password);
      await adapter.onReady();
      expect(adapter.requestClient.called).to.equal(false);
      expect(adapter.timeouts).to.have.length(0);
      expect(adapter.intervals).to.have.length(0);
      expect(adapter.states['info.connection']).to.equal(false);
      expect(logged(adapter.log.error).some((line) => line.includes('Email or password is missing'))).to.equal(true);
    });
  }
});

describe('charge history limit', () => {
  const cases = [
    [100, 100],
    [0, 0],
    [1, 1],
    [1000, 1000],
    [1001, 1000],
    [12.7, 12],
    ['50', 50],
    [-1, 100],
    ['', 100],
    [null, 100],
    ['abc', 100],
    [Infinity, 100],
  ];
  for (const [configured, expected] of cases) {
    it(`keeps ${expected} entries for a configured ${JSON.stringify(configured)}`, async () => {
      const adapter = setup();
      adapter.config.chargeHistoryLimit = /** @type {any} */ (configured);
      await adapter.onReady();
      expect(adapter.config.chargeHistoryLimit).to.equal(expected);
      expect(logged(adapter.log.warn).some((line) => line.startsWith('Charge history entries'))).to.equal(expected !== Number(configured));
    });
  }

  /** @type {[number, string[]][]} */
  const kept = [
    [2, ['2', '3']],
    [0, ['1', '2', '3']],
  ];
  for (const [limit, days] of kept) {
    it(`writes the entries ${days.join(', ')} with a configured limit of ${limit}`, async () => {
      const adapter = setup({
        '/charge-history?': { data: { attributes: { chargeSummaries: [{ day: '1' }, { day: '2' }, { day: '3' }] } } },
      });
      adapter.config.chargeHistoryLimit = limit;
      await adapter.onReady();
      const call = adapter.json2iob.parse.getCalls().find((entry) => entry.args[0] === 'VIN1.charge-history');
      expect(call?.args[1].chargeSummaries.map((entry) => entry.day)).to.deep.equal(days);
    });
  }
});

describe('brand', () => {
  for (const [configured, brand, product, warned] of [
    ['renault', 'renault', 'MYRENAULT', false],
    ['alpine', 'alpine', 'MYALPINE', false],
    ['', 'renault', 'MYRENAULT', false],
    [undefined, 'renault', 'MYRENAULT', false],
    ['bmw', 'renault', 'MYRENAULT', true],
    ['Alpine', 'renault', 'MYRENAULT', true],
  ]) {
    it(`uses ${brand} for a configured ${JSON.stringify(configured)}`, async () => {
      const adapter = setup();
      adapter.config.brand = /** @type {any} */ (configured);
      await adapter.onReady();
      expect(adapter.brand).to.equal(brand);
      expect(adapter.product).to.equal(product);
      expect(adapter.buildTraceId().startsWith('build=' + brand + '-android-')).to.equal(true);
      expect(logged(adapter.log.warn).some((line) => line.includes('is unknown, using renault'))).to.equal(warned);
    });
  }
});

describe('personal data in the log', () => {
  /** @param {any} adapter */
  const allLines = (adapter) =>
    Object.values(adapter.log).flatMap((spy) => spy.getCalls().map((call) => require('node:util').inspect(call.args[0])));

  it('logs neither the position nor the vehicle list', async () => {
    const adapter = setup({
      '/location?': require('./test/fixtures/renault-api/location.1.json'),
      '/vehicles?': { vehicleLinks: [{ ...VEHICLE, vehicleDetails: { ...VEHICLE.vehicleDetails, registrationNumber: 'AB-CD-123' } }] },
    });
    await adapter.onReady();
    const lines = allLines(adapter);
    for (const secret of ['48.1234567', '11.1234567', 'AB-CD-123']) {
      expect(lines.filter((line) => line.includes(secret))).to.deep.equal([]);
    }
    expect(lines.some((line) => line.includes('location of VIN1: position not logged'))).to.equal(true);
  });

  it('logs only code and message of a failed login', async () => {
    const adapter = setup({
      'accounts.login': { errorCode: 206001, errorMessage: 'Account Pending Registration', UID: 'UID-123', regToken: 'REG-TOKEN' },
    });
    await adapter.onReady();
    const lines = allLines(adapter);
    expect(lines.filter((line) => line.includes('UID-123') || line.includes('REG-TOKEN'))).to.deep.equal([]);
    expect(logged(adapter.log.error)).to.include('Login failed: 206001 Account Pending Registration');
  });
});

describe('VIN check', () => {
  it('skips vehicles whose VIN would break object ids or URLs', async () => {
    const adapter = setup({
      '/vehicles?': { vehicleLinks: [VEHICLE, { vin: 'A.B' }, { vin: 'X/../Y' }, { vin: 'A B' }, { vin: '' }, { vin: 5 }, {}, null] },
    });
    await adapter.onReady();
    expect(adapter.deviceArray).to.deep.equal(['VIN1']);
    expect([...adapter.objects.values()].filter((object) => object.type === 'device').map((object) => object._id)).to.deep.equal([
      'renault.0.VIN1',
    ]);
    expect(urls(adapter).filter((url) => url.includes('/cars/') && !url.includes('/cars/VIN1/'))).to.deep.equal([]);
    expect(logged(adapter.log.warn).filter((line) => line.startsWith('Skipped a vehicle'))).to.have.length(7);
  });
});

describe('after unload', () => {
  it('plans no poll, refresh or relogin', async () => {
    const adapter = setup();
    await adapter.onReady();
    adapter.onUnload(() => {});
    const timeouts = adapter.timeouts.length;
    adapter.schedulePoll(1000);
    adapter.scheduleRefresh('VIN1', 'location', 0);
    adapter.reconnect(0);
    await adapter.sendCommand('VIN1', 'climateStart', 'https://example.invalid', {});
    expect(adapter.timeouts).to.have.length(timeouts);
  });

  it('starts no timer when the instance stops during a successful login', async () => {
    /** @type {any} */
    let adapter = undefined;
    adapter = setup({
      'accounts.login': () => {
        adapter.onUnload(() => {});
        return { sessionInfo: { cookieValue: 'COOKIE' } };
      },
    });
    await adapter.onReady();
    expect(adapter.timeouts).to.have.length(0);
    expect(adapter.intervals).to.have.length(0);
  });

  it('plans no retry when the instance stops during a failed login', async () => {
    /** @type {any} */
    let adapter = undefined;
    adapter = setup({
      'accounts.login': () => {
        adapter.onUnload(() => {});
        return new Error('ECONNRESET');
      },
    });
    await adapter.onReady();
    expect(adapter.timeouts).to.have.length(0);
  });
});

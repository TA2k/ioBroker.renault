'use strict';

// In-memory stand-in for the Adapter class of @iobroker/adapter-core. Requiring this file replaces
// that module in the require cache, so it must be required before main.js.

const sinon = require('sinon');
const { EventEmitter } = require('node:events');

class FakeAdapter extends EventEmitter {
  constructor() {
    super();
    this.namespace = 'renault.0';
    this.config = {};
    /** @type {Record<string, any>} state values by id relative to the namespace */
    this.states = {};
    /** @type {Record<string, boolean>} ack flags by relative id */
    this.acks = {};
    /** @type {Record<string, number>} write times by relative id */
    this.stamps = {};
    /** @type {Map<string, any>} objects by full id */
    this.objects = new Map();
    /** @type {string[]} relative ids passed to delObjectAsync */
    this.deleted = [];
    /** @type {{ fn: () => any, ms: number }[]} */
    this.timeouts = [];
    /** @type {{ fn: () => any, ms: number }[]} */
    this.intervals = [];
    this.log = { debug: sinon.spy(), info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
    this.clearTimeout = sinon.spy();
    this.clearInterval = sinon.spy();
    this.subscribeStates = sinon.spy();
  }

  /** @param {string} id */
  relativeId(id) {
    return id.startsWith(this.namespace + '.') ? id.slice(this.namespace.length + 1) : id;
  }

  /** @param {string} id */
  fullId(id) {
    return this.namespace + '.' + this.relativeId(id);
  }

  setState(id, state, ack) {
    const key = this.relativeId(id);
    const isObject = state !== null && typeof state === 'object';
    this.states[key] = isObject ? state.val : state;
    this.acks[key] = Boolean(isObject ? state.ack : ack);
    this.stamps[key] = Date.now();
    return Promise.resolve();
  }

  setStateAsync(id, state, ack) {
    return this.setState(id, state, ack);
  }

  getStateAsync(id) {
    const key = this.relativeId(id);
    return Promise.resolve(key in this.states ? { val: this.states[key], ack: this.acks[key] } : null);
  }

  extendObjectAsync(id, object) {
    const key = this.fullId(id);
    const old = this.objects.get(key) || { common: {}, native: {} };
    this.objects.set(key, {
      ...old,
      ...object,
      _id: key,
      common: { ...old.common, ...object.common },
      native: { ...old.native, ...object.native },
    });
    return Promise.resolve();
  }

  getObjectAsync(id) {
    return Promise.resolve(this.objects.get(this.fullId(id)) ?? null);
  }

  setObjectNotExistsAsync(id, object) {
    const key = this.fullId(id);
    if (!this.objects.has(key)) {
      this.objects.set(key, { ...object, _id: key });
    }
    return Promise.resolve();
  }

  /** @param {string} pattern full id ending in `.*` */
  getForeignObjectsAsync(pattern) {
    const prefix = pattern.slice(0, -1);
    return Promise.resolve(Object.fromEntries([...this.objects].filter(([id]) => id.startsWith(prefix))));
  }

  /** @param {string} pattern full id ending in `.*` */
  getForeignStatesAsync(pattern) {
    const prefix = this.relativeId(pattern.slice(0, -1));
    return Promise.resolve(
      Object.fromEntries(
        Object.keys(this.states)
          .filter((key) => key.startsWith(prefix))
          .map((key) => [this.fullId(key), { val: this.states[key], ack: this.acks[key], ts: this.stamps[key] }]),
      ),
    );
  }

  delForeignObjectAsync(id) {
    return this.delObjectAsync(id);
  }

  setObjectNotExists(id, object) {
    void this.setObjectNotExistsAsync(id, object);
  }

  delObjectAsync(id) {
    const key = this.fullId(id);
    this.deleted.push(this.relativeId(id));
    for (const existing of [...this.objects.keys()]) {
      if (existing === key || existing.startsWith(key + '.')) {
        this.objects.delete(existing);
      }
    }
    return Promise.resolve();
  }

  setTimeout(fn, ms) {
    const timer = { fn, ms };
    this.timeouts.push(timer);
    return timer;
  }

  setInterval(fn, ms) {
    const timer = { fn, ms };
    this.intervals.push(timer);
    return timer;
  }
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
const createRenault = require('../main.js');

/**
 * @typedef {Omit<ReturnType<typeof createRenault>, 'requestClient' | 'json2iob' | 'log' | 'setState' | 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'subscribeStates'>
 *   & FakeAdapter
 *   & { requestClient: sinon.SinonSpy; json2iob: { parse: sinon.SinonSpy } }} TestAdapter
 */

const ACCOUNT = { accountId: 'acc-1', accountType: 'MYRENAULT', accountStatus: 'ACTIVE' };
const VEHICLE = { vin: 'VIN1', brand: 'RENAULT', vehicleDetails: { modelSCR: 'ZOE', model: { label: ' R135' } } };

/**
 * Build an HTTP error shaped like an axios error.
 *
 * @param {number} status
 * @param {Record<string, unknown>} [config]
 * @param {unknown} [data]
 */
function httpError(status, config = {}, data = { status }) {
  const error = new Error('Request failed with status code ' + status);
  Object.assign(error, { response: { status, data }, config });
  return error;
}

/**
 * Create an adapter whose HTTP client answers per URL fragment.
 * A route value is a response body, an Error to throw, or a function of the request that returns
 * either (or a promise of a body).
 *
 * @param {Record<string, unknown>} [routes]
 * @returns {TestAdapter}
 */
function createTestAdapter(routes = {}) {
  const adapter = /** @type {TestAdapter} */ (/** @type {unknown} */ (createRenault()));
  adapter.config = { ...require('../io-package.json').native, username: 'user@example.com', password: 'secret' };
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
    const route = key === undefined ? {} : all[key];
    const answer = await (typeof route === 'function' ? route(request) : route);
    if (answer instanceof Error) {
      throw answer;
    }
    return { data: answer };
  });
  adapter.json2iob.parse = sinon.spy();
  return adapter;
}

/** Routes that answer every polled endpoint with a real answer copied from renault-api. */
function fixtureRoutes() {
  const fixture = (name) => require('./fixtures/renault-api/' + name);
  return {
    '/battery-status?': fixture('battery-status.renault_5.json'),
    '/battery-inhibition-status?': {},
    '/cockpit?': fixture('cockpit.captur_ii.json'),
    '/charge-mode?': fixture('charge-mode.json'),
    '/hvac-status?': fixture('hvac-status.renault_5.json'),
    '/hvac-settings?': fixture('hvac-settings.json'),
    '/charging-settings?': fixture('charging-settings.single.json'),
    '/lock-status?': fixture('lock-status.1.json'),
    '/res-state?': fixture('res-state.1.json'),
    '/location?': fixture('location.1.json'),
    '/pressure?': fixture('pressure.json'),
    '/charge-history?': fixture('charge-history.day.json'),
    '/charges?': fixture('charges.json'),
  };
}

module.exports = { FakeAdapter, createTestAdapter, fixtureRoutes, httpError, ACCOUNT, VEHICLE };

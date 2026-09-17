'use strict';

// Runs @iobroker/repochecker's object structure check, the check the ioBroker.repositories bot
// runs against a live instance dump.
//
//   npm run pr:objects             # objects of a fake instance fed with renault-api answers
//   npm run pr:objects dump.json   # objects exported from a real instance
//
// The checker is not a dependency: `npm run pr:objects` fetches it through npx.

const fs = require('node:fs');
const path = require('node:path');
const ioPackage = require('../io-package.json');

/** `npx --package` only puts the package's .bin on PATH, so resolve the library next to it. */
function loadChecker() {
  const library = '@iobroker/repochecker/lib/objectStructure.js';
  try {
    return require(library).checkObjectStructure;
  } catch {
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      if (!entry.endsWith(path.join('node_modules', '.bin'))) {
        continue;
      }
      const candidate = path.join(entry, '..', ...library.split('/'));
      if (fs.existsSync(candidate)) {
        return require(candidate).checkObjectStructure;
      }
    }
  }
  throw new Error('@iobroker/repochecker not found, run: npm run pr:objects');
}

async function buildDump() {
  const { createTestAdapter, fixtureRoutes } = require('../test/fakeAdapter');
  const Json2iob = require('json2iob');
  const adapter = createTestAdapter(fixtureRoutes());
  adapter.json2iob = /** @type {any} */ (new Json2iob(adapter));
  await adapter.onReady();
  await adapter.onStateChange('renault.0.VIN1.remote.charging-start', /** @type {any} */ ({ val: true, ack: false }));

  /** @type {Record<string, any>} */
  const dump = {};
  for (const object of ioPackage.instanceObjects || []) {
    dump[adapter.namespace + '.' + object._id] = { ...object, _id: adapter.namespace + '.' + object._id };
  }
  for (const [id, object] of adapter.objects) {
    dump[id] = object;
  }
  // A real dump is JSON, and JSON drops undefined members.
  return JSON.parse(JSON.stringify(dump));
}

async function main() {
  const file = process.argv[2];
  const dump = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await buildDump();
  const result = loadChecker()(dump, ioPackage.common.name);
  console.log('Checked ' + result.objectCount + ' objects: ' + result.errors.length + ' errors, ' + result.warnings.length + ' warnings');
  for (const warning of result.warnings) {
    console.log('WARNING ' + warning.code + ' ' + warning.message);
  }
  for (const error of result.errors) {
    console.log('ERROR ' + error.code + ' ' + error.message);
  }
  // The repositories bot fails the objects label on warnings too.
  process.exit(result.errors.length + result.warnings.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

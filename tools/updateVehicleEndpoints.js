'use strict';

// Rebuilds lib/vehicleEndpoints.json from renault-api (MIT), which documents per model code which
// endpoint and which request variant ("mode") a car supports.
//
//   node tools/updateVehicleEndpoints.js

const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'https://raw.githubusercontent.com/hacf-fr/renault-api/main/src/renault_api/kamereon/models.py';
const TARGET = path.join(__dirname, '..', 'lib', 'vehicleEndpoints.json');

/**
 * Cut the Python dict literal assigned to `name` (from its opening brace to the closing brace at
 * column 0).
 *
 * @param {string} source
 * @param {string} name
 */
function dictBody(source, name) {
  const start = source.search(new RegExp('^' + name + ':', 'm'));
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) {
    throw new Error(name + ' not found in models.py');
  }
  return source.slice(source.indexOf('{', start) + 1, end);
}

/**
 * Modes of the named endpoint definitions, e.g. { 'actions/charge-start-via-settings': 'kcm-settings' }.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function definitionModes(body) {
  /** @type {Record<string, string>} */
  const modes = {};
  for (const match of body.matchAll(/"([a-z/-]+)": EndpointDefinition\(([^)]*)\)/g)) {
    modes[match[1]] = /mode="([a-z-]+)"/.exec(match[2])?.[1] ?? 'default';
  }
  return modes;
}

/**
 * @param {string} source content of renault-api kamereon/models.py
 * @returns {Record<string, { name: string, endpoints: Record<string, string | null> }>}
 */
function parseModels(source) {
  const tables = {
    DEFAULT: definitionModes(dictBody(source, '_DEFAULT_ENDPOINTS')),
    KCA_ALTERNATIVE: definitionModes(dictBody(source, '_KCA_ALTERNATIVE_ENDPOINTS')),
    KCM: definitionModes(dictBody(source, '_KCM_ENDPOINTS')),
  };
  /** @type {Record<string, { name: string, endpoints: Record<string, string | null> }>} */
  const models = {};
  const body = dictBody(source, '_VEHICLE_ENDPOINTS');
  for (const block of body.matchAll(/\n {4}"([A-Z0-9]+)": \{[ \t]*(?:#[ \t]*([^\n]*))?\n([\s\S]*?)\n {4}\},/g)) {
    /** @type {Record<string, string | null>} */
    const endpoints = {};
    const entries = /\n {8}"([a-z/-]+)":\s*(?:(None)|_(DEFAULT|KCA_ALTERNATIVE|KCM)_ENDPOINTS\[\s*(?:#[^\n]*)?\s*"([a-z/-]+)"\s*\])/g;
    for (const entry of ('\n' + block[3]).matchAll(entries)) {
      if (entry[2]) {
        endpoints[entry[1]] = null;
        continue;
      }
      const mode = tables[/** @type {'DEFAULT' | 'KCA_ALTERNATIVE' | 'KCM'} */ (entry[3])][entry[4]];
      if (mode === undefined) {
        throw new Error('Unknown endpoint definition ' + entry[3] + ' ' + entry[4] + ' for ' + block[1]);
      }
      endpoints[entry[1]] = mode;
    }
    models[block[1]] = { name: (block[2] || '').trim(), endpoints };
  }
  if (!Object.keys(models).length) {
    throw new Error('No models found in _VEHICLE_ENDPOINTS');
  }
  return models;
}

async function main() {
  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error('Fetching ' + SOURCE + ' failed: ' + response.status);
  }
  const models = parseModels(await response.text());
  const data = {
    source: SOURCE,
    license: 'MIT, Copyright (c) 2020 epenet',
    retrieved: new Date().toISOString().slice(0, 10),
    models,
  };
  fs.writeFileSync(TARGET, JSON.stringify(data, null, 2) + '\n');
  console.log('Wrote ' + Object.keys(models).length + ' models to ' + path.relative(process.cwd(), TARGET));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { parseModels };

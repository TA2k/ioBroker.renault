![Logo](admin/renault.png)

# ioBroker.renault

[![NPM version](https://img.shields.io/npm/v/iobroker.renault.svg)](https://www.npmjs.com/package/iobroker.renault)
[![Downloads](https://img.shields.io/npm/dm/iobroker.renault.svg)](https://www.npmjs.com/package/iobroker.renault)
![Number of Installations](https://iobroker.live/badges/renault-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/renault-stable.svg)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.renault/workflows/Test%20and%20Release/badge.svg)

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** For more details and for information how to disable the error reporting see [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry)! Sentry reporting is used starting with js-controller 3.0.

## Renault / Dacia / Alpine adapter for ioBroker

This adapter connects ioBroker to the My Renault / My Dacia / My Alpine cloud and exposes vehicle status data (battery, charging, HVAC, mileage, ...) as well as remote commands (HVAC start, charging start/stop, force refresh) for compatible Renault, Dacia and Alpine models such as the Renault Zoe, Megane E-Tech, Kangoo E-Tech, the Dacia Spring and the Alpine A290.

## Installation / Login

1. Install the adapter via the ioBroker admin UI.
2. Open the adapter configuration and enter the credentials of your **My Renault** (or **My Dacia** / **My Alpine**) account: app email and app password.
3. Select the **brand** matching your app: `Renault / Dacia` or `Alpine` (they use separate accounts and API keys).
4. Set the **country** to the two-letter country code matching your account (e.g. `de`, `fr`, `it`, `es`).
5. Optionally set the polling **interval** in minutes and the **API key** (leave empty for auto-detect).
6. Save and the instance will start polling.

## Remote control

Each vehicle is created as a device using its VIN. Remote commands are exposed as states under `renault.0.<VIN>.remote.*`:

| State                    | Type    | Action                                                    |
| ------------------------ | ------- | --------------------------------------------------------- |
| `actions/hvac-start`     | boolean | `true` = start, `false` = stop pre-conditioning           |
| `hvac-temperature`       | number  | Target HVAC temperature                                   |
| `actions/charging-start` | boolean | `true` = start, `false` = stop charging                   |
| `charge/pause-resume`    | boolean | `true` = start, `false` = pause                           |
| `charge/start`           | boolean | `true` = start, `false` = stop charging (legacy endpoint) |
| `refresh`                | boolean | `true` = force refresh of vehicle data                    |

Set the corresponding state to `true` to trigger the command.

## Discussion / questions

ioBroker forum: <https://forum.iobroker.net/topic/48074/test-adapter-renault-v0-0-x>

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (typhosj) breaking: only one cockpit version is polled per vehicle (v2 if it answers); the channel of the other version (cockpit or cockpitv2) is deleted once
- (typhosj) an endpoint the car rejected is asked again once a day, so a temporary 403 no longer disables it until restart
- (typhosj) the charge history is fetched once per hour instead of on every poll, and the adapter warns once when its requests exceed Renault's quota of about 60 per hour
- (typhosj) an expired token during a poll stops the poll, refreshes the token once and repeats the poll once
- (typhosj) after a failed token refresh the adapter logs in again with growing delay and restarts polling once, instead of trying a single time
- (typhosj) when Renault's request quota is used up (429), polling pauses for 15, 30 and then 60 minutes instead of logging an error per endpoint
- (typhosj) login and requests use the country from the settings instead of always Germany; an invalid country falls back to de
- (typhosj) the Kamereon API key lookup accepts only a well-formed key; an invalid key in the settings is ignored with a warning
- (typhosj) polls no longer overlap: a manual refresh or a command during a running poll waits for it
- (typhosj) the update interval is at least 5 minutes (15 minutes for new installations), and the adapter only listens to its remote states
- (typhosj) requests to the Renault cloud time out after 30 seconds, so one unanswered request no longer stalls polling
- (typhosj) the adapter icon and readme links point to the `main` branch again
- (typhosj) timers are managed by the adapter, so none survives a stop of the instance
- (typhosj) lint uses the shared `@iobroker/eslint-config`; dependencies updated

### 0.0.25

- (typhosj) retry the connection with growing delay (5 to 60 minutes) when login or vehicle list fail at startup; a login rejected by the account service is not retried
- (typhosj) `info.connection` is true only after the account was found and turns false when the token refresh fails
- (typhosj) a temporary server error (5xx) on the first poll no longer disables that endpoint until restart
- (typhosj) fix crash for vehicles without vehicle details and for the refresh button before login
- (typhosj) no longer write password, session cookie, id token or account data into the log
- (typhosj) add missing admin translations, remove unused dependencies
- (typhosj) require Node.js 22 or newer, test with Node.js 26, update dependencies

### 0.0.24

- (TA2k) add Alpine support: brand selection (Alpine accounts use the same Renault Gigya/Kamereon tenant, only product/account type MYALPINE differs)

### 0.0.23

- (TA2k) align API headers with My Renault Android app, drop EOL Node 18/20, migrate admin UI to jsonConfig

### 0.0.22

- (TA2k) update dependencies, migrate to ESLint 10, fix repochecker findings

### 0.0.7

- (TA2k) initial release

[Older changelogs can be found here](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2021-2026 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

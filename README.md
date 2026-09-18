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

| State                | Type    | Role                | Action                                                                                                       |
| -------------------- | ------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `climateStart`       | boolean | `button.start`      | start the climate control                                                                                    |
| `climateStop`        | boolean | `button.stop`       | stop the climate control                                                                                     |
| `climateTemperature` | number  | `level.temperature` | target temperature in °C for the next start (default 21)                                                     |
| `chargingStart`      | boolean | `button.start`      | start charging (see below)                                                                                   |
| `chargingStop`       | boolean | `button.stop`       | stop charging                                                                                                |
| `chargeLimitMin`     | number  | `level`             | minimum charge level in %, 15 to 45 in steps of 5                                                            |
| `chargeLimitTarget`  | number  | `level`             | target charge level in %, 55 to 100 in steps of 5                                                            |
| `chargeMode`         | string  | `text`              | `always`, `always_charging`, `schedule_mode` or `scheduled`; the current mode is in `charge-mode.chargeMode` |
| `refreshAll`         | boolean | `button`            | poll all vehicle data now                                                                                    |
| `refreshBattery`     | boolean | `button`            | ask only the battery status, one minute later                                                                |
| `lastCommandError`   | string  | `text`              | error of the last command, empty after a successful command                                                  |

A button is pressed by writing `true`. The adapter resets it to `false` with `ack: true` once the
command was handled; `lastCommandError` tells whether the Renault cloud accepted it. The car carries
it out afterwards, and the data states show the result after the next poll, for example
`hvac-status.hvacStatus` and `battery-status.chargingStatus`.

`chargeLimitMin` and `chargeLimitTarget` are sent together, so the adapter needs the other limit
from `soc-levels`. It is read once per hour; right after the start a write waits for that first
read. The current limits are in `soc-levels.socMin` and `soc-levels.socTarget`.

`refreshBattery` is meant for scripts that follow the wallbox: it costs one request instead of a
full poll. It waits one minute, so the car has time to upload its new state, merges all presses in
that minute, and asks the battery status of a vehicle at most every three minutes. Frequent use of
`refreshAll` can exhaust the request quota of the account, which also blocks the My Renault app.

Which request a command sends, and which vehicle data the adapter polls, depends on the model. The
adapter uses the endpoint table of [renault-api](https://github.com/hacf-fr/renault-api) (model code
in `general.vehicleDetails.model.code`):

- A button the model does not support is not created. Models that cannot stop charging remotely,
  for example the Megane E-Tech, Renault 4, Renault 5 and Alpine A290, have no `chargingStop`.
- Renault 4, Renault 5, Alpine A290, Scenic E-Tech and Master E-Tech charge by schedule. On these
  models `chargingStart` **switches off all charge programs**, as the My Renault app does; switch
  them on again in the app.
- Data the model does not provide is not polled, which saves requests.
- A model renault-api does not list yet gets the default requests: every command and endpoint is tried,
  and unsupported endpoints are asked again once a day.

## Vehicle data

The data of each endpoint is written to a channel below `renault.0.<VIN>`, named after the
endpoint, for example `battery-status`, `cockpit` and `hvac-status`. Most are asked on every
poll; these change slowly and are asked once per hour:

| Channel          | Content                                           |
| ---------------- | ------------------------------------------------- |
| `charge-history` | charges per day                                   |
| `charges`        | single charges                                    |
| `pressure`       | tyre pressure per wheel in mbar and a status code |
| `soc-levels`     | minimum and target charge level                   |

## Discussion / questions

ioBroker forum: <https://forum.iobroker.net/topic/48074/test-adapter-renault-v0-0-x>

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (typhosj) set the charge mode with `remote.chargeMode` (`always`, `always_charging`, `schedule_mode`, `scheduled`)
- (typhosj) read and set the minimum and target charge level with `remote.chargeLimitMin` and `remote.chargeLimitTarget` on models that support it (Megane E-Tech, Scenic E-Tech, Renault 4, Renault 5, Alpine A290, Master E-Tech); the current limits are read once per hour into `soc-levels`
- (typhosj) new channel `pressure` with the tyre pressure per wheel in mbar, read once per hour on models that report it
- (typhosj) **Breaking change:** the remote states are renamed and are buttons for every model. `hvac-start` becomes `climateStart` and `climateStop`, `hvac-temperature` becomes `climateTemperature`, `charging` becomes `chargingStart` and `chargingStop`, `refresh` becomes `refreshAll`, `lastError` becomes `lastCommandError`. The old states are removed on the first start and the target temperature is taken over. Adjust scripts and visualizations.
- (typhosj) new button `remote.refreshBattery` asks only the battery status, one minute later and at most every three minutes, for scripts that follow the wallbox
- (typhosj) an endpoint that has answered with server errors for 24 hours is asked only hourly until it answers again
- (typhosj) `hvac-temperature` starts at 21 °C instead of empty
- (typhosj) the refresh button, and `charging` on models that cannot stop charging, are reset to false with ack after they were handled
- (typhosj) an endpoint that answers with only a message and no data (cockpit v2 on the Zoe phase 2) counts as not supported
- (typhosj) a server error (5xx) is logged as warning once per endpoint and vehicle, with the endpoint name; repeats go to the debug log until the endpoint answers again
- (typhosj) breaking: `actions/hvac-start` is renamed to `hvac-start`, and `actions/charging-start`, `charge/pause-resume` and `charge/start` are replaced by one state `charging`; the old states are removed, scripts and visualizations need the new names
- (typhosj) commands and polled data follow the endpoint table of renault-api per model: `charging` and the climate control stop send the request the model needs, and commands or data the model does not offer are not created or polled
- (typhosj) `charging` starts charging on the Renault 4, Renault 5, Alpine A290, Scenic E-Tech and Master E-Tech by switching off their charge programs
- (typhosj) breaking: battery, range, mileage, fuel and temperature states get units and specific roles, and data states are read-only
- (typhosj) breaking: the command states use the roles switch, button.start and level.temperature instead of button and value
- (typhosj) commands are confirmed with ack after the cloud accepted them, and errors are written to remote.lastError
- (typhosj) the vehicle list and details are loaded again every 24 hours, new vehicles are picked up, and the details channel is named "Vehicle details"
- (typhosj) breaking: only one cockpit version is polled per vehicle (v2 if it answers, else v1), and its data is always written to `<vin>.cockpit`; the `cockpitv2` channel is removed once
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

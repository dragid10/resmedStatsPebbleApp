# ResMed Stats for Pebble

[![Pebble App Store](https://img.shields.io/badge/Pebble-App%20Store-orange)](https://apps.repebble.com/bca44cfa4de14135915afbec)

A Pebble smartwatch app that connects to your ResMed myAir account and displays your CPAP sleep therapy stats for the past week.

**[Install from the Pebble App Store](https://apps.repebble.com/bca44cfa4de14135915afbec)**

## Features

- **myAir Score** displayed prominently with color-coded indicators (green/yellow/red)
- **Daily stats**: Events (AHI), Usage, Mask Off count, Leak percentage
- **Cycle through days** with UP/DOWN buttons (most recent first)
- **Manual sync** with SELECT button (long-press 3s to force refresh)
- **Automatic background sync** via configurable interval (4/6/8/12 hours)
- **Cached data** — app launches instantly with stored data, only fetches when stale
- **Phone settings page** with login, logout, and configurable options

## Settings (via phone companion)

After logging in, the settings page offers:

| Setting | Description |
|---------|-------------|
| **Colorblind Mode** | Monochrome display — all values in white, no color meaning |
| **Simple Mode** | Replaces numbers with "Good" / "OK" / "Poor" text |
| **Sync Interval** | Refresh on open if cached data is older than this (4, 6, 8, or 12 hours). The app also refreshes itself once a day at 9 AM and closes again on its own. |
| **Visible Stats** | Toggle which stats appear below the score |
| **Disconnect** | Clear credentials and log out |

## Controls

| Button | Action |
|--------|--------|
| **UP** | Previous day |
| **DOWN** | Next day |
| **SELECT** | Sync data (15-min cooldown) |
| **SELECT (3s hold)** | Force sync (bypasses cooldown) |
| **BACK** | Exit app |

## Privacy

- Credentials are stored **only on your phone** in the Pebble companion app's local storage
- Nothing is sent to any cloud service or external server beyond ResMed's own API
- The watch stores only sleep data (scores, stats) — never credentials
- Uninstalling the app clears all stored data

## How It Works

```
Phone (PebbleKit JS)              Watch (C)
─────────────────────            ──────────────
1. Okta OAuth2 + PKCE     ←──   REQUEST_DATA
2. GraphQL query           ──→   Sleep records
3. Send day-by-day         ──→   Display & cache
```

The phone companion handles all authentication and API communication. The watch only receives and displays the resulting sleep data.

## Supported Platforms

All Pebble hardware: Aplite, Basalt, Chalk, Diorite, Emery, Flint, Gabbro.

The UI layout is fully proportional — it scales from the smallest (144x168) to the largest (200x228) screen.

## Building

```bash
npm install
pebble build
```

## Installing

```bash
# Via CloudPebble proxy (phone must have Dev Connect enabled)
pebble install --cloudpebble

# Via direct WiFi (phone and computer on same network)
pebble install --phone <PHONE_IP>
```

## Requirements

- A ResMed myAir account (North America or Europe)
- A Pebble watch paired with a phone running the Pebble companion app
- Email verification codes (used by EU myAir accounts) are supported: after saving your login, check your email and enter the code in the app's settings page. Other MFA methods are not supported yet

## API Details

This app uses the unofficial ResMed myAir API, reverse-engineered from the myAir web application. The authentication flow is:

1. POST credentials to Okta `/api/v1/authn` to get a session token
2. Exchange session token for an authorization code via OAuth2 PKCE
3. Exchange the authorization code for access and ID tokens
4. Read the region's public myAir metadata file for the API endpoints and keys (cached for a day)
5. Register this install's own random handset ID with the account, once, as the myAir web app does for each browser
6. Query the AWS AppSync GraphQL endpoint for sleep records

The API is undocumented and may change without notice. This app is not affiliated with or endorsed by ResMed.

## Disclaimer

This application is **not HIPAA compliant and does not intend to be**. CPAP therapy data is cached on the watch and transmitted over Bluetooth without application-layer encryption. This app is intended for personal use — it is not a medical device and should not be used for clinical decision-making.

## License

MIT, see [LICENSE](LICENSE).

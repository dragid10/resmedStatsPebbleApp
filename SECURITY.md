# Security Policy

## Supported versions

Only the latest release on the Pebble app store gets security fixes. If you're on an older version, update first and check whether the problem is still there.

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Only the maintainer can see the report.

Include what you can of:

- What the problem is and what an attacker could do with it
- Steps to reproduce, or a proof of concept
- The app version, Pebble model and phone platform (Android or iOS)

Please don't include your myAir password, tokens or real therapy data in a report. Redacted logs are fine.

This is a hobby project maintained by one person, so there's no bounty and no fixed response time. I'll aim to acknowledge a report within a week, keep you posted while I work on it, and credit you in the release notes if you'd like.

## Scope

In scope:

- The watch app (`src/c/`)
- The phone-side PebbleKit JS code (`src/pkjs/`), including login, token handling and the settings pages
- How the app stores credentials and sleep data on the phone and watch

Out of scope:

- ResMed's myAir service, Okta, or the Pebble/Rebble apps and services. Report those to their owners
- Attacks that need a rooted or jailbroken phone, or physical access to an unlocked phone or watch
- Lack of TLS certificate pinning, which PebbleKit JS doesn't support

## How the app handles your data

- Your myAir email and password are entered in the app's settings page and stay on your phone, in the Pebble app's local storage for this app
- Once ResMed issues a refresh token, the stored password is deleted and only tokens are kept
- The app talks only to ResMed's own login (Okta) and myAir API servers. There's no server run by this project, and no analytics
- The watch only receives sleep stats (score, events, usage, mask off, leak), never credentials
- Disconnecting your account in settings removes your credentials and tokens from the phone and the cached stats from the watch. Uninstalling wipes the watch's copy, and the phone's copy is cleared the next time the app is installed

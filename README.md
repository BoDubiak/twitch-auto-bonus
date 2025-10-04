# Twitch Helper for Chrome

## Overview
Twitch Helper is a local Chrome extension that automates a few repetitive actions on twitch.tv. Everything runs in the browser; no external services or accounts are required.

## Features
- Automatically clicks the Channel Points bonus with a configurable delay window.
- Closes the AdBlock overlay so the stream resumes without manual input.
- Auto-votes in Predictions using majority/minority/random/blue/pink strategies with configurable wager and countdown timing.
- All behaviour can be configured from the popup: modules, strategies, wager amounts, and bonus delay.

## Installation
1. Download or clone this repository to a local folder.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the project folder.
5. Open Twitch in a tab - the extension activates automatically.

## Configuration
- Use the popup button to toggle the Bonus, Overlay, and Predictions modules.
- Predictions strategy options: `majority`, `minority`, `random`, `blue`, `pink`.
- Choose the countdown threshold (in seconds) before the script submits a bet.
- Provide either a percent of the maximum wager or a fixed amount (fixed > 0 takes priority).
- Bonus click delay is defined by the minimum and maximum seconds fields.
- Settings persist via `chrome.storage.sync` so they follow you to other Chrome profiles that are signed in.

## How It Works
- `content.js` injects into matched Twitch pages and observes the DOM via `MutationObserver`.
- Bonus detection targets `claimable-bonus__icon` and `community-points-summary-claim-button` selectors.
- Overlay cleanup searches for "Return to stream" buttons and clicks them with a short delay.
- The Predictions module opens Reward Center dialogs, picks a side, applies stake rules, and confirms the vote.

## Limitations
- The logic depends on Twitch DOM structure; layout changes may require selector updates.
- Predictions rely on `chrome.storage.sync`. If sync is disabled, defaults are used until settings are saved locally.
- Automation should be used responsibly - test with your own account and adjust delays to avoid suspicious behaviour.

## Feedback
Found a bug or have an idea? Open an issue or submit a pull request in this repository.

# AllegationList

A Discord bot that keeps a numbered list of "allegations" against M\*rtin, one list per
server. Anyone can add to it with `/new allegation`, and every allegation is checked by a
built-in automatic moderator (automod) before it's posted.

> [!WARNING]
> **Content warning:** [`blacklist.default.json`](blacklist.default.json) is the bot's
> starter blacklist. It lists slurs and hateful terms (racist, homophobic, transphobic,
> ableist, hate-group and self-harm language) so that the bot can **block** them. You
> don't need to open it to use or read the rest of the code.

## What it does

- **Numbered allegations.** Each server gets a read-only channel. Allegations are posted
  there as "Allegation #1", "#2", … and the numbers close up when one is deleted.
- **Automod.** Every allegation gets a certainty score from 0 to 100%. Clean ones are
  posted straight away, unsure ones are held for moderators, and certain ones are
  rejected. It sees through common disguises: capitals and accents, numbers and symbols
  used as letters, look-alike letters from other alphabets, invisible characters,
  stretched or spaced-out letters, misspellings, endings, and words hidden inside longer
  words.
- **Moderator tools.** Held allegations appear as cards with Approve / Reject buttons in a
  private review channel. Moderators edit the blacklist and allowlist and tune every
  automod setting with slash commands.
- **Optional automatic timeouts** after a configurable number of rejections.
- **Configurable cooldown** between allegations, set by the moderators.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/new allegation` | Everyone | File an allegation (cooldown set by the mods, 30 seconds by default) |
| `/ping` | Everyone | Check the bot is online |
| `/blacklist add · remove · allow · unallow · list` | Moderators | Edit the server's word lists |
| `/automod status · enable · thresholds · review-channel · log-rejections · cooldown · reject-cooldown · strikes · test` | Moderators | Configure automod |

## Running it yourself

Requires [Node.js](https://nodejs.org/) 22 or newer and a bot application from the
[Discord Developer Portal](https://discord.com/developers/applications).

1. Copy `.env.example` to `.env` and fill in your bot's token and application ID.
   **Never commit `.env`.**
2. Install and start:

   ```bash
   npm install
   npm start
   ```

3. Run the tests with `npm test`.

To keep it online around the clock on a free Oracle Cloud server, see
[`DEPLOY.md`](DEPLOY.md).

## How it's built

| File | What's in it |
|---|---|
| [`architecture.md`](architecture.md) | Overview of the whole codebase: modules, design decisions, data model, data flows |
| [`automod-plan.md`](automod-plan.md) | How the automod score works, with worked examples |
| [`security-review.md`](security-review.md) | Findings of a bug and security review, and how each was handled |
| [`automod.js`](automod.js) | The scorer: pure functions, no Discord code |
| [`automod.test.js`](automod.test.js) | Unit tests, using harmless stand-in words |

## License

Copyright © 2026 Dratic95. All rights reserved.

The source is published so people can read it. It is not licensed for reuse,
modification or redistribution.

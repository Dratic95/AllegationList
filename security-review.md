# Security & bug review — 2026-11-17

Two full scans (a line-by-line read of every file, then an end-to-end trace of every flow),
plus an independent review by a separate agent that hadn't seen the first two. Findings
were verified against the code; the scorer ones were reproduced with stand-in words.

No critical issues: the bot token is never printed or committed, there is no prototype
pollution, no regex injection or ReDoS, and no way for a non-mod to approve, reject or
change settings.

Status key: ✅ fixed · ➖ accepted as-is (reason given)

## Medium

| # | Finding | Status |
|---|---|---|
| 1 | **Timeout loophole.** Once strikes are on, a mod with only Manage Messages can cause mass timeouts by making *more* things rejected (`/blacklist add`, `/blacklist unallow`, lower `/automod thresholds`, re-enabling automod, "Reject + add word"). `/automod strikes enabled:false` also stored harsh limits/durations that the next enable silently inherited. | ✅ Those changes (for thresholds: lowering the reject level) now need **Timeout Members** while strikes are on; turning strikes off no longer stores other options. |
| 2 | **Review queue denial of service.** No per-user limit, review items never expire: one member could fill all 500 slots in ~4 h and block reviews server-wide, spamming notifying cards. | ✅ At most 3 items per member waiting for review. |
| 3 | **Orphaned review items.** Deleting a card, purging or deleting the review channel left pending items that could never be clicked and counted toward the cap forever. | ✅ Deleting a card dismisses its item; if the review channel is deleted and recreated, waiting items get fresh cards. |
| 4 | **Allowlist bypass with a symbol.** If an allowlisted word is the start/end of a blacklisted one, writing a symbol for the next letter (`chick€n`) blanked the allowed part and slipped through. Also, allowing a word blanked word+suffix even when that was itself blacklisted. | ✅ Allowlist boundaries treat leet symbols as letters; a suffixed form that is itself a term is never blanked. |
| 5 | **Review channel could be public.** `/automod review-channel` only warned when @everyone could see it, so held/rejected text (often slurs) could be shown to every member. | ✅ Refused when @everyone can view it. |

## Low

| # | Finding | Status |
|---|---|---|
| 6 | `strict` terms still matched split words ("chick en"), contradicting the docs. | ✅ |
| 7 | Startup race: a `/new` arriving before the rebuild was queued could be numbered from the stale saved list. | ✅ Rebuild is queued first. |
| 8 | Reject cooldown of 0 also removed the normal 30 s cooldown, allowing unthrottled spam of log cards and disk writes. | ✅ A rejection always waits at least the normal 30 s. |
| 9 | A mod overriding a rejection didn't remove the strike it caused. | ✅ Strike removed (an already-applied timeout is left to mods). |
| 10 | Admins collected strikes and triggered "can't time out" log spam. | ✅ Admins don't get strikes. |
| 11 | `/blacklist remove`, `unallow`, `allow` changed settings in memory before a limit check could fail → unsaved, stale-cache changes. | ✅ Checks first, then change. |
| 12 | Settings handlers could call `fetchMe()` before replying (3-second deadline). | ✅ Uses the cached member. |
| 13 | Buttons/modals the bot doesn't recognise got no response ("interaction failed"). | ✅ Private "no longer active" reply. |
| 14 | Unknown `/automod` subcommand (e.g. stale registration) crashed the handler; lookup didn't check own properties. | ✅ |
| 15 | Error reply read `err.code` without guarding against non-Error throws. | ✅ |
| 16 | Deprecated modal API (`ActionRow` + `TextInput.setLabel`). | ✅ Uses `LabelBuilder`. |
| 17 | `package.json` allowed discord.js versions without the `clientReady` event. | ✅ `^14.28.1`. |
| 18 | Masked links `[text](url)` rendered in public allegations (phishing-style links). | ✅ Masked-link brackets are escaped; the address stays visible. |
| 19 | Fallback (non-atomic) save left a stale `data.json.tmp` that a later load could silently prefer. | ✅ Removed after a successful fallback write. |
| 20 | Held/rejected text and strikes for servers the bot left stayed on disk forever. | ✅ Cleared when the bot leaves a server (not on outages). |
| 21 | Docs/comment mismatches (storage header, `/ping` guild check, a few sends without `allowedMentions`, dependency diagram). | ✅ |

## Accepted as-is

| Finding | Reason |
|---|---|
| A lost response from Discord after a successful post could duplicate an allegation on retry. | Very rare; the startup rebuild corrects the numbering. |
| A review channel visible to a broad role (not @everyone) isn't flagged. | Can't tell which roles are "mods"; the @everyone case is refused and the channel is private by default. |
| Every change rewrites `data.json` synchronously. | Fine at this bot's scale; batching saves would risk losing data on a crash. |
| `/blacklist` and `/automod` rely on Discord's command permissions. | Intended: admins choose who gets them in Server Settings → Integrations. Buttons re-check Manage Messages. |

# AllegationList — Architecture

> **Living document.** Update this file *before* changing code: the folder map,
> patterns and data flows here should always match what the bot actually does.
> Last updated: 2026-11-22

## What it is

A Discord bot (Node.js + discord.js v14) that keeps a **numbered list of
"allegations" against M\*rtin, separately for every server it's in**.
Each server gets a read-only channel, **All Of M\*rtins Allegations**, and anyone
can add to it with `/new allegation`.

Every allegation is screened by **automod** first: a certainty score decides whether
it's posted straight away, held for moderators, or rejected. Moderators manage the
blacklist and every automod setting with slash commands. The design rationale (how
the score works, worked examples) is in [`automod-plan.md`](automod-plan.md).

## Bird's-eye diagram

```
                ┌──────────────────────────── Discord ─────────────────────────────────┐
   member       │  /new allegation "…"      #all-of-m*rtins-allegations (read only)     │
   mods         │  /blacklist  /automod      #allegation-review (private, buttons)      │
                └──────┬───────────────────────────────▲──────────────────▲────────────┘
            interactions (commands, buttons, modals)   │ post allegation  │ review / log cards
                       ▼                               │                  │ (+ DMs, timeouts)
┌──────────────────────────────────────── bot process ─┼──────────────────┼────────────┐
│ index.js       config, client, event wiring, timers  │                  │            │
│   └─ interactionCreate ─► commands.js ───────────────┤                  │            │
│                   │        /new  /ping  /blacklist  /automod            │            │
│                   │          │                                          │            │
│                   │          ├─► moderation.js ── screen() ─► automod.js (pure scorer)│
│                   │          │      review cards, strikes, ───────────────┘            │
│                   └─ buttons/modals ─► moderation.js (approve/reject/override/add)   │
│                                         │                                            │
│                         allegations.js ◄┘ postAllegation(): number, post, rollback   │
│                         channels.js       find-or-create allegations + review channel│
│                         storage.js ◄────► data.json (atomic saves)                   │
│                         blacklist.default.json (starter list, read at startup)        │
└──────────────────────────────────────────────────────────────────────────────────────┘

set-avatar.js ── one-off script ── REST: PATCH /users/@me (avatar.gif/.png) ──► Discord
```

## Folder structure

```
AllegationList/
├── index.js               Entry point: config check, client, event wiring, command registration, timers
├── commands.js            Slash commands: /new allegation, /ping, /blacklist …, /automod …
├── moderation.js          Discord side of automod: per-server blacklist, screening, review/log
│                          cards, button + modal handlers, strikes → timeouts, DMs
├── automod.js             PURE scorer (no Discord code): normalise → candidates → score
├── allegations.js         Numbered allegation list: post, delete, startup rebuild, renumber + cooldowns
├── channels.js            Find-or-create for the allegations channel and the review channel
├── storage.js             data.json load/save, per-server records and automod settings
├── blacklist.default.json Starter blacklist + allowlist (shipped with the bot)
├── automod.test.js        Unit tests for automod.js (`npm.cmd test`)
├── deploy/                Running the bot 24/7 on a Linux server (see "Hosting" below)
│   ├── setup-server.sh    Runs ON the server: installs Node.js, installs/updates the bot, starts the service
│   ├── allegationlist.service  systemd unit: start on boot, restart on crash, locked-down permissions
│   └── deploy.cmd         Runs on this PC: packs the project, uploads it over SSH, runs setup-server.sh
├── DEPLOY.md              Step-by-step guide to hosting on Oracle Cloud's free tier
├── set-avatar.js          One-off: uploads a picture as the bot's profile picture (default avatar.gif; PNG/JPEG/GIF)
├── avatar.gif             Bot profile picture (animated, 480×476)
├── avatar.png             The previous (still) profile picture, kept as a backup
├── avatar.old.png         The original profile picture, kept as a backup
├── package.json           Dependencies (discord.js), `start` and `test` scripts
├── package-lock.json      Exact installed versions
├── .env                   SECRET — DISCORD_TOKEN, CLIENT_ID, GUILD_ID (git-ignored)
├── .env.example           Template for .env
├── data.json              Runtime state, created by the bot (git-ignored)
├── data.json.tmp          Exists only for a moment during a save (git-ignored)
├── automod-plan.md        Design notes for automod
├── security-review.md     Findings of the 2026-11-17 bug & security review, and what was done
├── CLAUDE.md              Rules for Claude: update this file before changing code
├── .gitignore             Keeps .env, data.json, node_modules (and tool folders) out of git
├── .gitattributes         Pins line endings: CRLF for deploy.cmd, LF for the Linux scripts
├── README.md              Public overview for GitHub: what the bot does, setup, content warning
├── architecture.md        This file
└── node_modules/          Installed packages (npm install)
```

Module dependencies only point "down", so there are no import cycles:

```
index.js    → commands.js, moderation.js, allegations.js, channels.js
commands.js → moderation.js, allegations.js, storage.js
moderation.js → allegations.js, channels.js, storage.js, automod.js
allegations.js → channels.js, storage.js
channels.js → storage.js
storage.js  → automod.js (default thresholds only)
```

| Module | Responsibility |
|---|---|
| `storage.js` | Loads/saves `data.json`; `guildData(id)` gets-or-creates a server record; `automodSettings(id)` returns that server's settings with defaults filled in and bad hand-edited values repaired; `trySave()` logs instead of throwing. Path can be overridden with `ALLEGATIONS_DATA_FILE` (used by tests). |
| `channels.js` | `getAllegationsChannel(guild)`, `getReviewChannel(guild)`: one generic find-or-create with a per-server, per-kind lock |
| `allegations.js` | `postAllegation()`, deletions, the startup rebuild and the renumber worker (all list changes go through a per-server queue), plus the per-user cooldown map (stores "blocked until" times so cooldowns can vary in length) |
| `automod.js` | `compileList()`, `scan()`, `termKey()`, `lightNormalize()` — pure functions, unit tested |
| `moderation.js` | Default list loading, per-server effective list (cached, invalidated on change), `screen()`, card building, `handleComponent()` for buttons/modals, strikes, pending-item pruning |
| `commands.js` | Command definitions + `execute` functions |
| `index.js` | Wires it all to the Discord client |

## Design patterns

- **Server-only commands.** Commands are registered with `contexts: [Guild]` and
  `integration_types: [GuildInstall]`, so they only appear in servers the bot has been
  added to. Every command also checks `inCachedGuild()` as a backstop.
- **Unknown buttons get an answer.** A button or modal the bot doesn't recognise (e.g. from
  an old version) gets a private "no longer active" reply instead of "interaction failed".
- **Mod-only commands by default.** `/blacklist` and `/automod` use
  `setDefaultMemberPermissions(ManageMessages)`; admins can change who sees them in
  *Server Settings → Integrations*.
- **Timeouts need Timeout Members.** Turning auto-timeouts on requires the caller to have
  **Timeout Members** themselves. While strikes are on, so does anything that makes *more*
  allegations get rejected: `/blacklist add` with the reject action, `/blacklist unallow`,
  lowering the reject level with `/automod thresholds`, `/automod enable` (turning it on) and
  "Reject + add word". Otherwise
  a Manage-Messages-only mod could time members out indirectly. Turning strikes off is
  always allowed, and stores nothing but "off", so harsh limits can't be planted for later.
- **Buttons re-check permissions.** Review buttons and the add-word modal check
  **Manage Messages** at click time; seeing the review channel is not enough.
- **Defer first.** Slow commands call `deferReply` before any network work, so Discord's
  3-second deadline can't expire. Buttons use `deferUpdate`.
- **Screen before numbering.** Automod runs before a number is reserved; held
  allegations get their number only when approved, so the public list never has gaps.
- **Per-member review limit.** A member can have at most 3 allegations waiting for review,
  so one person can't fill the server's queue.
- **Cards and their items live and die together.** Deleting a review card (or purging the
  review channel) dismisses its item. If the review channel itself is deleted, it is
  recreated straight away when items are waiting, and every waiting item gets a fresh card
  (any later recreation does the same).
- **Review channel stays private.** `/automod review-channel` refuses a channel @everyone
  can see, because held and rejected text often contains slurs.
- **First click wins.** A pending review item is removed from memory synchronously
  (before any `await`) when a mod acts on it, so two mods clicking at once can't both
  approve it. If posting then fails, the item is put back.
- **Pure scorer.** `automod.js` has no Discord or file access, so it is unit tested
  directly and is cheap to call (compiled list cached per server).
- **Same normalisation on both sides.** Blacklist terms and messages go through the
  same pipeline, so every disguise collapses to the same "skeleton".
- **Run-length check on repeated letters.** Repeated letters are collapsed for
  comparison, but a match also requires the message to have *at least* as many of each
  repeated letter as the term. This catches stretched words (`chiiicken`) without
  turning short words with a double letter into common words.
- **Action decides the ceiling.** A `review` term can send an allegation to mods but
  never reject it, whatever its score or the thresholds.
- **Allowlist on the lightly normalised text.** Allowlisted words are blanked out of the
  message *before* the heavy normalisation, so collapsing letters can never make a
  blacklisted word look like an allowlisted one. An allowed word only counts as a whole
  word when it isn't touching a letter, digit *or leet symbol* (`@ $ € £ ¢ ! ¡ | +`), so
  `chick€n` can't hide behind an allowed "chick". An allowed word plus an ending
  (`-s`, `-er`, …) is only blanked if that longer form isn't itself blacklisted.
- **No masked links in allegations.** `[text](url)` is shown literally (brackets escaped)
  so the public channel can't carry disguised links; the address itself stays visible.
- **Never echo the blocked word to the author.** Users are only told "contains a blocked
  word"; mods see the match (spoilered) on the card.
- **Per-server lock on channel setup.** One in-flight find-or-create promise per
  server *and* channel kind, so simultaneous callers never make duplicate channels.
- **Only recreate on "Unknown Channel".** If a saved channel can't be fetched because
  of anything *other* than Discord error 10003 (deleted), it's reported as an error rather
  than replaced, so a permissions problem never spawns a duplicate channel.
- **Numbers follow the channel.** An allegation's number is its position among the
  allegations that still exist in the channel. The server record keeps an ordered list of
  posted allegations (`message id` + the number currently shown on it). Deleting one
  removes it from the list and every later allegation is edited down by one, so there are
  never gaps; the next allegation gets `list length + 1`.
- **One list change at a time per server.** Posting, deletions and the startup rebuild
  all go through a per-server queue (`serial()`), so two of them can never interleave and
  give out the same number. Posting is rare (30 s cooldown per user), so the queue is
  never a bottleneck.
- **Renumbering runs in the background.** A per-server worker repeatedly finds the first
  allegation whose shown number differs from its position and edits it, until none differ.
  It is outside the queue, so a long renumber (deleting #1 of 500) never blocks new posts.
  Each edit records the number it actually wrote, so a deletion mid-renumber just makes the
  worker pass over that part again. On an unexpected error it stops and is retried at the
  next change or the next hourly housekeeping run.
- **Rebuild from the channel at startup.** Deletions that happen while the bot is
  offline are invisible, so on startup the bot reads the allegations channel's history
  and rebuilds the list from its own "Allegation #N" messages (oldest first), then
  renumbers. This also migrates servers from the old "counter only" format.
- **Recreated channel starts again at #1.** If the allegations channel was deleted and
  is recreated, the list is reset, because none of the old allegations exist any more.
- **Variable cooldowns.** The cooldown map stores "blocked until" times: 30 s after a
  normal submission, a mod-configured length (never less than 30 s) after an automatic
  rejection. Cleared if
  the command fails. Swept every 5 minutes. Members with the **Administrator** permission
  are exempt from both: they can file as often as they like. (Automod still screens what
  they file, but admins never get strikes, since they can't be timed out.)
- **Overrides undo strikes.** Each logged rejection remembers the strike it caused;
  "Override & post" removes that strike. A timeout already applied is left for mods to lift.
- **Atomic saves.** `data.json` is written to `data.json.tmp` then renamed over the original.
  On load: `data.json` → else `data.json.tmp` → else the corrupt file is set aside and the
  bot starts empty. A UTF-8 BOM is stripped before parsing. If the rename fails (file
  locked) the bot writes `data.json` directly and then deletes the temp file, so a stale
  copy can never be loaded later.
- **Repair settings on read.** `automodSettings()` replaces any missing or invalid value
  (e.g. from a hand-edited `data.json`) with its default, so bad data can't crash a scan.
- **Bounded storage.** Each server holds at most 500 pending items, 500 added terms and
  500 allowlist entries. Rejection logs expire after 7 days; strike timestamps expire with
  their window. Pruned hourly. When the bot is removed from a server (not a Discord outage),
  that server's held/rejected texts and strikes are deleted; its settings and word list are
  kept in case it's added back.
- **Only set permissions the bot has.** Channel permission overwrites are filtered through
  `me.permissions.has()`, because Discord rejects ones the bot lacks.
- **Mentions never ping.** Every message and reply the bot sends uses `allowedMentions: { parse: [] }`.
- **Housekeeping is silent.** Channel intros, rejection logs, blacklist-change notes and
  timeout notices are sent with Discord's `SuppressNotifications` flag (like `@silent`):
  they show as unread but never trigger a notification, even in servers whose default
  notification setting is "All Messages". Only messages someone may want to act on
  notify: review cards and the allegations themselves.
- **Process-level safety nets.** `client.on('error')` and `unhandledRejection` are logged.
- **Clean shutdown.** On SIGTERM/SIGINT (a service stop, a server reboot, Ctrl+C) the bot
  disconnects from Discord and exits with code 0. Nothing needs flushing: every change is
  already saved when it happens, and the startup rebuild fixes a renumber cut short.
- **Command registry.** Each command is `{ data, execute }` in one array; a `Map` dispatches.
- **Central error boundary.** `interactionCreate` wraps every command, button and modal
  in try/catch and sends the user a private "something went wrong" message.
- **Config via environment.** Secrets only in `.env`, loaded by `node --env-file=.env`.

## Data model — `data.json`

```json
{
  "guilds": {
    "<server id>": {
      "channelId": "<allegations channel id>",
      "allegations": [{ "id": "<message id>", "shown": 1 }],
      "automod": {
        "enabled": true,
        "reviewChannelId": null,
        "thresholds": { "reject": 0.9, "review": 0.75 },
        "logRejections": true,
        "rejectCooldownSeconds": 30,
        "strikes": { "enabled": false, "limit": 3, "windowMinutes": 1440, "timeoutMinutes": 10 },
        "added":   [{ "term": "…", "action": "reject", "match": "fuzzy", "by": "<user id>", "at": 0 }],
        "removed": ["<term key>"],
        "allowAdded":   ["…"],
        "allowRemoved": ["…"]
      },
      "pending": {
        "<uuid>": {
          "kind": "review | rejected",
          "text": "…", "userId": "…", "score": 0.83,
          "match": { "term": "…", "how": "fuzzy", "found": "…" },
          "cardChannelId": "…", "cardMessageId": "…", "at": 0,
          "strikeAt": 0
        }
      },
      "strikes": { "<user id>": [0, 0] }
    }
  }
}
```

- `allegations` = the posted allegations still in the channel, oldest first. An entry's
  number is its position (index + 1); `shown` is the number currently on the message, which
  only differs from the position while a renumber is in progress. Posted text lives in the
  channel. (Older data files had a `count` instead; it is dropped and the list is rebuilt
  from the channel at startup.)
- `pending.text` is stored because held/rejected text isn't in any public message.
- `removed` holds *term keys* (normalised skeletons), so "Chicken" and "chicken" are one entry.
- `added[].match` is `fuzzy`, `strict` or `anywhere`; absent means "decide by length".
- `strikes` holds the times of each user's recent automatic rejections. A rejection log's
  `strikeAt` is the strike it added (absent if none), so an override can remove it.

## Automod — how a message is scored (summary)

1. **Allowlist** words are blanked from the lightly normalised text (accents stripped,
   look-alike letters mapped, lower-case).
2. Two **views** are built: one where digits/symbols become letters (`ch1ck3n`), one where
   they are separators (`cat!`). Then `l→i`, `ph→f`, `ck→k`, `qq→gg`, repeated letters collapsed (trailing `!`, `|`, `+` count as punctuation).
3. **Candidates**: each word, spaced-out letters glued (`C H i c k e n`), adjacent word
   pairs joined (`chick en`), multi-word windows, and digit runs (for numeric terms).
4. **Score** per term: exact 1.00 · spaced 0.98 · suffix (`s es z er ers ed ing y ish`)
   0.95 · split 0.85 (long terms only) · embedded in a longer word 0.92, so it rejects by
  default (long fuzzy terms, plus any term set to `anywhere`) ·
   fuzzy ≤ 0.94 (weighted Damerau–Levenshtein: swap 0.5, vowel↔vowel 0.75, other
   substitution 2, insert/delete 1, first letter different +0.5; long single-word terms only).
5. **Outcome**: the best match among `reject` terms ≥ reject threshold → **reject**;
   otherwise the best match of any term ≥ review threshold → **review**; else **accept**.

Terms are `fuzzy` by default when they're a single word whose skeleton is 5+ letters;
otherwise `strict` (exact, spaced and suffix matches only: no misspellings, no "inside
another word", no split words). A third mode, `anywhere`, is for short words mods want
caught inside other words too (`cat` in `catdog`): it adds the embedded match to whatever
the term would otherwise get. It's opt-in per term because doing it for every short default
term flagged about 1 in 25 ordinary English words (980 of ~23,000) in testing; the allowlist
rescues innocent words it catches. The embedded match also needs the term's repeated
letters to be there (the same run-length check as exact matches).

**The blacklist and allowlist never share a word.** Two entries are "the same word" when
`termKey()` gives the same skeleton. `/blacklist add` takes the word off the allowlist
(server-added entries are deleted, default ones are switched off), and `/blacklist allow`
takes it off the blacklist the same way. The reply says when that happened. Because taking a
word off the allowlist makes automod stricter, `/blacklist add` of a `review` term needs the
Timeout Members permission (while strikes are on) when it would do that, the same as
`unallow`.

## Data flows

### 1. Startup
```
npm.cmd start → node --env-file=.env index.js
 → storage: load data.json (or start empty)
 → moderation: load + compile blacklist.default.json (empty list + error log if unreadable)
 → registerCommands(): PUT global commands; clear GUILD_ID's old server-only commands
 → client.login(token)
 → clientReady: prune expired pending/strikes; for each server → queue the rebuild first (so
   no /new can be numbered from the stale list), set up the allegations channel, then rebuild
   the list from the channel history → renumber anything out of place
 → hourly: prune again; restart any renumber that stopped on an error
```

### 2. Bot joins a new server
```
guildCreate → create locked allegations channel → save its id → post intro message
(the review channel is created lazily, the first time something needs reviewing)
```

### 3. `/new allegation <text>`
```
validate (in server, not blank) → cooldown check → start 30 s cooldown (both skipped for admins) → deferReply (private)
 → automod off? → accept
 → screen(): scan(text, server's compiled list, thresholds)
   accept → postAllegation() (in the server queue): channel → N = list length + 1
            → post embed "Allegation #N" → add to list → save
            → "✅ Allegation #N has been added"
   review → member already has 3 waiting? → "wait for a decision"; queue full? → "try later"
          → save pending item → post review card [Approve] [Reject] [Reject + add word]
            (card failed → pending item removed, error reply)
          → "🕵️ sent to the moderators for review"
   reject → cooldown = rejectCooldownSeconds
          → logging on? → save pending item (kind "rejected") → post log card [Override & post]
          → strikes on (and not an admin)? → record strike → limit reached within window? → timeout member,
            clear their strikes, note it in the review channel
          → "❌ automatically rejected"
```

### 4. Mod clicks a button on a card
```
check Manage Messages → look up pending item in *this* server → remove it (sync) → deferUpdate
 Approve / Override → postAllegation() → card turns green "Approved by @mod — #N" → DM author
                      (post failed → item restored, private error to the mod)
 Reject            → card turns grey "Rejected by @mod" → DM author
 Reject + add word → modal asks for the word → validate → add to blacklist → reject as above
Missing item (already handled / expired) → private "already handled" reply
```

### 5. `/blacklist` and `/automod` (mods)
```
/blacklist add|remove|allow|unallow → validate → update data.json → drop the server's
                                      compiled-list cache → log the change to the review channel
/blacklist list                     → private .txt attachment
/automod status|enable|thresholds|review-channel|log-rejections|reject-cooldown|strikes|test
```

### 6. An allegation is deleted
```
messageDelete / messageDeleteBulk in the allegations channel (by a mod, or via purge)
 → (server queue) remove those ids from the list → save
 → renumber worker: edit each later allegation to its new position (#3 → #2, …)
   (message already gone → drop it from the list and carry on)
Deleted while the bot was offline → caught by the rebuild at the next startup
```

### 7. A review card or the review channel is deleted
```
messageDelete / messageDeleteBulk of a card in the review channel → drop its pending item
channelDelete of the review channel → items waiting? → recreate it now → repost their cards
```

### 8. Bot removed from a server
```
guildDelete (server available, i.e. not an outage) → delete pending items and strikes → save
```

### 9. Errors
```
any command / button / modal throws → central handler → logs it
 → private message: "I'm missing permissions…" (Discord 50001/50013) or generic
 → uses editReply / followUp / reply depending on whether the bot already responded
```

### 10. Channel locking (permission overwrites set at creation)
| Channel | @everyone | The bot |
|---|---|---|
| Allegations | view + read history, can't send/thread/react | view, send, embed links |
| Review (auto-created) | can't view | view, send, embed links, read history |

Administrators always bypass channel locks. Mods can be given access to the review
channel by an admin, or `/automod review-channel` can point at an existing mod channel.

## External dependencies & permissions

- **discord.js 14.x** — the only runtime dependency.
- **Gateway intents:** `Guilds` and `GuildMessages` (needed to hear about deleted
  allegations). No privileged intents: no message content, no member list. The message
  cache is turned off, and the `Message` partial lets delete events arrive for messages that
  aren't cached (only the id is needed).
- **Bot permissions requested by the invite link** (permissions integer `1477737270352`):
  Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links,
  Read Message History, Add Reactions, Send Messages in Threads, Create Public Threads,
  Create Private Threads, **Timeout Members** (for automod strikes; servers that invited
  the bot earlier must grant it to the bot's role, and the bot's role must be above the
  members it times out).

  `https://discord.com/oauth2/authorize?client_id=1571117641291137124&scope=bot+applications.commands&permissions=1477737270352`
- **Discord app settings** (Developer Portal, not code): "Public Bot" decides whether anyone
  can invite it; commands are registered as server-install only regardless.

## Testing

- `npm.cmd test` runs `automod.test.js` (node:test): disguises, worked examples,
  false-positive guard on ordinary sentences against the real default list, strict terms,
  review-only terms, allowlist, numeric terms.
- The Discord-facing modules are exercised with a fake discord.js harness kept outside the
  repo (real builders/constants, fake network): accept/review/reject paths, approve/reject/
  override buttons, double clicks, add-word modal, strikes → timeout, settings validation,
  restart with pending items, and numbering: delete-then-post reuses the number, later
  allegations move down, middle and bulk deletes, simultaneous posts, a delete during a
  renumber, offline deletes fixed by the startup rebuild, old-format migration, edit failures
  retried, a recreated channel restarting at #1.

## Running

Locally (for testing):
```
cd %USERPROFILE%\Documents\AllegationList
npm.cmd start
```
Only run **one** copy at a time, or every command is answered twice. Once the bot is hosted,
don't start it on this PC as well.

## Hosting (24/7)

The bot runs on an Oracle Cloud "Always Free" Ubuntu server as a **systemd service**, so it
starts when the server boots and restarts itself 10 s after any crash. `DEPLOY.md` is the
step-by-step guide.

```
this PC                                    Oracle Cloud server (Ubuntu)
deploy\deploy.cmd <user@ip> <key>
  → tar the project (no node_modules,      ~/allegationlist-upload.tgz
    no logs, no local test files)    ──scp──►
  → ssh: unpack, run setup-server.sh  ──ssh──► setup-server.sh (sudo)
                                                 → Node.js 24 from NodeSource (first run only)
                                                 → system user "allegationlist" (no login)
                                                 → copy code to /opt/allegationlist
                                                   (data.json only on the FIRST install;
                                                    afterwards the server's copy is kept)
                                                 → npm ci --omit=dev
                                                 → .env owned by the service user, mode 600
                                                 → install + enable + restart the service
                                               systemd: allegationlist.service
                                                 node --env-file=.env index.js
                                                 Restart=always, logs → journalctl
```

- **The server's data wins.** After the first deploy, `data.json` on the server is the live
  copy; deploys never overwrite it. `setup-server.sh` backs it up to
  `data.json.bak-<time>` before every update (keeping the newest 5).
- **No open ports.** The bot only makes outgoing connections to Discord, so the server needs
  no inbound rules beyond SSH (Oracle's default).
- **Locked-down service.** The unit runs as an unprivileged user with `NoNewPrivileges`,
  `ProtectSystem=strict` (only `/opt/allegationlist` writable), `ProtectHome`, `PrivateTmp`
  and related hardening, so a bug in the bot can't touch the rest of the server.
- **Idle reclamation.** Oracle may stop Always Free servers whose CPU, network and (Arm shapes)
  memory stay under 20% for 7 days, which a bot would. The guide has the account upgraded to
  Pay As You Go, which keeps Always Free resources free but exempts them from that.

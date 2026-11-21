# Automod — automatic allegation screening (PLAN)

> Status: **built** (2026-11-17). This is the original design write-up; where the build differs, `architecture.md` describes what the code actually does and the differences are noted below.
> `architecture.md` has the short version under "Planned: Automod"; this file is the detail.

## Goal

Every `/new allegation` is scanned **before** it gets a number or is posted. A
certainty score (0–1) decides one of three outcomes:

| Score | Outcome | What happens |
|---|---|---|
| `< review` (default 0.75) | ✅ **Accept** | Posted exactly as today |
| `review … reject` | 🕵️ **Review** | Held; sent to mods with Approve / Reject buttons |
| `≥ reject` (default 0.90) | ❌ **Reject** | Not posted; user told privately; logged for mods |

It must catch blacklisted words that are written straight, **disguised**
(`C H i c k e n`, `c.h.i.c.k.e.n`, `ch1ck3n`, `chiiiicken`, Cyrillic look-alikes,
zero-width characters) or **misspelled** (`Cihcken`, `Chickan`). Moderators manage
the list with slash commands — no file editing, no restart.

---

## 1. How the score is worked out (`automod.js`)

A pure module with no Discord code, so it can be unit tested on its own.
`scan(text, list) → { score, outcome, match }` where `match` says which term was hit,
how (`exact`, `spaced`, `suffix`, `fuzzy`, `embedded`) and the piece of text that hit.

### Step 1 — Normalise (applied to the message **and** to every blacklist term)

The same function runs on both sides, so whatever the trick, both collapse to the
same "skeleton".

1. Unicode `NFKD`, then drop combining accents → `çhíckén` → `chicken`.
   Also folds full-width / mathematical letters (`ｃｈｉｃｋｅｎ`, `𝐜𝐡𝐢𝐜𝐤𝐞𝐧`).
2. Delete invisible characters (zero-width space/joiner, soft hyphen, variation selectors).
3. Lower-case.
4. Homoglyphs → Latin: Cyrillic/Greek look-alikes (`а е о р с х у і ѕ ο ν` …) and
   symbols (`@→a`, `$→s`, `€→e`, `£→l`, `!→i`, `|→i`).
5. Leetspeak digits: `0→o 1→i 3→e 4→a 5→s 7→t 8→b 9→g`, and `ph→f`, `ck→k`, `qq→gg` (a single `q` stays, so "faq" is safe).
   Ambiguous ones (`1` = i or l) map to **one** canonical letter on both sides
   (`l→i` too), so it doesn't matter which the writer meant.
6. Collapse repeated letters: `chiiiicken` → `chicken` (`chicken` itself → `chiken`;
   fine, because the term gets the same treatment).

### Step 2 — Build candidates from the message

- **Words**: split on anything that isn't a letter.
- **Spaced-out runs**: consecutive 1–2 letter fragments separated by spaces / dots /
  dashes / underscores are glued together: `C H i c k e n`, `c.h.i.c.k.e.n`,
  `chi-ck-en` → `chiken`. Only *short* fragments are glued, so normal sentences
  ("a chick entered") never merge into a match.
- **Word windows**: 2- and 3-word windows (for multi-word terms like "kill time",
  and for split words like `chick en`).

### Step 3 — Score each candidate against each term (take the highest)

| How it matched | Score | Example (term "chicken") |
|---|---|---|
| Exact skeleton match | **1.00** | `chicken`, `CH1CK3N`, `chiiicken`, `сhicken` (Cyrillic с) |
| Spaced-out run equals term | **0.98** | `C H i c k e n`, `c.h.i.c.k.e.n` |
| Term + common ending (`s es z er ers ed ing y ish`) | **0.95** | `chickens` |
| Fuzzy (see below) | **up to 0.94** | `cihcken` 0.92, `chickan` 0.83, `chikn` 0.83 |
| Term hidden inside a longer word | **0.92** (was 0.80; see §9) | `xxchickenxx` |

**Fuzzy** = Damerau–Levenshtein edit distance on the skeletons, with weights tuned to
how people disguise words:

- swapped neighbours (`ih`↔`hi`) cost **0.5** — deliberate scrambles should still reject
- substitution / missing / extra letter cost **1.0**
- first letter different: extra **0.5** (real typos rarely hit the first letter, so
  this cuts false positives a lot)
- `score = 1 − cost / length(term)`, capped at 0.94 (fuzzy alone is never "certain"
  for a 1-edit change unless it's a swap)

Worked examples (term "chicken", skeleton `chiken`, 6 letters):

| Input | Cost | Score | Outcome |
|---|---|---|---|
| `Cihcken` | 0.5 (one swap) | 0.92 | ❌ reject |
| `Chickan` | 1 | 0.83 | 🕵️ review |
| `Chikn` | 1 | 0.83 | 🕵️ review |
| `Kitchen` | ≥3 | ≤0.5 | ✅ accept |

### Step 4 — Guard rails against false positives

- **Short terms (≤ 4 letters) are `strict`** by default: exact / spaced / suffix
  matches only — no fuzzy, no "inside another word". Stops `ass` hitting `class`,
  or a 3-letter slur matching dozens of normal words one edit away.
- **Allowlist**: real words that contain or resemble a term (`scunthorpe`, `spicy`,
  `grape`, `cocoon`, `raccoon`, `pakistan`, …). A candidate that *is* an allowlisted
  word scores 0 for every term. Mods can add to it.
  **The allowlist is compared on the plain lower-cased word, not the skeleton.**
  Otherwise repeat-collapsing would turn a slur into an innocent allowlisted word
  (e.g. a double-g slur collapses to the country name "Niger") and whitelist it.
- **Per-term action**: a term can be `"action": "review"` instead of `"reject"`.
  A match on it can send to mods but never auto-reject, whatever the thresholds are. For words
  that are a slur in one context and innocent in another (e.g. a word that is
  also part of a scientific name).
- Length pre-filter: skip fuzzy when lengths differ by > 2 — keeps the scan cheap
  (≈200 words × ≈250 terms is well under a millisecond-scale budget per message).

---

## 2. The blacklist — where it lives and how mods change it

### Two layers

1. **`blacklist.default.json`** (in the repo, shipped with the bot) — the starter list,
   grouped by category. Owner edits it; applies to every server.
2. **Per-server changes in `data.json`** — what that server's mods added, removed or
   allowlisted.

Effective list for a server = default − `removed` + `added`; allowlist = default
allowlist + `allowed`. Built once and cached per server; rebuilt when a mod changes it.

Entry format:

```json
{ "term": "chicken", "category": "example", "action": "reject", "match": "fuzzy" }
```

`action` defaults to `reject`; `match` defaults to `fuzzy` for ≥ 5 letters, `strict` otherwise.

### Mod commands (`/blacklist`)

Registered with `setDefaultMemberPermissions(ManageMessages)`, so only members with
**Manage Messages** see them (admins can change who in *Server Settings → Integrations*).

| Command | Does |
|---|---|
| `/blacklist add term:<word or phrase> [action:reject\|review] [match:fuzzy\|strict]` | Add a term (or re-enable a default one) |
| `/blacklist remove term:<…>` | Remove a term (default ones are hidden for this server) |
| `/blacklist allow word:<…>` / `/blacklist unallow word:<…>` | Manage the allowlist |
| `/blacklist list` | Private reply with the full list as a `.txt` attachment (so slurs aren't printed in chat) |
| `/blacklist test text:<…>` | Private dry-run: shows the score, outcome and matched term. Nothing is filed. |
| `/blacklist settings [reject:<0–1>] [review:<0–1>] [enabled:<bool>] [review-channel:<#channel>]` | Thresholds, on/off switch, where reviews go |

All replies are ephemeral. Every change is logged to the review channel
("@mod added a term (category: …)") so changes are visible to the mod team.

---

## 3. What the user and mods see

### Accept
Unchanged: allegation posted, user gets "✅ Allegation #N has been added".

### Reject
- User (private): "❌ Your allegation was automatically rejected because it contains a
  blocked word or phrase. If you think this is a mistake, ask a moderator."
  The matched word is **not** shown — otherwise people can probe the filter.
- Cooldown still applies, so variations can't be brute-forced quickly.
- Review channel gets a log card: user, text in a spoiler, score, matched term,
  plus an **Override & post** button for false positives.

### Review
- User (private): "🕵️ Your allegation has been sent to the moderators for review.
  You'll get a DM when it's decided."
- Review channel gets a card with the text (spoilered), score, what it might match,
  and **Approve** / **Reject** buttons.
- Approve → goes through the normal posting path and **gets its number only now**, so
  numbers in the public channel never have gaps. Card is edited to "Approved by @mod".
- Reject → card edited to "Rejected by @mod". User gets a best-effort DM (ignored if
  their DMs are closed).
- Optional on the card: **Reject + add term** — rejects and opens a modal to add the
  word to the blacklist in one step.

### Review channel
`/blacklist settings review-channel:` points it at an existing mod channel. If none is
set, the bot creates a private **#allegation-review** (hidden from @everyone; admins
see it automatically; mods can be given access by an admin). Same find-or-create /
per-server-lock pattern as the allegations channel.

Buttons check **Manage Messages** at click time (not just channel visibility), and a
card that's already been decided can't be decided twice (first click wins; the pending
record is deleted synchronously before any await).

---

## 4. Code changes

```
AllegationList/
├── index.js                 + calls automod before reserving a number
│                            + /blacklist command, button & modal handling
│                            + postAllegation() extracted (used by accept AND approve)
├── automod.js        NEW    pure scanner: normalise, candidates, score
├── automod.test.js   NEW    node:test unit tests (no Discord needed)
├── blacklist.default.json  NEW  starter list + allowlist
└── package.json             + "test": "node --test"
```

### `/new allegation` flow after the change

```
validate text, cooldown, deferReply   (as today)
 → automod off for this server? → accept
 → scan(text, effectiveList(guild))
     accept → postAllegation()                       (reserve number, save, send, rollback)
     review → save pending record → post review card → reply "sent for review"
     reject → post log card (best-effort) → reply "rejected"
```

`postAllegation(guild, text, user)` is today's reserve → save → send → rollback block,
lifted out unchanged so the approve button can reuse it.

### `interactionCreate`

Currently returns early for anything that isn't a slash command. Add:
- `isButton()` → custom ids `am:approve:<id>`, `am:reject:<id>`, `am:override:<id>`, `am:addterm:<id>`
- `isModalSubmit()` → `am:addterm-modal:<id>`

Ids are stored in `data.json`, so buttons keep working after a restart.

### Data model additions (`data.json`)

```json
"<server id>": {
  "channelId": "…", "count": 7,
  "automod": {
    "enabled": true,
    "reviewChannelId": "…",
    "thresholds": { "reject": 0.9, "review": 0.7 },
    "added":   [{ "term": "…", "action": "reject", "match": "fuzzy", "by": "<user id>", "at": 1763380000000 }],
    "removed": ["…"],
    "allowed": ["…"]
  },
  "pending": {
    "<id>": { "kind": "review|rejected", "text": "…", "userId": "…", "score": 0.83,
              "match": { "term": "…", "how": "fuzzy", "found": "…" },
              "cardMessageId": "…", "at": 1763380000000 }
  }
}
```

Pending allegation text has to be stored here (until now only the number was), because
it isn't in any public message yet. `rejected` entries are dropped after 7 days
(override window); `review` entries stay until a mod decides.

No new gateway intents or invite permissions: buttons and modals arrive as interactions,
and the bot can already create channels and send messages.

---

## 5. Testing

`automod.test.js` (run with `npm.cmd test`):
- every disguise from the goal list rejects for a test term ("chicken")
- the worked-examples table above
- allowlist words and everyday sentences accept (a few hundred lines of normal English —
  false-positive guard)
- short strict terms don't fire inside longer words
- `review`-action terms never cause a rejection, even at low thresholds

Then the same fake-discord.js harness used in the 2026-11-17 bug-fix pass for:
review → approve numbering, double-click on a card, restart with a pending item,
review channel deleted, user with closed DMs.

---

## 6. Build order

1. `automod.js` + tests (no bot changes; can be tuned with `/blacklist test`-style script)
2. `blacklist.default.json` (draft exists — see below)
3. Data model + `/blacklist` commands
4. Hook into `/new allegation`: reject path only
5. Review channel, cards, buttons, DMs
6. Update `architecture.md` "Planned" section into the real sections

## 7. Open questions

1. Should rejected attempts be logged to mods at all, or silently dropped?
   (Plan: logged, with an override button.)
2. Default thresholds 0.90 / 0.75 (raised from 0.70 after a 23,000-word false-positive scan). Mods tune them with `/automod thresholds` and check with `/automod test`. **Decided:** configurable.
3. General swearing isn't in the draft list — it's a joke list and swearing is probably
   expected. Mods can add any word they want.
4. Should a user who hits **reject** several times in a row get a longer cooldown?

## 8. Decisions and changes during the build (2026-11-17)

- Q1 → logging rejections is a mod toggle: `/automod log-rejections`.
- Q2 → thresholds are configurable: `/automod thresholds` (percentages).
- Q3 → general swearing stays off the list.
- Q4 → configurable: `/automod reject-cooldown`, plus `/automod strikes` (time out after
  N automatic rejections within a window; N can be 1). Turning strikes on requires the
  mod to have **Timeout Members**. Only automatic rejections count as strikes.
- Settings live under `/automod`; word-list editing under `/blacklist`; the dry run is
  `/automod test`.
- Repeated letters: matches also check the text has at least as many of each repeated
  letter as the term, so short words with a double letter don't match common words.
- Substitutions are weighted (vowel↔vowel 0.75, other 2) and fuzzy matching is limited to
  single words of 5+ letters; phrases and short words are exact-only.

## 9. Changes after launch (2026-11-19)

- A long blacklisted word hidden inside a longer one (`cheeseburger` for `cheese`) now
  **rejects** (score 0.92, was 0.80 = review). Across ~23,000 ordinary English words the
  default list's long terms hid inside just one, and that term is review-only.
- New match mode **`anywhere`** for `/blacklist add`: also catch the word inside longer
  words. Opt-in per term, because doing this for every short default term flagged about
  1 in 25 ordinary words (980 of ~23,000). The allowlist rescues innocent words it catches.
- Spaced-out letters inside a compound (`c h e e s e b u r g e r`) are caught for long terms.
- The blacklist and allowlist can no longer share a word: adding to one takes it off the
  other (same term key), and the reply says so.

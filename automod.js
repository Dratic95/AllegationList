// automod.js - scores a piece of text against a blacklist.
//
// Pure functions only: no Discord, no file access, no shared mutable state. That keeps
// it easy to unit test (automod.test.js) and cheap to call on every allegation.
//
// The pipeline, in short (automod-plan.md has the long version and worked examples):
//   1. blank out allowlisted words from the lightly normalised text
//   2. build two "skeleton" views (digits/symbols as letters, and as separators)
//   3. turn each view into candidates: words, spaced-out letters glued together,
//      adjacent word pairs, multi-word windows
//   4. score every candidate against every relevant term and keep the best match
//   5. turn the best scores into accept / review / reject using the thresholds

// 0.75 for review was picked by running ~23,000 English words through the default
// list: at 0.70 words like "retired" and "fate" were sent to review.
export const DEFAULT_THRESHOLDS = Object.freeze({ reject: 0.9, review: 0.75 });

// How confident each kind of match is. Anything at or above the reject threshold
// (0.9 by default) is treated as certain.
const SCORE = Object.freeze({
  exact: 1,
  spaced: 0.98, // "C H i c k e n"
  suffix: 0.95, // "chickens"
  split: 0.85, // "chick en" - could be two real words, so it's only a review by default
  splitSuffix: 0.8,
  // "chickenburger". Above the default reject threshold: only long terms and terms a mod
  // set to "anywhere" get this match, and across ~23,000 ordinary English words the
  // default list's long terms hid inside just one (a review-only term).
  embedded: 0.92,
  fuzzyCap: 0.94, // a misspelling on its own is never fully certain
  fuzzyFloor: 0.5, // below this a fuzzy match isn't worth reporting at all
});

// Endings that still count as "the same word". Checked against the collapsed
// skeleton, so "-ses" style doubles are already handled by the letter collapse.
const SUFFIXES = ['s', 'es', 'z', 'er', 'ers', 'ed', 'ing', 'y', 'ish'];

// Single-word terms with a skeleton this long (or longer) get misspelling matching
// unless the entry says otherwise. Shorter words sit too close to real English words.
const FUZZY_MIN_LENGTH = 5;

// Weights for the edit distance. Tuned for how people disguise words: swapping two
// neighbours or changing one vowel is cheap; changing a consonant is expensive,
// because that's usually how two genuinely different words differ (cart/card).
const COST = Object.freeze({ swap: 0.5, vowel: 0.75, consonant: 2, indel: 1, firstLetter: 0.5 });
const VOWELS = new Set('aeiouy');

// Glued fragments can only be this many letters each ("C H i c k e n", "ch i ck en").
const MAX_FRAGMENT = 2;
const MAX_INPUT = 4000;

// ---- Normalisation ---------------------------------------------------------

// Look-alike letters from other scripts, and Latin letters NFKD doesn't decompose.
const LETTER_FOLDS = new Map(
  Object.entries({
    // Cyrillic
    а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c', т: 't',
    у: 'y', х: 'x', ш: 'w', щ: 'w', ъ: 'b', ь: 'b', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q',
    ԝ: 'w', ӏ: 'i', ү: 'y',
    // Greek
    α: 'a', β: 'b', γ: 'y', ε: 'e', η: 'n', θ: 'o', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o',
    π: 'n', ρ: 'p', σ: 'o', ς: 'c', τ: 't', υ: 'u', χ: 'x', ω: 'w',
    // Latin extras
    ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', ħ: 'h', þ: 'p', ŧ: 't', ı: 'i',
    ɨ: 'i', ɑ: 'a', ɡ: 'g', ʟ: 'l',
  }),
);

// Digits and symbols used as letters. Only applied in the "leet" view, because the
// same characters are ordinary punctuation most of the time ("wow!").
const LEET = new Map(
  Object.entries({
    0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g',
    '@': 'a', $: 's', '€': 'e', '£': 'l', '¢': 'c', '!': 'i', '¡': 'i', '|': 'i', '+': 't',
  }),
);

const MARKS_AND_INVISIBLES = /[\p{M}\p{Cf}]/gu; // accents, zero-width chars, bidi controls
const ASCII_LETTERS = /^[a-z]+$/;
// One or more of ! ¡ | + not followed by a letter, digit or another leet symbol.
const TRAILING_PUNCTUATION = /[!¡|+]+(?![\p{L}\p{N}@$€£¢])/gu;

/**
 * First, cheap normalisation: compatibility-decompose (folds full-width and "fancy"
 * maths letters), lower-case, drop accents and invisible characters, and map
 * look-alike letters to Latin. Digits and punctuation are left alone.
 */
export function lightNormalize(text) {
  const stripped = String(text).normalize('NFKD').toLowerCase().replace(MARKS_AND_INVISIBLES, '');
  let out = '';
  for (const ch of stripped) out += LETTER_FOLDS.get(ch) ?? ch;
  return out;
}

/**
 * Second stage: everything that isn't a letter becomes a space, then letters that are
 * commonly swapped for each other are merged into one canonical letter. Repeated
 * letters are NOT collapsed here; makeToken() does that so it can remember the runs.
 */
function skeletonText(light, useLeet) {
  // "!", "|" and "+" at the end of a word are punctuation ("ch!cken!"), not letters.
  const source = useLeet ? light.replace(TRAILING_PUNCTUATION, ' ') : light;
  let out = '';
  for (const ch of source) {
    const mapped = useLeet ? (LEET.get(ch) ?? ch) : ch;
    out += ASCII_LETTERS.test(mapped) ? mapped : ' ';
  }
  // l/1/i/|/! all look alike, so they're one letter as far as matching goes.
  // Only a doubled "qq" stands in for "gg"; a single q is too common ("faq").
  return mergeDigraphs(out.replace(/l/g, 'i').replace(/qq/g, 'gg'));
}

// Two-letter spellings of one sound. Kept separate because glued fragments
// ("c" + "k" from "C H i c k e n") have to go through it again after joining.
const mergeDigraphs = (s) => s.replace(/ph/g, 'f').replace(/ck/g, 'k');

/**
 * Collapses repeated letters ("chiiiken" -> "chiken") but keeps how long each run
 * was, so a match can insist the text has at least as many as the term (see runsCover).
 */
function makeToken(raw) {
  let key = '';
  const runs = [];
  for (const ch of raw) {
    if (key.length && key[key.length - 1] === ch) runs[runs.length - 1] += 1;
    else {
      key += ch;
      runs.push(1);
    }
  }
  return { raw, key, runs };
}

const tokenize = (skeleton) => skeleton.split(' ').filter(Boolean).map(makeToken);

/**
 * True if every letter run in the term is matched by a run at least as long in the
 * candidate. This is what stops a short term with a double letter from matching the
 * same word with a single letter, while "stretched" spellings still match.
 */
function runsCover(candidateRuns, termRuns) {
  for (let i = 0; i < termRuns.length; i++) if (!(candidateRuns[i] >= termRuns[i])) return false;
  return true;
}

// ---- Compiling a blacklist -------------------------------------------------

/**
 * Identity of a term: its uncollapsed skeleton, words separated by single spaces.
 * "Chicken", "CH1CKEN" and "chicken " all give the same key. Returns null when the
 * term has fewer than two letters (or digits) after normalisation.
 */
export function termKey(term) {
  const light = lightNormalize(term).trim();
  if (/^\d+$/.test(light)) return light.length >= 2 ? light : null;
  const words = tokenize(skeletonText(light, true));
  const letters = words.reduce((sum, w) => sum + w.key.length, 0);
  return letters >= 2 ? words.map((w) => w.raw).join(' ') : null;
}

/** Normalised form of an allowlist entry, or null if it's too short to be useful. */
export function allowKey(word) {
  const key = lightNormalize(word).trim().replace(/\s+/g, ' ');
  return key.length >= 2 ? key : null;
}

function compileTerm(entry) {
  const key = termKey(entry.term);
  if (!key) return null;

  const action = entry.action === 'review' ? 'review' : 'reject';
  const base = { term: String(entry.term), key, action, category: entry.category ?? 'custom' };

  if (/^\d+$/.test(key)) return { ...base, numeric: true, fuzzy: false, words: [], joined: null };

  const words = key.split(' ').map(makeToken);
  const joined = makeToken(words.map((w) => w.raw).join(''));
  const fuzzyAllowed = words.length === 1 && joined.key.length >= FUZZY_MIN_LENGTH;
  // An explicit "fuzzy" can't turn on misspelling matching for phrases or very short
  // words; it would make far too many ordinary sentences match.
  const fuzzy = entry.match === 'strict' ? false : fuzzyAllowed;
  // "Hidden inside a longer word" comes with fuzzy matching, or on request ("anywhere")
  // for short words. Phrases span several words, so they can't hide inside one.
  const embedded = fuzzy || (entry.match === 'anywhere' && words.length === 1);
  return { ...base, numeric: false, fuzzy, embedded, words, joined };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds the lookup structures for one blacklist. Later entries with the same key
 * replace earlier ones, so a server's own additions override the defaults.
 *
 * @param {{ terms?: Array<{term: string, action?: string, match?: string, category?: string}>, allowlist?: string[] }} list
 */
export function compileList({ terms = [], allowlist = [] } = {}) {
  const byKey = new Map();
  let skipped = 0;
  for (const entry of terms) {
    const compiled = entry && typeof entry.term === 'string' ? compileTerm(entry) : null;
    if (compiled) byKey.set(compiled.key, compiled);
    else skipped += 1;
  }

  const byJoined = new Map(); // collapsed joined skeleton -> terms (single words AND phrases)
  const byFirstWord = new Map(); // collapsed first word -> multi-word terms
  const numeric = new Map(); // digit string -> term
  const fuzzy = []; // terms that also match misspellings
  const embedded = []; // terms that also match inside a longer word
  let maxLength = 0;

  const push = (map, key, value) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
  };

  for (const t of byKey.values()) {
    if (t.numeric) {
      numeric.set(t.key, t);
      continue;
    }
    push(byJoined, t.joined.key, t);
    if (t.words.length > 1) push(byFirstWord, t.words[0].key, t);
    if (t.fuzzy) fuzzy.push(t);
    if (t.embedded) embedded.push(t);
    maxLength = Math.max(maxLength, t.joined.key.length);
  }

  // Longest first, so "homo sapiens" is blanked before a shorter entry can split it.
  const allowed = [...new Set(allowlist.map((w) => (typeof w === 'string' ? allowKey(w) : null)).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  // A whole word means: not touching a letter, a digit, or a symbol that the leet view
  // reads as a letter. Without the symbols, "chick€n" would blank an allowed "chick" and
  // leave only "€n" to scan. The optional ending is captured so scan() can tell whether
  // the longer form is itself blacklisted.
  const notWordChar = `[\\p{L}\\p{N}${escapeRegex([...LEET.keys()].filter((c) => !/\d/.test(c)).join(''))}]`;
  const allow = allowed.length
    ? new RegExp(
        `(?<!${notWordChar})(?:${allowed.map((w) => escapeRegex(w).replace(/ /g, '\\s+')).join('|')})` +
          `(${SUFFIXES.join('|')})?(?!${notWordChar})`,
        'gu',
      )
    : null;

  return { size: byKey.size, skipped, byJoined, byFirstWord, numeric, fuzzy, embedded, maxLength, allow };
}

// ---- Fuzzy matching --------------------------------------------------------

const substitutionCost = (x, y) => (VOWELS.has(x) && VOWELS.has(y) ? COST.vowel : COST.consonant);

/**
 * Weighted optimal-string-alignment (restricted Damerau-Levenshtein) distance.
 * Gives up early and returns Infinity once every path costs more than `limit`.
 */
function editCost(a, b, limit) {
  const n = a.length;
  const m = b.length;
  let before = null; // row i-2, needed for swaps
  let prev = Array.from({ length: m + 1 }, (_, j) => j * COST.indel);

  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i * COST.indel;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const same = a[i - 1] === b[j - 1];
      let v = Math.min(
        prev[j] + COST.indel,
        cur[j - 1] + COST.indel,
        prev[j - 1] + (same ? 0 : substitutionCost(a[i - 1], b[j - 1])),
      );
      if (!same && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, before[j - 2] + COST.swap);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return Infinity;
    before = prev;
    prev = cur;
  }
  return prev[m];
}

function fuzzyScore(candidate, term) {
  const target = term.joined;
  if (Math.abs(candidate.key.length - target.key.length) > 2) return 0;
  const limit = target.key.length * (1 - SCORE.fuzzyFloor);
  let cost = editCost(candidate.key, target.key, limit);
  if (cost === Infinity) return 0;
  // Same collapsed letters but fewer repeats than the term (e.g. a one-letter-shorter
  // spelling): treat it like one missing letter rather than a perfect match.
  if (cost === 0 && !runsCover(candidate.runs, target.runs)) cost = COST.indel;
  if (candidate.key[0] !== target.key[0]) cost += COST.firstLetter;
  const score = Math.min(SCORE.fuzzyCap, 1 - cost / target.key.length);
  return score >= SCORE.fuzzyFloor ? score : 0;
}

// ---- Scanning --------------------------------------------------------------

/**
 * Keeps the best match overall and the best match among "reject" terms. Both are
 * needed: a review-only term with a perfect score must not hide a reject term that
 * also scored above the reject threshold.
 */
function createTracker() {
  const best = { any: null, reject: null };
  return {
    best,
    consider(term, score, how, found) {
      const match = { term: term.term, category: term.category, action: term.action, how, found, score };
      if (!best.any || score > best.any.score) best.any = match;
      if (term.action === 'reject' && (!best.reject || score > best.reject.score)) best.reject = match;
    },
  };
}

/** Exact and suffix lookups of one candidate against every term with that skeleton. */
function matchWhole(list, candidate, how, scores, consider, filter) {
  const exact = list.byJoined.get(candidate.key);
  if (exact) {
    for (const t of exact) if (filter(t) && runsCover(candidate.runs, t.joined.runs)) consider(t, scores.exact, how, candidate.key);
  }
  for (const suffix of SUFFIXES) {
    if (candidate.key.length <= suffix.length + 1 || !candidate.key.endsWith(suffix)) continue;
    const terms = list.byJoined.get(candidate.key.slice(0, -suffix.length));
    if (!terms) continue;
    for (const t of terms) if (filter(t) && runsCover(candidate.runs, t.joined.runs)) consider(t, scores.suffix, `${how}+suffix`, candidate.key);
  }
}

/** True if `text`, read as one word, is exactly a blacklisted term (or phrase). */
function isListedWord(list, text) {
  const candidate = makeToken(mergeDigraphs(tokenize(skeletonText(text, true)).map((t) => t.raw).join('')));
  return (list.byJoined.get(candidate.key) ?? []).some((t) => runsCover(candidate.runs, t.joined.runs));
}

/**
 * True if the term appears inside the (longer) candidate word with at least as many of
 * each repeated letter, e.g. "cheeseburger" contains "cheese" but "chesburger" doesn't.
 * Every occurrence is tried, since only a later one might have the full letter runs.
 */
function containsTerm(candidate, target) {
  const { key, runs } = candidate;
  if (key.length <= target.key.length) return false;
  for (let at = key.indexOf(target.key); at !== -1; at = key.indexOf(target.key, at + 1)) {
    if (runsCover(runs.slice(at), target.runs)) return true;
  }
  return false;
}

const anyTerm = () => true;
// Split words ("chick en") are a loose match, so only terms that allow loose matching
// (fuzzy: single words of 5+ letters not marked strict) get them.
const looseMatching = (t) => t.fuzzy;
const WORD_SCORES = { exact: SCORE.exact, suffix: SCORE.suffix };
const SPACED_SCORES = { exact: SCORE.spaced, suffix: SCORE.suffix };
const SPLIT_SCORES = { exact: SCORE.split, suffix: SCORE.splitSuffix };

function scanTokens(list, tokens, consider) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // 1. The word on its own: exact, with an ending, hidden inside, or misspelt.
    matchWhole(list, tok, 'exact', WORD_SCORES, consider, anyTerm);
    for (const t of list.embedded) {
      if (containsTerm(tok, t.joined)) consider(t, SCORE.embedded, 'embedded', tok.key);
    }
    for (const t of list.fuzzy) {
      const score = fuzzyScore(tok, t);
      if (score) consider(t, score, 'fuzzy', tok.key);
    }

    // 2. Phrases: each word must match, the last one may have an ending.
    for (const t of list.byFirstWord.get(tok.key) ?? []) {
      const last = t.words.length - 1;
      if (i + last >= tokens.length) continue;
      let ok = true;
      let suffixed = false;
      for (let w = 0; w <= last && ok; w++) {
        const cand = tokens[i + w];
        const word = t.words[w];
        if (cand.key === word.key && runsCover(cand.runs, word.runs)) continue;
        const ending = cand.key.slice(word.key.length);
        if (w === last && cand.key.startsWith(word.key) && SUFFIXES.includes(ending) && runsCover(cand.runs, word.runs)) {
          suffixed = true;
        } else ok = false;
      }
      if (ok) consider(t, suffixed ? SCORE.suffix : SCORE.exact, suffixed ? 'phrase+suffix' : 'phrase', t.key);
    }

    // 3. A long word split in two ("chick en"). Could be two innocent words, so
    //    this tops out below the default reject threshold.
    if (i + 1 < tokens.length) {
      matchWhole(list, makeToken(mergeDigraphs(tok.raw + tokens[i + 1].raw)), 'split', SPLIT_SCORES, consider, looseMatching);
    }

    // 4. Spaced-out letters ("C H i c k e n", "ch i ck en"): glue runs of tiny
    //    fragments, as long as at least half of them are single letters.
    if (tok.raw.length <= MAX_FRAGMENT) {
      let raw = '';
      let singles = 0;
      for (let j = i; j < tokens.length && tokens[j].raw.length <= MAX_FRAGMENT; j++) {
        raw += tokens[j].raw;
        if (tokens[j].raw.length === 1) singles += 1;
        if (raw.length > list.maxLength + 3) break;
        const count = j - i + 1;
        if (count >= 2 && singles * 2 >= count) {
          const glued = makeToken(mergeDigraphs(raw));
          matchWhole(list, glued, 'spaced', SPACED_SCORES, consider, anyTerm);
          // "c h e e s e b u r g e r". Long (fuzzy) terms only: short words are
          // everywhere in runs of little words ("is it at a ...").
          for (const t of list.fuzzy) {
            if (containsTerm(glued, t.joined)) consider(t, SCORE.embedded, 'spaced+embedded', glued.key);
          }
        }
      }
    }
  }
}

/**
 * Scores `text` against a compiled list.
 *
 * @returns {{ outcome: 'accept' | 'review' | 'reject', score: number, match: null | {
 *   term: string, category: string, action: string, how: string, found: string, score: number } }}
 */
export function scan(text, list, thresholds = DEFAULT_THRESHOLDS) {
  const tracker = createTracker();
  let light = lightNormalize(String(text ?? '').slice(0, MAX_INPUT));
  // Blank allowlisted words, except "allowed word + ending" when that longer form is
  // itself on the blacklist (allowing "grape" must not also allow a listed "grapes").
  if (list.allow) light = light.replace(list.allow, (found, ending) => (ending && isListedWord(list, found) ? found : ' '));

  if (list.numeric.size) {
    for (const [digits] of light.matchAll(/\d+/g)) {
      const t = list.numeric.get(digits);
      if (t) tracker.consider(t, SCORE.exact, 'exact', digits);
    }
  }

  // Two views of the same text: "c@t" needs the symbol read as a letter, while
  // "cat!" needs it read as punctuation. Scanning both covers either intent.
  for (const useLeet of [true, false]) scanTokens(list, tokenize(skeletonText(light, useLeet)), tracker.consider);

  const { any, reject } = tracker.best;
  if (reject && reject.score >= thresholds.reject) return { outcome: 'reject', score: reject.score, match: reject };
  if (any && any.score >= thresholds.review) return { outcome: 'review', score: any.score, match: any };
  return { outcome: 'accept', score: any?.score ?? 0, match: any };
}

// Unit tests for automod.js. Run with `npm.cmd test`.
//
// The hand-written cases use harmless stand-in words ("chicken", "cat", ...) so this
// file never has to spell out a slur. The real default list is tested generically:
// every entry is disguised programmatically and must still be caught, and a corpus
// of ordinary sentences must pass untouched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileList, scan, termKey, allowKey, DEFAULT_THRESHOLDS } from './automod.js';

const list = compileList({
  terms: [
    { term: 'chicken', category: 'test' },
    { term: 'cat', category: 'test' },
    { term: 'boot', category: 'test' },
    { term: 'spam', category: 'test' },
    { term: 'gizmo', category: 'test', action: 'review' },
    { term: 'kill time', category: 'test' },
    { term: '1234', category: 'test' },
  ],
  allowlist: ['spammer', 'homo sapiens'],
});

const outcome = (text, l = list, thresholds) => scan(text, l, thresholds).outcome;

describe('disguised blacklisted words are rejected', () => {
  const disguises = [
    'chicken',
    'CHICKEN',
    'Martin is a chicken.',
    'ch1ck3n',
    'chiiiiicken',
    'C H i c k e n',
    'c.h.i.c.k.e.n',
    'c-h-i-c-k-e-n',
    'c_h_i_c_k_e_n',
    'ch i ck en',
    'сhicken', // Cyrillic es
    'chi​cken', // zero-width space
    'çhíckén',
    'ｃｈｉｃｋｅｎ', // full-width
    'chickens',
    'Cihcken', // swapped neighbours
    'ch!cken',
    'he is a ch!cken!',
  ];
  for (const text of disguises) {
    test(JSON.stringify(text), () => assert.equal(outcome(text), 'reject'));
  }
});

describe('worked examples from automod-plan.md', () => {
  test('Cihcken scores ~0.92 (reject)', () => {
    const r = scan('Cihcken', list);
    assert.equal(r.outcome, 'reject');
    assert.ok(Math.abs(r.score - 0.917) < 0.01, `score ${r.score}`);
  });
  test('Chickan goes to review', () => assert.equal(outcome('Chickan'), 'review'));
  test('Chikn goes to review', () => assert.equal(outcome('Chikn'), 'review'));
  test('Kitchen is accepted', () => assert.equal(outcome('Kitchen'), 'accept'));
  test('a word hidden inside another rejects', () => assert.equal(outcome('xxchickenxx'), 'reject'));
  test('a long word split in two goes to review', () => assert.equal(outcome('what a chick en'), 'review'));
});

describe('strict (short) terms', () => {
  test('exact, plural and spaced forms reject', () => {
    for (const text of ['cat', 'CATS', 'c a t', 'c4t']) assert.equal(outcome(text), 'reject', text);
  });
  test('no misspelling or inside-a-word matches', () => {
    for (const text of ['concatenate', 'cart', 'cot', 'scatter', 'a cot and a cart']) assert.equal(outcome(text), 'accept', text);
  });
  test('a double letter in the term must be there in the text', () => {
    assert.equal(outcome('a bot'), 'accept');
    assert.equal(outcome('booooot'), 'reject');
  });
});

describe('review-only terms', () => {
  test('never reject, even with an exact match and a low reject threshold', () => {
    const r = scan('gizmo', list, { reject: 0.5, review: 0.4 });
    assert.equal(r.outcome, 'review');
    assert.equal(r.score, 1);
  });
  test('do not hide a reject term in the same text', () => {
    assert.equal(outcome('gizmo chicken'), 'reject');
  });
});

describe('allowlist', () => {
  test('allowlisted words (and their plurals) are ignored', () => {
    assert.equal(outcome('he is a spammer'), 'accept');
    assert.equal(outcome('two spammers'), 'accept');
  });
  test('the word itself is still caught', () => assert.equal(outcome('spam'), 'reject'));
  test('a disguised spelling is not allowlisted', () => assert.equal(outcome('sp4mmer'), 'reject'));
  test('multi-word entries work', () => assert.equal(allowKey('Homo  Sapiens'), 'homo sapiens'));
  // Security review #4: a symbol standing in for a letter must not end the allowed word.
  test('an allowed prefix cannot hide a blacklisted word written with symbols', () => {
    const l = compileList({ terms: [{ term: 'chicken' }], allowlist: ['chick'] });
    for (const text of ['chick€n', 'chick@n', 'chick3n', 'the chick€ns']) {
      assert.notEqual(outcome(text, l), 'accept', text);
    }
    assert.equal(outcome('a chick! wow', l), 'accept', 'trailing punctuation still works');
  });
  test('allowing a word does not allow a blacklisted longer form of it', () => {
    const l = compileList({ terms: [{ term: 'grapes' }], allowlist: ['grape'] });
    assert.equal(outcome('grape', l), 'accept');
    assert.equal(outcome('grapes', l), 'reject');
  });
});

describe('strict means strict', () => {
  // Security review #6: split words are a loose match, so strict terms must not get them.
  test('a strict long term does not match a split word', () => {
    const l = compileList({ terms: [{ term: 'chicken', match: 'strict' }] });
    assert.equal(outcome('chick en', l), 'accept');
    assert.equal(outcome('C H i c k e n', l), 'reject', 'spaced letters are still caught');
  });
});

describe('words hidden inside longer words', () => {
  const cheese = compileList({ terms: [{ term: 'cheese' }] });
  test('a long term inside a compound rejects', () => {
    for (const text of ['cheeseburger', 'I like cheeseburgers', 'supercheese', 'mega-cheeseburger', 'CH33SEBURGER']) {
      assert.equal(outcome(text, cheese), 'reject', text);
    }
  });
  test('spaced-out letters inside a compound reject', () => {
    assert.equal(outcome('c h e e s e b u r g e r', cheese), 'reject');
  });
  test('the hidden word still needs its repeated letters', () => {
    // "chese" collapses like "cheese" but is missing an e.
    assert.notEqual(outcome('cheseburger', cheese), 'reject');
  });
  test('a strict long term is not found inside other words', () => {
    const l = compileList({ terms: [{ term: 'cheese', match: 'strict' }] });
    assert.equal(outcome('cheeseburger', l), 'accept');
  });

  const anywhere = compileList({
    terms: [
      { term: 'cat', match: 'anywhere' },
      { term: 'boot', match: 'anywhere' },
      { term: 'kill time', match: 'anywhere' },
    ],
    allowlist: ['concatenate'],
  });
  test('"anywhere" finds a short term inside other words', () => {
    for (const text of ['catdog', 'tomcat', 'wildcats', 'bootcamp', 'x b00tlegx']) {
      assert.equal(outcome(text, anywhere), 'reject', text);
    }
  });
  test('"anywhere" keeps the double-letter rule and stays exact otherwise', () => {
    for (const text of ['botany', 'cart', 'cot', 'a cot and a cart']) assert.equal(outcome(text, anywhere), 'accept', text);
  });
  test('the allowlist rescues innocent words an "anywhere" term hides in', () => {
    assert.equal(outcome('concatenate the strings', anywhere), 'accept');
    assert.equal(outcome('concatenate the catdog', anywhere), 'reject');
  });
  test('"anywhere" does nothing extra for phrases', () => {
    assert.equal(anywhere.embedded.some((t) => t.key === 'kill time'), false);
    assert.equal(outcome('overkill timer', anywhere), 'accept');
  });
  test('"anywhere" on a long word keeps misspelling matching', () => {
    const l = compileList({ terms: [{ term: 'chicken', match: 'anywhere' }] });
    assert.equal(outcome('Cihcken', l), 'reject');
    assert.equal(outcome('chickenburger', l), 'reject');
  });
});

describe('phrases', () => {
  for (const text of ['kill time', 'KILL TIME', 'killtime', 'kill times', 'k i l l t i m e']) {
    test(`${JSON.stringify(text)} rejects`, () => assert.equal(outcome(text), 'reject'));
  }
  test('words in between break the phrase', () => assert.equal(outcome('kill the time'), 'accept'));
});

describe('plain numbers are not words', () => {
  // "8008" would read as "boob" in the letter view; on its own it's just a number.
  const l = compileList({ terms: [{ term: 'boob' }, { term: 'chicken' }] });
  test('a standalone number is accepted', () => {
    for (const text of ['He ate 8008 nuggets', '8008', 'call 8008.', 'room 8008, floor 2']) assert.equal(outcome(text, l), 'accept', text);
  });
  test('digits mixed into a word are still read as letters', () => {
    for (const text of ['b008', '8oo8', 'ch1ck3n', 'c h 1 c k 3 n']) assert.equal(outcome(text, l), 'reject', text);
  });
});

describe('numeric terms', () => {
  test('exact number rejects', () => assert.equal(outcome('code 1234 now'), 'reject'));
  test('longer numbers and lookalike words pass', () => {
    for (const text of ['12345', '01234', 'the lab']) assert.equal(outcome(text), 'accept', text);
  });
});

describe('thresholds and keys', () => {
  test('custom thresholds move the boundaries', () => {
    assert.equal(outcome('Chickan', list, { reject: 0.8, review: 0.5 }), 'reject');
    assert.equal(outcome('Chickan', list, { reject: 0.99, review: 0.9 }), 'accept');
  });
  test('defaults are 0.9 / 0.75', () => assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { reject: 0.9, review: 0.75 }));
  test('a single q is not read as g ("groq" is not "grog")', () => {
    const l = compileList({ terms: [{ term: 'grog' }] });
    assert.equal(outcome('read the groq', l), 'accept');
  });
  test('termKey ignores case and leetspeak', () => assert.equal(termKey('Chicken'), termKey('CH1CKEN')));
  test('termKey rejects terms that are too short', () => {
    for (const bad of ['a', '!', '  ', '1']) assert.equal(termKey(bad), null, bad);
  });
  test('empty input is accepted', () => {
    assert.equal(outcome(''), 'accept');
    assert.equal(scan(undefined, list).outcome, 'accept');
  });
  test('later entries override earlier ones with the same key', () => {
    const l = compileList({ terms: [{ term: 'chicken' }, { term: 'CHICKEN', action: 'review' }] });
    assert.equal(l.size, 1);
    assert.equal(outcome('chicken', l), 'review');
  });
  test('invalid entries are skipped and counted', () => {
    const l = compileList({ terms: [{ term: 'a' }, null, { term: 42 }, { term: 'chicken' }] });
    assert.equal(l.size, 1);
    assert.equal(l.skipped, 3);
  });
});

describe('the shipped default list', () => {
  const raw = JSON.parse(readFileSync(new URL('./blacklist.default.json', import.meta.url), 'utf8'));
  const defaults = compileList(raw);

  test('every entry compiles', () => {
    assert.equal(defaults.skipped, 0);
    assert.equal(defaults.size, raw.terms.length);
  });

  // Every disguise below must still be caught. Messages show only the entry's index,
  // so a failure never prints the word itself.
  raw.terms.forEach((entry, index) => {
    if (/^\d+$/.test(entry.term)) return;
    // A review-only entry may legitimately be rejected when a disguise of it also spells
    // a reject-level entry (spaced-out phrases glue into one word), so allow either.
    const allowed = entry.action === 'review' ? ['review', 'reject'] : ['reject'];
    const letters = entry.term.replace(/\s+/g, '');
    const disguises = [
      entry.term.toUpperCase(),
      `Martin is a ${entry.term}.`,
      letters.split('').join(' '),
      letters.split('').join('.'),
      entry.term.replace(/o/g, '0').replace(/e/g, '3').replace(/a/g, '@'),
    ];
    test(`default entry #${index} is caught in disguise`, () => {
      for (const [i, text] of disguises.entries()) {
        const { outcome: got } = scan(text, defaults);
        assert.ok(allowed.includes(got), `disguise ${i} of entry #${index}: ${got}`);
      }
    });
  });

  const sentences = [
    'Martin stole my sandwich at lunch.',
    'He went to Scunthorpe for a cocktail in the cockpit.',
    'The raccoon is sleeping in a cocoon next to the tycoon.',
    'Martin regards the speaker as a total disaster.',
    'We need a tray of crackers, spicy grapes and some spice.',
    'Japan and Pakistan played cricket in the rain.',
    'He has a bigger digger than the trigger happy tiger.',
    'Nigel went to Niger and Nigeria last summer.',
    'Martin ate the last chunky kitchen pie.',
    'Where is the whole polka band?',
    'He said the con men are among us.',
    'The ripple made the speaker restart the video.',
    'He is always tardy, the dastard, with mustard on his custard.',
    'Mongolia is home to a mongrel and a fishmonger.',
    'The pedal of the bike near the pedestrian crossing broke.',
    'He studied homo sapiens in his homework for the documentary.',
    'Martin went to Cumbria with a cucumber and some cumin.',
    'A darker shade of blue in the beaker.',
    'The negroni was great, said the bartender.',
    'I regard him highly as a therapist.',
    'The therapists accumulated a circumstance of documents.',
    'He uses an abacus about above the abode.',
    'He likes sambas and polkas, and the squads do squats.',
    'Martin drank a whole pint at the pub with his class.',
    'The assassination of the classic bass player shocked everyone.',
    'He played spaghetti western music on the porch.',
    'Martin said hello to the trainee at the station.',
    'This is a constitutional matter of great importance.',
    'The fire retardant protected the custard factory.',
    'Martin put a raccoon in the encyclopedia of torpedoes.',
    'He sniggered at the niggling problem.',
    'Martin cracked the case like a nutcracker on a firecracker.',
    'The sauerkraut tasted sour.',
    'He shouted heebie jeebies in Yiddish.',
    'Martin parked in the wrong spot again.',
    'Martin ate my cookies and blamed the dog.',
    'Martin keeps saying he is the best at Mario Kart.',
    'He wore the same socks three days in a row!!!',
    'Martin claims 2 + 2 = 5 and that 1234 is not his PIN.',
    "Martin's speech at the meeting was 45 minutes long.",
    'He left the oven on and burned the toast at 7:30.',
    'Martin cheated at chess, monopoly and uno.',
    'Martin is secretly a Manchester United fan.',
    'He told everyone the moon landing was filmed in his garage.',
    'Martin microwaved fish in the office kitchen.',
    'Martin replied all to the company-wide email.',
    'He took the last slice and said nothing.',
    'Martin can not parallel park to save his life.',
    'He said pineapple belongs on pizza, which is a crime.',
    'He got lost in IKEA for three hours.',
  ];
  for (const sentence of sentences) {
    test(`ordinary sentence passes: ${sentence.slice(0, 40)}`, () => {
      const r = scan(sentence, defaults);
      assert.equal(r.outcome, 'accept', `${r.outcome} via ${r.match?.how} (${r.match?.category}) score ${r.score}`);
    });
  }
});

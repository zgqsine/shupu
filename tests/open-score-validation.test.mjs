import test from 'node:test';
import assert from 'node:assert/strict';
import { newScore, openScore, writeNote } from '../dist/score.js';

const formatError = /不是受支持的简谱工程，或工程内容不完整/;

test('openScore rejects null top-level array elements with the normal format error', () => {
  for (const field of ['measures', 'lanes', 'notes', 'tempoMarks', 'endings', 'tempoLines', 'chordSymbols', 'importNotices', 'tuplets', 'spans', 'brackets', 'linkedParts']) {
    const score = newScore();
    score[field] = [null];
    assert.throws(() => openScore(JSON.stringify(score)), formatError, field);
  }
});

test('openScore rejects null nested note array elements with the normal format error', () => {
  const base = newScore();
  writeNote(base, { lane: 'S', at: 0 }, [{ degree: 1, octave: 4, alter: 0 }], 96, 0);
  base.notes[0].verses = [{ number: 1, text: 'a' }];

  const cases = [
    ['pitch', score => { score.notes[0].pitches = [null]; }],
    ['verse', score => { score.notes[0].verses = [null]; }],
    ['grace note', score => { score.notes[0].grace = { before: { notes: [null] } }; }]
  ];
  for (const [name, mutate] of cases) {
    const score = structuredClone(base);
    mutate(score);
    assert.throws(() => openScore(JSON.stringify(score)), formatError, name);
  }
});

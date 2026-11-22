import test from 'node:test';
import assert from 'node:assert/strict';
import { addSideLane, deleteTemporaryVoiceInterval, mergeTemporaryVoices, newScore, openScore, writeNote } from '../dist/score.js';

const pitch = { degree: 1, octave: 4, alter: 0 };

test('deleting a whole hidden temporary voice removes its visibility entry and keeps the project loadable', () => {
  const score = newScore();
  const side = addSideLane(score, 'S', 0, 384);
  writeNote(score, { lane: side.id, at: 0 }, [pitch], 96, 0);
  score.measures[0].layout = { visibility: { [side.id]: 'hide' } };

  deleteTemporaryVoiceInterval(score, { lane: side.id, at: 0 }, 384);

  assert.equal(score.lanes.some(lane => lane.id === side.id), false);
  assert.deepEqual(score.measures[0].layout.visibility, {});
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

test('merging adjacent temporary voices removes the merged lane visibility and keeps the project loadable', () => {
  const score = newScore();
  addSideLane(score, 'S', 0, 192);
  const right = addSideLane(score, 'S', 192, 384);
  score.measures[0].layout = { visibility: { [right.id]: 'hide' } };

  mergeTemporaryVoices(score, 'S');

  assert.equal(score.lanes.some(lane => lane.id === right.id), false);
  assert.deepEqual(score.measures[0].layout.visibility, {});
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

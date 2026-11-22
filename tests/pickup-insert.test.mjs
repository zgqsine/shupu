import test from 'node:test';
import assert from 'node:assert/strict';
import { insertBlankMeasure, measureTable, newScore, openScore } from '../dist/score.js';

const summary = score => measureTable(score).slice(0, 3).map(measure => [measure.number, measure.length, measure.pickup]);

test('inserting after a pickup adds a full measure without copying the pickup flag', () => {
  const score = newScore(4, 4, 96);
  insertBlankMeasure(score, 0, true);

  assert.deepEqual(summary(score), [[0, 96, true], [1, 384, false], [2, 384, false]]);
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

test('inserting before a pickup adds a full measure and keeps numbering sequential', () => {
  const score = newScore(4, 4, 96);
  insertBlankMeasure(score, 0, false);

  assert.deepEqual(summary(score), [[1, 384, false], [2, 96, true], [3, 384, false]]);
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

test('a pickup created by the app keeps sequential numbering when a measure is inserted after it', () => {
  const score = newScore(4, 4);
  score.measures[0] = { length: 96, pickup: true, numberStep: 1 };
  insertBlankMeasure(score, 0, true);

  assert.deepEqual(summary(score), [[1, 96, true], [2, 384, false], [3, 384, false]]);
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

test('a pickup created by the app keeps sequential numbering when a measure is inserted before it', () => {
  const score = newScore(4, 4);
  score.measures[0] = { length: 96, pickup: true, numberStep: 1 };
  insertBlankMeasure(score, 0, false);

  assert.deepEqual(summary(score), [[1, 384, false], [2, 96, true], [3, 384, false]]);
  assert.doesNotThrow(() => openScore(JSON.stringify(score)));
});

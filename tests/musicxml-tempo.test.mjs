import test from 'node:test';
import assert from 'node:assert/strict';
import { installDOM } from './xml-dom.mjs';

installDOM();
const { newScore, writeNote } = await import('../dist/score.js');
const { exportMusicXML } = await import('../dist/musicxml-export.js');
const { importMusicXML } = await import('../dist/musicxml.js');

const tempoScore = () => {
  const score = newScore();
  writeNote(score, { lane: 'S', at: 0 }, [{ degree: 1, octave: 4, alter: 0 }], 384, 0);
  score.tempoLines = [{ id: 'line-1', from: 0, to: 768, kind: 'rit.', label: 'rit.', dashVisible: false }];
  return score;
};

test('tempo line words are not duplicated onto the note on import', () => {
  const { xml } = exportMusicXML(tempoScore());
  assert.match(xml, /<words>rit\.<\/words>/);
  const imported = importMusicXML(xml, 'tempo');
  assert.equal(imported.score.tempoLines?.length, 1);
  assert.deepEqual(imported.score.notes.filter(note => note.text), []);
});

test('repeated tempo line words from an older export are also dropped', () => {
  const { xml } = exportMusicXML(tempoScore());
  const doubled = xml.replace('<words>rit.</words>', '<words>rit. rit.</words>');
  const imported = importMusicXML(doubled, 'tempo');
  assert.equal(imported.score.tempoLines?.length, 1);
  assert.deepEqual(imported.score.notes.filter(note => note.text), []);
});

test('files without tempo metadata keep their printed words as text', () => {
  const { xml } = exportMusicXML(tempoScore());
  const stripped = xml.replace(/<miscellaneous-field name="shupu-tempo">[\s\S]*?<\/miscellaneous-field>/, '');
  const imported = importMusicXML(stripped, 'tempo');
  assert.equal(imported.score.tempoLines, undefined);
  assert.deepEqual(imported.score.notes.filter(note => note.text).map(note => note.text), ['rit.']);
});

test('unrelated text at the same position is kept', () => {
  const score = tempoScore();
  score.notes[0].text = 'dolce';
  const imported = importMusicXML(exportMusicXML(score).xml, 'tempo');
  assert.deepEqual(imported.score.notes.filter(note => note.text).map(note => note.text), ['dolce']);
});

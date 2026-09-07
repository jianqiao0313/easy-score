import assert from 'node:assert/strict';
import test from 'node:test';
import { markMeasureRowEnds, musicXmlWithSystemBreaks } from '../src/score-layout.mjs';

const score = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>One</part-name></score-part><score-part id="P2"><part-name>Two</part-name></score-part></part-list>
  <part id="P1">${Array.from({ length: 5 }, (_, index) => `<measure number="${index + 1}"><note><rest/></note></measure>`).join('')}</part>
  <part id="P2">${Array.from({ length: 5 }, (_, index) => `<measure number="${index + 1}"><note><rest/></note></measure>`).join('')}</part>
</score-partwise>`;

test('layout copy adds synchronized system breaks without changing source XML', () => {
  const arranged = musicXmlWithSystemBreaks(score, 2);
  assert.equal((arranged.match(/new-system="yes"/g) || []).length, 4);
  assert.equal(score.includes('new-system'), false);
});

test('layout copy replaces existing break directives at each row boundary', () => {
  const source = score.replace('<measure number="3">', '<measure number="3"><print new-system="no"/>');
  const arranged = musicXmlWithSystemBreaks(source, 2);
  assert.equal(arranged.includes('new-system="no"'), false);
});

test('automatic layout passes through the original score without fixed row directives', () => {
  const source = score.replace('<measure number="3">', '<measure number="3"><print new-system="yes"/>');
  assert.equal(musicXmlWithSystemBreaks(source, 'auto'), source);
});

test('automatic layout preserves the original measure ending flags', () => {
  const measures = [{ HasEndLine: true }, { HasEndLine: false }];
  markMeasureRowEnds(measures, 'auto');
  assert.deepEqual(measures, [{ HasEndLine: true }, { HasEndLine: false }]);
});

test('row endings are marked on the transient OSMD score model', () => {
  const measures = Array.from({ length: 7 }, (_, index) => ({
    HasEndLine: index === 1 || index === 6,
    endingBarStyleEnum: index === 1 ? 'repeat-glyph-is-preserved' : undefined,
  }));
  markMeasureRowEnds(measures, 3);
  assert.deepEqual(measures.map((measure) => measure.HasEndLine), [false, false, true, false, false, true, true]);
  assert.equal(measures[1].endingBarStyleEnum, 'repeat-glyph-is-preserved');
});

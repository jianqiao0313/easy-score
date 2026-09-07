import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMusicXML } from '../src/musicxml.mjs';

const wrap = (measures, partList = '<score-part id="P1"><part-name>Piano</part-name></score-part>') => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <work><work-title>Etude</work-title></work>
  <identification><creator type="composer">A. Composer</creator></identification>
  <part-list>${partList}</part-list>
  <part id="P1">${measures}</part>
</score-partwise>`;

test('parseMusicXML converts divisions, rests, accidentals, chords, backup, and forward into quarter-note time', () => {
  const score = parseMusicXML(wrap(`
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><sound tempo="96"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><chord/><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <backup><duration>8</duration></backup>
      <forward><duration>2</duration></forward>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>2</voice></note>
    </measure>`));

  assert.equal(score.title, 'Etude');
  assert.equal(score.composer, 'A. Composer');
  assert.equal(score.tempo, 96);
  assert.deepEqual(score.timeSignature, { beats: 4, beatType: 4 });
  assert.equal(score.keySignature, 'F major');
  assert.deepEqual(score.parts, [{ id: 'P1', name: 'Piano' }]);
  assert.deepEqual(score.notes.map(({ midi, startBeat, durationBeats }) => ({ midi, startBeat, durationBeats })), [
    { midi: 60, startBeat: 0, durationBeats: 1 },
    { midi: 63, startBeat: 0, durationBeats: 1 },
    { midi: 74, startBeat: 1, durationBeats: 1 },
    { midi: 67, startBeat: 2, durationBeats: 2 },
  ]);
  assert.deepEqual(score.measures, [{ number: 1, startBeat: 0, durationBeats: 4, timeSignature: { beats: 4, beatType: 4 } }]);
  assert.equal(score.totalBeats, 4);
});

test('parseMusicXML preserves a pickup, aligns parts, changes divisions, and merges cross-measure ties', () => {
  const xml = `<?xml version="1.0"?>
  <score-partwise version="4.0">
    <movement-title>Pickup tune</movement-title>
    <part-list>
      <score-part id="P1"><part-name>Saxophone</part-name></score-part>
      <score-part id="P2"><part-name>Piano</part-name></score-part>
    </part-list>
    <part id="P1">
      <measure number="0" implicit="yes">
        <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><tie type="start"/></note>
      </measure>
      <measure number="1">
        <attributes><divisions>2</divisions></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><tie type="stop"/></note>
        <note><rest/><duration>4</duration><voice>1</voice></note>
        <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      </measure>
    </part>
    <part id="P2">
      <measure number="0" implicit="yes">
        <attributes><divisions>2</divisions></attributes>
        <note><rest/><duration>2</duration></note>
      </measure>
      <measure number="1">
        <note><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration></note>
      </measure>
    </part>
  </score-partwise>`;

  const score = parseMusicXML(xml);

  assert.deepEqual(score.measures, [
    { number: 1, startBeat: 0, durationBeats: 1, timeSignature: { beats: 4, beatType: 4 } },
    { number: 2, startBeat: 1, durationBeats: 4, timeSignature: { beats: 4, beatType: 4 } },
  ]);
  assert.equal(score.totalBeats, 5);
  assert.deepEqual(score.notes.map(({ partId, midi, startBeat, durationBeats, measure }) => ({ partId, midi, startBeat, durationBeats, measure })), [
    { partId: 'P1', midi: 60, startBeat: 0, durationBeats: 2, measure: 1 },
    { partId: 'P2', midi: 55, startBeat: 1, durationBeats: 4, measure: 2 },
    { partId: 'P1', midi: 64, startBeat: 4, durationBeats: 1, measure: 2 },
  ]);
});

test('parseMusicXML applies instrument transposition and rejects invalid input', () => {
  const score = parseMusicXML(wrap(`
    <measure number="1">
      <attributes><divisions>1</divisions><transpose><chromatic>-2</chromatic></transpose></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note>
    </measure>`));
  assert.equal(score.notes[0].midi, 58);
  assert.throws(() => parseMusicXML(''), /不能为空/);
  assert.throws(() => parseMusicXML('<score-timewise/>'), /score-partwise/);
  assert.throws(() => parseMusicXML('<score-partwise><part>'), /无法解析 MusicXML/);
});

test('parseMusicXML pads an underfilled middle measure so later notes stay aligned', () => {
  const score = parseMusicXML(wrap(`
    <measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>8</duration></note></measure>
    <measure number="2"><note><rest/><duration>7</duration></note></measure>
    <measure number="3"><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note><note><rest/><duration>6</duration></note></measure>`));

  assert.deepEqual(score.measures.map(({ startBeat, durationBeats }) => ({ startBeat, durationBeats })), [
    { startBeat: 0, durationBeats: 4 },
    { startBeat: 4, durationBeats: 4 },
    { startBeat: 8, durationBeats: 4 },
  ]);
  assert.equal(score.notes[0].startBeat, 8);
  assert.ok(score.warnings.some((warning) => warning.includes('第 2 小节') && warning.includes('不完整')));
});

test('parseMusicXML defaults a missing time signature to 4/4 and reports it', () => {
  const score = parseMusicXML(wrap('<measure number="1"><attributes><divisions>1</divisions></attributes><note><rest/><duration>1</duration></note></measure>'));
  assert.deepEqual(score.timeSignature, { beats: 4, beatType: 4 });
  assert.ok(score.warnings.some((warning) => warning.includes('拍号')));
  assert.ok(score.warnings.some((warning) => warning.includes('速度') && warning.includes('120')));
});

test('parseMusicXML uses each measure active meter instead of padding with the opening meter', () => {
  const score = parseMusicXML(wrap(`
    <measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>4</duration></note></measure>
    <measure number="2"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><note><rest/><duration>3</duration></note></measure>
    <measure number="3"><note><rest/><duration>3</duration></note></measure>`));

  assert.deepEqual(score.measures.map(({ startBeat, durationBeats, timeSignature }) => ({ startBeat, durationBeats, timeSignature })), [
    { startBeat: 0, durationBeats: 4, timeSignature: { beats: 4, beatType: 4 } },
    { startBeat: 4, durationBeats: 3, timeSignature: { beats: 3, beatType: 4 } },
    { startBeat: 7, durationBeats: 3, timeSignature: { beats: 3, beatType: 4 } },
  ]);
  assert.equal(score.totalBeats, 10);
});

test('parseMusicXML does not guess major or minor when key mode is absent', () => {
  const score = parseMusicXML(wrap(`
    <measure number="1"><attributes><divisions>1</divisions><key><fifths>2</fifths></key></attributes><note><rest/><duration>4</duration></note></measure>`));
  assert.equal(score.keySignature, '2♯');
});

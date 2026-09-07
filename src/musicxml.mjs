import { DOMParser } from '@xmldom/xmldom';

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const MINOR_KEYS = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];

function children(element, name) {
  return Array.from(element?.childNodes || []).filter((node) => node.nodeType === 1 && (!name || node.localName === name || node.nodeName === name));
}

function child(element, name) {
  return children(element, name)[0] || null;
}

function descendants(element, name) {
  return Array.from(element?.getElementsByTagName(name) || []);
}

function textOf(element, name) {
  const target = name ? child(element, name) : element;
  return target?.textContent?.trim() || '';
}

function numberOf(element, name, fallback = 0) {
  const value = Number(textOf(element, name));
  return Number.isFinite(value) ? value : fallback;
}

function midiOf(note, transpose = 0) {
  const pitch = child(note, 'pitch');
  if (!pitch) return null;
  const step = textOf(pitch, 'step').toUpperCase();
  const octave = numberOf(pitch, 'octave', NaN);
  const alter = numberOf(pitch, 'alter', 0);
  if (!(step in STEP_SEMITONES) || !Number.isFinite(octave)) return null;
  return (octave + 1) * 12 + STEP_SEMITONES[step] + alter + transpose;
}

function keyName(fifths, mode) {
  if (mode !== 'major' && mode !== 'minor') {
    if (fifths === 0) return '无升降号';
    return `${Math.abs(fifths)}${fifths > 0 ? '♯' : '♭'}`;
  }
  const index = Math.max(-7, Math.min(7, fifths)) + 7;
  return `${mode === 'minor' ? MINOR_KEYS[index] : MAJOR_KEYS[index]} ${mode}`;
}

function beatsValue(value, fallback = 4) {
  const beats = String(value || '').split('+').reduce((sum, item) => sum + (Number(item) || 0), 0);
  return beats || fallback;
}

function parsePartMeasure(measure, state, partId, measureIndex, warnings) {
  let cursor = 0;
  let furthest = 0;
  let previousStart = 0;
  const notes = [];

  for (const item of children(measure)) {
    if (item.localName === 'attributes' || item.nodeName === 'attributes') {
      const divisions = numberOf(item, 'divisions', state.divisions);
      if (divisions > 0) state.divisions = divisions;
      const transpose = child(item, 'transpose');
      if (transpose) state.transpose = numberOf(transpose, 'chromatic', 0) + numberOf(transpose, 'octave-change', 0) * 12;
      const time = child(item, 'time');
      if (time) {
        state.beats = beatsValue(textOf(time, 'beats'), state.beats);
        state.beatType = numberOf(time, 'beat-type', state.beatType) || state.beatType;
      }
      continue;
    }

    if (item.localName === 'backup' || item.nodeName === 'backup') {
      cursor = Math.max(0, cursor - numberOf(item, 'duration') / state.divisions);
      continue;
    }

    if (item.localName === 'forward' || item.nodeName === 'forward') {
      cursor += numberOf(item, 'duration') / state.divisions;
      furthest = Math.max(furthest, cursor);
      continue;
    }

    if (item.localName !== 'note' && item.nodeName !== 'note') continue;

    const duration = numberOf(item, 'duration') / state.divisions;
    const isChord = Boolean(child(item, 'chord'));
    const isGrace = Boolean(child(item, 'grace'));
    const startBeat = isChord ? previousStart : cursor;
    if (!isChord) previousStart = startBeat;

    if (!child(item, 'rest') && !isGrace) {
      const midi = midiOf(item, state.transpose);
      if (midi === null) {
        warnings.push(`第 ${measureIndex + 1} 小节包含无法播放的音高。`);
      } else {
        const tieTypes = children(item, 'tie').map((tie) => tie.getAttribute('type'));
        notes.push({
          partId,
          midi,
          localStart: startBeat,
          durationBeats: duration,
          measure: measureIndex + 1,
          voice: textOf(item, 'voice') || '1',
          staff: textOf(item, 'staff') || '1',
          tieStart: tieTypes.includes('start'),
          tieStop: tieTypes.includes('stop'),
        });
      }
    }

    if (!isChord && !isGrace) cursor += duration;
    furthest = Math.max(furthest, startBeat + duration, cursor);
  }

  return {
    notes,
    durationBeats: furthest,
    expectedBeats: state.beats * 4 / state.beatType,
    timeSignature: { beats: state.beats, beatType: state.beatType },
  };
}

export function parseMusicXML(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) throw new TypeError('MusicXML 内容不能为空。');

  const xmlErrors = [];
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => xmlErrors.push(message),
      fatalError: (message) => xmlErrors.push(message),
    },
  }).parseFromString(xmlText, 'application/xml');
  const parseError = descendants(document, 'parsererror')[0];
  const root = document.documentElement;
  if (xmlErrors.length || parseError || !root || root.nodeName !== 'score-partwise') throw new Error('无法解析 MusicXML：文件不是有效的 score-partwise 乐谱。');

  const warnings = [];
  const title = textOf(descendants(root, 'work-title')[0]) || textOf(descendants(root, 'movement-title')[0]) || '未命名乐谱';
  const creator = descendants(root, 'creator').find((node) => node.getAttribute('type') === 'composer');
  const composer = textOf(creator) || '';
  const partNames = new Map(descendants(child(root, 'part-list'), 'score-part').map((part) => [part.getAttribute('id'), textOf(part, 'part-name') || part.getAttribute('id')]));
  const partElements = children(root, 'part');
  const parts = partElements.map((part) => ({ id: part.getAttribute('id'), name: partNames.get(part.getAttribute('id')) || part.getAttribute('id') || 'Part' }));

  const firstTime = descendants(root, 'time')[0];
  const beatsText = textOf(firstTime, 'beats');
  const beats = beatsValue(beatsText);
  const beatType = numberOf(firstTime, 'beat-type', 4) || 4;
  const firstKey = descendants(root, 'key')[0];
  const fifths = numberOf(firstKey, 'fifths', 0);
  const mode = textOf(firstKey, 'mode');
  const tempoValues = descendants(root, 'sound').map((sound) => Number(sound.getAttribute('tempo'))).filter((value) => value > 0);
  const metronomeTempo = numberOf(descendants(root, 'metronome')[0], 'per-minute', 0);
  const tempo = tempoValues[0] || metronomeTempo || 120;
  if (!firstTime) warnings.push('乐谱未提供拍号；当前按 4/4 拍处理。');
  if (!tempoValues.length && !metronomeTempo) warnings.push('乐谱未提供速度；当前默认使用 120 BPM。');
  if (new Set(tempoValues.map(String)).size > 1) warnings.push('乐谱包含速度变化；当前播放使用起始速度。');

  const parsedParts = partElements.map((part) => {
    const state = { divisions: 1, transpose: 0, beats, beatType };
    return children(part, 'measure').map((measure, measureIndex) => parsePartMeasure(measure, state, part.getAttribute('id'), measureIndex, warnings));
  });
  const measureCount = Math.max(0, ...parsedParts.map((part) => part.length));
  const measures = [];
  let totalBeats = 0;
  for (let index = 0; index < measureCount; index += 1) {
    const actualBeats = Math.max(0, ...parsedParts.map((part) => part[index]?.durationBeats || 0));
    const measureParts = parsedParts.map((part) => part[index]).filter(Boolean);
    const expectedBeats = Math.max(0, ...measureParts.map((measure) => measure.expectedBeats));
    const timeSignature = measureParts[0]?.timeSignature || { beats, beatType };
    const isOpeningPickup = index === 0 && actualBeats > 0 && actualBeats < expectedBeats - 1e-7;
    const durationBeats = isOpeningPickup ? actualBeats : Math.max(actualBeats, expectedBeats);
    if (index > 0 && actualBeats > 0 && actualBeats < expectedBeats - 1e-7) {
      warnings.push(`第 ${index + 1} 小节时值不完整（${actualBeats} / ${expectedBeats} 拍）；已保留完整小节长度，避免后续音符提前。`);
    }
    measures.push({ number: index + 1, startBeat: totalBeats, durationBeats, timeSignature });
    totalBeats += durationBeats;
  }

  const rawNotes = parsedParts.flatMap((part) => part.flatMap((measure, index) => measure.notes.map((note) => ({ ...note, startBeat: measures[index].startBeat + note.localStart }))));
  rawNotes.sort((a, b) => a.startBeat - b.startBeat || a.partId.localeCompare(b.partId) || a.midi - b.midi);
  const activeTies = new Map();
  const soundingNotes = [];
  for (const note of rawNotes) {
    const tieKey = `${note.partId}:${note.voice}:${note.staff}:${note.midi}`;
    const active = activeTies.get(tieKey);
    if (note.tieStop && active) {
      active.durationBeats = Math.max(active.durationBeats, note.startBeat + note.durationBeats - active.startBeat);
      if (!note.tieStart) activeTies.delete(tieKey);
      continue;
    }
    const sounding = { partId: note.partId, midi: note.midi, startBeat: note.startBeat, durationBeats: note.durationBeats, measure: note.measure };
    soundingNotes.push(sounding);
    if (note.tieStart) activeTies.set(tieKey, sounding);
  }

  const notes = soundingNotes.map((note, index) => ({ id: `note-${index + 1}`, ...note }));
  if (descendants(root, 'repeat').length || descendants(root, 'segno').length || descendants(root, 'coda').length) {
    warnings.push('当前播放按书写顺序进行，不展开反复或跳转记号。');
  }

  return { title, composer, tempo, timeSignature: { beats, beatType }, keySignature: firstKey ? keyName(fifths, mode) : '未标注', parts, notes, measures, totalBeats, warnings };
}

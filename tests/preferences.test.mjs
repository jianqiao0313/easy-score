import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPreferences, saveInstrument, saveMeasuresPerRow } from '../src/preferences.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

test('preferences default to alto sax and automatic row layout', () => {
  assert.deepEqual(loadPreferences(memoryStorage()), {
    instrumentId: 'saxophone',
    measuresPerRow: 'auto',
  });
});

test('preferences restore automatic layout and previously saved numeric layouts', () => {
  assert.deepEqual(loadPreferences(memoryStorage({
    'easy-score.measures-per-row': 'auto',
  })), { instrumentId: 'saxophone', measuresPerRow: 'auto' });

  assert.deepEqual(loadPreferences(memoryStorage({
    'easy-score.instrument': 'piano',
    'easy-score.measures-per-row': '8',
  })), { instrumentId: 'piano', measuresPerRow: 8 });
});

test('preferences reject stale values', () => {
  assert.deepEqual(loadPreferences(memoryStorage({
    'easy-score.instrument': 'organ',
    'easy-score.measures-per-row': '12',
  })), { instrumentId: 'saxophone', measuresPerRow: 'auto' });
});

test('preference writers persist only supported values', () => {
  const storage = memoryStorage();
  assert.equal(saveInstrument(storage, 'piano'), true);
  assert.equal(saveMeasuresPerRow(storage, 'auto'), true);
  assert.equal(storage.values.get('easy-score.measures-per-row'), 'auto');
  assert.equal(saveMeasuresPerRow(storage, 1), true);
  assert.equal(saveInstrument(storage, 'organ'), false);
  assert.equal(saveMeasuresPerRow(storage, 0), false);
  assert.equal(storage.values.get('easy-score.instrument'), 'piano');
  assert.equal(storage.values.get('easy-score.measures-per-row'), '1');
});

test('restricted storage falls back safely and write failures stay non-fatal', () => {
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
  };
  assert.deepEqual(loadPreferences(storage), { instrumentId: 'saxophone', measuresPerRow: 'auto' });
  assert.equal(saveInstrument(storage, 'piano'), false);
  assert.equal(saveMeasuresPerRow(storage, 6), false);
});

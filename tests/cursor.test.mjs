import assert from 'node:assert/strict';
import test from 'node:test';
import { syncCursorToBeat } from '../src/cursor.mjs';

function cursorAt(timestamps) {
  let index = 0;
  let previousCalls = 0;
  const cursor = {
    iterator: {
      endReached: false,
      clone() {
        let probeIndex = index;
        return {
          get currentTimeStamp() { return { realValue: timestamps[probeIndex] / 4 }; },
          moveToNextVisibleVoiceEntry() { probeIndex = Math.min(timestamps.length - 1, probeIndex + 1); },
        };
      },
    },
    reset() { index = 0; this.iterator.endReached = false; },
    next() { index += 1; this.iterator.endReached = index >= timestamps.length - 1; },
    previous() { previousCalls += 1; index -= 1; this.iterator.endReached = false; },
    show() {},
    timestampBeats() { return timestamps[index]; },
  };
  return { cursor, index: () => index, previousCalls: () => previousCalls };
}

test('cursor stays on the current note until the next note begins', () => {
  const fixture = cursorAt([0, 1, 2, 3]);
  syncCursorToBeat(fixture.cursor, 0.99, { reset: true });
  assert.equal(fixture.index(), 0);
  assert.equal(fixture.previousCalls(), 0);

  syncCursorToBeat(fixture.cursor, 1, { reset: false });
  assert.equal(fixture.index(), 1);
});

test('cursor resets before seeking backward and lands on the floor timestamp', () => {
  const fixture = cursorAt([0, 0.5, 1.5, 2]);
  syncCursorToBeat(fixture.cursor, 1.8, { reset: true });
  assert.equal(fixture.index(), 2);
  syncCursorToBeat(fixture.cursor, 0.75, { reset: true });
  assert.equal(fixture.index(), 1);
});

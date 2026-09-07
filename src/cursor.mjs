export function cursorTimestampBeats(cursor) {
  if (typeof cursor?.timestampBeats === 'function') return cursor.timestampBeats();
  const iterator = cursor?.iterator;
  const timestamp = iterator?.currentTimeStamp || iterator?.CurrentTimeStamp;
  const real = timestamp?.realValue ?? timestamp?.RealValue;
  return Number.isFinite(real) ? real * 4 : null;
}

function nextTimestampBeats(cursor) {
  const probe = cursor?.iterator?.clone?.();
  if (!probe) return null;
  probe.moveToNextVisibleVoiceEntry(false);
  const timestamp = probe.currentTimeStamp || probe.CurrentTimeStamp;
  const real = timestamp?.realValue ?? timestamp?.RealValue;
  return Number.isFinite(real) ? real * 4 : null;
}

export function syncCursorToBeat(cursor, beat, { reset = false } = {}) {
  if (!cursor) return null;
  if (reset) cursor.reset();

  let guard = 0;
  let timestamp = cursorTimestampBeats(cursor);
  while (timestamp !== null && timestamp < beat && guard++ < 10000 && !cursor.iterator?.endReached) {
    const nextTimestamp = nextTimestampBeats(cursor);
    if (nextTimestamp !== null && nextTimestamp > beat) break;
    cursor.next();
    const next = cursorTimestampBeats(cursor);
    if (next === null || next === timestamp) break;
    if (nextTimestamp === null && next > beat) {
      cursor.previous();
      break;
    }
    timestamp = next;
  }
  cursor.show();
  return cursorTimestampBeats(cursor);
}

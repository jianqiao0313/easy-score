import { DEFAULT_INSTRUMENT_ID, isInstrumentId } from './instruments.mjs';

const INSTRUMENT_KEY = 'easy-score.instrument';
const MEASURES_PER_ROW_KEY = 'easy-score.measures-per-row';

function validMeasuresPerRow(value) {
  if (value === 'auto') return true;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 8;
}

export function loadPreferences(storage) {
  let instrumentId = DEFAULT_INSTRUMENT_ID;
  let measuresPerRow = 'auto';
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const storedInstrument = target?.getItem(INSTRUMENT_KEY);
    const storedMeasures = target?.getItem(MEASURES_PER_ROW_KEY);
    if (isInstrumentId(storedInstrument)) instrumentId = storedInstrument;
    if (validMeasuresPerRow(storedMeasures)) measuresPerRow = storedMeasures === 'auto' ? 'auto' : Number(storedMeasures);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return { instrumentId, measuresPerRow };
}

export function saveInstrument(storage, instrumentId) {
  if (!isInstrumentId(instrumentId)) return false;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    target?.setItem(INSTRUMENT_KEY, instrumentId);
    return true;
  } catch {
    return false;
  }
}

export function saveMeasuresPerRow(storage, value) {
  if (!validMeasuresPerRow(value)) return false;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    target?.setItem(MEASURES_PER_ROW_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}

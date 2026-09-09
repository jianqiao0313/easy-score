export const DEFAULT_INSTRUMENT_ID = 'piano';

export const INSTRUMENTS = Object.freeze([
  Object.freeze({ id: 'piano', name: '钢琴', description: 'Salamander 大三角钢琴（加载失败时使用合成音色）' }),
  Object.freeze({ id: 'saxophone', name: '萨克斯', description: '本地采样萨克斯（加载失败时使用合成音色）' }),
]);

export function isInstrumentId(value) {
  return INSTRUMENTS.some(({ id }) => id === value);
}

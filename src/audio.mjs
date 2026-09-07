export const INSTRUMENTS = Object.freeze([
  Object.freeze({ id: 'piano', name: '钢琴', description: '本地采样钢琴（加载失败时使用合成音色）' }),
  Object.freeze({ id: 'saxophone', name: '中音萨克斯', description: '本地采样中音萨克斯（加载失败时使用合成音色）' }),
]);

const INSTRUMENT_IDS = new Set(INSTRUMENTS.map(({ id }) => id));
const SAMPLE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LOOKAHEAD_SECONDS = 0.15;
const SCHEDULER_INTERVAL_MS = 25;
const POSITION_INTERVAL_MS = 33;
const SILENCE_PEAK_THRESHOLD = 0.0005;
const SAMPLE_FALLBACK_SEMITONES = 12;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function midiToSampleName(midi) {
  const rounded = Math.round(midi);
  return `${SAMPLE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function safeStop(node, when = 0) {
  try { node.stop(when); } catch { /* A source may already have ended. */ }
  try { node.disconnect(); } catch { /* Disconnect is best-effort. */ }
}

export class ScorePlayer {
  constructor({ instrumentId = 'saxophone', onPosition = () => {}, onEnded = () => {}, onStatus = () => {} } = {}) {
    if (!INSTRUMENT_IDS.has(instrumentId)) throw new RangeError(`未知音色：${instrumentId}`);
    this._onPosition = onPosition;
    this._onEnded = onEnded;
    this._onStatus = onStatus;
    this._score = null;
    this._context = null;
    this._masterGain = null;
    this._tempo = 120;
    this._instrumentId = instrumentId;
    this._metronome = false;
    this._volume = 0.8;
    this._soundMode = 'uninitialized';
    this._sampleMaps = new Map();
    this._sampleBuffers = new Map();
    this._sampleDecodePromises = new Map();
    this._sampleFailures = new Set();
    this._sampleFailureMessages = new Map();
    this._activeSources = new Set();
    this._playing = false;
    this._playIntent = false;
    this._storedBeat = 0;
    this._anchorBeat = 0;
    this._anchorTime = 0;
    this._nextNoteIndex = 0;
    this._nextMetronomeBeat = 0;
    this._metronomeEvents = [];
    this._schedulerTimer = null;
    this._positionTimer = null;
    this._operationId = 0;
  }

  get currentBeat() {
    if (!this._playing || !this._context) return this._storedBeat;
    return this._beatAtContextTime(this._audibleContextTime());
  }

  get isPlaying() { return this._playIntent; }
  get soundMode() { return this._soundMode; }
  get soundSource() { return this._soundMode === 'sample' ? 'sample' : this._soundMode === 'synthesized' ? 'synth' : null; }
  get instrumentId() { return this._instrumentId; }

  async load(score) {
    if (!score || !Array.isArray(score.notes) || !Number.isFinite(score.totalBeats) || score.totalBeats < 0) {
      throw new TypeError('乐谱时间线无效。');
    }
    this.stop();
    this._score = { ...score, notes: [...score.notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi) };
    this._metronomeEvents = this._buildMetronomeEvents(this._score);
    this._tempo = Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : 120;
    this._storedBeat = 0;
    this._onPosition(0);
  }

  async play() {
    if (!this._score || this._playIntent) return;
    const operationId = ++this._operationId;
    if (this._storedBeat >= this._score.totalBeats) this._storedBeat = 0;
    if (this._score.totalBeats <= 0) {
      this._onEnded();
      return;
    }

    this._playIntent = true;
    try {
      await this._ensureAudio();
      await this._context.resume();
      const soundMode = await this._ensureInstrumentSamples(this._instrumentId);
      if (operationId !== this._operationId) return;
      this._setSoundMode(soundMode, this._soundModeMessage(this._instrumentId, soundMode));
      this._playing = true;
      this._restartScheduling(this._storedBeat);
    } catch (error) {
      if (operationId === this._operationId) this._playIntent = false;
      throw error;
    }
  }

  pause() {
    const beat = this.currentBeat;
    this._operationId += 1;
    this._playIntent = false;
    if (this._playing) this._storedBeat = beat;
    this._playing = false;
    this._clearTimersAndSources();
    this._onPosition(this._storedBeat);
  }

  stop() {
    this._operationId += 1;
    this._playIntent = false;
    this._playing = false;
    this._storedBeat = 0;
    this._clearTimersAndSources();
    this._onPosition(0);
  }

  seek(beat) {
    const target = clamp(Number(beat) || 0, 0, this._score?.totalBeats || 0);
    this._storedBeat = target;
    if (this._playing && target >= this._score.totalBeats) {
      this._finish();
      return;
    }
    if (this._playing) this._restartScheduling(target);
    this._onPosition(target);
  }

  setTempo(bpm) {
    const nextTempo = Number(bpm);
    if (!Number.isFinite(nextTempo) || nextTempo <= 0) throw new RangeError('速度必须是大于 0 的数值。');
    const beat = this.currentBeat;
    this._tempo = clamp(nextTempo, 20, 400);
    this._storedBeat = beat;
    if (this._playing) this._restartScheduling(beat);
  }

  async setInstrument(id) {
    if (!INSTRUMENT_IDS.has(id)) throw new RangeError(`未知音色：${id}`);
    const operationId = ++this._operationId;
    const wasPlaying = this._playIntent;
    const beat = this.currentBeat;
    this._storedBeat = beat;
    this._playing = false;
    this._clearTimersAndSources();
    this._instrumentId = id;
    try {
      await this._ensureAudio();
      await this._context.resume();
      const soundMode = await this._ensureInstrumentSamples(id);
      if (operationId !== this._operationId) return;
      this._setSoundMode(soundMode, this._soundModeMessage(id, soundMode));
      if (wasPlaying && this._playIntent) {
        this._playing = true;
        this._restartScheduling(this._storedBeat);
      }
    } catch (error) {
      if (operationId === this._operationId && wasPlaying) this._playIntent = false;
      throw error;
    }
  }

  setMetronome(enabled) {
    const beat = this.currentBeat;
    this._metronome = Boolean(enabled);
    this._storedBeat = beat;
    if (this._playing) this._restartScheduling(beat);
  }

  setVolume(value) {
    this._volume = clamp(Number(value) || 0, 0, 1);
    if (this._masterGain && this._context) this._masterGain.gain.setValueAtTime(this._volume, this._context.currentTime);
  }

  async dispose() {
    this.stop();
    if (this._context && this._context.state !== 'closed') await this._context.close();
    this._context = null;
    this._masterGain = null;
    this._sampleBuffers.clear();
    this._sampleDecodePromises.clear();
  }

  async _ensureAudio() {
    if (this._context) return;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio。');
    this._context = new AudioContextClass();
    this._masterGain = this._context.createGain();
    this._masterGain.gain.setValueAtTime(this._volume, this._context.currentTime);
    this._masterGain.connect(this._context.destination);
  }

  async _ensureInstrumentSamples(instrumentId) {
    if (this._sampleFailures.has(instrumentId)) {
      return 'synthesized';
    }
    let buffers = this._sampleBuffers.get(instrumentId);
    if (!buffers) {
      buffers = new Map();
      this._sampleBuffers.set(instrumentId, buffers);
    }

    try {
      let sampleMap = this._sampleMaps.get(instrumentId);
      if (!sampleMap) {
        const response = await fetch(`/soundfonts/${instrumentId}.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status || 'error'}`);
        sampleMap = await response.json();
        this._sampleMaps.set(instrumentId, sampleMap);
      }
      const neededMidi = [...new Set((this._score?.notes || []).map(({ midi }) => Math.round(midi)))];
      await Promise.all(neededMidi.map(async (midi) => {
        if (buffers.has(midi)) return;
        const sample = await this._findAudibleSample(instrumentId, sampleMap, midi);
        if (!sample) throw new Error(`MIDI ${midi} 附近没有可听采样`);
        buffers.set(midi, sample);
      }));
      return 'sample';
    } catch (error) {
      this._sampleFailures.add(instrumentId);
      this._sampleFailureMessages.set(instrumentId, `本地采样加载失败，已使用合成音色：${error.message}`);
      return 'synthesized';
    }
  }

  _soundModeMessage(instrumentId, soundMode) {
    return soundMode === 'sample'
      ? '正在使用本地 FluidR3_GM 采样。'
      : this._sampleFailureMessages.get(instrumentId) || '本地采样不可用，已切换到合成音色。';
  }

  _setSoundMode(soundMode, message) {
    this._soundMode = soundMode;
    this._onStatus({ instrumentId: this._instrumentId, soundMode, message });
  }

  _secondsPerBeat() { return 60 / this._tempo; }

  _beatAtContextTime(contextTime) {
    return clamp(this._anchorBeat + (contextTime - this._anchorTime) / this._secondsPerBeat(), this._anchorBeat, this._score?.totalBeats || 0);
  }

  _audibleContextTime() {
    if (typeof this._context.getOutputTimestamp !== 'function') return this._context.currentTime;
    const contextTime = this._context.getOutputTimestamp()?.contextTime;
    return Number.isFinite(contextTime) ? contextTime : this._context.currentTime;
  }

  async _findAudibleSample(instrumentId, sampleMap, targetMidi) {
    for (let distance = 0; distance <= SAMPLE_FALLBACK_SEMITONES; distance += 1) {
      const candidates = distance === 0 ? [targetMidi] : [targetMidi - distance, targetMidi + distance];
      for (const sourceMidi of candidates) {
        if (!sampleMap[midiToSampleName(sourceMidi)]) continue;
        const buffer = await this._decodeSample(instrumentId, sampleMap, sourceMidi);
        if (this._isAudibleBuffer(buffer)) return { buffer, sourceMidi };
      }
    }
    return null;
  }

  async _decodeSample(instrumentId, sampleMap, midi) {
    let promises = this._sampleDecodePromises.get(instrumentId);
    if (!promises) {
      promises = new Map();
      this._sampleDecodePromises.set(instrumentId, promises);
    }
    if (!promises.has(midi)) {
      promises.set(midi, (async () => {
        const response = await fetch(sampleMap[midiToSampleName(midi)]);
        if (!response.ok) throw new Error(`无法读取 MIDI ${midi} 的采样`);
        return this._context.decodeAudioData(await response.arrayBuffer());
      })());
    }
    return promises.get(midi);
  }

  _isAudibleBuffer(buffer) {
    if (!Number.isFinite(buffer?.numberOfChannels) || typeof buffer.getChannelData !== 'function') return true;
    for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
      const channel = buffer.getChannelData(channelIndex);
      const stride = Math.max(1, Math.floor(channel.length / 8192));
      for (let index = 0; index < channel.length; index += stride) {
        if (Math.abs(channel[index]) >= SILENCE_PEAK_THRESHOLD) return true;
      }
    }
    return false;
  }

  _restartScheduling(beat) {
    this._clearTimersAndSources();
    this._storedBeat = beat;
    this._anchorBeat = beat;
    this._anchorTime = this._context.currentTime;
    this._nextNoteIndex = this._score.notes.findIndex((note) => note.startBeat + note.durationBeats > beat);
    if (this._nextNoteIndex < 0) this._nextNoteIndex = this._score.notes.length;
    this._nextMetronomeBeat = this._metronomeEvents.findIndex((event) => event.beat >= beat - 1e-7);
    if (this._nextMetronomeBeat < 0) this._nextMetronomeBeat = this._metronomeEvents.length;
    this._scheduleWindow();
    if (!this._playing) return;
    this._onPosition(beat);
    this._schedulerTimer = setInterval(() => this._scheduleWindow(), SCHEDULER_INTERVAL_MS);
    this._positionTimer = setInterval(() => this._emitPosition(), POSITION_INTERVAL_MS);
  }

  _clearTimersAndSources() {
    if (this._schedulerTimer) clearInterval(this._schedulerTimer);
    if (this._positionTimer) clearInterval(this._positionTimer);
    this._schedulerTimer = null;
    this._positionTimer = null;
    for (const source of this._activeSources) safeStop(source);
    this._activeSources.clear();
  }

  _emitPosition() {
    if (!this._playing) return;
    const beat = this.currentBeat;
    this._onPosition(beat);
    if (beat >= this._score.totalBeats) this._finish();
  }

  _finish() {
    this._playIntent = false;
    this._playing = false;
    this._storedBeat = this._score.totalBeats;
    this._clearTimersAndSources();
    this._onPosition(this._storedBeat);
    this._onEnded();
  }

  _scheduleWindow() {
    if (!this._playing) return;
    const nowBeat = this._beatAtContextTime(this._context.currentTime);
    if (nowBeat >= this._score.totalBeats) return;
    const horizonBeat = nowBeat + LOOKAHEAD_SECONDS / this._secondsPerBeat();
    while (this._nextNoteIndex < this._score.notes.length) {
      const note = this._score.notes[this._nextNoteIndex];
      if (note.startBeat > horizonBeat) break;
      this._nextNoteIndex += 1;
      if (note.startBeat + note.durationBeats <= nowBeat) continue;
      this._scheduleNote(note, nowBeat);
    }
    if (this._metronome) this._scheduleMetronome(horizonBeat);
  }

  _scheduleNote(note, nowBeat) {
    const secondsPerBeat = this._secondsPerBeat();
    const audibleStartBeat = Math.max(note.startBeat, nowBeat);
    const when = Math.max(this._context.currentTime + 0.005, this._anchorTime + (audibleStartBeat - this._anchorBeat) * secondsPerBeat);
    const duration = Math.max(0.02, (note.startBeat + note.durationBeats - audibleStartBeat) * secondsPerBeat);
    const offset = Math.max(0, (audibleStartBeat - note.startBeat) * secondsPerBeat);
    const sample = this._sampleBuffers.get(this._instrumentId)?.get(Math.round(note.midi));
    if (this._soundMode === 'sample' && sample) this._scheduleSample(note.midi, sample, when, duration, offset);
    else this._scheduleSynth(note.midi, when, duration);
  }

  _trackSource(source) {
    this._activeSources.add(source);
    source.onended = () => this._activeSources.delete(source);
  }

  _scheduleSample(midi, sample, when, duration, offset) {
    const { buffer, sourceMidi } = sample;
    const source = this._context.createBufferSource();
    const envelope = this._context.createGain();
    source.buffer = buffer;
    const playbackRate = 2 ** ((midi - sourceMidi) / 12);
    source.playbackRate.setValueAtTime(playbackRate, when);
    source.connect(envelope);
    envelope.connect(this._masterGain);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.linearRampToValueAtTime(this._instrumentId === 'piano' ? 0.72 : 0.5, when + 0.015);
    if (this._instrumentId === 'saxophone' && buffer.duration > 0.4) {
      source.loop = true;
      source.loopStart = buffer.duration * 0.25;
      source.loopEnd = buffer.duration * 0.72;
      envelope.gain.setValueAtTime(0.5, when + Math.max(0.02, duration - 0.08));
      envelope.gain.linearRampToValueAtTime(0.0001, when + duration);
    } else {
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration + 0.12);
    }
    this._trackSource(source);
    source.start(when, Math.min(offset * playbackRate, Math.max(0, buffer.duration - 0.02)));
    source.stop(when + duration + 0.14);
  }

  _scheduleSynth(midi, when, duration) {
    const oscillator = this._context.createOscillator();
    const envelope = this._context.createGain();
    oscillator.type = this._instrumentId === 'piano' ? 'triangle' : 'sawtooth';
    oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), when);
    oscillator.connect(envelope);
    envelope.connect(this._masterGain);
    envelope.gain.setValueAtTime(0.0001, when);
    envelope.gain.linearRampToValueAtTime(this._instrumentId === 'piano' ? 0.32 : 0.16, when + 0.012);
    if (this._instrumentId === 'piano') envelope.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(duration + 0.2, 1.8));
    else {
      envelope.gain.setValueAtTime(0.16, when + Math.max(0.02, duration - 0.08));
      envelope.gain.linearRampToValueAtTime(0.0001, when + duration);
    }
    this._trackSource(oscillator);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.22);
  }

  _scheduleMetronome(horizonBeat) {
    while (this._nextMetronomeBeat < this._metronomeEvents.length) {
      const { beat, strong } = this._metronomeEvents[this._nextMetronomeBeat];
      if (beat > horizonBeat) break;
      const when = Math.max(this._context.currentTime + 0.005, this._anchorTime + (beat - this._anchorBeat) * this._secondsPerBeat());
      const oscillator = this._context.createOscillator();
      const envelope = this._context.createGain();
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(strong ? 1320 : 880, when);
      oscillator.connect(envelope);
      envelope.connect(this._masterGain);
      envelope.gain.setValueAtTime(strong ? 0.2 : 0.11, when);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
      this._trackSource(oscillator);
      oscillator.start(when);
      oscillator.stop(when + 0.05);
      this._nextMetronomeBeat += 1;
    }
  }

  _buildMetronomeEvents(score) {
    const measures = score.measures?.length
      ? score.measures
      : [{ startBeat: 0, durationBeats: score.totalBeats, timeSignature: score.timeSignature }];
    const events = [];
    for (const measure of measures) {
      const meter = measure.timeSignature || score.timeSignature || { beats: 4, beatType: 4 };
      const step = 4 / (meter.beatType || 4);
      const end = Math.min(score.totalBeats, measure.startBeat + measure.durationBeats);
      for (let beat = measure.startBeat, index = 0; beat < end - 1e-7; beat += step, index += 1) {
        events.push({ beat, strong: index === 0 });
      }
    }
    return events;
  }
}

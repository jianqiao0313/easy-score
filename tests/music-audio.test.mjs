import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTRUMENTS, ScorePlayer } from '../src/audio.mjs';

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'set', value, time });
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'exponential', value, time });
  }
  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); }
}

class FakeNode {
  constructor(context) {
    this.context = context;
    this.gain = new FakeParam(1);
    this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0);
    this.playbackRate = new FakeParam(1);
    this.stopped = false;
    this.stopCalls = [];
    this.connections = [];
  }
  connect(node) {
    this.connections.push(node);
    return this;
  }
  disconnect() {}
  start(when = 0, offset = 0) { this.started = { when, offset }; }
  stop(when = 0) { this.stopped = true; this.stopTime = when; this.stopCalls.push(when); }
}

class FakeAudioContext {
  static instances = [];
  constructor() {
    this.currentTime = 10;
    this.state = 'suspended';
    this.destination = new FakeNode(this);
    this.bufferSources = [];
    this.oscillators = [];
    FakeAudioContext.instances.push(this);
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  async decodeAudioData(bytes) { return { duration: 2, bytes }; }
  createGain() { return new FakeNode(this); }
  createBufferSource() {
    const node = new FakeNode(this);
    this.bufferSources.push(node);
    return node;
  }
  createOscillator() {
    const node = new FakeNode(this);
    this.oscillators.push(node);
    return node;
  }
}

function decodedBuffer(samples, duration = 2) {
  const channel = Float32Array.from(samples);
  return {
    duration,
    sampleRate: channel.length / duration,
    numberOfChannels: 1,
    getChannelData() { return channel; },
  };
}

function loopBoundaryError(channel, sampleRate, startTime, endTime) {
  const start = Math.round(startTime * sampleRate);
  const end = Math.round(endTime * sampleRate);
  let error = 0;
  for (let offset = -8; offset <= 8; offset += 1) {
    error += (channel[start + offset] - channel[end + offset]) ** 2;
  }
  return error;
}

const score = {
  tempo: 120,
  timeSignature: { beats: 4, beatType: 4 },
  totalBeats: 4,
  notes: [
    { id: 'a', partId: 'P1', midi: 60, startBeat: 0, durationBeats: 1, measure: 1 },
    { id: 'b', partId: 'P1', midi: 64, startBeat: 0, durationBeats: 2, measure: 1 },
  ],
};

test('ScorePlayer initializes audio lazily, loads only used local samples, and cancels scheduled sources on pause', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'data:audio/mp3;base64,AA==', E4: 'data:audio/mp3;base64,AQ==' }; } };
    }
    return { ok: true, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load(score);
  assert.equal(FakeAudioContext.instances.length, 0);

  await player.play();
  const context = FakeAudioContext.instances[0];
  assert.equal(context.state, 'running');
  assert.equal(player.soundMode, 'sample');
  assert.equal(player.soundSource, 'sample');
  assert.equal(fetched.filter((url) => url.startsWith('data:')).length, 2);
  assert.equal(context.bufferSources.length, 2);
  assert.equal(context.oscillators.length, 0);
  assert.equal(player.isPlaying, true);

  player.pause();
  assert.equal(player.isPlaying, false);
  assert.ok(context.bufferSources.every((source) => source.stopped));
  await player.dispose();
});

test('ScorePlayer exposes distinct instruments and falls back visibly to synthesis when samples fail', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async () => { throw new Error('offline'); };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  assert.deepEqual(INSTRUMENTS.map(({ id }) => id), ['piano', 'saxophone']);
  const statuses = [];
  const player = new ScorePlayer({ onStatus: (status) => statuses.push(status) });
  await player.load(score);
  await player.setInstrument('saxophone');
  await player.play();

  const context = FakeAudioContext.instances[0];
  assert.equal(player.soundMode, 'synthesized');
  assert.equal(player.soundSource, 'synth');
  assert.ok(context.oscillators.length >= 2);
  assert.ok(statuses.some((status) => status.soundMode === 'synthesized'));
  assert.ok(statuses.some((status) => status.message.includes('offline')));
  player.stop();
  assert.equal(player.currentBeat, 0);
  await player.dispose();
});

test('ScorePlayer defaults to alto saxophone without creating an AudioContext and accepts a stored initial instrument', () => {
  FakeAudioContext.instances.length = 0;

  const defaultPlayer = new ScorePlayer();
  const storedPreferencePlayer = new ScorePlayer({ instrumentId: 'piano' });

  assert.equal(defaultPlayer.instrumentId, 'saxophone');
  assert.equal(storedPreferencePlayer.instrumentId, 'piano');
  assert.equal(FakeAudioContext.instances.length, 0);
  assert.throws(() => new ScorePlayer({ instrumentId: 'accordion' }), /未知音色/);
});

test('ScorePlayer pitch-shifts the nearest audible alto sax sample when the requested sample is silent', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  const fetchedSamples = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('saxophone.json')) {
      return {
        ok: true,
        async json() {
          return { D6: 'sax-d6', Db6: 'sax-db6', C6: 'sax-c6' };
        },
      };
    }
    fetchedSamples.push(value);
    return {
      ok: true,
      async arrayBuffer() { return Uint8Array.of(value === 'sax-c6' ? 1 : 0).buffer; },
    };
  };
  const originalDecode = FakeAudioContext.prototype.decodeAudioData;
  FakeAudioContext.prototype.decodeAudioData = async function decodeAudioData(bytes) {
    return decodedBuffer([new Uint8Array(bytes)[0] ? 0.2 : 0.00002]);
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
    FakeAudioContext.prototype.decodeAudioData = originalDecode;
  });

  const statuses = [];
  const player = new ScorePlayer({ onStatus: (status) => statuses.push(status) });
  await player.load({ ...score, notes: [{ ...score.notes[0], midi: 86 }] });
  await player.play();

  const source = FakeAudioContext.instances[0].bufferSources[0];
  assert.deepEqual(fetchedSamples, ['sax-d6', 'sax-db6', 'sax-c6']);
  assert.ok(Math.abs(source.playbackRate.value - 2 ** (2 / 12)) < 1e-10);
  assert.match(statuses.at(-1).message, /FluidR3_GM 中音萨克斯/);
  player.stop();
  await player.dispose();
});

test('ScorePlayer aligns the alto sax loop waveform and releases after the written note duration', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const originalDecode = FakeAudioContext.prototype.decodeAudioData;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  const sampleRate = 1000;
  const duration = 2;
  const channel = Float32Array.from({ length: sampleRate * duration }, (_, index) => {
    const time = index / sampleRate;
    return Math.sin(2 * Math.PI * 37 * time) * (0.7 + 0.08 * Math.sin(2 * Math.PI * 0.8 * time));
  });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: 'sax-c4' }; } };
    }
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  FakeAudioContext.prototype.decodeAudioData = async () => ({
    duration,
    sampleRate,
    numberOfChannels: 1,
    getChannelData() { return channel; },
  });
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
    FakeAudioContext.prototype.decodeAudioData = originalDecode;
  });

  const player = new ScorePlayer();
  await player.load({ ...score, notes: [{ ...score.notes[0], durationBeats: 2 }] });
  await player.play();

  const source = FakeAudioContext.instances[0].bufferSources[0];
  assert.equal(source.loop, true);
  assert.ok(source.loopStart >= duration * 0.31 && source.loopStart <= duration * 0.33);
  assert.ok(source.loopEnd >= duration * 0.68 && source.loopEnd <= duration * 0.82);
  assert.ok(
    loopBoundaryError(channel, sampleRate, source.loopStart, source.loopEnd)
      < loopBoundaryError(channel, sampleRate, duration * 0.25, duration * 0.72) * 0.01,
  );

  const noteStart = source.started.when;
  const noteEnd = noteStart + 1;
  assert.deepEqual(source.connections[0].gain.events, [
    { type: 'set', value: 0.0001, time: noteStart },
    { type: 'linear', value: 0.46, time: noteStart + 0.008 },
    { type: 'set', value: 0.46, time: noteEnd },
    { type: 'linear', value: 0.0001, time: noteEnd + 0.1 },
  ]);
  assert.equal(source.stopTime, noteEnd + 0.1);
  player.stop();
  await player.dispose();
});

test('ScorePlayer reuses a nearby Salamander piano root sample with a natural sustain envelope', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const originalDecode = FakeAudioContext.prototype.decodeAudioData;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  const fetchedSamples = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'piano-c4', Eb4: 'piano-eb4' }; } };
    }
    fetchedSamples.push(value);
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  FakeAudioContext.prototype.decodeAudioData = async () => decodedBuffer([0.2], 16);
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
    FakeAudioContext.prototype.decodeAudioData = originalDecode;
  });

  const statuses = [];
  const player = new ScorePlayer({ instrumentId: 'piano', onStatus: (status) => statuses.push(status) });
  await player.load({
    ...score,
    totalBeats: 2,
    notes: [
      { ...score.notes[0], id: 'piano-a', midi: 61, durationBeats: 2 },
      { ...score.notes[0], id: 'piano-b', midi: 61, durationBeats: 2 },
    ],
  });
  await player.play();

  const sources = FakeAudioContext.instances[0].bufferSources;
  assert.deepEqual(fetchedSamples, ['piano-c4']);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].buffer, sources[1].buffer);
  assert.ok(Math.abs(sources[0].playbackRate.value - 2 ** (1 / 12)) < 1e-10);
  assert.match(statuses.at(-1).message, /Salamander Grand Piano/);

  const source = sources[0];
  const noteStart = source.started.when;
  const noteEnd = noteStart + 1;
  assert.deepEqual(source.connections[0].gain.events, [
    { type: 'set', value: 0.0001, time: noteStart },
    { type: 'linear', value: 0.72, time: noteStart + 0.005 },
    { type: 'set', value: 0.72, time: noteEnd },
    { type: 'exponential', value: 0.0001, time: noteEnd + 0.3 },
  ]);
  assert.equal(source.stopTime, noteEnd + 0.3);
  player.stop();
  assert.ok(sources.every((scheduledSource) => scheduledSource.stopCalls.includes(0)));
  await player.dispose();
});

test('ScorePlayer reports the beat currently rendered by the audio output device', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: 'sax-c', E4: 'sax-e' }; } };
    }
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer();
  await player.load(score);
  await player.play();
  const context = FakeAudioContext.instances[0];
  context.currentTime = 10.5;
  context.getOutputTimestamp = () => ({ contextTime: 10.25, performanceTime: 1000 });

  assert.equal(player.currentBeat, 0.5);
  player.stop();
  await player.dispose();
});

test('ScorePlayer does not finish before the output device renders the score end', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: 'sax-c' }; } };
    }
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer();
  await player.load({ ...score, totalBeats: 1, notes: [score.notes[0]] });
  await player.play();
  const context = FakeAudioContext.instances[0];
  context.currentTime = 10.6;
  context.getOutputTimestamp = () => ({ contextTime: 10.4, performanceTime: 1000 });

  player._scheduleWindow();
  assert.equal(player.isPlaying, true);
  assert.ok(Math.abs(player.currentBeat - 0.8) < 1e-10);

  context.getOutputTimestamp = () => ({ contextTime: 10.5, performanceTime: 1100 });
  player._emitPosition();
  assert.equal(player.isPlaying, false);
  await player.dispose();
});

test('natural score completion preserves the piano release tail without leaving transport timers', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'piano-c4' }; } };
    }
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  const activeIntervals = new Set();
  globalThis.setInterval = () => {
    const handle = {};
    activeIntervals.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => activeIntervals.delete(handle);
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  let endedCount = 0;
  const player = new ScorePlayer({ instrumentId: 'piano', onEnded: () => { endedCount += 1; } });
  await player.load({ ...score, totalBeats: 1, notes: [score.notes[0]] });
  await player.play();
  const context = FakeAudioContext.instances[0];
  const source = context.bufferSources[0];
  const scheduledStops = [...source.stopCalls];
  assert.equal(activeIntervals.size, 2);

  context.getOutputTimestamp = () => ({ contextTime: 10.5, performanceTime: 1000 });
  player._emitPosition();
  assert.equal(player.isPlaying, false);
  assert.equal(endedCount, 1);
  assert.equal(activeIntervals.size, 0);
  assert.deepEqual(source.stopCalls, scheduledStops);

  player.seek(0.25);
  assert.ok(source.stopCalls.includes(0));
  assert.equal(player.currentBeat, 0.25);
  await player.dispose();
});

test('ScorePlayer position does not regress behind a new seek anchor while output catches up', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: 'sax-c', E4: 'sax-e' }; } };
    }
    return { ok: true, async arrayBuffer() { return Uint8Array.of(1).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer();
  await player.load(score);
  await player.play();
  const context = FakeAudioContext.instances[0];
  player.seek(2);
  context.getOutputTimestamp = () => ({ contextTime: context.currentTime - 0.1, performanceTime: 1000 });

  assert.equal(player.currentBeat, 2);
  player.stop();
  await player.dispose();
});

test('ScorePlayer metronome accents measure starts and follows a changed beat subdivision', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'data:audio/mp3;base64,AA==', E4: 'data:audio/mp3;base64,AQ==' }; } };
    }
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load({
    ...score,
    tempo: 400,
    totalBeats: 5.5,
    measures: [
      { number: 1, startBeat: 0, durationBeats: 4, timeSignature: { beats: 4, beatType: 4 } },
      { number: 2, startBeat: 4, durationBeats: 1.5, timeSignature: { beats: 3, beatType: 8 } },
    ],
  });
  player.setMetronome(true);
  player.seek(4);
  await player.play();
  const clicks = FakeAudioContext.instances[0].oscillators;
  assert.deepEqual(clicks.slice(0, 3).map((click) => click.frequency.value), [1320, 880, 880]);
  player.stop();
  await player.dispose();
});

test('ScorePlayer does not start stale playback after stop is called during sample decoding', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  let releaseSample;
  const sampleResponse = new Promise((resolve) => { releaseSample = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'data:audio/mp3;base64,AA==', E4: 'data:audio/mp3;base64,AQ==' }; } };
    }
    return sampleResponse;
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load(score);
  const playing = player.play();
  await Promise.resolve();
  await Promise.resolve();
  player.stop();
  releaseSample({ ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } });
  await playing;

  assert.equal(player.isPlaying, false);
  assert.equal(player.currentBeat, 0);
  assert.equal(FakeAudioContext.instances[0].bufferSources.length, 0);
  await player.dispose();
});

test('ScorePlayer seek and tempo changes cancel old sources and preserve transport position', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'data:audio/mp3;base64,AA==', E4: 'data:audio/mp3;base64,AQ==' }; } };
    }
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load(score);
  await player.play();
  const context = FakeAudioContext.instances[0];
  const firstSources = context.bufferSources.slice();
  context.currentTime += 0.5;
  assert.equal(player.currentBeat, 1);

  player.seek(0.5);
  assert.equal(player.currentBeat, 0.5);
  assert.ok(firstSources.every((source) => source.stopCalls.includes(0)));
  const seekSources = context.bufferSources.slice(firstSources.length);

  player.setTempo(60);
  assert.ok(seekSources.every((source) => source.stopCalls.includes(0)));
  context.currentTime += 0.5;
  assert.equal(player.currentBeat, 1);
  player.pause();
  await player.dispose();
});

test('previousMeasure seeks to the preceding measure start across pickup and meter changes', async () => {
  const positions = [];
  const player = new ScorePlayer({ onPosition: (beat) => positions.push(beat) });
  const navigationScore = {
    ...score,
    totalBeats: 11.5,
    measures: [
      { number: 1, startBeat: 0, durationBeats: 1, timeSignature: { beats: 1, beatType: 4 } },
      { number: 2, startBeat: 1, durationBeats: 3, timeSignature: { beats: 3, beatType: 4 } },
      { number: 3, startBeat: 4, durationBeats: 5, timeSignature: { beats: 5, beatType: 4 } },
      { number: 4, startBeat: 9, durationBeats: 2.5, timeSignature: { beats: 5, beatType: 8 } },
    ],
  };
  await player.load(navigationScore);

  player.seek(6.25);
  assert.equal(player.previousMeasure(), 1);
  assert.equal(player.currentBeat, 1);
  assert.equal(player.isPlaying, false);

  player.seek(4);
  assert.equal(player.previousMeasure(), 1);

  player.seek(0.75);
  assert.equal(player.previousMeasure(), 0);

  player.seek(navigationScore.totalBeats);
  assert.equal(player.previousMeasure(), 4);
  assert.equal(positions.at(-1), 4);
  await player.dispose();
});

test('previousMeasure uses the audible playback position and keeps playback running', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'piano-c', E4: 'piano-e' }; } };
    }
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load({
    ...score,
    totalBeats: 12,
    measures: [
      { number: 1, startBeat: 0, durationBeats: 4 },
      { number: 2, startBeat: 4, durationBeats: 3 },
      { number: 3, startBeat: 7, durationBeats: 5 },
    ],
  });
  await player.play();
  const context = FakeAudioContext.instances[0];
  context.currentTime += 4;
  assert.equal(player.currentBeat, 8);

  const sourcesBeforeNavigation = context.bufferSources.slice();
  assert.equal(player.previousMeasure(), 4);
  assert.equal(player.currentBeat, 4);
  assert.equal(player.isPlaying, true);
  assert.ok(sourcesBeforeNavigation.every((source) => source.stopCalls.includes(0)));
  player.stop();
  await player.dispose();
});

test('pause during an instrument switch cancels the pending restart', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  let releaseSax;
  const saxSample = new Promise((resolve) => { releaseSax = resolve; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('piano.json') || value.endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: value.endsWith('piano.json') ? 'piano-c' : 'sax-c', E4: value.endsWith('piano.json') ? 'piano-e' : 'sax-e' }; } };
    }
    if (value.startsWith('sax-')) return saxSample;
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load(score);
  await player.play();
  const switching = player.setInstrument('saxophone');
  assert.equal(player.isPlaying, true);
  player.seek(2.5);
  player.pause();
  releaseSax({ ok: true, async arrayBuffer() { return new Uint8Array([2]).buffer; } });
  await switching;

  assert.equal(player.isPlaying, false);
  assert.equal(player.currentBeat, 2.5);
  await player.dispose();
});

test('seek during an instrument switch becomes the restart position', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  let releaseSax;
  const saxSample = new Promise((resolve) => { releaseSax = resolve; });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith('piano.json') || value.endsWith('saxophone.json')) {
      return { ok: true, async json() { return { C4: value.endsWith('piano.json') ? 'piano-c' : 'sax-c', E4: value.endsWith('piano.json') ? 'piano-e' : 'sax-e' }; } };
    }
    if (value.startsWith('sax-')) return saxSample;
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
  });

  const player = new ScorePlayer({ instrumentId: 'piano' });
  await player.load(score);
  await player.play();
  const switching = player.setInstrument('saxophone');
  player.seek(2.5);
  releaseSax({ ok: true, async arrayBuffer() { return new Uint8Array([2]).buffer; } });
  await switching;

  assert.equal(player.isPlaying, true);
  assert.equal(player.currentBeat, 2.5);
  player.pause();
  await player.dispose();
});

test('seeking to the end leaves no timers and replay immediately reports beat zero', async (t) => {
  const originalAudioContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  FakeAudioContext.instances.length = 0;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('piano.json')) {
      return { ok: true, async json() { return { C4: 'data:audio/mp3;base64,AA==', E4: 'data:audio/mp3;base64,AQ==' }; } };
    }
    return { ok: true, async arrayBuffer() { return new Uint8Array([1]).buffer; } };
  };
  const activeIntervals = new Set();
  globalThis.setInterval = () => {
    const handle = {};
    activeIntervals.add(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => activeIntervals.delete(handle);
  t.after(() => {
    globalThis.AudioContext = originalAudioContext;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  const positions = [];
  const player = new ScorePlayer({ instrumentId: 'piano', onPosition: (beat) => positions.push(beat) });
  await player.load(score);
  await player.play();
  assert.equal(activeIntervals.size, 2);

  player.seek(score.totalBeats);
  assert.equal(player.isPlaying, false);
  assert.equal(activeIntervals.size, 0);

  await player.play();
  assert.equal(player.isPlaying, true);
  assert.equal(positions.at(-1), 0);
  assert.equal(activeIntervals.size, 2);
  player.stop();
  await player.dispose();
});

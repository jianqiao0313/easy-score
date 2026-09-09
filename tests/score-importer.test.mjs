import assert from 'node:assert/strict';
import test from 'node:test';

import { ScoreImporter, fetchJson } from '../src/score-importer.mjs';

const XML = '<score-partwise version="4.0" />';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function abortError(error) {
  return error?.name === 'AbortError';
}

test('fetchJson returns JSON and preserves server error messages with an HTTP fallback', async () => {
  assert.deepEqual(await fetchJson('/ok', {}, async () => jsonResponse({ ok: true })), { ok: true });

  await assert.rejects(
    fetchJson('/message', {}, async () => jsonResponse({ message: '具体错误' }, { status: 422 })),
    { message: '具体错误' },
  );
  await assert.rejects(
    fetchJson('/empty', {}, async () => new Response('not json', { status: 503 })),
    { message: '请求失败（503）' },
  );
});

test('constructor uses global fetch and the default poll interval', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return jsonResponse({ id: 'default', status: 'processing' });
    if (calls.length === 2) return jsonResponse({ id: 'default', status: 'done' });
    return new Response(XML);
  };

  try {
    const importer = new ScoreImporter();
    const started = Date.now();
    const result = await importer.upload(new Blob(['pdf'], { type: 'application/pdf' }), {
      onProgress() {},
    });
    assert.equal(result.xml, XML);
    assert.ok(Date.now() - started >= 900, 'the default poll interval should be approximately one second');
    assert.deepEqual(calls, ['/api/jobs', '/api/jobs/default', '/api/jobs/default/score.musicxml']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('default fetch keeps the global receiver when reading MusicXML', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = function fetchRequiringGlobalReceiver(url) {
    assert.equal(this, globalThis);
    calls.push(url);
    if (url === '/api/jobs/browser') return Promise.resolve(jsonResponse({ id: 'browser', status: 'done' }));
    return Promise.resolve(new Response(XML));
  };

  try {
    const result = await new ScoreImporter().open('browser');
    assert.equal(result.xml, XML);
    assert.deepEqual(calls, ['/api/jobs/browser', '/api/jobs/browser/score.musicxml']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('upload validates supported formats and the 50 MB limit before fetching', async () => {
  let fetches = 0;
  const importer = new ScoreImporter({ fetchImpl: async () => { fetches += 1; } });

  await assert.rejects(importer.upload({ name: 'notes.txt', type: 'text/plain', size: 4 }), (error) => {
    assert.equal(error.message, '请选择 PDF、MusicXML（.musicxml / .xml / .mxl）或 PNG / JPG 乐谱图片。');
    assert.equal(error.code, 'INVALID_UPLOAD');
    return true;
  });
  await assert.rejects(importer.upload({ name: 'large.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 + 1 }), (error) => {
    assert.equal(error.message, '文件超过 50 MB，请选择更小的乐谱文件。');
    assert.equal(error.code, 'INVALID_UPLOAD');
    return true;
  });
  assert.equal(fetches, 0);
});

test('upload emits initial progress synchronously and sends the existing file headers', async () => {
  const requests = [];
  const progress = [];
  const file = Object.assign(new Blob(['music'], { type: 'application/xml' }), { name: '练习曲 #1.xml' });
  const importer = new ScoreImporter({
    pollIntervalMs: 0,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/jobs') return jsonResponse({ id: 'job / 1', status: 'done', sourceType: 'musicxml' }, { status: 202 });
      return new Response(XML);
    },
  });

  const promise = importer.upload(file, { onProgress: (job) => progress.push(job) });
  assert.deepEqual(progress, [{
    status: 'queued', sourceType: 'musicxml', progress: 0, fileName: file.name, message: '正在上传乐谱文件。',
  }]);

  const result = await promise;
  assert.equal(result.xml, XML);
  assert.equal(result.job.fileName, file.name);
  assert.deepEqual(progress.at(-1), result.job);
  assert.equal(requests[0].url, '/api/jobs');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/vnd.recordare.musicxml+xml');
  assert.equal(requests[0].options.headers['X-File-Name'], encodeURIComponent(file.name));
  assert.equal(requests[0].options.body, file);
  assert.equal(requests[1].url, '/api/jobs/job%20%2F%201/score.musicxml');
});

test('upload reports polled progress and honors a job-provided XML URL', async () => {
  const progress = [];
  const calls = [];
  const responses = [
    jsonResponse({ id: 'poll', status: 'queued', progress: 5 }),
    jsonResponse({ id: 'poll', status: 'processing', progress: 60 }),
    jsonResponse({ id: 'poll', status: 'done', progress: 100, xmlUrl: '/custom/music.xml' }),
    new Response(XML),
  ];
  const importer = new ScoreImporter({
    pollIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      return responses.shift();
    },
  });

  const { job, xml } = await importer.upload(
    { name: 'scan.pdf', type: 'application/pdf', size: 3 },
    { onProgress: (value) => progress.push(value) },
  );

  assert.equal(job.status, 'done');
  assert.equal(xml, XML);
  assert.deepEqual(progress.map(({ status }) => status), ['queued', 'queued', 'processing', 'done']);
  assert.deepEqual(calls, ['/api/jobs', '/api/jobs/poll', '/api/jobs/poll', '/custom/music.xml']);
});

test('cancel aborts a pending poll delay and prevents later progress', async () => {
  const progress = [];
  let calls = 0;
  const importer = new ScoreImporter({
    pollIntervalMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ id: 'waiting', status: 'processing', progress: 20 });
    },
  });
  const promise = importer.upload(
    { name: 'scan.png', type: 'image/png', size: 3 },
    { onProgress: (value) => progress.push(value) },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  importer.cancel();

  await assert.rejects(promise, abortError);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.deepEqual(progress.map(({ status }) => status), ['queued', 'processing']);
});

test('rapid upload then history open aborts the in-flight poll and ignores its late completion', async () => {
  const oldPoll = deferred();
  const progress = [];
  const calls = [];
  const importer = new ScoreImporter({
    pollIntervalMs: 0,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, signal: options.signal });
      if (url === '/api/jobs') return jsonResponse({ id: 'old', status: 'processing', progress: 10 });
      if (url === '/api/jobs/old') return oldPoll.promise;
      if (url === '/api/jobs/new%2Fhistory') return jsonResponse({ id: 'new/history', status: 'done', xmlUrl: '/new.xml' });
      if (url === '/new.xml') return new Response('<new />');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const upload = importer.upload(
    { name: 'old.jpg', type: 'image/jpeg', size: 3 },
    { onProgress: (value) => progress.push(value) },
  );
  while (!calls.some(({ url }) => url === '/api/jobs/old')) await new Promise((resolve) => setTimeout(resolve, 0));

  const opened = importer.open('new/history');

  await assert.rejects(upload, abortError);
  assert.equal(calls.find(({ url }) => url === '/api/jobs/old').signal.aborted, true);
  oldPoll.resolve(jsonResponse({ id: 'old', status: 'done', progress: 100 }));
  assert.deepEqual(await opened, {
    job: { id: 'new/history', status: 'done', xmlUrl: '/new.xml' },
    xml: '<new />',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(progress.map(({ status }) => status), ['queued', 'processing']);
});

test('a new invalid upload still cancels an in-flight import', async () => {
  const pending = deferred();
  let firstSignal;
  const importer = new ScoreImporter({
    fetchImpl: async (url, options) => {
      firstSignal = options.signal;
      return pending.promise;
    },
  });
  const first = importer.open('old');

  const invalid = importer.upload({ name: 'bad.txt', type: 'text/plain', size: 1 });

  await assert.rejects(first, abortError);
  await assert.rejects(invalid, { message: '请选择 PDF、MusicXML（.musicxml / .xml / .mxl）或 PNG / JPG 乐谱图片。' });
  assert.equal(firstSignal.aborted, true);
});

test('cancellation interrupts XML body reading and stale completion cannot report progress', async () => {
  const body = deferred();
  const progress = [];
  const importer = new ScoreImporter({
    fetchImpl: async (url) => {
      if (url === '/api/jobs/first') return jsonResponse({ id: 'first', status: 'done' });
      if (url === '/api/jobs/first/score.musicxml') return { ok: true, text: () => body.promise };
      if (url === '/api/jobs/second') return jsonResponse({ id: 'second', status: 'done' });
      if (url === '/api/jobs/second/score.musicxml') return new Response('<second />');
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const first = importer.open('first', { onProgress: (value) => progress.push(value) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const second = importer.open('second', { onProgress: (value) => progress.push(value) });

  await assert.rejects(first, abortError);
  body.resolve('<first />');
  assert.equal((await second).xml, '<second />');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(progress.map(({ id }) => id), ['first', 'second']);
});

test('terminal job errors and unfinished history jobs retain existing messages', async () => {
  const errorImporter = new ScoreImporter({
    fetchImpl: async () => jsonResponse({ id: 'failed', status: 'error', message: '识别器失败' }),
  });
  await assert.rejects(
    errorImporter.upload({ name: 'scan.pdf', type: 'application/pdf', size: 3 }),
    { message: '识别器失败' },
  );

  const fallbackImporter = new ScoreImporter({
    fetchImpl: async () => jsonResponse({ id: 'failed', status: 'error' }),
  });
  await assert.rejects(
    fallbackImporter.upload({ name: 'scan.pdf', type: 'application/pdf', size: 3 }),
    { message: '识谱未能完成' },
  );

  const openImporter = new ScoreImporter({
    fetchImpl: async () => jsonResponse({ id: 'queued', status: 'queued' }),
  });
  await assert.rejects(openImporter.open('queued'), { message: '这份乐谱的识别结果尚未就绪。' });
});

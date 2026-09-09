import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createApp, JobStore, MAX_UPLOAD_BYTES } from '../server/app.mjs';
import { createAudiverisEngine, musicXmlFromMxl } from '../server/engine.mjs';

const TEST_PDF = Buffer.from('%PDF-1.7\n% fake test fixture only\n%%EOF');
const TEST_XML = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>';
const PLAYABLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>
</score-partwise>`;
const TEST_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]),
]);
const TEST_JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x02,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);

async function fixture(t, engine) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'score-player-server-'));
  const jobsRoot = path.join(temporary, 'jobs');
  const demoRoot = path.join(temporary, 'demo');
  const app = await createApp({ jobsRoot, demoRoot, engine });
  const server = createServer((request, response) => void app.handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await once(server, 'close');
    await rm(temporary, { recursive: true, force: true });
  });
  return { ...app, base, demoRoot, jobsRoot };
}

async function serve(t, app) {
  const server = createServer((request, response) => void app.handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function writeStoredJob(jobsRoot, directoryId, job, { pdf = TEST_PDF, xml = TEST_XML } = {}) {
  const directory = path.join(jobsRoot, directoryId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'job.json'), typeof job === 'string' ? job : JSON.stringify(job));
  if (pdf !== null) await writeFile(path.join(directory, 'source.pdf'), pdf);
  if (xml !== null) await writeFile(path.join(directory, 'score.musicxml'), xml);
}

function fakeEngine(overrides = {}) {
  return {
    name: 'Audiveris',
    async health() {
      return { available: true, name: 'Audiveris', message: 'test fixture engine' };
    },
    async convert({ onProgress }) {
      onProgress(60, 'test fixture conversion');
      return { xml: TEST_XML };
    },
    ...overrides,
  };
}

function utf16Le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

async function waitFor(base, id, expected = 'done') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    const job = await response.json();
    if (job.status === expected || job.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not finish.`);
}

async function uploadTemporaryFiles(jobsRoot) {
  try {
    return await readdir(path.join(jobsRoot, '.uploads'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

function openUpload(base) {
  const url = new URL('/api/jobs', base);
  const request = httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' },
  });
  request.on('error', () => {});
  request.write('%PDF-');
  return request;
}

test('health exposes the exact engine availability shape', async (t) => {
  const { base } = await fixture(t, fakeEngine());
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    engine: { available: true, name: 'Audiveris', message: 'test fixture engine' },
    demoAvailable: false,
  });
});

test('upload validates content type, PDF magic bytes, and the 50 MB boundary', async (t) => {
  const { base } = await fixture(t, fakeEngine());
  const expectedMaximum = 50 * 1024 * 1024;
  assert.equal(MAX_UPLOAD_BYTES, expectedMaximum);

  const wrongType = await fetch(`${base}/api/jobs`, { method: 'POST', body: TEST_PDF });
  assert.equal(wrongType.status, 415);

  const wrongMagic = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: 'plain text',
  });
  assert.equal(wrongMagic.status, 400);

  const aboveOldLimit = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(21 * 1024 * 1024 - 5)]),
  });
  assert.equal(aboveOldLimit.status, 202);

  const atLimit = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(expectedMaximum - 5)]),
  });
  assert.equal(atLimit.status, 202);

  const tooLarge = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(expectedMaximum - 4)]),
  });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: 'Upload exceeds the 50 MB limit.' });

  const acceptedJobs = await Promise.all([aboveOldLimit.json(), atLimit.json()]);
  const completedJobs = await Promise.all(acceptedJobs.map(({ id }) => waitFor(base, id)));
  assert.deepEqual(completedJobs.map(({ status }) => status), ['done', 'done']);
});

test('a raw PDF job persists, reports progress, and serves XML and the original bytes', async (t) => {
  const { base, jobsRoot } = await fixture(t, fakeEngine());
  const accepted = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf; charset=binary',
      'x-file-name': encodeURIComponent('../四驱小子 betop.pdf'),
    },
    body: TEST_PDF,
  });
  assert.equal(accepted.status, 202);
  const queued = await accepted.json();
  assert.match(queued.id, /^[0-9a-f-]{36}$/);
  assert.ok(['queued', 'processing', 'done'].includes(queued.status));

  const done = await waitFor(base, queued.id);
  assert.deepEqual(done, {
    id: queued.id,
    status: 'done',
    progress: 100,
    message: '识别完成',
    fileName: '四驱小子 betop.pdf',
    sourceType: 'pdf',
    sourceMime: 'application/pdf',
    xmlUrl: `/api/jobs/${queued.id}/score.musicxml`,
    sourceUrl: `/api/jobs/${queued.id}/source`,
    pdfUrl: `/api/jobs/${queued.id}/source.pdf`,
  });

  const xmlResponse = await fetch(`${base}${done.xmlUrl}`);
  assert.equal(xmlResponse.status, 200);
  assert.match(xmlResponse.headers.get('content-type'), /musicxml/);
  assert.equal(await xmlResponse.text(), TEST_XML);

  const pdfResponse = await fetch(`${base}${done.pdfUrl}`);
  assert.equal(pdfResponse.status, 200);
  assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()), TEST_PDF);
  assert.deepEqual(await readFile(path.join(jobsRoot, queued.id, 'source.pdf')), TEST_PDF);
  assert.equal(JSON.parse(await readFile(path.join(jobsRoot, queued.id, 'job.json'))).status, 'done');
});

test('MusicXML imports finish immediately, preserve the original, and survive restart without recognition', async (t) => {
  let conversions = 0;
  const engine = fakeEngine({ async convert() { conversions += 1; return { xml: TEST_XML }; } });
  const { base, jobsRoot, demoRoot } = await fixture(t, engine);
  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/vnd.recordare.musicxml+xml',
      'x-file-name': encodeURIComponent('../夜空中最亮的星.musicxml'),
    },
    body: PLAYABLE_XML,
  });
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.deepEqual(created, {
    id: created.id,
    status: 'done',
    progress: 100,
    message: '导入完成',
    fileName: '夜空中最亮的星.musicxml',
    sourceType: 'musicxml',
    sourceMime: 'application/vnd.recordare.musicxml+xml',
    sourceUrl: `/api/jobs/${created.id}/source`,
    xmlUrl: `/api/jobs/${created.id}/score.musicxml`,
  });
  assert.equal(conversions, 0);

  const job = await fetch(`${base}/api/jobs/${created.id}`).then((item) => item.json());
  assert.deepEqual(job, {
    id: created.id,
    status: 'done',
    progress: 100,
    message: '导入完成',
    fileName: '夜空中最亮的星.musicxml',
    sourceType: 'musicxml',
    sourceMime: 'application/vnd.recordare.musicxml+xml',
    sourceUrl: `/api/jobs/${created.id}/source`,
    xmlUrl: `/api/jobs/${created.id}/score.musicxml`,
  });
  const source = await fetch(`${base}${job.sourceUrl}`);
  assert.equal(source.headers.get('content-type'), 'application/vnd.recordare.musicxml+xml');
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), Buffer.from(PLAYABLE_XML));
  assert.doesNotMatch(await readFile(path.join(jobsRoot, created.id, 'score.musicxml'), 'utf8'), /<!DOCTYPE/i);

  const restarted = await createApp({ jobsRoot, demoRoot, engine });
  const restartedBase = await serve(t, restarted);
  const scores = await fetch(`${restartedBase}/api/scores`).then((item) => item.json());
  assert.equal(conversions, 0);
  assert.equal(scores.scores[0].id, created.id);
  assert.equal(scores.scores[0].sourceType, 'musicxml');
});

test('MXL imports follow the safe container root and accept browser ZIP MIME aliases only for .mxl', async (t) => {
  const { base } = await fixture(t, fakeEngine());
  const mxl = zipSync({
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>'),
    'scores/main.musicxml': strToU8(PLAYABLE_XML),
    'ignored.xml': strToU8('<ignored/>'),
  });
  const accepted = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': 'score.mxl' },
    body: mxl,
  });
  assert.equal(accepted.status, 202);
  const imported = await accepted.json();
  assert.equal(imported.status, 'done');
  assert.equal(imported.sourceType, 'musicxml');
  assert.equal(imported.sourceMime, 'application/vnd.recordare.musicxml');
  assert.equal(imported.sourceUrl, `/api/jobs/${imported.id}/source`);

  const bareZip = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-file-name': 'score.zip' }, body: mxl,
  });
  assert.equal(bareZip.status, 415);

  const traversal = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
    'score.musicxml': strToU8(PLAYABLE_XML),
    '../outside.txt': strToU8('unsafe'),
  });
  const unsafe = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/vnd.recordare.musicxml', 'x-file-name': 'unsafe.mxl' }, body: traversal,
  });
  assert.equal(unsafe.status, 400);
  assert.match((await unsafe.json()).error, /unsafe path/i);
});

test('image imports validate MIME and magic bytes, preserve originals, and pass images directly to recognition', async (t) => {
  const conversions = [];
  const engine = fakeEngine({
    async convert(options) {
      conversions.push(options);
      return { xml: TEST_XML };
    },
  });
  const { base, jobsRoot, demoRoot } = await fixture(t, engine);
  for (const [fileName, mime, bytes] of [
    ['page.png', 'image/png', TEST_PNG],
    ['page.jpeg', 'image/jpeg', TEST_JPEG],
  ]) {
    const accepted = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': mime, 'x-file-name': fileName }, body: bytes,
    });
    assert.equal(accepted.status, 202);
    const created = await accepted.json();
    const done = await waitFor(base, created.id);
    assert.equal(done.sourceType, 'image');
    assert.equal(done.sourceMime, mime);
    const source = await fetch(`${base}${done.sourceUrl}`);
    assert.equal(source.headers.get('content-type'), mime);
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), bytes);
  }
  assert.deepEqual(conversions.map(({ sourceType }) => sourceType), ['image', 'image']);
  assert.ok(conversions.every(({ inputPath }) => /source\.(?:png|jpg)$/.test(inputPath)));

  const restarted = await createApp({ jobsRoot, demoRoot, engine });
  const restartedBase = await serve(t, restarted);
  const restartedScores = await fetch(`${restartedBase}/api/scores`).then((response) => response.json());
  assert.deepEqual(restartedScores.scores.map(({ sourceType }) => sourceType), ['image', 'image']);
  assert.equal(conversions.length, 2);

  const wrongMagic = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'fake.png' }, body: TEST_JPEG,
  });
  assert.equal(wrongMagic.status, 400);
  assert.match((await wrongMagic.json()).error, /PNG/);

  const hugePng = Buffer.from(TEST_PNG);
  hugePng.writeUInt32BE(20_000, 16);
  hugePng.writeUInt32BE(20_000, 20);
  const hugeImage = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': 'huge.png' }, body: hugePng,
  });
  assert.equal(hugeImage.status, 400);
  assert.match((await hugeImage.json()).error, /100 megapixel/);

  const mismatchedType = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-file-name': 'fake.png' }, body: TEST_PNG,
  });
  assert.equal(mismatchedType.status, 415);
});

test('MusicXML rejects entity declarations, internal DTD subsets, and scores without playable notes', async (t) => {
  const { base } = await fixture(t, fakeEngine());
  for (const xml of [
    '<?xml version="1.0"?><!DOCTYPE score-partwise [<!ENTITY x "x">]><score-partwise>&x;</score-partwise>',
    TEST_XML,
    PLAYABLE_XML.replace('</note></measure>', '</measure></note>'),
    PLAYABLE_XML.replace('</note></measure>', '</note></oops></measure>'),
    PLAYABLE_XML.replace('<part-name>Piano</part-name>', '<part-name value="bad<value">Piano</part-name>'),
    `junk${PLAYABLE_XML}`,
    PLAYABLE_XML.replace('<score-partwise', '<!-- bad -- comment --><score-partwise'),
  ]) {
    const response = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/xml', 'x-file-name': 'bad.xml' }, body: xml,
    });
    assert.equal(response.status, 400);
  }
});

test('UTF-16 MusicXML and MXL preserve source bytes while storing UTF-8 playable output', async (t) => {
  const { base } = await fixture(t, fakeEngine());
  const utf16Score = utf16Le(PLAYABLE_XML.replace('encoding="UTF-8"', 'encoding="UTF-16"'));
  const uploads = [
    {
      name: 'utf16.musicxml',
      mime: 'application/vnd.recordare.musicxml+xml',
      body: utf16Score,
    },
    {
      name: 'utf16.mxl',
      mime: 'application/vnd.recordare.musicxml',
      body: zipSync({
        'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
        'score.musicxml': new Uint8Array(utf16Score),
      }),
    },
  ];

  for (const upload of uploads) {
    const response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': upload.mime, 'x-file-name': upload.name },
      body: upload.body,
    });
    assert.equal(response.status, 202);
    const job = await response.json();
    const source = Buffer.from(await fetch(`${base}${job.sourceUrl}`).then((item) => item.arrayBuffer()));
    assert.deepEqual(source, Buffer.from(upload.body));
    const output = Buffer.from(await fetch(`${base}${job.xmlUrl}`).then((item) => item.arrayBuffer()));
    assert.equal(output.subarray(0, 3).toString(), '<?x');
    assert.match(output.toString('utf8'), /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.doesNotMatch(output.toString('utf8'), /encoding="UTF-16"/i);
  }
});

test('score listing returns only complete local imports newest first without exposing storage metadata', async (t) => {
  const { base, jobsRoot } = await fixture(t, fakeEngine());
  const oldId = '11111111-1111-4111-8111-111111111111';
  const newId = '22222222-2222-4222-8222-222222222222';
  const done = (id, fileName, dates = {}) => ({
    id, status: 'done', progress: 100, message: '识别完成', fileName, warnings: ['校对提示'],
    serverPath: '/private/jobs/secret', ...dates,
  });
  await writeStoredJob(jobsRoot, oldId, done(oldId, 'old.pdf', {
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z',
  }));
  await writeStoredJob(jobsRoot, newId, done(newId, 'new.pdf', {
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
  }));
  await writeStoredJob(jobsRoot, 'mismatch', done('different-id', 'mismatch.pdf'));
  await writeStoredJob(jobsRoot, 'error-job', { id: 'error-job', status: 'error' });
  await writeStoredJob(jobsRoot, 'queued-job', { id: 'queued-job', status: 'queued' });
  await writeStoredJob(jobsRoot, 'processing-job', { id: 'processing-job', status: 'processing' });
  await writeStoredJob(jobsRoot, 'missing-pdf', done('missing-pdf', 'missing.pdf'), { pdf: null });
  await writeStoredJob(jobsRoot, 'empty-xml', done('empty-xml', 'empty.xml.pdf'), { xml: '' });
  await writeStoredJob(jobsRoot, 'malformed', '{broken json');
  await writeStoredJob(jobsRoot, 'demo', done('demo', 'demo.pdf'));

  const response = await fetch(`${base}/api/scores`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scores: [
    {
      id: newId, status: 'done', progress: 100, message: '识别完成', fileName: 'new.pdf',
      sourceType: 'pdf', sourceMime: 'application/pdf', sourceUrl: `/api/jobs/${newId}/source`,
      xmlUrl: `/api/jobs/${newId}/score.musicxml`, pdfUrl: `/api/jobs/${newId}/source.pdf`,
      warnings: ['校对提示'], createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: oldId, status: 'done', progress: 100, message: '识别完成', fileName: 'old.pdf',
      sourceType: 'pdf', sourceMime: 'application/pdf', sourceUrl: `/api/jobs/${oldId}/source`,
      xmlUrl: `/api/jobs/${oldId}/score.musicxml`, pdfUrl: `/api/jobs/${oldId}/source.pdf`,
      warnings: ['校对提示'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z',
    },
  ] });
});

test('completed imports remain listed after app restart without re-running conversion', async (t) => {
  let conversions = 0;
  const engine = fakeEngine({
    async convert() {
      conversions += 1;
      return { xml: TEST_XML };
    },
  });
  const { base, jobsRoot, demoRoot } = await fixture(t, engine);
  const accepted = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: TEST_PDF,
  }).then((response) => response.json());
  await waitFor(base, accepted.id);
  assert.equal(conversions, 1);

  const restarted = await createApp({ jobsRoot, demoRoot, engine });
  const restartedBase = await serve(t, restarted);
  const scores = await fetch(`${restartedBase}/api/scores`).then((response) => response.json());
  assert.equal(conversions, 1);
  assert.equal(scores.scores.length, 1);
  assert.equal(scores.scores[0].id, accepted.id);
});

test('the job queue never invokes more than one engine conversion concurrently', async (t) => {
  let active = 0;
  let maximum = 0;
  const engine = fakeEngine({
    async convert() {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { xml: TEST_XML };
    },
  });
  const { base } = await fixture(t, engine);
  const request = () => fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: TEST_PDF,
  }).then((response) => response.json());
  const [first, second] = await Promise.all([request(), request()]);
  await Promise.all([waitFor(base, first.id), waitFor(base, second.id)]);
  assert.equal(maximum, 1);
});

test('job progress persistence is serialized in callback order', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'score-player-queue-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const id = 'serialized-job';
  const directory = path.join(temporary, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'source.pdf'), TEST_PDF);

  let active = 0;
  let maximum = 0;
  const snapshots = [];
  const store = new JobStore({
    root: temporary,
    demoRoot: path.join(temporary, 'demo'),
    engine: fakeEngine({
      async convert({ onProgress }) {
        onProgress(30, 'first progress');
        onProgress(70, 'second progress');
        return { xml: TEST_XML };
      },
    }),
    async persist(_file, snapshot) {
      active += 1;
      maximum = Math.max(maximum, active);
      snapshots.push({ status: snapshot.status, progress: snapshot.progress, message: snapshot.message });
      await new Promise((resolve) => setTimeout(resolve, snapshot.progress === 30 ? 15 : 1));
      active -= 1;
    },
  });
  store.jobs.set(id, {
    id, status: 'queued', progress: 5, message: 'queued', fileName: 'score.pdf', warnings: [],
  });
  store.queue.push(id);

  await store.drain();

  assert.equal(maximum, 1);
  assert.deepEqual(snapshots.map(({ status, progress }) => [status, progress]), [
    ['processing', 10],
    ['processing', 30],
    ['processing', 70],
    ['done', 100],
  ]);
});

test('queue load and persistence failures are isolated and never leave processing wedged', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'score-player-queue-failures-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const ids = ['load-fails', 'start-save-fails', 'finish-save-fails', 'later-job'];
  for (const id of ids.slice(1)) {
    const directory = path.join(temporary, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'source.pdf'), TEST_PDF);
  }

  const conversions = [];
  const failures = new Set();
  const store = new JobStore({
    root: temporary,
    demoRoot: path.join(temporary, 'demo'),
    engine: fakeEngine({
      async convert({ inputPath }) {
        conversions.push(path.basename(path.dirname(inputPath)));
        return { xml: TEST_XML };
      },
    }),
    async persist(_file, snapshot) {
      const key = `${snapshot.id}:${snapshot.status}`;
      if ((key === 'start-save-fails:processing' || key === 'finish-save-fails:done') && !failures.has(key)) {
        failures.add(key);
        throw new Error(`fixture ${key}`);
      }
    },
  });
  for (const id of ids.slice(1)) {
    store.jobs.set(id, { id, status: 'queued', progress: 5, message: 'queued', fileName: `${id}.pdf`, warnings: [] });
  }
  const originalLoad = store.load.bind(store);
  store.load = async (id) => {
    if (id === 'load-fails') throw new Error('fixture load failure');
    return originalLoad(id);
  };
  store.queue.push(...ids);

  await assert.doesNotReject(store.drain());

  assert.equal(store.processing, false);
  assert.deepEqual(store.queue, []);
  assert.deepEqual(conversions, ['finish-save-fails', 'later-job']);
  assert.equal(store.jobs.get('start-save-fails').status, 'error');
  assert.equal(store.jobs.get('finish-save-fails').status, 'error');
  assert.equal(store.jobs.get('later-job').status, 'done');

  store.queue.push('later-job');
  await assert.doesNotReject(store.drain());
  assert.equal(store.processing, false);
  assert.deepEqual(conversions, ['finish-save-fails', 'later-job', 'later-job']);
});

test('uploads are limited to two simultaneous receives and reject excess work with Retry-After', async (t) => {
  const { base, jobsRoot } = await fixture(t, fakeEngine());
  const first = openUpload(base);
  const second = openUpload(base);
  t.after(() => {
    first.destroy();
    second.destroy();
  });

  for (let attempt = 0; attempt < 50 && (await uploadTemporaryFiles(jobsRoot)).length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await uploadTemporaryFiles(jobsRoot)).length, 2);

  const busy = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: TEST_PDF,
  });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.match((await busy.json()).error, /busy/i);

  first.destroy();
  second.destroy();
  for (let attempt = 0; attempt < 50 && (await uploadTemporaryFiles(jobsRoot)).length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await uploadTemporaryFiles(jobsRoot), []);
});

test('streamed uploads clean temporary files after invalid input, oversize, abort, and create failure', async (t) => {
  const { base, jobsRoot, store } = await fixture(t, fakeEngine());

  const invalid = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: 'not a PDF',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await uploadTemporaryFiles(jobsRoot), []);

  const oversized = httpRequest(new URL('/api/jobs', base), {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' },
  });
  const oversizedResponse = once(oversized, 'response').then(([response]) => response);
  oversized.write(Buffer.from('%PDF-'));
  const chunk = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < 50; index += 1) oversized.write(chunk);
  oversized.end(Buffer.from('x'));
  const rejected = await oversizedResponse;
  assert.equal(rejected.statusCode, 413);
  assert.deepEqual(await uploadTemporaryFiles(jobsRoot), []);

  const aborted = openUpload(base);
  for (let attempt = 0; attempt < 50 && !(await uploadTemporaryFiles(jobsRoot)).length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  aborted.destroy();
  for (let attempt = 0; attempt < 50 && (await uploadTemporaryFiles(jobsRoot)).length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await uploadTemporaryFiles(jobsRoot), []);

  store.persist = async () => { throw new Error('fixture create failure'); };
  const createFailure = await fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/pdf' }, body: TEST_PDF,
  });
  assert.equal(createFailure.status, 500);
  assert.deepEqual(await uploadTemporaryFiles(jobsRoot), []);
  assert.deepEqual((await readdir(jobsRoot)).filter((name) => name !== '.uploads'), []);
});

test('engine failures are surfaced as job errors and output stays unavailable', async (t) => {
  const engine = fakeEngine({
    async convert() {
      throw new Error('fixture engine unavailable');
    },
  });
  const { base } = await fixture(t, engine);
  const accepted = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: TEST_PDF,
  }).then((response) => response.json());
  const failed = await waitFor(base, accepted.id, 'error');
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /fixture engine unavailable/);
  assert.equal((await fetch(`${base}/api/jobs/${accepted.id}/score.musicxml`)).status, 409);
});

test('demo endpoint serves only prepared real-job metadata', async (t) => {
  const { base, demoRoot } = await fixture(t, fakeEngine());
  assert.equal((await fetch(`${base}/api/demo`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`).then((response) => response.json())).demoAvailable, false);

  await writeFile(path.join(demoRoot, 'job.json'), JSON.stringify({
    id: 'demo',
    status: 'done',
    progress: 100,
    message: 'prepared test fixture',
    fileName: 'fixture.pdf',
  }));
  const response = await fetch(`${base}/api/demo`);
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/api/health`).then((response) => response.json())).demoAvailable, true);
  assert.deepEqual(await response.json(), {
    id: 'demo',
    status: 'done',
    progress: 100,
    message: 'prepared test fixture',
    fileName: 'fixture.pdf',
    sourceType: 'pdf',
    sourceMime: 'application/pdf',
    xmlUrl: '/api/jobs/demo/score.musicxml',
    sourceUrl: '/api/jobs/demo/source',
    pdfUrl: '/api/jobs/demo/source.pdf',
  });
});

test('MXL extraction follows META-INF/container.xml', () => {
  const mxl = zipSync({
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>'),
    'scores/main.musicxml': strToU8(TEST_XML),
    'ignored.xml': strToU8('<ignored/>'),
  });
  assert.equal(musicXmlFromMxl(mxl), TEST_XML);
});

test('MXL extraction rejects forged expansion sizes and encrypted entries before decompression', () => {
  const archive = Buffer.from(zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
    'score.musicxml': strToU8(PLAYABLE_XML),
  }));
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

  const oversized = Buffer.from(archive);
  const firstCentral = oversized.indexOf(centralSignature);
  oversized.writeUInt32LE(64 * 1024 * 1024 + 1, firstCentral + 24);
  assert.throws(() => musicXmlFromMxl(oversized), (error) => error.statusCode === 413);

  const encrypted = Buffer.from(archive);
  const encryptedCentral = encrypted.indexOf(centralSignature);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 1, encryptedCentral + 8);
  assert.throws(() => musicXmlFromMxl(encrypted), /Encrypted MXL entries/);

  const tooMany = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`extra-${index}.txt`, strToU8('x')]));
  tooMany['META-INF/container.xml'] = strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>');
  tooMany['score.musicxml'] = strToU8(PLAYABLE_XML);
  assert.throws(() => musicXmlFromMxl(zipSync(tooMany)), /1-256 bounded entries/);
});

test('MXL extraction rejects malformed container XML and the wrong container hierarchy', () => {
  const mxl = (container) => zipSync({
    'META-INF/container.xml': strToU8(container),
    'score.musicxml': strToU8(PLAYABLE_XML),
  });
  assert.throws(
    () => musicXmlFromMxl(mxl('<evil><rootfile full-path="score.musicxml"/></evil>')),
    /container document/i,
  );
  assert.throws(
    () => musicXmlFromMxl(mxl('<container><rootfiles><rootfile full-path="score.musicxml"/></container>')),
    /container\.xml is malformed/i,
  );
  assert.throws(
    () => musicXmlFromMxl(mxl('<container><rootfiles><rootfile full-path="score.musicxml"></rootfiles></rootfile></container>')),
    /container\.xml is malformed/i,
  );
  assert.throws(
    () => musicXmlFromMxl(mxl('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></oops></container>')),
    /container\.xml is malformed/i,
  );
  assert.throws(
    () => musicXmlFromMxl(mxl('<container><rootfiles><rootfile full-path="bad<path"/></rootfiles></container>')),
    /container\.xml is malformed/i,
  );
});

test('Audiveris receives a resampled 300 DPI image and preserves the original source', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'score-player-engine-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'fake-audiveris');
  const inputPath = path.join(temporary, 'source.png');
  const outputDir = path.join(temporary, 'output');
  await mkdir(outputDir);
  const image = spawnSync(process.env.PYTHON_BIN || 'python3', ['-c',
    'from PIL import Image; import sys; Image.new("RGB", (400, 600), "white").save(sys.argv[1], dpi=(150,150))', inputPath]);
  assert.equal(image.status, 0, image.stderr?.toString());
  const original = await readFile(inputPath);
  await writeFile(`${inputPath}.mxl`, zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
    'score.musicxml': strToU8(PLAYABLE_XML),
  }));
  await writeFile(executable, `#!/bin/sh
printf '%s' "$7" > "$5/recognition-input.txt"
cp "$5/../source.png.mxl" "$5/result.mxl"
`);
  await chmod(executable, 0o755);

  const engine = createAudiverisEngine({ executable });
  const result = await engine.convert({ inputPath, outputDir, sourceType: 'image' });
  const recognitionInput = await readFile(path.join(outputDir, 'recognition-input.txt'), 'utf8');
  assert.notEqual(recognitionInput, inputPath);
  assert.match(recognitionInput, /\.render-.*[/\\]score\.png$/);
  const preprocessing = JSON.parse(await readFile(path.join(outputDir, 'preprocess.json'), 'utf8'));
  assert.deepEqual(preprocessing.sourceSize, [400, 600]);
  assert.deepEqual(preprocessing.outputSize, [800, 1200]);
  assert.deepEqual(preprocessing.outputDpi, [300, 300]);
  assert.equal(preprocessing.resized, true);
  assert.deepEqual(await readFile(inputPath), original);
  assert.equal((await readdir(outputDir)).some((name) => name.startsWith('.render-')), false);
  assert.match(result.xml, /<score-partwise/);
  assert.match(result.xml, /<note>/);
  assert.deepEqual(result.warnings, []);

  const noOutputExecutable = path.join(temporary, 'fake-audiveris-no-output');
  await writeFile(noOutputExecutable, '#!/bin/sh\nexit 0\n');
  await chmod(noOutputExecutable, 0o755);
  const noOutput = createAudiverisEngine({ executable: noOutputExecutable });
  const emptyOutputDir = path.join(temporary, 'empty-output');
  await mkdir(emptyOutputDir);
  await assert.rejects(
    noOutput.convert({ inputPath, outputDir: emptyOutputDir, sourceType: 'image' }),
    (error) => /图片完整且包含清晰的五线谱/.test(error.publicMessage),
  );
  assert.equal((await readdir(emptyOutputDir)).some((name) => name.startsWith('.render-')), false);

  await writeFile(`${inputPath}.mxl`, zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
    'score.musicxml': strToU8(TEST_XML),
  }));
  const invalidOutputDir = path.join(temporary, 'invalid-output');
  await mkdir(invalidOutputDir);
  await assert.rejects(
    engine.convert({ inputPath, outputDir: invalidOutputDir, sourceType: 'image' }),
    (error) => /没有生成包含可播放音符的有效乐谱/.test(error.publicMessage),
  );
});

test('missing image preprocessing tools falls back explicitly without losing the source', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'score-player-preprocess-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const executable = path.join(temporary, 'fake-audiveris');
  const inputPath = path.join(temporary, 'source.png');
  const outputDir = path.join(temporary, 'output');
  await mkdir(outputDir);
  await writeFile(inputPath, TEST_PNG);
  await writeFile(path.join(temporary, 'fixture.mxl'), zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>'),
    'score.musicxml': strToU8(PLAYABLE_XML),
  }));
  await writeFile(executable, `#!/bin/sh
printf '%s' "$7" > "$5/recognition-input.txt"
cp "$5/../fixture.mxl" "$5/result.mxl"
`);
  await chmod(executable, 0o755);
  const engine = createAudiverisEngine({ executable, pythonExecutable: path.join(temporary, 'missing-python') });
  const result = await engine.convert({ inputPath, outputDir, sourceType: 'image' });
  assert.equal(await readFile(path.join(outputDir, 'recognition-input.txt'), 'utf8'), inputPath);
  assert.ok(result.warnings.some((warning) => /300 DPI.*原图/.test(warning)));

  const failingPython = path.join(temporary, 'failing-python');
  await writeFile(failingPython, '#!/bin/sh\nprintf "Pillow unavailable\\n" >&2\nexit 1\n');
  await chmod(failingPython, 0o755);
  const failedOutput = path.join(temporary, 'failed-output');
  await mkdir(failedOutput);
  const failedPreparation = await createAudiverisEngine({ executable, pythonExecutable: failingPython })
    .convert({ inputPath, outputDir: failedOutput, sourceType: 'image' });
  assert.ok(failedPreparation.warnings.some((warning) => /预处理失败.*原图/.test(warning)));
  assert.match(await readFile(path.join(failedOutput, 'preprocess.log'), 'utf8'), /Pillow unavailable/);
  assert.equal((await readdir(failedOutput)).some((name) => name.startsWith('.render-')), false);
});

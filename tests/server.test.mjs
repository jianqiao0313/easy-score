import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createApp, MAX_UPLOAD_BYTES } from '../server/app.mjs';
import { musicXmlFromMxl } from '../server/engine.mjs';

const TEST_PDF = Buffer.from('%PDF-1.7\n% fake test fixture only\n%%EOF');
const TEST_XML = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>';

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

async function waitFor(base, id, expected = 'done') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    const job = await response.json();
    if (job.status === expected || job.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${id} did not finish.`);
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

test('upload validates content type, PDF magic bytes, and the 20 MB boundary', async (t) => {
  const { base } = await fixture(t, fakeEngine());

  const wrongType = await fetch(`${base}/api/jobs`, { method: 'POST', body: TEST_PDF });
  assert.equal(wrongType.status, 415);

  const wrongMagic = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: 'plain text',
  });
  assert.equal(wrongMagic.status, 400);

  const tooLarge = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_UPLOAD_BYTES)]),
  });
  assert.equal(tooLarge.status, 413);
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
    xmlUrl: `/api/jobs/${queued.id}/score.musicxml`,
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
      xmlUrl: `/api/jobs/${newId}/score.musicxml`, pdfUrl: `/api/jobs/${newId}/source.pdf`,
      warnings: ['校对提示'], createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: oldId, status: 'done', progress: 100, message: '识别完成', fileName: 'old.pdf',
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
    xmlUrl: '/api/jobs/demo/score.musicxml',
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

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAudiverisEngine } from './engine.mjs';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function error(response, status, message) {
  json(response, status, { error: message });
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

async function readBody(request, maximum) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) {
    const failure = new Error(`PDF exceeds the ${maximum / 1024 / 1024} MB upload limit.`);
    failure.statusCode = 413;
    throw failure;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) {
      const failure = new Error(`PDF exceeds the ${maximum / 1024 / 1024} MB upload limit.`);
      failure.statusCode = 413;
      throw failure;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFileName(header) {
  if (!header) return 'score.pdf';
  let decoded;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    const failure = new Error('X-File-Name must be valid percent-encoded text.');
    failure.statusCode = 400;
    throw failure;
  }
  const fileName = path.basename(decoded.replaceAll('\\', '/')).trim();
  return fileName || 'score.pdf';
}

function publicJob(job) {
  const result = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    fileName: job.fileName,
  };
  if (job.status === 'done') {
    result.xmlUrl = `/api/jobs/${job.id}/score.musicxml`;
    result.pdfUrl = `/api/jobs/${job.id}/source.pdf`;
  }
  if (job.warnings?.length) result.warnings = job.warnings;
  return result;
}

export class JobStore {
  constructor({ root, demoRoot, engine = createAudiverisEngine() }) {
    this.root = root;
    this.demoRoot = demoRoot;
    this.engine = engine;
    this.jobs = new Map();
    this.saves = new Map();
    this.queue = [];
    this.processing = false;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.demoRoot, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = await this.load(entry.name);
      if (!job || !['queued', 'processing'].includes(job.status)) continue;
      job.status = 'queued';
      job.progress = 5;
      job.message = '服务重启后重新排队';
      await this.save(job);
      this.queue.push(job.id);
    }
    if (this.queue.length) void this.drain();
  }

  directory(id) {
    return id === 'demo' ? this.demoRoot : path.join(this.root, id);
  }

  async load(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    try {
      const stored = JSON.parse(await readFile(path.join(this.directory(id), 'job.json'), 'utf8'));
      this.jobs.set(id, stored);
      return stored;
    } catch (cause) {
      if (cause.code === 'ENOENT' || cause instanceof SyntaxError) return null;
      throw cause;
    }
  }

  async save(job) {
    this.jobs.set(job.id, job);
    const snapshot = structuredClone(job);
    const previous = this.saves.get(job.id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() =>
      atomicJson(path.join(this.directory(job.id), 'job.json'), snapshot));
    this.saves.set(job.id, pending);
    await pending;
  }

  async create(fileName, pdf) {
    const id = randomUUID();
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'source.pdf'), pdf);
    const job = {
      id,
      status: 'queued',
      progress: 5,
      message: '等待识别引擎',
      fileName,
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    await this.save(job);
    this.queue.push(id);
    void this.drain();
    return job;
  }

  async drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const id = this.queue.shift();
      const job = await this.load(id);
      if (!job) continue;
      const directory = this.directory(id);
      job.status = 'processing';
      job.progress = 10;
      job.message = 'Audiveris 正在分析乐谱';
      await this.save(job);
      try {
        const result = await this.engine.convert({
          inputPath: path.join(directory, 'source.pdf'),
          outputDir: directory,
          onProgress: (progress, message) => {
            job.progress = Math.max(job.progress, Math.min(95, progress));
            job.message = message || 'Audiveris 正在分析乐谱';
            void this.save(job).catch(() => {});
          },
        });
        await writeFile(path.join(directory, 'score.musicxml'), result.xml);
        if (result.warnings?.length) job.warnings.push(...result.warnings);
        job.status = 'done';
        job.progress = 100;
        job.message = '识别完成';
      } catch (cause) {
        job.status = 'error';
        job.progress = Math.max(job.progress, 10);
        job.message = cause?.publicMessage || (cause instanceof Error ? cause.message : String(cause));
      }
      job.updatedAt = new Date().toISOString();
      await this.save(job);
    }
    this.processing = false;
  }
}

async function sendFile(response, file, contentType, downloadName) {
  let metadata;
  try {
    metadata = await stat(file);
  } catch (cause) {
    if (cause.code === 'ENOENT') return error(response, 404, 'File not found.');
    throw cause;
  }
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': metadata.size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  });
  if (response.req?.method === 'HEAD') return response.end();
  createReadStream(file).pipe(response);
}

export async function createApp({
  jobsRoot = path.resolve(process.env.DATA_DIR || '.local', 'jobs'),
  demoRoot = path.resolve(process.env.DATA_DIR || '.local', 'demo'),
  engine = createAudiverisEngine(),
  fallback,
} = {}) {
  const store = new JobStore({ root: jobsRoot, demoRoot, engine });
  await store.initialize();

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const demo = await store.load('demo');
        return json(response, 200, { ok: true, engine: await engine.health(), demoAvailable: demo?.status === 'done' });
      }
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        if ((request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/pdf') {
          return error(response, 415, 'Content-Type must be application/pdf.');
        }
        const body = await readBody(request, MAX_UPLOAD_BYTES);
        if (body.length < 5 || body.subarray(0, 5).toString('ascii') !== '%PDF-') {
          return error(response, 400, 'Uploaded content is not a PDF file.');
        }
        const job = await store.create(safeFileName(request.headers['x-file-name']), body);
        return json(response, 202, { id: job.id, status: job.status, message: job.message });
      }
      if (request.method === 'GET' && url.pathname === '/api/demo') {
        const job = await store.load('demo');
        if (!job) return error(response, 404, 'The real PDF demo has not been prepared yet.');
        return json(response, 200, publicJob(job));
      }

      const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(score\.musicxml|source\.pdf))?$/);
      if (request.method === 'GET' && match) {
        const id = match[1];
        const job = await store.load(id);
        if (!job) return error(response, 404, 'Job not found.');
        if (!match[2]) return json(response, 200, publicJob(job));
        if (job.status !== 'done') return error(response, 409, 'Job output is not ready.');
        if (match[2] === 'score.musicxml') {
          return sendFile(response, path.join(store.directory(id), 'score.musicxml'), 'application/vnd.recordare.musicxml+xml; charset=utf-8', `${path.parse(job.fileName).name}.musicxml`);
        }
        return sendFile(response, path.join(store.directory(id), 'source.pdf'), 'application/pdf', job.fileName);
      }

      if (url.pathname.startsWith('/api/')) return error(response, 404, 'API route not found.');
      if (fallback) return fallback(request, response);
      return error(response, 404, 'Not found.');
    } catch (cause) {
      if (!response.headersSent) error(response, cause.statusCode || 500, cause.message || 'Internal server error.');
      else response.destroy(cause);
    }
  };

  return { handler, store };
}

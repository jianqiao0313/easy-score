import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAudiverisEngine } from './engine.mjs';
import { resolveUploadFormat, validateUpload } from './imports.mjs';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

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
    const failure = new Error(`Upload exceeds the ${maximum / 1024 / 1024} MB limit.`);
    failure.statusCode = 413;
    throw failure;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) {
      const failure = new Error(`Upload exceeds the ${maximum / 1024 / 1024} MB limit.`);
      failure.statusCode = 413;
      throw failure;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFileName(header) {
  if (!header) return '';
  let decoded;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    const failure = new Error('X-File-Name must be valid percent-encoded text.');
    failure.statusCode = 400;
    throw failure;
  }
  const fileName = path.basename(decoded.replaceAll('\\', '/')).trim();
  return fileName;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sourceType(job) {
  return job.sourceType || 'pdf';
}

function sourceMime(job) {
  return job.sourceMime || 'application/pdf';
}

function sourceFile(job) {
  return job.sourceFile || 'source.pdf';
}

function publicJob(job, { includeTimestamps = false } = {}) {
  const result = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    fileName: job.fileName,
    sourceType: sourceType(job),
    sourceMime: sourceMime(job),
  };
  if (job.status === 'done') {
    result.xmlUrl = `/api/jobs/${job.id}/score.musicxml`;
    result.sourceUrl = `/api/jobs/${job.id}/source`;
    if (sourceType(job) === 'pdf') result.pdfUrl = `/api/jobs/${job.id}/source.pdf`;
  }
  if (job.warnings?.length) result.warnings = job.warnings;
  if (includeTimestamps && validTimestamp(job.createdAt)) result.createdAt = job.createdAt;
  if (includeTimestamps && validTimestamp(job.updatedAt)) result.updatedAt = job.updatedAt;
  return result;
}

function isCompleteJobMetadata(job, directoryId) {
  return job
    && !Array.isArray(job)
    && job.id === directoryId
    && SAFE_JOB_ID.test(directoryId)
    && job.status === 'done'
    && Number.isFinite(job.progress)
    && typeof job.message === 'string'
    && typeof job.fileName === 'string'
    && job.fileName.trim().length > 0
    && (job.warnings === undefined
      || (Array.isArray(job.warnings) && job.warnings.every((warning) => typeof warning === 'string')));
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
      if (!job || job.id !== entry.name || !SAFE_JOB_ID.test(entry.name)
        || !['queued', 'processing'].includes(job.status)) continue;
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

  async create({ fileName, format, body, scoreXml = null }) {
    const id = randomUUID();
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, format.sourceFile), body);
    if (scoreXml !== null) await writeFile(path.join(directory, 'score.musicxml'), scoreXml);
    const job = {
      id,
      status: scoreXml === null ? 'queued' : 'done',
      progress: scoreXml === null ? 5 : 100,
      message: scoreXml === null ? '等待识别引擎' : '导入完成',
      fileName,
      sourceType: format.sourceType,
      sourceMime: format.sourceMime,
      sourceFile: format.sourceFile,
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    if (scoreXml !== null) job.updatedAt = job.createdAt;
    await this.save(job);
    if (scoreXml === null) {
      this.queue.push(id);
      void this.drain();
    }
    return job;
  }

  async listScores() {
    const entries = await readdir(this.root, { withFileTypes: true });
    const candidates = await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === 'demo' || !SAFE_JOB_ID.test(entry.name)) return null;
      const directory = path.join(this.root, entry.name);
      try {
        const metadataPath = path.join(directory, 'job.json');
        const job = await readFile(metadataPath, 'utf8').then(JSON.parse);
        const [metadata, source, xml] = await Promise.all([
          stat(metadataPath),
          stat(path.join(directory, sourceFile(job))),
          stat(path.join(directory, 'score.musicxml')),
        ]);
        if (!isCompleteJobMetadata(job, entry.name)
          || !source.isFile() || source.size === 0
          || !xml.isFile() || xml.size === 0) return null;
        const newestTimestamp = validTimestamp(job.createdAt)
          ? Date.parse(job.createdAt)
          : validTimestamp(job.updatedAt) ? Date.parse(job.updatedAt) : metadata.mtimeMs;
        return { job, newestTimestamp };
      } catch {
        return null;
      }
    }));

    return candidates
      .filter(Boolean)
      .sort((left, right) => right.newestTimestamp - left.newestTimestamp
        || left.job.id.localeCompare(right.job.id))
      .map(({ job }) => publicJob(job, { includeTimestamps: true }));
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
          inputPath: path.join(directory, sourceFile(job)),
          outputDir: directory,
          sourceType: sourceType(job),
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
        const hasFileName = Boolean(request.headers['x-file-name']);
        const requestedFileName = safeFileName(request.headers['x-file-name']);
        const format = resolveUploadFormat(request.headers['content-type'], requestedFileName, hasFileName);
        const fileName = requestedFileName || `score${path.extname(format.sourceFile)}`;
        const body = await readBody(request, MAX_UPLOAD_BYTES);
        const { scoreXml } = validateUpload(format, body);
        const job = await store.create({ fileName, format, body, scoreXml });
        return json(response, 202, publicJob(job));
      }
      if (request.method === 'GET' && url.pathname === '/api/scores') {
        return json(response, 200, { scores: await store.listScores() });
      }
      if (request.method === 'GET' && url.pathname === '/api/demo') {
        const job = await store.load('demo');
        if (!job) return error(response, 404, 'The real PDF demo has not been prepared yet.');
        return json(response, 200, publicJob(job));
      }

      const match = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(score\.musicxml|source|source\.pdf))?$/);
      if (request.method === 'GET' && match) {
        const id = match[1];
        const job = await store.load(id);
        if (!job) return error(response, 404, 'Job not found.');
        if (!match[2]) return json(response, 200, publicJob(job));
        if (job.status !== 'done') return error(response, 409, 'Job output is not ready.');
        if (match[2] === 'score.musicxml') {
          return sendFile(response, path.join(store.directory(id), 'score.musicxml'), 'application/vnd.recordare.musicxml+xml; charset=utf-8', `${path.parse(job.fileName).name}.musicxml`);
        }
        if (match[2] === 'source.pdf' && sourceType(job) !== 'pdf') return error(response, 404, 'File not found.');
        return sendFile(response, path.join(store.directory(id), sourceFile(job)), sourceMime(job), job.fileName);
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

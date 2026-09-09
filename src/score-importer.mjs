import { importFormat } from './import-file.mjs';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const INVALID_FORMAT_MESSAGE = '请选择 PDF、MusicXML（.musicxml / .xml / .mxl）或 PNG / JPG 乐谱图片。';
const TOO_LARGE_MESSAGE = '文件超过 50 MB，请选择更小的乐谱文件。';

function invalidUpload(message) {
  const error = new Error(message);
  error.code = 'INVALID_UPLOAD';
  return error;
}

export async function fetchJson(url, options, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
  return body;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function delay(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class ScoreImporter {
  constructor({ fetchImpl = globalThis.fetch, pollIntervalMs = 1000 } = {}) {
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.pollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
    this.controller = null;
  }

  cancel() {
    this.controller?.abort();
  }

  async upload(file, { onProgress } = {}) {
    const controller = this.#begin();
    try {
      const format = importFormat(file);
      if (!format) throw invalidUpload(INVALID_FORMAT_MESSAGE);
      if (file.size > MAX_UPLOAD_BYTES) throw invalidUpload(TOO_LARGE_MESSAGE);

      this.#progress(controller, onProgress, {
        status: 'queued',
        sourceType: format.sourceType,
        progress: 0,
        fileName: file.name,
        message: '正在上传乐谱文件。',
      });

      let job = await this.#json(controller, '/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': format.mime,
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
      this.#assertCurrent(controller);
      job = { ...job, fileName: job.fileName || file.name };

      while (true) {
        this.#progress(controller, onProgress, job);
        if (job.status === 'error') throw new Error(job.message || '识谱未能完成');
        if (job.status === 'done') return { job, xml: await this.#xml(controller, job) };

        await delay(this.pollIntervalMs, controller.signal);
        this.#assertCurrent(controller);
        job = await this.#json(controller, `/api/jobs/${encodeURIComponent(job.id)}`);
        this.#assertCurrent(controller);
        job = { ...job, fileName: job.fileName || file.name };
      }
    } finally {
      this.#finish(controller);
    }
  }

  async open(jobId, { onProgress } = {}) {
    const controller = this.#begin();
    try {
      const job = await this.#json(controller, `/api/jobs/${encodeURIComponent(jobId)}`);
      this.#assertCurrent(controller);
      this.#progress(controller, onProgress, job);
      if (job.status === 'error') throw new Error(job.message || '识谱未能完成');
      if (job.status !== 'done') throw new Error('这份乐谱的识别结果尚未就绪。');
      return { job, xml: await this.#xml(controller, job) };
    } finally {
      this.#finish(controller);
    }
  }

  #begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return controller;
  }

  #finish(controller) {
    if (this.controller === controller) this.controller = null;
  }

  #assertCurrent(controller) {
    if (this.controller !== controller) throw controller.signal.reason;
    controller.signal.throwIfAborted();
  }

  #progress(controller, onProgress, job) {
    this.#assertCurrent(controller);
    onProgress?.(job);
    this.#assertCurrent(controller);
  }

  #json(controller, url, options = {}) {
    const request = fetchJson(url, { ...options, signal: controller.signal }, this.fetchImpl);
    return abortable(request, controller.signal);
  }

  async #xml(controller, job) {
    const url = job.xmlUrl || `/api/jobs/${encodeURIComponent(job.id)}/score.musicxml`;
    const response = await abortable(this.fetchImpl(url, { signal: controller.signal }), controller.signal);
    this.#assertCurrent(controller);
    if (!response.ok) throw new Error(`MusicXML 读取失败（${response.status}）`);
    const xml = await abortable(response.text(), controller.signal);
    this.#assertCurrent(controller);
    return xml;
  }
}

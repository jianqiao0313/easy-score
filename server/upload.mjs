import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

function uploadFailure(statusCode, message, headers) {
  const failure = new Error(message);
  failure.statusCode = statusCode;
  failure.headers = headers;
  return failure;
}

async function removeTemporary(file) {
  if (!file) return;
  try {
    await unlink(file);
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
}

async function writeChunk(file, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
    offset += bytesWritten;
  }
}

async function receiveToTemporaryFile(request, root, maximum) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) {
    request.resume();
    throw uploadFailure(413, `Upload exceeds the ${maximum / 1024 / 1024} MB limit.`);
  }

  await mkdir(root, { recursive: true });
  const temporary = path.join(root, `.upload-${process.pid}-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx');
  let failure;
  let size = 0;
  try {
    for await (const chunk of request) {
      if (failure) continue;
      size += chunk.length;
      if (size > maximum) {
        failure = uploadFailure(413, `Upload exceeds the ${maximum / 1024 / 1024} MB limit.`);
        continue;
      }
      await writeChunk(file, chunk);
    }
    if (request.aborted) throw uploadFailure(400, 'Upload was aborted.');
    if (failure) throw failure;
    return temporary;
  } catch (cause) {
    await file.close().catch(() => {});
    await removeTemporary(temporary).catch(() => {});
    throw cause;
  } finally {
    await file.close().catch(() => {});
  }
}

export function createUploadReceiver({ root, maximum, concurrency = 2 }) {
  let active = 0;
  return async function receiveUpload(request, useTemporaryFile) {
    if (active >= concurrency) {
      request.resume();
      throw uploadFailure(503, 'Upload service is busy. Please retry shortly.', { 'retry-after': '1' });
    }

    active += 1;
    let temporary;
    try {
      temporary = await receiveToTemporaryFile(request, root, maximum);
      return await useTemporaryFile(temporary);
    } finally {
      await removeTemporary(temporary).catch(() => {});
      active -= 1;
    }
  };
}

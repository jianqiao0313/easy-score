import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { parseMusicXML } from '../src/musicxml.mjs';

const MAX_MXL_ENTRIES = 256;
const MAX_MXL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_MXL_CONTAINER_BYTES = 256 * 1024;
const MAX_MXL_SCORE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_IMAGE_DIMENSION = 32_768;
const MXL_CONTAINER_NAMESPACE = 'urn:oasis:names:tc:opendocument:xmlns:container';
const ZIP_MIMES = new Set(['application/vnd.recordare.musicxml', 'application/zip', 'application/x-zip-compressed']);

const FORMATS_BY_EXTENSION = new Map([
  ['.pdf', { kind: 'pdf', sourceType: 'pdf', sourceMime: 'application/pdf', sourceFile: 'source.pdf' }],
  ['.png', { kind: 'png', sourceType: 'image', sourceMime: 'image/png', sourceFile: 'source.png' }],
  ['.jpg', { kind: 'jpeg', sourceType: 'image', sourceMime: 'image/jpeg', sourceFile: 'source.jpg' }],
  ['.jpeg', { kind: 'jpeg', sourceType: 'image', sourceMime: 'image/jpeg', sourceFile: 'source.jpg' }],
  ['.musicxml', { kind: 'xml', sourceType: 'musicxml', sourceMime: 'application/vnd.recordare.musicxml+xml', sourceFile: 'source.musicxml' }],
  ['.xml', { kind: 'xml', sourceType: 'musicxml', sourceMime: 'application/vnd.recordare.musicxml+xml', sourceFile: 'source.musicxml' }],
  ['.mxl', { kind: 'mxl', sourceType: 'musicxml', sourceMime: 'application/vnd.recordare.musicxml', sourceFile: 'source.mxl' }],
]);

const FORMATS_BY_MIME = new Map([
  ['application/pdf', FORMATS_BY_EXTENSION.get('.pdf')],
  ['image/png', FORMATS_BY_EXTENSION.get('.png')],
  ['image/jpeg', FORMATS_BY_EXTENSION.get('.jpg')],
  ['application/vnd.recordare.musicxml+xml', FORMATS_BY_EXTENSION.get('.musicxml')],
  ['application/xml', FORMATS_BY_EXTENSION.get('.xml')],
  ['text/xml', FORMATS_BY_EXTENSION.get('.xml')],
  ['application/vnd.recordare.musicxml', FORMATS_BY_EXTENSION.get('.mxl')],
]);

function uploadFailure(statusCode, message) {
  const failure = new Error(message);
  failure.statusCode = statusCode;
  return failure;
}

function compatible(left, right) {
  return left.kind === right.kind || (left.kind === 'jpeg' && right.kind === 'jpeg');
}

export function resolveUploadFormat(contentType, fileName, hasFileName = true) {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  const extension = path.extname(fileName).toLowerCase();
  const byExtension = FORMATS_BY_EXTENSION.get(extension);
  let byMime = FORMATS_BY_MIME.get(mime);

  if (ZIP_MIMES.has(mime)) {
    if (extension !== '.mxl') throw uploadFailure(415, 'ZIP uploads must use the .mxl MusicXML extension.');
    byMime = FORMATS_BY_EXTENSION.get('.mxl');
  }
  if (mime === 'application/octet-stream') {
    if (!byExtension) throw uploadFailure(415, 'application/octet-stream requires a supported file extension.');
    byMime = byExtension;
  }
  if (!byMime) throw uploadFailure(415, 'Supported uploads are PDF, PNG, JPEG, MusicXML, and MXL files.');
  if (hasFileName && (!byExtension || !compatible(byMime, byExtension))) {
    throw uploadFailure(415, 'Content-Type does not match the uploaded file extension.');
  }
  return byMime;
}

function decodeXml(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function stripAllowedDoctype(xml) {
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) {
    throw uploadFailure(400, 'MusicXML entity declarations and internal DTD subsets are not supported.');
  }
  const declarations = xml.match(/<!DOCTYPE[\s\S]*?>/gi) || [];
  if (declarations.length > 1) throw uploadFailure(400, 'MusicXML may contain at most one DOCTYPE declaration.');
  if (!declarations.length) return xml;
  const allowed = /^<!DOCTYPE\s+score-partwise\s+(?:PUBLIC\s+(["'])[^"']+\1\s+(["'])[^"']+\2|SYSTEM\s+(["'])[^"']+\3)\s*>$/i;
  if (!allowed.test(declarations[0])) {
    throw uploadFailure(400, 'Only a standard external score-partwise MusicXML DOCTYPE is supported.');
  }
  return xml.replace(declarations[0], '');
}

function assertStrictTagNesting(xml, label) {
  const stack = [];
  let roots = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const offset = xml.indexOf('<', cursor);
    if (offset === -1) {
      if (stack.length === 0 && xml.slice(cursor).trim()) throw uploadFailure(400, `${label} is malformed XML.`);
      break;
    }
    if (stack.length === 0 && xml.slice(cursor, offset).trim()) {
      throw uploadFailure(400, `${label} is malformed XML.`);
    }
    if (xml.startsWith('<!--', offset)) {
      const end = xml.indexOf('-->', offset + 4);
      if (end === -1 || xml.slice(offset + 4, end).includes('--')) {
        throw uploadFailure(400, `${label} is malformed XML.`);
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', offset)) {
      const end = xml.indexOf(']]>', offset + 9);
      if (end === -1 || stack.length === 0) throw uploadFailure(400, `${label} is malformed XML.`);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', offset)) {
      const end = xml.indexOf('?>', offset + 2);
      if (end === -1) throw uploadFailure(400, `${label} is malformed XML.`);
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('</', offset)) {
      const end = xml.indexOf('>', offset + 2);
      const name = end === -1 ? '' : xml.slice(offset + 2, end).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name) || stack.pop() !== name) {
        throw uploadFailure(400, `${label} is malformed XML.`);
      }
      cursor = end + 1;
      continue;
    }
    if (xml.startsWith('<!', offset)) throw uploadFailure(400, `${label} contains an unsupported declaration.`);

    let end = offset + 1;
    let quote = '';
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === '<') throw uploadFailure(400, `${label} is malformed XML.`);
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      } else if (character === '<') {
        throw uploadFailure(400, `${label} is malformed XML.`);
      }
    }
    if (end >= xml.length || quote) throw uploadFailure(400, `${label} is malformed XML.`);
    const tag = xml.slice(offset + 1, end);
    const name = tag.match(/^\s*([A-Za-z_][\w.:-]*)/)?.[1];
    if (!name) throw uploadFailure(400, `${label} is malformed XML.`);
    if (stack.length === 0) roots += 1;
    if (!/\/\s*$/.test(tag)) stack.push(name);
    cursor = end + 1;
  }
  if (stack.length || roots !== 1) throw uploadFailure(400, `${label} is malformed XML.`);
}

export function validateMusicXml(buffer) {
  let xml;
  try {
    xml = stripAllowedDoctype(decodeXml(buffer));
  } catch (cause) {
    if (cause.statusCode) throw cause;
    throw uploadFailure(400, 'MusicXML must be valid UTF-8 or UTF-16 text.');
  }
  assertStrictTagNesting(xml, 'MusicXML');
  const diagnostics = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => diagnostics.push(message),
      error: (message) => diagnostics.push(message),
      fatalError: (message) => diagnostics.push(message),
    },
  }).parseFromString(xml, 'application/xml');
  if (diagnostics.length || document.getElementsByTagName('parsererror').length) {
    throw uploadFailure(400, 'MusicXML is malformed XML.');
  }
  let score;
  try {
    score = parseMusicXML(xml);
  } catch (cause) {
    throw uploadFailure(400, cause instanceof Error ? cause.message : 'Uploaded content is not valid MusicXML.');
  }
  if (!score.notes.length) throw uploadFailure(400, 'MusicXML must contain at least one playable pitched note.');
  return xml.replace(/^\uFEFF?\s*(?:<\?xml\s+[\s\S]*?\?>)?/i, '<?xml version="1.0" encoding="UTF-8"?>\n');
}

function safeArchivePath(name) {
  return name
    && !name.includes('\0')
    && !name.includes('\\')
    && !name.startsWith('/')
    && !/^[A-Za-z]:/.test(name)
    && !name.split('/').includes('..');
}

function zipEntries(buffer) {
  buffer = Buffer.from(buffer);
  let end = buffer.length - 22;
  const minimum = Math.max(0, buffer.length - 65_558);
  while (end >= minimum && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < minimum || end + 22 > buffer.length) throw uploadFailure(400, 'MXL is not a valid ZIP archive.');
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0
    || buffer.readUInt16LE(end + 8) !== count) {
    throw uploadFailure(400, 'Multi-disk MXL archives are not supported.');
  }
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw uploadFailure(400, 'ZIP64 MXL archives are not supported.');
  }
  if (count === 0 || count > MAX_MXL_ENTRIES || centralOffset + centralSize > end) {
    throw uploadFailure(400, `MXL archives must contain 1-${MAX_MXL_ENTRIES} bounded entries.`);
  }

  const entries = [];
  const names = new Set();
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw uploadFailure(400, 'MXL central directory is malformed.');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const originalSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || compressedSize === 0xffffffff || originalSize === 0xffffffff) {
      throw uploadFailure(400, 'MXL central directory is malformed.');
    }
    const name = strFromU8(buffer.subarray(offset + 46, offset + 46 + nameLength));
    if (!safeArchivePath(name)) throw uploadFailure(400, `MXL contains an unsafe path: ${name || '(empty)'}.`);
    if (names.has(name)) throw uploadFailure(400, `MXL contains a duplicate entry: ${name}.`);
    if (flags & 1) throw uploadFailure(400, 'Encrypted MXL entries are not supported.');
    if (compression !== 0 && compression !== 8) throw uploadFailure(400, 'MXL uses an unsupported compression method.');
    totalSize += originalSize;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_MXL_UNCOMPRESSED_BYTES) {
      throw uploadFailure(413, 'MXL expands beyond the 64 MB safety limit.');
    }
    names.add(name);
    entries.push({ name, originalSize });
    offset = next;
  }
  if (offset !== centralOffset + centralSize) throw uploadFailure(400, 'MXL central directory is malformed.');
  return entries;
}

function unzipEntry(buffer, name, maximum) {
  let extracted;
  try {
    extracted = unzipSync(new Uint8Array(buffer), {
      filter(entry) {
        if (entry.name !== name) return false;
        if (entry.originalSize > maximum) throw uploadFailure(413, `${name} exceeds its MXL extraction limit.`);
        return true;
      },
    })[name];
  } catch (cause) {
    if (cause.statusCode) throw cause;
    throw uploadFailure(400, 'MXL contains invalid compressed data.');
  }
  if (!extracted) throw uploadFailure(400, `MXL is missing ${name}.`);
  return Buffer.from(extracted);
}

export function musicXmlFromMxl(buffer) {
  const entries = zipEntries(buffer);
  const containerEntry = entries.find(({ name }) => name === 'META-INF/container.xml');
  if (!containerEntry) throw uploadFailure(400, 'MXL is missing META-INF/container.xml.');
  if (containerEntry.originalSize > MAX_MXL_CONTAINER_BYTES) throw uploadFailure(413, 'MXL container.xml is too large.');
  let containerText;
  try {
    containerText = decodeXml(unzipEntry(buffer, containerEntry.name, MAX_MXL_CONTAINER_BYTES));
  } catch {
    throw uploadFailure(400, 'MXL container.xml must be valid UTF-8 or UTF-16 text.');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(containerText)) throw uploadFailure(400, 'MXL container.xml must not contain DTD declarations.');
  assertStrictTagNesting(containerText, 'MXL container.xml');
  const diagnostics = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => diagnostics.push(message),
      error: (message) => diagnostics.push(message),
      fatalError: (message) => diagnostics.push(message),
    },
  }).parseFromString(containerText, 'application/xml');
  if (diagnostics.length || document.getElementsByTagName('parsererror').length) {
    throw uploadFailure(400, 'MXL container.xml is malformed XML.');
  }
  const root = document.documentElement;
  const namespace = root?.namespaceURI || '';
  if (root?.localName !== 'container' || (namespace && namespace !== MXL_CONTAINER_NAMESPACE)) {
    throw uploadFailure(400, 'MXL container.xml must be a valid container document.');
  }
  const children = (element, localName) => Array.from(element?.childNodes || [])
    .filter((node) => node.nodeType === 1 && node.localName === localName);
  const rootFilesElements = children(root, 'rootfiles')
    .filter((element) => (element.namespaceURI || '') === namespace);
  if (rootFilesElements.length !== 1) {
    throw uploadFailure(400, 'MXL container.xml must contain one direct rootfiles element.');
  }
  const rootFile = children(rootFilesElements[0], 'rootfile')
    .find((element) => (element.namespaceURI || '') === namespace);
  if (!rootFile) throw uploadFailure(400, 'MXL container.xml must contain a direct rootfile element.');
  const rootPath = rootFile?.getAttribute('full-path');
  if (!safeArchivePath(rootPath)) throw uploadFailure(400, 'MXL container.xml contains an unsafe rootfile path.');
  const scoreEntry = entries.find(({ name }) => name === rootPath);
  if (!scoreEntry) throw uploadFailure(400, 'MXL container.xml points to a missing MusicXML score.');
  if (scoreEntry.originalSize > MAX_MXL_SCORE_BYTES) throw uploadFailure(413, 'MusicXML inside MXL exceeds the 50 MB limit.');
  try {
    return decodeXml(unzipEntry(buffer, rootPath, MAX_MXL_SCORE_BYTES));
  } catch {
    throw uploadFailure(400, 'MusicXML inside MXL must be valid UTF-8 or UTF-16 text.');
  }
}

function imageDimensions(buffer, kind) {
  if (kind === 'png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)
      || buffer.readUInt32BE(8) !== 13
      || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
      throw uploadFailure(400, 'Uploaded content is not a valid PNG image.');
    }
    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw uploadFailure(400, 'Uploaded content is not a valid JPEG image.');
  }
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) break;
      return [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw uploadFailure(400, 'Uploaded content is not a valid JPEG image.');
}

export function validateUpload(format, buffer) {
  if (format.kind === 'pdf') {
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw uploadFailure(400, 'Uploaded content is not a PDF file.');
    }
    return { scoreXml: null };
  }
  if (format.kind === 'xml') return { scoreXml: validateMusicXml(buffer) };
  if (format.kind === 'mxl') return { scoreXml: validateMusicXml(Buffer.from(musicXmlFromMxl(buffer))) };

  const [width, height] = imageDimensions(buffer, format.kind);
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS) {
    throw uploadFailure(400, 'Image dimensions exceed the 100 megapixel or 32768 pixel safety limit.');
  }
  return { scoreXml: null };
}

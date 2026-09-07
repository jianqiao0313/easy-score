import assert from 'node:assert/strict';
import test from 'node:test';
import { importFormat } from '../src/import-file.mjs';

test('file picker and drag-and-drop accept score formats when browsers omit MIME', () => {
  for (const [name, type] of [['score.musicxml', 'musicxml'], ['score.XML', 'musicxml'], ['score.mxl', 'musicxml'], ['谱子.PNG', 'image'], ['photo.JPEG', 'image'], ['score.pdf', 'pdf']]) {
    assert.equal(importFormat({ name, type: '' }).sourceType, type);
    assert.equal(importFormat({ name, type: 'application/octet-stream' }).sourceType, type);
  }
  assert.equal(importFormat({ name: 'score.xml', type: 'text/xml' }).mime, 'application/vnd.recordare.musicxml+xml');
  assert.equal(importFormat({ name: 'score.mxl', type: 'application/zip' }).mime, 'application/vnd.recordare.musicxml');
  assert.equal(importFormat({ name: 'scan', type: 'image/jpeg' }).sourceType, 'image');
});

test('unsupported and conflicting file types are rejected before upload', () => {
  for (const file of [
    { name: 'image.svg', type: 'image/svg+xml' },
    { name: 'photo.webp', type: 'image/webp' },
    { name: 'archive.zip', type: 'application/zip' },
    { name: 'score.pdf', type: 'image/png' },
    { name: 'page.html', type: 'application/xml' },
    { name: 'unknown', type: '' },
  ]) assert.equal(importFormat(file), null);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicRoot = new URL('../public/', import.meta.url);

test('saxophone manifest serves independent verified MP3 roots and bounded sustain loops', async () => {
  const manifestBytes = await readFile(new URL('soundfonts/saxophone.json', publicRoot));
  assert.ok(manifestBytes.length < 10_000, 'loading one note must not download an inline sound bank');
  const manifest = JSON.parse(manifestBytes);
  const checksums = new Map((await readFile(new URL('soundfonts/saxophone/SHA256SUMS', publicRoot), 'utf8'))
    .trim().split('\n').map((line) => {
      const [hash, file] = line.split(/\s+/);
      return [file, hash];
    }));
  assert.equal(Object.keys(manifest).length, 32);
  assert.equal(checksums.size, 32);
  for (const [note, { url, loop }] of Object.entries(manifest)) {
    assert.match(note, /^[A-G]b?[3-5]$/);
    assert.match(url, /^\/soundfonts\/saxophone\/[A-G]s?[3-5]\.mp3$/);
    const bytes = await readFile(new URL(url.slice(1), publicRoot));
    assert.ok(bytes.length > 100_000, `${note}: missing or truncated MP3`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), checksums.get(url.split('/').at(-1)), note);
    assert.ok(Number.isFinite(loop.start) && Number.isFinite(loop.end));
    assert.ok(loop.start > 0.2 && loop.end - loop.start > 0.5, `${note}: retain attack and use a sustained loop`);
  }
  const license = await readFile(new URL('soundfonts/saxophone/LICENSE-CC-BY-3.0.txt', publicRoot), 'utf8');
  assert.match(license, /Attribution 3\.0/);
});

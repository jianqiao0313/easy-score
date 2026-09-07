import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Pillow preprocessing covers real image pixels, DPI, orientation, and size limits', () => {
  const result = spawnSync(process.env.PYTHON_BIN || 'python3', [
    '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_prepare_image.py', '-v',
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

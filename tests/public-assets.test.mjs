import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import test from 'node:test';
import { verifyPublicAssets } from '../docker/public-assets.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const contentTypes = { '.json': 'application/json', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

async function serveAssets(t, overrides = {}) {
  const server = createServer(async (request, response) => {
    const override = overrides[request.url];
    if (override) {
      response.writeHead(override.status ?? 200, { 'content-type': override.type ?? 'text/plain' });
      response.end(override.body ?? '');
      return;
    }
    try {
      const bytes = await readFile(new URL(request.url.slice(1), publicRoot));
      response.writeHead(200, { 'content-type': contentTypes[extname(request.url)] ?? 'text/plain' });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('container asset checks accept the repository licenses, font and soundfonts', async (t) => {
  await verifyPublicAssets(await serveAssets(t));
});

test('container asset checks reject missing attribution', async (t) => {
  const baseUrl = await serveAssets(t, { '/asset-licenses.txt': { body: '<html>app fallback</html>' } });
  await assert.rejects(verifyPublicAssets(baseUrl), /license notices.*asset-licenses\.txt/);
});

test('container asset checks require the complete saxophone license', async (t) => {
  const baseUrl = await serveAssets(t, { '/soundfonts/saxophone/LICENSE-CC-BY-3.0.txt': { status: 404 } });
  await assert.rejects(verifyPublicAssets(baseUrl), /license notices.*saxophone\/LICENSE/);
});

test('container asset checks reject an invalid saxophone sustain loop', async (t) => {
  const manifest = JSON.parse(await readFile(new URL('soundfonts/saxophone.json', publicRoot)));
  manifest.C4.loop.end = manifest.C4.loop.start;
  const baseUrl = await serveAssets(t, {
    '/soundfonts/saxophone.json': { type: 'application/json', body: JSON.stringify(manifest) },
  });
  await assert.rejects(verifyPublicAssets(baseUrl), /saxophone sample map/);
});

test('container asset checks reject an HTML fallback for a saxophone MP3', async (t) => {
  const baseUrl = await serveAssets(t, {
    '/soundfonts/saxophone/C4.mp3': { type: 'text/html', body: '<html>app fallback</html>'.repeat(100) },
  });
  await assert.rejects(verifyPublicAssets(baseUrl), /saxophone sample was not served/);
});

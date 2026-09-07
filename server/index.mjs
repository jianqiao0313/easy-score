import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.mjs';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 4173;
const production = process.env.NODE_ENV === 'production';

async function productionFallback(request, response) {
  const url = new URL(request.url, `http://${host}`);
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  let file = path.resolve('dist', relative);
  if (!file.startsWith(`${path.resolve('dist')}${path.sep}`) && file !== path.resolve('dist/index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
    file = path.resolve('dist/index.html');
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(response);
}

let fallback;
let vite;
if (production) {
  fallback = productionFallback;
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    appType: 'spa',
    server: {
      middlewareMode: true,
      watch: {
        ignored: [
          '**/.local/**',
          '**/.next/**',
          '**/docs/**',
          '**/scripts/**',
          '**/server/**',
          '**/tests/**',
        ],
      },
    },
  });
  fallback = (request, response) => vite.middlewares(request, response, (cause) => {
    if (cause) vite.ssrFixStacktrace?.(cause);
    if (!response.headersSent) response.writeHead(cause ? 500 : 404).end(cause?.message || 'Not found.');
  });
}

const { handler } = await createApp({ fallback });
const server = createServer((request, response) => void handler(request, response));
server.listen(port, host, () => {
  console.log(`easy-score listening on http://${host}:${port} (${production ? 'production' : 'Vite development'})`);
});

async function close() {
  await vite?.close();
  server.close();
}
process.once('SIGINT', close);
process.once('SIGTERM', close);

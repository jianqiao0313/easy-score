import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseMusicXML } from '../src/musicxml.mjs';

const image = process.argv[2] || 'easy-score:local';
const name = `easy-score-smoke-${process.pid}`;

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitForHealth(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
      lastError = new Error(`health endpoint returned HTTP ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`container did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function recognizePdf(baseUrl, pdfPath) {
  const pdf = await readFile(pdfPath);
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent('docker-smoke.pdf'),
    },
    body: pdf,
  });
  if (created.status !== 202) throw new Error(`PDF upload returned HTTP ${created.status}`);
  const { id } = await created.json();
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(`${baseUrl}/api/jobs/${id}`);
    if (!statusResponse.ok) throw new Error(`job status returned HTTP ${statusResponse.status}`);
    const job = await statusResponse.json();
    if (job.status === 'error') throw new Error(`OMR job failed: ${job.error || job.message}`);
    if (job.status === 'done') {
      const score = await fetch(`${baseUrl}/api/jobs/${id}/score.musicxml`);
      const xml = await score.text();
      if (!score.ok || !xml.includes('<score-partwise')) {
        throw new Error('OMR job did not return a valid MusicXML score.');
      }
      const parsed = parseMusicXML(xml);
      if (parsed.notes.length === 0 || parsed.totalBeats <= 0) {
        throw new Error('OMR job returned MusicXML without playable notes.');
      }
      const source = await fetch(`${baseUrl}/api/jobs/${id}/source.pdf`);
      const returnedPdf = Buffer.from(await source.arrayBuffer());
      if (!source.ok || !returnedPdf.equals(pdf)) {
        throw new Error('OMR job did not preserve the uploaded PDF bytes.');
      }
      return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('OMR smoke test timed out.');
}

let started = false;
try {
  const version = docker(
    'run', '--rm', '--platform', 'linux/amd64', image,
    '/opt/audiveris/bin/Audiveris', '-version',
  );
  if (!version.includes('5.11.0')) throw new Error(`unexpected Audiveris version: ${version}`);

  docker(
    'run', '--detach', '--name', name, '--platform', 'linux/amd64',
    '--mount', 'type=tmpfs,destination=/data,tmpfs-mode=1777',
    '--publish', '127.0.0.1::4173', image,
  );
  started = true;
  const port = docker('port', name, '4173/tcp').match(/:(\d+)$/)?.[1];
  if (!port) throw new Error('could not resolve the mapped HTTP port');
  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl);
  if (!health.ok || !health.engine?.available) {
    throw new Error(`unhealthy OMR engine: ${JSON.stringify(health)}`);
  }
  const page = await fetch(baseUrl);
  if (!page.ok || !(await page.text()).includes('<html')) {
    throw new Error('production web page was not served');
  }
  docker('exec', name, 'node', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    for (const file of [
      '/usr/share/doc/easy-score/LICENSE',
      '/usr/share/doc/easy-score/THIRD_PARTY_NOTICES.md',
      '/usr/share/doc/easy-score/NODE_LICENSE',
      '/usr/share/doc/easy-score/debian-packages.tsv',
      '/opt/tessdata/LICENSE',
    ]) {
      if (!readFileSync(file, 'utf8').trim()) throw new Error('Missing license record: ' + file);
    }
  `);
  for (const [file, names] of [
    ['third-party-licenses.txt', ['PhonicScore', 'Jean-loup Gailly']],
    ['asset-licenses.txt', ['Frank Wen', 'Creative Commons Attribution 3.0 US']],
    ['fonts/LICENSE.txt', ['Adobe', 'SIL OPEN FONT LICENSE']],
    ['soundfonts/piano/SOURCE.md', ['Alexander Holm', 'CC BY 3.0']],
    ['soundfonts/piano/LICENSE-CC-BY-3.0.txt', ['CREATIVE COMMONS']],
  ]) {
    const licenses = await fetch(`${baseUrl}/${file}`);
    const licenseText = await licenses.text();
    if (!licenses.ok || names.some((author) => !licenseText.includes(author))) {
      throw new Error(`third-party license notices were not served: ${file}`);
    }
  }

  const font = await fetch(`${baseUrl}/fonts/SourceHanSansCN-VF.otf.woff2`);
  const fontBytes = Buffer.from(await font.arrayBuffer());
  if (!font.ok || font.headers.get('content-type') !== 'font/woff2' || fontBytes.subarray(0, 4).toString() !== 'wOF2') {
    throw new Error('local Source Han Sans web font was not served');
  }
  const pianoMap = await (await fetch(`${baseUrl}/soundfonts/piano.json`)).json();
  if (Object.keys(pianoMap).length !== 30 || !pianoMap.C4?.startsWith('/soundfonts/piano/')) {
    throw new Error('local Salamander piano sample map was not served');
  }
  const pianoSample = await fetch(`${baseUrl}${pianoMap.C4}`);
  if (!pianoSample.ok || pianoSample.headers.get('content-type') !== 'audio/mpeg' || (await pianoSample.arrayBuffer()).byteLength < 1000) {
    throw new Error('local Salamander piano sample was not served');
  }

  let omr = 'skipped (set EASY_SCORE_SMOKE_PDF to run a real recognition job)';
  if (process.env.EASY_SCORE_SMOKE_PDF) {
    const id = await recognizePdf(baseUrl, process.env.EASY_SCORE_SMOKE_PDF);
    omr = `passed (job ${id})`;
  }
  console.log(JSON.stringify({ image, audiveris: '5.11.0', health: 'passed', web: 'passed', licenses: 'passed', omr }, null, 2));
} finally {
  if (started) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 15_000 });
}

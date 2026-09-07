import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { strToU8, zipSync } from 'fflate';
import { parseMusicXML } from '../src/musicxml.mjs';

const image = process.argv[2] || 'easy-score:local';
const name = `easy-score-smoke-${process.pid}`;
const DIRECT_MUSIC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes>
      <divisions>1</divisions>
      <key><fifths>0</fifths></key>
      <time><beats>4</beats><beat-type>4</beat-type></time>
      <clef><sign>G</sign><line>2</line></clef>
    </attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
  </measure></part>
</score-partwise>`;

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
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

function assertDoneMetadata(job, { id, fileName, sourceType, sourceMime, pdf = false }) {
  if (job.id !== id || job.status !== 'done' || job.progress !== 100 || job.fileName !== fileName
    || job.sourceType !== sourceType || job.sourceMime !== sourceMime
    || job.sourceUrl !== `/api/jobs/${id}/source`
    || job.xmlUrl !== `/api/jobs/${id}/score.musicxml`
    || (pdf && job.pdfUrl !== `/api/jobs/${id}/source.pdf`)) {
    throw new Error(`job metadata did not match the ${sourceType} source contract: ${JSON.stringify(job)}`);
  }
}

async function fetchPlayableScore(baseUrl, job) {
  const score = await fetch(`${baseUrl}${job.xmlUrl}`);
  const xml = await score.text();
  if (!score.ok || !xml.includes('<score-partwise')) {
    throw new Error('job did not return a valid MusicXML score.');
  }
  const parsed = parseMusicXML(xml);
  if (parsed.notes.length === 0 || parsed.totalBeats <= 0) {
    throw new Error('job returned MusicXML without playable notes.');
  }
}

async function fetchOriginalSource(baseUrl, job, expected) {
  const source = await fetch(`${baseUrl}${job.sourceUrl}`);
  const returned = Buffer.from(await source.arrayBuffer());
  if (!source.ok || source.headers.get('content-type')?.split(';', 1)[0] !== job.sourceMime
    || !returned.equals(expected)) {
    throw new Error(`job did not preserve the uploaded ${job.sourceType} bytes.`);
  }
}

async function waitForDone(baseUrl, id) {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(`${baseUrl}/api/jobs/${id}`);
    if (!statusResponse.ok) throw new Error(`job status returned HTTP ${statusResponse.status}`);
    const job = await statusResponse.json();
    if (job.status === 'error') throw new Error(`OMR job failed: ${job.error || job.message}`);
    if (job.status === 'done') return job;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('OMR smoke test timed out.');
}

async function uploadForRecognition(baseUrl, bytes, { fileName, sourceType, sourceMime, pdf = false }) {
  const created = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': sourceMime,
      'x-file-name': encodeURIComponent(fileName),
    },
    body: bytes,
  });
  if (created.status !== 202) throw new Error(`${sourceType} upload returned HTTP ${created.status}`);
  const { id } = await created.json();
  const job = await waitForDone(baseUrl, id);
  assertDoneMetadata(job, { id, fileName, sourceType, sourceMime, pdf });
  await fetchPlayableScore(baseUrl, job);
  await fetchOriginalSource(baseUrl, job, bytes);
  if (pdf) {
    const legacyPdf = await fetch(`${baseUrl}${job.pdfUrl}`);
    if (!legacyPdf.ok || !Buffer.from(await legacyPdf.arrayBuffer()).equals(bytes)) {
      throw new Error('OMR job did not preserve the PDF at its legacy URL.');
    }
  }
  return id;
}

async function uploadDirectScore(baseUrl, bytes, { fileName, sourceType, sourceMime }) {
  const response = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': sourceMime,
      'x-file-name': encodeURIComponent(fileName),
    },
    body: bytes,
  });
  if (response.status !== 202) throw new Error(`${sourceType} direct upload returned HTTP ${response.status}`);
  const created = await response.json();
  if (created.status !== 'done') {
    throw new Error(`${sourceType} direct upload invoked the asynchronous OMR path: ${JSON.stringify(created)}`);
  }
  const jobResponse = await fetch(`${baseUrl}/api/jobs/${created.id}`);
  if (!jobResponse.ok) throw new Error(`${sourceType} job lookup returned HTTP ${jobResponse.status}`);
  const job = await jobResponse.json();
  assertDoneMetadata(job, { id: created.id, fileName, sourceType, sourceMime });
  await fetchPlayableScore(baseUrl, job);
  await fetchOriginalSource(baseUrl, job, bytes);
  return created.id;
}

async function verifyHistory(baseUrl, expectedEntries) {
  const response = await fetch(`${baseUrl}/api/scores`);
  if (!response.ok) throw new Error(`score history returned HTTP ${response.status}`);
  const { scores } = await response.json();
  for (const { id, fileName, sourceType, sourceMime } of expectedEntries) {
    const score = scores.find((entry) => entry.id === id);
    if (!score || score.status !== 'done' || score.fileName !== fileName
      || score.sourceType !== sourceType || score.sourceMime !== sourceMime
      || score.sourceUrl !== `/api/jobs/${id}/source`
      || score.xmlUrl !== `/api/jobs/${id}/score.musicxml`) {
      throw new Error(`completed direct import was missing from score history: ${id}`);
    }
  }
}

function createMxlFixture() {
  return Buffer.from(zipSync({
    mimetype: [strToU8('application/vnd.recordare.musicxml'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles>
</container>`),
    'score.musicxml': strToU8(DIRECT_MUSIC_XML),
  }));
}

function renderFirstPageAsPng(pdfPath) {
  docker('cp', pdfPath, `${name}:/tmp/docker-smoke.pdf`);
  const encoded = docker('exec', name, 'sh', '-c', [
    'pdftoppm -png -f 1 -l 1 -singlefile -r 200',
    '/tmp/docker-smoke.pdf /tmp/docker-smoke-page >/dev/null 2>&1',
    '&& base64 -w 0 /tmp/docker-smoke-page.png',
  ].join(' '));
  const png = Buffer.from(encoded, 'base64');
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('pdftoppm did not produce a valid PNG fixture.');
  }
  return png;
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

  const musicXmlBytes = Buffer.from(DIRECT_MUSIC_XML);
  const musicXmlId = await uploadDirectScore(baseUrl, musicXmlBytes, {
    fileName: 'docker-direct.musicxml',
    sourceType: 'musicxml',
    sourceMime: 'application/vnd.recordare.musicxml+xml',
  });
  const mxlBytes = createMxlFixture();
  const mxlId = await uploadDirectScore(baseUrl, mxlBytes, {
    fileName: 'docker-direct.mxl',
    sourceType: 'musicxml',
    sourceMime: 'application/vnd.recordare.musicxml',
  });
  await verifyHistory(baseUrl, [
    {
      id: musicXmlId,
      fileName: 'docker-direct.musicxml',
      sourceType: 'musicxml',
      sourceMime: 'application/vnd.recordare.musicxml+xml',
    },
    {
      id: mxlId,
      fileName: 'docker-direct.mxl',
      sourceType: 'musicxml',
      sourceMime: 'application/vnd.recordare.musicxml',
    },
  ]);

  let omr = 'skipped (set EASY_SCORE_SMOKE_PDF to run a real recognition job)';
  let imageOmr = omr;
  if (process.env.EASY_SCORE_SMOKE_PDF) {
    const pdf = await readFile(process.env.EASY_SCORE_SMOKE_PDF);
    const pdfId = await uploadForRecognition(baseUrl, pdf, {
      fileName: 'docker-smoke.pdf', sourceType: 'pdf', sourceMime: 'application/pdf', pdf: true,
    });
    omr = `passed (job ${pdfId})`;
    const png = renderFirstPageAsPng(process.env.EASY_SCORE_SMOKE_PDF);
    const imageId = await uploadForRecognition(baseUrl, png, {
      fileName: 'docker-smoke.png', sourceType: 'image', sourceMime: 'image/png',
    });
    const preprocessing = JSON.parse(docker('exec', name, 'cat', `/data/jobs/${imageId}/preprocess.json`));
    if (!preprocessing.resized || !preprocessing.sourceDpi?.every((dpi) => dpi > 199 && dpi < 201)
      || !preprocessing.outputDpi?.every((dpi) => dpi >= 300)
      || !preprocessing.outputSize?.every((size, index) => size > preprocessing.sourceSize[index])) {
      throw new Error(`low-DPI image did not undergo real pixel resampling: ${JSON.stringify(preprocessing)}`);
    }
    imageOmr = `passed (200 → 300 DPI resampling; job ${imageId})`;
  }
  console.log(JSON.stringify({
    image,
    audiveris: '5.11.0',
    health: 'passed',
    web: 'passed',
    licenses: 'passed',
    directImports: `passed (MusicXML ${musicXmlId}; MXL ${mxlId})`,
    omr,
    imageOmr,
  }, null, 2));
} finally {
  if (started) spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 15_000 });
}

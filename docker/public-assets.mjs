export async function verifyPublicAssets(baseUrl) {
  for (const [file, names] of [
    ['third-party-licenses.txt', ['PhonicScore', 'Jean-loup Gailly']],
    ['asset-licenses.txt', ['Karoryfer', 'tonejs-instruments', 'Creative Commons Attribution 3.0 Unported']],
    ['fonts/LICENSE.txt', ['Adobe', 'SIL OPEN FONT LICENSE']],
    ['soundfonts/piano/SOURCE.md', ['Alexander Holm', 'CC BY 3.0']],
    ['soundfonts/piano/LICENSE-CC-BY-3.0.txt', ['CREATIVE COMMONS']],
    ['soundfonts/saxophone/SOURCE.md', ['Karoryfer', 'Nicholaus P. Brosowsky', 'CC BY 3.0']],
    ['soundfonts/saxophone/LICENSE-CC-BY-3.0.txt', ['CREATIVE COMMONS', 'Attribution 3.0']],
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

  const saxophoneResponse = await fetch(`${baseUrl}/soundfonts/saxophone.json`);
  if (!saxophoneResponse.ok) throw new Error('local saxophone sample map was not served');
  const saxophoneMap = await saxophoneResponse.json();
  const root = saxophoneMap?.C4;
  if (!saxophoneMap || Object.keys(saxophoneMap).length !== 32
    || root?.url !== '/soundfonts/saxophone/C4.mp3'
    || !Number.isFinite(root.loop?.start) || !Number.isFinite(root.loop?.end)
    || root.loop.start <= 0 || root.loop.end <= root.loop.start) {
    throw new Error('local saxophone sample map was not served');
  }
  const saxophoneSample = await fetch(`${baseUrl}${root.url}`);
  if (!saxophoneSample.ok || saxophoneSample.headers.get('content-type') !== 'audio/mpeg'
    || (await saxophoneSample.arrayBuffer()).byteLength < 1000) {
    throw new Error('local saxophone sample was not served');
  }
}

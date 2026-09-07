import { access, appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { musicXmlFromMxl, validateMusicXml } from './imports.mjs';

export const DEFAULT_ENGINE_PATH = path.resolve(
  '.local/omr/Audiveris.app/Contents/MacOS/Audiveris',
);
const PDF_RENDER_DPI = 350;
const MAX_HIGH_RESOLUTION_PAGES = 20;

async function findFiles(directory, extension) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findFiles(target, extension));
    else if (entry.name.toLowerCase().endsWith(extension)) found.push(target);
  }
  return found;
}

async function executableOnPath(name) {
  if (!name) return null;
  if (name.includes(path.sep)) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function runProcess(executable, args, { cwd, env, timeoutMs, onOutput = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(executable)} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(cause);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

async function preparePdfInput({ inputPath, outputDir, timeoutMs, onProgress, pythonExecutable }) {
  const warnings = [];
  const renderer = await executableOnPath(process.env.POPPLER_BIN || 'pdftoppm');
  if (!renderer) {
    warnings.push('未检测到 pdftoppm，已使用 Audiveris 原生 300 DPI PDF 渲染；细小符号的识别率可能降低。');
    return { recognitionInput: inputPath, warnings, cleanup: async () => {} };
  }

  const renderDirectory = await mkdtemp(path.join(outputDir, '.render-'));
  const cleanup = () => rm(renderDirectory, { recursive: true, force: true });
  const log = [];
  try {
    onProgress(12, `正在以 ${PDF_RENDER_DPI} DPI 渲染 PDF`);
    await runProcess(renderer, [
      '-r', String(PDF_RENDER_DPI), '-png', inputPath, path.join(renderDirectory, 'page'),
    ], {
      cwd: renderDirectory,
      env: process.env,
      timeoutMs,
      onOutput: (chunk) => log.push(chunk.toString()),
    });
    const pages = (await findFiles(renderDirectory, '.png')).sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }));
    if (pages.length === 0) throw new Error('pdftoppm did not render any pages.');
    if (pages.length === 1) return { recognitionInput: pages[0], warnings, cleanup };

    if (pages.length > MAX_HIGH_RESOLUTION_PAGES) {
      warnings.push(`PDF 共 ${pages.length} 页，超过高精度识别建议上限 ${MAX_HIGH_RESOLUTION_PAGES} 页；已使用 Audiveris 原生 300 DPI 多页处理。`);
      await cleanup();
      return { recognitionInput: inputPath, warnings, cleanup: async () => {} };
    }
    const python = await executableOnPath(pythonExecutable);
    if (!python) {
      warnings.push('未检测到 Python/Pillow，已使用 Audiveris 原生 300 DPI 多页处理。');
      await cleanup();
      return { recognitionInput: inputPath, warnings, cleanup: async () => {} };
    }
    const tiff = path.join(renderDirectory, 'score.tiff');
    onProgress(15, `正在准备 ${pages.length} 页高精度乐谱`);
    await runProcess(python, [
      path.resolve('server/render_pdf.py'), tiff, String(PDF_RENDER_DPI), ...pages,
    ], {
      cwd: outputDir,
      env: process.env,
      timeoutMs,
      onOutput: (chunk) => log.push(chunk.toString()),
    });
    return { recognitionInput: tiff, warnings, cleanup };
  } catch (cause) {
    await appendFile(path.join(outputDir, 'preprocess.log'), `${log.join('')}\n${cause.stack || cause}\n`);
    warnings.push(`${PDF_RENDER_DPI} DPI PDF 预处理失败，已使用 Audiveris 原生 300 DPI 渲染；详细信息已保存到任务日志。`);
    await cleanup();
    return { recognitionInput: inputPath, warnings, cleanup: async () => {} };
  }
}

async function prepareImageInput({ inputPath, outputDir, timeoutMs, onProgress, pythonExecutable }) {
  const python = await executableOnPath(pythonExecutable);
  if (!python) {
    return {
      recognitionInput: inputPath,
      warnings: ['未检测到 Python/Pillow，无法进行 300 DPI 图片预处理，已使用原图识别。'],
      cleanup: async () => {},
    };
  }
  const renderDirectory = await mkdtemp(path.join(outputDir, '.render-'));
  const cleanup = () => rm(renderDirectory, { recursive: true, force: true });
  const recognitionInput = path.join(renderDirectory, 'score.png');
  const output = [];
  try {
    onProgress(12, '正在本地预处理图片（目标 300 DPI）');
    await runProcess(python, [path.resolve('server/prepare_image.py'), inputPath, recognitionInput], {
      cwd: outputDir,
      env: process.env,
      timeoutMs,
      onOutput: (chunk) => output.push(chunk.toString()),
    });
    const report = JSON.parse(output.join(''));
    await access(recognitionInput);
    await writeFile(path.join(outputDir, 'preprocess.json'), JSON.stringify(report, null, 2));
    return { recognitionInput, warnings: report.warnings || [], cleanup };
  } catch (cause) {
    await cleanup();
    await appendFile(path.join(outputDir, 'preprocess.log'), `${output.join('')}\n${cause.stack || cause}\n`);
    return {
      recognitionInput: inputPath,
      warnings: ['300 DPI 图片预处理失败，已使用原图识别；详细信息已保存到任务日志。'],
      cleanup: async () => {},
    };
  }
}

function progressForLog(line, current) {
  const upper = line.toUpperCase();
  const stages = [
    ['LOAD', 18, '正在读取乐谱页面'],
    ['BINARY', 25, '正在校正页面图像'],
    ['GRID', 35, '正在检测谱线'],
    ['HEADS', 48, '正在识别音符'],
    ['STEMS', 58, '正在识别音符与记号'],
    ['SYMBOLS', 66, '正在识别音符与记号'],
    ['RHYTHMS', 76, '正在分析节奏和小节'],
    ['PAGE', 84, '正在整理乐谱结构'],
    ['EXPORT', 92, '正在生成可播放乐谱'],
  ];
  let result = { progress: current, message: null };
  for (const [needle, progress, message] of stages) {
    if (upper.includes(needle) && progress > result.progress) result = { progress, message };
  }
  return result;
}

export function createAudiverisEngine({
  executable = process.env.AUDIVERIS_BIN || DEFAULT_ENGINE_PATH,
  tessdataDirectory = process.env.TESSDATA_PREFIX || path.resolve('.local/omr/tessdata'),
  timeoutMs = Number(process.env.OMR_TIMEOUT_MS) || 10 * 60_000,
  pythonExecutable = process.env.PYTHON_BIN || 'python3',
} = {}) {
  return {
    name: 'Audiveris',

    async health() {
      try {
        await access(executable, constants.X_OK);
        return {
          available: true,
          name: 'Audiveris',
          message: 'Audiveris 已就绪',
        };
      } catch {
        return {
          available: false,
          name: 'Audiveris',
          message: `Audiveris executable was not found at ${executable}. Run scripts/setup-omr.sh.`,
        };
      }
    },

    async convert({ inputPath, outputDir, sourceType = 'pdf', onProgress = () => {} }) {
      const health = await this.health();
      if (!health.available) throw new Error(health.message);

      const prepared = sourceType === 'pdf'
        ? await preparePdfInput({ inputPath, outputDir, timeoutMs, onProgress, pythonExecutable })
        : await prepareImageInput({ inputPath, outputDir, timeoutMs, onProgress, pythonExecutable });
      const args = ['-batch', '-transcribe', '-export', '-output', outputDir, '--', prepared.recognitionInput];

      let progress = 12;
      const recentOutput = [];
      try {
        const capture = (chunk) => {
          for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
            recentOutput.push(line);
            if (recentOutput.length > 30) recentOutput.shift();
            const next = progressForLog(line, progress);
            if (next.progress !== progress) {
              progress = next.progress;
              onProgress(progress, next.message);
            }
          }
        };
        await runProcess(executable, args, {
          cwd: outputDir,
          env: { ...process.env, LC_ALL: 'en_US.UTF-8', TESSDATA_PREFIX: tessdataDirectory },
          timeoutMs,
          onOutput: capture,
        });
      } catch (cause) {
        const failure = new Error(`${cause.message} ${recentOutput.slice(-5).join(' ')}`);
        failure.publicMessage = 'Audiveris 识别失败，详细日志已保存在任务目录。';
        throw failure;
      } finally {
        await prepared.cleanup();
      }

      const mxlFiles = await findFiles(outputDir, '.mxl');
      if (mxlFiles.length === 0) {
        const failure = new Error('Audiveris completed without producing an MXL file.');
        failure.publicMessage = sourceType === 'image'
          ? 'Audiveris 无法从这张图片生成乐谱，请确认图片完整且包含清晰的五线谱。'
          : 'Audiveris 未能从 PDF 生成乐谱，请确认文件完整且包含可识别的五线谱。';
        throw failure;
      }
      const newest = (await Promise.all(mxlFiles.map(async (file) => ({
        file,
        stat: await stat(file),
      })))).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0].file;
      const mxl = await readFile(newest);
      try {
        const xml = validateMusicXml(Buffer.from(musicXmlFromMxl(mxl)));
        return { xml, mxlPath: newest, warnings: prepared.warnings };
      } catch (cause) {
        const failure = new Error(`Audiveris produced invalid MusicXML: ${cause.message}`);
        failure.publicMessage = sourceType === 'image'
          ? 'Audiveris 已处理图片，但没有生成包含可播放音符的有效乐谱。请尝试更清晰、完整的五线谱图片。'
          : 'Audiveris 已处理 PDF，但没有生成包含可播放音符的有效乐谱。请确认文件包含清晰、完整的五线谱。';
        throw failure;
      }
    },
  };
}

export { musicXmlFromMxl } from './imports.mjs';

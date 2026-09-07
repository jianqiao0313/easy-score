import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { parseMusicXML } from './musicxml.mjs';
import { ScorePlayer } from './audio.mjs';
import { syncCursorToBeat } from './cursor.mjs';
import { loadPreferences, saveInstrument, saveMeasuresPerRow } from './preferences.mjs';
import { markMeasureRowEnds, musicXmlWithSystemBreaks } from './score-layout.mjs';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const ui = {
  engineDot: $('#engineDot'), engineStatus: $('#engineStatus'), uploadButton: $('#uploadButton'), emptyUploadButton: $('#emptyUploadButton'), fileInput: $('#fileInput'),
  demoSection: $('#demoSection'), demoButton: $('#demoButton'), emptyDemoButton: $('#emptyDemoButton'), dropZone: $('#dropZone'), dropOverlay: $('#dropOverlay'), emptyState: $('#emptyState'),
  processingState: $('#processingState'), errorState: $('#errorState'), errorMessage: $('#errorMessage'), retryButton: $('#retryButton'), progressNumber: $('#progressNumber'),
  progressBar: $('#progressBar'), jobStatusLabel: $('#jobStatusLabel'), jobStatusTitle: $('#jobStatusTitle'), jobStatusMessage: $('#jobStatusMessage'), scoreView: $('#scoreView'),
  pdfView: $('#pdfView'), pdfFrame: $('#pdfFrame'), osmdContainer: $('#osmdContainer'), scoreTab: $('#scoreTab'), pdfTab: $('#pdfTab'),
  exportButton: $('#exportButton'), scoreOrigin: $('#scoreOrigin'), scoreTitle: $('#scoreTitle'), scoreComposer: $('#scoreComposer'), scoreMeta: $('#scoreMeta'),
  measuresPerRow: $('#measuresPerRow'),
  timeSignature: $('#timeSignature'), keySignature: $('#keySignature'), measureCount: $('#measureCount'), warningCount: $('#warningCount'), soundSource: $('#soundSource'),
  warningDetails: $('#warningDetails'), warningList: $('#warningList'),
  instrumentGroup: $('#instrumentGroup'), tempoInput: $('#tempoInput'), tempoRange: $('#tempoRange'), tempoDown: $('#tempoDown'), tempoUp: $('#tempoUp'), tempoMark: $('#tempoMark'),
  metronomeToggle: $('#metronomeToggle'), volumeRange: $('#volumeRange'), volumeValue: $('#volumeValue'), practiceTip: $('#practiceTip'), playButton: $('#playButton'),
  stopButton: $('#stopButton'), forwardButton: $('#forwardButton'), seekRange: $('#seekRange'), currentTime: $('#currentTime'), totalTime: $('#totalTime'),
  currentMeasure: $('#currentMeasure'), totalMeasures: $('#totalMeasures'), nowPlayingTitle: $('#nowPlayingTitle'), nowPlayingDetail: $('#nowPlayingDetail'),
};

let osmd;
let score;
let xmlText = '';
let activeJob = null;
let activeJobSource = null;
let activeRequest = 0;
let retryAction = null;
let currentTab = 'score';
let cursorBeat = -1;
let layoutRenderRequest = 0;
let automaticLayoutWidth = 0;
const preferences = loadPreferences();

const player = new ScorePlayer({
  instrumentId: preferences.instrumentId,
  onPosition: (beat) => updatePlayback(beat),
  onEnded: () => {
    setPlaying(false);
    updatePlayback(score?.totalBeats || 0);
  },
  onStatus: ({ soundMode, message }) => {
    updateSoundSourceLabel(false, soundMode);
    if (message && soundMode === 'synthesized') setPracticeTip('音源提示', message, '!');
  },
});

ui.measuresPerRow.value = String(preferences.measuresPerRow);
setInstrumentSelection(preferences.instrumentId);

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function estimatedSeconds(beat, bpm = Number(ui.tempoInput.value)) {
  return (Math.max(0, beat) * 60) / Math.max(1, bpm);
}

function setView(view) {
  ['emptyState', 'processingState', 'errorState', 'scoreView', 'pdfView'].forEach((key) => { ui[key].hidden = true; });
  if (view === 'loaded') ui[currentTab === 'score' ? 'scoreView' : 'pdfView'].hidden = false;
  else ui[view].hidden = false;
}

function setTab(tab) {
  currentTab = tab;
  const scoreSelected = tab === 'score';
  ui.scoreTab.classList.toggle('is-active', scoreSelected);
  ui.pdfTab.classList.toggle('is-active', !scoreSelected);
  ui.scoreTab.setAttribute('aria-selected', String(scoreSelected));
  ui.pdfTab.setAttribute('aria-selected', String(!scoreSelected));
  updateCursorFollowing();
  if (score) setView('loaded');
  if (scoreSelected) resizeAutomaticScore();
}

function updateCursorFollowing() {
  if (!osmd) return;
  osmd.setOptions({ followCursor: Boolean(player?.isPlaying && currentTab === 'score') });
}

function showError(message, action) {
  retryAction = action;
  ui.errorMessage.textContent = message || '请稍后重试，或换一份清晰的印刷乐谱。';
  ui.retryButton.hidden = !action;
  setView('errorState');
}

function statusCopy(job) {
  if (job.status === 'queued') return ['等待识别', '乐谱已进入处理队列', job.message || '正在等待识谱引擎。'];
  return ['正在识别', '正在把乐谱转换为可播放音符', job.message || '页数较多时可能需要几分钟，请保持此页面打开。'];
}

function showJob(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const [label, title, message] = statusCopy(job);
  ui.progressNumber.textContent = Math.round(progress);
  ui.progressBar.style.width = `${progress}%`;
  ui.jobStatusLabel.textContent = label;
  ui.jobStatusTitle.textContent = title;
  ui.jobStatusMessage.textContent = message;
  ui.scoreOrigin.textContent = activeJobSource === 'demo' ? '缓存的真实识别示例' : '本次识别任务';
  ui.scoreTitle.textContent = job.fileName || '正在读取乐谱';
  ui.scoreComposer.textContent = `${progress}% · OMR 结果可能需要对照原谱校验`;
  setView('processingState');
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `请求失败（${response.status}）`);
  return body;
}

async function checkHealth() {
  try {
    const health = await fetchJson('/api/health');
    const available = Boolean(health.engine?.available);
    setDemoAvailability(Boolean(health.demoAvailable));
    ui.engineDot.classList.toggle('is-online', available);
    ui.engineDot.classList.toggle('is-warning', !available);
    ui.engineStatus.textContent = available ? `${health.engine.name || '识谱引擎'} 已就绪` : (health.engine?.message || '识谱引擎不可用');
  } catch {
    setDemoAvailability(false);
    ui.engineDot.classList.add('is-warning');
    ui.engineStatus.textContent = '暂时无法连接识谱服务';
  }
}

function setDemoAvailability(available) {
  ui.demoSection.hidden = !available;
  ui.emptyDemoButton.hidden = !available;
}

async function loadDemo() {
  const request = ++activeRequest;
  retryAction = loadDemo;
  resetLoadedState();
  activeJobSource = 'demo';
  try {
    const job = await fetchJson('/api/demo');
    if (request !== activeRequest) return;
    await handleJob(job, request);
  } catch (error) {
    if (request === activeRequest) showError(`示例尚未准备好：${error.message}`, loadDemo);
  }
}

async function uploadFile(file) {
  if (!file) return;
  const request = ++activeRequest;
  resetLoadedState();
  activeJobSource = 'upload';
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    ui.fileInput.value = '';
    return showError('请选择 PDF 格式的印刷乐谱。', () => ui.fileInput.click());
  }
  if (file.size > 20 * 1024 * 1024) {
    ui.fileInput.value = '';
    return showError('文件超过 20 MB，请选择更小的 PDF。', () => ui.fileInput.click());
  }
  retryAction = () => uploadFile(file);
  showJob({ status: 'queued', progress: 0, fileName: file.name, message: '正在安全地上传到识谱服务。' });
  try {
    const job = await fetchJson('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
    if (request !== activeRequest) return;
    await handleJob({ ...job, fileName: job.fileName || file.name }, request);
  } catch (error) {
    if (request === activeRequest) showError(`导入失败：${error.message}`, () => uploadFile(file));
  } finally {
    ui.fileInput.value = '';
  }
}

async function handleJob(job, request) {
  activeJob = job;
  if (job.status === 'error') throw new Error(job.message || '识谱未能完成');
  if (job.status === 'done') return loadCompletedJob(job, request);
  showJob(job);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (request !== activeRequest) return;
  const next = await fetchJson(`/api/jobs/${encodeURIComponent(job.id)}`);
  if (request !== activeRequest) return;
  return handleJob(next, request);
}

async function loadCompletedJob(job, request) {
  const xmlUrl = job.xmlUrl || `/api/jobs/${encodeURIComponent(job.id)}/score.musicxml`;
  const pdfUrl = job.pdfUrl || `/api/jobs/${encodeURIComponent(job.id)}/source.pdf`;
  const response = await fetch(xmlUrl);
  if (!response.ok) throw new Error(`MusicXML 读取失败（${response.status}）`);
  const source = await response.text();
  if (request !== activeRequest) return;
  const parsed = parseMusicXML(source);
  if (!parsed.notes?.length) throw new Error('识别结果中没有可播放的音符，请检查原谱或重新识别。');

  await renderScore(source, request);
  if (request !== activeRequest) return;
  xmlText = source;
  score = parsed;
  activeJob = job;
  await player.load(parsed);
  if (request !== activeRequest) return;
  player.setTempo(parsed.tempo || 96);
  player.setVolume(Number(ui.volumeRange.value) / 100);
  setPdfSource(pdfUrl);
  populateScore(job);
  setTab('score');
}

function configureEngraving(osmdInstance) {
  const rules = osmdInstance.EngravingRules;
  rules.FixedMeasureWidth = true;
  rules.FixedMeasureWidthUseForPickupMeasures = true;
  rules.StretchLastSystemLine = false;
  rules.LastSystemMaxScalingFactor = 1;
  rules.NewPartAndSystemAfterFinalBarline = true;
  rules.ShowRhythmAgainAfterPartEndOrFinalBarline = false;
}

function measuredFixedWidth(osmdInstance) {
  const widths = (osmdInstance.GraphicSheet?.MeasureList || []).flat()
    .map((measure) => measure?.minimumStaffEntriesWidth)
    .filter((width) => Number.isFinite(width) && width > 0);
  return widths.length ? Math.max(...widths) : 0;
}

function requiredScoreViewWidth(osmdInstance, measuresPerRow) {
  const rules = osmdInstance.EngravingRules;
  const systems = (osmdInstance.GraphicSheet?.MusicPages || []).flatMap((page) => page.MusicSystems || []);
  const measureWidths = (osmdInstance.GraphicSheet?.MeasureList || []).map((staffMeasures) => Math.max(0, ...staffMeasures
    .filter(Boolean)
    .map((measure) => measure.beginInstructionsWidth + measure.minimumStaffEntriesWidth + measure.endInstructionsWidth)));
  const rowWidths = [];
  for (let index = 0; index < measureWidths.length; index += measuresPerRow) {
    rowWidths.push(measureWidths.slice(index, index + measuresPerRow).reduce((sum, width) => sum + width, 0));
  }
  const labelWidth = Math.max(0, ...systems.map((system) => system.MaxLabelLength || 0)) + rules.SystemLabelsRightMargin;
  const systemWidth = Math.max(0, ...rowWidths) + labelWidth;
  const margins = rules.PageLeftMargin + rules.PageRightMargin + rules.SystemLeftMargin + rules.SystemRightMargin;
  return Math.ceil((systemWidth + margins) * 10 * (osmdInstance.Zoom || 1)) + 56;
}

function automaticScoreWidth() {
  const style = getComputedStyle(ui.dropZone);
  return Math.max(1, Math.min(900, ui.dropZone.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
}

function resizeAutomaticScore() {
  if (!osmd || !score || currentTab !== 'score' || ui.measuresPerRow.value !== 'auto' || ui.scoreView.hidden) return;
  const width = automaticScoreWidth();
  if (Math.abs(width - automaticLayoutWidth) < 1) return;
  const { scrollTop, scrollLeft } = ui.dropZone;
  osmd.setOptions({ followCursor: false });
  ui.scoreView.style.width = `${width}px`;
  automaticLayoutWidth = width;
  osmd.render();
  cursorBeat = -1;
  updatePlayback(player.currentBeat);
  updateCursorFollowing();
  ui.dropZone.scrollTo(scrollLeft, scrollTop);
}

async function renderScore(source, request, layoutRequest = ++layoutRenderRequest) {
  const measuresPerRow = ui.measuresPerRow.value === 'auto' ? 'auto' : Number(ui.measuresPerRow.value);
  const automatic = measuresPerRow === 'auto';
  const nextOsmd = new OpenSheetMusicDisplay(ui.osmdContainer, {
    autoResize: false,
    backend: 'svg',
    drawTitle: true,
    drawingParameters: 'compacttight',
    followCursor: false,
    newSystemFromXML: !automatic,
  });
  try {
    await nextOsmd.load(musicXmlWithSystemBreaks(source, measuresPerRow));
    if (request !== activeRequest || layoutRequest !== layoutRenderRequest) return;
    markMeasureRowEnds(nextOsmd.Sheet?.SourceMeasures, measuresPerRow);
    releaseOsmd();
    ui.osmdContainer.replaceChildren();
    ui.scoreView.style.minWidth = '';
    ui.scoreView.style.width = '';
    if (automatic) {
      automaticLayoutWidth = automaticScoreWidth();
      ui.scoreView.style.width = `${automaticLayoutWidth}px`;
    }
    ui.scoreView.classList.add('is-measuring');
    if (!automatic) configureEngraving(nextOsmd);
    nextOsmd.render();
    const fixedWidth = automatic ? 0 : measuredFixedWidth(nextOsmd);
    if (fixedWidth) {
      nextOsmd.EngravingRules.FixedMeasureWidthFixedValue = fixedWidth;
      const scoreViewWidth = `${requiredScoreViewWidth(nextOsmd, measuresPerRow)}px`;
      ui.scoreView.style.minWidth = scoreViewWidth;
      ui.scoreView.style.width = scoreViewWidth;
      nextOsmd.render();
    }
    osmd = nextOsmd;
    if (nextOsmd.cursor) {
      nextOsmd.cursor.show();
      nextOsmd.cursor.reset();
    }
  } catch (error) {
    throw new Error(`乐谱排版失败：${error.message}`);
  } finally {
    ui.scoreView.classList.remove('is-measuring');
  }
}

function setPdfSource(url) {
  ui.pdfFrame.src = url;
}

function populateScore(job) {
  const parsedTitle = score.title?.trim();
  const title = parsedTitle && parsedTitle !== '未命名乐谱' ? parsedTitle : (job.fileName || '未命名乐谱');
  const composer = score.composer?.trim() || '作曲者未标注';
  const bpm = Math.max(30, Math.min(240, Math.round(score.tempo || 96)));
  ui.scoreOrigin.textContent = activeJobSource === 'demo' ? '真实 PDF · 已缓存识别结果' : '真实 PDF · 本次识别结果';
  ui.scoreTitle.textContent = title;
  ui.scoreComposer.textContent = composer;
  ui.nowPlayingTitle.textContent = title;
  ui.nowPlayingDetail.textContent = `${composer} · ${score.parts?.length || 1} 个声部`;
  ui.timeSignature.textContent = score.timeSignature ? `${score.timeSignature.beats}/${score.timeSignature.beatType}` : '—';
  ui.keySignature.textContent = score.keySignature || '未标注';
  ui.measureCount.textContent = String(score.measures?.length || 0);
  const warnings = [...new Set([...(job.warnings || []), ...(score.warnings || [])].filter(Boolean))];
  ui.warningCount.textContent = warnings.length ? `${warnings.length} 项` : '无';
  ui.warningList.replaceChildren(...warnings.map((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    return item;
  }));
  ui.warningDetails.hidden = warnings.length === 0;
  ui.warningDetails.open = warnings.length > 0;
  setPracticeTip('识别提示', warnings[0] || 'OMR 可能有误差，请与原谱对照练习。', '♩');
  ui.scoreMeta.hidden = false;
  ui.exportButton.disabled = false;
  [ui.playButton, ui.stopButton, ui.forwardButton, ui.seekRange].forEach((element) => { element.disabled = false; });
  ui.totalMeasures.textContent = `/ ${score.measures?.length || '—'}`;
  setTempo(bpm);
  updatePlayback(0);
  updateSoundSourceLabel();
}

function resetLoadedState() {
  player.stop();
  releaseOsmd();
  score = null;
  xmlText = '';
  cursorBeat = -1;
  ui.scoreMeta.hidden = true;
  ui.warningDetails.hidden = true;
  ui.exportButton.disabled = true;
  [ui.playButton, ui.stopButton, ui.forwardButton, ui.seekRange].forEach((element) => { element.disabled = true; });
  setPlaying(false);
}

function releaseOsmd() {
  if (!osmd) return;
  try { osmd.setOptions?.({ autoResize: false }); } catch { /* Version-specific cleanup is best-effort. */ }
  try { osmd.clear?.(); } catch { /* The container is cleared before the next render. */ }
  osmd = undefined;
}

function setPlaying(playing) {
  ui.playButton.classList.toggle('is-playing', playing);
  ui.playButton.querySelector('span').textContent = playing ? 'Ⅱ' : '▶';
  ui.playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
  updateCursorFollowing();
}

function updatePlayback(beat) {
  if (!score) return;
  const currentBeat = Math.max(0, Math.min(score.totalBeats || 0, Number(beat) || 0));
  const ratio = score.totalBeats ? currentBeat / score.totalBeats : 0;
  ui.seekRange.value = String(Math.round(ratio * 1000));
  ui.currentTime.textContent = formatTime(estimatedSeconds(currentBeat));
  ui.totalTime.textContent = formatTime(estimatedSeconds(score.totalBeats));
  const measure = [...(score.measures || [])].reverse().find((item) => currentBeat >= item.startBeat)?.number || 1;
  ui.currentMeasure.textContent = String(measure);
  syncCursor(currentBeat);
}

function syncCursor(beat) {
  const cursor = osmd?.cursor;
  if (!cursor) return;
  try {
    syncCursorToBeat(cursor, beat, { reset: beat < cursorBeat || cursorBeat < 0 });
    cursorBeat = beat;
  } catch {
    cursor.hide();
  }
}

function setInstrumentSelection(instrumentId) {
  for (const item of ui.instrumentGroup.querySelectorAll('[data-instrument]')) {
    const selected = item.dataset.instrument === instrumentId;
    item.classList.toggle('is-active', selected);
    item.setAttribute('aria-checked', String(selected));
  }
}

function setTempo(value) {
  const bpm = Math.max(30, Math.min(240, Math.round(Number(value) || 96)));
  ui.tempoInput.value = String(bpm);
  ui.tempoRange.value = String(bpm);
  ui.tempoMark.textContent = `♩ = ${bpm}`;
  player.setTempo(bpm);
  if (score) updatePlayback(player.currentBeat);
}

function updateSoundSourceLabel(loading = false, reportedMode = '') {
  if (loading) return void (ui.soundSource.textContent = '正在加载音色…');
  const source = reportedMode || player.soundMode || player.soundSource || player.audioSource || player.instrumentSource || player.sourceType;
  if (source === 'sample' || source === 'sampled' || source === 'soundfont') ui.soundSource.textContent = '采样音色';
  else if (source === 'synth' || source === 'synthesized') ui.soundSource.textContent = '合成音色';
  else if (player.isUsingSamples === true) ui.soundSource.textContent = '采样音色';
  else if (player.isUsingSamples === false) ui.soundSource.textContent = '合成音色';
  else ui.soundSource.textContent = score ? '音源状态未知' : '等待乐谱';
}

function setPracticeTip(title, message, symbol = '♩') {
  ui.practiceTip.replaceChildren();
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = symbol;
  const copy = document.createElement('p');
  const heading = document.createElement('strong');
  heading.textContent = title;
  copy.append(heading, document.createTextNode(message));
  ui.practiceTip.append(icon, copy);
}

async function selectInstrument(button) {
  const id = button.dataset.instrument;
  const buttons = [...ui.instrumentGroup.querySelectorAll('[data-instrument]')];
  buttons.forEach((item) => { item.disabled = true; });
  updateSoundSourceLabel(true);
  try {
    await player.setInstrument(id);
    setInstrumentSelection(id);
    saveInstrument(undefined, id);
    updateSoundSourceLabel();
  } catch (error) {
    ui.soundSource.textContent = `音色加载失败`;
    setPracticeTip('音色未切换', error.message || '请稍后重试。', '!');
  } finally {
    buttons.forEach((item) => { item.disabled = false; });
  }
}

async function changeMeasuresPerRow() {
  const value = ui.measuresPerRow.value;
  saveMeasuresPerRow(undefined, value);
  if (!xmlText || !score) return;
  const request = ++layoutRenderRequest;
  const tab = currentTab;
  const scrollTop = ui.dropZone.scrollTop;
  const scrollLeft = ui.dropZone.scrollLeft;
  ui.measuresPerRow.disabled = true;
  try {
    await renderScore(xmlText, activeRequest, request);
    if (request !== layoutRenderRequest) return;
    cursorBeat = -1;
    updatePlayback(player.currentBeat);
    setTab(tab);
    ui.dropZone.scrollTo(scrollLeft, scrollTop);
  } catch (error) {
    setPracticeTip('排版未更新', error.message || '请稍后重试。', '!');
  } finally {
    if (request === layoutRenderRequest) ui.measuresPerRow.disabled = false;
  }
}

function exportXml() {
  if (!xmlText) return;
  const blob = new Blob([xmlText], { type: 'application/vnd.recordare.musicxml+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const base = (score.title || activeJob?.fileName || 'score').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-');
  link.href = url;
  link.download = `${base}.musicxml`;
  link.click();
  URL.revokeObjectURL(url);
}

ui.uploadButton.addEventListener('click', () => ui.fileInput.click());
ui.emptyUploadButton.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => uploadFile(ui.fileInput.files[0]));
ui.demoButton.addEventListener('click', loadDemo);
ui.emptyDemoButton.addEventListener('click', loadDemo);
ui.retryButton.addEventListener('click', () => retryAction?.());
ui.scoreTab.addEventListener('click', () => setTab('score'));
ui.pdfTab.addEventListener('click', () => setTab('pdf'));
ui.exportButton.addEventListener('click', exportXml);
ui.measuresPerRow.addEventListener('change', changeMeasuresPerRow);
ui.instrumentGroup.addEventListener('click', (event) => { const button = event.target.closest('[data-instrument]'); if (button) selectInstrument(button); });
ui.tempoRange.addEventListener('input', () => setTempo(ui.tempoRange.value));
ui.tempoInput.addEventListener('change', () => setTempo(ui.tempoInput.value));
ui.tempoDown.addEventListener('click', () => setTempo(Number(ui.tempoInput.value) - 2));
ui.tempoUp.addEventListener('click', () => setTempo(Number(ui.tempoInput.value) + 2));
ui.volumeRange.addEventListener('input', () => { ui.volumeValue.textContent = `${ui.volumeRange.value}%`; player.setVolume(Number(ui.volumeRange.value) / 100); });
ui.metronomeToggle.addEventListener('click', () => {
  const enabled = ui.metronomeToggle.getAttribute('aria-checked') !== 'true';
  ui.metronomeToggle.setAttribute('aria-checked', String(enabled));
  ui.metronomeToggle.querySelector('em').textContent = enabled ? '开启' : '关闭';
  player.setMetronome(enabled);
});
ui.playButton.addEventListener('click', async () => {
  if (!score) return;
  try {
    if (player.isPlaying) player.pause(); else await player.play();
    setPlaying(player.isPlaying);
    updateSoundSourceLabel();
  } catch (error) {
    showError(`播放失败：${error.message}`, null);
  }
});
ui.stopButton.addEventListener('click', () => { player.stop(); setPlaying(false); updatePlayback(0); });
ui.forwardButton.addEventListener('click', () => {
  if (!score) return;
  const next = score.measures?.find((measure) => measure.startBeat > player.currentBeat + 0.05);
  player.seek(next?.startBeat ?? score.totalBeats);
  updatePlayback(player.currentBeat);
});
ui.seekRange.addEventListener('input', () => {
  if (!score) return;
  const beat = (Number(ui.seekRange.value) / 1000) * score.totalBeats;
  player.seek(beat);
  updatePlayback(beat);
});

for (const eventName of ['dragenter', 'dragover']) {
  ui.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); ui.dropOverlay.classList.add('is-visible'); });
  ui.uploadButton.addEventListener(eventName, (event) => { event.preventDefault(); ui.uploadButton.classList.add('is-dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  ui.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); if (eventName === 'drop' || !ui.dropZone.contains(event.relatedTarget)) ui.dropOverlay.classList.remove('is-visible'); });
  ui.uploadButton.addEventListener(eventName, (event) => { event.preventDefault(); if (eventName === 'drop' || !ui.uploadButton.contains(event.relatedTarget)) ui.uploadButton.classList.remove('is-dragging'); });
}
ui.dropZone.addEventListener('drop', (event) => uploadFile(event.dataTransfer.files[0]));
ui.uploadButton.addEventListener('drop', (event) => uploadFile(event.dataTransfer.files[0]));
let scoreResizeFrame = 0;
const scoreResizeObserver = new ResizeObserver(() => {
  if (scoreResizeFrame) return;
  scoreResizeFrame = requestAnimationFrame(() => {
    scoreResizeFrame = 0;
    resizeAutomaticScore();
  });
});
scoreResizeObserver.observe(ui.dropZone);
window.addEventListener('beforeunload', () => {
  activeRequest++;
  scoreResizeObserver.disconnect();
  cancelAnimationFrame(scoreResizeFrame);
  player.dispose();
});

checkHealth();

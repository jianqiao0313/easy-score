import { parseMusicXML } from './musicxml.mjs';
import { ScoreRenderer } from './score-renderer.mjs';
import { ScoreImporter, fetchJson } from './score-importer.mjs';
import { createPlaybackControls } from './playback-controls.mjs';
import { loadPreferences, saveMeasuresPerRow } from './preferences.mjs';
import { renderIcon, renderIcons } from './icons.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);
const ui = {
  engineDot: $('#engineDot'), engineStatus: $('#engineStatus'), uploadButton: $('#uploadButton'), emptyUploadButton: $('#emptyUploadButton'), fileInput: $('#fileInput'),
  historyList: $('#historyList'), historyCount: $('#historyCount'), historyStatus: $('#historyStatus'), historyRetry: $('#historyRetry'), historyItemTemplate: $('#historyItemTemplate'),
  dropZone: $('#dropZone'), dropOverlay: $('#dropOverlay'), emptyState: $('#emptyState'),
  processingState: $('#processingState'), errorState: $('#errorState'), errorMessage: $('#errorMessage'), retryButton: $('#retryButton'), progressNumber: $('#progressNumber'),
  progressBar: $('#progressBar'), jobStatusLabel: $('#jobStatusLabel'), jobStatusTitle: $('#jobStatusTitle'), jobStatusMessage: $('#jobStatusMessage'), scoreView: $('#scoreView'),
  pdfView: $('#pdfView'), pdfFrame: $('#pdfFrame'), sourceImage: $('#sourceImage'), sourceTabLabel: $('#sourceTabLabel'), osmdContainer: $('#osmdContainer'), scoreTab: $('#scoreTab'), pdfTab: $('#pdfTab'),
  exportButton: $('#exportButton'), scoreOrigin: $('#scoreOrigin'), scoreTitle: $('#scoreTitle'), scoreComposer: $('#scoreComposer'), scoreMeta: $('#scoreMeta'),
  measuresPerRow: $('#measuresPerRow'),
  timeSignature: $('#timeSignature'), keySignature: $('#keySignature'), measureCount: $('#measureCount'), warningCount: $('#warningCount'), soundSource: $('#soundSource'),
  warningDetails: $('#warningDetails'), warningList: $('#warningList'),
  instrumentGroup: $('#instrumentGroup'), tempoInput: $('#tempoInput'), tempoRange: $('#tempoRange'), tempoDown: $('#tempoDown'), tempoUp: $('#tempoUp'), tempoMark: $('#tempoMark'),
  metronomeToggle: $('#metronomeToggle'), volumeRange: $('#volumeRange'), volumeValue: $('#volumeValue'), volumeDown: $('#volumeDown'), volumeUp: $('#volumeUp'), practiceTip: $('#practiceTip'), playButton: $('#playButton'),
  previousButton: $('#previousButton'), forwardButton: $('#forwardButton'), seekRange: $('#seekRange'), currentTime: $('#currentTime'), totalTime: $('#totalTime'),
  currentMeasure: $('#currentMeasure'), totalMeasures: $('#totalMeasures'), nowPlayingTitle: $('#nowPlayingTitle'), nowPlayingDetail: $('#nowPlayingDetail'),
};

renderIcons(document);
renderIcons(ui.historyItemTemplate.content);

let score;
let xmlText = '';
let activeJob = null;
let activeJobSource = null;
let activeRequest = 0;
let retryAction = null;
let currentTab = 'score';
let layoutRenderRequest = 0;
let historyRequest = 0;
const preferences = loadPreferences();
const scoreFontReady = Promise.all([
  document.fonts.load('400 16px "Source Han Sans CN VF"'),
  document.fonts.load('600 16px "Source Han Sans CN VF"'),
]).catch(() => {}); // A font download failure should not prevent playing a score.

const renderer = new ScoreRenderer({ scoreView: ui.scoreView, container: ui.osmdContainer, viewport: ui.dropZone, fontReady: scoreFontReady });
const importer = new ScoreImporter();
const { player, setPlaying, updatePlayback, setTempo, updateSoundSourceLabel } = createPlaybackControls({
  ui,
  instrumentId: preferences.instrumentId,
  getScore: () => score,
  onPosition: (beat) => renderer.syncCursor(beat),
  onPlayingChange: () => updateCursorFollowing(),
  onError: (message) => showError(message, null),
  onTip: setPracticeTip,
});

ui.measuresPerRow.value = String(preferences.measuresPerRow);

function setView(view) {
  ['emptyState', 'processingState', 'errorState', 'scoreView', 'pdfView'].forEach((key) => { ui[key].hidden = true; });
  if (view === 'loaded') ui[currentTab === 'score' ? 'scoreView' : 'pdfView'].hidden = false;
  else ui[view].hidden = false;
}

function setTab(tab) {
  if (tab === 'pdf' && (ui.pdfTab.hidden || ui.pdfTab.disabled)) return;
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
  renderer.setFollowing(Boolean(player?.isPlaying && currentTab === 'score'));
}

function showError(message, action) {
  retryAction = action;
  ui.errorMessage.textContent = message || '请稍后重试，或换一份清晰的印刷乐谱。';
  ui.retryButton.hidden = !action;
  setView('errorState');
}

function statusCopy(job) {
  if (job.status === 'loading') return ['历史乐谱', '正在打开乐谱', '正在读取本地保存的识别结果。'];
  if (job.sourceType === 'musicxml') return ['正在导入', '正在读取 MusicXML 乐谱', job.message || '正在解析音符与排版。'];
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
  ui.scoreOrigin.textContent = activeJobSource === 'history' ? '本地历史乐谱' : '本次导入';
  ui.scoreTitle.textContent = job.fileName || '正在读取乐谱';
  ui.scoreComposer.textContent = job.sourceType === 'musicxml' ? `${progress}% · 正在读取乐谱文件` : `${progress}% · 识别结果请对照原谱校验`;
  setView('processingState');
}

async function checkHealth() {
  try {
    const health = await fetchJson('/api/health');
    const available = Boolean(health.engine?.available);
    ui.engineDot.classList.toggle('is-online', available);
    ui.engineDot.classList.toggle('is-warning', !available);
    ui.engineStatus.textContent = available ? `${health.engine.name || '识谱引擎'} 已就绪` : (health.engine?.message || '识谱引擎不可用');
  } catch {
    ui.engineDot.classList.add('is-warning');
    ui.engineStatus.textContent = '暂时无法连接识谱服务';
  }
}

function updateHistorySelection() {
  for (const button of ui.historyList.querySelectorAll('[data-score-id]')) {
    const selected = Boolean(score && button.dataset.scoreId === activeJob?.id);
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

async function refreshHistory() {
  const request = ++historyRequest;
  ui.historyRetry.hidden = true;
  try {
    const { scores } = await fetchJson('/api/scores');
    if (request !== historyRequest) return;
    if (!Array.isArray(scores)) throw new Error('历史乐谱数据格式错误');
    const items = scores.map((job) => {
      const item = ui.historyItemTemplate.content.cloneNode(true);
      const button = item.querySelector('button');
      button.dataset.scoreId = job.id;
      button.title = job.fileName;
      item.querySelector('strong').textContent = job.fileName;
      const date = new Date(job.createdAt);
      const status = job.sourceType === 'musicxml' ? '已导入' : '已识别';
      item.querySelector('small').textContent = Number.isFinite(date.getTime()) ? `${date.toLocaleDateString('zh-CN')} · ${status}` : status;
      button.addEventListener('click', () => loadHistoryScore(job));
      return item;
    });
    ui.historyList.replaceChildren(...items);
    ui.historyCount.textContent = String(scores.length);
    ui.historyStatus.textContent = '暂无历史乐谱，成功导入后会显示在这里。';
    ui.historyStatus.hidden = scores.length > 0;
    updateHistorySelection();
  } catch {
    if (request !== historyRequest) return;
    ui.historyStatus.textContent = '历史乐谱读取失败，请重试。';
    ui.historyStatus.hidden = false;
    ui.historyRetry.hidden = false;
  }
}

async function loadHistoryScore(entry) {
  if (score && activeJob?.id === entry.id) return setTab('score');
  const request = ++activeRequest;
  const retry = () => loadHistoryScore(entry);
  retryAction = retry;
  resetLoadedState();
  activeJobSource = 'history';
  showJob({ status: 'loading', progress: 100, fileName: entry.fileName });
  try {
    const { job, xml } = await importer.open(entry.id);
    if (request !== activeRequest) return;
    await loadCompletedJob(job, xml, request);
  } catch (error) {
    if (request === activeRequest) showError(`历史乐谱打开失败：${error.message}`, retry);
    void refreshHistory();
  }
}

async function uploadFile(file) {
  if (!file) return;
  const request = ++activeRequest;
  resetLoadedState();
  activeJobSource = 'upload';
  retryAction = () => uploadFile(file);
  try {
    const { job, xml } = await importer.upload(file, {
      onProgress: (job) => {
        if (request !== activeRequest) return;
        showJob(job);
        if (job.status === 'done') void refreshHistory();
      },
    });
    if (request !== activeRequest) return;
    await loadCompletedJob(job, xml, request);
  } catch (error) {
    if (request === activeRequest) {
      const retry = error.code === 'INVALID_UPLOAD' ? () => ui.fileInput.click() : () => uploadFile(file);
      showError(`导入失败：${error.message}`, retry);
    }
  } finally {
    if (request === activeRequest) ui.fileInput.value = '';
  }
}

async function loadCompletedJob(job, source, request) {
  if (request !== activeRequest) return;
  const parsed = parseMusicXML(source);
  if (!parsed.notes?.length) throw new Error('识别结果中没有可播放的音符，请检查原谱或重新识别。');

  ui.measuresPerRow.disabled = true;
  let rendered;
  try {
    rendered = await renderScore(source, request);
  } finally {
    if (request === activeRequest) ui.measuresPerRow.disabled = false;
  }
  if (!rendered || request !== activeRequest) return;
  saveMeasuresPerRow(undefined, renderer.layout);
  xmlText = source;
  score = parsed;
  activeJob = job;
  await player.load(parsed);
  if (request !== activeRequest) return;
  player.setTempo(parsed.tempo || 96);
  player.setVolume(Number(ui.volumeRange.value) / 100);
  setOriginalSource(job);
  populateScore(job);
  updateHistorySelection();
  setTab('score');
}

async function resizeAutomaticScore() {
  if (!renderer.instance || renderer.pending || !score || currentTab !== 'score' || ui.measuresPerRow.value !== 'auto' || ui.scoreView.hidden) return;
  if (Math.abs(renderer.automaticWidth() - renderer.width) < 1) return;
  const { scrollTop, scrollLeft } = ui.dropZone;
  const request = activeRequest;
  try {
    if (!await renderScore(xmlText, request)) return;
    updatePlayback(player.currentBeat);
    updateCursorFollowing();
    ui.dropZone.scrollTo(scrollLeft, scrollTop);
  } catch (error) {
    if (request === activeRequest) setPracticeTip('排版未更新', error.message, 'warning');
  }
}

function renderScore(source, request, layoutRequest = ++layoutRenderRequest) {
  const measuresPerRow = ui.measuresPerRow.value === 'auto' ? 'auto' : Number(ui.measuresPerRow.value);
  return renderer.render(source, {
    measuresPerRow,
    isCurrent: () => request === activeRequest && layoutRequest === layoutRenderRequest,
  });
}

function setOriginalSource(job) {
  const type = job.sourceType || 'pdf';
  ui.pdfFrame.removeAttribute('src');
  ui.sourceImage.removeAttribute('src');
  ui.pdfFrame.hidden = type !== 'pdf';
  ui.sourceImage.hidden = type !== 'image';
  ui.pdfTab.hidden = type === 'musicxml';
  ui.pdfTab.disabled = type === 'musicxml';
  if (type === 'musicxml') return;
  const url = job.sourceUrl || job.pdfUrl || `/api/jobs/${encodeURIComponent(job.id)}/source.pdf`;
  ui.sourceTabLabel.textContent = type === 'image' ? '原始图片' : '原始 PDF';
  renderIcon(ui.pdfTab.querySelector('[data-icon]'), type === 'image' ? 'image' : 'pdf');
  if (type === 'image') ui.sourceImage.src = url;
  else ui.pdfFrame.src = url;
}

function populateScore(job) {
  const parsedTitle = score.title?.trim();
  const title = parsedTitle && parsedTitle !== '未命名乐谱' ? parsedTitle : (job.fileName || '未命名乐谱');
  const composer = score.composer?.trim() || '作曲者未标注';
  const bpm = Math.max(30, Math.min(240, Math.round(score.tempo || 96)));
  const sourceLabel = { pdf: 'PDF', image: '图片', musicxml: 'MusicXML' }[job.sourceType || 'pdf'];
  ui.scoreOrigin.textContent = `${sourceLabel} · ${activeJobSource === 'history' ? '本地历史乐谱' : '本次导入'}`;
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
  setPracticeTip(job.sourceType === 'musicxml' ? '练习提示' : '识别提示', warnings[0] || (job.sourceType === 'musicxml' ? 'MusicXML 已载入，可调整速度、选择音色或从任意小节开始练习。' : 'OMR 可能有误差，请与原谱对照练习。'));
  ui.scoreMeta.hidden = false;
  ui.exportButton.disabled = false;
  [ui.playButton, ui.previousButton, ui.forwardButton, ui.seekRange].forEach((element) => { element.disabled = false; });
  ui.totalMeasures.textContent = `/ ${score.measures?.length || '—'}`;
  setTempo(bpm);
  updatePlayback(0);
  updateSoundSourceLabel();
}

function resetLoadedState() {
  player.stop();
  renderer.clear();
  layoutRenderRequest++;
  ui.measuresPerRow.disabled = false;
  score = null;
  activeJob = null;
  updateHistorySelection();
  xmlText = '';
  ui.scoreMeta.hidden = true;
  ui.warningDetails.hidden = true;
  ui.exportButton.disabled = true;
  ui.pdfTab.disabled = true;
  ui.pdfFrame.removeAttribute('src');
  ui.sourceImage.removeAttribute('src');
  [ui.playButton, ui.previousButton, ui.forwardButton, ui.seekRange].forEach((element) => { element.disabled = true; });
  setPlaying(false);
}

function setPracticeTip(title, message, iconName = 'info') {
  ui.practiceTip.replaceChildren();
  const icon = document.createElement('span');
  renderIcon(icon, iconName);
  const copy = document.createElement('p');
  const heading = document.createElement('strong');
  heading.textContent = title;
  copy.append(heading, document.createTextNode(message));
  ui.practiceTip.append(icon, copy);
}

async function changeMeasuresPerRow() {
  const value = ui.measuresPerRow.value;
  if (!xmlText || !score) return void saveMeasuresPerRow(undefined, value);
  const previousValue = renderer.layout;
  const request = ++layoutRenderRequest;
  const tab = currentTab;
  const { scrollTop, scrollLeft } = ui.dropZone;
  ui.measuresPerRow.disabled = true;
  try {
    if (!await renderScore(xmlText, activeRequest, request)) return;
    saveMeasuresPerRow(undefined, value);
    updatePlayback(player.currentBeat);
    setTab(tab);
    ui.dropZone.scrollTo(scrollLeft, scrollTop);
  } catch (error) {
    if (request !== layoutRenderRequest) return;
    ui.measuresPerRow.value = String(previousValue);
    setPracticeTip('排版未更新', error.message || '请稍后重试。', 'warning');
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
ui.historyRetry.addEventListener('click', refreshHistory);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshHistory(); });
ui.retryButton.addEventListener('click', () => retryAction?.());
ui.scoreTab.addEventListener('click', () => setTab('score'));
ui.pdfTab.addEventListener('click', () => setTab('pdf'));
ui.exportButton.addEventListener('click', exportXml);
ui.measuresPerRow.addEventListener('change', changeMeasuresPerRow);
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
  importer.cancel();
  renderer.clear();
  scoreResizeObserver.disconnect();
  cancelAnimationFrame(scoreResizeFrame);
  player.dispose();
});

checkHealth();
void refreshHistory();

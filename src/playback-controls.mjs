import { ScorePlayer } from './audio.mjs';
import { renderIcon } from './icons.js';
import { saveInstrument } from './preferences.mjs';

export function createPlaybackControls({
  ui,
  instrumentId,
  getScore,
  onPosition = () => {},
  onPlayingChange = () => {},
  onError = () => {},
  onTip = () => {},
}) {
  let player;

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  function estimatedSeconds(beat, bpm = Number(ui.tempoInput.value)) {
    return (Math.max(0, beat) * 60) / Math.max(1, bpm);
  }

  function setPlaying(playing) {
    ui.playButton.classList.toggle('is-playing', playing);
    renderIcon(ui.playButton.querySelector('[data-icon]'), playing ? 'pause' : 'play');
    ui.playButton.setAttribute('aria-label', playing ? '暂停' : '播放');
    ui.playButton.title = playing ? '暂停' : '播放';
    onPlayingChange(playing);
  }

  function updatePlayback(beat) {
    const score = getScore();
    if (!score) return;
    const currentBeat = Math.max(0, Math.min(score.totalBeats || 0, Number(beat) || 0));
    const ratio = score.totalBeats ? currentBeat / score.totalBeats : 0;
    ui.seekRange.value = String(Math.round(ratio * 1000));
    ui.currentTime.textContent = formatTime(estimatedSeconds(currentBeat));
    ui.totalTime.textContent = formatTime(estimatedSeconds(score.totalBeats));
    const measure = [...(score.measures || [])].reverse().find((item) => currentBeat >= item.startBeat)?.number || 1;
    ui.currentMeasure.textContent = String(measure);
    onPosition(currentBeat);
  }

  function setInstrumentSelection(selectedInstrumentId) {
    for (const item of ui.instrumentGroup.querySelectorAll('[data-instrument]')) {
      const selected = item.dataset.instrument === selectedInstrumentId;
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
    if (getScore()) updatePlayback(player.currentBeat);
  }

  function setVolume(value) {
    const volume = Math.max(0, Math.min(100, Number(value) || 0));
    ui.volumeRange.value = String(volume);
    ui.volumeValue.textContent = `${volume}%`;
    player.setVolume(volume / 100);
  }

  function updateSoundSourceLabel(loading = false, reportedMode = '') {
    if (loading) return void (ui.soundSource.textContent = '正在加载音色…');
    const source = reportedMode || player.soundMode || player.soundSource || player.audioSource || player.instrumentSource || player.sourceType;
    if (source === 'sample' || source === 'sampled' || source === 'soundfont') ui.soundSource.textContent = '采样音色';
    else if (source === 'mixed') ui.soundSource.textContent = '采样音色 · 部分音符使用合成';
    else if (source === 'synth' || source === 'synthesized') ui.soundSource.textContent = '合成音色';
    else if (player.isUsingSamples === true) ui.soundSource.textContent = '采样音色';
    else if (player.isUsingSamples === false) ui.soundSource.textContent = '合成音色';
    else ui.soundSource.textContent = getScore() ? '音源状态未知' : '等待乐谱';
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
      ui.soundSource.textContent = '音色加载失败';
      onTip('音色未切换', error.message || '请稍后重试。', 'warning');
    } finally {
      buttons.forEach((item) => { item.disabled = false; });
    }
  }

  player = new ScorePlayer({
    instrumentId,
    onPosition: updatePlayback,
    onEnded: () => {
      setPlaying(false);
      updatePlayback(getScore()?.totalBeats || 0);
    },
    onStatus: ({ soundMode, message }) => {
      updateSoundSourceLabel(false, soundMode);
      if (message && (soundMode === 'synthesized' || soundMode === 'mixed')) onTip('音源提示', message, 'warning');
    },
  });

  setInstrumentSelection(instrumentId);
  setVolume(ui.volumeRange.value);

  ui.instrumentGroup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-instrument]');
    if (button) void selectInstrument(button);
  });
  ui.tempoRange.addEventListener('input', () => setTempo(ui.tempoRange.value));
  ui.tempoInput.addEventListener('change', () => setTempo(ui.tempoInput.value));
  ui.tempoDown.addEventListener('click', () => setTempo(Number(ui.tempoInput.value) - 2));
  ui.tempoUp.addEventListener('click', () => setTempo(Number(ui.tempoInput.value) + 2));
  ui.volumeRange.addEventListener('input', () => setVolume(ui.volumeRange.value));
  ui.volumeDown.addEventListener('click', () => setVolume(Number(ui.volumeRange.value) - 10));
  ui.volumeUp.addEventListener('click', () => setVolume(Number(ui.volumeRange.value) + 10));
  ui.metronomeToggle.addEventListener('click', () => {
    const enabled = ui.metronomeToggle.getAttribute('aria-checked') !== 'true';
    ui.metronomeToggle.setAttribute('aria-checked', String(enabled));
    ui.metronomeToggle.querySelector('em').textContent = enabled ? '开启' : '关闭';
    player.setMetronome(enabled);
  });
  ui.playButton.addEventListener('click', async () => {
    const score = getScore();
    if (!score) return;
    try {
      if (player.isPlaying) player.pause(); else await player.play();
      if (getScore() !== score) return;
      setPlaying(player.isPlaying);
      updateSoundSourceLabel();
    } catch (error) {
      if (getScore() !== score) return;
      onError(`播放失败：${error.message}`);
    }
  });
  ui.previousButton.addEventListener('click', () => {
    if (!getScore()) return;
    player.previousMeasure();
    updatePlayback(player.currentBeat);
  });
  ui.forwardButton.addEventListener('click', () => {
    const score = getScore();
    if (!score) return;
    const next = score.measures?.find((measure) => measure.startBeat > player.currentBeat + 0.05);
    player.seek(next?.startBeat ?? score.totalBeats);
    updatePlayback(player.currentBeat);
  });
  ui.seekRange.addEventListener('input', () => {
    const score = getScore();
    if (!score) return;
    const beat = (Number(ui.seekRange.value) / 1000) * score.totalBeats;
    player.seek(beat);
    updatePlayback(beat);
  });

  return { player, setPlaying, updatePlayback, setTempo, setVolume, updateSoundSourceLabel };
}

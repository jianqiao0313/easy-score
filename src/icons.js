import Upload from '@icon-park/svg/es/icons/UploadOne.js';
import Download from '@icon-park/svg/es/icons/DownloadOne.js';
import Refresh from '@icon-park/svg/es/icons/Refresh.js';
import FileMusic from '@icon-park/svg/es/icons/FileMusic.js';
import FilePdf from '@icon-park/svg/es/icons/FilePdf.js';
import Pic from '@icon-park/svg/es/icons/Pic.js';
import Right from '@icon-park/svg/es/icons/Right.js';
import Info from '@icon-park/svg/es/icons/Info.js';
import Attention from '@icon-park/svg/es/icons/Attention.js';
import Piano from '@icon-park/svg/es/icons/Piano.js';
import MusicOne from '@icon-park/svg/es/icons/MusicOne.js';
import Minus from '@icon-park/svg/es/icons/Minus.js';
import Plus from '@icon-park/svg/es/icons/Plus.js';
import VolumeDown from '@icon-park/svg/es/icons/VolumeDown.js';
import VolumeUp from '@icon-park/svg/es/icons/VolumeUp.js';
import GoStart from '@icon-park/svg/es/icons/GoStart.js';
import GoEnd from '@icon-park/svg/es/icons/GoEnd.js';
import PlayOne from '@icon-park/svg/es/icons/PlayOne.js';
import Pause from '@icon-park/svg/es/icons/Pause.js';

// Original saxophone outline: IconPark does not provide this instrument.
function Saxophone() {
  return `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M30 7h7l3 3-3 3h-6c-2 0-3 1-4 4l-7 20c-2 5-7 7-11 4S5 33 7 29l2-4 8 4-2 5c-1 2 0 3 1 3s2-1 2-2l6-20c1-5 3-8 6-8Z"/>
    <path d="m7 24 12 5M32 7v6M23 20l4 1M21 26l4 1M19 32l4 1"/>
  </svg>`;
}

const icons = {
  upload: Upload, download: Download, refresh: Refresh, score: FileMusic, pdf: FilePdf, image: Pic,
  right: Right, info: Info, warning: Attention, piano: Piano, music: MusicOne,
  saxophone: Saxophone, minus: Minus, plus: Plus, 'volume-low': VolumeDown, 'volume-high': VolumeUp,
  previous: GoStart, next: GoEnd, play: PlayOne, pause: Pause,
};

export function renderIcon(element, name) {
  element.classList.add('icon');
  element.dataset.icon = name;
  element.setAttribute('aria-hidden', 'true');
  // Only bundled icon factories produce this markup; no score or user content is inserted.
  element.innerHTML = icons[name]({
    theme: name === 'play' ? 'filled' : 'outline', size: '1em', fill: 'currentColor', strokeWidth: 3,
  }).replace(/<\?xml[^>]*\?>/, '');
  element.querySelector('svg').setAttribute('focusable', 'false');
}

export function renderIcons(root) {
  for (const element of root.querySelectorAll('[data-icon]')) renderIcon(element, element.dataset.icon);
}

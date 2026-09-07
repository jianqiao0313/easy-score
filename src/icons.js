import Upload from '@icon-park/svg/es/icons/Upload.js';
import Download from '@icon-park/svg/es/icons/Download.js';
import Refresh from '@icon-park/svg/es/icons/Refresh.js';
import FileMusic from '@icon-park/svg/es/icons/FileMusic.js';
import FilePdf from '@icon-park/svg/es/icons/FilePdf.js';
import Right from '@icon-park/svg/es/icons/Right.js';
import Info from '@icon-park/svg/es/icons/Info.js';
import Attention from '@icon-park/svg/es/icons/Attention.js';
import Piano from '@icon-park/svg/es/icons/Piano.js';
import MusicOne from '@icon-park/svg/es/icons/MusicOne.js';
import Minus from '@icon-park/svg/es/icons/Minus.js';
import Plus from '@icon-park/svg/es/icons/Plus.js';
import VolumeSmall from '@icon-park/svg/es/icons/VolumeSmall.js';
import VolumeNotice from '@icon-park/svg/es/icons/VolumeNotice.js';
import GoStart from '@icon-park/svg/es/icons/GoStart.js';
import GoEnd from '@icon-park/svg/es/icons/GoEnd.js';
import PlayOne from '@icon-park/svg/es/icons/PlayOne.js';
import Pause from '@icon-park/svg/es/icons/Pause.js';

const icons = {
  upload: Upload, download: Download, refresh: Refresh, score: FileMusic, pdf: FilePdf,
  right: Right, info: Info, warning: Attention, piano: Piano, music: MusicOne,
  minus: Minus, plus: Plus, 'volume-low': VolumeSmall, 'volume-high': VolumeNotice,
  previous: GoStart, next: GoEnd, play: PlayOne, pause: Pause,
};

export function renderIcon(element, name) {
  element.classList.add('icon');
  element.dataset.icon = name;
  element.setAttribute('aria-hidden', 'true');
  // Only bundled IconPark factories produce this markup; no score or user content is inserted.
  element.innerHTML = icons[name]({
    theme: name === 'play' ? 'filled' : 'outline', size: '1em', fill: 'currentColor', strokeWidth: 3,
  }).replace(/<\?xml[^>]*\?>/, '');
  element.querySelector('svg').setAttribute('focusable', 'false');
}

export function renderIcons(root) {
  for (const element of root.querySelectorAll('[data-icon]')) renderIcon(element, element.dataset.icon);
}

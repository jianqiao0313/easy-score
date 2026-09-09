"""Regenerate the sax sample map and sustain loops; requires ffmpeg, no Python packages.

Run from any directory: python3 scripts/prepare-saxophone.py
MP3s remain byte-for-byte upstream copies. Work on decoded mono audio only to
locate phase/level-matched loop boundaries in the middle of each sustained note.
"""

import array
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_DIR = ROOT / 'public/soundfonts/saxophone'
SAMPLE_RATE = 44100
FLATS = {'Cs': 'Db', 'Ds': 'Eb', 'Fs': 'Gb', 'Gs': 'Ab', 'As': 'Bb'}


def sample_entry(file):
    raw = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(file), '-f', 'f32le',
        '-ac', '1', '-ar', str(SAMPLE_RATE), '-',
    ])
    channel = array.array('f', raw)
    # Avoid tonguing at the beginning and breath/release at the end. Compare
    # 10ms either side, so matching a single zero crossing is not sufficient.
    target = int(len(channel) * 0.3)
    # Join rising zero crossings to keep the seam continuous even when the
    # best overall waveform match has a slightly different amplitude.
    def rising(frame):
        return channel[frame - 1] <= 0 < channel[frame]

    start = next(frame for frame in range(target, target + int(SAMPLE_RATE * 0.03)) if rising(frame))
    radius = int(SAMPLE_RATE * 0.01)
    offsets = range(-radius, radius + 1, 8)
    reference = [channel[start + offset] for offset in offsets]
    end = min(
        (frame for frame in range(int(len(channel) * 0.55), int(len(channel) * 0.72)) if rising(frame)),
        key=lambda candidate: sum(
            (value - channel[candidate + offset]) ** 2
            for offset, value in zip(offsets, reference)
        ),
    )
    return {
        'url': f'/soundfonts/saxophone/{file.name}',
        'loop': {'start': round(start / SAMPLE_RATE, 6), 'end': round(end / SAMPLE_RATE, 6)},
    }


def main():
    files = sorted(SAMPLE_DIR.glob('*.mp3'))
    if len(files) != 32:
        raise ValueError(f'Expected 32 upstream saxophone samples, got {len(files)}')
    sample_map = {}
    for file in files:
        note = file.stem
        name = FLATS.get(note[:-1], note[:-1]) + note[-1]
        sample_map[name] = sample_entry(file)
    (SAMPLE_DIR.parent / 'saxophone.json').write_text(json.dumps(sample_map, indent=2) + '\n')
    print(f'Prepared {len(sample_map)} local samples with sustain loops')


if __name__ == '__main__':
    main()

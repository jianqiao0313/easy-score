# Saxophone sample source

- Instrument label: saxophone
- Upstream distribution: `nbrosowsky/tonejs-instruments`, `samples/saxophone/`
- Pinned upstream commit: `622c2f1c32c8cfce4158ddc3eb26e518ddef37e5`
- Pinned source URL: <https://github.com/nbrosowsky/tonejs-instruments/tree/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5/samples/saxophone>
- Upstream source record: <https://github.com/nbrosowsky/tonejs-instruments/blob/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5/sample-source-info.txt>
- Upstream project and license statement: <https://github.com/nbrosowsky/tonejs-instruments/tree/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5>
- License: Creative Commons Attribution 3.0 Unported (CC BY 3.0)
- Canonical license URL: <https://creativecommons.org/licenses/by/3.0/>

The 32 MP3 files in this directory were copied byte-for-byte from the pinned
`tonejs-instruments` commit. Easy Score made no changes to the MP3 bytes. File
integrity is recorded in `SHA256SUMS`, and the complete license text is in
`LICENSE-CC-BY-3.0.txt`.

The pinned upstream source record attributes the saxophone samples to
Karoryfer. It does not identify an individual performer or recording author,
and it does not establish that these particular files are recordings of an
alto saxophone. Easy Score therefore labels the instrument simply
"saxophone" and makes no more specific authorship or instrument claim.

Attribution: "Saxophone samples from Karoryfer, redistributed and edited by
Nicholaus P. Brosowsky / the tonejs-instruments project, licensed under CC BY 3.0."

The sampled roots are `Cs3`, `D3`, `Ds3`, `E3`, `F3`, `Fs3`, `G3`, `Gs3`,
`As3`, `B3`, `C4`, `Cs4`, `D4`, `Ds4`, `E4`, `F4`, `Fs4`, `G4`, `Gs4`, `A4`,
`As4`, `B4`, `C5`, `Cs5`, `D5`, `Ds5`, `E5`, `F5`, `Fs5`, `G5`, `Gs5`, and
`A5`. Filenames use `s` for sharps, for example `Cs3.mp3` for C-sharp 3.
The sample map uses the equivalent flat note names (`Db`, `Eb`, `Gb`, `Ab`,
and `Bb`) where required by the player.

Easy Score's sample map associates each root with a local URL and offline
generated loop start and end points. Playback loads separate files on demand
for the pitches present in the score, retains the natural variation in the
recordings, and uses the loop metadata to sustain longer notes. Pitches beyond
the sampled range use the nearest root within 12 semitones. An out-of-range
note or an individual sample download/decode failure uses the synthesized
voice for that note only; the UI reports mixed playback. Other notes continue
using recordings, and a subsequent score can recover without a page reload.

Loop metadata can be regenerated with `python3 scripts/prepare-saxophone.py`
from the repository root (requires ffmpeg, no additional Python packages).
It compares the sustained waveform at rising zero crossings in the middle
of each recording; the MP3 files remain unchanged.

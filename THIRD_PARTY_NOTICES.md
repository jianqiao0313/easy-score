# Third-party notices

## Instrument samples

The locally served `public/soundfonts/piano.json` and `saxophone.json` are JSON re-packagings of the acoustic grand piano and alto saxophone MP3 samples from **FluidR3_GM**, rendered and distributed by **Benjamin Gleitzman and contributors** in [MIDI.js Soundfonts](https://github.com/gleitz/midi-js-soundfonts). Fluid SoundFont was created by **Frank Wen**.

Source files: [acoustic grand piano](https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js), [alto saxophone](https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/alto_sax-mp3.js).

License: [Creative Commons Attribution 3.0 United States](https://creativecommons.org/licenses/by/3.0/us/). The original soundfont repository documents this license in its README. Modification: the JavaScript variable wrapper was removed and sample mappings were serialized to JSON; sample audio was not changed.

## Recognition and notation

[Audiveris](https://github.com/Audiveris/audiveris) is an independent optical music recognition program distributed under AGPL-3.0. It is invoked as a separate subprocess. The macOS setup downloads its runtime into `.local/omr`; the Docker image includes the official unmodified 5.11.0 Linux package, its bundled license, and the corresponding source archive. Version, source commit and in-image paths are documented in [docker/AUDIVERIS.md](docker/AUDIVERIS.md).

[OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) renders MusicXML notation (BSD-3-Clause). [fflate](https://github.com/101arrowz/fflate) reads compressed MusicXML (MIT). [xmldom](https://github.com/xmldom/xmldom) parses MusicXML (MIT).

## User score

The supplied 四驱小子 BeTop PDF and generated recognition output are local user test data, not licensed application demo content for public redistribution. These assets remain in ignored local directories and are excluded from the public repository and Docker image.

## Logo

`public/easy-score.svg` is the original logo supplied by the project owner, copied without modification.

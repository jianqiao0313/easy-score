# Music timeline and audio lane report

## Changed files

- `src/musicxml.mjs` — browser/Node MusicXML parser for metadata, parts, quarter-note timing, rests, chords, voices (`backup` / `forward`), changing divisions, written-to-sounding transposition, pickup measures, cross-measure ties, and deterministic warnings.
- `src/audio.mjs` — lazy Web Audio transport with play/pause/stop/seek, live tempo and volume changes, piano/saxophone selection, accented metronome, local FluidR3_GM sample loading, synthesized fallback, and stale-schedule cancellation.
- `tests/musicxml.test.mjs` — parser regression coverage for timing, metadata, accidentals, pickup alignment, ties, transposition, malformed input, missing meter, and underfilled middle measures.
- `tests/music-audio.test.mjs` — transport regression coverage with a fake Web Audio context for lazy initialization, used-note-only sample decoding, sample fallback visibility, metronome accents, and cancellation during asynchronous decoding.

## Verification

`npm test`:

```text
17 tests passed, 0 failed
```

This includes 10 music-lane tests plus the server regression suite.

`npm run build`:

```text
vite v7.3.6
23 modules transformed
build completed successfully
```

Vite reports the existing production bundle-size warning (main JS is about 1.32 MB / 357 KB gzip), driven largely by score rendering dependencies.

The real `.local/demo/score.musicxml` parses as 39 measures, 125 sounding notes, and 156 quarter-note beats. Its missing meter defaults to 4/4 with a warning. Measure 25 contains only 3.5 recognized beats; the parser warns with the measure number and pads its timeline duration to four beats, preserving measure 26 at beat 100.

## Known limitations

- Playback uses the first tempo and reports a warning when the MusicXML contains multiple `<sound tempo>` values; tempo ramps and mid-score changes are not scheduled.
- Repeat, segno, and coda navigation are not expanded; playback follows document order and reports a warning.
- The sample engine decodes only MIDI pitches used by the loaded score. If an instrument map or required pitch cannot load, that instrument switches to the clearly reported synthesized fallback.
- Piano samples use their natural recorded decay. Saxophone samples loop their middle region for long notes; source and gain ramps reduce loop/release clicks, but the result remains a lightweight browser playback voice rather than studio-grade articulation.
- The current demo OMR lacks original tempo metadata, so it defaults to 120 BPM until recognition or UI metadata supplies the source tempo.

## Final transport follow-up

Seek-to-end installs no idle scheduler timers after synchronous completion. Successful restart immediately emits the current beat, so replay displays zero immediately. Focused timer lifecycle coverage added. Final full suite: 22/22 pass; Vite production build passes.

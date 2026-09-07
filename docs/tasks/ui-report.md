# UI implementation report

## Scope

- Implemented the vanilla JavaScript workspace in `index.html`, `src/main.js`, and `src/style.css`.
- Kept the interface local-first, responsive, keyboard accessible, and in Chinese with the `easy-score` identity.
- Did not modify package metadata, server code, the parser, or the audio engine.

## Implemented behavior

- Warm-white and forest-green three-panel score workspace with mobile/tablet layouts.
- PDF file picker and drag/drop import, 20 MB/type validation, raw upload headers, API error handling, and generation-guarded job polling.
- Starting any replacement selection invalidates and stops the prior job before file validation, so a rejected file cannot be overwritten by stale polling.
- Explicit empty, queued, processing, completed, and failed states. Demo copy identifies `/api/demo` as a cached result from a real PDF.
- OpenSheetMusicDisplay SVG rendering with auto resize and a guarded playback-follow cursor.
- OSMD loads with resize handling disabled, renders only after its visible paper has a stable width, and clears/disables the previous instance before replacement.
- Original PDF and recognized-score tabs, plus MusicXML export using the actual API response.
- Score title/composer, time/key signature, measure count, and all recognition/parser warnings shown for manual verification.
- Working play/pause/reset/seek/next-measure controls, elapsed time and measure position, BPM, volume, metronome, and async piano/saxophone switching.
- Audio source label follows `ScorePlayer.soundMode`: sampled audio is labeled `采样音色`; fallback is labeled `合成音色`.
- No fabricated score, progress, recognition result, or accuracy claim.

## Verification

- `npm run build` — passed with Vite 7.3.6. The OSMD bundle emits the existing >500 kB chunk advisory; output is valid.
- `npm test` — the earlier integrated run passed 16/16. After the reviewer pass, two newly added audio-agent pending-switch tests were still failing while `src/audio.mjs` was being revised; the UI files do not own those failures and root will rerun after that integration settles.
- `node --check src/main.js` — passed.
- Production smoke checks at `127.0.0.1:4173`:
  - `/api/health` returned Audiveris available.
  - `/api/demo` returned the completed real `四驱小子betop.pdf` job.
  - demo MusicXML and original PDF returned successfully.
  - both local soundfont JSON files returned successfully (about 2.6 MB each).

## Remaining integration check

- Root agent owns the final interactive browser pass for visual rendering, actual AudioContext playback, PDF embedding, and responsive viewport review.

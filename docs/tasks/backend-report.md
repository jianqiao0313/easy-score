# OMR backend report

## Delivered behavior

- `server/index.mjs` listens on `127.0.0.1:4173`, runs Vite as development middleware, and serves `dist/` with an SPA fallback in production.
- Vite ignores `.local`, `.next`, `docs`, `scripts`, `server`, and `tests`, so OMR output and local job persistence do not reload the browser during playback.
- `server/app.mjs` implements the contracted health, job, output, source PDF, and demo routes. Uploads are raw `application/pdf`, limited to 20 MB, checked for `%PDF-` magic bytes, and stored unchanged.
- Jobs persist under `.local/jobs/<uuid>/`. A single in-process queue runs Audiveris with concurrency 1, persists product-facing Chinese progress, restores interrupted queued/processing jobs after restart, and reports engine failure instead of creating fallback score data.
- Audiveris `.mxl` output is unpacked with `fflate`; `META-INF/container.xml` selects the MusicXML root file.

## Local OMR runtime

Run `scripts/setup-omr.sh` from the project root. It idempotently installs:

- Audiveris 5.11.0 arm64 at `.local/omr/Audiveris.app`, including OpenJDK 25 and Tesseract 5.5.2.
- The standard English Tesseract model at `.local/omr/tessdata/eng.traineddata`. The standard model is required because Audiveris requests legacy OCR components that `tessdata_fast` does not contain.

No files are installed in `/Applications`. The engine can be overridden with `AUDIVERIS_BIN`; conversion timeout uses `OMR_TIMEOUT_MS` (default 10 minutes).

PDFs are rendered with `pdftoppm` at 350 DPI before recognition. The engine resolves `POPPLER_BIN` first and then `pdftoppm` on `PATH`. One-page PDFs go to Audiveris as PNG. For 2–20 pages, `PYTHON_BIN` or `python3` plus Pillow combines the rendered pages into a multi-frame TIFF so Audiveris retains one multi-page score. More than 20 pages, missing tools, or preprocessing failure falls back to Audiveris's native full-PDF 300 DPI loader and adds a specific quality warning to the job; pages are never silently dropped.

The CLI is based on the official Audiveris command-line contract: `-batch -transcribe -export -output <dir> -- <input>`. Audiveris documents `-output` as the exact target for `.omr`/`.mxl` results and `-export` as MusicXML export: <https://audiveris.github.io/audiveris/_pages/guides/advanced/cli/>. Its scanning guidance recommends selecting resolution by symbol size and staff interline distance: <https://audiveris.github.io/audiveris/_pages/guides/advanced/scanning/>.

## Real conversion evidence

The final demo was created by POSTing `/Users/lvjianqiao/Downloads/四驱小子betop.pdf` through the running HTTP server, job `b8cc50ad-577b-4c7f-aa04-f471c7d690f9`. The resulting server job artifacts were copied to `.local/demo`; no mock or hand-authored recognition data is used.

- Source SHA-256 (download and served/stored copy): `03a73582d56504d172f62aa6c2c273318c5448bd882ee71a95feec7bb5d380d1`
- MusicXML: 64,713 bytes; title `<<BeT0p>>`; tempo 167; 39 measures; 125 sounding notes; 156 total quarter-note beats.
- First four parsed notes `[midi,startBeat,durationBeats]`: `[78,0.5,0.5]`, `[78,1,0.5]`, `[78,1.5,0.5]`, `[78,2,1]`.
- Last sounding note `[midi,startBeat,durationBeats,measure]`: `[83,151.5,1.5,38]`; final measure is `{number:39,startBeat:152,durationBeats:4}`.
- There are no incomplete-measure parser warnings. Audiveris did not detect an explicit time signature, so the player reports and uses its documented 4/4 inference.
- Reproducible evidence is stored in `.local/demo/verification.json`; the original PDF, `.mxl`, `.omr`, MusicXML, and raw Audiveris log are retained alongside it.

The chosen 350 DPI pass was selected from real comparisons: 300 DPI underfilled measure 25, while 400 DPI underfilled measure 1. The 350 DPI output preserved both measures and the full 156-beat form without introducing a score-specific repair.

### Two-page pipeline verification

A technical two-page fixture was created at `.local/inspection/betop-2page.pdf` by duplicating the original PDF page with `pypdf`; the original file was not modified. The fixture was uploaded through the unchanged running service as job `925c0c62-4173-49c0-9f0c-87bce0628cc4`.

- The job progressed through `正在以 350 DPI 渲染 PDF` and `正在准备 2 页高精度乐谱`, then completed successfully.
- The retained Audiveris log reports `2 sheets` from the generated multi-frame TIFF and `Exporting sheet(s): [#1#2]`, confirming both pages entered one export.
- The single returned MusicXML is 127,137 bytes and parses as one part, 78 measures, 250 playable events, 312 quarter-note beats, title `<<BeT0p>>`, and tempo 167.
- The first measure is 4 beats at beat 0; the final measure is number 78, starts at beat 308, and is 4 beats. The only parser warning is the expected missing-time-signature 4/4 inference.
- The submitted and returned PDF both have SHA-256 `86c69cd86ea8183aba61585fa0e251d9d2b9b490bbd6ba5a3c368e91679e7323`; `pypdf` confirms the stored source still has two pages.
- Machine-readable results are retained in `.local/inspection/betop-2page-result.json`. Temporary rendered PNG/TIFF inputs were cleaned after conversion; the source PDF, `.omr`, `.mxl`, raw log, job metadata, and decompressed MusicXML remain in the persistent job directory.

## Verification

- `node --test tests/server.test.mjs`: 7/7 pass. Covers the response contract, content type/magic/20 MB boundaries, persistence, original-byte serving, concurrency 1, surfaced engine failures, demo preparation, and `container.xml`-based MXL extraction. Fake engine data is explicitly labeled as a test fixture.
- `npm test`: 21/21 pass across server, parser, and audio tests.
- `npm run build`: Vite production build succeeds (23 modules). Rollup reports only the existing large OSMD bundle advisory.
- Production smoke on port 4174 served `dist/index.html` and `/api/health`; development smoke served the demo PDF (29,406 bytes) and MusicXML (64,713 bytes) with the contracted content types.
- `scripts/setup-omr.sh` rerun succeeds and reports Audiveris 5.11.0, bundled OpenJDK 25, Tesseract 5.5.2, and the project-local English OCR data.

## Known limits

- OMR is probabilistic. The real output reads the printed title as `<<BeT0p>>` and requires the player's explicit 4/4 inference. The API and UI retain an OMR review warning rather than claiming perfect recognition.
- The queue is intentionally process-local and concurrency 1. Persisted jobs survive restart, but this is not a distributed worker system.

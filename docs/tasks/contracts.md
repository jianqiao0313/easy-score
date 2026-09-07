# Shared interfaces

Project root /Users/lvjianqiao/projects/easy-score. Vanilla JavaScript ES modules, Vite, OpenSheetMusicDisplay. Node 24. All agents own separate paths; do not change others' files/package.json. Request package changes via root. Do not commit; root integrates.

## HTTP (backend owns server/)
- GET /api/health -> {ok:true,engine:{available:boolean,name:'Audiveris',message:string}}
- POST /api/jobs with raw PDF bytes, Content-Type application/pdf, X-File-Name percent-encoded filename -> 202 {id,status:'queued'|'processing'|'done',message?}
- GET /api/jobs/:id -> {id,status:'queued'|'processing'|'done'|'error',progress:0..100,message,fileName,xmlUrl?,pdfUrl?,warnings?:string[]}
- GET /api/jobs/:id/score.musicxml -> raw decompressed MusicXML string
- GET /api/jobs/:id/source.pdf -> raw input
- GET /api/demo -> same job status object for actual user PDF, from prepared .local/demo (or managed real job), no fabricated data. Error if not prepared.
- server/index.mjs port 4173 host 127.0.0.1. Dev integrate Vite middleware; prod static dist. Also API supports raw MusicXML? Not required.

## Score module (music agent owns src/musicxml.mjs, src/audio.mjs, tests/music*.test.mjs)
export function parseMusicXML(xmlText): {title:string,composer:string,tempo:number,timeSignature:{beats:number,beatType:number},keySignature:string,parts:[{id,name}],notes:[{id,partId,midi,startBeat,durationBeats,measure:number}],measures:[{number,startBeat,durationBeats}],totalBeats:number,warnings:string[]}
- beats in quarter-note units, one-based measure.number. MIDI numeric. Notes exclude rests, sustain tied notes. ordered startBeat.
- optional extra fields okay. Parser runs browser and Node using @xmldom/xmldom.
export class ScorePlayer { constructor({onPosition:(beat)=>{},onEnded:()=>{}}={}); async load(score); async play(); pause(); stop(); seek(beat); setTempo(bpm); setInstrument(id); setMetronome(enabled); setVolume(value0to1); dispose(); getters currentBeat, isPlaying; }
- instrument ids piano,saxophone. Default piano. Expose INSTRUMENTS array {id,name,description}. Audio lazily initialized on user gesture. Use synthesized Web Audio voice initially and label accurately. Root may add sample assets later.
- onPosition emits ~30fps; seek/resume stops stale sources; no old scheduled notes after settings change; metronome strong beat.

## UI (frontend agent owns index.html, src/main.js, src/style.css)
- Import parseMusicXML/ScorePlayer from modules above.
- Import {OpenSheetMusicDisplay} from 'opensheetmusicdisplay'. Load XML, autoResize true, backend svg, drawTitle true. Can use cursor follow; map timestamp whole-note units *4 to beat, avoid crashing on end.
- fetch API only, never fabricate recognition data or status. Initial state elegant empty page with demo CTA (user's PDF), not auto-play. Could auto-load demo if available but retain clear origin.
- import raw PDF via upload/drag drop; X-File-Name=encodeURIComponent(file.name); polling with abort/generation guard prevents old job overwriting new.
- UI all main user copy Chinese; product brand easy-score; warm white, forest green, editorial whitespace. Responsive and accessible.
- controls play/pause, reset, seek, BPM, volume, instrument choices piano/saxophone, metronome, score/original PDF tabs, export MusicXML. Practice page actual functionality; no inert placeholder nav.
- Original PDF via iframe/object URL backend. For initial/demo preview root may supply public/samples/betop-preview.png.
- File UI must say OMR can contain errors; distinguish actual recognition from previously processed demo. Never claim 100% accuracy.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMusicXML} from '../src/musicxml.mjs';

const base = process.env.SCORE_URL || 'http://127.0.0.1:4173';
const pdfPath = process.argv[2] || new URL('../.local/inspection/betop.pdf', import.meta.url);
const pdf = await readFile(pdfPath);
const health = await fetch(`${base}/api/health`).then(r => r.json());
assert.equal(health.ok, true);
assert.equal(health.engine.available, true, health.engine.message);
const invalid = await fetch(`${base}/api/jobs`, {method:'POST',headers:{'Content-Type':'application/pdf'},body:'not a pdf'});
assert.ok(invalid.status >= 400, `Malformed PDF accepted: ${invalid.status}`);
const missing = await fetch(`${base}/api/jobs/does-not-exist`);
assert.equal(missing.status,404);
const response = await fetch(`${base}/api/jobs`,{method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(path.basename(pdfPath instanceof URL ? fileURLToPath(pdfPath) : pdfPath))},body:pdf});
assert.equal(response.status,202,await response.clone().text());
let job = await response.json();
console.log(JSON.stringify({event:'submitted',id:job.id,status:job.status}));
const deadline=Date.now()+240000;
let lastStatus='';
while(Date.now()<deadline){
 const result=await fetch(`${base}/api/jobs/${job.id}`);
 assert.equal(result.status,200);
 job=await result.json();
 if(job.status!==lastStatus){console.log(JSON.stringify({event:'status',status:job.status,message:job.message}));lastStatus=job.status;}
 if(job.status==='done'||job.status==='error')break;
 await new Promise(resolve=>setTimeout(resolve,1500));
}
assert.equal(job.status,'done',JSON.stringify(job));
assert.ok(job.xmlUrl);assert.ok(job.pdfUrl);
const xml=await fetch(new URL(job.xmlUrl,base)).then(r=>r.text());
const score=parseMusicXML(xml);
assert.ok(score.notes.length>0);
assert.ok(score.totalBeats>0);
const retrieved=Buffer.from(await fetch(new URL(job.pdfUrl,base)).then(r=>r.arrayBuffer()));
const hash=data=>createHash('sha256').update(data).digest('hex');
assert.equal(hash(retrieved),hash(pdf),'Returned source PDF changed');
// Reference checks were independently read from the user's BeTop score.
const referencePdf = await readFile(new URL('../.local/inspection/betop.pdf', import.meta.url)).catch(() => null);
if (referencePdf && hash(pdf) === hash(referencePdf)) {
  assert.equal(score.tempo, 167, 'Source tempo is quarter=167');
  assert.equal(score.measures.length, 39);
  assert.equal(score.totalBeats, 156);
  assert.deepEqual(score.notes.slice(0,14).map(n=>[n.midi,n.startBeat,n.durationBeats]), [
    [78,.5,.5],[78,1,.5],[78,1.5,.5],[78,2,1],[78,3,.5],[78,3.5,.5],
    [78,4,1],[78,5,.5],[78,5.5,1],[78,6.5,.5],[78,7,1],
    [79,8,3],[81,11,.5],[78,11.5,4.5],
  ], 'Opening rests, pitches and ties must match original PDF');
  assert.deepEqual(score.notes.filter(n=>n.measure===25).map(n=>[n.midi,n.startBeat,n.durationBeats]), [[78,98.5,.5],[78,99,.5],[78,99.5,.5]], 'Measure 25 eighth rest must be preserved');
  const ending=score.notes.at(-1);
  assert.deepEqual([ending.midi,ending.startBeat,ending.durationBeats],[83,151.5,1.5], 'Ending B5 tie must leave three silent beats');
}
console.log(JSON.stringify({event:'verified',id:job.id,title:score.title,tempo:score.tempo,measures:score.measures.length,notes:score.notes.length,totalBeats:score.totalBeats,timeSignature:score.timeSignature,keySignature:score.keySignature,firstNotes:score.notes.slice(0,15),warnings:score.warnings},null,2));

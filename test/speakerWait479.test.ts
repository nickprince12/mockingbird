import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptPlaybackOngoing, receiptOverlap, waitForSpeaker } from '../src/core/speakerWait.ts';
import { applyHeard } from '../src/core/heard.ts';
import { gradeSpeakerTurns } from '../src/run.ts';
const base = Date.parse('2026-11-14T12:34:54.490Z');
const submit = { event: 'reply-submitted', sessionId: 'run15', generation: 7, atWall: base };
const complete = { event: 'reply-completed', sessionId: 'run15', generation: 7, atWall: base + 23270 };
const lineAt = Date.parse('2026-11-14T12:35:13.600Z');
test('Run 15 paragraph pause remains ongoing until matching completion, then quiet wins', async () => {
  let now = 13310; const started = now;
  const waited = await waitForSpeaker(1500,25000,()=>({ now, speaking: now < 17610 || now >= 20000 && now < 23270,
    playing: false, lastEnd: now < 20000 ? 17610 : 23270,
    receiptOngoing: receiptPlaybackOngoing(now < 23270 ? [submit] : [submit,complete],base+now)
  }), async()=>{now+=50;});
  assert.equal(waited.timedOut,false);
  assert.ok(now >= 24770); assert.ok(now > lineAt-base); assert.ok(waited.waitedMs > 5800);
  assert.equal(waited.waitedMs,now-started);
});
test('wrong generation/session cannot release wait; missing complete is bounded', async()=>{
  for (const end of [{...complete,generation:8},{...complete,sessionId:'other'}]) {
    assert.equal(receiptPlaybackOngoing([submit,end],base+24000),true);
  }
  assert.equal(receiptPlaybackOngoing([submit,complete,{...complete,event:'reply-outcome',outcome:'played'}],base+24000),false);
  let now=0;
  assert.deepEqual(await waitForSpeaker(1500,25000,()=>({now,playing:false,speaking:false,lastEnd:0,receiptOngoing:true}),async()=>{now+=50;}),{waitedMs:25000,timedOut:true});
});
test('fallback retains normal quiet but lengthens long and unfinished replies',async()=>{
  for (const [extra,expected] of [[{},1500],[{replyStarted:0},2500],[{replyText:'Next add'},2500],[{replyText:'Next add.'},1500]] as const) {
    let now=12000;
    const result=await waitForSpeaker(1500,25000,()=>({now,playing:false,speaking:false,lastEnd:12000,...extra}),async()=>{now+=50;});
    assert.equal(result.waitedMs,expected);
  }
});
function report(rows:any[]): any {
  return {turns:[{index:1,kind:'say',text:'Could you open the calendar instead? I want to check tomorrow.',spokenAtWall:lineAt,cueEndWall:lineAt+3000,spokenAtMs:19000,cueEndMs:22000,extraSegments:0,overlappedAppSpeech:false}],appEvidence:{sessions:[{sessionId:'run15',events:rows}]}};
}
test('receipt establishes masked overlap and infra grading without requiring a later heard line',()=>{
  const r=report([submit,complete]);
  const checks=gradeSpeakerTurns(r,[],{turns:r.turns as any,micAvailable:true,spokenLines:[],uiErrors:[]});
  assert.equal(r.turns[0].overlappedAppSpeech,true);
  assert.equal((r.turns[0] as any).rigFailure,'spoke-over-app');
  assert.ok(checks.some(c=>c.id==='spoke-over-app#1' && c.source==='rig/infra'));
  assert.ok(!checks.some(c=>c.id==='every-utterance-answered' && c.verdict==='fail'));
});
test('future unrelated replies, unmatched completions, heard lines and failed fetch never classify infra',()=>{
  for (const rows of [[complete],[{...submit,atWall:lineAt+1},complete],[submit,{...complete,generation:8}],[submit,{...complete,sessionId:'other'}],[submit,{...complete,atWall:lineAt}],[submit,complete,{event:'transcript',role:'user',text:'heard',atWall:lineAt+3000}]]) {
    const r=report(rows); applyHeard(r); assert.equal((r.turns[0] as any).rigFailure,undefined);
  }
  const r=report([submit,complete]); (r.appEvidence as any).partial='partial'; applyHeard(r);
  assert.equal((r.turns[0] as any).rigFailure,undefined);
  assert.equal(receiptOverlap([submit,complete],lineAt),true);
});
test('479 cancellation and every latency outcome release their generation, allowing later lines', async()=>{
  for (const end of [{...complete,event:'reply-cancelled'}, ...['played','cancelled','failed','unknown'].map(outcome=>({...complete,event:'reply-outcome',outcome}))]) {
    assert.equal(receiptPlaybackOngoing([submit,complete,end],base+24000),false);
    let now=24000;
    const result=await waitForSpeaker(1500,25000,()=>({now,playing:false,speaking:false,lastEnd:23270,
      receiptOngoing:receiptPlaybackOngoing([submit,complete,end],base+now)}),async()=>{now+=50;});
    assert.deepEqual(result,{waitedMs:800,timedOut:false});
  }
});
test('479 overlap requires reply-completed beyond the 750 ms clock tolerance',()=>{
  for (const delta of [-1,0,1,749,750,751]) {
    assert.equal(receiptOverlap([submit,{...complete,atWall:lineAt+delta}],lineAt),delta>750);
  }
  assert.equal(receiptOverlap([submit,{...complete,event:'reply-outcome',outcome:'played'}],lineAt),false);
});
test('479 AudioLoop slow or hung receipt polls never masquerade as playback',async()=>{
  const { AudioLoop } = await import('../src/core/audio.ts');
  for (const delay of [3000,Infinity]) {
    const audio = new AudioLoop({kind:'file',path:'/unused'}) as any;
    let now=0; audio.nowMs=()=>now+=50; audio.wallAt=(n:number)=>base+n;
    audio.lastPlaybackEndMs=0; audio.vad={speaking:false,segments:[]};
    let resolve!: (rows:any[])=>void;
    audio.playbackReceipts=()=>new Promise<any[]>(r=>{resolve=r;});
    const tick=Number.isFinite(delay) ? setTimeout(()=>resolve([]),delay) : undefined;
    try { const result=await audio.awaitQuiet(1500,25000); assert.equal(result.timedOut,false); assert.ok(result.waitedMs<25000); }
    finally { clearTimeout(tick); resolve([]); }
  }
});
test('479 early played latency cannot release speech; later completion or latency wins',()=>{
  const played={...complete,event:'reply-outcome',outcome:'played',atWall:base+100};
  assert.equal(receiptPlaybackOngoing([submit,played],base+500),true);
  assert.equal(receiptPlaybackOngoing([submit,played,complete],base+500),true);
  assert.equal(receiptPlaybackOngoing([submit,played,complete],base+24000),false);
  assert.equal(receiptPlaybackOngoing([submit,complete,{...played,atWall:base+25000}],base+24000),true);
  for (const outcome of ['cancelled','failed','silent','closed','unknown']) {
    assert.equal(receiptPlaybackOngoing([submit,{...played,outcome}],base+500),false);
  }
});

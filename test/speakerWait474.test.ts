import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSpeaker, lineOverlaps } from '../src/core/speakerWait.ts';
import { applyHeard } from '../src/core/heard.ts';
import { classifyHealth } from '../src/core/health.ts';
import { gradeSpeakerTurns, retrySpeakerLine } from '../src/run.ts';

function fixture() {
  const turn:any={index:1,kind:'say',text:'Start garlic bread',spokenAtMs:1000,spokenAtWall:10000,cueEndMs:2000,cueEndWall:11000,extraSegments:0,overlappedAppSpeech:true};
  const later:any={index:2,kind:'say',text:'How much water do I need for the pasta',spokenAtMs:10000,spokenAtWall:20000,cueEndMs:12000,cueEndWall:22000,extraSegments:0,overlappedAppSpeech:false,replyStartMs:13000};
  const receipts=[{event:'started',atWall:9000,sessionId:'s'}, {event:'transcript',role:'user',text:later.text,atWall:22000,sessionId:'s'}, {event:'ended',atWall:30000,sessionId:'s'}];
  return {turns:[turn,later],appEvidence:{sessions:[{sessionId:'s',events:receipts}]}} as any;
}
test('1500 ms quiet preserves a 1000 ms filler-then-answer pause',async()=>{
  let now=0;
  const result=await waitForSpeaker(1500,25000,()=>({now,speaking:now<2000 || now>=3000&&now<4000,playing:false,lastEnd:now<3000?2000:4000}),async()=>{now+=50;});
  assert.deepEqual(result,{waitedMs:5500,timedOut:false});
});
test('timeout is bounded and is not evidence of audio overlap',async()=>{
  let now=0;
  const waited=await waitForSpeaker(1500,25000,()=>({now,speaking:true,playing:false,lastEnd:0}),async()=>{now+=50;});
  assert.deepEqual(waited,{waitedMs:25000,timedOut:true});
  assert.equal(lineOverlaps(now,now+1000,[]),false);
  assert.equal(lineOverlaps(now,now+1000,[{startMs:24000,endMs:26000}]),true);
});
test('overlap excludes short noise, classified chimes and endpoint contact',()=>{
  assert.equal(lineOverlaps(1000,2000,[{startMs:500,endMs:1500}]),true);
  assert.equal(lineOverlaps(1000,2000,[{startMs:900,endMs:1200}]),false);
  assert.equal(lineOverlaps(1000,2000,[{startMs:500,endMs:1500,chime:true}]),false);
  assert.equal(lineOverlaps(1000,2000,[{startMs:500,endMs:1500,nonSpeech:true}]),false);
  assert.equal(lineOverlaps(1000,2000,[{startMs:500,endMs:1000}]),false);
  assert.equal(lineOverlaps(1000,2000,[{startMs:1200,endMs:1800}]),false);
});
test('complete session and later clean transcript establish rig failure',()=>{
  const r=fixture(); applyHeard(r); assert.equal(r.turns[0].rigFailure,'spoke-over-app');
  r.appEvidence.sessions[0].events.push({event:'transcript',role:'user',text:r.turns[0].text,atWall:11000,sessionId:'s'});
  applyHeard(r); assert.equal(r.turns[0].rigFailure,undefined);
});
test('partial archive, no later clean transcript, other session, and missing archive retain product unanswered',()=>{
  for(const change of [
    (r:any)=>{delete r.appEvidence;},
    (r:any)=>{r.appEvidence.sessions[0].events.shift();},
    (r:any)=>{r.appEvidence.partial='partial fetch';},
    (r:any)=>{r.turns[1].overlappedAppSpeech=true;},
    (r:any)=>{r.appEvidence.sessions[0].events.splice(1,1);},
    (r:any)=>{const rs=r.appEvidence.sessions[0].events; r.appEvidence.sessions.push({sessionId:'other',events:[{...rs.splice(1,1)[0],sessionId:'other'}]});},
    (r:any)=>{r.appEvidence.sessions[0].events=[{event:'ended',atWall:9500}];},
  ]) {const r=fixture();change(r);applyHeard(r);assert.equal(r.turns[0].rigFailure,undefined);}
});
test('mixed health retains product failures and separately lists spoke-over-app',()=>{
  const rig={id:'spoke-over-app#1',verdict:'fail',detail:'no app transcript'};
  assert.equal(classifyHealth({checks:[rig]}).health,'infra');
  const h=classifyHealth({checks:[rig,{id:'every-utterance-answered',verdict:'fail',detail:'no reply to: "water"'}]});
  assert.equal(h.health,'product-fail');assert.equal(h.failedChecks.length,2);assert.ok(h.reasons.some(r=>r.startsWith('spoke-over-app:')));
});
test('run final grading applies heard first for silence, latency and human checks',()=>{
  const r=fixture();
  r.turns[0].expect='silence';r.turns[0].replyStartMs=50000;r.turns[0].usefulStartMs=50000;
  r.turns[0].segments=[{startMs:50000,endMs:51000,transcript:'Here is the answer'}];
  const checks=gradeSpeakerTurns(r,[],{turns:r.turns,micAvailable:true,startToFirstWordsMs:100,spokenLines:[],uiErrors:[],expectWords:{1:'garlic'}},
    [{turnIndex:1,intent:'done_after_step',before:{text:'the app tools said',instruction:'same',source:'test'},after:{text:'the app tools said',instruction:'same',source:'test'}}] as any,
    [{id:'human:loop#1',source:'test',verdict:'fail',detail:'cap reached'}]);
  assert.equal(r.turns[0].rigFailure,'spoke-over-app');
  assert.equal(checks.find(c=>c.id==='reply-words#1')?.verdict,'unmeasured');
  assert.ok(!checks.some(c=>c.id==='silent-line-not-answered'));
  assert.ok(!checks.some(c=>c.id.startsWith('human:')));
  assert.ok(!checks.some(c=>/^useful-reply/.test(c.id)&&c.verdict==='fail'));
  r.turns[0].expect='advance';
  const again=gradeSpeakerTurns(r,[],{turns:r.turns,micAvailable:true,spokenLines:r.turns.map((t:any)=>t.text),uiErrors:[],backend:{sessions:['s'],user:[],assistant:[]}});
  assert.equal(again.find(c=>c.id==='advances#1')?.verdict,'unmeasured');
  assert.ok(!again.some(c=>/^useful-reply/.test(c.id)&&c.verdict==='fail'));
  assert.equal(again.find(c=>c.id==='app-heard-the-speaker')?.detail,'0 of 1 played lines appear in what the app heard');
  r.turns[1].replyStartMs=undefined;
  assert.equal(gradeSpeakerTurns(r,[],{turns:r.turns,micAvailable:true,spokenLines:[],uiErrors:[]}).find(c=>c.id==='every-utterance-answered')?.verdict,'fail');
});
test('retry preserves barge-in modes, refreshes playback time, and records quiet timeout without overlap',async()=>{
  for(const mode of ['overlap','after-onset','after-quiet'] as const){
    let waits=0;const turn:any={spokenAtMs:1,spokenAtWall:2};
    const audio:any={awaitQuiet:async()=>{waits++;return {waitedMs:25000,timedOut:true};},say:async()=>({startMs:30000,endMs:31000}),wallAt:(n:number)=>n+9000};
    await retrySpeakerLine(audio,turn,{mode},1500,25000,'hello','Samantha',185);
    assert.equal(waits,mode==='after-quiet'?1:0);
    assert.equal(turn.spokenAtMs,30000);assert.equal(turn.spokenAtWall,39000);
    assert.equal(turn.notes?.includes('speaker-wait-timeout')??false,mode==='after-quiet');
    assert.equal(turn.overlappedAppSpeech,undefined);
  }
});

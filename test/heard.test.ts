import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHeard, selectReplyText, applyHeard } from '../src/core/heard.ts';
import { evaluate, type TurnRecord } from '../src/core/assertions.ts';
const turn=(index:number,text:string,start:number):TurnRecord=>({index,kind:'say',text,spokenAtWall:start,cueEndWall:start+100,cueEndMs:start+100,extraSegments:0,replyTranscript:'Meeting rumm'});
const row=(text:string,atWall:number,role='user')=>({event:'transcript',role,text,atWall});
test('one-to-one and numeric canonicalization',()=>{ const h=analyzeHeard([turn(1,'four minutes left',1000)],[row('4 minutes left',1200)]);assert.equal(h.wer,0); });
test('split turns join once; merged turns scored as a group',()=>{
 const t=[turn(1,'lights and music',1000),turn(2,'set volume',10000)];
 const split=analyzeHeard(t,[row('lights',1200),row('and music',1500),row('set volume',10500)]); assert.equal(split.wer,0);assert.equal(split.groups[0].alignment,'split (joined in order)');
 const merged=analyzeHeard(t,[row('lights and music set volume',10500)]);assert.equal(merged.wer,0);assert.equal(merged.groups[0].alignment,'merged (group score only)');
});
test('missing archive is unmeasured; missing turn with archive counts deletions',()=>{
 const t=[turn(1,'music',1000),turn(2,'volume',10000)];assert.equal(analyzeHeard(t,[]).wer,null);
 assert.equal(analyzeHeard(t,[row('music',1500)]).wer,.5);
});
test('submitted assistant text wins word checks without altering acoustic evidence',()=>{
 const t=turn(1,'hello',1000), next=turn(2,'next',10000);
 const r:any={turns:[t,next],appEvidence:{sessions:[{events:[row('hello',1500),row('next',10500),row('Meeting room for four',2000,'assistant'),row('wrong next reply',12000,'assistant')]}]}};applyHeard(r);
 assert.equal(t.replyTranscript,'Meeting rumm');assert.equal(t.replyWords?.source,'backend');
 const c=evaluate({turns:[t],micAvailable:true,spokenLines:[],uiErrors:[],expectWords:{1:'room'}}).find(c=>c.id==='reply-words#1');assert.equal(c?.verdict,'pass');assert.equal(c?.source,'backend');
 assert.equal(selectReplyText(t,[t],[]).source,'acoustic');
});
import { tokens452 } from '../src/core/heardScore.ts';
for (const [digits,words] of [
 ['1/3','one third'],['2/3','two thirds'],['1/6','one sixth'],['1/8','one eighth'],['3/8','three eighths'],['5/8','five eighths'],
 ['1 1/2','one and a half'],['1½','one and a half'],['1.5','one point five'],['2.75','two point seven five'],
 ['4 oz','four ounces'],['2 tbsp','two tablespoons'],['1 tsp','one teaspoon'],['1 lb','one pound'],['2 min','two minutes'],
 ['ok','okay'],['nine-minute','nine minute'],['25%','twenty-five percent'],['1.5','one and a half']
]) test(`provider-fair tokens: ${digits} = ${words}`,()=>assert.deepEqual(tokens452(digits),tokens452(words)));
test('late assistant belongs to preceding user, even after next cue; multiple rows flagged',()=>{
 const a=turn(1,'music',10000), b=turn(2,'volume',20000);
 const receipts=[row('music',11000),row('late music reply',20500,'assistant'),row('extra music reply',20700,'assistant'),row('volume',22000),row('volume reply',23000,'assistant')];
 const reply=selectReplyText(a,[a,b],receipts);
 assert.equal(reply.text,'late music reply');assert.equal(reply.ambiguous,true);assert.equal(reply.assistantRows,2);
 assert.match(reply.provenance,/multiple assistant rows/);
 assert.equal(selectReplyText(b,[a,b],receipts).text,'volume reply');
});
test('assistant generation mismatch cannot be attributed to current user',()=>{
 const a=turn(1,'music',10000);
 const receipts=[{...row('music',11000),generation:2},{...row('old reply',12000,'assistant'),generation:0},{...row('right reply',13000,'assistant'),generation:2}];
 assert.equal(selectReplyText(a,[a],receipts).text,'right reply');
});

test('adapter vocabulary marks domain words as critical without changing WER', () => {
  const turns = [turn(1, 'open calendar', 1000)];
  const events = [row('open calculator', 1200)];
  const generic = analyzeHeard(turns, events);
  const configured = analyzeHeard(turns, events, [], new Set(['calendar']));
  assert.equal(generic.wer, configured.wer);
  assert.equal(generic.criticalErrorRate, null);
  assert.equal(configured.criticalErrorRate, 1);
});

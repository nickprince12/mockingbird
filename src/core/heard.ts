import { receiptOverlap } from './speakerWait.ts';
/** Synthetic scenario evidence only. Text remains inside the run directory. */
import { score452 } from './heardScore.ts';
import type { TurnRecord } from './assertions.ts';
export type AppEvent = { event: string; role?: string; text?: string; atWall?: number; sessionId?: string; generation?: number; sttProvider?: string; outcome?: string };
export interface AppEvidence { sessions: { events: AppEvent[] }[]; partial?: boolean }
export const percent = (n: number | null | undefined) => n == null ? 'unmeasured' : `${(100*n).toFixed(2)}%`;
export function analyzeHeard(turns: TurnRecord[], receipts: AppEvent[], steps: Array<{say?: string; ui?: string; await?: string}> = [], criticalWords?: ReadonlySet<string>) {
  const lines = turns.filter(t => t.kind === 'say').map(t => ({...t, text: (steps[t.index-1]?.say ?? t.text ?? '').replace(/\[\[pause\]\]/g, ' ')}));
  const users = receipts.filter(r => r.event === 'transcript' && r.role === 'user' && typeof r.text === 'string').sort((a,b)=>(a.atWall ?? 0)-(b.atWall ?? 0));
  const providers = [...new Set(receipts.map(r=>r.sttProvider).filter(Boolean))];
  // Monotone grouped alignment: permit split/merged turns, never duplicate text.
  // Archive time is not a speech clock: allow 3s skew and constrain groups to cue windows.
  const n=lines.length,m=users.length, d=Array.from({length:n+1},()=>Array(m+1).fill(Infinity));
  const back = new Map<string, {i:number;j:number;a:number;b:number}>(); d[0][0]=0;
  for(let i=0;i<=n;i++)for(let j=0;j<=m;j++)if(Number.isFinite(d[i][j])) {
    for(let a=0;a<=Math.min(3,n-i);a++)for(let b=0;b<=Math.min(3,m-j);b++) {
      if(!a&&!b || !a&&b>1 || !b&&a>1)continue;
      const ref=lines.slice(i,i+a).map(t=>t.text).join(' '), hyp=users.slice(j,j+b).map(r=>r.text).join(' ');
      const start=lines[i]?.spokenAtWall ?? lines[i]?.cueEndWall;
      const end=lines[i+a]?.spokenAtWall ?? lines[i+a]?.cueEndWall;
      if(a&&b&&users.slice(j,j+b).some(r=>r.atWall===undefined || start===undefined || r.atWall<start-3000 || end!==undefined&&r.atWall>=end+3000))continue;
      const cost=score452(ref,hyp).errors + .25*(Math.max(0,a-1)+Math.max(0,b-1)) + (!a||!b ? .5 : 0);
      if(d[i][j]+cost<d[i+a][j+b]) {d[i+a][j+b]=d[i][j]+cost;back.set(`${i+a},${j+b}`,{i,j,a,b});}
    }
  }
  const groups: Array<{indices:number[];reference:string;heard?:string;alignment:string;score?:ReturnType<typeof score452>}> = [];
  let i=n,j=m;
  while(i||j) {const p=back.get(`${i},${j}`);if(!p)break;
    const reference=lines.slice(p.i,i).map(t=>t.text).join(' '), heard=users.slice(p.j,j).map(r=>r.text).join(' ');
    groups.unshift({indices:lines.slice(p.i,i).map(t=>t.index), reference, heard:users.length?heard:undefined, alignment:!p.a?'unmatched app turn':!p.b?'missing app turn':p.a>1?'merged (group score only)':p.b>1?'split (joined in order)':'one-to-one', score:users.length?score452(reference,heard,criticalWords):undefined}); i=p.i;j=p.j;
  }
  const scores=groups.flatMap(g=>g.score?[g.score]:[]), sum=(k:'words'|'errors'|'criticalWords'|'criticalErrors'|'criticalInsertions')=>scores.reduce((s,r)=>s+r[k],0);
  return {sttProvider:providers.join(', ')||'unavailable', transcriptTurns:m, scriptedLines:n, unexecutedLines:steps.filter(s=>s.say).length-n, words:sum('words'), errors:sum('errors'), wer:users.length&&sum('words')?sum('errors')/sum('words'):null, criticalErrorRate:users.length&&sum('criticalWords')?sum('criticalErrors')/sum('criticalWords'):null, criticalInsertions:sum('criticalInsertions'), groups};
}
export function selectReplyText(turn: TurnRecord, turns: TurnRecord[], receipts: AppEvent[]) {
  const start=turn.kind==='say' ? turn.spokenAtWall ?? turn.cueEndWall : turn.cueEndWall;
  const next=turns[turns.indexOf(turn)+1]; const end=next?.spokenAtWall ?? next?.cueEndWall;
  const ordered=receipts.filter(r=>r.event==='transcript'&&typeof r.text==='string').sort((a,b)=>(a.atWall ?? 0)-(b.atWall ?? 0));
  const nextSay=turns.slice(turns.indexOf(turn)+1).find(t=>t.kind==='say');
  const userEnd=nextSay?.spokenAtWall ?? nextSay?.cueEndWall;
  const user=turn.kind==='say' ? ordered.find(r=>r.role==='user'&&r.atWall!==undefined&&start!==undefined&&r.atWall>=start-3000&&(userEnd===undefined||r.atWall<userEnd-3000)) : undefined;
  const userIndex=user ? ordered.indexOf(user) : -1;
  const nextUser=user ? ordered.findIndex((r,i)=>i>userIndex&&r.role==='user'&&r.sessionId===user.sessionId) : -1;
  const rows=user ? ordered.slice(userIndex+1,nextUser<0?undefined:nextUser).filter(r=>r.role==='assistant'&&r.sessionId===user.sessionId&&(user.generation===undefined||r.generation===undefined||r.generation===user.generation))
    : turn.kind==='say' ? [] : ordered.filter(r=>r.role==='assistant'&&r.atWall!==undefined&&start!==undefined&&r.atWall>=start&&(end===undefined||r.atWall<end));
  return rows.length ? {text:rows[0].text, source:'backend', assistantRows:rows.length, ambiguous:rows.length>1, provenance:`App transcript (submitted text; delivery not established)${rows.length>1 ? '; WARNING: multiple assistant rows in reply window ('+rows.length+'); first selected' : ''}`} : {text:turn.replyTranscript, source:'acoustic', provenance:'local whisper (no aligned assistant receipt)'};
}
export function applyHeard(report: any, steps: Array<{say?: string; ui?: string; await?: string}> = []) {
  const receipts: AppEvent[] = (report.appEvidence?.sessions ?? []).flatMap((s:any)=>s.events ?? []);
  report.heardAs=analyzeHeard(report.turns,receipts,steps,report.criticalWords);
  for(const t of report.turns) {
    t.replyWords=selectReplyText(t,report.turns,receipts);
    const lineHasText = (line: TurnRecord, rows: AppEvent[]) => {
      const next = report.turns.slice(report.turns.indexOf(line)+1).find((x:TurnRecord) => x.kind === 'say');
      const end = next?.spokenAtWall ?? next?.cueEndWall;
      const start = line.spokenAtWall ?? line.cueEndWall;
      return rows.some(r => r.event === 'transcript' && r.role === 'user' && r.text?.trim() && r.atWall !== undefined && start !== undefined && r.atWall >= start-3000 && (end === undefined || r.atWall < end-3000));
    };
    // A populated but partial archive cannot establish an unheard line. Require
    // same-session receipts bracketing the full cue and a later clean heard line.
    const covered = !report.appEvidence?.partial && (report.appEvidence?.sessions ?? []).some((s:any) => {
      const rs: AppEvent[] = s.events ?? [];
      const times = rs.flatMap(r => r.atWall === undefined ? [] : [r.atWall]);
      if (!Number.isFinite(t.spokenAtWall) || !Number.isFinite(t.cueEndWall) || !times.length || Math.min(...times) > t.spokenAtWall || Math.max(...times) < t.cueEndWall) return false;
      const ended = rs.find(r => r.event === 'ended');
      if (ended?.atWall !== undefined && ended.atWall < t.cueEndWall) return false;
      return report.turns.some((later:any) => later.kind === 'say' && later.overlappedAppSpeech === false && later.spokenAtWall > t.cueEndWall &&
        lineHasText(later, rs) &&
        rs.some(r => r.event === 'transcript' && r.role === 'user' && r.text?.trim() && r.atWall !== undefined && r.atWall >= later.spokenAtWall && r.atWall >= t.cueEndWall && (ended?.atWall === undefined || r.atWall <= ended.atWall)));
    });
    const appOverlap = !report.appEvidence?.partial && Number.isFinite(t.spokenAtWall) && receiptOverlap(receipts, t.spokenAtWall);
    if (t.kind === 'say' && appOverlap && !lineHasText(t, receipts)) t.overlappedAppSpeech = true;
    if(t.kind === 'say' && t.overlappedAppSpeech === true && !lineHasText(t, receipts) && (covered || appOverlap)) t.rigFailure='spoke-over-app';
    else delete t.rigFailure;
  }
}
export function heardMarkdown(h: ReturnType<typeof analyzeHeard>) {
  const cell=(s:string)=>s.replace(/\|/g,'/').replace(/\n/g,' ');
  return `## App heard-as accuracy\n\nsttProvider: ${h.sttProvider}. WER: ${percent(h.wer)}. Critical-token error rate: ${percent(h.criticalErrorRate)}. Critical insertions: ${h.criticalInsertions} (separate from reference-anchored rate). ${h.transcriptTurns} app transcripts / ${h.scriptedLines} executed scripted lines; ${h.unexecutedLines} unexecuted lines. Missing archive text is unmeasured, not perfect recognition.\n\n| step(s) | alignment | scripted | app heard | WER |\n|---|---|---|---|---|\n${h.groups.filter(g=>!g.score||g.score.errors||g.alignment!=='one-to-one').map(g=>`| ${g.indices.join(', ')||'—'} | ${g.alignment} | ${cell(g.reference)} | ${cell(g.heard ?? 'unavailable')} | ${percent(g.score?.wer)} |`).join('\n')}\n`;
}

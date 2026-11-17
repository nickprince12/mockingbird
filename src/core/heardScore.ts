/** Corpus WER and reference-anchored critical-token errors from one Levenshtein alignment. */
const digits = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function numberWords(n: number): string { if(n<20)return digits[n]; if(n<100)return tens[Math.floor(n/10)]+(n%10?' '+digits[n%10]:''); if(n<1000)return digits[Math.floor(n/100)]+' hundred'+(n%100?' '+numberWords(n%100):''); return String(n); }
export function tokens452(text: string): string[] {
  const fractions: Record<string,string> = {'1/2':'half','1/3':'third','2/3':'two thirds','1/4':'quarter','3/4':'three quarters','1/6':'sixth','1/8':'eighth','3/8':'three eighths','5/8':'five eighths'};
  const units: Record<string,string> = {oz:'ounce',ounces:'ounce',tbsp:'tablespoon',tablespoons:'tablespoon',tsp:'teaspoon',teaspoons:'teaspoon',lb:'pound',lbs:'pound',pounds:'pound',min:'minute',mins:'minute',minutes:'minute'};
  return text.toLowerCase().replace(/[’']/g,'')
    .replace(/[½⅓⅔¼¾⅙⅛⅜⅝]/g,c=>' '+({'½':'1/2','⅓':'1/3','⅔':'2/3','¼':'1/4','¾':'3/4','⅙':'1/6','⅛':'1/8','⅜':'3/8','⅝':'5/8'}[c])+' ')
    .replace(/\b(\d+)\s+(\d+\/\d+)\b/g,'$1 and $2')
    .replace(/\b\d+\.\d+\b/g,n=>{const [whole,part]=n.split('.');return Number(part)===5 && part.length===1 ? numberWords(Number(whole))+' and a half' : numberWords(Number(whole))+' point '+[...part].map(c=>digits[Number(c)]).join(' ');})
    .replace(/\b(?:1\/2|1\/3|2\/3|1\/4|3\/4|1\/6|1\/8|3\/8|5\/8)\b/g,n=>fractions[n])
    .replace(/\b\d+\b/g,n=>numberWords(Number(n))).replace(/%/g,' percent ')
    .replace(/[^a-z0-9]+/g,' ').replace(/\bper cent\b/g,'percent').replace(/\bok\b/g,'okay')
    .replace(/\bpoint five\b(?! (?:zero|one|two|three|four|five|six|seven|eight|nine)\b)/g,'and half')
    .replace(/\b(?:one|a) (half|quarter|third|sixth|eighth)\b/g,'$1')
    .replace(/\band a (half|quarter|third|sixth|eighth)\b/g,'and $1')
    .trim().split(/\s+/).filter(Boolean).map(t=>units[t] ?? t);
}
const numberTokens = new Set([...digits,...tens,'hundred','thousand','half','halves','quarter','quarters','sixth','sixths','third','thirds','eighth','eighths','point','percent']);
export function score452(reference: string, hypothesis: string, domainWords?: ReadonlySet<string>) {
  const r=tokens452(reference), h=tokens452(hypothesis), critical=(t:string)=>domainWords?.has(t)||numberTokens.has(t);
  const d=Array.from({length:r.length+1},()=>Array(h.length+1).fill(0) as number[]);
  for(let i=0;i<=r.length;i++)d[i][0]=i; for(let j=0;j<=h.length;j++)d[0][j]=j;
  for(let i=1;i<=r.length;i++)for(let j=1;j<=h.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+Number(r[i-1]!==h[j-1]));
  let i=r.length,j=h.length,substitutions=0,deletions=0,insertions=0,criticalErrors=0,criticalInsertions=0;
  while(i||j){
    if(i&&j&&d[i][j]===d[i-1][j-1]+Number(r[i-1]!==h[j-1])) {if(r[i-1]!==h[j-1]){substitutions++;if(critical(r[i-1]))criticalErrors++;}i--;j--;}
    else if(i&&d[i][j]===d[i-1][j]+1){deletions++;if(critical(r[i-1]))criticalErrors++;i--;}
    else {insertions++;if(critical(h[j-1]))criticalInsertions++;j--;}
  }
  const words=r.length, criticalWords=r.filter(critical).length, errors=substitutions+deletions+insertions;
  // Critical insertions reported separately: unknown misspellings cannot be classified reliably.
  return {words,errors,substitutions,deletions,insertions,wer:words?errors/words:null,criticalWords,criticalErrors,criticalInsertions,criticalErrorRate:criticalWords?criticalErrors/criticalWords:null};
}

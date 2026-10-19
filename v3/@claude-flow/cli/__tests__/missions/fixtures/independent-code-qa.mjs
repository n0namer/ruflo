// Physically independent functional reviewer for a real Codex-created ES module.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [file, taskId] = process.argv.slice(2);
if (!file || taskId !== 'make') process.exit(2);
try {
  const source = readFileSync(file, 'utf8');
  const imported = await import(pathToFileURL(file).href + '?qa=' + Date.now());
  if (typeof imported.sumFinite !== 'function') throw new Error('sumFinite export missing');
  const sum = imported.sumFinite;
  const cases = [[2,3,5],[-2.5,1.25,-1.25],[0,0,0],[1e3,2e3,3e3]];
  for(const [a,b,expected] of cases) {
    if (sum(a,b) !== expected) throw new Error('incorrect sumFinite result');
  }
  for (const [a,b] of [[null,1],['2',3],[{},0]]) {
    let threw = false;
    try { sum(a,b); } catch(e) { threw = e instanceof TypeError; }
    if (!threw) throw new Error('missing TypeError on invalid input');
  }
  for (const [a,b] of [[Infinity,2],[NaN,1],[2,-Infinity]]) {
    let threw=false;
    try { sum(a,b); } catch(e) { threw = e instanceof RangeError; }
    if (!threw) throw new Error('missing RangeError on non-finite values');
  }
  const artifactDigest = 'sha256:' + createHash('sha256').update(source).digest('hex');
  console.log(JSON.stringify({ kind:'independent-process-check', taskId, artifactDigest,
    pid:process.pid, verdict:'passed', tests:cases.length+6 }));
} catch (error) {
  console.error('INDEPENDENT_QA_FAILED: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

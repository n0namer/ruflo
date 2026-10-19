// Separate Node reviewer process. Checks a fixed expected artifact; no code execution.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [file, taskId] = process.argv.slice(2);
if (!file || !/^[a-z][a-z0-9-]+$/.test(taskId ?? '')) process.exit(2);
const contents = readFileSync(file, 'utf8');
if (contents !== 'M2:' + taskId + ':verified') process.exit(3);
const artifactDigest = 'sha256:' + createHash('sha256').update(contents).digest('hex');
console.log(JSON.stringify({ kind:'independent-process-check', taskId, artifactDigest,
  pid: process.pid, verdict: 'passed' }));

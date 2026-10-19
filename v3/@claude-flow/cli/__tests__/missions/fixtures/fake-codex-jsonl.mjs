// Deterministic PHYSICAL PROCESS fixture, not an OpenAI Codex model.
// Emits real Codex JSONL event shapes for M2 transport E2E.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const prompt = JSON.parse(process.argv.at(-1) ?? '{}');
if (typeof prompt.taskId !== 'string' || !/^[a-z][a-z0-9-]+$/.test(prompt.taskId)) process.exit(2);
const base = resolve(process.cwd(), '.claude-flow', 'probe-artifacts');
mkdirSync(base, { recursive: true });
const artifact = resolve(base, prompt.taskId + '.txt');
if (dirname(artifact) !== base) process.exit(3);
writeFileSync(artifact, 'M2:' + prompt.taskId + ':verified', 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: randomUUID() }));
console.log(JSON.stringify({ type: 'turn.started' }));
await new Promise(resolve => setTimeout(resolve, 15));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));

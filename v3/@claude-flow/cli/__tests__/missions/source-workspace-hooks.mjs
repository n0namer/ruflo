// Test-only Node subprocess module aliases for a sparse/unbuilt Ruflo workspace.
// Vitest aliases are not inherited by node --import tsx child processes.
import { registerHooks } from 'node:module';

const aliases = new Map([
  ['@claude-flow/security/policy/index', new URL('../../../security/src/policy/index.ts', import.meta.url).href],
  ['@claude-flow/security/mcp-caller-identity', new URL('../../../security/src/mcp-caller-identity.ts', import.meta.url).href],
  ['@claude-flow/security/safe-git', new URL('../../../security/src/safe-git.ts', import.meta.url).href],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = aliases.get(specifier);
    return target ? { url: target, shortCircuit: true } : nextResolve(specifier, context);
  },
});

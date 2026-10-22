import fs from 'node:fs';
import {runProviderGuardianTick} from 'file:///D:/Users/NIKITA/Documents/DEV/worktrees/ruflo-factory-m2-bridge-20261019/lib/factory-provider-guardian.mjs';
const root='D:/Users/NIKITA/Documents/DEV/ruflo';
const policy=JSON.parse(fs.readFileSync(root+'/factory-policy.json','utf8')).provider_guardian ?? {};
const r=await runProviderGuardianTick({factoryRoot:root,policy});
console.log('GUARDIAN_RESULT='+JSON.stringify({status:r.status,reason:r.reason??null,mode:r.provider_circuit?.mode,canaryOk:r.canary?.ok??null,last_success_at:r.provider_circuit?.last_success_at,modelCalls:r.model_calls}));

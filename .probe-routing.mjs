import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Token2bIQService } from './lib/service.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-p3-'));
const svc = new Token2bIQService({ stateFile: null, settingsFile: path.join(dir,'s.json') });
svc.settings.update({ strongModel: 'magpie-responses::gptmengluo/gpt-6-astra', normalModel: 'magpie::wps-lingxi/deepseek-v4.1-flash',
  forceTeam: 'auto', pipelineGate: 'off', rolePools: { plan: ['magpie-responses::gptmengluo/gpt-6-astra'], judge: ['magpie-responses::gptmengluo/gpt-6-astra'] } });
const agent = { id: 'agent_lead' };
const ctx = { agent, agentTeams: { isEnabled: () => true, createTask: async (a, s) => ({ id: 'tt_' + String(s && s.subject).slice(0, 6) }) }, subagents: { rootOf: () => agent }, sessionId: 's1' };
const a = await svc.startWithAuto({ goal: 'p', mode: 'S4' }, ctx);
console.log(JSON.stringify(a.created.modelRouting.map(m => ({ stage: m.stage, provider: m.provider, model: m.model })), null, 1));
console.log('--- next ---'); console.log(String(a.next).slice(0, 800));
fs.rmSync(dir, { recursive: true, force: true });

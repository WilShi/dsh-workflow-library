/**
 * E2E driver — staged into the harness package by scripts/e2e.mjs.
 *
 * Runs against real harness services; only the subagent provider is stubbed so
 * no model key is needed.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from './lib/index.js'
import * as workflowLibrary from './.wf-e2e-plugin.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fail = (m) => { console.error('FAIL ' + m); process.exit(1) }
const ok = (m) => console.log('  ok  ' + m)

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SubagentRuntime)

let providerStarts = 0
ctx.subagents.registerProvider({
  name: 'e2e-stub',
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async start() {
    providerStarts += 1
    return {
      id: 'e2e-child-' + providerStarts,
      result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    }
  },
})
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'e2e-stub' })

const engine = ctx.get('workflowEngine')
const tools = ctx.get('tools')
if (!engine) fail('拿不到 workflowEngine')
if (!tools) fail('拿不到 tools')
ok('真实引擎与工具注册表已启动')

const captured = []
workflowLibrary.apply({
  tools: { register: (t) => { captured.push(t); return tools.register(t) } },
  get: (n) => ctx.get(n),
})
if (captured.length !== 4) fail('工具数应为 4，实际 ' + captured.length)
ok('注册 4 个工具: ' + captured.map((t) => t.name).join(', '))

const dir = mkdtempSync(join(tmpdir(), 'wf-e2e-'))
mkdirSync(join(dir, '.git'), { recursive: true })
mkdirSync(join(dir, '.dsh', 'workflows'), { recursive: true })

const workflowSource = [
  '---',
  'name: fanout',
  'description: fan out to N subagents',
  'args: n (number) how many subagents to start',
  'phases: gather, report',
  '---',
  'const n = (args && args.n) || 1',
  'const answers = []',
  'for (let i = 0; i < n; i++) {',
  '  const v = await agent(String(i), { schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } })',
  '  answers.push(v.answer)',
  '}',
  'return { count: answers.length, answers }',
  '',
].join("\n")
writeFileSync(join(dir, '.dsh', 'workflows', 'fanout.js'), workflowSource)

const agent = { id: 'e2e-parent', options: {}, cwd: dir }
const exec = { agent, signal: AbortSignal.timeout(120000), callId: 'e2e', name: 'x', arguments: {} }
const tool = (n) => { const t = captured.find((x) => x.name === n); if (!t) fail('缺少工具 ' + n); return t }

try {
  const listed = await tool('workflow_list').execute({}, exec)
  if (listed.workflows.length !== 1) fail('列表数量不对: ' + JSON.stringify(listed))
  ok('workflow_list 发现工作流: ' + listed.workflows[0].name)

  const shown = await tool('workflow_show').execute({ name: 'fanout' }, exec)
  if (!shown.script.includes('agent(')) fail('show 未返回脚本正文')
  if (!shown.args || !shown.args.includes('n (number)')) fail('show 未返回 args 说明: ' + JSON.stringify(shown.args))
  if (JSON.stringify(shown.phases) !== JSON.stringify(['gather', 'report'])) fail('show 未返回 phases: ' + JSON.stringify(shown.phases))
  ok('workflow_show 返回脚本 ' + shown.script.split('\n').length + ' 行，含 args 与 phases')

  const listedArgs = listed.workflows[0]
  if (JSON.stringify(listedArgs.phases) !== JSON.stringify(['gather', 'report'])) fail('list 未返回 phases')

  const t0 = Date.now()
  const out = await tool('workflow_run').execute({ name: 'fanout', args: { n: 3 } }, exec)
  console.log('    run = ' + JSON.stringify(out))
  if (out.stopReason !== 'completed') fail('未完成: ' + out.stopReason)
  if (out.agentsStarted !== 3) fail('agentsStarted 应为 3，实际 ' + out.agentsStarted)
  if (JSON.stringify(out.value.answers) !== JSON.stringify([42, 42, 42])) fail('answers 不对: ' + JSON.stringify(out.value))
  if (providerStarts !== 3) fail('provider 调用次数应为 3，实际 ' + providerStarts)
  ok('workflow_run 真实执行：3 个子 agent，耗时 ' + (Date.now() - t0) + 'ms')

  const saved = await tool('workflow_save').execute({ name: 'saved-e2e', description: 'saved', script: 'return { saved: true }' }, exec)
  const listed2 = await tool('workflow_list').execute({}, exec)
  if (listed2.workflows.length !== 2) fail('保存后列表应有 2 个')
  ok('workflow_save 写入 ' + saved.name + '，并立即出现在列表')

  const out2 = await tool('workflow_run').execute({ name: 'saved-e2e' }, exec)
  if (JSON.stringify(out2.value) !== JSON.stringify({ saved: true })) fail('保存脚本返回值不对: ' + JSON.stringify(out2.value))
  ok('运行刚保存的工作流成功')

  let threw = false
  try { await tool('workflow_run').execute({ name: 'nope' }, exec) } catch { threw = true }
  if (!threw) fail('未知名字应报错')
  ok('未知名字给出可执行报错')
} finally {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
}

console.log('E2E_PASS')

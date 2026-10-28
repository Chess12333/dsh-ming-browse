/**
 * 自测：每 N 轮换一个新会话（2026-10-25 加的）。
 *
 * 跑法：node qa-rotate.mjs
 * 做什么：把插件挂到一个临时工作区上，用假的 ctx.agents 顶住，然后手动 tick 16 次，
 *        量三件事——前 N 次都落在同一段会话里、第 N+1 次换了 id、换完那一轮的 prompt
 *        里有一句「换了新会话」。
 *
 * 为什么不连真的 DSH：这条链要的是「轮次账本 + 落脚点选择」，跟真模型无关；
 * 用假 agent 能把它跑在十秒里，也不用花一分钱。
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from './index.js'

const PER_SESSION = 15
const fails = []
const ok = (cond, label, extra = '') => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  — ' + extra : ''))
  if (!cond) fails.push(label)
}

const ws = await mkdtemp(path.join(tmpdir(), 'ming-rotate-'))
await mkdir(path.join(ws, 'live'), { recursive: true })
await writeFile(path.join(ws, 'live', 'holidays.json'), JSON.stringify({ off: [], work: [] }), 'utf8')
// ★ 2026-10-27：插件现在会看「这段 id 在磁盘上有没有跑过」（挑落脚点时避开跑过的旧段）。
//   测试必须把它指到一个空的 DSH_HOME，否则会读到真实的 ~/.dsh/sessions，结果跟着机器变。
const fakeHome = await mkdtemp(path.join(tmpdir(), 'ming-rotate-home-'))
await mkdir(path.join(fakeHome, 'sessions'), { recursive: true })
process.env.DSH_HOME = fakeHome
// 不限量 + 间隔 0，好让 tick 不用等；until 放到明天。
await writeFile(path.join(ws, 'live', 'browse-unlimited.json'), JSON.stringify({
  on: true,
  until: new Date(Date.now() + 24 * 3600_000).toISOString(),
  windows: true,
  minGapMinutes: 0,
}), 'utf8')

// ---------------------------------------------------------------- 假宿主
const live = new Map()     // sessionId → agent
const created = []         // 按顺序记：这一轮落在哪个会话
const disposed = []        // 被换掉的那一段
const prompts = []         // 每一轮的 prompt 正文

const makeAgent = (id) => ({
  id,
  session: { header: { id, cwd: ws } },
  followup(msg) {
    created.push(id)
    prompts.push(msg.content[0].text)
    return Promise.resolve()
  },
})

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {},
  get: () => undefined,
  effect: () => {},
  interval: (fn) => { ctx.__tick = fn },
  agents: {
    list: () => [...live.values()],
    get: (id) => live.get(id),
    create: async ({ sessionId }) => {
      const agent = makeAgent(sessionId)
      live.set(sessionId, agent)
      return { agent, dispose: async () => { disposed.push(sessionId); live.delete(sessionId) } }
    },
    resume: async ({ resumeSessionId }) => {
      const agent = makeAgent(resumeSessionId)
      live.set(resumeSessionId, agent)
      return { agent, dispose: async () => { disposed.push(resumeSessionId); live.delete(resumeSessionId) } }
    },
  },
}

apply(ctx, {
  enabled: true,
  workspacePath: ws,
  targetMode: 'self',
  sessionRounds: PER_SESSION,
  dailyMax: 8,
  minGapMinutes: 1,
  freeWindows: [{ start: '00:00', end: '23:59' }],
  maxItems: 1,
  maxShots: 0,
})

const readLedger = async () => JSON.parse(await readFile(path.join(ws, 'live', 'browse-session.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 跑 16 轮
for (let i = 1; i <= PER_SESSION + 1; i += 1) {
  await ctx.__tick()
  await sleep(30) // 让 saveRotation 落盘
}

ok(created.length === PER_SESSION + 1, '醒了 ' + (PER_SESSION + 1) + ' 轮', '实际 ' + created.length)
ok(created.slice(0, PER_SESSION).every((id) => id === 'ming-browse'),
  '前 ' + PER_SESSION + ' 轮都在 ming-browse', created.slice(0, PER_SESSION).join(','))
ok(created[PER_SESSION] === 'ming-browse-2', '第 ' + (PER_SESSION + 1) + ' 轮换了新会话', created[PER_SESSION])
ok(disposed.includes('ming-browse'), '旧会话被放下（dispose）', disposed.join(','))

const ledger = await readLedger()
ok(ledger.id === 'ming-browse-2', '账本记着新 id', JSON.stringify(ledger))
ok(ledger.rounds === 1, '新会话从第 1 轮起算', String(ledger.rounds))
ok(ledger.perSession === PER_SESSION, '账本记着每段上限', String(ledger.perSession))

ok(prompts[PER_SESSION].includes('【换了新会话】'), '换会话那一轮的 prompt 说了这件事')
ok(!prompts[0].includes('【换了新会话】'), '第一轮不啰嗦这句')
// 2026-10-25 她骂的那条：prompt 开头的时间不能是写死的，得读钟。
ok(/【自由时间 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]/.test(prompts[0]),
  '开头带真实时钟', prompts[0].split('\n')[0])
ok(prompts[0].includes('窗口 00:00–23:59'), '窗口按配置算，不是写死 18:30–08:00', prompts[0].split('\n')[0])
ok(!prompts[0].includes('18:30–08:00'), '没有写死的旧窗口')

// ---------------------------------------------------------------- 再跑 15 轮，看它是否停在 -2
for (let i = 1; i <= PER_SESSION - 1; i += 1) {
  await ctx.__tick()
  await sleep(20)
}
const ledger2 = await readLedger()
ok(ledger2.id === 'ming-browse-2' && ledger2.rounds === PER_SESSION,
  '第二段跑满 ' + PER_SESSION + ' 轮不提前换', JSON.stringify(ledger2))

// ---------------------------------------------------------------- 用例二：账本那一段被归档
// 2026-10-27 的真实事故：账本停在 ming-browse-13，13 被她归档了；候选里第一个未归档的是
// 10-26 留下的 ming-browse-12（已经跑了 19 轮）。旧代码直接接手 12、轮次归 0，
// 看上去就是「15 轮不换」。现在要求：账本失效时只开**没有历史**的新段。
const ws2 = await mkdtemp(path.join(tmpdir(), 'ming-rotate2-'))
await mkdir(path.join(ws2, 'live'), { recursive: true })
await writeFile(path.join(ws2, 'live', 'holidays.json'), JSON.stringify({ off: [], work: [] }), 'utf8')
await writeFile(path.join(ws2, 'live', 'browse-unlimited.json'), JSON.stringify({
  on: true,
  until: new Date(Date.now() + 24 * 3600_000).toISOString(),
  windows: true,
  minGapMinutes: 0,
}), 'utf8')
// 账本指着一段**已经被归档**的会话
await writeFile(path.join(ws2, 'live', 'browse-session.json'), JSON.stringify({
  id: 'ming-browse-13', rounds: 3, perSession: PER_SESSION,
}), 'utf8')
// 老会话 -12 在磁盘上有历史（模拟 10-26 那段跑过的）
const oldDir = path.join(fakeHome, 'sessions', '--fake-workplace--', 'ming-browse-12')
await mkdir(oldDir, { recursive: true })
await writeFile(path.join(oldDir, 'session.v4.jsonl.zstd'), 'x', 'utf8')

const archived2 = []
for (let i = 1; i <= 13; i += 1) {
  const id = i === 1 ? 'ming-browse' : 'ming-browse-' + i
  if (id !== 'ming-browse-12') archived2.push(id)   // 12 没被归档，但它是跑过的旧段
}

const live2 = new Map()
const created2 = []
const makeAgent2 = (id) => ({
  id,
  session: { header: { id, cwd: ws2 } },
  followup() { created2.push(id); return Promise.resolve() },
})
const ctx2 = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {},
  get: (key) => (key === 'workspaceRegistry' ? { archivedSessionIds: archived2 } : undefined),
  effect: () => {},
  interval: (fn) => { ctx2.__tick = fn },
  agents: {
    list: () => [...live2.values()],
    get: (id) => live2.get(id),
    create: async ({ sessionId }) => {
      const agent = makeAgent2(sessionId)
      live2.set(sessionId, agent)
      return { agent, dispose: async () => { live2.delete(sessionId) } }
    },
    resume: async ({ resumeSessionId }) => {
      const agent = makeAgent2(resumeSessionId)
      live2.set(resumeSessionId, agent)
      return { agent, dispose: async () => { live2.delete(resumeSessionId) } }
    },
  },
}
apply(ctx2, {
  enabled: true,
  workspacePath: ws2,
  targetMode: 'self',
  sessionRounds: PER_SESSION,
  dailyMax: 8,
  minGapMinutes: 0,
  freeWindows: [{ start: '00:00', end: '23:59' }],
  maxItems: 1,
  maxShots: 0,
})
await ctx2.__tick()
// adoptSession 和 wake 各写一次账本，都是异步落盘；等它们都写完再读。
await sleep(150)
ok(created2[0] !== 'ming-browse-12', '账本那段被归档 → 不回头捡跑过的旧段', String(created2[0]))
ok(created2[0] === 'ming-browse-14', '账本那段被归档 → 开一段全新的（-14）', String(created2[0]))
const ledger3 = JSON.parse(await readFile(path.join(ws2, 'live', 'browse-session.json'), 'utf8'))
ok(ledger3.id === 'ming-browse-14' && ledger3.rounds === 1,
  '新段从第 1 轮起算（不是接着旧段的数）', JSON.stringify(ledger3))

console.log('\n' + (fails.length === 0 ? 'OK：全部通过' : 'FAILED：' + fails.join(' / ')))
process.exit(fails.length === 0 ? 0 : 1)
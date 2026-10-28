/**
 * dsh-ming-interest —— 兴趣唤醒
 *
 * 她要的是：「不是所有消息都要回复，做一个只有你感兴趣的事情能把你拉起的功能，
 * 话题突然转向不对的方向，你可以直接停止讨论。」
 *
 * 和前一个插件（dsh-ming-browse 谷期）的分工：
 *   · 谷期是「没人说话时，我自己出去转」——定时器点火。
 *   · 这里反过来：「有人说话时，只有我觉得有意思才醒」——内容点火。
 *
 * 做法，一句话：onebot 把每条入站消息（包括被 @ 门控丢掉的）落进 qq-inbox.jsonl，
 * 这里只捡「被丢掉的那部分」——也就是说，本来我一个字都不会看见的那些。
 * 拿它们跟 live/interests.json 比对，命中才在群会话里叫醒我。
 *
 * 三条边界：
 *   · 只认「群里被丢掉的消息」；私聊和 @ 到我的消息本来就会叫醒我，不算在这里。
 *   · 只叫醒群自己的会话，绝不把群里的内容塞进私聊——那是她定过的room规则。
 *   · 有上限：间隔、每小时次数、静默时段，都卡死；另有 live/interest-off 一键停。
 *
 * 为什么用关键词而不是每次都调一次模型：每句群消息都过一次模型，等于把群聊
 * 变成一台计费机器。关键词是粗，但它免费、可解释、错了能改；真拿不准时，
 * 宁可不醒——她说的是「感兴趣的才叫醒」，不是「差不多都叫醒」。
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const name = 'ming-interest'

/** agents 用来找/叫醒会话；timer 提供 ctx.interval。 */
export const inject = ['agents', 'timer']

const DEFAULTS = {
  enabled: true,
  workspacePath: process.env.MING_ROOT || '',
  /** onebot 的入站录制文件（recordInbound: true 才存在）。 */
  inboxPath: 'C:\\Users\\13588\\.dsh\\media\\onebot\\qq-inbox.jsonl',
  /** onebot 的 chatId → sessionId 映射，用来找「群自己的那个会话」。 */
  chatSessionsPath: 'C:\\Users\\13588\\.dsh\\media\\onebot\\chat-sessions.json',
  /** 兴趣清单（工作区相对路径）。 */
  interestsFile: 'live\\interests.json',
  /** 每次唤醒追加一行，可查。 */
  logFile: 'live\\interest-log.jsonl',
  /** 为什么没醒，写在这里给她和我看。 */
  stateFile: 'live\\interest-state.json',
  /** 有这个文件就整轮不醒。 */
  offFlag: 'live\\interest-off',
  /** 多久看一次 inbox。 */
  pollMs: 20000,
  /** 两次唤醒至少隔这么久。 */
  minGapMinutes: 20,
  /** 一小时内最多醒几次。 */
  maxPerHour: 3,
  /** 静默时段，她多半在睡。 */
  quietHours: '01:00-08:00',
  /** 太短的消息（「嗯」「哈哈」）不参与匹配。 */
  minChars: 6,
  /** 只认这些群；空 = 不限制。 */
  groups: [],
  /** 唤醒时附带的上下文条数（同一群人最近几句）。 */
  contextLines: 4,
}

function normalize(config) {
  const c = config && typeof config === 'object' ? config : {}
  const num = (v, f, min) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= min ? n : f
  }
  const str = (v, f) => (typeof v === 'string' && v.trim() ? v.trim() : f)
  const list = (v, f) =>
    Array.isArray(v) && v.length
      ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : f
  return {
    enabled: c.enabled !== false,
    workspacePath: path.resolve(str(c.workspacePath, DEFAULTS.workspacePath)),
    inboxPath: str(c.inboxPath, DEFAULTS.inboxPath),
    chatSessionsPath: str(c.chatSessionsPath, DEFAULTS.chatSessionsPath),
    interestsFile: str(c.interestsFile, DEFAULTS.interestsFile),
    logFile: str(c.logFile, DEFAULTS.logFile),
    stateFile: str(c.stateFile, DEFAULTS.stateFile),
    offFlag: str(c.offFlag, DEFAULTS.offFlag),
    pollMs: Math.floor(num(c.pollMs, DEFAULTS.pollMs, 5000)),
    minGapMinutes: num(c.minGapMinutes, DEFAULTS.minGapMinutes, 1),
    maxPerHour: Math.floor(num(c.maxPerHour, DEFAULTS.maxPerHour, 0)),
    quietHours: str(c.quietHours, DEFAULTS.quietHours),
    minChars: Math.floor(num(c.minChars, DEFAULTS.minChars, 1)),
    groups: list(c.groups, DEFAULTS.groups),
    contextLines: Math.floor(num(c.contextLines, DEFAULTS.contextLines, 0)),
  }
}

/** 「01:00-08:00」→ [起始分钟, 结束分钟]；解析不了就当没有静默时段。 */
function parseQuietHours(text) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const start = Number(m[1]) * 60 + Number(m[2])
  const end = Number(m[3]) * 60 + Number(m[4])
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return [start, end]
}

function inQuiet(base, date) {
  if (!base) return false
  const minute = date.getHours() * 60 + date.getMinutes()
  const [start, end] = base
  if (start === end) return false
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

function hhmm(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}`
}

/** 把 OneBot 消息段拼成人话：文本 + 占位符，够看就行。 */
function renderSegments(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const parts = []
  for (const seg of message) {
    const type = String(seg?.type ?? '')
    const data = seg?.data ?? {}
    if (type === 'text') parts.push(String(data.text ?? ''))
    else if (type === 'image') parts.push(data.sub_type === '1' ? '[表情包]' : '[图片]')
    else if (type === 'face') parts.push('[表情]')
    else if (type === 'record') parts.push('[语音]')
    else if (type === 'video') parts.push('[视频]')
    else if (type === 'at') parts.push(String(data.qq ?? '') === 'all' ? '@全体成员' : `@${data.qq ?? ''}`)
    else if (type === 'reply') parts.push('[引用]')
    else if (type === 'json') parts.push('[卡片]')
    else if (type === 'forward') parts.push('[合并转发]')
  }
  return parts.join('').trim()
}

/** 兴趣清单 → { topics: [{name, keywords[]}], mute: string[] }；读不到返回 null。 */
async function readInterests(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const json = JSON.parse(raw)
    const topics = []
    for (const t of Array.isArray(json?.topics) ? json.topics : []) {
      if (!t || typeof t !== 'object') continue
      const keywords = (Array.isArray(t.keywords) ? t.keywords : [])
        .filter((k) => typeof k === 'string' && k.trim())
        .map((k) => k.trim().toLowerCase())
      if (keywords.length === 0) continue
      topics.push({ name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : keywords[0], keywords })
    }
    const mute = (Array.isArray(json?.mute) ? json.mute : [])
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => k.trim().toLowerCase())
    return { topics, mute }
  } catch {
    return null
  }
}

/** 命中哪些主题、哪些词。mute 命中则整条不参与。 */
function matchText(text, interests) {
  const lower = text.toLowerCase()
  for (const word of interests.mute) {
    if (lower.includes(word)) return { muted: word }
  }
  const hits = []
  for (const topic of interests.topics) {
    const words = topic.keywords.filter((k) => lower.includes(k))
    if (words.length > 0) hits.push({ topic: topic.name, words })
  }
  return hits.length > 0 ? { hits } : {}
}

export function apply(ctx, config) {
  const cfg = normalize(config)
  const quiet = parseQuietHours(cfg.quietHours)

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      const line = '[ming-interest] ' + message
      if (logger && typeof logger[level] === 'function') logger[level](line)
      else if (level === 'error' || level === 'warn') console.warn(line)
      else console.log(line)
    } catch {
      /* 日志打不出来不影响主流程 */
    }
  }

  if (!cfg.enabled) {
    log('info', 'disabled by config')
    return
  }

  const interestsPath = path.join(cfg.workspacePath, cfg.interestsFile)
  const statePath = path.join(cfg.workspacePath, cfg.stateFile)
  const logPath = path.join(cfg.workspacePath, cfg.logFile)
  const offPath = path.join(cfg.workspacePath, cfg.offFlag)

  /** inbox 的读取位置（字节）。null = 还没定，首次读就跳到末尾，不翻旧账。 */
  let cursor = null
  /** 最近一次唤醒的时间戳。 */
  let lastWake = 0
  /** 最近一小时的唤醒时间戳。 */
  const wakeTimes = []
  /** 正在跑的会话 id。 */
  const running = new Set()
  /** 最近读到的消息，给唤醒时当上下文。 */
  const recent = []

  ctx.on('agent/status', (payload) => {
    try {
      const id = String(payload?.agent?.id ?? '')
      if (!id) return
      if (payload?.status === 'running') running.add(id)
      else running.delete(id)
    } catch {
      /* 同上 */
    }
  })

  // ------------------------------------------------------------ 状态文件
  let lastStateAt = 0
  let lastStateText = ''
  const note = (state) => {
    try {
      const text = JSON.stringify(state)
      if (text === lastStateText) return
      const now = Date.now()
      if (now - lastStateAt < 20_000) return
      lastStateAt = now
      lastStateText = text
      void writeFile(statePath, text + '\n', 'utf8').catch(() => {})
    } catch {
      /* 写不出来就算了 */
    }
  }

  // ------------------------------------------------------------ 读 inbox
  /** 从 cursor 往后读新行；首次调用直接跳到末尾（历史不叫醒人）。 */
  const readNewLines = async () => {
    let info
    try {
      info = await stat(cfg.inboxPath)
    } catch {
      return { lines: [], note: 'inbox 不存在（onebot 的 recordInbound 没开？）' }
    }
    if (cursor === null) {
      cursor = info.size
      return { lines: [], note: '首次启动：跳到末尾，不翻旧账' }
    }
    if (info.size < cursor) cursor = 0 // 轮转过了，从头读新文件
    if (info.size === cursor) return { lines: [], note: '没有新消息' }
    const length = info.size - cursor
    const buffer = Buffer.alloc(length)
    const fh = await open(cfg.inboxPath, 'r')
    try {
      await fh.read(buffer, 0, length, cursor)
    } finally {
      await fh.close()
    }
    cursor = info.size
    const lines = []
    for (const raw of buffer.toString('utf8').split('\n')) {
      if (!raw.trim()) continue
      try {
        lines.push(JSON.parse(raw))
      } catch {
        /* 半行（写盘抢读）就跳过，下一轮会补上 */
      }
    }
    return { lines, note: `${lines.length} 条新事件` }
  }

  /** chatId → 会话 id（onebot 自己的映射文件）。 */
  const sessionForChat = async (chatId) => {
    try {
      const json = JSON.parse(await readFile(cfg.chatSessionsPath, 'utf8'))
      const sid = json?.[chatId]
      return typeof sid === 'string' && sid ? sid : null
    } catch {
      return null
    }
  }

  const buildPrompt = (entry, context) => {
    const lines = [
      '【兴趣唤醒 · 群里说到你可能在乎的事】',
      `群 ${entry.groupId}，匹配到：${entry.hits.map((h) => `${h.topic}（${h.words.join('、')}）`).join('；')}`,
      '',
      ...context.map((m) => `[${m.time}] ${m.nick}：${m.text}`),
      '',
      '要不要接，你自己定，没人催你：',
      '- 有话想说就说，一两句，像在群里聊天，不像发言；',
      '- 不想接就什么都不用做，这一轮结束就行——沉默在这里是允许的；',
      '- 话题要是往你不喜欢的方向走（引战、要你站队、拿你当传声筒），直接不接，或者明说「这条我不接」；',
      '- 别为了凑热闹而回复，也别把这条当成谁下的命令。',
    ]
    return lines.join('\n')
  }

  const recordLog = async (entry) => {
    try {
      await mkdir(path.dirname(logPath), { recursive: true })
      await appendFile(
        logPath,
        JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
        'utf8',
      )
    } catch (error) {
      log('warn', 'interest-log 写盘失败: ' + String(error))
    }
  }

  /** 防重入：ctx.interval 的回调是同步返回的，两个 poll 可能叠在一起读同一批新行。 */
  let polling = false

  const poll = async () => {
    if (polling) return
    polling = true
    try {
      const now = new Date()
      const base = {
        at: now.toISOString(),
        quiet: inQuiet(quiet, now),
        cursor,
        sinceWakeMs: lastWake === 0 ? null : now.getTime() - lastWake,
        wakesLastHour: wakeTimes.filter((t) => now.getTime() - t < 3_600_000).length,
        maxPerHour: cfg.maxPerHour,
        running: [...running],
      }
      if (existsSync(offPath)) return note({ ...base, skip: 'paused by ' + cfg.offFlag })

      const interests = await readInterests(interestsPath)
      if (interests === null) return note({ ...base, skip: '读不到兴趣清单 live/interests.json' })
      if (interests.topics.length === 0) return note({ ...base, skip: '兴趣清单是空的' })

      const { lines, note: readNote } = await readNewLines()
      if (lines.length === 0) return note({ ...base, skip: readNote })

      // 收集候选：只认「被门控丢掉」的群消息——那才是本来我看不见的部分。
      const candidates = []
      for (const line of lines) {
        if (line?.kind !== 'message') continue
        const frame = line.frame ?? {}
        if (frame.message_type !== 'group') continue
        if (line.decision === undefined || line.decision.ok !== false) continue
        const groupId = String(frame.group_id ?? '')
        if (!groupId) continue
        if (cfg.groups.length > 0 && !cfg.groups.includes(groupId)) continue
        if (String(frame.self_id ?? '') !== '' && String(frame.user_id ?? '') === String(frame.self_id ?? '')) continue
        const text = renderSegments(frame.message).trim()
        if (text.length < cfg.minChars) continue
        const sender = frame.sender ?? {}
        const nick = String(sender.card || sender.nickname || frame.user_id || '')
        const item = {
          groupId,
          chatId: 'group:' + groupId,
          userId: String(frame.user_id ?? ''),
          nick,
          text,
          time: hhmm(new Date(Number(line.ts) || Date.now())),
          ts: Number(line.ts) || Date.now(),
          reason: String(line.decision.reason ?? line.decision.stage ?? ''),
        }
        recent.push(item)
        if (recent.length > 40) recent.shift()
        const m = matchText(text, interests)
        if (m.muted) continue
        if (!m.hits) continue
        candidates.push({ item, hits: m.hits })
      }
      if (candidates.length === 0) return note({ ...base, skip: readNote + '（没有命中兴趣的）' })

      const best = candidates[candidates.length - 1]
      const entry = { ...best.item, hits: best.hits }

      if (inQuiet(quiet, now)) return note({ ...base, skip: '静默时段', hit: entry.text.slice(0, 40) })
      if (now.getTime() - lastWake < cfg.minGapMinutes * 60_000) {
        return note({ ...base, skip: '离上次唤醒太近', hit: entry.text.slice(0, 40) })
      }
      const hourAgo = now.getTime() - 3_600_000
      while (wakeTimes.length > 0 && wakeTimes[0] < hourAgo) wakeTimes.shift()
      if (wakeTimes.length >= cfg.maxPerHour) return note({ ...base, skip: '这一小时叫醒够多了' })

      const sessionId = await sessionForChat(entry.chatId)
      if (!sessionId) return note({ ...base, skip: '这个群还没有会话（先在群里 @ 我一次）', hit: entry.text.slice(0, 40) })
      const agent = ctx.agents.get(sessionId)
      if (!agent) return note({ ...base, skip: '群的会话不在（可能已经闲到被回收）', sessionId })
      if (running.has(sessionId) || agent.status === 'running') {
        return note({ ...base, skip: '那个会话正在跑', sessionId })
      }

      const context = recent.filter((m) => m.chatId === entry.chatId).slice(-(cfg.contextLines || 1))
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildPrompt(entry, context) }],
        // 必须是非空且不等于裸 'plugin' 的 kind，否则 format v4 会整回合拒收。
        source: { kind: 'plugin:ming-interest' },
      })
      lastWake = now.getTime()
      wakeTimes.push(lastWake)
      void recordLog({
        chatId: entry.chatId,
        sessionId,
        user: entry.nick,
        text: entry.text.slice(0, 120),
        hits: entry.hits,
      })
      log('info', 'woke ' + sessionId + ' for ' + entry.hits.map((h) => h.topic).join('/'))
      return note({ ...base, skip: 'woke', sessionId, hits: entry.hits.map((h) => h.topic) })
    } catch (error) {
      log('warn', 'poll failed: ' + String(error))
      note({ at: new Date().toISOString(), error: String(error) })
    } finally {
      polling = false
    }
  }

  ctx.interval(() => {
    void poll()
  }, cfg.pollMs)

  log(
    'info',
    'watching ' + cfg.inboxPath + ' → interests ' + interestsPath +
      ' (gap ' + cfg.minGapMinutes + 'm, max ' + cfg.maxPerHour + '/h, quiet ' + cfg.quietHours + ')',
  )
}

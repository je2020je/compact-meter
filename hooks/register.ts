import type { Register } from 'claude-code'
import { decide, relaunchVerdict, sectionsOf, usageRecord } from './filter'

// The meter measures. An opt-in filter (COMPACT_FILTER=on) drops the blocks Claude Code re-attaches after a
// compact; it is OFF unless that variable is exactly `on`, and it fails open (see filter.ts).
// Sizes are characters (~3.5 chars per token for English, fewer for other scripts). No message text is logged.
// The log is $COMPACT_METER_LOG when set, else $HOME/.claude/compact-meter.log: no machine path is written here.
type Io = { env: { get: (n: string) => Promise<string | undefined> }; fs: { read: (p: string) => Promise<unknown>; write: (p: string, s: string) => Promise<unknown> } }
let LOG = ''
const lines: string[] = []
let afterCompact = 0 // rows still to log after a compaction
// A compact in one process and the first prompt in a relaunched one leave both counters at 0, so the restored
// Reads and skills would never be logged. A new process therefore logs its first attachments too, under a
// `== … process-start` header.
let afterAttach = 40 // per-request attachments still to log after a compaction or a process start
let started = false
let filterWindow = 0 // post-compact requests still filtered; 0 = filter inactive (also after a process start)
let stateText: string | null | undefined // undefined = not read since the last compact
// The engine dedupes a skill that is called again after a compact ("loaded earlier, see the invoked-skills
// reminder"), and that reminder is itself an invoked_skills attachment. Dropping every such attachment in the
// window would drop the re-invoked skill too. Only the FIRST invoked_skills attachment after a compact is the
// restore; every later one is a re-invocation and is kept.
let skillsRestoreDropped = false
// A process that never saw `session.compact` may still be the resume of a compact (Claude Code was quit after
// it). With the filter on, the first attachment request reads this session's transcript once; every parallel
// hook awaits the same promise.
let compactSeen = false
let relaunchCheck: Promise<'yes' | 'no' | 'unknown'> | null = null
let relaunchApplied = false

const size = (c: unknown) => JSON.stringify(c ?? '').length
const logPath = async ($: Io) => {
  LOG ||= (await $.env.get('COMPACT_METER_LOG')) || `${(await $.env.get('HOME')) ?? '.'}/.claude/compact-meter.log`
  return LOG
}
// The fs surface offers read + write but no append, so each flush reads the log as it stands now and adds only
// this process's new rows. A read rejects when the file is missing (start fresh) or over 4 MiB.
// Parallel attachment hooks flush at once: flushes run one at a time on one chain (a stale read written last
// would erase the other rows), and a flush with no rows writes nothing.
let flushChain: Promise<void> = Promise.resolve()
const flush = ($: Io): Promise<void> => {
  flushChain = flushChain.then(() => flushNow($)).catch(() => {})
  return flushChain
}
const flushNow = async ($: Io) => {
  if (lines.length === 0) return
  const path = await logPath($)
  let prev = ''
  try {
    const t = await $.fs.read(path)
    if (typeof t === 'string') prev = t
  } catch {
    // no log yet: start fresh
  }
  if (prev !== '' && !prev.endsWith('\n')) prev += '\n'
  await $.fs.write(path, prev + lines.splice(0).join('\n') + '\n')
}

// The STATE file is the path in $COMPACT_FILTER_STATE and nothing else: no default location is searched.
// null (variable unset, file missing, unreadable or empty) makes the filter change nothing.
const readState = async ($: any): Promise<string | null> => {
  try {
    const path = await $.env.get('COMPACT_FILTER_STATE')
    if (!path) return null
    const t = await $.fs.read(path)
    return typeof t === 'string' && t.length > 0 ? t : null
  } catch {
    return null
  }
}

// $COMPACT_FILTER_KEEP: comma list of skill names that stay in the restored-skills block. Empty by default.
const keepList = async ($: any): Promise<string[]> => {
  try {
    return ((await $.env.get('COMPACT_FILTER_KEEP')) ?? '')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => s !== '')
  } catch {
    return []
  }
}

// Was this session compacted and not yet answered? Read the transcript's tail in ranges (fs.read rejects over
// 4 MiB and a transcript is often larger). Any error = 'unknown' = the caller drops nothing.
const TAIL = [1024 * 1024, 4 * 1024 * 1024 - 4096]
const checkRelaunch = async ($: any): Promise<{ verdict: 'yes' | 'no' | 'unknown'; why: string }> => {
  try {
    const path = (await $.session.info()).transcriptPath
    if (typeof path !== 'string' || path === '') return { verdict: 'unknown', why: 'no transcript path' }
    const { size } = await $.fs.stat(path)
    for (const want of TAIL) {
      const len = Math.min(size, want)
      const text = await $.fs.read(path, { offset: size - len, length: len })
      if (typeof text !== 'string') return { verdict: 'unknown', why: 'unreadable' }
      const v = relaunchVerdict(text, len === size)
      if (v !== 'more') return { verdict: v, why: `${len} of ${size} bytes` }
    }
    return { verdict: 'unknown', why: 'no compact_boundary in the last 4 MiB' }
  } catch (err) {
    return { verdict: 'unknown', why: `error ${String((err as Error)?.message ?? err).slice(0, 80)}` }
  }
}

const filterIsOn = async ($: any): Promise<boolean> => {
  try {
    return (await $.env.get('COMPACT_FILTER')) === 'on'
  } catch {
    return false
  }
}

// The usage file: one writer per process, one write at a time.
let usageChain: Promise<void> = Promise.resolve()

export const register: Register = on => {
  // One register call per process. The tests call it once per test: a fresh process state each time.
  LOG = ''
  lines.length = 0
  afterCompact = 0
  afterAttach = 40
  started = false
  compactSeen = false
  relaunchCheck = null
  relaunchApplied = false
  filterWindow = 0
  stateText = undefined
  skillsRestoreDropped = false
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined && !e.agentId) {
      lines.push(`== ${new Date().toISOString()} compact trigger=${e.trigger} before=${r.tokensBefore ?? '?'} after=${r.tokensAfter ?? '?'} kept=${r.messages.length}`)
      r.messages.forEach((m, i) => lines.push(`  kept[${i}] ${m.role} chars=${m.text.length} tools=${m.toolUses.length}`))
      afterCompact = 60
      afterAttach = 40
      filterWindow = 40
      stateText = undefined
      skillsRestoreDropped = false
      compactSeen = true
      started = true
      if (await filterIsOn($)) lines.push(`  filter on (COMPACT_FILTER=on)`)
      await flush($)
    }
    return r
  })

  // The restored Reads and skills do not pass session.append: they are rendered per request, here.
  on('prompt.attachment', async ($, e, next) => {
    const filterOn = !e.agentId && (await filterIsOn($))
    // A process that saw no compact asks the transcript once (memoized, started before any decide; the
    // attachment hooks run in parallel and all await this one promise). Filter off: no transcript is read.
    if (filterOn && !compactSeen) {
      try {
        relaunchCheck ??= checkRelaunch($).then(c => {
          lines.push(`  filter relaunch-check verdict=${c.verdict} (${c.why})`)
          return c.verdict
        })
        const verdict = await relaunchCheck
        if (verdict === 'yes' && !relaunchApplied && !compactSeen) {
          relaunchApplied = true
          filterWindow = 40
          stateText = undefined
          skillsRestoreDropped = false
          lines.push(`  filter window opened (relaunch after compact)`)
        }
        await flush($)
      } catch {
        // fail open
      }
    }
    // The window is the first 40 attachment requests after the compact: each one counts, then the filter goes
    // quiet for the rest of the process.
    let windowOpen = false
    if (!e.agentId && filterWindow > 0) {
      windowOpen = true
      filterWindow -= 1
    }
    let r = await next(e)
    if (filterOn && windowOpen && (e.type === 'file' || e.type === 'compact_file_reference' || e.type === 'invoked_skills')) {
      try {
        if (r.text === null || r.text === undefined) {
          // An empty render is the engine's, not a drop: row it, so a bare `attach … chars=0` never stands alone.
          lines.push(`  filter skip type=${e.type} chars=0 (empty)`)
          await flush($)
        } else {
          if (stateText === undefined) stateText = await readState($)
          let d = decide(e.type, r.text, stateText, await $.session.cwd(), await keepList($))
          if (e.type === 'invoked_skills' && d.action !== 'keep') {
            if (skillsRestoreDropped) {
              d = { action: 'keep', rows: sectionsOf(r.text).map(s => `filter keep type=invoked_skills skill=${s.name} chars=${s.text.length} (re-invoked after compact)`) }
            } else skillsRestoreDropped = true
          }
          for (const row of d.rows) lines.push(`  ${row}`)
          if (d.action === 'drop') r = { text: null }
          else if (d.action === 'rewrite') r = { text: d.text }
          if (d.rows.length > 0) await flush($)
        }
      } catch {
        // fail open: r stays as resolved
      }
    }
    if (!e.agentId && afterAttach > 0) {
      afterAttach -= 1
      if (!started) {
        started = true
        if (lines.length === 0) lines.push(`== ${new Date().toISOString()} process-start (attachments of the first requests)`)
      }
      if (e.type === 'invoked_skills') {
        for (const s of sectionsOf(r.text ?? '')) {
          lines.push(`  invoked_skills skill=${s.name} chars=${s.text.length}`)
        }
      } else {
        lines.push(`  attach type=${e.type} chars=${r.text?.length ?? 0}`)
      }
      await flush($)
    }
    return r
  })

  // The plan quota, read for free. The engine reports the rate-limit windows after each response; the usage
  // file lets a script read them without a probe request. Written whether or not the filter is on.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.rateLimits.length > 0) {
        const dir = (await $.env.get('COMPACT_METER_DIR')) || `${(await $.env.get('HOME')) ?? '.'}/.claude/compact-meter`
        const id = await $.session.id()
        const body = usageRecord(id, e.rateLimits, new Date())
        usageChain = usageChain.then(() => $.fs.write(`${dir}/usage-${id}.json`, body)).catch(() => {})
        await usageChain
      }
    } catch {
      // never break the session over a reading
    }
    return r
  })

  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && (afterCompact > 0 || e.door === 'compaction')) {
      afterCompact = Math.max(afterCompact - 1, 0)
      lines.push(`  row door=${e.door} type=${e.message.type} name=${e.message.name ?? '-'} role=${e.message.role ?? '-'} chars=${size(e.message.content)}`)
      await flush($)
    }
    return r
  })
}

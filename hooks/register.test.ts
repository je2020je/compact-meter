import { expect, test } from 'claude-code/testing'
import { register } from './register'
import { rows as positiveRows } from './fixtures/relaunch-positive'
import { rows as negativeRows } from './fixtures/relaunch-negative'

type Hook = ($: any, e: any, next: any) => Promise<any>

const load = () => {
  const handlers: Record<string, Hook> = {}
  ;(register as any)((pattern: string, hook: Hook) => {
    handlers[pattern] = hook
  }, {})
  return handlers
}

type StubOpts = { env?: Record<string, string>; files?: Record<string, string> }

// Minimal $ for register.ts: env.get, fs.read/write, session.cwd. Writes are captured in memory.
// Reads reject (file missing) unless the path is in `files`.
const LOG = '/m/test.log'
const stub = (opts: StubOpts = {}) => {
  const writes: Array<{ path: string; text: string }> = []
  const files = opts.files ?? {}
  const env = opts.env ?? {}
  const $ = {
    env: { get: async (n: string) => env[n] },
    fs: {
      read: async (p: string) => {
        if (p in files) return files[p]
        throw new Error('ENOENT')
      },
      write: async (p: string, s: string) => {
        writes.push({ path: p, text: s })
      },
    },
    session: { cwd: async () => '/r', id: async () => 'sess-1' },
  }
  return { $, writes, logged: () => writes.map(w => w.text).join('\n') }
}

const STATE_PATH = '/r/resume.md'
// The filter ON, with a STATE file that exists.
const on = (extra: Record<string, string> = {}) =>
  stub({ env: { COMPACT_METER_LOG: LOG, COMPACT_FILTER: 'on', COMPACT_FILTER_STATE: STATE_PATH, ...extra }, files: { [STATE_PATH]: 'resume notes' } })

const compactEvent = () => ({ trigger: 'manual' })
const compactNext = () => async () => ({
  tokensBefore: 1,
  tokensAfter: 1,
  messages: [{ role: 'assistant', text: 'SUMMARY-TEXT-MARKER', toolUses: [] }] as unknown[],
})
const attachNext = (text: string | null) => async () => ({ text })
const FILE = 'Called the Read tool with the following input: {"file_path":"/r/docs/notes.md"}\nbody'
const RESTORE = '### Skill: alpha\nPath: projectSettings:alpha\n\nalpha body\n### Skill: beta\nPath: projectSettings:beta\n\nbeta body'

test('default: with COMPACT_FILTER unset the filter is off and a restored Read and a skill block are kept', async () => {
  const h = load()
  const s = stub({ env: { COMPACT_METER_LOG: LOG, COMPACT_FILTER_STATE: STATE_PATH }, files: { [STATE_PATH]: 'resume notes' } })
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const f = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(FILE))
  const k = await h['prompt.attachment']!(s.$, { type: 'compact_file_reference' }, attachNext('Note: /r/a.md was read before'))
  const sk = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(f.text).toBe(FILE)
  expect(k.text).toBe('Note: /r/a.md was read before')
  expect(sk.text).toBe(RESTORE)
  expect(s.logged()).not.toContain('filter drop')
  // the meter still measures: the attachments are logged
  expect(s.logged()).toContain('attach type=file chars=' + FILE.length)
  expect(s.logged()).toContain('invoked_skills skill=alpha')
})

test('off: any value other than "on" leaves the filter off, and a relaunch reads no transcript', async () => {
  for (const v of ['off', 'ON', 'true', '1', '']) {
    const h = load()
    const s = on({ COMPACT_FILTER: v })
    let transcriptReads = 0
    ;(s.$ as any).session.info = async () => {
      transcriptReads += 1
      return { transcriptPath: '/t/s.jsonl' }
    }
    const f = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(FILE))
    expect(f.text).toBe(FILE)
    expect(transcriptReads).toBe(0)
  }
})

test('COMPACT_FILTER=on: a restored Read and the restored skills are dropped after a compact, with a row each', async () => {
  const h = load()
  const s = on()
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const f = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(FILE))
  const sk = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  const other = await h['prompt.attachment']!(s.$, { type: 'skill_listing' }, attachNext('listing'))
  expect(f.text).toBe(null)
  expect(sk.text).toBe(null)
  expect(other.text).toBe('listing') // other types are never touched
  expect(s.logged()).toContain('filter drop type=file path=docs/notes.md chars=' + FILE.length)
  expect(s.logged()).toContain('filter drop type=invoked_skills skill=alpha')
  expect(s.logged()).toContain('filter drop type=invoked_skills skill=beta')
})

test('COMPACT_FILTER=on without COMPACT_FILTER_STATE keeps everything (no resume file, nothing dropped)', async () => {
  const h = load()
  const s = stub({ env: { COMPACT_METER_LOG: LOG, COMPACT_FILTER: 'on' } })
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const f = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(FILE))
  const sk = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(f.text).toBe(FILE)
  expect(sk.text).toBe(RESTORE)
  expect(s.logged()).toContain('filter keep type=file path=docs/notes.md')
  expect(s.logged()).toContain('(no STATE)')
})

test('COMPACT_FILTER=on with an unreadable STATE path keeps everything (fail open)', async () => {
  const h = load()
  const s = stub({ env: { COMPACT_METER_LOG: LOG, COMPACT_FILTER: 'on', COMPACT_FILTER_STATE: '/r/missing.md' } })
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const f = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(FILE))
  expect(f.text).toBe(FILE)
})

test('COMPACT_FILTER=on and COMPACT_FILTER_KEEP: a named skill stays in the block, the others are cut', async () => {
  const h = load()
  const s = on({ COMPACT_FILTER_KEEP: ' beta , other ' })
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const sk = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(sk.text).toContain('### Skill: beta')
  expect(sk.text).not.toContain('### Skill: alpha')
  expect(s.logged()).toContain('filter keep type=invoked_skills skill=beta')
  expect(s.logged()).toContain('filter drop type=invoked_skills skill=alpha')
})

test('COMPACT_FILTER=on: only the first invoked_skills block after a compact is dropped; a re-invocation is kept', async () => {
  const h = load()
  const s = on()
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const first = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(first.text).toBe(null)
  const again = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext('### Skill: alpha\nalpha body'))
  expect(again.text).toBe('### Skill: alpha\nalpha body')
  expect(s.logged()).toContain('(re-invoked after compact)')
  // the next compact re-arms the drop
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const third = await h['prompt.attachment']!(s.$, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(third.text).toBe(null)
})

test('COMPACT_FILTER=on: an empty attachment is logged as a skip, never as a drop; subagent attachments are untouched', async () => {
  const h = load()
  const s = on()
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  const r = await h['prompt.attachment']!(s.$, { type: 'file' }, attachNext(null))
  expect(r.text).toBe(null)
  expect(s.logged()).toContain('filter skip type=file chars=0 (empty)')
  const sub = await h['prompt.attachment']!(s.$, { type: 'file', agentId: 'a1' }, attachNext(FILE))
  expect(sub.text).toBe(FILE)
})

test('COMPACT_FILTER=on: parallel attachments never clobber each other in the log', async () => {
  const h = load()
  let disk = ''
  const tick = () => new Promise(r => setTimeout(r, 1))
  const $ = {
    env: { get: async (n: string) => ({ COMPACT_METER_LOG: LOG, COMPACT_FILTER: 'on', COMPACT_FILTER_STATE: STATE_PATH } as Record<string, string>)[n] },
    fs: {
      read: async (p: string) => {
        if (p === STATE_PATH) return 'resume notes'
        await tick()
        return disk
      },
      write: async (_p: string, s: string) => {
        await tick()
        disk = s
      },
    },
    session: { cwd: async () => '/r', id: async () => 'sess-1' },
  }
  await h['session.compact']!($, compactEvent(), compactNext())
  await Promise.all([
    h['prompt.attachment']!($, { type: 'invoked_skills' }, attachNext(RESTORE)),
    h['prompt.attachment']!($, { type: 'compact_file_reference' }, attachNext('Note: /r/docs/notes.md was read before')),
    h['prompt.attachment']!($, { type: 'date' }, attachNext('2026')),
  ])
  expect(disk).toContain('filter drop type=invoked_skills skill=alpha')
  expect(disk).toContain('filter drop type=invoked_skills skill=beta')
  expect(disk).toContain('filter drop type=compact_file_reference path=docs/notes.md')
  expect(disk).not.toContain('\n\n\n')
})

test('log rows hold sizes and names, never message text', async () => {
  const h = load()
  const s = on()
  await h['session.compact']!(s.$, compactEvent(), compactNext())
  await h['prompt.attachment']!(s.$, { type: 'instructions' }, attachNext('SECRET-BODY-MARKER'))
  await h['session.append']!(s.$, { door: 'compaction', message: { type: 'user', content: 'ROW-BODY-MARKER' } }, async () => ({}))
  const log = s.logged()
  expect(log).toContain('kept[0] assistant chars=19')
  expect(log).toContain('attach type=instructions chars=18')
  expect(log).toContain('row door=compaction type=user')
  expect(log).not.toContain('SUMMARY-TEXT-MARKER')
  expect(log).not.toContain('SECRET-BODY-MARKER')
  expect(log).not.toContain('ROW-BODY-MARKER')
})

// ---- relaunch: Claude Code quit after a compact, the next prompt comes in a new process ----------------------
// That process never saw `session.compact`. The transcript still says it: the last compact_boundary row has no
// main-thread assistant row after it. The fixtures are structure only (type, subtype, isSidechain, timestamp).
// A hooks module imports only .ts/.js files, so the fixtures are .ts rows joined to JSONL here.
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const POSITIVE = jsonl(positiveRows)
const NEGATIVE = jsonl(negativeRows)
const TRANSCRIPT = '/t/s.jsonl'
const relaunchStub = (transcript: string | Error, extra: Record<string, string> = {}) => {
  const s = on(extra)
  const reads: Array<{ offset?: number; length?: number }> = []
  const $ = s.$ as any
  $.session.info = async () => ({ transcriptPath: TRANSCRIPT })
  $.fs.stat = async () => {
    if (transcript instanceof Error) throw transcript
    return { size: new TextEncoder().encode(transcript).length }
  }
  const baseRead = $.fs.read
  $.fs.read = async (p: string, o?: { offset?: number; length?: number }) => {
    if (p !== TRANSCRIPT) return baseRead(p)
    reads.push(o ?? {})
    const b = new TextEncoder().encode(transcript as string)
    return new TextDecoder().decode(b.subarray(o?.offset ?? 0, (o?.offset ?? 0) + (o?.length ?? b.length)))
  }
  return { ...s, reads }
}

test('relaunch: a compact with no assistant row after it opens the window (drops)', async () => {
  const h = load()
  const { $, logged } = relaunchStub(POSITIVE)
  const f = await h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE))
  const s = await h['prompt.attachment']!($, { type: 'invoked_skills' }, attachNext(RESTORE))
  expect(f.text).toBe(null)
  expect(s.text).toBe(null)
  expect(logged()).toContain('filter relaunch-check verdict=yes')
  expect(logged()).toContain('filter drop type=file path=docs/notes.md')
})

test('relaunch: an assistant row after the boundary keeps everything', async () => {
  const h = load()
  const { $, logged } = relaunchStub(NEGATIVE)
  const f = await h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE))
  expect(f.text).toBe(FILE)
  expect(logged()).toContain('filter relaunch-check verdict=no')
  expect(logged()).not.toContain('filter drop')
})

test('relaunch: parallel hooks share one transcript read and the first block is the one dropped', async () => {
  const h = load()
  const { $, reads } = relaunchStub(POSITIVE)
  const [a, b, c] = await Promise.all([
    h['prompt.attachment']!($, { type: 'invoked_skills' }, attachNext(RESTORE)),
    h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE)),
    h['prompt.attachment']!($, { type: 'date' }, attachNext('2026')),
  ])
  expect(reads.length).toBe(1)
  expect(a.text).toBe(null)
  expect(b.text).toBe(null)
  expect(c.text).toBe('2026')
})

test('relaunch: fails open on a read error (row logged, nothing dropped)', async () => {
  const h = load()
  const { $, logged } = relaunchStub(new Error('EACCES nope'))
  const f = await h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE))
  expect(f.text).toBe(FILE)
  expect(logged()).toContain('filter relaunch-check verdict=unknown (error EACCES nope)')
})

test('relaunch: a process that saw a compact does not read the transcript', async () => {
  const h = load()
  const { $, reads } = relaunchStub(POSITIVE)
  await h['session.compact']!($, compactEvent(), compactNext())
  await h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE))
  expect(reads.length).toBe(0)
})

test('relaunch: a transcript over 4 MiB is read by ranges, and a boundary beyond the tail is found', async () => {
  const h = load()
  const pad = '{"type":"user","isSidechain":false,"pad":"' + 'x'.repeat(1000) + '"}\n'
  const { $, reads } = relaunchStub(POSITIVE + pad.repeat(1500)) // boundary ~1.5 MB from the end
  const f = await h['prompt.attachment']!($, { type: 'file' }, attachNext(FILE))
  expect(reads.length).toBe(2)
  expect(reads[0]!.length).toBe(1024 * 1024)
  expect(f.text).toBe(null)
})

// ---- the usage file ---------------------------------------------------------------------------------------------
const READING = [
  { kind: 'five_hour', percentUsed: 26, resetsAt: '2026-11-18T15:40:00.000Z' },
  { kind: 'seven_day', percentUsed: 25, resetsAt: '2026-11-19T12:00:00.000Z' },
]
const measureNext = async (e: any) => ({ changed: e.changed })

test('usage: session.measure writes usage-<session>.json under COMPACT_METER_DIR', async () => {
  const h = load()
  const { $, writes } = stub({ env: { COMPACT_METER_DIR: '/m', HOME: '/hh/x' } })
  const r = await h['session.measure']!($, { context: {}, rateLimits: READING, changed: ['rateLimits'] }, measureNext)
  expect(r.changed).toEqual(['rateLimits'])
  expect(writes.length).toBe(1)
  expect(writes[0]!.path).toBe('/m/usage-sess-1.json')
  const got = JSON.parse(writes[0]!.text)
  expect(Date.now() - Date.parse(got.at)).toBeLessThan(60_000)
  expect(got.session_id).toBe('sess-1')
  expect(got.rateLimits).toEqual(READING)
})

test('usage: the default dir is $HOME/.claude/compact-meter; no windows writes nothing; the filter switch does not matter', async () => {
  const h = load()
  const a = stub({ env: { HOME: '/hh/x' } }) // COMPACT_FILTER unset: still writes
  await h['session.measure']!(a.$, { context: {}, rateLimits: READING, changed: ['rateLimits'] }, measureNext)
  expect(a.writes[0]!.path).toBe('/hh/x/.claude/compact-meter/usage-sess-1.json')
  const b = stub({ env: { HOME: '/hh/x' } })
  await h['session.measure']!(b.$, { context: {}, rateLimits: [], changed: ['context'] }, measureNext)
  expect(b.writes.length).toBe(0)
})

test('usage: a failing write never breaks the hook', async () => {
  const h = load()
  const { $ } = stub({ env: { HOME: '/h' } })
  ;($ as any).fs.write = async () => {
    throw new Error('EROFS')
  }
  const r = await h['session.measure']!($, { context: {}, rateLimits: READING, changed: ['rateLimits'] }, measureNext)
  expect(r.changed).toEqual(['rateLimits'])
})

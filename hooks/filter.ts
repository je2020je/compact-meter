// Pure decision code of the opt-in filter (COMPACT_FILTER=on). No engine calls here: it is tested alone.
// FAIL OPEN: every unknown shape returns `keep`.

export type Decision =
  | { action: 'keep'; rows: string[] }
  | { action: 'drop'; rows: string[] }
  | { action: 'rewrite'; text: string | null; rows: string[] }

// A restored Read names its file in the text. Three shapes are read; none found = unknown = keep.
const PATH_PATTERNS: RegExp[] = [
  /"file_path"\s*:\s*"([^"]+)"/,
  /(?:^|\n)\s*Note:\s+(\S+)\s+was read before/,
  /(?:^|\n)\s*(?:Contents of|File:)\s+(\S+?)(?::|\s|$)/,
]

export const pathOf = (text: string): string | undefined => {
  for (const p of PATH_PATTERNS) {
    const m = text.match(p)
    if (m && m[1]) return m[1]
  }
  return undefined
}

export const relativeTo = (root: string, path: string): string => {
  const r = root.replace(/\/+$/, '') + '/'
  return path.startsWith(r) ? path.slice(r.length) : path
}

// One section per invoked skill. The engine's shape:
//   <preamble>\n\n### Skill: <name>\nPath: <scope>:<name>\n\n<the whole SKILL.md body>
// Only a `### Skill: <name>` line starts a section. A SKILL.md body carries its own headings
// (`# title`, `## Rules`), so splitting on every heading would cut a skill at its first inner heading.
// No such line = shape unknown = one section named `unknown`.
const SKILL_HEAD = /^#{1,6}\s+Skill:\s*(\S+)\s*$/i
type Section = { name: string; text: string }
const splitSkills = (text: string): { pre: string; secs: Section[] } => {
  const lines = text.split('\n')
  const starts: Array<{ i: number; name: string }> = []
  lines.forEach((line, i) => {
    const m = line.match(SKILL_HEAD)
    if (m && m[1] !== undefined) starts.push({ i, name: m[1].toLowerCase() })
  })
  if (starts.length === 0) return { pre: '', secs: [{ name: 'unknown', text }] }
  return {
    pre: lines.slice(0, starts[0]!.i).join('\n'),
    secs: starts.map((s, k) => ({
      name: s.name,
      text: lines.slice(s.i, k + 1 < starts.length ? starts[k + 1]!.i : lines.length).join('\n'),
    })),
  }
}
export const sectionsOf = (text: string): Section[] => splitSkills(text).secs

/**
 * Decide one post-compact attachment.
 * `state` null = no resume file (or unreadable) = change nothing.
 * `keep` = skill names (lower case) that stay in a restored-skills block.
 */
export const decide = (type: string, text: string, state: string | null, root: string, keep: string[] = []): Decision => {
  if (type === 'file' || type === 'compact_file_reference') {
    const p = pathOf(text)
    const shown = p === undefined ? '?' : relativeTo(root, p)
    if (state === null) {
      const why = p === undefined ? 'path unknown, no STATE' : 'no STATE'
      return { action: 'keep', rows: [`filter keep type=${type} path=${shown} chars=${text.length} (${why})`] }
    }
    return { action: 'drop', rows: [`filter drop type=${type} path=${shown} chars=${text.length} (restored after compact)`] }
  }
  if (type === 'invoked_skills') {
    const { pre, secs } = splitSkills(text)
    if (secs.length === 1 && secs[0]!.name === 'unknown') {
      return { action: 'keep', rows: [`filter keep type=invoked_skills skill=unknown chars=${text.length} (shape unknown)`] }
    }
    if (state === null) {
      return { action: 'keep', rows: secs.map(s => `filter keep type=invoked_skills skill=${s.name} chars=${s.text.length} (no STATE)`) }
    }
    const kept = secs.filter(s => keep.includes(s.name))
    const rows = secs.map(s =>
      keep.includes(s.name)
        ? `filter keep type=invoked_skills skill=${s.name} chars=${s.text.length} (COMPACT_FILTER_KEEP)`
        : `filter drop type=invoked_skills skill=${s.name} chars=${s.text.length} (restored after compact)`,
    )
    if (kept.length === secs.length) return { action: 'keep', rows }
    if (kept.length === 0) return { action: 'drop', rows }
    return { action: 'rewrite', text: [pre, ...kept.map(s => s.text)].filter(x => x !== '').join('\n'), rows }
  }
  return { action: 'keep', rows: [`filter keep type=${type} chars=${text.length} (unknown type)`] }
}

// Relaunch check. Compact in one process, Claude Code quit, the next prompt in a NEW process: that process never
// saw `session.compact`, but the transcript still says it: the last `compact_boundary` row has no main-thread
// assistant row after it (nothing was answered since the compact).
//   yes  = compacted and not yet answered: the restore is about to be attached, open the window
//   no   = answered since the boundary, or no boundary in a complete read
//   more = no boundary in this window and the window does not reach the file's start: read more
// `text` is the tail of the transcript JSONL; `complete` is true when it starts at byte 0. A partial first
// line is skipped. Rows are cheap-checked by substring before they are parsed (rows can be 100 kB).
export type Relaunch = 'yes' | 'no' | 'more'
export const relaunchVerdict = (text: string, complete: boolean): Relaunch => {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= (complete ? 0 : 1); i--) {
    const line = lines[i]!
    const boundary = line.includes('"subtype":"compact_boundary"')
    if (!boundary && !line.includes('"type":"assistant"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object') continue
    if (row.type === 'system' && row.subtype === 'compact_boundary') return 'yes'
    if (row.type === 'assistant' && row.isSidechain !== true) return 'no'
  }
  return complete ? 'no' : 'more'
}

// The usage file. `percentUsed` is the engine's own scale, 0 to 100 (SessionRateLimit); the objects are written
// as given.
export const usageRecord = (sessionId: string, rateLimits: unknown[], at: Date): string =>
  JSON.stringify({ at: at.toISOString(), session_id: sessionId, rateLimits }, null, 2) + '\n'

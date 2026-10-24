import type { Register } from 'claude-code'

// Measure only. It changes nothing the model reads: every hook returns next(e) as resolved.
// Sizes are characters (~3.5 chars per token for English, fewer for Persian).
// The log is $COMPACT_METER_LOG when set, else $HOME/.claude/compact-meter.log: no machine path is written here.
type Io = { env: { get: (n: string) => Promise<string | undefined> }; fs: { write: (p: string, s: string) => Promise<unknown> } }
let LOG = ''
const lines: string[] = []
let afterCompact = 0 // rows still to log after a compaction
let afterAttach = 0 // per-request attachments still to log after a compaction

const size = (c: unknown) => JSON.stringify(c ?? '').length
const head = (s: string) => s.replace(/\s+/g, ' ').slice(0, 50)
const flush = async ($: Io) => {
  LOG ||= (await $.env.get('COMPACT_METER_LOG')) || `${(await $.env.get('HOME')) ?? '.'}/.claude/compact-meter.log`
  await $.fs.write(LOG, lines.join('\n') + '\n')
}

export const register: Register = on => {
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined && !e.agentId) {
      lines.push(`== ${new Date().toISOString()} compact trigger=${e.trigger} before=${r.tokensBefore ?? '?'} after=${r.tokensAfter ?? '?'} kept=${r.messages.length}`)
      r.messages.forEach((m, i) => lines.push(`  kept[${i}] ${m.role} chars=${m.text.length} tools=${m.toolUses.length} "${head(m.text)}"`))
      afterCompact = 60
      afterAttach = 40
      await flush($)
    }
    return r
  })

  // The restored Reads and skills do not pass session.append: they are rendered per request, here.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && afterAttach > 0) {
      afterAttach -= 1
      lines.push(`  attach type=${e.type} chars=${r.text?.length ?? 0} "${head(r.text ?? '')}"`)
      await flush($)
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

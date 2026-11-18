import { expect, test } from 'claude-code/testing'
import { decide, pathOf, relaunchVerdict, sectionsOf, usageRecord } from './filter'

const ROOT = '/r'
const STATE = 'resume notes'
const file = (p: string) => `Called the Read tool with the following input: {"file_path":"${p}"}\nbody`

test('file and compact_file_reference: a restored Read is dropped when a STATE exists', () => {
  const t = file('/r/docs/notes.md')
  const d = decide('file', t, STATE, ROOT)
  expect(d.action).toBe('drop')
  expect(d.rows[0]).toBe(`filter drop type=file path=docs/notes.md chars=${t.length} (restored after compact)`)
  const ref = 'Note: /r/docs/old.md was read before the last conversation was summarized'
  expect(pathOf(ref)).toBe('/r/docs/old.md')
  expect(decide('compact_file_reference', ref, STATE, ROOT).action).toBe('drop')
  expect(decide('file', 'no path here', STATE, ROOT).rows[0]).toContain('path=? ')
})

// The engine's shape: a preamble, then per skill `### Skill: <name>` / `Path: ...` / the whole SKILL.md body.
// A body carries its own headings: they must not split a section.
const PRE = 'The following skills were invoked in this session.\n'
const sk = (n: string) => `### Skill: ${n}\nPath: projectSettings:${n}\n\nBase directory for this skill: /r/skills/${n}\n\n# ${n} - title\n\n## Rules\nbody of ${n}\n### Skill tool notes\nmore`

test('invoked_skills: the whole block is dropped when a STATE exists', () => {
  const t = PRE + '\n' + [sk('alpha'), sk('beta'), sk('gamma-two')].join('\n')
  const d = decide('invoked_skills', t, STATE, ROOT)
  expect(d.action).toBe('drop')
  expect(d.rows).toEqual([
    `filter drop type=invoked_skills skill=alpha chars=${sk('alpha').length} (restored after compact)`,
    `filter drop type=invoked_skills skill=beta chars=${sk('beta').length} (restored after compact)`,
    `filter drop type=invoked_skills skill=gamma-two chars=${sk('gamma-two').length} (restored after compact)`,
  ])
})

test('invoked_skills: inner headings of a SKILL.md body are not read as skills', () => {
  const secs = sectionsOf(PRE + sk('alpha') + '\n' + sk('beta'))
  expect(secs.map(s => s.name)).toEqual(['alpha', 'beta'])
  expect(sectionsOf('## alpha\nrules')[0]!.name).toBe('unknown')
})

test('COMPACT_FILTER_KEEP list: a kept skill stays, the others are cut from the block', () => {
  const t = PRE + '\n' + [sk('alpha'), sk('beta'), sk('gamma')].join('\n')
  const d = decide('invoked_skills', t, STATE, ROOT, ['beta'])
  expect(d.action).toBe('rewrite')
  if (d.action === 'rewrite') {
    expect(d.text).toContain('### Skill: beta')
    expect(d.text).not.toContain('### Skill: alpha')
    expect(d.text).not.toContain('### Skill: gamma')
    expect(d.text).toContain('The following skills were invoked')
  }
  expect(d.rows).toContain(`filter keep type=invoked_skills skill=beta chars=${sk('beta').length} (COMPACT_FILTER_KEEP)`)
  expect(d.rows.some(r => r.startsWith('filter drop type=invoked_skills skill=alpha'))).toBe(true)
  // every skill kept: the block is untouched
  expect(decide('invoked_skills', t, STATE, ROOT, ['alpha', 'beta', 'gamma']).action).toBe('keep')
})

test('fail open: no STATE, unknown shape, unknown type', () => {
  expect(decide('file', file('/r/x.md'), null, ROOT).action).toBe('keep')
  expect(decide('invoked_skills', sk('alpha'), null, ROOT).action).toBe('keep')
  expect(decide('invoked_skills', '## alpha\nx', STATE, ROOT).action).toBe('keep')
  const d = decide('skill_listing', 'x', STATE, ROOT)
  expect(d.action).toBe('keep')
  expect(d.rows[0]).toContain('filter keep type=skill_listing')
})

test('relaunchVerdict: sidechain assistant rows do not count; the LAST boundary rules; a partial first line is skipped', () => {
  const b = '{"type":"system","subtype":"compact_boundary","isSidechain":false}'
  const a = '{"type":"assistant","isSidechain":false}'
  const sa = '{"type":"assistant","isSidechain":true}'
  const u = '{"type":"user","isSidechain":false}'
  expect(relaunchVerdict([b, u, sa].join('\n'), true)).toBe('yes')
  expect(relaunchVerdict([b, a, b, u].join('\n'), true)).toBe('yes')
  expect(relaunchVerdict([b, a, u].join('\n'), true)).toBe('no')
  expect(relaunchVerdict([u, u].join('\n'), true)).toBe('no')
  expect(relaunchVerdict([u, u].join('\n'), false)).toBe('more')
  expect(relaunchVerdict('ompact_boundary"}\n' + u, false)).toBe('more')
  expect(relaunchVerdict('not json "type":"assistant"\n' + u, true)).toBe('no')
})

test('usageRecord: session id, time and the windows as the engine gave them', () => {
  const limits = [{ kind: 'five_hour', percentUsed: 26, resetsAt: '2026-11-18T15:40:00.000Z' }]
  const got = JSON.parse(usageRecord('s1', limits, new Date('2026-11-18T11:30:00.000Z')))
  expect(got).toEqual({ at: '2026-11-18T11:30:00.000Z', session_id: 's1', rateLimits: limits })
})

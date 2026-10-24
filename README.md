# compact-meter

A Claude Code mod that **measures** what a `/compact` keeps and what the engine re-attaches after it.
It changes nothing the model reads: every hook returns the engine's own result unchanged.

Use it before you cut waves, STATE files or skills to "save context after a compact". Measure first.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install compact-meter --marketplace je2020je/compact-meter
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install compact-meter --marketplace je2020je/compact-meter
```

## Read it

After a compact:

```
tail -n 60 ~/.claude/compact-meter.log
```

The log is `$COMPACT_METER_LOG` when that variable is set, else `$HOME/.claude/compact-meter.log`.

| row | what it is |
|---|---|
| `== … compact trigger= before= after= kept=` | tokens before and after the compact, and the kept message count |
| `kept[i] role chars=` | each kept message (the summary, the last reply) |
| `row door=attachment name=…` | rows written to the transcript after the compact |
| `attach type=… chars=…` | blocks injected per request after the compact: `file` (a restored Read), `compact_file_reference`, `invoked_skills`, `skill_listing`, `instructions`, … |

Sizes are characters; divide by about 3.5 for English tokens.

## What we found with it

In a long multi-wave session (122k tokens before the compact), the restored file Reads were about
1k tokens and the restored skills about 9k. The rest of what a compact re-attaches (skill list,
CLAUDE.md, memory, environment) is what a brand-new session loads anyway. A compact cost about the
same as a fresh start. The large context was the session's own work, not the restoration.

## How it works

Three hooks: `session.compact` (kept messages), `session.append` (rows after the compact) and
`prompt.attachment` (per-request blocks, where the restored Reads and skills live). A
`prompt.attachment` hook that returned `{ text: null }` would drop a block; this mod never does.

## License

MIT

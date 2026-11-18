# compact-meter 0.2.0

A Claude Code mod that **measures** what a `/compact` keeps and what Claude Code re-attaches after it.
By default it changes nothing the model reads. It also has an **opt-in filter**, which is **off by default**.

Use the meter before you cut skills or state files to "save context after a compact". Measure first.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install compact-meter --marketplace je2020je/compact-meter
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install compact-meter --marketplace je2020je/compact-meter
```

## What it measures

Three hooks write one log. The log is `$COMPACT_METER_LOG` when that variable is set, else
`$HOME/.claude/compact-meter.log`. Read it after a compact:

```
tail -n 60 ~/.claude/compact-meter.log
```

Rows hold **sizes and names only**: no message text, no file content. (A `filter … type=file` row also names the path of the Read.)

| row | what it is |
|---|---|
| `== … compact trigger= before= after= kept=` | tokens before and after the compact, and the kept message count |
| `kept[i] role chars= tools=` | each kept message (the summary, the last reply): size only |
| `row door=… type= name= role= chars=` | rows written to the transcript after the compact |
| `attach type=… chars=…` | blocks injected per request after the compact: `file` (a restored Read), `compact_file_reference`, `skill_listing`, `instructions`, … |
| `invoked_skills skill=… chars=…` | one row per restored skill |
| `== … process-start` | a new process (for example after Claude Code is quit and relaunched) logs its first attachments too |

Sizes are characters; divide by about 3.5 for English tokens.

### The usage file

After each response, when your plan reports rate-limit windows, the plugin writes
`${COMPACT_METER_DIR:-$HOME/.claude/compact-meter}/usage-<session-id>.json`. It holds the time of the reading, the
session id, and the windows exactly as Claude Code gave them (`kind`, `percentUsed` from 0 to 100, `resetsAt`). A
script can read the plan quota from it without a probe request. It holds no message text. Nothing is written when
your plan reports no windows. The usage file is written whether the filter is on or off.

## The filter (off by default)

With nothing set, the plugin only measures. **The filter runs only when `COMPACT_FILTER=on`** is in the environment
of the Claude Code process (any other value, or no value, leaves it off).

**What it drops when on.** After a `/compact`, Claude Code re-attaches two things to the next requests:

- every restored **Read file** (`file` and `compact_file_reference` blocks), and
- every restored **skill block** (`invoked_skills`: the full text of each skill you invoked before the compact).

The filter removes both. It does the same when Claude Code is **quit and relaunched** after a compact and before your
next message (it reads the end of the session transcript once to see that the compact was not yet answered). It
touches nothing else: instructions, the skill list, the session context and other blocks stay.

**So your next prompt must re-invoke the skills it needs**, and re-read the files it needs. For example:

```
Continue from notes/resume.md. First call the Skill tool with `my-skill`, then read src/main.ts.
```

A skill you call again after the compact is kept: only the first restored skill block after a compact is dropped.

It only runs when it has a resume file to rely on, and it fails open: with no resume file, an unreadable one, an
unknown block shape or any error, it drops nothing. It acts only in the first 40 requests after the compact.

Settings (environment variables of the Claude Code process):

| variable | meaning |
|---|---|
| `COMPACT_FILTER=on` | turns the filter on. Unset or anything else: off. |
| `COMPACT_FILTER_STATE` | path to your resume file (a file that tells the next prompt what to reload). Required: with it unset or unreadable, the filter drops nothing. No default location is searched. |
| `COMPACT_FILTER_KEEP` | comma list of skill names that stay in the restored skill block, for example `my-skill,other-skill`. Empty by default. New in 0.2.0 and tested only against stubs: if a kept skill is missing after a compact, call it again. |

**To turn it off:** unset `COMPACT_FILTER` (or set it to `off`) and restart Claude Code. A plugin loads once per launch.

Each decision leaves a log row, so you can check it: `filter drop type=file path=… chars=…`,
`filter drop type=invoked_skills skill=… chars=…`, `filter keep …` (with the reason), `filter skip …` (an empty
block, never a drop), and `filter relaunch-check verdict=…` after a relaunch.

## How it works

Hooks: `session.compact` (kept messages), `session.append` (rows after the compact), `prompt.attachment` (per-request
blocks, where the restored Reads and skills live) and `session.measure` (the usage file). A `prompt.attachment` hook
that returns `{ text: null }` leaves a block out of the request; this plugin does that only for the filter above.

## What we found with it

In a long multi-wave session (122k tokens before the compact), the restored file Reads were about 1k tokens and the
restored skills about 9k. The rest of what a compact re-attaches (skill list, CLAUDE.md, memory, environment) is what
a brand-new session loads anyway. A compact cost about the same as a fresh start. The large context was the
session's own work, not the restoration.

## Tests

```
claude plugin test /path/to/compact-meter
```

## License

MIT

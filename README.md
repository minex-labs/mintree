<h1 align="center">mintree</h1>

<p align="center">
  <strong>Issue-driven Git worktrees + Claude Code sessions</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mintree"><img src="https://img.shields.io/npm/v/mintree.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/mintree"><img src="https://img.shields.io/npm/dm/mintree.svg" alt="npm downloads"></a>
  <a href="https://github.com/minex-labs/mintree/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/mintree.svg" alt="license"></a>
  <a href="https://github.com/minex-labs/mintree/actions/workflows/ci.yml"><img src="https://github.com/minex-labs/mintree/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
</p>

<p align="center">
  Pick an issue, spin up an isolated worktree, and work it with Claude — for repos with an opinionated SDD+TDD flow.
</p>

---

mintree wraps the steps you do manually every time a feature begins:

1. Pick an open issue or work item assigned to you (GitHub Issues or Linear).
2. Create a git worktree on a branch named after that item, following the project's convention.
3. Launch Claude Code inside the worktree with a session ID you can resume later.
4. Live-track which Claude sessions are active, idle, or waiting.

It is a smaller, opinionated cousin of [santree](https://github.com/santiagotoscanini/santree) — built on the same TypeScript + Ink + Pastel stack but stripped to the `<type>/<issue>-<desc>` branch convention and the two issue trackers most likely to be used by a small team: GitHub Issues and Linear.

---

## Install

```bash
npm install -g mintree

# Upgrade later:
#   npm update -g mintree

# Verify
mintree --version          # should match the latest published version
mintree doctor             # checks toolchain (git, gh, claude, tmux, ...)

# Enable the shell wrapper so `mintree worktree create` and the
# dashboard can `cd` your shell into the new worktree.
#
# Use the cache-aware one-liner — it sources a cached copy on every
# subsequent shell instead of spawning node, which keeps shell
# startup fast. The cache regenerates itself when mintree is updated.
cat >> ~/.zshrc <<'EOF'
_MT=${XDG_CACHE_HOME:-$HOME/.cache}/mintree/init-zsh.zsh
[[ -f $_MT ]] && source $_MT || eval "$(mintree helpers shell-init zsh)"
EOF
exec zsh

# Bash users:
cat >> ~/.bashrc <<'EOF'
_MT=${XDG_CACHE_HOME:-$HOME/.cache}/mintree/init-bash.bash
[[ -f "$_MT" ]] && source "$_MT" || eval "$(mintree helpers shell-init bash)"
EOF
```

> Working on mintree itself? Clone the repo, run `npm install` and `npm link` instead — that wires `mintree` to your local checkout so source edits show up after `npm run build`.

`mintree doctor` should report **all required checks pass** before you continue. The most common gaps are:

- `gh` not authenticated → `gh auth login` (still needed when using Linear — mintree uses `gh` for PR status on worktree branches)
- Claude Code not installed → `npm install -g @anthropic-ai/claude-code`
- Shell integration not loaded → re-run the `echo … >> ~/.zshrc` step and start a new shell

---

## Per-repo setup

In every repository where you want to use mintree:

```bash
cd path/to/repo

# Default: GitHub Issues provider
mintree init

# Or: Linear provider (--team is repeatable, one per team you pull work from)
mintree init --provider linear --workspace <your-workspace-slug> --team FE --team BE

mintree helpers session-signal install   # optional: live session state in the dashboard
```

`init` is idempotent — re-running it is a no-op when everything is already in place.

### Picking the issue provider

mintree supports two issue providers, selected per repo via `.mintree/metadata.json`:

- **`github`** (default): lists issues assigned to you on the current repo via `gh`. Transitions to "In Progress" on a Projects v2 board when present.
- **`linear`**: lists issues assigned to you across a configured set of [Linear](https://linear.app) teams, via the Linear GraphQL API. Moves the issue to "In Progress" on `w`.

`mintree init --provider linear --workspace <slug> --team FE --team BE` scaffolds the metadata for you. If you skip `--team`, or want to tweak it later, edit `.mintree/metadata.json` so `linear.teams` lists at least one team key:

```json
{
  "version": 1,
  "provider": "linear",
  "issues": {},
  "linear": {
    "apiUrl": "https://api.linear.app/graphql",
    "workspaceSlug": "my-team",
    "teams": [
      { "key": "FE", "name": "Frontend" },
      { "key": "BE", "name": "Backend" }
    ]
  }
}
```

The `workspaceSlug` is the URL key of your Linear workspace (`linear.app/<slug>/...`). Each team `key` is the short prefix shown on issue IDs (the `FE` in `FE-123`); `name` is optional. Optional keys: `inProgressStateName` (override the workflow state `w` transitions to) and `protectedStateTypes` (workflow-state types `clean` won't touch).

Authenticate by setting `LINEAR_API_KEY` in your shell, or by writing the key to `~/.mintree/credentials.json`:

```bash
export LINEAR_API_KEY=lin_api_XXXXXXXXXXXXXX
# or
cat > ~/.mintree/credentials.json <<'EOF'
{ "linear": { "apiKey": "lin_api_XXXXXXXXXXXXXX" } }
EOF
chmod 600 ~/.mintree/credentials.json
```

The key goes straight into the `Authorization` header (no `Bearer` prefix). `mintree doctor` validates the key, resolves the viewer, and pings each configured team when `provider === "linear"`.

### Launch behaviour (optional)

Three top-level keys in `.mintree/metadata.json` tune how mintree launches Claude — all apply to GitHub and Linear repos alike:

```json
{
  "version": 1,
  "provider": "linear",
  "issues": {},
  "defaultPermissionMode": "auto",
  "promptTemplate": "Trabajá en el ticket {{id}} ({{title}}). Abrí {{url}} para el contexto completo y seguí las convenciones del repo.",
  "orchestratorPromptTemplate": "Hacé de orquestador con los tickets {{ids}} ({{count}} en total). Resolvelos con la menor intervención posible, paralelizando con subagentes salvo dependencias.",
  "linear": { "workspaceSlug": "my-team", "teams": [{ "key": "FE" }] }
}
```

- **`defaultPermissionMode`** (`"default"` | `"auto"`): the Claude `--permission-mode` mintree uses when it launches a session — from the dashboard (`w` / `↵`), `worktree work`, or `worktree create --work`. Omitted (or `"default"`) keeps the stricter default mode; `"auto"` starts every session with auto-accept on. The `--permission-mode` / `-m` CLI flag still overrides it per launch.
- **`promptTemplate`**: the initial message seeded into the dashboard's `w` overlay (the text Claude receives as its first prompt). It replaces mintree's built-in default and supports these placeholders, substituted per issue:

  | Placeholder | Replaced with                                         |
  |-------------|-------------------------------------------------------|
  | `{{id}}`    | Issue id — `100` (GitHub) or `FE-123` (Linear)        |
  | `{{title}}` | Issue title                                           |
  | `{{url}}`   | Issue URL (GitHub issue page / Linear issue link)     |

  It's a single line on purpose. In the `w` overlay the rendered template seeds a multi-line **Prompt** box that you edit freely — add or remove whatever you want before launching; whatever's left is sent to Claude (empty = no initial message). In that box **Enter inserts a newline**, **Ctrl+X launches**, **Ctrl+L clears the whole box**, and Esc cancels; you can paste long, multi-line context safely. When omitted, mintree falls back to its provider-aware default (`gh issue view` for GitHub, the bare id + URL for Linear).
- **`orchestratorPromptTemplate`**: the message handed to the Claude **orchestrator** launched from the dashboard's `Orchestrate` tab (or `mintree orchestrate`). It replaces the built-in default and supports:

  | Placeholder | Replaced with                                          |
  |-------------|--------------------------------------------------------|
  | `{{ids}}`   | Comma-separated list of the selected ticket ids        |
  | `{{count}}` | How many tickets were selected                         |

  When omitted, mintree uses a built-in default that asks Claude to orchestrate the selected tickets with minimal intervention — parallelising via subagents unless dependencies force sequential work, creating a worktree per ticket with mintree, using the repo's skills, and moving each ticket to *in progress* on start and closing it when done. As in the `w` overlay, pressing `↵` on the Orchestrate tab first opens a confirm overlay with the rendered template seeded into an editable multi-line **Prompt** box you can tweak before launching (Enter = newline, Ctrl+L = clear, Ctrl+X = launch, Esc = cancel).

### Bringing gitignored files into worktrees (optional)

Git worktrees don't share **untracked** files: a new worktree is a fresh working directory, so gitignored config like `.env` lives only in your main checkout and is **absent** in every worktree mintree creates. That breaks per-worktree tooling that needs it — e.g. running an E2E suite that reads `.env` for staging credentials.

The `linkFiles` top-level key (valid on GitHub and Linear repos) lists repo-root-relative paths that mintree materialises into each new worktree, right after creating it. Each entry picks its own `mode`:

```json
{
  "version": 1,
  "provider": "linear",
  "issues": {},
  "linkFiles": [".env", { "path": ".env.local", "mode": "link" }],
  "linear": { "workspaceSlug": "my-team", "teams": [{ "key": "FE" }] }
}
```

- **`mode: "copy"`** (the default, and what a bare string means) — the worktree gets its **own** file. Editing it (a port, a feature flag, a per-worktree tweak) stays local and never mutates the main checkout's. The trade-off: it's a snapshot taken at create time, so rotating a credential in the main file does **not** propagate to worktrees already created.
- **`mode: "link"`** — a relative symlink back to the main checkout: one source of truth, so a rotated credential is picked up by every worktree, at the cost of per-worktree edits writing through to the shared file.

Pick per entry by asking who owns the file. Shared, rotated credentials that every worktree should read identically (`.env.local` holding a broker token) want `link`. Anything a worktree must own — or that a `.mintree/init.sh` regenerates per worktree, like a `.env` carrying an isolated docker project name — wants `copy`, or belongs out of the list entirely so the hook is its only author.

> History: these were symlinks up to 0.5.13, copies from 0.5.14, and per-entry from 0.5.27 — neither is right for every file. Existing worktrees keep whatever they were created with; convert one by hand if you need the other.

- **Best-effort, never fatal** — an entry that doesn't exist in the repo root is skipped, and so is one whose target is already present in the worktree (e.g. a tracked file). Both show up as `skip` steps in the create log. If a file is load-bearing for isolation, generate it in `.mintree/init.sh`, whose failure *is* fatal to the hand-off.
- **Runs before `.mintree/init.sh`** — so the post-create hook (if any) can rely on the files being there.
- **Sandboxed paths** — entries must be repo-root-relative; absolute paths and `..` escapes are dropped on read, so a stray `metadata.json` can't make mintree copy something outside the worktree, or aim a symlink at an arbitrary path.

This applies to `worktree create` (CLI), the dashboard `w` overlay, and the detached-worktree flow alike. For more involved per-worktree setup (installing deps, copying templated files), use `.mintree/init.sh` instead — see [What gets stored where](#what-gets-stored-where).

### When `.mintree/init.sh` fails

The post-create hook is often what makes a worktree self-contained (isolated docker project name, per-worktree ports). A worktree whose hook failed is the dangerous case: it looks healthy, but its tooling can still be pointed at the main checkout — so a test suite or CI gate run inside it goes green while validating the **wrong branch**.

So a failing hook fails closed:

- The step is an **error** (`✗`), not a warning, and the failure is repeated as a **banner at the end** of the output — not left mid-scroll where it's already gone.
- The detail carries the hook's **own stderr** and exit status, not just `Command failed`.
- `mintree worktree create` exits **non-zero**.
- **`--work` is withheld** — Claude is not launched into an uninitialised worktree, and the issue is not transitioned to *In Progress*.
- The worktree is still created (you don't lose the branch), and is marked `init_failed` in `.mintree/metadata.json` until a later create for that issue succeeds.

A hook that exists but isn't executable counts as a failure too, for the same reason: the setup didn't happen.

---

## Daily flow

### Interactive dashboard

```bash
mintree dashboard
```

Opens a full-screen TUI listing your assigned open issues (or work items), each row marked with the live state of its Claude session (`● active`, `! waiting`, `○ idle`, `— exited`, `· no session`). Rows are grouped by project board and Status. The right pane shows the issue body, labels, worktree info, PR status, and live session message.

It has three tabs, switched with `←` / `→`:

- **Issues** — your assigned open issues, grouped by project/Status. Blocked issues are hidden (see below).
- **Worktrees** — orphaned worktrees (on disk under `.mintree/worktrees/` but no longer matching an open issue). Each row is a checkbox (`[ ]` / `[✔]`): tick several with `Space` (or `a` for all) and press `d` to remove them in one confirmation. With nothing checked, `d` removes just the row under the cursor. Once you confirm, the overlay shows a live `Removing 12/104 — BE-172` counter (worktrees are removed one at a time and a big batch takes a while) and ignores keystrokes until it's done.
- **Orchestrate** — the same issues as the Issues tab, but each row is a checkbox (`[ ]` / `[✔]`). Tick the tickets you want resolved and press `↵` to open a confirm overlay, where you can add an optional extra message, then launch a single Claude **orchestrator** in the repo root that drives them to completion (parallel subagents when possible, sequential otherwise), creating a worktree per ticket with mintree. The message is built from `orchestratorPromptTemplate` (see above) or the built-in default, plus the extra message if you typed one.

| Shortcut | Action                                                                |
|----------|-----------------------------------------------------------------------|
| `←/→`    | Switch tab (Issues → Worktrees → Orchestrate)                         |
| `↑/↓` or `j/k` | Move between rows                                               |
| `↵`      | Issues/Worktrees: resume Claude in the existing worktree, or open the create overlay. Orchestrate: open the confirm overlay for the checked tickets |
| `Space`  | Worktrees/Orchestrate tabs: toggle the row under the cursor           |
| `a`      | Worktrees/Orchestrate tabs: select / deselect all visible rows        |
| `w`      | Always open the create overlay (type + kebab description)             |
| `d`      | Delete the selected worktree(s) — the checked batch on the Worktrees tab, or the row under the cursor (confirmation overlay) |
| `r`      | Manual refresh — bypasses the Linear snapshot cache, so a just-assigned ticket shows up immediately (auto-refreshes silently every 5 min) |
| `o`      | Open the issue in your browser                                        |
| `q`/`Esc`| Quit (or cancel an open overlay)                                      |

The dashboard runs in the alternate screen buffer, so closing it leaves your shell exactly as it was.

#### Blocked issues are hidden (Linear)

An issue that another issue **blocks** in Linear isn't workable yet, so mintree leaves it out of the dashboard entirely — both the Issues list and Orchestrate. If `FE-300` is blocked by `BE-129`, it won't show up while `BE-129` is open.

A blocker only counts while it's still open: once it reaches a closed state (`completed` / `canceled` / `duplicate`, or whatever you set in `linear.protectedStateTypes`), the ticket it was gating reappears on the next refresh — no action needed on your side. The blocker doesn't have to belong to a team you configured; the relation is read from the issue itself. Only the `blocks` relation hides a ticket — `related`, `duplicate`, and `similar` don't.

This is always on and needs no configuration. It applies to `provider: "linear"` only — GitHub Issues has no native blocking relation.

### CLI

Same building blocks, scriptable from any shell:

```bash
# Create a worktree, optionally launch Claude with an initial prompt
mintree worktree create feat/100-validar-patente
mintree worktree create feat/FE-123-validar-patente --work --prompt "empezar FE-123"

# Fork from a specific base instead of origin/HEAD (defaults to main/master)
mintree worktree create fix/55-hotfix --base release/2.1

# On a Linear repo you can pass the issue's own Linear branch name
mintree worktree create jdoe/fe-68-landing-page --work

# ...or just the issue id: mintree swaps in Linear's branch name, because a
# branch named `FE-68` closes FE-68 when it merges (--exact opts out)
mintree worktree create FE-68

# Resume Claude in the worktree you're currently inside
# (the worktree dir is the bare issue id)
cd .mintree/worktrees/FE-123
mintree worktree work

# Inspect / clean up
mintree worktree list                          # tabular view, dirty + ahead/behind
mintree worktree list --pr                     # also fetch PR status per branch (slower)
mintree worktree remove fix/55-bug             # drop worktree, keep the branch, prune the issue's metadata entry
mintree worktree remove fix/55-bug --force     # discard uncommitted changes too
mintree worktree clean                         # sweep worktrees whose PR is merged/closed (prunes their metadata entry)

# Launch a Claude orchestrator over a batch of tickets (renders
# orchestratorPromptTemplate, or the built-in default)
mintree orchestrate FE-81 FE-84 FE-82
mintree orchestrate FE-81 FE-84 -m auto
```

Removing a worktree **keeps the branch** (it may still have an open PR — delete it with `git branch -D` when you're done) but **prunes the issue's entry** in `.mintree/metadata.json`, `session_id` included. Re-creating a worktree for that issue therefore starts a fresh Claude session rather than resuming the old one.

### Directories git has forgotten

If you rename or move the repo directory, every worktree breaks: git stores absolute paths on both ends of a worktree, so the rename orphans them and the next `git worktree prune` drops the references — leaving full checkouts sitting in `.mintree/worktrees/` that `git worktree list` no longer reports.

The dashboard's **Worktrees** tab scans the directory itself, not just `git worktree list`, so these show up flagged `(not in git)`. Removing one is a plain `rm -rf` (there's no git metadata left to check it against), so it's gated behind the uppercase `Y` confirmation even when it looks clean, and mintree refuses outright if the path isn't under `.mintree/worktrees/`. Commits on the associated branches are unaffected — those live in the repo, not the worktree.

If `remove` (or the dashboard's `d`) fails with `Permission denied`, a Docker Compose stack is usually still bound to the worktree — a per-worktree `make worktree-up` leaves containers holding the directory, and the files they created can't be deleted while the stack is up. mintree flags this in the error; bring the stack down first (e.g. `docker compose -p <project> down -v` from inside the worktree) and remove again.

`mt`, `mtw`, `mtn` are shell aliases the wrapper installs for `mintree`, `mintree worktree`, and an interactive "name a branch" shortcut.

---

## Branch convention

By default mintree enforces:

```
<type>/<issue>-<kebab-desc>
```

`<type>` is one of:

> `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `perf`, `style`, `revert`

`<issue>` is one of:

- Bare digits for GitHub Issues (the issue number, no `#`): `42`, `100`, `1234`
- `<TEAM>-<digits>` for Linear issues (the human identifier): `FE-123`, `BE-7`, `DSGN-12`. The prefix is uppercase letters / digits / underscores, matching Linear's team-key constraints.

`<desc>` is lowercase kebab-case.

Examples: `feat/42-validacion-patente`, `fix/55-selfie-upload-timeout`, `feat/FE-123-readme-update`, `fix/BE-7-modal`.

When the dashboard's `w` overlay opens, it suggests a kebab description capped at 5 words. If your repo has a `docs/conventions/git-workflow.md`, `CONTRIBUTING.md`, or `.claude/skills/` directory, mintree mentions it on the overlay so you can verify the suggestion against your project's rules — then edit the description to match.

### Linear repos: branches come from Linear

Many Linear-tracked repos follow the branch name Linear suggests — `<user>/<team>-<n>-<desc>`, e.g. `jdoe/fe-68-landing-page` — rather than the `<type>/<issue>-<desc>` convention above. That value is the issue's `branchName` (a.k.a. gitBranchName), and it depends on the branch-name prefix configured in your Linear workspace.

So **when `provider` is `linear` and the issue has a `branchName`, mintree uses it verbatim** instead of synthesising a `<type>/<issue>-<desc>` branch:

- In the dashboard's `w` overlay, the "new branch" mode shows the Linear branch (read-only, labelled `from Linear`) and skips the type/description fields.
- From the CLI, you can pass the Linear branch directly: `mintree worktree create jdoe/fe-68-landing-page`. mintree finds the Linear identifier (`fe-68`) by matching it against your configured `linear.teams[].key`, and normalises it to the canonical `FE-68`.

The worktree directory is still the **bare, upper-case issue id** (`FE-68`) regardless of the branch name, matching the GitHub case. The `<type>/<issue>-<desc>` convention is still accepted on Linear repos too — it's used as a fallback when an issue has no `branchName`. GitHub repos are unaffected: they always use the convention and reject Linear-style branches.

#### Passing a bare issue id

`mintree worktree create FE-68` — the identifier and nothing else — is the form everyone reaches for, because the identifier is what you have in hand when you pick up a ticket. It is also the one shape you don't want as a branch name: **Linear closes an issue when a branch named after it merges**, no matter what the PR body says, so `FE-68` can take its ticket to Done with part of the scope unshipped.

So on a Linear repo with configured teams, mintree asks Linear for that issue's `branchName` and creates **that** branch instead, reporting the substitution:

```
$ mintree worktree create FE-68
✓ parsed branch (issue=FE-68, branch=jdoe/fe-68-landing-page)
! used Linear's branch name (FE-68 → jdoe/fe-68-landing-page; a branch named after the issue closes it on merge)
```

The worktree directory is `FE-68` either way. If the lookup can't run — no `LINEAR_API_KEY`, offline, Linear unreachable — the branch is created **exactly as you typed it** and mintree warns instead; it never blocks. Pass **`--exact`** to keep the bare id deliberately and skip the lookup.

Nothing else is affected: a `<type>/<issue>-<desc>` branch, a Linear `branchName`, an id that turns out not to be a Linear issue, a repo with no Linear teams configured, and every GitHub repo all go through untouched — no lookup, no warning, no output.

---

## What gets stored where

```
<repo>/
├── .gitignore                    # gets `.mintree/worktrees/` + session-states/ + metadata.json appended
└── .mintree/
    ├── metadata.json             # gitignored. provider config + <issue-id> → { base_branch?, session_id? }
    ├── worktrees/                # gitignored
    │   ├── 100/                  # GH form: <digits>
    │   └── FE-123/               # Linear form: <TEAM-digits>
    ├── session-states/           # gitignored
    │   └── 100.json              # live state written by Claude hooks (active/waiting/idle/exited)
    └── init.sh                   # opt-in. Runs in the new worktree post-create (install deps, scaffold, …)
```

The worktree directory is named after the bare issue id (`100`, `FE-123`, `FE-68`); the branch keeps its full name — `<type>/<issue>-<desc>` for the convention, or Linear's own `<user>/<team>-<n>-<desc>` on Linear repos.

`metadata.json` is gitignored because the `session_id` is local to your machine — sharing it would only generate noise. The `provider` and `linear.*` keys can be re-derived from a Linear workspace if needed; sharing them would just leak local config preference.

Linear authentication lives in `~/.mintree/credentials.json` (user-scoped, not per-repo) or the `LINEAR_API_KEY` env var.

---

## Claude Code integrations

- **Sessions persist by issue**: each issue gets a UUID stored in `metadata.json`. Subsequent `worktree work` calls pass `--resume <uuid>` so Claude reopens the same conversation.
- **Live state** (optional): the four hooks installed by `mintree helpers session-signal install` write the current Claude state to `.mintree/session-states/<issue>.json` on every prompt / stop / notification / session-end. The dashboard reads those files to colour each row in real time.
- **Remote Control** (optional): `mintree doctor` checks `~/.claude.json` for `remoteControlAtStartup: true`. Enable it by running `/config` inside Claude Code and turning on *Enable Remote Control for all sessions* — it lets you continue a local session from a different device.
- **iTerm2 session badge** (automatic): when you launch on [iTerm2](https://iterm2.com), mintree sets the terminal **badge** — the large translucent label drawn over the session — to the session name (the worktree issue id like `FE-68`, or the orchestrator's name) so each tab stays identifiable at a glance. It uses the badge rather than the tab title because Claude Code overwrites the title while it runs; the badge is independent of it and persists for the whole session, then clears on exit. No-op on other terminals (detected via `TERM_PROGRAM` / `LC_TERMINAL`).

---

## Troubleshooting

- `mintree doctor` is the first stop. It surfaces missing tools, unauthenticated CLIs, missing hooks, and gitignore drift.
- The shell wrapper exports `MINTREE_SHELL_INTEGRATION=1` — if doctor says it's missing, the wrapper isn't being loaded by your shell init file.
- If the dashboard ever opens with a stale session state, press `r` to force a refetch (the auto-refresh runs every 5 minutes).
- Linear-side issues (timeouts, rate limits, unexpected response shapes) can be logged to `~/.mintree/linear-debug.log` by running `MINTREE_DEBUG=1 mintree dashboard`. The log is file-only so it never corrupts the Ink-rendered TUI.

---

## Why not santree

mintree was written for projects that have:

- A small set of trackers (GitHub Issues or Linear) — santree supports both too but is heavier.
- An established branch convention without the `gh-` prefix santree imposes.
- Skills (`.claude/skills/`) that own the SDD + TDD flow — mintree intentionally leaves the rich PR-create / PR-review prompts out of scope.

The implementation copies santree's stack (TypeScript + Ink + Pastel + Zod) and visual style (split pane, alt-screen, marker-based shell wrapper) so the two feel similar in use.

---

## Development

```bash
npm ci
npm test          # node:test + tsx, 107 tests, no network
npm run lint      # eslint over source/
npm run build     # tsc -> dist/ (tracked: the installed binary runs it)
```

`dist/` is committed, so any source change needs `npm run build` **and** `git add dist` in the same commit.

CI (`.github/workflows/ci.yml`) runs on every pull request and on every push to `main`:

| Job | What it checks |
|---|---|
| `test` | The suite on Node 20 / 22 / 24 (the floor is `engines.node >= 20`) |
| `lint` | `eslint source` |
| `dist is up to date` | Rebuilds and fails if the committed `dist/` differs from `source/` |

To make a merge to `main` impossible while CI is red, mark those jobs as required in **Settings → Branches → Branch protection rules**.

---

## License

MIT

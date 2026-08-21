# CLAUDE.md

Contexto inicial para arrancar el desarrollo de **mintree**.

> Este archivo es el ancla: cuando Claude entra a este repo por primera vez, lee esto y sabe qué tiene que hacer. Cuando se estabilice el proyecto, esta info se va a partir entre `README.md` (qué es mintree + cómo se usa) y este `CLAUDE.md` (cómo se trabaja en el repo).

---

## Qué es mintree

CLI con TUI rica (al estilo de [santree](https://github.com/santiagotoscanini/santree)) para:

1. **Listar issues / work items asignados** en un dashboard interactivo. Provider seleccionable por repo: GitHub Issues o Linear.
2. **Crear git worktrees** desde un issue, en branches con la convención del proyecto target.
3. **Lanzar Claude Code** dentro del worktree, con session ID persistente para reanudar después.
4. **Reanudar sesiones** existentes (`claude --resume <session-id>`).
5. **Habilitar Remote Control** de Claude Code para poder continuar sesiones desde otros devices.

Es básicamente santree con:
- Soporte de GitHub Issues + Linear. Default = github; switch a linear vía `mintree init --provider linear`.
- Convención de branch `<tipo>/<issue>-<desc>` (sin `gh-` prefix). `<issue>` puede ser `\d+` (GH) o `<TEAM>-\d+` (Linear).
- Sin las features avanzadas de PR fix / PR review automáticas con prompts ricos — el dueño de eso es el flujo de skills del repo target, mintree no se mete.
- Lanzamiento de Claude **limpio**, con la opción de inyectar un texto inicial (estilo "empezar a trabajar el issue #XX") — equivalente al `--contextFile` o al overlay de modo de santree.

---

## Por qué existe (y por qué no santree directo)

mintree apunta a repos con flujo SDD+TDD que ya tienen:

- Specs en `docs/specs/` y skills de Claude Code que ordenan cada paso del trabajo (crear spec, implementar feature, crear PR, review).
- Convención de branches `<tipo>/<issue>-<desc>` (ej `feat/100-readme-update` o `feat/FE-123-readme-update`).
- GitHub Issues o Linear como tracker.

Santree ([repo](https://github.com/santiagotoscanini/santree)) tiene soporte GitHub Issues, pero impone branches `<prefix>/gh-<issue>-<desc>` (con `gh-` prefix), lo que choca con la convención ya establecida en esos repos. Forkear santree es más invasivo de lo necesario; mintree replica solo lo esencial respetando la convención existente.

**Mintree NO reemplaza las skills del repo target.** Las skills siguen siendo el ordenador del flujo SDD+TDD. Mintree solo envuelve los pasos previos al primer prompt: elegir issue → crear branch+worktree → lanzar Claude con session persistente. Una vez en el worktree, el usuario invoca sus skills como siempre.

---

## Decisiones ya tomadas (no re-preguntar)

| Decisión | Valor |
|---|---|
| Stack | **TypeScript + Ink + Pastel + Zod** (mismo que santree, para replicar el look y poder copiar patrones probados) |
| Distribución | npm (`npm i -g mintree`) |
| Repo | independiente (`minex-labs/mintree`) |
| Comando principal | `mintree` |
| Aliases | `mt`, `mtw` (= `mt worktree`), `mtn` (= interactive create + work, equivalente a `stn` de santree) |
| Provider de issues | GitHub Issues (default, vía `gh` CLI) **o** Linear (vía GraphQL `api.linear.app/graphql`). Seleccionable por repo en `.mintree/metadata.json#provider`. |
| Convención de branch en repo target | `<tipo>/<issue>-<desc>` (ej `feat/100-claude-md-inicial` o `feat/FE-123-claude-md-inicial`). **NO** prefijo `gh-`. |
| Storage | per-repo, en `<repo>/.mintree/` (gitignored). |
| Lanzamiento Claude | limpio (`cd <worktree> && claude --session-id <uuid>`), con opción de pasar un texto inicial cuando se crea el worktree. |
| Permission mode | flag `--permission-mode <auto\|default>` en `worktree create/work`, **default `default`**. Santree usa `auto` siempre; para el flujo SDD+TDD del repo target preferimos default más estricto, con override por flag. |
| Prompt inicial (`--prompt`) | inyección literal. El texto va como primer mensaje al Claude recién lanzado, sin templating. Si más adelante hace falta enriquecer con título/body/labels del issue, evaluamos un template Nunjucks. |
| Naming del worktree | `<issue>` solo (ej `100`, `FE-123`). El directorio es el ID del issue sin descripción; el `<desc>` sólo vive en el nombre del branch. |

---

## Stack y dependencias

- **Runtime**: Node ≥ 20.
- **Lenguaje**: TypeScript estricto.
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) (React para terminales).
- **CLI framework**: [Pastel](https://github.com/vadimdemedes/pastel) — declara comandos como componentes React, file-based routing.
- **Schemas**: [Zod](https://zod.dev) — para flags de CLI y validación.
- **Templates de prompts** (cuando los necesitemos): [Nunjucks](https://mozilla.github.io/nunjucks/) — siguiendo santree.
- **Lint**: ESLint con la config de XO o similar (definir en scaffolding).

### Tools externas requeridas

- `git` — obvio, para worktrees.
- `gh` (GitHub CLI) — autenticado.
  - Provider `github`: requerido para listar issues + crear/inspeccionar PRs.
  - Provider `linear`: necesario sólo para PR status de las branches con worktree. `mintree doctor` lo marca opcional cuando provider=linear.
- `claude` (Claude Code CLI) — para lanzar sesiones.
- `tmux` — opcional pero recomendado para abrir worktrees en ventanas separadas.

### Auth para provider Linear

API key personal de Linear (`lin_api_...`) requerida cuando `provider === "linear"`. Resolución:
1. `LINEAR_API_KEY` env var (prioridad 1)
2. `~/.mintree/credentials.json` con shape `{ "linear": { "apiKey": "..." } }` (prioridad 2)

La key va directo en el header `Authorization` (sin prefijo `Bearer`). Nunca se guarda en `.mintree/metadata.json` del repo (sería leak en caso de que alguien committee el archivo por accidente).

---

## Scope del MVP

Comandos a implementar, en orden de prioridad:

| # | Comando | Qué hace |
|---|---------|----------|
| 1 | `mintree doctor` | Verifica `git`, `gh` (autenticado), `claude`, Node, tmux opcional, **Remote Control habilitado** en `~/.claude/config.json` (`remoteControlAtStartup: true`), y los hooks de session-signal en `~/.claude/settings.json`. |
| 2 | `mintree init` | Marca el repo actual como mintree-enabled: crea `.mintree/metadata.json`, `.mintree/worktrees/`, agrega entradas a `.gitignore` si faltan. |
| 3 | `mintree dashboard` | TUI principal full-screen, alt-screen + mouse. Split pane: lista de issues asignados (`gh api search/issues?q=is:open+is:issue+assignee:@me+repo:<owner>/<name>`) + panel de detalle. Atajos: `w` work, `↵` resume, `e` open editor, `o` open issue browser, `d` rm worktree, `q` exit. |
| 4 | `mintree worktree create <branch>` | Flags `--base`, `--work`, `--prompt <text>`. Crea worktree en `.mintree/worktrees/<issue>/` (ver "Estructura en disco"). Si `--work`, lanza Claude post-creación con el prompt opcional inyectado. |
| 5 | `mintree worktree work` | Reanuda sesión Claude del worktree actual (o crea nueva si no hay session_id). Acepta `--prompt <text>` para mensaje inicial. |
| 6 | `mintree worktree list` | Lista worktrees con issue asociado, branch, dirty status, commits ahead, PR status. |
| 7 | `mintree worktree remove <branch>` | Borra worktree. **No** borra el branch automáticamente (diferencia con santree — para no perder branches con PR abierto). |
| 8 | `mintree worktree clean` | Borra worktrees cuyo PR está merged/closed. Pide confirmación. |
| 9 | `mintree helpers shell-init <zsh\|bash>` | Imprime el shell wrapper para `eval` en `.zshrc`/`.bashrc`. Define la función `mintree`/`mt`/`mtw`/`mtn` que parsea markers `MINTREE_CD:<path>` y ejecuta `cd` en el shell padre. |
| 10 | `mintree helpers session-signal {install,prompt,stop,end,notification}` | Instala los 4 hooks de Claude Code en `~/.claude/settings.json` (`UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification`) que escriben estado vivo a `<repo>/.mintree/session-states/<id>.json`. |

Out-of-scope explícito para el MVP:

- No `mintree pr create/fix/review` con prompts AI (santree los tiene; nosotros usamos las skills del repo target — `/crear-pr`, `/review-pr`).
- No statusline custom de Claude (santree la tiene como helper; opcional para v1.x).
- No diff overlay inline (tecla `v` en santree). Nice-to-have, no MVP.
- No multiplexer cmux. Solo `tmux` y `none` para empezar.

> Nota: la decisión "no multi-provider" se revisó al agregar Plane (0.2.0) y se revisitó al cambiar Plane por Linear (0.3.0). Hoy soporta github + linear.

---

## Estructura en disco (en el repo target)

Al correr `mintree init` en un repo, queda:

```
<repo>/
├── .gitignore                          # se le agregan: .mintree/worktrees/, .mintree/session-states/, .mintree/metadata.json
└── .mintree/
    ├── metadata.json                   # gitignored. Config del provider + mapa <issue-id> → { base_branch?, session_id? }.
    ├── worktrees/                      # gitignored
    │   ├── 100/                        # GH form: <digits>
    │   └── FE-123/                      # Linear form: <TEAM-digits>
    ├── session-states/                 # gitignored
    │   ├── 100.json                    # estado vivo de Claude (active/waiting/idle/exited)
    │   └── FE-123.json
    └── init.sh                         # opt-in, corre en post-create del worktree (copia .env, npm install, etc.)
```

> **Nota sobre `metadata.json`**: gitignored siempre porque guarda el `session_id` (UUID generado localmente por Claude para cada dev), que no debe compartirse. Si `mintree init` corre en un repo donde `metadata.json` ya estaba committed, muestra un warning con la instrucción `git rm --cached`.

Shape del metadata para provider=linear:

```json
{
  "version": 1,
  "provider": "linear",
  "issues": { "FE-123": { "base_branch": "main", "session_id": "uuid..." } },
  "linear": {
    "apiUrl": "https://api.linear.app/graphql",
    "workspaceSlug": "acme",
    "teams": [
      { "key": "FE", "name": "Frontend" },
      { "key": "BE", "name": "Backend" }
    ]
  }
}
```

Para provider=github (default) basta con `{ version: 1, provider: "github", issues: {} }` (o sin `provider` — se infiere github).

Naming del directorio del worktree: **`<issue-id>`** solo. Para GH: `100`. Para Linear: `FE-123`. Es el issueId que se extrae del branch (group 2 del `BRANCH_REGEX`); la descripción del branch no entra al nombre del directorio. Esto difiere de santree (que usa el ticket ID en uppercase como `GH-100`); mintree usa el ID humano del provider tal cual. Los regex que recuperan el issueId del dirname (`dashboard.ts`, `session-signal.ts`, `worktree/work.tsx`) toleran además el viejo formato `<issue>-<desc>` para worktrees que ya estén en disco.

---

## Convenciones del repo target

Mintree tiene que respetar estas reglas cuando crea cosas:

### Branches

Formato: `<tipo>/<issue>-<descripcion-kebab>`

- `<tipo>`: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `perf`, `style`, `revert`.
- `<issue>`: identifier del work item. Dos formas aceptadas:
  - GitHub: dígitos puros (ej `42`, `100`)
  - Linear: `<TEAM_KEY>-<digits>` donde el team key es uppercase letras/dígitos/underscores arrancando con letra (ej `FE-123`, `BE-7`, `DSGN-42`)
- Sin corchetes, sin `#`.

Ejemplos: `feat/42-validacion-patente`, `fix/55-selfie-upload-timeout`, `feat/FE-123-readme-update`, `fix/BE-7-rate-limit`.

### Extracción del issue ID desde branch

Regex de mintree (single source of truth en `source/lib/branch.ts`):

```ts
// Match: <prefix>/<issueId>-<desc>
// issueId es: \d+ (GitHub) o <TEAM>-\d+ (Linear)
const BRANCH_REGEX = /^([a-z]+)\/((?:[A-Z][A-Z0-9_]*-)?\d+)-([a-z0-9][a-z0-9-]*)$/;
const m = branch.match(BRANCH_REGEX);
const issueId = m ? m[2] : null;  // ej "100" o "FE-123"
```

El mismo shape se usa en `worktreeCreate.ts` (validación), `worktree/work.tsx` (resolver session_id) y `session-signal.ts` (live state hooks). Para recuperar el issueId desde el **nombre del dir** del worktree hay un único helper, `issueIdFromWorktreeDirName` (`branch.ts`), por el que pasan `dashboard.ts`, `worktreeRemove.ts` y `clean.tsx`. Cualquier cambio al regex tiene que tocar esos sitios coordinadamente.

---

## Sesiones de Claude

Patrón (igual a santree):

1. **Crear**: generar UUID v4, guardarlo en `.mintree/metadata.json` bajo `<issue-id>.session_id`, lanzar `claude --permission-mode <auto|default> --session-id <uuid>`.
2. **Reanudar**: leer `session_id` de metadata, lanzar `claude --resume <uuid>`.
3. **Estado vivo**: hooks de Claude Code escriben a `.mintree/session-states/<issue-id>.json`:
   - `Notification` → `waiting`
   - `Stop` → `idle`
   - `UserPromptSubmit` → `active`
   - `SessionEnd` → `exited`
4. El dashboard muestra el estado en vivo (refrescando cada 5 minutos; `r` para refresh manual).

### Remote Control

`mintree doctor` verifica que `~/.claude/config.json` tenga `remoteControlAtStartup: true`. Si no, sugiere correr `/config` en Claude Code y activar "Enable Remote Control for all sessions". (Este check es idéntico al `checkRemoteControl()` de santree en `source/commands/doctor.tsx:395`.)

---

## Estado actual (post-0.3.0)

El MVP del plan original (Fases 0-5 abajo) está terminado. Después se sumó Plane como segundo provider (0.2.x) y en 0.3.0 Plane fue **reemplazado por Linear**. Hoy soporta github + linear.

Cambios de la 0.3.0 (Plane → Linear):

- Borrado `source/lib/providers/plane.ts`; nuevo `source/lib/providers/linear.ts` con GraphQL contra `api.linear.app/graphql`.
- `Metadata.provider` ahora es `"github" | "linear"` (era `"github" | "plane"`); `metadata.plane` reemplazado por `metadata.linear: { workspaceSlug, teams: [{ key, name? }], apiUrl?, inProgressStateName?, protectedStateTypes? }`.
- `mintree init` toma `--provider linear --workspace <slug> --team <key>` (`--team` repetible).
- `mintree doctor` muestra una fila Linear con check de API key + viewer + per-team ping.
- Auth: `LINEAR_API_KEY` env var o `~/.mintree/credentials.json#linear.apiKey` (sin prefijo `Bearer` en el header).
- Breaking change para cualquier repo con `provider: "plane"` — hay que re-correr `mintree init --provider linear --workspace <slug> --team <key>` (o editar `metadata.json` a mano).

Cambios de la 0.4.9 (branch de Linear):

- Con `provider: "linear"`, mintree usa el `branchName` que sugiere Linear (`<user>/<team>-<n>-<desc>`, ej `jdoe/fe-68-landing-page`) **verbatim** como branch del worktree, en vez de forzar `<type>/<issue>-<desc>`. Fallback a la convención si el issue no trae `branchName`. GitHub sin cambios.
- `ProviderIssue.branchName?: string` (poblado por el provider Linear desde el campo `branchName` del GraphQL). El dashboard lo usa en el overlay `w`: muestra la branch de Linear read-only (`from Linear`) y saltea los campos type/description.
- `source/lib/branch.ts`: `parseLinearBranch(branch, teamKeys)` + `extractLinearIssueId(branch, teamKeys)`. Extraen el id `<TEAM>-<n>` (case-insensitive, restringido a los teams configurados) y lo normalizan a mayúsculas; el branch se preserva tal cual. `ParsedBranch.type/desc` ahora son opcionales (sólo para branches de convención). El worktree dir sigue siendo el issueId pelado (`FE-68`).
- `runCreate` resuelve la branch con `resolveCreateBranch`: primero convención, y si falla y `provider=linear`, parsea como branch de Linear. Tanto el CLI (`worktree create <branch>`) como el dashboard pasan por ahí.
- **Tests automatizados**: agregado runner con `node:test` + `tsx` (`npm test`, `test/*.test.ts`). Cubren el parseo/derivación del branch de Linear y un create end-to-end con provider Linear mockeado vía metadata.

Cambios de la 0.4.10 (config de lanzamiento):

- `metadata.json` acepta dos claves top-level opcionales (válidas para github y linear):
  - `defaultPermissionMode: "default" | "auto"` — permission-mode por defecto con el que mintree lanza Claude (dashboard `w`/`↵`, `worktree work`, `worktree create --work`). El flag `--permission-mode`/`-m` sigue overrideando por lanzamiento. Resolución centralizada en `worktree/work.tsx` (`flag ?? metadata.defaultPermissionMode ?? "default"`), que es el único punto por el que pasan todos los flujos de launch.
  - `promptTemplate: string` — template del prompt inicial seedeado en el overlay `w`, con placeholders `{{id}}`, `{{title}}`, `{{url}}`. Render en `source/lib/promptTemplate.ts` (`renderPromptTemplate`). Cuando falta, fallback al default provider-aware de `defaultPromptForIssue` (dashboard).
- Sanitización de ambos campos en `readMetadata` (`source/lib/metadata.ts`). Tests nuevos: `test/metadata.test.ts` y `test/promptTemplate.test.ts`.

Cambios de la 0.5.0 (tab Orchestrate):

- Tercer tab **Orchestrate** en el dashboard (`source/commands/dashboard.tsx`). Muestra el mismo set que Issues (no-orphan) pero cada fila lleva un checkbox `[ ]`/`[✔]`. Navegás con flechas/`j`/`k`, **Space** togglea la selección, **`a`** togglea todas, **Enter** lanza el orquestador. `←/→` ahora cicla por los 3 tabs (`TAB_ORDER`). El chip muestra la cantidad de tickets tildados. Estado nuevo en `ReadyState`: `orchestrateIndex` + `selectedIds: Set<string>` (los ids resueltos/cerrados se descartan en cada `refresh`).
- Config nueva `orchestratorPromptTemplate: string` (top-level en `metadata.json`, vale github + linear). Placeholders `{{ids}}` (lista coma-separada de los tickets seleccionados, en orden de la lista) y `{{count}}`. Render en `source/lib/promptTemplate.ts` (`renderOrchestratorTemplate`); cuando falta, fallback a `defaultOrchestratorPrompt` (texto en castellano que replica el flujo manual del usuario). Sanitización en `readMetadata`.
- Comando nuevo `mintree orchestrate [ids...]` (`source/commands/orchestrate.tsx`). Lanza un Claude **en la raíz del repo** (no en un worktree) con sesión fresca (UUID nuevo, sin resume) + remote-control `orchestrator`, vía `launchClaude`. Opciones `--prompt` / `--prompt-file` (excluyentes) / `--permission-mode`. Con ids positivos y sin prompt, renderiza el template. Reutiliza `writePromptFile` (ahora exportado desde `worktreeCreate.ts`).
- Markers nuevos: `buildOrchestrateMarkers` (`source/lib/markers.ts`) emite `MINTREE_CD:<repoRoot>` + `MINTREE_ORCHESTRATE:1` + `MINTREE_ORCHESTRATE_PROMPT_FILE:<f>` (+ `MINTREE_PERMISSION_MODE`). El shell wrapper (`shell/init.zsh` + `init.bash`) los maneja en `_mintree_handle_markers`: tras el `cd`, si está `MINTREE_ORCHESTRATE:` corre `mintree orchestrate --prompt-file … --permission-mode …` (toma precedencia sobre `MINTREE_WORK`). El dashboard escribe los markers a `MINTREE_MARKER_FILE` como ya hacía.
- Tests: `test/promptTemplate.test.ts` (orquestador), `test/metadata.test.ts` (`orchestratorPromptTemplate`), `test/markers.test.ts` (nuevo).
- La sesión del orquestador **no** se persiste/reanuda en v1 (no se mapea a un issue) — resume queda como follow-up.

Cambios de la 0.5.1–0.5.5 (fixes del orquestador + Linear):

- **0.5.1** (`fix(orchestrate)`): el arg posicional `ids` de `mintree orchestrate` pasó a ser opcional, para que el handshake del dashboard (que lanza vía markers, sin ids posicionales) funcione.
- **0.5.2** (`fix(orchestrate)`): remote-control name único por sesión del orquestador, para evitar colisiones con una sesión previa aún registrada.
- **0.5.3** (`chore`): bump de versión para evitar choque con un `v0.5.2` ya publicado.
- **0.5.4** (`fix(linear)`): el dashboard excluye los issues de tipo "duplicate" para no listarlos.
- **0.5.5** (`feat(orchestrate)`): la sesión RC del orquestador se nombra según los ticket ids que cubre (`orchestrator-FE-12_BE-16_FE-3`), para identificarla en la UI de Remote Control. Fallback a un hash de sesión cuando no hay ids. El nombre se forwardea por `--rc-name` (marker `MINTREE_ORCHESTRATE_RC_NAME`) porque el lanzamiento del dashboard no lleva ids posicionales.

Cambios de la 0.5.6–0.5.7 (badge de iTerm2):

- **0.5.6** (`feat(claude)`): mintree etiqueta cada sesión de Claude con el **badge** nativo de iTerm2 (el texto translúcido sobre la sesión) usando el nombre de la sesión: el issue id del worktree (`FE-68`) o el RC name del orquestador. Se usa el badge y no el título del tab porque Claude Code reescribe el título (OSC 0/2) mientras corre y no expone forma de fijarlo; el badge es independiente y persiste toda la sesión, y se limpia al salir. Módulo nuevo `source/lib/terminal.ts` (`isITerm`, `buildBadgeSequence` pura, `setITermBadge`/`clearITermBadge`); enganchado en `launchClaude` (`source/lib/claude.ts`). No-op fuera de iTerm2 (detección `TERM_PROGRAM`/`LC_TERMINAL`); wrap DCS de tmux cuando `$TMUX` está set. Tests en `test/terminal.test.ts`.
- **0.5.7** (`docs`): documentado el badge de iTerm2 en el README (sección *Claude Code integrations*).

Cambios de la 0.5.9–0.5.11 (experimento tab title / user variable → revert al badge):

- **0.5.9** (`fix(claude)`): el badge de iTerm2 (0.5.6) renderizaba **enorme** — su font escala para llenar una caja cuyo tamaño fija el perfil de iTerm2, y no hay secuencia de escape para achicarlo per-session. Reemplazado por el **tab title** vía **OSC 1** (set icon name). **Esto no funcionó**: se confirmó en vivo que Claude Code setea el título con **OSC 0** (que toca ambos slots: window title + icon name), así que pisa también el OSC 1 a los ~0.5s de arrancar. Quedó como paso intermedio, ver 0.5.10.
- **0.5.10** (`fix(claude)`): conclusión del hallazgo anterior — **cualquier** título (OSC 0/1/2) lo pisa Claude. El único slot de iTerm2 que Claude no toca es una **user variable** (`SetUserVar`). mintree ahora publica el nombre de sesión como `user.mintree` (base64) y lo limpia al exit. `source/lib/terminal.ts`: `buildSessionVarSequence`/`setITermSessionVar`/`clearITermSessionVar` (+ `SESSION_VAR_NAME = "mintree"`); secuencia `ESC]1337;SetUserVar=mintree=<b64>BEL`, wrap DCS de tmux, no-op fuera de iTerm2. `launchClaude` (`source/lib/claude.ts`) la setea antes del spawn. **Requiere setup de perfil una vez** (documentado en README): campo Name = `\(user.mintree)` + destildar "Terminal may set tab title" para que Claude no pise el Session Name. Trade-off: si el toggle de tab/window está combinado, se pierde el resumen descriptivo de Claude en el window title. Tests (`test/terminal.test.ts`) y README actualizados.
- **0.5.11** (`revert`): la user var (0.5.10) requería setup manual del perfil de iTerm2, que no convenció. Se revierte al **badge** (estado 0.5.8): `source/lib/terminal.ts`/`claude.ts`/`test/terminal.test.ts`/README restaurados a `buildBadgeSequence`/`setITermBadge`/`clearITermBadge` (`SetBadgeFormat`). El badge es grande pero funciona sin tocar el perfil. Conclusión del experimento 0.5.9–0.5.10, conservada acá para no repetirlo: el título (OSC 0/1/2) no sirve para etiquetar sesiones de Claude (lo pisa con OSC 0); las únicas alternativas que sobreviven son el badge (grande, zero-config) y la user var (chica, requiere config de perfil).

Cambios de la 0.5.12 (symlink de archivos gitignored al worktree):

- **0.5.12** (`feat(worktree)`): nueva clave top-level `linkFiles: string[]` en `metadata.json` (vale github + linear). Lista paths relativos a la raíz del repo que mintree **symlinkea** dentro de cada worktree recién creado (caso típico: `.env`). Resuelve que los git worktrees no comparten archivos untracked: el `.env` gitignored vive solo en el checkout principal y el worktree nace sin él, rompiendo tooling per-worktree (p. ej. la suite E2E que lee credenciales de staging). Symlink y no copia → single source of truth (rotás credencial en el principal y todos los worktrees la ven); `worktree remove` borra el link, nunca el original. Best-effort: source ausente o target ya presente se saltean como step `skip`. Corre **antes** de `.mintree/init.sh` para que el hook pueda asumir los archivos presentes. Sanitización en `readMetadata` (`source/lib/metadata.ts`, `sanitizeLinkFiles`): descarta no-strings, vacíos, paths absolutos y escapes con `..`; normaliza y de-dupea. Helper `linkFilesIntoWorktree` en `source/lib/worktreeCreate.ts`, cableado en `runCreate` + `runCreateDetached` (cubre CLI `worktree create`, overlay `w` del dashboard y flujo detached). Tests nuevos en `test/worktreeCreate.test.ts` (symlink real + skip de source ausente) y `test/metadata.test.ts` (sanitización). README documentado (sección *Linking gitignored files into worktrees*).

Cambios de la 0.5.13 (bypass del cache de Linear en el refresh manual):

- **0.5.13** (`fix(dashboard)`): el refresh manual (`r`) del dashboard ahora **saltea** el snapshot cache del provider Linear, así un ticket recién asignado en Linear aparece apenas apretás `r` en vez de esperar a que venza el TTL de 60s. Antes, si el último fetch había sido hace <60s (el load del mount o un `r` previo), `loadSnapshot` cortocircuitaba con el snapshot cacheado y la query GraphQL nunca se reejecutaba. Nuevo tipo `LoadOptions { forceRefresh?: boolean }` en `source/lib/providers/types.ts`, cableado por `IssueProvider.listAssignedIssues`/`fetchProjectAssignments` → `LinearProvider.loadSnapshot(forceRefresh)` (gatea sólo el `readSnapshotCache`; el per-instance `snapshotPromise` se conserva, así los dos callers de un mismo load comparten el único fetch forzado) → `loadDashboard(root, opts)` → `refresh({ forceRefresh: true })` en el handler de `r`. El mount, el auto-refresh de 5min y el post-remove siguen usando cache. GitHub no tiene cache → ignora el flag (firma compatible, no se tocó `github.ts`). Tests nuevos en `test/linear.test.ts` (cache hit dentro del TTL + bypass con `forceRefresh`, mockeando `global.fetch`).

Cambios de la 0.5.14 (linkFiles: copia en vez de symlink):

- **0.5.14** (`fix(worktree)`): los archivos de `linkFiles` ahora se **copian** al worktree en vez de symlinkearse. Motivo: con symlink, editar el `.env` del worktree mutaba el `.env` del checkout principal (single source of truth compartido), rompiendo el aislamiento per-worktree — un cambio local de puerto/flag en un worktree pisaba a los demás y al principal. Con copia, cada worktree nace con su **propio** archivo independiente. Trade-off documentado: es un snapshot al momento de crear el worktree, así que rotar una credencial en el `.env` principal **no** se propaga a worktrees ya creados (re-copiar a mano si hace falta). `fs.symlinkSync` → `fs.copyFileSync` en `source/lib/worktreeCreate.ts`; helper renombrado `linkFilesIntoWorktree` → `copyFilesIntoWorktree`; los steps ahora son `copied X` / `skipped copy X` / `failed to copy X` (antes `linked`/`skipped link`/`failed to link`). **La clave de config sigue siendo `linkFiles`** (back-compat: no hace falta tocar el `metadata.json` de los repos target). Tests actualizados en `test/worktreeCreate.test.ts` (verifica archivo regular, no symlink, + que editar la copia no toca el original). README (sección renombrada *Copying gitignored files into worktrees*) y comentarios de `metadata.ts` actualizados. Worktrees ya existentes conservan su symlink viejo: reemplazar a mano (`rm <wt>/.env && cp <root>/.env <wt>/.env`) si se quiere el archivo independiente.

Cambios de la 0.5.15 (multi-select de worktrees para borrado batch):

- **0.5.15** (`feat(dashboard)`): el tab **Worktrees** ahora soporta selección múltiple igual que Orchestrate. Cada fila lleva checkbox `[ ]`/`[✔]`; **Space** togglea el worktree bajo el cursor, **`a`** togglea todos los visibles, y **`d`** borra el batch tildado en una sola confirmación (con nada tildado, `d` sigue borrando la fila bajo el cursor — comportamiento previo intacto). Estado nuevo `selectedWorktreeIds: Set<string>` en `ReadyState` (paralelo a `selectedIds` de Orchestrate); se filtra en cada `refresh` a los ids que siguen siendo orphan, así un worktree ya removido/re-atachado sale del batch. `RemoveOverlay` pasó de campos single (`issue`/`branch`/`worktreePath`/`dirty`) a `targets: RemoveTarget[]`; `confirmRemove` itera los targets (runRemove/runRemoveByPath son síncronos), agrega resultados y togglea la confirmación con `Y` si **algún** target está dirty (mismo gating que el single). `RemoveOverlayView` renderiza single vs batch (lista de ids + branch + dirty/clean). Footer nuevo del tab Worktrees con hints Space/a/d(count). Helper `toRemoveTarget`. Sin tests nuevos (la lógica de remove vive en `worktreeRemove.ts`, ya cubierta; los cambios son de estado/UI de la TUI).

Cambios de la 0.5.16 (test de regresión del checkbox + fix de proceso):

- **0.5.16** (`test(dashboard)`): confirmado que el multi-select del tab Worktrees (0.5.15) renderiza bien — el "no anda" reportado fue un proceso del dashboard corriendo el `dist/` viejo en memoria (Node cachea el módulo al importarlo; `r`/auto-refresh recargan datos pero no el código). Recordá [[project-dist-tracked]]: el `dist/` está trackeado y el binario (`npm link`) lo ejecuta; hay que `npm run build` + `git add dist` y **reabrir el proceso** (`q` y `mintree dashboard` de nuevo) para tomar el código nuevo. Se exportó `IssueListRow` (`source/commands/dashboard.tsx`) y se agregó `test/dashboard.test.ts` (con `ink-testing-library` como devDep) que verifica el prefijo `[ ]`/`[✔]`/sin-brackets según el prop `checkbox` — primer test de render de la TUI, cubre el wiring que faltaba.

Cambios de la 0.5.17 (fix de metadata):

- **0.5.17** (`chore`): el campo `author` de `package.json` pasó del mail de trabajo al personal (`martinmineo@gmail.com`). Solo metadata del paquete npm; no toca código ni `dist/`.

Cambios de la 0.5.18 (mensaje extra en el launch):

- **0.5.18** (`feat(dashboard)`): al arrancar a trabajar un ticket desde **Issues** (`w`) o desde **Orchestrate** (`↵`), ahora se puede agregar un **mensaje extra** opcional que mintree appendea al prompt del template (separado por línea en blanco, `<template>\n\n<extra>`). El template renderizado (`promptTemplate` / `orchestratorPromptTemplate`, o el default) pasa a mostrarse **read-only** como prompt base, y el usuario tipea su texto en un campo nuevo **Extra** (puede quedar vacío = solo el template). Antes: en Issues el prompt era un único campo editable con el template; en Orchestrate `↵` lanzaba directo sin chance de agregar nada.
  - `CreateOverlay`: nuevo campo `extra` + `field` enum `"prompt"` → `"extra"`; el `prompt` (template) queda read-only. `combinePrompt(base, extra)` (exportado) une ambos. `confirmCreate` lo usa en vez de `overlay.prompt.trim()`.
  - Nuevo `OrchestrateOverlay` + `OrchestrateOverlayView`: `↵` en el tab Orchestrate abre un overlay de confirmación (ids + template read-only + campo Extra) en vez de lanzar directo. `launchOrchestrator` se partió en `openOrchestrateOverlay` (valida + renderiza el template + abre overlay) y `confirmOrchestrate` (combina + `writePromptFile` + markers + exit). El `rcName`/`permissionMode` se capturan al abrir.
  - `FooterRow` y el render principal manejan el kind `orchestrate`; `onOverlayExtraChange` es compartido por ambos overlays (los dos tienen `extra`).
  - Tests nuevos en `test/dashboard.test.ts` para `combinePrompt` (append, extra vacío, base vacío, trim). El CLI `mintree orchestrate` no cambió (ya tiene `--prompt`).

Cambios de la 0.5.19 (cajita multi-línea para el mensaje extra):

- **0.5.19** (`fix(dashboard)`): el campo **Extra** (0.5.18) pasó de un `ink-text-input` de **una línea** a una **cajita multi-línea** bordeada. El single-line rompía todo el overlay al **pegar un texto largo/multi-línea** (Ink desparramaba el contenido, superaba el alto de la terminal y se pisaba con el fondo — reportado en vivo). La cajita nueva soporta Enter=newline, wrapping y **paste multi-línea** (se inserta como un solo chunk y scrollea internamente en vez de desbordar).
  - Componente nuevo `source/lib/MultilineTextArea.tsx`, **portado de santree** (`source/lib/dashboard/MultilineTextArea.tsx`) **sin** el `Ctrl+O` editor externo ni el paste de imagen (Ctrl+V), y sin insertar Tab literal (Tab lo usa el overlay para navegar campos). Mantiene: escritura, newline, backspace, edición readline (Ctrl+A/E/W/U/K, Option+←/→/⌫), navegación por filas visuales (soft-wrap), stripping de secuencias OSC que se cuelan en stdin, y render con borde + scroll + placeholder + cursor.
  - **Keybindings nuevos**: dentro de la cajita, **Enter inserta un salto de línea** (ya no lanza) y **`Ctrl+D` lanza** (create+work / orchestrate); `Esc`/`Ctrl+G` cancelan. Antes Enter lanzaba — chocaba con escribir párrafos. Footer de ambos overlays actualizado.
  - **Wiring**: el `MultilineTextArea` y el `useInput` global del dashboard coexisten. En create, `focus = field === "extra"` (isActive gate); `handleOverlayInput` ya no confirma con Enter cuando `field === "extra"` (lo maneja la cajita) y Tab sigue ciclando campos. En orchestrate la cajita siempre tiene foco y el handler global cede todo salvo Esc. `onExtraSubmit`/`onExtraCancel` (→ `confirmCreate`/`confirmOrchestrate` / cerrar overlay) + geometría `extraBoxWidth`/`createExtraHeight`/`orchestrateExtraHeight` (clamp a la terminal; la cajita scrollea si es chica).
  - **Prompt base**: en ambos overlays el template dejó de mostrarse entero (era el otro culpable del desborde) — ahora se muestra **truncado a ~120 chars en una línea** (`truncate(prompt.replace(/\s+/g," "), 120)`).
  - Tests nuevos en `test/multilineTextArea.test.ts` (placeholder, borde, render multi-línea) con `ink-testing-library`. README actualizado (Ctrl+D + cajita).

Cambios de la 0.5.20 (submit con Option+Enter en vez de Ctrl+D):

- **0.5.20** (`fix(dashboard)`): la tecla para **lanzar** desde la cajita Extra pasó de **`Ctrl+D`** a **`Option+Enter`** (⌥Enter). `Ctrl+D` chocaba con un hotkey de iTerm2 del usuario y no dejaba avanzar. `Enter` sigue siendo salto de línea. Descartado `Shift+Enter`: las terminales no lo distinguen de `Enter` (mismo byte `\r`) sin activar CSI-u a mano.
  - `MultilineTextArea`: el branch de submit `key.ctrl && input === "d"` → `key.meta && key.return`, chequeado **antes** del branch de Enter (newline). **Requiere** Option configurado como "Esc+" en iTerm2 (Profiles → Keys) para que la terminal mande `ESC`+`CR` y Ink lo reporte como `key.meta && key.return`. `Ctrl+G`/`Esc` siguen cancelando.
  - Footers de ambos overlays: `Ctrl+D` → `⌥Enter`.
  - Riesgo conocido: si Ink no agrupa `ESC`+`CR` en un solo evento (lo separa en `key.escape` + `key.return`), el overlay se cerraría en vez de lanzar. En la práctica Ink agrupa la secuencia meta; si no anduviera, habría que detectar la secuencia cruda. Cambio no cubierto por tests (input de teclado en TTY).

Cambios de la 0.5.21 (fix de pérdida de texto al pegar bloques grandes):

- **0.5.21** (`fix(dashboard)`): pegar un texto **grande** en la cajita Extra **perdía parte del contenido** (reportado: un prompt de ~90 líneas entraba a partir de la línea ~14, sin el principio). Causa: un paste grande llega a stdin **partido en varios `data` events** que corren todos **antes** de que React re-renderice; el `MultilineTextArea` insertaba cada chunk leyendo el `value`/`cursor` de props/state (stale hasta el próximo render), así que los chunks se **pisaban** entre sí y se perdía texto. Bug heredado del port de santree (0.5.19).
  - Fix: el buffer y el cursor se espejan en **refs** (`valueRef`/`cursorRef`) que se actualizan **sincrónicamente** en cada edición; los chunks de una ráfaga se **encadenan** sobre el ref en vez de sobre el prop viejo. Reconciliación en render (`value !== lastEmittedRef.current`) para respetar resets externos sin pisar la ráfaga. `useState` del cursor queda solo para disparar re-render; la fuente de verdad es el ref. Render lee de los refs. `useEffect` de clamp reemplazado por la reconciliación.
  - Extra: stripping de los guardas de **bracketed paste** (`\x1b[200~`/`\x1b[201~` y el fragmento `[200~`/`[201~`) que algunas terminales anteponen al pegar, por si se cuelan en el input.
  - Tests nuevos (`test/multilineTextArea.test.ts`, con `ink-testing-library`): 3 chunks escritos back-to-back en el mismo tick → el buffer conserva `AAAABBBBCCCC` en orden (regresión directa del bug); + tipeo simple de caracteres.

Cambios de la 0.5.22 (submit con Ctrl+X):

- **0.5.22** (`fix(dashboard)`): la tecla para **lanzar** desde la cajita Extra pasó de **`Option+Enter`** (0.5.20) a **`Ctrl+X`**. `Option+Enter` no andaba porque **requiere** configurar la Option como "Esc+" en iTerm (Profiles → Keys) y el usuario no la tomó → llegaba un `\r` puro que Ink ve como Enter normal (insertaba newline en vez de lanzar). `Ctrl+X` (estilo nano) **anda sin ninguna config** de terminal. Historial de la tecla: `Ctrl+D` (0.5.19, chocaba con un hotkey de iTerm) → `Option+Enter` (0.5.20, requería config) → `Ctrl+X` (0.5.22). `Enter` sigue siendo salto de línea; `Ctrl+G`/`Esc` cancelan.
  - `MultilineTextArea`: branch de submit `key.meta && key.return` → `key.ctrl && input === "x"`. Footers de ambos overlays: `⌥Enter` → `Ctrl+X`. Test nuevo: `Ctrl+X` (`\x18`) dispara `onSubmit`.

Cambios de la 0.5.23 (unificar prompt + extra en una sola cajita editable):

- **0.5.23** (`feat(dashboard)`): se **unificaron** el "Prompt" (template read-only truncado) y la cajita "Extra message" en **una sola cajita `Prompt` editable**, seedeada con el template renderizado — el usuario agrega/quita/edita libremente y lo que quede es lo que se manda. Antes (0.5.18–0.5.22): template fijo read-only + extra que se appendeaba. El usuario pidió simplificar a una sola caja editable donde ya aparece el prompt de la config y se toca a gusto.
  - `CreateOverlay`/`OrchestrateOverlay`: se borró el campo `extra`; `prompt` pasó de read-only a **editable** (la fuente de verdad de la cajita). `field` enum `"extra"` → `"prompt"`. Se eliminó `combinePrompt` (+ sus 4 tests) — ya no hay base+extra: `confirmCreate`/`confirmOrchestrate` mandan `overlay.prompt.trim()` directo.
  - Vistas: se sacó la línea `Prompt:` read-only truncada de ambos overlays; la cajita ahora lleva el label `▸ Prompt (from your template — edit freely, empty = no message)`. Handlers `onOverlayExtra*` → `onOverlayPrompt*`; geometría `extraBox*` → `box*` (la cajita de create se agrandó un poco al liberar espacio: `createBoxHeight` clamp 4–8). Footer: `In the Prompt box:` / orchestrate `Edit the prompt`.
  - `Enter` = newline, `Ctrl+X` = launch, `Esc`/`Ctrl+G` = cancel (sin cambios). Vuelve, en esencia, al modelo pre-0.5.18 (prompt editable) pero con la cajita multi-línea robusta (paste grande sin pérdida, 0.5.21) en vez del `ink-text-input` de una línea.

Cambios de la 0.5.24 (Ctrl+L para vaciar la cajita):

- **0.5.24** (`feat(dashboard)`): nueva tecla **`Ctrl+L`** en la cajita `Prompt` (`MultilineTextArea`) que **borra todo** el contenido de una, sin importar dónde esté el cursor. Distinta de `Ctrl+U` (borra sólo hasta el inicio de línea). Útil para arrancar el prompt de cero cuando el template seedeado no sirve.
  - `MultilineTextArea`: branch nuevo `key.ctrl && input === "l"` → `emit("")` + `setCursor(0)`, chequeado después de submit/cancel. Footers de ambos overlays (create + orchestrate) suman `Ctrl+L clear`. Test nuevo en `test/multilineTextArea.test.ts` (`\x0c` vacía el buffer).
  - Elección de tecla: se descartó `Ctrl+Shift+L`/`Ctrl+Shift+D` porque las terminales **no distinguen** `Ctrl+Shift+<letra>` de `Ctrl+<letra>` (mismo byte, el Shift se pierde sin CSI-u activado — misma limitación que el `Shift+Enter` descartado en 0.5.20). `Ctrl+L` quedó confirmado por el usuario tras dudar de un posible choque con iTerm2 (no lo hubo). Teclas ya ocupadas: `x` launch, `g` cancel, `a/e/w/u/k` edición.

Cambios de la 0.5.25 (`worktree clean` poda la entrada de metadata):

- **0.5.25** (`feat(worktree)`): `mintree worktree clean` ahora **borra la entrada del issue en `metadata.json`** (incluido el `session_id`) por cada worktree que remueve. Antes conservaba todo — igual que `remove` — y las entradas se acumulaban indefinidamente (el repo target tenía ~250). Racional: `clean` sólo toca worktrees cuyo PR está merged/closed, o sea el issue ya está cerrado; no hay sesión que reanudar, así que la entrada es basura. `remove` **sigue conservando** metadata a propósito (permite re-atachar y reanudar la sesión de Claude) — política confirmada por el usuario ("clean poda, remove conserva").
  - Helper nuevo `removeIssue(repoRoot, issueId): boolean` en `source/lib/metadata.ts` (borra la entrada + persiste; no-op que devuelve `false` si no existe, así se llama sin chequear).
  - Helper nuevo `issueIdFromWorktreeDirName(dirName): string | null` en `source/lib/branch.ts` — centraliza el regex `^((?:[A-Z][A-Z0-9_]*-)?\d+)(?:-|$)` que hasta ahora vivía inline en `buildWorktreeIndex` (`dashboard.ts`); recupera el issueId del nombre del dir del worktree (bare id o legacy `<id>-<desc>`), null para dirs detached. `clean.tsx` lo usa tras cada `removeWorktree` exitoso para localizar la entrada a podar; dirs sin issueId parseable se saltean.
  - Mensaje final de `clean`: "Branches and metadata preserved" → "Branches preserved; metadata entries pruned". README actualizado (comentarios de `remove`/`clean`). Tests nuevos: `removeIssue` (borra + persiste + no-op) en `test/metadata.test.ts` y `issueIdFromWorktreeDirName` (bare/legacy/null) en `test/branch.test.ts`.
  - **Hint de Docker en el remove fallido**: cuando `git worktree remove` falla con `Permission denied`, `runRemove`/`runRemoveByPath` ahora agregan un `hint` explicando que probablemente haya un stack de Docker Compose levantado sobre el worktree (de `make worktree-up`) y que hay que bajarlo (`docker compose -p <project> down -v`) antes de reintentar. El raw error de git no daba ninguna pista. Helper nuevo `removeFailure(stderr)` (exportado) que centraliza la construcción del `RemoveResult` de error + detección `permission denied` case-insensitive; los dos catch de `worktreeRemove.ts` lo usan. El CLI (`remove.tsx`) ya renderiza `result.hint` y el dashboard concatena `message — hint` en el overlay, así que el hint aparece en ambos flujos sin más cambios. Tests nuevos en `test/worktreeRemove.test.ts`.
  - **Contexto del hallazgo**: se destapó investigando un worktree `BE-347` que en el dashboard mostraba branch `jdoe/fe-78-autor-legible-flag` (mismatch) y fallaba el remove con `Permission denied`. Causa real del *Permission denied*: **Docker** — `make worktree-up` había dejado stacks de compose (`be-347-*`, `be-347-gaps-*`) con bind-mounts vivos sobre esos dirs, y los archivos creados por los containers no se podían borrar con el stack arriba. El mismatch dir/branch era **data vieja en memoria del dashboard**: git ya había pruneado el worktree (admin dir en `.git/worktrees/BE-347` borrado, dir de trabajo huérfano en disco), así que el branch mostrado era el del último refresh. Cleanup manual: `docker compose -p <proj> down -v` + `rm -rf` de los dirs huérfanos + `git worktree prune`. **Idea a futuro** (no hecho acá): que `worktree remove` corra un hook de teardown (`make worktree-down`) automáticamente antes del `rm -rf`, en vez de sólo sugerirlo en el hint.

Cambios de la 0.5.26 (ocultar tickets bloqueados en Linear):

- **0.5.26** (`feat(dashboard)`): con `provider: "linear"`, el dashboard **oculta** los issues que otro issue **bloquea** — salen tanto de la lista de Issues como de Orchestrate. Caso que lo motivó: `FE-300` estaba bloqueado por `BE-129` (In Progress) y aparecía como trabajable. Decisiones tomadas con el usuario: ocultar (no marcar), **siempre activo** (sin flag de config — un ticket bloqueado no es trabajable, no hay razón para verlo), y el bloqueante cuenta **sólo mientras esté abierto**.
  - **Semántica de Linear** (verificada contra la API real, no asumida): Linear guarda `A blocks B` **una sola vez**, en A; B la ve por `inverseRelations`. No existe un tipo de relación `blocked_by`. En el nodo, el bloqueante viene en `issue` y el bloqueado en `relatedIssue`. Sólo el type `blocks` oculta; `related`/`duplicate`/`similar` no.
  - Query: `inverseRelations { nodes { type issue { identifier title state { name type } } relatedIssue { …} } }` sumado al `BOOTSTRAP_QUERY` — **sin round-trip extra**, viaja en el mismo POST del bootstrap.
  - Helper nuevo exportado `blockersOf(wi, protectedTypes): string[]` (`source/lib/providers/linear.ts`). Toma el extremo de la relación cuyo `identifier` **no** es el issue mismo (defensivo ante que la API reporte la relación desde la otra perspectiva), y descarta los bloqueantes cuyo `state.type` esté en `protectedTypes` (los mismos `completed`/`canceled`/`duplicate` ya configurables por `linear.protectedStateTypes`). Un bloqueante **sin state legible se trata como abierto** (esconder un ticket trabajable es peor que mostrar uno bloqueado, pero un state ausente casi siempre significa "abierto"). El filtro corre en `listAssignedIssues`, que es el único origen de datos del dashboard (`loadDashboard` deriva todo de ahí), así que no hizo falta tocar `dashboard.ts` ni `fetchProjectAssignments`. Los tickets reaparecen solos cuando cierra el último bloqueante — no hay estado local que limpiar.
  - El bloqueante **no** necesita ser de un team configurado (`PLA` no está en `linear.teams` del repo target y aun así oculta) — la relación se lee desde el issue, no por query de team. GitHub no tiene relación nativa de blocking → sin cambios.
  - Tests nuevos en `test/linear.test.ts`: 6 unitarios de `blockersOf` (bloqueante abierto, cerrado en los 3 types protegidos, types no-blocking, extremo invertido, state ilegible, sin relaciones) + 1 end-to-end de `listAssignedIssues` con `global.fetch` mockeado. **Ojo**: el mock de `fetch` no valida el schema GraphQL — la validez de la query se verificó aparte, con un POST real a la API (46 vs 47 issues, `hiding FE-300: blocked by BE-129` en el debug log con `MINTREE_DEBUG=1`). Cualquier cambio a la query merece la misma prueba real.

Cambios de la 0.5.27 (init.sh falla cerrado + modo por entrada en linkFiles):

- **0.5.27** (`fix(worktree)`): el fallo del hook post-create `.mintree/init.sh` **falla cerrado**, y `linkFiles` pasa a decidir copy-vs-link **por entrada**. Motivación (medida sobre los worktrees vivos de un repo target): varios **mal aislados**, y el modo de falla que los produce es silencioso — el hook es lo que garantiza el aislamiento, pero su fallo salía como `warn` entre ~10 líneas de output y el worktree quedaba creado igual. Un worktree así *parece* sano y corre su gate contra el stack de main: verde validando la rama equivocada.
  - **Fallo del hook** → step `error` (kind nuevo, `✗` rojo) en vez de `warn`, **banner al final** del output (el step queda sepultado mid-scroll por lo que corre después), **exit code 1**, y marca `init_failed: true` en la entrada del issue de `metadata.json` (se limpia sola cuando un create posterior de ese issue sale bien). Decisión tomada con el usuario: **crear-y-marcar**, no abortar con rollback — el worktree y la branch no se pierden, que es lo caro.
  - **`--work` se retiene**: no se lanza Claude en un worktree sin inicializar, no se stagea el `--prompt`, y (por caer el `work` efectivo) tampoco se transiciona el issue a In Progress. `CreateResult.work` ahora es el work **efectivo**; `initFailed`/`initError` distinguen los dos falses.
  - **Diagnóstico real**: `describeInitFailure` saca el stderr del hook (fallback a stdout) + exit status del error de `execSync`. Antes el detail era el `err.message`, o sea `"Command failed: <path>"` — el stderr se capturaba con `stdio: pipe` y se tiraba justo cuando importaba. Truncado a 3 líneas / 300 chars.
  - **Un `init.sh` no ejecutable** cuenta como fallo (antes también, pero como warn): el setup no ocurrió, el estado es el mismo.
  - **`linkFiles` con `mode` por entrada** (`"copy"` | `"link"`): `[".env", { "path": ".env.local", "mode": "link" }]`. Cierra el ping-pong 0.5.12 (symlink) ↔ 0.5.14 (copia) — ninguno de los dos es correcto para todos los archivos: una credencial compartida y rotada quiere `link` (single source of truth), un archivo que el worktree debe poseer o que el hook regenera aislado quiere `copy`. Back-compat total: un string pelado significa `copy`, y `writeMetadata` **serializa los `copy` de vuelta a strings**, así el `metadata.json` de un repo que nunca optó por modos no churnea (cada `upsertIssue` reescribe el archivo entero). Un `mode` desconocido cae a `copy` en vez de descartar la entrada. La validación de paths (absolutos, escapes con `..`) aplica igual a las entradas objeto — si no, `mode: "link"` sería una forma de apuntar un symlink a cualquier lado.
  - **Refactor**: el bloque linkFiles+init.sh estaba **duplicado byte a byte** en `runCreate` y `runCreateDetached`; extraído a `bootstrapWorktree`. Era el bug latente exacto que este ticket arregla — un fix a la mitad de los call sites. `copyFilesIntoWorktree` → `materializeLinkFiles`.
  - Tests: 9 nuevos en `test/worktreeCreate.test.ts` (hook que falla: kind del step, stderr propagado, exit silencioso, `--work` retenido, marca en metadata, camino feliz sin marca, repo sin hook, hook no ejecutable, entrada `link` → symlink relativo que sigue la rotación) + 6 en `test/metadata.test.ts` (modo explícito, fallback de mode desconocido, validación de paths en objetos, round-trip de serialización, `setInitFailed` set/clear y preservación del resto de la entrada). Verificado además end-to-end con el CLI real contra un repo de prueba con un `init.sh` que falla a propósito.
  - **Pendiente, no atacado**: con detail largo y terminal angosta, Ink wrapea la fila del step y **se come el icono** (`✓`/`✗`) — preexistente, afecta a cualquier step con path largo, no sólo a los nuevos. El banner final no depende de eso.

Cambios de la 0.5.28 (progreso visible en el borrado batch de worktrees):

- **0.5.28** (`fix(dashboard)`): tras confirmar el remove batch del tab Worktrees (`d` → `y`/`Y`), el overlay ahora muestra un contador vivo `⠋ Removing 12/104 — BE-172...` en lugar de quedar congelado sin señal de vida. Reportado sobre un batch de 104 worktrees: apretabas `Y` y no pasaba nada visible.
  - **Causa**: `confirmRemove` corría los 104 `runRemove` en un `.map` **síncrono** (`execSync` + `rm -rf` por worktree), bloqueando el event loop durante decenas de segundos. Ink no puede repintar dentro de un tick bloqueado, así que la confirmación quedaba tal cual en pantalla hasta que terminaba todo el batch.
  - **Fix**: el `.map` pasó a un `for` que remueve **un target por vuelta**, publica `progress` con `setState` funcional y cede el hilo con `await setTimeout(FRAME_MS)` antes de cada `runRemove`, para que Ink pinte el contador. Mismo patrón `pending`/`await` que ya usaba `confirmCreate`. Constante nueva `FRAME_MS = 32` (compartida con `confirmCreate`).
  - **Segunda causa, igual de importante**: con 104 targets el overlay renderizaba **una fila por worktree**, empujando la línea de confirmación/progreso fuera de la pantalla — o sea que aunque hubiera habido spinner, no se veía. `RemoveOverlayView` ahora recibe `maxListRows` (`rows - 16`, calculado en el render junto a `createBoxHeight`/`orchestrateBoxHeight`), corta la lista y cierra con `… and N more`. Las filas además llevan `wrap="truncate-end"`, lo que arregla de paso el wrapping que mezclaba branch + `clean` en la misma línea (visible en el reporte original).
  - **Estado nuevo** `RemoveOverlay.progress: { done, total, current, failed } | null`. Mientras es no-null, `handleOverlayInput` **ignora todo** (mismo guard que `overlay.kind === "create" && overlay.pending`, y colocado **antes** del branch de Esc): git ya está borrando, un Esc no cancelaría nada — sólo ocultaría el progreso.
  - Los `setState` post-loop pasaron a forma funcional (`state` es el closure pre-await; un refresh puede haber aterrizado mientras corría git). `selectedWorktreeIds` se filtra desde `prev`.
  - `RemoveOverlayView` se exportó para testear. 4 tests nuevos en `test/dashboard.test.ts`: contador visible + confirmación ausente durante el batch, `(N failed)` en la línea de progreso, confirmación intacta antes de arrancar, y truncado de la lista con `… and 94 more`. **Ojo con los tests de la TUI que renderizan `<Spinner>`**: el interval de `ink-spinner` mantiene vivo el proceso de `node:test` y la suite cuelga para siempre — hay que llamar `unmount()` del `render` de `ink-testing-library` (el helper `removeFrame` lo hace).
  - No cubierto: el borrado sigue siendo **secuencial** (paralelizarlo con `git worktree remove` concurrentes sobre el mismo repo es riesgoso por el lock del index) y no hay forma de abortar a mitad de camino.

Cambios de la 0.5.29 (worktrees que git olvidó + poda de metadata en `remove`):

- **0.5.29** (`fix(dashboard)`, `feat(worktree)`): dos cosas reportadas juntas sobre el repo target — 8 dirs en `.mintree/worktrees/` que el dashboard no mostraba, y `metadata.json` con **197 entradas** contra 0 worktrees vivos.
  - **Causa de los dirs invisibles** (diagnosticada, no asumida): el repo target se **renombró** (cambió el `<org>/<name>` y con eso su path en disco). Git guarda paths **absolutos en los dos extremos** de un worktree: el `.git` del worktree apunta al admin dir, y el admin dir (`.git/worktrees/<id>/gitdir`) apunta al working tree. El rename rompe ambos; el siguiente `git worktree prune` (que git corre solo dentro de un montón de comandos ordinarios) borra los admin dirs y deja los checkouts completos tirados en disco (~7 MB c/u). Verificado en vivo: `git worktree list` devolvía sólo el checkout principal y los `.git` de los 8 dirs seguían apuntando al path viejo.
  - **Por qué eran invisibles**: `buildWorktreeIndex` (`source/lib/dashboard.ts`) derivaba la lista **sólo** de `git worktree list`. Lo que git no registra no existía para mintree → no aparecían en el tab Worktrees y por lo tanto **no había forma de borrarlos con `d`**. Ahora `scanUnregistered` recorre además el filesystem de `.mintree/worktrees/` y agrega los dirs que git desconoce, marcados `WorktreeInfo.unregistered`. Saltea archivos sueltos (`.DS_Store`) y dirs sin issueId parseable; un worktree registrado siempre gana sobre un dir con el mismo id.
  - **Borrado de un unregistered**: `git worktree remove` los rechaza (`is not a working tree`), así que `runRemoveByPath` detecta el caso (`isRegisteredWorktree`) y hace `fs.rmSync` recursivo. Dos guardas, porque es un `rm -rf` sin red de contención de git: el path **debe** estar bajo `.mintree/worktrees/` (si no, se rechaza), y **exige `force`** — sin admin dir no hay manera de chequear si hay cambios sin commitear. En la UI eso se traduce a que `needsForce = dirty || unregistered`, o sea que un dir huérfano pide `Y` mayúscula aunque parezca limpio. La fila de la lista lleva `(not in git)` en rojo para distinguirlo de un huérfano común (worktree vivo con issue cerrado).
  - **`remove` ahora poda metadata** (revierte la política de la 0.5.25 "clean poda, remove conserva", a pedido del usuario). La entrada se conservaba para poder re-atachar y reanudar la sesión de Claude, pero en la práctica sólo se acumulaba. `pruneMetadataFor` corre en las **tres** variantes de éxito (`removed`, `pruned-orphan`, `removed-unregistered`) de `runRemove` y `runRemoveByPath`; el issueId sale de `issueIdFromWorktreeDirName(basename(worktreePath))`, igual que en `clean`. `RemoveResult.ok` suma `prunedIssueId: string | null`. **Costo aceptado**: re-crear el worktree de ese issue arranca una sesión de Claude nueva, no reanuda la vieja. La branch se sigue preservando.
  - El regex del dirname dejó de estar duplicado inline en `dashboard.ts`: ahora todos pasan por `issueIdFromWorktreeDirName` (`branch.ts`), que queda como single source of truth.
  - Tests: `test/worktreeOrphans.test.ts` (6, contra un repo git real — `strandWorktree` borra el admin dir para reproducir el rename): poda de metadata en `remove`, detección del dir stranded, ignorar `.DS_Store`/dirs sin id, rechazo sin force, borrado con force + poda, y el guard de path fuera de `.mintree/worktrees/`.
  - **Limpieza aplicada al repo target**: verifiqué que los 8 dirs no tenían **nada** sin commitear (reconstruí un index temporal por worktree con `read-tree` + `diff-files` contra el commit base de cada uno: 0 modificados; FE-254/255 idénticos al tip de su branch, ya pusheada) y los borré (59 MB). Las 8 branches quedaron intactas.
  - **No cubierto**: el CLI `mintree worktree remove <branch>` **no** llega a un dir unregistered — resuelve el path vía `worktreeForBranch`, que consulta git. Sólo el dashboard (que pasa por path) los limpia. `mintree worktree list` tampoco los muestra.

Cambios de la 0.5.30 (limpieza previa a abrir el repo):

- **0.5.30** (`chore`): se sacaron del código, los tests y la documentación todos los identificadores del proyecto privado donde mintree se usa, como paso previo a hacer el repo público. Los fixtures pasaron a nombres neutros: workspace `acme`, team keys `FE`/`BE`, branch de Linear `jdoe/fe-68-landing-page`, e ids `FE-68`/`BE-155`/etc. en lugar de los reales. También salieron los paths absolutos del home (`/Users/…`, referencias a santree y al repo) y el mail de trabajo que quedaba citado en el changelog de la 0.5.17.
- Los tests siguen verdes (107/107) y conservan su intención al renombrar los fixtures: p. ej. el caso "una team key no matchea si está embebida en una palabra del slug" quedó como `ofe-68` vs la key `FE`.
- **El historial de git se descartó**: el repo público arranca desde un commit inicial único, porque los nombres viejos vivían en commits ya hechos y limpiar sólo el working tree no los sacaba de `git log`. Se conservó el historial completo en un branch/tag local (`pre-public-history`) por si hace falta consultarlo.

Cambios de la 0.5.31 (CI en GitHub Actions):

- **0.5.31** (`ci`): primer workflow del repo, `.github/workflows/ci.yml`. Corre en **pull_request contra main** y en **push a main**, o sea que cubre tanto el pre-merge como el post-merge. GitHub Actions **no consume minutos** en repos públicos con runners estándar (confirmado contra la doc de billing: *"GitHub Actions usage is free … for public repositories that use standard GitHub-hosted runners"*), así que el costo es cero.
  - Tres jobs: **`test`** (matrix Node 20/22/24 — 20 es el floor que declara `engines.node`), **`lint`** (`eslint source`) y **`dist is up to date`**, que rebuildea y falla si el `dist/` commiteado difiere del `source/`. El tercero existe por [[project-dist-tracked]]: `dist/` está trackeado y es lo que ejecuta el binario instalado, así que un `dist/` viejo publica código roto aunque los tests estén verdes — es un modo de falla que ni los tests ni el lint detectan.
  - `concurrency` cancela runs viejos del **mismo PR** al pushear encima, pero nunca cancela los de `main`. `permissions: contents: read` (el workflow no escribe nada).
  - Actions pinneadas a `actions/checkout@v6` + `actions/setup-node@v6` (hay v7, de julio 2026; v6 es el punto maduro). `cache: npm` + `npm ci` contra el lockfile.
  - **Verificado antes de pushear, no asumido**: la suite completa se corrió en Linux dentro de containers `node:20`, `node:22` y `node:24` (107/107 en las tres), más `npm run lint` y un rebuild de `dist/` byte-idéntico al commiteado. Los tests son offline (git local en tmpdir, `fetch` mockeado en `linear.test.ts`) y setean su propia identidad de git, así que no necesitan nada del runner.
  - **Falta un paso manual**: para que un merge a `main` sea imposible con CI en rojo hay que marcar los jobs como **required** en Settings → Branches. El workflow por sí solo reporta, no bloquea.
  - README: badge de CI en el header + sección *Development* con los comandos y la tabla de jobs.

Cambios de la 0.5.32 (id pelado de Linear como nombre de branch):

- **0.5.32** (`feat(worktree)`): `mintree worktree create <ID>` con el **identificador pelado** (`VAL-920`) ya no crea una branch llamada así. En un repo Linear con teams configurados, mintree le pide a Linear el `branchName` del issue y crea **ése**, informando la sustitución. Motivo: **Linear cierra un issue cuando mergea una branch que lleva su identificador**, independientemente de lo que diga el body del PR (`Part of` no lo frena). Medido sobre una tanda real de 5 worktrees: **4 salieron con el id pelado** porque el prompt del ejecutor decía `mintree worktree create <TICKET>` — es lo que uno tiene a mano al arrancar un ticket. Ya había un incidente documentado de un ticket cerrado solo en 28 segundos sobre un PR que no era su entregable.
  - **No era un bug**: el `--help` documenta las dos formas buenas y mintree hacía exactamente lo pedido. Esto es una red defensiva sobre una consecuencia silenciosa e irreversible.
  - **Medición que definió la opción** (A resolver vs B avisar): `issue(id: "VAL-920"){ branchName }` contra la API real **acepta el identificador humano**, es case-insensitive, tarda ~270ms y un id inexistente vuelve como `Entity not found: Issue` (distinguible de un error de transporte). O sea que (A) es viable — pero necesita API key, así que degrada a (B): si no hay key / no hay red, la branch se crea **tal cual se tipeó** y se avisa. Nunca bloquea.
  - **No se usa `loadSnapshot`**: su query filtra a issues abiertos, asignados a vos, de los teams configurados — justo los ids que se tipean a mano (de otro, cerrados, de otro team) quedarían afuera. `fetchIssueBranchName` (`source/lib/providers/linear.ts`) hace su propio round-trip.
  - **Detección sin regex laxo**: el predicado es `isBareIssueIdBranch` (`source/lib/branch.ts`) — `parsed.branch === parsed.issueId`, o sea que el nombre entero es el identificador ya resuelto contra los `linear.teams[].key` del repo. **Con `teamKeys` vacío el guard se desactiva** (sin teams, `parseLinearBranch` cae a un `<palabra>-<dígitos>` genérico). Medido sobre 7040 branch names reales de ~40 repos locales: el regex laxo `^[A-Za-z][A-Za-z0-9_]*-\d+$` matchea **409 (5.8%)**, incluidos `release_mt-2`, `integration-1`, `old-2`, `prueba-1`, `drp-1` que no son tickets de nada; la regla estricta (whole-name + team key configurada) matchea **0**.
  - **Escape hatch**: flag `--exact` en `worktree create` — conserva el id pelado, saltea el lookup y lo reporta como step `skip` sin banner (quien lo pidió a propósito no merece un reto).
  - **Silencio total** para todo lo demás: branch de convención, `branchName` de Linear, id que resulta no ser un issue (`not-found`), repo sin teams, repo GitHub. Ni request, ni step, ni output.
  - `resolveBareIssueBranch` (`source/lib/worktreeCreate.ts`) corre **antes** de los checks de worktree-ya-existe / dir-ya-existe, para que miren la branch final. `CreateResult.bareIssueBranch` lleva `{ requested, resolvedTo?, reason? }`; `create.tsx` renderiza una nota `dim` cuando se corrigió y un **banner amarillo al final** cuando se conservó el id (mismo tratamiento que el `initFailed` de la 0.5.27, por el mismo motivo: el step queda sepultado mid-scroll).
  - Tests: 15 nuevos en `test/bareIssueBranch.test.ts` — 9 unitarios con lookup inyectado (**cada caso "silencioso" es control positivo: repo Linear con teams, el arg llega al guard, y se asserta que el lookup nunca se llamó**) + 6 end-to-end contra un repo git real con `global.fetch` mockeado, que verifican `git branch --show-current` **dentro del worktree**, no lo que dice el resultado. Verificado además con el CLI real contra la API de Linear en vivo: `create VAL-920` dejó `martinmineo/val-920-…` y ninguna branch `VAL-920`.
  - **No cubierto**: el dashboard no cambia (ya pasa el `branchName` del issue, nunca un id pelado) y `runCreateDetached` tampoco (no crea branch). Tampoco hay renombre de branches ya creadas con el id pelado.

Áreas que NO se atacaron y siguen pendientes para futuro:

- `init --provider linear` interactivo: hoy hay que pasar `--team` repetido o editar `metadata.json`. Lo ideal es que `init` consulte la API y deje elegir equipos.
- Linkback de PR a Linear vía `attachmentLinkURL` / `issueUpdate` post-creación de PR.
- Más cobertura de tests (dashboard/TUI, providers contra la API real).

---

## Plan de implementación original (orden recomendado, ya completado)

### Fase 0: Scaffolding

1. `npm init` con TypeScript, Ink, Pastel, Zod.
2. `tsconfig.json`, `eslint.config.mjs`, `.gitignore` (node_modules, dist, *.log).
3. Estructura `source/cli.tsx` + `source/commands/` (Pastel hace routing automático).
4. `package.json` con `bin: { mintree, mt, mtw, mtn }` (todos apuntan al mismo `dist/cli.js`, los aliases se resuelven en el shell wrapper).
5. `git init`, primer commit con scaffolding.

### Fase 1: Comandos base

1. **`mintree doctor`**: el más simple, sirve para validar el toolchain. Empezar acá para iterar sobre el patrón de comandos Pastel + Ink.
2. **`mintree init`**: crear `.mintree/`, escribir metadata, actualizar `.gitignore`.
3. **`mintree helpers shell-init`**: imprime el shell wrapper. Sin esto los `cd` no funcionan en el shell padre.

### Fase 2: Worktree management (sin TUI todavía)

4. **`mintree worktree create <branch>`** — sin `--work` todavía. Solo crea el worktree.
5. **`mintree worktree list`** — lectura de `git worktree list --porcelain` + enrich con metadata.
6. **`mintree worktree remove <branch>`**.
7. **`mintree worktree clean`**.

### Fase 3: Lanzamiento Claude

8. **Session ID generation + persistencia** en metadata.
9. **`mintree worktree work [--prompt <text>]`** — lanza/reanuda Claude.
10. **`mintree helpers session-signal install`** + los 4 sub-comandos para los hooks.

### Fase 4: TUI

11. **`mintree dashboard`** — fetch issues + lista navegable (single pane).
12. Detail pane con info del issue.
13. Atajos `w` (work flow con overlay tipo + descripción + texto opcional para Claude), `↵` (resume), `o` (browser), `d` (rm).
14. Estado vivo de sesión Claude en cada fila.
15. Refresh automático cada 30s.

### Fase 5: Polish

16. Theme light/dark con detección OSC 11 (santree lo hace, ver `source/lib/dashboard/theme.ts`).
17. Mouse support (click-to-select, scroll wheel, drag para resize panes).
18. Publish a npm.

---

## Referencias

- **Santree (referencia primaria)**: [santiagotoscanini/santree](https://github.com/santiagotoscanini/santree), cloneado localmente. Cuando algo no quede claro, leer cómo lo resolvió santree y adaptar. Archivos clave:
  - `source/cli.tsx` — entry Pastel.
  - `source/commands/doctor.tsx` — patrón de comando Ink + verificaciones del sistema (incluye `checkRemoteControl()`).
  - `source/lib/git.ts` — helpers de git, worktrees, metadata.
  - `source/lib/ai.ts` — `launchAgent`, resolución de Claude binary, manejo de session ID.
  - `source/lib/session-signal.ts` — instalación de hooks.
  - `source/commands/dashboard.tsx` + `source/lib/dashboard/` — TUI.
  - `shell/init.zsh.njk` + `shell/init.bash.njk` — shell wrapper templates.
  - `source/commands/helpers/shell-init.tsx` — cómo se renderiza el wrapper.
- **Repo target**: el repo donde mintree se va a usar. Sus skills (`.claude/skills/`) y convenciones (`docs/conventions/git-workflow.md` o equivalente) son las que mintree tiene que respetar.

---

## Cómo arrancar (próximos pasos para Claude)

1. Ejecutar Fase 0: scaffolding del proyecto Node + TypeScript + Ink + Pastel + Zod.
2. Primer comando: `mintree doctor` (Fase 1).
3. Iterar comando por comando en el orden del plan.

Cuando empieces a implementar, **leé primero el comando equivalente de santree** y entendé qué hace antes de escribir el de mintree. Adaptás, no copiás ciegamente — la convención de branches es distinta, la estructura de directorios es distinta, y el scope es más chico.

<div align="center">

# Token 2b IQ

### Trade measurable token spend for first-pass correctness

**A multi-agent orchestration controller for DSH (DeepSeek Harness).** It picks a tier, creates the shared task board, collects receipts, keeps a token ledger and renders a run panel — while the actual work is still done by the official Agent Teams. In short: a **project manager + ledger + dashboard** on top of the executors.

[![GitHub](https://img.shields.io/badge/GitHub-SSRYLJRSS%2Fdsh--token2biq-181717?logo=github)](https://github.com/SSRYLJRSS/dsh-token2biq)
[![CI](https://github.com/SSRYLJRSS/dsh-token2biq/actions/workflows/ci.yml/badge.svg)](https://github.com/SSRYLJRSS/dsh-token2biq/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-v0.9.1-3B82F6.svg)](https://github.com/SSRYLJRSS/dsh-token2biq/releases)
[![Releases](https://img.shields.io/github/v/release/SSRYLJRSS/dsh-token2biq?display_name=tag&color=3B82F6)](https://github.com/SSRYLJRSS/dsh-token2biq/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-3B82F6.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.3%20%3C0.3.0-10B981.svg)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.md) · **English**

</div>

---

## What's new in v0.9

- **AI task profiling (P0):** before starting, the model classifies task type (code vs research), complexity and risk, then picks the pipeline — no more keyword-only misclassification.
- **Size-aware trimming (P0/P2):** within your chosen tier, only *genuinely simple* tasks get stages trimmed; medium / complex / high-risk always run the full tier.
- **Cautious downgrade (this release):** downgrades only for simple work and never drop verification — code keeps review + tests, research keeps citation / fact checks. Each downgrade is reported in `start().rigor`; pass `strictRigor:true` to force the full tier.
- **Type-aware evidence (P1):** under `strict`, investigation tasks pass with citations, code tasks with real `testsRun`.
- **Classification cache + shorter prompts (P1/P2):** no duplicate profiling calls; ~5% shorter teammate prompt.

| Situation | Pipeline |
| --- | --- |
| High tier + medium / complex / high-risk | Full tier, nothing trimmed |
| High tier + genuinely simple | Cautious one-step downgrade, verification kept |
| Unsure | Prefer the higher standard |

## What it solves

DSH Agent Teams already answers "can multiple agents collaborate?" (`subagent`, `team_task_create`, `send_message`, `wait_agent`). In practice multi-agent work still gets stuck on three other things:

| Without an orchestration layer | What Token 2b IQ adds |
| --- | --- |
| How many agents, which stages, how many review rounds — guesswork | **S1–S4 / Auto tiers** turn "how many roles and stages" into a coarse knob |
| The doer is also the judge — approving its own work | Staged pipeline + **independent blind review / cross-vendor review** (enforceable) |
| No clear picture of tokens spent, progress, or why it failed | Per-stage **receipts + token ledger + run panel**, exportable as Markdown |
| Complex work gets "one-shot" delivered with no verification gate | Optional `pipelineGate=strict` (or `auto`): no acceptance criteria → no implementation; no **proven** `testsRun` → no delivery |
| Research/audit tasks get forced through a code pipeline (no artefact to "generate") | `taskType=investigation` runs **research → synth → review → verify**, with **no `generate`** |

> ⚠️ **Honest disclaimer**: in a small A/B (3 self-contained tasks), the strict pipeline did **not** improve correctness (both arms were already 100%) — it only added review overhead, with zero rework. So `pipelineGate` defaults to `off`. Keep it off for small tasks; its value only shows up on hard tasks where the generator actually makes mistakes.

## Layers: brain vs hands

Token 2b IQ is **not** another agent runtime. It sits on top of the official Agent Teams:

| | Official Agent Teams | Token 2b IQ |
| --- | --- | --- |
| Role | **Hands**: real parallelism / division / messaging | **Brain**: how much, who reviews, how much it costs, pass or not |
| Provides | Spawn teammates, shared-task DAG, messages, waiting | Tier plans, team playbook, receipt validation, token ledger, panel |
| Relation | Execution primitives | Policy layer + ledger; never re-implements the runtime |

## Install

### 1) Desktop plugin market (recommended)

Open **DeepSeek Harness Desktop → Settings → Plugins**, search `dsh-token2biq`, and click Install. **Fully quit and restart DSH** afterwards.

> The market installs from the registry's GitHub source. The package has zero runtime dependencies and no build scripts; on load it provisions the Agent Teams and subagent model-selection host settings.

### 2) `dsh plugin` CLI (GitHub source, recommended)

```sh
dsh plugin --profile desktop add github:SSRYLJRSS/dsh-token2biq
```

> Same source the market uses. Replace `desktop` with your profile name (e.g. `web`). If your network can only reach GitHub Releases, use the prebuilt tarball in option 3.
>
> If you hit `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, run `$env:NODE_OPTIONS='--use-system-ca'` in PowerShell, then retry; the local Node trust store is rejecting the GitHub certificate chain, not the plugin.

### 3) Prebuilt tarball (optional)

```sh
# Latest (recommended; same source as the market, always points to the newest release)
dsh plugin --profile desktop add https://github.com/SSRYLJRSS/dsh-token2biq/releases/latest/download/dsh-token2biq.tgz
# Need a pinned version? use the GitHub source: dsh plugin --profile desktop add github:SSRYLJRSS/dsh-token2biq#v0.9.1
```

> Zero dependencies, no install scripts, so no `allowBuilds` approval. If you hit `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, Node does not trust the GitHub Release certificate chain: use option 2, or set `NODE_OPTIONS=--use-system-ca` before launching DSH.

### 4) Local source link (development/troubleshooting only)

```sh
git clone https://github.com/SSRYLJRSS/dsh-token2biq.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-token2biq
```

> `link:` creates a directory junction at `node_modules/dsh-token2biq` in the profile. **Remove it before switching back to a market/cloud install**, otherwise pnpm fails during import with `ERR_PNPM_EPERM ... rename ... dsh-token2biq_tmp_... -> dsh-token2biq` and the install appears to hang forever.

Windows — remove the stale junction (link only; the source checkout is untouched):

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-token2biq"
if (Test-Path $p) { (Get-Item $p -Force).Delete() }
```

macOS / Linux:

```sh
rm -f ~/.dsh/profiles/desktop/node_modules/dsh-token2biq
```

### Version & compatibility

- Package version: `0.9.1`
- DSH compatibility: `>=0.2.2-rc.3 <0.3.0-0`, declared in both `engines.dsh` and `dsh.compatibility.dsh`
- The market and host read `engines.dsh`, so there is no "version undeclared / compatibility unknown" state

> Host-side JS is loaded at startup — **a full DSH restart is required** after install/upgrade. Client changes require rebuilt host client artifacts and a page refresh. Development HMR additionally requires `pnpm run dev:web` running from the same checkout; saving source alone does not update the running GUI.

## Quick start

1. Pick a tier from the **IQ** dropdown above the composer: `Off · Auto · S1 · S2 · S3 · S4`. This is a real session-level switch — `Off` makes the server reject `start`; a fixed tier is locked for the session and persisted.
2. Let the model call `token2biq action=start { goal, mode? }`. As a Team Lead it creates the shared task board (`roster / created / modelRouting`). The Lead must still start teammates with official `subagent` and dispatch work with `send_message`; ready tasks do not start agents.
3. Execute per roster, call `token2biq action=record` after each stage (with `teamTaskId` / `owner` / receipt), and `token2biq action=finish` at the end.

## Tiers

| Tier | Max agents | Stages | Relative cost |
| --- | ---: | --- | ---: |
| **S1** | 1 | generate → verify (2 stages, 1 agent) | ×2 |
| **S2** | 3 | plan → generate → review → verify (4 stages) | ×5 |
| **S3** | 5 | core 5: research → plan → generate → review → regression; high risk adds judge / redteam (7 stages total) | ×10 |
| **S4** | 8 | full 7: research → plan → generate → review → judge → redteam → regression, with two-way parallel review (two independent models blind-review the generate output; any FAIL fails the stage) | ×16 |

> **Since 0.7.0: research/document tasks use a different pipeline.** With `taskType=investigation` (or `auto` resolving to it), stages become **research → synth → review → verify / regression** — there is no `generate`; `synth` (role `synthesizer`) produces the report/document, and its receipt is validated like any worker receipt (`files` + `diffSummary`). S1 collapses to research→synth→verify and S3/S4 add judge/redteam. This removes the deadlock where an investigation task could never satisfy a code pipeline that demands an implementation artefact.
| **Auto** | — | keyword screen → low-effort model check → fallback to keywords | — |

> S3's judge / redteam are **high-risk add-ons**: they run only when `start` passes `risk: "high"` (or `strict`); `regression` is a core stage and always runs, so normal tasks run the core 5 stages. S4's "two-way review" runs the same `review` stage with two independent models in parallel blind review (any FAIL fails the stage); other stages are not parallelized.

## Thinking effort (reasoning)

When a stage calls a model, you choose not only *which* model but *how hard it thinks*. The default is **auto**: no explicit level; it is derived from a "tier × role" matrix.

- **Default auto matrix** (`settings.reasoning.default = "auto"`): resolves per tier and role (`MODE_ROLE_EFFORT`):

| Tier | research | plan | generate | review | judge | redteam | verify | regression | default |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | — | — | high | high | — | — | high | — | high |
| S2 | — | high | high | high | — | — | high | — | high |
| S3 | high | high | high | high | xhigh | high | high | high | high |
| S4 | high | xhigh | high | xhigh | xhigh | xhigh | high | high | high |

- **Per-role override**: `settings.reasoning.byRole[<role>]` — one of `off / minimal / low / medium / high / xhigh / max`.
- **Per-model override**: `settings.reasoning.byModel["provider::model"]`.
- **Precedence**: per-model > per-role > global default `auto` (matrix). Configure in the panel's **Settings → Thinking effort** page or the `reasoning` field of `token2biq action=settings`.
- **Reasoning capability**: resolution reads `reasoning.supportedEfforts` first (legacy `reasoning.efforts` as fallback) plus `reasoning.defaultEffort`. Legacy models with only `defaultEffort` (no selectable levels) cause the plugin to **omit** `reasoning_effort` and call normally (no error; the panel shows "only default <level>"); if the preferred level is not offered, it **steps down** along `off → minimal → low → medium → high → xhigh → max` to the nearest available, then the model default.

## Configuration (what is enforced vs. advisory)

Settings live in `~/.dsh/token2biq/settings.json`. Hard-enforced on `record`: `forceTeam` (S2/S3/S4 require `teamTaskId`+`owner`), `allowModels`, `independentReview` (owner ≠ generator), and `pipelineGate=strict`. Per-role `rolePools` are **advisory**; `roleModels` is a read-only derived field and is never persisted — `rolePools` are written into the playbook, executed by the Lead via `subagent(provider/model)`.

## Design limits (please read before installing)

1. A tier is **a strong prompt + hard receipt gates, not a kernel-level interceptor** of every tool call.
2. Model-routed stages must be executed by the Lead with `subagent`; `subagent` can carry an explicit LLM provider/model.
3. `pipelineGate` defaults to `off` (see the A/B note above).
4. "Real token" is process-wide (host `llm/stream` usage carries no `runId`), so it can be higher than one run's true cost.
5. `generate` is serial by default (shared cwd, no file lock); parallel tasks need disjoint `writeScopes`.
6. HTTP routes are gated by the official `ctx.connection.requestRejection` (untrusted Host/Origin → 403, unauthenticated → 401), with `application/json` body parsing and a 1 MB `readJson` cap; access control is delegated to the host's `requestRejection` (the plugin keeps no separate Origin allowlist).

---

## Install & active-profile resolution

- **Market TLS**: the market installs from GitHub; `UNABLE_TO_VERIFY_LEAF_SIGNATURE` means local Node distrusts GitHub's chain — run `$env:NODE_OPTIONS='--use-system-ca'` (PowerShell) before install/launch.
- **Junction cleanup**: a `link:` install creates a directory junction at the profile's `node_modules/dsh-token2biq`; remove it before switching back to a market/cloud install, or pnpm fails with `ERR_PNPM_EPERM ... rename`.
- **Active profile (priority)**: explicit `profile` → `provisionProfile` setting → `DSH_PROFILE` env → reverse-derived from the plugin path `profiles/<name>/node_modules` → enumerate `~/.dsh/profiles/*` (only a unique hit). With several profiles and no reliable source it writes nothing and `action=provision` returns `ok:false` + `candidates` — it never silently writes `desktop`.
- **`provisionStatus`**: the latest auto-provision result (`ok/changed/patchFile/profileTargeted/candidates/error`) is visible via `action=state`; a startup failure is `console.warn`ed and recorded there without blocking DSH.
- **`action=provision`**: manual re-run (idempotent), returns `profileTargeted / patchFile / candidates / added / merged / unchanged / skipped`.

## Automatic host setup (no manual ticking)

On load the plugin provisions two DSH host settings. The first load writes the profile; they take effect after a **DSH restart** (restart once more if the host does not hot-reload):

> Verified on DSH 0.2.2-rc.3 with the Desktop profile: both entries are written; an existing entry with the same id is left untouched.

| Written automatically | Location | Effect |
| --- | --- | --- |
| `- id: agent-team` → `defaultEnabled: true` | `~/.dsh/profiles/<profile>/cordis.patch.yml` | New root sessions start with official Agent Teams enabled (existing choices win) |
| `- id: subagent-model-selection-settings` → `enabled: true` + current models pre-checked | same file | Subagents may use different models; available models are pre-filled from `settings.yaml` |

Safety: never edits `~/.dsh/settings.yaml`; only appends these two entries; if an id already exists it is **left untouched** (reported as skipped); when no models are found it writes the Team entry only (no empty `allowedModels`); backs up to `cordis.patch.yml.bak-token2biq-<ts>`, writes atomically, verifies, and rolls back on failure; idempotent.

Disable with `autoProvision: false`, re-run with `token2biq action=provision`, restore by copying the `.bak-token2biq-*` file back.

---

## Docs & releases

| Document | Contents |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | Release notes (currently **0.9.1**) |
| [Install & upgrade guide](docs/INSTALL.md) | Market/CLI/source install, junction cleanup, version declaration, rollback |
| [0.6 optimization notes](docs/OPTIMIZATION-0.6.md) | 0.6.0 tier rebalance, thinking effort, prompt slimming |
| [Architecture](docs/ARCHITECTURE.md) | Execution model, module responsibilities, maintenance boundaries |
| [Verification](docs/VERIFICATION.md) | Test entry points, verified scope, measured results |
| [Audit report](docs/AUDIT-2026-11-16.md) | Review and fix acceptance record |
| [GitHub Releases](https://github.com/SSRYLJRSS/dsh-token2biq/releases) | Release notes and version distribution (`v0.9.1`) |

---

## Develop & test

```sh
npm run check
npm test
npm pack --dry-run
```

Use the isolated `npm test` entry point. See [verification](https://github.com/SSRYLJRSS/dsh-token2biq/blob/main/docs/VERIFICATION.md), [architecture](https://github.com/SSRYLJRSS/dsh-token2biq/blob/main/docs/ARCHITECTURE.md), and the [audit report](https://github.com/SSRYLJRSS/dsh-token2biq/blob/main/docs/AUDIT-2026-11-16.md) for measured results and remaining limits.

Repository layout:

```
lib/
├── index.js        Host entry: web routes + token2biq tool
├── host-integration.js Official Agent Teams adapter: live root session, isEnabled/setEnabled/rootOf only, real reasons
├── autoprovision.js Post-install host setup: appends agent-team.defaultEnabled and the subagent model allowlist (backup/atomic/verify/rollback, idempotent)
├── service.js      Core service: tiers/plan/receipts/ledger/panel/dispatch
├── orchestrator.js Pure: tier PLANS / classify / playbook / roster
├── receipts.js     Pure: per-stage receipt validation
├── stage-state.js  Pure: aggregate stage state by slot, teamTaskId then owner, any FAIL wins, retries self-heal
├── run-store.js    8-entity persistence (atomic JSON writes; in-memory capable)
├── report.js       Pure: Markdown report export
├── settings.js     Settings storage and normalization
├── model-routes.js Subagent model allow policy
├── paths.js        State file paths
└── client.js       Browser panel
```

---

## License

MIT · see [LICENSE](LICENSE)

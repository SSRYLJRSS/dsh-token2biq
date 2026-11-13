<div align="center">

# Token 2b IQ

### Trade measurable token spend for first-pass correctness

**A multi-agent orchestration controller for DSH (DeepSeek Harness).** It picks a tier, spins up the team, collects receipts, keeps a token ledger and renders a run panel — while the actual work is still done by the official Agent Teams. In short: a **project manager + ledger + dashboard** on top of the executors.

[![GitHub](https://img.shields.io/badge/GitHub-SSRYLJRSS%2Fdsh--token2biq-181717?logo=github)](https://github.com/SSRYLJRSS/dsh-token2biq)
[![License: MIT](https://img.shields.io/badge/License-MIT-3B82F6.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1%20%3C0.3.0-10B981.svg)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.md) · **English**

</div>

---

## What it solves

DSH Agent Teams already answers "can multiple agents collaborate?" (`spawn_teammate`, `team_task_create`, `send_message`, `wait_agent`). In practice multi-agent work still gets stuck on three other things:

| Without an orchestration layer | What Token 2b IQ adds |
| --- | --- |
| How many agents, which stages, how many review rounds — guesswork | **S1–S4 / Auto tiers** turn "how many roles and stages" into a coarse knob |
| The doer is also the judge — approving its own work | Staged pipeline + **independent blind review / cross-vendor review** (enforceable) |
| No clear picture of tokens spent, progress, or why it failed | Per-stage **receipts + token ledger + run panel**, exportable as Markdown |
| Complex work gets "one-shot" delivered with no verification gate | Optional `pipelineGate=strict`: no acceptance criteria → no implementation; no `testsRun` → no delivery |

> ⚠️ **Honest disclaimer**: in a small A/B (3 self-contained tasks), the strict pipeline did **not** improve correctness (both arms were already 100%) — it only added review overhead, with zero rework. So `pipelineGate` defaults to `off`. Keep it off for small tasks; its value only shows up on hard tasks where the generator actually makes mistakes.

## Layers: brain vs hands

Token 2b IQ is **not** another agent runtime. It sits on top of the official Agent Teams:

| | Official Agent Teams | Token 2b IQ |
| --- | --- | --- |
| Role | **Hands**: real parallelism / division / messaging | **Brain**: how much, who reviews, how much it costs, pass or not |
| Provides | Spawn teammates, shared-task DAG, messages, waiting | Tier plans, team playbook, receipt validation, token ledger, panel |
| Relation | Execution primitives | Policy layer + ledger; never re-implements the runtime |

## Install

```sh
# From GitHub source (no build step; this repo is the plugin)
dsh plugin --profile web add github:SSRYLJRSS/dsh-token2biq

# Or local link (development)
dsh plugin --profile desktop add link:./dsh-token2biq
```

> Replace `web` with your profile name (e.g. `desktop`). Host-side JS is loaded at startup — **a full DSH restart is required** after install/upgrade. Only `lib/client.js` (the panel) hot-reloads with a page refresh.

## Quick start

1. Pick a tier from the **IQ** dropdown above the composer: `Off · Auto · S1 · S2 · S3 · S4`. This is a real session-level switch — `Off` makes the server reject `start`; a fixed tier is locked for the session and persisted.
2. Let the model call `token2biq action=start { goal, mode? }`. As a Team Lead it creates the shared task board and teammates for you (`roster / created / modelRouting`).
3. Execute per roster, call `token2biq action=record` after each stage (with `teamTaskId` / `owner` / receipt), and `token2biq action=finish` at the end.

## Tiers

| Tier | Max agents | Stages | Review rounds | Relative cost |
| --- | ---: | --- | ---: | ---: |
| **S1** | 1 | generate → review → verify | 1 | ×2 |
| **S2** | 3 | plan → generate → review → verify | 3 | ×5 |
| **S3** | 6 | research → plan → generate → review → judge → redteam → regression | 3 | ×10 |
| **S4** | 8 | same as S3, plus multi-candidate parallel review/judge/redteam | 3 | ×16 |
| **Auto** | — | keyword screen → low-effort model check → fallback to keywords | — | — |

## Configuration (what is enforced vs. advisory)

Settings live in `~/.dsh/token2biq/settings.json`. Hard-enforced on `record`: `forceTeam` (S2/S3/S4 require `teamTaskId`+`owner`), `allowModels`, `requireDifferentVendor`, `independentReview` (owner ≠ generator), and `pipelineGate=strict`. Per-role `rolePools`/`roleModels` are **advisory** — written into the playbook, executed by the Lead via `subagent(provider/model)`.

## Design limits (please read before installing)

1. A tier is **a strong prompt + hard receipt gates, not a kernel-level interceptor** of every tool call.
2. Model-routed stages must be executed by the Lead with `subagent`; `spawn_teammate` cannot carry an LLM provider/model.
3. `pipelineGate` defaults to `off` (see the A/B note above).
4. "Real token" is process-wide (host `llm/stream` usage carries no `runId`), so it can be higher than one run's true cost.
5. `generate` is serial by default (shared cwd, no file lock); parallel tasks need disjoint `writeScopes`.
6. HTTP routes listen on `127.0.0.1` only and do not add CSRF/Origin checks (limited risk).

## Develop & test

```sh
node --check lib/index.js lib/service.js lib/orchestrator.js
node --test    # 126/126 passing (logic + service integration + smoke)
```

## License

MIT · see [LICENSE](LICENSE)

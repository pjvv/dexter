# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & Commands

Dexter is a Bun-first TypeScript project. Use `bun` for everything — Node/npm are not the supported path.

- Install: `bun install` (runs `playwright install chromium` via `postinstall` — expect a slow first install)
- Run CLI: `bun start` (= `bun run src/index.tsx`)
- Watch mode: `bun dev`
- Type-check: `bun run typecheck` (`tsc --noEmit`)
- Tests: `bun test` — tests use the `bun:test` runtime (`import { describe, test, expect } from 'bun:test'`). A legacy `jest.config.js` exists but `bun test` is primary. CI only runs `typecheck` + `bun test`.
- Single test file: `bun test src/gateway/access-control.test.ts`
- Single test by name: `bun test --test-name-pattern "updates the active agent config"`
- Evals: `bun run src/evals/run.ts` or `bun run src/evals/run.ts --sample 10` (LangSmith-backed LLM-as-judge; needs `LANGSMITH_*` env vars to log results)
- WhatsApp gateway: `bun run gateway:login` (QR link), then `bun run gateway` (both shell out to `tsx`, not `bun`, because Baileys has ESM quirks)
- Release: `bash scripts/release.sh [YYYY.M.D]` — bumps `package.json`, tags `vYYYY.M.D`, pushes tag, creates GH release via `gh`. Do not run without explicit user confirmation.

## High-Level Architecture

Dexter is a terminal-native financial research agent: a LangChain tool-calling loop wrapped in a custom TUI, with provider-agnostic LLM routing, a persistent memory subsystem, and an optional WhatsApp gateway. The pieces that require reading several files to understand:

### Agent loop (`src/agent/`)
`Agent` (in `agent.ts`) is the core. It runs an iterative tool-calling loop (default max 10 iterations) that:
1. Builds a system prompt by composing **compact tool descriptions**, discovered skill metadata, memory section, channel profile, optional `SOUL.md` identity, and optional user `RULES.md`.
2. Streams LLM responses with a blocking fallback, yielding typed `AgentEvent`s (`thinking`, `tool_start`, `tool_end`, `answer_start`, `compaction`, `microcompact`, `context_cleared`, `memory_recalled`, `done`, etc.) for real-time UI updates.
3. Runs **two tiers of context pressure relief**: per-turn `microcompact` (prunes bulky tool results from prior turns while preserving reasoning), and threshold-based full `compact` that summarizes older history when token usage crosses provider-specific caps.
4. Executes tools via `AgentToolExecutor` which respects a **concurrency map** — read-only tools run in parallel; write/approval tools are serialized.
5. Persists oversized tool results to disk (`utils/tool-result-storage.ts`) and rewrites them to a short "persisted to file" stub so the model uses `read_file` to page through large data.

The `Scratchpad` is an append-only JSONL log at `.dexter/scratchpad/*.jsonl`. It captures `init`, `tool_result`, and `thinking` entries for every query and is the debugging ground truth. It is not the context window — full messages live in an `InMemoryChatHistory`.

### Provider routing (`src/providers.ts` + `src/model/llm.ts`)
`src/providers.ts` is the **single source of truth** for LLM providers — id, display name, model prefix, env var, fast-model variant, and context window. Adding a provider means one entry there; routing, config UI, fast-model selection, and compaction thresholds all derive from it. `resolveProvider(modelName)` does prefix matching (`claude-` → Anthropic, `gemini-` → Google, `grok-` → xAI, `kimi-` → Moonshot, `deepseek-` → DeepSeek, `openrouter:` → OpenRouter, `ollama:` → Ollama, else OpenAI). Default model is `gpt-5.4`. Anthropic gets explicit `cache_control` on the system prompt for prompt-cache cost savings.

### Tool registry (`src/tools/registry.ts`)
Tools are declared as `RegisteredTool` objects carrying both a long `description` (injected into the system prompt) and a `compactDescription` (used for token-optimized prompts), plus a `concurrencySafe` flag. Key behavior:
- `web_search` is **conditional** on env vars, with priority `EXASEARCH_API_KEY` → `PERPLEXITY_API_KEY` → `TAVILY_API_KEY`. Only one is registered.
- `x_search` only registers when `X_BEARER_TOKEN` is set.
- The `skill` tool only registers when at least one `SKILL.md` is discovered.
- `get_financials` / `get_market_data` are deliberately coarse — the system prompt instructs the LLM to pass the **full natural language query once** instead of splitting into per-ticker calls.
- There is no `stock_screener` (Yahoo Finance has no equivalent). The LLM must use `get_financials` + its own reasoning for screens.

### Finance data backend (`src/tools/finance/providers/yahoo.ts`)
All finance tools route through a single Yahoo Finance adapter. The adapter reshapes `yahoo-finance2` responses into the FinancialDatasets.ai-flavoured payloads the formatters already expect (`income_statements`, `balance_sheets`, `snapshot`, etc.), so formatters and the inner-LLM routers didn't change. Notes:
- Yahoo's `quote*` methods have narrowing issues in TypeScript; the adapter uses `as unknown as Rec` casts to avoid `never` inference.
- **Fundamentals bypass the yahoo-finance2 wrapper.** Yahoo's `quoteSummary` financial modules (`incomeStatementHistory`, etc.) have been gutted since Nov 2024 — most line items return zeros. And `yahooFinance.fundamentalsTimeSeries()` only accepts bare period types (`"annual"`/`"quarterly"`/`"trailing"`) and returns a tiny auto-selected field set. The adapter therefore fetches `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}?type=<comma-joined-prefixed-fields>&period1=…&period2=…` directly and collapses the per-field arrays into per-period rows.
- `fetchHistoricalKeyRatios` derives margins/growth from income statements rather than a dedicated metrics endpoint — it is an approximation, not a parity swap.
- SEC filing **section text** is not extracted — `get_10K_filing_items` / `get_10Q_filing_items` / `get_8K_filing_items` now return a pointer payload instructing the agent to use `web_fetch` on the SEC URL. `read_filings` still orchestrates, but its inner workflow ends with `web_fetch`, not direct item extraction.
- No `FINANCIAL_DATASETS_API_KEY` is read anywhere in the code. `src/tools/finance/api.ts` has been deleted.

### Skills (`src/skills/`)
A skill is a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`) and a markdown body. Discovery order: `src/skills/*` (builtin) then `.dexter/skills/*` (project override by name). The registry caches metadata; the `skill` tool loads the full body on invocation. Built-in: `dcf`, `x-research`. Each skill is allowed at most one invocation per query.

### Memory (`src/memory/`)
Hybrid retrieval over Markdown files in `.dexter/memory/` (long-term `MEMORY.md` + daily `YYYY-MM-DD.md`) **and** indexed session transcripts. A SQLite index stores chunks with embeddings; queries combine vector similarity, full-text score, temporal decay, and MMR diversification. Embedding provider priority: OpenAI → Gemini → Ollama; the DB clears embeddings automatically when the provider fingerprint changes. The LLM interacts via the `memory_search` / `memory_get` / `memory_update` tools — never via raw `read_file`/`write_file` on memory paths.

### CLI (`src/cli.ts`, `src/components/`, `src/controllers/`)
The UI is **not React/Ink** despite what older docs say — it uses `@mariozechner/pi-tui` (`Container`, `ProcessTerminal`, `TUI`, etc.) with plain-TypeScript component and controller classes. Entry is `src/index.tsx` → `runCli()`. Controllers (`AgentRunnerController`, `ModelSelectionController`, `InputHistoryController`) own state; components render. Slash commands are declared in `src/commands/`. If you hit `jsx` in a `.tsx` file, it's configured for `react-jsx` purely to satisfy `@babel/preset-env` — don't introduce React.

### Gateway (`src/gateway/`)
The WhatsApp bridge is a separate process driven via Baileys. Multi-account, with per-account auth dirs under `.dexter/credentials/whatsapp/<accountId>/`. `allowFrom`/DM/group policies live in `gatewayConfig` (see `src/gateway/config.ts`); inbound messages route through `routing/` → `agent-runner.ts` which spins up an `Agent` with the `whatsapp` channel profile (different behavior/format bullets from the CLI profile — see `src/agent/channels.ts`). See `src/gateway/channels/whatsapp/README.md` for setup details.

### Cron (`src/cron/`)
Scheduled agent runs (`every`, `at`, `cron` expressions with optional `ActiveHours` gating). Invoked from the `cron` tool so the agent itself can create/list/update/delete jobs. Backed by `store.ts` (JSON on disk) and executed by `executor.ts` / `runner.ts`.

## Conventions & Gotchas

- **ESM-only**. Intra-package imports must carry the `.js` suffix even when the source is `.ts` (e.g., `import { Agent } from './agent.js'`). The `@/*` path alias → `./src/*` is defined in `tsconfig.json` for `@/...` imports.
- **Strict TypeScript**. Avoid `any`; use `unknown` + narrowing. Favor small focused files and extract helpers.
- **Don't add logging or docs unless asked.** Per `AGENTS.md`, log calls and new README files should not be introduced speculatively.
- **Zod validates tool input boundaries.** Follow the pattern already in `src/tools/*` when adding tools.
- **`.dexter/` is the runtime root** — `settings.json`, `memory/`, `scratchpad/`, `credentials/`, user overrides (`SOUL.md`, `RULES.md`), user `skills/`. All gitignored.
- **AGENTS.md** in the repo root documents additional project guidelines (structure, coding style, LLM providers, testing, versioning). Treat it as authoritative when it conflicts with external assumptions. One known drift: it calls the CLI library "Ink (React for CLI)" — the actual implementation uses `@mariozechner/pi-tui`.
- **SOUL.md** (repo root, or `.dexter/SOUL.md` to override) defines Dexter's identity/voice and is concatenated into the system prompt. Changing it changes tone across every session.
- **Version format is CalVer `YYYY.M.D`** with no zero-padding; tag prefix is `v`. Never push a release without user confirmation.
- **Two lockfiles exist** (`bun.lock` and `package-lock.json`). `bun.lock` is authoritative; do not regenerate `package-lock.json`.

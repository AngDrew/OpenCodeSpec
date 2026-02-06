# OpenSpec (Fission-AI/OpenSpec) - Functionality Notes

This document captures the important user-facing and internal functionalities of OpenSpec, based on reading the upstream repository `github.com/Fission-AI/OpenSpec` (tag/version observed: `1.1.1`).

OpenSpec is a Node.js CLI and a set of tool-specific "skills" + slash commands that implement a spec-driven development workflow for AI coding assistants. The current flagship workflow is called **OPSX**.

## What OpenSpec Produces In A Project

After `openspec init`, OpenSpec expects and manages a project-local `openspec/` directory with two primary data planes:

- Source-of-truth specs: `openspec/specs/<capability>/spec.md`
- Work-in-progress changes: `openspec/changes/<change-name>/...`

The documented structure is:

```
openspec/
├── specs/              # current behavior, organized by capability/domain
│   └── <capability>/
│       └── spec.md
├── changes/            # proposed changes, one folder per change
│   ├── <change-name>/
│   │   ├── proposal.md
│   │   ├── design.md
│   │   ├── tasks.md
│   │   ├── .openspec.yaml
│   │   └── specs/      # delta specs (per capability)
│   │       └── <capability>/
│   │           └── spec.md
│   └── archive/        # completed changes moved here
│       └── YYYY-MM-DD-<change-name>/...
└── config.yaml         # optional project defaults/context/rules
```

Sources:
- `docs/getting-started.md`
- `docs/concepts.md`

## Core Concepts

### Specs vs Changes

- `openspec/specs/` is the *current* system behavior ("source of truth").
- `openspec/changes/` contains *proposals* to modify that behavior, bundled with planning artifacts.

Archiving a change merges its delta specs into `openspec/specs/` and moves the change into `openspec/changes/archive/` for audit/history.

Sources:
- `docs/concepts.md`
- `src/core/archive.ts`
- `src/core/specs-apply.ts`

### Artifacts

In the default schema (`spec-driven`), a change typically accumulates:

- `proposal.md`: why + what changes + capability mapping
- `specs/**/spec.md`: delta specs (what requirements change)
- `design.md`: how to implement (technical design)
- `tasks.md`: trackable implementation checklist (checkboxes)

Sources:
- `docs/getting-started.md`
- `docs/concepts.md`
- `schemas/spec-driven/schema.yaml`

### Delta Specs (ADDED/MODIFIED/REMOVED/RENAMED)

Delta specs describe *what is changing* rather than re-stating the entire spec.

OpenSpec recognizes top-level delta sections:

- `## ADDED Requirements`
- `## MODIFIED Requirements`
- `## REMOVED Requirements`
- `## RENAMED Requirements`

Requirements are blocks headed by:

- `### Requirement: <name>`

Scenarios are headed by:

- `#### Scenario: <name>`

The built-in schema instructions explicitly warn that scenario heading level matters ("must be exactly `####`").

Sources:
- `docs/getting-started.md`
- `schemas/spec-driven/schema.yaml`
- `src/core/parsers/requirement-blocks.ts`

## OPSX Workflow (AI Slash Commands)

OpenSpec generates tool-specific slash commands that drive an "actions, not phases" workflow.

The canonical command set:

- `/opsx:explore`: explore / think through requirements before starting
- `/opsx:new`: create a new change directory and metadata
- `/opsx:continue`: create the next artifact in dependency order
- `/opsx:ff`: create all planning artifacts in dependency order ("fast-forward")
- `/opsx:apply`: implement tasks (AI writes code, checks off tasks)
- `/opsx:verify`: check implementation vs artifacts (completeness/correctness/coherence)
- `/opsx:sync`: apply delta specs to main specs without archiving (optional)
- `/opsx:archive`: finalize the change; merge specs; move to archive
- `/opsx:bulk-archive`: archive multiple changes
- `/opsx:onboard`: guided first-run walkthrough

Sources:
- `docs/commands.md`
- `docs/workflows.md`
- `docs/opsx.md`
- `src/core/templates/skill-templates.ts` (skill + command templates)

### Tool-specific command syntax (colon vs hyphen)

Some tools use different slash command syntax. OpenSpec includes a transformer that rewrites `/opsx:<cmd>` references to `/opsx-<cmd>` (hyphen) for tools that need it.

- Implementation: `src/utils/command-references.ts` exports `transformToHyphenCommands()`
- Example: OpenCode adapter writes `.opencode/command/opsx-<id>.md` and applies the transform.

Sources:
- `src/utils/command-references.ts`
- `src/core/command-generation/adapters/opencode.ts`
- `CHANGELOG.md` (notes about OpenCode hyphen format)

## CLI (Terminal) Functionality

OpenSpec's binary is `openspec` (`bin/openspec.js`). The CLI is built with `commander`.

### Main CLI commands

The CLI complements the AI slash commands. High-level categories (from docs):

- Setup: `openspec init`, `openspec update`
- Browsing: `openspec list`, `openspec view`, `openspec show`
- Validation: `openspec validate`
- Lifecycle: `openspec archive`
- Workflow helpers: `openspec status`, `openspec instructions`, `openspec templates`, `openspec schemas`
- Schema management: `openspec schema init|fork|validate|which`
- Config: `openspec config ...`
- Utility: `openspec feedback`, `openspec completion ...`

Sources:
- `docs/cli.md`
- `src/cli/index.ts`
- `package.json` (bin + scripts)

### Agent-friendly JSON mode

Several commands support `--json` output to be programmatically consumed by an AI agent (e.g., `list`, `show`, `validate`, `status`, `instructions`, `templates`, `schemas`).

Sources:
- `docs/cli.md`
- `src/commands/show.ts`
- `src/commands/validate.ts`
- `src/commands/workflow/status.ts`
- `src/commands/workflow/instructions.ts`
- `src/commands/workflow/templates.ts`
- `src/commands/workflow/schemas.ts`

## Schema System (Custom Workflows)

OpenSpec's OPSX workflow is schema-driven.

### What a schema is

A schema is a YAML file that defines:

- artifact IDs and dependencies (`requires`)
- what files each artifact generates (`generates`) to detect completion
- an instruction string and a template file for each artifact
- optional apply-phase metadata

Schema validation checks:

- YAML shape via Zod
- duplicate artifact IDs
- dependency references are valid
- dependency graph has no cycles

Sources:
- `src/core/artifact-graph/types.ts` (Zod schema)
- `src/core/artifact-graph/schema.ts` (load/parse + validation)
- `src/core/artifact-graph/graph.ts` (topological order, ready/blocked)
- `schemas/spec-driven/schema.yaml` (built-in schema)

### Schema resolution order (where schemas are found)

OpenSpec can resolve schemas from multiple locations:

- built-in package schema directory
- per-user override schema directory
- per-project schema directory (`openspec/schemas/<name>/`)

There are CLI commands to inspect and manage schema resolution:

- `openspec schemas` (list available schemas)
- `openspec templates --schema <name>` (show resolved template paths)
- `openspec schema which <name>` (show resolution source and shadowing)
- `openspec schema fork <source> <dest>` (copy a schema into project)
- `openspec schema validate [name]` (validate schema structure)

Sources:
- `src/core/artifact-graph/resolver.ts`
- `src/commands/schema.ts`
- `docs/customization.md`

## Artifact Graph + Status/Instructions

OpenSpec uses an artifact dependency graph to compute:

- build order (topological sort)
- "ready" artifacts (all dependencies complete)
- blocked artifacts + unmet dependencies

Completion is derived from the filesystem by checking whether each artifact's `generates` path exists; supports both direct paths and glob patterns.

Sources:
- `src/core/artifact-graph/graph.ts` (`getBuildOrder`, `getNextArtifacts`, `getBlocked`)
- `src/core/artifact-graph/state.ts` (`detectCompleted`, glob detection)

### Instruction generation with context/rules/template injection

Artifact instruction generation is enriched by injecting:

1. `<context>` from project config
2. `<rules>` for that artifact ID
3. `<template>` content from the schema template file

This allows teams to tune prompts without modifying TypeScript.

Sources:
- `src/core/artifact-graph/instruction-loader.ts` (`generateInstructions`, `loadChangeContext`)
- `src/core/project-config.ts` (config schema + validation)
- `docs/opsx.md`

## Change Metadata

Each change can include `.openspec.yaml` with at least:

- `schema: <schema-name>`
- optional `created: YYYY-MM-DD`

Schema selection precedence:

1. explicit CLI flag
2. `.openspec.yaml`
3. `openspec/config.yaml`
4. default `spec-driven`

Sources:
- `src/utils/change-metadata.ts`
- `src/core/artifact-graph/instruction-loader.ts` (schema resolution for change)
- `docs/opsx.md`

## Spec Sync / Archive / Delta Merge Logic

OpenSpec implements delta merging at the requirement-block level.

### Parsing delta operations

Delta spec parsing (`parseDeltaSpec`) extracts:

- requirement blocks for ADDED/MODIFIED (full blocks)
- requirement names for REMOVED
- FROM/TO pairs for RENAMED

Sources:
- `src/core/parsers/requirement-blocks.ts` (`parseDeltaSpec`, helpers)

### Applying deltas

Core merging entrypoints:

- `applySpecs(projectRoot, changeName, options)` applies delta specs into `openspec/specs/` without archiving (dry-run supported).
- `ArchiveCommand.execute(...)` applies specs (unless `--skip-specs`) and then moves the change into the archive directory.

Key behaviors from `buildUpdatedSpec(...)` and related logic:

- Operation order is: `RENAMED` -> `REMOVED` -> `MODIFIED` -> `ADDED`.
- Pre-validations detect duplicates inside sections and cross-section conflicts.
- When the target spec does not exist, OpenSpec creates a skeleton spec and restricts which operations are allowed (e.g., MODIFIED/RENAMED not allowed on a new spec).
- Updated specs can be validated before writing via `Validator.validateSpecContent(...)`.

Sources:
- `src/core/specs-apply.ts` (`findSpecUpdates`, `buildUpdatedSpec`, `applySpecs`)
- `src/core/archive.ts`

### Task-progress awareness

Archive checks `tasks.md` progress and warns/prompts if tasks are incomplete.

Sources:
- `src/utils/task-progress.ts`
- `src/core/archive.ts`

## Validation

Validation is implemented via a `Validator` that uses:

- a Markdown parser to extract sections/requirements/scenarios
- Zod schemas for `Spec` and `Change`
- additional custom rules and enriched error messages

Notable validations:

- Spec files must have `## Purpose` and `## Requirements` sections.
- Delta spec validation for changes (`validateChangeDeltaSpecs`) enforces the presence and consistency of delta operations and requirement/scenario expectations.

Sources:
- `src/core/parsers/markdown-parser.ts`
- `src/core/parsers/change-parser.ts`
- `src/core/validation/validator.ts`
- `src/core/validation/constants.ts`

## Tool Integrations (Skills + Commands)

OpenSpec supports many assistants/editors by generating:

- skill files (agent instructions)
- slash command binding files (tool-specific)

### Supported tools list

Tool support is enumerated in code as `AI_TOOLS` with a `skillsDir` per tool.

Sources:
- `docs/supported-tools.md`
- `src/core/config.ts` (AI_TOOLS)

### Skill templates

Skill templates are centralized and exported from `src/core/templates/skill-templates.ts`. Examples include:

- `openspec-explore`
- `openspec-new-change`
- `openspec-continue-change`
- `openspec-ff-change`
- `openspec-apply-change`
- `openspec-verify-change`
- `openspec-sync-specs`
- `openspec-archive-change`
- `openspec-bulk-archive-change`
- `openspec-onboard`

Sources:
- `src/core/templates/skill-templates.ts`
- `src/core/shared/skill-generation.ts` (`getSkillTemplates`, `generateSkillContent`)

### Command adapter pattern

Slash commands are generated from tool-agnostic `CommandContent` and formatted by adapters.

Example:

- OpenCode adapter writes `.opencode/command/opsx-<id>.md` with YAML frontmatter.

Sources:
- `src/core/command-generation/generator.ts`
- `src/core/command-generation/types.ts`
- `src/core/command-generation/adapters/*.ts`
- `src/core/command-generation/adapters/opencode.ts`

### Version detection for skills

OpenSpec inspects generated skill files to see which OpenSpec version generated them and whether they need updating.

Sources:
- `src/core/shared/tool-detection.ts` (`extractGeneratedByVersion`, `getToolVersionStatus`, etc.)
- `src/core/update.ts`

## Shell Completions

OpenSpec includes a completions system that:

- has a command registry describing commands/flags
- can generate completion scripts for multiple shells (zsh, bash, fish, PowerShell)
- provides dynamic completions for change/spec IDs with caching to reduce filesystem load

Sources:
- `src/core/completions/command-registry.ts`
- `src/core/completions/completion-provider.ts`
- `src/core/completions/generators/*`
- `src/core/completions/installers/*`

## Configuration

### Project config (`openspec/config.yaml`)

Project config supports:

- `schema`: default schema name
- `context`: free-form text injected into every artifact prompt
- `rules`: per-artifact bullet rules injected only for that artifact

Rules are validated against the artifact IDs present in the selected schema.

Sources:
- `docs/customization.md`
- `docs/opsx.md`
- `src/core/project-config.ts`

### Global config

There are two global-ish configuration stores in the upstream repo:

- Telemetry state stored at `~/.config/openspec/config.json` (anonymousId, noticeSeen).
- A separate global config module for feature flags (XDG-aware paths).

Sources:
- `src/telemetry/config.ts`
- `src/core/global-config.ts`

## Telemetry

Telemetry is implemented via PostHog and is designed to be privacy-preserving:

- tracks only command name and version
- does not track arguments, paths, or content
- respects opt-out env vars (`OPENSPEC_TELEMETRY=0`, `DO_NOT_TRACK=1`)
- disables itself in CI

CLI hooks invoke telemetry tracking on each command.

Sources:
- `src/telemetry/index.ts`
- `src/cli/index.ts` (preAction/postAction hooks)
- `README.md` (telemetry description)

## Migration / Legacy Cleanup

OpenSpec includes documentation and code paths to migrate from older/legacy layouts to OPSX.

- `docs/migration-guide.md` describes what changes and how `init`/`update` clean up or regenerate files.
- The implementation includes a legacy detection/cleanup module invoked from setup flows.

Sources:
- `docs/migration-guide.md`
- `src/core/legacy-cleanup.ts`
- `src/core/init.ts`
- `src/core/update.ts`

## Practical Notes / Gotchas

- Node version requirement: `>=20.19.0` (`package.json`).
- Tasks must use checkbox syntax `- [ ]` / `- [x]` for progress tracking (`src/utils/task-progress.ts` and schema instructions).
- Delta merge is strict about requirement header matching and disallows conflicting ops (e.g. same requirement in ADDED and MODIFIED).
- Spec parsing expects consistent heading structure; missing `Purpose`/`Requirements` blocks validation.

Sources:
- `package.json`
- `schemas/spec-driven/schema.yaml`
- `src/core/specs-apply.ts`
- `src/core/parsers/markdown-parser.ts`
- `src/core/validation/validator.ts`

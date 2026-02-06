Now I have a comprehensive understanding of the OpenCode architecture. Let me provide you with a detailed summary.

---

## OpenCode Codebase Architecture Summary

### Overview

OpenCode is an **AI-powered software development workflow system** that uses a structured artifact-driven approach to manage code changes. It consists of:

1. **VS Code Extension** (`src/extension.ts`) - Minimal entry point
2. **OpenCode Configuration** (`.opencode/` directory) - Contains commands, skills, and configuration
3. **OpenSpec System** (`openspec/` directory) - Manages changes, specs, and artifacts
4. **Plugin SDK** (`@opencode-ai/plugin` and `@opencode-ai/sdk`) - Core API infrastructure

---

### 1. Command Structure

**Location**: `.opencode/command/`

Commands are markdown files with YAML frontmatter defining slash commands:

| Command File | Command | Purpose |
|-------------|---------|---------|
| `opsx-new.md` | `/opsx-new` | Start a new change with step-by-step artifact creation |
| `opsx-ff.md` | `/opsx-ff` | Fast-forward: create all artifacts at once |
| `opsx-continue.md` | `/opsx-continue` | Continue working on an existing change |
| `opsx-apply.md` | `/opsx-apply` | Implement tasks from a change |
| `opsx-verify.md` | `/opsx-verify` | Verify implementation matches artifacts |
| `opsx-archive.md` | `/opsx-archive` | Archive a completed change |
| `opsx-bulk-archive.md` | `/opsx-bulk-archive` | Archive multiple changes at once |
| `opsx-sync.md` | `/opsx-sync` | Sync delta specs to main specs |
| `opsx-explore.md` | `/opsx-explore` | Enter explore mode (thinking/problem-solving) |
| `opsx-onboard.md` | `/opsx-onboard` | Guided onboarding tutorial |

**Command Format**:
```yaml
---
description: Brief description of what the command does
---
```

**Key Features**:
- Commands use the `openspec` CLI for workflow management
- Support for `--json` output for programmatic parsing
- Integration with `AskUserQuestion` tool for interactive prompts
- Todo tracking via `TodoWrite` tool

---

### 2. Main Features and Tools

#### A. Change Management System
- **Changes** are stored in `openspec/changes/<name>/`
- Each change contains artifacts based on a schema
- Changes can be archived to `openspec/changes/archive/YYYY-MM-DD-<name>/`

#### B. Artifact Types (Spec-Driven Schema)
1. **proposal.md** - Why and what the change is about
2. **specs/<capability>/spec.md** - Detailed requirements with WHEN/THEN/AND scenarios
3. **design.md** - Technical decisions and architecture
4. **tasks.md** - Implementation checklist

#### C. Workflow Commands
- **openspec CLI** commands:
  - `openspec new change "<name>"` - Create new change
  - `openspec status --change "<name>" --json` - Check artifact status
  - `openspec instructions <artifact> --change "<name>" --json` - Get artifact template
  - `openspec list --json` - List active changes
  - `openspec archive "<name>"` - Archive a change

#### D. Verification System
Three-dimensional verification:
- **Completeness**: Task completion, spec coverage
- **Correctness**: Requirement mapping, scenario coverage
- **Coherence**: Design adherence, pattern consistency

---

### 3. Agent System

**Location**: `.opencode/opencode.jsonc`

The agent system supports multiple specialized agents:

```jsonc
{
  "agent": {
    "build": {        // For implementation tasks
      "model": "kimi-for-coding/k2p5"
    },
    "plan": {         // For planning and architecture
      "model": "proxy/gpt-5.2-high",
      "permission": {
        "edit": "deny",
        "bash": "ask"
      }
    },
    "explore": {      // For thinking/exploration (read-only)
      "model": "proxy/gemini-3-flash-preview",
      "permission": {
        "edit": "deny"
      }
    },
    "general": {      // Default agent (disabled in config)
      "model": "proxy/gpt-5.2-medium",
      "disable": true
    }
  }
}
```

**Agent Capabilities**:
- Different models for different tasks
- Permission controls (edit, bash)
- Tool access (file read/write, bash, grep, etc.)

---

### 4. Configuration System

**Main Config**: `.opencode/opencode.jsonc`
- JSON with comments support
- Schema validation via `$schema`
- Agent configuration with per-agent settings
- Model selection and permissions

**OpenSpec Config**: `openspec/config.yaml`
```yaml
schema: spec-driven  # Default workflow schema
context: |           # Project context (optional)
  Tech stack, conventions, etc.
rules:               # Per-artifact rules (optional)
  proposal:
    - Keep proposals under 500 words
  tasks:
    - Break tasks into chunks of max 2 hours
```

**VS Code Extension Config**: `package.json`
- Standard VS Code extension manifest
- Commands contributed via `contributes.commands`
- Activation events and dependencies

---

### 5. Skill System

**Location**: `.opencode/skills/`

Skills are self-contained workflow definitions:

**Structure**:
```
.opencode/skills/<skill-name>/
└── SKILL.md
```

**Skill Format** (YAML frontmatter + markdown):
```yaml
---
name: openspec-new-change
description: What this skill does
license: MIT
compatibility: Requires openspec CLI
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.1.1"
---
```

**Available Skills**:
- `openspec-new-change` - Start new change
- `openspec-apply-change` - Implement tasks
- `openspec-continue-change` - Continue artifact creation
- `openspec-archive-change` - Archive change
- `openspec-bulk-archive-change` - Batch archive
- `openspec-verify-change` - Verify implementation
- `openspec-sync-specs` - Sync specs to main
- `openspec-ff-change` - Fast-forward artifact creation
- `openspec-explore` - Explore mode
- `openspec-onboard` - Onboarding tutorial

**Skill Loading**:
- Skills are loaded from `.opencode/skills/` directory
- Each skill has a `SKILL.md` file with instructions
- Skills can be invoked via the `skill` tool (as shown in available_skills)
- Metadata includes compatibility and version information

---

### 6. Plugin SDK Architecture

**Location**: `.opencode/node_modules/@opencode-ai/`

#### SDK (`@opencode-ai/sdk`)
Provides server and client capabilities:

**Server API**:
```typescript
export type ServerOptions = {
    hostname?: string;
    port?: number;
    signal?: AbortSignal;
    timeout?: number;
    config?: Config;
};

export declare function createOpencodeServer(options?: ServerOptions): Promise<{
    url: string;
    close(): void;
}>;

export declare function createOpencodeTui(options?: TuiOptions): {
    close(): void;
};
```

**Client API**:
```typescript
export declare function createOpencode(options?: ServerOptions): Promise<{
    client: OpencodeClient;
    server: { url: string; close(): void; };
}>;
```

#### Plugin System (`@opencode-ai/plugin`)
Hook-based plugin architecture:

**Plugin Interface**:
```typescript
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    serverUrl: URL;
    $: BunShell;  // Bun shell for command execution
};

export type Plugin = (input: PluginInput) => Promise<Hooks>;
```

**Available Hooks**:
- `event` - Handle events
- `config` - Modify configuration
- `tool` - Register custom tools
- `auth` - Authentication providers
- `chat.message` - Message processing
- `chat.params` - LLM parameter modification
- `chat.headers` - Header modification
- `permission.ask` - Permission handling
- `command.execute.before` - Command interception
- `tool.execute.before/after` - Tool execution hooks
- `experimental.chat.messages.transform` - Message transformation
- `experimental.chat.system.transform` - System prompt transformation
- `experimental.session.compacting` - Session management
- `experimental.text.complete` - Text completion

---

### Key Components Exposable via API

1. **Change Management API**
   - Create, read, update, archive changes
   - List active/archived changes
   - Get change status and artifacts

2. **Artifact Management API**
   - Create artifacts (proposal, specs, design, tasks)
   - Get artifact templates and instructions
   - Validate artifact completion

3. **Spec Management API**
   - Sync delta specs to main specs
   - Conflict resolution
   - Requirement tracking

4. **Verification API**
   - Completeness checking (tasks, specs)
   - Correctness validation (implementation vs spec)
   - Coherence analysis (design adherence)

5. **Agent API**
   - Multi-agent configuration
   - Model selection
   - Permission management

6. **Skill API**
   - Skill discovery and loading
   - Skill execution
   - Skill metadata access

7. **Plugin API**
   - Hook registration
   - Tool registration
   - Event handling
   - Authentication providers

8. **Workflow API**
   - Schema management
   - Workflow execution
   - Status tracking

---

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     OpenCode System                          │
├──────────────────────────────────────────────────────────────┤
│  VS Code Extension (src/extension.ts)                        │
│  └─ Minimal entry point, activates OpenCode                  │
├──────────────────────────────────────────────────────────────┤
│  .opencode/                                                  │
│  ├─ opencode.jsonc        # Agent & model config             │
│  ├─ command/              # Slash command definitions        │
│  │  ├─ opsx-new.md                                           │
│  │  ├─ opsx-apply.md                                         │
│  │  └─ ... (10 commands)                                     │
│  └─ skills/               # Skill definitions                │
│     ├─ openspec-new-change/SKILL.md                          │
│     ├─ openspec-apply-change/SKILL.md                        │
│     └─ ... (10 skills)                                       │
├──────────────────────────────────────────────────────────────┤
│  openspec/                                                   │
│  ├─ config.yaml           # Workflow schema config           │
│  ├─ changes/              # Active changes                   │
│  │  └─ <name>/                                               │
│  │     ├─ proposal.md                                        │
│  │     ├─ specs/<cap>/spec.md                                │
│  │     ├─ design.md                                          │
│  │     ├─ tasks.md                                           │
│  │     └─ .openspec.yaml                                     │
│  └─ specs/                # Main specifications              │
├──────────────────────────────────────────────────────────────┤
│  @opencode-ai/plugin & sdk  # Core infrastructure            │
│  └─ Hooks, tools, auth, client/server APIs                   │
└──────────────────────────────────────────────────────────────┘
```

This architecture provides a robust, extensible system for AI-assisted software development with clear separation of concerns between configuration, workflow management, and execution.

---

## Addendum: Context Window Usage Counting

When OpenCode displays "context window usage" (in its web app + TUI), it uses the
token usage reported on the last assistant message and computes:

`total = input + output + reasoning + cache.read + cache.write`

Then it renders usage as a percentage of the model context limit
(`model.limit.context`).

This matters if you implement a context indicator: using only `tokens.input`
will undercount versus upstream.

Details and file references are captured in:

- `research/opencode-context-window-counting.md`

# AI Chat Assistant - Implementation Plan

## Overview
Build a GitHub Copilot-like chat interface that uses OpenCode as the backend via its `serve` command and REST API. This leverages OpenCode's powerful multi-agent system, MCP support, and rich tool ecosystem while providing a modern web-based UI.

## Research Summary

### From `research/opencode-serve-doc.md`

**OpenCode Serve Command**:
- Starts HTTP server exposing OpenCode's functionality via REST API
- Default: hostname `127.0.0.1`, port `4096`
- 60+ REST endpoints across categories:
  - **Session**: Create, delete, send prompts, get messages
  - **Files**: List, read, git status
  - **Find**: Text search (ripgrep), file search, LSP symbols
  - **MCP**: Full Model Context Protocol support
  - **Tools**: List available tools with schemas
  - **Config**: Global and project configuration
  - **Events**: Server-Sent Events for real-time updates

**SDK Usage Patterns**:
```javascript
// Pattern 1: Full Server + Client
import { createOpencode } from '@opencode-ai/sdk/v2';
const { client, server } = await createOpencode({ port: 4096 });

// Pattern 2: Connect to existing server
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4096' });
```

**Key API Endpoints for Chat App**:
- `POST /session` - Create chat session
- `POST /session/{id}/prompt` - Send message (streaming)
- `GET /session/{id}/messages` - Get history
- `GET /file/list` - Browse files
- `GET /file/read` - View file content
- `GET /find/text` - Search code
- `GET /app/agents` - List configured agents
- `GET /global/event` - SSE stream

### From `research/opencode-architecture.md`

**OpenCode Agent System** (configured in `.opencode/opencode.jsonc`):
```jsonc
{
  "agent": {
    "build": {        // Implementation tasks
      "model": "kimi-for-coding/k2p5"
    },
    "plan": {         // Planning and architecture
      "model": "proxy/gpt-5.2-high",
      "permission": { "edit": "deny", "bash": "ask" }
    },
    "explore": {      // Research (read-only)
      "model": "proxy/gemini-3-flash-preview",
      "permission": { "edit": "deny" }
    }
  }
}
```

**Skill System**: 10+ built-in skills in `.opencode/skills/`:
- `openspec-new-change` - Start new change
- `openspec-apply-change` - Implement tasks
- `openspec-explore` - Explore mode
- `openspec-verify-change` - Verify implementation

**Plugin SDK** (`@opencode-ai/plugin`):
- Hook-based architecture
- Hooks: `chat.message`, `tool.execute`, `permission.ask`, etc.
- Custom tool registration

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AI Chat Assistant System                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  FRONTEND              API LAYER                BACKEND                 │
│  ┌──────────┐      ┌──────────────┐       ┌────────────────┐           │
│  │ Next.js  │◄────►│  API Proxy   │◄─────►│ OpenCode Serve │           │
│  │ React App│ HTTP │  (Optional)  │ HTTP  │  (Port 4096)   │           │
│  └──────────┘      └──────────────┘       └────────────────┘           │
│       │                                           │                     │
│       ▼                                           ▼                     │
│  ┌──────────┐                              ┌──────────────┐            │
│  │  Agent   │                              │Native Agents │            │
│  │  Router  │                              │- build       │            │
│  │(Layer 2) │                              │- plan        │            │
│  └──────────┘                              │- explore     │            │
│                                            └──────────────┘            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Multi-Agent Architecture

### Layer 1: OpenCode Native Agents
Pre-configured agents from user's `opencode.jsonc`:

| Agent | Purpose | Model | Permissions |
|-------|---------|-------|-------------|
| `build` | Implementation, coding | kimi-for-coding/k2p5 | Full access |
| `plan` | Architecture, planning | proxy/gpt-5.2-high | Read-only + ask |
| `explore` | Research, exploration | proxy/gemini-3-flash-preview | Read-only |

### Layer 2: Chat Orchestrator (Frontend)
- Analyzes user query intent
- Routes to appropriate agent
- Manages conversation context
- Handles agent switching mid-conversation

### Layer 3: UI Agent (Frontend)
- Renders streaming responses
- Visualizes tool calls
- Manages file previews
- Handles UI state

## Technology Stack

### Frontend
| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript 5+ |
| Styling | Tailwind CSS 3.4+ |
| UI Library | shadcn/ui |
| State Management | Zustand |
| Data Fetching | TanStack Query |
| Icons | Lucide React |
| Code Highlight | PrismJS / Shiki |

### Backend Integration
| Component | Technology |
|-----------|------------|
| Server | OpenCode CLI (`opencode serve`) |
| SDK | `@opencode-ai/sdk` v2 |
| Protocol | REST API + Server-Sent Events |
| Default Port | 4096 |

## Project Structure

```
ai-chat-assistant/
├── apps/
│   └── web/                         # Next.js frontend
│       ├── src/
│       │   ├── app/                 # App router
│       │   │   ├── page.tsx         # Main chat page
│       │   │   ├── layout.tsx       # Root layout
│       │   │   └── globals.css      # Global styles
│       │   │
│       │   ├── components/          # React components
│       │   │   ├── chat/            # Chat UI components
│       │   │   │   ├── ChatPanel.tsx       # Main chat panel
│       │   │   │   ├── MessageList.tsx     # Message rendering
│       │   │   │   ├── MessageInput.tsx    # Input with send
│       │   │   │   ├── CodeBlock.tsx       # Syntax highlighted code
│       │   │   │   ├── ToolCall.tsx        # Tool execution UI
│       │   │   │   └── AgentSelector.tsx   # Agent dropdown
│       │   │   │
│       │   │   ├── tools/           # Tool visualization
│       │   │   │   ├── FileTree.tsx        # File browser
│       │   │   │   ├── FilePreview.tsx     # File content view
│       │   │   │   ├── DiffViewer.tsx      # Code diff
│       │   │   │   └── SearchResults.tsx   # Search results
│       │   │   │
│       │   │   └── ui/              # shadcn/ui components
│       │   │
│       │   ├── hooks/               # Custom hooks
│       │   │   ├── useOpencode.ts   # OpenCode client hook
│       │   │   ├── useSession.ts    # Session management
│       │   │   ├── useStreaming.ts  # SSE streaming
│       │   │   └── useAgents.ts     # Agent operations
│       │   │
│       │   ├── lib/                 # Utilities
│       │   │   ├── api.ts           # OpenCode API client
│       │   │   ├── agents.ts        # Agent orchestration
│       │   │   └── utils.ts         # Helpers
│       │   │
│       │   ├── stores/              # Zustand stores
│       │   │   ├── chatStore.ts     # Chat state
│       │   │   ├── sessionStore.ts  # Session state
│       │   │   └── agentStore.ts    # Agent state
│       │   │
│       │   └── types/               # TypeScript types
│       │       ├── opencode.ts      # OpenCode API types
│       │       └── chat.ts          # Chat app types
│       │
│       ├── package.json
│       ├── tailwind.config.ts
│       └── next.config.js
│
├── packages/
│   └── opencode-sdk/                # SDK wrapper (optional)
│       ├── src/
│       │   ├── client.ts
│       │   └── types.ts
│       └── package.json
│
├── package.json                     # Root monorepo config
├── turbo.json                       # Turborepo config
└── plan.md                          # This file
```

## Key Features

### 1. Chat Interface (Copilot-Style)
- **Floating chat panel** that can be toggled with keyboard shortcut
- **Streaming responses** via Server-Sent Events
- **Syntax highlighting** for code blocks (multiple languages)
- **Message threading** with conversation history
- **Inline code suggestions** similar to Copilot
- **Keyboard shortcuts**: Cmd+K to open, Esc to close

### 2. Multi-Agent Support
- **Agent selector dropdown** in chat header showing all configured agents
- **Automatic agent routing** based on query intent detection
- **Per-agent configuration** loaded from user's `opencode.jsonc`
- **Agent-specific context** preservation across messages
- **Visual indicators** showing which agent is responding

### 3. Tool Visualization
- **File operations**: Show file tree browser, file previews, diffs
- **Search results**: Display ripgrep results with context
- **Command execution**: Terminal output rendered in chat
- **Tool call indicators**: Visual feedback when tools are invoked
- **LSP integration**: Symbol search and go-to-definition

### 4. File Integration
- **File tree browser** in side panel
- **File preview** on hover or click
- **Diff viewer** for code changes with syntax highlighting
- **Quick navigation** to referenced files
- **File search** with ripgrep integration

### 5. MCP Support
- **Connect MCP servers** via settings UI
- **Tool discovery** from connected MCP servers
- **OAuth flows** for remote MCP authentication
- **MCP server management**: Add, remove, enable/disable

## API Integration Details

### Core OpenCode Endpoints

```typescript
// Session Management
POST   /session                      // Create new session
GET    /session/{id}                 // Get session details
DELETE /session/{id}                 // Delete session
POST   /session/{id}/prompt          // Send message (streaming)
POST   /session/{id}/prompt-async    // Async message
GET    /session/{id}/messages        // Get message history

// File Operations
GET    /file/list?path={path}        // List directory contents
GET    /file/read?path={path}        // Read file content
GET    /file/status                  // Get git status

// Search
GET    /find/text?q={query}          // Ripgrep search
GET    /find/files?pattern={pat}     // File pattern search
GET    /find/symbols?q={query}       // LSP symbol search

// Tools & Agents
GET    /tool/list                    // List available tools with schemas
GET    /tool/ids                     // Tool identifiers
GET    /app/agents                   // List configured agents
GET    /app/skills                   // List available skills

// Configuration
GET    /global/config                // Get global configuration
GET    /config                       // Get project configuration
PUT    /config                       // Update configuration

// Real-time Events
GET    /global/event                 // Server-Sent Events stream
```

### SSE Event Handling

OpenCode streams events via SSE at `GET /global/event`:
- `message` - New message content (streaming tokens)
- `tool_call` - Tool execution started
- `tool_result` - Tool execution completed
- `error` - Error occurred
- `done` - Response complete

## Data Flow

### Sending a Message

```
1. User types message and presses Enter
   ↓
2. Frontend Agent Router analyzes intent
   ↓
3. Select appropriate agent (build/plan/explore)
   ↓
4. POST /session/{id}/prompt with agent parameter
   ↓
5. OpenCode processes with selected agent
   ↓
6. SSE stream returns tokens and tool calls
   ↓
7. Frontend renders streaming response
   ↓
8. Tool calls trigger UI updates (file tree, previews)
```

### Tool Execution Flow

```
1. Agent decides to use tool
   ↓
2. OpenCode executes tool via tool system
   ↓
3. Tool result returned to agent
   ↓
4. Frontend visualizes tool call in chat
   ↓
5. Agent continues with tool result
   ↓
6. Final response streamed to user
```

## Configuration

### OpenCode Config (User's Existing Config)

The app reads from user's existing OpenCode configuration:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "build": {
      "model": "kimi-for-coding/k2p5",
      "permission": {
        "edit": "allow",
        "bash": "allow"
      }
    },
    "plan": {
      "model": "proxy/gpt-5.2-high",
      "permission": {
        "edit": "deny",
        "bash": "ask"
      }
    },
    "explore": {
      "model": "proxy/gemini-3-flash-preview",
      "permission": {
        "edit": "deny"
      }
    }
  },
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["node", "server.js"],
      "enabled": true
    }
  }
}
```

### Chat App Config

```typescript
// apps/web/src/config/chat.config.ts
export const config = {
  opencode: {
    baseUrl: process.env.NEXT_PUBLIC_OPENCODE_URL || 'http://127.0.0.1:4096',
    defaultAgent: 'build',
    reconnectAttempts: 3,
    reconnectDelay: 1000,
  },
  ui: {
    streaming: true,
    showToolCalls: true,
    codeHighlightTheme: 'github-dark',
    maxMessageHistory: 100,
  },
  shortcuts: {
    toggleChat: 'cmd+k',
    closeChat: 'esc',
    newSession: 'cmd+n',
  }
};
```

## Implementation Phases

### Phase 1: Foundation
- [ ] Set up monorepo with Turborepo
- [ ] Initialize Next.js project with shadcn/ui
- [ ] Configure TypeScript, Tailwind, ESLint
- [ ] Create OpenCode API client wrapper
- [ ] Test connection to OpenCode server
- [ ] Set up Zustand stores

### Phase 2: Core Chat UI
- [ ] Build ChatPanel component with toggle
- [ ] Implement MessageList with streaming support
- [ ] Create MessageInput with submit handling
- [ ] Add SSE streaming hook (`useStreaming`)
- [ ] Implement basic session management
- [ ] Add keyboard shortcuts (Cmd+K, Esc)

### Phase 3: Agents Integration
- [ ] Fetch agents from `/app/agents`
- [ ] Build AgentSelector dropdown component
- [ ] Implement agent routing logic
- [ ] Add agent context to messages
- [ ] Show agent indicator in messages

### Phase 4: Tool Visualization
- [ ] Create ToolCall component for tool execution
- [ ] Build FileTree component for file browsing
- [ ] Implement FilePreview panel
- [ ] Add DiffViewer for code changes
- [ ] Create SearchResults component
- [ ] Visualize different tool types

### Phase 5: Advanced Features
- [ ] Implement file search with `/find/text`
- [ ] Add symbol search integration
- [ ] Build MCP server management UI
- [ ] Add settings/configuration panel
- [ ] Implement conversation export

### Phase 6: Polish & Optimization
- [ ] Add error handling and retry logic
- [ ] Implement loading states and skeletons
- [ ] Add toast notifications
- [ ] Optimize re-renders with React.memo
- [ ] Add accessibility features
- [ ] Mobile responsive design

## Development Workflow

### Prerequisites
- Node.js 18+
- OpenCode CLI installed globally (`npm install -g opencode`)
- User's OpenCode configuration at `~/.config/opencode/opencode.jsonc`

### Running Locally

```bash
# Terminal 1: Start OpenCode server
opencode serve --port=4096

# Terminal 2: Start chat app
cd ai-chat-assistant/apps/web
npm install
npm run dev

# Access at http://localhost:3000
```

### Environment Variables

```env
# apps/web/.env.local
NEXT_PUBLIC_OPENCODE_URL=http://127.0.0.1:4096
NEXT_PUBLIC_OPENCODE_PROJECT_PATH=/path/to/project
```

## Security Considerations

1. **Local Only**: By default, OpenCode binds to localhost (127.0.0.1)
2. **CORS**: Configure allowed origins in development
3. **File Access**: Respects OpenCode's permission system from config
4. **Command Execution**: Commands run in user's environment with their permissions
5. **Optional Proxy**: Can add API proxy layer for additional security/auth

## Benefits

1. **Minimal Backend Code**: Leverages OpenCode's robust server (60+ endpoints)
2. **Feature Complete**: Access to all OpenCode tools, agents, and MCP
3. **User Configuration**: Uses existing `opencode.jsonc` - no duplicate config
4. **Multi-Agent**: Built-in agent system with no additional work
5. **Extensible**: MCP support for custom tools and integrations
6. **Familiar UI**: Copilot-like interface users already know
7. **Streaming**: Real-time responses via Server-Sent Events
8. **Type Safe**: Full TypeScript support with SDK types

## Open Questions

1. **UI Location**: Standalone web app, VS Code webview, or both?
2. **Authentication**: Local-only or remote access support?
3. **Feature Priority**: Which OpenCode features to expose first?
4. **Multi-Project**: Support multiple projects simultaneously?

---

## Next Steps

1. Review and approve this plan
2. Answer open questions above
3. Begin Phase 1: Foundation implementation
4. Set up project structure and dependencies
5. Implement OpenCode API client
6. Build core chat UI components

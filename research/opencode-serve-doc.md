Based on my comprehensive search of the OpenCode codebase, here are my detailed findings:

---

## OpenCode `serve` Command - Detailed Analysis

### 1. What is the `opencode serve` Command?

The `opencode serve` command is the **core server component** of the OpenCode CLI. Based on the SDK implementation found at:

**`D:\projects\js\OpenCodeSpec\.opencode\node_modules\@opencode-ai\sdk\dist\v2\server.js`**

The serve command:
- Starts an HTTP server that exposes OpenCode's functionality via REST API
- Default configuration: hostname `127.0.0.1`, port `4096`
- Accepts command-line arguments:
  - `--hostname=<host>` - Server hostname (default: 127.0.0.1)
  - `--port=<port>` - Server port (default: 4096)
  - `--log-level=<level>` - Logging level

When the server starts successfully, it outputs: `opencode server listening on <url>`

---

### 2. APIs Exposed by the Server

The OpenCode server exposes a comprehensive REST API with the following major categories (found in `D:\projects\js\OpenCodeSpec\.opencode\node_modules\@opencode-ai\sdk\dist\v2\gen\sdk.gen.d.ts`):

#### **Core API Endpoints:**

| Category | Endpoints | Description |
|----------|-----------|-------------|
| **Global** | `GET /health` | Server health check |
| | `GET /global/event` | Server-sent events subscription |
| | `POST /global/dispose` | Dispose all instances |
| | `GET /global/config` | Get global configuration |
| | `PUT /global/config` | Update global configuration |
| **Project** | `GET /project` | List all projects |
| | `GET /project/current` | Get current project |
| | `PUT /project/{projectID}` | Update project settings |
| **Session** | `GET /session` | List sessions |
| | `POST /session` | Create new session |
| | `GET /session/{sessionID}` | Get session details |
| | `DELETE /session/{sessionID}` | Delete session |
| | `POST /session/{sessionID}/prompt` | Send message to AI |
| | `POST /session/{sessionID}/prompt-async` | Send async message |
| | `POST /session/{sessionID}/command` | Execute command |
| | `POST /session/{sessionID}/shell` | Run shell command |
| | `GET /session/{sessionID}/messages` | Get session messages |
| **Files** | `GET /file/list` | List files |
| | `GET /file/read` | Read file content |
| | `GET /file/status` | Get git status |
| **Find** | `GET /find/text` | Search text (ripgrep) |
| | `GET /find/files` | Search files |
| | `GET /find/symbols` | LSP symbol search |
| **MCP** | `GET /mcp` | Get MCP server status |
| | `POST /mcp` | Add MCP server |
| | `POST /mcp/{name}/connect` | Connect MCP server |
| | `POST /mcp/{name}/disconnect` | Disconnect MCP server |
| | `POST /mcp/{name}/auth` | MCP OAuth operations |
| **TUI** | `POST /tui/prompt/append` | Append to TUI prompt |
| | `POST /tui/command/execute` | Execute TUI command |
| | `POST /tui/session/select` | Select session in TUI |
| **PTY** | `GET /pty` | List PTY sessions |
| | `POST /pty` | Create PTY session |
| | `GET /pty/{ptyID}` | Get PTY details |
| | `WebSocket /pty/{ptyID}/connect` | WebSocket PTY connection |
| **Config** | `GET /config` | Get configuration |
| | `PUT /config` | Update configuration |
| | `GET /config/providers` | List AI providers |
| **Tools** | `GET /tool/ids` | List available tools |
| | `GET /tool/list` | List tools with schemas |
| **Auth** | `POST /auth/{providerID}` | Set auth credentials |
| | `DELETE /auth/{providerID}` | Remove auth |
| **Permissions** | `GET /permission` | List pending permissions |
| | `POST /permission/{requestID}/reply` | Respond to permission |
| **Questions** | `GET /question` | List pending questions |
| | `POST /question/{requestID}/reply` | Answer question |
| **Provider** | `GET /provider` | List AI providers |
| | `GET /provider/auth` | Get auth methods |
| | `POST /provider/{providerID}/oauth/authorize` | OAuth authorization |
| **Worktree** | `GET /worktree` | List worktrees |
| | `POST /worktree` | Create worktree |
| | `DELETE /worktree` | Remove worktree |
| **VCS** | `GET /vcs` | Get version control info |
| **App** | `POST /app/log` | Write to server logs |
| | `GET /app/agents` | List agents |
| | `GET /app/skills` | List skills |
| **Event** | `GET /event` | Subscribe to events |

---

### 3. How to Interact with OpenCode Programmatically

OpenCode provides an **official SDK** at `@opencode-ai/sdk` with three main usage patterns:

#### **Pattern 1: Full Server + Client (Recommended)**
```javascript
import { createOpencode } from '@opencode-ai/sdk/v2';

const { client, server } = await createOpencode({
  hostname: '127.0.0.1',
  port: 4096,
  timeout: 5000,
  config: {
    // Optional configuration
    logLevel: 'info'
  }
});

// Use the client
const health = await client.global.health();
const sessions = await client.session.list();
```

#### **Pattern 2: Start Server Only**
```javascript
import { createOpencodeServer } from '@opencode-ai/sdk/v2/server';

const server = await createOpencodeServer({
  hostname: '127.0.0.1',
  port: 4096
});

console.log('Server running at:', server.url);

// Close server when done
server.close();
```

#### **Pattern 3: Connect to Existing Server**
```javascript
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const client = createOpencodeClient({
  baseUrl: 'http://127.0.0.1:4096',
  directory: '/path/to/project'  // Optional: sets x-opencode-directory header
});

// Use API
const project = await client.project.current();
const files = await client.file.list({ path: '.' });
```

#### **Pattern 4: Launch TUI**
```javascript
import { createOpencodeTui } from '@opencode-ai/sdk/v2/server';

const tui = createOpencodeTui({
  project: 'my-project',
  model: 'anthropic/claude-3-opus-20240229',
  session: 'session-id',  // Optional
  agent: 'build'          // Optional
});

// Close TUI
tui.close();
```

---

### 4. Using OpenCode as a Backend

To use OpenCode as a backend service:

1. **Install the OpenCode CLI** globally:
   ```bash
   npm install -g opencode
   ```

2. **Start the server** programmatically:
   ```javascript
   import { createOpencodeServer } from '@opencode-ai/sdk/v2/server';
   
   const server = await createOpencodeServer({
     port: 4096,
     config: {
       model: 'anthropic/claude-3-opus-20240229'
     }
   });
   ```

3. **Make API calls** to the running server:
   ```javascript
   // Create a session
   const session = await client.session.create({
     title: 'My Session'
   });
   
   // Send a prompt
   await client.session.prompt({
     sessionID: session.data.id,
     parts: [{ type: 'text', text: 'Hello!' }]
   });
   ```

---

### 5. MCP (Model Context Protocol) Implementation

**Yes, OpenCode has full MCP support!** Found extensive MCP implementation in:

**File:** `D:\projects\js\OpenCodeSpec\.opencode\node_modules\@opencode-ai\sdk\dist\v2\gen\types.gen.d.ts`

#### MCP Configuration Types:
```typescript
// Local MCP server
type McpLocalConfig = {
  type: "local";
  command: string[];           // Command and args to run
  environment?: { [key: string]: string };  // Environment variables
  enabled?: boolean;           // Enable on startup
  timeout?: number;           // Request timeout (default 5000ms)
};

// Remote MCP server
type McpRemoteConfig = {
  type: "remote";
  url: string;                // Remote MCP server URL
  enabled?: boolean;
  headers?: { [key: string]: string };
  oauth?: McpOAuthConfig | false;  // OAuth config
  timeout?: number;
};

// OAuth config for remote MCP
type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
};
```

#### MCP API Endpoints:
- `GET /mcp` - Get MCP server status
- `POST /mcp` - Add new MCP server
- `POST /mcp/{name}/connect` - Connect MCP server
- `POST /mcp/{name}/disconnect` - Disconnect MCP server
- `POST /mcp/{name}/auth` - Start OAuth flow
- `POST /mcp/{name}/auth/callback` - Complete OAuth
- `POST /mcp/{name}/auth/authenticate` - Full OAuth flow

#### MCP in Config:
MCP servers are configured in `opencode.jsonc`:
```json
{
  "mcp": {
    "my-local-server": {
      "type": "local",
      "command": ["node", "mcp-server.js"],
      "enabled": true
    },
    "my-remote-server": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "oauth": {
        "clientId": "my-client"
      }
    }
  }
}
```

---

### 6. SDK Package Structure

**Location:** `D:\projects\js\OpenCodeSpec\.opencode\node_modules\@opencode-ai\sdk`

**Exports:**
- `/` - Main SDK (v1)
- `/client` - Client-only (v1)
- `/server` - Server functions (v1)
- `/v2` - Latest SDK (v2)
- `/v2/client` - Client-only (v2)
- `/v2/server` - Server functions (v2)

**Key Files:**
- `dist/v2/server.js` - Server creation functions
- `dist/v2/client.js` - Client creation functions
- `dist/v2/index.js` - Combined server + client
- `dist/v2/gen/sdk.gen.d.ts` - Full API type definitions

---

### Summary

OpenCode is a **VS Code extension with a powerful backend server** that can be used programmatically through:

1. **CLI Command**: `opencode serve --hostname=127.0.0.1 --port=4096`
2. **SDK**: `@opencode-ai/sdk` package with TypeScript support
3. **REST API**: Comprehensive HTTP API with 60+ endpoints
4. **MCP Support**: Full Model Context Protocol implementation for tool integration
5. **WebSocket**: PTY session support via WebSocket
6. **Server-Sent Events**: Real-time event streaming

The SDK allows embedding OpenCode capabilities into any Node.js application, making it a viable backend for AI-powered development tools.
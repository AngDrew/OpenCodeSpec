## ADDED Requirements

### Requirement: Host-managed OpenCode lifecycle
The extension host SHALL be the authoritative owner of OpenCode connection lifecycle, including server startup/shutdown, workspace directory scoping, readiness tracking, and current server URL exposure for webview initialization.

#### Scenario: Extension initializes OpenCode runtime with workspace scope
- **WHEN** the extension activates in a workspace
- **THEN** it SHALL initialize an OpenCode runtime scoped to the active workspace directory
- **AND** it SHALL track readiness and current server URL in host state

#### Scenario: Extension starts local OpenCode server
- **WHEN** local server startup is requested
- **THEN** the host SHALL start OpenCode through the SDK/server integration
- **AND** it SHALL update runtime state with the returned server URL and ready status

#### Scenario: Extension stops local OpenCode server
- **WHEN** local server shutdown is requested
- **THEN** the host SHALL close only the server instance it started
- **AND** it SHALL clear host runtime readiness and active streaming subscriptions

### Requirement: Canonical host-to-webview initialization contract
The host SHALL provide a canonical initialization message that includes connection and session context required for webview bootstrap.

#### Scenario: Webview requests initialization
- **WHEN** the webview sends a ready/init request
- **THEN** the host SHALL respond with an initialization payload containing at minimum `ready`, `serverUrl`, and `workspaceRoot`
- **AND** it SHALL include current session context and defaults when available

#### Scenario: Connection state changes after webview mount
- **WHEN** host connection readiness or server URL changes
- **THEN** the host SHALL notify the webview using the same canonical contract semantics
- **AND** the webview SHALL be able to re-bootstrap without requiring reload

### Requirement: Secure host transport proxy boundary
Requests proxied by the extension host SHALL be restricted to the active OpenCode server origin.

#### Scenario: Proxy HTTP request targets OpenCode origin
- **WHEN** the webview sends a proxied HTTP request to the configured OpenCode origin
- **THEN** the host SHALL forward the request and return status, headers, and body to the webview

#### Scenario: Proxy HTTP request targets a different origin
- **WHEN** the webview sends a proxied HTTP request to a non-OpenCode origin
- **THEN** the host SHALL reject the request with an explicit error response

#### Scenario: SSE subscription targets a different origin
- **WHEN** the webview requests SSE subscription to a non-OpenCode origin
- **THEN** the host SHALL reject the subscription and emit a connection error event

### Requirement: Deterministic lifecycle observability
The extension SHALL expose deterministic connection status and lifecycle events suitable for UI state and debugging.

#### Scenario: Health or readiness check succeeds
- **WHEN** host health/readiness validation succeeds
- **THEN** the host SHALL emit connected/ready state to the webview

#### Scenario: Health or readiness check fails
- **WHEN** host health/readiness validation fails
- **THEN** the host SHALL emit disconnected/error state to the webview with actionable error detail

## ADDED Requirements

### Requirement: Webview SDK bootstrap from host context
The webview SHALL initialize its OpenCode SDK client using host-provided connection context and SHALL not assume fixed server URLs.

#### Scenario: Webview receives canonical init payload
- **WHEN** the webview receives host initialization with `serverUrl` and `workspaceRoot`
- **THEN** it SHALL construct SDK client access using that runtime context
- **AND** it SHALL mark itself ready only after client bootstrap succeeds

#### Scenario: Host init indicates not-ready runtime
- **WHEN** the host initialization indicates `ready = false`
- **THEN** the webview SHALL present disconnected state
- **AND** it SHALL not issue prompt/session API calls until ready context is provided

### Requirement: Realtime event synchronization model
The webview SHALL maintain normalized realtime state for sessions, messages, message parts, permissions, and session status using event-driven updates.

#### Scenario: Session and message events arrive in sequence
- **WHEN** realtime events are received from the `/event` stream
- **THEN** the webview SHALL apply updates to normalized stores keyed by stable IDs
- **AND** message rendering SHALL reflect latest message + part state without duplication

#### Scenario: Event burst occurs during generation
- **WHEN** multiple realtime events arrive rapidly
- **THEN** the webview SHALL batch processing to avoid render thrash
- **AND** final visible state SHALL be equivalent to applying all events in order

### Requirement: SSE resilience and status signaling
The realtime sync layer SHALL recover from transient SSE failures and communicate status transitions to UI state.

#### Scenario: SSE stream disconnects transiently
- **WHEN** the SSE stream ends or errors due to transient connection failure
- **THEN** the webview sync layer SHALL transition to reconnecting status
- **AND** it SHALL automatically retry subscription

#### Scenario: SSE stream reconnects successfully
- **WHEN** SSE reconnection succeeds
- **THEN** the sync layer SHALL transition to connected status
- **AND** it SHALL trigger bootstrap reconciliation for active session state

### Requirement: Session bootstrap and switching consistency
Session selection and bootstrap SHALL produce deterministic state transitions without stale in-flight artifacts from prior sessions.

#### Scenario: User switches session during active generation
- **WHEN** the user changes to another session while a generation is in progress
- **THEN** the webview SHALL clear in-flight state for the previous session context
- **AND** it SHALL bootstrap and render the selected session history before accepting new queued prompts for that session

#### Scenario: Bootstrap runs for selected session
- **WHEN** bootstrap is triggered for a selected session
- **THEN** the webview SHALL fetch current session messages, permissions, and status for that session scope
- **AND** it SHALL reconcile store state before processing buffered realtime events

### Requirement: Permission and error propagation in sync flow
The realtime sync layer SHALL surface permission requests and session-level errors in a way that keeps prompt flow recoverable.

#### Scenario: Permission request event is received
- **WHEN** a permission request event is emitted for the active session or related child sessions
- **THEN** the webview SHALL surface a permission prompt with actionable once/always/reject responses

#### Scenario: Session error event is received
- **WHEN** a session error event is emitted during prompt processing
- **THEN** the webview SHALL clear thinking/in-flight state for that session
- **AND** it SHALL surface an inline recoverable error while allowing subsequent prompts

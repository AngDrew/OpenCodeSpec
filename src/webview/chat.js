(function() {
  const vscode = acquireVsCodeApi();
  
  // DOM Elements
  const messagesContainer = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const inputWrapper = document.getElementById('input-wrapper');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const modePicker = document.getElementById('mode-picker');
  const modelPicker = document.getElementById('model-picker');
  const variantPicker = document.getElementById('variant-picker');
  const sessionPicker = document.getElementById('session-picker');
  const modeLabel = document.getElementById('mode-label');
  const modelLabel = document.getElementById('model-label');
  const variantLabel = document.getElementById('variant-label');
  const chatContainer = document.getElementById('chat-container');
  const connectionBar = document.getElementById('connection-bar');
  const connectionStatus = document.getElementById('connection-status');
  const contextIndicator = document.getElementById('context-indicator');
  if (contextIndicator) {
    contextIndicator.addEventListener('click', () => {
      vscode.postMessage({ type: 'showContextInfo' });
    });
  }
  const newChatBtn = document.getElementById('new-chat-btn');
  const welcomeMessage = document.getElementById('welcome-message');
  const inputContainer = document.getElementById('input-container');
  const slashPalette = document.getElementById('slash-palette');
  const slashList = document.getElementById('slash-list');
  const slashMeta = document.getElementById('slash-meta');
  const pickerPalette = document.getElementById('picker-palette');
  const pickerTitle = document.getElementById('picker-title');
  const pickerMeta = document.getElementById('picker-meta');
  const pickerInput = document.getElementById('picker-input');
  const pickerList = document.getElementById('picker-list');
  
  let currentStreamingElement = null;
  let currentStreamingRoot = null;
  let isStreaming = false;
  let isConnected = false;
  let currentMode = 'build';
  let currentModel = '';
  const DEFAULT_VARIANT_ID = '__default__';
  let currentVariant = DEFAULT_VARIANT_ID;
  let currentSessionId = '';
  let streamingSessionId = '';
  // Populated by host `healthStatus`/`initState`; no fixed server URL assumption.
  let currentUrl = '';
  let availableAgents = [];
  let availableModels = [];
  let availableVariants = [];
  let availableSessions = [];
  let sessionsListLimit = 100;
  let hasReceivedModelsList = false;
  let pendingDefaultsVariant = null;
  let messageElsById = new Map();
  let textByMessageId = new Map();
  let thinkingByMessageId = new Map();
  let toolRowsByMessageId = new Map();
  let patchRowsByMessageId = new Map();

  function createRealtimeSyncState() {
    return {
      sessions: {
        byId: new Map(),
        order: [],
      },
      messages: {
        byId: new Map(),
        orderBySessionId: new Map(),
        partsByMessageId: new Map(),
      },
      permissions: {
        bySessionId: new Map(),
      },
      status: {
        connection: {
          value: 'disconnected',
          url: currentUrl,
          error: '',
        },
        sessionById: new Map(),
      },
    };
  }

  // Ordering assumptions for normalized realtime sync state:
  // 1) `setHistory` is the canonical baseline for a session and replaces prior
  //    message/part state for that session.
  // 2) `partUpdate` may arrive before/after `setHistory`; updates are merged by
  //    stable message and part keys using last-write-wins semantics.
  // 3) text/reasoning parts append when `delta` exists; otherwise snapshots
  //    replace the current text for that part key.
  // 4) session/permission/status updates are idempotent by stable IDs and are
  //    safe to replay without creating duplicates.
  // 5) high-frequency realtime events are processed in FIFO batches per frame,
  //    preserving event order while minimizing render thrash.
  let realtimeSyncState = createRealtimeSyncState();

  function resetRenderedMessageState() {
    messageElsById = new Map();
    textByMessageId = new Map();
    thinkingByMessageId = new Map();
    toolRowsByMessageId = new Map();
    patchRowsByMessageId = new Map();
  }

  function clearMessageSyncState(sessionID) {
    const sid = typeof sessionID === 'string' ? sessionID.trim() : '';
    if (!sid) {
      realtimeSyncState.messages.byId.clear();
      realtimeSyncState.messages.orderBySessionId.clear();
      realtimeSyncState.messages.partsByMessageId.clear();
      return;
    }

    const order = realtimeSyncState.messages.orderBySessionId.get(sid) || [];
    order.forEach((messageID) => {
      realtimeSyncState.messages.byId.delete(messageID);
      realtimeSyncState.messages.partsByMessageId.delete(messageID);
    });
    realtimeSyncState.messages.orderBySessionId.set(sid, []);
  }

  function ensureMessageOrder(sessionID, messageID) {
    if (!sessionID || !messageID) return;
    if (!realtimeSyncState.messages.orderBySessionId.has(sessionID)) {
      realtimeSyncState.messages.orderBySessionId.set(sessionID, []);
    }
    const order = realtimeSyncState.messages.orderBySessionId.get(sessionID);
    if (!order.includes(messageID)) {
      order.push(messageID);
    }
  }

  function ensureMessageRecord(messageID, part, roleFallback, sessionIDFallback) {
    const id = typeof messageID === 'string' ? messageID.trim() : '';
    if (!id) return null;

    const partSessionID = part && typeof part.sessionID === 'string' ? part.sessionID.trim() : '';
    const sessionID = partSessionID || sessionIDFallback || currentSessionId || '';
    const role = (part && part.message && part.message.role) || (part && part.role) || roleFallback || 'assistant';

    let record = realtimeSyncState.messages.byId.get(id);
    if (!record) {
      record = {
        id,
        sessionID,
        role,
      };
      realtimeSyncState.messages.byId.set(id, record);
    } else {
      if (!record.sessionID && sessionID) record.sessionID = sessionID;
      if (!record.role && role) record.role = role;
    }

    if (record.sessionID) {
      ensureMessageOrder(record.sessionID, id);
    }

    return record;
  }

  function ensurePartsMap(messageID) {
    if (!realtimeSyncState.messages.partsByMessageId.has(messageID)) {
      realtimeSyncState.messages.partsByMessageId.set(messageID, new Map());
    }
    return realtimeSyncState.messages.partsByMessageId.get(messageID);
  }

  function getPartSyncKey(part, indexHint) {
    if (!part || typeof part !== 'object') return `unknown:${indexHint}`;
    if (typeof part.id === 'string' && part.id.trim().length > 0) {
      return `id:${part.id.trim()}`;
    }

    const partType = typeof part.type === 'string' ? part.type : 'unknown';
    if (partType === 'tool' && typeof part.callID === 'string' && part.callID.trim().length > 0) {
      return `tool:${part.callID.trim()}`;
    }
    if (partType === 'patch' && typeof part.hash === 'string' && part.hash.trim().length > 0) {
      return `patch:${part.hash.trim()}`;
    }
    if (partType === 'text' || partType === 'reasoning' || partType === 'step-start' || partType === 'step-finish') {
      return partType;
    }
    return `${partType}:${indexHint}`;
  }

  function upsertPartSyncState(messageID, part, delta, indexHint, sessionIDFallback) {
    const messageRecord = ensureMessageRecord(messageID, part, undefined, sessionIDFallback);
    if (!messageRecord || !part) return messageRecord;

    const parts = ensurePartsMap(messageRecord.id);
    const key = getPartSyncKey(part, indexHint);
    const previousPart = parts.get(key);
    const nextPart = {
      ...part,
      key,
      messageID: messageRecord.id,
      sessionID: messageRecord.sessionID,
    };

    if (part.type === 'text' || part.type === 'reasoning') {
      const previousText = previousPart && typeof previousPart.text === 'string' ? previousPart.text : '';
      if (typeof delta === 'string' && delta.length > 0) {
        nextPart.text = previousText + delta;
      } else if (typeof part.text === 'string') {
        nextPart.text = part.text;
      } else {
        nextPart.text = previousText;
      }
    }

    parts.set(key, nextPart);
    return messageRecord;
  }

  function composePartText(messageID, partType) {
    const parts = realtimeSyncState.messages.partsByMessageId.get(messageID);
    if (!parts) return '';

    let text = '';
    for (const part of parts.values()) {
      if (!part || part.type !== partType) continue;
      if (typeof part.text === 'string' && part.text.length > 0) {
        text += part.text;
      }
    }
    return text;
  }

  function applySessionsSyncState(payload) {
    const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions : [];
    availableSessions = sessions;

    const byId = new Map();
    const order = [];
    sessions.forEach((session) => {
      const id = session && typeof session.id === 'string' ? session.id.trim() : '';
      if (!id) return;
      byId.set(id, session);
      order.push(id);
    });

    realtimeSyncState.sessions.byId = byId;
    realtimeSyncState.sessions.order = order;

    if (payload && typeof payload.currentSessionId === 'string') {
      const nextSessionID = normalizeSessionID(payload.currentSessionId);
      if (nextSessionID && nextSessionID !== currentSessionId) {
        beginBootstrapReconciliation(nextSessionID);
      }
      currentSessionId = nextSessionID;
    }
  }

  function applyPermissionSyncState(payload) {
    if (!payload || typeof payload !== 'object') return;
    const sessionID = typeof payload.sessionId === 'string'
      ? payload.sessionId.trim()
      : (typeof payload.sessionID === 'string' ? payload.sessionID.trim() : currentSessionId);
    if (!sessionID) return;

    const requestID = typeof payload.requestId === 'string'
      ? payload.requestId.trim()
      : (typeof payload.requestID === 'string' ? payload.requestID.trim() : 'default');
    if (!requestID) return;

    if (!realtimeSyncState.permissions.bySessionId.has(sessionID)) {
      realtimeSyncState.permissions.bySessionId.set(sessionID, new Map());
    }

    const permissionsForSession = realtimeSyncState.permissions.bySessionId.get(sessionID);
    permissionsForSession.set(requestID, { ...payload, sessionID, requestID });
  }

  function clearPermissionSyncState(payload) {
    if (!payload || typeof payload !== 'object') return;
    const sessionID = typeof payload.sessionId === 'string'
      ? payload.sessionId.trim()
      : (typeof payload.sessionID === 'string' ? payload.sessionID.trim() : currentSessionId);
    if (!sessionID) return;

    const permissionsForSession = realtimeSyncState.permissions.bySessionId.get(sessionID);
    if (!permissionsForSession) return;

    const requestID = typeof payload.requestId === 'string'
      ? payload.requestId.trim()
      : (typeof payload.requestID === 'string' ? payload.requestID.trim() : '');
    if (!requestID) {
      realtimeSyncState.permissions.bySessionId.delete(sessionID);
      return;
    }

    permissionsForSession.delete(requestID);
    if (permissionsForSession.size === 0) {
      realtimeSyncState.permissions.bySessionId.delete(sessionID);
    }
  }

  function applySessionStatusSyncState(payload) {
    if (!payload || typeof payload !== 'object') return;
    const sessionID = typeof payload.sessionId === 'string'
      ? payload.sessionId.trim()
      : (typeof payload.sessionID === 'string' ? payload.sessionID.trim() : currentSessionId);
    if (!sessionID) return;

    const status = typeof payload.status === 'string' ? payload.status.trim() : '';
    if (!status) return;

    realtimeSyncState.status.sessionById.set(sessionID, {
      status,
      updatedAt: Date.now(),
      source: payload.source || 'host',
    });
  }

  const BATCHED_REALTIME_MESSAGE_TYPES = new Set([
    'partUpdate',
    'permissionUpdate',
    'permissionClear',
    'sessionStatus',
  ]);

  let queuedRealtimeMessages = [];
  let queuedRealtimeFlushHandle = null;
  let queuedRealtimeFlushIsRaf = false;
  let pendingBootstrapSessionId = '';
  let bootstrapReconciliationReleaseHandle = null;

  function isBatchedRealtimeMessageType(type) {
    return typeof type === 'string' && BATCHED_REALTIME_MESSAGE_TYPES.has(type);
  }

  function normalizeSessionID(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isRealtimeDrainBlocked() {
    return pendingBootstrapSessionId.length > 0;
  }

  function beginBootstrapReconciliation(sessionID) {
    const sid = normalizeSessionID(sessionID);
    if (!sid) return;

    pendingBootstrapSessionId = sid;
    if (bootstrapReconciliationReleaseHandle !== null) {
      clearTimeout(bootstrapReconciliationReleaseHandle);
    }

    bootstrapReconciliationReleaseHandle = window.setTimeout(() => {
      pendingBootstrapSessionId = '';
      bootstrapReconciliationReleaseHandle = null;
      flushQueuedRealtimeMessagesNow();
    }, 3000);
  }

  function completeBootstrapReconciliation(sessionID) {
    if (!pendingBootstrapSessionId) return;

    const sid = normalizeSessionID(sessionID);
    if (sid && sid !== pendingBootstrapSessionId) {
      return;
    }

    pendingBootstrapSessionId = '';
    if (bootstrapReconciliationReleaseHandle !== null) {
      clearTimeout(bootstrapReconciliationReleaseHandle);
      bootstrapReconciliationReleaseHandle = null;
    }

    if (messageType !== 'setHistory') {
      flushQueuedRealtimeMessagesNow();
    }
  }

  function withSessionFallback(payload, sessionIDFallback) {
    if (!payload || typeof payload !== 'object') return payload;
    if (typeof payload.sessionId === 'string' || typeof payload.sessionID === 'string') {
      return payload;
    }
    return {
      ...payload,
      sessionID: sessionIDFallback,
    };
  }

  function scheduleQueuedRealtimeFlush() {
    if (queuedRealtimeFlushHandle !== null) return;
    if (isRealtimeDrainBlocked()) return;

    const flush = () => {
      queuedRealtimeFlushHandle = null;
      queuedRealtimeFlushIsRaf = false;
      flushQueuedRealtimeMessages();
    };

    if (typeof window.requestAnimationFrame === 'function') {
      queuedRealtimeFlushIsRaf = true;
      queuedRealtimeFlushHandle = window.requestAnimationFrame(flush);
      return;
    }

    queuedRealtimeFlushIsRaf = false;
    queuedRealtimeFlushHandle = window.setTimeout(flush, 16);
  }

  function applyBatchedRealtimeMessage(queuedEntry) {
    const message = queuedEntry && queuedEntry.message ? queuedEntry.message : queuedEntry;
    if (!message || typeof message !== 'object') return false;

    const fallbackSessionID = queuedEntry && typeof queuedEntry.sessionIDFallback === 'string'
      ? queuedEntry.sessionIDFallback
      : currentSessionId;

    switch (message.type) {
      case 'partUpdate':
        applyPartUpdate(message.messageID, message.part, message.delta, fallbackSessionID, 0);
        return true;

      case 'permissionUpdate':
        applyPermissionSyncState(withSessionFallback(message, fallbackSessionID));
        return false;

      case 'permissionClear':
        clearPermissionSyncState(withSessionFallback(message, fallbackSessionID));
        return false;

      case 'sessionStatus':
        applySessionStatusSyncState(withSessionFallback(message, fallbackSessionID));
        return false;

      default:
        return false;
    }
  }

  function flushQueuedRealtimeMessages() {
    if (queuedRealtimeMessages.length === 0) return;
    if (isRealtimeDrainBlocked()) return;

    const batch = queuedRealtimeMessages;
    queuedRealtimeMessages = [];

    let shouldScroll = false;
    const hasPartUpdate = batch.some((entry) => entry && entry.message && entry.message.type === 'partUpdate');
    if (hasPartUpdate) {
      hideWelcome();
    }

    for (const entry of batch) {
      if (applyBatchedRealtimeMessage(entry)) {
        shouldScroll = true;
      }
    }

    if (shouldScroll) {
      scrollToBottom();
    }
  }

  function flushQueuedRealtimeMessagesNow() {
    if (queuedRealtimeFlushHandle !== null) {
      if (queuedRealtimeFlushIsRaf && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(queuedRealtimeFlushHandle);
      } else {
        clearTimeout(queuedRealtimeFlushHandle);
      }
      queuedRealtimeFlushHandle = null;
      queuedRealtimeFlushIsRaf = false;
    }

    flushQueuedRealtimeMessages();
  }

  function clearQueuedRealtimeMessages() {
    if (queuedRealtimeFlushHandle !== null) {
      if (queuedRealtimeFlushIsRaf && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(queuedRealtimeFlushHandle);
      } else {
        clearTimeout(queuedRealtimeFlushHandle);
      }
    }
    queuedRealtimeFlushHandle = null;
    queuedRealtimeFlushIsRaf = false;
    queuedRealtimeMessages = [];
  }

  function clearInFlightGenerationState(options) {
    const clearRealtimeQueue = Boolean(options && options.clearRealtimeQueue);
    if (clearRealtimeQueue) {
      clearQueuedRealtimeMessages();
    }

    isStreaming = false;
    streamingSessionId = '';
    currentStreamingElement = null;
    currentStreamingRoot = null;
    streamingText = '';
    thinkingText = '';
    toolRowsByCallId = new Map();
    patchRowsByHash = new Map();
    updateSendButtonState();
  }

  function enqueueRealtimeMessage(message) {
    if (!message || typeof message !== 'object') return;

    queuedRealtimeMessages.push({
      message,
      sessionIDFallback: currentSessionId,
    });
    scheduleQueuedRealtimeFlush();
  }

  // Slash command palette state
  let allCommands = [];
  let isSlashOpen = false;
  let slashQuery = '';
  let slashActiveIndex = 0;

  // Model/Agent/Variant/Session picker palette state
  let isPickerOpen = false;
  let pickerKind = ''; // 'model' | 'agent' | 'variant' | 'session'
  let pickerQuery = '';
  let pickerActiveIndex = 0;

  // Initialize
  function init() {
    setupEventListeners();
    autoResizeTextarea();
    updateSendButtonState();
    updatePaletteBottomOffset();
    updateVariantLabel();
    
    // Notify host that the webview is ready for canonical init payload.
    vscode.postMessage({ type: 'webviewReady' });
  }

  function updatePaletteBottomOffset() {
    // Keep palettes above the input + connection bar.
    try {
      const inputH = inputContainer ? inputContainer.offsetHeight : 0;
      const connH = connectionBar ? connectionBar.offsetHeight : 0;
      const offset = Math.max(inputH + connH + 12, 96);
      document.documentElement.style.setProperty('--oc-palette-bottom', `${offset}px`);
    } catch {
      // noop
    }
  }

  function setupEventListeners() {
    // Send button
    sendBtn.addEventListener('click', sendMessage);
    
    // Stop button
    stopBtn.addEventListener('click', stopGeneration);

    // New chat button
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newChat' });
      });
    }
    
    // Enter key (Cmd+Enter or Ctrl+Enter)
    messageInput.addEventListener('keydown', (e) => {
      if (isPickerOpen && e.key === 'Escape') {
        e.preventDefault();
        closePickerPalette();
        return;
      }

      if (isSlashOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlashPalette();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveSlashActive(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveSlashActive(-1);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          commitSlashSelection();
          return;
        }
      }

      // Enter sends; Shift+Enter inserts newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
        } else if (isStreaming) {
          stopGeneration();
        } else {
          sendMessage();
        }
        return;
      }
    });

    // Global shortcuts (only when focus stays inside this webview chat)
    document.addEventListener('keydown', (e) => {
      const active = document.activeElement;
      if (!chatContainer || !active || !chatContainer.contains(active)) return;

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (!isCmdOrCtrl) return;

      // Cmd/Ctrl+N: new session
      if (String(e.key).toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        vscode.postMessage({ type: 'newChat' });
        return;
      }

      // Cmd/Ctrl+. : agent picker
      if (e.key === '.' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        openPickerPalette('agent');
        return;
      }

      // Cmd/Ctrl+' : model picker
      if ((e.key === '\'' || e.code === 'Quote') && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        openPickerPalette('model');
        return;
      }

      // Cmd/Ctrl+Shift+D : cycle variant (mac/windows)
      if (String(e.key) === 'D' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        cycleVariant(1);
        return;
      }

      // Some browsers report lowercase even when Shift is held.
      if (String(e.key) === 'd' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        cycleVariant(1);
        return;
      }

      // Cmd/Ctrl+Shift+S : session picker
      if (String(e.key) === 'S' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
        openPickerPalette('session');
        return;
      }

      if (String(e.key) === 's' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
        openPickerPalette('session');
        return;
      }
    });
    
    // Input change for send button state
    messageInput.addEventListener('input', () => {
      updateSendButtonState();
      autoResize();
      updatePaletteBottomOffset();

      // If user is typing a slash command, open/update palette.
      const v = messageInput.value;
      const parsed = parseSlashQuery(v);
      if (parsed) {
        if (isPickerOpen) closePickerPalette();
        slashQuery = parsed.query;
        openSlashPalette();
        renderSlashList();
      } else if (isSlashOpen) {
        closeSlashPalette();
      }
    });

    window.addEventListener('resize', () => {
      updatePaletteBottomOffset();
    });
    
    // Agent/model pickers (in-webview palette)
    if (modePicker) {
      modePicker.addEventListener('click', () => {
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        openPickerPalette('agent');
      });
    }

    if (modelPicker) {
      modelPicker.addEventListener('click', () => {
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        openPickerPalette('model');
      });
    }

    if (variantPicker) {
      variantPicker.addEventListener('click', () => {
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        openPickerPalette('variant');
      });
    }

    if (sessionPicker) {
      sessionPicker.addEventListener('click', () => {
        if (!isConnected) {
          openConnectionDialog();
          return;
        }

        // Refresh sessions before opening.
        vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
        openPickerPalette('session');
      });
    }
    
    // Connection status click
    connectionStatus.addEventListener('click', openConnectionDialog);
    
    // Context indicator: hover-only (no click action)
  }

  function parseSlashQuery(value) {
    if (typeof value !== 'string') return null;
    // Trigger when the input starts with '/'.
    if (!value.startsWith('/')) return null;
    // If there's a newline, we won't show the palette.
    if (value.includes('\n')) return null;

    // Only show the palette while typing the command name (before any whitespace).
    // Once the user adds a space, they are entering arguments.
    const rest = value.slice(1);
    if (/\s/.test(rest)) return null;
    return { query: rest };
  }

  function openSlashPalette() {
    if (!slashPalette) return;
    if (isSlashOpen) return;
    isSlashOpen = true;
    slashActiveIndex = 0;
    slashPalette.classList.remove('hidden');
    slashPalette.setAttribute('aria-hidden', 'false');

    // Lazy-load commands if we don't have them yet.
    if (isConnected && Array.isArray(allCommands) && allCommands.length === 0) {
      vscode.postMessage({ type: 'getCommands' });
    }
  }

  function closeSlashPalette() {
    if (!slashPalette) return;
    isSlashOpen = false;
    slashQuery = '';
    slashActiveIndex = 0;
    slashPalette.classList.add('hidden');
    slashPalette.setAttribute('aria-hidden', 'true');
    if (slashList) slashList.innerHTML = '';
    if (slashMeta) slashMeta.textContent = '';
  }

  function openPickerPalette(kind) {
    if (!pickerPalette || !pickerInput || !pickerList) return;
    if (kind !== 'model' && kind !== 'agent' && kind !== 'variant' && kind !== 'session') return;

    if (isSlashOpen) closeSlashPalette();

    isPickerOpen = true;
    pickerKind = kind;
    pickerQuery = '';
    pickerActiveIndex = 0;

    pickerPalette.classList.remove('hidden');
    pickerPalette.setAttribute('aria-hidden', 'false');

    if (pickerTitle) {
      pickerTitle.textContent = kind === 'model'
        ? 'Select Model'
        : (kind === 'agent' ? 'Select Agent' : (kind === 'variant' ? 'Select Variant' : 'Select Session'));
    }
    if (pickerInput) {
      pickerInput.value = '';
      pickerInput.placeholder = kind === 'model'
        ? 'Search models'
        : (kind === 'agent' ? 'Search agents' : (kind === 'variant' ? 'Search variants' : 'Search sessions'));
    }

    // Ensure inventory is loaded.
    if (kind === 'model' && (!Array.isArray(availableModels) || availableModels.length === 0)) {
      if (pickerMeta) pickerMeta.textContent = 'Loading models...';
      vscode.postMessage({ type: 'getModels' });
    }
    if (kind === 'agent' && (!Array.isArray(availableAgents) || availableAgents.length === 0)) {
      if (pickerMeta) pickerMeta.textContent = 'Loading agents...';
      vscode.postMessage({ type: 'getAgents' });
    }
    if (kind === 'variant') {
      ensureVariantsForCurrentModel();
    }

    if (kind === 'session') {
      if (pickerMeta) pickerMeta.textContent = 'Loading sessions...';
      vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
    }

    // Initialize active index to current selection when possible.
    const items = getPickerItems();
    const currentId = kind === 'model'
      ? currentModel
      : (kind === 'agent' ? currentMode : (kind === 'variant' ? currentVariant : currentSessionId));
    const idx = items.findIndex((it) => it && it.id === currentId);
    pickerActiveIndex = idx >= 0 ? idx : 0;

    renderPickerList();

    // Focus input after render.
    setTimeout(() => {
      try {
        pickerInput.focus();
        pickerInput.select();
      } catch {
        // noop
      }
    }, 0);
  }

  function closePickerPalette() {
    if (!pickerPalette) return;
    isPickerOpen = false;
    pickerKind = '';
    pickerQuery = '';
    pickerActiveIndex = 0;
    pickerPalette.classList.add('hidden');
    pickerPalette.setAttribute('aria-hidden', 'true');
    if (pickerList) pickerList.innerHTML = '';
    if (pickerMeta) pickerMeta.textContent = '';
    try {
      messageInput.focus();
    } catch {
      // noop
    }
  }

  function getPickerItems() {
    if (pickerKind === 'agent') {
      return (Array.isArray(availableAgents) ? availableAgents : [])
        .filter((a) => a && a.id && a.name)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description || '',
          detail: a.model ? `Model: ${a.model}` : '',
        }));
    }

    if (pickerKind === 'model') {
      return (Array.isArray(availableModels) ? availableModels : [])
        .filter((m) => m && m.id && m.name)
        .map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description || '',
          detail: m.id,
        }));
    }

    if (pickerKind === 'variant') {
      return (Array.isArray(availableVariants) ? availableVariants : [])
        .filter((v) => v && v.id && v.name)
        .map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description || '',
          detail: v.detail || '',
        }));
    }

    if (pickerKind === 'session') {
      return (Array.isArray(availableSessions) ? availableSessions : [])
        .filter((s) => s && s.id)
        .map((s) => {
          const id = String(s.id);
          const title = typeof s.title === 'string' ? String(s.title).trim() : '';
          const name = title || id;

          let updated = '';
          try {
            const tu = s.time && typeof s.time.updated === 'number' ? s.time.updated : undefined;
            if (typeof tu === 'number' && Number.isFinite(tu) && tu > 0) {
              updated = new Date(tu).toLocaleString();
            }
          } catch {
            // noop
          }
          const detail = updated ? `Updated: ${updated}` : '';
          return {
            id,
            name,
            description: title ? id : '',
            detail,
          };
        });
    }

    return [];
  }

  function fuzzyScore(query, text) {
    const q = String(query || '').toLowerCase();
    const t = String(text || '').toLowerCase();
    if (!q) return 1;
    let ti = 0;
    let lastMatch = -1;
    let score = 0;

    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      const found = t.indexOf(ch, ti);
      if (found === -1) return null;

      // Base reward
      score += 10;

      // Bonus for contiguous matches
      if (lastMatch !== -1 && found === lastMatch + 1) {
        score += 15;
      }

      // Bonus for start-of-word / separators
      if (found === 0) {
        score += 12;
      } else {
        const prev = t[found - 1];
        if (prev === '/' || prev === '-' || prev === '_' || prev === ' ' || prev === '.') {
          score += 10;
        }
      }

      // Penalty for gaps
      if (lastMatch !== -1) {
        const gap = found - lastMatch - 1;
        score -= Math.min(gap, 12);
      } else {
        // Prefer earlier matches
        score -= Math.min(found, 20);
      }

      lastMatch = found;
      ti = found + 1;
    }

    return score;
  }

  function getFilteredPickerItems() {
    const q = String(pickerQuery || '').trim();
    const items = getPickerItems();
    if (!q) return items.map((it) => ({ item: it, score: 1 }));

    const ranked = [];
    for (const it of items) {
      const hay = `${it.name} ${it.id} ${it.description} ${it.detail}`;
      const s = fuzzyScore(q, hay);
      if (typeof s === 'number') {
        // Prefer name matches a bit.
        const ns = fuzzyScore(q, it.name);
        ranked.push({ item: it, score: s + (typeof ns === 'number' ? ns * 0.6 : 0) });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  function ensureActiveRowInView(containerEl, activeSelector) {
    if (!containerEl) return;
    const active = containerEl.querySelector(activeSelector);
    if (!active) return;

    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    const viewTop = containerEl.scrollTop;
    const viewBottom = viewTop + containerEl.clientHeight;

    if (top < viewTop) {
      containerEl.scrollTop = top;
      return;
    }
    if (bottom > viewBottom) {
      containerEl.scrollTop = Math.max(bottom - containerEl.clientHeight, 0);
    }
  }

  function renderPickerList() {
    if (!pickerList) return;

    const ranked = getFilteredPickerItems();
    const max = 200;
    const shown = ranked.slice(0, max);

    if (pickerMeta) {
      const total = ranked.length;
      const q = String(pickerQuery || '').trim();
      const base = q ? `${total} match${total === 1 ? '' : 'es'}` : `${total} item${total === 1 ? '' : 's'}`;
      if (pickerKind === 'session') {
        pickerMeta.textContent = `${base} (showing up to ${sessionsListLimit})`;
      } else {
        pickerMeta.textContent = base;
      }
    }

    pickerActiveIndex = Math.min(pickerActiveIndex, Math.max(shown.length - 1, 0));
    pickerList.innerHTML = '';

    shown.forEach((row, idx) => {
      const it = row.item;
      const el = document.createElement('div');
      el.className = 'picker-item' + (idx === pickerActiveIndex ? ' active' : '');
      el.setAttribute('role', 'option');
      el.dataset.index = String(idx);
      el.addEventListener('mousedown', (e) => {
        // prevent messageInput focus jump
        e.preventDefault();
      });
      el.addEventListener('click', () => {
        pickerActiveIndex = idx;
        commitPickerSelection();
      });

      const name = document.createElement('div');
      name.className = 'picker-name';
      name.textContent = it.name;

      const desc = document.createElement('div');
      desc.className = 'picker-desc';
      // Show id + optional description
      const descText = it.description ? `${it.id} - ${it.description}` : it.id;
      desc.textContent = descText;

      el.appendChild(name);
      el.appendChild(desc);
      pickerList.appendChild(el);
    });

    if (pickerKind === 'session' && !String(pickerQuery || '').trim()) {
      // Best-effort pagination: ask extension to increase the server-side limit.
      // Keep it simple: only show when not searching.
      if (shown.length >= Math.min(sessionsListLimit, 200) && sessionsListLimit < 500) {
        const el = document.createElement('div');
        el.className = 'picker-item';
        el.setAttribute('role', 'option');
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
        });
        el.addEventListener('click', () => {
          const delta = 100;
          vscode.postMessage({ type: 'sessionListPage', delta });
        });

        const name = document.createElement('div');
        name.className = 'picker-name';
        name.textContent = 'Load more sessions…';
        const desc = document.createElement('div');
        desc.className = 'picker-desc';
        desc.textContent = `Increase limit by 100 (current ${sessionsListLimit})`;

        el.appendChild(name);
        el.appendChild(desc);
        pickerList.appendChild(el);
      }
    }

    ensureActiveRowInView(pickerList, '.picker-item.active');
  }

  function movePickerActive(delta) {
    const ranked = getFilteredPickerItems();
    const count = Math.min(ranked.length, 200);
    if (count <= 0) return;
    pickerActiveIndex = (pickerActiveIndex + delta + count) % count;
    renderPickerList();
  }

  function commitPickerSelection() {
    const ranked = getFilteredPickerItems();
    const shown = ranked.slice(0, 200);
    const row = shown[pickerActiveIndex];
    if (!row || !row.item) return;
    const it = row.item;
    if (pickerKind === 'session' && it && it.id === '__load_more__') {
      // defensive; currently load-more is a separate row, not an item
      return;
    }

    if (pickerKind === 'agent') {
      currentMode = it.id;
      updateModeLabel();
      vscode.postMessage({ type: 'modeChanged', mode: currentMode });
    } else if (pickerKind === 'model') {
      currentModel = it.id;
      updateModelLabel();
      vscode.postMessage({ type: 'modelChanged', model: currentModel });

      const prevVariant = currentVariant;
      ensureVariantsForCurrentModel();
      if (prevVariant !== currentVariant) {
        vscode.postMessage({
          type: 'variantChanged',
          variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant,
        });
      }
    } else if (pickerKind === 'variant') {
      currentVariant = it.id;
      updateVariantLabel();
      vscode.postMessage({ type: 'variantChanged', variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant });
    } else if (pickerKind === 'session') {
      if (typeof it.id === 'string' && it.id !== currentSessionId) {
        beginBootstrapReconciliation(it.id);
        clearInFlightGenerationState({ clearRealtimeQueue: true });
      }
      currentSessionId = it.id;
      vscode.postMessage({ type: 'changeSession', sessionId: currentSessionId });
    }

    closePickerPalette();
  }

  if (pickerInput) {
    pickerInput.addEventListener('input', () => {
      pickerQuery = pickerInput.value;
      pickerActiveIndex = 0;
      renderPickerList();
    });

    pickerInput.addEventListener('keydown', (e) => {
      if (!isPickerOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closePickerPalette();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        movePickerActive(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        movePickerActive(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPickerSelection();
        return;
      }
    });
  }

  function getFilteredCommands() {
    const qRaw = String(slashQuery || '').trim();
    const q = qRaw.replace(/^\//, '').toLowerCase();
    if (!q) return allCommands.slice(0);

    const ranked = [];
    for (const c of allCommands) {
      const name = String(c?.name || '');
      if (!name) continue;
      const desc = String(c?.description || '');
      const tmpl = String(c?.template || '');

      const hay = `${name} ${desc} ${tmpl}`;
      const hs = fuzzyScore(q, hay);
      const ns = fuzzyScore(q, name);

      if (typeof hs !== 'number' && typeof ns !== 'number') continue;

      // Prefer name matches over description/template matches.
      const score = (typeof hs === 'number' ? hs : 0) + (typeof ns === 'number' ? ns * 0.9 : 0);
      ranked.push({ cmd: c, score });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.map((r) => r.cmd);
  }

  function renderSlashList() {
    if (!slashList) return;
    const items = getFilteredCommands();
    const max = 10;
    const shown = items.slice(0, max);

    if (slashMeta) {
      const total = items.length;
      const q = (slashQuery || '').trim();
      slashMeta.textContent = q ? `${total} match${total === 1 ? '' : 'es'}` : `${total} command${total === 1 ? '' : 's'}`;
    }

    slashActiveIndex = Math.min(slashActiveIndex, Math.max(shown.length - 1, 0));
    slashList.innerHTML = '';

    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-item empty';
      empty.setAttribute('role', 'option');
      const name = document.createElement('div');
      name.className = 'slash-name';
      name.textContent = isConnected
        ? 'No commands match'
        : 'Connect to load commands';
      const desc = document.createElement('div');
      desc.className = 'slash-desc';
      desc.textContent = isConnected
        ? 'Try a different query'
        : 'Click the connection status to select a server';
      empty.appendChild(name);
      empty.appendChild(desc);
      slashList.appendChild(empty);
      return;
    }

    shown.forEach((cmd, idx) => {
      const row = document.createElement('div');
      row.className = 'slash-item' + (idx === slashActiveIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.dataset.index = String(idx);
      row.addEventListener('mousedown', (e) => {
        // prevent textarea blur
        e.preventDefault();
      });
      row.addEventListener('click', () => {
        slashActiveIndex = idx;
        commitSlashSelection();
      });

      const name = document.createElement('div');
      name.className = 'slash-name';
      name.textContent = `/${cmd.name}`;
      const desc = document.createElement('div');
      desc.className = 'slash-desc';
      desc.textContent = cmd.description || cmd.template || '';

      row.appendChild(name);
      if (desc.textContent) row.appendChild(desc);
      slashList.appendChild(row);
    });

    ensureActiveRowInView(slashList, '.slash-item.active');
  }

  function moveSlashActive(delta) {
    const items = getFilteredCommands();
    const count = Math.min(items.length, 10);
    if (count <= 0) return;
    slashActiveIndex = (slashActiveIndex + delta + count) % count;
    renderSlashList();
  }

  function commitSlashSelection() {
    const items = getFilteredCommands();
    const cmd = items[slashActiveIndex];
    if (!cmd || !cmd.name) return;
    // Put the command into the input and close the palette.
    messageInput.value = `/${cmd.name} `;
    autoResize();
    updateSendButtonState();
    closeSlashPalette();
    messageInput.focus();
  }

  function openConnectionDialog() {
    vscode.postMessage({ type: 'openConnectionDialog' });
  }

  function autoResizeTextarea() {
    messageInput.addEventListener('input', autoResize);
  }

  function autoResize() {
    messageInput.style.height = 'auto';
    const maxHeight = 110;
    const newHeight = Math.min(messageInput.scrollHeight, maxHeight);
    messageInput.style.height = newHeight + 'px';
    updatePaletteBottomOffset();
  }

  function updateSendButtonState() {
    const hasText = messageInput.value.trim().length > 0;
    
    if (isStreaming) {
      sendBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      sendBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      sendBtn.disabled = !hasText || !isConnected;
      sendBtn.style.opacity = (hasText && isConnected) ? '1' : '0.3';
    }
  }

  function normalizeConnectionStatus(rawStatus) {
    if (typeof rawStatus === 'string') {
      const value = rawStatus.trim().toLowerCase();
      if (value === 'connected' || value === 'reconnecting' || value === 'disconnected' || value === 'failed') {
        return value;
      }
    }
    return 'disconnected';
  }

  function setConnectedState(statusRaw, url, error) {
    const previousConnected = isConnected;
    const status = normalizeConnectionStatus(statusRaw);

    isConnected = status === 'connected';
    currentUrl = url || currentUrl;

    connectionBar.className = status;

    const statusText = connectionStatus.querySelector('.status-text');
    if (statusText) {
      if (status === 'connected') {
        let endpoint = currentUrl;
        try {
          const urlObj = new URL(currentUrl);
          endpoint = `${urlObj.hostname}:${urlObj.port}`;
        } catch {
          // noop
        }
        statusText.textContent = `connected: ${endpoint}`;
      } else if (status === 'reconnecting') {
        statusText.textContent = 'reconnecting';
      } else if (status === 'failed') {
        statusText.textContent = 'failed';
      } else {
        statusText.textContent = 'disconnected';
      }
    }

    const errorText = typeof error === 'string' ? error.trim() : '';
    realtimeSyncState.status.connection = {
      value: status,
      url: currentUrl,
      error: errorText,
    };
    connectionStatus.title = errorText.length > 0
      ? `${status}: ${errorText}`
      : status;

    // Enable/disable input controls
    if (isConnected) {
      messageInput.disabled = false;
      if (modePicker) modePicker.disabled = false;
      if (modelPicker) modelPicker.disabled = false;
      if (variantPicker) variantPicker.disabled = false;
      if (sessionPicker) sessionPicker.disabled = false;
      if (newChatBtn) newChatBtn.disabled = false;
      inputWrapper.classList.remove('disabled');

      if (!previousConnected) {
        vscode.postMessage({ type: 'getAgents' });
        vscode.postMessage({ type: 'getModels' });
        vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
        ensureVariantsForCurrentModel();
      }
    } else {
      messageInput.disabled = true;
      if (modePicker) modePicker.disabled = true;
      if (modelPicker) modelPicker.disabled = true;
      if (variantPicker) variantPicker.disabled = true;
      if (sessionPicker) sessionPicker.disabled = true;
      if (newChatBtn) newChatBtn.disabled = true;
      inputWrapper.classList.add('disabled');
    }
    
    updateSendButtonState();
  }

  function sendMessage() {
    if (!isConnected) {
      openConnectionDialog();
      return;
    }
    
    const text = messageInput.value.trim();
    if (!text || isStreaming) return;

    // If user submitted a slash command, execute via session.command.
    if (text.startsWith('/')) {
      const { command, args } = splitSlashCommand(text);
      if (command) {
        messageInput.value = '';
        messageInput.style.height = 'auto';
        updateSendButtonState();
        hideWelcome();
        vscode.postMessage({
          type: 'sendCommand',
          command,
          arguments: args,
          agent: currentMode,
          model: currentModel,
          variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant,
        });
        return;
      }
    }
    
    const agent = currentMode;
    
    messageInput.value = '';
    messageInput.style.height = 'auto';
    updateSendButtonState();
    
    hideWelcome();
    
    vscode.postMessage({
      type: 'sendMessage',
      text,
      agent,
      model: currentModel,
      variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant,
    });
  }

  function splitSlashCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('/')) return { command: '', args: '' };
    const body = raw.slice(1);
    const spaceIdx = body.search(/\s/);
    if (spaceIdx === -1) {
      return { command: body, args: '' };
    }
    const command = body.slice(0, spaceIdx);
    const args = body.slice(spaceIdx).trim();
    return { command, args };
  }

  function stopGeneration() {
    vscode.postMessage({ type: 'stopGeneration' });
  }

  function hideWelcome() {
    welcomeMessage.style.display = 'none';
  }

  function showWelcome() {
    welcomeMessage.style.display = 'block';
    messagesContainer.innerHTML = '';
    resetRenderedMessageState();
    clearMessageSyncState(currentSessionId);
  }

  function resetHistoryState(sessionID) {
    messagesContainer.innerHTML = '';
    resetRenderedMessageState();
    clearMessageSyncState(sessionID);
  }

  function getOrCreateMessageEl(messageID, role) {
    if (!messageID) return null;
    if (messageElsById.has(messageID)) return messageElsById.get(messageID);
    const created = addMessage(role || 'assistant', '');
    created.messageEl.dataset.messageId = messageID;
    messageElsById.set(messageID, created.messageEl);
    return created.messageEl;
  }

  function getContentEl(messageEl) {
    if (!messageEl) return null;
    return messageEl.querySelector('.bubble-content');
  }

  function getToolMapsForMessage(messageID) {
    if (!toolRowsByMessageId.has(messageID)) toolRowsByMessageId.set(messageID, new Map());
    if (!patchRowsByMessageId.has(messageID)) patchRowsByMessageId.set(messageID, new Map());
    return {
      toolRowsByCallId: toolRowsByMessageId.get(messageID),
      patchRowsByHash: patchRowsByMessageId.get(messageID),
    };
  }

  function updateToolRowForMessage(messageID, messageEl, payload) {
    const maps = getToolMapsForMessage(messageID);
    const prevToolMap = toolRowsByCallId;
    toolRowsByCallId = maps.toolRowsByCallId;
    try {
      updateToolRow(messageEl, payload);
    } finally {
      toolRowsByCallId = prevToolMap;
    }
  }

  function addPatchRowForMessage(messageID, messageEl, payload) {
    const maps = getToolMapsForMessage(messageID);
    const prevPatchMap = patchRowsByHash;
    patchRowsByHash = maps.patchRowsByHash;
    try {
      addPatchRow(messageEl, payload);
    } finally {
      patchRowsByHash = prevPatchMap;
    }
  }

  function applyPartUpdate(messageID, part, delta, sessionIDFallback, indexHint) {
    if (!messageID || !part) return;
    const messageRecord = upsertPartSyncState(messageID, part, delta, indexHint, sessionIDFallback);
    if (!messageRecord) return;

    const role = messageRecord.role || 'assistant';
    const messageEl = getOrCreateMessageEl(messageRecord.id, role);
    if (!messageEl) return;

    if (role === 'assistant') {
      // ensure events container exists even if created as blank
      getOrCreateEventsContainer(messageEl);
    }

    const pType = part.type;
    if (pType === 'text') {
      const next = composePartText(messageRecord.id, 'text');
      textByMessageId.set(messageRecord.id, next);
      const contentEl = getContentEl(messageEl);
      if (contentEl) contentEl.innerHTML = formatContent(next);
    }

    if (pType === 'reasoning') {
      const next = composePartText(messageRecord.id, 'reasoning');
      thinkingByMessageId.set(messageRecord.id, next);
      const body = ensureThinkingBlock(messageEl);
      if (body) body.innerHTML = formatContent(next);
    }

    if (pType === 'tool') {
      updateToolRowForMessage(messageRecord.id, messageEl, {
        tool: part.tool,
        callID: part.callID,
        state: part.state,
      });
    }

    if (pType === 'patch') {
      addPatchRowForMessage(messageRecord.id, messageEl, {
        hash: part.hash,
        files: part.files,
      });
    }

    if (pType === 'step-start' || pType === 'step-finish') {
      const eventsEl = getOrCreateEventsContainer(messageEl);
      if (eventsEl) {
        let step = eventsEl.querySelector('.step-row');
        if (!step) {
          step = document.createElement('div');
          step.className = 'step-row';
          eventsEl.appendChild(step);
        }
        if (pType === 'step-start') {
          step.textContent = 'Step started';
        } else {
          const reason = part.reason ? ` (${part.reason})` : '';
          step.textContent = `Step finished${reason}`;
        }
      }
    }
  }

  function addMessage(role, content) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'bubble';

    const contentEl = document.createElement('div');
    contentEl.className = 'bubble-content';
    contentEl.innerHTML = formatContent(content);
    bubbleEl.appendChild(contentEl);

    if (role === 'assistant') {
      const eventsEl = document.createElement('div');
      eventsEl.className = 'assistant-events';
      bubbleEl.appendChild(eventsEl);
      messageEl._eventsEl = eventsEl;
    }

    messageEl.appendChild(bubbleEl);
    messagesContainer.appendChild(messageEl);
    scrollToBottom();

    return { messageEl, contentEl };
  }

  function getOrCreateEventsContainer(messageEl) {
    if (!messageEl) return null;
    if (messageEl._eventsEl) return messageEl._eventsEl;
    const bubble = messageEl.querySelector('.bubble');
    if (!bubble) return null;
    const eventsEl = document.createElement('div');
    eventsEl.className = 'assistant-events';
    bubble.appendChild(eventsEl);
    messageEl._eventsEl = eventsEl;
    return eventsEl;
  }

  function ensureThinkingBlock(messageEl) {
    const eventsEl = getOrCreateEventsContainer(messageEl);
    if (!eventsEl) return null;
    let details = eventsEl.querySelector('details.thinking');
    if (!details) {
      details = document.createElement('details');
      details.className = 'thinking';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking';
      const body = document.createElement('div');
      body.className = 'thinking-body';
      details.appendChild(summary);
      details.appendChild(body);
      eventsEl.appendChild(details);
    }
    return details.querySelector('.thinking-body');
  }

  function ensureToolList(messageEl) {
    const eventsEl = getOrCreateEventsContainer(messageEl);
    if (!eventsEl) return null;
    let toolList = eventsEl.querySelector('.tool-list');
    if (!toolList) {
      toolList = document.createElement('div');
      toolList.className = 'tool-list';
      eventsEl.appendChild(toolList);
    }
    return toolList;
  }

  function updateToolRow(messageEl, payload) {
    const toolList = ensureToolList(messageEl);
    if (!toolList) return;
    const key = payload.callID || `${payload.tool || 'tool'}_${Date.now()}`;
    let row = toolRowsByCallId.get(key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'tool-row';
      row.dataset.callId = key;
      const head = document.createElement('div');
      head.className = 'tool-head';
      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = payload.tool || 'tool';
      const status = document.createElement('span');
      status.className = 'tool-status';
      head.appendChild(name);
      head.appendChild(status);
      const body = document.createElement('div');
      body.className = 'tool-body';
      row.appendChild(head);
      row.appendChild(body);
      toolList.appendChild(row);
      toolRowsByCallId.set(key, row);
    }

    const statusEl = row.querySelector('.tool-status');
    const bodyEl = row.querySelector('.tool-body');
    const state = payload.state || {};
    const st = state.status || 'pending';
    statusEl.textContent = st;
    row.dataset.status = st;

    bodyEl.innerHTML = '';
    if (state.title) {
      const title = document.createElement('div');
      title.className = 'tool-title';
      title.textContent = state.title;
      bodyEl.appendChild(title);
    }
    if (state.input && Object.keys(state.input).length > 0) {
      const input = document.createElement('details');
      input.className = 'tool-io';
      const sum = document.createElement('summary');
      sum.textContent = 'Input';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(state.input, null, 2);
      input.appendChild(sum);
      input.appendChild(pre);
      bodyEl.appendChild(input);
    }
    if (typeof state.output === 'string' && state.output.length > 0) {
      const out = document.createElement('details');
      out.className = 'tool-io';
      const sum = document.createElement('summary');
      sum.textContent = 'Output';
      const pre = document.createElement('pre');
      pre.textContent = state.output;
      out.appendChild(sum);
      out.appendChild(pre);
      bodyEl.appendChild(out);
    }
  }

  function addPatchRow(messageEl, payload) {
    const toolList = ensureToolList(messageEl);
    if (!toolList) return;
    const key = payload.hash || `patch_${Date.now()}`;
    if (patchRowsByHash.has(key)) return;
    const row = document.createElement('div');
    row.className = 'patch-row';
    row.dataset.hash = key;
    const head = document.createElement('div');
    head.className = 'patch-head';
    head.textContent = 'Patch';
    const pre = document.createElement('pre');
    pre.textContent = (payload.files || []).join('\n');
    row.appendChild(head);
    row.appendChild(pre);
    toolList.appendChild(row);
    patchRowsByHash.set(key, row);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatContent(content) {
    const safe = escapeHtml(content || '');
    return safe
      .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
  }

  function updateContextIndicator(usedTokens, maxTokens) {
    const isValid = Number.isFinite(usedTokens) && Number.isFinite(maxTokens) && maxTokens > 0;
    // The extension uses 0/1 as a placeholder for "unavailable".
    const isUnavailable = !isValid || (usedTokens === 0 && maxTokens === 1);

    if (isUnavailable) {
      const circumference = 62.8;
      const fill = contextIndicator.querySelector('.context-ring-fill');
      if (fill) {
        fill.style.strokeDashoffset = circumference;
        fill.style.stroke = 'var(--vscode-panel-border)';
      }
      contextIndicator.title = 'Context: unavailable';
      return;
    }

    const percentage = Math.min((usedTokens / maxTokens) * 100, 100);
    const circumference = 62.8;
    const offset = circumference - (percentage / 100) * circumference;
    
    const fill = contextIndicator.querySelector('.context-ring-fill');
    if (fill) {
      fill.style.strokeDashoffset = offset;
      
      if (percentage > 90) {
        fill.style.stroke = 'var(--vscode-testing-iconFailed)';
      } else if (percentage > 75) {
        fill.style.stroke = 'var(--vscode-editorWarning-foreground)';
      } else {
        fill.style.stroke = 'var(--vscode-activityBarBadge-background)';
      }
    }
    
    contextIndicator.title = `Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${Math.round(percentage)}%)`;
  }

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    const messageType = message && typeof message.type === 'string' ? message.type : '';

    if (isBatchedRealtimeMessageType(messageType)) {
      enqueueRealtimeMessage(message);
      return;
    }

    flushQueuedRealtimeMessagesNow();

    switch (messageType) {
      case 'agentsList':
        if ((!currentMode || currentMode === 'build') && message && typeof message.defaultAgentId === 'string' && message.defaultAgentId.length > 0) {
          currentMode = message.defaultAgentId;
        }
        updateModeSelector(message.agents);
        break;
        
      case 'modelsList':
        hasReceivedModelsList = true;
        if ((!currentModel || currentModel === 'Model') && message && typeof message.defaultModelId === 'string' && message.defaultModelId.length > 0) {
          // Only trust server config default (avoid auto-picking arbitrary model).
          currentModel = message.defaultModelId;
        }
        updateModelSelector(message.models);
        ensureVariantsForCurrentModel();
        applyPendingDefaultsVariant();
        break;

      case 'defaults':
        if (message && typeof message.agent === 'string' && message.agent.length > 0) {
          currentMode = message.agent;
        }
        if (message && typeof message.model === 'string' && message.model.length > 0) {
          currentModel = message.model;
        }
        // Defer applying variant until we have a model inventory, otherwise
        // ensureVariantsForCurrentModel() would overwrite it.
        pendingDefaultsVariant = (message && typeof message.variant === 'string' && message.variant.length > 0)
          ? message.variant
          : DEFAULT_VARIANT_ID;
        updateModeLabel();
        updateModelLabel();
        if (hasReceivedModelsList) {
          ensureVariantsForCurrentModel();
          applyPendingDefaultsVariant();
        } else {
          currentVariant = DEFAULT_VARIANT_ID;
          updateVariantLabel();
        }

        // Persist defaults back to extension so sends include them.
        vscode.postMessage({ type: 'modeChanged', mode: currentMode });
        vscode.postMessage({ type: 'modelChanged', model: currentModel });
        // Only persist the variant once we can validate it against the active model.
        if (hasReceivedModelsList) {
          vscode.postMessage({ type: 'variantChanged', variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant });
        }
        break;

      case 'sessionsList':
        applySessionsSyncState(message);
        if (message && typeof message.limit === 'number' && Number.isFinite(message.limit) && message.limit > 0) {
          sessionsListLimit = Math.max(10, Math.min(Math.floor(message.limit), 500));
        }
        if (isPickerOpen && pickerKind === 'session') {
          // When sessions arrive, prefer highlighting the current session.
          if (!String(pickerQuery || '').trim()) {
            try {
              const items = getPickerItems();
              const idx = items.findIndex((it) => it && it.id === currentSessionId);
              if (idx >= 0) pickerActiveIndex = idx;
            } catch {
              // noop
            }
          }
          renderPickerList();
        }
        break;

      // Agent/model selection is handled locally (picker palette).

      case 'commandsList':
        allCommands = Array.isArray(message.commands) ? message.commands : [];
        // Keep list stable: prefer name sort.
        allCommands.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
        // If palette is open, re-render.
        if (isSlashOpen) renderSlashList();
        break;
        
      case 'addMessage':
        addMessage(message.role, message.content);
        break;
        
      case 'startStreaming':
        isStreaming = true;
        streamingSessionId = currentSessionId;
        streamingText = '';
        thinkingText = '';
        toolRowsByCallId = new Map();
        patchRowsByHash = new Map();
        const created = addMessage('assistant', '');
        currentStreamingRoot = created.messageEl;
        currentStreamingElement = created.contentEl;
        updateSendButtonState();
        break;

      case 'bindStreaming':
        // If the assistant message already exists in history, stream into that bubble.
        if (message && message.messageID) {
          const bound = messageElsById.get(message.messageID);
          if (bound) {
            // Remove the placeholder streaming bubble if it's different.
            if (currentStreamingRoot && currentStreamingRoot !== bound && !currentStreamingRoot.dataset.messageId) {
              try {
                currentStreamingRoot.remove();
              } catch {
                // noop
              }
            }
            currentStreamingRoot = bound;
            currentStreamingElement = getContentEl(bound);
            streamingText = textByMessageId.get(message.messageID) || '';
          }
        }
        break;

      case 'setHistory':
        const historySessionID = normalizeSessionID(typeof message.sessionId === 'string' ? message.sessionId : currentSessionId);
        beginBootstrapReconciliation(historySessionID);
        const shouldClearInFlightForSessionSwitch = isStreaming
          && historySessionID
          && streamingSessionId
          && historySessionID !== streamingSessionId;

        if (shouldClearInFlightForSessionSwitch) {
          clearInFlightGenerationState({ clearRealtimeQueue: true });
        }

        clearPermissionSyncState({
          sessionID: historySessionID,
        });
        applySessionStatusSyncState({
          sessionID: historySessionID,
          status: 'history_loaded',
          source: 'setHistory',
        });

        if ((message.messages || []).length === 0) {
          showWelcome();
        } else {
          hideWelcome();
        }

        resetHistoryState(historySessionID);
        (message.messages || []).forEach((entry) => {
          const info = entry?.info || {};
          const msgId = info.id || info.messageID;
          const sessionID = info.sessionID || historySessionID;
          const role = info.role || 'assistant';
          if (!msgId) return;
          ensureMessageRecord(msgId, { sessionID, role }, role, historySessionID);
          const messageEl = getOrCreateMessageEl(msgId, role);
          if (!messageEl) return;
          const parts = Array.isArray(entry.parts) ? entry.parts : [];
          parts.forEach((p, index) => {
            applyPartUpdate(msgId, p, undefined, historySessionID, index);
          });
        });

        // If we were streaming, re-bind the streaming bubble to the last assistant message.
        if (isStreaming) {
          const allIds = Array.from(messageElsById.keys());
          const lastId = allIds[allIds.length - 1];
          if (lastId) {
            const bound = messageElsById.get(lastId);
            if (bound) {
              currentStreamingRoot = bound;
              currentStreamingElement = getContentEl(bound);
              streamingText = textByMessageId.get(lastId) || '';
            }
          }
        }
        scrollToBottom();
        completeBootstrapReconciliation(historySessionID);
        break;

      case 'sessionCreated':
        // After session creation, make sure pickers reflect latest inventories.
        if (isConnected) {
          vscode.postMessage({ type: 'getAgents' });
          vscode.postMessage({ type: 'getModels' });
          vscode.postMessage({ type: 'getSessions', limit: sessionsListLimit });
        }
        break;

      case 'partUpdate':
      case 'permissionUpdate':
      case 'permissionClear':
      case 'sessionStatus':
        // Handled by batched realtime queue above.
        break;
        
      case 'streamChunk':
        if (currentStreamingElement) {
          streamingText += message.content || '';
          currentStreamingElement.innerHTML = formatContent(streamingText);
          scrollToBottom();
        }
        break;

      case 'replaceStreaming':
        if (currentStreamingElement) {
          streamingText = message.content || '';
          currentStreamingElement.innerHTML = formatContent(streamingText);
          scrollToBottom();
        }
        break;

      case 'thinkingDelta':
        if (currentStreamingRoot) {
          const body = ensureThinkingBlock(currentStreamingRoot);
          if (body) {
            thinkingText += message.text || '';
            body.innerHTML = formatContent(thinkingText);
            scrollToBottom();
          }
        }
        break;

      case 'thinkingUpdate':
        if (currentStreamingRoot) {
          const body = ensureThinkingBlock(currentStreamingRoot);
          if (body) {
            thinkingText = message.text || '';
            body.innerHTML = formatContent(thinkingText);
            scrollToBottom();
          }
        }
        break;

      case 'toolUpdate':
        if (currentStreamingRoot) {
          updateToolRow(currentStreamingRoot, message);
          scrollToBottom();
        }
        break;

      case 'patchUpdate':
        if (currentStreamingRoot) {
          addPatchRow(currentStreamingRoot, message);
          scrollToBottom();
        }
        break;

      case 'stepUpdate':
        if (currentStreamingRoot) {
          const eventsEl = getOrCreateEventsContainer(currentStreamingRoot);
          if (eventsEl) {
            let step = eventsEl.querySelector('.step-row');
            if (!step) {
              step = document.createElement('div');
              step.className = 'step-row';
              eventsEl.appendChild(step);
            }
            const phase = message.phase;
            if (phase === 'start') {
              step.textContent = 'Step started';
            } else {
              const reason = message.reason ? ` (${message.reason})` : '';
              step.textContent = `Step finished${reason}`;
            }
          }
        }
        break;
        
      case 'endStreaming':
        clearInFlightGenerationState();
        break;

      case 'error':
        clearInFlightGenerationState();
        addMessage('system', `Error: ${message.message}`);
        break;
        
      case 'healthStatus':
        applySessionStatusSyncState({
          sessionID: currentSessionId,
          status: message.status,
          source: 'healthStatus',
        });
        setConnectedState(message.status, message.url, message.error);
        break;

      case 'initState':
        if (message && message.payload && typeof message.payload === 'object') {
          const payload = message.payload;
          const ctx = payload.sessionContext && typeof payload.sessionContext === 'object'
            ? payload.sessionContext
            : undefined;
          if (ctx && typeof ctx.sessionId === 'string') {
            const nextSessionID = normalizeSessionID(ctx.sessionId);
            if (nextSessionID && nextSessionID !== currentSessionId) {
              beginBootstrapReconciliation(nextSessionID);
            }
            currentSessionId = nextSessionID;
          }
        }
        if (message && message.payload && typeof message.payload.ready === 'boolean') {
          const payload = message.payload;
          setConnectedState(
            payload.ready ? 'connected' : 'disconnected',
            typeof payload.serverUrl === 'string' ? payload.serverUrl : currentUrl,
            '',
          );
        }
        break;
        
      case 'externalMessage':
        if (!isConnected) {
          openConnectionDialog();
          return;
        }
        messageInput.value = message.text;
        messageInput.focus();
        updateSendButtonState();
        autoResize();
        break;
        
      case 'newChat':
        showWelcome();
        break;

      case 'contextUpdate':
        updateContextIndicator(message.usedTokens, message.maxTokens);
        break;
    }
  });

  function updateModeSelector(agents) {
    // The extension should already filter to primary agents, but be defensive
    // in case older extension versions or server responses include subagents.
    availableAgents = (Array.isArray(agents) ? agents : []).filter((a) => {
      if (!a || !a.id) return false;
      if (a.mode && a.mode !== 'primary') return false;
      if (a.hidden === true) return false;
      return true;
    });

    if (!currentMode || !availableAgents.some(a => a && a.id === currentMode)) {
      const first = availableAgents.find(a => a && a.id);
      if (first) currentMode = first.id;
    }

    updateModeLabel();

    if (isPickerOpen && pickerKind === 'agent') {
      renderPickerList();
    }
  }

  function updateModelSelector(models) {
    availableModels = Array.isArray(models) ? models : [];

    if (!currentModel || !availableModels.some(m => m && m.id === currentModel)) {
      const first = availableModels.find(m => m && m.id);
      if (first) currentModel = first.id;
    }

    updateModelLabel();

    ensureVariantsForCurrentModel();

    if (isPickerOpen && pickerKind === 'model') {
      renderPickerList();
    }
  }

  function updateModeLabel() {
    if (!modeLabel) return;
    const found = availableAgents.find(a => a && a.id === currentMode);
    modeLabel.textContent = (found && found.name) ? found.name : (currentMode || 'Build');
    if (modePicker) {
      const title = found && found.description ? found.description : '';
      modePicker.title = title;
    }
  }

  function updateModelLabel() {
    if (!modelLabel) return;
    const found = availableModels.find(m => m && m.id === currentModel);
    modelLabel.textContent = (found && found.name) ? found.name : (currentModel ? (currentModel.split('/').pop() || currentModel) : '');
    if (modelPicker) {
      const title = found && found.description ? found.description : (currentModel || '');
      modelPicker.title = title;
    }
  }

  function updateVariantLabel() {
    if (!variantLabel) return;
    const found = availableVariants.find(v => v && v.id === currentVariant);
    const label = currentVariant === DEFAULT_VARIANT_ID
      ? 'Variant'
      : ((found && found.name) ? found.name : (currentVariant || 'Variant'));
    variantLabel.textContent = label;
    if (variantPicker) {
      const title = currentVariant === DEFAULT_VARIANT_ID
        ? 'Model variant (Ctrl+Shift+D to cycle)'
        : (found && found.description ? found.description : (currentVariant || ''));
      variantPicker.title = title;
    }
  }

  function deriveVariantsForModel(modelId) {
    const model = availableModels.find(m => m && m.id === modelId);
    const variantsObj = model && model.variants && typeof model.variants === 'object' ? model.variants : null;
    const out = [];
    if (variantsObj) {
      try {
        Object.entries(variantsObj).forEach(([id, cfg]) => {
          if (!id) return;
          const disabled = cfg && typeof cfg === 'object' ? Boolean(cfg.disabled) : false;
          if (disabled) return;
          out.push({
            id,
            name: id,
            description: '',
            detail: '',
          });
        });
      } catch {
        // noop
      }
    }

    // Always include a server-default option.
    out.unshift({ id: DEFAULT_VARIANT_ID, name: 'Variant', description: 'Server default variant', detail: '' });

    return out;
  }

  function ensureVariantsForCurrentModel() {
    availableVariants = deriveVariantsForModel(currentModel);
    if (!currentVariant || !availableVariants.some(v => v && v.id === currentVariant)) {
      const first = availableVariants.find(v => v && v.id);
      currentVariant = first ? first.id : '';
    }
    updateVariantLabel();

    if (isPickerOpen && pickerKind === 'variant') {
      renderPickerList();
    }
  }

  function applyPendingDefaultsVariant() {
    if (!pendingDefaultsVariant) return;
    const next = pendingDefaultsVariant;
    pendingDefaultsVariant = null;

    // Make sure variants are derived for the current model.
    ensureVariantsForCurrentModel();

    if (next && availableVariants.some(v => v && v.id === next)) {
      currentVariant = next;
    } else {
      currentVariant = DEFAULT_VARIANT_ID;
    }
    updateVariantLabel();
    vscode.postMessage({ type: 'variantChanged', variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant });
  }

  function cycleVariant(delta) {
    ensureVariantsForCurrentModel();
    const list = (Array.isArray(availableVariants) ? availableVariants : [])
      .filter(v => v && v.id);
    if (list.length === 0) return;
    const idx = list.findIndex(v => v.id === currentVariant);
    const nextIdx = ((idx >= 0 ? idx : 0) + delta + list.length) % list.length;
    currentVariant = list[nextIdx].id;
    updateVariantLabel();
    vscode.postMessage({ type: 'variantChanged', variant: currentVariant === DEFAULT_VARIANT_ID ? '' : currentVariant });
  }

  let streamingText = '';
  let thinkingText = '';
  let toolRowsByCallId = new Map();
  let patchRowsByHash = new Map();

  init();
})();

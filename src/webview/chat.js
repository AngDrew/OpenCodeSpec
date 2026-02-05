(function() {
  const vscode = acquireVsCodeApi();
  
  // DOM Elements
  const messagesContainer = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const inputWrapper = document.getElementById('input-wrapper');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const modeDropdown = document.getElementById('mode-dropdown');
  const modelDropdown = document.getElementById('model-dropdown');
  const connectionBar = document.getElementById('connection-bar');
  const connectionStatus = document.getElementById('connection-status');
  const attachImageBtn = document.getElementById('attach-image-btn');
  const contextIndicator = document.getElementById('context-indicator');
  const welcomeMessage = document.getElementById('welcome-message');
  
  let currentStreamingElement = null;
  let currentStreamingRoot = null;
  let isStreaming = false;
  let isConnected = false;
  let currentMode = 'build';
  let currentModel = '';
  let currentUrl = 'http://127.0.0.1:4096';

  // Initialize
  function init() {
    setupEventListeners();
    autoResizeTextarea();
    updateSendButtonState();
    
    // Request initial health check
    vscode.postMessage({ type: 'healthCheck' });
  }

  function setupEventListeners() {
    // Send button
    sendBtn.addEventListener('click', sendMessage);
    
    // Stop button
    stopBtn.addEventListener('click', stopGeneration);
    
    // Enter key (Cmd+Enter or Ctrl+Enter)
    messageInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!isConnected) {
          openConnectionDialog();
        } else if (isStreaming) {
          stopGeneration();
        } else {
          sendMessage();
        }
      }
    });
    
    // Input change for send button state
    messageInput.addEventListener('input', () => {
      updateSendButtonState();
      autoResize();
    });
    
    // Mode selector change
    modeDropdown.addEventListener('change', () => {
      currentMode = modeDropdown.value;
      vscode.postMessage({ type: 'modeChanged', mode: currentMode });
    });
    
    // Model selector change
    modelDropdown.addEventListener('change', () => {
      currentModel = modelDropdown.value;
      vscode.postMessage({ type: 'modelChanged', model: currentModel });
    });
    
    // Connection status click
    connectionStatus.addEventListener('click', openConnectionDialog);
    
    // Attach image button
    attachImageBtn.addEventListener('click', () => {
      if (!isConnected) {
        openConnectionDialog();
        return;
      }
      vscode.postMessage({ type: 'attachImage' });
    });
    
    // Context indicator click
    contextIndicator.addEventListener('click', () => {
      vscode.postMessage({ type: 'showContextInfo' });
    });
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

  function setConnectedState(connected, url) {
    isConnected = connected;
    currentUrl = url || currentUrl;
    
    // Update connection bar
    connectionBar.className = connected ? 'connected' : 'disconnected';
    
    // Update status text
    const statusText = connectionStatus.querySelector('.status-text');
    if (statusText) {
      if (connected) {
        // Extract host:port from URL
        const urlObj = new URL(currentUrl);
        statusText.textContent = `connected: ${urlObj.hostname}:${urlObj.port}`;
      } else {
        statusText.textContent = 'disconnected';
      }
    }
    
    // Enable/disable input controls
    if (connected) {
      messageInput.disabled = false;
      modeDropdown.disabled = false;
      modelDropdown.disabled = false;
      attachImageBtn.disabled = false;
      inputWrapper.classList.remove('disabled');
      
      // Request agents and models
      vscode.postMessage({ type: 'getAgents' });
      vscode.postMessage({ type: 'getModels' });
    } else {
      messageInput.disabled = true;
      modeDropdown.disabled = true;
      modelDropdown.disabled = true;
      attachImageBtn.disabled = true;
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
    
    const agent = currentMode;
    
    messageInput.value = '';
    messageInput.style.height = 'auto';
    updateSendButtonState();
    
    hideWelcome();
    
    vscode.postMessage({
      type: 'sendMessage',
      text,
      agent
    });
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
    
    switch (message.type) {
      case 'agentsList':
        updateModeSelector(message.agents);
        break;
        
      case 'modelsList':
        updateModelSelector(message.models);
        break;
        
      case 'addMessage':
        addMessage(message.role, message.content);
        break;
        
      case 'startStreaming':
        isStreaming = true;
        streamingText = '';
        thinkingText = '';
        toolRowsByCallId = new Map();
        patchRowsByHash = new Map();
        const created = addMessage('assistant', '');
        currentStreamingRoot = created.messageEl;
        currentStreamingElement = created.contentEl;
        updateSendButtonState();
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
        isStreaming = false;
        currentStreamingElement = null;
        currentStreamingRoot = null;
        updateSendButtonState();
        break;
        
      case 'error':
        isStreaming = false;
        updateSendButtonState();
        addMessage('system', `Error: ${message.message}`);
        break;
        
      case 'healthStatus':
        setConnectedState(message.isConnected, message.url);
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
    const currentValue = modeDropdown.value;
    modeDropdown.innerHTML = '';
    
    agents.forEach(agent => {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      if (agent.description) {
        option.title = agent.description;
      }
      modeDropdown.appendChild(option);
    });
    
    if (currentValue) {
      modeDropdown.value = currentValue;
      currentMode = currentValue;
    }
  }

  function updateModelSelector(models) {
    const currentValue = modelDropdown.value;
    modelDropdown.innerHTML = '';
    
    models.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      if (model.description) {
        option.title = model.description;
      }
      modelDropdown.appendChild(option);
    });
    
    if (currentValue) {
      modelDropdown.value = currentValue;
      currentModel = currentValue;
    }
  }

  init();
})();
  let streamingText = '';
  let thinkingText = '';
  let toolRowsByCallId = new Map();
  let patchRowsByHash = new Map();

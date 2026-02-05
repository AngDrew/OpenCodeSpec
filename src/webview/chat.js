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

  function addMessage(role, content, agent) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;
    
    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';
    
    const avatarEl = document.createElement('div');
    avatarEl.className = `avatar ${role}`;
    avatarEl.textContent = role === 'user' ? 'You' : (agent || 'AI');
    
    headerEl.appendChild(avatarEl);
    messageEl.appendChild(headerEl);
    
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.innerHTML = formatContent(content);
    messageEl.appendChild(contentEl);
    
    messagesContainer.appendChild(messageEl);
    scrollToBottom();
    
    return contentEl;
  }

  function formatContent(content) {
    return content
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
        addMessage(message.role, message.content, message.agent);
        break;
        
      case 'startStreaming':
        isStreaming = true;
        currentStreamingElement = addMessage('assistant', '', message.agent);
        updateSendButtonState();
        break;
        
      case 'streamChunk':
        if (currentStreamingElement) {
          const currentText = currentStreamingElement.textContent || '';
          currentStreamingElement.innerHTML = formatContent(currentText + message.content);
          scrollToBottom();
        }
        break;

      case 'replaceStreaming':
        if (currentStreamingElement) {
          currentStreamingElement.innerHTML = formatContent(message.content || '');
          scrollToBottom();
        }
        break;
        
      case 'endStreaming':
        isStreaming = false;
        currentStreamingElement = null;
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

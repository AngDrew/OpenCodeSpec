(function() {
  const vscode = acquireVsCodeApi();
  
  // DOM Elements
  const messagesContainer = document.getElementById('messages');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const agentDropdown = document.getElementById('agent-dropdown');
  const newChatBtn = document.getElementById('new-chat-btn');
  const connectionStatus = document.getElementById('connection-status');
  const welcomeMessage = document.getElementById('welcome-message');
  
  let currentStreamingElement = null;
  let isStreaming = false;

  // Initialize
  function init() {
    // Request agents list
    vscode.postMessage({ type: 'getAgents' });
    
    // Check connection
    vscode.postMessage({ type: 'healthCheck' });
    
    // Setup event listeners
    setupEventListeners();
    
    // Auto-resize textarea
    autoResizeTextarea();
  }

  function setupEventListeners() {
    // Send button
    sendBtn.addEventListener('click', sendMessage);
    
    // Enter key (Cmd+Enter or Ctrl+Enter)
    messageInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        sendMessage();
      }
    });
    
    // New chat button
    newChatBtn.addEventListener('click', () => {
      clearMessages();
      vscode.postMessage({ type: 'createSession' });
    });
    
    // Suggestion buttons
    document.querySelectorAll('.suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        messageInput.value = btn.dataset.text;
        messageInput.focus();
        autoResizeTextarea();
      });
    });
  }

  function autoResizeTextarea() {
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
    });
  }

  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || isStreaming) return;
    
    const agent = agentDropdown.value || undefined;
    
    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    
    // Hide welcome message
    welcomeMessage.style.display = 'none';
    
    // Send to extension
    vscode.postMessage({
      type: 'sendMessage',
      text,
      agent
    });
  }

  function clearMessages() {
    messagesContainer.innerHTML = '';
    welcomeMessage.style.display = 'block';
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
    // Simple markdown formatting
    return content
      .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Handle messages from extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    
    switch (message.type) {
      case 'agentsList':
        updateAgentsList(message.agents);
        break;
        
      case 'addMessage':
        addMessage(message.role, message.content, message.agent);
        break;
        
      case 'startStreaming':
        isStreaming = true;
        currentStreamingElement = addMessage('assistant', '', message.agent);
        sendBtn.disabled = true;
        break;
        
      case 'streamChunk':
        if (currentStreamingElement) {
          const currentText = currentStreamingElement.textContent || '';
          currentStreamingElement.innerHTML = formatContent(currentText + message.content);
          scrollToBottom();
        }
        break;
        
      case 'endStreaming':
        isStreaming = false;
        currentStreamingElement = null;
        sendBtn.disabled = false;
        break;
        
      case 'error':
        isStreaming = false;
        sendBtn.disabled = false;
        addMessage('system', `Error: ${message.message}`);
        break;
        
      case 'healthStatus':
        updateConnectionStatus(message.status);
        break;
        
      case 'externalMessage':
        messageInput.value = message.text;
        sendMessage();
        break;
    }
  });

  function updateAgentsList(agents) {
    agentDropdown.innerHTML = '<option value="">Auto</option>';
    agents.forEach(agent => {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      if (agent.description) {
        option.title = agent.description;
      }
      agentDropdown.appendChild(option);
    });
  }

  function updateConnectionStatus(status) {
    connectionStatus.className = status === 'ok' ? 'connected' : 'disconnected';
    connectionStatus.title = status === 'ok' ? 'Connected to OpenCode' : 'Disconnected from OpenCode';
  }

  init();
})();

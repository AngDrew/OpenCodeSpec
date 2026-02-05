// OpenCode API Client for VS Code Extension
// Connects to opencode serve backend

const OPENCODE_BASE_URL = 'http://127.0.0.1:4096';

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  model?: string;
}

export interface PromptRequest {
  parts: Array<{ type: 'text'; text: string }>;
  agent?: string;
}

export class OpenCodeClient {
  private baseUrl: string;

  constructor(baseUrl: string = OPENCODE_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async createSession(request?: { title?: string }): Promise<Session> {
    return this.fetch<Session>('/session', {
      method: 'POST',
      body: JSON.stringify(request || {}),
    });
  }

  async listAgents(): Promise<Agent[]> {
    const response = await this.fetch<{ data: Agent[] }>('/app/agents');
    return response.data;
  }

  async health(): Promise<{ status: string }> {
    return this.fetch<{ status: string }>('/health');
  }

  async streamPrompt(
    sessionId: string,
    request: PromptRequest,
    onChunk: (chunk: { data: string }) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    const url = `${this.baseUrl}/session/${sessionId}/prompt`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Streaming error: ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.content) {
                onChunk({ data: data.content });
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      onError?.(error as Error);
      throw error;
    }
  }
}

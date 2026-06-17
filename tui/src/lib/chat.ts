// Chat Session — direct conversational bridge for the ikbi TUI.
// Maintains conversation history, loads ikbi's personality, and calls an
// OpenAI-compatible chat endpoint directly. This is the STANDALONE path (no
// tools); the tool-calling loop lives in agent-chat.ts (the ikbi /chat server).
import { loadPersonality, buildPersonalityPrompt, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatResponse {
  content: string;
  thinkingVerb?: string;
}

export type StreamCallback = (chunk: string) => void;

// Default model endpoint: the documented default MiMo provider (mimo-v2.5),
// matching ikbi's core config default (src/core/config.ts) and egress allowlist.
// Point at any OpenAI-compatible endpoint via IKBI_CHAT_BASE_URL / IKBI_CHAT_MODEL
// (or the constructor opts) — e.g. a local model or your own gateway.
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MODEL = 'mimo-v2.5';

/**
 * A conversational chat session. Unlike the task-oriented build pipeline, this
 * maintains an ongoing conversation in ikbi's engineer voice.
 */
export class ChatSession {
  private messages: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private systemPrompt: string;
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.systemPrompt = buildPersonalityPrompt(this.personality);
    this.apiKey = opts?.apiKey ?? process.env.IKBI_CHAT_API_KEY ?? process.env.MIMO_API_KEY;
    this.baseUrl = opts?.baseUrl ?? process.env.IKBI_CHAT_BASE_URL ?? DEFAULT_BASE_URL;
    this.model = opts?.model ?? process.env.IKBI_CHAT_MODEL ?? DEFAULT_MODEL;

    this.messages.push({ role: 'system', content: this.systemPrompt, timestamp: Date.now() });
  }

  getPersonality(): Personality {
    return this.personality;
  }

  getSkin(): Skin {
    return this.skin;
  }

  getHistory(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * Send a user message and get ikbi's response via the OpenAI-compatible
   * chat completions API. Streams when `onStream` is provided.
   */
  async send(userMessage: string, onStream?: StreamCallback): Promise<ChatResponse> {
    this.messages.push({ role: 'user', content: userMessage, timestamp: Date.now() });

    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'building';

    const wireMessages = this.messages.map((m) => ({ role: m.role, content: m.content }));

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      // OpenAI-style and MiMo-style auth headers both supported.
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['api-key'] = this.apiKey;
    }

    const body = {
      model: this.model,
      messages: wireMessages,
      max_completion_tokens: 4096,
      temperature: 0.4,
      stream: !!onStream,
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(`Chat API error ${response.status}: ${errorText.slice(0, 300)}`);
      }

      let content = '';

      if (onStream && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const ls = buffer.split('\n');
          buffer = ls.pop() ?? '';
          for (const line of ls) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                content += delta;
                onStream(delta);
              }
            } catch {
              // Skip malformed chunks.
            }
          }
        }
      } else {
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        content = data.choices?.[0]?.message?.content ?? '';
      }

      this.messages.push({ role: 'assistant', content, timestamp: Date.now() });
      return { content, thinkingVerb };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Chat failed: ${message}`);
    }
  }

  /** Get a quick non-streaming response. */
  async ask(question: string): Promise<string> {
    const response = await this.send(question);
    return response.content;
  }
}

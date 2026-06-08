/**
 * AGENT CHAT SESSION — the tool-calling path for the ikbi TUI.
 *
 * Unlike chat.ts (a direct, tool-less conversation), this session talks to the
 * ikbi SERVER's `/chat` endpoint, where the real tool-calling loop runs with the
 * builder's worktree-confined tools (search_files, patch, governed terminal,
 * read/write/list, run_checks). Running the loop server-side keeps the TUI a thin
 * client and keeps ALL execution behind ikbi's governance — the standalone TUI
 * package never imports ikbi's internals or the trio's tools.
 *
 * The endpoint contract (see src/modules/chat in the ikbi server):
 *   POST /chat  { message, session_id? }  ->  { response, session_id, tools? }
 * The session_id is persisted client-side so the conversation is continuous.
 */
import { loadPersonality, type Personality } from './personality.js';
import { loadSkin, type Skin } from './skin.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
}

/** A tool the server invoked while answering, surfaced for display. */
export interface ToolActivity {
  name: string;
  ok: boolean;
  summary?: string;
}

export interface AgentChatResponse {
  content: string;
  thinkingVerb?: string;
  tools?: ToolActivity[];
}

/** Default ikbi server base — overridable via IKBI_SERVER_URL or constructor opts. */
const DEFAULT_SERVER_URL = 'http://127.0.0.1:18796';

export class AgentChatSession {
  private history: ChatMessage[] = [];
  private personality: Personality;
  private skin: Skin;
  private serverUrl: string;
  private sessionId: string | undefined;

  constructor(opts?: { serverUrl?: string; sessionId?: string }) {
    this.personality = loadPersonality();
    this.skin = loadSkin();
    this.serverUrl = (opts?.serverUrl ?? process.env.IKBI_SERVER_URL ?? DEFAULT_SERVER_URL).replace(/\/$/, '');
    this.sessionId = opts?.sessionId;
  }

  getPersonality(): Personality {
    return this.personality;
  }

  getSkin(): Skin {
    return this.skin;
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /** The server-assigned session id (after the first turn). */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Send a user message to the ikbi /chat endpoint and return the assistant's
   * reply. The server runs the tool-calling loop and maintains the authoritative
   * conversation; we mirror the turn locally for display and carry session_id.
   */
  async send(userMessage: string): Promise<AgentChatResponse> {
    this.history.push({ role: 'user', content: userMessage, timestamp: Date.now() });

    const verbs = this.skin.spinner.thinking_verbs;
    const thinkingVerb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'building';

    const body: { message: string; session_id?: string } = { message: userMessage };
    if (this.sessionId) body.session_id = this.sessionId;

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach ikbi server at ${this.serverUrl} — is it running? (${message})`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`ikbi /chat error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as { response?: string; session_id?: string; tools?: ToolActivity[] };
    if (typeof data.session_id === 'string') this.sessionId = data.session_id;

    const content = data.response ?? '';
    this.history.push({ role: 'assistant', content, timestamp: Date.now() });

    return { content, thinkingVerb, ...(data.tools ? { tools: data.tools } : {}) };
  }

  /** Quick one-shot helper. */
  async ask(question: string): Promise<string> {
    const r = await this.send(question);
    return r.content;
  }
}

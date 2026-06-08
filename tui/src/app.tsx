// ikbi TUI — the build engine's terminal interface.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { loadSkin, type Skin } from './lib/skin.js';
import { ChatSession, type ChatMessage } from './lib/chat.js';
import { AgentChatSession, type ToolActivity } from './lib/agent-chat.js';

/** A unified message shape for the view (carries optional tool activity for agent mode). */
interface ViewMessage {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolActivity[];
}

/** A session that both ChatSession and AgentChatSession satisfy for the TUI's needs. */
interface Session {
  send(message: string): Promise<{ content: string; tools?: ToolActivity[] }>;
}

// ── Banner ───────────────────────────────────────────────────────────
function Banner({ skin }: { skin: Skin }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={skin.colors.banner_border} paddingX={1}>
      <Text>{skin.banner_logo}</Text>
      <Text>{skin.banner_hero}</Text>
    </Box>
  );
}

// ── Status Line ──────────────────────────────────────────────────────
function StatusLine({ skin, status, elapsed, mode }: { skin: Skin; status: string; elapsed: string; mode: string }) {
  const statusColor =
    status === 'ready' ? skin.colors.status_good : status === 'error' ? skin.colors.status_bad : skin.colors.status_warn;
  return (
    <Box borderStyle="single" borderColor={skin.colors.muted} paddingX={1}>
      <Text color={skin.colors.muted}>{skin.branding.agent_name}</Text>
      <Text color={skin.colors.muted}> │ </Text>
      <Text color={skin.colors.ui_accent}>{mode}</Text>
      <Text color={skin.colors.muted}> │ </Text>
      <Text color={statusColor} bold>{status}</Text>
      <Text color={skin.colors.muted}> │ </Text>
      <Text color={skin.colors.muted}>{elapsed}</Text>
    </Box>
  );
}

// ── Thinking Indicator ───────────────────────────────────────────────
function ThinkingIndicator({ skin, verb }: { skin: Skin; verb: string }) {
  const face = skin.spinner.thinking_faces[0] ?? '⠋';
  const wing = skin.spinner.wings[0] ?? ['▸', '◂'];
  return (
    <Box paddingX={1}>
      <Text color={skin.colors.ui_accent}>
        {wing[0]} {face} {verb}... {wing[1]}
      </Text>
    </Box>
  );
}

// ── Tool Activity ────────────────────────────────────────────────────
function ToolLine({ skin, tools }: { skin: Skin; tools: ToolActivity[] }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {tools.map((t, i) => (
        <Text key={i} color={t.ok ? skin.colors.status_good : skin.colors.status_bad}>
          {skin.tool_prefix} {skin.tool_emojis[t.name] ?? '•'} {t.name}
          {t.summary ? ` — ${t.summary}` : ''}
        </Text>
      ))}
    </Box>
  );
}

// ── Message Bubble ───────────────────────────────────────────────────
function Message({ msg, skin }: { msg: ViewMessage; skin: Skin }) {
  if (msg.role === 'user') {
    return (
      <Box paddingX={1}>
        <Text color={skin.colors.prompt} bold>{skin.branding.prompt_symbol} </Text>
        <Text color={skin.colors.text}>{msg.content}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={skin.colors.response_border} paddingX={1} marginBottom={1}>
      <Text color={skin.colors.ui_accent} bold>{skin.branding.response_label}</Text>
      {msg.tools && msg.tools.length > 0 ? <ToolLine skin={skin} tools={msg.tools} /> : null}
      <Text color={skin.colors.text}>{msg.content}</Text>
    </Box>
  );
}

// ── Main App ─────────────────────────────────────────────────────────
export default function App() {
  const skin = loadSkin();
  const { exit } = useApp();
  // Agent mode (server-side tool loop) when IKBI_TUI_AGENT is truthy; else direct chat.
  const agentMode = Boolean(process.env.IKBI_TUI_AGENT) && process.env.IKBI_TUI_AGENT !== '0';
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('ready');
  const [thinkingVerb, setThinkingVerb] = useState('');
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState('0s');
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    try {
      sessionRef.current = agentMode ? new AgentChatSession() : new ChatSession();
    } catch (err) {
      setStatus('error');
      console.error('Failed to initialize session:', err);
    }
  }, [agentMode]);

  useEffect(() => {
    const timer = setInterval(() => {
      const secs = Math.floor((Date.now() - startTime) / 1000);
      if (secs < 60) setElapsed(`${secs}s`);
      else setElapsed(`${Math.floor(secs / 60)}m ${secs % 60}s`);
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') exit();
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      if (!value.trim() || !sessionRef.current) return;
      const next = [...messages, { role: 'user' as const, content: value }];
      setMessages(next);
      setInput('');

      const verbs = skin.spinner.thinking_verbs;
      const verb = verbs[Math.floor(Math.random() * verbs.length)] ?? 'building';
      setThinkingVerb(verb);
      setStatus(verb);

      try {
        const response = await sessionRef.current.send(value);
        setMessages([
          ...next,
          { role: 'assistant', content: response.content, ...(response.tools ? { tools: response.tools } : {}) },
        ]);
        setStatus('ready');
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMessages([...next, { role: 'assistant', content: `[Error: ${errorMsg}]` }]);
        setStatus('error');
      }
    },
    [messages, skin],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Banner skin={skin} />

      <Box paddingX={1} paddingTop={1}>
        <Text color={skin.colors.ui_accent} italic>{skin.branding.welcome}</Text>
      </Box>

      <Box flexDirection="column" paddingTop={1} paddingBottom={1}>
        {messages.map((msg, i) => (
          <Message key={i} msg={msg} skin={skin} />
        ))}
      </Box>

      {status !== 'ready' && status !== 'error' && <ThinkingIndicator skin={skin} verb={thinkingVerb} />}

      <Box paddingX={1}>
        <Text color={skin.colors.prompt} bold>{skin.branding.prompt_symbol} </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} placeholder="State the goal..." />
      </Box>

      <Box paddingTop={1}>
        <StatusLine skin={skin} status={status} elapsed={elapsed} mode={agentMode ? 'agent' : 'chat'} />
      </Box>
    </Box>
  );
}

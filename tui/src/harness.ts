#!/usr/bin/env tsx
/**
 * ikbi Chat Harness — exercise ikbi's personality + runtime from the CLI.
 * No TTY needed. Sends a message, prints the response.
 *
 * Usage:
 *   tsx src/harness.ts "What do you do?"
 *   tsx src/harness.ts --interactive
 *   tsx src/harness.ts --agent "rename helo to hello"   # uses the ikbi /chat server
 *   IKBI_CHAT_API_KEY=xxx tsx src/harness.ts "Plan a small refactor"
 */
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ChatSession } from './lib/chat.js';
import { AgentChatSession } from './lib/agent-chat.js';
import { loadSkin } from './lib/skin.js';
import { loadPersonality } from './lib/personality.js';

interface Session {
  send(message: string): Promise<{ content: string }>;
}

async function main() {
  const args = process.argv.slice(2);
  const interactive = args.includes('--interactive') || args.includes('-i');
  const agentMode = args.includes('--agent') || args.includes('-a');
  const message = args.filter((a) => !a.startsWith('--') && a !== '-i' && a !== '-a').join(' ');

  const skin = loadSkin();
  const personality = loadPersonality();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Agent: ${skin.branding.agent_name}`);
  console.log(`  Personality: ${personality.name} — ${personality.voice_summary.slice(0, 80).trim()}...`);
  console.log(`  Intensity: ${personality.intensity}`);
  console.log(`  Mode: ${agentMode ? 'agent (server /chat — tool-calling)' : 'chat (direct)'}`);
  console.log(`  Primary Color: ${skin.theme.primary}`);
  console.log(`${'═'.repeat(60)}\n`);

  const makeSession = (): Session => (agentMode ? new AgentChatSession() : new ChatSession());

  if (interactive) {
    const session = makeSession();
    const rl = readline.createInterface({ input: stdin, output: stdout });
    console.log(`  ${skin.branding.welcome}`);
    console.log(`  (Type 'exit' or 'quit' to leave)\n`);

    while (true) {
      const input = await rl.question(`${skin.branding.prompt_symbol} `);
      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        console.log(`\n  ${skin.branding.goodbye}\n`);
        break;
      }
      if (!input.trim()) continue;

      const verb = skin.spinner.thinking_verbs[Math.floor(Math.random() * skin.spinner.thinking_verbs.length)] ?? 'building';
      process.stdout.write(`  ${skin.spinner.thinking_faces[0] ?? '⠋'} ${verb}...`);
      try {
        const response = await session.send(input);
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        console.log(`\n${skin.branding.response_label}`);
        console.log(`${response.content}\n`);
      } catch (err) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        console.error(`\n  [Error: ${err instanceof Error ? err.message : String(err)}]\n`);
      }
    }
    rl.close();
  } else if (message) {
    const session = makeSession();
    const verb = skin.spinner.thinking_verbs[Math.floor(Math.random() * skin.spinner.thinking_verbs.length)] ?? 'building';
    console.log(`  ${skin.spinner.thinking_faces[0] ?? '⠋'} ${verb}...`);
    try {
      const response = await session.send(message);
      console.log(`\n${skin.branding.response_label}`);
      console.log(`${response.content}\n`);
    } catch (err) {
      console.error(`\n  [Error: ${err instanceof Error ? err.message : String(err)}]\n`);
      process.exit(1);
    }
  } else {
    console.log('  No message provided. Usage:');
    console.log('    tsx src/harness.ts "What do you do?"');
    console.log('    tsx src/harness.ts --interactive');
    console.log('    tsx src/harness.ts --agent "rename helo to hello"');
    console.log('');
    console.log('  Environment:');
    console.log(`    IKBI_CHAT_API_KEY: ${process.env.IKBI_CHAT_API_KEY ? '(set)' : '(not set)'}`);
    console.log(`    IKBI_SERVER_URL:   ${process.env.IKBI_SERVER_URL ?? '(default http://127.0.0.1:18796)'}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

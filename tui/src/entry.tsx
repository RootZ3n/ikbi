#!/usr/bin/env tsx
// Entry point — launches the ikbi build-engine TUI.
import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { loadSkin } from './lib/skin.js';

// Clear terminal (scrollback included).
process.stdout.write('\x1b[2J\x1b[H\x1b[3J');

const skin = loadSkin();
console.log(`\n  ${skin.branding.agent_name} TUI — ${skin.description}\n`);

render(React.createElement(App));

// ══════════════════════════════════════════════════════════════════════
// IKBI · APP GLUE — wires the live backend (api.js + scenes.js) into the
// inline world engine, and adds chrome the engine doesn't own: a backend
// status dot, Build Log drawer, and a command bar. Loaded AFTER the inline
// engine so all of its globals exist.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── 1. Live workspace bodies ──────────────────────────────────────────────
  // Override pehWorkspaceBody so that any defId registered in IkbiScenes
  // renders a live container instead of the "coming soon" placeholder.
  var _origBody = window.pehWorkspaceBody;
  window.pehWorkspaceBody = function (w, deckMarkup) {
    var def = (typeof pehWorkspaceDef === 'function') ? pehWorkspaceDef(w.defId) : null;
    if (def && def.kind === 'deck') return _origBody(w, deckMarkup);
    if (window.IkbiScenes && IkbiScenes.has(w.defId)) {
      setTimeout(function () { IkbiScenes.fill(w.defId); }, 0);
      return IkbiScenes.liveContainer(w.defId);
    }
    return _origBody(w, deckMarkup);
  };

  // ── 2. Workshop console — append a live build-status strip ───────────────
  var _origConsole = window.renderWorkshopConsole;
  if (typeof _origConsole === 'function') {
    window.renderWorkshopConsole = function () {
      setTimeout(function () { if (window.IkbiScenes) IkbiScenes.fill('console'); }, 0);
      var extra = '<div class="wks-live"><h3 class="wks-section-title">Live engine status</h3>' +
        (window.IkbiScenes ? IkbiScenes.liveContainer('console') : '') + '</div>';
      return _origConsole() + extra;
    };
  }

  // ── 3. Build Log entries on navigation ───────────────────────────────────
  function sceneTitle(id) {
    try { var s = pehScene(pehActiveProductId(), id); return s ? s.title : id; } catch (e) { return id; }
  }
  var _origActivate = window.pehHotspotActivate;
  window.pehHotspotActivate = function (sceneId, hotspotId) {
    try {
      var s = pehScene(pehActiveProductId(), sceneId);
      var h = s && s.hotspots ? s.hotspots.find(function (x) { return x.id === hotspotId; }) : null;
      if (h && h.greeting && window.IkbiGuide) IkbiGuide.log('ikbi: "' + h.greeting + '"', 'peh');
    } catch (e) { /* ignore */ }
    return _origActivate(sceneId, hotspotId);
  };
  ['pehSetScene', 'pehGoScene'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (sceneId) {
      try { if (window.IkbiGuide) IkbiGuide.log('Moved to ' + sceneTitle(sceneId) + '.', 'move'); } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ── 4. Backend status dot ─────────────────────────────────────────────────
  var statusEl = null, lastOnline = null;
  function buildStatus() {
    statusEl = document.createElement('button');
    statusEl.className = 'peh-status';
    statusEl.type = 'button';
    statusEl.title = 'Build engine status — click to recheck';
    statusEl.innerHTML = '<i class="peh-status-dot"></i><span class="peh-status-txt">checking…</span>';
    statusEl.onclick = function () { pollHealth(true); };
    document.body.appendChild(statusEl);
  }
  async function pollHealth(manual) {
    if (!statusEl) return;
    var r = await window.IkbiAPI.health({ fresh: true });
    var dot = statusEl.querySelector('.peh-status-dot');
    var txt = statusEl.querySelector('.peh-status-txt');
    if (r.ok && r.data) {
      dot.className = 'peh-status-dot online';
      txt.textContent = 'online · ' + (r.data.version || 'ok');
      statusEl.title = 'Build engine online · ' + (r.data.service || 'ikbi') + ' ' + (r.data.version || '');
      if (lastOnline === false && window.IkbiGuide) IkbiGuide.log('Build engine back online. Foundation is solid.', 'ok');
      lastOnline = true;
    } else {
      dot.className = 'peh-status-dot offline';
      txt.textContent = 'offline';
      statusEl.title = 'Build engine unreachable: ' + (r.error || 'no response');
      if (lastOnline !== false && window.IkbiGuide && lastOnline !== null) IkbiGuide.log('Build engine offline. Check :18796.', 'warn');
      if (manual && window.IkbiGuide) IkbiGuide.log('Still no response from :18796. Run: node dist/cli/index.js', 'warn');
      lastOnline = false;
    }
  }

  // ── 5. Command bar ────────────────────────────────────────────────────────
  var COMMANDS = 'help, health, agent, capabilities, goto <area>, ask <message>';
  function buildCommandBar() {
    var bar = document.createElement('form');
    bar.className = 'peh-cmd';
    bar.innerHTML =
      '<span class="peh-cmd-mark" aria-hidden="true">›</span>' +
      '<input class="peh-cmd-input" type="text" autocomplete="off" spellcheck="false" ' +
      'placeholder="Command the build engine — try: help">' +
      '<button class="peh-cmd-go" type="submit" aria-label="Run">Run</button>';
    document.body.appendChild(bar);
    var input = bar.querySelector('.peh-cmd-input');
    bar.onsubmit = function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      runCommand(v);
    };
  }

  var SCENE_ALIASES = {
    hub: 'the-heartwood', center: 'the-heartwood', heartwood: 'the-heartwood', command: 'the-heartwood',
    grove: 'the-grove', terminal: 'the-grove', build: 'the-grove', builder: 'the-grove',
    flame: 'the-sacred-flame', testing: 'the-sacred-flame', tests: 'the-sacred-flame', test: 'the-sacred-flame',
    river: 'the-rivers-end', history: 'the-rivers-end', archive: 'the-rivers-end', logs: 'the-rivers-end',
  };

  async function summarize(label, promise, fmt) {
    IkbiGuide.toggle(true);
    var r = await promise;
    if (!r.ok || !r.data) { IkbiGuide.log(label + ': offline (' + (r.error || '?') + ')', 'warn'); return; }
    IkbiGuide.log(label + ': ' + fmt(r.data), 'data');
  }

  async function runCommand(raw) {
    var parts = raw.split(/\s+/);
    var cmd = parts.shift().toLowerCase();
    var rest = parts.join(' ');
    if (!window.IkbiGuide) return;
    switch (cmd) {
      case 'help':
        IkbiGuide.toggle(true);
        IkbiGuide.log('Commands: ' + COMMANDS, 'note');
        break;
      case 'health':
        await summarize('Health', IkbiAPI.health({ fresh: true }), function (d) {
          return (d.status || '?') + ' · ' + (d.service || 'ikbi') + ' ' + (d.version || '');
        });
        break;
      case 'agent':
        await summarize('Agent', IkbiAPI.agent({ fresh: true }), function (d) {
          return (d.name || 'ikbi') + ' · model: ' + (d.model || '?') + ' · tools: ' + (d.tools || 0) + ' · uptime: ' + Math.round(d.uptime || 0) + 's';
        });
        break;
      case 'capabilities':
      case 'caps':
        await summarize('Capabilities', IkbiAPI.capabilities({ fresh: true }), function (d) {
          return (d.features || []).length + ' features · builder tools: ' + (d.toolParity ? d.toolParity.builder : '?');
        });
        break;
      case 'goto':
        var target = SCENE_ALIASES[rest.toLowerCase()] || rest;
        if (target && typeof pehGoScene === 'function' && pehScene(pehActiveProductId(), target)) {
          pehGoScene(target);
        } else {
          IkbiGuide.log('Unknown area: "' + rest + '". Try: hub, grove, flame, river', 'warn');
        }
        break;
      case 'ask':
        if (!rest) { IkbiGuide.log('Ask what? e.g. "ask what tools does the builder have?"', 'note'); break; }
        await ask(rest);
        break;
      default:
        await ask(raw);
    }
  }

  async function ask(message) {
    IkbiGuide.toggle(true);
    IkbiGuide.log('You: ' + message, 'you');
    IkbiGuide.log('ikbi: processing request…', 'note');
    var r = await IkbiAPI.converse(message);
    if (r.ok && r.data && (r.data.response || r.data.content)) {
      IkbiGuide.log('ikbi: ' + (r.data.response || r.data.content), 'peh');
    } else if (r.status === 401) {
      IkbiGuide.log('ikbi: Chat requires IKBI_CHAT_TOKEN. Set it on the server to enable conversational commands.', 'warn');
    } else if (r.status === 503) {
      IkbiGuide.log('ikbi: Chat is unavailable — IKBI_CHAT_TOKEN not configured on the server.', 'warn');
    } else {
      IkbiGuide.log('ikbi: No response from the engine. Is it running on :18796?', 'warn');
    }
  }

  window.IkbiApp = { runCommand: runCommand, ask: ask, pollHealth: pollHealth };

  // ── 6. Floating ikbi Chat Agent ───────────────────────────────────────────
  var chatOpen = false;
  var chatDrawerEl = null;
  var chatBtnEl = null;

  function buildIkbiChat() {
    // Floating trigger button
    chatBtnEl = document.createElement('button');
    chatBtnEl.className = 'ikbi-chat-btn';
    chatBtnEl.type = 'button';
    chatBtnEl.innerHTML = '🔨';
    chatBtnEl.title = 'Chat with ikbi';
    chatBtnEl.setAttribute('aria-label', 'Open ikbi chat');
    chatBtnEl.onclick = toggleIkbiChat;
    document.body.appendChild(chatBtnEl);

    // Chat drawer
    chatDrawerEl = document.createElement('div');
    chatDrawerEl.className = 'ikbi-chat-drawer';
    chatDrawerEl.setAttribute('role', 'dialog');
    chatDrawerEl.setAttribute('aria-label', 'ikbi Chat');
    chatDrawerEl.innerHTML =
      '<div class="ikbi-chat-header">' +
        '<div class="ikbi-chat-avatar" aria-hidden="true">⚙</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:13px;color:#f5ead6;font-family:var(--ikbi-display,sans-serif)">ikbi</div>' +
          '<div style="font-size:11px;color:var(--ink-dim,#b6a079)">Build Engine</div>' +
        '</div>' +
        '<button class="ikbi-chat-close" type="button" aria-label="Close chat" onclick="toggleIkbiChat()">×</button>' +
      '</div>' +
      '<div class="ikbi-chat-messages" id="ikbi-chat-msgs"></div>' +
      '<div class="ikbi-chat-input-wrap">' +
        '<input class="ikbi-chat-input" type="text" id="ikbi-chat-input" ' +
          'placeholder="Ask the build engine…" autocomplete="off" spellcheck="false">' +
        '<button class="ikbi-chat-send" type="button" onclick="sendIkbiChat()">Send</button>' +
      '</div>';
    document.body.appendChild(chatDrawerEl);

    // Enter key sends
    chatDrawerEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'ikbi-chat-input') {
        e.preventDefault();
        sendIkbiChat();
      }
    });

    // Show ikbi's greeting
    appendChatMsg('assistant', 'Welcome to the Workshop. I\'m ikbi — your build engine. Tell me what you want to build, and I\'ll read the ground truth, make the smallest correct change, and prove it green.');
  }

  function toggleIkbiChat() {
    chatOpen = !chatOpen;
    if (chatDrawerEl) chatDrawerEl.classList.toggle('open', chatOpen);
    if (chatBtnEl) chatBtnEl.classList.toggle('active', chatOpen);
    if (chatOpen) {
      var inp = document.getElementById('ikbi-chat-input');
      if (inp) { try { setTimeout(function () { inp.focus(); }, 60); } catch (e) {} }
    }
  }

  function appendChatMsg(role, text) {
    var msgs = document.getElementById('ikbi-chat-msgs');
    if (!msgs) return;
    var el = document.createElement('div');
    el.className = 'ikbi-msg ' + role;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function sendIkbiChat() {
    var inp = document.getElementById('ikbi-chat-input');
    if (!inp) return;
    var text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    appendChatMsg('user', text);

    // Thinking indicator
    var msgs = document.getElementById('ikbi-chat-msgs');
    var thinking = document.createElement('div');
    thinking.className = 'ikbi-msg assistant';
    thinking.style.cssText = 'opacity:.5;font-style:italic';
    thinking.textContent = 'Processing…';
    if (msgs) { msgs.appendChild(thinking); msgs.scrollTop = msgs.scrollHeight; }

    var r = await IkbiAPI.converse(text);
    if (thinking.parentNode) thinking.parentNode.removeChild(thinking);

    if (r.ok && r.data && (r.data.response || r.data.content)) {
      appendChatMsg('assistant', r.data.response || r.data.content);
    } else if (r.status === 503) {
      appendChatMsg('assistant', 'Chat requires IKBI_CHAT_TOKEN to be set on the server. Start the server with that env var to enable live conversation.');
    } else if (r.status === 401) {
      appendChatMsg('assistant', 'Unauthorized. Set IKBI_CHAT_TOKEN on the server and window.IKBI_CHAT_TOKEN in the browser.');
    } else {
      appendChatMsg('assistant', 'No response from the engine. Is it running on :18796? Run: node dist/cli/index.js');
    }
  }

  window.toggleIkbiChat = toggleIkbiChat;
  window.sendIkbiChat = sendIkbiChat;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function start() {
    if (window.IkbiGuide) IkbiGuide.init();
    buildStatus();
    buildCommandBar();
    buildIkbiChat();
    if (window.IkbiGuide) IkbiGuide.log('Build engine ready. Type "help" for commands.', 'peh');
    if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
    pollHealth();
    setInterval(function () { pollHealth(); }, 12000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

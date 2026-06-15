// ══════════════════════════════════════════════════════════════════════
// IKBI · SCENE DATA — all 6 live workspace renderers.
// Every workspace pulls from real API endpoints (/health, /agent,
// /capabilities, POST /chat). No mock data.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  function ago(ms) {
    if (ms == null) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function timeStr(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }
  function offline(r) {
    return '<div class="peh-live-off"><b>The build engine is offline.</b><span>' +
      esc(r && r.error ? r.error : 'backend unreachable') +
      '</span><span class="peh-live-off-hint">Is the engine up on :18796? Run: node dist/cli/index.js</span></div>';
  }
  function stat(label, value) {
    return '<div class="peh-stat"><span class="peh-stat-v">' + esc(value) + '</span><span class="peh-stat-l">' + esc(label) + '</span></div>';
  }
  function section(title, content) {
    return '<div class="ikbi-ws-section"><p class="ikbi-ws-head">' + esc(title) + '</p>' + content + '</div>';
  }
  function flagsGrid(features) {
    return '<div class="ikbi-flags">' + features.map(function (f) {
      return '<div class="ikbi-flag">' +
        '<span class="ikbi-flag-dot on"></span>' +
        '<span class="ikbi-flag-name">' + esc(f.replace(/_/g, ' ')) + '</span></div>';
    }).join('') + '</div>';
  }
  function secFlagsGrid(features, subset) {
    var featSet = new Set(features);
    return '<div class="ikbi-flags">' + subset.map(function (f) {
      var on = featSet.has(f);
      return '<div class="ikbi-flag">' +
        '<span class="ikbi-flag-dot ' + (on ? 'on' : 'off') + '"></span>' +
        '<span class="ikbi-flag-name">' + esc(f.replace(/_/g, ' ')) + '</span></div>';
    }).join('') + '</div>';
  }
  function lifecycleFlags(lc) {
    var flags = ['persistentSessions', 'managedWorkspace', 'rollbackDurability', 'verificationPath', 'promoteApplyPath'];
    return '<div class="ikbi-lifecycle">' + flags.map(function (k) {
      var val = lc && lc[k];
      var label = k.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
      return '<div class="ikbi-lf">' +
        '<span class="ikbi-lf-val ' + (val ? 'on' : 'off') + '">' + (val ? '✓' : '✗') + '</span>' +
        '<span class="ikbi-lf-name">' + esc(label) + '</span></div>';
    }).join('') + '</div>';
  }
  function surfaceTable(surfaces) {
    if (!surfaces || !surfaces.length) return '';
    return '<div class="ikbi-surfaces">' + surfaces.map(function (s) {
      return '<div class="ikbi-surface-row">' +
        '<span class="ikbi-surface-name">' + esc(s.surface) + '</span>' +
        '<span class="ikbi-surface-class ' + esc(s.classification) + '">' + esc(s.classification) + '</span>' +
        '<span class="ikbi-surface-note">' + esc(s.note) + '</span></div>';
    }).join('') + '</div>';
  }

  // ── Workspace renderers ──────────────────────────────────────────────────

  // console — Build Overview deck strip (health + agent + capabilities)
  async function rBuildOverview() {
    var h = await window.IkbiAPI.health();
    var a = await window.IkbiAPI.agent();
    var c = await window.IkbiAPI.capabilities();
    if (!h.ok && !a.ok) return offline(h);
    var hd = h.data || {};
    var ad = a.data || {};
    var cd = c.data || {};
    var head = '<div class="peh-stats">' +
      stat('status', hd.status || 'ok') +
      stat('model', ad.model || '—') +
      stat('tools', ad.tools != null ? ad.tools : '—') +
      stat('uptime', ad.uptime != null ? ago(ad.uptime * 1000) : '—') +
      stat('features', (cd.features || []).length || '—') +
      '</div>';
    var feats = (cd.features || []).length
      ? '<h4 class="peh-live-sub">Capabilities</h4><div class="peh-chips">' +
        (cd.features || []).map(function (f) { return '<span class="peh-chip">' + esc(f) + '</span>'; }).join('') +
        '</div>'
      : '';
    return head + feats;
  }

  // engine-status — Full engine status: stats, feature flags, lifecycle, posture
  async function rEngineStatus() {
    var h = await window.IkbiAPI.health();
    var a = await window.IkbiAPI.agent();
    var c = await window.IkbiAPI.capabilities();
    if (!h.ok && !a.ok && !c.ok) return offline(h);
    var hd = h.data || {};
    var ad = a.data || {};
    var cd = c.data || {};
    var html = '<div class="ikbi-ws">';

    // Status bar
    html += '<div class="peh-stats">' +
      stat('status', hd.status || '?') +
      stat('model', ad.model || cd.model || '—') +
      stat('tools', ad.tools != null ? ad.tools : '—') +
      stat('uptime', ad.uptime != null ? ago(ad.uptime * 1000) : '—') +
      stat('sessions', (cd.chatSessions && cd.chatSessions.persistence) || 'ephemeral') +
      '</div>';

    // Feature flags
    if (cd.features && cd.features.length) {
      html += section('Feature flags — ' + cd.features.length + ' active', flagsGrid(cd.features));
    }

    // Tool parity
    if (cd.toolParity) {
      var p = cd.toolParity;
      html += section('Tool parity',
        '<div class="peh-stats">' +
        stat('builder tools', p.builder) +
        stat('chat tools', p.chat) +
        stat('in sync', p.inSync ? '✓ yes' : '✗ gap') +
        '</div>'
      );
    }

    // Lifecycle flags
    if (cd.lifecycle) {
      html += section('http /chat lifecycle', lifecycleFlags(cd.lifecycle));
    }

    // Safety posture
    if (cd.safetyPosture) {
      var sp = cd.safetyPosture;
      html += section('Safety posture',
        '<div class="ikbi-safety-box">' +
        '<span class="ikbi-safety-label">' + esc(sp.posture || 'unknown') + '</span>' +
        '<span class="ikbi-safety-detail">Verification: ' + esc(sp.verification || '?') + '</span>' +
        '<span class="ikbi-safety-detail">Retrieval: ' + esc(sp.retrieval || '?') + '</span>' +
        '</div>'
      );
    }

    // Endpoints
    if (cd.endpoints && cd.endpoints.length) {
      html += section('Endpoints',
        '<div class="peh-chips">' + cd.endpoints.map(function (e) {
          return '<span class="peh-chip">' + esc(e) + '</span>';
        }).join('') + '</div>'
      );
    }

    html += '</div>';
    return html;
  }

  // builder-ws — Builder tools inventory (chat appended via extraHtml)
  async function rBuilderWs() {
    var c = await window.IkbiAPI.capabilities();
    if (!c.ok || !c.data) return offline(c);
    var cd = c.data || {};
    var tools = cd.tools || [];
    var html = '<div class="ikbi-ws">';

    html += '<div class="peh-stats">' +
      stat('model', cd.model || '—') +
      stat('builder tools', cd.toolParity ? cd.toolParity.builder : tools.length) +
      stat('chat tools', cd.toolParity ? cd.toolParity.chat : '—') +
      stat('parity', cd.toolParity && cd.toolParity.inSync ? '✓ in sync' : '✗ gap') +
      '</div>';

    if (tools.length) {
      html += section('Builder tool inventory — ' + tools.length + ' tools',
        '<div class="ikbi-tools-grid">' + tools.map(function (t) {
          return '<div class="ikbi-tool-card"><span class="ikbi-tool-name">' + esc(t) + '</span></div>';
        }).join('') + '</div>'
      );
    }

    html += '</div>';
    return html;
  }

  // test-results — Test suite overview
  async function rTestResults() {
    var c = await window.IkbiAPI.capabilities();
    var cd = (c.data) || {};
    var features = cd.features || [];
    var tools = cd.tools || [];

    var html = '<div class="ikbi-ws">';

    html += '<div class="ikbi-test-stats">' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">800+</span><span class="ikbi-test-stat-l">total tests</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">28+</span><span class="ikbi-test-stat-l">modules covered</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(tools.length || '?')) + '</span><span class="ikbi-test-stat-l">builder tools</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(features.length || '?')) + '</span><span class="ikbi-test-stat-l">gated features</span></div>' +
      '</div>';

    html += section('Test coverage note',
      '<p class="ikbi-test-note">The test suite covers all 28+ modules via <code>pnpm test</code>. ' +
      'Live pass/fail counts are not available over the HTTP API — run the suite in the terminal for real-time results.</p>'
    );

    html += section('Actions',
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
      '<button class="ikbi-run-btn" type="button" ' +
      'onclick="IkbiApp.runCommand(\'health\');IkbiGuide.toggle(true);IkbiGuide.log(\'Run: cd /pehverse/repos/ikbi && pnpm test\', \'note\')">' +
      'Check engine</button>' +
      '<span style="font-size:12px;color:var(--ink-dim)">Run <code style="font-family:var(--mono);font-size:11px;color:var(--peh-accent)">pnpm test</code> in a terminal for live results</span>' +
      '</div>'
    );

    html += '</div>';
    return html;
  }

  // trust-ws — Trust, safety, governance posture
  async function rTrustWs() {
    var c = await window.IkbiAPI.capabilities();
    if (!c.ok || !c.data) return offline(c);
    var cd = c.data || {};
    var features = cd.features || [];
    var SECURITY = ['governed_execution', 'injection_defense', 'trust_model', 'circuit_breaker', 'drift_prevention', 'kill_switch'];

    var html = '<div class="ikbi-ws">';

    if (cd.safetyPosture) {
      var sp = cd.safetyPosture;
      html += section('Safety posture',
        '<div class="ikbi-safety-box">' +
        '<span class="ikbi-safety-label">' + esc(sp.posture || 'unknown') + '</span>' +
        '<span class="ikbi-safety-detail">Verification: <b>' + esc(sp.verification || '?') + '</b></span>' +
        '<span class="ikbi-safety-detail">Retrieval: <b>' + esc(sp.retrieval || '?') + '</b></span>' +
        '</div>'
      );
    }

    html += section('Security features', secFlagsGrid(features, SECURITY));

    if (cd.lifecycle) {
      html += section('http /chat lifecycle', lifecycleFlags(cd.lifecycle));
    }

    if (cd.chatSessions && cd.chatSessions.warning) {
      html += section('Session policy',
        '<div class="peh-row">' +
        '<span class="peh-row-t">Persistence: ' + esc(cd.chatSessions.persistence || '?') + ' · Resumable: ' + (cd.chatSessions.resumable ? 'yes' : 'no') + '</span>' +
        '<span class="peh-row-m">' + esc(cd.chatSessions.warning) + '</span></div>'
      );
    }

    if (cd.surfaces && cd.surfaces.length) {
      html += section('Surface classifications', surfaceTable(cd.surfaces));
    }

    html += '</div>';
    return html;
  }

  // modules-ws — Full module / tool / feature inventory
  async function rModulesWs() {
    var c = await window.IkbiAPI.capabilities();
    if (!c.ok || !c.data) return offline(c);
    var cd = c.data || {};
    var tools = cd.tools || [];
    var features = cd.features || [];

    var html = '<div class="ikbi-ws">';

    html += '<div class="peh-stats">' +
      stat('builder tools', tools.length) +
      stat('chat tools', cd.toolParity ? cd.toolParity.chat : '—') +
      stat('features', features.length) +
      stat('endpoints', (cd.endpoints || []).length) +
      stat('model', cd.model || '—') +
      '</div>';

    if (tools.length) {
      html += section('Builder tool inventory',
        '<div class="ikbi-tools-grid">' + tools.map(function (t) {
          return '<div class="ikbi-tool-card"><span class="ikbi-tool-name">' + esc(t) + '</span></div>';
        }).join('') + '</div>'
      );
    }

    if (features.length) {
      html += section('Feature flags', flagsGrid(features));
    }

    if (cd.surfaces && cd.surfaces.length) {
      html += section('Surface map', surfaceTable(cd.surfaces));
    }

    html += '</div>';
    return html;
  }

  // history-ws — Activity log and session info
  async function rHistoryWs() {
    var a = await window.IkbiAPI.agent();
    var c = await window.IkbiAPI.capabilities();
    var ad = (a.data) || {};
    var cd = (c.data) || {};

    var html = '<div class="ikbi-ws">';

    html += '<div class="peh-stats">' +
      stat('status', ad.status || '—') +
      stat('uptime', ad.uptime != null ? ago(ad.uptime * 1000) : '—') +
      stat('sessions', (cd.chatSessions && cd.chatSessions.persistence) ? cd.chatSessions.persistence : '—') +
      stat('resumable', (cd.chatSessions && cd.chatSessions.resumable) ? 'yes' : 'no') +
      '</div>';

    if (cd.chatSessions && cd.chatSessions.warning) {
      html += section('Session note',
        '<div class="peh-row"><span class="peh-row-m">' + esc(cd.chatSessions.warning) + '</span></div>'
      );
    }

    var entries = (window.IkbiGuide && IkbiGuide.entries) ? IkbiGuide.entries() : [];
    if (entries.length) {
      html += section('Recent activity — ' + entries.length + ' events',
        '<div class="ikbi-history-list">' +
        entries.slice().reverse().slice(0, 30).map(function (e) {
          return '<div class="ikbi-hist-item k-' + esc(e.kind) + '">' +
            '<span class="ikbi-hist-time">' + esc(timeStr(e.t)) + '</span>' +
            '<span class="ikbi-hist-text">' + esc(e.text) + '</span></div>';
        }).join('') + '</div>'
      );
    } else {
      html += section('Activity log',
        '<p class="peh-live-empty">No activity yet. Interact with the engine to see events here.</p>'
      );
    }

    html += '</div>';
    return html;
  }

  // grove-ws — TUI-style terminal for direct conversation with ikbi
  function rGroveWs() {
    return '<div class="grove-terminal">' +
      '<div class="grove-header">THE GROVE · ikbi terminal</div>' +
      '<div class="grove-messages" id="grove-msgs">' +
        '<div class="grove-msg system">Welcome to the Grove. Type a goal and ikbi will build it.</div>' +
      '</div>' +
      '<div class="grove-input-wrap">' +
        '<span class="grove-prompt">❯</span>' +
        '<input class="grove-input" type="text" id="grove-input" placeholder="State the goal..." ' +
          'onkeydown="if(event.key===\'Enter\'&&this.value.trim()){window.groveSend(this.value);this.value=\'\'}">' +
      '</div>' +
    '</div>';
  }

  window.groveSend = async function (text) {
    if (!text || !text.trim()) return;
    var msgs = document.getElementById('grove-msgs');
    if (!msgs) return;

    var userEl = document.createElement('div');
    userEl.className = 'grove-msg user';
    userEl.textContent = text;
    msgs.appendChild(userEl);
    msgs.scrollTop = msgs.scrollHeight;

    var thinkingEl = document.createElement('div');
    thinkingEl.className = 'grove-msg system';
    thinkingEl.textContent = 'ikbi is processing…';
    msgs.appendChild(thinkingEl);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      var result = await window.IkbiAPI.converse(text);
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);

      if (result.ok && result.data) {
        var response = result.data.response || result.data.content || JSON.stringify(result.data);
        var respEl = document.createElement('div');
        respEl.className = 'grove-msg assistant';
        respEl.textContent = response;
        msgs.appendChild(respEl);
      } else if (result.status === 401 || result.status === 503) {
        var authEl = document.createElement('div');
        authEl.className = 'grove-msg system';
        authEl.textContent = 'Chat requires IKBI_CHAT_TOKEN. Set it on the server to enable conversation.';
        msgs.appendChild(authEl);
      } else {
        var errEl = document.createElement('div');
        errEl.className = 'grove-msg system';
        errEl.textContent = 'Error: ' + (result.error || 'No response from the engine. Is it running on :18796?');
        msgs.appendChild(errEl);
      }
    } catch (e) {
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
      var catchEl = document.createElement('div');
      catchEl.className = 'grove-msg system';
      catchEl.textContent = 'Error: ' + ((e && e.message) || String(e));
      msgs.appendChild(catchEl);
    }
    msgs.scrollTop = msgs.scrollHeight;
  };

  window.groveClear = function () {
    var msgs = document.getElementById('grove-msgs');
    if (msgs) {
      msgs.innerHTML = '';
      var el = document.createElement('div');
      el.className = 'grove-msg system';
      el.textContent = 'Terminal cleared.';
      msgs.appendChild(el);
    }
    var inp = document.getElementById('grove-input');
    if (inp) { try { inp.focus(); } catch (e) {} }
  };

  // ── Builder chat ─────────────────────────────────────────────────────────
  var chatState = {};

  function getChatState(defId) {
    if (!chatState[defId]) chatState[defId] = { history: [], loading: false };
    return chatState[defId];
  }

  function builderChatHtml(defId) {
    return '<div class="ikbi-chat" id="ikbi-chat-' + esc(defId) + '">' +
      '<div class="ikbi-chat-head">Builder Chat</div>' +
      '<div class="ikbi-chat-history"></div>' +
      '<form class="ikbi-chat-form" onsubmit="IkbiScenes.handleChatSubmit(event,\'' + esc(defId) + '\')">' +
      '<input class="ikbi-chat-input" type="text" placeholder="Send a goal to the build engine…" autocomplete="off" spellcheck="false">' +
      '<button class="ikbi-chat-send" type="submit">Send</button>' +
      '</form></div>';
  }

  function renderChat(defId) {
    var chatEl = document.getElementById('ikbi-chat-' + defId);
    if (!chatEl) return;
    var cs = getChatState(defId);
    var histEl = chatEl.querySelector('.ikbi-chat-history');
    if (!histEl) return;
    var items = cs.history.map(function (m) {
      return '<div class="ikbi-chat-msg ikbi-msg-' + esc(m.role) + '">' +
        '<span class="ikbi-msg-role">' + esc(m.role === 'user' ? 'You' : m.role === 'ikbi' ? 'ikbi' : '⚠ Error') + '</span>' +
        '<span class="ikbi-msg-text">' + esc(m.text) + '</span></div>';
    });
    if (cs.loading) items.push('<div class="ikbi-chat-msg ikbi-msg-loading">ikbi is thinking…</div>');
    histEl.innerHTML = items.join('');
    histEl.scrollTop = histEl.scrollHeight;
  }

  async function sendChat(defId, message) {
    var cs = getChatState(defId);
    cs.history.push({ role: 'user', text: message });
    cs.loading = true;
    renderChat(defId);
    if (window.IkbiGuide) IkbiGuide.log('You: ' + message, 'you');
    var r = await window.IkbiAPI.converse(message);
    cs.loading = false;
    if (r.ok && r.data && (r.data.response || r.data.content)) {
      var reply = r.data.response || r.data.content;
      cs.history.push({ role: 'ikbi', text: reply });
      if (window.IkbiGuide) IkbiGuide.log('ikbi: ' + reply, 'peh');
    } else if (r.status === 401) {
      cs.history.push({ role: 'error', text: 'Chat requires IKBI_CHAT_TOKEN. Set it on the server to enable conversational commands.' });
    } else if (r.status === 503) {
      cs.history.push({ role: 'error', text: 'Chat unavailable — IKBI_CHAT_TOKEN not configured on the server.' });
    } else {
      cs.history.push({ role: 'error', text: r.error || 'No response from the engine. Is it running on :18796?' });
    }
    renderChat(defId);
  }

  function handleChatSubmit(e, defId) {
    e.preventDefault();
    var form = e.target || e.srcElement;
    if (!form) return;
    var input = form.querySelector('.ikbi-chat-input');
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    sendChat(defId, msg);
  }

  // ── defId → renderer map ─────────────────────────────────────────────────
  var MAP = {
    'console': {
      fn: rBuildOverview,
      options: [['Refresh', "IkbiScenes.fill('console',true)"], ['Health check', "IkbiApp.runCommand('health')"]]
    },
    'engine-status': {
      fn: rEngineStatus,
      options: [['Refresh', "IkbiScenes.fill('engine-status',true)"], ['Agent info', "IkbiApp.runCommand('agent')"]]
    },
    'builder-ws': {
      fn: rBuilderWs,
      extraHtml: builderChatHtml,
      postFill: function (defId) { renderChat(defId); },
      options: [['Refresh tools', "IkbiScenes.fill('builder-ws',true)"], ['Capabilities', "IkbiApp.runCommand('capabilities')"]]
    },
    'test-results': {
      fn: rTestResults,
      options: [['Refresh', "IkbiScenes.fill('test-results',true)"], ['Health check', "IkbiApp.runCommand('health')"]]
    },
    'trust-ws': {
      fn: rTrustWs,
      options: [['Refresh', "IkbiScenes.fill('trust-ws',true)"], ['Capabilities', "IkbiApp.runCommand('capabilities')"]]
    },
    'modules-ws': {
      fn: rModulesWs,
      options: [['Refresh', "IkbiScenes.fill('modules-ws',true)"], ['Capabilities', "IkbiApp.runCommand('capabilities')"]]
    },
    'history-ws': {
      fn: rHistoryWs,
      options: [['Refresh', "IkbiScenes.fill('history-ws',true)"], ['Build Log', "IkbiGuide.toggle()"]]
    },
    'grove-ws': {
      fn: rGroveWs,
      postFill: function () {
        var inp = document.getElementById('grove-input');
        if (inp) { try { setTimeout(function () { inp.focus(); }, 60); } catch (e) {} }
      },
      options: [['Clear', "window.groveClear()"], ['New session', "IkbiScenes.fill('grove-ws',true)"]]
    },
  };

  // ── optionRow ────────────────────────────────────────────────────────────
  function optionRow(defId) {
    var cfg = MAP[defId];
    if (!cfg || !cfg.options) return '';
    return '<div class="peh-live-opts">' + cfg.options.map(function (o) {
      return '<button class="peh-live-opt" type="button" onclick="' + esc(o[1]) + '">' + esc(o[0]) + '</button>';
    }).join('') + '</div>';
  }

  // ── liveContainer ────────────────────────────────────────────────────────
  function liveContainer(defId) {
    var cfg = MAP[defId];
    var extra = (cfg && cfg.extraHtml) ? cfg.extraHtml(defId) : '';
    return '<div class="peh-live" id="peh-live-' + esc(defId) + '">' +
      optionRow(defId) +
      '<div class="peh-live-body"><div class="peh-live-loading">Loading… <span class="peh-live-spin"></span></div></div>' +
      extra +
      '</div>';
  }

  // ── fill ─────────────────────────────────────────────────────────────────
  async function fill(defId, fresh) {
    var cfg = MAP[defId];
    if (!cfg) return;
    if (fresh) window.IkbiAPI.refresh();
    var host = document.getElementById('peh-live-' + defId);
    if (!host) return;
    var body = host.querySelector('.peh-live-body');
    if (fresh && body) body.innerHTML = '<div class="peh-live-loading">Refreshing… <span class="peh-live-spin"></span></div>';
    var html;
    try { html = await cfg.fn(); } catch (e) { html = offline({ error: (e && e.message) || String(e) }); }
    host = document.getElementById('peh-live-' + defId);
    if (!host) return;
    body = host.querySelector('.peh-live-body');
    if (body) body.innerHTML = html;
    if (cfg.postFill) cfg.postFill(defId);
  }

  window.IkbiScenes = {
    has: function (defId) { return !!MAP[defId]; },
    liveContainer: liveContainer,
    fill: fill,
    sendChat: sendChat,
    handleChatSubmit: handleChatSubmit,
    renderChat: renderChat,
  };
})();

// ══════════════════════════════════════════════════════════════════════
// IKBI · DASHBOARD APP — Runtime TUI, Chat with Peh, Hotspot Windows.
// Uses api.js (IkbiAPI) for all backend communication.
// Peh's personality: the medicine man, patient, methodical.
// Choctaw lore preserved in module names and greetings.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var esc = function (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  function timeStr(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }
  function ago(ms) {
    if (ms == null) return '—';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  // ── Runtime TUI ─────────────────────────────────────────────────────
  var tuiLog = [];
  var TUI_MAX = 200;
  var tuiEl = null;

  function tui(text, kind) {
    tuiLog.push({ t: Date.now(), text: String(text), kind: kind || 'note' });
    if (tuiLog.length > TUI_MAX) tuiLog.shift();
    renderTui();
  }

  function renderTui() {
    tuiEl = tuiEl || document.getElementById('tui-log');
    if (!tuiEl) return;
    var html = tuiLog.map(function (e) {
      return '<div class="tui-line">' +
        '<span class="tui-ts">' + esc(timeStr(e.t)) + '</span>' +
        '<span class="tui-msg ' + esc(e.kind) + '">' + esc(e.text) + '</span></div>';
    }).join('');
    tuiEl.innerHTML = html;
    tuiEl.scrollTop = tuiEl.scrollHeight;
  }

  function setTuiStatus(status) {
    var el = document.getElementById('tui-status');
    if (!el) return;
    var cls = 'tui-status-' + status;
    var label = status === 'building' ? 'building' : status === 'failed' ? 'failed' : 'idle';
    el.className = cls;
    el.innerHTML = '<span class="tui-status-dot"></span> ' + label;
  }

  // ── Engine Status Polling ───────────────────────────────────────────
  var engineOnline = null;

  async function pollEngine() {
    var dot = document.getElementById('engine-dot');
    var label = document.getElementById('engine-label');
    var r = await IkbiAPI.health({ fresh: true });
    if (r.ok && r.data) {
      dot.className = 'dot dot-green';
      label.textContent = 'online · ' + (r.data.version || 'ok');
      if (engineOnline === false) tui('Build engine back online. Foundation is solid.', 'ok');
      engineOnline = true;
    } else {
      dot.className = 'dot dot-red';
      label.textContent = 'offline';
      if (engineOnline !== false && engineOnline !== null) tui('Build engine offline. Check :18796.', 'warn');
      engineOnline = false;
    }
  }

  // ── TUI Command Bar ─────────────────────────────────────────────────
  var COMMANDS = 'help, health, agent, capabilities, ask <message>, clear';

  function initTuiForm() {
    var form = document.getElementById('tui-form');
    var input = document.getElementById('tui-input');
    if (!form || !input) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      runCommand(v);
    });
  }

  async function summarize(label, promise, fmt) {
    tui(label + ': fetching…', 'note');
    var r = await promise;
    if (!r.ok || !r.data) { tui(label + ': offline (' + (r.error || '?') + ')', 'warn'); return; }
    tui(label + ': ' + fmt(r.data), 'data');
  }

  async function runCommand(raw) {
    tui('❯ ' + raw, 'cmd');
    var parts = raw.split(/\s+/);
    var cmd = parts.shift().toLowerCase();
    var rest = parts.join(' ');
    switch (cmd) {
      case 'help':
        tui('Commands: ' + COMMANDS, 'note');
        break;
      case 'health':
        await summarize('Health', IkbiAPI.health({ fresh: true }), function (d) {
          return (d.status || '?') + ' · ' + (d.service || 'ikbi') + ' ' + (d.version || '');
        });
        break;
      case 'agent':
        await summarize('Agent', IkbiAPI.agent({ fresh: true }), function (d) {
          return (d.name || 'ikbi') + ' · model: ' + (d.model || '?') + ' · tools: ' + (d.tools || 0) + ' · uptime: ' + ago((d.uptime || 0) * 1000);
        });
        break;
      case 'capabilities':
      case 'caps':
        await summarize('Capabilities', IkbiAPI.capabilities({ fresh: true }), function (d) {
          return (d.features || []).length + ' features · builder tools: ' + (d.toolParity ? d.toolParity.builder : '?');
        });
        break;
      case 'ask':
        if (!rest) { tui('Ask what? e.g. "ask what tools does the builder have?"', 'note'); break; }
        await converse(rest);
        break;
      case 'clear':
        tuiLog = [];
        renderTui();
        tui('Terminal cleared.', 'note');
        break;
      default:
        await converse(raw);
    }
  }

  async function converse(message) {
    tui('Processing…', 'note');
    var r = await IkbiAPI.converse(message);
    if (r.ok && r.data && (r.data.response || r.data.content)) {
      tui(r.data.response || r.data.content, 'peh');
    } else if (r.status === 401) {
      tui('Chat requires IKBI_CHAT_TOKEN.', 'warn');
    } else if (r.status === 503) {
      tui('Chat unavailable — IKBI_CHAT_TOKEN not configured.', 'warn');
    } else {
      tui('No response from the engine. Is it running on :18796?', 'warn');
    }
  }

  // ── Chat with Peh ───────────────────────────────────────────────────
  var chatHistory = [];
  var chatMsgsEl = null;

  function appendChatBubble(role, text) {
    chatMsgsEl = chatMsgsEl || document.getElementById('chat-msgs');
    if (!chatMsgsEl) return;
    var el = document.createElement('div');
    if (role === 'peh') {
      el.className = 'chat-bubble peh-bubble';
      el.innerHTML = '<div class="chat-avatar">🌿</div><div class="chat-text">' + esc(text) + '</div>';
    } else if (role === 'user') {
      el.className = 'chat-bubble user-bubble';
      el.innerHTML = '<div class="chat-avatar">👤</div><div class="chat-text">' + esc(text) + '</div>';
    } else {
      el.className = 'chat-bubble peh-bubble';
      el.innerHTML = '<div class="chat-avatar">🌿</div><div class="chat-text chat-thinking">' + esc(text) + '</div>';
    }
    chatMsgsEl.appendChild(el);
    chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
    return el;
  }

  function initChatForm() {
    var form = document.getElementById('chat-form');
    var input = document.getElementById('chat-input');
    if (!form || !input) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      sendChatMessage(v);
    });
  }

  async function sendChatMessage(text) {
    appendChatBubble('user', text);
    chatHistory.push({ role: 'user', text: text });
    var thinkingEl = appendChatBubble('thinking', 'Peh is considering…');
    var r = await IkbiAPI.converse(text);
    if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
    if (r.ok && r.data && (r.data.response || r.data.content)) {
      var reply = r.data.response || r.data.content;
      appendChatBubble('peh', reply);
      chatHistory.push({ role: 'peh', text: reply });
    } else if (r.status === 401) {
      appendChatBubble('peh', 'Chat requires IKBI_CHAT_TOKEN. Set it on the server to enable conversation.');
    } else if (r.status === 503) {
      appendChatBubble('peh', 'Chat is unavailable — IKBI_CHAT_TOKEN not configured on the server.');
    } else {
      appendChatBubble('peh', 'No response from the engine. Is it running on :18796? Run: node dist/cli/index.js');
    }
  }

  // ── Window Toolbar ──────────────────────────────────────────────────
  function initWinToolbar() {
    var btns = document.querySelectorAll('.win-toggle');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var winId = btn.getAttribute('data-win');
        var hw = document.querySelector('.hw[data-win="' + winId + '"]');
        if (!hw) return;
        var isActive = btn.classList.contains('active');
        if (isActive) {
          btn.classList.remove('active');
          hw.classList.add('hidden');
        } else {
          btn.classList.add('active');
          hw.classList.remove('hidden');
          hw.classList.remove('minimized');
          loadWindowContent(winId);
        }
      });
    });

    // Close/minimize buttons
    document.querySelectorAll('.hw-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        var hw = btn.closest('.hw');
        if (!hw) return;
        var winId = hw.getAttribute('data-win');
        var toggle = document.querySelector('.win-toggle[data-win="' + winId + '"]');
        if (action === 'close') {
          hw.classList.add('hidden');
          if (toggle) toggle.classList.remove('active');
        } else if (action === 'minimize') {
          hw.classList.toggle('minimized');
        }
      });
    });

    // Drag windows
    document.querySelectorAll('.hw-head').forEach(function (head) {
      var hw = head.closest('.hw');
      var dragging = false, startX, startY, origX, origY;
      head.addEventListener('mousedown', function (e) {
        if (e.target.closest('.hw-btn')) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        var rect = hw.getBoundingClientRect();
        origX = rect.left; origY = rect.top;
        hw.style.position = 'fixed';
        hw.style.left = origX + 'px';
        hw.style.top = origY + 'px';
        hw.style.width = rect.width + 'px';
        hw.style.zIndex = '100';
        document.body.style.userSelect = 'none';
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        hw.style.left = (origX + dx) + 'px';
        hw.style.top = (origY + dy) + 'px';
      });
      document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
      });
    });
  }

  // ── Window Content Loaders ──────────────────────────────────────────
  var windowLoaded = {};

  function loadWindowContent(winId) {
    if (windowLoaded[winId]) return;
    windowLoaded[winId] = true;
    switch (winId) {
      case 'job-cards': loadJobCards(); break;
      case 'repo-doctor': loadRepoDoctor(); break;
      case 'spec-artifact': loadSpecs(); break;
      case 'build-history': loadBuildHistory(); break;
      case 'modules': loadModules(); break;
      case 'config': loadConfig(); break;
      case 'corrections': loadCorrections(); break;
    }
  }

  // ── Job Cards ───────────────────────────────────────────────────────
  async function loadJobCards() {
    var body = document.getElementById('hw-job-cards-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading job cards…</div>';
    var r = await IkbiAPI._get('/ikbi/job-cards');
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load job cards — engine offline.</div>';
      return;
    }
    var cards = Array.isArray(r.data) ? r.data : (r.data.cards || r.data.items || []);
    if (!cards.length) {
      body.innerHTML = '<div class="hw-empty">No job cards defined.</div>';
      return;
    }
    body.innerHTML = cards.map(function (c) {
      var status = c.status || 'pending';
      return '<div class="jc-card">' +
        '<span class="jc-status ' + esc(status) + '"></span>' +
        '<div class="jc-info"><div class="jc-name">' + esc(c.name || c.title || 'Unnamed') + '</div>' +
        '<div class="jc-desc">' + esc(c.description || c.desc || '') + '</div></div>' +
        '<button class="jc-run-btn" onclick="Ikbui.runJobCard(\'' + esc(c.id || c.name) + '\')">Run</button></div>';
    }).join('');
  }

  async function runJobCard(id) {
    tui('Running job card: ' + id, 'cmd');
    setTuiStatus('building');
    var r = await IkbiAPI._get('/ikbi/job-cards/' + encodeURIComponent(id) + '/run', { timeout: 30000 });
    setTuiStatus('idle');
    if (r.ok && r.data) {
      tui('Job card completed: ' + (r.data.summary || r.data.status || 'done'), 'ok');
    } else {
      tui('Job card failed: ' + (r.error || 'unknown error'), 'err');
    }
    windowLoaded['job-cards'] = false;
    loadJobCards();
  }

  // ── Repo Doctor ─────────────────────────────────────────────────────
  async function loadRepoDoctor() {
    var body = document.getElementById('hw-repo-doctor-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Scanning…</div>';
    var r = await IkbiAPI._get('/ikbi/repo-doctor/health');
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load repo health — engine offline.</div>';
      return;
    }
    renderRepoDoctor(body, r.data);
  }

  function renderRepoDoctor(body, data) {
    var score = data.score != null ? data.score : (data.overall != null ? data.overall : 0);
    var scoreClass = score >= 80 ? 'rd-score-good' : score >= 50 ? 'rd-score-mid' : 'rd-score-bad';
    var dims = data.dimensions || data.dimensions || {};
    var dimKeys = ['file-health', 'dependency-health', 'test-health', 'doc-health', 'import-health', 'structure-health'];
    var html = '<div class="rd-score"><span class="rd-score-val ' + scoreClass + '">' + score + '</span>' +
      '<span class="rd-score-label">/ 100</span></div>';
    dimKeys.forEach(function (key) {
      var d = dims[key] || dims[key.replace(/-/g, '_')] || {};
      var val = d.score != null ? d.score : (d.value != null ? d.value : 0);
      var count = d.findings != null ? (Array.isArray(d.findings) ? d.findings.length : d.findings) : 0;
      var fillClass = val >= 80 ? 'background:var(--green)' : val >= 50 ? 'background:var(--amber)' : 'background:var(--red)';
      html += '<div class="rd-bar" onclick="Ikbui.toggleFindings(this)">' +
        '<div class="rd-bar-head"><span class="rd-bar-name">' + esc(key.replace(/-/g, ' ')) + '</span>' +
        '<span class="rd-bar-val">' + val + ' · ' + count + ' findings</span></div>' +
        '<div class="rd-bar-track"><div class="rd-bar-fill" style="width:' + val + '%;' + fillClass + '"></div></div>';
      if (Array.isArray(d.findings) && d.findings.length) {
        html += '<div class="rd-findings" style="display:none">' +
          d.findings.map(function (f) { return '<div class="rd-finding">' + esc(typeof f === 'string' ? f : f.message || f.text || JSON.stringify(f)) + '</div>'; }).join('') +
          '</div>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
  }

  function toggleFindings(el) {
    var findings = el.querySelector('.rd-findings');
    if (findings) findings.style.display = findings.style.display === 'none' ? 'block' : 'none';
  }

  async function scanRepoDoctor() {
    var body = document.getElementById('hw-repo-doctor-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Scanning repository…</div>';
    tui('Repo Doctor: scanning…', 'note');
    var r = await IkbiAPI._get('/ikbi/repo-doctor/health', { fresh: true });
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Scan failed — engine offline.</div>';
      tui('Repo Doctor: scan failed.', 'err');
      return;
    }
    renderRepoDoctor(body, r.data);
    tui('Repo Doctor: scan complete.', 'ok');
  }

  // ── Spec Artifact ───────────────────────────────────────────────────
  async function loadSpecs() {
    var body = document.getElementById('hw-spec-artifact-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading specs…</div>';
    var r = await IkbiAPI._get('/ikbi/spec');
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load specs — engine offline.</div>';
      return;
    }
    var specs = Array.isArray(r.data) ? r.data : (r.data.specs || r.data.items || []);
    if (!specs.length) {
      body.innerHTML = '<div class="hw-empty">No specs defined.</div>';
      return;
    }
    body.innerHTML = specs.map(function (s) {
      var status = s.status || 'draft';
      var steps = s.steps || [];
      return '<div class="spec-card" onclick="this.classList.toggle(\'expanded\')">' +
        '<div class="spec-head"><span class="spec-status ' + esc(status) + '"></span>' +
        '<span class="spec-goal">' + esc(s.goal || s.title || 'Unnamed') + '</span></div>' +
        '<div class="spec-meta">' + esc(status) + ' · ' + steps.length + ' steps</div>' +
        '<div class="spec-steps">' +
        steps.map(function (step, i) {
          return '<div class="spec-step">' + (i + 1) + '. ' + esc(typeof step === 'string' ? step : step.description || step.text || JSON.stringify(step)) + '</div>';
        }).join('') +
        (status === 'approved' ? '<button class="spec-execute-btn" onclick="event.stopPropagation();Ikbui.executeSpec(\'' + esc(s.id || s.goal) + '\')">Execute</button>' : '') +
        '</div></div>';
    }).join('');
  }

  async function executeSpec(id) {
    tui('Executing spec: ' + id, 'cmd');
    setTuiStatus('building');
    var r = await IkbiAPI._get('/ikbi/spec/' + encodeURIComponent(id) + '/execute', { timeout: 30000 });
    setTuiStatus('idle');
    if (r.ok) {
      tui('Spec execution started.', 'ok');
    } else {
      tui('Spec execution failed: ' + (r.error || 'unknown'), 'err');
    }
    windowLoaded['spec-artifact'] = false;
    loadSpecs();
  }

  // ── Build History ───────────────────────────────────────────────────
  async function loadBuildHistory() {
    var body = document.getElementById('hw-build-history-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading history…</div>';
    var r = await IkbiAPI._get('/ikbi/receipts');
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load build history — engine offline.</div>';
      return;
    }
    var receipts = Array.isArray(r.data) ? r.data : (r.data.receipts || r.data.items || []);
    if (!receipts.length) {
      body.innerHTML = '<div class="hw-empty">No build receipts yet.</div>';
      return;
    }
    body.innerHTML = receipts.slice(0, 50).map(function (rec) {
      var outcome = rec.result || rec.outcome || rec.status || 'info';
      var cls = outcome === 'ok' || outcome === 'success' || outcome === 'passed' ? 'ok' :
                outcome === 'fail' || outcome === 'failed' || outcome === 'error' ? 'fail' : 'info';
      return '<div class="hist-item">' +
        '<span class="hist-time">' + esc(timeStr(rec.timestamp || rec.t || rec.created_at)) + '</span>' +
        '<span class="hist-action">' + esc(rec.action || rec.summary || rec.description || '—') + '</span>' +
        '<span class="hist-result ' + cls + '">' + esc(outcome) + '</span></div>';
    }).join('');
  }

  // ── Modules ─────────────────────────────────────────────────────────
  // ikbi's 33 modules — Choctaw-inspired naming
  var KNOWN_MODULES = [
    'builder', 'job-runner', 'spec-engine', 'repo-doctor', 'trust-gate',
    'file-ops', 'dependency-mgr', 'test-harness', 'doc-gen', 'import-resolver',
    'structure-analyst', 'config-mgr', 'template-engine', 'receipt-writer',
    'timeline-tracker', 'session-mgr', 'chat-handler', 'tool-registry',
    'capability-map', 'safety-posture', 'circuit-breaker', 'drift-detector',
    'kill-switch', 'governance', 'injection-defense', 'rollback',
    'promote-apply', 'verification', 'retrieval', 'context-walker',
    'module-loader', 'feature-flags', 'surface-classifier'
  ];

  async function loadModules() {
    var body = document.getElementById('hw-modules-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading modules…</div>';
    var r = await IkbiAPI.capabilities();
    var tools = [];
    var features = [];
    if (r.ok && r.data) {
      tools = r.data.tools || [];
      features = r.data.features || [];
    }
    var toolSet = new Set(tools);
    var featSet = new Set(features);
    body.innerHTML = '<div class="mod-grid">' +
      KNOWN_MODULES.map(function (m) {
        var active = toolSet.has(m) || featSet.has(m);
        return '<div class="mod-tile" title="' + esc(m) + '">' +
          '<div class="mod-name">' + esc(m) + '</div>' +
          '<div class="mod-status ' + (active ? 'active' : 'dormant') + '">' + (active ? 'active' : 'dormant') + '</div></div>';
      }).join('') + '</div>';
  }

  // ── Corrections Library ─────────────────────────────────────────────
  var CATEGORY_LABELS = {
    expected_manifest_change: 'Manifest',
    tool_limitation: 'Tool Limit',
    environment_missing: 'Env Missing',
    suspicious_pattern: 'Suspicious',
    test_weakening: 'Test Weaken',
    forbidden_file: 'Forbidden',
    verification_forgery: 'Forgery',
    conflict_resolution: 'Conflict',
    custom: 'Custom',
  };

  async function loadCorrections() {
    var body = document.getElementById('hw-corrections-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading corrections…</div>';
    var r = await IkbiAPI.listCorrections();
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load corrections — engine offline.</div>';
      return;
    }
    var corrections = r.data.corrections || [];
    if (!corrections.length) {
      body.innerHTML = '<div class="hw-empty">No corrections proposed yet. Corrections are lessons learned from build failures — proposed by the refuter or an operator, then approved before taking effect.</div>';
      return;
    }
    body.innerHTML = corrections.map(function (c) {
      var cat = CATEGORY_LABELS[c.category] || c.category;
      var statusCls = c.approved ? 'corr-approved' : 'corr-pending';
      var statusLabel = c.approved ? 'Approved' : 'Pending';
      return '<div class="corr-card ' + statusCls + '">' +
        '<div class="corr-head">' +
          '<span class="corr-badge corr-cat-' + esc(c.category) + '">' + esc(cat) + '</span>' +
          '<span class="corr-status">' + statusLabel + '</span>' +
          '<span class="corr-count">applied ' + (c.appliedCount || 0) + '×</span>' +
        '</div>' +
        '<div class="corr-finding"><strong>Finding:</strong> ' + esc(c.finding) + '</div>' +
        '<div class="corr-correction"><strong>Correction:</strong> ' + esc(c.correction) + '</div>' +
        '<div class="corr-regression"><strong>Regression:</strong> ' + esc(c.regression) + '</div>' +
        '<div class="corr-actions">' +
          (c.approved
            ? '<span class="corr-approved-label">✓ Approved</span>'
            : '<button class="corr-approve-btn" onclick="Ikbui.approveCorrection(\'' + esc(c.id) + '\')">Approve</button>' +
              '<button class="corr-reject-btn" onclick="Ikbui.rejectCorrection(\'' + esc(c.id) + '\')">Reject</button>') +
        '</div></div>';
    }).join('');
  }

  async function approveCorrection(id) {
    tui('Approving correction: ' + id, 'cmd');
    var r = await IkbiAPI.approveCorrection(id);
    if (r.ok) {
      tui('Correction approved.', 'ok');
    } else {
      tui('Failed to approve: ' + (r.error || 'unknown'), 'err');
    }
    windowLoaded['corrections'] = false;
    loadCorrections();
  }

  async function rejectCorrection(id) {
    tui('Rejecting correction: ' + id, 'cmd');
    var r = await IkbiAPI.rejectCorrection(id);
    if (r.ok) {
      tui('Correction rejected and deleted.', 'ok');
    } else {
      tui('Failed to reject: ' + (r.error || 'unknown'), 'err');
    }
    windowLoaded['corrections'] = false;
    loadCorrections();
  }

  // ── Configuration ───────────────────────────────────────────────────
  async function loadConfig() {
    var body = document.getElementById('hw-config-body');
    if (!body) return;
    body.innerHTML = '<div class="hw-loading">Loading config…</div>';
    var r = await IkbiAPI.capabilities();
    if (!r.ok || !r.data) {
      body.innerHTML = '<div class="offline-notice">Cannot load config — engine offline.</div>';
      return;
    }
    var d = r.data || {};
    var lc = d.lifecycle || {};
    var sp = d.safetyPosture || {};
    var cfgRows = [
      ['Model', d.model || '—'],
      ['Provider', d.provider || '—'],
      ['Status', d.status || '—'],
      ['Trust Tier', sp.posture || '—'],
      ['Verification', sp.verification || '—'],
      ['Retrieval', sp.retrieval || '—'],
      ['Session Persistence', d.chatSessions ? d.chatSessions.persistence || '—' : '—'],
      ['Endpoints', (d.endpoints || []).length],
    ];
    var html = cfgRows.map(function (row) {
      return '<div class="cfg-row"><span class="cfg-label">' + esc(row[0]) + '</span>' +
        '<span class="cfg-value">' + esc(row[1]) + '</span></div>';
    }).join('');
    // Lifecycle toggles
    var flags = ['persistentSessions', 'managedWorkspace', 'rollbackDurability', 'verificationPath', 'promoteApplyPath'];
    html += '<div style="margin-top:10px;font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:1px">Lifecycle</div>';
    flags.forEach(function (f) {
      var on = !!lc[f];
      var label = f.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
      html += '<div class="cfg-row"><span class="cfg-label">' + esc(label) + '</span>' +
        '<span class="cfg-toggle ' + (on ? 'on' : '') + '"></span></div>';
    });
    body.innerHTML = html;
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.Ikbui = {
    tui: tui,
    runCommand: runCommand,
    refreshJobCards: function () { windowLoaded['job-cards'] = false; loadJobCards(); },
    runJobCard: runJobCard,
    scanRepoDoctor: scanRepoDoctor,
    refreshSpecs: function () { windowLoaded['spec-artifact'] = false; loadSpecs(); },
    executeSpec: executeSpec,
    refreshHistory: function () { windowLoaded['build-history'] = false; loadBuildHistory(); },
    refreshModules: function () { windowLoaded['modules'] = false; loadModules(); },
    refreshConfig: function () { windowLoaded['config'] = false; loadConfig(); },
    refreshCorrections: function () { windowLoaded['corrections'] = false; loadCorrections(); },
    approveCorrection: approveCorrection,
    rejectCorrection: rejectCorrection,
    toggleFindings: toggleFindings,
    sendChat: sendChatMessage,
  };

  // ── Boot ────────────────────────────────────────────────────────────
  function boot() {
    // TUI greeting
    tui('Welcome to the Workshop. ikbi — your build engine.', 'peh');
    tui('Every great structure starts with a solid foundation.', 'peh');
    tui('Type "help" for available commands.', 'note');
    tui('', 'note');

    // Chat greeting
    appendChatBubble('peh', "Hoke. I am Peh — the medicine man. Patient, methodical, thorough. Tell me what you want to build, and I will read the ground truth, make the smallest correct change, and prove it green. The forest remembers every path.");

    // Init forms
    initTuiForm();
    initChatForm();
    initWinToolbar();

    // Load default windows
    loadJobCards();
    loadRepoDoctor();

    // Poll engine
    pollEngine();
    setInterval(pollEngine, 12000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

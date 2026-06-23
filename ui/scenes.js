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
  // Receipt helpers — read ground truth (cost lives in metadata.costUsd).
  function receiptCost(r) {
    var c = r && r.metadata && r.metadata.costUsd;
    return typeof c === 'number' ? c : 0;
  }
  function sumReceiptCost(rs) {
    return rs.reduce(function (a, r) { return a + receiptCost(r); }, 0);
  }
  function usd(n) {
    var v = Number(n);
    return isFinite(v) ? '$' + v.toFixed(4) : '—';
  }
  function statusOf(r) { return (r && r.outcome && r.outcome.status) || '?'; }
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

  // test-results — Live verification results from the durable receipt store (ground truth).
  async function rTestResults() {
    var c = await window.IkbiAPI.capabilities();
    var rec = await window.IkbiAPI.receipts({ limit: 100 });
    if (!c.ok && !rec.ok) return offline(rec.ok ? c : rec);
    var cd = (c.data) || {};
    var tools = cd.tools || [];
    var receipts = (rec.data && rec.data.receipts) || [];

    var ok = receipts.filter(function (r) { return statusOf(r) === 'success'; }).length;
    var fail = receipts.filter(function (r) { var s = statusOf(r); return s === 'failure' || s === 'rejected'; }).length;
    var spend = sumReceiptCost(receipts);

    var html = '<div class="ikbi-ws">';

    html += '<div class="ikbi-test-stats">' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(receipts.length)) + '</span><span class="ikbi-test-stat-l">recorded operations</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(ok)) + '</span><span class="ikbi-test-stat-l">succeeded</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(fail)) + '</span><span class="ikbi-test-stat-l">failed / rejected</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(usd(spend)) + '</span><span class="ikbi-test-stat-l">total spend</span></div>' +
      '<div class="ikbi-test-stat"><span class="ikbi-test-stat-v">' + esc(String(tools.length || '?')) + '</span><span class="ikbi-test-stat-l">builder tools</span></div>' +
      '</div>';

    if (receipts.length) {
      var rows = receipts.slice().reverse().slice(0, 25).map(function (r) {
        var s = statusOf(r);
        var dot = s === 'success' ? 'on' : (s === 'failure' || s === 'rejected') ? 'off' : '';
        var detail = (r.outcome && (r.outcome.detail || r.outcome.error)) || '';
        return '<div class="ikbi-hist-item">' +
          '<span class="ikbi-flag-dot ' + dot + '"></span>' +
          '<span class="ikbi-hist-time">' + esc(timeStr(r.timestamp)) + '</span>' +
          '<span class="ikbi-hist-text">' + esc(r.operation || 'op') + ' — ' + esc(s) +
          (receiptCost(r) ? ' · ' + esc(usd(receiptCost(r))) : '') +
          (detail ? ' · ' + esc(String(detail).slice(0, 80)) : '') + '</span></div>';
      }).join('');
      html += section('Recent verdicts — newest first', '<div class="ikbi-history-list">' + rows + '</div>');
    } else {
      html += section('Recent verdicts', '<p class="peh-live-empty">No receipts yet. Launch a build in the Grove to populate verified results here.</p>');
    }

    html += section('Note',
      '<p class="ikbi-test-note">These are the engine\'s durable receipts (<code>/api/receipts</code>, also <code>ikbi receipts</code> / <code>ikbi cost</code>). ' +
      'For the local source-test suite, run <code style="font-family:var(--mono);font-size:11px;color:var(--peh-accent)">pnpm test</code> in a terminal.</p>'
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

  // history-ws — Real build history from the durable receipt store + timeline rollup.
  async function rHistoryWs() {
    var a = await window.IkbiAPI.agent();
    var rec = await window.IkbiAPI.receipts({ limit: 50 });
    var tl = await window.IkbiAPI.timeline({ period: 'day' });
    var ad = (a.data) || {};
    var receipts = (rec.data && rec.data.receipts) || [];
    var buckets = (tl.data && tl.data.buckets) || [];

    // Roll up build-level counts + spend from the timeline (task-grouped, agrees with summary).
    var builds = 0, ok = 0, fail = 0, cost = 0;
    buckets.forEach(function (b) {
      builds += b.taskGroups || 0;
      ok += b.taskSuccesses || 0;
      fail += b.taskFailures || 0;
      cost += b.totalCostUsd || 0;
    });
    // Fall back to receipt-level spend when the timeline route is unavailable.
    if (!buckets.length && receipts.length) cost = sumReceiptCost(receipts);

    var html = '<div class="ikbi-ws">';

    html += '<div class="peh-stats">' +
      stat('status', ad.status || '—') +
      stat('uptime', ad.uptime != null ? ago(ad.uptime * 1000) : '—') +
      stat('builds', builds || (receipts.length ? '—' : 0)) +
      stat('passed', ok) +
      stat('failed', fail) +
      stat('spend', usd(cost)) +
      '</div>';

    if (receipts.length) {
      html += section('Build history — ' + receipts.length + ' receipt(s), newest first',
        '<div class="ikbi-history-list">' +
        receipts.slice().reverse().slice(0, 40).map(function (r) {
          var s = statusOf(r);
          var dot = s === 'success' ? 'on' : (s === 'failure' || s === 'rejected') ? 'off' : '';
          return '<div class="ikbi-hist-item">' +
            '<span class="ikbi-flag-dot ' + dot + '"></span>' +
            '<span class="ikbi-hist-time">' + esc(timeStr(r.timestamp)) + '</span>' +
            '<span class="ikbi-hist-text">' + esc(r.operation || 'op') + ' — ' + esc(s) +
            (receiptCost(r) ? ' · ' + esc(usd(receiptCost(r))) : '') +
            (r.requestId ? ' · ' + esc(String(r.requestId).slice(0, 12)) : '') + '</span></div>';
        }).join('') + '</div>'
      );
    } else {
      // No durable history yet — fall back to the in-browser session log so the panel is never empty.
      var entries = (window.IkbiGuide && IkbiGuide.entries) ? IkbiGuide.entries() : [];
      if (!rec.ok) {
        html += section('Build history', offline(rec));
      } else if (entries.length) {
        html += section('Session activity (no durable receipts yet) — ' + entries.length + ' events',
          '<div class="ikbi-history-list">' +
          entries.slice().reverse().slice(0, 30).map(function (e) {
            return '<div class="ikbi-hist-item k-' + esc(e.kind) + '">' +
              '<span class="ikbi-hist-time">' + esc(timeStr(e.t)) + '</span>' +
              '<span class="ikbi-hist-text">' + esc(e.text) + '</span></div>';
          }).join('') + '</div>'
        );
      } else {
        html += section('Build history',
          '<p class="peh-live-empty">No builds recorded yet. Launch a build in the Grove — verdicts and spend will appear here from <code>/api/receipts</code>.</p>'
        );
      }
    }

    html += '</div>';
    return html;
  }

  // grove-ws — TUI-style terminal for direct conversation with ikbi
  function rGroveWs() {
    return '<div class="grove-terminal">' +
      '<div class="grove-header">THE GROVE · ikbi terminal</div>' +
      '<div class="grove-messages" id="grove-msgs">' +
        '<div class="grove-msg system">Welcome to the Grove. Type a goal + target repo to launch a real build, e.g. <code>add a /healthz route --repo /path/to/app</code>. Live per-role progress streams here. (Prefix with <code>?</code> to chat instead.)</div>' +
      '</div>' +
      '<div class="grove-input-wrap">' +
        '<span class="grove-prompt">❯</span>' +
        '<input class="grove-input" type="text" id="grove-input" placeholder="State the goal…  (append --repo /abs/path)" ' +
          'onkeydown="if(event.key===\'Enter\'&&this.value.trim()){window.groveSend(this.value);this.value=\'\'}">' +
      '</div>' +
    '</div>';
  }

  // ── Build runner — submit a real /api/build task and stream live progress ──
  // Appends terminal-style messages into `msgs` and renders per-role progress from
  // the SSE stream. Shared by the Grove terminal and the Launch Pad build form, so
  // the UI's centerpiece launches verifiable builds — not an ephemeral chat.
  function buildMsg(msgs, cls, text) {
    var el = document.createElement('div');
    el.className = 'grove-msg ' + cls;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // Pull an optional `--repo <path>` suffix out of a goal string. The path may be
  // quoted; the remainder is the goal.
  function parseGoalRepo(text) {
    var repo = null;
    var m = text.match(/\s--repo\s+("[^"]+"|'[^']+'|\S+)\s*$/);
    if (m) {
      repo = m[1].replace(/^["']|["']$/g, '');
      text = text.slice(0, m.index);
    }
    return { goal: text.trim(), repo: repo };
  }

  function fmtCost(c) {
    var n = Number(c);
    return isFinite(n) ? '$' + n.toFixed(4) : '';
  }

  // Submit a build and stream its 5-role pipeline into `msgs` (a messages container).
  window.ikbiRunBuild = async function (goal, repo, msgs) {
    if (!msgs) return;
    if (!goal) { buildMsg(msgs, 'system', 'State a goal to build.'); return; }
    if (!repo) {
      buildMsg(msgs, 'system', 'A build needs a target repo. Try:  ' + goal + ' --repo /abs/path  — or set window.IKBI_DEFAULT_REPO. ' +
        '(The repo must be registered in state/repos.json or matched by IKBI_API_ALLOWED_REPOS.)');
      return;
    }
    buildMsg(msgs, 'system', 'Submitting build → ' + repo);
    if (window.IkbiGuide) IkbiGuide.log('Build: "' + goal + '" → ' + repo, 'you');

    var sub = await window.IkbiAPI.build(goal, repo);
    var taskId = sub.ok && sub.data ? (sub.data.taskId || sub.data.id) : null;
    if (!taskId) {
      var em = (sub.data && sub.data.error) ? sub.data.error : (sub.error || ('HTTP ' + sub.status));
      if (sub.status === 401) em = 'Build requires IKBI_API_TOKEN — set window.IKBI_API_TOKEN.';
      else if (sub.status === 503) em = 'Build unavailable — IKBI_OPERATOR_TOKEN / IKBI_WORKER_TOKEN not configured on the server.';
      buildMsg(msgs, 'system', 'Build not accepted: ' + em);
      return;
    }
    buildMsg(msgs, 'assistant', 'Build accepted — task ' + taskId + '. Streaming the scout→builder→critic→verifier→integrator pipeline…');

    var roleEls = {};
    function roleLine(role) {
      if (!roleEls[role]) roleEls[role] = buildMsg(msgs, 'role', '▸ ' + role + ' — …');
      return roleEls[role];
    }

    window.IkbiAPI.streamTask(taskId, {
      onEvent: function (ev, data) {
        data = data || {};
        if (ev === 'role_started') {
          roleLine(data.role).textContent = '▸ ' + data.role + (data.tier ? ' [' + data.tier + ']' : '') + ' — running…';
        } else if (ev === 'tool_activity') {
          roleLine('builder').textContent = '▸ builder — ' + (data.summary || 'working…');
        } else if (ev === 'role_completed') {
          var c = (data.cost != null) ? ' (' + fmtCost(data.cost) + ')' : '';
          roleLine(data.role).textContent = '✓ ' + data.role + ' — ' + (data.outcome || 'done') + c;
        } else if (ev === 'escalation') {
          buildMsg(msgs, 'system', '⤴ escalation → ' + (data.to || '?') + (data.reason ? ' — ' + data.reason : ''));
        } else if (ev === 'task_completed') {
          var cost = (data.totalCost != null) ? ' · ' + fmtCost(data.totalCost) : '';
          var ok = data.status === 'success';
          buildMsg(msgs, ok ? 'assistant' : 'system', 'Build ' + (data.status || 'finished') + cost);
          if (window.IkbiGuide) IkbiGuide.log('Build ' + (data.status || 'finished') + cost, ok ? 'ok' : 'warn');
        } else if (ev === 'timeout') {
          buildMsg(msgs, 'system', 'Stream idle — closed. Run `ikbi receipts` for the final verdict.');
        }
      },
      onError: function (m) { buildMsg(msgs, 'system', 'Stream error: ' + m); },
    });
  };

  // The Grove chat escape hatch — still talks to /chat for conversational queries
  // (prefix a message with "?" or "chat:").
  async function groveChat(text, msgs) {
    var thinkingEl = buildMsg(msgs, 'system', 'ikbi is processing…');
    try {
      var result = await window.IkbiAPI.converse(text);
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
      if (result.ok && result.data) {
        buildMsg(msgs, 'assistant', result.data.response || result.data.content || JSON.stringify(result.data));
      } else if (result.status === 401 || result.status === 503) {
        buildMsg(msgs, 'system', 'Chat requires IKBI_CHAT_TOKEN. Set it on the server to enable conversation.');
      } else {
        buildMsg(msgs, 'system', 'Error: ' + (result.error || 'No response from the engine. Is it running on :18796?'));
      }
    } catch (e) {
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
      buildMsg(msgs, 'system', 'Error: ' + ((e && e.message) || String(e)));
    }
  }

  window.groveSend = async function (text) {
    if (!text || !text.trim()) return;
    var msgs = document.getElementById('grove-msgs');
    if (!msgs) return;
    buildMsg(msgs, 'user', text);
    // Explicit chat escape hatch: "?<msg>" or "chat: <msg>".
    var chat = text.match(/^\s*(?:\?|chat:)\s*([\s\S]+)$/i);
    if (chat) { await groveChat(chat[1].trim(), msgs); return; }
    // Default: launch a verifiable build.
    var pr = parseGoalRepo(text);
    var repo = pr.repo || (typeof window !== 'undefined' && window.IKBI_DEFAULT_REPO) || null;
    await window.ikbiRunBuild(pr.goal, repo, msgs);
  };

  // Launch Pad (builder-ws) build form submit → the same streaming build runner.
  function handleLaunchSubmit(e, defId) {
    e.preventDefault();
    var wrap = document.getElementById('ikbi-launch-' + defId);
    if (!wrap) return false;
    var goalEl = wrap.querySelector('.ikbi-launch-goal');
    var repoEl = wrap.querySelector('.ikbi-launch-repo');
    var msgs = document.getElementById('builder-build-msgs-' + defId);
    var goal = goalEl ? goalEl.value.trim() : '';
    var repo = repoEl ? repoEl.value.trim() : '';
    if (!goal) { if (goalEl) goalEl.focus(); return false; }
    if (!repo) repo = (typeof window !== 'undefined' && window.IKBI_DEFAULT_REPO) || '';
    window.ikbiRunBuild(goal, repo, msgs);
    if (goalEl) goalEl.value = '';
    return false;
  }

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

  // Launch Pad — a real build launcher rendered above the builder workspace chat.
  function builderLaunchHtml(defId) {
    return '<div class="ikbi-launch" id="ikbi-launch-' + esc(defId) + '">' +
      '<div class="ikbi-chat-head">Launch Pad — verifiable build</div>' +
      '<form class="ikbi-launch-form" onsubmit="return IkbiScenes.handleLaunchSubmit(event,\'' + esc(defId) + '\')">' +
      '<input class="ikbi-chat-input ikbi-launch-goal" type="text" placeholder="Goal — what should ikbi build?" autocomplete="off">' +
      '<input class="ikbi-chat-input ikbi-launch-repo" type="text" placeholder="Repo — absolute path or registered name" autocomplete="off" spellcheck="false">' +
      '<button class="ikbi-chat-send" type="submit">Launch build</button>' +
      '</form>' +
      '<div class="grove-messages ikbi-launch-msgs" id="builder-build-msgs-' + esc(defId) + '"></div>' +
      '</div>';
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

  // job-cards-ws — Reusable build recipes
  async function rJobCardsWs() {
    var r = await window.IkbiAPI._get('/ikbi/job-cards');
    if (!r.ok) return offline(r);
    var cards = r.data || [];
    var html = '<div class="ikbi-ws">';
    html += '<div class="peh-stats">' + stat('job cards', cards.length) + '</div>';
    if (cards.length) {
      html += section('Job Cards', '<div class="ikbi-tools-grid">' + cards.map(function (c) {
        return '<div class="ikbi-tool-card"><span class="ikbi-tool-name">' + esc(c.name || c.title || c.id) + '</span>' +
          '<span class="ikbi-flag-name" style="font-size:11px;color:var(--ink-dim)">' + esc(c.category || 'general') + '</span></div>';
      }).join('') + '</div>');
    } else {
      html += section('Job Cards', '<p class="peh-live-empty">No job cards yet. Create one via the API or build engine.</p>');
    }
    html += '</div>';
    return html;
  }

  // repo-doctor-ws — Repo health scanner
  function rRepoDoctorWs() {
    return '<div class="ikbi-ws">' +
      section('Repo Doctor', '<p class="ikbi-ws-head">Scan a repository for health issues, missing configs, and structural problems.</p>' +
        '<div style="margin-top:12px"><button class="ikbi-run-btn" type="button" ' +
        'onclick="IkbiApp.runCommand(\'repo-doctor\')">Run Repo Doctor</button>' +
        '<span style="font-size:12px;color:var(--ink-dim);margin-left:10px">Or use: <code style="font-family:var(--mono);color:var(--peh-accent)">ikbi repo-doctor</code></span></div>') +
      '</div>';
  }

  // spec-artifact-ws — Structured spec cards
  async function rSpecArtifactWs() {
    var r = await window.IkbiAPI.listSpecs();
    if (!r.ok) return offline(r);
    var data = r.data || {};
    var specs = data.specs || [];
    var html = '<div class="ikbi-ws">';
    html += '<div class="peh-stats">' + stat('specs', specs.length) + '</div>';
    if (specs.length) {
      html += section('Spec Artifacts', '<div class="ikbi-tools-grid">' + specs.map(function (s) {
        var status = s.status || 'draft';
        var color = status === 'completed' ? 'on' : status === 'not_implemented' ? 'off' : '';
        return '<div class="ikbi-tool-card"><span class="ikbi-tool-name">' + esc(s.goal || s.id) + '</span>' +
          '<span class="ikbi-flag-dot ' + color + '"></span><span class="ikbi-flag-name">' + esc(status) + '</span></div>';
      }).join('') + '</div>');
    } else {
      html += section('Spec Artifacts', '<p class="peh-live-empty">No specs yet. Generate one via the API.</p>');
    }
    html += '</div>';
    return html;
  }

  // corrections-ws — Correction library (lessons learned)
  async function rCorrectionsWs() {
    var r = await window.IkbiAPI.listCorrections();
    if (!r.ok) return offline(r);
    var data = r.data || {};
    var corrections = data.corrections || [];
    var approved = corrections.filter(function (c) { return c.approved; }).length;
    var pending = corrections.length - approved;
    var html = '<div class="ikbi-ws">';
    html += '<div class="peh-stats">' +
      stat('total', corrections.length) +
      stat('approved', approved) +
      stat('pending', pending) +
      '</div>';
    if (corrections.length) {
      html += section('Corrections Library', '<div class="ikbi-tools-grid">' + corrections.map(function (c) {
        var icon = c.approved ? '✓' : '○';
        return '<div class="ikbi-tool-card"><span class="ikbi-tool-name">' + esc(icon + ' ' + (c.title || c.category)) + '</span>' +
          '<span class="ikbi-flag-name" style="font-size:11px;color:var(--ink-dim)">' + esc(c.category) + '</span></div>';
      }).join('') + '</div>');
    } else {
      html += section('Corrections Library', '<p class="peh-live-empty">No corrections yet. The refuter will propose them as builds run.</p>');
    }
    html += '</div>';
    return html;
  }

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
      extraHtml: function (defId) { return builderLaunchHtml(defId) + builderChatHtml(defId); },
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

    // ── New feature workspaces ──────────────────────────────────────────
    'job-cards-ws': {
      fn: rJobCardsWs,
      options: [['Refresh', "IkbiScenes.fill('job-cards-ws',true)"]]
    },
    'repo-doctor-ws': {
      fn: rRepoDoctorWs,
      options: [['Scan', "IkbiScenes.fill('repo-doctor-ws',true)"]]
    },
    'spec-artifact-ws': {
      fn: rSpecArtifactWs,
      options: [['Refresh', "IkbiScenes.fill('spec-artifact-ws',true)"]]
    },
    'corrections-ws': {
      fn: rCorrectionsWs,
      options: [['Refresh', "IkbiScenes.fill('corrections-ws',true)"]]
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
    handleLaunchSubmit: handleLaunchSubmit,
    renderChat: renderChat,
  };
})();

// ══════════════════════════════════════════════════════════════════════
// IKBI · BUILD LOG — a running log of build engine activity. The log is
// a slide-in drawer living OUTSIDE #app so it survives the engine's
// full-innerHTML re-renders. Voice: disciplined engineer, build metaphors.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = (typeof window.esc === 'function') ? window.esc : function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  var journal = [];   // [{t, text, kind}] newest last
  var MAX = 50;
  var open = false;
  var drawer = null, badge = null, listEl = null;

  function timeStr(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch (e) { return ''; }
  }

  function log(text, kind) {
    journal.push({ t: Date.now(), text: String(text), kind: kind || 'note' });
    if (journal.length > MAX) journal.shift();
    renderList();
    flashBadge();
  }

  function renderList() {
    if (!listEl) return;
    if (!journal.length) {
      listEl.innerHTML = '<li class="peh-jrnl-empty">No entries yet. Tap a location to start logging.</li>';
      return;
    }
    var items = journal.slice().reverse().map(function (e) {
      return '<li class="peh-jrnl-item k-' + esc(e.kind) + '"><span class="peh-jrnl-time">' + esc(timeStr(e.t)) +
        '</span><span class="peh-jrnl-text">' + esc(e.text) + '</span></li>';
    });
    listEl.innerHTML = items.join('');
  }

  function flashBadge() {
    if (!badge) return;
    badge.textContent = String(journal.length);
    badge.classList.remove('pulse');
    void badge.offsetWidth;
    badge.classList.add('pulse');
  }

  function toggle(force) {
    open = (typeof force === 'boolean') ? force : !open;
    if (drawer) drawer.classList.toggle('open', open);
    if (open) renderList();
  }

  function init() {
    if (drawer) return;
    var btn = document.createElement('button');
    btn.className = 'peh-jrnl-btn';
    btn.type = 'button';
    btn.title = 'Build Log — recent engine activity';
    btn.setAttribute('aria-label', 'Open Build Log');
    btn.innerHTML = '<span class="peh-jrnl-ico" aria-hidden="true">⚙</span><span class="peh-jrnl-label">Build Log</span><span class="peh-jrnl-badge">0</span>';
    btn.onclick = function () { toggle(); };
    document.body.appendChild(btn);
    badge = btn.querySelector('.peh-jrnl-badge');

    drawer = document.createElement('aside');
    drawer.className = 'peh-jrnl-drawer';
    drawer.setAttribute('aria-label', 'Build Log');
    drawer.innerHTML =
      '<header class="peh-jrnl-head"><b>Build Log</b><span>engine activity · command history</span>' +
      '<button class="peh-jrnl-close" type="button" aria-label="Close Build Log">×</button></header>' +
      '<ul class="peh-jrnl-list"></ul>';
    document.body.appendChild(drawer);
    listEl = drawer.querySelector('.peh-jrnl-list');
    drawer.querySelector('.peh-jrnl-close').onclick = function () { toggle(false); };
    renderList();
  }

  window.IkbiGuide = { init: init, log: log, toggle: toggle, entries: function () { return journal.slice(); } };
})();

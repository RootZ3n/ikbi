// ══════════════════════════════════════════════════════════════════════
// IKBI · API CLIENT — talks to the build engine backend (port 18796).
// Pure vanilla. No deps. Every call resolves to {ok, data, error, status}
// and NEVER throws, so a scene can always render even when the backend
// is down.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // Resolve the backend base URL. Order: explicit ?api= query → injected
  // window.IKBI_API → same-origin if already served from port 18796 →
  // the local default. The build engine binds 127.0.0.1:18796.
  function resolveBase() {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) return q.replace(/\/$/, '');
    } catch (e) { /* file:// has no usable search */ }
    if (typeof window !== 'undefined' && window.IKBI_API) {
      return String(window.IKBI_API).replace(/\/$/, '');
    }
    try {
      if (location.protocol.startsWith('http') && location.port === '18796') {
        return location.origin;
      }
    } catch (e) { /* ignore */ }
    return 'http://127.0.0.1:18796';
  }

  var BASE = resolveBase();
  var cache = new Map();
  var CACHE_MS = 4000;

  async function get(path, opts) {
    opts = opts || {};
    var fresh = opts.fresh === true;
    var key = path;
    var nowFn = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return new Date().getTime(); };
    if (!fresh) {
      var hit = cache.get(key);
      if (hit && (nowFn() - hit.t) < CACHE_MS) return hit.v;
    }
    var result;
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 6000);
      var headers = { 'Accept': 'application/json' };
      if (typeof window !== 'undefined' && window.IKBI_API_TOKEN) {
        headers['Authorization'] = 'Bearer ' + window.IKBI_API_TOKEN;
      }
      var res = await fetch(BASE + path, { method: 'GET', signal: ctrl.signal, headers: headers });
      clearTimeout(timer);
      var data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON body */ }
      result = { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ('HTTP ' + res.status) };
    } catch (err) {
      var msg = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || String(err);
      result = { ok: false, status: 0, data: null, error: msg };
    }
    cache.set(key, { t: nowFn(), v: result });
    return result;
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 30000);
      var headers = { 'Accept': 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (typeof window !== 'undefined' && window.IKBI_API_TOKEN) {
        headers['Authorization'] = 'Bearer ' + window.IKBI_API_TOKEN;
      }
      var fetchOpts = { method: method, signal: ctrl.signal, headers: headers };
      if (body) fetchOpts.body = JSON.stringify(body);
      var res = await fetch(BASE + path, fetchOpts);
      clearTimeout(timer);
      var data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      return { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ('HTTP ' + res.status) };
    } catch (err) {
      var msg = (err && err.name === 'AbortError') ? 'timed out' : (err && err.message) || String(err);
      return { ok: false, status: 0, data: null, error: msg };
    }
  }

  async function post(path, body, opts) {
    return request('POST', path, body, opts);
  }

  window.IkbiAPI = {
    base: BASE,
    // Read model — build engine data sources.
    health: function (o) { return get('/health', o); },
    ready: function (o) { return get('/ready', o); },
    agent: function (o) { return get('/agent', o); },
    capabilities: function (o) { return get('/capabilities', o); },
    // Chat endpoint — requires IKBI_CHAT_TOKEN Bearer auth.
    converse: function (message, o) { return post('/chat', { message: message }, o); },
    // ── Build/repair task surface (the golden path) ───────────────────────
    // Submit a build task. Resolves {ok,data:{taskId,...}} (202 on accept).
    build: function (goal, repo, opts) {
      opts = opts || {};
      var body = { goal: goal, repo: repo };
      if (opts.builderMode) body.builderMode = opts.builderMode;
      if (opts.priority) body.priority = opts.priority;
      return post('/api/build', body, opts);
    },
    // Submit a fix task.
    fix: function (repo, opts) {
      opts = opts || {};
      var body = { repo: repo };
      if (opts.check) body.check = opts.check;
      if (opts.goal) body.goal = opts.goal;
      if (opts.allowTestEdits != null) body.allowTestEdits = !!opts.allowTestEdits;
      return post('/api/fix', body, opts);
    },
    // Read a task's status + result, or list recent tasks.
    getTask: function (id, o) { return get('/api/tasks/' + encodeURIComponent(id), o); },
    listTasks: function (o) {
      o = o || {};
      var q = o.limit != null ? '?limit=' + encodeURIComponent(o.limit) : '';
      return get('/api/tasks' + q, o);
    },
    cancelTask: function (id, o) { return post('/api/tasks/' + encodeURIComponent(id) + '/cancel', null, o); },
    // Durable build history + per-task spend (ground truth — replaces placeholders).
    receipts: function (o) {
      o = o || {};
      var q = o.limit != null ? '?limit=' + encodeURIComponent(o.limit) : '';
      return get('/api/receipts' + q, o);
    },
    timeline: function (o) {
      o = o || {};
      var q = o.period ? '?period=' + encodeURIComponent(o.period) : '';
      return get('/api/timeline' + q, o);
    },
    // ── SSE task stream ───────────────────────────────────────────────────
    // Subscribe to a task's live per-role progress. EventSource cannot send an
    // Authorization header, so we stream with fetch + a manual SSE parser — that
    // way a protected engine (IKBI_API_TOKEN set) still works. `handlers` is
    // { onEvent(name,data), onError(msg), onClose() }. Returns an abort function.
    streamTask: function (id, handlers) {
      handlers = handlers || {};
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var done = false;
      function finish() { if (done) return; done = true; if (handlers.onClose) try { handlers.onClose(); } catch (e) {} }
      (async function () {
        var headers = { 'Accept': 'text/event-stream' };
        if (typeof window !== 'undefined' && window.IKBI_API_TOKEN) {
          headers['Authorization'] = 'Bearer ' + window.IKBI_API_TOKEN;
        }
        var res;
        try {
          res = await fetch(BASE + '/api/tasks/' + encodeURIComponent(id) + '/stream', {
            method: 'GET', headers: headers, signal: ctrl ? ctrl.signal : undefined,
          });
        } catch (err) {
          if (!done && handlers.onError) handlers.onError((err && err.message) || String(err));
          finish();
          return;
        }
        if (!res.ok || !res.body || !res.body.getReader) {
          if (handlers.onError) handlers.onError(res && res.status ? ('HTTP ' + res.status) : 'stream unavailable');
          finish();
          return;
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        function dispatchFrame(frame) {
          var ev = 'message', data = '';
          frame.split(/\r?\n/).forEach(function (line) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
          });
          var parsed = null;
          if (data) { try { parsed = JSON.parse(data); } catch (e) { parsed = data; } }
          if (handlers.onEvent) handlers.onEvent(ev, parsed);
        }
        try {
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buf += decoder.decode(chunk.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              var frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (frame.trim()) dispatchFrame(frame);
            }
          }
        } catch (err) {
          if (!done && handlers.onError && !(err && err.name === 'AbortError')) handlers.onError((err && err.message) || String(err));
        }
        finish();
      })();
      return function abort() { if (ctrl) try { ctrl.abort(); } catch (e) {} finish(); };
    },
    // Drop cached reads so the next call refetches.
    refresh: function () { cache.clear(); },
    _get: get,
    _post: post,
    _request: request,
    // Correction library
    listCorrections: function (filter) {
      var qs = [];
      if (filter && filter.category) qs.push('category=' + encodeURIComponent(filter.category));
      if (filter && filter.approved != null) qs.push('approved=' + filter.approved);
      var q = qs.length ? '?' + qs.join('&') : '';
      return get('/ikbi/corrections' + q);
    },
    approveCorrection: function (id) {
      return request('PATCH', '/ikbi/corrections/' + encodeURIComponent(id) + '/approve');
    },
    rejectCorrection: function (id) {
      return request('DELETE', '/ikbi/corrections/' + encodeURIComponent(id));
    },
    // Spec artifacts. listSpecs reads the GET list route; executeSpec POSTs (the
    // server mutates spec status — execution is never a GET).
    listSpecs: function (o) {
      return get('/ikbi/spec', o);
    },
    executeSpec: function (id, o) {
      return post('/ikbi/spec/' + encodeURIComponent(id) + '/execute', null, o);
    },
  };
})();

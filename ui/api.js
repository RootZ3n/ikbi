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
      var res = await fetch(BASE + path, { method: 'GET', signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
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
      if (typeof window !== 'undefined' && window.IKBI_CHAT_TOKEN) {
        headers['Authorization'] = 'Bearer ' + window.IKBI_CHAT_TOKEN;
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

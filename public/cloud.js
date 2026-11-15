/* =========================================================
   DSE 内容工作台 · 云端同步层（cloud.js）  v3
   作用：
   ① 会话：登录后把 token / 角色 / 命名空间存在本机
   ② 拉取：定时从服务器拉自己的数据（主管额外拉全员数据）
   ③ 推送：页面上任何一次保存，自动增量推到服务器（多人实时同步）
   ④ 名单：主管在后台增删员工昵称（员工凭昵称登录）

   v3 重点（数据安全）：
   · 左下角状态条，明确区分「已保存到云端 / 暂存中 / 保存失败」；
   · 没同步成功的改动会写进 localStorage，刷新、断网、关页面都不丢；
   · 保存失败自动按退避重试，也可以点状态条立刻重试；
   · 带上 baseRev 做并发校验：另一台设备同时在改时不会互相覆盖，
     而是先拉最新版本按 id 合并，再重新提交（不会重复创建笔记/客资）；
   · 拉取时不会用服务器旧数据覆盖本地还没推上去的改动。
   注意：用本地文件（file://）打开时自动关闭云同步，退回原来的单机模式。
   ========================================================= */
(function () {
  'use strict';
  var API = 'api/';
  var SKEY = 'dse_web_session_v1';
  var PKEY = 'dse_push_pending_v1';     // 未同步成功的改动（刷新不丢）
  var online = (location.protocol === 'http:' || location.protocol === 'https:');
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { sess = null; }
  if (sess && !sess.token) sess = null;

  /* 和页面 / 服务端完全一致的昵称哈希（命名空间 u_xxxx） */
  function hashStr(s) {
    var h = 2166136261; s = String(s || '');
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function canonNs(name) { return 'u_' + hashStr(name).toString(36); }
  function whoOf(raw) {
    var v = raw; try { var p = JSON.parse(raw); if (typeof p === 'string') v = p; } catch (e) {}
    return String(v == null ? '' : v).trim();
  }

  /* 旧版本命名空间搬迁：老版页面用的哈希不一样，浏览器里留下的键
     形如 dse_wb_u_1jxyfnsz2_xxx_v2。这里按 who（昵称）把它们统一
     搬到当前哈希算出来的 ns 下，避免「名字显示成一串代号 / 数据对不上」。 */
  function compactLocal() {
    var keys = [], i;
    for (i = 0; i < localStorage.length; i++) { var k0 = localStorage.key(i); if (k0) keys.push(k0); }
    var moved = 0;
    keys.forEach(function (k) {
      var m = k.match(/^dse_wb_(u_[a-z0-9]+)_who_v2$/);
      if (!m) return;
      var ns = m[1], who = whoOf(localStorage.getItem(k));
      if (!who) return;
      var canon = canonNs(who);
      if (canon === ns) return;
      var pre = 'dse_wb_' + ns + '_', cpre = 'dse_wb_' + canon + '_';
      var src = [];
      for (var j = 0; j < localStorage.length; j++) {
        var kk = localStorage.key(j);
        if (kk && kk.indexOf(pre) === 0) src.push(kk);
      }
      src.forEach(function (kk) {
        var nk = cpre + kk.slice(pre.length), v = localStorage.getItem(kk);
        if (v !== null && localStorage.getItem(nk) === null) { localStorage.setItem(nk, v); moved++; }
        localStorage.removeItem(kk); moved++;
      });
    });
    return moved;
  }

  /* 老会话也一起作废：token 里带的还是旧 ns，不重新登录就永远对不上数据 */
  var staleSession = false;
  if (sess && sess.role === 'emp' && sess.name && String(sess.ns || '') !== canonNs(sess.name)) {
    staleSession = true;
    try { localStorage.removeItem(SKEY); } catch (e) {}
    sess = null;
  }

  var pushTimer = null;
  var dirty = {};          // 还没成功推上服务器的键（k -> 字符串值）
  var flushing = null;     // 正在进行的推送
  var pulling = false;
  var started = false;
  var lastRev = 0;         // 拉取用的版本水位（员工=本 ns 版本；主管=全库版本）
  var myNsRev = 0;         // 我推送目标命名空间的版本（用于并发校验 baseRev）
  var conflictTries = 0;
  var onRemote = null;
  var retryTimer = null, retryMs = 0;

  /* 恢复上次没推成功的改动：刷新、断网、直接关掉页面都不会丢 */
  try {
    var pd = JSON.parse(localStorage.getItem(PKEY) || 'null');
    if (pd && typeof pd === 'object') {
      Object.keys(pd).forEach(function (k) { if (typeof pd[k] === 'string') dirty[k] = pd[k]; });
    }
  } catch (e) {}

  function savePending() {
    try {
      if (Object.keys(dirty).length) localStorage.setItem(PKEY, JSON.stringify(dirty));
      else localStorage.removeItem(PKEY);
    } catch (e) {}
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (sess && sess.token) h['Authorization'] = 'Bearer ' + sess.token;
    return h;
  }
  function req(method, path, body) {
    var opt = { method: method, headers: headers(), cache: 'no-store' };
    if (body) opt.body = JSON.stringify(body);
    var ctrl = null, timer = null;
    try {
      if (typeof AbortController === 'function') {
        ctrl = new AbortController();
        opt.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 20000);
      }
    } catch (e) {}
    return fetch(API + path, opt).then(function (r) {
      return r.json().then(function (j) {
        j = j || {}; j.__status = r.status; return j;
      }, function () { return { __status: r.status, ok: false, error: '服务器返回内容无法解析（HTTP ' + r.status + '）' }; });
    }).then(function (j) {
      if (timer) clearTimeout(timer);
      return j;
    }, function (e) {
      if (timer) clearTimeout(timer);
      var err = new Error(e && e.name === 'AbortError' ? '请求超时' : '网络连接失败');
      err.network = true;
      throw err;
    });
  }
  function saveSess(s) {
    sess = s;
    try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch (e) {}
  }

  /* ---------------- 状态条：已保存 / 暂存 / 失败 ---------------- */
  var st = { state: 'idle', at: 0, error: '', pending: 0, retryIn: 0 };
  var hideTimer = null, retryTick = null;

  function statusEl() {
    if (!document.body) return null;
    var el = document.getElementById('cloudStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cloudStatus';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:99998',
        'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif',
        'padding:6px 11px', 'border-radius:16px', 'color:#fff', 'background:#6b7280',
        'box-shadow:0 4px 14px rgba(0,0,0,.18)', 'max-width:60vw',
        'opacity:0', 'transition:opacity .2s', 'pointer-events:none',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
      ].join(';');
      document.body.appendChild(el);
    }
    return el;
  }

  function paint() {
    var el = statusEl(); if (!el) return;
    if (!sess || st.state === 'idle') { el.style.opacity = '0'; el.style.pointerEvents = 'none'; return; }
    var txt = '', bg = '#6b7280', clickable = false;
    if (st.state === 'ok') { txt = '✓ 已保存到云端' + (st.at ? ' · ' + hhmm(st.at) : ''); bg = '#16a34a'; }
    else if (st.state === 'pending') { txt = '↑ 暂存中 · 正在同步到云端' + (st.pending ? '（' + st.pending + ' 项）' : ''); bg = '#d97706'; }
    else if (st.state === 'retry') { txt = '↑ 暂存中 · 稍后自动重试' + (st.retryIn ? '（' + st.retryIn + 's）' : ''); bg = '#d97706'; }
    else if (st.state === 'conflict') { txt = '⇄ 已合并另一台设备的改动'; bg = '#2563eb'; }
    else if (st.state === 'error') { txt = '⚠ 保存失败 · 内容已保留在本机，点此重试'; bg = '#dc2626'; clickable = true; }
    else if (st.state === 'offline') { txt = '⚠ 网络断开 · 内容已暂存在本机，联网后自动上传'; bg = '#6b7280'; clickable = true; }
    el.textContent = txt;
    el.style.background = bg;
    el.style.opacity = '1';
    el.style.pointerEvents = clickable ? 'auto' : 'none';
    el.style.cursor = clickable ? 'pointer' : 'default';
    el.title = st.error || '';
    el.onclick = clickable ? function () { retryNow(); } : null;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (st.state === 'ok') {
      hideTimer = setTimeout(function () { var e2 = statusEl(); if (e2 && st.state === 'ok') e2.style.opacity = '0'; }, 2600);
    }
  }
  function hhmm(ts) {
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function setStatus(state, err) {
    st.state = state;
    st.at = state === 'ok' ? Date.now() : st.at;
    st.error = err || '';
    st.pending = Object.keys(dirty).length;
    if (state !== 'retry') { st.retryIn = 0; }
    paint();
  }
  function startRetryTick() {
    if (retryTick) return;
    retryTick = setInterval(function () {
      if (st.state !== 'retry') { clearInterval(retryTick); retryTick = null; return; }
      st.retryIn = Math.max(0, st.retryIn - 1);
      paint();
    }, 1000);
  }

  /* 这个键是不是「我这份数据」 */
  function isMine(k) {
    if (!sess) return false;
    if (/_remember$/.test(k)) return false;
    if (sess.role === 'admin') return k.indexOf('dse_wb_admin_') === 0 || k.indexOf('dse_admin_') === 0;
    return k.indexOf('dse_wb_' + sess.ns + '_') === 0;
  }

  /* 把服务器上的 kv 写进本机 localStorage，返回真正变化的条数
     注意：本地还没推上去的键（dirty）跳过，避免用旧数据把员工刚填的内容冲掉 */
  function applyKv(kv) {
    var n = 0;
    Object.keys(kv || {}).forEach(function (k) {
      if (!isMine(k)) return;
      if (Object.prototype.hasOwnProperty.call(dirty, k)) return;
      var v = kv[k];
      if (typeof v !== 'string') return;
      try {
        if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); n++; }
      } catch (e) {}
    });
    return n;
  }

  /* 拉自己（主管：拉全员） */
  function pull() {
    if (!online || !sess) return Promise.resolve(0);
    if (pulling) return Promise.resolve(0);
    pulling = true;
    var isAdmin = sess.role === 'admin';
    var q = '?since=' + encodeURIComponent(lastRev);
    return req('GET', (isAdmin ? 'all' : 'state') + q).then(function (d) {
      pulling = false;
      if (!d || d.ok === false) return 0;
      if (d.unchanged) {
        if (isAdmin && typeof d.nsRev === 'number') myNsRev = d.nsRev;
        return 0;
      }
      if (isAdmin) {
        var kv = {};
        Object.keys(d.ns || {}).forEach(function (ns) {
          var o = d.ns[ns] || {};
          Object.keys(o.kv || {}).forEach(function (k) { kv[k] = o.kv[k]; });
        });
        lastRev = d.rev || lastRev;
        if (typeof d.nsRev === 'number') myNsRev = d.nsRev;
        return applyKv(kv) + compactLocal();
      }
      lastRev = (typeof d.rev === 'number') ? d.rev : lastRev;
      myNsRev = (typeof d.rev === 'number') ? d.rev : myNsRev;
      return applyKv(d.kv || {}) + compactLocal();
    }).catch(function () { pulling = false; return 0; });
  }

  /* 页面每次保存都会调用这里（由 lsSet 触发） */
  function touch(k, v) {
    if (!online || !sess) return;
    if (!isMine(k)) return;
    try { dirty[k] = (typeof v === 'string') ? v : JSON.stringify(v); } catch (e) { return; }
    savePending();
    if (st.state === 'ok' || st.state === 'idle') setStatus('pending');
    else setStatus(st.state === 'error' || st.state === 'offline' ? st.state : 'pending');
    if (pushTimer) return;
    pushTimer = setTimeout(function () { pushTimer = null; flush(); }, 700);
  }

  /* 数组/对象按 id 合并：本地优先，服务器上多出来的条目补进来（不丢任何一边的数据） */
  function parseJson(s) { try { return JSON.parse(s); } catch (e) { return undefined; } }
  function unionById(localStr, serverStr) {
    var a = parseJson(localStr), b = parseJson(serverStr);
    if (a === undefined || b === undefined) return null;
    if (Array.isArray(a) && Array.isArray(b)) {
      var okA = a.every(function (x) { return x && typeof x === 'object' && x.id; });
      var okB = b.every(function (x) { return x && typeof x === 'object' && x.id; });
      if (!okA || !okB) return null;
      var seen = {}, out = [];
      a.forEach(function (x) { seen[x.id] = 1; out.push(x); });
      b.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; out.push(x); } });
      return JSON.stringify(out);
    }
    return null;
  }
  function unionDrafts(localStr, serverStr) {
    var a = parseJson(localStr), b = parseJson(serverStr);
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
    if (Array.isArray(a) || Array.isArray(b)) return null;
    var out = {};
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    return JSON.stringify(out);
  }

  function mergeAfterConflict(batch, serverKv, kvAnnotations) {
    var merged = {}, changed = false;
    Object.keys(batch).forEach(function (k) {
      var lv = Object.prototype.hasOwnProperty.call(dirty, k) ? dirty[k] : batch[k];
      var sv = serverKv[k];
      var out = null;
      if (typeof sv === 'string') {
        out = unionById(lv, sv);
        if (out === null && /_drafts_v2$/.test(k)) out = unionDrafts(lv, sv);
      }
      if (out !== null && out !== lv) {
        changed = true;
        try { localStorage.setItem(k, out); } catch (e) {}
        merged[k] = out;
      } else {
        merged[k] = lv;
      }
    });
    dirty = merged;
    savePending();
    return changed;
  }

  function scheduleFlush() {
    if (retryTimer) return;
    retryMs = retryMs ? Math.min(retryMs * 2, 60000) : 3000;
    st.retryIn = Math.round(retryMs / 1000);
    setStatus('retry');
    startRetryTick();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      flush().catch(function () {});
    }, retryMs);
  }

  function flush() {
    if (flushing) return flushing;
    if (!online || !sess) return Promise.resolve();
    var batch = {}, has = 0;
    Object.keys(dirty).forEach(function (k) {
      if (!isMine(k)) return;
      batch[k] = dirty[k]; has++;
    });
    if (!has) { savePending(); return Promise.resolve(); }
    if (st.state !== 'ok') setStatus(st.state === 'conflict' ? 'conflict' : 'pending');
    var body = { patch: batch, baseRev: myNsRev };

    flushing = req('POST', 'state', body).then(function (d) {
      flushing = null;
      if (d && d.__status === 401) { saveSess(null); location.replace('index.html'); return; }
      if (d && d.conflict) {
        /* 另一台设备也在改：先把服务器最新版合并进来，再重新提交同一份数据（幂等） */
        conflictTries++;
        var mergedChanged = mergeAfterConflict(batch, d.kv || {});
        myNsRev = (typeof d.nsRev === 'number') ? d.nsRev : myNsRev;
        lastRev = myNsRev;
        setStatus('conflict');
        if (conflictTries > 5) {
          setStatus('error', '多次合并仍未成功，请刷新页面后再试');
          return;
        }
        retryMs = 300;
        setTimeout(function () { flush().catch(function () {}); }, 350);
        if (mergedChanged && onRemote) { try { onRemote(); } catch (e) {} }
        return;
      }
      if (d && d.ok && d.persisted) {
        /* 真正写进云端了：清掉已确认的键（期间又被改过的保留） */
        Object.keys(batch).forEach(function (k) {
          if (dirty[k] === batch[k]) delete dirty[k];
        });
        savePending();
        myNsRev = (typeof d.nsRev === 'number') ? d.nsRev : myNsRev;
        if (sess && sess.role !== 'admin') lastRev = myNsRev;
        conflictTries = 0; retryMs = 0;
        if (Object.keys(dirty).length) { setStatus('pending'); setTimeout(function () { flush().catch(function () {}); }, 300); }
        else setStatus('ok');
        return;
      }
      /* 503：服务器没写进云端，但服务器内存里已暂存；前端继续保留并重试 */
      setStatus('error', (d && d.error) || '云端暂时写不进去');
      scheduleFlush();
    }).catch(function (e) {
      flushing = null;
      st.pending = Object.keys(dirty).length;
      if (e && e.network) setStatus('offline', e.message);
      else setStatus('error', (e && e.message) || '网络异常');
      scheduleFlush();
    });
    return flushing;
  }

  /* 用户点了状态条 / 网络恢复时立刻重试 */
  function retryNow() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryMs = 0; conflictTries = 0;
    setStatus('pending');
    return flush();
  }

  function tick() {
    if (document.hidden || !online || !sess) return;
    /* 有没推上去的改动就顺手推一次；如果已经在退避等待，就别再额外加压力 */
    var pre = (Object.keys(dirty).length && !retryTimer ? flush() : Promise.resolve());
    pre.then(function () {
      return pull().then(function (n) {
        if (n > 0 && onRemote) { try { onRemote(); } catch (e) {} }
      });
    });
  }

  function start(fn) {
    if (fn) onRemote = fn;
    if (!online) return;
    try { compactLocal(); } catch (e) {}
    if (!sess || started) return;
    started = true;
    setInterval(tick, 6000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('online', function () { try { retryNow(); } catch (e) {} tick(); });
    window.addEventListener('offline', function () { if (Object.keys(dirty).length) setStatus('offline', '浏览器报告网络已断开'); });
    window.addEventListener('beforeunload', function () { savePending(); });
    setTimeout(tick, 800);
  }

  function login(role, name, pass) {
    return req('POST', 'login', { role: role, name: name, pass: pass }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '登录失败');
      saveSess({ token: d.token, role: d.role, ns: d.ns, name: d.name, persona: d.persona || '' });
      lastRev = 0; myNsRev = 0;
      return d;
    });
  }

  function logout() {
    if (sess) {
      var pref = sess.role === 'admin' ? ['dse_wb_admin_', 'dse_admin_'] : ['dse_wb_' + sess.ns + '_'];
      var del = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || /_remember$/.test(k)) continue;
        for (var j = 0; j < pref.length; j++) {
          if (k.indexOf(pref[j]) === 0) { del.push(k); break; }
        }
      }
      del.forEach(function (k) { localStorage.removeItem(k); });
    }
    dirty = {}; savePending();
    saveSess(null);
    location.replace('index.html');
  }

  function roster() {
    return req('GET', 'roster').then(function (d) { return (d && d.roster) || []; });
  }
  function saveRoster(list) {
    return req('POST', 'roster', { roster: list }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '保存名单失败');
      return d.roster || [];
    });
  }
  function changeAdminPass(pass) {
    return req('POST', 'adminpass', { pass: pass }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '修改口令失败');
      return true;
    });
  }

  /* 主管专用：把某个员工的数据写进服务器（导入旧汇总码 / 恢复备份用） */
  function pushNs(ns, patch) {
    if (!online || !sess || sess.role !== 'admin') return Promise.resolve(null);
    if (!patch || !Object.keys(patch).length) return Promise.resolve(null);
    return req('POST', 'ns', { ns: ns, patch: patch }).then(function (d) {
      if (d && d.ok) lastRev = d.rev || lastRev;
      return d;
    }).catch(function () { return null; });
  }

  window.__cloud = {
    online: online,
    session: function () { return sess; },
    login: login,
    logout: logout,
    pull: pull,
    flush: flush,
    start: start,
    touch: touch,
    retry: retryNow,
    status: function () { return { state: st.state, at: st.at, error: st.error, pending: Object.keys(dirty).length }; },
    onStatus: function (fn) {
      if (typeof fn !== 'function') return;
      var old = paint;
      paint = function () { old(); try { fn(window.__cloud.status()); } catch (e) {} };
    },
    roster: roster,
    saveRoster: saveRoster,
    changeAdminPass: changeAdminPass,
    pushNs: pushNs,
    compact: compactLocal,
    rev: function () { return lastRev; }
  };

  /* 旧会话（旧版命名空间）已作废：回登录页用名单里的昵称重新登录一次 */
  if (staleSession && online) location.replace('index.html');
})();

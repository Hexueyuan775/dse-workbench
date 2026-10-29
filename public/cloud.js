/* =========================================================
   DSE 内容工作台 · 云端同步层（cloud.js）
   作用：
   ① 会话：登录后把 token / 角色 / 命名空间存在本机
   ② 拉取：定时从服务器拉自己的数据（主管额外拉全员数据）
   ③ 推送：页面上任何一次保存，自动增量推到服务器（多人实时同步）
   ④ 名单：主管在后台增删员工昵称（员工凭昵称登录）
   注意：用本地文件（file://）打开时自动关闭云同步，退回原来的单机模式。
   ========================================================= */
(function () {
  'use strict';
  var API = 'api/';
  var SKEY = 'dse_web_session_v1';
  var online = (location.protocol === 'http:' || location.protocol === 'https:');
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { sess = null; }
  if (sess && !sess.token) sess = null;

  var pushTimer = null;
  var dirty = {};
  var pulling = false;
  var started = false;
  var lastRev = 0;
  var onRemote = null;

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (sess && sess.token) h['Authorization'] = 'Bearer ' + sess.token;
    return h;
  }
  function req(method, path, body) {
    var opt = { method: method, headers: headers(), cache: 'no-store' };
    if (body) opt.body = JSON.stringify(body);
    return fetch(API + path, opt).then(function (r) {
      return r.json().then(function (j) { j.__status = r.status; return j; });
    });
  }
  function saveSess(s) {
    sess = s;
    try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch (e) {}
  }

  /* 这个键是不是「我这份数据」 */
  function isMine(k) {
    if (!sess) return false;
    if (/_remember$/.test(k)) return false;
    if (sess.role === 'admin') return k.indexOf('dse_wb_admin_') === 0 || k.indexOf('dse_admin_') === 0;
    return k.indexOf('dse_wb_' + sess.ns + '_') === 0;
  }

  /* 把服务器上的 kv 写进本机 localStorage，返回真正变化的条数 */
  function applyKv(kv) {
    var n = 0;
    Object.keys(kv || {}).forEach(function (k) {
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
      if (!d || d.ok === false || d.unchanged) return 0;
      if (isAdmin) {
        var kv = {};
        Object.keys(d.ns || {}).forEach(function (ns) {
          var o = d.ns[ns] || {};
          Object.keys(o.kv || {}).forEach(function (k) { kv[k] = o.kv[k]; });
        });
        lastRev = d.rev || lastRev;
        return applyKv(kv);
      }
      lastRev = d.rev || lastRev;
      return applyKv(d.kv || {});
    }).catch(function () { pulling = false; return 0; });
  }

  /* 页面每次保存都会调用这里（由 lsSet 触发） */
  function touch(k, v) {
    if (!online || !sess) return;
    if (!isMine(k)) return;
    try { dirty[k] = (typeof v === 'string') ? v : JSON.stringify(v); } catch (e) {}
    if (pushTimer) return;
    pushTimer = setTimeout(function () { pushTimer = null; flush(); }, 700);
  }

  function flush() {
    if (!online || !sess) return Promise.resolve();
    var patch = dirty;
    dirty = {};
    if (!Object.keys(patch).length) return Promise.resolve();
    return req('POST', 'state', { patch: patch }).then(function (d) {
      if (d && d.__status === 401) { saveSess(null); location.replace('index.html'); return; }
      if (d && d.ok !== false){
        lastRev = (sess && sess.role === 'admin') ? (d.rev || lastRev) : (d.nsRev || lastRev);
      }
    }).catch(function () {
      Object.keys(patch).forEach(function (k) { if (!(k in dirty)) dirty[k] = patch[k]; });
    });
  }

  function tick() {
    if (document.hidden || !online || !sess) return;
    var pre = (Object.keys(dirty).length ? flush() : Promise.resolve());
    pre.then(function () {
      return pull().then(function (n) {
        if (n > 0 && onRemote) { try { onRemote(); } catch (e) {} }
      });
    });
  }

  function start(fn) {
    if (fn) onRemote = fn;
    if (!online || !sess || started) return;
    started = true;
    setInterval(tick, 6000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('online', tick);
    window.addEventListener('beforeunload', function () { try { flush(); } catch (e) {} });
    setTimeout(tick, 800);
  }

  function login(role, name, pass) {
    return req('POST', 'login', { role: role, name: name, pass: pass }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '登录失败');
      saveSess({ token: d.token, role: d.role, ns: d.ns, name: d.name, persona: d.persona || '' });
      lastRev = 0;
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
    roster: roster,
    saveRoster: saveRoster,
    changeAdminPass: changeAdminPass,
    pushNs: pushNs,
    rev: function () { return lastRev; }
  };
})();

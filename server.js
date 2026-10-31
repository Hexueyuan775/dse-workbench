'use strict';
/* =========================================================
   DSE 内容工作台 · 网站版服务端
   纯 Node.js，无任何第三方依赖。
   职责：① 托管 public 里的页面 ② 员工名单 + 昵称登录 ③ 云端数据同步（各员工 / 主管各一份，实时互推）
   数据落盘：默认 data/db.json（本机 / 局域网用）；
             部署到 Render 这类免费主机时，设置 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
             两个环境变量，数据就存到云端 Redis，磁盘被清空也不会丢。
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const BUILD = 'v7-2026-10-31';
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA_DIR = process.env.DSE_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* 云端存储（可选）：填了这两个环境变量，数据就存到 Upstash Redis，
   这样在 Render 免费版（磁盘会被清空）上也不会丢数据。 */
const KV_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const KV_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const KV_KEY = String(process.env.DSE_KV_KEY || 'dse:db').trim();
const useKV = !!(KV_URL && KV_TOKEN);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- 工具 ---------------- */
// 和前端完全一致的昵称哈希（员工命名空间 u_xxxx）
function hashStr(s){
  let h = 2166136261;
  s = String(s || '');
  for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
const empNs = name => 'u_' + hashStr(name).toString(36);

/* ---------------- 数据 ---------------- */
function freshDB(){
  return {
    secret: crypto.randomBytes(24).toString('hex'),
    admin: { name: '主管', pass: 'dse2026' },   // 首次登录后请立刻在后台改口令
    roster: [],                                  // [{name, persona, pass, active, note, at}]
    ns: {},                                      // { 命名空间: { rev, kv:{ 存储键: 原始JSON字符串 } } }
    rev: 1,
    createdAt: Date.now()
  };
}
function normalizeDB(o){
  const d = (o && typeof o === 'object') ? o : freshDB();
  d.roster = Array.isArray(d.roster) ? d.roster : [];
  d.ns = d.ns && typeof d.ns === 'object' ? d.ns : {};
  d.admin = d.admin && d.admin.pass ? d.admin : { name: '主管', pass: 'dse2026' };
  d.rev = Number(d.rev) || 1;
  if (!d.secret) d.secret = crypto.randomBytes(24).toString('hex');
  return d;
}

let db = freshDB();
if (!useKV){
  try { db = normalizeDB(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { db = normalizeDB(freshDB()); }
} else {
  db = normalizeDB(freshDB());
}

/* ---------------- 保存（本机文件 / 云端 Redis） ---------------- */
let saveTimer = null, kvSaving = false, kvDirty = false, kvRetry = null;

function writeFile(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  }catch(e){ console.error('[DB] 保存失败：' + e.message); }
}

async function kvCmd(cmd){
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (!r.ok || !j || j.error) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j.result;
}

async function kvPump(){
  if (kvSaving) return;
  kvSaving = true;
  try{
    while (kvDirty){
      kvDirty = false;
      await kvCmd(['SET', KV_KEY, JSON.stringify(db)]);
    }
  }catch(e){
    kvDirty = true;
    console.error('[KV] 保存到云端失败：' + e.message + '（5 秒后重试）');
    if (!kvRetry) kvRetry = setTimeout(() => { kvRetry = null; kvPump(); }, 5000);
  }finally{ kvSaving = false; }
}

function persist(){
  if (useKV){ kvDirty = true; kvPump(); return; }
  writeFile();
}
function saveDB(){
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 250);
}

/* 旧版本命名空间合并：老版页面用的哈希和现在不一样，服务器里可能留着
   u_1jxyfnsz2 这类旧 ns（里面 who 已经写了昵称）。这里按 who 把它们
   统一搬到当前 ns，避免主管端看到「一串代号」的员工。
   idempotent：搬完就删旧 ns，重复跑也不会有副作用。 */
let lastCompact = 0;
function compactNs(force){
  const now = Date.now();
  if (!force && now - lastCompact < 30000) return;
  lastCompact = now;
  let changed = false;
  Object.keys(db.ns).forEach(ns => {
    const rec = db.ns[ns];
    if (!rec || !rec.kv) return;
    const raw = rec.kv['dse_wb_' + ns + '_who_v2'];
    if (!raw) return;
    let who = raw;
    try { const p = JSON.parse(raw); if (typeof p === 'string') who = p; } catch (e) {}
    who = String(who || '').trim();
    if (!who) return;
    const canon = empNs(who);
    if (canon === ns) return;
    const pre = 'dse_wb_' + ns + '_';
    const tgt = db.ns[canon] || (db.ns[canon] = { rev: 0, kv: {} });
    tgt.kv = tgt.kv || {};
    Object.keys(rec.kv).forEach(k => {
      if (k.indexOf(pre) !== 0) return;
      const nk = 'dse_wb_' + canon + '_' + k.slice(pre.length);
      if (!(nk in tgt.kv)) tgt.kv[nk] = rec.kv[k];
    });
    tgt.rev = (tgt.rev || 0) + 1;
    tgt.at = Date.now();
    delete db.ns[ns];
    changed = true;
  });
  if (changed){ db.rev++; saveDB(); }
}

/* ---------------- 令牌（无状态签名） ---------------- */
function sign(payload){
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', db.secret).update(b).digest('base64url');
  return b + '.' + s;
}
function verify(tok){
  const t = String(tok || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const b = t.slice(0, i), s = t.slice(i + 1);
  const exp = crypto.createHmac('sha256', db.secret).update(b).digest('base64url');
  const be = Buffer.from(exp), bs = Buffer.from(s);
  if (be.length !== bs.length || !crypto.timingSafeEqual(be, bs)) return null;
  let o; try { o = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!o || !o.ns) return null;
  if (Date.now() - (o.t || 0) > 60 * 86400000) return null;
  return o;
}

/* ---------------- HTTP 小工具 ---------------- */
function send(res, code, obj){
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let d = '', n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > 16 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      d += c;
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function auth(req){
  const h = req.headers['authorization'] || '';
  return verify(h.replace(/^Bearer\s+/i, ''));
}
function publicRoster(){
  return db.roster.map(x => ({ name: x.name, persona: x.persona || '', active: x.active !== false, note: x.note || '', hasPass: !!x.pass, ns: empNs(x.name) }));
}

/* ---------------- API ---------------- */
async function handleApi(req, res, u, p){
  if (p === '/api/ping'){
    return send(res, 200, { ok: true, app: 'dse-workbench', build: BUILD, employees: db.roster.length, rev: db.rev, storage: useKV ? 'kv' : 'file' });
  }

  /* 登录：主管用口令，员工用名单里的昵称 */
  if (p === '/api/login' && req.method === 'POST'){
    const b = await readBody(req);
    if (b.role === 'admin'){
      if (!b.pass || String(b.pass) !== String(db.admin.pass)) return send(res, 401, { ok: false, error: '主管口令不对' });
      return send(res, 200, { ok: true, token: sign({ r: 'admin', ns: 'admin', n: db.admin.name, t: Date.now() }), role: 'admin', ns: 'admin', name: db.admin.name });
    }
    const nm = String(b.name || '').trim().slice(0, 24);
    if (!nm) return send(res, 400, { ok: false, error: '请填写你的昵称' });
    const it = db.roster.find(x => x.name === nm);
    if (!it) return send(res, 403, { ok: false, error: '昵称「' + nm + '」不在主管录入的名单里，请联系主管添加后再登录' });
    if (it.active === false) return send(res, 403, { ok: false, error: '这个账号已被主管停用' });
    if (it.pass && String(b.pass || '') !== String(it.pass)) return send(res, 401, { ok: false, error: '密码不对' });
    /* 自愈：员工登录时，服务端亲手把这个命名空间的 who 写成他的昵称。
       这样即使员工浏览器里缓存的旧 cloud.js 没有推 who，
       主管端也不会再看到「u_xxxxx 一串代号」。 */
    const ns = empNs(nm);
    if (!db.ns[ns]) db.ns[ns] = { rev: 0, kv: {} };
    const whoKey = 'dse_wb_' + ns + '_who_v2';
    const whoVal = JSON.stringify(nm);
    if (db.ns[ns].kv[whoKey] !== whoVal){ db.ns[ns].kv[whoKey] = whoVal; db.rev++; saveDB(); }
    return send(res, 200, {
      ok: true,
      token: sign({ r: 'emp', ns: ns, n: nm, t: Date.now() }),
      role: 'emp', ns: ns, name: nm, persona: it.persona || ''
    });
  }

  const me = auth(req);
  if (!me) return send(res, 401, { ok: false, error: '登录已过期，请重新登录' });

  /* 读自己那份数据 */
  if (p === '/api/state' && req.method === 'GET'){
    const rec = db.ns[me.ns] || { rev: 0, kv: {} };
    const since = Number(u.searchParams.get('since') || -1);
    if (since === (rec.rev || 0)) return send(res, 200, { ok: true, rev: rec.rev || 0, unchanged: true });
    return send(res, 200, { ok: true, rev: rec.rev || 0, kv: rec.kv || {} });
  }

  /* 写自己那份数据（按 key 增量合并，避免互相覆盖） */
  if (p === '/api/state' && req.method === 'POST'){
    const b = await readBody(req);
    const patch = b && b.patch && typeof b.patch === 'object' ? b.patch : null;
    if (!patch) return send(res, 400, { ok: false, error: 'patch 为空' });
    const rec = db.ns[me.ns] || (db.ns[me.ns] = { rev: 0, kv: {} });
    rec.kv = rec.kv || {};
    let n = 0;
    Object.keys(patch).forEach(k => {
      if (!/^dse_(wb_|admin_)/.test(k)) return;         // 只接受工作台的键
      const v = patch[k];
      if (typeof v !== 'string') return;
      if (rec.kv[k] !== v){ rec.kv[k] = v; n++; }
    });
    if (n){
      rec.rev = (rec.rev || 0) + 1;
      rec.at = Date.now();
      db.rev++;
      saveDB();
    }
    return send(res, 200, { ok: true, rev: db.rev, nsRev: rec.rev || 0, changed: n });
  }

  /* 主管：拉全团队数据（含员工名单） */
  if (p === '/api/all' && req.method === 'GET'){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以拉全员数据' });
    compactNs();
    const since = Number(u.searchParams.get('since') || -1);
    if (since === db.rev) return send(res, 200, { ok: true, rev: db.rev, unchanged: true });
    return send(res, 200, { ok: true, rev: db.rev, ns: db.ns, roster: publicRoster(), adminName: db.admin.name });
  }

  /* 主管：把某个员工的数据直接写进服务器（导入旧汇总码 / 恢复备份时用） */
  if (p === '/api/ns' && req.method === 'POST'){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以写别人的数据' });
    const b = await readBody(req);
    const ns = String(b.ns || '');
    if (!/^(u_[a-z0-9]+|admin)$/.test(ns)) return send(res, 400, { ok: false, error: 'ns 不合法' });
    const patch = b.patch && typeof b.patch === 'object' ? b.patch : null;
    if (!patch) return send(res, 400, { ok: false, error: 'patch 为空' });
    const rec = db.ns[ns] || (db.ns[ns] = { rev: 0, kv: {} });
    rec.kv = rec.kv || {};
    let n = 0;
    Object.keys(patch).forEach(k => {
      if (!/^dse_(wb_|admin_)/.test(k)) return;
      const v = patch[k];
      if (typeof v !== 'string') return;
      if (rec.kv[k] !== v){ rec.kv[k] = v; n++; }
    });
    if (n){ rec.rev = (rec.rev || 0) + 1; rec.at = Date.now(); db.rev++; saveDB(); }
    return send(res, 200, { ok: true, rev: db.rev, nsRev: rec.rev, changed: n });
  }

  /* 主管：员工名单 */
  if (p === '/api/roster'){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以管理名单' });
    if (req.method === 'GET') return send(res, 200, { ok: true, roster: publicRoster() });
    if (req.method === 'POST'){
      const b = await readBody(req);
      if (!Array.isArray(b.roster)) return send(res, 400, { ok: false, error: 'roster 必须是数组' });
      if (b.roster.length > 300) return send(res, 400, { ok: false, error: '名单最多 300 人' });
      const seen = {}, out = [];
      for (const raw of b.roster){
        const nm = String((raw && raw.name) || '').trim().slice(0, 24);
        if (!nm || seen[nm]) continue;
        seen[nm] = 1;
        out.push({
          name: nm,
          persona: (raw.persona === '摘星' || raw.persona === '遵理') ? raw.persona : '',
          pass: String(raw.pass || '').slice(0, 24),
          active: raw.active !== false,
          note: String(raw.note || '').slice(0, 40),
          at: raw.at || Date.now()
        });
      }
      db.roster = out;
      db.rev++;
      saveDB();
      return send(res, 200, { ok: true, roster: publicRoster() });
    }
  }

  /* 主管：改自己的口令 */
  if (p === '/api/adminpass' && req.method === 'POST'){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以改口令' });
    const b = await readBody(req);
    const np = String(b.pass || '').trim();
    if (np.length < 4) return send(res, 400, { ok: false, error: '口令至少 4 位' });
    db.admin.pass = np;
    db.rev++;
    saveDB();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(res, p){
  let f = (p === '/' ? '/index.html' : p);
  const rel = path.normalize(f).replace(/^([\\/])+/, '');
  const full = path.join(PUB, rel);
  if (!full.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 找不到页面');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(buf);
  });
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400); return res.end('bad url'); }
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (e) {}
  if (p.startsWith('/api/')) {
    handleApi(req, res, u, p).catch(e => send(res, 500, { ok: false, error: String((e && e.message) || e) }));
  } else {
    serveStatic(res, p);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE'){
    console.error('');
    console.error(' 端口 ' + PORT + ' 已被占用：多半是已经开着一个黑窗口了。');
    console.error(' 把旧的黑窗口关掉，再双击一次「启动.bat」。');
    console.error('');
  } else {
    console.error(' 启动失败：' + e.message);
  }
  process.exit(1);
});

function startServer(){
  server.listen(PORT, '0.0.0.0', () => {
    const nets = os.networkInterfaces();
    const ips = [];
    Object.keys(nets).forEach(k => (nets[k] || []).forEach(n => { if (n.family === 'IPv4' && !n.internal) ips.push(n.address); }));
    console.log('==============================================');
    console.log(' DSE 内容工作台 · 网站版已启动');
    console.log(' 本机访问： http://localhost:' + PORT);
    ips.forEach(ip => console.log(' 局域网：  http://' + ip + ':' + PORT + '   （同一 WiFi 下手机/同事可打开）'));
    console.log(' 主管口令： ' + db.admin.pass + '   （登录后请在「后台」里改掉）');
    console.log(' 员工名单： ' + (db.roster.length ? db.roster.map(x => x.name).join('、') : '还没有员工，先用主管登录去后台添加'));
    console.log(' 数据存储： ' + (useKV ? 'Upstash Redis（云端，重启/重新部署都不会丢）' : DB_FILE));
    console.log('==============================================');
  });
}

/* 先（如果是云端模式）把数据拉下来，再开始对外服务 */
(async function boot(){
  if (useKV){
    try {
      const raw = await kvCmd(['GET', KV_KEY]);
      if (raw) db = normalizeDB(JSON.parse(raw));
      console.log('[KV] 云端存储已连接：' + KV_URL);
    } catch (e) {
      console.error('[KV] 读取云端数据失败：' + e.message);
      console.error('[KV] 请检查 Render 里的 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 是否填对');
    }
  }
  try { compactNs(true); } catch (e) { console.error('[NS] 旧命名空间合并失败：' + e.message); }
  startServer();
})();

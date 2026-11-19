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
const BUILD = 'v9.4-2026-11-19';
const SCHEMA = 2;                 // 数据结构版本号（备份清单里会带上）
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
/* 云端存储请求最多等多久。以前没有超时：Upstash 一旦不可达，请求会一直挂着，
   启动流程卡死、端口不监听，浏览器就表现为「能连上但一直转圈打不开」。 */
const KV_TIMEOUT = Number(process.env.DSE_KV_TIMEOUT || 8000) || 8000;

/* 云端数据「就绪」状态：只有成功从 Upstash 读到数据才算就绪。
   未就绪时既不做写操作，也不把内存里的空库推回云端，避免覆盖掉真实数据。
   另外记录「最近一次写入」的真实结果，/api/ping 会如实报告，不再靠猜。 */
const kvState = {
  ready: !useKV, ok: !useKV, error: '', tries: 0, at: 0,
  lastWriteAt: 0, lastWriteMs: 0, lastWriteOk: null, writeBytes: 0   // null = 还没写过
};

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
    schema: SCHEMA,
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
  d.schema = SCHEMA;
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

/* ---------------- 保存（本机文件 / 云端 Redis） ----------------
   写入规则（本次修复的核心）：
   ① 关键接口必须等「真正写进 Redis 成功」才回 ok，写失败回 503；
   ② 所有写操作排队串行执行，避免两次保存互相覆盖；
   ③ 写失败不会假装成功：内存里保留改动 + 后台按退避重试，
      接口明确告诉前端「staged（暂存）/ persisted（已落云端）」；
   ④ 云端还没加载完时一律拒绝写，防止用空库覆盖真实数据。
   --------------------------------------------------------------- */
let saveTimer = null;
let kvChain = Promise.resolve();     // 串行写队列
let dirtySinceWrite = false;         // 有改动还没成功写进云端
let retryTimer = null, retryMs = 0;

function writeFile(){
  try{
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, DB_FILE);
    kvState.lastWriteAt = Date.now();
    kvState.lastWriteOk = true;
    return true;
  }catch(e){
    kvState.lastWriteOk = false;
    kvState.error = '本机文件写入失败：' + e.message;
    console.error('[DB] 保存失败：' + e.message);
    return false;
  }
}

async function kvCmd(cmd, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || KV_TIMEOUT);
  try{
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: ctrl.signal
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || j.error) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j.result;
  }catch(e){
    if (e && e.name === 'AbortError') throw new Error('云端存储超时（' + (timeoutMs || KV_TIMEOUT) + 'ms 无响应）');
    throw e;
  }finally{ clearTimeout(timer); }
}

/* 启动时在后台把云端数据拉下来；失败就一直隔一会儿重试，永远不会挡住端口监听 */
async function loadKV(){
  kvState.tries++;
  try{
    const raw = await kvCmd(['GET', KV_KEY]);
    db = raw ? normalizeDB(JSON.parse(raw)) : normalizeDB(freshDB());
    kvState.ready = true; kvState.ok = true; kvState.error = ''; kvState.at = Date.now();
    console.log('[KV] 云端存储已连接：' + maskUrl(KV_URL) + '（员工 ' + db.roster.length + ' 人）');
    try { compactNs(true); } catch (e) { console.error('[NS] 旧命名空间合并失败：' + e.message); }
    if (dirtySinceWrite) commit('load').catch(() => {});
  }catch(e){
    kvState.ok = false;
    kvState.error = String((e && e.message) || e);
    console.error('[KV] 读取云端数据失败（第 ' + kvState.tries + ' 次）：' + kvState.error);
    console.error('[KV] 请检查 Render 里的 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 是否填对');
    if (!kvState.ready){
      const wait = Math.min(30000, 1000 * kvState.tries);
      setTimeout(loadKV, wait);
    }
  }
}

function scheduleRetry(){
  if (retryTimer) return;
  retryMs = retryMs ? Math.min(retryMs * 2, 60000) : 3000;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!dirtySinceWrite || !kvState.ready) return;
    commit('retry').catch(() => {});
  }, retryMs);
}

/* 真正落盘：返回 Promise，只有写入成功才 resolve */
function commit(reason){
  dirtySinceWrite = true;
  if (!useKV){
    return writeFile()
      ? Promise.resolve({ persisted: true, storage: 'file', bytes: 0, costMs: 0 })
      : Promise.reject(new Error('本机数据文件写入失败'));
  }
  if (!kvState.ready){
    scheduleRetry();
    return Promise.reject(new Error('云端数据还没加载完成，暂时不能写入（避免用空库覆盖真实数据）'));
  }
  const run = async () => {
    const json = JSON.stringify(db);          // 排队到这里时取最新快照，写的一定是最新状态
    const t0 = Date.now();
    await kvCmd(['SET', KV_KEY, json]);
    dirtySinceWrite = false;
    kvState.ok = true; kvState.error = '';
    kvState.lastWriteAt = Date.now();
    kvState.lastWriteMs = Date.now() - t0;
    kvState.lastWriteOk = true;
    kvState.writeBytes = Buffer.byteLength(json, 'utf8');
    retryMs = 0;
    return { persisted: true, storage: 'kv', bytes: kvState.writeBytes, costMs: kvState.lastWriteMs };
  };
  const p = kvChain.then(run, run);
  kvChain = p.then(() => {}, () => {});
  return p.catch(e => {
    kvState.ok = false;
    kvState.lastWriteOk = false;
    kvState.error = String((e && e.message) || e);
    console.error('[KV] 保存到云端失败：' + kvState.error + '（改动留在内存，后台重试）');
    scheduleRetry();
    throw e;
  });
}

/* 非关键路径：标记有改动，250ms 后合并成一次写；不阻塞调用方 */
function saveDB(){
  dirtySinceWrite = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; commit('debounce').catch(() => {}); }, 250);
}
/* 关键路径：等真正写成功才返回 */
function saveNow(){ return commit('request'); }

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

/* =========================================================
   任务 / 审核（P0）
   ---------------------------------------------------------
   存储：继续用现有的 ns.kv（每个员工一份 JSON），只新增键，不动老键、不做迁移：
     · 员工命名空间 dse_wb_<ns>_tasks_v2        该员工的任务（唯一数据源）
     · 主管命名空间 dse_wb_admin_reviewcfg_v2   免审策略
   权限：员工只能动自己 ns 里的任务；主管可以动全部。
   并发：Node 单线程，一个请求里的「读-改-写」是同步完成的，两个人同时改
        不会互相覆盖；落盘失败回 503，改动留在内存由后台重试补写，
        不会出现「页面说保存成功、云端其实没写」。
   ========================================================= */
const ST = {
  TODO: '待领取', WRITING: '写稿中', WAIT: '待审核', BACK: '需修改',
  PASS: '已通过', PUB: '已发布', DONE: '已完成', REJECT: '已否决'
};
const TASK_KEY = ns => 'dse_wb_' + ns + '_tasks_v2';
const CFG_KEY = 'dse_wb_admin_reviewcfg_v2';
/* 这些内容无论有没有免审权限，都必须主管看过（价格 / 升学承诺 / 成绩 / 机构对比等） */
const SENSITIVE_RE = /价格|学费|收费|报价|多少钱|优惠|折扣|承诺|保过|包过|保证|录取|升学|成绩|分数|排名|对比|退费|签约|合同/;

function nsRec(ns){
  if (!db.ns[ns]) db.ns[ns] = { rev: 0, kv: {} };
  const r = db.ns[ns];
  r.kv = (r.kv && typeof r.kv === 'object') ? r.kv : {};
  r.rev = Number(r.rev) || 0;
  return r;
}
function nsRead(ns, k, def){
  try{
    const raw = nsRec(ns).kv[k];
    if (typeof raw !== 'string' || !raw) return def;
    const v = JSON.parse(raw);
    return (v === null || v === undefined) ? def : v;
  }catch(e){ return def; }
}
/* 写回一个键：内容没变就不动版本号；变了才 +1，并标记需要落盘 */
function nsWrite(ns, k, obj){
  const rec = nsRec(ns);
  const val = JSON.stringify(obj);
  if (rec.kv[k] === val) return false;
  rec.kv[k] = val;
  rec.rev++;
  rec.at = Date.now();
  db.rev++;
  return true;
}
function taskList(ns){
  const list = nsRead(ns, TASK_KEY(ns), []);
  return Array.isArray(list) ? list.filter(x => x && x.id) : [];
}
function saveTaskList(ns, list){ return nsWrite(ns, TASK_KEY(ns), list); }
/* 主管视角：把每个员工命名空间里的任务汇总起来 */
function allTasks(){
  const out = [];
  Object.keys(db.ns).forEach(ns => {
    if (!/^u_[a-z0-9]+$/.test(ns)) return;
    taskList(ns).forEach(t => out.push(Object.assign({}, t, { empNs: ns })));
  });
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function findTask(id){
  const sid = String(id || '');
  for (const ns of Object.keys(db.ns)){
    if (!/^u_[a-z0-9]+$/.test(ns)) continue;
    const t = taskList(ns).find(x => x.id === sid);
    if (t) return { ns, task: t };
  }
  return null;
}
function reviewCfg(){
  const c = nsRead('admin', CFG_KEY, null);
  const o = (c && typeof c === 'object') ? c : {};
  return {
    exemptEmps: Array.isArray(o.exemptEmps) ? o.exemptEmps.filter(x => typeof x === 'string') : [],
    exemptTypes: Array.isArray(o.exemptTypes) ? o.exemptTypes.filter(x => typeof x === 'string') : []
  };
}
function isExempt(emp, ctype, cfg){
  return !!(cfg.exemptEmps.indexOf(emp) >= 0 || cfg.exemptTypes.indexOf(ctype) >= 0);
}
function isSensitive(txt){ return SENSITIVE_RE.test(String(txt || '')); }
function newTaskId(){ return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function nowStr(){ return new Date().toISOString().slice(0, 10); }
function pushLog(task, by, action, note){
  task.log = Array.isArray(task.log) ? task.log : [];
  task.log.push({ at: Date.now(), by: String(by || ''), action: String(action || ''), note: String(note || '').slice(0, 500) });
  if (task.log.length > 200) task.log = task.log.slice(-200);
  task.updatedAt = Date.now();
}
function cleanTaskInput(b){
  const s = v => String(v == null ? '' : v).trim();
  return {
    title: s(b.title).slice(0, 120),
    acctId: s(b.acctId).slice(0, 40),
    acctName: s(b.acctName).slice(0, 60),
    project: ['摘星', '遵理', 'DSE通用'].indexOf(s(b.project)) >= 0 ? s(b.project) : 'DSE通用',
    audience: ['家长', '学生'].indexOf(s(b.audience)) >= 0 ? s(b.audience) : '家长',
    ctype: ['流量型', '信任型', '转化型', '日常'].indexOf(s(b.ctype)) >= 0 ? s(b.ctype) : '日常',
    brief: s(b.brief).slice(0, 2000),
    due: s(b.due).slice(0, 10),
    priority: ['高', '中', '低'].indexOf(s(b.priority)) >= 0 ? s(b.priority) : '中'
  };
}
/* 员工只能用自己名下的账号（服务端校验，不能靠前端） */
function acctAllowed(ns, acctId, acctName){
  const list = nsRead(ns, 'dse_wb_' + ns + '_acct_v2', []);
  if (!Array.isArray(list) || !list.length) return true;   // 还没登记账号的老员工不拦
  if (acctId) return list.some(a => a && a.id === acctId);
  return list.some(a => a && a.name === acctName);
}
function acctMeta(ns, acctId, acctName){
  const list = nsRead(ns, 'dse_wb_' + ns + '_acct_v2', []);
  const hit = (Array.isArray(list) ? list : []).find(a => a && ((acctId && a.id === acctId) || (!acctId && a.name === acctName)));
  return hit ? { id: hit.id || acctId || '', name: hit.name || acctName || '', link: hit.link || '', persona: hit.persona || '' } : { id: acctId || '', name: acctName || '', link: '', persona: '' };
}
/* 发布时挂一条笔记记录：同一个任务只挂一条，重复点发布不会多出笔记 */
function linkDaily(task, ns, who){
  const list = nsRead(ns, 'dse_wb_' + ns + '_daily_v2', []);
  const arr = Array.isArray(list) ? list : [];
  if (arr.some(x => x && x.taskId === task.id)) return false;
  const acct = acctMeta(ns, task.acctId, task.acctName);
  const last = (task.versions || []).slice(-1)[0] || {};
  arr.unshift({
    id: 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    taskId: task.id, title: last.title || task.title, body: last.body || '',
    link: (task.publish && task.publish.link) || '', date: nowStr(),
    views: null, imp: null, like: null, cmt: null, cx: null, pending: true,
    note: '', status: '', acct: acct.name || task.acctName || who,
    acctLink: acct.link || '', persona: acct.persona || '', emp: who
  });
  nsWrite(ns, 'dse_wb_' + ns + '_daily_v2', arr);
  return true;
}
/* 把「需要落盘」的改动写进云端；失败按 503 如实回报，绝不假装成功 */
async function persistOr503(res, extra){
  try{
    const w = await saveNow();
    return send(res, 200, Object.assign({ ok: true, persisted: true, staged: false, storage: w.storage, costMs: w.costMs || 0 }, extra || {}));
  }catch(e){
    return send(res, 503, Object.assign({
      ok: false, persisted: false, staged: true, retryable: true,
      error: '云端存储暂时写不进去，改动已保留并将自动重试：' + String((e && e.message) || e)
    }, extra || {}));
  }
}

/* =========================================================
   飞书 CRM（多维表格）对接
   ---------------------------------------------------------
   主管在「主管后台 → 飞书 CRM」里填 App ID / App Secret / 多维表格链接，
   点「测试连接」→「一键同步」即可。配置随数据一起存进云端。
   方向：飞书 → 网站（客户线索）；网站 → 飞书（笔记数据）。
   ========================================================= */
const FS = String(process.env.FEISHU_API_BASE || 'https://open.feishu.cn/open-apis').replace(/\/+$/, '');
const crmRt = { tok: '', exp: 0, syncing: false, pushing: false, err: '', at: 0 };

/* 线索表字段别名：不同人建表用的名字不一样，这里按顺序找第一个存在的 */
const LEAD_ALIAS = {
  name:    ['名字', '姓名', '客户姓名', '学员姓名', '客户'],
  wx:      ['微信', '微信号'],
  phone:   ['手机号', '手机', '电话', '联系方式'],
  area:    ['客户省市', '省市', '地区', '城市'],
  grade:   ['在读年级', '年级'],
  system:  ['在读体系', '体系', '课程体系'],
  channel: ['渠道来源', '来源渠道', '渠道'],
  product: ['意向产品', '意向课程', '意向科目', '产品'],
  subject: ['科目需求', '科目'],
  stage:   ['客户阶段', '阶段', '销售阶段'],
  status:  ['意向状态', '状态'],
  owner:   ['客户销售负责人', '销售负责人', '负责人', '销售'],
  hk:      ['香港身份情况', '香港身份'],
  level:   ['客户层级', '层级'],
  amount:  ['意向金额', '金额'],
  cost:    ['教育成本', '成本'],
  emp:     ['来源员工', '来源账号', '归属员工', '对接员工', '归属人', '来源人'],
  time:    ['创建时间', '录入时间', '添加时间']
};

const NOTE_HEAD = ['日期', '员工', '人设', '账号', '账号主页', '笔记标题', '笔记链接', '浏览量', '点赞', '评论', '客资数', '备注'];

function crmCfg(){
  if (!db.crm || typeof db.crm !== 'object') db.crm = {};
  const c = db.crm;
  c.appId = String(c.appId || '').trim();
  c.secret = String(c.secret || '').trim();
  c.baseToken = String(c.baseToken || '').trim();
  c.baseUrl = String(c.baseUrl || '').trim();
  c.notesTableName = String(c.notesTableName || '笔记数据').trim();
  c.tables = (c.tables && typeof c.tables === 'object') ? c.tables : {};
  c.fields = (c.fields && typeof c.fields === 'object') ? c.fields : {};
  c.noteIds = (c.noteIds && typeof c.noteIds === 'object') ? c.noteIds : {};
  c.leads = Array.isArray(c.leads) ? c.leads : [];
  return c;
}
function crmConfigured(){ const c = crmCfg(); return !!(c.appId && c.secret && c.baseToken); }

async function fetchJson(url, opt, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 15000);
  try{
    const r = await fetch(url, Object.assign({}, opt, { signal: ctrl.signal }));
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    if (!j) throw new Error('飞书返回的不是 JSON（HTTP ' + r.status + '）：' + txt.slice(0, 120));
    return j;
  }catch(e){
    if (e && e.name === 'AbortError') throw new Error('请求飞书超时（' + (timeoutMs || 15000) + 'ms），检查服务器出网');
    throw e;
  }finally{ clearTimeout(timer); }
}

async function fsToken(force){
  const c = crmCfg();
  if (!force && crmRt.tok && Date.now() < crmRt.exp) return crmRt.tok;
  const j = await fetchJson(FS + '/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.secret })
  }, 12000);
  if (j.code !== 0 || !j.tenant_access_token){
    throw new Error('飞书鉴权失败（' + j.code + '）：' + (j.msg || '请检查 App ID / App Secret 是否填对'));
  }
  crmRt.tok = j.tenant_access_token;
  crmRt.exp = Date.now() + Math.max(60, (Number(j.expire) || 7200) - 180) * 1000;
  return crmRt.tok;
}

async function fsApi(method, path, body, timeoutMs){
  const run = async () => {
    const t = await fsToken();
    return fetchJson(FS + path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined
    }, timeoutMs || 20000);
  };
  let j = await run();
  if (j && (j.code === 99991661 || j.code === 99991663 || j.code === 99991668)){
    crmRt.tok = ''; crmRt.exp = 0;
    j = await run();
  }
  if (j && j.code !== 0){
    const msg = String(j.msg || '');
    const hint = /91403|1254302|forbidden|permission/i.test(j.code + msg)
      ? ' —— 多半是没把这个应用加成多维表格的协作者（表格右上角「…」→ 添加文档协作者 → 搜应用名 → 可编辑）'
      : '';
    throw new Error('飞书接口报错（' + j.code + '）：' + msg + hint);
  }
  return j.data;
}

/* 多维表格链接 → app_token（兼容 /base/ 与 /wiki/） */
async function fsResolveBase(raw){
  const c = crmCfg();
  const s = String(raw || c.baseUrl || c.baseToken || '').trim();
  c.baseUrl = s;
  const mBase = s.match(/\/base\/([A-Za-z0-9]+)/);
  const mWiki = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (mBase){
    c.baseToken = mBase[1]; c.baseKind = 'base';
  }else if (mWiki){
    const d = await fsApi('GET', '/wiki/v2/spaces/get_node?token=' + mWiki[1] + '&obj_type=wiki');
    c.baseToken = String((d && d.node && d.node.obj_token) || '');
    c.baseKind = 'wiki';
    if (!c.baseToken) throw new Error('这个知识库节点不是多维表格，或应用没开 wiki 权限（wiki:wiki:readonly）');
  }else{
    c.baseToken = s.replace(/[?&#].*$/, ''); c.baseKind = 'base';
  }
  if (!c.baseToken) throw new Error('看不懂这个链接，请复制多维表格地址栏里的完整网址');
  const mt = s.match(/[?&]table=([A-Za-z0-9]+)/);
  if (mt && !c.tables.leads) c.tables.leads = mt[1];
  return c.baseToken;
}

async function fsTables(){
  const bt = crmCfg().baseToken;
  const out = []; let pt = '';
  for (let i = 0; i < 10; i++){
    const d = await fsApi('GET', '/bitable/v1/apps/' + bt + '/tables?page_size=100' + (pt ? '&page_token=' + encodeURIComponent(pt) : ''));
    (d && d.items || []).forEach(x => out.push({ table_id: x.table_id, name: x.name }));
    if (!d || !d.has_more) break;
    pt = d.page_token || '';
  }
  return out;
}

async function fsRecords(tableId){
  const bt = crmCfg().baseToken;
  const out = []; let pt = '';
  for (let i = 0; i < 50; i++){
    const d = await fsApi('GET', '/bitable/v1/apps/' + bt + '/tables/' + tableId + '/records?page_size=500' + (pt ? '&page_token=' + encodeURIComponent(pt) : ''));
    (d && d.items || []).forEach(x => out.push(x));
    if (!d || !d.has_more) break;
    pt = d.page_token || '';
  }
  return out;
}

async function fsFields(tableId){
  const bt = crmCfg().baseToken;
  const d = await fsApi('GET', '/bitable/v1/apps/' + bt + '/tables/' + tableId + '/fields?page_size=100');
  return (d && d.items || []).map(x => ({ field_id: x.field_id, field_name: x.field_name, type: x.type }));
}

/* 飞书字段值 → 纯文本 / 数字 / 日期（单选是字符串、人员是数组、公式是 {value:[]}） */
function fText(v){
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fText).filter(x => x !== '').join('、');
  if (typeof v === 'object'){
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.link === 'string') return v.link;
    if (v.value !== undefined) return fText(v.value);
  }
  return '';
}
function fNum(v){
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return fNum(v[0]);
  if (typeof v === 'object') return fNum(v.value !== undefined ? v.value : v.text);
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
function fDate(v){
  if (!v) return '';
  if (typeof v === 'number' || /^\d+$/.test(String(v))){
    const d = new Date(Number(v));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const s = String(v);
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  return '';
}
function pickField(keys, aliases){
  for (const a of aliases) if (keys.indexOf(a) >= 0) return a;
  for (const k of keys) for (const a of aliases) if (k.indexOf(a) >= 0) return k;
  return '';
}

async function crmSyncLeads(){
  const c = crmCfg();
  if (!crmConfigured()) throw new Error('还没配置飞书 CRM（App ID / Secret / 表格链接）');
  if (!c.tables.leads) throw new Error('还没选线索表，先点「测试连接」再选一个表');
  crmRt.syncing = true; crmRt.err = '';
  try{
    const recs = await fsRecords(c.tables.leads);
    const keys = recs.length ? Object.keys(recs[0].fields || {}) : [];
    const map = {};
    Object.keys(LEAD_ALIAS).forEach(k => { map[k] = pickField(keys, LEAD_ALIAS[k]); });
    c.fields = map;
    const pick = (f, k) => (map[k] ? f[map[k]] : undefined);
    c.leads = recs.map(r => {
      const f = r.fields || {};
      return {
        rid: r.record_id,
        name: fText(pick(f, 'name')),
        wx: fText(pick(f, 'wx')),
        phone: fText(pick(f, 'phone')),
        area: fText(pick(f, 'area')),
        grade: fText(pick(f, 'grade')),
        system: fText(pick(f, 'system')),
        channel: fText(pick(f, 'channel')),
        product: fText(pick(f, 'product')),
        subject: fText(pick(f, 'subject')),
        stage: fText(pick(f, 'stage')),
        status: fText(pick(f, 'status')),
        owner: fText(pick(f, 'owner')),
        hk: fText(pick(f, 'hk')),
        level: fText(pick(f, 'level')),
        amount: fNum(pick(f, 'amount')),
        cost: fText(pick(f, 'cost')),
        emp: fText(pick(f, 'emp')).trim(),
        date: fDate(pick(f, 'time'))
      };
    }).filter(x => x.name || x.wx || x.phone);
    c.lastSync = Date.now();
    c.leadCount = c.leads.length;
    db.rev++;
    saveDB();
    crmRt.at = Date.now();
    console.log('[CRM] 已同步线索 ' + c.leads.length + ' 条（' + keys.length + ' 个字段）');
    return { count: c.leads.length, fields: map, table: c.tables.leads };
  }catch(e){
    crmRt.err = String((e && e.message) || e);
    throw e;
  }finally{ crmRt.syncing = false; }
}

/* 服务端直接从各员工命名空间里的上报数据算出笔记列表（不依赖页面） */
function serverNotes(){
  const out = [];
  Object.keys(db.ns || {}).forEach(ns => {
    const kv = (db.ns[ns] || {}).kv || {};
    let who = '';
    try { const w = JSON.parse(kv['dse_wb_' + ns + '_who_v2'] || '""'); who = typeof w === 'string' ? w : ''; } catch (e) {}
    let arr = [];
    try { arr = JSON.parse(kv['dse_wb_' + ns + '_daily_v2'] || '[]'); } catch (e) {}
    if (!Array.isArray(arr)) return;
    arr.forEach(x => {
      if (!x || (!x.title && !x.link)) return;
      out.push({
        ns: ns, emp: who || x.acct || '', persona: x.persona || '',
        acct: x.acct || '', acctLink: x.acctLink || '',
        title: x.title || '', link: x.link || '', date: x.date || '',
        views: +x.views || 0, like: +x.like || 0, cmt: +x.cmt || 0, cx: +x.cx || 0,
        note: x.note || ''
      });
    });
  });
  return out;
}

/* 防丢合并：日报/任务这类「带 id 的数组」，云端已有的条目不会被更短的数组冲掉。
   员工端删记录时会在 _trash_v2 里留下 id，这里按 id 过滤，所以删除依然生效。 */
function protectDaily(ns, key, oldStr, newStr){
  if (!/(_daily_v2|_tasks_v2)$/.test(key)) return newStr;
  let a, b;
  try { a = JSON.parse(oldStr || '[]'); } catch (e){ return newStr; }
  try { b = JSON.parse(newStr || '[]'); } catch (e){ return newStr; }
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length) return newStr;
  const idOf = x => (x && typeof x === 'object' && x.id != null) ? String(x.id) : '';
  if (!a.every(idOf) || !b.every(idOf)) return newStr;
  const trash = {};
  try {
    const t = JSON.parse((((db.ns[ns] || {}).kv) || {})['dse_wb_' + ns + '_trash_v2'] || '[]');
    if (Array.isArray(t)) t.forEach(x => { const id = String((x && x.id) || x); if (id) trash[id] = 1; });
  } catch (e) {}
  const seen = {}, out = [];
  b.forEach(x => {
    const id = idOf(x);
    if (trash[id]) return;
    if (!seen[id]) { seen[id] = 1; out.push(x); }
  });
  a.forEach(x => {
    const id = idOf(x);
    if (!id || trash[id] || seen[id]) return;
    seen[id] = 1;
    out.push(x);
  });
  return out.length === b.length ? newStr : JSON.stringify(out);
}

async function crmEnsureNotesTable(){
  const c = crmCfg();
  const tables = await fsTables();
  let t = tables.find(x => x.name === c.notesTableName);
  if (!t){
    const d = await fsApi('POST', '/bitable/v1/apps/' + c.baseToken + '/tables', {
      table: {
        name: c.notesTableName,
        default_view_name: '全部笔记',
        fields: NOTE_HEAD.map((n, i) => ({ field_name: n, type: (n === '日期') ? 5 : (['浏览量', '点赞', '评论', '客资数'].indexOf(n) >= 0 ? 2 : 1) }))
      }
    });
    t = { table_id: d.table_id, name: c.notesTableName };
  }
  c.tables.notes = t.table_id;
  /* 补上后来新增的列（比如以前建的旧表） */
  const have = (await fsFields(t.table_id)).map(x => x.field_name);
  for (const n of NOTE_HEAD){
    if (have.indexOf(n) >= 0) continue;
    const type = (n === '日期') ? 5 : (['浏览量', '点赞', '评论', '客资数'].indexOf(n) >= 0 ? 2 : 1);
    await fsApi('POST', '/bitable/v1/apps/' + c.baseToken + '/tables/' + t.table_id + '/fields', { field_name: n, type: type });
  }
  return t.table_id;
}

async function crmPushNotes(){
  const c = crmCfg();
  if (!crmConfigured()) throw new Error('还没配置飞书 CRM');
  crmRt.pushing = true; crmRt.err = '';
  try{
    const tid = await crmEnsureNotesTable();
    const notes = serverNotes();
    const toCreate = [], toUpdate = [];
    notes.forEach(n => {
      const key = n.link ? ('L' + n.link) : ('T' + n.date + '|' + n.emp + '|' + n.title);
      const fields = {
        '日期': n.date ? Date.parse(n.date + 'T00:00:00+08:00') : null,
        '员工': n.emp, '人设': n.persona, '账号': n.acct, '账号主页': n.acctLink,
        '笔记标题': n.title, '笔记链接': n.link,
        '浏览量': n.views, '点赞': n.like, '评论': n.cmt, '客资数': n.cx, '备注': n.note
      };
      Object.keys(fields).forEach(k => { if (fields[k] === null) delete fields[k]; });
      const rid = c.noteIds[key];
      if (rid) toUpdate.push({ record_id: rid, fields: fields });
      else toCreate.push({ key: key, fields: fields });
    });
    let created = 0, updated = 0;
    for (let i = 0; i < toCreate.length; i += 200){
      const chunk = toCreate.slice(i, i + 200);
      const d = await fsApi('POST', '/bitable/v1/apps/' + c.baseToken + '/tables/' + tid + '/records/batch_create', {
        records: chunk.map(x => ({ fields: x.fields }))
      });
      created += chunk.length;
      const back = (d && d.records) || [];
      chunk.forEach((x, i2) => { const r = back[i2]; if (r && r.record_id) c.noteIds[x.key] = r.record_id; });
    }
    for (let i = 0; i < toUpdate.length; i += 200){
      const chunk = toUpdate.slice(i, i + 200);
      await fsApi('POST', '/bitable/v1/apps/' + c.baseToken + '/tables/' + tid + '/records/batch_update', { records: chunk });
      updated += chunk.length;
    }
    c.lastPush = Date.now();
    c.noteCount = notes.length;
    db.rev++;
    saveDB();
    crmRt.at = Date.now();
    console.log('[CRM] 笔记已推送：新增 ' + created + ' · 更新 ' + updated);
    return { created: created, updated: updated, total: notes.length };
  }catch(e){
    crmRt.err = String((e && e.message) || e);
    throw e;
  }finally{ crmRt.pushing = false; }
}

function crmPublic(){
  const c = crmCfg();
  const leads = c.leads || [];
  const byEmp = {};
  leads.forEach(x => {
    const k = x.emp || '未标注';
    byEmp[k] = (byEmp[k] || 0) + 1;
  });
  return {
    ok: true,
    configured: crmConfigured(),
    appId: c.appId,
    secretSet: !!c.secret,
    baseUrl: c.baseUrl,
    baseToken: c.baseToken,
    baseKind: c.baseKind || '',
    tables: c.tables,
    notesTableName: c.notesTableName,
    fields: c.fields,
    leadCount: leads.length,
    byEmp: byEmp,
    lastSync: c.lastSync || 0,
    lastPush: c.lastPush || 0,
    noteCount: c.noteCount || 0,
    syncing: crmRt.syncing,
    pushing: crmRt.pushing,
    error: crmRt.err || ''
  };
}

/* 日志里不打印完整连接串，只留主机名首尾 */
function maskUrl(u){
  try {
    const h = new URL(u).hostname, p = h.split('.');
    return p.length > 2 ? (p[0].slice(0, 2) + '***.' + p.slice(1).join('.')) : '***';
  } catch (e) { return '***'; }
}

/* ---------------- 健康检查 ---------------- */
/* 分级：进程正常 / 云端可连（读成功）/ 最近一次写成功 / 写入能力主动探测。
   写探测用独立测试键（KV_KEY + ':health'），只在 ?probe=write 时触发，
   最低间隔 60 秒，用完立刻 DEL，绝不碰业务数据。 */
const health = { at: 0, ok: false, err: '', ms: 0 };
async function probeWrite(){
  if (!useKV) return { ok: true, storage: 'file', at: Date.now(), ms: 0, note: '本机文件模式，无需探测' };
  const now = Date.now();
  if (health.at && now - health.at < 60000){
    return { ok: health.ok, cached: true, at: health.at, ms: health.ms, error: health.err || null };
  }
  const key = KV_KEY + ':health';
  const token = crypto.randomBytes(6).toString('hex');
  const t0 = Date.now();
  try{
    await kvCmd(['SET', key, token], 5000);
    const back = await kvCmd(['GET', key], 5000);
    if (String(back) !== token) throw new Error('写入后读回不一致');
    health.ok = true; health.err = '';
  }catch(e){
    health.ok = false; health.err = String((e && e.message) || e);
  }finally{
    health.ms = Date.now() - t0; health.at = Date.now();
    kvCmd(['DEL', key], 3000).catch(() => {});
  }
  return { ok: health.ok, cached: false, at: health.at, ms: health.ms, error: health.err || null, testKey: key };
}

/* ---------------- API ---------------- */
async function handleApi(req, res, u, p){
  if (p === '/api/ping'){
    const dbInfo = {
      storage: useKV ? 'kv' : 'file',
      loaded: kvState.ready,                       // 启动时是否成功读到云端数据
      readOk: kvState.ok,                          // 最近一次云端读写是否正常
      readAt: kvState.at || 0,
      writeOk: useKV ? kvState.lastWriteOk : true, // 最近一次真实写入是否成功
      lastWriteAt: kvState.lastWriteAt || 0,
      lastWriteMs: kvState.lastWriteMs || 0,
      writeBytes: kvState.writeBytes || 0,
      pendingWrite: dirtySinceWrite                // 还有改动没落云端
    };
    if (u.searchParams.get('probe') === 'write') dbInfo.probe = await probeWrite();
    return send(res, 200, {
      ok: true, app: 'dse-workbench', build: BUILD, schema: SCHEMA,
      employees: db.roster.length, rev: db.rev,
      storage: dbInfo.storage,
      kvReady: kvState.ready, kvOk: kvState.ok, kvError: kvState.error || null,
      uptimeSec: Math.round(process.uptime()),
      crm: crmConfigured(),
      db: dbInfo
    });
  }

  /* 云端数据还没加载好（Upstash 慢/连不上）时，先明确告诉前端在恢复，
     而不是返回空数据让页面看起来「数据全没了」。 */
  if (useKV && !kvState.ready){
    return send(res, 503, { ok: false, loading: true, error: '云端数据正在重新连接，请 10 秒后再试一次' });
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

  /* ---------------- 飞书 CRM ---------------- */
  if (p.indexOf('/api/crm') === 0){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以操作 CRM 同步' });

    /* 当前配置 + 同步状态 */
    if (p === '/api/crm' && req.method === 'GET'){
      return send(res, 200, crmPublic());
    }

    /* 保存配置（secret 留空表示不修改） */
    if (p === '/api/crm/config' && req.method === 'POST'){
      const b = await readBody(req);
      const c = crmCfg();
      if (typeof b.appId === 'string') c.appId = b.appId.trim();
      if (typeof b.secret === 'string' && b.secret.trim()) { c.secret = b.secret.trim(); crmRt.tok = ''; crmRt.exp = 0; }
      if (typeof b.baseUrl === 'string') c.baseUrl = b.baseUrl.trim();
      if (typeof b.notesTableName === 'string' && b.notesTableName.trim()) c.notesTableName = b.notesTableName.trim();
      if (b.tables && typeof b.tables === 'object'){
        if (b.tables.leads) c.tables.leads = String(b.tables.leads);
      }
      db.rev++; saveDB();
      return send(res, 200, crmPublic());
    }

    /* 测试连接：拿 token + 列出所有数据表 */
    if (p === '/api/crm/test' && req.method === 'POST'){
      try{
        const b = await readBody(req);
        const c = crmCfg();
        if (b && typeof b.appId === 'string' && b.appId.trim()) c.appId = b.appId.trim();
        if (b && typeof b.secret === 'string' && b.secret.trim()) { c.secret = b.secret.trim(); crmRt.tok = ''; crmRt.exp = 0; }
        if (b && typeof b.baseUrl === 'string') c.baseUrl = b.baseUrl.trim();
        if (!c.appId || !c.secret) throw new Error('先填 App ID 和 App Secret');
        if (!c.baseUrl && !c.baseToken) throw new Error('先填多维表格链接');
        await fsResolveBase(c.baseUrl);
        const tables = await fsTables();
        const guess = tables.find(x => /线索|客户/.test(x.name)) || tables.find(x => /线索/.test(x.name)) || null;
        return send(res, 200, { ok: true, tables: tables, baseToken: c.baseToken, suggest: guess ? guess.table_id : '' });
      }catch(e){
        crmRt.err = String((e && e.message) || e);
        return send(res, 400, { ok: false, error: crmRt.err });
      }
    }

    /* 一键同步线索（飞书 → 网站） */
    if (p === '/api/crm/sync' && req.method === 'POST'){
      try{
        const b = await readBody(req);
        if (b && b.table) crmCfg().tables.leads = String(b.table);
        const r = await crmSyncLeads();
        return send(res, 200, Object.assign({ ok: true }, r, { status: crmPublic() }));
      }catch(e){
        return send(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
    }

    /* 一键把笔记推回飞书（网站 → 飞书） */
    if (p === '/api/crm/push' && req.method === 'POST'){
      try{
        const r = await crmPushNotes();
        return send(res, 200, Object.assign({ ok: true }, r, { status: crmPublic() }));
      }catch(e){
        return send(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
    }

    /* 线索明细（客资页用） */
    if (p === '/api/crm/leads' && req.method === 'GET'){
      const month = String(u.searchParams.get('month') || '');
      const emp = String(u.searchParams.get('emp') || '');
      let list = crmCfg().leads || [];
      if (month) list = list.filter(x => (x.date || '').slice(0, 7) === month || !x.date);
      if (emp) list = list.filter(x => x.emp === emp);
      return send(res, 200, { ok: true, total: list.length, leads: list });
    }

    return send(res, 404, { ok: false, error: 'CRM 接口不存在' });
  }

  /* 读自己那份数据 */
  if (p === '/api/state' && req.method === 'GET'){
    const rec = db.ns[me.ns] || { rev: 0, kv: {} };
    const since = Number(u.searchParams.get('since') || -1);
    if (since === (rec.rev || 0)) return send(res, 200, { ok: true, rev: rec.rev || 0, unchanged: true });
    return send(res, 200, { ok: true, rev: rec.rev || 0, kv: rec.kv || {} });
  }

  /* 写自己那份数据（按 key 增量合并，避免互相覆盖）
     - baseRev：前端带上「自己上次看到的版本」，不一致说明另一台设备也在改 → 409 交回最新版
     - 只有真正写进云端才回 ok:true；写不进去回 503 + persisted:false + staged:true */
  if (p === '/api/state' && req.method === 'POST'){
    const b = await readBody(req);
    const patch = b && b.patch && typeof b.patch === 'object' ? b.patch : null;
    if (!patch) return send(res, 400, { ok: false, error: 'patch 为空' });
    const rec = db.ns[me.ns] || (db.ns[me.ns] = { rev: 0, kv: {} });
    rec.kv = rec.kv || {};
    const hasBase = b && b.baseRev !== undefined && b.baseRev !== null && b.baseRev !== '';
    if (hasBase){
      const base = Number(b.baseRev);
      if (Number.isFinite(base) && base !== (rec.rev || 0)){
        return send(res, 409, {
          ok: false, conflict: true,
          error: '另一台设备也在修改这份数据，请合并后再保存',
          rev: db.rev, nsRev: rec.rev || 0, kv: rec.kv || {}
        });
      }
    }
    let n = 0;
    Object.keys(patch).forEach(k => {
      if (!/^dse_(wb_|admin_)/.test(k)) return;         // 只接受工作台的键
      let v = patch[k];
      if (typeof v !== 'string') return;
      v = protectDaily(me.ns, k, rec.kv[k], v);         // 云端已有的日报条目不会被短数组冲掉
      if (rec.kv[k] !== v){ rec.kv[k] = v; n++; }
    });
    if (n){
      rec.rev = (rec.rev || 0) + 1;
      rec.at = Date.now();
      db.rev++;
    }
    /* 没有实际变化、也没有积压的改动：不需要写，直接如实回报 */
    if (!n && !dirtySinceWrite){
      return send(res, 200, {
        ok: true, persisted: true, staged: false, changed: 0,
        rev: db.rev, nsRev: rec.rev || 0,
        storage: useKV ? 'kv' : 'file', at: Date.now()
      });
    }
    try{
      const w = await saveNow();
      return send(res, 200, {
        ok: true, persisted: true, staged: false, changed: n,
        rev: db.rev, nsRev: rec.rev || 0,
        storage: w.storage, bytes: w.bytes || 0, costMs: w.costMs || 0, at: Date.now()
      });
    }catch(e){
      return send(res, 503, {
        ok: false, persisted: false, staged: true, retryable: true, changed: n,
        rev: db.rev, nsRev: rec.rev || 0,
        error: '云端存储暂时写不进去，改动已保留并将自动重试：' + String((e && e.message) || e)
      });
    }
  }

  /* 主管：拉全团队数据（含员工名单） */
  if (p === '/api/all' && req.method === 'GET'){
    if (me.r !== 'admin') return send(res, 403, { ok: false, error: '只有主管可以拉全员数据' });
    compactNs();
    const since = Number(u.searchParams.get('since') || -1);
    if (since === db.rev) return send(res, 200, { ok: true, rev: db.rev, unchanged: true, nsRev: (db.ns['admin'] && db.ns['admin'].rev) || 0 });
    return send(res, 200, {
      ok: true, rev: db.rev, ns: db.ns, roster: publicRoster(), adminName: db.admin.name,
      nsRev: (db.ns['admin'] && db.ns['admin'].rev) || 0
    });
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
      let v = patch[k];
      if (typeof v !== 'string') return;
      v = protectDaily(ns, k, rec.kv[k], v);            // 主管导入/恢复也不会把云端日报冲少
      if (rec.kv[k] !== v){ rec.kv[k] = v; n++; }
    });
    if (n){ rec.rev = (rec.rev || 0) + 1; rec.at = Date.now(); db.rev++; }
    if (!n && !dirtySinceWrite) return send(res, 200, { ok: true, persisted: true, staged: false, rev: db.rev, nsRev: rec.rev, changed: 0 });
    try{
      const w = await saveNow();
      return send(res, 200, { ok: true, persisted: true, staged: false, rev: db.rev, nsRev: rec.rev, changed: n, storage: w.storage, costMs: w.costMs || 0 });
    }catch(e){
      return send(res, 503, { ok: false, persisted: false, staged: true, retryable: true, rev: db.rev, nsRev: rec.rev, changed: n, error: '云端存储暂时写不进去，改动已保留并将自动重试：' + String((e && e.message) || e) });
    }
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
        const old = db.roster.find(x => x.name === nm);
        let pw = String(raw.pass == null ? '' : raw.pass).trim().slice(0, 24);
        /* 密码框留空＝不改（名单接口不回传密码，避免编辑别处时把密码冲掉）；
           要取消密码必须显式传 clearPass:true */
        if (raw.clearPass === true) pw = '';
        else if (!pw && old) pw = old.pass || '';
        out.push({
          name: nm,
          persona: (raw.persona === '摘星' || raw.persona === '遵理') ? raw.persona : '',
          pass: pw,
          active: raw.active !== false,
          note: String(raw.note || '').slice(0, 40),
          at: raw.at || Date.now()
        });
      }
      db.roster = out;
      db.rev++;
      try{
        await saveNow();
        return send(res, 200, { ok: true, persisted: true, roster: publicRoster() });
      }catch(e){
        return send(res, 503, {
          ok: false, persisted: false, staged: true, retryable: true, roster: publicRoster(),
          error: '名单已在本机生效，但还没写进云端，会自动重试：' + String((e && e.message) || e)
        });
      }
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
    try{
      await saveNow();
      return send(res, 200, { ok: true, persisted: true });
    }catch(e){
      return send(res, 503, { ok: false, persisted: false, staged: true, retryable: true, error: '口令已在本机生效，但还没写进云端，会自动重试：' + String((e && e.message) || e) });
    }
  }

  /* ---------------- 任务 / 审核（P0） ---------------- */
  if (p === '/api/task' && req.method === 'GET'){
    const cfg = reviewCfg();
    if (me.r === 'admin'){
      return send(res, 200, { ok: true, role: 'admin', tasks: allTasks(), cfg: cfg, roster: publicRoster(), rev: db.rev });
    }
    /* 员工只返回「负责人是自己」的任务；即使命名空间里混进别人的数据也不带出去 */
    const mine = taskList(me.ns).filter(t => t && t.emp === me.n);
    return send(res, 200, { ok: true, role: 'emp', tasks: mine, rev: db.rev });
  }

  if (p === '/api/task' && req.method === 'POST'){
    const b = await readBody(req);
    const action = String(b.action || '');
    const isAdmin = me.r === 'admin';
    const who = isAdmin ? (db.admin.name || '主管') : me.n;
    const cfg = reviewCfg();

    /* ① 主管派任务 / 批量导入 */
    if (action === 'assign' || action === 'import'){
      if (!isAdmin) return send(res, 403, { ok: false, error: '只有主管可以分配任务' });
      const rows = action === 'import' ? (Array.isArray(b.rows) ? b.rows : []) : [b.task || b];
      if (!rows.length) return send(res, 400, { ok: false, error: '没有可创建的任务' });
      if (rows.length > 200) return send(res, 400, { ok: false, error: '一次最多导入 200 条' });
      const created = [], skipped = [];
      const changedNs = {};
      rows.forEach((raw, i) => {
        const emp = String((raw && raw.emp) || '').trim().slice(0, 24);
        const person = db.roster.find(x => x.name === emp);
        if (!person){ skipped.push({ row: i + 1, emp: emp, reason: '员工不在名单里' }); return; }
        const v = cleanTaskInput(raw);
        if (!v.title){ skipped.push({ row: i + 1, emp: emp, reason: '选题标题为空' }); return; }
        const ns = empNs(emp);
        const list = changedNs[ns] || (changedNs[ns] = taskList(ns));
        if (action === 'import'){
          const dup = list.some(t => t.emp === emp && (t.acctName || '') === v.acctName && t.title === v.title && (t.due || '') === v.due);
          if (dup){ skipped.push({ row: i + 1, emp: emp, title: v.title, reason: '重复任务，已跳过' }); return; }
        }
        const t = Object.assign({
          id: newTaskId(), emp: emp, empNs: ns, status: ST.TODO, selfCreated: false,
          createdAt: Date.now(), createdBy: who, versions: [], log: []
        }, v, { acctName: v.acctName || acctMeta(ns, v.acctId, '').name || '' });
        pushLog(t, who, '分配任务', v.due ? ('截止 ' + v.due) : '');
        list.unshift(t);
        created.push(t);
      });
      Object.keys(changedNs).forEach(ns => saveTaskList(ns, changedNs[ns]));
      if (!created.length) return send(res, 200, { ok: true, persisted: true, created: [], skipped: skipped, changed: 0 });
      return persistOr503(res, { created: created, skipped: skipped });
    }

    /* ② 员工自主选题（默认进待审核） */
    if (action === 'selfCreate'){
      if (isAdmin) return send(res, 400, { ok: false, error: '主管请用「分配任务」创建' });
      const ns = me.ns;
      const v = cleanTaskInput(b);
      if (!v.title) return send(res, 400, { ok: false, error: '选题标题不能为空' });
      if (!acctAllowed(ns, v.acctId, v.acctName)) return send(res, 403, { ok: false, error: '只能选择自己有权限的账号' });
      const body = String(b.body == null ? '' : b.body);
      if (!body.trim()) return send(res, 400, { ok: false, error: '内容初稿不能为空' });
      const meta = acctMeta(ns, v.acctId, v.acctName);
      const t = Object.assign({
        id: newTaskId(), emp: me.n, empNs: ns, status: ST.WAIT, selfCreated: true,
        createdAt: Date.now(), createdBy: me.n, planAt: String(b.planAt || '').slice(0, 10),
        versions: [{ n: 1, title: v.title, body: body, tags: String(b.tags || ''), at: Date.now() }], log: []
      }, v, { acctId: meta.id || v.acctId, acctName: meta.name || v.acctName });
      t.review = { action: 'submit', by: me.n, at: Date.now(), note: '' };
      pushLog(t, me.n, '自主选题并提交', '');
      const exempt = isExempt(me.n, t.ctype, cfg) && !isSensitive(t.title + body);
      if (exempt){
        t.status = ST.PASS;
        t.review = { action: 'approve', by: '系统', at: Date.now(), note: '免审员工/免审内容类型，且不涉及敏感信息', auto: true };
        pushLog(t, '系统', '自动通过（免审）', '');
      }
      const list = taskList(ns);
      list.unshift(t);
      saveTaskList(ns, list);
      return persistOr503(res, { task: t });
    }

    /* ③ 员工存草稿 / 提交审核 / 登记发布 / 完成复盘 */
    if (['saveDraft', 'submit', 'publish', 'done'].indexOf(action) >= 0){
      const hit = findTask(b.id);
      if (!hit) return send(res, 404, { ok: false, error: '任务不存在' });
      if (!isAdmin && (hit.ns !== me.ns || hit.task.emp !== me.n)) return send(res, 403, { ok: false, error: '不能操作别人的任务' });
      const t = hit.task;
      const title = String(b.title == null ? '' : b.title).trim().slice(0, 120);
      const body = String(b.body == null ? '' : b.body);
      const tags = String(b.tags == null ? '' : b.tags).slice(0, 500);

      if (action === 'saveDraft'){
        if ([ST.TODO, ST.WRITING, ST.BACK].indexOf(t.status) < 0) return send(res, 409, { ok: false, error: '当前状态不能再存草稿（' + t.status + '）' });
        if (title || body) t.draft = { title: title, body: body, tags: tags, at: Date.now() };
        if (t.status === ST.TODO){ t.status = ST.WRITING; pushLog(t, who, '开始写稿', ''); }
        pushLog(t, who, '暂存草稿', '');
      } else if (action === 'submit'){
        if ([ST.TODO, ST.WRITING, ST.BACK].indexOf(t.status) < 0) return send(res, 409, { ok: false, error: '当前状态不能提交审核（' + t.status + '）' });
        if (!title) return send(res, 400, { ok: false, error: '标题不能为空' });
        if (!body.trim()) return send(res, 400, { ok: false, error: '正文不能为空' });
        t.versions = Array.isArray(t.versions) ? t.versions : [];
        const n = (t.versions.slice(-1)[0] || {}).n || 0;
        t.versions.push({ n: n + 1, title: title, body: body, tags: tags, at: Date.now() });
        t.draft = null;
        t.status = ST.WAIT;
        t.submitAt = Date.now();
        t.review = { action: 'submit', by: who, at: Date.now(), note: '' };
        pushLog(t, who, '提交审核', '第 ' + (n + 1) + ' 版');
        if (isExempt(t.emp || who, t.ctype, cfg) && !isSensitive(title + body)){
          t.status = ST.PASS;
          t.review = { action: 'approve', by: '系统', at: Date.now(), note: '免审员工/免审内容类型，且不涉及敏感信息', auto: true };
          pushLog(t, '系统', '自动通过（免审）', '');
        }
      } else if (action === 'publish'){
        const emergency = !!b.emergency && isAdmin;
        const link = String(b.link || '').trim().slice(0, 500);
        if (!link) return send(res, 400, { ok: false, error: '请填发布后的笔记链接' });
        const okStates = emergency ? [ST.WAIT, ST.BACK, ST.PASS] : [ST.PASS];
        if (okStates.indexOf(t.status) < 0){
          return send(res, 409, { ok: false, error: emergency ? '这个状态不能直接发布' : '还没通过审核，不能登记发布（' + t.status + '）' });
        }
        t.publish = { link: link, at: Date.now(), by: who, emergency: emergency };
        t.status = ST.PUB;
        linkDaily(t, hit.ns, t.emp || who);
        pushLog(t, who, emergency ? '主管紧急发布（免审核）' : '登记发布', link);
      } else if (action === 'done'){
        if (t.status !== ST.PUB) return send(res, 409, { ok: false, error: '只有已发布的任务能标记完成' });
        t.status = ST.DONE;
        t.doneAt = Date.now();
        pushLog(t, who, '完成复盘', '');
      }

      const list = taskList(hit.ns);
      const i = list.findIndex(x => x.id === t.id);
      if (i >= 0) list[i] = t;
      saveTaskList(hit.ns, list);
      return persistOr503(res, { task: t });
    }

    /* ④ 主管修改任务 / 撤回任务 */
    if (action === 'update' || action === 'delete'){
      if (!isAdmin) return send(res, 403, { ok: false, error: '只有主管可以修改或撤回任务' });
      const hit = findTask(b.id);
      if (!hit) return send(res, 404, { ok: false, error: '任务不存在' });
      const t = hit.task;
      if ([ST.PUB, ST.DONE].indexOf(t.status) >= 0){
        return send(res, 409, { ok: false, error: '已发布/已完成的任务不能改或撤回，否则会和线上笔记对不上' });
      }

      if (action === 'delete'){
        const list = taskList(hit.ns);
        const i = list.findIndex(x => x.id === t.id);
        if (i >= 0) list.splice(i, 1);
        saveTaskList(hit.ns, list);
        /* 留一份审计快照，方便事后追查 */
        const lg = nsRead('admin', 'dse_wb_admin_tasklog_v2', []);
        const arr = Array.isArray(lg) ? lg : [];
        arr.unshift({ at: Date.now(), by: who, action: 'delete', taskId: t.id, emp: t.emp, title: t.title, status: t.status, snapshot: t });
        nsWrite('admin', 'dse_wb_admin_tasklog_v2', arr.slice(0, 500));
        return persistOr503(res, { removed: t.id });
      }

      const v = cleanTaskInput(b);
      if (!v.title) return send(res, 400, { ok: false, error: '选题标题不能为空' });
      const newEmp = String(b.emp || '').trim() || t.emp;
      if (newEmp !== t.emp){
        const person = db.roster.find(x => x.name === newEmp);
        if (!person) return send(res, 400, { ok: false, error: '新负责人不在员工名单里' });
        const from = taskList(hit.ns);
        const i = from.findIndex(x => x.id === t.id);
        if (i >= 0) from.splice(i, 1);
        saveTaskList(hit.ns, from);
        const nns = empNs(newEmp);
        const to = taskList(nns);
        Object.assign(t, v, { emp: newEmp, empNs: nns, acctName: v.acctName || t.acctName || '' });
        pushLog(t, who, '改派给 ' + newEmp, '');
        to.unshift(t);
        saveTaskList(nns, to);
        return persistOr503(res, { task: t });
      }
      Object.assign(t, v, { acctName: v.acctName || t.acctName || '' });
      pushLog(t, who, '修改任务', '');
      const list = taskList(hit.ns);
      const i = list.findIndex(x => x.id === t.id);
      if (i >= 0) list[i] = t;
      saveTaskList(hit.ns, list);
      return persistOr503(res, { task: t });
    }

    /* ⑤ 主管审核：通过 / 退回修改 / 否决 */
    if (action === 'review'){
      if (!isAdmin) return send(res, 403, { ok: false, error: '只有主管可以审核' });
      const hit = findTask(b.id);
      if (!hit) return send(res, 404, { ok: false, error: '任务不存在' });
      const t = hit.task;
      if (t.status !== ST.WAIT) return send(res, 409, { ok: false, error: '这条不是待审核状态（' + t.status + '）' });
      const act = String(b.review || '');
      const note = String(b.note || '').trim().slice(0, 1000);
      if (['approve', 'return', 'reject'].indexOf(act) < 0) return send(res, 400, { ok: false, error: '审核动作不合法' });
      if (act !== 'approve' && !note) return send(res, 400, { ok: false, error: '退回或否决必须写清原因' });
      t.status = act === 'approve' ? ST.PASS : (act === 'return' ? ST.BACK : ST.REJECT);
      t.review = { action: act, by: who, at: Date.now(), note: note };
      if (act === 'return') t.returnCount = (Number(t.returnCount) || 0) + 1;
      pushLog(t, who, act === 'approve' ? '审核通过' : (act === 'return' ? '退回修改' : '否决'), note);
      const list = taskList(hit.ns);
      const i = list.findIndex(x => x.id === t.id);
      if (i >= 0) list[i] = t;
      saveTaskList(hit.ns, list);
      return persistOr503(res, { task: t });
    }

    /* ⑤ 主管：免审授权（员工不能改自己的权限） */
    if (action === 'cfg'){
      if (!isAdmin) return send(res, 403, { ok: false, error: '只有主管可以设置免审权限' });
      const next = {
        exemptEmps: Array.isArray(b.exemptEmps) ? b.exemptEmps.filter(x => typeof x === 'string').slice(0, 100) : [],
        exemptTypes: Array.isArray(b.exemptTypes) ? b.exemptTypes.filter(x => ['流量型', '信任型', '转化型', '日常'].indexOf(x) >= 0) : []
      };
      nsWrite('admin', CFG_KEY, next);
      return persistOr503(res, { cfg: next });
    }

    return send(res, 400, { ok: false, error: '不支持的 action：' + action });
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

/* 先把端口监听起来，再在后台加载云端数据。
   这样即使 Upstash 慢/不可达，Render 也能立刻认为服务已启动、页面能打开，
   不会出现「连得上但一直转圈打不开」。 */
(function boot(){
  startServer();
  if (useKV){
    loadKV();
  } else {
    try { compactNs(true); } catch (e) { console.error('[NS] 旧命名空间合并失败：' + e.message); }
  }
  /* 配好飞书之后每 5 分钟自动拉一次线索（失败不影响服务，等下一轮） */
  setInterval(() => {
    if (!kvState.ready || crmRt.syncing || !crmConfigured()) return;
    crmSyncLeads().catch(e => console.error('[CRM] 自动同步失败：' + e.message));
  }, 5 * 60 * 1000);
})();

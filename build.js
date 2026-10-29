'use strict';
/* =========================================================
   build.js —— 把桌面版两个单文件工作台，编译成「网站版」页面
   源文件： ..\主管工作台.html 、 ..\员工工作台.html
   输出：   .\public\admin.html 、 .\public\staff.html
   用法：   node build.js
   说明：改了桌面版 HTML 之后，重跑一次这个脚本，网站版就会同步更新。
   ========================================================= */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_ADMIN = path.join(ROOT, '..', '主管工作台.html');
const SRC_STAFF = path.join(ROOT, '..', '员工工作台.html');
const OUT_ADMIN = path.join(ROOT, 'public', 'admin.html');
const OUT_STAFF = path.join(ROOT, 'public', 'staff.html');

function read(p){ return fs.readFileSync(p, 'utf8'); }
function write(p, s){ fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }
function repOnce(html, from, to, tag){
  const i = html.indexOf(from);
  if (i < 0) throw new Error('锚点没找到：' + tag);
  const j = html.indexOf(from, i + from.length);
  if (j >= 0) throw new Error('锚点出现多次（不唯一）：' + tag);
  return html.slice(0, i) + to + html.slice(i + from.length);
}

const HEAD_ANCHOR = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
const LS_SET_STAFF = `const lsSet = (k,v)=>{ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} };`;
const LS_SET_ADMIN = LS_SET_STAFF; // 两个文件写法一致
const LS_SET_NEW = `const lsSet = (k,v)=>{ try{ localStorage.setItem(k,JSON.stringify(v)); if(window.__cloud) window.__cloud.touch(k,v); }catch(e){} };`;

/* ---------------- 员工版 ---------------- */
const BOOT_STAFF_OLD = `function boot(){
  const lp = $('#lnkPersona'); if(lp) lp.href = FEISHU.persona;
  const ld = $('#lnkDaily'); if(ld) ld.href = FEISHU.daily;
  $('#btnEnter').onclick = enter;
  $('#gateName').onkeydown = e=>{ if(e.key==='Enter') enter(); };
  $('#gate').classList.add('show');
}
function enter(){
  const name = ($('#gateName').value||'').trim();
  if(!name){ $('#gateErr').textContent='请先填一个代号或昵称'; return; }
  setNamespace('u_'+hashStr(name).toString(36));
  SESSION = {name};
  loadState(); autoPullSeed(); save();
  $('#gate').classList.remove('show');
  $('#app').style.display = 'flex';
  init();
}`;

const BOOT_STAFF_NEW = `function boot(){
  const lp = $('#lnkPersona'); if(lp) lp.href = FEISHU.persona;
  const ld = $('#lnkDaily'); if(ld) ld.href = FEISHU.daily;
  $('#btnEnter').onclick = enter;
  $('#gateName').onkeydown = e=>{ if(e.key==='Enter') enter(); };
  // 网站版：登录信息从登录页带过来，云端拉一次数据再渲染
  const s = (window.__cloud && __cloud.session && __cloud.session());
  if(s && s.role==='emp'){ cloudEnter(s); return; }
  if(window.__cloud && __cloud.online && !s){ location.replace('index.html'); return; }
  $('#gate').classList.add('show');
}
function cloudEnter(s){
  setNamespace(s.ns);
  SESSION = {name:s.name};
  $('#gate').classList.remove('show');
  $('#app').style.display = 'flex';
  loadState(); autoPullSeed(); init();          // 先用本机缓存渲染，避免白屏
  if(!(window.__cloud && __cloud.online)) return;
  __cloud.pull().then(()=>{
    loadState(); autoPullSeed(); save();        // 云端数据落地后回写一次（写上 who，主管才认得出是谁）
    renderWho(); switchTab(state.tab||'today');
    __cloud.start(cloudOnRemote);
  }).catch(()=>{ __cloud.start(cloudOnRemote); });
}
function cloudOnRemote(){
  if(document.querySelector('#overlay.show')) return;
  const t = state.tab;
  loadState(); renderWho(); switchTab(t||'today');
}
function enter(){
  const name = ($('#gateName').value||'').trim();
  if(!name){ $('#gateErr').textContent='请先填一个代号或昵称'; return; }
  setNamespace('u_'+hashStr(name).toString(36));
  SESSION = {name};
  loadState(); autoPullSeed(); save();
  $('#gate').classList.remove('show');
  $('#app').style.display = 'flex';
  init();
}`;

const LOGOUT_STAFF_OLD = `  $('#btnLogout').onclick = ()=> location.reload();`;
const LOGOUT_NEW = `  $('#btnLogout').onclick = ()=> (window.__cloud && __cloud.online) ? __cloud.logout() : location.reload();`;

let staff = read(SRC_STAFF);
staff = repOnce(staff, HEAD_ANCHOR, HEAD_ANCHOR + '\n<script src="cloud.js"></script>', 'staff:head');
staff = repOnce(staff, LS_SET_STAFF, LS_SET_NEW, 'staff:lsSet');
staff = repOnce(staff, BOOT_STAFF_OLD, BOOT_STAFF_NEW, 'staff:boot');
staff = repOnce(staff, LOGOUT_STAFF_OLD, LOGOUT_NEW, 'staff:logout');
write(OUT_STAFF, staff);

/* ---------------- 主管版 ---------------- */
const BOOT_ADMIN_OLD = `function boot(){
  const lp = $('#lnkPersona'); if(lp) lp.href = FEISHU.persona;
  const ld = $('#lnkDaily'); if(ld) ld.href = FEISHU.daily;
  $('#btnEnterAdmin').onclick = enterAdmin;
  // 记住本设备：下次打开直接进，不再弹入口
  if(lsGet(ADMIN_REMEMBER_KEY, false)){ enterAdmin(); return; }
  $('#gate').classList.add('show');
}
function enterAdmin(){
  const box = $('#gateRemember');
  lsSet(ADMIN_REMEMBER_KEY, box ? !!box.checked : true);
  setNamespace('admin');
  SESSION = {role:'admin', name:'主管', ns:'admin'};
  loadState();
  autoPullSeed();
  $('#gate').classList.remove('show');
  init();
}`;

const BOOT_ADMIN_NEW = `function boot(){
  const lp = $('#lnkPersona'); if(lp) lp.href = FEISHU.persona;
  const ld = $('#lnkDaily'); if(ld) ld.href = FEISHU.daily;
  $('#btnEnterAdmin').onclick = ()=> enterAdmin(false);
  // 网站版：登录页已登录则直接进，并从云端把全员数据拉下来
  const s = (window.__cloud && __cloud.session && __cloud.session());
  if(s && s.role==='admin'){ enterAdmin(true); return; }
  if(window.__cloud && __cloud.online && !s){ location.replace('index.html'); return; }
  // 记住本设备：下次打开直接进，不再弹入口
  if(lsGet(ADMIN_REMEMBER_KEY, false)){ enterAdmin(false); return; }
  $('#gate').classList.add('show');
}
function enterAdmin(useCloud){
  const box = $('#gateRemember');
  lsSet(ADMIN_REMEMBER_KEY, box ? !!box.checked : true);
  setNamespace('admin');
  SESSION = {role:'admin', name:'主管', ns:'admin'};
  $('#gate').classList.remove('show');
  if(useCloud && window.__cloud){
    __cloud.pull().then(loadRosterCache).catch(()=>{}).then(()=>{
      loadState(); autoPullSeed(); init(); __cloud.start(cloudOnRemote);
    });
  }else{
    loadState(); autoPullSeed(); init();
  }
}
function cloudOnRemote(){
  if($('#overlay').classList.contains('show')) return;
  const t = state.tab;
  loadState(); renderWho(); renderAccounts(); renderMeta(); switchTab(t||'admin');
}`;

const LOGOUT_ADMIN_OLD = `  $('#btnLogout').onclick = ()=> location.reload();`;

const ROSTER_JS = `
/* =========================================================
   20. 员工登录名单（网站版）
   ========================================================= */
const ROSTER_KEY = 'dse_admin_roster_cache';
function rosterCache(){ return lsGet(ROSTER_KEY, []) || []; }
function loadRosterCache(){
  if(!(window.__cloud && __cloud.online)) return Promise.resolve([]);
  return __cloud.roster().then(list=>{ lsSet(ROSTER_KEY, list); if(state.tab==='admin') renderAdminPanel(); return list; }).catch(()=>[]);
}
function renderRosterCard(){
  if(!(window.__cloud && __cloud.online)) return '';
  const list = rosterCache();
  const rows = list.map((e,i)=> (
    '<tr>'+
      '<td><input class="inp rs-nm" data-i="'+i+'" value="'+esc(e.name||'')+'" placeholder="员工昵称" style="height:30px;min-width:104px"></td>'+
      '<td><select class="inp rs-pf" data-i="'+i+'" style="height:30px;min-width:84px">'+
        [['摘星','摘星'],['遵理','遵理'],['','通用']].map(p=>'<option value="'+p[0]+'"'+(e.persona===p[0]?' selected':'')+'>'+p[1]+'</option>').join('')+
      '</select></td>'+
      '<td><input class="inp rs-pw" data-i="'+i+'" value="'+esc(e.pass||'')+'" placeholder="留空=免密码" style="height:30px;min-width:92px"></td>'+
      '<td style="text-align:center"><input type="checkbox" class="rs-on" data-i="'+i+'"'+(e.active!==false?' checked':'')+'></td>'+
      '<td><button class="link-btn rs-del" data-i="'+i+'">删除</button></td>'+
    '</tr>')).join('');
  return '<div class="adm-emp">'+
    '<div class="hd"><span class="nm">员工登录名单</span>'+
      '<span class="tag">已录入 '+list.length+' 人</span>'+
      '<button class="link-btn hot" id="rsAdd">+ 添加员工</button>'+
      '<button class="link-btn" id="rsSave">💾 保存名单</button>'+
      '<button class="link-btn" id="rsPass">🔑 改主管口令</button>'+
    '</div>'+
    '<div class="adm-detail">'+
      '<div class="hint-box">只有这里录入的昵称<b>才能</b>登录员工版；没录入的员工会提示「不在名单里」。<br>人设方向决定他默认出<b>摘星</b>还是<b>遵理</b>的选题；密码留空就是只填昵称即可登录。</div>'+
      (list.length
        ? '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px"><thead><tr style="text-align:left;color:#8b8f99"><th style="padding:4px 6px">昵称</th><th style="padding:4px 6px">人设方向</th><th style="padding:4px 6px">密码</th><th style="text-align:center;padding:4px 6px">启用</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>'
        : '<div class="empty-tip">还没有录入员工，点上面「+ 添加员工」写昵称，再点「保存名单」</div>')+
    '</div></div>';
}
function collectRosterForm(){
  const names=$$('.rs-nm'), pfs=$$('.rs-pf'), pws=$$('.rs-pw'), ons=$$('.rs-on');
  const out = [];
  names.forEach((el,i)=>{
    const nm = (el.value||'').trim();
    if(!nm) return;
    out.push({name:nm, persona: pfs[i]?pfs[i].value:'', pass: pws[i]?(pws[i].value||'').trim():'', active: !!(ons[i] && ons[i].checked)});
  });
  return out;
}
function bindRosterCard(){
  const add = $('#rsAdd');
  if(add) add.onclick = ()=>{ const l = rosterCache(); l.push({name:'', persona:'', pass:'', active:true}); lsSet(ROSTER_KEY, l); renderAdminPanel(); };
  $$('.rs-del').forEach(b=> b.onclick = ()=>{ const l = rosterCache(); l.splice(+b.dataset.i,1); lsSet(ROSTER_KEY, l); renderAdminPanel(); });
  const sv = $('#rsSave');
  if(sv) sv.onclick = ()=>{
    const list = collectRosterForm();
    if(!list.length){ toast('至少填一个员工昵称'); return; }
    __cloud.saveRoster(list).then(r=>{
      lsSet(ROSTER_KEY, r); renderAdminPanel();
      toast('名单已保存（'+r.length+' 人），员工现在可以用昵称登录了');
    }).catch(e=> toast(e.message||'保存失败'));
  };
  const pw = $('#rsPass');
  if(pw) pw.onclick = openAdminPass;
}
function openAdminPass(){
  showModal('修改主管口令',
    '<div class="hint-box">改完请记牢：以后主管登录要用新口令。员工登录不受影响。</div>'+
    '<div class="field"><label>新口令（至少 4 位）</label><input class="inp" id="apNew" type="text" placeholder="例如 dse2026"></div>',
    [{t:'取消', fn:closeModal},{t:'保存', primary:true, fn:()=>{
      const v = (($('#apNew')&&$('#apNew').value)||'').trim();
      if(v.length<4){ toast('口令至少 4 位'); return; }
      __cloud.changeAdminPass(v).then(()=>{ closeModal(); toast('主管口令已更新'); }).catch(e=> toast(e.message||'修改失败'));
    }}]);
  const el = $('#apNew'); if(el) el.focus();
}
`;

let admin = read(SRC_ADMIN);
admin = repOnce(admin, HEAD_ANCHOR, HEAD_ANCHOR + '\n<script src="cloud.js"></script>', 'admin:head');
admin = repOnce(admin, LS_SET_ADMIN, LS_SET_NEW, 'admin:lsSet');
admin = repOnce(admin, BOOT_ADMIN_OLD, BOOT_ADMIN_NEW, 'admin:boot');
admin = repOnce(admin, LOGOUT_ADMIN_OLD, LOGOUT_NEW, 'admin:logout');
admin = repOnce(admin,
  `  $('#panelBody').innerHTML =
    '<div style="padding:12px">'+\n      '<div class="hint-box"><b>主管后台</b>`,
  `  $('#panelBody').innerHTML =
    '<div style="padding:12px">'+\n      renderRosterCard()+\n      '<div class="hint-box"><b>主管后台</b>`,
  'admin:roster-card');
admin = repOnce(admin,
  `  $('#admRefreshBtn').onclick = ()=> renderAdminPanel();
}`,
  `  $('#admRefreshBtn').onclick = ()=> renderAdminPanel();
  bindRosterCard();
}`,
  'admin:bind-roster');
admin = repOnce(admin,
  `  set('daily', Array.isArray(data.daily)?data.daily:[]);`,
  `  set('daily', Array.isArray(data.daily)?data.daily:[]);
  // 网站版：顺手推到服务器，员工在自己页面登录后就能看到这些历史数据
  if(window.__cloud && window.__cloud.online){
    __cloud.pushNs(ns, {
      ['dse_wb_'+ns+'_who_v2']: JSON.stringify(String(data.who)),
      ['dse_wb_'+ns+'_acct_v2']: JSON.stringify(Array.isArray(data.accounts)?data.accounts:[]),
      ['dse_wb_'+ns+'_topics_v2']: JSON.stringify(Array.isArray(data.topics)?data.topics:[]),
      ['dse_wb_'+ns+'_drafts_v2']: JSON.stringify((data.drafts && typeof data.drafts==='object' && !Array.isArray(data.drafts))?data.drafts:{}),
      ['dse_wb_'+ns+'_daily_v2']: JSON.stringify(Array.isArray(data.daily)?data.daily:[])
    });
  }`,
  'admin:import-push');

admin = repOnce(admin,
  `function restoreLocalDump(data){
  Object.keys(data||{}).forEach(k=>{
    if(!/^dse_wb_/.test(k) && !/^dse_admin_/.test(k)) return;
    if(data[k]===null || data[k]===undefined) return;
    lsSet(k, data[k]);
  });
}`,
  `function restoreLocalDump(data){
  Object.keys(data||{}).forEach(k=>{
    if(!/^dse_wb_/.test(k) && !/^dse_admin_/.test(k)) return;
    if(data[k]===null || data[k]===undefined) return;
    lsSet(k, data[k]);
  });
  // 网站版：把旧备份里各个员工命名空间的数据一并推到服务器，员工登录后直接能看到
  if(window.__cloud && window.__cloud.online){
    const groups = {};
    Object.keys(data||{}).forEach(k=>{
      const m = k.match(/^dse_wb_(u_[a-z0-9]+)_/);
      if(!m) return;
      if(data[k]===null || data[k]===undefined) return;
      (groups[m[1]] = groups[m[1]] || {})[k] = JSON.stringify(data[k]);
    });
    Object.keys(groups).forEach(ns=> __cloud.pushNs(ns, groups[ns]));
  }
}`,
  'admin:restore-push');

admin = repOnce(admin, `\nboot();`, ROSTER_JS + `\nboot();`, 'admin:roster-js');
write(OUT_ADMIN, admin);

console.log('OK  已生成：');
console.log('  ' + OUT_STAFF);
console.log('  ' + OUT_ADMIN);

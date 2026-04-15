import React, { useState, useMemo, useCallback, useEffect } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { authAPI, usersAPI, projectsAPI, requestsAPI, timesheetAPI, rolesAPI, payrollAPI, activitiesAPI, rotationAPI, companyAPI, totpAPI, auditAPI, emailAPI, pushAPI, holidaysAPI, companyEntitiesAPI, reportsAPI, workflowsAPI, erpRosterAPI, erpWeeksAPI, erpNotificationsAPI, uploadsAPI, verifySession, departmentsAPI, balanceTypesAPI, userBalancesAPI } from "./api";
import { getMsalInstance, loginRequest, ssoEnabled } from "./msalConfig";

// ─── Export helpers ────────────────────────────────────────────────────────────
function downloadXLSX(rows, filename) {
  import('xlsx').then(XLSX => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, filename + '.xlsx');
  }).catch(() => {
    // fallback: CSV
    const csv = rows.map(r => r.map(c => JSON.stringify(c ?? '')).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = filename + '.csv'; a.click();
  });
}
function printPage() { window.print(); }

// ─── Constants ────────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const ALLOC_STEPS = [1, 0.75, 0.5, 0.25];
let HOLIDAYS = ["2025-01-01","2025-03-20","2025-04-09","2025-05-01","2025-07-25","2025-08-13","2025-10-15"];
const MONTHLY_STATS = [
  {month:"Jan",workedDays:168,leaves:14,missions:5,ontime:94},
  {month:"Feb",workedDays:154,leaves:22,missions:8,ontime:91},
  {month:"Mar",workedDays:172,leaves:10,missions:6,ontime:96},
  {month:"Apr",workedDays:160,leaves:18,missions:9,ontime:89},
  {month:"May",workedDays:165,leaves:16,missions:7,ontime:92},
  {month:"Jun",workedDays:158,leaves:20,missions:11,ontime:88},
];
const COLORS = ["#7c3aed","#0ea5e9","#10b981","#f59e0b","#ef4444","#ec4899","#8b5cf6","#06b6d4","#f97316","#64748b"];
const BG_MAP = {"#7c3aed":"#f5f3ff","#0ea5e9":"#f0f9ff","#10b981":"#f0fdf4","#f59e0b":"#fffbeb","#ef4444":"#fef2f2","#ec4899":"#fdf2f8","#8b5cf6":"#f5f3ff","#06b6d4":"#ecfeff","#f97316":"#fff7ed","#64748b":"#f8fafc"};

const PERMISSIONS_LIST = [
  {key:"all",label:"Full System Access"},{key:"analytics",label:"View Analytics"},
  {key:"approve",label:"Approve Requests"},{key:"view_team",label:"View Team Data"},
  {key:"view_all",label:"View All Employees"},{key:"reports",label:"Generate Reports"},
  {key:"hr_report",label:"HR Payroll Reports"},{key:"timesheet",label:"Manage Own Timesheet"},
  {key:"requests",label:"Submit Requests"},{key:"schedule",label:"View Schedule"},
  {key:"leave_balance",label:"View Leave Balances"},{key:"manage_users",label:"Manage Users & Roles"},
  {key:"manage_projects",label:"Manage Projects"},
  {key:"erp_rota",label:"ERP Duty Rota"},{key:"erp_rota_edit",label:"ERP Duty Rota — Edit Rotation & Members"},{key:"erp_rota_notify",label:"ERP Duty Rota — Send Notifications"},
];

// Data now loaded from API - kept as fallbacks
const INITIAL_ROLES = {};
const INITIAL_PROJECTS = [];
const INITIAL_USERS = [];
const INITIAL_REQUESTS = [];
const INITIAL_TS_STATUS = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pad     = n => String(n).padStart(2,"0");
const isWE    = ds => { const d=new Date(ds); return d.getDay()===0||d.getDay()===6; };
const isHol   = ds => HOLIDAYS.includes(ds);
const daysIn  = (y,m) => new Date(y,m+1,0).getDate();
const firstWD = (y,m) => new Date(y,m,1).getDay();
const initials = n => n.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
const aColor   = id => COLORS[id % COLORS.length];
const colorBg  = hex => BG_MAP[hex] || "#f8fafc";
const hasPerm  = (roles,role,perm) => { const r=roles[role]; return r&&(r.permissions.includes("all")||r.permissions.includes(perm)); };
const tsKey    = (uid,y,m) => `${uid}-${y}-${pad(m+1)}`;

// Per-employee rotation day type: ON (working), OFF (rest mirror), EXTRA (beyond rotation)
function getFieldDayType(uid, ds, rotations=[]) {
  const userRots = rotations.filter(r=>r.userId===uid).sort((a,b)=>new Date(a.onStart)-new Date(b.onStart));
  if (userRots.length === 0) {
    // Legacy fallback: hardcoded 14/14 cycle from 2025-01-01
    const diff = Math.floor((new Date(ds)-new Date("2025-01-01"))/86400000);
    return ((diff%28)+28)%28 < 14 ? "ON" : "OFF";
  }
  const d = new Date(ds);
  for (const rot of userRots) {
    const onStart = new Date(rot.onStart), onEnd = new Date(rot.onEnd);
    const onDays  = Math.floor((onEnd-onStart)/86400000)+1;
    const offStart = new Date(onEnd); offStart.setDate(offStart.getDate()+1);
    const offEnd   = new Date(onEnd); offEnd.setDate(offEnd.getDate()+onDays);
    if (d>=onStart && d<=onEnd)   return "ON";
    if (d>=offStart && d<=offEnd) return "OFF";
  }
  return "EXTRA";
}

function buildEntries(user, year, month, projects, activities=[], rotations=[]) {
  const days = daysIn(year, month);
  const avail = projects.filter(p=>p.open&&(user.type==="field"?p.fieldAllowed:p.officeAllowed));
  const dflt  = avail[0]?.id || null;
  const fProj = projects.find(p=>p.code==="GHRIB-OPX")?.id || dflt;
  const defAct = user.type==="office" ? "Office" : "Site";
  return Array.from({length:days},(_,i)=>{
    const d=i+1, ds=`${year}-${pad(month+1)}-${pad(d)}`;
    if (isWE(ds) && user.type==="office") return null;
    if (isHol(ds)) return null;
    if (user.type==="field") {
      const dt = getFieldDayType(user.id, ds, rotations);
      if (dt!=="ON") return null; // Only ON days in timesheet; OFF and EXTRA excluded
      const projId = fProj;
      return { id:ds, day:d, date:ds, activity:defAct, locked:false, hours:12, allocations:[{id:Date.now()+d,projectId:projId,allocation:1.0,note:""}] };
    }
    const projId = dflt;
    return {
      id:ds, day:d, date:ds, activity:defAct, locked:false,
      hours:8,
      allocations:[{id:Date.now()+d,projectId:projId,allocation:1.0,note:""}],
    };
  }).filter(Boolean);
}

// ─── Toast notification system ────────────────────────────────────────────────
// Module-level handler — registered by App on mount so any component can call toast()
let _showToast = null;
const toast = (msg, type = 'error') => {
  if (_showToast) _showToast(msg, type);
  else console.warn('[toast]', type, msg);
};

function ToastContainer() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    _showToast = (msg, type) => {
      const id = Date.now() + Math.random();
      setToasts(prev => [...prev.slice(-4), { id, msg: String(msg), type }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    };
    return () => { _showToast = null; };
  }, []);

  if (!toasts.length) return null;
  return (
    <div style={{position:'fixed',bottom:24,right:24,zIndex:9999,display:'flex',flexDirection:'column',gap:8,maxWidth:380}}>
      {toasts.map(t => (
        <div key={t.id} style={{
          display:'flex',alignItems:'flex-start',gap:10,padding:'12px 16px',
          borderRadius:10,boxShadow:'0 4px 20px rgba(0,0,0,.18)',
          background: t.type==='success' ? '#10b981' : t.type==='info' ? '#0ea5e9' : '#ef4444',
          color:'#fff',fontSize:13,lineHeight:1.45,fontWeight:500,
          animation:'toast-in .2s ease'
        }}>
          <span style={{fontSize:16,flexShrink:0}}>
            {t.type==='success' ? '✓' : t.type==='info' ? 'ℹ' : '✕'}
          </span>
          <span style={{flex:1}}>{t.msg}</span>
          <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
            style={{background:'none',border:'none',color:'#fff',cursor:'pointer',fontSize:16,lineHeight:1,padding:0,opacity:.8,flexShrink:0}}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
// ── Theme definitions ─────────────────────────────────────────────────────────
// Single theme — Microsoft Admin Center (Fluent UI style)
const THEMES = {
  enterprise: { key:"enterprise", label:"Enterprise", ico:"🏢", vars:{
    "--bg":"#f5f5f5","--surface":"#ffffff","--s2":"#faf9f8","--s3":"#edebe9",
    "--b":"#edebe9","--b2":"#8a8886",
    "--t":"#323130","--t2":"#605e5c","--t3":"#a19f9d",
    "--v":"#0078d4","--vl":"#eff6fc","--vd":"#106ebe",
    "--sk":"#0078d4","--skl":"#eff6fc",
    "--gr":"#107c10","--grl":"#f1faf1",
    "--am":"#ffb900","--aml":"#fff8e1",
    "--re":"#d13438","--rel":"#fdf3f4",
    "--r":"4px","--rs":"2px",
    "--sh":"0 1.6px 3.6px 0 rgba(0,0,0,.132),0 .3px .9px 0 rgba(0,0,0,.108)",
    "--shm":"0 3.2px 7.2px 0 rgba(0,0,0,.132),0 .6px 1.8px 0 rgba(0,0,0,.108)",
    "--shl":"0 6.4px 14.4px 0 rgba(0,0,0,.132),0 1.2px 3.6px 0 rgba(0,0,0,.108)",
    "--ent-sb":"#faf9f8","--ent-sb-hover":"#f3f2f1","--ent-sb-active-bg":"#eff6fc",
    "--ent-accent":"#0078d4","--ent-accent-hover":"#106ebe",
    "--ent-neutral":"#8a8886","--ent-neutral-light":"#f3f2f1",
    "--ent-on":"#0078d4","--ent-on-bg":"#deecf9",
    "--ent-extra":"#5c2d91","--ent-extra-bg":"#ede9fe",
    "--ent-hol":"#8a8886","--ent-hol-bg":"#faf9f8"
  }},
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#f8fafc;--surface:#fff;--s2:#f1f5f9;--s3:#e2e8f0;
  --b:#e2e8f0;--b2:#cbd5e1;
  --t:#0f172a;--t2:#475569;--t3:#94a3b8;
  --v:#7c3aed;--vl:#f5f3ff;--vd:#6d28d9;
  --sk:#0ea5e9;--skl:#f0f9ff;
  --gr:#10b981;--grl:#f0fdf4;
  --am:#f59e0b;--aml:#fffbeb;
  --re:#ef4444;--rel:#fef2f2;
  --r:10px;--rs:6px;
  --sh:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
  --shm:0 4px 12px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.04);
  --shl:0 10px 30px rgba(0,0,0,.1),0 4px 8px rgba(0,0,0,.06);
}
body{background:var(--bg);color:var(--t);font-family:'Plus Jakarta Sans',sans-serif;}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e1b4b 0%,#312e81 40%,#1e40af 100%);overflow:auto;}
.login-card{background:#fff;border-radius:18px;padding:40px 36px;width:400px;max-width:95vw;box-shadow:0 24px 64px rgba(0,0,0,.25);}
.login-logo{display:flex;align-items:center;gap:12px;margin-bottom:30px;}
.login-logo-ico{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#0ea5e9);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace;box-shadow:0 4px 14px rgba(124,58,237,.35);}
.login-err{background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:10px 13px;border-radius:var(--rs);font-size:13px;margin-bottom:14px;font-weight:500;}
.pwd-wrap{position:relative;}
.pwd-wrap .fi{padding-right:40px;}
.pwd-eye{position:absolute;right:11px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--t3);font-size:15px;background:none;border:none;}
.pwd-eye:hover{color:var(--t);}
.profile-dd{position:relative;}
.profile-menu{position:absolute;right:0;top:calc(100% + 8px);background:var(--surface);border:1px solid var(--b);border-radius:var(--r);box-shadow:var(--shl);min-width:200px;z-index:100;animation:su .13s ease;}
.profile-menu-item{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;font-size:13px;font-weight:500;color:var(--t2);transition:background .1s;}
.profile-menu-item:hover{background:var(--s2);color:var(--t);}
.profile-menu-item.danger{color:var(--re);}
.profile-menu-item.danger:hover{background:var(--rel);}
.profile-menu-sep{height:1px;background:var(--b);margin:4px 0;}
.app{display:flex;height:100vh;width:100vw;overflow:hidden;}
.sb{width:240px;min-width:240px;background:var(--surface);border-right:1px solid var(--b);display:flex;flex-direction:column;}
.sb-top{padding:16px 16px 12px;border-bottom:1px solid var(--b);}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.logo-ico{width:36px;height:36px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#0ea5e9);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;font-family:'JetBrains Mono',monospace;box-shadow:0 2px 8px rgba(124,58,237,.3);}
.logo-co{font-size:15px;font-weight:800;color:var(--t);}
.logo-sub{font-size:10px;color:var(--t3);font-weight:500;letter-spacing:.04em;}
.upill{background:var(--s2);border:1px solid var(--b);border-radius:var(--rs);padding:9px 11px;display:flex;align-items:center;gap:9px;}
.u-nm{font-size:13px;font-weight:700;color:var(--t);line-height:1.2;}
.u-rl{font-size:11px;color:var(--t3);font-weight:500;}
.nav{flex:1;padding:8px;overflow-y:auto;}
.nl{font-size:10px;font-weight:700;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;padding:8px 8px 3px;}
.ni{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:var(--rs);cursor:pointer;font-size:13px;font-weight:500;color:var(--t2);transition:all .12s;margin-bottom:1px;}
.ni:hover{background:var(--s2);color:var(--t);}
.ni.active{background:var(--vl);color:var(--v);font-weight:700;}
.ni-ico{width:17px;text-align:center;font-size:14px;}
.nbadge{margin-left:auto;background:var(--re);color:#fff;font-size:10px;border-radius:20px;padding:1px 6px;font-family:'JetBrains Mono',monospace;font-weight:600;min-width:18px;text-align:center;}
.nbadge.am{background:var(--am);}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
.topbar{height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid var(--b);background:var(--surface);flex-shrink:0;gap:12px;}
.topbar-search{display:flex;align-items:center;gap:8px;background:var(--s2);border:1px solid var(--b);border-radius:var(--rs);padding:6px 12px;flex:1;max-width:420px;}
.topbar-search-input{border:none;background:transparent;outline:none;font-size:13px;color:var(--t);width:100%;font-family:inherit;}
.topbar-search-input::placeholder{color:var(--t3);}
.profile-name{display:none;}
@media(min-width:768px){.profile-name{display:block;}}
.pg-title{font-size:18px;font-weight:800;color:var(--t);}
.pg-sub{font-size:11px;color:var(--t3);font-weight:500;}
.content{flex:1;overflow-y:auto;padding:20px 24px;min-width:0;}
.tabs{display:flex;gap:3px;background:var(--s2);border-radius:var(--rs);padding:3px;margin-bottom:18px;flex-wrap:wrap;}
.tab{padding:6px 14px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:500;color:var(--t2);transition:all .12s;white-space:nowrap;}
.tab:hover{color:var(--t);}
.tab.active{background:var(--surface);color:var(--t);font-weight:700;box-shadow:var(--sh);}
.card{background:var(--surface);border:1px solid var(--b);border-radius:var(--r);padding:18px;box-shadow:var(--sh);}
.card-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.card-title{font-size:14px;font-weight:700;color:var(--t);}
.card-sub{font-size:12px;color:var(--t3);margin-top:1px;}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px;}
.sc{background:var(--surface);border:1px solid var(--b);border-radius:var(--r);padding:15px 17px;box-shadow:var(--sh);position:relative;overflow:hidden;}
.sa{position:absolute;top:0;right:0;width:52px;height:52px;border-radius:0 var(--r) 0 52px;opacity:.08;}
.sl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-bottom:5px;}
.sv{font-size:26px;font-weight:800;line-height:1;margin-bottom:3px;}
.sc2{font-size:11px;font-weight:500;}
.up{color:var(--gr);}.dn{color:var(--re);}.neu{color:var(--t3);}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px;}
.tbl{width:100%;border-collapse:collapse;font-size:13px;}
.tbl th{padding:9px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);border-bottom:1px solid var(--b);background:var(--s2);white-space:nowrap;}
.tbl td{padding:9px 12px;border-bottom:1px solid var(--b);color:var(--t);vertical-align:middle;}
.tbl tr:last-child td{border-bottom:none;}
.tbl tr:hover td{background:#fafbfc;}
.tw{border:1px solid var(--b);border-radius:var(--r);overflow:hidden;background:var(--surface);box-shadow:var(--sh);}

/* alloc */
.alloc-wrap{background:var(--s2);border-top:1px solid var(--b);}
.alloc-row{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 38px;border-bottom:1px solid var(--b);font-size:12px;}
.alloc-row:last-child{border-bottom:none;}
.abar{flex:1;height:8px;background:var(--s3);border-radius:4px;overflow:hidden;min-width:70px;}
.abar-fill{height:100%;border-radius:4px;transition:width .3s;}
.alloc-footer{display:flex;align-items:center;justify-content:space-between;padding:5px 12px 7px 38px;font-size:11px;}
.add-proj-btn{color:var(--v);cursor:pointer;padding:2px 8px;border-radius:4px;border:1px dashed var(--v);background:var(--vl);font-weight:600;font-size:11px;}
.add-proj-btn:hover{background:#ede9fe;}
.del-btn{color:var(--re);cursor:pointer;font-size:16px;line-height:1;padding:0 3px;}
.del-btn:hover{opacity:.7;}
.ok{color:var(--gr);font-weight:700;font-family:'JetBrains Mono',monospace;}
.warn{color:var(--re);font-weight:700;font-family:'JetBrains Mono',monospace;}
.exp-arrow{display:inline-block;transition:transform .15s;font-size:9px;color:var(--t3);}
.exp-arrow.open{transform:rotate(90deg);}

/* ── Timesheet status banner ── */
.ts-banner{border-radius:var(--rs);padding:11px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px;border:1px solid;}
.ts-banner.draft    {background:#f8fafc;border-color:var(--b);color:var(--t2);}
.ts-banner.submitted{background:var(--aml);border-color:#fcd34d;color:#92400e;}
.ts-banner.approved {background:var(--grl);border-color:#6ee7b7;color:#065f46;}
.ts-banner.rejected {background:var(--rel);border-color:#fca5a5;color:#991b1b;}
.ts-banner-ico{font-size:20px;flex-shrink:0;}
.ts-banner-body{flex:1;}
.ts-banner-title{font-weight:700;font-size:13px;}
.ts-banner-sub{font-size:11px;margin-top:2px;opacity:.8;}

/* ── Approval detail panel ── */
.ap-detail{border:1px solid var(--b);border-radius:var(--r);overflow:hidden;margin-top:8px;}
.ap-detail-hd{padding:12px 14px;background:var(--s2);border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between;}
.ap-alloc-row{display:flex;align-items:center;gap:10px;padding:7px 14px;border-bottom:1px solid var(--b);font-size:12px;}
.ap-alloc-row:last-child{border-bottom:none;}

/* inline controls */
.isel{background:var(--surface);border:1px solid var(--b2);border-radius:4px;font-size:11px;padding:3px 6px;color:var(--t);cursor:pointer;outline:none;max-width:155px;}
.isel:focus{border-color:var(--v);}
.isel2{background:transparent;border:1px solid transparent;border-radius:4px;font-size:12px;padding:2px 6px;color:var(--t);cursor:pointer;outline:none;}
.isel2:hover{border-color:var(--b2);background:var(--s2);}
.isel2:focus{border-color:var(--v);background:var(--surface);}
.iinp{background:var(--surface);border:1px solid var(--b2);border-radius:4px;font-size:11px;padding:3px 7px;color:var(--t);outline:none;width:100%;}
.iinp:focus{border-color:var(--v);}
.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.04em;font-family:'JetBrains Mono',monospace;white-space:nowrap;}
.bv{background:var(--vl);color:var(--v);}
.bsk{background:var(--skl);color:var(--sk);}
.bgr{background:var(--grl);color:var(--gr);}
.bam{background:var(--aml);color:var(--am);}
.bre{background:var(--rel);color:var(--re);}
.bgr2{background:var(--s2);color:var(--t3);}
.btn{padding:7px 15px;border-radius:var(--rs);cursor:pointer;font-size:13px;font-weight:600;transition:all .12s;border:none;font-family:'Plus Jakarta Sans',sans-serif;display:inline-flex;align-items:center;gap:6px;}
.bp{background:var(--v);color:#fff;}.bp:hover{background:var(--vd);box-shadow:0 2px 8px rgba(124,58,237,.3);}
.bo{background:transparent;border:1px solid var(--b2);color:var(--t2);}.bo:hover{border-color:var(--v);color:var(--v);background:var(--vl);}
.bg2{background:transparent;border:none;color:var(--t3);padding:5px 8px;}.bg2:hover{color:var(--t);background:var(--s2);border-radius:var(--rs);}
.bd{background:var(--rel);color:var(--re);border:1px solid #fecaca;}.bd:hover{background:#fee2e2;}
.bs{background:var(--grl);color:var(--gr);border:1px solid #a7f3d0;}.bs:hover{background:#d1fae5;}
.bsk2{background:var(--skl);color:var(--sk);border:1px solid #bae6fd;}.bsk2:hover{background:#e0f2fe;}
.bam2{background:var(--aml);color:var(--am);border:1px solid #fcd34d;}.bam2:hover{background:#fef3c7;}
.bsm{padding:5px 11px;font-size:12px;}.bxs{padding:3px 8px;font-size:11px;}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.ff{grid-column:1/-1;}
.fgrp{display:flex;flex-direction:column;gap:5px;}
.flbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--t2);}
.fi,.fsel,.fta{background:var(--surface);border:1px solid var(--b2);color:var(--t);padding:9px 12px;border-radius:var(--rs);font-size:13px;font-family:'Plus Jakarta Sans',sans-serif;outline:none;transition:border-color .12s,box-shadow .12s;width:100%;}
.fi:focus,.fsel:focus,.fta:focus{border-color:var(--v);box-shadow:0 0 0 3px rgba(124,58,237,.1);}
.fta{resize:vertical;min-height:68px;}
.fnote{font-size:11px;color:var(--am);font-weight:500;margin-top:4px;}
.sw{position:relative;display:inline-block;width:36px;height:20px;}
.sw input{opacity:0;width:0;height:0;}
.sldr{position:absolute;cursor:pointer;inset:0;background:var(--s3);border-radius:20px;transition:.18s;}
.sldr:before{position:absolute;content:"";height:14px;width:14px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.18s;box-shadow:0 1px 3px rgba(0,0,0,.2);}
input:checked+.sldr{background:var(--v);}
input:checked+.sldr:before{transform:translateX(16px);}
.cgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
.chd{text-align:center;font-size:10px;font-weight:700;color:var(--t3);padding:5px 0;letter-spacing:.06em;text-transform:uppercase;}
.cday{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;border:1px solid transparent;transition:all .11s;font-weight:500;}
.cday:hover:not(.empty){border-color:var(--v);background:var(--vl);}
.cday.empty{pointer-events:none;}
.cday.on{background:#e0f2fe;color:#0369a1;}
.cday.off{background:var(--s2);color:var(--t3);}
.cday.extra{background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd;}
.cday.hol{background:#fef3c7;color:#92400e;}
.cday.we{background:var(--s2);color:var(--t3);opacity:.65;}
.cday.today{border-color:var(--v)!important;background:var(--vl);color:var(--v);font-weight:800;}
.dnum{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:600;line-height:1;}
.dtag{font-size:8px;font-weight:700;letter-spacing:.06em;margin-top:2px;opacity:.8;}
.dact{font-size:7px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block;margin-top:1px;text-align:center;opacity:.85;}
@media print{.sidebar,.topbar,.btn,nav,.tabs,.hamburger{display:none!important;}.main{margin:0!important;padding:0!important;}.card{box-shadow:none!important;border:1px solid #e2e8f0!important;}body{background:#fff!important;}}
.prog{height:6px;background:var(--s2);border-radius:3px;overflow:hidden;}
.prog-f{height:100%;border-radius:3px;transition:width .4s;}
.rc{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--surface);border:1px solid var(--b);border-radius:var(--r);box-shadow:var(--sh);margin-bottom:8px;}
.rc:hover{box-shadow:var(--shm);}
.ri{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;}
.mo{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:200;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);animation:fi .14s;}
.md{background:var(--surface);border:1px solid var(--b);border-radius:14px;padding:24px;width:520px;max-width:95vw;max-height:88vh;overflow-y:auto;box-shadow:var(--shl);animation:su .18s ease;}
.md-wide{width:680px;}
.md-title{font-size:17px;font-weight:800;color:var(--t);margin-bottom:18px;}
.md-footer{display:flex;gap:10px;margin-top:20px;justify-content:flex-end;}
@keyframes fi{from{opacity:0}to{opacity:1}}
@keyframes su{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}
.pgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.pi{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;background:var(--s2);border-radius:var(--rs);}
.pkey{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);}
.pc{display:flex;align-items:center;gap:11px;padding:11px 13px;background:var(--surface);border:1px solid var(--b);border-radius:var(--r);box-shadow:var(--sh);margin-bottom:7px;}
.pdot{width:12px;height:12px;border-radius:50%;flex-shrink:0;}
.divider{height:1px;background:var(--b);margin:14px 0;}
.shd{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);border-bottom:1px solid var(--b);padding-bottom:7px;margin-bottom:12px;}
.av{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.lb-row{display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid var(--b);}
.lb-row:last-child{border-bottom:none;}
.lb-nm{font-size:13px;font-weight:600;color:var(--t);width:148px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lb-bw{flex:1;}
.lb-v{font-size:12px;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--t2);width:52px;text-align:right;}
.empty{text-align:center;padding:38px 20px;color:var(--t3);}
.empty-ico{font-size:34px;margin-bottom:8px;opacity:.35;}
.tt{background:var(--surface);border:1px solid var(--b);border-radius:var(--rs);padding:9px 13px;box-shadow:var(--shm);font-size:12px;}
.tt-lbl{font-weight:700;color:var(--t);margin-bottom:5px;}
.tt-row{display:flex;align-items:center;gap:7px;margin-top:3px;color:var(--t2);}
.color-sw{width:22px;height:22px;border-radius:5px;cursor:pointer;transition:transform .1s;}
.color-sw:hover{transform:scale(1.15);}
.color-sw.sel{outline:3px solid var(--t);outline-offset:2px;}
.itag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--t3);font-weight:500;}
/* ── Bulk action bar ── */
.bulk-bar{position:sticky;bottom:0;left:0;right:0;background:var(--t);color:#fff;border-radius:var(--r);padding:11px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 -2px 20px rgba(0,0,0,.18);z-index:10;margin-top:10px;animation:su .15s ease;}
.bulk-count{font-size:13px;font-weight:700;flex:1;}
.bulk-count span{background:rgba(255,255,255,.15);padding:2px 8px;border-radius:20px;font-family:'JetBrains Mono',monospace;margin-right:6px;}
.bulk-btn{padding:6px 13px;border-radius:var(--rs);font-size:12px;font-weight:600;cursor:pointer;border:none;font-family:'Plus Jakarta Sans',sans-serif;transition:all .12s;}
.bulk-btn.pri{background:var(--v);color:#fff;}.bulk-btn.pri:hover{background:var(--vd);}
.bulk-btn.sec{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);}.bulk-btn.sec:hover{background:rgba(255,255,255,.22);}
.bulk-btn.ghost{background:transparent;color:rgba(255,255,255,.55);}.bulk-btn.ghost:hover{color:#fff;}
/* row selected highlight */
.tbl tr.sel-row td{background:#f5f3ff!important;}
/* checkbox */
.cb{width:15px;height:15px;cursor:pointer;accent-color:var(--v);}
::-webkit-scrollbar{width:5px;height:5px;}
::-webkit-scrollbar-thumb{background:var(--b2);border-radius:3px;}
/* ── Org Chart ──────────────────────────────────────────────────────────────── */
.ot-wrap{overflow-x:auto;padding:8px 0 24px;min-height:160px;}.ot-tree{display:inline-flex;flex-direction:column;align-items:center;min-width:100%;}.ot-level{display:flex;justify-content:center;position:relative;}.ot-node{display:flex;flex-direction:column;align-items:center;padding:0 8px;}.ot-vline{width:2px;height:22px;background:var(--b2);flex-shrink:0;}.ot-hbar{height:2px;background:var(--b2);position:absolute;top:0;}.ot-card{border:1.5px solid var(--b);border-radius:10px;padding:10px 12px;background:var(--surface);text-align:center;width:148px;box-shadow:var(--sh);transition:box-shadow .15s;}.ot-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.1);}.ot-card.me{border-color:var(--v);background:var(--vl);box-shadow:0 0 0 3px #ede9fe;}.ot-card.inactive{opacity:.45;}.ot-you{font-size:9px;font-weight:800;color:var(--v);text-transform:uppercase;letter-spacing:.5px;margin-top:3px;}.ot-fm{font-size:10px;color:var(--t3);border-top:1px dashed var(--b);margin-top:5px;padding-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* ── Responsive ─────────────────────────────────────────────────────────────── */
.hamburger{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:6px;border:none;background:none;flex-shrink:0;}
.hamburger span{display:block;width:20px;height:2px;background:var(--t2);border-radius:2px;transition:all .2s;}
.sb-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:150;backdrop-filter:blur(1px);animation:fi .15s;}
@media(max-width:768px){
  .hamburger{display:flex;}
  .app{position:relative;}
  .sb{position:fixed;top:0;left:0;height:100vh;z-index:200;transform:translateX(-100%);transition:transform .25s ease;box-shadow:none;}
  .sb.open{transform:translateX(0);box-shadow:var(--shl);}
  .sb-overlay.open{display:block;}
  .topbar{padding:0 14px;}
  .content{padding:14px 12px;}
  .sg{grid-template-columns:repeat(2,1fr);}
  .g2,.g3,.fg{grid-template-columns:1fr;}
  .ff{grid-column:1/-1;}
  .tw{overflow-x:auto;}
  .tbl{min-width:540px;}
  .md{width:calc(100vw - 24px);max-width:100%;padding:18px 16px;}
  .md-wide{width:calc(100vw - 24px);}
  .tabs{gap:2px;}
  .tab{padding:5px 10px;font-size:12px;}
  .pg-title{font-size:15px;}
  .pg-sub{display:none;}
  .topbar-date{display:none;}
  .topbar-search{display:none!important;}
  .topbar-logo-text{display:none!important;}
  .profile-name{display:none!important;}
  .card{padding:14px;}
}
@media(max-width:480px){
  .sg{grid-template-columns:1fr 1fr;}
  .sv{font-size:20px;}
  .login-card{padding:28px 20px;}
}
@keyframes toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.login-card{background:var(--surface);}
.fi,.isel{background:var(--surface);color:var(--t);}
select.fi option{background:var(--surface);color:var(--t);}
input[type="date"]{color-scheme:light;}
:root[style*="--bg:#0f172a"] input[type="date"]{color-scheme:dark;}

/* ── Enterprise theme (Microsoft Admin Center style) ──────────────────────── */
/* Uses Fluent UI design: flat, clean, Segoe UI, left-accent sidebar, underline tabs */
/* All enterprise colors reference --ent-* or --v/--vl/--vd variables */
.ent-breadcrumb{display:none;}
.ent-page-header{display:none;}

/* Enterprise: Segoe UI font stack */
:root[style*="--ent-sb"] *{font-family:'Segoe UI','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif;}

/* Enterprise: breadcrumb */
:root[style*="--ent-sb"] .ent-breadcrumb{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--t3);font-weight:400;margin-bottom:1px;}
:root[style*="--ent-sb"] .ent-bc-sep{color:var(--b2);margin:0 2px;font-size:10px;}
:root[style*="--ent-sb"] .ent-bc-active{color:var(--t);font-weight:600;}
:root[style*="--ent-sb"] .ent-breadcrumb span:first-child:hover{color:var(--v);text-decoration:underline;}

/* Enterprise: page header */
:root[style*="--ent-sb"] .ent-page-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:0 0 16px;margin-bottom:16px;border-bottom:1px solid var(--b);gap:16px;flex-wrap:wrap;
}
:root[style*="--ent-sb"] .ent-ph-desc{font-size:14px;color:var(--t2);line-height:1.5;max-width:600px;font-weight:400;}
:root[style*="--ent-sb"] .ent-ph-right{display:flex;align-items:center;gap:6px;flex-shrink:0;}
:root[style*="--ent-sb"] .ent-ph-meta{display:flex;align-items:center;gap:6px;}
:root[style*="--ent-sb"] .ent-ph-chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--rs);font-size:12px;font-weight:600;background:var(--vl);color:var(--v);}
:root[style*="--ent-sb"] .ent-ph-chip-muted{background:var(--s2);color:var(--t3);}

/* Enterprise: sidebar — light bg, left accent bar */
:root[style*="--ent-sb"] .sb{background:var(--ent-sb);border-right:1px solid var(--b);}
:root[style*="--ent-sb"] .sb .logo-ico{border-radius:var(--rs);background:var(--ent-accent);}
:root[style*="--ent-sb"] .sb .logo-co{color:var(--t);font-size:14px;font-weight:700;}
:root[style*="--ent-sb"] .sb .logo-sub{color:var(--t3);font-size:10px;}
:root[style*="--ent-sb"] .sb .nl{color:var(--t3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}
:root[style*="--ent-sb"] .sb .ni{color:var(--t2);border-radius:0;padding:9px 12px;margin:0;font-size:14px;font-weight:400;border-left:3px solid transparent;transition:all .1s;}
:root[style*="--ent-sb"] .sb .ni:hover{background:var(--ent-sb-hover);color:var(--t);border-left-color:transparent;}
:root[style*="--ent-sb"] .sb .ni.active{background:var(--ent-sb-active-bg);color:var(--ent-accent);font-weight:600;border-left-color:var(--ent-accent);border-radius:0;}
:root[style*="--ent-sb"] .sb .ni-ico{filter:none;opacity:1;font-size:15px;}
:root[style*="--ent-sb"] .sb .ni.active .ni-ico{filter:none;}
:root[style*="--ent-sb"] .sb .u-nm{color:var(--t);}
:root[style*="--ent-sb"] .sb .u-rl{color:var(--t3);}
:root[style*="--ent-sb"] .sb .upill{background:var(--ent-sb-hover);border:1px solid var(--b);border-radius:var(--rs);}
:root[style*="--ent-sb"] .sb .nbadge{background:var(--ent-accent);color:#fff;border-radius:10px;font-size:10px;}
:root[style*="--ent-sb"] .sb > div:last-child{border-color:var(--b);}
:root[style*="--ent-sb"] .sb > div:last-child span{color:var(--t3)!important;}
:root[style*="--ent-sb"] .sb > div:last-child .dot{background:var(--gr)!important;}

/* Enterprise: topbar */
:root[style*="--ent-sb"] .topbar{height:48px;padding:0 24px;border-bottom:none;box-shadow:none;background:#0F27A4;}
:root[style*="--ent-sb"] .topbar .hamburger span{background:#fff;}
:root[style*="--ent-sb"] .topbar-search{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);border-radius:var(--r);}
:root[style*="--ent-sb"] .topbar-search:focus-within{background:rgba(255,255,255,.95);border-color:#fff;}
:root[style*="--ent-sb"] .topbar-search-input{font-size:14px;color:#fff;}
:root[style*="--ent-sb"] .topbar-search:focus-within .topbar-search-input{color:var(--t);}
:root[style*="--ent-sb"] .topbar-search-input::placeholder{color:rgba(255,255,255,.7);}
:root[style*="--ent-sb"] .topbar-search:focus-within .topbar-search-input::placeholder{color:var(--t3);}
:root[style*="--ent-sb"] .topbar-search span{color:rgba(255,255,255,.8)!important;}
:root[style*="--ent-sb"] .topbar-search:focus-within span{color:var(--t3)!important;}
:root[style*="--ent-sb"] .topbar-date{color:#fff!important;}
:root[style*="--ent-sb"] .topbar .btn.bo{border-color:rgba(255,255,255,.4);color:#fff;}
:root[style*="--ent-sb"] .topbar .btn.bo:hover{background:rgba(255,255,255,.15);border-color:#fff;color:#fff;}
:root[style*="--ent-sb"] .topbar .av{border:2px solid rgba(255,255,255,.4);}
:root[style*="--ent-sb"] .topbar .profile-name div:first-child{color:#fff;}
:root[style*="--ent-sb"] .topbar .profile-name div:last-child{color:rgba(255,255,255,.7);}
:root[style*="--ent-sb"] .pg-title{font-size:18px;font-weight:700;color:#fff;letter-spacing:0;line-height:48px;}
:root[style*="--ent-sb"] .topbar-logo-text{color:#fff!important;}
:root[style*="--ent-sb"] .topbar-logo .logo-ico{background:rgba(255,255,255,.2);box-shadow:none;}

/* Enterprise: content area */
:root[style*="--ent-sb"] .content{padding:20px 24px;}

/* Enterprise: cards — flat Fluent surface */
:root[style*="--ent-sb"] .card{border-radius:var(--r);padding:16px 20px;box-shadow:var(--sh);}
:root[style*="--ent-sb"] .card:hover{box-shadow:var(--shm);}
:root[style*="--ent-sb"] .card-hd{margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--b);}
:root[style*="--ent-sb"] .card-title{font-size:14px;font-weight:600;color:var(--t);}
:root[style*="--ent-sb"] .rc{border-radius:var(--r);}
:root[style*="--ent-sb"] .pc{border-radius:var(--r);}

/* Enterprise: KPI stat cards */
:root[style*="--ent-sb"] .sg{gap:12px;}
:root[style*="--ent-sb"] .sc{border-radius:var(--r);padding:16px 18px;}
:root[style*="--ent-sb"] .sc:hover{box-shadow:var(--shm);}
:root[style*="--ent-sb"] .sl{font-size:12px;font-weight:600;text-transform:none;letter-spacing:0;color:var(--t2);margin-bottom:4px;}
:root[style*="--ent-sb"] .sv{font-size:28px;font-weight:700;}

/* Enterprise: tables — Fluent DetailsList style */
:root[style*="--ent-sb"] .tbl th{background:transparent;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--t2);border-bottom:2px solid var(--b);padding:8px 12px;}
:root[style*="--ent-sb"] .tbl td{padding:8px 12px;font-size:13px;}
:root[style*="--ent-sb"] .tbl tr:hover td{background:var(--ent-sb-hover);}
:root[style*="--ent-sb"] .tw{border-radius:var(--r);}

/* Enterprise: tabs — Fluent Pivot underline style */
:root[style*="--ent-sb"] .tabs{background:transparent;border-radius:0;padding:0;gap:0;border-bottom:1px solid var(--b);}
:root[style*="--ent-sb"] .tab{border-radius:0;padding:10px 16px;font-size:14px;font-weight:400;color:var(--t2);border-bottom:2px solid transparent;margin-bottom:-1px;}
:root[style*="--ent-sb"] .tab:hover{color:var(--t);background:transparent;}
:root[style*="--ent-sb"] .tab.active{color:var(--v);font-weight:600;background:transparent;box-shadow:none;border-bottom:2px solid var(--v);}

/* Enterprise: buttons — Fluent UI flat */
:root[style*="--ent-sb"] .btn{border-radius:var(--r);font-weight:600;font-size:14px;padding:6px 16px;letter-spacing:0;}
:root[style*="--ent-sb"] .bp{background:var(--v);box-shadow:none;}
:root[style*="--ent-sb"] .bp:hover{background:var(--vd);box-shadow:none;}
:root[style*="--ent-sb"] .bo{border:1px solid var(--ent-neutral);color:var(--t2);}
:root[style*="--ent-sb"] .bo:hover{border-color:var(--v);color:var(--v);background:var(--vl);}
:root[style*="--ent-sb"] .bd{background:var(--rel);color:var(--re);border:1px solid var(--re);}
:root[style*="--ent-sb"] .bd:hover{background:var(--re);color:#fff;}
:root[style*="--ent-sb"] .bsm{padding:4px 12px;font-size:13px;}

/* Enterprise: badges — Fluent status */
:root[style*="--ent-sb"] .badge{border-radius:var(--rs);font-size:12px;padding:2px 8px;font-weight:600;}

/* Enterprise: modals — Fluent Dialog */
:root[style*="--ent-sb"] .mo{backdrop-filter:none;background:rgba(0,0,0,.4);}
:root[style*="--ent-sb"] .md{border-radius:var(--r);padding:24px;border:none;box-shadow:var(--shl);}
:root[style*="--ent-sb"] .md-title{font-size:20px;font-weight:600;letter-spacing:0;padding-bottom:0;border-bottom:none;margin-bottom:16px;color:var(--t);}
:root[style*="--ent-sb"] .md-footer{border-top:1px solid var(--b);padding-top:16px;margin-top:24px;}

/* Enterprise: form inputs — Fluent TextField */
:root[style*="--ent-sb"] .fi{border-radius:var(--rs);padding:6px 12px;border:1px solid var(--ent-neutral);font-size:14px;transition:border-color .1s;}
:root[style*="--ent-sb"] .fi:focus{border-color:var(--v);box-shadow:none;outline:none;border-bottom-width:2px;}
:root[style*="--ent-sb"] .flbl{font-size:14px;font-weight:600;color:var(--t);text-transform:none;letter-spacing:0;margin-bottom:4px;}

/* Enterprise: grid spacing */
:root[style*="--ent-sb"] .g2{gap:16px;margin-bottom:16px;}
:root[style*="--ent-sb"] .g3{gap:12px;margin-bottom:16px;}

/* Enterprise: status banners */
:root[style*="--ent-sb"] .ts-banner{border-radius:var(--rs);padding:12px 16px;}
:root[style*="--ent-sb"] .ts-banner.submitted{border-color:var(--am);}
:root[style*="--ent-sb"] .ts-banner.approved{border-color:var(--gr);}
:root[style*="--ent-sb"] .ts-banner.rejected{border-color:var(--re);}

/* Enterprise: calendar day overrides */
:root[style*="--ent-sb"] .cday.on{background:var(--ent-on-bg);color:var(--ent-on);}
:root[style*="--ent-sb"] .cday.extra{background:var(--ent-extra-bg);color:var(--ent-extra);}
:root[style*="--ent-sb"] .cday.hol{background:var(--ent-hol-bg);color:var(--ent-hol);}

/* Enterprise: login page */
:root[style*="--ent-sb"] .login-wrap{background:var(--bg);}
:root[style*="--ent-sb"] .login-card{border-radius:var(--r);box-shadow:var(--shl);border:1px solid var(--b);padding:32px 28px;}
:root[style*="--ent-sb"] .login-logo-ico{background:var(--ent-accent);border-radius:var(--rs);box-shadow:none;}
:root[style*="--ent-sb"] .login-err{border-radius:var(--rs);}

/* Enterprise: avatars — circular like Microsoft People */
:root[style*="--ent-sb"] .av{border-radius:50%!important;}

/* Enterprise: empty states */
:root[style*="--ent-sb"] .empty{padding:40px 20px;}
:root[style*="--ent-sb"] .empty-ico{font-size:36px;}

/* Enterprise: profile menu */
:root[style*="--ent-sb"] .profile-menu{border-radius:var(--r);box-shadow:var(--shl);}
:root[style*="--ent-sb"] .profile-menu-item{font-size:14px;}

/* Enterprise: allocation bars & misc */
:root[style*="--ent-sb"] .add-proj-btn{border-radius:var(--rs);border-color:var(--v);color:var(--v);background:var(--vl);}
:root[style*="--ent-sb"] .ap-detail{border-radius:var(--r);}
:root[style*="--ent-sb"] .alloc-row{font-size:13px;}
:root[style*="--ent-sb"] .sldr:checked{background:var(--v);}
`;

// ─── Shared mini-components ───────────────────────────────────────────────────
const RoleBadge = ({role,roles}) => {
  const r=roles[role]||{label:role,color:"#64748b",bg:"#f8fafc"};
  return <span className="badge" style={{background:r.bg,color:r.color}}>{r.label}</span>;
};
const StatusBadge = ({status}) => {
  const m={Approved:"bgr",Pending:"bam","Pending L2":"bam",Rejected:"bre"};
  const label=status==="Pending L2"?"Pending L2":status;
  return <span className={`badge ${m[status]||"bgr2"}`} style={status==="Pending L2"?{background:"#ede9fe",color:"#7c3aed"}:{}}>{label}</span>;
};
const TSStatusBadge = ({status}) => {
  const m={draft:["bgr2","Draft"],submitted:["bam","Submitted"],approved:["bgr","Approved"],rejected:["bre","Rejected"]};
  const [cls,lbl]=m[status]||["bgr2","Draft"];
  return <span className={`badge ${cls}`}>{lbl}</span>;
};
const TypeBadge = ({type}) =>
  <span className={`badge ${type==="field"?"bsk":"bv"}`}>{type==="field"?"Field":"Office"}</span>;
const CT = ({active,payload,label}) => {
  if(!active||!payload?.length) return null;
  return <div className="tt"><div className="tt-lbl">{label}</div>{payload.map((p,i)=><div key={i} className="tt-row"><div className="dot" style={{background:p.color}}/><span>{p.name}:</span><strong>{p.value}</strong></div>)}</div>;
};
function AllocBar({allocations,projects}) {
  const tot=allocations.reduce((s,a)=>s+a.allocation,0);
  return (
    <div style={{display:"flex",gap:1,height:6,borderRadius:4,overflow:"hidden",width:"100%",minWidth:60}}>
      {allocations.map((a,i)=>{const p=projects.find(x=>x.id===a.projectId);return <div key={i} style={{flex:a.allocation,background:p?.color||"#94a3b8",height:"100%"}} title={`${p?.code} ${(a.allocation*100).toFixed(0)}%`}/>;  })}
      {tot<1&&<div style={{flex:1-tot,background:"#e2e8f0",height:"100%"}}/>}
    </div>
  );
}

// ─── PASSWORD UTILS ───────────────────────────────────────────────────────────
function pwdStrength(p) {
  let s=0;
  if(p.length>=8) s++;
  if(/[A-Z]/.test(p)) s++;
  if(/[0-9]/.test(p)) s++;
  if(/[^A-Za-z0-9]/.test(p)) s++;
  return s; // 0-4
}
const PWD_COLORS=["#ef4444","#f59e0b","#f59e0b","#10b981","#10b981"];
const PWD_LABELS=["Too short","Weak","Fair","Good","Strong"];

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({onLogin, onVerifyTOTP, cs={}}) {
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [showPwd,setShowPwd]=useState(false);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [step,setStep]=useState("password"); // "password" | "totp"
  const [pendingId,setPendingId]=useState(null);
  const [totpCode,setTotpCode]=useState("");

  async function handleLogin() {
    setError(""); setLoading(true);
    try {
      const result = await onLogin(email, password);
      if (result?.requiresTOTP) { setPendingId(result.pendingUserId); setStep("totp"); }
    } catch (err) {
      setError(err.message || "Login failed. Please check your credentials.");
    } finally { setLoading(false); }
  }

  async function handleTOTP() {
    setError(""); setLoading(true);
    try {
      await onVerifyTOTP(pendingId, totpCode);
    } catch (err) {
      setError(err.message || "Invalid code. Try again.");
      setTotpCode("");
    } finally { setLoading(false); }
  }

  async function handleSSOLogin() {
    setError(""); setLoading(true);
    try {
      const msalInstance = await getMsalInstance();
      const result = await msalInstance.loginPopup(loginRequest);
      const response = await authAPI.ssoLogin(result.idToken);
      onLogin.__ssoResult = response; // pass result directly to parent handler
      // Simulate a successful login by calling onLogin with a special SSO flag
      await onLogin(null, null, response);
    } catch (err) {
      if (err.errorCode === 'user_cancelled') { setLoading(false); return; }
      setError(err.message || "Microsoft login failed. Please try again.");
    } finally { setLoading(false); }
  }

  const logo = (
    <div className="login-logo">
      {cs.logoBase64
        ? <img src={cs.logoBase64} alt="logo" style={{width:46,height:46,borderRadius:12,objectFit:"contain"}}/>
        : <div className="login-logo-ico">{(cs.companyName||"ME").slice(0,2).toUpperCase()}</div>}
      <div>
        <div style={{fontSize:20,fontWeight:800,color:"var(--t)"}}>{cs.companyName||"MAZARINE"}</div>
        <div style={{fontSize:11,color:"var(--t3)",fontWeight:500}}>{cs.companySubtitle||"Energy Tunisia"} · Timesheet Platform</div>
      </div>
    </div>
  );

  if (step==="totp") return (
    <div className="login-wrap">
      <div className="login-card">
        {logo}
        <div style={{fontSize:22,fontWeight:800,marginBottom:4}}>Two-Factor Auth</div>
        <div style={{fontSize:13,color:"var(--t3)",marginBottom:22}}>Enter the 6-digit code from your authenticator app</div>
        {error&&<div className="login-err">⚠ {error}</div>}
        <div className="fgrp" style={{marginBottom:20}}>
          <label className="flbl">Authenticator Code</label>
          <input className="fi" type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={totpCode} autoFocus
            style={{letterSpacing:"0.3em",fontSize:22,textAlign:"center",fontFamily:"'JetBrains Mono',monospace"}}
            onChange={e=>{setTotpCode(e.target.value.replace(/\D/g,""));setError("");}}
            onKeyDown={e=>e.key==="Enter"&&totpCode.length===6&&handleTOTP()}/>
        </div>
        <button className="btn bp" style={{width:"100%",justifyContent:"center",padding:"11px",fontSize:14}}
          disabled={loading||totpCode.length!==6} onClick={handleTOTP}>
          {loading?"Verifying…":"Verify →"}
        </button>
        <div style={{textAlign:"center",marginTop:14}}>
          <span style={{fontSize:12,color:"var(--t3)",cursor:"pointer",textDecoration:"underline"}}
            onClick={()=>{setStep("password");setError("");setTotpCode("");}}>
            ← Back to login
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="login-wrap">
      <div className="login-card">
        {logo}
        <div style={{fontSize:22,fontWeight:800,marginBottom:4}}>Welcome back</div>
        <div style={{fontSize:13,color:"var(--t3)",marginBottom:22}}>Sign in to your account to continue</div>
        {error&&<div className="login-err">⚠ {error}</div>}
        <div>
          <div className="fgrp" style={{marginBottom:12}}>
            <label className="flbl">Email address</label>
            <input className="fi" type="email" placeholder="your.name@mazarine.tn" value={email} autoFocus
              onChange={e=>{setEmail(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
          </div>
          <div className="fgrp" style={{marginBottom:20}}>
            <label className="flbl">Password</label>
            <div className="pwd-wrap">
              <input className="fi" type={showPwd?"text":"password"} placeholder="Enter your password" value={password}
                onChange={e=>{setPassword(e.target.value);setError("");}} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
              <button className="pwd-eye" onClick={()=>setShowPwd(s=>!s)}>{showPwd?"🙈":"👁"}</button>
            </div>
          </div>
          <button className="btn bp" style={{width:"100%",justifyContent:"center",padding:"11px",fontSize:14}} disabled={loading} onClick={handleLogin}>
            {loading?"Signing in…":"Sign In →"}
          </button>
          {ssoEnabled && (
            <>
              <div style={{display:"flex",alignItems:"center",gap:10,margin:"18px 0 14px"}}>
                <div style={{flex:1,height:1,background:"var(--border)"}}/>
                <span style={{fontSize:11,color:"var(--t3)",whiteSpace:"nowrap"}}>or continue with</span>
                <div style={{flex:1,height:1,background:"var(--border)"}}/>
              </div>
              <button
                style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:10,
                  padding:"10px",fontSize:13,fontWeight:600,border:"1px solid var(--border)",
                  borderRadius:8,background:"var(--bg2)",cursor:"pointer",color:"var(--t)"}}
                disabled={loading} onClick={handleSSOLogin}>
                <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
                  <rect x="1" y="1" width="9" height="9" fill="#F35325"/>
                  <rect x="11" y="1" width="9" height="9" fill="#81BC06"/>
                  <rect x="1" y="11" width="9" height="9" fill="#05A6F0"/>
                  <rect x="11" y="11" width="9" height="9" fill="#FFBA08"/>
                </svg>
                Sign in with Microsoft
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── CHANGE PASSWORD MODAL ────────────────────────────────────────────────────
function ChangePasswordModal({user, onClose, forced=false}) {
  const [cur,setCur]=useState("");
  const [next,setNext]=useState("");
  const [confirm,setConfirm]=useState("");
  const [showCur,setShowCur]=useState(false);
  const [showNext,setShowNext]=useState(false);
  const [error,setError]=useState("");
  const [saving,setSaving]=useState(false);

  const str=pwdStrength(next);
  const match=next===confirm&&next.length>0;
  const canSave=cur&&str>=2&&match;

  async function save() {
    setError("");
    setSaving(true);
    
    try {
      await authAPI.changePassword(cur, next);
      onClose();
    } catch (err) {
      setError(err.message || "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mo" onClick={e=>!forced&&e.target.className==="mo"&&onClose()}>
      <div className="md">
        <div className="md-title">{forced?"🔐 Set New Password":"Change Password"}</div>
        {forced&&<div style={{padding:"10px 13px",background:"var(--aml)",border:"1px solid #fcd34d",borderRadius:"var(--rs)",fontSize:13,color:"#92400e",marginBottom:16}}>
          Your password has been reset by an administrator. Please set a new password before continuing.
        </div>}
        {error&&<div className="login-err" style={{marginBottom:14}}>⚠ {error}</div>}
        <div className="fgrp" style={{marginBottom:12}}>
          <label className="flbl">Current Password</label>
          <div className="pwd-wrap">
            <input className="fi" type={showCur?"text":"password"} placeholder="Current password" value={cur} onChange={e=>{setCur(e.target.value);setError("");}}/>
            <button className="pwd-eye" onClick={()=>setShowCur(s=>!s)}>{showCur?"🙈":"👁"}</button>
          </div>
        </div>
        <div className="fgrp" style={{marginBottom:4}}>
          <label className="flbl">New Password</label>
          <div className="pwd-wrap">
            <input className="fi" type={showNext?"text":"password"} placeholder="At least 8 chars, upper, number, symbol" value={next} onChange={e=>{setNext(e.target.value);setError("");}}/>
            <button className="pwd-eye" onClick={()=>setShowNext(s=>!s)}>{showNext?"🙈":"👁"}</button>
          </div>
          {next&&<div style={{marginTop:6}}>
            <div style={{height:4,borderRadius:2,background:"var(--s2)",overflow:"hidden"}}>
              <div style={{height:"100%",borderRadius:2,width:`${str*25}%`,background:PWD_COLORS[str],transition:"all .3s"}}/>
            </div>
            <div style={{fontSize:11,color:PWD_COLORS[str],fontWeight:600,marginTop:3}}>{PWD_LABELS[str]}</div>
          </div>}
        </div>
        <div className="fgrp" style={{marginBottom:16}}>
          <label className="flbl">Confirm New Password</label>
          <input className="fi" type="password" placeholder="Re-enter new password" value={confirm} onChange={e=>{setConfirm(e.target.value);setError("");}}
            style={{borderColor:confirm?(match?"var(--gr)":"var(--re)"):"var(--b2)"}}/>
          {confirm&&<div style={{fontSize:11,marginTop:3,color:match?"var(--gr)":"var(--re)",fontWeight:600}}>{match?"✓ Passwords match":"✗ Passwords don't match"}</div>}
        </div>
        <div style={{fontSize:11,color:"var(--t3)",marginBottom:16}}>Requirements: 8+ characters, uppercase letter, number, special character</div>
        <div className="md-footer">
          {!forced&&<button className="btn bo" onClick={onClose} disabled={saving}>Cancel</button>}
          <button className="btn bp" disabled={!canSave || saving} style={{opacity:canSave&&!saving?1:.5}} onClick={save}>
            {saving ? "Saving..." : "Save Password"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TWO-FACTOR AUTH MODAL ────────────────────────────────────────────────────
function TwoFactorModal({onClose}) {
  const [enabled, setEnabled] = useState(null); // null=loading
  const [step, setStep] = useState("status");    // "status"|"setup"|"disable"
  const [qr, setQr] = useState(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");

  useEffect(()=>{
    totpAPI.getStatus().then(r=>{ setEnabled(r.enabled); }).catch(()=>setEnabled(false));
  },[]);

  async function startSetup() {
    setError(""); setSaving(true);
    try {
      const r = await totpAPI.setup();
      setQr(r.qr); setSecret(r.secret); setStep("setup");
    } catch(err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function confirmEnable() {
    setError(""); setSaving(true);
    try {
      await totpAPI.enable(secret, code);
      setEnabled(true); setSuccess("2FA enabled successfully!"); setStep("status"); setCode("");
    } catch(err) { setError(err.message); setCode(""); }
    finally { setSaving(false); }
  }

  async function confirmDisable() {
    setError(""); setSaving(true);
    try {
      await totpAPI.disable(code);
      setEnabled(false); setSuccess("2FA disabled."); setStep("status"); setCode("");
    } catch(err) { setError(err.message); setCode(""); }
    finally { setSaving(false); }
  }

  return (
    <div className="mo" onClick={e=>e.target.className==="mo"&&onClose()}>
      <div className="md">
        <div className="md-title">🔒 Two-Factor Authentication</div>

        {error&&<div className="login-err" style={{marginBottom:14}}>⚠ {error}</div>}
        {success&&<div style={{background:"var(--grl)",border:"1px solid #6ee7b7",color:"#065f46",borderRadius:"var(--rs)",padding:"10px 13px",fontSize:13,marginBottom:14,fontWeight:500}}>✓ {success}</div>}

        {enabled===null && <div style={{textAlign:"center",padding:32,color:"var(--t3)"}}>Loading…</div>}

        {enabled!==null && step==="status" && (
          <div>
            <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",background:enabled?"var(--grl)":"var(--s2)",borderRadius:"var(--r)",border:`1px solid ${enabled?"#6ee7b7":"var(--b)"}`,marginBottom:20}}>
              <div style={{fontSize:28}}>{enabled?"🛡":"🔓"}</div>
              <div>
                <div style={{fontWeight:700,fontSize:14,color:enabled?"#065f46":"var(--t)"}}>{enabled?"2FA is enabled":"2FA is disabled"}</div>
                <div style={{fontSize:12,color:enabled?"#047857":"var(--t3)",marginTop:2}}>{enabled?"Your account is protected with an authenticator app.":"Enable 2FA for stronger account security."}</div>
              </div>
            </div>
            {!enabled && <div style={{fontSize:13,color:"var(--t2)",marginBottom:18,lineHeight:1.6}}>
              Scan the QR code with <strong>Google Authenticator</strong>, <strong>Authy</strong>, or any TOTP app. You will need to enter a 6-digit code on every login.
            </div>}
            <div className="md-footer">
              <button className="btn bo" onClick={onClose}>Close</button>
              {enabled
                ? <button className="btn bd" onClick={()=>{setStep("disable");setCode("");setError("");setSuccess("");}}>Disable 2FA</button>
                : <button className="btn bp" disabled={saving} onClick={startSetup}>{saving?"Loading…":"Set Up 2FA →"}</button>}
            </div>
          </div>
        )}

        {step==="setup" && (
          <div>
            <div style={{fontSize:13,color:"var(--t2)",marginBottom:14}}>1. Scan this QR code with your authenticator app:</div>
            {qr&&<div style={{textAlign:"center",marginBottom:14}}><img src={qr} alt="QR" style={{width:180,height:180,borderRadius:8,border:"1px solid var(--b)"}}/></div>}
            <div style={{background:"var(--s2)",borderRadius:"var(--rs)",padding:"10px 13px",marginBottom:16,fontFamily:"'JetBrains Mono',monospace",fontSize:12,wordBreak:"break-all",color:"var(--t2)"}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",color:"var(--t3)",marginBottom:4}}>Manual entry key</div>
              {secret}
            </div>
            <div style={{fontSize:13,color:"var(--t2)",marginBottom:8}}>2. Enter the 6-digit code to verify:</div>
            <input className="fi" type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={code} autoFocus
              style={{letterSpacing:"0.3em",fontSize:20,textAlign:"center",fontFamily:"'JetBrains Mono',monospace",marginBottom:16}}
              onChange={e=>{setCode(e.target.value.replace(/\D/g,""));setError("");}}
              onKeyDown={e=>e.key==="Enter"&&code.length===6&&confirmEnable()}/>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>{setStep("status");setError("");}} disabled={saving}>Cancel</button>
              <button className="btn bp" disabled={code.length!==6||saving} onClick={confirmEnable}>{saving?"Enabling…":"Enable 2FA ✓"}</button>
            </div>
          </div>
        )}

        {step==="disable" && (
          <div>
            <div style={{fontSize:13,color:"var(--t2)",marginBottom:14}}>Enter your current authenticator code to disable 2FA:</div>
            <input className="fi" type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={code} autoFocus
              style={{letterSpacing:"0.3em",fontSize:20,textAlign:"center",fontFamily:"'JetBrains Mono',monospace",marginBottom:16}}
              onChange={e=>{setCode(e.target.value.replace(/\D/g,""));setError("");}}
              onKeyDown={e=>e.key==="Enter"&&code.length===6&&confirmDisable()}/>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>{setStep("status");setError("");}} disabled={saving}>Cancel</button>
              <button className="btn bd" disabled={code.length!==6||saving} onClick={confirmDisable}>{saving?"Disabling…":"Disable 2FA"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TIMESHEET STATUS BANNER ──────────────────────────────────────────────────
function TSBanner({tsStatus, onSubmit, onRecall, user, entries, leaveActs=[]}) {
  const status = tsStatus?.status || "draft";
  const workEntries = entries.filter(e=>!leaveActs.includes(e.activity));
  const allAllocOk = workEntries.every(e=>{
    const tot=e.allocations.reduce((s,a)=>s+a.allocation,0);
    return e.allocations.length===0||Math.abs(tot-1)<0.01;
  });
  const unallocated = workEntries.filter(e=>e.allocations.length===0).length;

  const cfg = {
    draft:     {ico:"📝", title:"Draft — Timesheet not yet submitted",    sub:`${entries.length} entries · ${unallocated>0?`${unallocated} entries missing project allocation · `:""}Edit entries then submit for manager review`, btn:<button className="btn bp bsm" onClick={onSubmit} disabled={!allAllocOk} title={!allAllocOk?"All entries must be 100% allocated before submitting":""} style={{opacity:allAllocOk?1:.5,cursor:allAllocOk?"pointer":"not-allowed"}}>Submit for Approval ▶</button>},
    submitted: {ico:"⏳", title:"Submitted — Awaiting manager review",      sub:`Submitted ${tsStatus?.submittedAt||""}`,     btn:<button className="btn bam2 bsm" onClick={onRecall}>↩ Recall & Edit</button>},
    approved:  {ico:"✅", title:"Approved",                                 sub:`Approved by manager${tsStatus?.reviewComment?` · "${tsStatus.reviewComment}"`:""}`, btn:null},
    rejected:  {ico:"❌", title:"Rejected — Please review and resubmit",    sub:tsStatus?.reviewComment?`Manager comment: "${tsStatus.reviewComment}"`:"No comment provided", btn:<button className="btn bp bsm" onClick={onSubmit}>Resubmit ▶</button>},
  };
  const c=cfg[status]||cfg.draft;
  return (
    <div className={`ts-banner ${status}`}>
      <span className="ts-banner-ico">{c.ico}</span>
      <div className="ts-banner-body">
        <div className="ts-banner-title">{c.title}</div>
        <div className="ts-banner-sub">{c.sub}</div>
      </div>
      {c.btn}
    </div>
  );
}

// ─── TIMESHEET VIEW ───────────────────────────────────────────────────────────
function TimesheetView({user,projects,timesheetData,setTimesheetData,tsStatuses,setTsStatuses,activities,rotations=[],requests=[]}) {
  const today=new Date();
  const [detailMonth,setDetailMonth]=useState(null); // null=list view, {year,month}=detail view
  const [year,setYear]=useState(today.getFullYear());
  const [month,setMonth]=useState(today.getMonth());
  const [tab,setTab]=useState("entries");
  const [expanded,setExpanded]=useState({});

  // ── Bulk selection state
  const [selected,setSelected]=useState(new Set());       // Set of entry ids
  const [bulkModal,setBulkModal]=useState(false);         // open bulk apply modal
  // bulkTemplate: allocation rows being built in the modal
  const BLANK_TMPL=[{id:1,projectId:"",allocation:1.0,note:""}];
  const [bulkTmpl,setBulkTmpl]=useState(BLANK_TMPL);
  const [bulkScope,setBulkScope]=useState("selected");    // "selected"|"activity"|"all"
  const [bulkActFilter,setBulkActFilter]=useState("");    // for scope="activity"
  const [defaultProject,setDefaultProject]=useState("");  // default project for quick fill

  const key=tsKey(user.id,year,month);
  const _today=new Date(); _today.setHours(0,0,0,0);
  const _isAdminUser=['admin','superadmin'].includes(user.role);
  const openProj=projects.filter(p=>
    p.open&&
    (user.type==="field"?p.fieldAllowed:p.officeAllowed)&&
    (!p.dept||_isAdminUser||p.dept===user.dept)&&
    (!p.expiryDate||_isAdminUser||new Date(p.expiryDate)>=_today)
  );
  const tsStatus=tsStatuses[key]||null;
  const status=tsStatus?.status||"draft";
  const isLocked=status==="submitted"||status==="approved";
  const LEAVE_ACTS_PS=activities.filter(a=>a.isLeave).map(a=>a.name);

  const rawEntries=useMemo(()=>timesheetData[key]||buildEntries(user,year,month,projects,activities,rotations),[key,timesheetData,user,year,month,projects,activities,rotations]);

  // Overlay pending request activities onto timesheet entries
  const pendingByDate=useMemo(()=>{
    const map={};
    const monthStart=`${year}-${pad(month+1)}-01`, monthEnd=`${year}-${pad(month+1)}-${pad(daysIn(year,month))}`;
    requests.filter(r=>r.userId===user.id&&(r.status==="Pending"||r.status==="Pending L2")&&r.start<=monthEnd&&r.end>=monthStart)
      .forEach(r=>{
        const s=new Date(Math.max(new Date(r.start),new Date(monthStart)));
        const e=new Date(Math.min(new Date(r.end),new Date(monthEnd)));
        for(let d=new Date(s);d<=e;d.setDate(d.getDate()+1)){
          if(d.getDay()===0||d.getDay()===6) continue;
          const ds=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
          map[ds]={type:r.type,status:r.status};
        }
      });
    return map;
  },[requests,user.id,year,month]);

  const entries=useMemo(()=>{
    return rawEntries.map(e=>{
      const pr=pendingByDate[e.date];
      if(pr&&!e.locked) return {...e,activity:pr.type,pendingRequest:true};
      return e;
    });
  },[rawEntries,pendingByDate]);

  const editableEntries=useMemo(()=>entries.filter(e=>!e.locked&&!e.pendingRequest),[entries]);
  const activityTypes=useMemo(()=>[...new Set(editableEntries.map(e=>e.activity))],[editableEntries]);

  const setEntries=useCallback(updater=>{
    setTimesheetData(prev=>{
      const cur=prev[key]||buildEntries(user,year,month,projects,activities,rotations);
      const nxt=typeof updater==="function"?updater(cur):updater;
      return {...prev,[key]:nxt};
    });
  },[key,user,year,month,projects,activities,rotations,setTimesheetData]);

  useEffect(()=>{
    timesheetAPI.getEntries(user.id,year,month+1).then(data=>{
      const defaults=buildEntries(user,year,month,projects,activities,rotations);
      const byDate=Object.fromEntries((data||[]).map(e=>[e.date,e]));
      const defaultDates=new Set(defaults.map(e=>e.date));
      const merged=defaults.map(e=>{
        const a=byDate[e.date];
        if(a) return {id:a.id,day:a.day,date:a.date,activity:a.activity,locked:a.locked,hours:a.hours,allocations:a.allocations||[]};
        return e;
      });
      // Include locked entries (approved requests) on OFF/EXTRA days not in defaults
      const extraLocked=(data||[]).filter(e=>!defaultDates.has(e.date)&&e.locked)
        .map(e=>({id:e.id,day:e.day,date:e.date,activity:e.activity,locked:e.locked,hours:e.hours,allocations:e.allocations||[]}));
      const all=[...merged,...extraLocked].sort((a,b)=>new Date(a.date)-new Date(b.date));
      setTimesheetData(prev=>({...prev,[key]:all}));
    }).catch(()=>{
      setTimesheetData(prev=>{
        if(prev[key]) return prev;
        return {...prev,[key]:buildEntries(user,year,month,projects,activities,rotations)};
      });
    });
  },[key]); // eslint-disable-line

  // Load statuses for all 12 months in the current list year whenever the list view is shown
  useEffect(()=>{
    if(detailMonth!==null) return;
    for(let m=0;m<12;m++){
      const k=tsKey(user.id,year,m);
      if(tsStatuses[k]) continue;
      timesheetAPI.getStatus(user.id,year,m+1).then(s=>{
        if(s?.status) setTsStatuses(prev=>({...prev,[k]:{
          status:s.status,submittedAt:s.submitted_at,
          reviewComment:s.review_comment,reviewedBy:s.reviewed_by,reviewedAt:s.reviewed_at
        }}));
      }).catch(()=>{});
    }
  },[detailMonth,year,user.id]); // eslint-disable-line

  // Open a specific month in detail view; loads entries + status from API on demand
  function openDetail(y,m){
    setYear(y); setMonth(m);
    setDetailMonth({year:y,month:m});
    setTab("entries"); setExpanded({}); setSelected(new Set());
    const k=tsKey(user.id,y,m);
    if(!timesheetData[k]){
      timesheetAPI.getEntries(user.id,y,m+1).then(data=>{
        const defaults=buildEntries(user,y,m,projects,activities,rotations);
        const byDate=Object.fromEntries((data||[]).map(e=>[e.date,e]));
        const defaultDates=new Set(defaults.map(e=>e.date));
        const merged=defaults.map(e=>{
          const a=byDate[e.date];
          if(a) return {id:a.id,day:a.day,date:a.date,activity:a.activity,locked:a.locked,hours:a.hours,allocations:a.allocations||[]};
          return e;
        });
        const extraLocked=(data||[]).filter(e=>!defaultDates.has(e.date)&&e.locked)
          .map(e=>({id:e.id,day:e.day,date:e.date,activity:e.activity,locked:e.locked,hours:e.hours,allocations:e.allocations||[]}));
        const all=[...merged,...extraLocked].sort((a,b)=>new Date(a.date)-new Date(b.date));
        setTimesheetData(prev=>({...prev,[k]:all}));
      }).catch(()=>{});
    }
    if(!tsStatuses[k]){
      timesheetAPI.getStatus(user.id,y,m+1).then(s=>{
        if(s?.status) setTsStatuses(prev=>({...prev,[k]:{
          status:s.status,submittedAt:s.submitted_at,
          reviewComment:s.review_comment,reviewedBy:s.reviewed_by,reviewedAt:s.reviewed_at
        }}));
      }).catch(()=>{});
    }
  }

  // Reset selection when month changes
  const prevM=()=>{if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1);setExpanded({});setSelected(new Set());};
  const nextM=()=>{if(month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1);setExpanded({});setSelected(new Set());};

  // ── Selection helpers
  const toggleSel=(id)=>setSelected(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;});
  const allEditable=editableEntries.map(e=>e.id);
  const allSelected=allEditable.length>0&&allEditable.every(id=>selected.has(id));
  const someSelected=allEditable.some(id=>selected.has(id));
  const toggleAll=()=>setSelected(allSelected?new Set():new Set(allEditable));
  const clearSel=()=>setSelected(new Set());

  // ── Single-row edit helpers
  function toggleRow(id){setExpanded(e=>({...e,[id]:!e[id]}));}
  function addAlloc(eid){setEntries(prev=>prev.map(e=>{if(e.id!==eid)return e;const used=e.allocations.reduce((s,a)=>s+a.allocation,0);const rem=Math.round((1-used)*4)/4;if(rem<=0)return e;const usedIds=e.allocations.map(a=>Number(a.projectId));const nextProj=openProj.find(p=>!usedIds.includes(p.id))?.id||"";return{...e,allocations:[...e.allocations,{id:Date.now(),projectId:nextProj,allocation:rem,note:""}]};}));}
  function delAlloc(eid,aid){setEntries(prev=>prev.map(e=>e.id!==eid?e:{...e,allocations:e.allocations.filter(a=>a.id!==aid)}));}
  function updAlloc(eid,aid,field,val){setEntries(prev=>prev.map(e=>e.id!==eid?e:{...e,allocations:e.allocations.map(a=>a.id!==aid?a:{...a,[field]:val})}));}
  // updAct removed — activity is set by user type / approved requests, not editable in-row

  // ── Bulk operations
  function fillUnallocated(){
    const dflt=openProj[0]?.id;
    if(!dflt){toast("No open projects available.");return;}
    setEntries(prev=>prev.map(e=>{
      if(isLocked||LEAVE_ACTS_PS.includes(e.activity)) return e;
      if(e.allocations.length>0) return e; // already has allocation
      return{...e,allocations:[{id:Date.now()+Math.random(),projectId:dflt,allocation:1.0,note:""}]};
    }));
  }

  function applyDefaultProject(){
    const pid=Number(defaultProject);
    if(!pid){toast("Please select a default project first.");return;}
    // Eligible: non-leave days that have no allocation or empty allocation
    const eligible=entries.filter(e=>{
      if(LEAVE_ACTS_PS.includes(e.activity)) return false;
      if(isLocked) return false;
      // Include days with no allocations or no project set (even if locked from approved requests)
      return e.allocations.length===0||!e.allocations.some(a=>a.projectId);
    });
    if(eligible.length===0){toast("All non-leave days already have a project assigned.");return;}
    const eligibleIds=new Set(eligible.map(e=>e.id));
    setEntries(prev=>prev.map(e=>{
      if(!eligibleIds.has(e.id)) return e;
      return{...e,allocations:[{id:Date.now()+Math.random(),projectId:pid,allocation:1.0,note:""}]};
    }));
    toast(`Applied default project to ${eligible.length} days.`,"info");
  }

  function copyPrevMonth(){
    const prevYear=month===0?year-1:year;
    const prevMonth=month===0?11:month-1;
    const prevKey=tsKey(user.id,prevYear,prevMonth);
    const prevEntries=timesheetData[prevKey];
    if(!prevEntries||prevEntries.length===0){toast(`No saved timesheet found for ${MONTHS[prevMonth]} ${prevYear}.`);return;}
    // Build a map of day-of-week → allocations from prev month
    const dowMap={};
    prevEntries.forEach(e=>{
      if(e.locked||e.allocations.length===0) return;
      const dow=new Date(e.date).getDay();
      dowMap[dow]=e.allocations.map(a=>({...a,id:Date.now()+Math.random()}));
    });
    // Also build activity map
    const actMap={};
    prevEntries.forEach(e=>{if(!e.locked) actMap[new Date(e.date).getDay()]=e.activity;});
    if(Object.keys(dowMap).length===0){toast("Previous month has no allocations to copy.");return;}
    setEntries(prev=>prev.map(e=>{
      if(e.locked||isLocked) return e;
      const dow=new Date(e.date).getDay();
      const allocs=dowMap[dow];
      if(!allocs) return e;
      // Validate projects still exist and are open
      const valid=allocs.filter(a=>openProj.some(p=>p.id==a.projectId));
      if(valid.length===0) return e;
      // Renormalise if some projects were removed
      const tot=valid.reduce((s,a)=>s+a.allocation,0);
      const norm=valid.map(a=>({...a,allocation:Math.round(a.allocation/tot*4)/4}));
      return{...e,allocations:norm.map(a=>({...a,id:Date.now()+Math.random()}))};
    }));
    toast(`Allocation pattern copied from ${MONTHS[prevMonth]} ${prevYear} (matched by day of week).`, 'success');
  }

  // ── Bulk template helpers
  function tmplAddRow(){
    const used=bulkTmpl.reduce((s,a)=>s+a.allocation,0);
    const rem=Math.round((1-used)*4)/4;
    if(rem<=0) return;
    const usedIds=new Set(bulkTmpl.map(r=>Number(r.projectId)));
    const nextProj=openProj.find(p=>!usedIds.has(p.id))?.id||openProj[0]?.id||"";
    setBulkTmpl(t=>[...t,{id:Date.now(),projectId:nextProj,allocation:rem,note:""}]);
  }
  function tmplDel(id){setBulkTmpl(t=>t.filter(r=>r.id!==id));}
  function tmplUpd(id,field,val){setBulkTmpl(t=>t.map(r=>r.id===id?{...r,[field]:val}:r));}
  const tmplTotal=bulkTmpl.reduce((s,a)=>s+a.allocation,0);
  const tmplOk=Math.abs(tmplTotal-1)<0.01&&bulkTmpl.length>0&&bulkTmpl.every(r=>r.projectId);

  function openBulkModal(){
    // Pre-fill template from first selected entry if it already has allocations
    const firstId=[...selected][0];
    const firstEntry=entries.find(e=>e.id===firstId);
    if(firstEntry?.allocations?.length>0){
      setBulkTmpl(firstEntry.allocations.map(a=>({...a,id:a.id})));
    } else {
      setBulkTmpl([{id:1,projectId:openProj[0]?.id||"",allocation:1.0,note:""}]);
    }
    setBulkScope("selected");
    setBulkActFilter(activityTypes[0]||"");
    setBulkModal(true);
  }

  function applyBulk(){
    if(!tmplOk) return;
    const newAllocs=bulkTmpl.map(a=>({...a,id:Date.now()+Math.random()}));
    // Issue 6: for scope="activity" with a non-leave activity, also add missing WE/holiday entries
    const workActName=bulkScope==="activity"?bulkActFilter:null;
    const workActObj=workActName?activities.find(a=>a.name===workActName):null;
    const addMissing=workActObj&&!workActObj.isLeave;
    setEntries(prev=>{
      // Apply allocations to matching entries
      let updated=prev.map(e=>{
        if(e.locked||isLocked) return e;
        const inScope=
          bulkScope==="selected"?selected.has(e.id):
          bulkScope==="activity"?e.activity===bulkActFilter:
          true; // "all"
        if(!inScope) return e;
        return{...e,allocations:newAllocs.map(a=>({...a,id:Date.now()+Math.random()}))};
      });
      // Issue 6: fill in missing weekend/holiday entries within the activity's date range
      if(addMissing){
        const scopedDates=updated.filter(e=>e.activity===workActName).map(e=>e.date).sort();
        if(scopedDates.length>0){
          const minD=scopedDates[0],maxD=scopedDates[scopedDates.length-1];
          const existDates=new Set(updated.map(e=>e.date));
          const toAdd=[];
          const cur=new Date(minD);
          const end=new Date(maxD);
          while(cur<=end){
            const dateStr=cur.toISOString().slice(0,10);
            if(!existDates.has(dateStr)&&(isWE(dateStr)||isHol(dateStr))){
              toAdd.push({id:"we-"+dateStr,day:cur.getDate(),date:dateStr,activity:workActName,locked:false,hours:user.type==="field"?12:8,allocations:newAllocs.map(a=>({...a,id:Date.now()+Math.random()}))});
            }
            cur.setDate(cur.getDate()+1);
          }
          if(toAdd.length>0)
            updated=[...updated,...toAdd].sort((a,b)=>a.date.localeCompare(b.date));
        }
      }
      return updated;
    });
    setBulkModal(false);
    clearSel();
  }

  // Count how many days will be affected by bulk
  const bulkAffectCount=useMemo(()=>{
    if(bulkScope==="selected") return [...selected].filter(id=>editableEntries.some(e=>e.id===id)).length;
    if(bulkScope==="activity") return editableEntries.filter(e=>e.activity===bulkActFilter).length;
    return editableEntries.length;
  },[bulkScope,bulkActFilter,selected,editableEntries]);

  async function handleSubmit(){
    const badAlloc=entries.filter(e=>!LEAVE_ACTS_PS.includes(e.activity)&&e.allocations.length>0&&Math.abs(e.allocations.reduce((s,a)=>s+a.allocation,0)-1)>=0.01).length;
    if(badAlloc>0){toast(`${badAlloc} entries have allocations that don't add up to 100%. Please fix before submitting.`);return;}
    // Normalize: merge any duplicate projectIds within each entry's allocations
    const normEntries=entries.map(e=>{
      if(e.allocations.length<2) return e;
      const m={};
      e.allocations.forEach(a=>{const pid=a.projectId;if(!m[pid])m[pid]={...a};else m[pid].allocation+=a.allocation;});
      return{...e,allocations:Object.values(m)};
    });
    try {
      await timesheetAPI.save(user.id, year, month+1, normEntries);
      await timesheetAPI.updateStatus(user.id, year, month+1, "submitted");
      setTsStatuses(prev=>({...prev,[key]:{status:"submitted",submittedAt:new Date().toISOString().split("T")[0],reviewComment:"",reviewedBy:null,reviewedAt:null}}));
    } catch(err) { toast("Failed to submit timesheet: "+err.message); }
  }
  async function handleRecall(){
    try {
      await timesheetAPI.updateStatus(user.id, year, month+1, "draft");
      setTsStatuses(prev=>({...prev,[key]:{...prev[key],status:"draft"}}));
    } catch(err) { toast("Failed to recall timesheet: "+err.message); }
  }

  const actColorFn=n=>activities.find(a=>a.name===n)?.color||"var(--v)";

  const projSummary=useMemo(()=>{
    const m={};
    entries.forEach(e=>e.allocations.forEach(a=>{if(!m[a.projectId])m[a.projectId]={days:0,hours:0};m[a.projectId].days+=a.allocation;m[a.projectId].hours+=a.allocation*e.hours;}));
    return Object.entries(m).map(([pid,v])=>({pid,proj:projects.find(p=>p.id==pid),days:Math.round(v.days*100)/100,hours:Math.round(v.hours*10)/10})).sort((a,b)=>b.days-a.days);
  },[entries,projects]);

  const actSum=useMemo(()=>{
    const c={};
    entries.forEach(e=>{c[e.activity]=(c[e.activity]||0)+1;});
    return c;
  },[entries]);
  const workedDaysPS=entries.filter(e=>!LEAVE_ACTS_PS.includes(e.activity)).length;

  const totAlloc=entries.reduce((s,e)=>s+e.allocations.reduce((ss,a)=>ss+a.allocation,0),0);
  const totHours=entries.reduce((s,e)=>s+e.hours,0);
  const unallocatedCount=editableEntries.filter(e=>e.allocations.length===0).length;

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  if(!detailMonth) return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button className="btn bo bsm" onClick={()=>setYear(y=>y-1)}>‹</button>
        <span style={{fontSize:15,fontWeight:700,minWidth:60,textAlign:"center"}}>{year}</span>
        <button className="btn bo bsm" onClick={()=>setYear(y=>y+1)}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12}}>
        {Array.from({length:12},(_,m)=>{
          const k=tsKey(user.id,year,m);
          const st=tsStatuses[k]?.status||"draft";
          const ents=timesheetData[k];
          const wdays=ents?ents.length:"—";
          const projCount=ents?new Set(ents.flatMap(e=>e.allocations.map(a=>a.projectId)).filter(Boolean)).size:"—";
          const isFuture=new Date(year,m,1)>today;
          // Count pending/approved requests that cover this month
          const monthStart=`${year}-${pad(m+1)}-01`, monthEnd=`${year}-${pad(m+1)}-${pad(daysIn(year,m))}`;
          const monthReqs=requests.filter(r=>r.userId===user.id&&r.start<=monthEnd&&r.end>=monthStart);
          const pendingReqs=monthReqs.filter(r=>r.status==="Pending"||r.status==="Pending L2");
          const approvedReqs=monthReqs.filter(r=>r.status==="Approved");
          const hasRequests=monthReqs.length>0;
          const borderCol=st==="approved"?"var(--gr)":st==="submitted"?"var(--am)":st==="rejected"?"var(--re)":"var(--b)";
          return (
            <div key={m} className="card" style={{cursor:"pointer",opacity:1,border:`1.5px solid ${borderCol}`,transition:"box-shadow .15s"}}
              onClick={()=>openDetail(year,m)}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontWeight:700,fontSize:15}}>{MONTHS[m]}</span>
                <TSStatusBadge status={st}/>
              </div>
              <div style={{display:"flex",gap:12,fontSize:12,color:"var(--t3)"}}>
                <span>📅 {wdays}{typeof wdays==="number"?" days":""}</span>
                <span>📁 {projCount}{typeof projCount==="number"?" proj":""}</span>
              </div>
              {(pendingReqs.length>0||approvedReqs.length>0)&&(
                <div style={{display:"flex",gap:8,marginTop:6,fontSize:11,flexWrap:"wrap"}}>
                  {pendingReqs.length>0&&<span style={{background:"var(--aml)",color:"#92400e",padding:"2px 7px",borderRadius:4,fontWeight:600}}>{pendingReqs.length} pending</span>}
                  {approvedReqs.length>0&&<span style={{background:"var(--grl)",color:"#065f46",padding:"2px 7px",borderRadius:4,fontWeight:600}}>{approvedReqs.length} approved</span>}
                </div>
              )}
              {st==="rejected"&&tsStatuses[k]?.reviewComment&&(
                <div style={{marginTop:6,fontSize:11,color:"var(--re)",fontStyle:"italic"}}>"{tsStatuses[k].reviewComment}"</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  const detailMonthStart=`${year}-${pad(month+1)}-01`, detailMonthEnd=`${year}-${pad(month+1)}-${pad(daysIn(year,month))}`;
  const monthRequests=requests.filter(r=>r.userId===user.id&&r.start<=detailMonthEnd&&r.end>=detailMonthStart);
  const pendingMonthReqs=monthRequests.filter(r=>r.status==="Pending"||r.status==="Pending L2");
  const approvedMonthReqs=monthRequests.filter(r=>r.status==="Approved");

  return (
    <div>
      <button className="btn bo bsm" onClick={()=>setDetailMonth(null)} style={{marginBottom:14}}>← All Timesheets</button>
      <TSBanner tsStatus={tsStatus} onSubmit={handleSubmit} onRecall={handleRecall} user={user} entries={entries} leaveActs={LEAVE_ACTS_PS}/>

      {monthRequests.length>0&&(
        <div style={{marginBottom:12,padding:"10px 14px",background:"var(--s2)",borderRadius:"var(--rs)",border:"1px solid var(--b)"}}>
          <div style={{fontSize:12,fontWeight:700,marginBottom:6,color:"var(--t2)"}}>Requests for {MONTHS[month]} {year}</div>
          {monthRequests.map(r=>(
            <div key={r.id} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",fontSize:12}}>
              <span style={{background:r.status==="Approved"?"var(--grl)":r.status==="Pending"||r.status==="Pending L2"?"var(--aml)":"var(--s3)",
                color:r.status==="Approved"?"#065f46":r.status==="Pending"||r.status==="Pending L2"?"#92400e":"var(--t2)",
                padding:"2px 8px",borderRadius:4,fontWeight:600,fontSize:11,minWidth:70,textAlign:"center"}}>{r.status}</span>
              <span style={{fontWeight:600}}>{r.type}</span>
              <span style={{color:"var(--t3)"}}>{r.start}{r.end!==r.start?` → ${r.end}`:""}</span>
              {r.daysCount>0&&<span style={{color:"var(--t3)"}}>({r.daysCount}d)</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
        <div className="tabs" style={{margin:0}}>
          <div className={`tab ${tab==="entries"?"active":""}`}  onClick={()=>setTab("entries")}>📋 Daily Entries</div>
          <div className={`tab ${tab==="projects"?"active":""}`} onClick={()=>setTab("projects")}>📁 Project Allocation</div>
          <div className={`tab ${tab==="summary"?"active":""}`}  onClick={()=>setTab("summary")}>📊 Payroll Summary</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button className="btn bo bsm" onClick={prevM}>‹</button>
          <span style={{fontSize:13,fontWeight:700,minWidth:100,textAlign:"center"}}>{MONTHS[month]} {year}</span>
          <button className="btn bo bsm" onClick={nextM}>›</button>
          <TSStatusBadge status={status}/>
        </div>
      </div>

      {tab==="entries"&&(
        <div>
          {/* ── Bulk toolbar (only when not locked) */}
          {!isLocked&&(
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--rs)",border:"1px solid var(--b)",flexWrap:"wrap"}}>
              <span style={{fontSize:12,color:"var(--t3)",fontWeight:600,marginRight:4}}>Default Project:</span>
              <select className="isel" style={{fontSize:12,padding:"4px 8px",maxWidth:200}} value={defaultProject} onChange={e=>setDefaultProject(e.target.value)}>
                <option value="">— Select —</option>
                {openProj.map(p=><option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
              <button className="btn bp bsm" onClick={applyDefaultProject} disabled={!defaultProject} style={{opacity:defaultProject?1:.5}}>
                Apply to unallocated days
              </button>
              {unallocatedCount>0&&<span style={{fontSize:11,color:"var(--am)",fontWeight:600}}>{unallocatedCount} unallocated</span>}
              <button className="btn bo bsm" title="Copy allocation pattern from previous month (matched by day of week)" onClick={copyPrevMonth}>
                📋 Copy prev month
              </button>
              <span style={{marginLeft:"auto",fontSize:11,color:"var(--t3)"}}>
                {someSelected?`${selected.size} of ${allEditable.length} selected`:`${allEditable.length} editable days · click rows to select`}
              </span>
            </div>
          )}

          <div className="tw">
            <table className="tbl">
              <thead><tr>
                {!isLocked&&<th style={{width:36,paddingLeft:10}}>
                  <input type="checkbox" className="cb" checked={allSelected} onChange={toggleAll} title="Select all editable days"/>
                </th>}
                <th style={{width:28}}/>
                <th>Date</th><th>Day</th>
                {user.type==="field"&&<th>Shift</th>}
                <th>Activity</th><th>Project Split</th><th>Allocated</th><th>Status</th>
              </tr></thead>
              <tbody>
                {entries.map(e=>{
                  const isSel=selected.has(e.id);
                  const isOpen=expanded[e.id];
                  const tot=e.allocations.reduce((s,a)=>s+a.allocation,0);
                  const allocOk=Math.abs(tot-1)<0.01||e.allocations.length===0;
                  const isPending=!!e.pendingRequest;
                  const isLeaveEntry=LEAVE_ACTS_PS.includes(e.activity)||isPending;
                  const usedProjIds=e.allocations.map(a=>Number(a.projectId));const canAdd=tot<0.99&&!isLocked&&!isLeaveEntry&&openProj.some(p=>!usedProjIds.includes(p.id));
                  const ac=actColorFn(e.activity);
                  const canExpand=!isLocked&&!isLeaveEntry&&!isPending;
                  const canSelect=!e.locked&&!isLocked&&!isPending;
                  return (
                    <>
                      <tr key={e.id} className={isSel?"sel-row":""} style={{cursor:canExpand?"pointer":"default",opacity:isLocked?.85:1,background:isPending?"var(--aml)":undefined}}
                        onClick={()=>{ if(canSelect){toggleSel(e.id);} else if(canExpand){toggleRow(e.id);} }}>
                        {!isLocked&&<td style={{paddingLeft:10}} onClick={ev=>ev.stopPropagation()}>
                          {canSelect&&<input type="checkbox" className="cb" checked={isSel} onChange={()=>toggleSel(e.id)}/>}
                        </td>}
                        <td style={{padding:"8px 6px",textAlign:"center"}} onClick={ev=>{ev.stopPropagation();canExpand&&toggleRow(e.id);}}>
                          {canExpand&&<span className={`exp-arrow${isOpen?" open":""}`}>▶</span>}
                        </td>
                        <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"#000"}}>{e.date}</td>
                        <td style={{fontWeight:700}}>{DS[new Date(e.date).getDay()]}</td>
                        {user.type==="field"&&<td><span className="badge bsk">ON</span></td>}
                        <td onClick={ev=>ev.stopPropagation()}>
                          <span className="badge" style={{background:ac+"18",color:ac,border:`1px solid ${ac}30`}}>{e.activity}</span>
                        </td>
                        <td style={{minWidth:140}}>
                          {isLeaveEntry||isPending
                            ? <span style={{fontSize:11,color:"var(--t3)"}}>—</span>
                            : e.allocations.length===0
                              ? <span style={{fontSize:11,color:"var(--re)",fontWeight:600}}>⚠ Not allocated</span>
                              : <div style={{display:"flex",alignItems:"center",gap:8}}><AllocBar allocations={e.allocations} projects={projects}/><span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)",whiteSpace:"nowrap"}}>{e.allocations.length}p</span></div>}
                        </td>
                        <td>{isLeaveEntry||isPending?<span style={{fontSize:11,color:"var(--t3)"}}>—</span>:<span className={allocOk&&e.allocations.length>0?"ok":"warn"}>{e.allocations.length===0?"0%":(tot*100).toFixed(0)+"%"}</span>}</td>
                        <td>{isPending?<span className="badge bam">⏳ Pending</span>:isLocked?<span className="badge bam">🔒 Locked</span>:e.locked?<span className="badge bgr">✓ Auto</span>:isSel?<span className="badge bv">☑ Selected</span>:<span className="badge bgr2">Draft</span>}</td>
                      </tr>
                      {isOpen&&canExpand&&(
                        <tr key={e.id+"_al"}>
                          <td colSpan={user.type==="field"?9:8} style={{padding:0}}>
                            <div className="alloc-wrap">
                              <div style={{display:"flex",alignItems:"center",padding:"5px 12px 3px 38px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",gap:8}}>
                                <span style={{flex:"0 0 155px"}}>Project</span><span style={{flex:1}}>Bar</span><span style={{width:60,textAlign:"center"}}>Amount</span><span style={{flex:1}}>Note</span><span style={{width:22}}/>
                              </div>
                              {e.allocations.map(a=>{
                                const ap=projects.find(p=>p.id===a.projectId);
                                return (
                                  <div className="alloc-row" key={a.id}>
                                    <div style={{flex:"0 0 155px",display:"flex",alignItems:"center",gap:6}}>
                                      <div className="dot" style={{background:ap?.color||"#94a3b8"}}/>
                                      <select className="isel" style={{maxWidth:142}} value={a.projectId} onChange={ev=>updAlloc(e.id,a.id,"projectId",Number(ev.target.value))}>
                                        {openProj.filter(p=>!e.allocations.filter(a2=>a2.id!==a.id).map(a2=>Number(a2.projectId)).includes(p.id)).map(p=><option key={p.id} value={p.id}>{p.code}</option>)}
                                      </select>
                                    </div>
                                    <div style={{flex:1,padding:"0 8px"}}><div className="abar"><div className="abar-fill" style={{width:`${a.allocation*100}%`,background:ap?.color||"#94a3b8"}}/></div></div>
                                    <div style={{width:60}}><select className="isel" style={{width:56,textAlign:"center"}} value={a.allocation} onChange={ev=>updAlloc(e.id,a.id,"allocation",parseFloat(ev.target.value))}>{ALLOC_STEPS.map(o=><option key={o} value={o}>{(o*100).toFixed(0)}%</option>)}</select></div>
                                    <div style={{flex:1,padding:"0 8px"}}><input className="iinp" placeholder="Note…" value={a.note} onChange={ev=>updAlloc(e.id,a.id,"note",ev.target.value)}/></div>
                                    <span className="del-btn" onClick={()=>delAlloc(e.id,a.id)}>×</span>
                                  </div>
                                );
                              })}
                              <div className="alloc-footer">
                                <div style={{display:"flex",alignItems:"center",gap:10}}>
                                  {canAdd&&<span className="add-proj-btn" onClick={()=>addAlloc(e.id)}>+ Add Project</span>}
                                  <span style={{fontSize:11,color:"var(--t3)"}}>{e.allocations.map(a=>{const p=projects.find(x=>x.id===a.projectId);return`${p?.code||"?"} ${(a.allocation*100).toFixed(0)}%`;}).join(" · ")}</span>
                                </div>
                                <span className={Math.abs(e.allocations.reduce((s,a)=>s+a.allocation,0)-1)<0.01?"ok":"warn"}>
                                  Total: {(e.allocations.reduce((s,a)=>s+a.allocation,0)*100).toFixed(0)}%
                                  {Math.abs(e.allocations.reduce((s,a)=>s+a.allocation,0)-1)>=0.01&&" ⚠ must = 100%"}
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Floating bulk action bar */}
          {someSelected&&!isLocked&&(
            <div className="bulk-bar">
              <div className="bulk-count"><span>{selected.size}</span>days selected</div>
              <button className="bulk-btn pri" onClick={openBulkModal}>✏️ Apply Allocation</button>
              <button className="bulk-btn sec" onClick={()=>{
                // Select all with same activity as first selected
                const firstId=[...selected][0];
                const act=entries.find(e=>e.id===firstId)?.activity;
                if(act) setSelected(new Set(editableEntries.filter(e=>e.activity===act).map(e=>e.id)));
              }}>⊞ Select same activity</button>
              <button className="bulk-btn ghost" onClick={clearSel}>✕ Clear</button>
            </div>
          )}
        </div>
      )}

      {tab==="projects"&&(
        <div>
          <div className="sg">
            <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Working Days</div><div className="sv" style={{color:"var(--v)"}}>{entries.length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Projects Used</div><div className="sv" style={{color:"var(--gr)"}}>{projSummary.length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Days Allocated</div><div className="sv" style={{color:"var(--am)"}}>{Math.round(totAlloc)}</div></div>
          </div>
          <div className="g2">
            <div className="tw">
              <div style={{padding:"12px 14px",borderBottom:"1px solid var(--b)",background:"var(--surface)"}}><div className="card-title">Breakdown by Project</div><div className="card-sub">{MONTHS[month]} {year}</div></div>
              <table className="tbl">
                <thead><tr><th>Project</th><th>Type</th><th>Days</th><th>Share</th></tr></thead>
                <tbody>
                  {projSummary.map(({pid,proj,days})=>{const pct=totAlloc>0?Math.round((days/totAlloc)*100):0;return(
                    <tr key={pid}><td><div style={{display:"flex",alignItems:"center",gap:8}}><div className="dot" style={{background:proj?.color||"#94a3b8"}}/><div><div style={{fontWeight:700,fontSize:13}}>{proj?.code||"?"}</div><div style={{fontSize:11,color:"var(--t3)"}}>{proj?.name}</div></div></div></td><td><span className="badge bgr2" style={{fontSize:10}}>{proj?.type}</span></td><td style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:"var(--v)"}}>{days}</td><td><div style={{display:"flex",alignItems:"center",gap:8}}><div className="prog" style={{width:56}}><div className="prog-f" style={{width:`${pct}%`,background:proj?.color||"var(--v)"}}/></div><span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}}>{pct}%</span></div></td>
                  </tr>);})}
                  {!projSummary.length&&<tr><td colSpan={5} style={{textAlign:"center",color:"var(--t3)",padding:28}}>No allocations yet</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="card">
              <div className="card-hd"><div><div className="card-title">Time Distribution</div><div className="card-sub">By project</div></div></div>
              <ResponsiveContainer width="100%" height={175}><PieChart><Pie data={projSummary.map(s=>({name:s.proj?.code,value:s.days,color:s.proj?.color||"#94a3b8"}))} cx="50%" cy="50%" innerRadius={42} outerRadius={72} paddingAngle={3} dataKey="value">{projSummary.map((s,i)=><Cell key={i} fill={s.proj?.color||COLORS[i%COLORS.length]}/>)}</Pie><Tooltip formatter={(v,n)=>[`${v}d`,n]}/></PieChart></ResponsiveContainer>
              {projSummary.map(({pid,proj,days})=>(<div key={pid} style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}><div className="dot" style={{background:proj?.color||"#94a3b8"}}/><span style={{fontSize:12,flex:1,color:"var(--t2)"}}>{proj?.code||"?"}</span><strong style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>{days}d</strong></div>))}
            </div>
          </div>
        </div>
      )}

      {tab==="summary"&&(
        <div className="card">
          <div className="shd">Payroll Summary — {MONTHS[month]} {year}</div>
          <div className="tw">
            <table className="tbl">
              <thead><tr>
                <th>Employee</th>
                <th>Worked Days</th>
                <th>Annual Leave</th>
                <th>Sick Leave</th>
                {user.type==="field"
                  ?<><th>Night Shift</th><th>Mission</th></>
                  :<><th>Remote Work</th><th>Mission</th><th>Training</th></>}
                <th>Recovery</th>
              </tr></thead>
              <tbody><tr>
                <td><div style={{fontWeight:700}}>{user.name}</div><div style={{fontSize:11,color:"var(--t3)"}}>{user.type}</div></td>
                <td><strong style={{color:"var(--v)",fontFamily:"'JetBrains Mono',monospace"}}>{workedDaysPS}</strong></td>
                <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Annual Leave"]||0}</td>
                <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Sick Leave"]||0}</td>
                {user.type==="field"
                  ?<>
                    <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Night Shift"]||0}</td>
                    <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{(actSum["Mission"]||0)+(actSum["Mission Office"]||0)+(actSum["Other Mission"]||0)}</td>
                  </>
                  :<>
                    <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Remote Work"]||0}</td>
                    <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{(actSum["Mission"]||0)+(actSum["Mission Office"]||0)+(actSum["Other Mission"]||0)}</td>
                    <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Training"]||0}</td>
                  </>}
                <td style={{fontFamily:"'JetBrains Mono',monospace"}}>{actSum["Recovery Leave"]||0}</td>
              </tr></tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Bulk Apply Modal */}
      {bulkModal&&(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setBulkModal(false)}>
          <div className="md">
            <div className="md-title">✏️ Bulk Apply Allocation</div>

            {/* Scope selector */}
            <div style={{marginBottom:16}}>
              <div className="flbl" style={{marginBottom:8}}>Apply to which days?</div>
              <div style={{display:"flex",flexDirection:"column",gap:7}}>
                <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"9px 12px",borderRadius:"var(--rs)",border:`1px solid ${bulkScope==="selected"?"var(--v)":"var(--b)"}`,background:bulkScope==="selected"?"var(--vl)":"var(--surface)"}}>
                  <input type="radio" name="scope" value="selected" checked={bulkScope==="selected"} onChange={()=>setBulkScope("selected")} style={{accentColor:"var(--v)"}}/>
                  <div><div style={{fontWeight:600,fontSize:13}}>{selected.size} selected days</div><div style={{fontSize:11,color:"var(--t3)"}}>Only the rows you checked</div></div>
                </label>
                <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"9px 12px",borderRadius:"var(--rs)",border:`1px solid ${bulkScope==="activity"?"var(--v)":"var(--b)"}`,background:bulkScope==="activity"?"var(--vl)":"var(--surface)"}}>
                  <input type="radio" name="scope" value="activity" checked={bulkScope==="activity"} onChange={()=>setBulkScope("activity")} style={{accentColor:"var(--v)"}}/>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>All days with activity:</div>
                    <select className="fsel" style={{fontSize:12,padding:"4px 8px"}} value={bulkActFilter} onChange={e=>setBulkActFilter(e.target.value)}>
                      <option value="">— Select activity —</option>
                      {activityTypes.filter(a=>!LEAVE_ACTS_PS.includes(a)).map(a=>(
                        <option key={a} value={a}>{a} ({editableEntries.filter(e=>e.activity===a).length}d)</option>
                      ))}
                    </select>
                  </div>
                </label>
                <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"9px 12px",borderRadius:"var(--rs)",border:`1px solid ${bulkScope==="all"?"var(--v)":"var(--b)"}`,background:bulkScope==="all"?"var(--vl)":"var(--surface)"}}>
                  <input type="radio" name="scope" value="all" checked={bulkScope==="all"} onChange={()=>setBulkScope("all")} style={{accentColor:"var(--v)"}}/>
                  <div><div style={{fontWeight:600,fontSize:13}}>All {editableEntries.length} editable days</div><div style={{fontSize:11,color:"var(--t3)"}}>Entire month (overwrites existing allocations)</div></div>
                </label>
              </div>
            </div>

            {/* Allocation template builder */}
            <div className="flbl" style={{marginBottom:8}}>Allocation to apply</div>
            <div style={{border:"1px solid var(--b)",borderRadius:"var(--rs)",overflow:"hidden",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",padding:"5px 10px 3px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",color:"var(--t3)",gap:8,background:"var(--s2)"}}>
                <span style={{flex:"0 0 155px"}}>Project</span><span style={{flex:1}}>Bar</span><span style={{width:60,textAlign:"center"}}>Amount</span><span style={{width:22}}/>
              </div>
              {bulkTmpl.map(a=>{
                const ap=projects.find(p=>p.id===a.projectId);
                return(
                  <div className="alloc-row" key={a.id} style={{paddingLeft:10}}>
                    <div style={{flex:"0 0 155px",display:"flex",alignItems:"center",gap:6}}>
                      <div className="dot" style={{background:ap?.color||"#94a3b8"}}/>
                      <select className="isel" style={{maxWidth:142}} value={a.projectId} onChange={ev=>tmplUpd(a.id,"projectId",Number(ev.target.value))}>
                        {openProj.filter(p=>!bulkTmpl.filter(r=>r.id!==a.id).map(r=>Number(r.projectId)).includes(p.id)).map(p=><option key={p.id} value={p.id}>{p.code}</option>)}
                      </select>
                    </div>
                    <div style={{flex:1,padding:"0 8px"}}><div className="abar"><div className="abar-fill" style={{width:`${a.allocation*100}%`,background:ap?.color||"#94a3b8"}}/></div></div>
                    <div style={{width:60}}><select className="isel" style={{width:56}} value={a.allocation} onChange={ev=>tmplUpd(a.id,"allocation",parseFloat(ev.target.value))}>{ALLOC_STEPS.map(o=><option key={o} value={o}>{(o*100).toFixed(0)}%</option>)}</select></div>
                    <span className="del-btn" style={{marginLeft:4}} onClick={()=>tmplDel(a.id)}>×</span>
                  </div>
                );
              })}
              <div style={{padding:"6px 10px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                {tmplTotal<0.99&&<span className="add-proj-btn" onClick={tmplAddRow}>+ Add project</span>}
                <span style={{marginLeft:"auto"}} className={tmplOk?"ok":"warn"}>
                  Total: {(tmplTotal*100).toFixed(0)}%{!tmplOk&&" ⚠"}
                </span>
              </div>
            </div>

            <div style={{padding:"9px 13px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12,color:"var(--t2)"}}>
              This will overwrite existing allocations on <strong>{bulkAffectCount} day{bulkAffectCount!==1?"s":""}</strong>.
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setBulkModal(false)}>Cancel</button>
              <button className="btn bp" disabled={!tmplOk} style={{opacity:tmplOk?1:.5,cursor:tmplOk?"pointer":"not-allowed"}} onClick={applyBulk}>
                Apply to {bulkAffectCount} day{bulkAffectCount!==1?"s":""}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── COMBINED APPROVALS VIEW (Requests + Timesheets) ─────────────────────────

function ApprovalsView({user,requests,setRequests,users,setUsers,roles,tsStatuses,setTsStatuses,timesheetData,setTimesheetData,projects,activities,rotations=[]}) {
  const [tab,setTab]=useState("timesheets");
  const isAd=hasPerm(roles,user.role,"all");
  const canUnlock=isAd||hasPerm(roles,user.role,"hr_report");
  const [resetModal,setResetModal]=useState(null);
  const [reqDetailModal,setReqDetailModal]=useState(null);
  const [reqDetailHistory,setReqDetailHistory]=useState([]);
  const [reqDetailLoading,setReqDetailLoading]=useState(false);
  const openReqDetail=async(r)=>{
    setReqDetailModal(r);setReqDetailHistory([]);setReqDetailLoading(true);
    try{const h=await requestsAPI.getHistory(r.id);setReqDetailHistory(h||[]);}catch{}
    setReqDetailLoading(false);
  };

  async function resetTimesheet(){
    if(!resetModal) return;
    const {key,userId,year,month,user:tUser}=resetModal;
    try{
      const resp=await timesheetAPI.reset(userId,year,month+1);
      // Remove status (back to draft = disappears from approvals list)
      setTsStatuses(prev=>{const n={...prev};delete n[key];return n;});
      // Clear cached entries (forces rebuild from defaults on next open)
      setTimesheetData(prev=>{const n={...prev};delete n[key];return n;});
      // Remove related requests from UI
      if(resp.deletedRequestIds?.length>0)
        setRequests(prev=>prev.filter(r=>!resp.deletedRequestIds.includes(r.id)));
      // Restore user balances
      if((resp.leaveRestored||0)+(resp.recoveryBalRestored||0)+(resp.recoveryReversed||0)>0&&setUsers)
        setUsers(prev=>prev.map(u=>{
          if(u.id!==Number(userId)) return u;
          return{...u,
            leaveBalance:(u.leaveBalance||0)+(resp.leaveRestored||0),
            usedLeave:Math.max(0,(u.usedLeave||0)-(resp.leaveRestored||0)),
            recoveryBalance:Math.max(0,(u.recoveryBalance||0)+(resp.recoveryBalRestored||0)-(resp.recoveryReversed||0))
          };
        }));
      setResetModal(null);
      toast(`✅ ${tUser.name}'s timesheet for ${MONTHS[month]} ${year} has been reset to default.`,'success');
    }catch(err){toast('Failed to reset timesheet: '+err.message);}
  }

  async function unlockTimesheet(item){
    if(!window.confirm(`Unlock ${item.user.name}'s timesheet for ${MONTHS[item.month]} ${item.year}?\nIt will return to Draft so the employee can edit it again.`)) return;
    try{
      await timesheetAPI.unlock(item.userId,item.year,item.month+1);
      setTsStatuses(prev=>({...prev,[item.key]:{...prev[item.key],status:"draft",reviewComment:"",reviewedBy:null,reviewedAt:null}}));
      setTimesheetData(prev=>{const n={...prev};delete n[item.key];return n;});
    }catch(err){toast('Failed to unlock: '+err.message);}
  }

  // Request approvals (existing)
  const isOpsManager=user.role==="operations_manager";
  const isCountryManager=user.role==="country_manager";
  const teamIds=isAd?users.map(u=>u.id):users.filter(u=>u.manager===user.id).map(u=>u.id);
  const canSeeRequest=(r)=>{
    if(isAd) return true;
    // Workflow-driven: if user is the current approver, they can see it
    if(r.currentApproverId===user.id) return true;
    // Managers always see their team's requests
    if(teamIds.includes(r.userId)) return true;
    // Legacy: L2 role-based approvers
    if(r.type==="Extra Days OnSite"&&r.status==="Pending L2"){
      const days=Number(r.daysCount);
      if(isCountryManager&&days>3) return true;
      if(isOpsManager&&days===3) return true;
    }
    return false;
  };
  const canApproveRequest=(r)=>{
    if(isAd&&(r.status==="Pending"||r.status==="Pending L2")) return true;
    // Workflow-driven: check if current user is the designated approver
    if(r.currentApproverId) return r.currentApproverId===user.id;
    // Legacy fallback (requests without workflow)
    if(r.type==="Extra Days OnSite"){
      const days=Number(r.daysCount);
      if(r.status==="Pending"&&teamIds.includes(r.userId)) return true;
      if(r.status==="Pending L2"&&isCountryManager&&days>3) return true;
      if(r.status==="Pending L2"&&isOpsManager&&days===3) return true;
      return false;
    }
    return r.status==="Pending"&&teamIds.includes(r.userId);
  };
  const pendReq=requests.filter(r=>(r.status==="Pending"||r.status==="Pending L2")&&canApproveRequest(r));
  const allTeamReq=requests.filter(r=>canSeeRequest(r));
  const icos={"Annual Leave":"🌴","Sick Leave":"🏥","Mission":"✈️","Mission Office":"✈️","Training":"📚","Remote Work":"🏠","Night Shift":"🌙","Extra Days":"💼","Compassionate":"💙","Recovery Leave":"🔄","Temporary Authorization":"🕐"};
  const nm=id=>users.find(u=>u.id===id)?.name||"Unknown";
  async function approve(id){
    try{
      const resp=await requestsAPI.update(id,{status:"Approved",reviewComment:""});
      const newStatus=resp.status||"Approved";
      setRequests(p=>p.map(r=>r.id===id?{...r,status:newStatus,approvalStep:resp.approval_step||r.approvalStep,step1ReviewedBy:resp.step1_reviewed_by||r.step1ReviewedBy,step1ReviewedAt:resp.step1_reviewed_at?.slice(0,10)||r.step1ReviewedAt,currentApproverId:null}:r));
      if(resp.affectedMonths?.length>0){
        setTimesheetData(prev=>{const n={...prev};resp.affectedMonths.forEach(k=>delete n[k]);return n;});
      }
    }catch(err){toast('Failed to approve: '+err.message);}
  }
  async function reject(id){
    try{
      const resp=await requestsAPI.update(id,{status:"Rejected",reviewComment:""});
      setRequests(p=>p.map(r=>r.id===id?{...r,status:"Rejected"}:r));
      // Issue 2: restore balance in UI state on rejection
      if((resp.daysRestored||0)>0&&setUsers)
        setUsers(prev=>prev.map(u=>u.id===resp.user_id?{...u,leaveBalance:(u.leaveBalance||0)+resp.daysRestored,usedLeave:Math.max(0,(u.usedLeave||0)-resp.daysRestored)}:u));
      if((resp.recoveryRestored||0)>0&&setUsers)
        setUsers(prev=>prev.map(u=>u.id===resp.user_id?{...u,recoveryBalance:(u.recoveryBalance||0)+resp.recoveryRestored}:u));
    }catch(err){toast('Failed to reject: '+err.message);}
  }

  // Load team timesheet statuses on mount so manager sees submitted timesheets
  useEffect(()=>{
    timesheetAPI.getAllStatuses().then(rows=>{
      const updates={};
      rows.forEach(r=>{
        const k=`${r.user_id}-${r.year}-${String(r.month).padStart(2,'0')}`;
        updates[k]={status:r.status,submittedAt:r.submitted_at?.slice(0,10)||null,reviewComment:r.review_comment||'',reviewedBy:r.reviewed_by,reviewedAt:r.reviewed_at?.slice(0,10)||null};
      });
      setTsStatuses(prev=>({...prev,...updates}));
    }).catch(()=>{});
  },[]);

  // Timesheet approvals
  const [reviewModal,setReviewModal]=useState(null); // {key, userId, year, month, action}
  const [reviewComment,setReviewComment]=useState("");
  const [tsDetailModal,setTsDetailModal]=useState(null);

  // Build list of submitted timesheets for this manager's team
  const submittedTS = useMemo(()=>{
    const result=[];
    Object.entries(tsStatuses).forEach(([k,v])=>{
      if(v.status!=="submitted"&&v.status!=="approved"&&v.status!=="rejected") return;
      const [uid,yr,mo]=k.split("-");
      const teamUser=users.find(u=>u.id===Number(uid));
      if(!teamUser) return;
      if(!isAd&&teamUser.manager!==user.id) return;
      result.push({key:k,userId:Number(uid),year:Number(yr),month:Number(mo)-1,user:teamUser,status:v.status,submittedAt:v.submittedAt,reviewComment:v.reviewComment,reviewedAt:v.reviewedAt});
    });
    return result.sort((a,b)=>{
      const order={submitted:0,rejected:1,approved:2};
      return (order[a.status]||0)-(order[b.status]||0)||(b.submittedAt||"").localeCompare(a.submittedAt||"");
    });
  },[tsStatuses,users,user.id,isAd]);

  const pendingTS=submittedTS.filter(t=>t.status==="submitted").length;

  function openReview(item,action){setReviewModal({...item,action});setReviewComment("");}
  async function confirmReview(){
    if(!reviewModal) return;
    const {key,action,userId,year,month}=reviewModal;
    if(action==="reject"&&!reviewComment.trim()){toast("Please provide a rejection reason.");return;}
    const newStatus=action==="approve"?"approved":"rejected";
    try{
      const resp=await timesheetAPI.updateStatus(userId,year,month+1,newStatus,reviewComment);
      setTsStatuses(prev=>({...prev,[key]:{...prev[key],status:newStatus,reviewComment,reviewedBy:user.id,reviewedAt:new Date().toISOString().split("T")[0]}}));
      // Update the employee's recovery balance in UI if days were accrued on approval
      if((resp?.recoveryAccrued||0)>0&&setUsers){
        setUsers(prev=>prev.map(u=>u.id===Number(userId)?{...u,recoveryBalance:(u.recoveryBalance||0)+resp.recoveryAccrued}:u));
        toast(`✅ Timesheet approved — 🔄 ${resp.recoveryAccrued}d recovery balance added`);
      }
      setReviewModal(null);
    }catch(err){toast('Failed to '+action+' timesheet: '+err.message);}
  }

  function getEntries(item){
    return timesheetData[item.key]||buildEntries(item.user,item.year,item.month,projects,activities,rotations);
  }
  function getProjSummary(entries){
    const m={};
    entries.forEach(e=>e.allocations.forEach(a=>{if(!m[a.projectId])m[a.projectId]={days:0,hours:0};m[a.projectId].days+=a.allocation;m[a.projectId].hours+=a.allocation*e.hours;}));
    return Object.entries(m).map(([pid,v])=>({proj:projects.find(p=>p.id==pid),days:Math.round(v.days*100)/100,hours:Math.round(v.hours*10)/10})).sort((a,b)=>b.days-a.days);
  }

  return (
    <div>
      <div className="tabs">
        <div className={`tab ${tab==="timesheets"?"active":""}`} onClick={()=>setTab("timesheets")} style={{display:"flex",alignItems:"center",gap:6}}>
          🗒 Timesheet Approvals {pendingTS>0&&<span className="nbadge">{pendingTS}</span>}
        </div>
        <div className={`tab ${tab==="requests"?"active":""}`} onClick={()=>setTab("requests")} style={{display:"flex",alignItems:"center",gap:6}}>
          📋 Request Approvals {pendReq.length>0&&<span className="nbadge">{pendReq.length}</span>}
        </div>
      </div>

      {/* ── TIMESHEET APPROVALS ── */}
      {tab==="timesheets"&&(
        <div>
          {/* Summary stats */}
          <div className="sg">
            <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Pending Review</div><div className="sv" style={{color:"var(--am)"}}>{pendingTS}</div><div className="sc2 neu">awaiting action</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Approved</div><div className="sv" style={{color:"var(--gr)"}}>{submittedTS.filter(t=>t.status==="approved").length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--re)"}}/><div className="sl">Rejected</div><div className="sv" style={{color:"var(--re)"}}>{submittedTS.filter(t=>t.status==="rejected").length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Team Members</div><div className="sv" style={{color:"var(--v)"}}>{teamIds.length}</div></div>
          </div>

          {submittedTS.length===0?(
            <div className="empty"><div className="empty-ico">🗒</div>No timesheets submitted by your team yet</div>
          ):(
            <div className="tw">
              <table className="tbl">
                <thead><tr><th>Employee</th><th>Period</th><th>Working Days</th><th>Projects</th><th>Submitted</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {submittedTS.map(item=>{
                    const entries=getEntries(item);
                    const ps=getProjSummary(entries);
                    const wdays=entries.length;
                    return (
                      <tr key={item.key}>
                        <td>
                          <div style={{display:"flex",alignItems:"center",gap:9}}>
                            <div className="av" style={{background:aColor(item.userId)}}>{initials(item.user.name)}</div>
                            <div>
                              <div style={{fontWeight:700,fontSize:13}}>{item.user.name}</div>
                              <div style={{fontSize:11,color:"var(--t3)"}}>{item.user.dept}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{MONTHS[item.month]} {item.year}</td>
                        <td style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:"var(--v)"}}>{wdays}d</td>
                        <td>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                            {ps.slice(0,3).map(({proj,days})=>(
                              <span key={proj?.id} className="badge bgr2" style={{fontSize:10,gap:4}}>
                                <div className="dot" style={{background:proj?.color||"#94a3b8",width:6,height:6}}/>{proj?.code} {days}d
                              </span>
                            ))}
                            {ps.length>3&&<span className="badge bgr2" style={{fontSize:10}}>+{ps.length-3}</span>}
                          </div>
                        </td>
                        <td style={{fontSize:12,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{item.submittedAt||"—"}</td>
                        <td><TSStatusBadge status={item.status}/></td>
                        <td>
                          <div style={{display:"flex",gap:4,alignItems:"center"}}>
                            <button className="btn bo bxs" onClick={()=>setTsDetailModal(item)} title="View details">▼ Details</button>
                            {item.status==="submitted"&&(
                              <>
                                <button className="btn bs bxs" onClick={()=>openReview(item,"approve")}>✓ Approve</button>
                                <button className="btn bd bxs" onClick={()=>openReview(item,"reject")}>✗ Reject</button>
                              </>
                            )}
                            {item.status==="approved"&&<>{canUnlock&&<button className="btn bo bxs" title="Unlock for editing" onClick={()=>unlockTimesheet(item)}>🔓 Unlock</button>}<span style={{fontSize:11,color:"var(--gr)",fontWeight:600}}>✓ Approved</span></>}
                            {item.status==="rejected"&&<span style={{fontSize:11,color:"var(--re)",fontWeight:600}}>✗ Sent back</span>}
                            {isAd&&<button className="btn bd bxs" title="Reset timesheet to default — removes all entries and related requests" onClick={()=>setResetModal(item)}>🔄 Reset</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── REQUEST APPROVALS ── */}
      {tab==="requests"&&(
        <div>
          <div style={{marginBottom:12}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:3}}>Team Requests</div>
            <div style={{fontSize:12,color:"var(--t3)"}}>{pendReq.length} pending · {allTeamReq.filter(r=>r.status==="Approved").length} approved · {allTeamReq.filter(r=>r.status==="Rejected").length} rejected</div>
          </div>
          {allTeamReq.length===0&&<div className="empty"><div className="empty-ico">📋</div>No team requests yet</div>}
          {allTeamReq.map(r=>{
            return(
            <div className="rc" key={r.id}>
              <div className="ri" style={{background:r.type==="Annual Leave"?"#d1fae5":r.type==="Sick Leave"?"#fee2e2":"#f0f9ff"}}>{icos[r.type]||"📋"}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--v)",marginBottom:2}}>{nm(r.userId)}</div>
                <div style={{fontWeight:700,fontSize:13}}>{r.type}{r.balanceSource==="recovery"&&<span style={{marginLeft:5,fontSize:10,color:"var(--v)",fontWeight:400}}>🔄 Recovery</span>}</div>
                <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{r.type==="Temporary Authorization"?`${r.start} · ${r.authStartTime||""}→${r.authEndTime||""} (${r.durationHours}h)`:`${r.start}${r.halfDayStart?" "+r.halfDayStart:""}${r.end!==r.start?" → "+r.end+(r.halfDayEnd?" "+r.halfDayEnd:""):""} · ${r.daysCount===0.5?"½ day":r.daysCount+"d"}`}{r.comment?" · "+r.comment:""}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                <StatusBadge status={r.status}/>
                {(r.status==="Pending"||r.status==="Pending L2")&&r.createdAt&&(()=>{
                  const days=Math.floor((new Date()-new Date(r.createdAt))/86400000);
                  return days>=3?<span style={{fontSize:10,fontWeight:700,color:days>=7?"var(--re)":"var(--am)",background:days>=7?"var(--rel)":"var(--aml)",padding:"1px 6px",borderRadius:3}}>⏱ {days}d pending</span>:null;
                })()}
                {r.totalSteps>1&&<span style={{fontSize:10,color:r.status==="Pending L2"?"#7c3aed":"var(--t3)",fontWeight:600}}>
                  Step {r.approvalStep}/{r.totalSteps}{r.status==="Pending L2"?" · L2 Review":""}
                </span>}
                {r.step1ReviewedBy&&<span style={{fontSize:10,color:"#059669"}}>✓ Mgr: {nm(r.step1ReviewedBy)}{r.step1ReviewedAt?" · "+r.step1ReviewedAt:""}</span>}
                <button className="btn bo bxs" onClick={()=>openReqDetail(r)}>Details</button>
                {canApproveRequest(r)&&(
                  <div style={{display:"flex",gap:4}}><button className="btn bs bxs" onClick={()=>approve(r.id)}>✓</button><button className="btn bd bxs" onClick={()=>reject(r.id)}>✗</button></div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* ── Timesheet Detail Modal ── */}
      {tsDetailModal&&(()=>{
        const item=tsDetailModal;
        const entries=getEntries(item);
        const ps=getProjSummary(entries);
        return (
          <div className="mo" onClick={e=>e.target.className==="mo"&&setTsDetailModal(null)}>
            <div className="md" style={{maxWidth:820,width:"95vw",maxHeight:"88vh",display:"flex",flexDirection:"column"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div className="av" style={{background:aColor(item.userId)}}>{initials(item.user.name)}</div>
                  <div>
                    <div style={{fontWeight:700,fontSize:15}}>{item.user.name}</div>
                    <div style={{fontSize:12,color:"var(--t3)"}}>{MONTHS[item.month]} {item.year} · {item.user.type} · {item.user.dept}</div>
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <TSStatusBadge status={item.status}/>
                  {item.status==="submitted"&&<>
                    <button className="btn bs bxs" onClick={()=>{setTsDetailModal(null);openReview(item,"approve");}}>✓ Approve</button>
                    <button className="btn bd bxs" onClick={()=>{setTsDetailModal(null);openReview(item,"reject");}}>✗ Reject</button>
                  </>}
                  <button className="btn bo bxs" onClick={()=>setTsDetailModal(null)}>✕</button>
                </div>
              </div>
              {item.reviewComment&&(
                <div style={{padding:"8px 12px",background:item.status==="approved"?"var(--grl)":"var(--rel)",borderRadius:"var(--rs)",fontSize:12,color:item.status==="approved"?"#065f46":"#991b1b",marginBottom:12}}>
                  <strong>{item.status==="approved"?"✓ Approval note:":"✗ Rejection reason:"}</strong> {item.reviewComment}
                </div>
              )}
              {/* Daily entries table */}
              <div style={{overflow:"auto",flex:1,marginBottom:14}}>
                <table className="tbl" style={{minWidth:560}}>
                  <thead><tr><th>Date</th><th>Day</th><th>Activity</th><th>Project Allocation</th></tr></thead>
                  <tbody>
                    {entries.map(e=>(
                      <tr key={e.id}>
                        <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"#000"}}>{e.date}</td>
                        <td style={{fontWeight:600,fontSize:12}}>{DS[new Date(e.date).getDay()]}</td>
                        <td><span className="badge bgr2" style={{fontSize:11}}>{e.activity}</span></td>
                        <td>
                          {e.allocations.length===0
                            ?<span style={{fontSize:11,color:"var(--re)"}}>⚠ None</span>
                            :<div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {e.allocations.map(a=>{const p=projects.find(x=>x.id==a.projectId);return(
                                <span key={a.id} className="badge bgr2" style={{fontSize:10,display:"flex",alignItems:"center",gap:3}}>
                                  <div className="dot" style={{background:p?.color||"#94a3b8",width:6,height:6}}/>{p?.code||"?"} {(a.allocation*100).toFixed(0)}%
                                </span>
                              );})}
                            </div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Project allocation summary */}
              <div style={{borderTop:"1px solid var(--b)",paddingTop:12}}>
                <div className="shd" style={{marginBottom:8}}>Project Allocation Summary</div>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {ps.map(({proj,days})=>(
                    <div className="ap-alloc-row" key={proj?.id} style={{background:"var(--s2)",borderRadius:"var(--rs)"}}>
                      <div className="dot" style={{background:proj?.color||"#94a3b8"}}/>
                      <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:12,width:120}}>{proj?.code||"?"}</span>
                      <div style={{flex:1,padding:"0 10px"}}><div className="prog"><div className="prog-f" style={{width:`${Math.round(days/entries.length*100)}%`,background:proj?.color||"var(--v)"}}/></div></div>
                      <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--v)",fontWeight:700,width:36,textAlign:"right"}}>{days}d</span>
                    </div>
                  ))}
                  {ps.length===0&&<div style={{fontSize:12,color:"var(--t3)"}}>No project allocations recorded.</div>}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Reset Timesheet Confirmation Modal ── */}
      {resetModal&&(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setResetModal(null)}>
          <div className="md">
            <div className="md-title">🔄 Reset Timesheet</div>
            <div style={{color:"var(--t2)",fontSize:13,marginBottom:16}}>
              The following will be permanently removed for <strong>{resetModal.user.name} — {MONTHS[resetModal.month]} {resetModal.year}</strong>:
              <ul style={{marginTop:8,paddingLeft:20,lineHeight:1.9,color:"var(--t2)"}}>
                <li>All timesheet entries (activities + allocations)</li>
                <li>All leave and work requests overlapping this period</li>
                <li>Any accrued recovery balance from this timesheet</li>
              </ul>
              Activities will be restored to <strong>{resetModal.user.type==="field"?"Site":"Office"}</strong> (default for {resetModal.user.type} employee).
            </div>
            <div style={{padding:"9px 13px",background:"var(--rel)",borderRadius:"var(--rs)",fontSize:12,color:"#991b1b",marginBottom:16,fontWeight:600}}>
              ⚠️ This action cannot be undone.
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setResetModal(null)}>Cancel</button>
              <button className="btn bd" onClick={resetTimesheet}>Yes, Reset Timesheet</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Review Modal ── */}
      {reviewModal&&(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setReviewModal(null)}>
          <div className="md">
            <div className="md-title">{reviewModal.action==="approve"?"✅ Approve Timesheet":"❌ Reject Timesheet"}</div>
            <div style={{padding:"12px 14px",background:"var(--s2)",borderRadius:"var(--rs)",marginBottom:16}}>
              <div style={{fontWeight:700,fontSize:13}}>{reviewModal.user?.name}</div>
              <div style={{fontSize:12,color:"var(--t3)",marginTop:2}}>{MONTHS[reviewModal.month]} {reviewModal.year} · {reviewModal.user?.type}</div>
            </div>
            <div className="fgrp">
              <label className="flbl">{reviewModal.action==="approve"?"Comment (optional)":"Rejection Reason (required)"}</label>
              <textarea className="fta" style={{minHeight:90}} placeholder={reviewModal.action==="approve"?"e.g. All looks good, approved.":"e.g. Project allocation on day 5 appears incorrect."} value={reviewComment} onChange={e=>setReviewComment(e.target.value)}/>
            </div>
            {reviewModal.action==="approve"&&<p className="fnote" style={{color:"var(--gr)",marginTop:8}}>✓ This timesheet will be locked and forwarded to HR for payroll processing.</p>}
            {reviewModal.action==="reject"&&<p className="fnote" style={{marginTop:8}}>⚠ The employee will be notified and can edit and resubmit their timesheet.</p>}
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setReviewModal(null)}>Cancel</button>
              <button className={`btn ${reviewModal.action==="approve"?"bs":"bd"}`} onClick={confirmReview}>
                {reviewModal.action==="approve"?"✓ Confirm Approval":"✗ Confirm Rejection"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Request Detail Modal ── */}
      {reqDetailModal&&(()=>{
        const r=reqDetailModal;
        const actionLabels={request_created:"Created",request_approved:"Approved",request_approved_l1:"Approved (L1)",request_rejected:"Rejected",request_cancelled:"Cancelled"};
        const actionIcos={request_created:"📝",request_approved:"✅",request_approved_l1:"✔️",request_rejected:"❌",request_cancelled:"🚫"};
        const actionColors={request_created:"var(--v)",request_approved:"var(--gr)",request_approved_l1:"var(--v)",request_rejected:"var(--re)",request_cancelled:"var(--t3)"};
        return(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setReqDetailModal(null)}>
          <div className="md" style={{maxWidth:620,width:"95vw",maxHeight:"90vh",overflowY:"auto"}}>
            <div className="md-title" style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span>Request #{r.id} Details</span>
              <StatusBadge status={r.status}/>
            </div>
            <div className="fg">
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>
                <div><span style={{color:"var(--t3)"}}>Employee:</span> <b>{nm(r.userId)}</b></div>
                <div><span style={{color:"var(--t3)"}}>Type:</span> <b>{r.type}</b></div>
                <div><span style={{color:"var(--t3)"}}>Start:</span> <b>{r.start}{r.halfDayStart?` (${r.halfDayStart})`:""}</b></div>
                <div><span style={{color:"var(--t3)"}}>End:</span> <b>{r.end}{r.halfDayEnd?` (${r.halfDayEnd})`:""}</b></div>
                {r.type==="Temporary Authorization"?<>
                  <div><span style={{color:"var(--t3)"}}>Time:</span> <b>{r.authStartTime||""} → {r.authEndTime||""}</b></div>
                  <div><span style={{color:"var(--t3)"}}>Duration:</span> <b>{r.durationHours}h</b></div>
                </>:<>
                  <div><span style={{color:"var(--t3)"}}>Days:</span> <b>{r.daysCount===0.5?"½ day":r.daysCount+"d"}</b></div>
                  <div><span style={{color:"var(--t3)"}}>Balance:</span> <b>{r.balanceSource==="recovery"?"🔄 Recovery":"Annual"}</b></div>
                </>}
                {r.totalSteps>1&&<div><span style={{color:"var(--t3)"}}>Step:</span> <b>{r.approvalStep}/{r.totalSteps}</b></div>}
                {r.createdAt&&<div><span style={{color:"var(--t3)"}}>Submitted:</span> <b>{r.createdAt}</b></div>}
              </div>
              {r.comment&&(
                <div style={{marginTop:10,padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>
                  <span style={{color:"var(--t3)"}}>Comment:</span> {r.comment}
                </div>
              )}

              <div style={{marginTop:14,borderTop:"1px solid var(--b)",paddingTop:12}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Change History</div>
                {reqDetailLoading&&<div style={{fontSize:12,color:"var(--t3)"}}>Loading…</div>}
                {!reqDetailLoading&&reqDetailHistory.length===0&&<div style={{fontSize:12,color:"var(--t3)",fontStyle:"italic"}}>No history entries yet.</div>}
                {!reqDetailLoading&&reqDetailHistory.map((h,i)=>(
                  <div key={h.id} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:i<reqDetailHistory.length-1?"1px solid var(--b)":"none"}}>
                    <div style={{fontSize:18,flexShrink:0,width:24,textAlign:"center"}}>{actionIcos[h.action]||"•"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,color:actionColors[h.action]||"var(--t)"}}>
                        {actionLabels[h.action]||h.action} <span style={{fontWeight:400,color:"var(--t3)"}}>by {h.actor_name||"System"}</span>
                      </div>
                      <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{new Date(h.created_at).toLocaleString()}</div>
                      <div style={{fontSize:12,color:"var(--t2)",marginTop:3}}>{(h.detail||"").replace(/^Request #\d+:\s*/,"")}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setReqDetailModal(null)}>Close</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ─── REQUESTS VIEW ────────────────────────────────────────────────────────────
function RequestsView({user,requests,setRequests,users,roles,setUsers,tsStatuses,setTsStatuses,activities}) {
  const [tab,setTab]=useState("mine");
  const [mineFilter,setMineFilter]=useState("all");
  const [show,setShow]=useState(false);
  const [form,setForm]=useState({type:"",start:"",end:"",comment:"",halfDayStart:"",halfDayEnd:"",durationHours:1,balanceSource:"annual",authStartTime:"08:00",authEndTime:"10:00"});
  const [attachFile,setAttachFile]=useState(null); // File object
  const [attachUrl,setAttachUrl]=useState(""); // uploaded blob URL
  const [attachUploading,setAttachUploading]=useState(false);
  const handleAttach=async(e)=>{
    const file=e.target.files?.[0];
    if(!file)return;
    if(file.size>10*1024*1024){toast("File too large. Max 10 MB.");return;}
    setAttachFile(file);
    setAttachUploading(true);
    try{
      const result=await uploadsAPI.upload(file);
      setAttachUrl(result.blobName||result.url||result.name||"");
      toast("File uploaded.","success");
    }catch(err){toast("Upload failed: "+err.message);setAttachFile(null);}
    setAttachUploading(false);
  };
  const [cancelModal,setCancelModal]=useState(null);
  const [cancelReason,setCancelReason]=useState("");
  const [histFilter,setHistFilter]=useState("all");
  const [detailModal,setDetailModal]=useState(null);
  const [detailHistory,setDetailHistory]=useState([]);
  const [detailLoading,setDetailLoading]=useState(false);
  const openDetail=async(r)=>{
    setDetailModal(r);setDetailHistory([]);setDetailLoading(true);
    try{const h=await requestsAPI.getHistory(r.id);setDetailHistory(h||[]);}catch{}
    setDetailLoading(false);
  };
  const fieldActs=activities.filter(a=>a.active&&(a.visibleTo==="field"||a.visibleTo==="both")).map(a=>a.name);
  const officeActs=activities.filter(a=>a.active&&(a.visibleTo==="office"||a.visibleTo==="both")).map(a=>a.name);
  const FTYP=[...new Set([...fieldActs,"Temporary Authorization"])];
  const OTYP=[...new Set([...officeActs,"Temporary Authorization"])];
  const leaveTypes=user.type==="field"?FTYP:OTYP;
  const tList=[...leaveTypes,...ADMIN_DOC_TYPES];
  const icos={"Annual Leave":"🌴","Sick Leave":"🏥","Mission":"✈️","Mission Office":"✈️","Training":"📚","Remote Work":"🏠","Night Shift":"🌙","Extra Days":"💼","Compassionate":"💙","Recovery Leave":"🔄","Other Mission":"🗺","Temporary Authorization":"🕐","Work Certificate":"📄","Salary Certificate":"📄","Salary Advance":"💰","Employment Letter":"📃","Experience Letter":"📃","Other Document":"📋"};
  const ADMIN_DOC_TYPES=["Work Certificate","Salary Certificate","Salary Advance","Employment Letter","Experience Letter","Other Document"];
  const isAdminDoc=ADMIN_DOC_TYPES.includes(form.type);
  const HALF_DAY_TYPES=["Annual Leave","Sick Leave","Compassionate","Remote Work","Mission","Mission Office","Other Mission","Training","Recovery Leave"];
  const showHalfDay=HALF_DAY_TYPES.includes(form.type);
  const isSingleDay=!form.end||form.end===form.start;
  const liveDc=useMemo(()=>{
    if(!form.type||form.type==="Temporary Authorization"||ADMIN_DOC_TYPES.includes(form.type)||!form.start||!form.end||form.end<form.start) return null;
    const isSingle=form.end===form.start;
    const full=isSingle?1:Math.ceil((new Date(form.end)-new Date(form.start))/86400000)+1;
    const sd=form.halfDayStart?0.5:0;
    const ed=(!isSingle&&form.halfDayEnd)?0.5:0;
    return isSingle&&form.halfDayStart?0.5:Math.max(0.5,full-sd-ed);
  },[form.type,form.start,form.end,form.halfDayStart,form.halfDayEnd]);// eslint-disable-line
  const annualRem=Math.max(0,Number(user.leaveBalance)-Number(user.usedLeave));
  const availForType=(form.type==="Recovery Leave"||(["Annual Leave","Sick Leave","Compassionate"].includes(form.type)&&form.balanceSource==="recovery"))?Number(user.recoveryBalance||0):annualRem;
  const myR=requests.filter(r=>r.userId===user.id);
  const histR=myR.filter(r=>r.status!=="Pending"&&r.status!=="Pending L2").sort((a,b)=>(b.start||"").localeCompare(a.start||""));
  const filtHistR=histFilter==="all"?histR:histR.filter(r=>r.status===histFilter);

  // Team: direct reports + peers (same line manager)
  const directReports=users.filter(u=>u.manager===user.id).map(u=>u.id);
  const peers=user.manager?users.filter(u=>u.manager===user.manager&&u.id!==user.id).map(u=>u.id):[];
  const teamIds=[...new Set([...directReports,...peers])];
  const teamR=requests.filter(r=>teamIds.includes(r.userId));
  const activeTeamR=teamR.filter(r=>r.status==="Pending"||r.status==="Approved");

  // Conflict detection
  function datesOverlap(s1,e1,s2,e2){return s1<=e2&&e1>=s2;}
  const conflictIds=useMemo(()=>{
    const ids=new Set();
    for(let i=0;i<activeTeamR.length;i++)
      for(let j=i+1;j<activeTeamR.length;j++)
        if(datesOverlap(activeTeamR[i].start,activeTeamR[i].end,activeTeamR[j].start,activeTeamR[j].end)){
          ids.add(activeTeamR[i].id);ids.add(activeTeamR[j].id);
        }
    return ids;
  },[activeTeamR]);// eslint-disable-line

  // Warn in form when teammates already have overlapping requests
  const formConflicts=form.type!=="Temporary Authorization"&&!ADMIN_DOC_TYPES.includes(form.type)&&form.start&&form.end
    ?activeTeamR.filter(r=>datesOverlap(form.start,form.end,r.start,r.end))
    :[];

  async function submit(){
    const isTempAuth=form.type==="Temporary Authorization";
    const isDoc=ADMIN_DOC_TYPES.includes(form.type);
    if(!form.type)return;
    if(!isDoc&&!form.start)return;
    if(!isDoc&&!isTempAuth&&!form.end)return;
    // Date ordering guard
    if(!isDoc&&!isTempAuth&&form.end<form.start){toast("End date must be on or after start date.");return;}
    let dc,durationHours,endDate;
    if(isDoc){
      // Admin doc requests: no dates, no balance
      dc=0;durationHours=null;
      const today=new Date().toISOString().split("T")[0];
      endDate=form.start||today;
      if(!form.start) setForm(f=>({...f,start:today}));
    }else if(isTempAuth){
      // Issue 5: time-range validation
      if(!form.authStartTime||!form.authEndTime){toast("Start and end time required.");return;}
      const [sh,sm]=form.authStartTime.split(":").map(Number);
      const [eh,em]=form.authEndTime.split(":").map(Number);
      const diffH=(eh*60+em-(sh*60+sm))/60;
      if(diffH<=0){toast("End time must be after start time.");return;}
      if(diffH>2){toast("Maximum authorization duration is 2 hours.");return;}
      durationHours=Math.round(diffH*100)/100;
      dc=0;endDate=form.start;
    }else{
      const fullDays=isSingleDay?1:Math.ceil((new Date(form.end)-new Date(form.start))/86400000)+1;
      const startDeduct=form.halfDayStart?0.5:0;
      const endDeduct=(!isSingleDay&&form.halfDayEnd)?0.5:0;
      dc=isSingleDay&&form.halfDayStart?0.5:Math.max(0.5,fullDays-startDeduct-endDeduct);
      durationHours=null;endDate=form.end;
    }
    // Zero-duration guard
    if(!isTempAuth&&!isDoc&&dc<=0){toast("Request duration must be greater than 0 days.");return;}
    if(!isTempAuth&&!isDoc&&dc>7&&user.type==="field"){toast("Max 7 days per request for field staff.");return;}
    // Issue 1: balance check before submission
    if(!isTempAuth&&!isDoc){
      const leaveBalTypes=["Annual Leave","Sick Leave","Compassionate"];
      if(leaveBalTypes.includes(form.type)||form.type==="Recovery Leave"){
        const useRecovery=form.type==="Recovery Leave"||(form.balanceSource||"annual")==="recovery";
        const avail=useRecovery?Number(user.recoveryBalance||0):Math.max(0,Number(user.leaveBalance)-Number(user.usedLeave));
        if(dc>avail){toast(`Insufficient balance: ${dc}d requested, ${avail.toFixed(1)}d available.`);return;}
      }
    }
    if(!isTempAuth&&!isDoc){
      // Check if any covered month's timesheet is already submitted/approved
      const s0=new Date(form.start), s1=new Date(endDate);
      const d0=new Date(s0.getFullYear(),s0.getMonth(),1);
      const d1=new Date(s1.getFullYear(),s1.getMonth(),1);
      for(let d=new Date(d0);d<=d1;d.setMonth(d.getMonth()+1)){
        const mk=tsKey(user.id,d.getFullYear(),d.getMonth());
        const mst=tsStatuses[mk]?.status;
        if(mst==="submitted"||mst==="approved"){
          const mn=d.toLocaleString("default",{month:"long"});
          toast(`Your timesheet for ${mn} ${d.getFullYear()} is already ${mst}. You cannot submit a request for this period.`);
          return;
        }
      }
      const myActive=myR.filter(r=>r.status==="Pending"||r.status==="Approved");
      const overlap=myActive.filter(r=>datesOverlap(form.start,endDate,r.start,r.end));
      if(overlap.length>0){toast(`Period overlaps with your existing ${overlap[0].status} request (${overlap[0].start} → ${overlap[0].end}). Please cancel it first.`);return;}
      // Block teammate overlaps unless user has allowOverlap permission
      if(formConflicts.length>0&&!user.allowOverlap){
        toast(`Request overlaps with ${formConflicts.map(r=>nm(r.userId)).join(", ")}'s leave. Contact your manager to resolve.`);
        return;
      }
    }
    try{
      const startDate=isDoc?(form.start||new Date().toISOString().split("T")[0]):form.start;
      const created=await requestsAPI.create({userId:user.id,type:form.type,start:startDate,end:isDoc?startDate:endDate,comment:form.comment,daysCount:dc,durationHours,halfDayStart:isDoc?null:(form.halfDayStart||null),halfDayEnd:isDoc?null:(form.halfDayEnd||null),balanceSource:isDoc?"annual":(form.balanceSource||"annual"),authStartTime:isTempAuth?(form.authStartTime||null):null,authEndTime:isTempAuth?(form.authEndTime||null):null,attachmentUrl:attachUrl||null});
      // Issue 2: update balance in UI state immediately (deducted on submission)
      if((created.daysDeducted||0)>0&&setUsers) setUsers(p=>p.map(u=>u.id===user.id?{...u,leaveBalance:u.leaveBalance-created.daysDeducted,usedLeave:u.usedLeave+created.daysDeducted}:u));
      if((created.recoveryDeducted||0)>0&&setUsers) setUsers(p=>p.map(u=>u.id===user.id?{...u,recoveryBalance:u.recoveryBalance-created.recoveryDeducted}:u));
      setRequests(p=>[...p,{id:created.id,userId:created.user_id,type:created.type,start:created.start_date?.slice(0,10),end:created.end_date?.slice(0,10),daysCount:Number(created.days_count),durationHours:created.duration_hours?Number(created.duration_hours):null,halfDayStart:created.half_day_start||"",halfDayEnd:created.half_day_end||"",balanceSource:created.balance_source||"annual",authStartTime:created.auth_start_time||null,authEndTime:created.auth_end_time||null,status:created.status,comment:created.comment,attachmentUrl:created.attachment_url||null}]);
      // Enable future months covered by this request in timesheet
      if(!isDoc&&setTsStatuses){
        const rs=new Date(startDate),re=new Date(isDoc?startDate:endDate);
        for(let d=new Date(rs.getFullYear(),rs.getMonth(),1);d<=re;d.setMonth(d.getMonth()+1)){
          const mk=tsKey(user.id,d.getFullYear(),d.getMonth());
          if(!tsStatuses[mk]) setTsStatuses(prev=>({...prev,[mk]:{status:"draft",submittedAt:null,reviewComment:"",reviewedBy:null,reviewedAt:null}}));
        }
      }
      setShow(false);setForm({type:"",start:"",end:"",comment:"",halfDayStart:"",halfDayEnd:"",durationHours:1,balanceSource:"annual",authStartTime:"08:00",authEndTime:"10:00"});setAttachFile(null);setAttachUrl("");
    }catch(err){toast('Failed to submit request: '+err.message);}
  }
  async function doCancelRequest(id,isApproved,reason){
    try{
      if(isApproved){
        const result=await requestsAPI.cancel(id,reason||"");
        setRequests(p=>p.filter(r=>r.id!==id));
        if(result.daysRestored>0&&setUsers)
          setUsers(prev=>prev.map(u=>u.id===user.id?{...u,leaveBalance:(u.leaveBalance||0)+result.daysRestored,usedLeave:Math.max(0,(u.usedLeave||0)-result.daysRestored)}:u));
        if(result.recoveryRestored>0&&setUsers)
          setUsers(prev=>prev.map(u=>u.id===user.id?{...u,recoveryBalance:(u.recoveryBalance||0)+result.recoveryRestored}:u));
      }else{
        // Issue 2: restore balance for pending cancel
        const result=await requestsAPI.delete(id);
        setRequests(p=>p.filter(r=>r.id!==id));
        if((result?.daysRestored||0)>0&&setUsers)
          setUsers(prev=>prev.map(u=>u.id===user.id?{...u,leaveBalance:(u.leaveBalance||0)+result.daysRestored,usedLeave:Math.max(0,(u.usedLeave||0)-result.daysRestored)}:u));
        if((result?.recoveryRestored||0)>0&&setUsers)
          setUsers(prev=>prev.map(u=>u.id===user.id?{...u,recoveryBalance:(u.recoveryBalance||0)+result.recoveryRestored}:u));
      }
      setCancelModal(null);setCancelReason("");
    }catch(err){toast('Failed to cancel request: '+err.message);}
  }

  const nm=id=>users.find(u=>u.id===id)?.name||"Unknown";

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div className="tabs" style={{margin:0}}>
          <div className={`tab ${tab==="mine"?"active":""}`} onClick={()=>setTab("mine")}>📋 My Requests <span style={{fontSize:11,opacity:.7}}>{myR.filter(r=>r.status==="Pending"||r.status==="Pending L2").length>0?`(${myR.filter(r=>r.status==="Pending"||r.status==="Pending L2").length} pending)`:""}</span></div>
          {teamIds.length>0&&<div className={`tab ${tab==="team"?"active":""}`} onClick={()=>setTab("team")} style={{display:"flex",alignItems:"center",gap:5}}>👥 Team {conflictIds.size>0&&<span className="nbadge" style={{background:"var(--am)"}}>⚠</span>}</div>}
        </div>
        <button className="btn bp bsm" onClick={()=>setShow(true)}>+ New Request</button>
      </div>

      {/* ── My Requests tab ── */}
      {tab==="mine"&&(()=>{
        const filtered=myR.filter(r=>{
          if(mineFilter==="all")return true;
          if(mineFilter==="pending")return r.status==="Pending"||r.status==="Pending L2";
          return r.status===mineFilter;
        }).sort((a,b)=>(b.start||"").localeCompare(a.start||""));
        return(
        <div>
          <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
            {[["pending","⏳ Pending",myR.filter(r=>r.status==="Pending"||r.status==="Pending L2").length],["Approved","✅ Approved",myR.filter(r=>r.status==="Approved").length],["Rejected","❌ Rejected",myR.filter(r=>r.status==="Rejected").length],["Cancelled","🚫 Cancelled",myR.filter(r=>r.status==="Cancelled").length],["all","All",myR.length]].map(([v,l,cnt])=>(
              <button key={v} onClick={()=>setMineFilter(v)} style={{padding:"4px 12px",borderRadius:20,border:`1px solid ${mineFilter===v?"var(--v)":"var(--b)"}`,background:mineFilter===v?"var(--v)":"var(--s2)",color:mineFilter===v?"#fff":"var(--t2)",fontSize:12,cursor:"pointer",fontWeight:mineFilter===v?600:400}}>
                {l}{cnt>0?` (${cnt})`:""}</button>
            ))}
          </div>
          {filtered.length===0&&<div className="empty"><div className="empty-ico">📋</div>{myR.length===0?"No requests yet":"No requests match this filter"}</div>}
          {filtered.map(r=>(
            <div className="rc" key={r.id} style={{cursor:"pointer"}} onClick={(e)=>{if(e.target.tagName!=="BUTTON")openDetail(r);}}>
              <div className="ri" style={{background:r.type==="Annual Leave"?"#d1fae5":r.type==="Sick Leave"?"#fee2e2":"#f0f9ff"}}>{icos[r.type]||"📋"}</div>
              <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{r.type}{r.balanceSource==="recovery"&&<span style={{marginLeft:5,fontSize:10,color:"var(--v)",fontWeight:400}}>🔄 Recovery</span>}</div><div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{r.type==="Temporary Authorization"?`${r.start} · ${r.authStartTime||""}→${r.authEndTime||""} (${r.durationHours}h)`:`${r.start}${r.halfDayStart?" "+r.halfDayStart:""}${r.end!==r.start?" → "+r.end+(r.halfDayEnd?" "+r.halfDayEnd:""):""} · ${r.daysCount===0.5?"½ day":r.daysCount+"d"}`}{r.comment?" · "+r.comment:""}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
                <StatusBadge status={r.status}/>
                {r.totalSteps>1&&<span style={{fontSize:10,color:r.status==="Pending L2"?"#7c3aed":"var(--t3)",fontWeight:600}}>Step {r.approvalStep}/{r.totalSteps}</span>}
                <button className="btn bo bxs" onClick={(e)=>{e.stopPropagation();openDetail(r);}}>Details</button>
                {(r.status==="Pending"||r.status==="Pending L2")&&<button className="btn bo bxs" onClick={(e)=>{e.stopPropagation();doCancelRequest(r.id,false,"");}}>Cancel</button>}
                {r.status==="Approved"&&<button className="btn bd bxs" onClick={(e)=>{e.stopPropagation();setCancelModal({id:r.id,type:r.type,start:r.start,end:r.end,daysCount:r.daysCount,durationHours:r.durationHours});setCancelReason("");}}>Cancel</button>}
              </div>
            </div>
          ))}
        </div>
        );
      })()}

      {/* ── History tab (removed — merged into My Requests filter) ── */}
      {false&&tab==="history"&&(
        <div>
          {/* Status filter pills */}
          <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
            {[["all","All",histR.length],["Approved","✅ Approved",histR.filter(r=>r.status==="Approved").length],["Rejected","❌ Rejected",histR.filter(r=>r.status==="Rejected").length],["Cancelled","🚫 Cancelled",histR.filter(r=>r.status==="Cancelled").length]].map(([v,l,cnt])=>(
              <button key={v} onClick={()=>setHistFilter(v)} style={{padding:"4px 12px",borderRadius:20,border:`1px solid ${histFilter===v?"var(--v)":"var(--b)"}`,background:histFilter===v?"var(--v)":"var(--s2)",color:histFilter===v?"#fff":"var(--t2)",fontSize:12,cursor:"pointer",fontWeight:histFilter===v?600:400}}>
                {l}{cnt>0?` (${cnt})`:""}</button>
            ))}
          </div>
          {filtHistR.length===0&&<div className="empty"><div className="empty-ico">📜</div>{histR.length===0?"No completed requests yet":"No requests match this filter"}</div>}
          {(()=>{
            const years=[...new Set(filtHistR.map(r=>r.start?.slice(0,4)||""))].filter(Boolean).sort((a,b)=>b.localeCompare(a));
            return years.map(yr=>(
              <div key={yr}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--t3)",textTransform:"uppercase",letterSpacing:1,marginBottom:6,marginTop:10,paddingBottom:4,borderBottom:"1px solid var(--b)"}}>{yr}</div>
                {filtHistR.filter(r=>(r.start||"").startsWith(yr)).map(r=>(
                  <div className="rc" key={r.id} style={{opacity:r.status==="Rejected"||r.status==="Cancelled"?0.72:1,cursor:"pointer"}} onClick={(e)=>{if(e.target.tagName!=="BUTTON"&&e.target.tagName!=="SPAN")openDetail(r);}}>
                    <div className="ri" style={{background:r.type==="Annual Leave"?"#d1fae5":r.type==="Sick Leave"?"#fee2e2":"#f0f9ff"}}>{icos[r.type]||"📋"}</div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13}}>{r.type}{r.balanceSource==="recovery"&&<span style={{marginLeft:5,fontSize:10,color:"var(--v)",fontWeight:400}}>🔄 Recovery</span>}</div>
                      <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{r.type==="Temporary Authorization"?`${r.start} · ${r.authStartTime||""}→${r.authEndTime||""} (${r.durationHours}h)`:`${r.start}${r.halfDayStart?" "+r.halfDayStart:""}${r.end!==r.start?" → "+r.end+(r.halfDayEnd?" "+r.halfDayEnd:""):""} · ${r.daysCount===0.5?"½ day":r.daysCount+"d"}`}{r.comment?<span style={{color:"var(--t3)"}}> · {r.comment}</span>:""}</div>
                      {r.attachmentUrl&&<div style={{marginTop:3}}><span style={{fontSize:11,color:"var(--v)",cursor:"pointer"}} onClick={async(e)=>{e.stopPropagation();try{const d=await uploadsAPI.getDownloadUrl(r.attachmentUrl);window.open(d.url,"_blank");}catch{toast("Could not load attachment.");}}}>📎 View attachment</span></div>}
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <StatusBadge status={r.status}/>
                      <button className="btn bo bxs" onClick={(e)=>{e.stopPropagation();openDetail(r);}}>Details</button>
                    </div>
                  </div>
                ))}
              </div>
            ));
          })()}
        </div>
      )}

      {/* ── Team tab ── */}
      {tab==="team"&&teamIds.length>0&&(
        <div>
          {conflictIds.size>0&&(
            <div style={{marginBottom:12,padding:"10px 14px",background:"#fef3c7",border:"1px solid #f59e0b",borderRadius:"var(--r)",display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:18}}>⚠️</span>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:"#92400e"}}>Availability conflict detected</div>
                <div style={{fontSize:12,color:"#78350f",marginTop:1}}>{conflictIds.size} requests overlap with other team members — review before approving</div>
              </div>
            </div>
          )}
          <div style={{fontSize:12,color:"var(--t3)",marginBottom:10}}>{teamR.filter(r=>r.status==="Pending").length} pending · {teamR.filter(r=>r.status==="Approved").length} approved · {teamIds.length} team members</div>
          {teamR.length===0&&<div className="empty"><div className="empty-ico">👥</div>No team requests yet</div>}
          {teamR.sort((a,b)=>a.start.localeCompare(b.start)).map(r=>(
            <div className="rc" key={r.id} style={conflictIds.has(r.id)?{border:"1.5px solid #f59e0b",background:"#fffbeb"}:{}}>
              <div className="ri" style={{background:r.type==="Annual Leave"?"#d1fae5":r.type==="Sick Leave"?"#fee2e2":"#f0f9ff"}}>{icos[r.type]||"📋"}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--v)",marginBottom:2}}>{nm(r.userId)}</div>
                <div style={{fontWeight:700,fontSize:13}}>{r.type}</div>
                <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{r.type==="Temporary Authorization"?`${r.start} · ${r.authStartTime||""}→${r.authEndTime||""} (${r.durationHours}h)`:`${r.start}${r.halfDayStart?" "+r.halfDayStart:""}${r.end!==r.start?" → "+r.end+(r.halfDayEnd?" "+r.halfDayEnd:""):""} · ${r.daysCount===0.5?"½ day":r.daysCount+"d"}`}{r.comment?" · "+r.comment:""}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                {conflictIds.has(r.id)&&<span style={{fontSize:10,fontWeight:700,color:"#92400e",background:"#fde68a",borderRadius:4,padding:"2px 6px"}}>⚠ Overlap</span>}
                <StatusBadge status={r.status}/>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── New Request modal ── */}
      {show&&(()=>{
        const canSubmit=form.type&&(isAdminDoc||form.start)&&(isAdminDoc||form.type==="Temporary Authorization"||(form.end&&form.end>=form.start))&&(user.allowOverlap||formConflicts.length===0);
        const dateErr=form.start&&form.end&&form.end<form.start;
        return(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setShow(false)}>
          <div className="md"><div className="md-title">New Request</div>
            <div className="fg">

              {/* ── Type picker: icon pill grid ── */}
              <div className="fgrp ff">
                <label className="flbl">Leave & Absence <span style={{color:"var(--re)"}}>*</span></label>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))",gap:6,marginTop:4}}>
                  {leaveTypes.map(t=>(
                    <button key={t} type="button"
                      onClick={()=>setForm(f=>({...f,type:t,halfDayStart:HALF_DAY_TYPES.includes(t)?f.halfDayStart:"",halfDayEnd:HALF_DAY_TYPES.includes(t)?f.halfDayEnd:""}))}
                      style={{padding:"8px 10px",borderRadius:"var(--rs)",border:`1.5px solid ${form.type===t?"var(--v)":"var(--b)"}`,background:form.type===t?"var(--vl)":"var(--surface)",cursor:"pointer",display:"flex",alignItems:"center",gap:7,fontSize:12,fontWeight:form.type===t?700:400,color:form.type===t?"var(--v)":"var(--t2)",textAlign:"left",transition:"all .15s"}}>
                      <span style={{fontSize:15}}>{icos[t]||"📋"}</span>{t}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Balance banner ── */}
              {["Annual Leave","Sick Leave","Compassionate","Recovery Leave"].includes(form.type)&&(
                <div style={{display:"flex",gap:10,padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12,flexWrap:"wrap",alignItems:"center",marginBottom:2}}>
                  <span>📅 Annual: <b style={{color:"var(--gr)"}}>{annualRem}d</b></span>
                  {(user.recoveryBalance||0)>0&&<span>🔄 Recovery: <b style={{color:"var(--v)"}}>{Number(user.recoveryBalance||0)}d</b></span>}
                  {liveDc>0&&<span style={{marginLeft:"auto",fontWeight:700,fontSize:11,color:liveDc>availForType?"var(--re)":"var(--gr)"}}>After: {Math.max(0,availForType-liveDc).toFixed(1)}d left</span>}
                </div>
              )}

              {/* ── Administrative Document fields ── */}
              {isAdminDoc&&(
                <div style={{padding:"12px 16px",background:"var(--vl)",border:"1px solid var(--v)",borderRadius:"var(--r)",fontSize:13}}>
                  <div style={{fontWeight:700,color:"var(--v)",marginBottom:4}}>{icos[form.type]||"📄"} {form.type}</div>
                  {form.type==="Work Certificate"&&<p style={{color:"var(--t2)",margin:0}}>A certificate confirming your current employment status and position at the company.</p>}
                  {form.type==="Salary Certificate"&&<p style={{color:"var(--t2)",margin:0}}>A certificate detailing your current salary, issued for bank or visa purposes.</p>}
                  {form.type==="Salary Advance"&&<p style={{color:"var(--t2)",margin:0}}>Request an advance on your upcoming salary. Specify the amount and reason in the comment.</p>}
                  {form.type==="Employment Letter"&&<p style={{color:"var(--t2)",margin:0}}>A formal letter confirming your employment details for official purposes.</p>}
                  {form.type==="Experience Letter"&&<p style={{color:"var(--t2)",margin:0}}>A letter detailing your role, responsibilities, and duration of employment.</p>}
                  {form.type==="Other Document"&&<p style={{color:"var(--t2)",margin:0}}>Request any other administrative document. Please describe in the comment field.</p>}
                  <p style={{fontSize:11,color:"var(--t3)",marginTop:6,marginBottom:0}}>No leave balance deduction. Requires HR approval.</p>
                </div>
              )}

              {/* ── Temporary Authorization fields ── */}
              {form.type==="Temporary Authorization"&&(
                <>
                  <div className="fgrp"><label className="flbl">Date <span style={{color:"var(--re)"}}>*</span></label><input type="date" className="fi" value={form.start} onChange={e=>setForm(f=>({...f,start:e.target.value}))}/></div>
                  <div style={{display:"flex",gap:8}}>
                    <div className="fgrp" style={{flex:1}}><label className="flbl">From</label><input type="time" className="fi" value={form.authStartTime} onChange={e=>setForm(f=>({...f,authStartTime:e.target.value}))}/></div>
                    <div className="fgrp" style={{flex:1}}><label className="flbl">To (max +2h)</label><input type="time" className="fi" value={form.authEndTime} onChange={e=>setForm(f=>({...f,authEndTime:e.target.value}))}/></div>
                  </div>
                  {form.authStartTime&&form.authEndTime&&(()=>{const[sh,sm]=form.authStartTime.split(":").map(Number);const[eh,em]=form.authEndTime.split(":").map(Number);const diff=(eh*60+em-(sh*60+sm))/60;return diff>0&&diff<=2?<p className="fnote" style={{color:"var(--gr)"}}>✓ Duration: {diff===Math.floor(diff)?diff+"h":(Math.floor(diff)>0?Math.floor(diff)+"h ":"")+((diff%1)*60)+"min"}</p>:diff>2?<p className="fnote" style={{color:"var(--re)"}}>⚠ Duration {diff.toFixed(2)}h exceeds 2h maximum</p>:diff<=0?<p className="fnote" style={{color:"var(--re)"}}>⚠ End time must be after start time</p>:null;})()}
                  <p className="fnote">⏱ Short absence ≤ 2h. Requires line manager approval. Does not deduct leave balance.</p>
                </>
              )}

              {/* ── Regular leave date fields (2-column) ── */}
              {form.type&&form.type!=="Temporary Authorization"&&!isAdminDoc&&(
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    <div className="fgrp" style={{marginBottom:4}}>
                      <label className="flbl">Start Date <span style={{color:"var(--re)"}}>*</span></label>
                      <input type="date" className="fi" value={form.start}
                        onChange={e=>{const v=e.target.value;setForm(f=>({...f,start:v,end:(f.end&&f.end<v)?v:f.end}));}}/>
                      {showHalfDay&&(
                        <select className="isel" style={{width:"100%",marginTop:5}} value={form.halfDayStart} onChange={e=>setForm(f=>({...f,halfDayStart:e.target.value}))}>
                          <option value="">Full day</option><option value="AM">Half — AM</option><option value="PM">Half — PM</option>
                        </select>
                      )}
                    </div>
                    <div className="fgrp" style={{marginBottom:4}}>
                      <label className="flbl">End Date <span style={{color:"var(--re)"}}>*</span></label>
                      <input type="date" className="fi" value={form.end}
                        min={form.start||undefined}
                        style={{borderColor:dateErr?"var(--re)":""}}
                        onChange={e=>setForm(f=>({...f,end:e.target.value}))}/>
                      {dateErr
                        ?<span style={{fontSize:10,color:"var(--re)",marginTop:2,display:"block"}}>⚠ End must be ≥ start date</span>
                        :(showHalfDay&&!isSingleDay&&(
                          <select className="isel" style={{width:"100%",marginTop:5}} value={form.halfDayEnd} onChange={e=>setForm(f=>({...f,halfDayEnd:e.target.value}))}>
                            <option value="">Full day</option><option value="AM">Half — AM</option><option value="PM">Half — PM</option>
                          </select>
                        ))
                      }
                    </div>
                  </div>
                  {liveDc!==null&&(
                    <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 12px",background:"var(--vl)",border:"1px solid var(--v)",borderRadius:20,fontSize:12,color:"var(--v)",fontWeight:700,marginBottom:6}}>
                      📅 {liveDc===0.5?"½ day":`${liveDc} day${liveDc!==1?"s":""}`}
                    </div>
                  )}
                </>
              )}

              {/* ── Balance source selector ── */}
              {["Annual Leave","Sick Leave","Compassionate"].includes(form.type)&&(user.recoveryBalance>0)&&(
                <div className="fgrp"><label className="flbl">Deduct from</label>
                  <select className="fsel" value={form.balanceSource} onChange={e=>setForm(f=>({...f,balanceSource:e.target.value}))}>
                    <option value="annual">Annual Leave ({annualRem}d remaining)</option>
                    <option value="recovery">Recovery Balance ({Number(user.recoveryBalance)}d remaining)</option>
                  </select>
                </div>
              )}

              {/* ── Comment ── */}
              <div className="fgrp ff"><label className="flbl">Comment</label><textarea className="fta" value={form.comment} onChange={e=>setForm(f=>({...f,comment:e.target.value}))}/></div>

              {/* ── Type-specific notes ── */}
              {form.type==="Annual Leave"&&<p className="fnote">⚠ Must be submitted ≥15 days before. Max 7 days for field staff.</p>}
              {form.type==="Recovery Leave"&&<p className="fnote">🔄 Deducts from your Recovery Balance — {Number(user.recoveryBalance||0)}d remaining.</p>}
              {form.type==="Sick Leave"&&<p className="fnote">🏥 Deducts from your {form.balanceSource==="recovery"?"Recovery":"Annual Leave"} Balance.</p>}
              {(form.type==="Sick Leave"||form.type==="Salary Advance")&&(
                <div className="fgrp ff">
                  <label className="flbl">{form.type==="Sick Leave"?"Medical Certificate":"Supporting Document"} {form.type==="Sick Leave"&&<span style={{color:"var(--re)"}}>*</span>}</label>
                  {!attachFile ? (
                    <label style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"14px 16px",borderRadius:"var(--r)",border:"2px dashed var(--b2)",background:"var(--s2)",cursor:"pointer",fontSize:13,color:"var(--t2)",transition:"all .15s"}}>
                      <span style={{fontSize:20}}>📎</span>
                      <span>{form.type==="Sick Leave"?"Click to attach medical certificate":"Attach supporting document (optional)"} (PDF, JPG, PNG — max 10 MB)</span>
                      <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={handleAttach} style={{display:"none"}}/>
                    </label>
                  ) : (
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:"var(--r)",border:"1px solid var(--gr)",background:"var(--grl)"}}>
                      <span style={{fontSize:18}}>{attachUploading?"⏳":"✅"}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{attachFile.name}</div>
                        <div style={{fontSize:11,color:"var(--t3)"}}>{(attachFile.size/1024).toFixed(0)} KB{attachUploading?" — uploading...":""}</div>
                      </div>
                      {!attachUploading&&<button type="button" onClick={()=>{setAttachFile(null);setAttachUrl("");}} style={{border:"none",background:"none",color:"var(--re)",cursor:"pointer",fontSize:16,padding:"2px 6px"}}>✕</button>}
                    </div>
                  )}
                </div>
              )}
              {form.type==="Compassionate"&&<p className="fnote">💙 Deducts from your {form.balanceSource==="recovery"?"Recovery":"Annual Leave"} Balance.</p>}

              {/* ── Teammate conflict warning ── */}
              {formConflicts.length>0&&(
                <div style={{padding:"8px 12px",background:user.allowOverlap?"#fef3c7":"var(--rel)",border:`1px solid ${user.allowOverlap?"#f59e0b":"var(--re)"}`,borderRadius:"var(--rs)",fontSize:12,color:user.allowOverlap?"#78350f":"#991b1b"}}>
                  {user.allowOverlap?"⚠️":"🚫"} {formConflicts.length} teammate{formConflicts.length>1?"s have":"has"} overlapping leave: {formConflicts.map(r=>nm(r.userId)).join(", ")}
                  {!user.allowOverlap&&<div style={{marginTop:3,fontWeight:600,fontSize:11}}>Submission blocked — contact your manager to resolve the conflict.</div>}
                </div>
              )}
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setShow(false)}>Cancel</button>
              <button className="btn bp" onClick={submit} disabled={!canSubmit} style={{opacity:canSubmit?1:.5,cursor:canSubmit?"pointer":"not-allowed"}}>Submit</button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* ── Cancel Approved Request modal ── */}
      {cancelModal&&(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setCancelModal(null)}>
          <div className="md">
            <div className="md-title">Cancel Approved Request</div>
            <div style={{padding:"10px 14px",background:"var(--rel)",borderRadius:"var(--rs)",marginBottom:14,fontSize:12,color:"#991b1b"}}>
              <strong>{cancelModal.type}</strong> · {cancelModal.type==="Temporary Authorization"?`${cancelModal.start} · ${cancelModal.durationHours}h`:`${cancelModal.start} → ${cancelModal.end} · ${cancelModal.daysCount===0.5?"½ day":cancelModal.daysCount+"d"}`}<br/>
              <span style={{opacity:.8}}>{cancelModal.type==="Temporary Authorization"?"This authorization will be removed.":`This will restore ${cancelModal.daysCount} day${cancelModal.daysCount!==1?"s":""} to your leave balance.`}</span>
            </div>
            <div className="fgrp">
              <label className="flbl">Reason for cancellation <span style={{color:"var(--re)"}}>*</span></label>
              <textarea className="fta" style={{minHeight:80}} placeholder="e.g. Plans changed, no longer needed." value={cancelReason} onChange={e=>setCancelReason(e.target.value)}/>
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setCancelModal(null)}>Keep Request</button>
              <button className="btn bd" disabled={!cancelReason.trim()} style={{opacity:cancelReason.trim()?1:.5}} onClick={()=>doCancelRequest(cancelModal.id,true,cancelReason)}>Confirm Cancellation</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Request Detail Modal with audit trail ── */}
      {detailModal&&(()=>{
        const r=detailModal;
        const actionLabels={request_created:"Created",request_approved:"Approved",request_approved_l1:"Approved (L1)",request_rejected:"Rejected",request_cancelled:"Cancelled",request_pending:"Pending"};
        const actionIcos={request_created:"📝",request_approved:"✅",request_approved_l1:"✔️",request_rejected:"❌",request_cancelled:"🚫",request_pending:"⏳"};
        const actionColors={request_created:"var(--v)",request_approved:"var(--gr)",request_approved_l1:"var(--v)",request_rejected:"var(--re)",request_cancelled:"var(--t3)"};
        return(
        <div className="mo" onClick={e=>e.target.className==="mo"&&setDetailModal(null)}>
          <div className="md" style={{maxWidth:620,width:"95vw",maxHeight:"90vh",overflowY:"auto"}}>
            <div className="md-title" style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span>Request #{r.id} Details</span>
              <StatusBadge status={r.status}/>
            </div>
            <div className="fg">
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>
                <div><span style={{color:"var(--t3)"}}>Employee:</span> <b>{nm(r.userId)}</b></div>
                <div><span style={{color:"var(--t3)"}}>Type:</span> <b>{r.type}</b></div>
                <div><span style={{color:"var(--t3)"}}>Start:</span> <b>{r.start}{r.halfDayStart?` (${r.halfDayStart})`:""}</b></div>
                <div><span style={{color:"var(--t3)"}}>End:</span> <b>{r.end}{r.halfDayEnd?` (${r.halfDayEnd})`:""}</b></div>
                {r.type==="Temporary Authorization"?<>
                  <div><span style={{color:"var(--t3)"}}>Time:</span> <b>{r.authStartTime||""} → {r.authEndTime||""}</b></div>
                  <div><span style={{color:"var(--t3)"}}>Duration:</span> <b>{r.durationHours}h</b></div>
                </>:<>
                  <div><span style={{color:"var(--t3)"}}>Days:</span> <b>{r.daysCount===0.5?"½ day":r.daysCount+"d"}</b></div>
                  <div><span style={{color:"var(--t3)"}}>Balance:</span> <b>{r.balanceSource==="recovery"?"🔄 Recovery":"Annual"}</b></div>
                </>}
                {r.totalSteps>1&&<div><span style={{color:"var(--t3)"}}>Step:</span> <b>{r.approvalStep}/{r.totalSteps}</b></div>}
                {r.createdAt&&<div><span style={{color:"var(--t3)"}}>Submitted:</span> <b>{r.createdAt}</b></div>}
              </div>
              {r.comment&&(
                <div style={{marginTop:10,padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>
                  <span style={{color:"var(--t3)"}}>Comment:</span> {r.comment}
                </div>
              )}
              {r.attachmentUrl&&(
                <div style={{marginTop:8}}>
                  <button className="btn bo bsm" onClick={async()=>{try{const d=await uploadsAPI.getDownloadUrl(r.attachmentUrl);window.open(d.url,"_blank");}catch{toast("Could not load attachment.");}}}>📎 View Attachment</button>
                </div>
              )}

              <div style={{marginTop:14,borderTop:"1px solid var(--b)",paddingTop:12}}>
                <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Change History</div>
                {detailLoading&&<div style={{fontSize:12,color:"var(--t3)"}}>Loading…</div>}
                {!detailLoading&&detailHistory.length===0&&<div style={{fontSize:12,color:"var(--t3)",fontStyle:"italic"}}>No history entries yet.</div>}
                {!detailLoading&&detailHistory.map((h,i)=>(
                  <div key={h.id} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:i<detailHistory.length-1?"1px solid var(--b)":"none"}}>
                    <div style={{fontSize:18,flexShrink:0,width:24,textAlign:"center"}}>{actionIcos[h.action]||"•"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,color:actionColors[h.action]||"var(--t)"}}>
                        {actionLabels[h.action]||h.action} <span style={{fontWeight:400,color:"var(--t3)"}}>by {h.actor_name||"System"}</span>
                      </div>
                      <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{new Date(h.created_at).toLocaleString()}</div>
                      <div style={{fontSize:12,color:"var(--t2)",marginTop:3}}>{(h.detail||"").replace(/^Request #\d+:\s*/,"")}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={()=>setDetailModal(null)}>Close</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({user,requests,projects,roles,tsStatuses,rotations=[],users=[],setView}) {
  const myR=requests.filter(r=>r.userId===user.id);
  const alRem=Number(user.leaveBalance)-Number(user.usedLeave);
  const recRem=Number(user.recoveryBalance||0);
  const today=new Date().toISOString().split("T")[0];
  const dayType=user.type==="field"?getFieldDayType(user.id,today,rotations):"Office";
  const myProj=projects.filter(p=>p.open&&(user.type==="field"?p.fieldAllowed:p.officeAllowed));
  const icos={"Annual Leave":"🌴","Sick Leave":"🏥","Mission":"✈️","Training":"📚","Remote Work":"🏠","Night Shift":"🌙","Extra Days":"💼"};
  // Current month TS status
  const now=new Date(); const curKey=tsKey(user.id,now.getFullYear(),now.getMonth());
  const curTsStatus=tsStatuses[curKey]?.status||"draft";
  const tsColors={draft:"var(--t3)",submitted:"var(--am)",approved:"var(--gr)",rejected:"var(--re)"};
  // ERP Duty Rota summary — always load to detect if current user is on duty
  const hasErp = hasPerm(roles,user.role,"all") || hasPerm(roles,user.role,"erp_rota");
  const [erpDashData, setErpDashData] = useState({roster:[],weeks:[]});
  useEffect(() => {
    Promise.all([erpRosterAPI.getAll().catch(()=>[]), erpWeeksAPI.getAll().catch(()=>[])])
      .then(([r,w]) => setErpDashData({roster:r, weeks:w.map(wk=>({id:wk.id,label:wk.label,start:wk.start_date?.slice(0,10)||wk.start,end:wk.end_date?.slice(0,10)||wk.end,crisisCoord:wk.crisis_coord,drillingCrisisCoord:wk.drilling_crisis_coord,cpfContact:wk.cpf_contact,drillingContact:wk.drilling_contact,media:wk.media}))}));
  }, []);
  const erpActiveWeek = erpDashData.weeks.find(w => w.start <= today && w.end >= today) || erpDashData.weeks[0];
  const erpMemberCount = erpDashData.roster.length;
  const dtf = daysUntilFriday();
  // Check if current user is assigned to a duty slot in the active week
  const myErpSlots = erpActiveWeek ? ERP_DUTY_SLOTS.filter(slot => Number(erpActiveWeek[slot.key]) === user.id) : [];
  const isOnErpRoster = erpDashData.roster.some(r => r.user_id === user.id);
  return (
    <div>
      {/* ERP Duty Alert — shown when current user is assigned to active rotation */}
      {myErpSlots.length > 0 && erpActiveWeek && (
        <div style={{marginBottom:14,padding:"14px 18px",borderRadius:"var(--r)",background:"linear-gradient(135deg,#eff6fc,#deecf9)",border:"2px solid var(--v)",display:"flex",alignItems:"center",gap:14}}>
          <div style={{fontSize:32,flexShrink:0}}>🛡️</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:15,color:"var(--v)"}}>You are on ERP Duty</div>
            <div style={{fontSize:13,color:"var(--t2)",marginTop:2}}>
              {myErpSlots.map(s => s.label).join(", ")} — {erpActiveWeek.label} ({erpActiveWeek.start} → {erpActiveWeek.end})
            </div>
            <div style={{fontSize:12,color:"var(--t3)",marginTop:4,fontFamily:"'JetBrains Mono',monospace"}}>
              Emergency Line: 29 324 484 · {dtf} day{dtf!==1?"s":""} to handover
            </div>
          </div>
          {setView && <button className="btn bp" style={{flexShrink:0}} onClick={()=>setView("erp_rota")}>View Rota</button>}
        </div>
      )}
      {/* ERP Roster member but not on duty this week */}
      {myErpSlots.length === 0 && isOnErpRoster && erpActiveWeek && (
        <div style={{marginBottom:14,padding:"10px 16px",borderRadius:"var(--r)",background:"var(--vl)",border:"1px solid var(--b)",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>🔄</span>
          <div style={{flex:1,fontSize:13,color:"var(--t2)"}}>
            You are part of the <strong>ERP Duty Roster</strong>. You are not assigned this rotation ({erpActiveWeek.label}).
          </div>
        </div>
      )}
      <div className="sg">
        <div className="sc"><div className="sa" style={{background:"#7c3aed"}}/><div className="sl">Today</div><div className="sv" style={{color:"var(--v)"}}>{dayType}</div><div className="sc2 neu">{new Date().toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short"})}</div></div>
        <div className="sc" style={{padding:0,overflow:"hidden"}}>
          <div style={{display:"flex",height:"100%"}}>
            <div style={{flex:1,padding:"15px 14px",borderRight:recRem>0?"1px solid var(--b)":"none"}}>
              <div className="sa" style={{background:"#10b981"}}/>
              <div className="sl">Annual Leave</div>
              <div className="sv" style={{color:"var(--gr)"}}>{alRem}</div>
              <div className="sc2 neu">of {user.leaveBalance} days</div>
            </div>
            {recRem>0&&(
              <div style={{flex:1,padding:"15px 14px",background:"var(--vl)"}}>
                <div className="sa" style={{background:"#7c3aed"}}/>
                <div className="sl" style={{color:"var(--v)"}}>🔄 Recovery</div>
                <div className="sv" style={{color:"var(--v)"}}>{recRem}</div>
                <div className="sc2" style={{color:"var(--v)",opacity:.7}}>days accrued</div>
              </div>
            )}
          </div>
        </div>
        <div className="sc"><div className="sa" style={{background:"#f59e0b"}}/><div className="sl">My Requests</div><div className="sv" style={{color:"var(--am)"}}>{myR.length}</div><div className="sc2 neu">{myR.filter(r=>r.status==="Pending").length} pending</div></div>
        <div className="sc"><div className="sa" style={{background:"#0ea5e9"}}/><div className="sl">Timesheet ({MONTHS[now.getMonth()]})</div><div className="sv" style={{color:tsColors[curTsStatus],fontSize:18,paddingTop:4}}>{curTsStatus.charAt(0).toUpperCase()+curTsStatus.slice(1)}</div></div>
      </div>
      <div className="g2">
        <div className="card">
          <div className="card-hd"><div><div className="card-title">Recent Requests</div></div><span className="badge bgr2">{myR.length}</span></div>
          {myR.length===0&&<div className="empty"><div className="empty-ico">📋</div>No requests yet</div>}
          {myR.slice(0,4).map(r=>(<div className="rc" key={r.id}><div className="ri" style={{background:"#f0f9ff"}}>{icos[r.type]||"📋"}</div><div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{r.type}</div><div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{r.start} → {r.end}</div></div><StatusBadge status={r.status}/></div>))}
        </div>
      </div>
      {/* ── ERP Duty Rota Summary ── */}
      {hasErp && erpActiveWeek && (
        <div className="card" style={{marginTop:14}}>
          <div className="card-hd">
            <div><div className="card-title">🔄 ERP Duty Rota</div><div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{erpActiveWeek.label} · {erpActiveWeek.start} → {erpActiveWeek.end}</div></div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span className="badge" style={{background:"#fff7ed",color:"#E8750A"}}>{dtf}d to handover</span>
              {setView && <button className="btn bo" style={{fontSize:11}} onClick={()=>setView("erp_rota")}>Open →</button>}
            </div>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:8}}>
            {ERP_DUTY_SLOTS.map(slot => {
              const assignedId = erpActiveWeek[slot.key];
              const u = assignedId ? users.find(x => x.id === Number(assignedId)) : null;
              const leaveReq = u ? requests.find(r => r.userId === u.id && ["Annual Leave","Sick Leave","Compassionate","Recovery Leave","Remote Work"].includes(r.type) && (r.status==="Approved"||r.status==="Pending") && r.start <= erpActiveWeek.end && r.end >= erpActiveWeek.start) : null;
              return (
                <div key={slot.key} style={{padding:"6px 12px",borderRadius:8,background:leaveReq?"#fef2f2":slot.critical?"#fffbeb":"var(--bg)",border:leaveReq?"2px solid #ef4444":"1px solid var(--b)",display:"flex",alignItems:"center",gap:6,fontSize:12}}>
                  <span>{slot.ico}</span>
                  {u ? (
                    <>
                      <div className="av" style={{background:leaveReq?"#ef4444":aColor(u.id),width:20,height:20,fontSize:8,borderRadius:4}}>{initials(u.name)}</div>
                      <span style={{fontWeight:600,textDecoration:leaveReq?"line-through":"none",color:leaveReq?"#ef4444":"inherit"}}>{u.name}</span>
                      {leaveReq && <span style={{fontSize:10,fontWeight:700,color:"#dc2626"}}>⚠️</span>}
                    </>
                  ) : (
                    <span style={{color:assignedId?"var(--t3)":"#ef4444",fontWeight:600}}>{assignedId?"Unknown":"Unassigned"}</span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,marginTop:10,paddingTop:10,borderTop:"1px solid var(--b)"}}>
            <span style={{fontSize:12,color:"var(--t3)"}}>{erpMemberCount} ERP members</span>
            <span style={{fontSize:12,color:"var(--t3)"}}>·</span>
            <span style={{fontSize:12,color:"var(--t3)"}}>{erpDashData.weeks.length} rotation weeks</span>
            <div style={{flex:1}}/>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"#dc2626",fontWeight:700}}>Emergency: 29 324 484</span>
          </div>
        </div>
      )}
      {/* ── Team Leave Balances ── */}
      {users.length>1&&(hasPerm(roles,user.role,"all")||hasPerm(roles,user.role,"view_team")||hasPerm(roles,user.role,"leave_balance"))&&(()=>{
        const isAdmin=hasPerm(roles,user.role,"all");
        const team=isAdmin?users.filter(u=>u.active!==false):users.filter(u=>u.active!==false&&(u.manager===user.id||u.id===user.id));
        if(team.length===0) return null;
        return(
          <div className="card" style={{marginTop:14}}>
            <div className="card-hd"><div className="card-title">Team Leave Balances</div><span className="badge bgr2">{team.length}</span></div>
            <div className="tw" style={{maxHeight:300,overflowY:"auto"}}>
              <table className="tbl" style={{fontSize:12}}>
                <thead><tr><th>Employee</th><th>Dept</th><th style={{textAlign:"center"}}>Annual</th><th style={{textAlign:"center"}}>Used</th><th style={{textAlign:"center"}}>Remaining</th><th style={{textAlign:"center"}}>Recovery</th></tr></thead>
                <tbody>
                  {team.sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(u=>{
                    const rem=Math.max(0,Number(u.leaveBalance||0)-Number(u.usedLeave||0));
                    return(
                      <tr key={u.id} style={{background:u.id===user.id?"var(--vl)":undefined}}>
                        <td style={{fontWeight:u.id===user.id?700:400}}>{u.name}{u.id===user.id?" (You)":""}</td>
                        <td style={{color:"var(--t3)"}}>{u.dept||"—"}</td>
                        <td style={{textAlign:"center",fontWeight:600}}>{u.leaveBalance||0}</td>
                        <td style={{textAlign:"center",fontWeight:600,color:"var(--am)"}}>{u.usedLeave||0}</td>
                        <td style={{textAlign:"center",fontWeight:700,color:rem<=2?"var(--re)":rem<=5?"var(--am)":"var(--gr)"}}>{rem}</td>
                        <td style={{textAlign:"center",fontWeight:600,color:"var(--v)"}}>{u.recoveryBalance||0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
function ScheduleView({user, rotations=[], users=[], rotationPlans=[], setRotationPlans, canManage=false}) {
  const today=new Date();
  const [scTab,setScTab]=useState("calendar");
  const [year,setYear]=useState(today.getFullYear());
  const [month,setMonth]=useState(today.getMonth());
  const ts=today.toISOString().split("T")[0];
  const days=daysIn(year,month),first=firstWD(year,month);
  const ds=d=>`${year}-${pad(month+1)}-${pad(d)}`;
  const prev=()=>month===0?(setMonth(11),setYear(y=>y-1)):setMonth(m=>m-1);
  const next=()=>month===11?(setMonth(0),setYear(y=>y+1)):setMonth(m=>m+1);
  const fdt=s=>getFieldDayType(user.id,s,rotations);
  const cls=d=>{const s=ds(d),c=["cday"];if(isHol(s))c.push("hol");else if(isWE(s))c.push("we");else if(user.type==="field"){const t=fdt(s);c.push(t==="ON"?"on":t==="EXTRA"?"extra":"off");}else c.push("on");if(s===ts)c.push("today");return c.join(" ");};
  const tag=d=>{const s=ds(d);if(isHol(s))return["PH","#92400e"];if(isWE(s))return["WE","var(--t3)"];if(user.type==="field"){const t=fdt(s);return t==="ON"?["ON","#1d4ed8"]:t==="EXTRA"?["EX","#7c3aed"]:["OFF","var(--t3)"];}return["WD","var(--v)"];};
  const onD=user.type==="field"?Array.from({length:days},(_,i)=>{const t=fdt(ds(i+1));return !isHol(ds(i+1))&&!isWE(ds(i+1))&&t==="ON";}).filter(Boolean).length:Array.from({length:days},(_,i)=>!isHol(ds(i+1))&&!isWE(ds(i+1))).filter(Boolean).length;
  const extraD=user.type==="field"?Array.from({length:days},(_,i)=>{const t=fdt(ds(i+1));return !isHol(ds(i+1))&&!isWE(ds(i+1))&&t==="EXTRA";}).filter(Boolean).length:0;
  const offD=user.type==="field"?Array.from({length:days},(_,i)=>{const t=fdt(ds(i+1));return !isHol(ds(i+1))&&!isWE(ds(i+1))&&t==="OFF";}).filter(Boolean).length:0;
  const [schedEntries,setSchedEntries]=useState([]);
  useEffect(()=>{
    timesheetAPI.getEntries(user.id,year,month+1)
      .then(data=>setSchedEntries(data||[]))
      .catch(()=>setSchedEntries([]));
  },[user.id,year,month]);
  const dayAct=d=>schedEntries.find(e=>e.date===d)?.activity||null;

  const userRots=rotations.filter(r=>r.userId===user.id).sort((a,b)=>new Date(a.onStart)-new Date(b.onStart));

  // ── Rotation management (admin/HR only) ──────────────────────────────────────
  const fieldUsers=users.filter(u=>u.type==="field"&&u.active);
  const BNRot={userId:"",onStart:"",onEnd:""};
  const [rotModal,setRotModal]=useState(null);
  const [rotForm,setRotForm]=useState(BNRot);
  const [rotSearch,setRotSearch]=useState("");
  const [selectedEmpId,setSelectedEmpId]=useState(null);
  function rotOffDates(r){
    if(!r.onStart||!r.onEnd) return {offStart:"",offEnd:"",onDays:0};
    const onDays=Math.floor((new Date(r.onEnd)-new Date(r.onStart))/86400000)+1;
    const offStart=new Date(r.onEnd);offStart.setDate(offStart.getDate()+1);
    const offEnd=new Date(r.onEnd);offEnd.setDate(offEnd.getDate()+onDays);
    return {offStart:offStart.toISOString().slice(0,10),offEnd:offEnd.toISOString().slice(0,10),onDays};
  }
  async function addRotation(){
    if(!rotForm.userId||!rotForm.onStart||!rotForm.onEnd){toast("All fields required.");return;}
    if(new Date(rotForm.onEnd)<new Date(rotForm.onStart)){toast("End date must be after start date.");return;}
    try{const r=await rotationAPI.create({userId:rotForm.userId,onStart:rotForm.onStart,onEnd:rotForm.onEnd});setRotationPlans&&setRotationPlans(p=>[...p,{id:r.id,userId:r.user_id,onStart:r.on_start,onEnd:r.on_end}]);setRotModal(null);setRotForm(BNRot);setSelectedEmpId(Number(rotForm.userId));}
    catch(err){toast("Failed to add rotation: "+err.message);}
  }
  async function saveRotation(){
    if(!rotForm.onStart||!rotForm.onEnd){toast("All fields required.");return;}
    if(new Date(rotForm.onEnd)<new Date(rotForm.onStart)){toast("End date must be after start date.");return;}
    try{const r=await rotationAPI.update(rotModal.id,{onStart:rotForm.onStart,onEnd:rotForm.onEnd});setRotationPlans&&setRotationPlans(p=>p.map(x=>x.id===rotModal.id?{id:r.id,userId:r.user_id,onStart:r.on_start,onEnd:r.on_end}:x));setRotModal(null);setRotForm(BNRot);}
    catch(err){toast("Failed to save rotation: "+err.message);}
  }
  async function delRotation(id){
    if(!window.confirm("Delete this rotation plan?"))return;
    try{await rotationAPI.delete(id);setRotationPlans&&setRotationPlans(p=>p.filter(x=>x.id!==id));}
    catch(err){toast("Failed to delete rotation: "+err.message);}
  }

  return (
    <div>
      {canManage&&(
        <div className="tabs">
          <div className={`tab ${scTab==="calendar"?"active":""}`} onClick={()=>{setScTab("calendar");setSelectedEmpId(null);setRotSearch("");}}>📅 My Schedule</div>
          <div className={`tab ${scTab==="rotations"?"active":""}`} onClick={()=>setScTab("rotations")}>🔄 Rotation Plans</div>
        </div>
      )}

      {scTab==="calendar"&&(<div>
        <div className="sg" style={{gridTemplateColumns:"repeat(4,1fr)"}}>
          <div className="sc"><div className="sl">{user.type==="field"?"Days ON":"Working Days"}</div><div className="sv" style={{color:"var(--sk)"}}>{onD}</div></div>
          {user.type==="field"&&<><div className="sc"><div className="sl">Days OFF</div><div className="sv" style={{color:"var(--t3)"}}>{offD}</div></div><div className="sc"><div className="sl">Extra Days</div><div className="sv" style={{color:"var(--v)"}}>{extraD}</div></div></>}
          <div className="sc"><div className="sl">Annual Leave</div><div className="sv" style={{color:"var(--gr)"}}>{user.leaveBalance-user.usedLeave}</div>{(user.recoveryBalance||0)>0&&<div style={{fontSize:11,color:"var(--v)",marginTop:2}}>🔄 {user.recoveryBalance}d recovery</div>}</div>
          <div className="sc"><div className="sl">Public Holidays</div><div className="sv" style={{color:"var(--am)"}}>{Array.from({length:days},(_,i)=>isHol(ds(i+1))).filter(Boolean).length}</div></div>
        </div>
        {user.type==="field"&&userRots.length>0&&(
          <div className="card" style={{marginBottom:12}}>
            <div className="card-title" style={{padding:"10px 14px 6px"}}>My Rotation Plans</div>
            <div style={{padding:"0 14px 10px",display:"flex",flexWrap:"wrap",gap:8}}>
              {userRots.map(r=>{const{offStart,offEnd,onDays}=rotOffDates(r);return(<div key={r.id} style={{fontSize:12,background:"var(--s2)",borderRadius:6,padding:"6px 10px",border:"1px solid var(--b)"}}>
                <span style={{fontWeight:700,color:"var(--sk)"}}>ON</span> {r.onStart} → {r.onEnd} <span style={{color:"var(--t3)"}}>({onDays}d)</span>
                <span style={{margin:"0 6px",color:"var(--t3)"}}>·</span>
                <span style={{fontWeight:700,color:"var(--t3)"}}>OFF</span> {offStart} → {offEnd}
              </div>);})}
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-hd"><div className="card-title">Schedule — {MONTHS[month]} {year}</div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button className="btn bo bsm" onClick={prev}>‹</button>
              <span style={{fontSize:13,fontWeight:700,minWidth:100,textAlign:"center"}}>{MONTHS[month]} {year}</span>
              <button className="btn bo bsm" onClick={next}>›</button>
            </div>
          </div>
          <div className="cgrid">
            {DS.map(d=><div key={d} className="chd">{d}</div>)}
            {Array.from({length:first},(_,i)=><div key={"e"+i} className="cday empty"/>)}
            {Array.from({length:days},(_,i)=>{const d=i+1,[lbl,col]=tag(d);const act=dayAct(ds(d));return(<div key={d} className={cls(d)}><span className="dnum">{d}</span><span className="dtag" style={{color:col}}>{lbl}</span>{act&&<span className="dact">{act}</span>}</div>);})}
          </div>
          <div style={{display:"flex",gap:14,flexWrap:"wrap",marginTop:13}}>
            {user.type==="field"&&<>
              <span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"#dbeafe",display:"inline-block"}}/> Day ON</span>
              <span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"var(--s2)",display:"inline-block"}}/> Day OFF</span>
              <span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"#ede9fe",border:"1px solid #7c3aed",display:"inline-block"}}/> Extra Day</span>
            </>}
            {user.type==="office"&&<span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"#dbeafe",display:"inline-block"}}/> Working Day</span>}
            <span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"#fef3c7",display:"inline-block"}}/> Public Holiday</span>
            <span className="itag"><span style={{width:12,height:12,borderRadius:3,background:"var(--vl)",border:"1px solid var(--v)",display:"inline-block"}}/> Today</span>
          </div>
        </div>
      </div>)}

      {scTab==="rotations"&&canManage&&(<div>
        {/* header + search */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,gap:12,flexWrap:"wrap"}}>
          <div><div style={{fontWeight:700,fontSize:15}}>Rotation Plans</div><div style={{fontSize:12,color:"var(--t3)"}}>{fieldUsers.length} field employee{fieldUsers.length!==1?"s":""} · {rotationPlans.length} rotation{rotationPlans.length!==1?"s":""}</div></div>
          <div style={{display:"flex",gap:8,alignItems:"center",flex:1,justifyContent:"flex-end",flexWrap:"wrap"}}>
            <input className="fi" placeholder="🔍 Search employee…" value={rotSearch} onChange={e=>setRotSearch(e.target.value)} style={{maxWidth:220,height:34}}/>
            <button className="btn bp bsm" onClick={()=>{setRotForm(BNRot);setRotModal("add");}}>+ Add Rotation</button>
          </div>
        </div>

        {fieldUsers.length===0&&<div className="empty"><div className="empty-ico">👷</div>No active field employees found.</div>}

        {/* employee cards grid */}
        {!selectedEmpId&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
            {fieldUsers.filter(u=>!rotSearch||u.name.toLowerCase().includes(rotSearch.toLowerCase())||u.dept?.toLowerCase().includes(rotSearch.toLowerCase())).map(u=>{
              const urots=rotationPlans.filter(r=>r.userId===u.id);
              return(
                <div key={u.id} className="card" style={{cursor:"pointer",transition:"box-shadow .15s,transform .15s"}}
                  onClick={()=>setSelectedEmpId(u.id)}
                  onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 4px 16px rgba(0,0,0,.15)";e.currentTarget.style.transform="translateY(-2px)";}}
                  onMouseLeave={e=>{e.currentTarget.style.boxShadow="";e.currentTarget.style.transform="";}}>
                  <div style={{padding:"16px 14px 12px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                      <div className="av" style={{background:aColor(u.id),width:38,height:38,borderRadius:10,fontSize:13,flexShrink:0}}>{initials(u.name)}</div>
                      <div style={{minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.name}</div>
                        <div style={{fontSize:11,color:"var(--t3)"}}>{u.dept||"—"}</div>
                      </div>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,color:urots.length?"var(--sk)":"var(--t3)",fontWeight:urots.length?600:400}}>
                        {urots.length?`${urots.length} rotation${urots.length>1?"s":""}`: "No plans set"}
                      </span>
                      <span style={{fontSize:11,color:"var(--t3)"}}>View →</span>
                    </div>
                    {urots.length>0&&(()=>{
                      const latest=urots.sort((a,b)=>new Date(b.onStart)-new Date(a.onStart))[0];
                      return <div style={{fontSize:11,color:"var(--t3)",marginTop:4,fontFamily:"'JetBrains Mono',monospace"}}>Last: {latest.onStart}</div>;
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* selected employee detail */}
        {selectedEmpId&&(()=>{
          const emp=fieldUsers.find(u=>u.id===selectedEmpId);
          if(!emp) return null;
          const urots=rotationPlans.filter(r=>r.userId===emp.id).sort((a,b)=>new Date(a.onStart)-new Date(b.onStart));
          return(
            <div>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
                <button className="btn bo bsm" onClick={()=>setSelectedEmpId(null)}>← Back</button>
                <div className="av" style={{background:aColor(emp.id),width:34,height:34,borderRadius:9,fontSize:12}}>{initials(emp.name)}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14}}>{emp.name}</div>
                  <div style={{fontSize:11,color:"var(--t3)"}}>{emp.dept||"Field Employee"}</div>
                </div>
                <button className="btn bo bsm" onClick={()=>{setRotForm({...BNRot,userId:emp.id});setRotModal("add");}}>+ Add Rotation</button>
              </div>
              <div className="card">
                {urots.length===0&&<div style={{padding:"20px 14px",fontSize:13,color:"var(--t3)",textAlign:"center"}}>No rotation plans — using legacy 14/14 schedule.</div>}
                {urots.map((r,i)=>{const{offStart,offEnd,onDays}=rotOffDates(r);return(
                  <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderTop:i>0?"1px solid var(--b)":"none",fontSize:12}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                        <span><span style={{fontWeight:700,color:"var(--sk)"}}>ON</span> <span style={{fontFamily:"'JetBrains Mono',monospace"}}>{r.onStart} → {r.onEnd}</span> <span style={{color:"var(--t3)"}}>({onDays}d)</span></span>
                        <span><span style={{fontWeight:700,color:"var(--t3)"}}>OFF</span> <span style={{fontFamily:"'JetBrains Mono',monospace"}}>{offStart} → {offEnd}</span> <span style={{color:"var(--t3)"}}>({onDays}d mirror)</span></span>
                      </div>
                    </div>
                    <button className="btn bg2 bxs" onClick={()=>{setRotForm({userId:r.userId,onStart:r.onStart,onEnd:r.onEnd});setRotModal(r);}}>✏️</button>
                    <button className="btn bd bxs" onClick={()=>delRotation(r.id)}>🗑</button>
                  </div>
                );})}
              </div>
            </div>
          );
        })()}

        {/* add/edit modal */}
        {rotModal&&(
          <div className="mo" onClick={e=>e.target.className==="mo"&&setRotModal(null)}>
            <div className="md">
              <div className="md-title">{rotModal==="add"?"Add Rotation Plan":"Edit Rotation Plan"}</div>
              <div className="fg">
                <div className="fgrp"><label className="flbl">Employee</label>
                  <select className="fsel" value={rotForm.userId} onChange={e=>setRotForm(f=>({...f,userId:Number(e.target.value)}))} disabled={rotModal!=="add"}>
                    <option value="">Select field employee…</option>
                    {fieldUsers.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
                <div className="fg" style={{gridTemplateColumns:"1fr 1fr"}}>
                  <div className="fgrp"><label className="flbl">On-Site Start</label><input type="date" className="fi" value={rotForm.onStart} onChange={e=>setRotForm(f=>({...f,onStart:e.target.value}))}/></div>
                  <div className="fgrp"><label className="flbl">On-Site End</label><input type="date" className="fi" value={rotForm.onEnd} onChange={e=>setRotForm(f=>({...f,onEnd:e.target.value}))}/></div>
                </div>
                {rotForm.onStart&&rotForm.onEnd&&new Date(rotForm.onEnd)>=new Date(rotForm.onStart)&&(()=>{const{offStart,offEnd,onDays}=rotOffDates(rotForm);return(
                  <div style={{background:"var(--s2)",borderRadius:6,padding:"10px 12px",fontSize:12}}>
                    <div style={{fontWeight:700,marginBottom:6,color:"var(--t2)"}}>Schedule Preview</div>
                    <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                      <div><span style={{fontWeight:700,color:"var(--sk)"}}>ON</span> {rotForm.onStart} → {rotForm.onEnd} <span style={{color:"var(--t3)"}}>({onDays}d)</span></div>
                      <div><span style={{fontWeight:700,color:"var(--t3)"}}>OFF</span> {offStart} → {offEnd} <span style={{color:"var(--t3)"}}>({onDays}d mirror)</span></div>
                    </div>
                  </div>
                );})()}
              </div>
              <div className="md-footer">
                <button className="btn bo" onClick={()=>setRotModal(null)}>Cancel</button>
                <button className="btn bp" onClick={rotModal==="add"?addRotation:saveRotation}>{rotModal==="add"?"Add":"Save"}</button>
              </div>
            </div>
          </div>
        )}
      </div>)}
    </div>
  );
}

// ─── ORG CHART ────────────────────────────────────────────────────────────────
function OrgChartView({user, users, roles}) {
  const visibleUsers = users.filter(u => u.role !== "superadmin" && u.id !== 0);

  // Build ancestor chain [root … manager] (excludes current user)
  function getAncestors(uid) {
    const chain=[]; let cur=visibleUsers.find(u=>u.id===uid);
    while(cur){chain.unshift(cur);cur=visibleUsers.find(u=>u.id===cur.manager);}
    return chain.slice(0,-1); // remove self
  }
  const ancestors = getAncestors(user.id);
  const myManager  = ancestors.length>0 ? ancestors[ancestors.length-1] : null;
  const peers      = visibleUsers.filter(u=>u.manager===user.manager&&u.id!==user.id);
  const directReports = visibleUsers.filter(u=>u.manager===user.id);

  // Card component
  function OCard({u, highlight=false, tag=null}) {
    return (
      <div className={`ot-card${highlight?" me":""}${!u.active?" inactive":""}`} style={{minWidth:110}}>
        <div className="av" style={{background:highlight?"var(--v)":aColor(u.id),margin:"0 auto 7px",width:36,height:36,borderRadius:9}}>{initials(u.name)}</div>
        <div style={{fontWeight:700,fontSize:12,lineHeight:1.3,textAlign:"center"}}>{u.name}</div>
        {highlight&&<div className="ot-you">▲ You</div>}
        {tag&&<div style={{fontSize:9,fontWeight:700,color:"var(--am)",textTransform:"uppercase",letterSpacing:.5,marginTop:2,textAlign:"center"}}>{tag}</div>}
        <div style={{fontSize:10,color:"var(--t3)",marginTop:3,textAlign:"center"}}>{u.dept}</div>
        <div style={{marginTop:5,display:"flex",gap:4,justifyContent:"center",flexWrap:"wrap"}}><RoleBadge role={u.role} roles={roles}/><TypeBadge type={u.type}/></div>
      </div>
    );
  }

  // Recursive tree for direct reports
  function ReportNode({u, depth}) {
    const children=visibleUsers.filter(x=>x.manager===u.id);
    return (
      <div className="ot-node">
        {depth>0&&<div className="ot-vline"/>}
        <OCard u={u}/>
        {children.length>0&&(
          <>
            <div className="ot-vline"/>
            <div className="ot-level" style={{gap:0}}>
              {children.length>1&&<div className="ot-hbar" style={{left:`${100/children.length/2}%`,right:`${100/children.length/2}%`}}/>}
              {children.map(c=><ReportNode key={c.id} u={c} depth={depth+1}/>)}
            </div>
          </>
        )}
      </div>
    );
  }

  const sectionHd = (label, sub) => (
    <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:12,justifyContent:"center"}}>
      <div style={{fontSize:11,fontWeight:700,color:"var(--t3)",textTransform:"uppercase",letterSpacing:1}}>{label}</div>
      {sub&&<div style={{fontSize:11,color:"var(--t3)"}}>{sub}</div>}
    </div>
  );

  // Breadcrumb: full chain including self
  const fullChain=[...ancestors,visibleUsers.find(u=>u.id===user.id)||user];

  return (
    <div>
      {/* Breadcrumb */}
      <div style={{marginBottom:20,padding:"10px 14px",background:"var(--vl)",borderRadius:"var(--r)",border:"1px solid #ede9fe",display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
        <span style={{fontSize:11,fontWeight:700,color:"var(--v)"}}>Your position:</span>
        {fullChain.map((u,i)=>(
          <span key={u.id} style={{display:"flex",alignItems:"center",gap:6}}>
            {i>0&&<span style={{color:"var(--t3)",fontSize:12}}>›</span>}
            <span style={{fontSize:12,fontWeight:i===fullChain.length-1?700:400,color:i===fullChain.length-1?"var(--v)":"var(--t2)"}}>{u.name}</span>
          </span>
        ))}
      </div>

      {/* ── Upper reporting chain ── */}
      {ancestors.length>0&&(
        <div style={{marginBottom:24}}>
          {sectionHd("Upper Reporting", `${ancestors.length} level${ancestors.length>1?"s":""} above you`)}
          <div style={{display:"flex",alignItems:"flex-start",gap:0,flexWrap:"wrap",justifyContent:"center"}}>
            {ancestors.map((anc,i)=>{
              const sibCount=visibleUsers.filter(u=>u.manager===anc.manager&&u.id!==anc.id).length;
              return(
                <div key={anc.id} style={{display:"flex",alignItems:"flex-start"}}>
                  {i>0&&<div style={{display:"flex",alignItems:"center",padding:"0 6px",marginTop:30,color:"var(--t3)",fontSize:18}}>›</div>}
                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                    <OCard u={anc} tag={i===ancestors.length-1?"Your Manager":null}/>
                    {sibCount>0&&<div style={{fontSize:10,color:"var(--t3)",textAlign:"center"}}>+{sibCount} peer{sibCount>1?"s":""}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Connector from manager to current level */}
      {myManager&&<div style={{width:2,height:20,background:"var(--b2)",margin:"0 auto",marginBottom:0,borderRadius:2}}/>}

      {/* ── Current level: peers + self ── */}
      <div style={{marginBottom:24}}>
        {sectionHd(
          "Your Level",
          myManager?`Reports to ${myManager.name}`:`${peers.length+1} people`
        )}
        <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-start",justifyContent:"center"}}>
          {peers.map(p=><OCard key={p.id} u={p}/>)}
          <OCard u={visibleUsers.find(u=>u.id===user.id)||user} highlight={true}/>
        </div>
      </div>

      {/* Connector to reports */}
      {directReports.length>0&&<div style={{width:2,height:20,background:"var(--b2)",margin:"0 auto",borderRadius:2}}/>}

      {/* ── Direct reports ── */}
      {directReports.length>0?(
        <div>
          {sectionHd("Your Direct Reports", `${directReports.length} report${directReports.length>1?"s":""}`)}
          <div className="ot-wrap">
            <div className="ot-tree" style={{justifyContent:"center"}}>
              <div className="ot-node" style={{alignItems:"center"}}>
                <div className="ot-vline"/>
                <div className="ot-level" style={{gap:0}}>
                  {directReports.length>1&&<div className="ot-hbar" style={{left:`${100/directReports.length/2}%`,right:`${100/directReports.length/2}%`}}/>}
                  {directReports.map(r=><ReportNode key={r.id} u={r} depth={1}/>)}
                </div>
              </div>
            </div>
          </div>
        </div>
      ):(
        <div style={{textAlign:"center",padding:"16px 0",fontSize:12,color:"var(--t3)"}}>No direct reports</div>
      )}

      {/* Legend */}
      <div style={{display:"flex",gap:16,marginTop:18,fontSize:11,color:"var(--t3)",flexWrap:"wrap"}}>
        <span style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:12,height:12,borderRadius:3,border:"2px solid var(--v)",background:"var(--vl)"}}/>You</span>
        <span style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:12,height:12,borderRadius:3,border:"1.5px solid var(--b)",opacity:.4}}/>Inactive</span>
      </div>
    </div>
  );
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
// ─── ANALYTICS + REPORTS (combined, tabbed) ───────────────────────────────────
function AnalyticsReports({user,requests,setRequests,users,projects,roles,tsStatuses,activities}) {
  const hasAna=hasPerm(roles,user.role,"analytics")||hasPerm(roles,user.role,"all");
  const hasRep=hasPerm(roles,user.role,"hr_report")||hasPerm(roles,user.role,"all");
  const [tab,setTab]=useState(hasAna?"analytics":"reports");
  return(
    <div>
      <div className="tabs">
        {hasAna&&<div className={`tab ${tab==="analytics"?"active":""}`} onClick={()=>setTab("analytics")}>📊 Analytics</div>}
        {hasRep&&<div className={`tab ${tab==="reports"?"active":""}`} onClick={()=>setTab("reports")}>📈 Reports</div>}
        {hasRep&&<div className={`tab ${tab==="allocation"?"active":""}`} onClick={()=>setTab("allocation")}>📊 Allocation</div>}
      </div>
      {tab==="analytics"&&hasAna&&<Analytics user={user} requests={requests} users={users} projects={projects} roles={roles} tsStatuses={tsStatuses}/>}
      {tab==="reports"&&hasRep&&<ReportsView users={users} requests={requests} activities={activities} tsStatuses={tsStatuses}/>}
      {tab==="allocation"&&hasRep&&<AllocationReport/>}
    </div>
  );
}

function Analytics({user,requests,users,projects,roles,tsStatuses}) {
  const isAd=hasPerm(roles,user.role,"all");
  const teamIds=isAd?users.map(u=>u.id):users.filter(u=>u.manager===user.id).map(u=>u.id);
  // Leave distribution — approved requests only, grouped by type
  const lvData=useMemo(()=>{
    const m={};
    requests.filter(r=>teamIds.includes(r.userId)&&r.status==="Approved").forEach(r=>{m[r.type]=(m[r.type]||0)+r.daysCount;});
    return Object.entries(m).map(([n,v],i)=>({name:n,value:v,color:COLORS[i%COLORS.length]}));
  },[requests,teamIds]);
  const pend=requests.filter(r=>r.status==="Pending").length;
  const tsApproved=Object.values(tsStatuses).filter(t=>t.status==="approved").length;
  const tsPending=Object.values(tsStatuses).filter(t=>t.status==="submitted").length;
  // Last 6 months — computed from real requests and tsStatuses
  const monthlyStats=useMemo(()=>{
    const now=new Date();
    return Array.from({length:6},(_,i)=>{
      const d=new Date(now.getFullYear(),now.getMonth()-5+i,1);
      const yr=d.getFullYear(); const mo=d.getMonth();
      const moStr=String(mo+1).padStart(2,"0");
      const label=d.toLocaleString("default",{month:"short"});
      const mReqs=requests.filter(r=>{ const s=new Date(r.startDate); return s.getFullYear()===yr&&s.getMonth()===mo; });
      const leaveDays=mReqs.filter(r=>r.status==="Approved"&&/leave/i.test(r.type)).reduce((s,r)=>s+r.daysCount,0);
      const missions=mReqs.filter(r=>r.status==="Approved"&&/mission/i.test(r.type)).reduce((s,r)=>s+r.daysCount,0);
      const tsAp=teamIds.filter(uid=>tsStatuses[`${uid}-${yr}-${moStr}`]?.status==="approved").length;
      const ontime=teamIds.length>0?Math.round((tsAp/teamIds.length)*100):0;
      return {month:label,leaveDays,missions,tsApproved:tsAp,ontime};
    });
  },[requests,tsStatuses,teamIds]);
  // Project activity — eligible active staff per open project
  const activeField=users.filter(u=>u.active&&u.type==="field").length;
  const activeOffice=users.filter(u=>u.active&&u.type==="office").length;
  const projActivity=projects.filter(p=>p.open).map(p=>{
    const eligible=(p.fieldAllowed?activeField:0)+(p.officeAllowed?activeOffice:0);
    return {...p,eligible};
  }).sort((a,b)=>b.eligible-a.eligible).slice(0,5);
  const maxEligible=projActivity[0]?.eligible||1;
  return (
    <div>
      <div className="sg">
        <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">{isAd?"Total Employees":"Team Size"}</div><div className="sv" style={{color:"var(--v)"}}>{isAd?users.length:teamIds.length}</div><div className="sc2 up">↑ {users.filter(u=>u.active).length} active</div></div>
        <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Pending Requests</div><div className="sv" style={{color:"var(--am)"}}>{pend}</div></div>
        <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">TS Approved</div><div className="sv" style={{color:"var(--gr)"}}>{tsApproved}</div><div className="sc2 neu">{tsPending} pending review</div></div>
        <div className="sc"><div className="sa" style={{background:"var(--sk)"}}/><div className="sl">Open Projects</div><div className="sv" style={{color:"var(--sk)"}}>{projects.filter(p=>p.open).length}</div></div>
      </div>
      <div className="g2">
        <div className="card"><div className="card-hd"><div><div className="card-title">Monthly Leave Trends</div><div style={{fontSize:11,color:"var(--t3)"}}>Approved leave days · last 6 months</div></div></div>
          <ResponsiveContainer width="100%" height={195}><AreaChart data={monthlyStats} margin={{top:0,right:0,bottom:0,left:-22}}>
            <defs><linearGradient id="gw" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#7c3aed" stopOpacity={.15}/><stop offset="95%" stopColor="#7c3aed" stopOpacity={0}/></linearGradient><linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={.15}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9"/><XAxis dataKey="month" tick={{fontSize:11,fill:"#94a3b8"}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:11,fill:"#94a3b8"}} axisLine={false} tickLine={false}/>
            <Tooltip content={<CT/>}/><Area type="monotone" dataKey="leaveDays" name="Leave Days" stroke="#7c3aed" fill="url(#gw)" strokeWidth={2} dot={false}/><Area type="monotone" dataKey="tsApproved" name="TS Approved" stroke="#10b981" fill="url(#gl)" strokeWidth={2} dot={false}/>
          </AreaChart></ResponsiveContainer>
        </div>
        <div className="card"><div className="card-hd"><div><div className="card-title">Leave Distribution</div><div style={{fontSize:11,color:"var(--t3)"}}>All-time · approved requests</div></div></div>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <ResponsiveContainer width="50%" height={145}><PieChart><Pie data={lvData.length?lvData:[{name:"No data",value:1,color:"#e2e8f0"}]} cx="50%" cy="50%" innerRadius={34} outerRadius={62} paddingAngle={3} dataKey="value">{(lvData.length?lvData:[{name:"No data",value:1,color:"#e2e8f0"}]).map((e,i)=><Cell key={i} fill={e.color}/>)}</Pie><Tooltip/></PieChart></ResponsiveContainer>
            <div style={{flex:1}}>{lvData.length?lvData.map((e,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><div className="dot" style={{background:e.color}}/><span style={{fontSize:12,color:"var(--t2)",flex:1}}>{e.name}</span><strong style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace"}}>{e.value}d</strong></div>):<span style={{fontSize:12,color:"var(--t3)"}}>No approved requests</span>}</div>
          </div>
        </div>
      </div>
      <div className="g2">
        <div className="card"><div className="card-hd"><div><div className="card-title">Missions</div><div style={{fontSize:11,color:"var(--t3)"}}>Approved mission days · last 6 months</div></div></div>
          <ResponsiveContainer width="100%" height={160}><BarChart data={monthlyStats} margin={{top:0,right:0,bottom:0,left:-22}}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false}/><XAxis dataKey="month" tick={{fontSize:11,fill:"#94a3b8"}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:11,fill:"#94a3b8"}} axisLine={false} tickLine={false}/><Tooltip content={<CT/>}/><Bar dataKey="missions" name="Missions (days)" fill="#7c3aed" radius={[4,4,0,0]} maxBarSize={26}/></BarChart></ResponsiveContainer>
        </div>
        <div className="card">
          <div className="card-hd"><div><div className="card-title">Project Reach</div><div style={{fontSize:11,color:"var(--t3)"}}>Eligible active staff per open project</div></div></div>
          {projActivity.length===0&&<div style={{fontSize:13,color:"var(--t3)",padding:"20px 0",textAlign:"center"}}>No open projects</div>}
          {projActivity.map(p=>{const pct=Math.round((p.eligible/maxEligible)*100);return(<div key={p.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:9}}><div className="dot" style={{background:p.color}}/><span style={{fontSize:12,color:"var(--t2)",width:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={p.name}>{p.code}</span><div className="prog" style={{flex:1}}><div className="prog-f" style={{width:`${pct}%`,background:p.color}}/></div><span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)",width:28,textAlign:"right"}}>{p.eligible}</span></div>);})}
          {isAd&&<><div className="divider"/><div style={{fontWeight:700,fontSize:13,marginBottom:4}}>TS Approval Rate <span style={{fontWeight:400,fontSize:11,color:"var(--t3)"}}>% of team per month</span></div><ResponsiveContainer width="100%" height={95}><LineChart data={monthlyStats} margin={{top:0,right:0,bottom:0,left:-22}}><XAxis dataKey="month" tick={{fontSize:10,fill:"#94a3b8"}} axisLine={false} tickLine={false}/><YAxis domain={[0,100]} tick={{fontSize:10,fill:"#94a3b8"}} axisLine={false} tickLine={false} unit="%"/><Tooltip/><Line type="monotone" dataKey="ontime" name="Approved %" stroke="#0ea5e9" strokeWidth={2} dot={{r:3,fill:"#0ea5e9",stroke:"#fff",strokeWidth:2}}/></LineChart></ResponsiveContainer></>}
        </div>
      </div>
    </div>
  );
}

// ─── REPORTS VIEW ─────────────────────────────────────────────────────────────
function ReportsView({users,requests,activities,tsStatuses}) {
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth());
  const [deptFilter,setDeptFilter]=useState("all");
  const [summary,setSummary]=useState({});
  const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  useEffect(()=>{
    payrollAPI.getSummary(year,month+1).then(rows=>{
      const m={};
      rows.forEach(r=>{if(!m[r.user_id])m[r.user_id]={};m[r.user_id][r.activity]=(m[r.user_id][r.activity]||0)+Number(r.days);});
      setSummary(m);
    }).catch(()=>{});
  },[year,month]);

  const act=(uid,a)=>summary[uid]?.[a]||0;
  const activeUsers=users.filter(u=>u.active);
  const depts=[...new Set(activeUsers.map(u=>u.dept).filter(Boolean))].sort();
  const filtered=deptFilter==="all"?activeUsers:activeUsers.filter(u=>u.dept===deptFilter);

  // ── Report datasets ──────────────────────────────────────────────────────
  const topSiteDays=filtered
    .map(u=>({...u,val:act(u.id,"Site")}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);

  const highLeaveBalance=filtered
    .map(u=>({...u,val:Math.max(0,Number(u.leaveBalance)-Number(u.usedLeave))}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);

  const recoveryLeaders=filtered.filter(u=>u.type==="field")
    .map(u=>({...u,val:Number(u.recoveryBalance||0)}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);


  const sickLeaders=filtered
    .map(u=>({...u,val:act(u.id,"Sick Leave")}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);

  const trainingLeaders=filtered.filter(u=>u.type==="office")
    .map(u=>({...u,val:act(u.id,"Training")}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);

  const remoteLeaders=filtered.filter(u=>u.type==="office")
    .map(u=>({...u,val:act(u.id,"Remote Work")}))
    .filter(u=>u.val>0).sort((a,b)=>b.val-a.val).slice(0,10);

  // By-department aggregations
  const byDept=depts.map(dept=>{
    const du=filtered.filter(u=>u.dept===dept);
    const uids=du.map(u=>u.id);
    const missionDays=du.reduce((t,u)=>t+act(u.id,"Mission")+act(u.id,"Mission Office")+act(u.id,"Other Mission"),0);
    const pending=requests.filter(r=>uids.includes(r.userId)&&r.status==="Pending").length;
    const approved=requests.filter(r=>uids.includes(r.userId)&&r.status==="Approved").length;
    const tsKeys=du.map(u=>`${u.id}-${year}-${String(month+1).padStart(2,"0")}`);
    const tsSubmitted=tsKeys.filter(k=>tsStatuses[k]?.status==="submitted").length;
    const tsApproved=tsKeys.filter(k=>tsStatuses[k]?.status==="approved").length;
    const totalLeaveRem=du.reduce((t,u)=>t+Math.max(0,Number(u.leaveBalance)-Number(u.usedLeave)),0);
    return{dept,total:du.length,field:du.filter(u=>u.type==="field").length,office:du.filter(u=>u.type==="office").length,missionDays,pending,approved,tsSubmitted,tsApproved,totalLeaveRem};
  }).filter(d=>d.total>0).sort((a,b)=>b.total-a.total);

  // ── UI helpers ───────────────────────────────────────────────────────────
  const MiniBar=({val,max,color})=>(
    <div style={{flex:1,background:"var(--b3,#e2e8f0)",borderRadius:4,height:8,overflow:"hidden",minWidth:60}}>
      <div style={{height:"100%",width:`${max>0?Math.min(100,(val/max)*100):0}%`,background:color,borderRadius:4,transition:"width .4s"}}/>
    </div>
  );

  const RankRow=({rank,user,val,label,maxVal,color})=>(
    <div style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid var(--b3,#e2e8f0)"}}>
      <div style={{width:20,color:"var(--t3)",fontWeight:700,fontSize:11,flexShrink:0}}>#{rank}</div>
      <div className="av" style={{background:aColor(user.id),flexShrink:0,width:28,height:28,fontSize:11}}>{initials(user.name)}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:600,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{user.name}</div>
        <div style={{fontSize:10,color:"var(--t3)"}}>{user.dept}</div>
      </div>
      <MiniBar val={val} max={maxVal} color={color}/>
      <div style={{minWidth:38,textAlign:"right",fontWeight:700,fontSize:13,color,flexShrink:0}}>{val}{label}</div>
    </div>
  );

  const RC=({title,ico,desc,children,empty})=>(
    <div className="card" style={{marginBottom:0}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:10}}>
        <span style={{fontSize:18,lineHeight:1.3}}>{ico}</span>
        <div><div style={{fontWeight:700,fontSize:13}}>{title}</div>{desc&&<div style={{fontSize:11,color:"var(--t3)"}}>{desc}</div>}</div>
      </div>
      {empty?<div style={{color:"var(--t3)",fontSize:12,textAlign:"center",padding:"14px 0"}}>{empty}</div>:children}
    </div>
  );

  const maxMission=Math.max(...byDept.map(d=>d.missionDays),1);
  const maxLeaveRem=Math.max(...byDept.map(d=>d.totalLeaveRem),1);

  return(
    <div>
      {/* Controls */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,flexWrap:"wrap"}}>
        <button className="btn bo bsm" onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
        <span style={{fontWeight:700,fontSize:15,minWidth:100,textAlign:"center"}}>{MN[month]} {year}</span>
        <button className="btn bo bsm" onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
        <select className="inp" style={{maxWidth:180,marginLeft:8}} value={deptFilter} onChange={e=>setDeptFilter(e.target.value)}>
          <option value="all">All Departments</option>
          {depts.map(d=><option key={d} value={d}>{d}</option>)}
        </select>
        <span style={{fontSize:11,color:"var(--t3)",marginLeft:4}}>Activity data: {MN[month]} {year}</span>
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          <button className="btn bo bsm" onClick={()=>{
            const hdr=["Department","Total","Field","Office","Mission Days","Pending Req","Approved Req","TS Submitted","TS Approved","Leave Liability (d)"];
            const rows=[hdr,...byDept.map(d=>[d.dept,d.total,d.field,d.office,d.missionDays,d.pending,d.approved,d.tsSubmitted,d.tsApproved,d.totalLeaveRem])];
            downloadXLSX(rows,`reports-${MN[month]}-${year}${deptFilter!=="all"?"-"+deptFilter:""}`);
          }}>⬇ XLSX</button>
          <button className="btn bo bsm" onClick={printPage}>🖨 PDF</button>
        </div>
      </div>

      {/* Headcount + dept summary table */}
      <div className="card" style={{marginBottom:16}}>
        <div className="shd">🏢 Headcount by Department</div>
        <div className="tw">
          <table className="tbl">
            <thead><tr>
              <th>Department</th><th>Total</th><th>⛽ Field</th><th>🏢 Office</th>
              <th>✈️ Mission Days</th><th>📋 Requests</th><th>📄 TS {MN[month]}</th><th>🌴 Leave Liability</th>
            </tr></thead>
            <tbody>{byDept.map(d=>(
              <tr key={d.dept}>
                <td><strong>{d.dept}</strong></td>
                <td><strong>{d.total}</strong></td>
                <td>{d.field||<span style={{color:"var(--t3)"}}>—</span>}</td>
                <td>{d.office||<span style={{color:"var(--t3)"}}>—</span>}</td>
                <td>{d.missionDays>0?<span style={{color:"var(--sk)",fontWeight:700}}>{d.missionDays}d</span>:<span style={{color:"var(--t3)"}}>—</span>}</td>
                <td>
                  {d.pending>0&&<span style={{background:"var(--aml)",color:"var(--am)",borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:700,marginRight:4}}>{d.pending}⏳</span>}
                  {d.approved>0&&<span style={{background:"var(--grl)",color:"var(--gr)",borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:700}}>{d.approved}✓</span>}
                  {d.pending===0&&d.approved===0&&<span style={{color:"var(--t3)"}}>—</span>}
                </td>
                <td>
                  {d.tsApproved>0&&<span style={{background:"var(--grl)",color:"var(--gr)",borderRadius:4,padding:"1px 5px",fontSize:11,fontWeight:700,marginRight:3}}>{d.tsApproved}✓</span>}
                  {d.tsSubmitted>0&&<span style={{background:"var(--aml)",color:"var(--am)",borderRadius:4,padding:"1px 5px",fontSize:11,fontWeight:700}}>{d.tsSubmitted}⏳</span>}
                  {d.tsApproved===0&&d.tsSubmitted===0&&<span style={{color:"var(--t3)"}}>—</span>}
                </td>
                <td><span style={{color:"var(--re)",fontWeight:700}}>{d.totalLeaveRem}d</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {/* Report cards grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",gap:16,alignItems:"start"}}>

        <RC title="Top — Site Days" ico="🏗️" desc={`Employees with most site days in ${MN[month]}`} empty={topSiteDays.length===0?"No site data for this period":null}>
          {topSiteDays.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={topSiteDays[0]?.val||1} color="var(--sk)"/>)}
        </RC>

        <RC title="Highest Leave Balance" ico="🌴" desc="Employees with most unused annual leave (financial liability)" empty={highLeaveBalance.length===0?"No data":null}>
          {highLeaveBalance.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={highLeaveBalance[0]?.val||1} color="var(--gr)"/>)}
        </RC>

        <RC title="Recovery Balance Leaders" ico="🔄" desc="Field employees with highest accrued recovery days" empty={recoveryLeaders.length===0?"No recovery balance accumulated":null}>
          {recoveryLeaders.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={recoveryLeaders[0]?.val||1} color="var(--v)"/>)}
        </RC>

        <RC title="Sick Leave Frequency" ico="🏥" desc={`Employees with most sick days in ${MN[month]}`} empty={sickLeaders.length===0?"No sick leave recorded this period":null}>
          {sickLeaders.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={sickLeaders[0]?.val||1} color="var(--re)"/>)}
        </RC>

        <RC title="Training Days" ico="📚" desc={`Office employees with most training days in ${MN[month]}`} empty={trainingLeaders.length===0?"No training recorded this period":null}>
          {trainingLeaders.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={trainingLeaders[0]?.val||1} color="#8b5cf6"/>)}
        </RC>

        <RC title="Remote Work Leaders" ico="🏠" desc={`Office employees working remotely most in ${MN[month]}`} empty={remoteLeaders.length===0?"No remote work recorded this period":null}>
          {remoteLeaders.map((u,i)=><RankRow key={u.id} rank={i+1} user={u} val={u.val} label="d" maxVal={remoteLeaders[0]?.val||1} color="var(--sk)"/>)}
        </RC>

        <RC title="Mission Days by Department" ico="✈️" desc={`Total field/office mission days by dept in ${MN[month]}`} empty={byDept.filter(d=>d.missionDays>0).length===0?"No mission days recorded this period":null}>
          {byDept.filter(d=>d.missionDays>0).map((d,i)=>(
            <div key={d.dept} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid var(--b3,#e2e8f0)"}}>
              <div style={{width:20,color:"var(--t3)",fontWeight:700,fontSize:11}}>#{i+1}</div>
              <div style={{flex:1,fontWeight:600,fontSize:13}}>{d.dept}</div>
              <MiniBar val={d.missionDays} max={maxMission} color="var(--sk)"/>
              <div style={{minWidth:38,textAlign:"right",fontWeight:700,fontSize:13,color:"var(--sk)"}}>{d.missionDays}d</div>
            </div>
          ))}
        </RC>

        <RC title="Leave Liability by Department" ico="💰" desc="Total unused annual leave days per department (payout risk)" empty={byDept.filter(d=>d.totalLeaveRem>0).length===0?"No data":null}>
          {byDept.filter(d=>d.totalLeaveRem>0).map((d,i)=>(
            <div key={d.dept} style={{display:"flex",alignItems:"center",gap:9,padding:"5px 0",borderBottom:"1px solid var(--b3,#e2e8f0)"}}>
              <div style={{width:20,color:"var(--t3)",fontWeight:700,fontSize:11}}>#{i+1}</div>
              <div style={{flex:1,fontWeight:600,fontSize:13}}>{d.dept}</div>
              <MiniBar val={d.totalLeaveRem} max={maxLeaveRem} color="var(--re)"/>
              <div style={{minWidth:38,textAlign:"right",fontWeight:700,fontSize:13,color:"var(--re)"}}>{d.totalLeaveRem}d</div>
            </div>
          ))}
        </RC>

        <RC title="Approval Duration by Manager" ico="⏱️" desc="Average days to approve/reject requests, grouped by reviewing manager" empty={null}>
          {(()=>{
            const reviewed=requests.filter(r=>(r.status==="Approved"||r.status==="Rejected")&&r.createdAt&&r.reviewedAt&&r.reviewedBy);
            if(reviewed.length===0) return <div style={{color:"var(--t3)",fontSize:12,textAlign:"center",padding:"14px 0"}}>No reviewed requests yet</div>;
            // Group by reviewedBy manager
            const byMgr={};
            reviewed.forEach(r=>{
              const dur=Math.max(0,Math.round((new Date(r.reviewedAt)-new Date(r.createdAt))/(1000*60*60*24)));
              if(!byMgr[r.reviewedBy]) byMgr[r.reviewedBy]={total:0,count:0,sameDay:0,slow:0};
              byMgr[r.reviewedBy].total+=dur;
              byMgr[r.reviewedBy].count+=1;
              if(dur===0) byMgr[r.reviewedBy].sameDay+=1;
              if(dur>3) byMgr[r.reviewedBy].slow+=1;
            });
            const rows=Object.entries(byMgr).map(([mgrId,s])=>{
              const mgr=users.find(u=>u.id===Number(mgrId));
              const avg=Math.round(s.total/s.count);
              return{mgrId:Number(mgrId),mgr,avg,count:s.count,sameDay:s.sameDay,slow:s.slow};
            }).sort((a,b)=>b.avg-a.avg);
            const maxAvg=rows[0]?.avg||1;
            const globalAvg=Math.round(reviewed.reduce((t,r)=>t+Math.max(0,Math.round((new Date(r.reviewedAt)-new Date(r.createdAt))/(1000*60*60*24))),0)/reviewed.length);
            return(<>
              <div style={{display:"flex",gap:12,marginBottom:10,flexWrap:"wrap"}}>
                <div style={{background:"var(--grl)",borderRadius:6,padding:"4px 10px",fontSize:11}}><strong style={{color:"var(--gr)"}}>{globalAvg}d</strong> overall avg</div>
                <div style={{background:"var(--skl)",borderRadius:6,padding:"4px 10px",fontSize:11}}><strong style={{color:"var(--sk)"}}>{reviewed.length}</strong> requests reviewed</div>
              </div>
              {rows.map((row,i)=>(
                <div key={row.mgrId} style={{display:"flex",alignItems:"center",gap:9,padding:"7px 0",borderBottom:"1px solid var(--b3,#e2e8f0)"}}>
                  <div style={{width:20,color:"var(--t3)",fontWeight:700,fontSize:11}}>#{i+1}</div>
                  {row.mgr?<div className="av" style={{background:aColor(row.mgr.id),flexShrink:0,width:28,height:28,fontSize:11}}>{initials(row.mgr.name)}</div>:<div className="av" style={{background:"#94a3b8",flexShrink:0,width:28,height:28,fontSize:11}}>?</div>}
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13}}>{row.mgr?.name||"Unknown"}</div>
                    <div style={{fontSize:10,color:"var(--t3)"}}>{row.count} reviewed · {row.sameDay} same-day{row.slow>0&&<span style={{color:"var(--re)"}}> · {row.slow} slow (&gt;3d)</span>}</div>
                  </div>
                  <MiniBar val={row.avg} max={maxAvg} color={row.avg>3?"var(--re)":row.avg>1?"var(--am)":"var(--gr)"}/>
                  <div style={{minWidth:42,textAlign:"right",fontWeight:700,fontSize:14,color:row.avg>3?"var(--re)":row.avg>1?"var(--am)":"var(--gr)"}}>{row.avg}d</div>
                </div>
              ))}
            </>);
          })()}
        </RC>

      </div>
    </div>
  );
}

// ─── LEAVE BALANCES MANAGEMENT ────────────────────────────────────────────────
function LeaveBalancesView({users,setUsers,roles,user,balanceTypes=[],userBalances=[],setUserBalances}) {
  const [filter,setFilter]=useState("");
  const [deptFilter,setDeptFilter]=useState("");
  const [editId,setEditId]=useState(null);
  const [editForm,setEditForm]=useState({}); // {balanceTypeId: {balance, used}}
  const [saving,setSaving]=useState(false);

  // Build map: userId -> balanceTypeId -> {balance, used}
  const balanceMap=useMemo(()=>{
    const m={};
    userBalances.forEach(b=>{
      m[b.user_id]=m[b.user_id]||{};
      m[b.user_id][b.balance_type_id]={balance:Number(b.balance||0),used:Number(b.used||0),color:b.balance_type_color};
    });
    return m;
  },[userBalances]);

  const activeTypes=balanceTypes.filter(b=>b.active!==false).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  const depts=[...new Set(users.filter(u=>u.dept).map(u=>u.dept))].sort();
  const filtered=users.filter(u=>u.active!==false)
    .filter(u=>!filter||u.name.toLowerCase().includes(filter.toLowerCase())||u.email?.toLowerCase().includes(filter.toLowerCase()))
    .filter(u=>!deptFilter||u.dept===deptFilter)
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  function startEdit(u){
    setEditId(u.id);
    const form={};
    activeTypes.forEach(bt=>{
      const b=balanceMap[u.id]?.[bt.id]||{balance:Number(bt.default_balance||0),used:0};
      form[bt.id]={balance:b.balance,used:b.used};
    });
    setEditForm(form);
  }
  async function saveBalance(){
    setSaving(true);
    try{
      const updates=[];
      for(const bt of activeTypes){
        const f=editForm[bt.id];if(!f)continue;
        updates.push(userBalancesAPI.update({userId:editId,balanceTypeId:bt.id,balance:f.balance,used:f.used}));
      }
      await Promise.all(updates);
      // Reload user balances
      const fresh=await userBalancesAPI.getAll();
      setUserBalances(fresh);
      setEditId(null);
    }catch(e){toast("Failed to save: "+e.message);}
    setSaving(false);
  }

  // Summary totals per type
  const typeTotals=activeTypes.map(bt=>({
    type:bt,
    totBalance:filtered.reduce((s,u)=>s+(balanceMap[u.id]?.[bt.id]?.balance||0),0),
    totUsed:filtered.reduce((s,u)=>s+(balanceMap[u.id]?.[bt.id]?.used||0),0),
  }));

  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:`repeat(auto-fill,minmax(180px,1fr))`,gap:10,marginBottom:16}}>
        {typeTotals.map(tt=>(
          <div key={tt.type.id} className="card" style={{padding:"10px 12px"}}>
            <div style={{fontSize:11,color:"var(--t3)",fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>{tt.type.name}</div>
            <div style={{fontSize:18,fontWeight:700,color:tt.type.color||"#10b981",marginTop:2}}>{tt.totBalance-tt.totUsed}<span style={{fontSize:11,color:"var(--t3)",marginLeft:4,fontWeight:400}}>/ {tt.totBalance}d</span></div>
            <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{tt.totUsed}d used</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
        <input className="fi" placeholder="Search by name or email..." value={filter} onChange={e=>setFilter(e.target.value)} style={{flex:1,minWidth:200,maxWidth:300}}/>
        <select className="fi" value={deptFilter} onChange={e=>setDeptFilter(e.target.value)} style={{maxWidth:180}}>
          <option value="">All Departments</option>
          {depts.map(d=><option key={d} value={d}>{d}</option>)}
        </select>
        <span style={{fontSize:12,color:"var(--t3)"}}>{filtered.length} employees</span>
      </div>
      <div className="tw">
        <table className="tbl">
          <thead><tr>
            <th>Employee</th><th>Department</th><th>Type</th>
            {activeTypes.map(bt=><th key={bt.id} style={{textAlign:"center",color:bt.color||"var(--gr)"}} colSpan={2}>{bt.name}</th>)}
            <th style={{width:100}}/>
          </tr><tr>
            <th colSpan={3} style={{borderBottom:"none"}}/>
            {activeTypes.map(bt=><React.Fragment key={bt.id}><th style={{textAlign:"center",fontSize:10,fontWeight:400,color:"var(--t3)"}}>Total</th><th style={{textAlign:"center",fontSize:10,fontWeight:400,color:"var(--t3)"}}>Used</th></React.Fragment>)}
            <th/>
          </tr></thead>
          <tbody>
            {filtered.map(u=>{
              const isEditing=editId===u.id;
              return(
                <tr key={u.id}>
                  <td><div style={{fontWeight:600,fontSize:13}}>{u.name}</div><div style={{fontSize:11,color:"var(--t3)"}}>{u.email}</div></td>
                  <td>{u.dept||"—"}</td>
                  <td><span className={`badge ${u.type==="field"?"bsk":"bv"}`}>{u.type==="field"?"Field":"Office"}</span></td>
                  {activeTypes.map(bt=>{
                    const b=balanceMap[u.id]?.[bt.id]||{balance:0,used:0};
                    const rem=Math.max(0,b.balance-b.used);
                    return(
                      <React.Fragment key={bt.id}>
                        <td style={{textAlign:"center"}}>
                          {isEditing?<input type="number" step="0.5" className="fi" style={{width:55,textAlign:"center",padding:"4px",fontSize:12}} value={editForm[bt.id]?.balance??0} onChange={e=>setEditForm(f=>({...f,[bt.id]:{...f[bt.id],balance:Number(e.target.value)}}))}/>:<span style={{fontWeight:600,fontSize:12}}>{b.balance}</span>}
                        </td>
                        <td style={{textAlign:"center"}}>
                          {isEditing?<input type="number" step="0.5" className="fi" style={{width:55,textAlign:"center",padding:"4px",fontSize:12}} value={editForm[bt.id]?.used??0} onChange={e=>setEditForm(f=>({...f,[bt.id]:{...f[bt.id],used:Number(e.target.value)}}))}/>:<span style={{fontWeight:600,fontSize:12,color:b.used>0?"var(--am)":"var(--t3)"}}>{b.used}</span>}
                          {!isEditing&&<div style={{fontSize:9,color:rem<=2?"var(--re)":rem<=5?"var(--am)":"var(--gr)"}}>({rem} left)</div>}
                        </td>
                      </React.Fragment>
                    );
                  })}
                  <td style={{textAlign:"right"}}>
                    {isEditing?(
                      <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                        <button className="btn bp bsm" onClick={saveBalance} disabled={saving}>{saving?"...":"Save"}</button>
                        <button className="btn bo bsm" onClick={()=>setEditId(null)}>Cancel</button>
                      </div>
                    ):(
                      <button className="btn bo bsm" onClick={()=>startEdit(u)}>Edit</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CREW ROTATION PLANNER (field employees, 6-month grid view) ──────────────
function CrewPlannerView({user,users,requests=[],rotations=[],setRotationPlans,roles,canManage=false}) {
  const today=new Date();
  const [startMonth,setStartMonth]=useState(new Date(today.getFullYear(),today.getMonth(),1));
  const [deptFilter,setDeptFilter]=useState("");
  const [monthsToShow,setMonthsToShow]=useState(6);
  const [manageModal,setManageModal]=useState(null); // user object whose rotations are being edited
  const [rotForm,setRotForm]=useState({onStart:"",onEnd:"",editId:null});
  const [saving,setSaving]=useState(false);

  // Only field employees, filtered
  const fieldUsers=useMemo(()=>users.filter(u=>u.type==="field"&&u.active!==false&&(!deptFilter||u.dept===deptFilter)).sort((a,b)=>(a.name||"").localeCompare(b.name||"")),[users,deptFilter]);
  const depts=useMemo(()=>[...new Set(users.filter(u=>u.type==="field"&&u.dept).map(u=>u.dept))].sort(),[users]);

  // Build list of all dates in the visible window
  const dates=useMemo(()=>{
    const arr=[];
    const end=new Date(startMonth);end.setMonth(end.getMonth()+monthsToShow);
    for(let d=new Date(startMonth);d<end;d.setDate(d.getDate()+1)){
      arr.push(new Date(d));
    }
    return arr;
  },[startMonth,monthsToShow]);

  // Index leave requests by user and date for fast lookup
  const leaveMap=useMemo(()=>{
    const m={};
    const LEAVE_TYPES=["Annual Leave","Sick Leave","Compassionate","Recovery Leave","Remote Work","Mission","Training","Other Mission","Extra Days"];
    requests.filter(r=>LEAVE_TYPES.includes(r.type)&&(r.status==="Approved"||r.status==="Pending"||r.status==="Pending L2")).forEach(r=>{
      const s=new Date(r.start),e=new Date(r.end);
      for(let d=new Date(s);d<=e;d.setDate(d.getDate()+1)){
        const ds=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
        m[r.userId]=m[r.userId]||{};
        if(!m[r.userId][ds]||r.status==="Approved") m[r.userId][ds]={type:r.type,status:r.status};
      }
    });
    return m;
  },[requests]);

  // For each cell, determine status
  function getCellStatus(uid,d){
    const ds=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const isWeekend=d.getDay()===0||d.getDay()===6;
    const isHoliday=isHol(ds);
    const leave=leaveMap[uid]?.[ds];
    const rot=getFieldDayType(uid,ds,rotations);
    if(leave) return {code:leave.status==="Approved"?"leave":"leave-pending",label:leave.type,rot};
    if(isHoliday) return {code:"hol",label:"Holiday",rot};
    if(isWeekend) return {code:"we",label:"Weekend",rot};
    return {code:rot.toLowerCase(),label:rot,rot};
  }

  // Daily on-site headcount (ON minus Leave)
  const dailyCoverage=useMemo(()=>{
    return dates.map(d=>{
      let onSite=0,onLeave=0,pendingLeave=0;
      fieldUsers.forEach(u=>{
        const st=getCellStatus(u.id,d);
        if(st.code==="on") onSite++;
        else if(st.code==="leave"&&st.rot==="ON") onLeave++;
        else if(st.code==="leave-pending"&&st.rot==="ON") pendingLeave++;
      });
      return {date:d,onSite,onLeave,pendingLeave};
    });
  },[dates,fieldUsers,leaveMap,rotations]);

  const COLORS_MAP={
    on:{bg:"#dcfce7",fg:"#166534",lbl:"ON"},
    off:{bg:"#f1f5f9",fg:"#64748b",lbl:"OFF"},
    extra:{bg:"#ede9fe",fg:"#5b21b6",lbl:"EXTRA"},
    leave:{bg:"#fef3c7",fg:"#92400e",lbl:"LV"},
    "leave-pending":{bg:"#fed7aa",fg:"#9a3412",lbl:"LV?"},
    we:{bg:"#f8fafc",fg:"#cbd5e1",lbl:""},
    hol:{bg:"#fee2e2",fg:"#991b1b",lbl:"PH"},
  };

  function exportCSV(){
    const rows=[["Employee","Dept",...dates.map(d=>`${pad(d.getDate())}-${pad(d.getMonth()+1)}`)]];
    fieldUsers.forEach(u=>{
      rows.push([u.name,u.dept||"",...dates.map(d=>getCellStatus(u.id,d).label)]);
    });
    rows.push(["Coverage (On-Site)","",...dailyCoverage.map(c=>c.onSite)]);
    downloadXLSX(rows,`crew-rotation-${startMonth.getFullYear()}-${pad(startMonth.getMonth()+1)}`);
  }

  function prevMonths(){const d=new Date(startMonth);d.setMonth(d.getMonth()-1);setStartMonth(d);}
  function nextMonths(){const d=new Date(startMonth);d.setMonth(d.getMonth()+1);setStartMonth(d);}
  function goToday(){setStartMonth(new Date(today.getFullYear(),today.getMonth(),1));}

  // ── CSV import ─────────────────────────────────────────────────────────────
  const [importResult,setImportResult]=useState(null);
  const [importing,setImporting]=useState(false);

  function downloadRotationTemplate(){
    const rows=[
      ["payroll_id","on_start","on_end"],
      ["EMP-0001","2026-01-01","2026-01-14"],
      ["EMP-0001","2026-01-29","2026-02-11"],
      ["EMP-0002","2026-01-08","2026-01-21"],
    ];
    const csv=rows.map(r=>r.join(",")).join("\n");
    const a=document.createElement("a");
    a.href="data:text/csv;charset=utf-8,"+encodeURIComponent(csv);
    a.download="rotations-import-template.csv";
    a.click();
  }

  async function handleImportFile(e){
    const file=e.target.files?.[0];if(!file)return;
    setImporting(true);setImportResult(null);
    try{
      const text=await file.text();
      // Simple CSV parser — accepts comma or semicolon separators
      const lines=text.split(/\r?\n/).filter(l=>l.trim());
      if(lines.length<2){toast("CSV is empty.");setImporting(false);return;}
      const sep=lines[0].includes(";")?";":",";
      const headers=lines[0].split(sep).map(s=>s.trim().toLowerCase());
      const rows=lines.slice(1).map(line=>{
        const parts=line.split(sep).map(s=>s.trim());
        const row={};headers.forEach((h,i)=>{row[h]=parts[i]||"";});
        return row;
      });
      const res=await rotationAPI.importCSV(rows);
      setImportResult(res);
      // Refresh rotations list
      if(res.created>0){
        const fresh=await rotationAPI.getAll();
        setRotationPlans(fresh.map(r=>({id:r.id,userId:r.user_id,onStart:r.on_start,onEnd:r.on_end})));
      }
    }catch(err){toast("Import failed: "+err.message);}
    setImporting(false);
    e.target.value="";
  }

  // Rotations for a specific user, sorted by start date
  function userRotations(uid){
    return rotations.filter(r=>r.userId===uid).sort((a,b)=>new Date(a.onStart)-new Date(b.onStart));
  }

  async function saveRotation(){
    if(!rotForm.onStart||!rotForm.onEnd){toast("Both dates required.");return;}
    if(new Date(rotForm.onEnd)<new Date(rotForm.onStart)){toast("End date must be on or after start date.");return;}
    setSaving(true);
    try{
      if(rotForm.editId){
        const r=await rotationAPI.update(rotForm.editId,{onStart:rotForm.onStart,onEnd:rotForm.onEnd});
        setRotationPlans(p=>p.map(x=>x.id===rotForm.editId?{id:r.id,userId:r.user_id,onStart:r.on_start,onEnd:r.on_end}:x));
      }else{
        const r=await rotationAPI.create({userId:manageModal.id,onStart:rotForm.onStart,onEnd:rotForm.onEnd});
        setRotationPlans(p=>[...p,{id:r.id,userId:r.user_id,onStart:r.on_start,onEnd:r.on_end}]);
      }
      setRotForm({onStart:"",onEnd:"",editId:null});
    }catch(err){toast("Failed to save: "+err.message);}
    setSaving(false);
  }

  async function deleteRotation(id){
    if(!window.confirm("Delete this rotation plan?"))return;
    try{
      await rotationAPI.delete(id);
      setRotationPlans(p=>p.filter(x=>x.id!==id));
    }catch(err){toast("Failed to delete: "+err.message);}
  }

  function startEditRotation(r){
    setRotForm({onStart:r.onStart?.slice(0,10)||r.onStart,onEnd:r.onEnd?.slice(0,10)||r.onEnd,editId:r.id});
  }

  // Group dates by month for the header
  const monthHeaders=useMemo(()=>{
    const groups={};
    dates.forEach((d,idx)=>{
      const key=`${d.getFullYear()}-${d.getMonth()}`;
      if(!groups[key]) groups[key]={label:`${MONTHS[d.getMonth()]} ${d.getFullYear()}`,startIdx:idx,count:0};
      groups[key].count++;
    });
    return Object.values(groups);
  },[dates]);

  return(
    <div>
      <div style={{padding:"10px 14px",background:"var(--vl)",borderRadius:"var(--rs)",border:"1px solid var(--v)",marginBottom:12,fontSize:12,lineHeight:1.4}}>
        <strong>👷 Crew Rotation Planner</strong> — visual tool to coordinate field crew rotations, ensure site coverage, and plan annual leave windows. Shows ON/OFF cycles with approved (yellow) and pending (orange) leave overlaid.
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
        <button className="btn bo bsm" onClick={prevMonths}>‹ Prev Month</button>
        <button className="btn bo bsm" onClick={goToday}>Today</button>
        <button className="btn bo bsm" onClick={nextMonths}>Next Month ›</button>
        <span style={{fontSize:13,fontWeight:700,marginLeft:6}}>
          {MONTHS[startMonth.getMonth()]} {startMonth.getFullYear()} — {MONTHS[(startMonth.getMonth()+monthsToShow-1)%12]} {startMonth.getFullYear()+Math.floor((startMonth.getMonth()+monthsToShow-1)/12)}
        </span>
        <div style={{flex:1}}/>
        <label style={{fontSize:12,color:"var(--t3)"}}>Window:</label>
        <select className="fi" value={monthsToShow} onChange={e=>setMonthsToShow(Number(e.target.value))} style={{width:90,padding:"4px 6px",fontSize:12}}>
          <option value={3}>3 months</option>
          <option value={6}>6 months</option>
          <option value={9}>9 months</option>
          <option value={12}>12 months</option>
        </select>
        <select className="fi" value={deptFilter} onChange={e=>setDeptFilter(e.target.value)} style={{maxWidth:160,fontSize:12}}>
          <option value="">All Departments</option>
          {depts.map(d=><option key={d} value={d}>{d}</option>)}
        </select>
        {canManage&&<button className="btn bg2 bsm" onClick={downloadRotationTemplate} title="Download CSV template with date format info">⬇ Template</button>}
        {canManage&&<label className="btn bg2 bsm" style={{cursor:"pointer",margin:0}}><input type="file" accept=".csv" style={{display:"none"}} onChange={handleImportFile} disabled={importing}/>{importing?"Importing…":"📥 Import CSV"}</label>}
        <button className="btn bp bsm" onClick={exportCSV}>📊 Export</button>
      </div>
      {importResult&&(
        <div style={{marginBottom:10,padding:"10px 14px",background:importResult.errors?.length>0?"#fef3c7":"#dcfce7",border:`1px solid ${importResult.errors?.length>0?"#f59e0b":"#10b981"}`,borderRadius:"var(--rs)",fontSize:12}}>
          <div style={{fontWeight:700,marginBottom:4}}>Import result: <span style={{color:"#166534"}}>{importResult.created} rotation(s) imported</span>{importResult.errors?.length>0&&<span style={{color:"#92400e"}}> · {importResult.errors.length} error(s)</span>}</div>
          {importResult.errors?.length>0&&(
            <div style={{maxHeight:100,overflowY:"auto",fontSize:11,color:"#78350f"}}>
              {importResult.errors.slice(0,10).map((e,i)=><div key={i}>• Row {e.row}{e.payrollId?` [${e.payrollId}]`:""}: {e.reason}</div>)}
              {importResult.errors.length>10&&<div>…and {importResult.errors.length-10} more</div>}
            </div>
          )}
          <button className="btn bo bxs" style={{marginTop:6}} onClick={()=>setImportResult(null)}>Dismiss</button>
        </div>
      )}
      {canManage&&(
        <div style={{padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:11,color:"var(--t3)",marginBottom:12,fontFamily:"'JetBrains Mono',monospace"}}>
          📋 CSV columns: <b>payroll_id</b>, <b>on_start</b>, <b>on_end</b> (dates in <b>YYYY-MM-DD</b> format, e.g. 2026-04-15). One row per rotation period.
        </div>
      )}

      {/* Legend */}
      <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap",fontSize:11}}>
        {Object.entries(COLORS_MAP).filter(([k])=>["on","off","extra","leave","leave-pending","hol"].includes(k)).map(([k,v])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{display:"inline-block",width:20,height:14,background:v.bg,border:`1px solid ${v.fg}40`,borderRadius:3}}/>
            <span style={{color:"var(--t3)"}}>{k==="on"?"On Site":k==="off"?"Off Rotation":k==="extra"?"Extra":k==="leave"?"Approved Leave":k==="leave-pending"?"Pending Leave":"Holiday"}</span>
          </div>
        ))}
      </div>

      <div style={{overflow:"auto",border:"1px solid var(--b)",borderRadius:"var(--rs)",maxHeight:"70vh"}}>
        <table style={{borderCollapse:"separate",borderSpacing:0,fontSize:10,fontFamily:"'JetBrains Mono',monospace",minWidth:"100%"}}>
          <thead>
            <tr style={{position:"sticky",top:0,zIndex:3,background:"var(--surface)"}}>
              <th style={{position:"sticky",left:0,background:"var(--s2)",zIndex:4,padding:"6px 10px",border:"1px solid var(--b)",minWidth:160,textAlign:"left",fontSize:11}}>Employee</th>
              {monthHeaders.map((mh,i)=>(
                <th key={i} colSpan={mh.count} style={{padding:"6px 4px",border:"1px solid var(--b)",background:"var(--s2)",textAlign:"center",fontSize:11}}>{mh.label}</th>
              ))}
            </tr>
            <tr style={{position:"sticky",top:28,zIndex:3,background:"var(--surface)"}}>
              <th style={{position:"sticky",left:0,background:"var(--s2)",zIndex:4,padding:"4px 10px",border:"1px solid var(--b)",fontSize:10,fontWeight:400,color:"var(--t3)"}}>{fieldUsers.length} field employees</th>
              {dates.map((d,i)=>{
                const todayStr=today.toISOString().slice(0,10);
                const ds=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
                const isToday=ds===todayStr;
                const isWeekend=d.getDay()===0||d.getDay()===6;
                return <th key={i} style={{padding:"2px 3px",border:"1px solid var(--b)",background:isToday?"var(--vl)":isWeekend?"#f8fafc":"var(--surface)",textAlign:"center",minWidth:22,fontWeight:isToday?700:400,color:isToday?"var(--v)":"var(--t3)"}}>
                  <div style={{fontSize:9}}>{DS[d.getDay()][0]}</div>
                  <div style={{fontSize:10}}>{d.getDate()}</div>
                </th>;
              })}
            </tr>
          </thead>
          <tbody>
            {fieldUsers.map(u=>(
              <tr key={u.id}>
                <td style={{position:"sticky",left:0,background:"var(--surface)",zIndex:1,padding:"3px 10px",border:"1px solid var(--b)",whiteSpace:"nowrap",fontFamily:"inherit"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"space-between"}}>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600}}>{u.name}</div>
                      <div style={{fontSize:10,color:"var(--t3)"}}>{u.payrollId?`#${u.payrollId} · `:""}{u.dept||""} · {userRotations(u.id).length} rot</div>
                    </div>
                    {canManage&&<button className="btn bo bxs" style={{fontSize:10,padding:"2px 6px"}} onClick={()=>{setManageModal(u);setRotForm({onStart:"",onEnd:"",editId:null});}}>✏️</button>}
                  </div>
                </td>
                {dates.map((d,i)=>{
                  const st=getCellStatus(u.id,d);
                  const c=COLORS_MAP[st.code]||COLORS_MAP.we;
                  return <td key={i} title={`${u.name} · ${d.toISOString().slice(0,10)} · ${st.label}`} style={{padding:0,border:"1px solid var(--b)",background:c.bg,color:c.fg,textAlign:"center",fontSize:9,fontWeight:600,minWidth:22,height:22}}>{c.lbl}</td>;
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{position:"sticky",bottom:0,background:"var(--s2)",zIndex:2}}>
              <td style={{position:"sticky",left:0,background:"var(--s2)",zIndex:3,padding:"4px 10px",border:"1px solid var(--b)",fontSize:11,fontWeight:700}}>On-site Coverage</td>
              {dailyCoverage.map((c,i)=>{
                const low=c.onSite<2;
                return <td key={i} title={`${c.onSite} on-site · ${c.onLeave} on leave · ${c.pendingLeave} pending leave`} style={{padding:"2px",border:"1px solid var(--b)",background:low?"#fee2e2":c.onSite>=4?"#dcfce7":"var(--surface)",color:low?"#991b1b":"var(--t)",textAlign:"center",fontSize:10,fontWeight:700,minWidth:22}}>{c.onSite}</td>;
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── Manage Rotations Modal ── */}
      {manageModal&&(()=>{
        const urots=userRotations(manageModal.id);
        const toISO=d=>{ if(!d) return ""; if(typeof d==="string") return d.slice(0,10); try{return new Date(d).toISOString().slice(0,10);}catch{return String(d);} };
        const todayIso=today.toISOString().slice(0,10);
        return(
        <div className="mo" onClick={e=>e.target.className==="mo"&&(setManageModal(null),setRotForm({onStart:"",onEnd:"",editId:null}))}>
          <div className="md" style={{maxWidth:760,width:"95vw",maxHeight:"90vh",overflowY:"auto",padding:0}}>
            {/* Employee header */}
            <div style={{padding:"16px 20px",borderBottom:"1px solid var(--b)",display:"flex",alignItems:"center",gap:12,background:"var(--s2)"}}>
              <div className="av" style={{background:aColor(manageModal.id),width:42,height:42,fontSize:14,borderRadius:8}}>{initials(manageModal.name)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:16,fontWeight:700}}>{manageModal.name}</div>
                <div style={{fontSize:12,color:"var(--t3)",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginTop:2}}>
                  {manageModal.payrollId&&<span style={{fontFamily:"'JetBrains Mono',monospace",background:"var(--vl)",color:"var(--v)",padding:"1px 6px",borderRadius:3,fontWeight:600}}>#{manageModal.payrollId}</span>}
                  <span>{manageModal.dept||"—"}</span>
                  <span>·</span>
                  <span className="badge bsk" style={{fontSize:10}}>Field</span>
                </div>
              </div>
              <button className="btn bo bsm" onClick={()=>{setManageModal(null);setRotForm({onStart:"",onEnd:"",editId:null});}}>✕ Close</button>
            </div>

            <div style={{padding:"16px 20px"}}>
              {/* Rotation list */}
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{fontSize:13,fontWeight:700}}>Rotation Plans</div>
                <span className="badge bgr2" style={{fontSize:10}}>{urots.length} defined</span>
              </div>
              {urots.length===0?
                <div style={{fontSize:12,color:"var(--t3)",padding:"16px",background:"var(--s2)",borderRadius:"var(--rs)",textAlign:"center",fontStyle:"italic",marginBottom:14}}>
                  No rotations defined yet — using the default 14/14 cycle from 2025-01-01.
                </div>
              :
                <div className="tw" style={{marginBottom:14}}>
                  <table className="tbl" style={{fontSize:12}}>
                    <thead><tr>
                      <th style={{width:40,textAlign:"center"}}>#</th>
                      <th>ON Start</th>
                      <th>ON End</th>
                      <th style={{textAlign:"center"}}>Days</th>
                      <th>OFF Period</th>
                      <th style={{textAlign:"right",width:120}}>Actions</th>
                    </tr></thead>
                    <tbody>
                      {urots.map((r,idx)=>{
                        const onStart=toISO(r.onStart);
                        const onEnd=toISO(r.onEnd);
                        const onDays=onStart&&onEnd?Math.floor((new Date(onEnd)-new Date(onStart))/86400000)+1:0;
                        const offStart=new Date(onEnd);offStart.setDate(offStart.getDate()+1);
                        const offEnd=new Date(onEnd);offEnd.setDate(offEnd.getDate()+onDays);
                        const offStartStr=offStart.toISOString().slice(0,10);
                        const offEndStr=offEnd.toISOString().slice(0,10);
                        const isCurrent=todayIso>=onStart&&todayIso<=offEndStr;
                        const isPast=todayIso>offEndStr;
                        const rowBg=isCurrent?"var(--vl)":isPast?"transparent":"transparent";
                        return(
                          <tr key={r.id} style={{background:rowBg}}>
                            <td style={{textAlign:"center",fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)",fontSize:11}}>{idx+1}</td>
                            <td style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>
                              {isCurrent&&<span style={{background:"#dcfce7",color:"#166534",padding:"1px 5px",borderRadius:3,fontSize:9,fontWeight:700,marginRight:6}}>NOW</span>}
                              {onStart}
                            </td>
                            <td style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{onEnd}</td>
                            <td style={{textAlign:"center",fontWeight:700,color:"#166534"}}>{onDays}d</td>
                            <td style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>
                              {offStartStr} → {offEndStr}
                            </td>
                            <td style={{textAlign:"right"}}>
                              <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                                <button className="btn bo bxs" onClick={()=>startEditRotation(r)}>Edit</button>
                                <button className="btn bd bxs" onClick={()=>deleteRotation(r.id)}>🗑</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              }

              {/* Add / Edit form */}
              <div style={{padding:"14px 16px",background:rotForm.editId?"var(--aml)":"var(--vl)",borderRadius:"var(--rs)",border:`1px solid ${rotForm.editId?"var(--am)":"var(--v)"}`}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
                  <span style={{fontSize:14}}>{rotForm.editId?"✏️":"➕"}</span>
                  <div style={{fontSize:13,fontWeight:700,color:rotForm.editId?"var(--am)":"var(--v)"}}>{rotForm.editId?`Editing rotation #${urots.findIndex(r=>r.id===rotForm.editId)+1}`:"Add New Rotation"}</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,alignItems:"end"}}>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--t2)",display:"block",marginBottom:4}}>ON Start Date</label>
                    <input type="date" className="fi" value={rotForm.onStart} onChange={e=>setRotForm(f=>({...f,onStart:e.target.value}))}/>
                  </div>
                  <div>
                    <label style={{fontSize:11,fontWeight:600,color:"var(--t2)",display:"block",marginBottom:4}}>ON End Date</label>
                    <input type="date" className="fi" value={rotForm.onEnd} onChange={e=>setRotForm(f=>({...f,onEnd:e.target.value}))}/>
                  </div>
                </div>
                {rotForm.onStart&&rotForm.onEnd&&new Date(rotForm.onEnd)>=new Date(rotForm.onStart)&&(()=>{
                  const onDays=Math.floor((new Date(rotForm.onEnd)-new Date(rotForm.onStart))/86400000)+1;
                  const offStart=new Date(rotForm.onEnd);offStart.setDate(offStart.getDate()+1);
                  const offEnd=new Date(rotForm.onEnd);offEnd.setDate(offEnd.getDate()+onDays);
                  return(
                    <div style={{marginTop:10,padding:"8px 12px",background:"var(--surface)",borderRadius:"var(--rs)",fontSize:11,color:"var(--t2)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                      <span style={{fontWeight:700}}>Preview:</span>
                      <span className="badge" style={{background:"#dcfce7",color:"#166534",fontSize:10}}>{onDays}/{onDays} cycle</span>
                      <span style={{color:"var(--t3)"}}>OFF: {offStart.toISOString().slice(0,10)} → {offEnd.toISOString().slice(0,10)}</span>
                    </div>
                  );
                })()}
                <div style={{display:"flex",gap:6,marginTop:12,justifyContent:"flex-end"}}>
                  {rotForm.editId&&<button className="btn bo bsm" onClick={()=>setRotForm({onStart:"",onEnd:"",editId:null})}>Cancel Edit</button>}
                  <button className="btn bp bsm" onClick={saveRotation} disabled={saving||!rotForm.onStart||!rotForm.onEnd}>{saving?"Saving…":rotForm.editId?"💾 Save Changes":"➕ Add Rotation"}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

// ─── HR REPORT ────────────────────────────────────────────────────────────────
function HRReport({users,tsStatuses,activities}) {
  const now=new Date();
  const [tab,setTab]=useState("field");
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth());
  const [summary,setSummary]=useState({}); // {userId: {activity: days}}

  useEffect(()=>{
    payrollAPI.getSummary(year,month+1).then(rows=>{
      const m={};
      rows.forEach(r=>{if(!m[r.user_id])m[r.user_id]={};m[r.user_id][r.activity]=(m[r.user_id][r.activity]||0)+Number(r.days);});
      setSummary(m);
    }).catch(()=>{});
  },[year,month]);

  const list=users.filter(u=>u.active&&u.type===tab);
  const LEAVE_ACTS=activities.filter(a=>a.isLeave).map(a=>a.name);

  function gs(u){
    const s=summary[u.id]||{};
    const workedDays=Object.entries(s).filter(([a])=>!LEAVE_ACTS.includes(a)).reduce((t,[,d])=>t+d,0);
    return{
      wd:workedDays||"—",
      al:s["Annual Leave"]||0,
      sl:s["Sick Leave"]||0,
      rw:s["Remote Work"]||0,
      ms:(s["Mission"]||0)+(s["Mission Office"]||0)+(s["Other Mission"]||0),
      tr:s["Training"]||0,
      ns:s["Night Shift"]||0,
      rc:s["Recovery Leave"]||0,
    };
  }

  const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mono={fontFamily:"'JetBrains Mono',monospace"};
  const numCell=v=><td style={mono}>{v||<span style={{color:"var(--t3)"}}>0</span>}</td>;

  return (
    <div>
      {/* Month/Year navigation */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <button className="btn bo bsm" onClick={()=>{if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
        <span style={{fontWeight:700,fontSize:15,minWidth:100,textAlign:"center"}}>{MN[month]} {year}</span>
        <button className="btn bo bsm" onClick={()=>{if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <div className="tabs" style={{margin:0}}><div className={`tab ${tab==="field"?"active":""}`} onClick={()=>setTab("field")}>⛽ Field</div><div className={`tab ${tab==="office"?"active":""}`} onClick={()=>setTab("office")}>🏢 Office</div></div>
          <button className="btn bo bsm" title="Export XLSX" onClick={()=>{
            const MN2=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            const isField=tab==="field";
            const hdr=isField?["Employee","Dept","Worked Days","Annual Leave","Sick Leave","Night Shift","Mission","Recovery","TS Status"]:["Employee","Dept","Worked Days","Annual Leave","Sick Leave","Remote Work","Mission","Training","Recovery","TS Status"];
            const rows=[hdr,...list.map(u=>{const g=gs(u);const tsk=Object.values(tsStatuses).find(ts=>ts.userId===u.id&&ts.year===year&&ts.month===month+1)?.status||"—";return isField?[u.name,u.dept||"",g.wd,g.al,g.sl,g.ns,g.ms,g.rc,tsk]:[u.name,u.dept||"",g.wd,g.al,g.sl,g.rw,g.ms,g.tr,g.rc,tsk];})];
            downloadXLSX(rows,`hr-report-${MN[month]}-${year}-${tab}`);
          }}>⬇ XLSX</button>
          <button className="btn bo bsm" title="Print / Save as PDF" onClick={printPage}>🖨 PDF</button>
        </div>
      </div>

      <div className="tw" style={{marginBottom:14}}>
        <table className="tbl">
          <thead><tr>
            <th>Employee</th>
            <th>Worked Days</th>
            <th>Annual Leave</th>
            <th>Sick Leave</th>
            {tab==="field"?<><th>Night Shift</th><th>Mission</th></>:<><th>Remote Work</th><th>Mission</th><th>Training</th></>}
            <th>Recovery</th>
            <th>TS Status</th>
          </tr></thead>
          <tbody>{list.map(u=>{
            const s=gs(u);
            const k=tsKey(u.id,year,month);
            const tss=tsStatuses[k]?.status||"draft";
            return(<tr key={u.id}>
              <td><div style={{display:"flex",alignItems:"center",gap:9}}><div className="av" style={{background:aColor(u.id)}}>{initials(u.name)}</div><div><div style={{fontWeight:700}}>{u.name}</div><div style={{fontSize:11,color:"var(--t3)"}}>{u.dept}</div></div></div></td>
              <td><strong style={{color:"var(--v)",...mono}}>{s.wd}</strong></td>
              {numCell(s.al)}
              {numCell(s.sl)}
              {tab==="field"?<>{numCell(s.ns)}{numCell(s.ms)}</>:<>{numCell(s.rw)}{numCell(s.ms)}{numCell(s.tr)}</>}
              {numCell(s.rc)}
              <td><TSStatusBadge status={tss}/></td>
            </tr>);
          })}</tbody>
        </table>
      </div>
      <div className="card"><div className="shd">Leave Balance Overview</div>{users.filter(u=>u.active).map(u=>{const pct=u.leaveBalance>0?Math.round((u.usedLeave/u.leaveBalance)*100):0;const rem=Number(u.leaveBalance)-Number(u.usedLeave);const rec=Number(u.recoveryBalance||0);return(<div className="lb-row" key={u.id}><div className="av" style={{background:aColor(u.id)}}>{initials(u.name)}</div><div className="lb-nm">{u.name}</div><TypeBadge type={u.type}/><div className="lb-bw"><div className="prog"><div className="prog-f" style={{width:`${pct}%`,background:pct>80?"var(--re)":pct>50?"var(--am)":"var(--gr)"}}/></div></div><div className="lb-v" style={{color:pct>80?"var(--re)":pct>50?"var(--am)":"var(--t2)"}}>{rem}d AL</div>{u.type==="field"&&<div className="lb-v" style={{color:"var(--v)",fontSize:11}} title="Recovery balance">🔄 {rec}d</div>}</div>);})}</div>
    </div>
  );
}

// ─── PUSH SETTINGS CARD (used inside Settings > system tab) ──────────────────
function PushSettingsCard() {
  const DEF={push_notify_new_request:true,push_notify_request_decision:true,push_notify_ts_submit:true,push_notify_ts_decision:true};
  const [cfg,setCfg]=useState(DEF);
  const [stats,setStats]=useState(null);
  const [saving,setSaving]=useState(false);
  const [testing,setTesting]=useState(false);
  const [msg,setMsg]=useState("");

  useEffect(()=>{
    pushAPI.getStats().then(s=>setStats(s)).catch(()=>{});
    // Load current push settings from email_settings via a dedicated endpoint
    fetch('/api/push/settings',{headers:{'Authorization':'Bearer '+localStorage.getItem('token')}})
      .then(r=>r.ok?r.json():null).then(d=>{if(d)setCfg(c=>({...c,...d}));}).catch(()=>{});
  },[]);

  async function save(){
    setSaving(true);setMsg("");
    try{await pushAPI.saveSettings(cfg);setMsg("✅ Saved");}
    catch(e){setMsg("❌ "+e.message);}
    finally{setSaving(false);}
  }
  async function test(){
    setTesting(true);setMsg("");
    try{await pushAPI.test();setMsg("✅ Test push sent to your browser");}
    catch(e){setMsg("❌ "+e.message);}
    finally{setTesting(false);}
  }

  const supported='serviceWorker' in navigator && 'PushManager' in window;
  return(
    <div>
      <div className="card-title" style={{marginBottom:12}}>🔔 Push Notifications</div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:7,background:"var(--grl)",borderRadius:6,padding:"5px 10px",fontSize:12}}>
          <span style={{color:"var(--gr)",fontWeight:700}}>✓</span> VAPID keys {stats?.vapidReady?"ready":"pending"}
        </div>
        {stats!=null&&<div style={{fontSize:12,color:"var(--t3)"}}>{stats.total} active subscription{stats.total!==1?"s":""}</div>}
        {!supported&&<div style={{fontSize:12,color:"var(--am)"}}>⚠️ Not supported in this browser</div>}
      </div>
      <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>Send push for:</div>
      {[["push_notify_new_request","New leave/extra-days request submitted → Approver"],
        ["push_notify_request_decision","Request approved or rejected → Employee"],
        ["push_notify_ts_submit","Timesheet submitted → Manager"],
        ["push_notify_ts_decision","Timesheet approved or rejected → Employee"]].map(([k,l])=>(
        <div key={k} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:"1px solid var(--b)"}}>
          <label className="sw"><input type="checkbox" checked={!!cfg[k]} onChange={e=>setCfg(c=>({...c,[k]:e.target.checked}))}/><span className="sldr"/></label>
          <span style={{fontSize:13}}>{l}</span>
        </div>
      ))}
      <div style={{display:"flex",gap:8,marginTop:14,alignItems:"center",flexWrap:"wrap"}}>
        <button className="btn bp bsm" onClick={save} disabled={saving}>{saving?"Saving…":"Save Settings"}</button>
        {supported&&<button className="btn bo bsm" onClick={test} disabled={testing}>{testing?"Sending…":"Send Test Push"}</button>}
        {msg&&<span style={{fontSize:12,color:msg.startsWith("✅")?"var(--gr)":"var(--re)"}}>{msg}</span>}
      </div>
    </div>
  );
}

// ─── WORKFLOW EDITOR ──────────────────────────────────────────────────────────

// ─── /WORKFLOW EDITOR ─────────────────────────────────────────────────────────

// ─── SETTINGS (abbreviated — same as v4 but with roles prop) ─────────────────
// ─── ENTITIES TAB ─────────────────────────────────────────────────────────────
function DepartmentsTab({departments,setDepartments}) {
  const [name,setName]=useState("");
  const [editing,setEditing]=useState(null);
  const [editName,setEditName]=useState("");

  async function add(){
    const n=name.trim();if(!n)return;
    try{const created=await departmentsAPI.create({name:n});setDepartments(p=>[...p,created]);setName("");}
    catch(err){toast('Failed: '+err.message);}
  }
  async function save(d){
    const n=editName.trim();if(!n)return;
    try{const updated=await departmentsAPI.update(d.id,{name:n,active:d.active!==false,sortOrder:d.sort_order||0});setDepartments(p=>p.map(x=>x.id===d.id?updated:x));setEditing(null);}
    catch(err){toast('Failed: '+err.message);}
  }
  async function toggle(d){
    try{const updated=await departmentsAPI.update(d.id,{name:d.name,active:d.active===false,sortOrder:d.sort_order||0});setDepartments(p=>p.map(x=>x.id===d.id?updated:x));}
    catch(err){toast('Failed: '+err.message);}
  }
  async function del(id){
    if(!window.confirm('Delete this department?'))return;
    try{await departmentsAPI.delete(id);setDepartments(p=>p.filter(x=>x.id!==id));}
    catch(err){toast('Failed: '+err.message);}
  }
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div><div style={{fontWeight:700,fontSize:15}}>Departments</div><div style={{fontSize:12,color:"var(--t3)"}}>{departments.filter(d=>d.active!==false).length} active · {departments.filter(d=>d.active===false).length} inactive</div></div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <input className="fi" placeholder="New department name..." value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} style={{flex:1,maxWidth:300}}/>
        <button className="btn bp bsm" onClick={add} disabled={!name.trim()}>+ Add</button>
      </div>
      <div className="tw"><table className="tbl"><thead><tr><th>Name</th><th>Status</th><th style={{width:140,textAlign:"right"}}>Actions</th></tr></thead><tbody>
        {departments.map(d=>(
          <tr key={d.id}>
            <td>{editing===d.id?<input className="fi" value={editName} onChange={e=>setEditName(e.target.value)} autoFocus/>:<span style={{fontWeight:600}}>{d.name}</span>}</td>
            <td><span className={`badge ${d.active!==false?"bgr":"bgr2"}`} style={{fontSize:10}}>{d.active!==false?"Active":"Inactive"}</span></td>
            <td style={{textAlign:"right"}}>
              {editing===d.id?
                <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}><button className="btn bp bxs" onClick={()=>save(d)}>Save</button><button className="btn bo bxs" onClick={()=>setEditing(null)}>Cancel</button></div>:
                <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}><button className="btn bg2 bxs" onClick={()=>{setEditing(d.id);setEditName(d.name);}}>✏️</button><label className="sw" style={{transform:"scale(.82)"}}><input type="checkbox" checked={d.active!==false} onChange={()=>toggle(d)}/><span className="sldr"/></label><button className="btn bd bxs" onClick={()=>del(d.id)}>🗑</button></div>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}

function BalanceTypesTab({balanceTypes,setBalanceTypes}) {
  const BLANK={name:"",code:"",defaultBalance:0,color:"#10b981"};
  const [form,setForm]=useState(BLANK);
  const [editId,setEditId]=useState(null);

  async function save(){
    if(!form.name.trim()||!form.code.trim())return;
    try{
      if(editId){
        const updated=await balanceTypesAPI.update(editId,{...form,active:true});
        setBalanceTypes(p=>p.map(x=>x.id===editId?updated:x));
      }else{
        const created=await balanceTypesAPI.create(form);
        setBalanceTypes(p=>[...p,created]);
      }
      setForm(BLANK);setEditId(null);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function del(id){
    if(!window.confirm('Delete this balance type? Related user balances will also be removed.'))return;
    try{await balanceTypesAPI.delete(id);setBalanceTypes(p=>p.filter(x=>x.id!==id));}
    catch(err){toast('Failed: '+err.message);}
  }
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div><div style={{fontWeight:700,fontSize:15}}>Balance Types</div><div style={{fontSize:12,color:"var(--t3)"}}>{balanceTypes.length} types defined</div></div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:14,padding:10,background:"var(--s2)",borderRadius:"var(--rs)",alignItems:"flex-end",flexWrap:"wrap"}}>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <label style={{fontSize:11,color:"var(--t3)"}}>Name</label>
          <input className="fi" placeholder="e.g. Sick Leave" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} style={{width:180}}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <label style={{fontSize:11,color:"var(--t3)"}}>Code</label>
          <input className="fi" placeholder="sick" value={form.code} onChange={e=>setForm(f=>({...f,code:e.target.value.toLowerCase().replace(/\s+/g,"_")}))} style={{width:120}}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <label style={{fontSize:11,color:"var(--t3)"}}>Default Days</label>
          <input type="number" step="0.5" className="fi" value={form.defaultBalance} onChange={e=>setForm(f=>({...f,defaultBalance:Number(e.target.value)}))} style={{width:90}}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:3}}>
          <label style={{fontSize:11,color:"var(--t3)"}}>Color</label>
          <input type="color" value={form.color} onChange={e=>setForm(f=>({...f,color:e.target.value}))} style={{width:42,height:32,border:"1px solid var(--b)",borderRadius:4,padding:0,cursor:"pointer"}}/>
        </div>
        <button className="btn bp bsm" onClick={save} disabled={!form.name.trim()||!form.code.trim()}>{editId?"Save":"+ Add"}</button>
        {editId&&<button className="btn bo bsm" onClick={()=>{setForm(BLANK);setEditId(null);}}>Cancel</button>}
      </div>
      <div className="tw"><table className="tbl"><thead><tr><th>Name</th><th>Code</th><th style={{textAlign:"center"}}>Default</th><th>Color</th><th style={{width:140,textAlign:"right"}}>Actions</th></tr></thead><tbody>
        {balanceTypes.map(b=>(
          <tr key={b.id}>
            <td style={{fontWeight:600}}>{b.name}</td>
            <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--t3)"}}>{b.code}</td>
            <td style={{textAlign:"center",fontWeight:700}}>{b.default_balance}d</td>
            <td><div style={{width:24,height:24,borderRadius:4,background:b.color||"#10b981",display:"inline-block"}}/></td>
            <td style={{textAlign:"right"}}>
              <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                <button className="btn bg2 bxs" onClick={()=>{setForm({name:b.name,code:b.code,defaultBalance:b.default_balance,color:b.color});setEditId(b.id);}}>✏️</button>
                <button className="btn bd bxs" onClick={()=>del(b.id)}>🗑</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}

function EntitiesTab({entities,setEntities}) {
  const [entForm,setEntForm]=useState({code:"",name:""});
  const [entEditing,setEntEditing]=useState(null);

  async function addEntity(){
    if(!entForm.code||!entForm.name)return;
    try{
      const created=await companyEntitiesAPI.create(entForm);
      setEntities(p=>[...p,created]);
      setEntForm({code:"",name:""});
    }catch(err){toast('Failed to create entity: '+err.message);}
  }

  async function saveEntity(id){
    try{
      const updated=await companyEntitiesAPI.update(id,entEditing);
      setEntities(p=>p.map(x=>x.id===id?updated:x));
      setEntEditing(null);
    }catch(err){toast('Failed to save entity: '+err.message);}
  }

  async function deleteEntity(id){
    if(!window.confirm("Delete this entity?"))return;
    try{
      await companyEntitiesAPI.delete(id);
      setEntities(p=>p.filter(x=>x.id!==id));
    }catch(err){toast(err.message||'Failed to delete entity');}
  }

  async function toggleActive(ent){
    try{
      const updated=await companyEntitiesAPI.update(ent.id,{...ent,active:!ent.active});
      setEntities(p=>p.map(x=>x.id===ent.id?updated:x));
    }catch(err){toast('Failed: '+err.message);}
  }

  return(
    <div>
      <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Company Entities</div>
      <div className="tw" style={{marginBottom:16}}>
        <table className="tbl">
          <thead><tr><th>Code</th><th>Name</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>
            {entities.map(ent=>(
              <tr key={ent.id}>
                {entEditing&&entEditing.id===ent.id?(
                  <>
                    <td><input className="fi" style={{width:70}} value={entEditing.code} onChange={e=>setEntEditing({...entEditing,code:e.target.value})}/></td>
                    <td><input className="fi" style={{width:200}} value={entEditing.name} onChange={e=>setEntEditing({...entEditing,name:e.target.value})}/></td>
                    <td><label className="sw"><input type="checkbox" checked={entEditing.active!==false} onChange={e=>setEntEditing({...entEditing,active:e.target.checked})}/><span className="sldr"/></label></td>
                    <td><div style={{display:"flex",gap:4}}><button className="btn bp bxs" onClick={()=>saveEntity(ent.id)}>💾</button><button className="btn bo bxs" onClick={()=>setEntEditing(null)}>✕</button></div></td>
                  </>
                ):(
                  <>
                    <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{ent.code}</span></td>
                    <td>{ent.name}</td>
                    <td><label className="sw"><input type="checkbox" checked={ent.active!==false} onChange={()=>toggleActive(ent)}/><span className="sldr"/></label></td>
                    <td><div style={{display:"flex",gap:4}}><button className="btn bg2 bxs" onClick={()=>setEntEditing({...ent})}>✏️</button><button className="btn bg2 bxs" onClick={()=>deleteEntity(ent.id)}>🗑</button></div></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <label style={{fontSize:12,color:"var(--t3)"}}>Code</label>
          <input className="fi" style={{width:80}} placeholder="e.g. 26" value={entForm.code} onChange={e=>setEntForm({...entForm,code:e.target.value})}/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <label style={{fontSize:12,color:"var(--t3)"}}>Name</label>
          <input className="fi" style={{width:200}} placeholder="Entity name" value={entForm.name} onChange={e=>setEntForm({...entForm,name:e.target.value})}/>
        </div>
        <button className="btn bp bsm" onClick={addEntity}>+ Add Entity</button>
      </div>
    </div>
  );
}

// ─── ALLOCATION REPORT ────────────────────────────────────────────────────────
function AllocationReport() {
  const now=new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth()+1);
  const [data,setData]=useState([]);
  const [loading,setLoading]=useState(false);
  const [view,setView]=useState("projects"); // "projects" | "departments" | "employees" | "ytd"
  const [detail,setDetail]=useState([]); // employee-level detail data
  const [detailLoading,setDetailLoading]=useState(false);
  const [expandedProj,setExpandedProj]=useState(null); // project id for drill-down
  const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ── YTD state (Finance report) ─────────────────────────────────────────────
  const [ytdYear,setYtdYear]=useState(now.getFullYear());
  const [ytdEndMonth,setYtdEndMonth]=useState(now.getMonth()+1);
  const [ytdDept,setYtdDept]=useState("");
  const [ytdRows,setYtdRows]=useState([]);
  const [ytdLoading,setYtdLoading]=useState(false);
  const [ytdGrouping,setYtdGrouping]=useState("employee"); // "employee" | "project" | "dept"

  useEffect(()=>{
    if(view!=="ytd")return;
    setYtdLoading(true);
    reportsAPI.allocationYTD(ytdYear,ytdEndMonth,ytdDept).then(r=>setYtdRows(r?.rows||[])).catch(()=>setYtdRows([])).finally(()=>setYtdLoading(false));
  },[view,ytdYear,ytdEndMonth,ytdDept]);

  useEffect(()=>{
    setLoading(true);setExpandedProj(null);
    Promise.all([
      reportsAPI.allocation(year,month).catch(()=>[]),
      reportsAPI.allocationDetail(year,month).catch(()=>[])
    ]).then(([agg,det])=>{setData(agg||[]);setDetail(det||[]);}).finally(()=>setLoading(false));
  },[year,month]);

  const depts=[...new Set(data.map(r=>r.dept))].sort();
  const projects=[...new Map(data.map(r=>[r.project_id,{id:r.project_id,code:r.project_code,name:r.project_name,type:r.project_type,entityCode:r.entity_code,entityName:r.entity_name}])).values()];

  function getCell(projId,dept){
    const row=data.find(r=>r.project_id===projId&&r.dept===dept);
    return row?Number(row.alloc_pct):null;
  }

  function cellStyle(val){
    if(val===null)return{};
    if(val>=20)return{background:"#dcfce7",color:"#166534",fontWeight:700};
    if(val>=10)return{background:"#fef9c3",color:"#854d0e",fontWeight:600};
    if(val>0)return{background:"#dbeafe",color:"#1e40af"};
    return{};
  }

  // Summary data for charts
  const deptTotals=depts.map(d=>{
    const total=projects.reduce((s,p)=>{const v=getCell(p.id,d);return s+(v||0);},0);
    const projCount=projects.filter(p=>getCell(p.id,d)!==null).length;
    return{dept:d,total:Math.round(total*10)/10,projCount};
  });
  const projTotals=projects.map(p=>{
    const total=depts.reduce((s,d)=>{const v=getCell(p.id,d);return s+(v||0);},0);
    const deptCount=depts.filter(d=>getCell(p.id,d)!==null).length;
    return{...p,total:Math.round(total*10)/10,deptCount};
  }).sort((a,b)=>b.total-a.total);

  const legend=<div style={{marginTop:10,fontSize:11,color:"var(--t3)"}}>
    <span style={{display:"inline-block",width:12,height:12,background:"#dcfce7",border:"1px solid #86efac",marginRight:4,verticalAlign:"middle"}}/>≥20%
    <span style={{display:"inline-block",width:12,height:12,background:"#fef9c3",border:"1px solid #fde047",marginRight:4,marginLeft:10,verticalAlign:"middle"}}/>10–19%
    <span style={{display:"inline-block",width:12,height:12,background:"#dbeafe",border:"1px solid #93c5fd",marginRight:4,marginLeft:10,verticalAlign:"middle"}}/>1–9%
  </div>;

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,flexWrap:"wrap"}}>
        <span style={{fontWeight:700,fontSize:15}}>📊 Allocation Report</span>
        <button className="btn bo bsm" onClick={()=>{if(month===1){setMonth(12);setYear(y=>y-1);}else setMonth(m=>m-1);}}>‹</button>
        <span style={{fontWeight:700,minWidth:90,textAlign:"center"}}>{MN[month-1]} {year}</span>
        <button className="btn bo bsm" onClick={()=>{if(month===12){setMonth(1);setYear(y=>y+1);}else setMonth(m=>m+1);}}>›</button>
        <div style={{flex:1}}/>
        <div className="tabs" style={{margin:0,flex:"none"}}>
          <div className={`tab ${view==="projects"?"active":""}`} onClick={()=>setView("projects")}>Projects by Dept</div>
          <div className={`tab ${view==="departments"?"active":""}`} onClick={()=>setView("departments")}>Depts by Project</div>
          <div className={`tab ${view==="employees"?"active":""}`} onClick={()=>setView("employees")}>Employee Detail</div>
          <div className={`tab ${view==="ytd"?"active":""}`} onClick={()=>setView("ytd")}>📆 YTD (Finance)</div>
        </div>
        {loading&&<span style={{fontSize:12,color:"var(--t3)"}}>Loading…</span>}
      </div>

      {data.length===0&&!loading&&<div style={{color:"var(--t3)",fontSize:13,padding:"20px 0"}}>No submitted/approved timesheet allocations for this period.</div>}

      {data.length>0&&view==="projects"&&(
        <>
          {/* Summary cards */}
          <div className="sg" style={{marginBottom:16}}>
            <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Projects</div><div className="sv" style={{color:"var(--v)"}}>{projects.length}</div><div className="sc2 neu">with allocations</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--sk)"}}/><div className="sl">Departments</div><div className="sv" style={{color:"var(--sk)"}}>{depts.length}</div><div className="sc2 neu">contributing</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Top Project</div><div className="sv" style={{color:"var(--gr)",fontSize:16}}>{projTotals[0]?.code||"—"}</div><div className="sc2 neu">{projTotals[0]?.total||0}% total</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Top Department</div><div className="sv" style={{color:"var(--am)",fontSize:16}}>{deptTotals.sort((a,b)=>b.total-a.total)[0]?.dept||"—"}</div><div className="sc2 neu">{deptTotals.sort((a,b)=>b.total-a.total)[0]?.projCount||0} projects</div></div>
          </div>

          {/* Bar chart: project totals */}
          <div className="card" style={{marginBottom:14}}>
            <div className="card-hd"><div className="card-title">Project Allocation Summary</div></div>
            <ResponsiveContainer width="100%" height={Math.max(200,projTotals.length*32)}>
              <BarChart data={projTotals} layout="vertical" margin={{left:80,right:20,top:5,bottom:5}}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false}/>
                <XAxis type="number" unit="%" domain={[0,"auto"]}/>
                <YAxis type="category" dataKey="code" width={75} tick={{fontSize:11,fontFamily:"'JetBrains Mono',monospace"}}/>
                <Tooltip formatter={v=>`${v}%`}/>
                <Bar dataKey="total" fill="var(--v)" radius={[0,4,4,0]} barSize={18}/>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Matrix table: rows=projects, cols=departments */}
          <div className="tw">
            <table className="tbl" style={{fontSize:12}}>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Entity</th>
                  <th>Type</th>
                  {depts.map(d=><th key={d} style={{minWidth:80}}>{d}</th>)}
                  <th>Total %</th>
                </tr>
              </thead>
              <tbody>
                {projects.map(p=>{
                  const rowTotal=depts.reduce((s,d)=>{const v=getCell(p.id,d);return s+(v||0);},0);
                  return(
                    <tr key={p.id}>
                      <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{p.code}</span><div style={{fontSize:11,color:"var(--t3)"}}>{p.name}</div></td>
                      <td>{p.entityCode?<span className="badge bgr2" style={{fontSize:10}}>{p.entityCode}</span>:<span style={{color:"var(--t3)"}}>—</span>}</td>
                      {depts.map(d=>{
                        const val=getCell(p.id,d);
                        return<td key={d} style={{textAlign:"center",...cellStyle(val)}}>{val!==null?`${val}%`:"—"}</td>;
                      })}
                      <td style={{textAlign:"center",fontWeight:700}}>{rowTotal>0?`${rowTotal.toFixed(1)}%`:"—"}</td>
                    </tr>
                  );
                })}
                {/* Department totals footer row */}
                <tr style={{background:"var(--s2)",fontWeight:700}}>
                  <td colSpan={3} style={{textAlign:"right",fontSize:11,textTransform:"uppercase",letterSpacing:".05em",color:"var(--t3)"}}>Dept Total</td>
                  {depts.map(d=>{
                    const total=projects.reduce((s,p)=>{const v=getCell(p.id,d);return s+(v||0);},0);
                    return<td key={d} style={{textAlign:"center"}}>{total>0?`${total.toFixed(1)}%`:"—"}</td>;
                  })}
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
          {legend}
        </>
      )}

      {data.length>0&&view==="departments"&&(
        <>
          {/* Summary cards */}
          <div className="sg" style={{marginBottom:16}}>
            {deptTotals.sort((a,b)=>b.total-a.total).map(d=>(
              <div className="sc" key={d.dept}>
                <div className="sl">{d.dept}</div>
                <div className="sv" style={{color:"var(--v)",fontSize:20}}>{d.projCount}</div>
                <div className="sc2 neu">project{d.projCount!==1?"s":""}</div>
              </div>
            ))}
          </div>

          {/* Bar chart: department breakdown */}
          <div className="card" style={{marginBottom:14}}>
            <div className="card-hd"><div className="card-title">Department Allocation Summary</div></div>
            <ResponsiveContainer width="100%" height={Math.max(200,depts.length*40)}>
              <BarChart data={deptTotals.sort((a,b)=>b.total-a.total)} layout="vertical" margin={{left:100,right:20,top:5,bottom:5}}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false}/>
                <XAxis type="number" unit="%" domain={[0,"auto"]}/>
                <YAxis type="category" dataKey="dept" width={95} tick={{fontSize:12}}/>
                <Tooltip formatter={v=>`${v}%`} labelFormatter={l=>`${l} department`}/>
                <Bar dataKey="total" fill="var(--sk)" radius={[0,4,4,0]} barSize={22}/>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Matrix table: rows=departments, cols=projects */}
          <div className="tw" style={{overflowX:"auto"}}>
            <table className="tbl" style={{fontSize:12}}>
              <thead>
                <tr>
                  <th style={{position:"sticky",left:0,background:"var(--surface)",zIndex:2}}>Department</th>
                  {projects.map(p=><th key={p.id} style={{minWidth:70,textAlign:"center"}}><div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:10}}>{p.code}</div></th>)}
                  <th>Total %</th>
                  <th># Projects</th>
                </tr>
              </thead>
              <tbody>
                {depts.map(d=>{
                  const rowTotal=projects.reduce((s,p)=>{const v=getCell(p.id,d);return s+(v||0);},0);
                  const projCount=projects.filter(p=>getCell(p.id,d)!==null).length;
                  return(
                    <tr key={d}>
                      <td style={{fontWeight:700,position:"sticky",left:0,background:"var(--surface)",zIndex:1}}>{d}</td>
                      {projects.map(p=>{
                        const val=getCell(p.id,d);
                        return<td key={p.id} style={{textAlign:"center",...cellStyle(val)}}>{val!==null?`${val}%`:"—"}</td>;
                      })}
                      <td style={{textAlign:"center",fontWeight:700}}>{rowTotal>0?`${rowTotal.toFixed(1)}%`:"—"}</td>
                      <td style={{textAlign:"center",fontWeight:600,color:"var(--v)"}}>{projCount}</td>
                    </tr>
                  );
                })}
                {/* Project totals footer row */}
                <tr style={{background:"var(--s2)",fontWeight:700}}>
                  <td style={{textAlign:"right",fontSize:11,textTransform:"uppercase",letterSpacing:".05em",color:"var(--t3)",position:"sticky",left:0,background:"var(--s2)",zIndex:1}}>Project Total</td>
                  {projects.map(p=>{
                    const total=depts.reduce((s,d)=>{const v=getCell(p.id,d);return s+(v||0);},0);
                    return<td key={p.id} style={{textAlign:"center"}}>{total>0?`${total.toFixed(1)}%`:"—"}</td>;
                  })}
                  <td/><td/>
                </tr>
              </tbody>
            </table>
          </div>
          {legend}

          {/* Per-department breakdown cards */}
          <div style={{marginTop:16}}>
            <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Department Detail</div>
            <div className="g2">
              {depts.map(d=>{
                const dProjects=projects.filter(p=>getCell(p.id,d)!==null).map(p=>({...p,pct:getCell(p.id,d)})).sort((a,b)=>b.pct-a.pct);
                return(
                  <div className="card" key={d} style={{margin:0}}>
                    <div className="card-hd">
                      <div><div className="card-title">{d}</div><div style={{fontSize:11,color:"var(--t3)"}}>{dProjects.length} project{dProjects.length!==1?"s":""}</div></div>
                      <span className="badge" style={{background:"var(--vl)",color:"var(--v)"}}>{dProjects.reduce((s,p)=>s+p.pct,0).toFixed(1)}%</span>
                    </div>
                    {dProjects.map(p=>(
                      <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:"1px solid var(--b)"}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:11,minWidth:80}}>{p.code}</span>
                        <div style={{flex:1}}>
                          <div className="prog" style={{height:8}}><div className="prog-f" style={{width:`${Math.min(100,p.pct*2)}%`,background:p.pct>=20?"var(--gr)":p.pct>=10?"var(--am)":"var(--v)"}}/></div>
                        </div>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,fontWeight:700,minWidth:45,textAlign:"right"}}>{p.pct}%</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {data.length>0&&view==="employees"&&(
        <>
          {/* Employee search/filter */}
          {(()=>{
            const empSearch=expandedProj; // reuse state as search filter
            const uniqueEmps=[...new Map(detail.map(r=>[r.user_id,{id:r.user_id,name:r.user_name,dept:r.dept,type:r.user_type}])).values()];
            const uniqueProjs=[...new Map(detail.map(r=>[r.project_id,{id:r.project_id,code:r.project_code,name:r.project_name,type:r.project_type}])).values()];

            // Group: per project → employees
            const projGroups=uniqueProjs.map(p=>{
              const emps=detail.filter(r=>r.project_id===p.id).sort((a,b)=>Number(b.total_hours)-Number(a.total_hours));
              const totalHours=emps.reduce((s,e)=>s+Number(e.total_hours),0);
              return{...p,emps,totalHours};
            }).sort((a,b)=>b.totalHours-a.totalHours);

            // Group: per employee → projects
            const empGroups=uniqueEmps.map(u=>{
              const projs=detail.filter(r=>r.user_id===u.id).sort((a,b)=>Number(b.total_hours)-Number(a.total_hours));
              const totalHours=projs.reduce((s,p)=>s+Number(p.total_hours),0);
              const totalDays=projs.reduce((s,p)=>s+Number(p.days_count),0);
              return{...u,projs,totalHours,totalDays};
            }).sort((a,b)=>b.totalHours-a.totalHours);

            return(
              <>
                {/* KPI cards */}
                <div className="sg" style={{marginBottom:16}}>
                  <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Employees</div><div className="sv" style={{color:"var(--v)"}}>{uniqueEmps.length}</div><div className="sc2 neu">with allocations</div></div>
                  <div className="sc"><div className="sa" style={{background:"var(--sk)"}}/><div className="sl">Projects</div><div className="sv" style={{color:"var(--sk)"}}>{uniqueProjs.length}</div></div>
                  <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Total Hours</div><div className="sv" style={{color:"var(--gr)"}}>{detail.reduce((s,r)=>s+Number(r.total_hours),0).toFixed(0)}</div></div>
                  <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Entries</div><div className="sv" style={{color:"var(--am)"}}>{detail.reduce((s,r)=>s+Number(r.days_count),0)}</div><div className="sc2 neu">timesheet days</div></div>
                </div>

                {/* Full detail table */}
                <div className="card" style={{marginBottom:16}}>
                  <div className="card-hd"><div className="card-title">Employee × Project Breakdown</div><span className="badge bgr2">{detail.length} rows</span></div>
                  <div className="tw" style={{maxHeight:400,overflowY:"auto"}}>
                    <table className="tbl" style={{fontSize:12}}>
                      <thead><tr>
                        <th>Employee</th><th>Dept</th><th>Type</th>
                        <th>Project</th><th>Proj Type</th>
                        <th style={{textAlign:"right"}}>Days</th>
                        <th style={{textAlign:"right"}}>Alloc</th>
                        <th style={{textAlign:"right"}}>Hours</th>
                      </tr></thead>
                      <tbody>
                        {detail.sort((a,b)=>a.user_name.localeCompare(b.user_name)||a.project_code.localeCompare(b.project_code)).map((r,i)=>(
                          <tr key={i}>
                            <td style={{fontWeight:600}}>{r.user_name}</td>
                            <td style={{fontSize:11,color:"var(--t2)"}}>{r.dept}</td>
                            <td><span className="badge bgr2" style={{fontSize:9}}>{r.user_type}</span></td>
                            <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:11}}>{r.project_code}</span><div style={{fontSize:10,color:"var(--t3)"}}>{r.project_name}</div></td>
                            <td><span className="badge bgr2" style={{fontSize:9}}>{r.project_type}</span></td>
                            <td style={{textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>{r.days_count}</td>
                            <td style={{textAlign:"right",fontFamily:"'JetBrains Mono',monospace"}}>{Number(r.total_alloc).toFixed(1)}</td>
                            <td style={{textAlign:"right",fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{Number(r.total_hours).toFixed(1)}h</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Per-project employee cards */}
                <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Employees per Project</div>
                <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
                  {projGroups.map(pg=>(
                    <div className="card" key={pg.id} style={{margin:0}}>
                      <div className="card-hd" style={{cursor:"pointer"}} onClick={()=>setExpandedProj(p=>p===pg.id?null:pg.id)}>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{pg.code}</span>
                            <span style={{fontSize:13,color:"var(--t2)"}}>{pg.name}</span>
                            <span className="badge bgr2" style={{fontSize:9}}>{pg.type}</span>
                          </div>
                          <div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{pg.emps.length} employee{pg.emps.length!==1?"s":""} · {pg.totalHours.toFixed(0)}h total</div>
                        </div>
                        <span style={{fontSize:12,color:"var(--t3)",transition:"transform .15s",transform:expandedProj===pg.id?"rotate(90deg)":"none"}}>▶</span>
                      </div>
                      {expandedProj===pg.id&&(
                        <div style={{marginTop:4}}>
                          {pg.emps.map(e=>(
                            <div key={e.user_id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid var(--b)"}}>
                              <div className="av" style={{background:aColor(e.user_id),width:28,height:28,fontSize:10}}>{initials(e.user_name)}</div>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontWeight:600,fontSize:13}}>{e.user_name}</div>
                                <div style={{fontSize:11,color:"var(--t3)"}}>{e.dept} · {e.user_type}</div>
                              </div>
                              <div style={{textAlign:"right",minWidth:60}}>
                                <div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:13}}>{Number(e.total_hours).toFixed(1)}h</div>
                                <div style={{fontSize:10,color:"var(--t3)"}}>{e.days_count} day{e.days_count!==1?"s":""}</div>
                              </div>
                              <div style={{width:80}}>
                                <div className="prog" style={{height:6}}><div className="prog-f" style={{width:`${Math.min(100,Number(e.total_hours)/pg.totalHours*100)}%`,background:"var(--v)"}}/></div>
                                <div style={{fontSize:9,color:"var(--t3)",textAlign:"right",marginTop:2}}>{(Number(e.total_hours)/pg.totalHours*100).toFixed(0)}%</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Per-employee project cards */}
                <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Projects per Employee</div>
                <div className="g2">
                  {empGroups.map(eg=>(
                    <div className="card" key={eg.id} style={{margin:0}}>
                      <div className="card-hd">
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div className="av" style={{background:aColor(eg.id),width:32,height:32,fontSize:11}}>{initials(eg.name)}</div>
                          <div><div style={{fontWeight:700,fontSize:14}}>{eg.name}</div><div style={{fontSize:11,color:"var(--t3)"}}>{eg.dept} · {eg.type}</div></div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:"var(--v)"}}>{eg.totalHours.toFixed(0)}h</div>
                          <div style={{fontSize:10,color:"var(--t3)"}}>{eg.totalDays} days</div>
                        </div>
                      </div>
                      {eg.projs.map(p=>(
                        <div key={p.project_id} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:"1px solid var(--b)"}}>
                          <span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:11,minWidth:80}}>{p.project_code}</span>
                          <div style={{flex:1}}>
                            <div className="prog" style={{height:6}}><div className="prog-f" style={{width:`${Math.min(100,Number(p.total_hours)/eg.totalHours*100)}%`,background:Number(p.total_hours)/eg.totalHours>=0.5?"var(--gr)":"var(--v)"}}/></div>
                          </div>
                          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:600,minWidth:50,textAlign:"right"}}>{Number(p.total_hours).toFixed(1)}h</span>
                          <span style={{fontSize:10,color:"var(--t3)",minWidth:35,textAlign:"right"}}>{p.days_count}d</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </>
      )}

      {/* ── YTD FINANCE REPORT ──────────────────────────────────────────── */}
      {view==="ytd"&&(()=>{
        const ytdDepts=[...new Set(ytdRows.map(r=>r.dept).filter(Boolean))].sort();
        const ytdProjects=[...new Map(ytdRows.map(r=>[r.project_id,{id:r.project_id,code:r.project_code,name:r.project_name,entityCode:r.entity_code}])).values()].sort((a,b)=>a.code.localeCompare(b.code));
        const ytdEmployees=[...new Map(ytdRows.map(r=>[r.user_id,{id:r.user_id,name:r.user_name,email:r.user_email,payrollId:r.payroll_id,dept:r.dept,type:r.user_type}])).values()].sort((a,b)=>(a.name||"").localeCompare(b.name||""));

        const grandHours=ytdRows.reduce((s,r)=>s+Number(r.total_hours||0),0);
        const grandDays=ytdRows.reduce((s,r)=>s+Number(r.days_count||0),0);

        function cell(userId,projectId){
          const r=ytdRows.find(x=>x.user_id===userId&&x.project_id===projectId);
          return r?{hours:Number(r.total_hours),days:Number(r.days_count),alloc:Number(r.total_alloc)}:null;
        }
        function userTotal(uid){
          return ytdRows.filter(r=>r.user_id===uid).reduce((s,r)=>s+Number(r.total_hours||0),0);
        }
        function projTotal(pid){
          return ytdRows.filter(r=>r.project_id===pid).reduce((s,r)=>s+Number(r.total_hours||0),0);
        }
        function deptTotal(dept){
          return ytdRows.filter(r=>r.dept===dept).reduce((s,r)=>s+Number(r.total_hours||0),0);
        }
        // Percentage = share of this employee's YTD working time on this project
        function pct(hours,userId){
          const tot=userTotal(userId);
          return tot>0?(Number(hours)/tot)*100:0;
        }

        function exportYtd(){
          const header=["Employee","Payroll ID","Department","Staff Type","Project Code","Project Name","Entity","Days","Alloc %","Months Covered"];
          const rows=[header];
          ytdRows.forEach(r=>rows.push([
            r.user_name,r.payroll_id||"",r.dept||"",r.user_type||"",r.project_code,r.project_name,r.entity_code||"",
            r.days_count,Number(pct(r.total_hours,r.user_id).toFixed(1)),
            `${MN[(r.first_month||1)-1]}–${MN[(r.last_month||1)-1]}`
          ]));
          rows.push([]);
          rows.push(["TOTAL","","","","","","",grandDays,"",""]);
          downloadXLSX(rows,`allocation-ytd-${ytdYear}-${ytdDept||"all"}`);
        }

        function exportMatrix(){
          // Rows: employees, Columns: projects, Cells: % of employee YTD time
          const header=["Employee","Payroll ID","Department",...ytdProjects.map(p=>p.code),"TOTAL %"];
          const rows=[header];
          ytdEmployees.forEach(u=>{
            const row=[u.name,u.payrollId||"",u.dept||""];
            let rowTot=0;
            ytdProjects.forEach(p=>{const c=cell(u.id,p.id);const p_=c?pct(c.hours,u.id):0;rowTot+=p_;row.push(p_?Number(p_.toFixed(1)):"");});
            row.push(Number(rowTot.toFixed(0)));
            rows.push(row);
          });
          downloadXLSX(rows,`allocation-ytd-matrix-${ytdYear}-${ytdDept||"all"}`);
        }

        return(
          <div>
            {/* Controls */}
            <div style={{display:"flex",gap:10,alignItems:"flex-end",marginBottom:14,flexWrap:"wrap",padding:"12px",background:"var(--s2)",borderRadius:"var(--rs)"}}>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Year</label>
                <input type="number" className="fi" value={ytdYear} onChange={e=>setYtdYear(Number(e.target.value))} style={{width:90}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Through Month</label>
                <select className="fsel" value={ytdEndMonth} onChange={e=>setYtdEndMonth(Number(e.target.value))} style={{width:110}}>
                  {MN.map((m,i)=><option key={i} value={i+1}>{m} {ytdYear}</option>)}
                </select>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Department</label>
                <select className="fsel" value={ytdDept} onChange={e=>setYtdDept(e.target.value)} style={{width:180}}>
                  <option value="">All Departments</option>
                  {ytdDepts.map(d=><option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                <label style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>Group</label>
                <select className="fsel" value={ytdGrouping} onChange={e=>setYtdGrouping(e.target.value)} style={{width:140}}>
                  <option value="employee">By Employee</option>
                  <option value="project">By Project</option>
                  <option value="dept">By Department</option>
                  <option value="matrix">Matrix (Emp × Proj)</option>
                </select>
              </div>
              <div style={{flex:1}}/>
              <button className="btn bg2 bsm" onClick={exportYtd}>📊 Export Detail</button>
              <button className="btn bp bsm" onClick={exportMatrix}>📊 Export Matrix</button>
            </div>

            {/* Summary cards */}
            <div className="sg" style={{marginBottom:14}}>
              <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Period</div><div className="sv" style={{color:"var(--v)",fontSize:15}}>Jan → {MN[ytdEndMonth-1]} {ytdYear}</div><div className="sc2 neu">{ytdEndMonth} month{ytdEndMonth!==1?"s":""}</div></div>
              <div className="sc"><div className="sa" style={{background:"var(--sk)"}}/><div className="sl">Employees</div><div className="sv" style={{color:"var(--sk)"}}>{ytdEmployees.length}</div><div className="sc2 neu">{ytdDept?`in ${ytdDept}`:"across all depts"}</div></div>
              <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Projects</div><div className="sv" style={{color:"var(--gr)"}}>{ytdProjects.length}</div><div className="sc2 neu">with allocations</div></div>
              <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Total Days</div><div className="sv" style={{color:"var(--am)"}}>{grandDays}</div><div className="sc2 neu">allocation entries</div></div>
            </div>

            {ytdLoading&&<div style={{padding:20,textAlign:"center",color:"var(--t3)",fontSize:13}}>Loading report…</div>}

            {!ytdLoading&&ytdRows.length===0&&<div style={{color:"var(--t3)",fontSize:13,padding:"20px 0"}}>No submitted/approved timesheet allocations for this period{ytdDept?` in ${ytdDept}`:""}.</div>}

            {/* Group: by Employee */}
            {!ytdLoading&&ytdRows.length>0&&ytdGrouping==="employee"&&(
              <div className="tw">
                <table className="tbl">
                  <thead><tr>
                    <th>Employee</th><th>Payroll ID</th><th>Department</th><th>Project</th><th>Entity</th>
                    <th style={{textAlign:"center"}}>Days</th><th style={{textAlign:"right"}}>% Time</th>
                  </tr></thead>
                  <tbody>
                    {ytdEmployees.map(u=>{
                      const userRows=ytdRows.filter(r=>r.user_id===u.id);
                      const uDays=userRows.reduce((s,r)=>s+Number(r.days_count||0),0);
                      return(
                        <React.Fragment key={u.id}>
                          {userRows.map((r,idx)=>{
                            const p=pct(r.total_hours,u.id);
                            return(
                              <tr key={r.project_id+"-"+u.id}>
                                {idx===0&&<td rowSpan={userRows.length+1} style={{fontWeight:600,verticalAlign:"top",borderRight:"1px solid var(--b)"}}>
                                  <div>{u.name}</div>
                                  <div style={{fontSize:10,color:"var(--t3)"}}>{u.type==="field"?"Field":"Office"}</div>
                                </td>}
                                {idx===0&&<td rowSpan={userRows.length+1} style={{verticalAlign:"top",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--t3)"}}>{u.payrollId||"—"}</td>}
                                {idx===0&&<td rowSpan={userRows.length+1} style={{verticalAlign:"top"}}>{u.dept||"—"}</td>}
                                <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:11}}>{r.project_code}</span> <span style={{color:"var(--t3)",fontSize:11}}>{r.project_name}</span></td>
                                <td>{r.entity_code?<span className="badge bgr2" style={{fontSize:10}}>{r.entity_code}</span>:"—"}</td>
                                <td style={{textAlign:"center",fontWeight:600}}>{r.days_count}</td>
                                <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{p.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                          <tr style={{background:"var(--vl)"}}>
                            <td colSpan={2} style={{textAlign:"right",fontWeight:700,fontStyle:"italic"}}>Subtotal:</td>
                            <td style={{textAlign:"center",fontWeight:700}}>{uDays}</td>
                            <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--v)"}}>100%</td>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Group: by Project */}
            {!ytdLoading&&ytdRows.length>0&&ytdGrouping==="project"&&(
              <div className="tw">
                <table className="tbl">
                  <thead><tr>
                    <th>Project</th><th>Entity</th><th>Employee</th><th>Department</th>
                    <th style={{textAlign:"center"}}>Days</th><th style={{textAlign:"right"}}>% of Employee Time</th>
                  </tr></thead>
                  <tbody>
                    {ytdProjects.map(p=>{
                      const projRows=ytdRows.filter(r=>r.project_id===p.id).sort((a,b)=>(a.user_name||"").localeCompare(b.user_name||""));
                      const pd=projRows.reduce((s,r)=>s+Number(r.days_count||0),0);
                      return(
                        <React.Fragment key={p.id}>
                          {projRows.map((r,idx)=>{
                            const p_=pct(r.total_hours,r.user_id);
                            return(
                              <tr key={r.project_id+"-"+r.user_id}>
                                {idx===0&&<td rowSpan={projRows.length+1} style={{fontWeight:600,verticalAlign:"top",borderRight:"1px solid var(--b)"}}>
                                  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12}}>{p.code}</div>
                                  <div style={{fontSize:10,color:"var(--t3)"}}>{p.name}</div>
                                </td>}
                                {idx===0&&<td rowSpan={projRows.length+1} style={{verticalAlign:"top"}}>{p.entityCode?<span className="badge bgr2" style={{fontSize:10}}>{p.entityCode}</span>:"—"}</td>}
                                <td>{r.user_name}{r.payroll_id&&<span style={{fontSize:10,color:"var(--t3)",marginLeft:6,fontFamily:"'JetBrains Mono',monospace"}}>#{r.payroll_id}</span>}</td>
                                <td>{r.dept||"—"}</td>
                                <td style={{textAlign:"center",fontWeight:600}}>{r.days_count}</td>
                                <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{p_.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                          <tr style={{background:"var(--vl)"}}>
                            <td colSpan={4} style={{textAlign:"right",fontWeight:700,fontStyle:"italic"}}>Project Subtotal:</td>
                            <td style={{textAlign:"center",fontWeight:700}}>{pd}</td>
                            <td/>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Group: by Department */}
            {!ytdLoading&&ytdRows.length>0&&ytdGrouping==="dept"&&(
              <div className="tw">
                <table className="tbl">
                  <thead><tr>
                    <th>Department</th><th>Employee</th><th>Project</th><th>Entity</th>
                    <th style={{textAlign:"center"}}>Days</th><th style={{textAlign:"right"}}>% of Employee Time</th>
                  </tr></thead>
                  <tbody>
                    {[...new Set(ytdRows.map(r=>r.dept||"— No Dept"))].sort().map(dept=>{
                      const dRows=ytdRows.filter(r=>(r.dept||"— No Dept")===dept).sort((a,b)=>(a.user_name||"").localeCompare(b.user_name||"")||(a.project_code||"").localeCompare(b.project_code||""));
                      const dd=dRows.reduce((s,r)=>s+Number(r.days_count||0),0);
                      return(
                        <React.Fragment key={dept}>
                          {dRows.map((r,idx)=>{
                            const p_=pct(r.total_hours,r.user_id);
                            return(
                              <tr key={dept+"-"+r.user_id+"-"+r.project_id}>
                                {idx===0&&<td rowSpan={dRows.length+1} style={{fontWeight:700,verticalAlign:"top",borderRight:"1px solid var(--b)",background:"var(--s2)"}}>{dept}</td>}
                                <td>{r.user_name}</td>
                                <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:600}}>{r.project_code}</span> <span style={{color:"var(--t3)",fontSize:11}}>{r.project_name}</span></td>
                                <td>{r.entity_code?<span className="badge bgr2" style={{fontSize:10}}>{r.entity_code}</span>:"—"}</td>
                                <td style={{textAlign:"center",fontWeight:600}}>{r.days_count}</td>
                                <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{p_.toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                          <tr style={{background:"var(--vl)"}}>
                            <td colSpan={4} style={{textAlign:"right",fontWeight:700,fontStyle:"italic"}}>Dept Subtotal:</td>
                            <td style={{textAlign:"center",fontWeight:700}}>{dd}</td>
                            <td/>
                          </tr>
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Group: Matrix (Employee × Project) */}
            {!ytdLoading&&ytdRows.length>0&&ytdGrouping==="matrix"&&(
              <div className="tw" style={{maxHeight:"65vh",overflow:"auto"}}>
                <table className="tbl" style={{fontSize:11}}>
                  <thead><tr>
                    <th style={{position:"sticky",left:0,top:0,background:"var(--s2)",zIndex:3,minWidth:200}}>Employee</th>
                    <th style={{position:"sticky",top:0,background:"var(--s2)",zIndex:2}}>Dept</th>
                    {ytdProjects.map(p=><th key={p.id} style={{textAlign:"center",position:"sticky",top:0,background:"var(--s2)",zIndex:2,minWidth:80}} title={p.name}><div style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700}}>{p.code}</div></th>)}
                    <th style={{position:"sticky",top:0,background:"var(--s2)",zIndex:2,textAlign:"right"}}>Total</th>
                  </tr></thead>
                  <tbody>
                    {ytdEmployees.map(u=>{
                      return(
                        <tr key={u.id}>
                          <td style={{position:"sticky",left:0,background:"var(--surface)",fontWeight:600,zIndex:1}}>
                            <div>{u.name}</div>
                            <div style={{fontSize:10,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{u.payrollId||"—"}</div>
                          </td>
                          <td style={{fontSize:11}}>{u.dept||"—"}</td>
                          {ytdProjects.map(p=>{
                            const c=cell(u.id,p.id);
                            const p_=c?pct(c.hours,u.id):0;
                            return <td key={p.id} style={{textAlign:"center",fontFamily:"'JetBrains Mono',monospace",background:c?"var(--vl)":"transparent"}}>{c?p_.toFixed(1)+"%":""}</td>;
                          })}
                          <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--v)",background:"var(--s2)"}}>100%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{background:"var(--s2)"}}>
                      <td style={{position:"sticky",left:0,background:"var(--s2)",fontWeight:700,zIndex:1}}>Project Share (of total)</td>
                      <td/>
                      {ytdProjects.map(p=>{
                        const pShare=grandHours>0?(projTotal(p.id)/grandHours)*100:0;
                        return <td key={p.id} style={{textAlign:"center",fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--v)"}}>{pShare.toFixed(1)}%</td>;
                      })}
                      <td style={{textAlign:"right",fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--v)"}}>100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function Settings({user,users,setUsers,projects,setProjects,roles,setRoles,activities,setActivities,holidays,setHolidays,entities,setEntities,workflows,setWorkflows,onResetPwd,departments=[],setDepartments,balanceTypes=[],setBalanceTypes}) {
  const [tab,setTab]=useState("users");
  const [editUser,setEditUser]=useState(null);
  const [showAdd,setShowAdd]=useState(false);
  const BNU={name:"",email:"",role:"employee",type:"office",dept:"",manager:null,functionalManager:null,active:true,leaveBalance:20,usedLeave:0};
  const [newUser,setNewUser]=useState(BNU);
  const [editProj,setEditProj]=useState(null);
  const [showAddProj,setShowAddProj]=useState(false);
  const [pFilter,setPFilter]=useState("all");
  const BNP={code:"",name:"",dept:"",open:true,fieldAllowed:true,officeAllowed:true,color:"#7c3aed",expiryDate:null,entityId:null};
  const [newProj,setNewProj]=useState(BNP);
  const [editRole,setEditRole]=useState(null);
  const [showAddRole,setShowAddRole]=useState(false);
  const BNR={key:"",label:"",color:"#64748b",permissions:[]};
  const [newRole,setNewRole]=useState(BNR);
  const mgrs=users.filter(u=>u.role==="manager"||u.role==="admin");

  const isAd=hasPerm(roles,user.role,"all");
  const depts=useMemo(()=>[...new Set(users.map(u=>u.dept).filter(Boolean))].sort(),[users]);

  // Workflow designer state
  const [wfModal,setWfModal]=useState(null); // null | "add" | workflow object
  const BLANK_WF={name:'',entityType:'leave',targetDept:null,targetStaffType:null,targetActivityType:null,priority:0,isActive:true,steps:[]};
  const BLANK_STEP={id:Date.now().toString(36),order:1,label:'',approver_type:'direct_manager',approver_value:null,conditions:[]};
  const [wfForm,setWfForm]=useState(BLANK_WF);

  async function saveWorkflow(){
    try{
      const steps=wfForm.steps.map((s,i)=>({...s,order:i+1,id:s.id||Date.now().toString(36)+i}));
      const payload={name:wfForm.name,entity_type:wfForm.entityType,target_dept:wfForm.targetDept||null,target_staff_type:wfForm.targetStaffType||null,target_activity_type:wfForm.targetActivityType||null,priority:Number(wfForm.priority)||0,is_active:wfForm.isActive,steps};
      if(wfModal==="add"){
        const created=await workflowsAPI.create(payload);
        const mapped={id:created.id,name:created.name,entityType:created.entity_type,targetDept:created.target_dept,targetStaffType:created.target_staff_type,targetActivityType:created.target_activity_type,priority:created.priority||0,isActive:created.is_active,steps:typeof created.steps==='string'?JSON.parse(created.steps):created.steps,createdAt:created.created_at?.slice(0,10)};
        setWorkflows(p=>[...p,mapped]);
      }else{
        const updated=await workflowsAPI.update(wfModal.id,payload);
        const mapped={id:updated.id,name:updated.name,entityType:updated.entity_type,targetDept:updated.target_dept,targetStaffType:updated.target_staff_type,targetActivityType:updated.target_activity_type,priority:updated.priority||0,isActive:updated.is_active,steps:typeof updated.steps==='string'?JSON.parse(updated.steps):updated.steps,createdAt:updated.created_at?.slice(0,10)};
        setWorkflows(p=>p.map(w=>w.id===mapped.id?mapped:w));
      }
      setWfModal(null);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function deleteWorkflow(id){
    try{await workflowsAPI.delete(id);setWorkflows(p=>p.filter(w=>w.id!==id));}catch(err){toast('Failed: '+err.message);}
  }
  function addWfStep(){setWfForm(f=>({...f,steps:[...f.steps,{...BLANK_STEP,id:Date.now().toString(36),order:f.steps.length+1}]}));}
  function removeWfStep(idx){setWfForm(f=>({...f,steps:f.steps.filter((_,i)=>i!==idx)}));}
  function moveWfStep(idx,dir){setWfForm(f=>{const s=[...f.steps];const ni=idx+dir;if(ni<0||ni>=s.length)return f;[s[idx],s[ni]]=[s[ni],s[idx]];return{...f,steps:s};});}
  function updateWfStep(idx,field,val){setWfForm(f=>({...f,steps:f.steps.map((s,i)=>i===idx?{...s,[field]:val}:s)}));}
  function addStepCondition(idx){setWfForm(f=>({...f,steps:f.steps.map((s,i)=>i===idx?{...s,conditions:[...(s.conditions||[]),{field:'days_count',operator:'>=',value:3}]}:s)}));}
  function removeStepCondition(sIdx,cIdx){setWfForm(f=>({...f,steps:f.steps.map((s,i)=>i===sIdx?{...s,conditions:s.conditions.filter((_,ci)=>ci!==cIdx)}:s)}));}
  function updateStepCondition(sIdx,cIdx,field,val){setWfForm(f=>({...f,steps:f.steps.map((s,i)=>i===sIdx?{...s,conditions:s.conditions.map((c,ci)=>ci===cIdx?{...c,[field]:val}:c)}:s)}));}

  // ── Pending reminder settings ──
  const [pendingReminderDays,setPendingReminderDays]=useState(3);
  const [staleInfo,setStaleInfo]=useState("");
  useEffect(()=>{
    companyAPI.getSettings().then(c=>{if(c.pending_reminder_days) setPendingReminderDays(c.pending_reminder_days);}).catch(()=>{});
  },[]);
  const savePendingDays=async()=>{
    try{
      await fetch(`${process.env.REACT_APP_API_URL||"/api"}/company-settings/pending-reminder`,{method:"PUT",headers:{"Content-Type":"application/json","Authorization":`Bearer ${localStorage.getItem("token")}`},body:JSON.stringify({pendingReminderDays})});
      toast("Reminder threshold saved.","success");
    }catch(e){toast("Failed: "+e.message);}
  };
  const sendStaleReminders=async()=>{
    setStaleInfo("Sending...");
    try{
      const r=await fetch(`${process.env.REACT_APP_API_URL||"/api"}/requests/send-stale-reminders`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${localStorage.getItem("token")}`}});
      const d=await r.json();
      setStaleInfo(`${d.staleCount} stale request${d.staleCount!==1?"s":""}, ${d.remindersSent} reminder${d.remindersSent!==1?"s":""} sent.`);
      toast(`${d.remindersSent} reminder(s) sent.`,"success");
    }catch(e){setStaleInfo("");toast("Failed: "+e.message);}
  };

  // ── CSV Import state ──
  const [importModal,setImportModal]=useState(null); // null | "users" | "projects"
  const [importRows,setImportRows]=useState([]);
  const [importResult,setImportResult]=useState(null);
  const [importLoading,setImportLoading]=useState(false);

  function parseCSV(text) {
    const lines=text.trim().split(/\r?\n/);
    if(lines.length<2) return [];
    const headers=lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/\s+/g,'_').replace(/[^a-z_]/g,''));
    return lines.slice(1).filter(l=>l.trim()).map(line=>{
      // Handle quoted fields
      const vals=[]; let cur='', inQ=false;
      for(let i=0;i<line.length;i++){
        if(line[i]==='"'){inQ=!inQ;}
        else if(line[i]===','&&!inQ){vals.push(cur.trim());cur='';}
        else cur+=line[i];
      }
      vals.push(cur.trim());
      return Object.fromEntries(headers.map((h,i)=>[h,(vals[i]||'').replace(/^"|"$/g,'').trim()]));
    });
  }

  function handleImportFile(e, kind) {
    const file=e.target.files[0];
    if(!file) return;
    e.target.value='';
    import('xlsx').then(XLSX=>{
      const reader=new FileReader();
      reader.onload=ev=>{
        const wb=XLSX.read(ev.target.result,{type:'binary'});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const rows=XLSX.utils.sheet_to_json(ws,{defval:''});
        // Normalise header keys: lowercase, underscores
        const normed=rows.map(r=>Object.fromEntries(
          Object.entries(r).map(([k,v])=>[k.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z_]/g,''),String(v)])
        ));
        setImportRows(normed);
        setImportResult(null);
        setImportModal(kind);
      };
      reader.readAsBinaryString(file);
    }).catch(()=>{
      // xlsx not available — fallback to plain CSV text reader
      const reader=new FileReader();
      reader.onload=ev=>{
        setImportRows(parseCSV(ev.target.result));
        setImportResult(null);
        setImportModal(kind);
      };
      reader.readAsText(file);
    });
  }

  async function runImport() {
    setImportLoading(true);
    try {
      const result = importModal==='users'
        ? await usersAPI.importCSV(importRows)
        : await projectsAPI.importCSV(importRows);
      setImportResult(result);
      if(result.created>0) {
        // Refresh the relevant list
        if(importModal==='users') usersAPI.getAll().then(setUsers).catch(()=>{});
        else projectsAPI.getAll().then(d=>setProjects(d.map(p=>({...p,fieldAllowed:p.field_allowed,officeAllowed:p.office_allowed,expiryDate:p.expiry_date||null})))).catch(()=>{});
      }
    } catch(e) { setImportResult({error:e.message}); }
    finally { setImportLoading(false); }
  }

  function downloadTemplate(kind) {
    const data = kind==='users'
      ? [['name','email','role','type','dept','manager_email','leave_balance'],
         ['Jane Smith','jane.smith@mazarine.tn','employee','office','Operations','','20'],
         ['Ali Ben','ali.ben@mazarine.tn','manager','field','Drilling','','20']]
      : [['code','name','dept','color','field_allowed','office_allowed'],
         ['PRJ-001','Field Maintenance','Operations','#7c3aed','true','false'],
         ['PRJ-002','Office IT','IT','#0ea5e9','false','true']];
    const csv=data.map(r=>r.join(',')).join('\n');
    const a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
    a.download=`${kind}-import-template.csv`;
    a.click();
  }

  // ── Email config state ──
  const DEF_EMAIL={provider:"disabled",smtp_host:"",smtp_port:587,smtp_secure:false,smtp_user:"",smtp_pass:"",smtp_from:"",m365_tenant_id:"",m365_client_id:"",m365_client_secret:"",m365_from:"",notify_new_request:true,notify_request_decision:true,notify_ts_submit:true,notify_ts_decision:true};
  const [emailCfg,setEmailCfg]=useState(DEF_EMAIL);
  const [emailSaving,setEmailSaving]=useState(false);
  const [emailTesting,setEmailTesting]=useState(false);
  const [emailMsg,setEmailMsg]=useState("");
  useEffect(()=>{
    emailAPI.getSettings().then(d=>setEmailCfg(c=>({...c,...d}))).catch(()=>{});
  },[]);
  async function saveEmailCfg(){
    setEmailSaving(true);setEmailMsg("");
    try{await emailAPI.saveSettings(emailCfg);setEmailMsg("✅ Saved");}
    catch(e){setEmailMsg("❌ "+e.message);}
    finally{setEmailSaving(false);}
  }
  async function testEmail(){
    setEmailTesting(true);setEmailMsg("");
    try{const r=await emailAPI.testEmail();setEmailMsg("✅ Test email sent to "+r.sentTo);}
    catch(e){setEmailMsg("❌ "+e.message);}
    finally{setEmailTesting(false);}
  }
  async function saveUser(){
    if(editUser){
      try{await usersAPI.update(editUser.id,editUser);setUsers(p=>p.map(u=>u.id===editUser.id?editUser:u));}
      catch(err){toast('Failed to save user: '+err.message);}
    }
    setEditUser(null);
  }
  async function addUser(){
    if(!newUser.name||!newUser.email)return;
    try{
      const created=await usersAPI.create(newUser);
      setUsers(p=>[...p,{id:created.id,email:created.email,name:created.name,role:created.role,type:created.type,dept:created.dept,manager:created.manager_id,functionalManager:created.functional_manager_id,active:created.active,leaveBalance:created.leave_balance,usedLeave:0,recoveryBalance:0,mustChangePwd:false}]);
      setShowAdd(false);setNewUser(BNU);
    }catch(err){toast('Failed to create user: '+err.message);}
  }
  async function toggleU(id){
    const u=users.find(x=>x.id===id);if(!u)return;
    try{await usersAPI.update(id,{...u,active:!u.active});setUsers(p=>p.map(x=>x.id===id?{...x,active:!x.active}:x));}
    catch(err){toast('Failed to update user: '+err.message);}
  }
  async function delUser(id){
    if(window.confirm("Remove user?")){
      try{await usersAPI.delete(id);setUsers(p=>p.filter(u=>u.id!==id));}
      catch(err){toast('Failed to delete user: '+err.message);}
    }
  }
  async function resetMFA(id){
    if(!window.confirm("Reset 2FA for this user? They will need to set it up again.")) return;
    try{await usersAPI.resetTOTP(id);setUsers(p=>p.map(u=>u.id===id?{...u,totpEnabled:false}:u));}
    catch(err){toast('Failed to reset 2FA: '+err.message);}
  }
  async function saveProj(){
    if(editProj){
      try{await projectsAPI.update(editProj.id,editProj);setProjects(p=>p.map(x=>x.id===editProj.id?editProj:x));}
      catch(err){toast('Failed to save project: '+err.message);}
    }
    setEditProj(null);
  }
  async function addProj(){
    if(!newProj.code||!newProj.name)return;
    try{
      const created=await projectsAPI.create(newProj);
      setProjects(p=>[...p,{id:created.id,code:created.code,name:created.name,dept:created.dept,open:created.open,fieldAllowed:created.field_allowed,officeAllowed:created.office_allowed,color:created.color,expiryDate:created.expiry_date||null,entityId:created.entity_id||null,entityCode:created.entity_code||null,entityName:created.entity_name||null}]);
      setShowAddProj(false);setNewProj(BNP);
    }catch(err){toast('Failed to create project: '+err.message);}
  }
  async function togglePO(id){
    const p=projects.find(x=>x.id===id);if(!p)return;
    try{await projectsAPI.update(id,{...p,open:!p.open});setProjects(pp=>pp.map(x=>x.id===id?{...x,open:!x.open}:x));}
    catch(err){toast('Failed to update project: '+err.message);}
  }
  async function delProj(id){
    if(window.confirm("Delete project?")){
      try{await projectsAPI.delete(id);setProjects(p=>p.filter(x=>x.id!==id));}
      catch(err){toast('Failed to delete project: '+err.message);}
    }
  }
  function addRole(){const k=newRole.key.trim().toLowerCase().replace(/\s+/g,"_");if(!k||!newRole.label.trim()){toast("Role key and label required.");return;}if(roles[k]){toast("Key already exists.");return;}setRoles(p=>({...p,[k]:{label:newRole.label,color:newRole.color,bg:colorBg(newRole.color),permissions:[...newRole.permissions]}}));setShowAddRole(false);setNewRole(BNR);}
  function saveRole(){if(!editRole)return;setRoles(p=>({...p,[editRole.key]:{...p[editRole.key],label:editRole.label,color:editRole.color,bg:colorBg(editRole.color),permissions:[...editRole.permissions]}}));setEditRole(null);}
  function delRole(k){if(roles[k]?.system){toast("System roles cannot be deleted.");return;}if(!window.confirm(`Delete role "${roles[k]?.label}"?`))return;setRoles(p=>{const n={...p};delete n[k];return n;});setUsers(p=>p.map(u=>u.role===k?{...u,role:"employee"}:u));}
  function togglePerm(perms,k){return perms.includes(k)?perms.filter(p=>p!==k):[...perms,k];}
  const filtProj=projects.filter(p=>pFilter==="all"||(pFilter==="open"&&p.open)||(pFilter==="closed"&&!p.open));
  // ── Activity management state
  const BNA={name:"",visibleTo:"both",isLeave:false,color:"#7c3aed",active:true,sortOrder:0,balanceTypeId:null};
  const [actModal,setActModal]=useState(null); // null | "add" | activity object
  const [actForm,setActForm]=useState(BNA);
  // ── Holiday management state
  const BNH={date:"",name:""};
  const [holModal,setHolModal]=useState(null); // null | "add" | holiday object
  const [holForm,setHolForm]=useState(BNH);

  async function addActivity(){
    if(!actForm.name.trim()){toast("Name required.");return;}
    try{
      const r=await activitiesAPI.create({name:actForm.name,visibleTo:actForm.visibleTo,isLeave:actForm.isLeave,color:actForm.color,sortOrder:actForm.sortOrder,balanceTypeId:actForm.balanceTypeId||null});
      setActivities(p=>[...p,{id:r.id,name:r.name,visibleTo:r.visible_to,isLeave:r.is_leave,color:r.color,active:r.active,sortOrder:r.sort_order,balanceTypeId:r.balance_type_id}]);
      setActModal(null);setActForm(BNA);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function saveActivity(){
    if(!actForm.name.trim()){toast("Name required.");return;}
    try{
      const r=await activitiesAPI.update(actModal.id,{name:actForm.name,visibleTo:actForm.visibleTo,isLeave:actForm.isLeave,color:actForm.color,active:actForm.active,sortOrder:actForm.sortOrder,balanceTypeId:actForm.balanceTypeId||null});
      setActivities(p=>p.map(a=>a.id===actModal.id?{id:r.id,name:r.name,visibleTo:r.visible_to,isLeave:r.is_leave,color:r.color,active:r.active,sortOrder:r.sort_order,balanceTypeId:r.balance_type_id}:a));
      setActModal(null);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function delActivity(id){
    if(!window.confirm("Delete activity? Existing timesheet entries keep their stored value but the activity won't appear in dropdowns."))return;
    try{await activitiesAPI.delete(id);setActivities(p=>p.filter(a=>a.id!==id));}
    catch(err){toast('Failed: '+err.message);}
  }
  async function toggleActActive(a){
    try{
      const r=await activitiesAPI.update(a.id,{name:a.name,visibleTo:a.visibleTo,isLeave:a.isLeave,color:a.color,active:!a.active,sortOrder:a.sortOrder});
      setActivities(p=>p.map(x=>x.id===a.id?{...x,active:r.active}:x));
    }catch(err){toast('Failed: '+err.message);}
  }

  async function addHoliday(){
    if(!holForm.date||!holForm.name.trim()){toast("Date and name required.");return;}
    try{
      const r=await holidaysAPI.create({date:holForm.date,name:holForm.name});
      const h={id:r.id,date:r.date.slice(0,10),name:r.name};
      setHolidays(p=>[...p,h].sort((a,b)=>a.date.localeCompare(b.date)));
      HOLIDAYS=[...HOLIDAYS,h.date].sort();
      setHolModal(null);setHolForm(BNH);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function saveHoliday(){
    if(!holForm.date||!holForm.name.trim()){toast("Date and name required.");return;}
    try{
      const r=await holidaysAPI.update(holModal.id,{date:holForm.date,name:holForm.name});
      const h={id:r.id,date:r.date.slice(0,10),name:r.name};
      setHolidays(p=>p.map(x=>x.id===holModal.id?h:x).sort((a,b)=>a.date.localeCompare(b.date)));
      HOLIDAYS=holidays.map(x=>x.id===holModal.id?h.date:x.date).sort();
      setHolModal(null);
    }catch(err){toast('Failed: '+err.message);}
  }
  async function delHoliday(id){
    if(!window.confirm("Delete this holiday?"))return;
    try{
      await holidaysAPI.delete(id);
      setHolidays(p=>p.filter(h=>h.id!==id));
      HOLIDAYS=holidays.filter(h=>h.id!==id).map(h=>h.date);
    }catch(err){toast('Failed: '+err.message);}
  }

  const CP=({value,onChange})=>(<div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:4}}>{COLORS.map(c=><div key={c} className={`color-sw${value===c?" sel":""}`} style={{background:c}} onClick={()=>onChange(c)}/>)}</div>);
  return (
    <div>
      <div className="tabs">{[["users","👥 Users & Roles"],["departments","🏛️ Departments"],["projects","📁 Projects"],["entities","🏢 Entities"],["activities","🎯 Activities"],["balanceTypes","💰 Balance Types"],["holidays","📅 Holidays"],["workflows","🔄 Workflows"],["rbac","🔐 Permissions & Roles"],["system","⚙️ System"]].map(([k,l])=>(<div key={k} className={`tab ${tab===k?"active":""}`} onClick={()=>setTab(k)}>{l}</div>))}</div>
      {tab==="users"&&(<div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div><div style={{fontWeight:700,fontSize:15}}>User Management</div><div style={{fontSize:12,color:"var(--t3)"}}>{users.filter(u=>u.active).length} active</div></div><div style={{display:"flex",gap:8}}><button className="btn bg2 bsm" onClick={()=>downloadTemplate('users')}>⬇ Template</button><label className="btn bg2 bsm" style={{cursor:"pointer",margin:0}}><input type="file" accept=".csv,.xlsx" style={{display:"none"}} onChange={e=>{handleImportFile(e,'users');e.target.value='';}} />📥 Import CSV</label><button className="btn bp bsm" onClick={()=>setShowAdd(true)}>+ Add User</button></div></div>
        <div className="tw"><table className="tbl"><thead><tr><th>User</th><th>Role</th><th>Type</th><th>Dept</th><th>Manager</th><th>Balances</th><th>Active</th><th>2FA</th><th>Actions</th></tr></thead><tbody>{users.map(u=>(<tr key={u.id}><td><div style={{display:"flex",alignItems:"center",gap:9}}><div className="av" style={{background:aColor(u.id)}}>{initials(u.name)}</div><div><div style={{fontWeight:700,fontSize:13}}>{u.name}</div><div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{u.email}</div></div></div></td><td><RoleBadge role={u.role} roles={roles}/></td><td><TypeBadge type={u.type}/></td><td style={{fontSize:12,color:"var(--t2)"}}>{u.dept}</td><td style={{fontSize:12,color:"var(--t3)"}}>{users.find(x=>x.id===u.manager)?.name||"—"}</td><td><div style={{display:"flex",flexDirection:"column",gap:3}}><div style={{display:"flex",alignItems:"center",gap:6}}><div className="prog" style={{width:48}}><div className="prog-f" style={{width:`${Math.round((u.usedLeave/u.leaveBalance)*100)}%`,background:u.usedLeave/u.leaveBalance>0.8?"var(--re)":"var(--gr)"}}/></div><span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}} title="Annual Leave remaining">{u.leaveBalance-u.usedLeave}d AL</span></div>{(u.recoveryBalance||0)>0&&<span style={{fontSize:10,color:"var(--v)",fontFamily:"'JetBrains Mono',monospace"}}>🔄 {u.recoveryBalance}d</span>}</div></td><td><label className="sw"><input type="checkbox" checked={u.active} onChange={()=>toggleU(u.id)}/><span className="sldr"/></label></td><td>{u.totpEnabled?<span className="badge bgr" style={{fontSize:10}}>🔒 On</span>:<span className="badge bgr2" style={{fontSize:10}}>Off</span>}</td><td><div style={{display:"flex",gap:4}}><button className="btn bg2 bxs" onClick={()=>setEditUser({...u})}>✏️</button>{onResetPwd&&<button className="btn bg2 bxs" title="Reset password" onClick={()=>onResetPwd(u.id)}>🔑</button>}{u.totpEnabled&&<button className="btn bg2 bxs" title="Reset 2FA" onClick={()=>resetMFA(u.id)}>🔓</button>}<button className="btn bg2 bxs" onClick={()=>delUser(u.id)}>🗑</button></div></td></tr>))}</tbody></table></div>
      </div>)}
      {tab==="projects"&&(<div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}><div><div style={{fontWeight:700,fontSize:15}}>Project Management</div><div style={{fontSize:12,color:"var(--t3)"}}>{projects.filter(p=>p.open).length} open · {projects.filter(p=>!p.open).length} closed</div></div><div style={{display:"flex",gap:8,alignItems:"center"}}><div className="tabs" style={{margin:0}}>{[["all","All"],["open","Open"],["closed","Closed"]].map(([k,l])=><div key={k} className={`tab ${pFilter===k?"active":""}`} onClick={()=>setPFilter(k)} style={{padding:"5px 11px"}}>{l}</div>)}</div><button className="btn bg2 bsm" onClick={()=>downloadTemplate('projects')}>⬇ Template</button><label className="btn bg2 bsm" style={{cursor:"pointer",margin:0}}><input type="file" accept=".csv,.xlsx" style={{display:"none"}} onChange={e=>{handleImportFile(e,'projects');e.target.value='';}} />📥 Import CSV</label><button className="btn bp bsm" onClick={()=>setShowAddProj(true)}>+ Add Project</button></div></div>
        <div className="tw" style={{marginBottom:14}}><table className="tbl"><thead><tr><th>Code</th><th>Name</th><th>Entity</th><th>Dept</th><th>Field</th><th>Office</th><th>Open</th><th>Actions</th></tr></thead><tbody>{filtProj.map(p=>(<tr key={p.id}><td><div style={{display:"flex",alignItems:"center",gap:7}}><div className="dot" style={{background:p.color}}/><span style={{fontFamily:"'JetBrains Mono',monospace",fontWeight:700,fontSize:12}}>{p.code}</span></div></td><td style={{fontWeight:600}}>{p.name}{p.expiryDate&&new Date(p.expiryDate)<new Date()&&<span className="badge" style={{background:"#fee2e2",color:"#dc2626",fontSize:10,marginLeft:4}}>Expired</span>}</td><td>{p.entityCode?<span className="badge bgr2" style={{fontSize:10}}>{p.entityCode}</span>:<span style={{color:"var(--t3)",fontSize:11}}>—</span>}</td><td style={{fontSize:12,color:"var(--t2)"}}>{p.dept}</td><td><label className="sw" style={{transform:"scale(.82)"}}><input type="checkbox" checked={p.fieldAllowed} onChange={()=>setProjects(pp=>pp.map(x=>x.id===p.id?{...x,fieldAllowed:!x.fieldAllowed}:x))}/><span className="sldr"/></label></td><td><label className="sw" style={{transform:"scale(.82)"}}><input type="checkbox" checked={p.officeAllowed} onChange={()=>setProjects(pp=>pp.map(x=>x.id===p.id?{...x,officeAllowed:!x.officeAllowed}:x))}/><span className="sldr"/></label></td><td><label className="sw" style={{transform:"scale(.82)"}}><input type="checkbox" checked={p.open} onChange={()=>togglePO(p.id)}/><span className="sldr"/></label></td><td><div style={{display:"flex",gap:4}}><button className="btn bg2 bxs" onClick={()=>setEditProj({...p})}>✏️</button><button className="btn bg2 bxs" onClick={()=>delProj(p.id)}>🗑</button></div></td></tr>))}</tbody></table></div>
        <div className="shd">Open Projects</div><div className="g3">{projects.filter(p=>p.open).map(p=>(<div className="pc" key={p.id}><div className="pdot" style={{background:p.color}}/><div style={{flex:1}}><div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:700,color:"var(--t3)"}}>{p.code}</div><div style={{fontSize:13,fontWeight:600}}>{p.name}</div><div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{p.dept}{p.fieldAllowed&&<span className="badge bsk" style={{fontSize:9,marginLeft:5}}>Field</span>}{p.officeAllowed&&<span className="badge bv" style={{fontSize:9,marginLeft:4}}>Office</span>}</div></div></div>))}</div>
      </div>)}
      {tab==="entities"&&<EntitiesTab entities={entities} setEntities={setEntities}/>}
      {tab==="departments"&&<DepartmentsTab departments={departments} setDepartments={setDepartments}/>}
      {tab==="balanceTypes"&&<BalanceTypesTab balanceTypes={balanceTypes} setBalanceTypes={setBalanceTypes}/>}
      {tab==="activities"&&(<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div><div style={{fontWeight:700,fontSize:15}}>Activity Management</div><div style={{fontSize:12,color:"var(--t3)"}}>{activities.filter(a=>a.active).length} active · {activities.filter(a=>!a.active).length} hidden</div></div>
          <button className="btn bp bsm" onClick={()=>{setActForm(BNA);setActModal("add");}}>+ Add Activity</button>
        </div>
        <div className="tw">
          <table className="tbl">
            <thead><tr><th>Activity</th><th>Visible To</th><th>Type</th><th>Color</th><th>Active</th><th>Actions</th></tr></thead>
            <tbody>{activities.map(a=>(
              <tr key={a.id}>
                <td><div style={{display:"flex",alignItems:"center",gap:8}}><div className="dot" style={{background:a.color}}/><span style={{fontWeight:600}}>{a.name}</span></div></td>
                <td>{a.visibleTo==="both"?<><span className="badge bsk" style={{fontSize:10}}>Field</span><span className="badge bv" style={{fontSize:10,marginLeft:4}}>Office</span></>:a.visibleTo==="field"?<span className="badge bsk" style={{fontSize:10}}>Field</span>:<span className="badge bv" style={{fontSize:10}}>Office</span>}</td>
                <td>{a.isLeave?<span className="badge bgr" style={{fontSize:10}}>Leave</span>:<span style={{fontSize:11,color:"var(--t3)"}}>Work</span>}</td>
                <td><span style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}}>{a.color}</span></td>
                <td><label className="sw"><input type="checkbox" checked={a.active} onChange={()=>toggleActActive(a)}/><span className="sldr"/></label></td>
                <td><div style={{display:"flex",gap:4}}><button className="btn bg2 bxs" onClick={()=>{setActForm({...a});setActModal(a);}}>✏️</button><button className="btn bd bxs" onClick={()=>delActivity(a.id)}>🗑</button></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {actModal&&(
          <div className="mo" onClick={e=>e.target.className==="mo"&&setActModal(null)}>
            <div className="md">
              <div className="md-title">{actModal==="add"?"Add Activity":`Edit — ${actModal.name}`}</div>
              <div className="fg">
                <div className="fgrp"><label className="flbl">Name</label><input className="fi" value={actForm.name} onChange={e=>setActForm(f=>({...f,name:e.target.value}))}/></div>
                <div className="fgrp"><label className="flbl">Visible To</label>
                  <select className="fsel" value={actForm.visibleTo} onChange={e=>setActForm(f=>({...f,visibleTo:e.target.value}))}>
                    <option value="both">Field + Office</option>
                    <option value="field">Field only</option>
                    <option value="office">Office only</option>
                  </select>
                </div>
                <div className="fgrp"><label className="flbl">Color</label><CP value={actForm.color} onChange={c=>setActForm(f=>({...f,color:c}))}/></div>
                <div className="fgrp"><label className="flbl">Counts as Leave</label>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
                    <label className="sw"><input type="checkbox" checked={actForm.isLeave} onChange={e=>setActForm(f=>({...f,isLeave:e.target.checked}))}/><span className="sldr"/></label>
                    <span style={{fontSize:13,color:"var(--t2)"}}>{actForm.isLeave?"Yes — deducts from selected balance":"No"}</span>
                  </div>
                </div>
                {actForm.isLeave&&(
                  <div className="fgrp"><label className="flbl">Balance Type</label>
                    <select className="fsel" value={actForm.balanceTypeId||""} onChange={e=>{
                      if(e.target.value==="__new__"){
                        const name=window.prompt("New balance type name (e.g. Sick Leave):");if(!name)return;
                        const code=name.toLowerCase().replace(/\s+/g,"_");
                        const defaultBalance=Number(window.prompt("Default days for new users:","0"))||0;
                        balanceTypesAPI.create({name,code,defaultBalance,color:"#10b981"}).then(created=>{
                          setBalanceTypes(p=>[...p,created]);
                          setActForm(f=>({...f,balanceTypeId:created.id}));
                        }).catch(err=>toast('Failed: '+err.message));
                      }else{
                        setActForm(f=>({...f,balanceTypeId:e.target.value?Number(e.target.value):null}));
                      }
                    }}>
                      <option value="">— None —</option>
                      {balanceTypes.filter(b=>b.active!==false).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
                      <option value="__new__">+ Add new balance type…</option>
                    </select>
                    <div style={{fontSize:11,color:"var(--t3)",marginTop:3}}>Choose which balance gets deducted when this activity is approved.</div>
                  </div>
                )}
                {actModal!=="add"&&(<div className="fgrp"><label className="flbl">Active</label>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
                    <label className="sw"><input type="checkbox" checked={actForm.active} onChange={e=>setActForm(f=>({...f,active:e.target.checked}))}/><span className="sldr"/></label>
                    <span style={{fontSize:13,color:"var(--t2)"}}>{actForm.active?"Visible in dropdowns":"Hidden from dropdowns"}</span>
                  </div>
                </div>)}
              </div>
              <div className="md-footer">
                <button className="btn bo" onClick={()=>setActModal(null)}>Cancel</button>
                <button className="btn bp" onClick={actModal==="add"?addActivity:saveActivity}>{actModal==="add"?"Add":"Save"}</button>
              </div>
            </div>
          </div>
        )}
      </div>)}
      {tab==="holidays"&&(<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <div style={{fontWeight:700,fontSize:15}}>Public Holidays</div>
            <div style={{fontSize:12,color:"var(--t3)"}}>{holidays.length} holiday{holidays.length!==1?"s":""} configured</div>
          </div>
          <button className="btn bp bsm" onClick={()=>{setHolForm(BNH);setHolModal("add");}}>+ Add Holiday</button>
        </div>
        <div className="tw">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Name</th><th>Day</th><th>Actions</th></tr></thead>
            <tbody>
              {holidays.map(h=>(
                <tr key={h.id}>
                  <td><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12}}>{h.date}</span></td>
                  <td><span style={{fontWeight:600}}>{h.name}</span></td>
                  <td><span style={{fontSize:12,color:"var(--t3)"}}>{new Date(h.date).toLocaleDateString("en-GB",{weekday:"long"})}</span></td>
                  <td>
                    <div style={{display:"flex",gap:4}}>
                      <button className="btn bg2 bxs" onClick={()=>{setHolForm({...h});setHolModal(h);}}>✏️</button>
                      <button className="btn bd bxs" onClick={()=>delHoliday(h.id)}>🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
              {holidays.length===0&&<tr><td colSpan={4} style={{textAlign:"center",color:"var(--t3)",fontSize:13,padding:"20px 0"}}>No holidays configured</td></tr>}
            </tbody>
          </table>
        </div>
        {holModal&&(
          <div className="mo" onClick={e=>e.target.className==="mo"&&setHolModal(null)}>
            <div className="md">
              <div className="md-title">{holModal==="add"?"Add Holiday":`Edit — ${holModal.name}`}</div>
              <div className="fg">
                <div className="fgrp">
                  <label className="flbl">Date</label>
                  <input type="date" className="fi" value={holForm.date} onChange={e=>setHolForm(f=>({...f,date:e.target.value}))}/>
                </div>
                <div className="fgrp">
                  <label className="flbl">Name</label>
                  <input className="fi" placeholder="e.g. Independence Day" value={holForm.name} onChange={e=>setHolForm(f=>({...f,name:e.target.value}))}/>
                </div>
              </div>
              <div className="md-footer">
                <button className="btn bo" onClick={()=>setHolModal(null)}>Cancel</button>
                <button className="btn bp" onClick={holModal==="add"?addHoliday:saveHoliday}>{holModal==="add"?"Add":"Save"}</button>
              </div>
            </div>
          </div>
        )}
      </div>)}
      {tab==="workflows"&&(<div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div><div style={{fontWeight:700,fontSize:15}}>Approval Workflows</div><div style={{fontSize:12,color:"var(--t3)"}}>{(workflows||[]).filter(w=>w.isActive).length} active · {(workflows||[]).filter(w=>!w.isActive).length} inactive</div></div>
          <button className="btn bp bsm" onClick={()=>{setWfForm({...BLANK_WF,steps:[{...BLANK_STEP}]});setWfModal("add");}}>+ Add Workflow</button>
        </div>
        <div style={{padding:"10px 14px",background:"var(--vl)",borderRadius:"var(--rs)",border:"1px solid var(--v)",marginBottom:12,fontSize:12,lineHeight:1.5}}>
          <strong>💡 Tip:</strong> Set a custom approver for a specific activity by creating a workflow with:
          <ul style={{margin:"6px 0 0 18px",paddingLeft:0}}>
            <li><b>Activity / Request Type</b> → the activity (e.g. "Annual Leave", "Mission")</li>
            <li>One step with <b>Approver Type</b> = <b>Direct Manager</b> (employee's line manager) or <b>Specific User</b> (choose any user)</li>
          </ul>
          If no workflow matches a request, approval defaults to the employee's direct manager.
        </div>
        <div className="tw"><table className="tbl"><thead><tr><th>Name</th><th>Trigger</th><th>Target</th><th>Steps</th><th>Priority</th><th>Active</th><th>Actions</th></tr></thead><tbody>
          {(workflows||[]).map(w=>(
            <tr key={w.id}>
              <td style={{fontWeight:600}}>{w.name}</td>
              <td><span className="badge bgr2" style={{fontSize:10}}>{w.entityType==='timesheet'?'Timesheet':w.entityType==='leave'?'Request/Leave':'Temp Auth'}</span></td>
              <td style={{fontSize:11,color:"var(--t3)"}}>
                {w.targetStaffType&&<span className="badge bsk" style={{fontSize:9,marginRight:4}}>{w.targetStaffType}</span>}
                {w.targetDept&&<span style={{marginRight:4}}>{w.targetDept}</span>}
                {w.targetActivityType&&<span className="badge bv" style={{fontSize:9}}>{w.targetActivityType}</span>}
                {!w.targetStaffType&&!w.targetDept&&!w.targetActivityType&&<span style={{color:"var(--t3)"}}>All</span>}
              </td>
              <td><span className="badge bgr2" style={{fontSize:10}}>{(w.steps||[]).length} step{(w.steps||[]).length!==1?"s":""}</span></td>
              <td style={{fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}}>{w.priority}</td>
              <td><label className="sw"><input type="checkbox" checked={w.isActive} onChange={async()=>{try{const updated=await workflowsAPI.update(w.id,{name:w.name,entity_type:w.entityType,target_dept:w.targetDept,target_staff_type:w.targetStaffType,target_activity_type:w.targetActivityType,priority:w.priority,steps:w.steps,is_active:!w.isActive});setWorkflows(p=>p.map(x=>x.id===w.id?{...x,isActive:!x.isActive}:x));}catch(err){toast('Failed: '+err.message);}}}/><span className="sldr"/></label></td>
              <td><div style={{display:"flex",gap:4}}>
                <button className="btn bg2 bxs" onClick={()=>{setWfForm({name:w.name,entityType:w.entityType,targetDept:w.targetDept,targetStaffType:w.targetStaffType,targetActivityType:w.targetActivityType,priority:w.priority,isActive:w.isActive,steps:[...(w.steps||[])]});setWfModal(w);}}>✏️</button>
                <button className="btn bd bxs" onClick={()=>deleteWorkflow(w.id)}>🗑</button>
              </div></td>
            </tr>
          ))}
        </tbody></table></div>
        {wfModal&&(
          <div className="mo" onClick={e=>e.target.className==="mo"&&setWfModal(null)}>
            <div className="md" style={{maxWidth:720,width:"95vw"}}>
              <div className="md-title">{wfModal==="add"?"Add Workflow":`Edit — ${wfModal.name}`}</div>
              <div className="fg" style={{maxHeight:"65vh",overflow:"auto"}}>
                <div className="fgrp"><label className="flbl">Name</label><input className="fi" value={wfForm.name} onChange={e=>setWfForm(f=>({...f,name:e.target.value}))}/></div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div className="fgrp"><label className="flbl">Entity Type</label>
                    <select className="fsel" value={wfForm.entityType} onChange={e=>setWfForm(f=>({...f,entityType:e.target.value}))}>
                      <option value="leave">Request / Leave</option>
                      <option value="timesheet">Timesheet</option>
                      <option value="temp_auth">Temporary Authorization</option>
                    </select>
                  </div>
                  <div className="fgrp"><label className="flbl">Priority</label><input className="fi" type="number" value={wfForm.priority} onChange={e=>setWfForm(f=>({...f,priority:Number(e.target.value)}))}/><div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>Higher = matched first</div></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <div className="fgrp"><label className="flbl">Staff Type</label>
                    <select className="fsel" value={wfForm.targetStaffType||''} onChange={e=>setWfForm(f=>({...f,targetStaffType:e.target.value||null}))}>
                      <option value="">All</option><option value="field">Field</option><option value="office">Office</option>
                    </select>
                  </div>
                  <div className="fgrp"><label className="flbl">Department</label>
                    <select className="fsel" value={wfForm.targetDept||''} onChange={e=>setWfForm(f=>({...f,targetDept:e.target.value||null}))}>
                      <option value="">All departments</option>{depts.map(d=><option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="fgrp"><label className="flbl">Activity / Request Type</label>
                    <select className="fsel" value={wfForm.targetActivityType||''} onChange={e=>setWfForm(f=>({...f,targetActivityType:e.target.value||null}))}>
                      <option value="">All types</option>{activities.filter(a=>a.active).map(a=><option key={a.id} value={a.name}>{a.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="fgrp"><label className="flbl">Active</label>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
                    <label className="sw"><input type="checkbox" checked={wfForm.isActive} onChange={e=>setWfForm(f=>({...f,isActive:e.target.checked}))}/><span className="sldr"/></label>
                    <span style={{fontSize:13,color:"var(--t2)"}}>{wfForm.isActive?"Active":"Inactive"}</span>
                  </div>
                </div>
                <div style={{borderTop:"1px solid var(--b)",paddingTop:14,marginTop:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontWeight:700,fontSize:14}}>Approval Steps</div>
                    <button className="btn bg2 bsm" disabled={wfForm.steps.length>=5} onClick={addWfStep}>+ Add Step</button>
                  </div>
                  {wfForm.steps.length===0&&<div style={{fontSize:12,color:"var(--t3)",padding:16,textAlign:"center",background:"var(--bg2)",borderRadius:8}}>No steps yet. Add at least one approval step.</div>}
                  {wfForm.steps.map((step,idx)=>(
                    <div key={step.id||idx} style={{border:"1px solid var(--b)",borderRadius:8,padding:12,marginBottom:8,background:"var(--bg2)"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <span style={{fontSize:12,fontWeight:700,color:"var(--v)"}}>Step {idx+1}</span>
                        <div style={{display:"flex",gap:4}}>
                          <button className="btn bg2 bxs" disabled={idx===0} onClick={()=>moveWfStep(idx,-1)}>↑</button>
                          <button className="btn bg2 bxs" disabled={idx===wfForm.steps.length-1} onClick={()=>moveWfStep(idx,1)}>↓</button>
                          <button className="btn bd bxs" onClick={()=>removeWfStep(idx)}>✕</button>
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                        <div className="fgrp"><label className="flbl">Label</label><input className="fi" value={step.label} placeholder="e.g. Manager Approval" onChange={e=>updateWfStep(idx,'label',e.target.value)}/></div>
                        <div className="fgrp"><label className="flbl">Approver Type</label>
                          <select className="fsel" value={step.approver_type} onChange={e=>updateWfStep(idx,'approver_type',e.target.value)}>
                            <option value="direct_manager">Direct Manager</option>
                            <option value="functional_manager">Functional Manager</option>
                            <option value="specific_role">Specific Role</option>
                            <option value="specific_user">Specific User</option>
                          </select>
                        </div>
                      </div>
                      {step.approver_type==='specific_role'&&(
                        <div className="fgrp"><label className="flbl">Role</label>
                          <select className="fsel" value={step.approver_value||''} onChange={e=>updateWfStep(idx,'approver_value',e.target.value)}>
                            <option value="">Select role...</option>
                            {Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                          </select>
                        </div>
                      )}
                      {step.approver_type==='specific_user'&&(
                        <div className="fgrp"><label className="flbl">User</label>
                          <select className="fsel" value={step.approver_value||''} onChange={e=>updateWfStep(idx,'approver_value',e.target.value)}>
                            <option value="">Select user...</option>
                            {users.filter(u=>u.active).map(u=><option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                          </select>
                        </div>
                      )}
                      <div style={{marginTop:6}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span style={{fontSize:11,fontWeight:600,color:"var(--t3)"}}>Conditions</span>
                          <button className="btn bg2 bxs" style={{fontSize:10}} onClick={()=>addStepCondition(idx)}>+ Condition</button>
                        </div>
                        {(step.conditions||[]).map((c,ci)=>(
                          <div key={ci} style={{display:"flex",gap:6,alignItems:"center",marginTop:4}}>
                            <select className="fsel" style={{flex:1,fontSize:11}} value={c.field} onChange={e=>updateStepCondition(idx,ci,'field',e.target.value)}>
                              <option value="days_count">Days Count</option>
                              <option value="duration_hours">Duration (hours)</option>
                            </select>
                            <select className="fsel" style={{width:60,fontSize:11}} value={c.operator} onChange={e=>updateStepCondition(idx,ci,'operator',e.target.value)}>
                              <option value="==">=</option><option value="!=">≠</option><option value=">">&gt;</option><option value=">=">&ge;</option><option value="<">&lt;</option><option value="<=">&le;</option>
                            </select>
                            <input className="fi" type="number" style={{width:60,fontSize:11}} value={c.value} onChange={e=>updateStepCondition(idx,ci,'value',Number(e.target.value))}/>
                            <button className="btn bd bxs" style={{fontSize:10}} onClick={()=>removeStepCondition(idx,ci)}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="md-footer">
                <button className="btn bo" onClick={()=>setWfModal(null)}>Cancel</button>
                <button className="btn bp" disabled={!wfForm.name||wfForm.steps.length===0} onClick={saveWorkflow}>{wfModal==="add"?"Create Workflow":"Save"}</button>
              </div>
            </div>
          </div>
        )}
      </div>)}
      {tab==="rbac"&&(<div><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div><div style={{fontWeight:700,fontSize:15}}>Roles & Permissions</div><div style={{fontSize:12,color:"var(--t3)"}}>Manage role definitions and access rights</div></div><button className="btn bp bsm" onClick={()=>setShowAddRole(true)}>+ New Role</button></div>
        {Object.entries(roles).map(([rKey,rDef])=>{const isAll=rDef.permissions.includes("all");return(<div className="card" key={rKey} style={{marginBottom:14}}><div className="card-hd" style={{marginBottom:14}}><div style={{display:"flex",alignItems:"center",gap:10}}><div style={{width:42,height:42,borderRadius:10,background:rDef.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,border:`1px solid ${rDef.color}20`}}>{rKey==="admin"?"👑":rKey==="manager"?"🏢":rKey==="hr"?"📋":rKey==="employee"?"👤":"🔑"}</div><div><div style={{fontWeight:700,fontSize:14}}>{rDef.label}</div><div style={{fontSize:11,color:"var(--t3)"}}>{users.filter(u=>u.role===rKey).length} users · {rDef.system?"System role":"Custom role"}</div></div></div><div style={{display:"flex",alignItems:"center",gap:8}}><RoleBadge role={rKey} roles={roles}/><button className="btn bg2 bxs" onClick={()=>setEditRole({key:rKey,...rDef,permissions:[...rDef.permissions]})}>✏️</button>{!rDef.system&&<button className="btn bd bxs" onClick={()=>delRole(rKey)}>🗑</button>}</div></div>
          <div className="pgrid">{PERMISSIONS_LIST.map(p=>{const on=isAll||rDef.permissions.includes(p.key);return(<div className="pi" key={p.key} style={{opacity:isAll&&p.key!=="all"?.55:1}}><div><div style={{fontSize:12,fontWeight:600,color:"var(--t)"}}>{p.label}</div><div className="pkey">{p.key}</div></div><label className="sw"><input type="checkbox" checked={on} disabled={isAll&&p.key!=="all"} onChange={()=>{if(isAll&&p.key!=="all")return;setRoles(prev=>({...prev,[rKey]:{...prev[rKey],permissions:togglePerm(prev[rKey].permissions,p.key)}}));}}/><span className="sldr"/></label></div>);})}</div>
        </div>);})}
      </div>)}
      {tab==="system"&&(<div className="g2"><div className="card"><div className="card-title" style={{marginBottom:13}}>⏰ Pending Request Reminders</div>
        <div style={{fontSize:13,color:"var(--t2)",marginBottom:12}}>Notify approvers when requests remain pending beyond the configured threshold.</div>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
          <div className="fgrp" style={{flex:"0 0 120px"}}>
            <label className="flbl">Reminder after (days)</label>
            <input type="number" className="fi" min={1} max={30} value={pendingReminderDays} onChange={e=>setPendingReminderDays(Math.max(1,Number(e.target.value)||3))}/>
          </div>
          <div style={{flex:1,fontSize:12,color:"var(--t3)"}}>Approvers will be notified about requests pending longer than <b style={{color:"var(--v)"}}>{pendingReminderDays} day{pendingReminderDays!==1?"s":""}</b>.</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button className="btn bp bsm" onClick={savePendingDays}>Save</button>
          <button className="btn bo bsm" onClick={sendStaleReminders}>📧 Send Reminders Now</button>
          {staleInfo&&<span style={{fontSize:12,color:"var(--t3)"}}>{staleInfo}</span>}
        </div>
      </div><div className="card"><div className="card-title" style={{marginBottom:13}}>Scheduling Rules</div>{[["Field rotation cycle","14d ON / 14d OFF"],["Annual leave advance","15 days min"],["Max AL per request","7 days (field)"],["AL carry forward","10 days max"],["Working hours (field)","12h/day"],["Working hours (office)","8h/day"]].map(([k,v])=>(<div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--b)",fontSize:13}}><span style={{color:"var(--t2)",fontWeight:500}}>{k}</span><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--v)",fontWeight:600}}>{v}</span></div>))}</div>
        <div><div className="card" style={{marginBottom:13}}><div className="card-title" style={{marginBottom:12}}>Public Holidays</div>{holidays.map(h=>(<div key={h.id} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--b)",fontSize:13}}><span style={{color:"var(--t2)"}}>{new Date(h.date).toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"long",year:"numeric"})}</span><span style={{fontSize:12,color:"var(--t3)",fontWeight:500}}>{h.name}</span></div>))}{holidays.length===0&&<div style={{fontSize:12,color:"var(--t3)",padding:"8px 0"}}>No holidays configured</div>}</div>
        <div className="card" style={{marginBottom:13}}>
          <PushSettingsCard/>
        </div>
        <div className="card">
          <div className="card-title" style={{marginBottom:14}}>📧 Email Notifications</div>
          <div className="fgrp"><label className="flbl">Provider</label>
            <select className="fsel" value={emailCfg.provider} onChange={e=>setEmailCfg(c=>({...c,provider:e.target.value}))}>
              <option value="disabled">Disabled</option>
              <option value="smtp">SMTP</option>
              <option value="m365">Microsoft 365 (Graph API)</option>
            </select>
          </div>
          {emailCfg.provider==="smtp"&&(<>
            <div style={{display:"grid",gridTemplateColumns:"1fr 100px",gap:8}}>
              <div className="fgrp"><label className="flbl">SMTP Host</label><input className="fi" placeholder="smtp.example.com" value={emailCfg.smtp_host||""} onChange={e=>setEmailCfg(c=>({...c,smtp_host:e.target.value}))}/></div>
              <div className="fgrp"><label className="flbl">Port</label><input type="number" className="fi" value={emailCfg.smtp_port||587} onChange={e=>setEmailCfg(c=>({...c,smtp_port:Number(e.target.value)}))}/></div>
            </div>
            <div className="fgrp"><label className="flbl">Username</label><input className="fi" placeholder="user@company.com" value={emailCfg.smtp_user||""} onChange={e=>setEmailCfg(c=>({...c,smtp_user:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">Password</label><input type="password" className="fi" placeholder="••••••••" value={emailCfg.smtp_pass||""} onChange={e=>setEmailCfg(c=>({...c,smtp_pass:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">From Address</label><input className="fi" placeholder="noreply@company.com" value={emailCfg.smtp_from||""} onChange={e=>setEmailCfg(c=>({...c,smtp_from:e.target.value}))}/></div>
            <div className="fgrp" style={{display:"flex",alignItems:"center",gap:10}}>
              <label className="sw"><input type="checkbox" checked={!!emailCfg.smtp_secure} onChange={e=>setEmailCfg(c=>({...c,smtp_secure:e.target.checked}))}/><span className="sldr"/></label>
              <span style={{fontSize:13}}>TLS/SSL (port 465)</span>
            </div>
          </>)}
          {emailCfg.provider==="m365"&&(<>
            <div style={{background:"var(--bg2)",borderRadius:"var(--rs)",padding:"10px 12px",fontSize:12,color:"var(--t3)",marginBottom:8}}>
              Requires an Azure App Registration with <b>Mail.Send</b> application permission and admin consent.
            </div>
            <div className="fgrp"><label className="flbl">Tenant ID</label><input className="fi" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={emailCfg.m365_tenant_id||""} onChange={e=>setEmailCfg(c=>({...c,m365_tenant_id:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">Client (App) ID</label><input className="fi" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={emailCfg.m365_client_id||""} onChange={e=>setEmailCfg(c=>({...c,m365_client_id:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">Client Secret</label><input type="password" className="fi" placeholder="••••••••" value={emailCfg.m365_client_secret||""} onChange={e=>setEmailCfg(c=>({...c,m365_client_secret:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">From (Shared Mailbox or User)</label><input className="fi" placeholder="notifications@company.com" value={emailCfg.m365_from||""} onChange={e=>setEmailCfg(c=>({...c,m365_from:e.target.value}))}/></div>
          </>)}
          {emailCfg.provider!=="disabled"&&(<>
            <div style={{fontWeight:600,fontSize:13,margin:"14px 0 8px"}}>Send notifications for:</div>
            {[["notify_new_request","New leave/extra-days request submitted → Approver"],["notify_request_decision","Request approved or rejected → Employee"],["notify_ts_submit","Timesheet submitted → Manager"],["notify_ts_decision","Timesheet approved or rejected → Employee"]].map(([k,l])=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:"1px solid var(--b)"}}>
                <label className="sw"><input type="checkbox" checked={!!emailCfg[k]} onChange={e=>setEmailCfg(c=>({...c,[k]:e.target.checked}))}/><span className="sldr"/></label>
                <span style={{fontSize:13}}>{l}</span>
              </div>
            ))}
          </>)}
          <div style={{display:"flex",gap:8,marginTop:14,alignItems:"center"}}>
            <button className="btn bp bsm" onClick={saveEmailCfg} disabled={emailSaving}>{emailSaving?"Saving…":"Save Settings"}</button>
            {emailCfg.provider!=="disabled"&&<button className="btn bo bsm" onClick={testEmail} disabled={emailTesting}>{emailTesting?"Sending…":"Send Test Email"}</button>}
            {emailMsg&&<span style={{fontSize:12,color:emailMsg.startsWith("✅")?"var(--gr)":"var(--re)"}}>{emailMsg}</span>}
          </div>
        </div></div>
      </div>)}
      {/* Modals */}
      {editUser&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setEditUser(null)}><div className="md"><div className="md-title">Edit User</div><div className="fg"><div className="fgrp"><label className="flbl">Full Name</label><input className="fi" value={editUser.name} onChange={e=>setEditUser(u=>({...u,name:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Email</label><input className="fi" value={editUser.email} onChange={e=>setEditUser(u=>({...u,email:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Payroll ID</label><input className="fi" placeholder="e.g. EMP-0042" value={editUser.payrollId||""} onChange={e=>setEditUser(u=>({...u,payrollId:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Role</label><select className="fsel" value={editUser.role} onChange={e=>setEditUser(u=>({...u,role:e.target.value}))}>{Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div><div className="fgrp"><label className="flbl">Staff Type</label><select className="fsel" value={editUser.type} onChange={e=>setEditUser(u=>({...u,type:e.target.value}))}><option value="field">Field</option><option value="office">Office</option></select></div><div className="fgrp"><label className="flbl">Department</label><select className="fsel" value={editUser.dept||""} onChange={e=>setEditUser(u=>({...u,dept:e.target.value}))}><option value="">— None —</option>{departments.filter(d=>d.active!==false).map(d=><option key={d.id} value={d.name}>{d.name}</option>)}</select></div><div className="fgrp"><label className="flbl">Line Manager</label><select className="fsel" value={editUser.manager||""} onChange={e=>setEditUser(u=>({...u,manager:Number(e.target.value)||null}))}><option value="">None</option>{mgrs.filter(m=>m.id!==editUser.id&&m.role!=="superadmin").map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></div><div className="fgrp"><label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",userSelect:"none"}}><input type="checkbox" checked={!!editUser.allowOverlap} onChange={e=>setEditUser(u=>({...u,allowOverlap:e.target.checked}))} style={{accentColor:"var(--v)",width:15,height:15,flexShrink:0}}/><span className="flbl" style={{margin:0}}>Allow overlapping requests</span></label><div style={{fontSize:11,color:"var(--t3)",marginTop:3,paddingLeft:23}}>This user can submit leave that overlaps with teammates' approved or pending requests.</div></div></div><div className="md-footer"><button className="btn bo" onClick={()=>setEditUser(null)}>Cancel</button><button className="btn bp" onClick={saveUser}>Save</button></div></div></div>)}
      {showAdd&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setShowAdd(false)}><div className="md"><div className="md-title">Add New User</div><div className="fg"><div className="fgrp"><label className="flbl">Full Name</label><input className="fi" placeholder="First Last" value={newUser.name} onChange={e=>setNewUser(u=>({...u,name:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Email</label><input className="fi" placeholder="name@mazarine.tn" value={newUser.email} onChange={e=>setNewUser(u=>({...u,email:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Payroll ID</label><input className="fi" placeholder="e.g. EMP-0042" value={newUser.payrollId||""} onChange={e=>setNewUser(u=>({...u,payrollId:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Role</label><select className="fsel" value={newUser.role} onChange={e=>setNewUser(u=>({...u,role:e.target.value}))}>{Object.entries(roles).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div><div className="fgrp"><label className="flbl">Staff Type</label><select className="fsel" value={newUser.type} onChange={e=>setNewUser(u=>({...u,type:e.target.value}))}><option value="field">Field</option><option value="office">Office</option></select></div><div className="fgrp"><label className="flbl">Department</label><select className="fsel" value={newUser.dept||""} onChange={e=>setNewUser(u=>({...u,dept:e.target.value}))}><option value="">— None —</option>{departments.filter(d=>d.active!==false).map(d=><option key={d.id} value={d.name}>{d.name}</option>)}</select></div><div className="fgrp"><label className="flbl">Line Manager</label><select className="fsel" value={newUser.manager||""} onChange={e=>setNewUser(u=>({...u,manager:Number(e.target.value)||null}))}><option value="">None</option>{mgrs.filter(m=>m.role!=="superadmin").map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></div></div><div className="md-footer"><button className="btn bo" onClick={()=>setShowAdd(false)}>Cancel</button><button className="btn bp" onClick={addUser}>Add</button></div></div></div>)}
      {editProj&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setEditProj(null)}><div className="md"><div className="md-title">Edit Project</div><div className="fg"><div className="fgrp"><label className="flbl">Code</label><input className="fi" value={editProj.code} onChange={e=>setEditProj(p=>({...p,code:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Entity</label><select className="fsel" value={editProj.entityId||""} onChange={e=>setEditProj(p=>({...p,entityId:e.target.value?Number(e.target.value):null}))}><option value="">— none —</option>{entities.map(e=><option key={e.id} value={e.id}>{e.code} — {e.name}</option>)}</select></div><div className="fgrp ff"><label className="flbl">Name</label><input className="fi" value={editProj.name} onChange={e=>setEditProj(p=>({...p,name:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Department</label><select className="fsel" value={editProj.dept||""} onChange={e=>setEditProj(p=>({...p,dept:e.target.value}))}><option value="">— None —</option>{departments.filter(d=>d.active!==false).map(d=><option key={d.id} value={d.name}>{d.name}</option>)}</select></div><div className="fgrp"><label className="flbl">Color</label><CP value={editProj.color} onChange={c=>setEditProj(p=>({...p,color:c}))}/></div><div className="fgrp"><label className="flbl">Allowed For</label><div style={{display:"flex",gap:14,marginTop:6}}><label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={editProj.fieldAllowed} onChange={e=>setEditProj(p=>({...p,fieldAllowed:e.target.checked}))}/>Field</label><label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={editProj.officeAllowed} onChange={e=>setEditProj(p=>({...p,officeAllowed:e.target.checked}))}/>Office</label></div></div><div className="fgrp ff"><label className="flbl">Status</label><div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}><label className="sw"><input type="checkbox" checked={editProj.open} onChange={e=>setEditProj(p=>({...p,open:e.target.checked}))}/><span className="sldr"/></label><span style={{fontSize:13}}>{editProj.open?"Open":"Closed"}</span></div></div><div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,color:"var(--t3)"}}>Expiry Date</label><input type="date" className="fi" value={editProj.expiryDate||""} onChange={e=>setEditProj({...editProj,expiryDate:e.target.value||null})}/></div></div><div className="md-footer"><button className="btn bo" onClick={()=>setEditProj(null)}>Cancel</button><button className="btn bp" onClick={saveProj}>Save</button></div></div></div>)}
      {showAddProj&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setShowAddProj(false)}><div className="md"><div className="md-title">Add New Project</div><div className="fg"><div className="fgrp"><label className="flbl">Code</label><input className="fi" placeholder="e.g. PROJ-001" value={newProj.code} onChange={e=>setNewProj(p=>({...p,code:e.target.value.toUpperCase()}))}/></div><div className="fgrp"><label className="flbl">Entity</label><select className="fsel" value={newProj.entityId||""} onChange={e=>setNewProj(p=>({...p,entityId:e.target.value?Number(e.target.value):null}))}><option value="">— none —</option>{entities.map(e=><option key={e.id} value={e.id}>{e.code} — {e.name}</option>)}</select></div><div className="fgrp ff"><label className="flbl">Name</label><input className="fi" placeholder="Full project name" value={newProj.name} onChange={e=>setNewProj(p=>({...p,name:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Department</label><select className="fsel" value={newProj.dept||""} onChange={e=>setNewProj(p=>({...p,dept:e.target.value}))}><option value="">— None —</option>{departments.filter(d=>d.active!==false).map(d=><option key={d.id} value={d.name}>{d.name}</option>)}</select></div><div className="fgrp"><label className="flbl">Color</label><CP value={newProj.color} onChange={c=>setNewProj(p=>({...p,color:c}))}/></div><div className="fgrp"><label className="flbl">Allowed For</label><div style={{display:"flex",gap:14,marginTop:6}}><label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={newProj.fieldAllowed} onChange={e=>setNewProj(p=>({...p,fieldAllowed:e.target.checked}))}/>Field</label><label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}><input type="checkbox" checked={newProj.officeAllowed} onChange={e=>setNewProj(p=>({...p,officeAllowed:e.target.checked}))}/>Office</label></div></div><div style={{display:"flex",flexDirection:"column",gap:4}}><label style={{fontSize:12,color:"var(--t3)"}}>Expiry Date</label><input type="date" className="fi" value={newProj.expiryDate||""} onChange={e=>setNewProj({...newProj,expiryDate:e.target.value||null})}/></div></div><div className="md-footer"><button className="btn bo" onClick={()=>setShowAddProj(false)}>Cancel</button><button className="btn bp" onClick={addProj}>Add</button></div></div></div>)}
      {showAddRole&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setShowAddRole(false)}><div className="md"><div className="md-title">Create New Role</div><div className="fg"><div className="fgrp"><label className="flbl">Role Key</label><input className="fi" placeholder="e.g. supervisor" value={newRole.key} onChange={e=>setNewRole(r=>({...r,key:e.target.value.toLowerCase().replace(/\s+/g,"_")}))}/></div><div className="fgrp"><label className="flbl">Display Label</label><input className="fi" placeholder="e.g. Supervisor" value={newRole.label} onChange={e=>setNewRole(r=>({...r,label:e.target.value}))}/></div><div className="fgrp ff"><label className="flbl">Badge Color</label><CP value={newRole.color} onChange={c=>setNewRole(r=>({...r,color:c}))}/></div><div className="fgrp ff"><label className="flbl">Permissions</label><div className="pgrid" style={{marginTop:6}}>{PERMISSIONS_LIST.map(p=>(<div className="pi" key={p.key}><div><div style={{fontSize:12,fontWeight:600,color:"var(--t)"}}>{p.label}</div><div className="pkey">{p.key}</div></div><label className="sw"><input type="checkbox" checked={newRole.permissions.includes(p.key)} onChange={()=>setNewRole(r=>({...r,permissions:togglePerm(r.permissions,p.key)}))}/><span className="sldr"/></label></div>))}</div></div></div><div style={{marginTop:10,padding:"9px 13px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>Preview: <RoleBadge role={newRole.key||"_"} roles={{[newRole.key||"_"]:{label:newRole.label||"New Role",color:newRole.color,bg:colorBg(newRole.color)}}}/></div><div className="md-footer"><button className="btn bo" onClick={()=>setShowAddRole(false)}>Cancel</button><button className="btn bp" onClick={addRole}>Create Role</button></div></div></div>)}
      {editRole&&(<div className="mo" onClick={e=>e.target.className==="mo"&&setEditRole(null)}><div className="md"><div className="md-title">Edit Role — <span style={{color:editRole.color}}>{editRole.label}</span></div>{editRole.system&&<div style={{padding:"8px 12px",background:"var(--aml)",borderRadius:"var(--rs)",fontSize:12,color:"var(--am)",marginBottom:14}}>⚠ System role: key is fixed, but label, color, and permissions can be changed.</div>}<div className="fg"><div className="fgrp"><label className="flbl">Display Label</label><input className="fi" value={editRole.label} onChange={e=>setEditRole(r=>({...r,label:e.target.value}))}/></div><div className="fgrp"><label className="flbl">Role Key (locked)</label><input className="fi" value={editRole.key} disabled style={{opacity:.5}}/></div><div className="fgrp ff"><label className="flbl">Badge Color</label><CP value={editRole.color} onChange={c=>setEditRole(r=>({...r,color:c}))}/></div><div className="fgrp ff"><label className="flbl">Permissions</label><div className="pgrid" style={{marginTop:6}}>{PERMISSIONS_LIST.map(p=>{const isAll=editRole.permissions.includes("all");const on=isAll||editRole.permissions.includes(p.key);return(<div className="pi" key={p.key} style={{opacity:isAll&&p.key!=="all"?.55:1}}><div><div style={{fontSize:12,fontWeight:600,color:"var(--t)"}}>{p.label}</div><div className="pkey">{p.key}</div></div><label className="sw"><input type="checkbox" checked={on} disabled={isAll&&p.key!=="all"} onChange={()=>setEditRole(r=>({...r,permissions:togglePerm(r.permissions,p.key)}))}/><span className="sldr"/></label></div>);})}</div></div></div><div style={{marginTop:10,padding:"9px 13px",background:"var(--s2)",borderRadius:"var(--rs)",fontSize:12}}>Preview: <RoleBadge role={editRole.key} roles={{[editRole.key]:{label:editRole.label,color:editRole.color,bg:colorBg(editRole.color)}}}/></div><div className="md-footer"><button className="btn bo" onClick={()=>setEditRole(null)}>Cancel</button><button className="btn bp" onClick={saveRole}>Save Role</button></div></div></div>)}
      {importModal&&(
        <div className="mo" onClick={e=>e.target.className==="mo"&&(setImportModal(null),setImportRows([]),setImportResult(null))}>
          <div className="md" style={{maxWidth:600,width:"95%"}}>
            <div className="md-title">📥 Import {importModal==='users'?'Users':'Projects'} from CSV</div>
            <div style={{padding:"16px 20px"}}>
              {!importResult&&(<>
                <div style={{fontSize:13,color:"var(--t2)",marginBottom:12}}>
                  {importRows.length>0
                    ?<><strong>{importRows.length}</strong> row{importRows.length!==1?'s':''} ready to import.</>
                    :<>Select a CSV or XLSX file to preview. Download the template if you need the correct column format.</>}
                </div>
                {importRows.length>0&&(
                  <div style={{overflowX:"auto",marginBottom:14,maxHeight:200,overflowY:"auto",border:"1px solid var(--bd)",borderRadius:"var(--r)"}}>
                    <table className="tbl" style={{fontSize:11}}>
                      <thead><tr>{Object.keys(importRows[0]).map(k=><th key={k}>{k}</th>)}</tr></thead>
                      <tbody>{importRows.slice(0,5).map((r,i)=><tr key={i}>{Object.values(r).map((v,j)=><td key={j}>{String(v)}</td>)}</tr>)}</tbody>
                    </table>
                    {importRows.length>5&&<div style={{padding:"4px 8px",fontSize:11,color:"var(--t3)"}}>… and {importRows.length-5} more rows</div>}
                  </div>
                )}
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <label className="btn bg2 bsm" style={{cursor:"pointer"}}>
                    <input type="file" accept=".csv,.xlsx" style={{display:"none"}} onChange={e=>{handleImportFile(e,importModal);e.target.value='';}} />
                    📂 Choose File
                  </label>
                  <button className="btn bg2 bsm" onClick={()=>downloadTemplate(importModal)}>⬇ Download Template</button>
                  {importRows.length>0&&<button className="btn bp bsm" disabled={importLoading} onClick={runImport}>{importLoading?'Importing…':'▶ Import'}</button>}
                </div>
              </>)}
              {importResult&&(<>
                {importResult.error
                  ?<div style={{color:"var(--re)",fontSize:13}}>❌ {importResult.error}</div>
                  :<div>
                    <div style={{fontSize:14,fontWeight:700,marginBottom:8,color:"var(--gr)"}}>✅ Import complete</div>
                    <div style={{fontSize:13,marginBottom:8}}>Created: <strong>{importResult.created}</strong> · Skipped: <strong>{importResult.skipped||0}</strong></div>
                    {importResult.errors&&importResult.errors.length>0&&(
                      <div style={{fontSize:12,color:"var(--re)",maxHeight:120,overflowY:"auto",background:"var(--re)10",borderRadius:"var(--r)",padding:"8px 10px"}}>
                        {importResult.errors.map((e,i)=><div key={i}>• {typeof e==="string"?e:`Row ${e.row||"?"}${e.code?` [${e.code}]`:""}${e.email?` [${e.email}]`:""}: ${e.reason||"Unknown error"}`}</div>)}
                      </div>
                    )}
                  </div>}
                <div className="md-footer">
                  <button className="btn bg2 bsm" onClick={()=>{setImportRows([]);setImportResult(null);}}>↩ Import More</button>
                  <button className="btn bp bsm" onClick={()=>{setImportModal(null);setImportRows([]);setImportResult(null);}}>Done</button>
                </div>
              </>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── AUDIT TRAIL ──────────────────────────────────────────────────────────────
const ACTION_LABELS = {
  login:                    {label:"Login",               color:"var(--v)",   ico:"🔑"},
  user_created:             {label:"User Created",        color:"var(--gr)",  ico:"👤"},
  user_deleted:             {label:"User Deleted",        color:"var(--re)",  ico:"🗑"},
  password_reset:           {label:"Password Reset",      color:"var(--am)",  ico:"🔒"},
  request_approved:         {label:"Request Approved",    color:"var(--gr)",  ico:"✅"},
  request_rejected:         {label:"Request Rejected",    color:"var(--re)",  ico:"❌"},
  timesheet_submitted:      {label:"TS Submitted",        color:"var(--sk)",  ico:"📤"},
  timesheet_approved:       {label:"TS Approved",         color:"var(--gr)",  ico:"✔"},
  timesheet_rejected:       {label:"TS Rejected",         color:"var(--re)",  ico:"✗"},
  timesheet_unlocked:       {label:"TS Unlocked",         color:"var(--am)",  ico:"🔓"},
  timesheet_reset_draft:    {label:"TS Reset Draft",      color:"var(--t3)",  ico:"↩"},
  balance_adjusted:         {label:"Balance Adjusted",    color:"var(--sk)",  ico:"⚖️"},
};

// ── NEW: ERP Duty Rota ── Constants & Helpers ──────────────────────────────
const ERP_ROLES_LIST = ["Crisis Management Coordinator","Drilling Crisis Coordinator","Field Manager (CPF)","DSV","Media","Reporting Team"];
const ERP_STATUS_VALUES = ["OFFICE","ON_SITE","OFF","FIELD"];
const ERP_STATUS_COLORS = {OFFICE:"#3b82f6",ON_SITE:"#f59e0b",OFF:"#94a3b8",FIELD:"#10b981"};
const ERP_STATUS_LABELS = {OFFICE:"Office",ON_SITE:"On Site",OFF:"Off",FIELD:"Field"};
const ERP_DUTY_SLOTS = [
  {key:"crisisCoord",label:"Crisis Management Coordinator",ico:"🎯",critical:true},
  {key:"drillingCrisisCoord",label:"Drilling Crisis Coordinator",ico:"⛏️",critical:true},
  {key:"cpfContact",label:"CPF Contact",ico:"🏭",critical:false},
  {key:"drillingContact",label:"Drilling Site Contact",ico:"🔩",critical:false},
  {key:"media",label:"Media",ico:"📡",critical:false},
];
const daysUntilFriday = () => { const d = new Date().getDay(); const diff = (5-d+7)%7; return diff===0?7:diff; };

const ERP_SEED_MEMBERS = [
  {initials:"RL", name:"Renaud Laneyrie",     func:"Country Manager",             erpRole:"Crisis Management Coordinator", phone:"29 902 442", status:"OFFICE"},
  {initials:"ABA",name:"Afif BelHaj Ali",     func:"Drilling Superintendent",     erpRole:"Drilling Crisis Coordinator",   phone:"29 371 944", status:"OFFICE"},
  {initials:"AH", name:"Amine Hamza",         func:"Production & Projects Mgr",   erpRole:"Crisis Management Coordinator", phone:"29 696 780", status:"OFFICE"},
  {initials:"MhH",name:"Mehdi Hajji",         func:"Field Manager",               erpRole:"Field Manager (CPF)",           phone:"29 683 812", status:"ON_SITE"},
  {initials:"MAA",name:"Med Amine Abdelkefi", func:"Field Manager",               erpRole:"Field Manager (CPF)",           phone:"27 655 544", status:"ON_SITE"},
  {initials:"AN", name:"Arbi Noura",          func:"DSV",                         erpRole:"DSV",                           phone:"29 526 207", status:"OFF"},
  {initials:"HM", name:"Hamid Messalti",      func:"DSV (Drilling)",              erpRole:"DSV",                           phone:"—",           status:"ON_SITE"},
  {initials:"MH", name:"Mohamed Hamda",       func:"Finance Manager",             erpRole:"Media",                         phone:"28 476 039", status:"OFFICE"},
  {initials:"IN", name:"Iman Nahlaoui",       func:"HR & Communications Mgr",     erpRole:"Reporting Team",                phone:"25 457 777", status:"OFF"},
  {initials:"CB", name:"Chourouk Bouchkara",  func:"Legal & Contracts Coord.",     erpRole:"Reporting Team",                phone:"29 696 213", status:"OFFICE"},
  {initials:"MrH",name:"Mariem Hached",       func:"Drilling Engineer",           erpRole:"Reporting Team",                phone:"29 683 810", status:"OFFICE"},
  {initials:"AS", name:"Aymen Saddoud",       func:"Drilling Engineer",           erpRole:"Reporting Team",                phone:"29 902 435", status:"OFFICE"},
  {initials:"MR", name:"Mariam Rafaoui",      func:"Office Administrator",        erpRole:"Reporting Team",                phone:"29 697 641", status:"OFFICE"},
];

const ERP_SEED_WEEKS = [
  {id:1,label:"Week #1",start:"2026-03-28",end:"2026-04-03",crisisCoord:"RL",drillingCrisisCoord:null,cpfContact:"MAA",drillingContact:"HM",media:"MH"},
  {id:2,label:"Week #2",start:"2026-04-04",end:"2026-04-10",crisisCoord:"AH",drillingCrisisCoord:"ABA",cpfContact:"MhH",drillingContact:"AN",media:"MH"},
];

const ERP_MSG_TEMPLATES = {
  rotation_reminder: (curr,next) => ({
    subject:"ERP Duty Rotation Reminder",
    body:`Reminder: Current duty rotation (${curr?.start||"N/A"} to ${curr?.end||"N/A"}) ends soon.\nNext rotation starts ${next?.start||"TBD"}.\nPlease ensure a smooth handover.`
  }),
  assignment: (member,slot,week) => ({
    subject:"ERP Duty Assignment Notice",
    body:`You have been assigned to ${slot} duty for the period ${week?.start||"TBD"} — ${week?.end||"TBD"}.\nPlease confirm your availability.`
  }),
  status_alert: (member,oldS,newS) => ({
    subject:"ERP Roster Status Change",
    body:`${member?.name||"Team member"} status changed from ${ERP_STATUS_LABELS[oldS]||oldS} to ${ERP_STATUS_LABELS[newS]||newS}.\nPlease update your planning accordingly.`
  }),
};

// ── NEW: ERP Duty Rota ── Main Component ────────────────────────────────────
function ERPDutyRotaView({user, users, roles, requests=[]}) {
  const [erpTab, setErpTab] = useState("dashboard");
  const isAd = hasPerm(roles, user.role, "all");
  const hasErpEdit = hasPerm(roles, user.role, "erp_rota_edit");
  const hasErpNotify = hasPerm(roles, user.role, "erp_rota_notify");
  const canEditWeeks = isAd || hasErpEdit;
  const canEditStatus = isAd || hasErpEdit;
  const canAddMembers = isAd || hasErpEdit;
  const canSendNotif = isAd || hasErpNotify;
  const canEmergency = isAd || hasErpNotify;
  const canEditSettings = isAd;

  // ── ERP Roster: loaded from API, shared across all users
  const [erpRosterRaw, setErpRosterRaw] = useState([]);
  const [rotWeeks, setRotWeeks] = useState([]);
  const [notifLog, setNotifLog] = useState([]);
  const [erpLoading, setErpLoading] = useState(true);

  // Load ERP data from API on mount
  const loadErpData = useCallback(async () => {
    setErpLoading(true);
    try {
      const [roster, weeks, notifs] = await Promise.all([
        erpRosterAPI.getAll().catch(e => { console.error('[ERP] roster load:', e); return []; }),
        erpWeeksAPI.getAll().catch(e => { console.error('[ERP] weeks load:', e); return []; }),
        erpNotificationsAPI.getAll().catch(e => { console.error('[ERP] notifs load:', e); return []; }),
      ]);
      setErpRosterRaw(Array.isArray(roster) ? roster : []);
      // Map DB column names to frontend keys
      setRotWeeks((Array.isArray(weeks) ? weeks : []).map(w => ({
        id: w.id, label: w.label, start: w.start_date?.slice(0,10) || w.start, end: w.end_date?.slice(0,10) || w.end,
        crisisCoord: w.crisis_coord, drillingCrisisCoord: w.drilling_crisis_coord,
        cpfContact: w.cpf_contact, drillingContact: w.drilling_contact, media: w.media
      })));
      setNotifLog((Array.isArray(notifs) ? notifs : []).map(n => ({
        id: n.id, time: n.created_at, subject: n.subject, channel: n.channel,
        count: n.recipient_count, status: n.status, isEmergency: n.is_emergency
      })));
    } catch (e) { console.error('[ERP] load error:', e); }
    setErpLoading(false);
  }, []);
  useEffect(() => { loadErpData(); }, [loadErpData]);

  // Derive erpMembers from API roster data + platform users
  const erpMembers = useMemo(() => {
    return erpRosterRaw.map(r => {
      const u = users.find(u => u.id === r.user_id);
      if (!u) return null;
      return { id: u.id, name: r.name || u.name, initials: initials(r.name || u.name), func: r.dept || u.dept || "", erpRole: r.erp_role || "", phone: r.phone || u.phone || "", email: r.email || u.email || "", status: u.type === "field" ? "FIELD" : "OFFICE", notes: r.notes || "", color: aColor(u.id), userId: u.id };
    }).filter(Boolean);
  }, [erpRosterRaw, users]);

  // ── Settings (local only — admin-specific config)
  const [erpSettings, setErpSettings] = useState(() => {
    const saved = localStorage.getItem("maz_erp_settings");
    if (saved) return JSON.parse(saved);
    return {backendUrl:"http://localhost:3001",reminderDay:"thursday",reminderChannel:"email",smtpHost:"",smtpUser:"",smtpPass:"",twilioSid:"",twilioToken:"",twilioFrom:"",twilioWa:""};
  });
  useEffect(() => { localStorage.setItem("maz_erp_settings", JSON.stringify(erpSettings)); }, [erpSettings]);

  // Helpers — lookup by userId (number) or legacy initials (string)
  const getMember = (key) => {
    if (!key) return null;
    if (typeof key === "number") return erpMembers.find(m => m.id === key);
    return erpMembers.find(m => m.initials === key || m.name === key || String(m.id) === String(key));
  };
  const today = new Date().toISOString().split("T")[0];
  const activeWeek = rotWeeks.find(w => w.start <= today && w.end >= today) || rotWeeks[0];
  const nextWeek = rotWeeks.find(w => w.start > today);
  const activeCnt = erpMembers.filter(m => m.status !== "OFF").length;
  const onSiteCnt = erpMembers.filter(m => m.status === "ON_SITE" || m.status === "FIELD").length;
  const offCnt = erpMembers.filter(m => m.status === "OFF").length;

  // ── Leave detection: check if an ERP member is on approved leave for a given date range
  const LEAVE_TYPES = ["Annual Leave","Sick Leave","Compassionate","Recovery Leave","Remote Work"];
  const isOnLeave = useCallback((memberKey, dateStart, dateEnd) => {
    // memberKey can be userId (number) or initials (string)
    const mem = getMember(memberKey);
    if (!mem) return null;
    const uid = mem.userId || mem.id;
    const start = dateStart || today;
    const end = dateEnd || today;
    return requests.find(r =>
      r.userId === uid &&
      LEAVE_TYPES.includes(r.type) &&
      (r.status === "Approved" || r.status === "Pending") &&
      r.start <= end && r.end >= start
    ) || null;
  }, [requests, erpMembers, today]);

  const TABS = [
    {key:"dashboard",ico:"📊",label:"Dashboard"},
    {key:"rotation",ico:"🔄",label:"Rotation"},
    {key:"members",ico:"👥",label:"Members"},
    {key:"notify",ico:"🔔",label:"Notify"},
    {key:"settings",ico:"⚙️",label:"Settings"},
  ];

  // ── NEW: ERP Duty Rota ── Dashboard Sub-tab ───────────────────────────────
  const renderDashboard = () => (
    <div>
      <div className="sg">
        <div className="sc"><div className="sa" style={{background:"#10b981"}}/><div className="sl">Active Personnel</div><div className="sv" style={{color:"#10b981"}}>{activeCnt}</div><div className="sc2 neu">of {erpMembers.length}</div></div>
        <div className="sc"><div className="sa" style={{background:"#f59e0b"}}/><div className="sl">On Site / Field</div><div className="sv" style={{color:"#f59e0b"}}>{onSiteCnt}</div></div>
        <div className="sc"><div className="sa" style={{background:"#94a3b8"}}/><div className="sl">Off Duty</div><div className="sv" style={{color:"#94a3b8"}}>{offCnt}</div></div>
        <div className="sc"><div className="sa" style={{background:"#E8750A"}}/><div className="sl">Days to Handover</div><div className="sv" style={{color:"#E8750A"}}>{daysUntilFriday()}</div><div className="sc2 neu">Friday EOB</div></div>
      </div>
      <div className="g2" style={{marginTop:16}}>
        <div className="card" style={{flex:2}}>
          <div className="card-hd"><div><div className="card-title">Current Duty Rotation</div><div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{activeWeek?.start} → {activeWeek?.end}</div></div><span className="badge" style={{background:"#dcfce7",color:"#16a34a"}}>ACTIVE</span></div>
          {ERP_DUTY_SLOTS.map(slot => {
            const m = getMember(activeWeek?.[slot.key]);
            const leaveReq = m ? isOnLeave(activeWeek?.[slot.key], activeWeek?.start, activeWeek?.end) : null;
            return (
              <div key={slot.key} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:10,marginBottom:6,background:leaveReq?"#fef2f2":slot.critical?"#fffbeb":"var(--bg)",border:leaveReq?"2px solid #ef4444":"1px solid var(--b)"}}>
                <span style={{fontSize:18,width:28,textAlign:"center"}}>{slot.ico}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,color:"var(--t3)",fontWeight:600}}>{slot.label}</div>
                  {m ? (
                    <>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:2}}>
                        <div className="av" style={{background:leaveReq?"#ef4444":m.color||"#7c3aed",width:26,height:26,fontSize:10,borderRadius:6}}>{m.initials}</div>
                        <span style={{fontWeight:700,fontSize:13,textDecoration:leaveReq?"line-through":"none",color:leaveReq?"#ef4444":"inherit"}}>{m.name}</span>
                        <span className="badge" style={{background:ERP_STATUS_COLORS[m.status]+"22",color:ERP_STATUS_COLORS[m.status],fontSize:10}}>{ERP_STATUS_LABELS[m.status]}</span>
                      </div>
                      {leaveReq && (
                        <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,padding:"4px 8px",borderRadius:6,background:"#fef2f2",border:"1px solid #fecaca"}}>
                          <span style={{fontSize:14}}>⚠️</span>
                          <span style={{fontSize:11,fontWeight:700,color:"#dc2626"}}>ON LEAVE ({leaveReq.type}{leaveReq.status==="Pending"?" — pending":""})</span>
                          <span style={{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"#ef4444"}}>{leaveReq.start} → {leaveReq.end}</span>
                          <span style={{fontSize:11,fontWeight:700,color:"#dc2626",marginLeft:"auto"}}>Assign replacement!</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{color:"#ef4444",fontWeight:600,fontSize:12,marginTop:2}}>⚠ Not assigned</div>
                  )}
                </div>
                {m && m.phone && m.phone !== "—" && (
                  <a href={`tel:${m.phone.replace(/\s/g,"")}`} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--v)",textDecoration:"none"}}>📞 {m.phone}</a>
                )}
              </div>
            );
          })}
        </div>
        <div className="card">
          <div className="card-hd"><div className="card-title">Personnel Status</div></div>
          <div style={{maxHeight:340,overflowY:"auto"}}>
            {erpMembers.map(m => {
              const lr = isOnLeave(m.id);
              return (
                <div key={m.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid var(--b)",background:lr?"#fef2f222":"transparent"}}>
                  <div className="av" style={{background:lr?"#ef4444":m.color||"#7c3aed",width:30,height:30,fontSize:11,borderRadius:8}}>{m.initials}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:13}}>{m.name}</div>
                    <div style={{fontSize:11,color:"var(--t3)"}}>{m.func}</div>
                    {lr && <div style={{fontSize:10,fontWeight:700,color:"#dc2626"}}>🌴 {lr.type} ({lr.start} → {lr.end})</div>}
                  </div>
                  {lr ? (
                    <span className="badge" style={{background:"#fef2f2",color:"#dc2626",fontSize:10}}>On Leave</span>
                  ) : (
                    <span className="badge" style={{background:ERP_STATUS_COLORS[m.status]+"22",color:ERP_STATUS_COLORS[m.status],fontSize:10}}>{ERP_STATUS_LABELS[m.status]}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* Emergency strip */}
      <div style={{marginTop:16,padding:"18px 24px",borderRadius:14,background:"linear-gradient(135deg,#991b1b,#dc2626)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontWeight:700,fontSize:14}}>Emergency Line</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:24,fontWeight:700,marginTop:2}}>29 324 484</div>
        </div>
        <button onClick={() => setErpTab("notify")} style={{padding:"10px 20px",borderRadius:10,border:"none",background:"#fff",color:"#dc2626",fontWeight:700,fontSize:13,cursor:"pointer"}}>🚨 Broadcast Alert</button>
      </div>
    </div>
  );

  // ── NEW: ERP Duty Rota ── Rotation Sub-tab ────────────────────────────────
  const [weekModal, setWeekModal] = useState(null);
  const [weekForm, setWeekForm] = useState({label:"",start:"",end:"",crisisCoord:"",drillingCrisisCoord:"",cpfContact:"",drillingContact:"",media:""});

  const openWeekModal = (w) => {
    if (w) setWeekForm({label:w.label,start:w.start,end:w.end,crisisCoord:w.crisisCoord||"",drillingCrisisCoord:w.drillingCrisisCoord||"",cpfContact:w.cpfContact||"",drillingContact:w.drillingContact||"",media:w.media||""});
    else setWeekForm({label:`Week #${rotWeeks.length+1}`,start:"",end:"",crisisCoord:"",drillingCrisisCoord:"",cpfContact:"",drillingContact:"",media:""});
    setWeekModal(w || {id:"new"});
  };

  const saveWeek = async () => {
    if (!weekForm.start || !weekForm.end) { toast("Start and end dates required."); return; }
    try {
      if (weekModal.id === "new") {
        const created = await erpWeeksAPI.create(weekForm);
        setRotWeeks(p => [...p, {id:created.id,label:created.label,start:created.start_date?.slice(0,10),end:created.end_date?.slice(0,10),crisisCoord:created.crisis_coord,drillingCrisisCoord:created.drilling_crisis_coord,cpfContact:created.cpf_contact,drillingContact:created.drilling_contact,media:created.media}]);
      } else {
        const updated = await erpWeeksAPI.update(weekModal.id, weekForm);
        setRotWeeks(p => p.map(w => w.id === weekModal.id ? {id:updated.id,label:updated.label,start:updated.start_date?.slice(0,10),end:updated.end_date?.slice(0,10),crisisCoord:updated.crisis_coord,drillingCrisisCoord:updated.drilling_crisis_coord,cpfContact:updated.cpf_contact,drillingContact:updated.drilling_contact,media:updated.media} : w));
      }
      setWeekModal(null);
      toast("Week saved.","success");
    } catch (e) { toast("Failed to save week: " + e.message); }
  };

  const deleteWeek = async (id) => {
    if (!window.confirm("Delete this rotation week?")) return;
    try {
      await erpWeeksAPI.delete(id);
      setRotWeeks(p => p.filter(w => w.id !== id));
      toast("Week deleted.","success");
    } catch (e) { toast("Failed to delete week: " + e.message); }
  };

  const renderRotation = () => (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:15,fontWeight:700}}>Rotation Week Planner</div>
        {canEditWeeks ? (
          <button className="btn bp" onClick={() => openWeekModal(null)}>+ Add Week</button>
        ) : (
          <span className="badge" style={{background:"#f1f5f9",color:"var(--t3)"}}>🔒 Read-only</span>
        )}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {rotWeeks.map(w => {
          const isActive = activeWeek?.id === w.id;
          return (
            <div key={w.id} className="card" style={{border:isActive?"2px solid #E8750A":"1px solid var(--b)",margin:0}}>
              <div className="card-hd">
                <div>
                  <div className="card-title">{w.label}</div>
                  <div style={{fontSize:12,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{w.start} → {w.end}</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {isActive && <span className="badge" style={{background:"#dcfce7",color:"#16a34a"}}>ACTIVE</span>}
                  {canEditWeeks && (
                    <>
                      <button className="btn bo" onClick={() => openWeekModal(w)}>Edit</button>
                      <button className="btn bo" style={{color:"var(--re)"}} onClick={() => deleteWeek(w.id)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,paddingTop:8}}>
                {ERP_DUTY_SLOTS.map(slot => {
                  const m = getMember(w[slot.key]);
                  const lr = m ? isOnLeave(w[slot.key], w.start, w.end) : null;
                  return (
                    <div key={slot.key} style={{padding:"6px 12px",borderRadius:8,background:lr?"#fef2f2":"var(--bg)",border:lr?"2px solid #ef4444":"1px solid var(--b)",display:"flex",alignItems:"center",gap:6,fontSize:12}}>
                      <span>{slot.ico}</span>
                      {m ? (
                        <>
                          <div className="av" style={{background:lr?"#ef4444":m.color||"#7c3aed",width:20,height:20,fontSize:8,borderRadius:4}}>{m.initials}</div>
                          <span style={{fontWeight:600,textDecoration:lr?"line-through":"none",color:lr?"#ef4444":"inherit"}}>{m.name}</span>
                          {lr && <span style={{fontSize:10,fontWeight:700,color:"#dc2626"}} title={`${lr.type}: ${lr.start} → ${lr.end}`}>⚠️ ON LEAVE</span>}
                        </>
                      ) : (
                        <span style={{color:"#ef4444",fontWeight:600}}>Unassigned</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {rotWeeks.length === 0 && <div className="empty"><div className="empty-ico">🔄</div>No rotation weeks configured</div>}
      </div>

      {weekModal && (
        <div className="mo" onClick={e=>e.target.className==="mo"&&setWeekModal(null)}>
          <div className="md">
            <div className="md-title">{weekModal.id === "new" ? "Add Week" : "Edit Week"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div className="fgrp"><label className="flbl">Label</label><input className="fi" value={weekForm.label} onChange={e => setWeekForm(f => ({...f,label:e.target.value}))}/></div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div className="fgrp"><label className="flbl">Start Date</label><input type="date" className="fi" value={weekForm.start} onChange={e => setWeekForm(f => ({...f,start:e.target.value}))}/></div>
                <div className="fgrp"><label className="flbl">End Date</label><input type="date" className="fi" value={weekForm.end} onChange={e => setWeekForm(f => ({...f,end:e.target.value}))}/></div>
              </div>
              {ERP_DUTY_SLOTS.map(slot => (
                <div className="fgrp" key={slot.key}>
                  <label className="flbl">{slot.ico} {slot.label}</label>
                  <select className="fi" value={weekForm[slot.key]} onChange={e => setWeekForm(f => ({...f,[slot.key]:e.target.value}))}>
                    <option value="">— Unassigned —</option>
                    {erpMembers.map(m => <option key={m.id} value={m.id}>{m.name} — {m.erpRole || m.func}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={() => setWeekModal(null)}>Cancel</button>
              <button className="btn bp" onClick={saveWeek}>Save Week</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ── NEW: ERP Duty Rota ── Members Sub-tab ─────────────────────────────────
  const [memSearch, setMemSearch] = useState("");
  const [memFilter, setMemFilter] = useState("All");
  const [memModal, setMemModal] = useState(null); // null | {id:"new"} | {id: userId}
  const [memForm, setMemForm] = useState({userId:"",erpRole:"",notes:""});

  // Available employees not yet in ERP roster
  const rosterUserIds = new Set(erpRosterRaw.map(r => r.user_id));
  const availableEmployees = users.filter(u => u.active && !rosterUserIds.has(u.id));

  const filteredMembers = erpMembers.filter(m => {
    if (memFilter !== "All" && m.status !== memFilter) return false;
    if (memSearch && !m.name.toLowerCase().includes(memSearch.toLowerCase()) && !m.initials.toLowerCase().includes(memSearch.toLowerCase())) return false;
    return true;
  });

  const openMemModal = (m) => {
    if (m) setMemForm({userId:m.id,erpRole:m.erpRole||"",notes:m.notes||""});
    else setMemForm({userId:"",erpRole:"",notes:""});
    setMemModal(m ? {id:m.id} : {id:"new"});
  };

  const saveMember = async () => {
    try {
      if (memModal.id === "new") {
        if (!memForm.userId) { toast("Select an employee."); return; }
        const created = await erpRosterAPI.add({userId:memForm.userId,erpRole:memForm.erpRole,notes:memForm.notes});
        const u = users.find(x => x.id === memForm.userId);
        if (u) setErpRosterRaw(p => [...p, {...created, name:u.name, email:u.email, phone:u.phone, dept:u.dept, type:u.type}]);
      } else {
        await erpRosterAPI.update(memModal.id, {erpRole:memForm.erpRole,notes:memForm.notes});
        setErpRosterRaw(p => p.map(r => r.user_id === memModal.id ? {...r,erp_role:memForm.erpRole,notes:memForm.notes} : r));
      }
      setMemModal(null);
      toast("Member saved.","success");
    } catch (e) { toast("Failed to save member: " + e.message); }
  };

  const deleteMember = async (id) => {
    if (!window.confirm("Remove this ERP member?")) return;
    try {
      await erpRosterAPI.remove(id);
      setErpRosterRaw(p => p.filter(r => r.user_id !== id));
      toast("Member removed.","success");
    } catch (e) { toast("Failed to remove member: " + e.message); }
  };

  const renderMembers = () => (
    <div>
      <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}>
        <input className="fi" placeholder="Search members..." value={memSearch} onChange={e => setMemSearch(e.target.value)} style={{maxWidth:260}}/>
        {["All","OFFICE","ON_SITE","OFF","FIELD"].map(f => (
          <button key={f} className={memFilter===f?"btn bp":"btn bo"} onClick={() => setMemFilter(f)} style={{fontSize:12,padding:"6px 14px"}}>{f === "All" ? "All" : ERP_STATUS_LABELS[f]}</button>
        ))}
        <div style={{flex:1}}/>
        {canAddMembers ? (
          <button className="btn bp" onClick={() => openMemModal(null)}>+ Add Employee</button>
        ) : (
          <span className="badge" style={{background:"#f1f5f9",color:"var(--t3)"}}>🔒 Read-only</span>
        )}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:14}}>
        {filteredMembers.map(m => (
          <div key={m.id} className="card" style={{margin:0}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div className="av" style={{background:m.color||"#7c3aed",width:42,height:42,fontSize:14,borderRadius:10}}>{m.initials}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14}}>{m.name}</div>
                <div style={{fontSize:11,color:"var(--t3)"}}>{m.func}</div>
                <div style={{fontSize:11,color:"var(--v)",fontWeight:600}}>{m.erpRole}</div>
              </div>
              <span className="badge" style={{background:ERP_STATUS_COLORS[m.status]+"22",color:ERP_STATUS_COLORS[m.status]}}>{ERP_STATUS_LABELS[m.status]}</span>
            </div>
            {m.notes && <div style={{marginTop:8,padding:"4px 10px",borderRadius:6,background:"#fffbeb",color:"#92400e",fontSize:11,fontWeight:500}}>📌 {m.notes}</div>}
            <div style={{display:"flex",gap:6,marginTop:10,borderTop:"1px solid var(--b)",paddingTop:10}}>
              {m.phone && m.phone !== "—" && <a href={`tel:${m.phone.replace(/\s/g,"")}`} className="btn bo" style={{fontSize:11,textDecoration:"none"}}>📞 {m.phone}</a>}
              {m.email && <a href={`mailto:${m.email}`} className="btn bo" style={{fontSize:11,textDecoration:"none"}}>✉ Email</a>}
              <div style={{flex:1}}/>
              {canAddMembers && <button className="btn bo" style={{fontSize:11}} onClick={() => openMemModal(m)}>Edit</button>}
              {canAddMembers && <button className="btn bo" style={{fontSize:11,color:"var(--re)"}} onClick={() => deleteMember(m.id)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      {filteredMembers.length === 0 && <div className="empty"><div className="empty-ico">👥</div>No members found</div>}

      {memModal && (
        <div className="mo" onClick={e=>e.target.className==="mo"&&setMemModal(null)}>
          <div className="md">
            <div className="md-title">{memModal.id === "new" ? "Add Employee to ERP Roster" : "Edit ERP Member"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {memModal.id === "new" ? (
                <div className="fgrp">
                  <label className="flbl">Select Employee <span style={{color:"var(--re)"}}>*</span></label>
                  <select className="fi" value={memForm.userId} onChange={e => setMemForm(f => ({...f,userId:Number(e.target.value)}))}>
                    <option value="">— Choose from employees —</option>
                    {availableEmployees.map(u => <option key={u.id} value={u.id}>{u.name} — {u.dept||"No dept"} ({u.type})</option>)}
                  </select>
                  <div style={{fontSize:11,color:"var(--t3)",marginTop:4}}>{availableEmployees.length} employees available</div>
                </div>
              ) : (
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,background:"var(--bg)",border:"1px solid var(--b)"}}>
                  {(() => { const m = erpMembers.find(x => x.id === memModal.id); return m ? (<><div className="av" style={{background:m.color,width:36,height:36,fontSize:12,borderRadius:8}}>{m.initials}</div><div><div style={{fontWeight:700,fontSize:14}}>{m.name}</div><div style={{fontSize:11,color:"var(--t3)"}}>{m.func}</div></div></>) : null; })()}
                </div>
              )}
              <div className="fgrp"><label className="flbl">ERP Role</label>
                <select className="fi" value={memForm.erpRole} onChange={e => setMemForm(f => ({...f,erpRole:e.target.value}))}>
                  <option value="">— Select —</option>
                  {ERP_ROLES_LIST.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="fgrp"><label className="flbl">Notes</label><input className="fi" value={memForm.notes} onChange={e => setMemForm(f => ({...f,notes:e.target.value}))}/></div>
            </div>
            <div className="md-footer">
              <button className="btn bo" onClick={() => setMemModal(null)}>Cancel</button>
              <button className="btn bp" onClick={saveMember}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ── NEW: ERP Duty Rota ── Notify Sub-tab ──────────────────────────────────
  const [notifSubTab, setNotifSubTab] = useState("compose");
  const [notifType, setNotifType] = useState("rotation_reminder");
  const [notifChannel, setNotifChannel] = useState("email");
  const [notifRecipients, setNotifRecipients] = useState([]);
  const [emergencyModal, setEmergencyModal] = useState(false);

  const getTemplate = () => {
    if (notifType === "rotation_reminder") return ERP_MSG_TEMPLATES.rotation_reminder(activeWeek, nextWeek);
    if (notifType === "assignment") return ERP_MSG_TEMPLATES.assignment(null, "Duty", activeWeek);
    if (notifType === "status_alert") return ERP_MSG_TEMPLATES.status_alert(null, "OFFICE", "ON_SITE");
    return {subject:"",body:""};
  };

  const sendNotification = async (isEmergency = false) => {
    const tpl = isEmergency ? {subject:"🚨 EMERGENCY ALERT — Mazarine Energy Tunisia",body:"EMERGENCY ALERT: All ERP duty personnel are required to report immediately.\nEmergency Line: 29 324 484"} : getTemplate();
    const rcpts = isEmergency ? erpMembers : erpMembers.filter(m => notifRecipients.includes(m.id));
    if (!isEmergency && rcpts.length === 0) { toast("Select at least one recipient."); return; }
    const entry = {id:Date.now(),time:new Date().toISOString(),subject:tpl.subject,channel:isEmergency?"all":notifChannel,count:rcpts.length,status:"simulated",isEmergency};
    try {
      await erpNotificationsAPI.send({type:notifType,channel:isEmergency?"all":notifChannel,recipients:rcpts.map(m=>({name:m.name,phone:m.phone,email:m.email})),subject:tpl.subject,body:tpl.body,isEmergency});
      entry.status = "sent";
    } catch { entry.status = "simulated"; }
    setNotifLog(p => [entry,...p]);
    setEmergencyModal(false);
    toast(entry.status === "sent" ? "Notification sent!" : "Notification simulated (backend offline).", entry.status === "sent" ? "success" : "info");
  };

  const toggleRecipient = (id) => {
    setNotifRecipients(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  };

  const renderNotify = () => {
    const tpl = getTemplate();
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{display:"flex",gap:8}}>
            {["compose","history"].map(t => (
              <button key={t} className={notifSubTab===t?"btn bp":"btn bo"} onClick={() => setNotifSubTab(t)} style={{fontSize:12}}>
                {t === "compose" ? "✉ Compose" : "📋 History"}
              </button>
            ))}
          </div>
          {canEmergency && <button onClick={() => setEmergencyModal(true)} style={{padding:"8px 18px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#dc2626,#991b1b)",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>🚨 Emergency Broadcast</button>}
          {!canEmergency && <span className="badge" style={{background:"#fef2f2",color:"#dc2626"}}>🔒 Emergency: Admin/Ops only</span>}
        </div>

        {notifSubTab === "compose" && (
          <div className="g2">
            <div className="card" style={{flex:2}}>
              {!canSendNotif && <div style={{padding:"8px 14px",borderRadius:8,background:"#f1f5f9",color:"var(--t3)",fontSize:12,fontWeight:600,marginBottom:12}}>🔒 Read-only — notification sending restricted</div>}
              <div className="fgrp"><label className="flbl">Notification Type</label>
                <select className="fi" value={notifType} onChange={e => setNotifType(e.target.value)}>
                  <option value="rotation_reminder">Rotation Reminder</option>
                  <option value="assignment">Duty Assignment</option>
                  <option value="status_alert">Status Alert</option>
                </select>
              </div>
              <div className="fgrp" style={{marginTop:12}}><label className="flbl">Channel</label>
                <div style={{display:"flex",gap:8}}>
                  {["email","sms","whatsapp","all"].map(c => (
                    <button key={c} className={notifChannel===c?"btn bp":"btn bo"} onClick={() => setNotifChannel(c)} style={{fontSize:12,padding:"6px 14px",textTransform:"capitalize"}}>{c}</button>
                  ))}
                </div>
              </div>
              <div className="fgrp" style={{marginTop:12}}><label className="flbl">Message Preview</label>
                <div style={{background:"var(--bg)",borderRadius:10,padding:14,border:"1px solid var(--b)"}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:4}}>{tpl.subject}</div>
                  <pre style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--t2)",whiteSpace:"pre-wrap",margin:0}}>{tpl.body}</pre>
                </div>
              </div>
              <div style={{display:"flex",gap:8,marginTop:14}}>
                <button className="btn bo" onClick={() => { setNotifRecipients(erpMembers.map(m=>m.id)); }}>Select All</button>
                <button className="btn bo" onClick={() => setNotifRecipients([])}>Clear</button>
                <div style={{flex:1}}/>
                {canSendNotif && <button className="btn bp" onClick={() => sendNotification(false)}>Send Notification ({notifRecipients.length})</button>}
              </div>
            </div>
            <div className="card">
              <div className="card-hd"><div className="card-title">Recipients</div><span className="badge bgr2">{notifRecipients.length}</span></div>
              {erpMembers.map(m => (
                <div key={m.id} onClick={() => toggleRecipient(m.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 6px",borderBottom:"1px solid var(--b)",cursor:"pointer",borderRadius:6,background:notifRecipients.includes(m.id)?"#f0fdf4":"transparent"}}>
                  <input type="checkbox" checked={notifRecipients.includes(m.id)} readOnly style={{accentColor:"#E8750A"}}/>
                  <div className="av" style={{background:m.color||"#7c3aed",width:26,height:26,fontSize:9,borderRadius:6}}>{m.initials}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:12}}>{m.name}</div>
                    <div style={{fontSize:10,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{m.phone}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {notifSubTab === "history" && (
          <div className="card">
            <div className="card-hd"><div className="card-title">Notification History</div><span className="badge bgr2">{notifLog.length}</span></div>
            {notifLog.length === 0 && <div className="empty"><div className="empty-ico">🔔</div>No notifications sent yet</div>}
            {notifLog.map(n => (
              <div key={n.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:"1px solid var(--b)"}}>
                <span style={{fontSize:18}}>{n.isEmergency ? "🚨" : "📧"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13}}>{n.subject}</div>
                  <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{n.channel} · {n.count} recipients · {new Date(n.time).toLocaleString()}</div>
                </div>
                <span className="badge" style={{background:n.status==="sent"?"#dcfce7":"#fef3c7",color:n.status==="sent"?"#16a34a":"#92400e"}}>{n.status}</span>
              </div>
            ))}
          </div>
        )}

        {emergencyModal && (
          <div className="mo" onClick={e=>e.target.className==="mo"&&setEmergencyModal(false)}>
            <div className="md" style={{maxWidth:440,border:"2px solid #dc2626"}}>
              <div className="md-title" style={{color:"#dc2626"}}>🚨 Emergency Broadcast</div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:48,marginBottom:8}}>🚨</div>
                <div style={{fontWeight:700,fontSize:15,marginBottom:8}}>Send Emergency Alert to ALL {erpMembers.length} ERP Members?</div>
                <div style={{fontSize:12,color:"var(--t3)",marginBottom:4}}>This will broadcast via ALL channels (Email, SMS, WhatsApp).</div>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,fontWeight:700,color:"#dc2626",marginBottom:16}}>Emergency Line: 29 324 484</div>
              </div>
              <div className="md-footer" style={{justifyContent:"center"}}>
                <button className="btn bo" onClick={() => setEmergencyModal(false)}>Cancel</button>
                <button className="btn bd" onClick={() => sendNotification(true)}>Send Now</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── NEW: ERP Duty Rota ── Settings Sub-tab ────────────────────────────────
  const [testConn, setTestConn] = useState(null); // null | "ok" | "fail"
  const testBackend = async () => {
    try {
      const r = await fetch(`${erpSettings.backendUrl}/api/health`);
      setTestConn(r.ok ? "ok" : "fail");
      toast(r.ok ? "Backend connected!" : "Backend unreachable.", r.ok ? "success" : "error");
    } catch { setTestConn("fail"); toast("Backend unreachable."); }
  };

  const resetAllData = async () => {
    if (!window.confirm("Reset ALL ERP Duty Rota data? This cannot be undone.")) return;
    try {
      // Delete all roster entries and weeks via API
      for (const m of erpMembers) await erpRosterAPI.remove(m.id).catch(()=>{});
      for (const w of rotWeeks) await erpWeeksAPI.delete(w.id).catch(()=>{});
      setErpRosterRaw([]);
      setRotWeeks([]);
      setNotifLog([]);
      localStorage.removeItem("maz_erp_settings");
      setErpSettings({backendUrl:"http://localhost:3001",reminderDay:"thursday",reminderChannel:"email",smtpHost:"",smtpUser:"",smtpPass:"",twilioSid:"",twilioToken:"",twilioFrom:"",twilioWa:""});
      toast("All ERP data reset.","success");
    } catch (e) { toast("Reset failed: " + e.message); }
  };

  const renderSettings = () => (
    <div>
      {!canEditSettings && <div style={{padding:"10px 16px",borderRadius:10,background:"#f1f5f9",color:"var(--t3)",fontSize:13,fontWeight:600,marginBottom:16}}>🔒 Read-only — settings changes restricted to Admin</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div className="card" style={{margin:0}}>
          <div className="card-hd"><div className="card-title">Backend Connection</div></div>
          <div className="fgrp"><label className="flbl">Backend URL</label><input className="fi" value={erpSettings.backendUrl} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,backendUrl:e.target.value}))}/></div>
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button className="btn bp" onClick={testBackend}>Test Connection</button>
            {testConn && <span className="badge" style={{background:testConn==="ok"?"#dcfce7":"#fef2f2",color:testConn==="ok"?"#16a34a":"#dc2626"}}>{testConn==="ok"?"✓ Connected":"✗ Failed"}</span>}
          </div>
        </div>
        <div className="card" style={{margin:0}}>
          <div className="card-hd"><div className="card-title">Email (SMTP)</div></div>
          <div className="fgrp"><label className="flbl">SMTP Host</label><input className="fi" value={erpSettings.smtpHost} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,smtpHost:e.target.value}))}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
            <div className="fgrp"><label className="flbl">User</label><input className="fi" value={erpSettings.smtpUser} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,smtpUser:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">Password</label><input type="password" className="fi" value={erpSettings.smtpPass} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,smtpPass:e.target.value}))}/></div>
          </div>
        </div>
        <div className="card" style={{margin:0}}>
          <div className="card-hd"><div className="card-title">Twilio (SMS/WhatsApp)</div></div>
          <div className="fgrp"><label className="flbl">Account SID</label><input className="fi" value={erpSettings.twilioSid} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,twilioSid:e.target.value}))}/></div>
          <div className="fgrp" style={{marginTop:8}}><label className="flbl">Auth Token</label><input type="password" className="fi" value={erpSettings.twilioToken} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,twilioToken:e.target.value}))}/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
            <div className="fgrp"><label className="flbl">SMS From</label><input className="fi" value={erpSettings.twilioFrom} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,twilioFrom:e.target.value}))}/></div>
            <div className="fgrp"><label className="flbl">WhatsApp From</label><input className="fi" value={erpSettings.twilioWa} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,twilioWa:e.target.value}))}/></div>
          </div>
        </div>
        <div className="card" style={{margin:0}}>
          <div className="card-hd"><div className="card-title">Schedule</div></div>
          <div className="fgrp"><label className="flbl">Reminder Day</label>
            <select className="fi" value={erpSettings.reminderDay} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,reminderDay:e.target.value}))}>
              {["monday","tuesday","wednesday","thursday","friday"].map(d => <option key={d} value={d}>{d.charAt(0).toUpperCase()+d.slice(1)}</option>)}
            </select>
          </div>
          <div className="fgrp" style={{marginTop:8}}><label className="flbl">Reminder Channel</label>
            <select className="fi" value={erpSettings.reminderChannel} disabled={!canEditSettings} onChange={e => setErpSettings(s => ({...s,reminderChannel:e.target.value}))}>
              <option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="all">All Channels</option>
            </select>
          </div>
        </div>
      </div>
      {canEditSettings && (
        <div className="card" style={{marginTop:16,border:"1px solid #fecaca"}}>
          <div className="card-hd"><div className="card-title" style={{color:"#dc2626"}}>Danger Zone</div></div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{fontSize:13,color:"var(--t3)"}}>Reset all ERP Duty Rota data to defaults. This cannot be undone.</div>
            <button onClick={resetAllData} style={{padding:"8px 18px",borderRadius:10,border:"1px solid #dc2626",background:"#fff",color:"#dc2626",fontWeight:700,fontSize:13,cursor:"pointer"}}>Reset All Data</button>
          </div>
        </div>
      )}
      <div className="card" style={{marginTop:16}}>
        <div className="card-hd"><div className="card-title">Setup Guide</div></div>
        <div style={{fontSize:13,color:"var(--t2)",lineHeight:1.7}}>
          <div style={{fontWeight:700,marginBottom:4}}>1. Configure Backend</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,background:"var(--bg)",padding:"6px 10px",borderRadius:6,marginBottom:10}}>Set Backend URL → Test Connection → verify ✓</div>
          <div style={{fontWeight:700,marginBottom:4}}>2. Set up Email (SMTP)</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,background:"var(--bg)",padding:"6px 10px",borderRadius:6,marginBottom:10}}>Host: smtp.office365.com | Port: 587 | TLS</div>
          <div style={{fontWeight:700,marginBottom:4}}>3. Set up Twilio (optional)</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,background:"var(--bg)",padding:"6px 10px",borderRadius:6}}>Account SID + Auth Token from twilio.com/console</div>
        </div>
      </div>
    </div>
  );

  // ── NEW: ERP Duty Rota ── Main Render ─────────────────────────────────────
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontSize:11,color:"var(--t3)",fontWeight:500}}>Mazarine Energy Tunisia – Oum Chiah CPF</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--t3)"}}>{new Date().toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short",year:"numeric"})}</span>
          <div style={{display:"flex"}}>
            {erpMembers.filter(m=>m.status!=="OFF").slice(0,6).map(m => (
              <div key={m.id} className="av" style={{background:m.color||"#7c3aed",width:28,height:28,fontSize:9,borderRadius:999,marginLeft:-6,border:"2px solid #fff"}} title={m.name}>{m.initials}</div>
            ))}
          </div>
        </div>
      </div>
      {/* Inner tab strip */}
      <div style={{display:"flex",gap:6,marginBottom:20,background:"var(--bg)",padding:4,borderRadius:12}}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setErpTab(t.key)} style={{
            padding:"8px 16px",borderRadius:8,border:"none",fontSize:13,fontWeight:600,cursor:"pointer",
            background:erpTab===t.key?"#fff":"transparent",
            color:erpTab===t.key?"var(--t1)":"var(--t3)",
            boxShadow:erpTab===t.key?"0 1px 4px rgba(0,0,0,.08)":"none",
            transition:"all .15s"
          }}>
            {t.ico} {t.label}
          </button>
        ))}
      </div>
      {erpLoading ? <div className="empty"><div className="empty-ico">⏳</div>Loading ERP data...</div> : <>
        {erpTab === "dashboard" && renderDashboard()}
        {erpTab === "rotation" && renderRotation()}
        {erpTab === "members" && renderMembers()}
        {erpTab === "notify" && renderNotify()}
        {erpTab === "settings" && renderSettings()}
      </>}
    </div>
  );
}

function AuditTrailView({users}) {
  const [logs,setLogs]=useState([]);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState("");
  const [filterAction,setFilterAction]=useState("");
  const [filterUser,setFilterUser]=useState("");

  useEffect(()=>{
    setLoading(true);
    auditAPI.getAll({limit:200}).then(rows=>{setLogs(rows);setLoading(false);}).catch(()=>setLoading(false));
  },[]);

  function refresh(){
    setLoading(true);
    auditAPI.getAll({limit:200}).then(rows=>{setLogs(rows);setLoading(false);}).catch(()=>setLoading(false));
  }

  const filtered=logs.filter(l=>{
    if(filterAction&&l.action!==filterAction) return false;
    if(filterUser&&String(l.actor_id)!==filterUser&&String(l.target_user_id)!==filterUser) return false;
    if(search){const q=search.toLowerCase();if(!(l.actor_name||"").toLowerCase().includes(q)&&!(l.detail||"").toLowerCase().includes(q)&&!(l.action||"").toLowerCase().includes(q)) return false;}
    return true;
  });

  const actionKeys=Object.keys(ACTION_LABELS);
  const uniqueActions=[...new Set(logs.map(l=>l.action))].sort();

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontWeight:700,fontSize:15}}>Audit Trail</div><div style={{fontSize:12,color:"var(--t3)"}}>{logs.length} events recorded</div></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input className="fi" placeholder="🔍 Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{height:34,maxWidth:200}}/>
          <select className="isel" value={filterAction} onChange={e=>setFilterAction(e.target.value)} style={{height:34}}>
            <option value="">All actions</option>
            {uniqueActions.map(a=><option key={a} value={a}>{ACTION_LABELS[a]?.label||a}</option>)}
          </select>
          <select className="isel" value={filterUser} onChange={e=>setFilterUser(e.target.value)} style={{height:34}}>
            <option value="">All users</option>
            {users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn bo bsm" onClick={refresh}>↺ Refresh</button>
        </div>
      </div>

      <div className="card">
        {loading&&<div style={{padding:"30px",textAlign:"center",color:"var(--t3)"}}>Loading…</div>}
        {!loading&&filtered.length===0&&<div className="empty"><div className="empty-ico">📋</div>No events found</div>}
        {!loading&&filtered.length>0&&(
          <div className="tw">
            <table className="tbl">
              <thead><tr><th style={{width:150}}>Timestamp</th><th style={{width:160}}>Action</th><th>Actor</th><th>Detail</th><th>Target</th></tr></thead>
              <tbody>
                {filtered.map(l=>{
                  const meta=ACTION_LABELS[l.action]||{label:l.action,color:"var(--t3)",ico:"•"};
                  return(
                    <tr key={l.id}>
                      <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--t3)",whiteSpace:"nowrap"}}>
                        {l.created_at?new Date(l.created_at).toLocaleString("fr-TN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—"}
                      </td>
                      <td>
                        <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:meta.color,background:meta.color+"18",padding:"2px 8px",borderRadius:4}}>
                          {meta.ico} {meta.label}
                        </span>
                      </td>
                      <td>
                        {l.actor_name?(
                          <div style={{display:"flex",alignItems:"center",gap:7}}>
                            <div className="av" style={{background:aColor(l.actor_id),width:24,height:24,borderRadius:6,fontSize:9,flexShrink:0}}>{initials(l.actor_name)}</div>
                            <span style={{fontSize:12,fontWeight:600}}>{l.actor_name}</span>
                          </div>
                        ):<span style={{fontSize:12,color:"var(--t3)"}}>System</span>}
                      </td>
                      <td style={{fontSize:12,color:"var(--t2)",maxWidth:300,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={l.detail}>{l.detail||"—"}</td>
                      <td style={{fontSize:12,color:"var(--t3)"}}>{l.target_name||"—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SUPER ADMIN VIEW ─────────────────────────────────────────────────────────
function SuperAdminView({users,setUsers,roles,setRoles,onResetPwd,companySetting,setCompanySetting}) {
  const [tab,setTab]=useState("users");
  const [editUser,setEditUser]=useState(null);
  const [brandName,setBrandName]=useState(companySetting?.companyName||"MAZARINE");
  const [brandSub,setBrandSub]=useState(companySetting?.companySubtitle||"Energy Tunisia");
  const [brandLogo,setBrandLogo]=useState(companySetting?.logoBase64||null);
  const [brandSaving,setBrandSaving]=useState(false);

  async function toggleActive(id){
    const u=users.find(x=>x.id===id);if(!u)return;
    try{await usersAPI.update(id,{...u,active:!u.active});setUsers(p=>p.map(x=>x.id===id?{...x,active:!x.active}:x));}
    catch(err){toast('Failed to update user: '+err.message);}
  }
  async function delUser(id){
    if(id===0){toast("Cannot delete the Super Admin account.");return;}
    if(window.confirm("Permanently delete this user?")){
      try{await usersAPI.delete(id);setUsers(p=>p.filter(u=>u.id!==id));}
      catch(err){toast('Failed to delete user: '+err.message);}
    }
  }

  return (
    <div>
      <div style={{padding:"14px 18px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:"var(--r)",marginBottom:18,display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:22}}>🔴</span>
        <div><div style={{fontWeight:800,fontSize:14,color:"#dc2626"}}>Super Admin Console</div><div style={{fontSize:12,color:"#991b1b",marginTop:2}}>Full system access — manage all users, roles, and credentials. Changes take effect immediately.</div></div>
      </div>
      <div className="tabs">
        <div className={`tab ${tab==="users"?"active":""}`} onClick={()=>setTab("users")}>👥 All Users</div>
        <div className={`tab ${tab==="roles"?"active":""}`} onClick={()=>setTab("roles")}>🔐 Roles</div>
        <div className={`tab ${tab==="audit"?"active":""}`} onClick={()=>setTab("audit")}>📋 Audit Log</div>
        <div className={`tab ${tab==="branding"?"active":""}`} onClick={()=>setTab("branding")}>🏢 Branding</div>
      </div>

      {tab==="users"&&(
        <div>
          <div className="sg">
            <div className="sc"><div className="sa" style={{background:"var(--v)"}}/><div className="sl">Total Users</div><div className="sv" style={{color:"var(--v)"}}>{users.length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--gr)"}}/><div className="sl">Active</div><div className="sv" style={{color:"var(--gr)"}}>{users.filter(u=>u.active).length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--re)"}}/><div className="sl">Inactive</div><div className="sv" style={{color:"var(--re)"}}>{users.filter(u=>!u.active).length}</div></div>
            <div className="sc"><div className="sa" style={{background:"var(--am)"}}/><div className="sl">Roles Defined</div><div className="sv" style={{color:"var(--am)"}}>{Object.keys(roles).length}</div></div>
          </div>
          <div className="tw">
            <table className="tbl">
              <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Type</th><th>Dept</th><th>Status</th><th>Password</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u=>(
                  <tr key={u.id}>
                    <td><div style={{display:"flex",alignItems:"center",gap:9}}><div className="av" style={{background:u.role==="superadmin"?"#dc2626":aColor(u.id)}}>{initials(u.name)}</div><div style={{fontWeight:700,fontSize:13}}>{u.name}</div></div></td>
                    <td style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}}>{u.email}</td>
                    <td><RoleBadge role={u.role} roles={roles}/></td>
                    <td><TypeBadge type={u.type}/></td>
                    <td style={{fontSize:12,color:"var(--t2)"}}>{u.dept}</td>
                    <td><div style={{display:"flex",alignItems:"center",gap:6}}><div className="dot" style={{background:u.active?"var(--gr)":"var(--re)"}}/><span style={{fontSize:12}}>{u.active?"Active":"Inactive"}</span></div></td>
                    <td>
                      {u.mustChangePwd
                        ? <span className="badge bam" style={{fontSize:10}}>⚠ Must change</span>
                        : <span className="badge bgr2" style={{fontSize:10}}>Set</span>}
                    </td>
                    <td>
                      <div style={{display:"flex",gap:4}}>
                        <button className="btn bsm bo bxs" onClick={()=>toggleActive(u.id)} title={u.active?"Deactivate":"Activate"}>
                          {u.active?"🚫":"✓"}
                        </button>
                        <button className="btn bsm bo bxs" title="Reset password" onClick={()=>onResetPwd(u.id)}>🔑</button>
                        {u.role!=="superadmin"&&<button className="btn bsm bd bxs" onClick={()=>delUser(u.id)}>🗑</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab==="roles"&&(
        <div>
          {Object.entries(roles).map(([k,r])=>(
            <div className="card" key={k} style={{marginBottom:12,display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:44,height:44,borderRadius:10,background:r.bg,border:`1px solid ${r.color}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                {k==="superadmin"?"👑":k==="admin"?"🛡":k==="manager"?"🏢":k==="hr"?"📋":"👤"}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:14}}>{r.label}</div>
                <div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{users.filter(u=>u.role===k).length} users · {r.system?"System":"Custom"}</div>
              </div>
              <RoleBadge role={k} roles={roles}/>
              <div style={{fontSize:11,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace",maxWidth:320,lineHeight:1.8}}>
                {r.permissions.join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==="audit"&&<AuditTrailView users={users}/>}

      {tab==="branding"&&(
        <div className="card" style={{maxWidth:560}}>
          <div className="shd">Company Branding</div>
          {/* Logo preview + upload */}
          <div style={{marginBottom:20}}>
            <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>Company Logo</div>
            <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:10}}>
              {brandLogo
                ? <img src={brandLogo} alt="logo" style={{width:64,height:64,borderRadius:10,objectFit:"contain",border:"1px solid var(--b)",background:"#f8fafc"}}/>
                : <div style={{width:64,height:64,borderRadius:10,background:"var(--v)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:22}}>{(brandName||"ME").slice(0,2).toUpperCase()}</div>}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <label className="btn bo" style={{cursor:"pointer",display:"inline-block"}}>
                  📂 Upload Logo
                  <input type="file" accept="image/*" style={{display:"none"}} onChange={e=>{
                    const file=e.target.files[0];
                    if(!file)return;
                    if(file.size>500*1024){toast("Logo must be under 500 KB");return;}
                    const reader=new FileReader();
                    reader.onload=ev=>setBrandLogo(ev.target.result);
                    reader.readAsDataURL(file);
                    e.target.value="";
                  }}/>
                </label>
                {brandLogo&&<button className="btn bd" onClick={()=>setBrandLogo(null)}>🗑 Remove Logo</button>}
              </div>
            </div>
            <div style={{fontSize:11,color:"var(--t3)"}}>PNG or SVG recommended · max 500 KB · displayed in sidebar and login screen</div>
          </div>
          {/* Company name */}
          <div style={{marginBottom:14}}>
            <label style={{display:"block",fontWeight:600,fontSize:13,marginBottom:6}}>Company Name</label>
            <input className="inp" value={brandName} onChange={e=>setBrandName(e.target.value)} placeholder="MAZARINE" style={{width:"100%"}}/>
          </div>
          {/* Subtitle */}
          <div style={{marginBottom:22}}>
            <label style={{display:"block",fontWeight:600,fontSize:13,marginBottom:6}}>Subtitle / Division</label>
            <input className="inp" value={brandSub} onChange={e=>setBrandSub(e.target.value)} placeholder="Energy Tunisia" style={{width:"100%"}}/>
          </div>
          {/* Save */}
          <button className="btn bp" disabled={brandSaving} onClick={async()=>{
            setBrandSaving(true);
            try{
              const r=await companyAPI.updateSettings({companyName:brandName,companySubtitle:brandSub,logoBase64:brandLogo||null});
              setCompanySetting({companyName:r.company_name||brandName,companySubtitle:r.company_subtitle||brandSub,logoBase64:r.logo_base64||null});
              toast("Branding saved.", 'success');
            }catch(err){toast("Failed to save branding: "+err.message);}
            finally{setBrandSaving(false);}
          }}>{brandSaving?"Saving…":"💾 Save Branding"}</button>
        </div>
      )}
    </div>
  );
}

// ─── AUTHENTICATED APP SHELL ──────────────────────────────────────────────────
// ─── APP (single component — ALL hooks declared unconditionally at top) ────────
export default function App() {
  // ── Data state
  const [users,         setUsers]         = useState(INITIAL_USERS);
  const [requests,      setRequests]      = useState(INITIAL_REQUESTS);
  const [projects,      setProjects]      = useState(INITIAL_PROJECTS);
  const [roles,         setRoles]         = useState(INITIAL_ROLES);
  const [activities,    setActivities]    = useState([]);
  const [holidays,      setHolidays]      = useState([]);
  const [entities,      setEntities]      = useState([]);
  const [departments,   setDepartments]   = useState([]);
  const [balanceTypes,  setBalanceTypes]  = useState([]);
  const [userBalances,  setUserBalances]  = useState([]);
  const [rotationPlans, setRotationPlans] = useState([]);
  const [workflows,     setWorkflows]     = useState([]);
  const [companySetting,setCompanySetting]= useState({companyName:"MAZARINE",companySubtitle:"Energy Tunisia",logoBase64:null});
  const [timesheetData, setTimesheetData] = useState({});
  const [tsStatuses,    setTsStatuses]    = useState(INITIAL_TS_STATUS);
  // ── Auth state
  const [session,       setSession]       = useState(localStorage.getItem('token') ? JSON.parse(localStorage.getItem('user') || '{}').id : null);
  const [currentUser,   setCurrentUser]   = useState(JSON.parse(localStorage.getItem('user') || 'null'));
  const [sessionChecked,setSessionChecked]= useState(false);

  // Verify session is still valid on app startup — if expired, clear and show login
  useEffect(() => {
    if (!localStorage.getItem('token')) { setSessionChecked(true); return; }
    verifySession().then(ok => {
      if (!ok) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setSession(null);
        setCurrentUser(null);
      }
      setSessionChecked(true);
    });
  }, []);
  // ── UI state
  const [view,          setView]          = useState("dashboard");
  const [showPwdModal,  setShowPwdModal]  = useState(false);
  const [profileOpen,   setProfileOpen]   = useState(false);
  const [sidebarOpen,   setSidebarOpen]   = useState(false);
  const [pushSubbed,    setPushSubbed]    = useState(false);  // is current browser subscribed?
  const [pushBusy,      setPushBusy]      = useState(false);
  const [showTOTPModal, setShowTOTPModal] = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const theme = "enterprise";

  // Apply theme CSS variables to document root
  useEffect(() => {
    const root = document.documentElement;
    const t = THEMES.enterprise;
    if (t && t.vars) Object.entries(t.vars).forEach(([k,v]) => root.style.setProperty(k,v));
  }, []);

  // ── Load company settings on mount (public endpoint, no auth needed) ──────────
  useEffect(() => {
    companyAPI.getSettings().then(r => {
      if (r) setCompanySetting({companyName:r.company_name||"MAZARINE",companySubtitle:r.company_subtitle||"Energy Tunisia",logoBase64:r.logo_base64||null});
    }).catch(()=>{});
  }, []); // eslint-disable-line

  // ── Data Loading from API ─────────────────────────────────────────────────────
  useEffect(() => {
    if (session == null) return;
    
    const loadData = async () => {
      setLoading(true);
      try {
        const [usersData, projectsData, requestsData, rolesData, activitiesData, rotationsData, holidaysData, entitiesData, workflowsData, deptsData, balanceTypesData, userBalancesData] = await Promise.all([
          usersAPI.getAll(),
          projectsAPI.getAll(),
          requestsAPI.getAll(),
          rolesAPI.getAll(),
          activitiesAPI.getAll(),
          rotationAPI.getAll(),
          holidaysAPI.getAll(),
          companyEntitiesAPI.getAll(),
          workflowsAPI.getAll().catch(() => []),
          departmentsAPI.getAll().catch(() => []),
          balanceTypesAPI.getAll().catch(() => []),
          userBalancesAPI.getAll().catch(() => [])
        ]);
        setDepartments(deptsData);
        setBalanceTypes(balanceTypesData);
        setUserBalances(userBalancesData);
        
        setUsers(usersData.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          type: u.type,
          dept: u.dept,
          manager: u.manager_id,
          functionalManager: u.functional_manager_id,
          active: u.active,
          leaveBalance: u.leave_balance,
          usedLeave: u.used_leave,
          recoveryBalance: u.recovery_balance || 0,
          mustChangePwd: u.must_change_pwd,
          totpEnabled: u.totp_enabled || false,
          allowOverlap: u.allow_overlap || false,
          payrollId: u.payroll_id || ""
        })));
        
        setProjects(projectsData.map(p => ({
          id: p.id,
          code: p.code,
          name: p.name,
          dept: p.dept,
          open: p.open,
          fieldAllowed: p.field_allowed,
          officeAllowed: p.office_allowed,
          color: p.color,
          expiryDate: p.expiry_date || null,
          entityId: p.entity_id || null,
          entityCode: p.entity_code || null,
          entityName: p.entity_name || null
        })));
        
        setRequests(requestsData.map(r => ({
          id: r.id,
          userId: r.user_id,
          type: r.type,
          start: r.start_date?.slice(0,10),
          end: r.end_date?.slice(0,10),
          status: r.status,
          comment: r.comment,
          daysCount: r.days_count ? Number(r.days_count) : 0,
          durationHours: r.duration_hours ? Number(r.duration_hours) : null,
          halfDayStart: r.half_day_start || "",
          halfDayEnd: r.half_day_end || "",
          balanceSource: r.balance_source || "annual",
          authStartTime: r.auth_start_time || null,
          authEndTime: r.auth_end_time || null,
          createdAt: r.created_at?.slice(0,10) || null,
          reviewedAt: r.reviewed_at?.slice(0,10) || null,
          reviewedBy: r.reviewed_by || null,
          approvalStep: r.approval_step || 1,
          totalSteps: r.total_steps || 1,
          step1ReviewedBy: r.step1_reviewed_by || null,
          step1ReviewedAt: r.step1_reviewed_at?.slice(0,10) || null,
          step1Comment: r.step1_comment || null,
          currentApproverId: r.current_approver_id || null,
          workflowInstanceId: r.workflow_instance_id || null,
          attachmentUrl: r.attachment_url || null
        })));
        
        const rolesObj = {};
        rolesData.forEach(r => {
          rolesObj[r.key] = {
            label: r.label,
            color: r.color,
            bg: colorBg(r.color),
            permissions: r.permissions,
            system: r.system
          };
        });
        setRoles(rolesObj);

        setActivities(activitiesData.map(a=>({
          id:a.id, name:a.name, visibleTo:a.visible_to,
          isLeave:a.is_leave, color:a.color, active:a.active, sortOrder:a.sort_order,
          balanceTypeId:a.balance_type_id
        })));

        setRotationPlans(rotationsData.map(r=>({
          id:r.id, userId:r.user_id, onStart:r.on_start, onEnd:r.on_end
        })));

        const mappedHolidays = holidaysData.map(h=>({id:h.id,date:h.date.slice(0,10),name:h.name}));
        HOLIDAYS = mappedHolidays.map(h=>h.date);
        setHolidays(mappedHolidays);
        setEntities(entitiesData || []);
        setWorkflows((workflowsData || []).map(w => ({
          id: w.id, name: w.name, entityType: w.entity_type, targetDept: w.target_dept,
          targetStaffType: w.target_staff_type, targetActivityType: w.target_activity_type,
          priority: w.priority || 0, isActive: w.is_active, steps: typeof w.steps === 'string' ? JSON.parse(w.steps) : (w.steps || []),
          createdAt: w.created_at?.slice(0,10) || null
        })));

      } catch (err) {
        console.error('Failed to load data:', err);
        setError('Failed to load data from server');
      } finally {
        setLoading(false);
      }
    };
    
    loadData();
  }, [session]);

  // ── All hooks must be ABOVE any conditional returns ──────────────────────────
  const user   = currentUser || (session != null ? (users.find(u => u.id === session) || null) : null);
  const isSA   = user ? user.role === "superadmin"                            : false;
  const isAd   = user ? hasPerm(roles, user.role, "all")                      : false;
  const canApp = user ? (hasPerm(roles, user.role, "approve") || isAd || users.some(u=>u.manager===user.id)) : false;
  const hasAna = user ? (hasPerm(roles, user.role, "analytics") || isAd)      : false;
  const hasHR  = user ? (hasPerm(roles, user.role, "hr_report") || isAd)      : false;

  const pendReq = useMemo(() => {
    if (!user) return 0;
    return requests.filter(r => {
      if (r.status !== "Pending" && r.status !== "Pending L2") return false;
      // Workflow-driven: check if current user is the designated approver
      if (r.currentApproverId === user.id) return true;
      // Admins see all pending
      if (isAd) return true;
      // Legacy: managers see their team's pending requests
      const emp = users.find(u => u.id === r.userId);
      if (emp && r.status === "Pending" && emp.manager === user.id) return true;
      return false;
    }).length;
  }, [requests, users, user, isAd]);

  const pendTS = useMemo(() => {
    if (!user) return 0;
    const teamIds = isAd
      ? users.map(u => u.id)
      : users.filter(u => u.manager === user.id).map(u => u.id);
    return Object.entries(tsStatuses).filter(([k, v]) => {
      const uid = Number(k.split("-")[0]);
      return v.status === "submitted" && teamIds.includes(uid);
    }).length;
  }, [tsStatuses, users, user, isAd]);

  useEffect(() => {
    const fn = () => setProfileOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Login/Logout handlers with API ─────────────────────────────────────────────
  function storeLogin(response) {
    localStorage.setItem('token', response.token);
    localStorage.setItem('user', JSON.stringify(response.user));
    setSession(response.user.id);
    setCurrentUser(response.user);
    setView("dashboard");
  }

  async function handleLogin(email, password, ssoResponse = null) {
    if (ssoResponse) { storeLogin(ssoResponse); return; } // SSO path
    const response = await authAPI.login(email, password);
    if (response.requiresTOTP) return response; // LoginScreen handles step 2
    storeLogin(response);
  }

  async function handleTOTPLogin(pendingUserId, code) {
    const response = await totpAPI.verifyLogin(pendingUserId, code);
    storeLogin(response);
  }
  
  function handleLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setSession(null);
    setCurrentUser(null);
    setView("dashboard");
    setProfileOpen(false);
    setUsers([]);
    setRequests([]);
    setProjects([]);
    setRoles({});
    setActivities([]);
    setEntities([]);
    setRotationPlans([]);
    setPushSubbed(false);
  }

  // ── Push notification helpers ─────────────────────────────────────────────
  useEffect(()=>{
    if(!session||!('serviceWorker' in navigator)||!('PushManager' in window)) return;
    navigator.serviceWorker.ready.then(reg=>reg.pushManager.getSubscription()).then(sub=>{
      setPushSubbed(!!sub);
    }).catch(()=>{});
  },[session]);

  async function togglePush() {
    if(!('serviceWorker' in navigator)||!('PushManager' in window)){
      toast('Push notifications are not supported in this browser.');return;
    }
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if(pushSubbed) {
        const sub = await reg.pushManager.getSubscription();
        if(sub){ await pushAPI.unsubscribe({endpoint:sub.endpoint}); await sub.unsubscribe(); }
        setPushSubbed(false);
      } else {
        const perm = await Notification.requestPermission();
        if(perm!=='granted'){ toast('Notification permission denied.'); return; }
        const {publicKey} = await pushAPI.getVapidKey();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly:true,
          applicationServerKey: publicKey
        });
        const j = sub.toJSON();
        await pushAPI.subscribe({endpoint:j.endpoint,keys:{p256dh:j.keys.p256dh,auth:j.keys.auth}});
        setPushSubbed(true);
      }
    } catch(e){ toast('Push error: '+e.message); }
    finally { setPushBusy(false); }
  }

  async function adminResetPwd(uid) {
    const tmp = "Mazarine@Temp1!";
    try {
      await usersAPI.resetPassword(uid, tmp);
      setUsers(p => p.map(u => u.id === uid ? {...u, mustChangePwd: true} : u));
      toast(`Password reset. Temporary: ${tmp}. User must change on next login.`, 'success');
    } catch (err) {
      toast('Failed to reset password: ' + err.message);
    }
  }

  // ── Auth gates ───────────────────────────────────────────────────────────────
  // While verifying the session on startup, show a blank splash so no stale data flashes
  if (!sessionChecked && localStorage.getItem('token')) return (
    <><style>{CSS}</style>
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"var(--bg)"}}>
        <div style={{fontSize:14,color:"var(--t3)"}}>Loading…</div>
      </div>
    </>
  );
  if (!user) return (
    <><style>{CSS}</style><LoginScreen onLogin={handleLogin} onVerifyTOTP={handleTOTPLogin} cs={companySetting}/></>
  );
  if (user.mustChangePwd) return (
    <><style>{CSS}</style>
      <ChangePasswordModal user={user} forced onClose={()=>{
        const updated = {...currentUser, mustChangePwd: false};
        setCurrentUser(updated);
        localStorage.setItem('user', JSON.stringify(updated));
      }} />
    </>
  );
  // ─────────────────────────────────────────────────────────────────────────────

  // ── API-enabled state setters ──────────────────────────────────────────────────
  const apiSetUsers = async (updater) => {
    const newUsers = typeof updater === 'function' ? updater(users) : updater;
    setUsers(newUsers);
  };
  
  const apiSetProjects = async (updater) => {
    const newProjects = typeof updater === 'function' ? updater(projects) : updater;
    setProjects(newProjects);
  };
  
  const apiSetRequests = async (updater) => {
    const newRequests = typeof updater === 'function' ? updater(requests) : updater;
    setRequests(newRequests);
  };
  
  const apiSetRoles = async (updater) => {
    const newRoles = typeof updater === 'function' ? updater(roles) : updater;
    setRoles(newRoles);
  };
  
  const apiSetTsStatuses = async (updater) => {
    const newStatuses = typeof updater === 'function' ? updater(tsStatuses) : updater;
    setTsStatuses(newStatuses);
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const totalBadge = pendReq + pendTS;

  const NAV = [
    {key:"dashboard",  label:"Dashboard",   ico:"⊞",  show:true},
    {key:"schedule",   label:"Schedule",    ico:"📅", show:!isSA&&user.type==="field"},
    {key:"erp_rota",   label:"ERP Duty Rota",ico:"🔄", show:!isSA&&(isAd||hasPerm(roles,user.role,"erp_rota")), badge:daysUntilFriday()+"d"},
    {key:"timesheet",  label:"Timesheet",   ico:"🗒", show:!isSA},
    {key:"requests",   label:"Requests",    ico:"📋", show:!isSA, badge:requests.filter(r=>r.userId===user.id&&r.status==="Pending").length},
    {key:"org-chart",  label:"Org Chart",   ico:"🏢", show:!isSA},
    {key:"analytics",  label:"Analytics",   ico:"📊", show:(hasAna||hasHR)&&!isSA},
    {key:"approvals",  label:"Approvals",   ico:"✅", show:canApp&&!isSA, badge:totalBadge},
    {key:"crew-planner",label:"Crew Planner",ico:"👷", show:(isAd||hasHR||canApp)&&!isSA},
    {key:"balances",   label:"Leave Balances",ico:"📊", show:(isAd||hasHR)&&!isSA},
    {key:"hr-report",  label:"HR Report",   ico:"📋", show:hasHR&&!isSA},
    {key:"audit",      label:"Audit Trail", ico:"📋", show:(isAd||hasHR)&&!isSA},
    {key:"settings",   label:"Settings",    ico:"⚙️", show:isAd},
  ].filter(n => n.show);

  const TITLES = {dashboard:"Dashboard",schedule:"My Schedule",erp_rota:"ERP Duty Rota",timesheet:"Timesheet",requests:"My Requests","org-chart":"Organisation Chart",analytics:"Analytics & Reports",approvals:"Approvals","crew-planner":"Crew Rotation Planner",balances:"Leave Balances","hr-report":"HR Report",audit:"Audit Trail",settings:"Settings"};
  const PAGE_META = {
    dashboard:   {desc:"Overview of your activity, leave balances, and key metrics",section:"Home"},
    schedule:    {desc:"Field rotation calendar with ON/OFF cycles and availability",section:"Operations"},
    erp_rota:    {desc:"Emergency response duty rotation, personnel, and notifications",section:"Operations"},
    timesheet:   {desc:"Monthly timesheet entries, project allocations, and submissions",section:"Time Management"},
    requests:    {desc:"Submit and track leave, mission, and other requests",section:"Time Management"},
    "org-chart": {desc:"Interactive organisation structure and reporting lines",section:"People"},
    analytics:   {desc:"Hours breakdown, project allocation, and workforce analytics",section:"Reports"},
    approvals:   {desc:"Review and approve pending timesheets and requests",section:"Management"},
    "crew-planner":{desc:"Visual 6-month view of field crew rotations, site coverage, and leave planning",section:"Management"},
    balances:    {desc:"Manage employee annual leave, used days, and recovery balances",section:"Management"},
    "hr-report": {desc:"Payroll summaries, attendance, and compliance reports",section:"Reports"},
    audit:       {desc:"System activity log with user actions and change history",section:"Administration"},
    settings:    {desc:"Users, roles, projects, activities, and system configuration",section:"Administration"},
  };
  const isEnterprise = true;

  return (
    <>
      <style>{CSS}</style>
      <ToastContainer />
      <div className="app">
        {/* ── Sidebar ── */}
        {/* Mobile overlay */}
        <div className={`sb-overlay${sidebarOpen?" open":""}`} onClick={()=>setSidebarOpen(false)}/>

        <aside className={`sb${sidebarOpen?" open":""}`}>
          <div style={{padding:"14px 16px",borderBottom:"1px solid var(--b)",display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>{setView("dashboard");setSidebarOpen(false);}}>
            {companySetting.logoBase64
              ? <img src={companySetting.logoBase64} alt="logo" style={{width:32,height:32,borderRadius:6,objectFit:"contain",flexShrink:0}}/>
              : <div className="logo-ico" style={{width:32,height:32,fontSize:12,borderRadius:6}}>{(companySetting.companyName||"ME").slice(0,2).toUpperCase()}</div>}
            <div style={{minWidth:0}}>
              <div className="logo-co" style={{fontSize:14,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{companySetting.companyName||"MAZARINE"}</div>
              {companySetting.companySubtitle && <div className="logo-sub" style={{fontSize:10,color:"var(--t3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{companySetting.companySubtitle}</div>}
            </div>
          </div>
          <nav className="nav" style={{paddingTop:12}}>
            <div className="nl">Navigation</div>
            {NAV.slice(0, isSA ? 2 : 5).map(n => (
              <div key={n.key} className={`ni${view===n.key?" active":""}`} onClick={()=>{setView(n.key);setSidebarOpen(false);}}>
                <span className="ni-ico">{n.ico}</span>{n.label}
                {(n.badge||0)>0 && <span className="nbadge">{n.badge}</span>}
              </div>
            ))}
            {!isSA && NAV.length > 5 && (
              <>
                <div className="nl" style={{marginTop:6}}>Management</div>
                {NAV.slice(5).map(n => (
                  <div key={n.key} className={`ni${view===n.key?" active":""}`} onClick={()=>{setView(n.key);setSidebarOpen(false);}}>
                    <span className="ni-ico">{n.ico}</span>{n.label}
                    {(n.badge||0)>0 && <span className="nbadge">{n.badge}</span>}
                  </div>
                ))}
              </>
            )}
          </nav>
        </aside>

        {/* ── Main ── */}
        <main className="main">
          <div className="topbar">
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <button className="hamburger" onClick={()=>setSidebarOpen(o=>!o)} aria-label="Menu">
                <span/><span/><span/>
              </button>
              <span className="pg-title">{NAV.find(n=>n.key===view)?.label||"Dashboard"}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <span className="topbar-date" style={{fontSize:12,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>
                {new Date().toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short",year:"numeric"})}
              </span>
              {totalBadge > 0 && canApp && !isSA && (
                <button className="btn bo bsm" style={{color:"var(--am)",borderColor:"var(--am)"}} onClick={()=>setView("approvals")}>
                  🔔 {totalBadge}
                </button>
              )}
              {/* Push notification bell */}
              {'serviceWorker' in navigator && 'PushManager' in window && (
                <button
                  className="btn bo bsm"
                  title={pushSubbed?"Disable push notifications":"Enable push notifications"}
                  onClick={togglePush}
                  disabled={pushBusy}
                  style={{fontSize:16,padding:"4px 8px",opacity:pushBusy?.5:1}}
                >
                  {pushSubbed ? '🔔' : '🔕'}
                </button>
              )}
              {/* Profile dropdown */}
              <div className="profile-dd" onMouseDown={e=>e.stopPropagation()}>
                <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>setProfileOpen(o=>!o)}>
                  <div className="av" style={{background:isSA?"#dc2626":aColor(user.id),width:34,height:34,borderRadius:8}}>
                    {initials(user.name)}
                  </div>
                  <div className="profile-name" style={{minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--t)",lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{user.name}</div>
                    <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.2}}>{isSA?"Admin":user.dept||user.role}</div>
                  </div>
                </div>
                {profileOpen && (
                  <div className="profile-menu">
                    <div style={{padding:"12px 14px 8px"}}>
                      <div style={{fontWeight:700,fontSize:13}}>{user.name}</div>
                      <div style={{fontSize:11,color:"var(--t3)",marginTop:1}}>{user.email}</div>
                      <div style={{marginTop:5}}><RoleBadge role={user.role} roles={roles}/></div>
                    </div>
                    <div className="profile-menu-sep"/>
                    <div className="profile-menu-item" onClick={()=>{setShowPwdModal(true);setProfileOpen(false);}}>
                      🔐 Change Password
                    </div>
                    <div className="profile-menu-item" onClick={()=>{setShowTOTPModal(true);setProfileOpen(false);}}>
                      🔒 Two-Factor Auth
                    </div>
                    {isAd && (
                      <div className="profile-menu-item" onClick={()=>{setView("settings");setProfileOpen(false);}}>
                        ⚙️ Settings
                      </div>
                    )}
                    <div className="profile-menu-sep"/>
                    <div className="profile-menu-item danger" onClick={handleLogout}>🚪 Sign Out</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="content">
            {isEnterprise && !isSA && PAGE_META[view] && (
              <div className="ent-page-header">
                <div className="ent-ph-left">
                  <div className="ent-ph-desc">{PAGE_META[view].desc}</div>
                </div>
                <div className="ent-ph-right">
                  <div className="ent-ph-meta">
                    <span className="ent-ph-chip">{user.type==="field"?"Field":"Office"}</span>
                    <span className="ent-ph-chip">{user.dept||"—"}</span>
                    <span className="ent-ph-chip ent-ph-chip-muted">{MONTHS[new Date().getMonth()]} {new Date().getFullYear()}</span>
                  </div>
                </div>
              </div>
            )}
            {isSA && view !== "settings" ? (
              <SuperAdminView users={users} setUsers={setUsers} roles={roles} setRoles={setRoles} onResetPwd={adminResetPwd} companySetting={companySetting} setCompanySetting={setCompanySetting}/>
            ) : (
              <>
                {view==="dashboard"  && !isSA && <Dashboard   user={user} requests={requests} projects={projects} roles={roles} tsStatuses={tsStatuses} rotations={rotationPlans} users={users} setView={setView}/>}
                {view==="schedule"   && <ScheduleView user={user} rotations={rotationPlans} users={users} rotationPlans={rotationPlans} setRotationPlans={setRotationPlans} canManage={isAd||hasHR}/>}
                {view==="erp_rota"   && <ERPDutyRotaView user={user} users={users} roles={roles} requests={requests}/>}
                {view==="timesheet"  && <TimesheetView user={user} projects={projects} timesheetData={timesheetData} setTimesheetData={setTimesheetData} tsStatuses={tsStatuses} setTsStatuses={setTsStatuses} activities={activities} rotations={rotationPlans} requests={requests}/>}
                {view==="requests"   && <RequestsView  user={user} requests={requests} setRequests={setRequests} users={users} roles={roles} setUsers={setUsers} tsStatuses={tsStatuses} setTsStatuses={setTsStatuses} activities={activities}/>}
                {view==="org-chart"  && <OrgChartView user={user} users={users} roles={roles}/>}
                {view==="analytics"  && (hasAna||hasHR) && <AnalyticsReports user={user} requests={requests} users={users} projects={projects} roles={roles} tsStatuses={tsStatuses} activities={activities}/>}
                {view==="approvals"  && canApp && <ApprovalsView user={user} requests={requests} setRequests={setRequests} users={users} setUsers={setUsers} roles={roles} tsStatuses={tsStatuses} setTsStatuses={setTsStatuses} timesheetData={timesheetData} setTimesheetData={setTimesheetData} projects={projects} activities={activities} rotations={rotationPlans}/>}
                {view==="crew-planner"&& (isAd||hasHR||canApp) && <CrewPlannerView user={user} users={users} requests={requests} rotations={rotationPlans} setRotationPlans={setRotationPlans} roles={roles} canManage={isAd||hasHR}/>}
                {view==="balances"   && (isAd||hasHR) && <LeaveBalancesView users={users} setUsers={setUsers} roles={roles} user={user} balanceTypes={balanceTypes} userBalances={userBalances} setUserBalances={setUserBalances}/>}
                {view==="hr-report"  && hasHR  && <HRReport requests={requests} users={users} tsStatuses={tsStatuses} activities={activities}/>}
                {view==="audit"      && (isAd||hasHR) && <AuditTrailView users={users}/>}
                {view==="settings"   && isAd   && <Settings user={user} users={users} setUsers={setUsers} projects={projects} setProjects={setProjects} roles={roles} setRoles={setRoles} onResetPwd={adminResetPwd} activities={activities} setActivities={setActivities} holidays={holidays} setHolidays={setHolidays} entities={entities} setEntities={setEntities} workflows={workflows} setWorkflows={setWorkflows} departments={departments} setDepartments={setDepartments} balanceTypes={balanceTypes} setBalanceTypes={setBalanceTypes}/>}
              </>
            )}
          </div>
        </main>
      </div>

      {showPwdModal && (
        <ChangePasswordModal user={user} onClose={()=>setShowPwdModal(false)} />
      )}
      {showTOTPModal && (
        <TwoFactorModal onClose={()=>setShowTOTPModal(false)} />
      )}
    </>
  );
}

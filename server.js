#!/usr/bin/env node
'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { exec } = require('child_process');
const os    = require('os');

const PORT          = process.env.PORT || 3000;
const AGENTS        = ['benjamin','spinoza','luke','emma','nut','bolt'];
const BASE          = path.join(os.homedir(), '.openclaw', 'agents');
const PERSONAS_FILE = path.join(os.homedir(), '.openclaw', 'personas.json');
const COUNCIL_FILE  = path.join(os.homedir(), '.openclaw', 'council.jsonl');

const ROLES = {
  benjamin : 'Senior Architect',
  spinoza  : 'Ethics & Philosophy',
  luke     : 'Full Stack Dev',
  emma     : 'UI/UX Designer',
  nut      : 'DevOps Engineer',
  bolt     : 'Performance Optimizer',
};

const DEFAULT_PERSONAS = {};  // 에이전트 디렉토리에서 자동 로드

// 에이전트의 soul/persona 파일을 자동으로 읽어옴
// 읽는 순서: SOUL.md → CLAUDE.md → persona.md → soul.md
function readAgentSoul(name) {
  const candidates = ['SOUL.md', 'CLAUDE.md', 'persona.md', 'soul.md'];
  const searchDirs = [
    path.join(BASE, name),
    path.join(BASE, name, 'workspace'),
    path.join(os.homedir(), '.openclaw', 'workspace', name),
  ];
  for (const dir of searchDirs) {
    for (const file of candidates) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        if (content.trim()) return content.slice(0, 2000);
      } catch {}
    }
  }
  return null;
}

// ─── Data layer ───────────────────────────────────────────────
function readSessionsJson(name) {
  const p = path.join(BASE, name, 'sessions', 'sessions.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readSessionFilePath(name) {
  const raw = readSessionsJson(name);
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (raw.sessionFile)    return raw.sessionFile;
  if (raw.currentSession) return raw.currentSession;
  if (raw.path)           return raw.path;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const entries = Object.values(raw).filter(v => v && v.sessionId);
    if (entries.length) {
      entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return path.join(BASE, name, 'sessions', entries[0].sessionId + '.jsonl');
    }
  }
  if (Array.isArray(raw) && raw.length) {
    const sorted = [...raw].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const f = sorted[0];
    return f.sessionFile || f.path || f.file || null;
  }
  return null;
}

function readLatestSessionMeta(name) {
  const raw = readSessionsJson(name);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.values(raw).filter(v => v && v.sessionId);
  if (!entries.length) return null;
  entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return entries[0];
}

function getAllSessionMetas(name) {
  const raw = readSessionsJson(name);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.values(raw)
    .filter(v => v && v.sessionId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function parseJsonl(fp) {
  try {
    return fs.readFileSync(fp, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function extractText(e) {
  const c = e?.message?.content ?? e?.content ?? e?.text ?? null;
  if (!c) return null;
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    for (const x of c) {
      if (x?.type === 'text' && x.text) return x.text.trim();
      if (typeof x === 'string' && x.trim()) return x.trim();
    }
  }
  return null;
}

function msgType(e) { return e?.type || e?.role || e?.message?.role || 'unknown'; }
function msgTs(e)   { return e?.timestamp || e?.ts || e?.time || null; }

function getAgentData(name) {
  const meta  = readLatestSessionMeta(name);
  const metas = getAllSessionMetas(name);
  const sf    = readSessionFilePath(name);
  const msgs  = sf ? parseJsonl(sf) : [];

  let lastTs  = null;
  let lastMsg = null;

  if (meta && meta.updatedAt) lastTs = new Date(meta.updatedAt).toISOString();
  if (meta && meta.label)     lastMsg = { type: 'system', text: meta.label };

  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!lastTs && msgTs(msgs[i])) lastTs = msgTs(msgs[i]);
    if (!lastMsg || lastMsg.type === 'system') {
      const t = extractText(msgs[i]);
      if (t) lastMsg = { type: msgType(msgs[i]), text: t.slice(0, 120) };
    }
    if (lastTs && lastMsg && lastMsg.type !== 'system') break;
  }

  const age    = lastTs ? Date.now() - new Date(lastTs).getTime() : Infinity;
  const status = age < 60000 ? 'active' : age < 300000 ? 'recent' : 'idle';

  const display = msgs.slice(-40).map(m => ({
    type : msgType(m),
    text : extractText(m),
    ts   : msgTs(m),
  })).filter(m => m.text);

  if (!display.length && metas.length) {
    display.push(...metas.slice(0, 20).map(v => ({
      type : 'system',
      text : v.label + (v.totalTokens ? ` [${v.totalTokens.toLocaleString()} 토큰]` : ''),
      ts   : new Date(v.updatedAt).toISOString(),
    })));
  }

  const totalTokens  = metas.reduce((s, v) => s + (v.totalTokens || 0), 0);
  const sessionCount = metas.length;

  return { name, role: ROLES[name] || 'Agent', status, lastActivity: lastTs, lastMessage: lastMsg, messages: display, stats: { totalTokens, sessionCount } };
}

// ─── Personas ─────────────────────────────────────────────────
// saved personas.json > agent soul file > empty
function readPersonas() {
  const saved = (() => { try { return JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8')); } catch { return {}; } })();
  const result = {};
  for (const name of AGENTS) {
    if (saved[name]) {
      result[name] = saved[name];
    } else {
      const soul = readAgentSoul(name);
      if (soul) result[name] = soul;
    }
  }
  return result;
}
function writePersona(name, text) {
  const p = readPersonas();
  p[name] = text;
  try { fs.writeFileSync(PERSONAS_FILE, JSON.stringify(p, null, 2)); return true; } catch { return false; }
}

// ─── Council ──────────────────────────────────────────────────
function appendCouncil(entry) {
  try { fs.appendFileSync(COUNCIL_FILE, JSON.stringify(entry) + '\n'); } catch {}
}

function getCouncilFeed() {
  const dispatches = [];
  try {
    fs.readFileSync(COUNCIL_FILE, 'utf8').split('\n').filter(Boolean).slice(-80)
      .forEach(l => { try { dispatches.push(JSON.parse(l)); } catch {} });
  } catch {}

  const agentMsgs = [];
  for (const name of AGENTS) {
    const sf = readSessionFilePath(name);
    if (!sf) continue;
    parseJsonl(sf).slice(-5).forEach(m => {
      const text = extractText(m);
      const ts   = msgTs(m);
      if (text && ts) agentMsgs.push({ agent: name, text: text.slice(0, 200), ts, type: 'agent', role: msgType(m) });
    });
  }

  const all = [...dispatches, ...agentMsgs];
  all.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));
  return all.slice(-80);
}

// ─── HTML ─────────────────────────────────────────────────────
const AGENTS_JSON           = JSON.stringify(AGENTS);
const DEFAULT_PERSONAS_JSON = JSON.stringify(DEFAULT_PERSONAS);

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw — 커맨드 센터</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Noto+Sans+KR:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:    #f2ede4;
  --bg2:   #faf7f0;
  --bg3:   #ffffff;
  --bg4:   #ede8dd;
  --gold:  #9a6c1a;
  --gold2: #c48c2a;
  --gold3: #e8c06a;
  --gold4: rgba(154,108,26,.1);
  --tx:    #1c1208;
  --tx2:   #5a3e1a;
  --tx3:   #9a7a4a;
  --active:  #1a6e38;
  --recent:  #b55010;
  --idle:    #aaa090;
  --c-benjamin: #5a28a0;
  --c-spinoza:  #b06010;
  --c-luke:     #1a7038;
  --c-emma:     #b02880;
  --c-nut:      #1050a8;
  --c-bolt:     #0a7860;
  --border:  rgba(154,108,26,.2);
  --border2: rgba(154,108,26,.4);
  --shadow:  0 2px 12px rgba(100,70,20,.12);
  --shadow2: 0 4px 24px rgba(100,70,20,.18);
  --r: 8px;
}
html,body{height:100%;overflow:hidden}
body{
  background:var(--bg);color:var(--tx);
  font-family:'Noto Sans KR',sans-serif;font-size:14px;line-height:1.6;
}

#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── HEADER ── */
header{
  flex:none;height:52px;
  background:var(--bg3);
  border-bottom:1px solid var(--border);
  box-shadow:0 1px 8px rgba(100,70,20,.08);
  display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;
}
.hdr-brand{display:flex;align-items:center;gap:10px}
.hdr-logo{
  font-family:'Cinzel',serif;font-size:13px;font-weight:700;
  letter-spacing:3px;color:var(--gold);
}
.hdr-logo span{color:var(--tx3);font-size:10px;letter-spacing:1px;font-weight:400;margin-left:4px}
.hdr-right{display:flex;align-items:center;gap:16px}
.hdr-pill{
  background:var(--bg4);border:1px solid var(--border);
  border-radius:20px;padding:3px 12px;
  font-size:12px;color:var(--tx2);display:flex;align-items:center;gap:5px;
}
.hdr-pill b{color:var(--gold);font-weight:600}
#clock{
  font-family:'Cinzel',serif;font-size:14px;font-weight:600;
  color:var(--gold);letter-spacing:2px;
}

/* ── MAIN ── */
main{flex:1;display:flex;overflow:hidden;min-height:0}

/* ── SIDEBAR ── */
#sidebar{
  width:196px;flex:none;
  background:var(--bg2);
  border-right:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden;
}
.sidebar-hdr{
  padding:12px 14px 8px;
  font-family:'Cinzel',serif;font-size:8px;letter-spacing:3px;
  color:var(--tx3);border-bottom:1px solid var(--border);text-align:center;
}
#agent-list{flex:1;overflow-y:auto;padding:6px}
.agent-row{
  display:flex;align-items:center;gap:9px;
  padding:8px 10px;border-radius:var(--r);cursor:pointer;
  transition:background .12s,box-shadow .12s;
  border:1px solid transparent;margin-bottom:3px;position:relative;
}
.agent-row:hover{background:var(--bg4)}
.agent-row.selected{
  background:var(--bg3);border-color:var(--border2);
  box-shadow:var(--shadow);
}
.agent-row.selected::before{
  content:'';position:absolute;left:0;top:6px;bottom:6px;width:3px;
  background:var(--agent-color,var(--gold));border-radius:3px 0 0 3px;
}
.row-avatar{flex:none;position:relative;width:24px;height:38px}
.row-avatar canvas{image-rendering:pixelated;image-rendering:crisp-edges}
.row-dot{
  position:absolute;bottom:-2px;right:-2px;
  width:7px;height:7px;border-radius:50%;border:1.5px solid var(--bg2);
}
.row-dot.active{background:var(--active);box-shadow:0 0 5px var(--active)}
.row-dot.recent{background:var(--recent)}
.row-dot.idle{background:var(--idle)}
.row-info{flex:1;min-width:0}
.row-name{
  font-size:11px;font-weight:700;
  color:var(--agent-color,var(--gold));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.row-role{font-size:11px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── MAIN PANEL ── */
#main-panel{
  flex:1;min-width:0;background:var(--bg);
  display:flex;flex-direction:column;overflow:hidden;
}
.panel-tabs{
  flex:none;display:flex;
  border-bottom:1px solid var(--border);
  background:var(--bg2);padding:0 16px;
}
.ptab{
  padding:13px 16px 11px;
  font-size:11px;font-weight:500;letter-spacing:1px;
  color:var(--tx3);cursor:pointer;border:none;background:none;
  border-bottom:2px solid transparent;transition:all .15s;
}
.ptab.active{color:var(--gold);border-bottom-color:var(--gold);font-weight:700}
.ptab:hover:not(.active){color:var(--tx2)}
.panel-body{flex:1;overflow-y:auto;padding:24px}
.panel-body.hidden{display:none}

/* ── PROFILE ── */
#no-sel{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;color:var(--tx3);text-align:center;gap:8px;
}
#no-sel h2{font-family:'Cinzel',serif;font-size:16px;letter-spacing:3px;color:var(--gold);opacity:.6}
#no-sel p{font-size:14px;color:var(--tx3)}

.profile-header{display:flex;flex-direction:column;align-items:center;margin-bottom:24px}
.profile-avatar-wrap{
  width:88px;height:116px;
  display:flex;align-items:center;justify-content:center;
  background:var(--bg3);
  border:1px solid var(--border2);
  border-radius:var(--r);margin-bottom:14px;
  box-shadow:var(--shadow2);
  position:relative;overflow:hidden;
}
.profile-avatar-wrap::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(135deg,rgba(255,255,255,.6) 0%,transparent 60%);
  pointer-events:none;
}
.profile-avatar-wrap canvas{image-rendering:pixelated;image-rendering:crisp-edges;position:relative;z-index:1}
.bob{animation:bob 2.4s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}

.profile-name{
  font-family:'Cinzel',serif;font-size:22px;font-weight:700;
  color:var(--agent-color,var(--gold));letter-spacing:2px;margin-bottom:2px;
}
.profile-role{font-size:14px;color:var(--tx2);margin-bottom:8px;font-style:italic}
.status-badge{
  padding:3px 14px;border-radius:20px;
  font-size:11px;font-weight:600;letter-spacing:1px;display:inline-flex;align-items:center;gap:5px;
}
.status-badge.active{background:rgba(26,110,56,.1);color:var(--active);border:1px solid rgba(26,110,56,.3)}
.status-badge.recent{background:rgba(181,80,16,.1);color:var(--recent);border:1px solid rgba(181,80,16,.3)}
.status-badge.idle{background:rgba(170,160,144,.15);color:var(--idle);border:1px solid rgba(170,160,144,.4)}

.sec-label{
  font-size:10px;font-weight:700;letter-spacing:2px;
  color:var(--tx3);margin-bottom:10px;
  display:flex;align-items:center;gap:10px;text-transform:uppercase;
}
.sec-label::after{content:'';flex:1;height:1px;background:var(--border)}

.persona-box{
  background:var(--bg3);border:1px solid var(--border);
  border-radius:var(--r);padding:16px;
  font-size:14px;line-height:1.8;color:var(--tx);
  min-height:80px;margin-bottom:8px;
  box-shadow:inset 0 1px 3px rgba(100,70,20,.06);
}
.persona-edit{
  width:100%;background:var(--bg3);border:1.5px solid var(--border2);
  color:var(--tx);font-family:'Noto Sans KR',sans-serif;
  font-size:14px;line-height:1.8;border-radius:var(--r);
  padding:16px;resize:vertical;min-height:100px;outline:none;display:none;
  box-shadow:inset 0 1px 3px rgba(100,70,20,.06);
}
.persona-edit:focus{border-color:var(--gold2);box-shadow:0 0 0 3px rgba(154,108,26,.1)}
.persona-actions{display:flex;gap:8px;justify-content:flex-end;margin-bottom:24px}
.btn{
  font-size:11px;font-weight:600;letter-spacing:1px;
  padding:7px 16px;border-radius:6px;cursor:pointer;transition:all .15s;border:1.5px solid;
}
.btn-ghost{background:none;border-color:var(--border2);color:var(--tx2)}
.btn-ghost:hover{border-color:var(--gold2);color:var(--gold);background:var(--gold4)}
.btn-solid{background:var(--gold);border-color:var(--gold);color:#fff}
.btn-solid:hover{background:var(--gold2);border-color:var(--gold2)}

.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:24px}
.stat-card{
  background:var(--bg3);border:1px solid var(--border);
  border-radius:var(--r);padding:16px 12px;text-align:center;
  box-shadow:var(--shadow);
}
.stat-val{font-family:'Cinzel',serif;font-size:22px;font-weight:700;color:var(--gold);margin-bottom:4px}
.stat-lbl{font-size:11px;color:var(--tx3);font-weight:500}

/* ── ACTIVITY ── */
.act-item{
  background:var(--bg3);border:1px solid var(--border);
  border-radius:var(--r);padding:12px 14px;margin-bottom:7px;
  box-shadow:var(--shadow);
}
.act-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.act-label{font-size:13px;color:var(--tx);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.act-time{font-size:11px;color:var(--tx3);flex:none}

.mlog{display:flex;flex-direction:column;gap:5px;margin-top:8px}
.mlog-item{
  padding:9px 12px;border-left:3px solid;
  border-radius:0 var(--r) var(--r) 0;font-size:13px;line-height:1.6;
}
.mlog-item.user{border-color:var(--c-nut);background:rgba(16,80,168,.05)}
.mlog-item.assistant{border-color:var(--active);background:rgba(26,112,56,.05)}
.mlog-item.tool_use,.mlog-item.tool_result{border-color:var(--gold2);background:rgba(196,140,42,.05);color:var(--tx2);font-size:12px}
.mlog-item.system{border-color:var(--border2);background:var(--bg4);color:var(--tx2)}
.mlog-item.unknown{border-color:var(--border);color:var(--tx2)}
.mlog-who{font-size:9px;font-weight:700;letter-spacing:1px;color:var(--tx3);margin-bottom:3px;text-transform:uppercase}

/* ── COUNCIL ── */
#council{
  width:320px;flex:none;background:var(--bg3);
  border-left:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden;
}
.council-hdr{
  flex:none;padding:12px 14px 10px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  background:var(--bg2);
}
.council-title{font-family:'Cinzel',serif;font-size:11px;font-weight:700;letter-spacing:2px;color:var(--gold)}
.council-ct{
  font-size:10px;color:var(--tx3);
  background:var(--bg4);padding:2px 8px;border-radius:10px;border:1px solid var(--border);
}

#council-feed{
  flex:1;overflow-y:auto;padding:10px;
  display:flex;flex-direction:column;gap:4px;
}
.c-empty{
  flex:1;display:flex;align-items:center;justify-content:center;
  text-align:center;color:var(--tx3);font-size:12px;line-height:2;
}

/* Chat bubble style */
.c-msg{padding:8px 11px;border-radius:10px;font-size:13px;line-height:1.5;max-width:100%}
.c-msg.agent-msg{
  background:var(--bg2);border:1px solid var(--border);
  border-radius:3px 10px 10px 10px;
}
.c-msg.user-msg{
  background:linear-gradient(135deg,rgba(154,108,26,.12),rgba(196,140,42,.08));
  border:1px solid var(--border2);
  border-radius:10px 3px 10px 10px;align-self:flex-end;
  margin-left:20px;
}
.c-msg.dispatch-msg{
  background:rgba(154,108,26,.06);border:1px dashed var(--border2);
  border-radius:var(--r);font-size:11px;color:var(--tx3);text-align:center;
}
.c-who{
  font-size:10px;font-weight:700;letter-spacing:1px;
  margin-bottom:3px;display:flex;align-items:center;gap:5px;text-transform:uppercase;
}
.c-dot{width:5px;height:5px;border-radius:50%;flex:none;display:inline-block}
.c-text{color:var(--tx);word-break:break-word}
.c-text.muted{color:var(--tx2)}
.c-time{font-size:10px;color:var(--tx3);margin-top:3px;text-align:right}

/* ── DISPATCH ── */
.dispatch-area{flex:none;border-top:1px solid var(--border);padding:10px;background:var(--bg2)}
.dispatch-label{
  font-size:9px;font-weight:700;letter-spacing:2px;color:var(--tx3);
  margin-bottom:8px;display:flex;align-items:center;gap:8px;text-transform:uppercase;
}
.dispatch-label::after{content:'';flex:1;height:1px;background:var(--border)}

.agent-toggles{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.ag-toggle{
  font-size:10px;font-weight:600;
  padding:3px 9px;border-radius:20px;cursor:pointer;
  border:1.5px solid var(--border);background:var(--bg3);color:var(--tx3);
  transition:all .12s;
}
.ag-toggle.on{
  background:var(--agent-color,var(--gold));
  border-color:var(--agent-color,var(--gold));color:#fff;
}
.dispatch-row{display:flex;gap:7px;align-items:flex-end}
#dispatch-input{
  flex:1;background:var(--bg3);border:1.5px solid var(--border);
  color:var(--tx);font-family:'Noto Sans KR',sans-serif;font-size:13px;
  padding:8px 11px;border-radius:var(--r);resize:none;height:58px;outline:none;
}
#dispatch-input:focus{border-color:var(--gold2);box-shadow:0 0 0 3px rgba(154,108,26,.1)}
#dispatch-input::placeholder{color:var(--tx3)}
#dispatch-btn{
  flex:none;font-size:11px;font-weight:700;letter-spacing:1px;
  padding:0 14px;border-radius:var(--r);height:58px;
  background:var(--gold);border:1.5px solid var(--gold);color:#fff;
  cursor:pointer;transition:all .15s;white-space:nowrap;
}
#dispatch-btn:hover{background:var(--gold2);border-color:var(--gold2);box-shadow:var(--shadow)}
#dispatch-btn:disabled{opacity:.4;cursor:default}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(154,108,26,.25);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(154,108,26,.45)}

/* ── STATUS BAR ── */
#statusbar{
  position:fixed;bottom:0;left:196px;right:320px;
  padding:5px 16px;font-size:12px;font-weight:500;
  color:var(--gold);pointer-events:none;z-index:500;
  background:linear-gradient(to top,var(--bg2),transparent);
}

/* ── TOAST ── */
.toast{
  position:fixed;top:16px;right:16px;z-index:9000;
  background:var(--tx);color:var(--bg3);
  padding:10px 16px;border-radius:var(--r);
  font-size:12px;font-weight:500;
  box-shadow:var(--shadow2);
  animation:slideIn .2s ease;
}
@keyframes slideIn{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="hdr-brand">
      <div class="hdr-logo">OpenClaw <span>커맨드 센터</span></div>
    </div>
    <div class="hdr-right">
      <div class="hdr-pill">활성 <b id="active-count">0</b></div>
      <div class="hdr-pill">에이전트 <b>6</b></div>
      <div id="clock">00:00:00</div>
    </div>
  </header>

  <main>
    <!-- 사이드바 -->
    <nav id="sidebar">
      <div class="sidebar-hdr">펠로우십</div>
      <div id="agent-list"></div>
    </nav>

    <!-- 메인 패널 -->
    <section id="main-panel">
      <div class="panel-tabs">
        <button class="ptab active" data-tab="profile">프로필</button>
        <button class="ptab" data-tab="activity">활동 내역</button>
      </div>

      <div id="profile-panel" class="panel-body">
        <div id="no-sel">
          <h2>FELLOWSHIP</h2>
          <p>좌측에서 에이전트를 선택하세요</p>
        </div>
        <div id="profile-view" style="display:none">
          <div class="profile-header">
            <div class="profile-avatar-wrap">
              <div id="profile-sprite-wrap">
                <canvas id="profile-canvas" width="72" height="112"></canvas>
              </div>
            </div>
            <div id="profile-name" class="profile-name"></div>
            <div id="profile-role" class="profile-role"></div>
            <div id="profile-badge" class="status-badge"></div>
          </div>

          <div class="sec-label">페르소나</div>
          <div id="persona-display" class="persona-box"></div>
          <textarea id="persona-edit" class="persona-edit" placeholder="이 에이전트의 페르소나를 입력하세요..."></textarea>
          <div class="persona-actions">
            <button class="btn btn-ghost" id="persona-edit-btn" onclick="togglePersonaEdit()">페르소나 수정</button>
            <button class="btn btn-solid"  id="persona-save-btn"   onclick="savePersona()"        style="display:none">저장</button>
            <button class="btn btn-ghost" id="persona-cancel-btn" onclick="cancelPersonaEdit()"  style="display:none">취소</button>
          </div>

          <div class="sec-label">현황</div>
          <div class="stats-grid">
            <div class="stat-card"><div id="stat-sessions" class="stat-val">0</div><div class="stat-lbl">세션</div></div>
            <div class="stat-card"><div id="stat-tokens"   class="stat-val">0</div><div class="stat-lbl">토큰</div></div>
            <div class="stat-card"><div id="stat-since"    class="stat-val">—</div><div class="stat-lbl">마지막 활동</div></div>
          </div>
        </div>
      </div>

      <div id="activity-panel" class="panel-body hidden">
        <div id="activity-view">
          <div style="color:var(--tx3);font-size:13px;text-align:center;padding:40px">에이전트를 선택하세요</div>
        </div>
      </div>
    </section>

    <!-- 의회 -->
    <aside id="council">
      <div class="council-hdr">
        <div class="council-title">의회</div>
        <div class="council-ct" id="council-ct">0개 메시지</div>
      </div>
      <div id="council-feed">
        <div class="c-empty">의회가 소집을 기다립니다<br>아래에서 에이전트에게 지시를 내려보세요</div>
      </div>
      <div class="dispatch-area">
        <div class="dispatch-label">지시 전송</div>
        <div class="agent-toggles" id="agent-toggles"></div>
        <div class="dispatch-row">
          <textarea id="dispatch-input" placeholder="에이전트에게 지시사항을 입력하세요 (Ctrl+Enter로 전송)"></textarea>
          <button id="dispatch-btn" onclick="dispatchCouncil()">전송</button>
        </div>
      </div>
    </aside>
  </main>
</div>

<div id="statusbar"></div>

<script>
const SCALE_MINI    = 3;
const SCALE_PROFILE = 8;

const SPRITES = {
  benjamin:{pal:{H:'#FDBCB4',E:'#1a0a00',h:'#1a0a00',c:'#7B2FBE',C:'#DDA0DD',a:'#FFD700',s:'#3D2B1F'},
    top:['..ccc...','.ccccc..','.CCCCC..','..HHHH..','.HEEHE..','..HHHH..','.cccccc.','.cccccc.','cccccccc','..aaaa..'],
    legs:{idle:['.cc..cc.','.cc..cc.','.ss..ss.','........'],walkA:['ccc..cc.','ccc...c.','sss...s.','........'],walkB:['.cc..ccc','..c..ccc','..s..sss','........']}},
  spinoza:{pal:{H:'#FDBCB4',E:'#1a0a00',h:'#1a0a00',c:'#2C3E50',C:'#ECF0F1',a:'#8B6914',s:'#1a0a00'},
    top:['..hhhh..','.hhhhhh.','..HHHH..','.HEEHE..','..HHHH..','.CCCCCC.','.cccccc.','.caCCac.','.cccccc.','.cccccc.'],
    legs:{idle:['.cc..cc.','.cc..cc.','.ss..ss.','........'],walkA:['ccc..cc.','ccc...c.','sss...s.','........'],walkB:['.cc..ccc','..c..ccc','..s..sss','........']}},
  luke:{pal:{H:'#FDBCB4',E:'#1a0a00',h:'#8B4513',c:'#27AE60',C:'#F5CBA7',a:'#8B4513',s:'#3D2B1F'},
    top:['..hhhh..','.hhhhhh.','..HHHH..','.HEEHE..','..HHHH..','.CCCCCC.','.cccccc.','.ccaacc.','.cccccc.','.cccccc.'],
    legs:{idle:['.aa..aa.','.aa..aa.','.ss..ss.','........'],walkA:['aaa..aa.','aaa...a.','sss...s.','........'],walkB:['.aa..aaa','..a..aaa','..s..sss','........']}},
  emma:{pal:{H:'#FDBCB4',E:'#1a0a00',h:'#FF69B4',c:'#3498DB',C:'#85C1E9',a:'#FFD700',s:'#2C3E50'},
    top:['.ahhhha.','.hhhhhh.','.hHHHHh.','.HEEHHh.','..HHHH..','.CCCcCC.','.cccccc.','.caaCac.','.cccccc.','.cccccc.'],
    legs:{idle:['.cc..cc.','.cc..cc.','.ss..ss.','........'],walkA:['ccc..cc.','ccc...c.','sss...s.','........'],walkB:['.cc..ccc','..c..ccc','..s..sss','........']}},
  nut:{pal:{H:'#FDBCB4',E:'#BDC3C7',h:'#708090',c:'#708090',C:'#BDC3C7',a:'#E74C3C',s:'#2C3E50'},
    top:['.CCCCCC.','CCCCCCCC','CcaaaaCC','CcaaaaCC','.CCCCCC.','.cccccc.','CCCCCCCC','.CccccC.','.cccccc.','.cCCCcc.'],
    legs:{idle:['.cc..cc.','.cc..cc.','.ss..ss.','........'],walkA:['ccc..cc.','ccc...c.','sss...s.','........'],walkB:['.cc..ccc','..c..ccc','..s..sss','........']}},
  bolt:{pal:{H:'#00CCCC',E:'#FFFFFF',h:'#0D1B2A',c:'#0D1B2A',C:'#00CCCC',a:'#FFFFFF',s:'#00CCCC'},
    top:['..CCCC..','.CccccC.','.CaEEaC.','.CccccC.','..CCCC..','.cccccc.','CcCcCcCc','.cccccc.','CcCcCcCc','.CCCCCC.'],
    legs:{idle:['.cc..cc.','.cc..cc.','.CC..CC.','........'],walkA:['ccc..cc.','ccc...c.','CCC...C.','........'],walkB:['.cc..ccc','..c..ccc','..C..CCC','........']}},
};

const AGENT_HEX = {benjamin:'#5a28a0',spinoza:'#b06010',luke:'#1a7038',emma:'#b02880',nut:'#1050a8',bolt:'#0a7860'};
const AGENT_KR  = {benjamin:'벤자민',spinoza:'스피노자',luke:'루크',emma:'엠마',nut:'넛',bolt:'볼트'};
const ROLE_KR   = {'Senior Architect':'선임 아키텍트','Ethics & Philosophy':'윤리 & 철학','Full Stack Dev':'풀스택 개발','UI/UX Designer':'UI/UX 디자이너','DevOps Engineer':'데브옵스 엔지니어','Performance Optimizer':'성능 최적화'};
const STATUS_KR = {active:'● 활성',recent:'◐ 최근 활동',idle:'○ 대기 중'};
const TYPE_KR   = {user:'사용자',assistant:'어시스턴트',tool_use:'도구 사용',tool_result:'도구 결과',system:'시스템',unknown:'기타'};

const AGENTS    = ${AGENTS_JSON};
const DP        = ${DEFAULT_PERSONAS_JSON};

let agents      = [];
let personas    = {};
let council     = [];
let selected    = null;
let activeTab   = 'profile';
let editing     = false;
let walkFrame   = 0;
let lastWalk    = 0;

function drawSprite(name, state, canvas, scale) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const sp  = SPRITES[name];
  if (!sp) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rows = [...sp.top, ...(sp.legs[state] || sp.legs.idle)];
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx]; if (ch === '.') continue;
      const col = sp.pal[ch]; if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(rx * scale, ry * scale, scale, scale);
    }
  });
}

// ── 사이드바 ─────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('agent-list');
  agents.forEach(ag => {
    let row = document.getElementById('row-' + ag.name);
    if (!row) {
      const color = AGENT_HEX[ag.name] || '#9a6c1a';
      const W = 8 * SCALE_MINI, H = 14 * SCALE_MINI;
      row = document.createElement('div');
      row.id = 'row-' + ag.name;
      row.className = 'agent-row';
      row.style.setProperty('--agent-color', color);
      row.innerHTML =
        '<div class="row-avatar">' +
          '<canvas id="mc-'+ag.name+'" width="'+W+'" height="'+H+'" style="width:'+W+'px;height:'+H+'px"></canvas>' +
          '<div class="row-dot '+ag.status+'" id="rd-'+ag.name+'"></div>' +
        '</div>' +
        '<div class="row-info">' +
          '<div class="row-name">'+(AGENT_KR[ag.name]||ag.name)+'</div>' +
          '<div class="row-role">'+(ROLE_KR[ag.role]||ag.role)+'</div>' +
        '</div>';
      row.addEventListener('click', () => selectAgent(ag.name));
      list.appendChild(row);
    }
    row.className = 'agent-row' + (selected === ag.name ? ' selected' : '');
    const dot = document.getElementById('rd-' + ag.name);
    if (dot) dot.className = 'row-dot ' + ag.status;
    drawSprite(ag.name, ag.status === 'active' ? 'walkA' : 'idle', document.getElementById('mc-' + ag.name), SCALE_MINI);
  });
}

// ── 프로필 ───────────────────────────────────
function renderProfile(ag) {
  if (!ag) {
    document.getElementById('no-sel').style.display = 'flex';
    document.getElementById('profile-view').style.display = 'none';
    return;
  }
  document.getElementById('no-sel').style.display = 'none';
  document.getElementById('profile-view').style.display = 'block';

  const color  = AGENT_HEX[ag.name] || '#9a6c1a';
  const nameEl = document.getElementById('profile-name');
  nameEl.textContent = AGENT_KR[ag.name] || ag.name.toUpperCase();
  nameEl.style.color = color;
  document.getElementById('profile-role').textContent = ROLE_KR[ag.role] || ag.role;

  const badge = document.getElementById('profile-badge');
  badge.className = 'status-badge ' + ag.status;
  badge.textContent = STATUS_KR[ag.status] || ag.status;

  const cvs  = document.getElementById('profile-canvas');
  cvs.width  = 8 * SCALE_PROFILE;
  cvs.height = 14 * SCALE_PROFILE;
  const wrap = document.getElementById('profile-sprite-wrap');
  wrap.className = ag.status !== 'idle' ? 'bob' : '';
  drawSprite(ag.name, ag.status === 'active' ? 'walkA' : 'idle', cvs, SCALE_PROFILE);

  const persona = personas[ag.name] || DP[ag.name] || '';
  document.getElementById('persona-display').textContent = persona;
  document.getElementById('persona-edit').value = persona;

  const s = ag.stats || {};
  document.getElementById('stat-sessions').textContent = s.sessionCount || 0;
  document.getElementById('stat-tokens').textContent   = fmtNum(s.totalTokens || 0);
  document.getElementById('stat-since').textContent    = ag.lastActivity ? timeAgo(ag.lastActivity) : '—';
}

// ── 활동 내역 ────────────────────────────────
function renderActivity(ag) {
  const view = document.getElementById('activity-view');
  if (!ag) {
    view.innerHTML = '<div style="color:var(--tx3);font-size:13px;text-align:center;padding:40px">에이전트를 선택하세요</div>';
    return;
  }
  let html = '';

  const sess = (ag.messages||[]).filter(m => m.type === 'system');
  if (sess.length) {
    html += '<div class="sec-label" style="font-size:10px;font-weight:700;letter-spacing:2px;color:var(--tx3);margin-bottom:10px;display:flex;align-items:center;gap:10px;text-transform:uppercase">최근 작업 <span style="flex:1;height:1px;background:var(--border);display:block"></span></div>';
    sess.slice(0,10).forEach(m => {
      html += '<div class="act-item"><div class="act-head">' +
        '<span class="act-label">'+esc(m.text)+'</span>' +
        '<span class="act-time">'+(m.ts ? timeAgo(m.ts) : '')+'</span>' +
        '</div></div>';
    });
  }

  const msgs = (ag.messages||[]).filter(m => m.type !== 'system');
  if (msgs.length) {
    html += '<div class="sec-label" style="font-size:10px;font-weight:700;letter-spacing:2px;color:var(--tx3);margin:20px 0 10px;display:flex;align-items:center;gap:10px;text-transform:uppercase">세션 로그 <span style="flex:1;height:1px;background:var(--border);display:block"></span></div>';
    html += '<div class="mlog">';
    msgs.forEach(m => {
      const cls = ['user','assistant','tool_use','tool_result','system'].includes(m.type) ? m.type : 'unknown';
      html += '<div class="mlog-item '+cls+'">' +
        '<div class="mlog-who">'+(TYPE_KR[m.type]||m.type)+'</div>' +
        '<div>'+esc(m.text||'').slice(0,400)+'</div>' +
        (m.ts ? '<div style="font-size:10px;color:var(--tx3);margin-top:3px">'+timeAgo(m.ts)+'</div>' : '') +
        '</div>';
    });
    html += '</div>';
  }

  if (!html) html = '<div style="color:var(--tx3);font-size:13px;text-align:center;padding:40px">기록된 작업이 없습니다</div>';
  view.innerHTML = html;
}

// ── 의회 피드 ────────────────────────────────
function renderCouncil() {
  const feed = document.getElementById('council-feed');
  const ct   = document.getElementById('council-ct');
  if (!council.length) {
    feed.innerHTML = '<div class="c-empty">의회가 소집을 기다립니다<br>아래에서 에이전트에게 지시를 내려보세요</div>';
    ct.textContent = '0개 메시지';
    return;
  }
  ct.textContent = council.length + '개 메시지';
  const items = council.slice(-60);
  feed.innerHTML = items.map(m => {
    const agLower = (m.agent||'').toLowerCase();
    const color   = AGENT_HEX[agLower] || '#9a6c1a';
    const isUser  = m.type === 'user';
    const isDisp  = m.type === 'dispatch';
    const label   = isUser ? '나' : (AGENT_KR[agLower] || (m.agent||'시스템').toUpperCase());

    if (isDisp) {
      return '<div class="c-msg dispatch-msg">'+esc(m.text||'')+'</div>';
    }
    return '<div class="c-msg '+(isUser?'user-msg':'agent-msg')+'">' +
      (isUser ? '' :
        '<div class="c-who"><span class="c-dot" style="background:'+color+'"></span>' +
        '<span style="color:'+color+'">'+esc(label)+'</span>' +
        (m.role ? '<span style="color:var(--tx3);font-size:9px">'+(TYPE_KR[m.role]||m.role)+'</span>' : '') +
        '</div>') +
      '<div class="c-text'+(isUser?' ':'')+'">'+esc(m.text||'').slice(0,200)+'</div>' +
      (m.ts ? '<div class="c-time">'+timeAgo(m.ts)+'</div>' : '') +
    '</div>';
  }).join('');
  feed.scrollTop = feed.scrollHeight;
}

// ── 선택 ─────────────────────────────────────
function selectAgent(name) {
  selected = name;
  cancelPersonaEdit();
  renderSidebar();
  const ag = agents.find(a => a.name === name);
  renderProfile(ag);
  renderActivity(ag);
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('profile-panel').classList.toggle('hidden', tab !== 'profile');
  document.getElementById('activity-panel').classList.toggle('hidden', tab !== 'activity');
}

// ── 페르소나 ──────────────────────────────────
function togglePersonaEdit() {
  editing = true;
  document.getElementById('persona-display').style.display = 'none';
  document.getElementById('persona-edit').style.display    = 'block';
  document.getElementById('persona-edit').focus();
  document.getElementById('persona-edit-btn').style.display   = 'none';
  document.getElementById('persona-save-btn').style.display   = '';
  document.getElementById('persona-cancel-btn').style.display = '';
}
function cancelPersonaEdit() {
  editing = false;
  document.getElementById('persona-display').style.display = 'block';
  document.getElementById('persona-edit').style.display    = 'none';
  document.getElementById('persona-edit-btn').style.display   = '';
  document.getElementById('persona-save-btn').style.display   = 'none';
  document.getElementById('persona-cancel-btn').style.display = 'none';
}
async function savePersona() {
  if (!selected) return;
  const text = document.getElementById('persona-edit').value.trim();
  try {
    const r = await fetch('/api/personas', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agent: selected, text })
    });
    if (r.ok) {
      personas[selected] = text;
      document.getElementById('persona-display').textContent = text;
      cancelPersonaEdit();
      showToast('페르소나가 저장되었습니다');
    }
  } catch(e) { showToast('저장 실패: ' + e.message); }
}

// ── 지시 전송 ─────────────────────────────────
function initToggles() {
  const c = document.getElementById('agent-toggles');
  AGENTS.forEach(name => {
    const color = AGENT_HEX[name] || '#9a6c1a';
    const btn   = document.createElement('button');
    btn.className = 'ag-toggle';
    btn.dataset.agent = name;
    btn.style.setProperty('--agent-color', color);
    btn.textContent = AGENT_KR[name] || name;
    btn.addEventListener('click', () => btn.classList.toggle('on'));
    c.appendChild(btn);
  });
}

async function dispatchCouncil() {
  const text    = document.getElementById('dispatch-input').value.trim();
  if (!text) return;
  const targets = [...document.querySelectorAll('.ag-toggle.on')].map(b => b.dataset.agent);
  if (!targets.length) { showToast('에이전트를 선택하세요'); return; }

  // 즉시 내 메시지를 로컬에 추가
  const now = new Date().toISOString();
  council.push({ agent: 'USER', text, ts: now, type: 'user' });
  council.push({ agent: 'COUNCIL', text: '→ ' + targets.map(t => AGENT_KR[t]||t).join(', ') + '에게 전송 중...', ts: now, type: 'dispatch' });
  renderCouncil();

  const btn = document.getElementById('dispatch-btn');
  btn.disabled = true; btn.textContent = '...';
  document.getElementById('dispatch-input').value = '';

  try {
    const r = await fetch('/api/dispatch', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agents: targets, text })
    });
    const d = await r.json();
    if (d.ok) {
      showToast(targets.map(t => AGENT_KR[t]||t).join(', ') + '에게 전송 완료');
      setTimeout(fetchAll, 2000);
    } else {
      showToast('오류: ' + (d.error || '알 수 없음'));
    }
  } catch(e) {
    showToast('전송 실패: ' + e.message);
  }
  btn.disabled = false; btn.textContent = '전송';
}

// ── 데이터 패치 ──────────────────────────────
async function fetchAll() {
  try {
    const [ar, pr, cr] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/personas'),
      fetch('/api/council'),
    ]);
    agents   = await ar.json();
    personas = await pr.json();
    const newCouncil = await cr.json();

    // council 서버 데이터와 로컬 user 메시지 합치기
    const userMsgs = council.filter(m => m.type === 'user');
    const serverTs = new Set(newCouncil.map(m => m.ts + m.text));
    userMsgs.forEach(m => { if (!serverTs.has(m.ts + m.text)) newCouncil.push(m); });
    newCouncil.sort((a, b) => new Date(a.ts||0) - new Date(b.ts||0));
    council = newCouncil;

    document.getElementById('active-count').textContent = agents.filter(a => a.status === 'active').length;
    renderSidebar();
    renderCouncil();
    if (selected && !editing) {
      const ag = agents.find(a => a.name === selected);
      if (ag) { renderProfile(ag); if (activeTab === 'activity') renderActivity(ag); }
    }
  } catch(e) { console.error('fetch error', e); }
}

// ── 애니메이션 ────────────────────────────────
function animLoop(ts) {
  if (ts - lastWalk > 350) {
    walkFrame = 1 - walkFrame;
    lastWalk  = ts;
    const state = walkFrame === 0 ? 'walkA' : 'walkB';
    agents.forEach(ag => {
      if (ag.status === 'active') {
        drawSprite(ag.name, state, document.getElementById('mc-' + ag.name), SCALE_MINI);
        if (selected === ag.name)
          drawSprite(ag.name, state, document.getElementById('profile-canvas'), SCALE_PROFILE);
      }
    });
  }
  requestAnimationFrame(animLoop);
}

// ── 시계 ─────────────────────────────────────
function tickClock() {
  const n = new Date();
  document.getElementById('clock').textContent =
    String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+':'+String(n.getSeconds()).padStart(2,'0');
}

// ── 헬퍼 ─────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtNum(n) { if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'K'; return String(n); }
function timeAgo(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const d  = Date.now() - ms;
  if (d < 60000)    return Math.floor(d/1000)+'초 전';
  if (d < 3600000)  return Math.floor(d/60000)+'분 전';
  if (d < 86400000) return Math.floor(d/3600000)+'시간 전';
  return Math.floor(d/86400000)+'일 전';
}

let toastTimer = null;
function showToast(msg) {
  let el = document.querySelector('.toast');
  if (el) el.remove();
  el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if(el.parentNode) el.remove(); }, 3000);
}

// ── 초기화 ────────────────────────────────────
function init() {
  document.querySelectorAll('.ptab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.getElementById('dispatch-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) dispatchCouncil();
  });
  initToggles();
  fetchAll();
  setInterval(fetchAll, 5000);
  requestAnimationFrame(animLoop);
  tickClock();
  setInterval(tickClock, 1000);
}
document.addEventListener('DOMContentLoaded', init);
</script>
</body>
</html>`;

// ─── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(AGENTS.map(getAgentData)));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/personas') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readPersonas()));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/personas') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { agent, text } = JSON.parse(body);
        if (!AGENTS.includes(agent) || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '잘못된 요청' })); return;
        }
        writePersona(agent, text.slice(0, 1000));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/council') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCouncilFeed()));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/dispatch') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { agents: targets, text } = JSON.parse(body);
        if (!Array.isArray(targets) || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '잘못된 요청' })); return;
        }
        const valid = targets.filter(a => AGENTS.includes(a));
        if (!valid.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '유효한 에이전트 없음' })); return;
        }
        const now = new Date().toISOString();
        // 사용자 메시지와 디스패치 알림 모두 기록
        appendCouncil({ agent: 'USER', text, ts: now, type: 'user' });
        appendCouncil({ agent: 'COUNCIL', text: '→ ' + valid.join(', ') + '에게 전송됨: ' + text.slice(0,60), ts: now, type: 'dispatch' });
        valid.forEach(name => {
          const others = valid.filter(x => x !== name);
          const prompt = others.length
            ? '[의회 지시 — ' + others.join(', ') + '와 협력] ' + text
            : text;
          exec('openclaw send ' + name + ' ' + JSON.stringify(prompt), { timeout: 15000 }, () => {});
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dispatched: valid }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/command') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { agent, text } = JSON.parse(body);
        if (!AGENTS.includes(agent) || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '잘못된 요청' })); return;
        }
        exec('openclaw send ' + agent + ' ' + JSON.stringify(text), { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: stderr || err.message })); }
          else      { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, output: stdout.slice(0,2000) })); }
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ✦ OpenClaw 커맨드 센터');
  console.log('  http://0.0.0.0:' + PORT);
  console.log('  에이전트: ' + BASE);
  console.log('  페르소나: ' + PERSONAS_FILE);
  console.log('  의회 로그: ' + COUNCIL_FILE + '\n');
});

// Servidor del modo online de Partido Libre: salas, emparejamiento, chat y retransmisión.
// No guarda datos en disco: todo vive en memoria mientras el servidor está encendido.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const CHAT = process.env.CHAT !== 'off';            // CHAT=off apaga el chat
const DURS = [60, 90, 150, 210];
let queue = [], matches = 0, rid = 0, chatlog = [];
const rooms = new Map();
const tours = new Map(); let tid = 0;
const MATCH_DUR = +process.env.MATCH_DUR || 150, READY_MS = +process.env.READY_MS || 120000;
const CODE_RE = /^[A-Z0-9]{4,10}$/, FMTS = ['liga', 'copa', 'grupos'], CAPS = [3, 4, 6, 8, 12, 16];

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Partido Libre online: ok. Conectados: ${wss.clients.size}. Salas: ${rooms.size}. Torneos: ${tours.size}. Partidos: ${matches}.`);
});
const wss = new WebSocketServer({
  server: srv, maxPayload: 4096,
  verifyClient: info => !ORIGINS.length || ORIGINS.includes(info.origin),
});

const send = (w, o) => { if (w && w.readyState === 1) w.send(JSON.stringify(o)); };
const broadcast = o => wss.clients.forEach(w => send(w, o));
const clean = (s, n) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, n);
const mkCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 6; i++) c += a[Math.random() * a.length | 0]; return c; };
const leaveQueue = w => { queue = queue.filter(x => x !== w); };
const publicRooms = () => [...rooms.values()].filter(r => !r.priv).slice(0, 50).map(r => (
  { id: r.id, name: r.name, host: r.host.name, team: r.host.team, dur: r.dur, state: r.guest ? 'playing' : 'waiting' }));

function dropRoom(w) {                               // cierra la sala de w (y la del rival si ya estaban jugando)
  if (w.room) { rooms.delete(w.room.id); if (w.peer) w.peer.room = null; w.room = null; }
}
function unpair(w) {
  const p = w.peer;
  if (w.tmatch && !w.tmatch.res) tForfeit(w);       // salir de un partido de torneo sin resultado = derrota
  dropRoom(w);
  if (p) { p.peer = null; w.peer = null; send(p, { t: 'left' }); }
}
function pair(a, b, dur, room, extra = {}) {
  a.peer = b; b.peer = a; matches++;
  const A = extra.A || { name: a.name, team: a.team }, B = extra.B || { name: b.name, team: b.team };
  send(a, { t: 'match', role: 'host', opp: B, me: A, dur, ko: !!extra.ko, tm: !!extra.tm });
  send(b, { t: 'match', role: 'guest', opp: A, me: B, dur, ko: !!extra.ko, tm: !!extra.tm });
  if (room) { room.guest = b; b.room = room; }
}
function joinRoom(w, r) {
  if (!r || r.guest || r.host === w || w.peer) return send(w, { t: 'error', msg: 'La sala ya no está disponible.' });
  leaveQueue(w); dropRoom(w);
  pair(r.host, w, r.dur, r);
}


const RNAME = { 2: 'Final', 4: 'Semifinales', 8: 'Cuartos de final', 16: 'Octavos de final' };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
function rr(ids) {                                    // todos contra todos (método del círculo)
  const a = ids.slice(); if (a.length % 2) a.push(null);
  const n = a.length, R = [];
  for (let r = 0; r < n - 1; r++) {
    const m = [];
    for (let i = 0; i < n / 2; i++) { const x = a[i], y = a[n - 1 - i]; if (x !== null && y !== null) m.push([x, y]); }
    R.push(m); a.splice(1, 0, a.pop());
  }
  return R;
}
const mkMatch = (t, a, b, g) => ({ id: ++t.mid, a, b, g, ph: t.phase, res: null, ra: false, rb: false, live: false, active: false, timer: null });
const alive = t => (t.state === 'lobby' ? t.members : t.P.filter(p => !p.out).map(p => p.ws)).filter(w => w.readyState === 1);

function tTables(t) {
  return t.groups.map((g, gi) => {
    const rows = g.map(id => ({ id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }));
    t.hist.filter(m => m.ph !== 'ko' && m.g === gi).forEach(m => {
      const A = rows.find(r => r.id === m.a), B = rows.find(r => r.id === m.b);
      if (!A || !B) return;
      A.p++; B.p++; A.gf += m.res.sa; A.ga += m.res.sb; B.gf += m.res.sb; B.ga += m.res.sa;
      if (m.res.sa > m.res.sb) { A.w++; A.pts += 3; B.l++; } else if (m.res.sa < m.res.sb) { B.w++; B.pts += 3; A.l++; } else { A.d++; B.d++; A.pts++; B.pts++; }
    });
    rows.sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.id - y.id);
    return { rows };
  });
}
function tKoRound(t, ids) {
  const n = ids.length;
  if (n === 1) return tFinish(t, ids[0]);
  t.rn = RNAME[n] || 'Ronda previa';
  let p = 1; while (p * 2 <= n) p *= 2;
  const extra = n - p;
  const play = extra === 0 ? ids : ids.slice(n - 2 * extra);
  t.kobye = extra === 0 ? [] : ids.slice(0, n - 2 * extra);
  t.cur = []; for (let i = 0; i < play.length; i += 2) t.cur.push(mkMatch(t, play[i], play[i + 1], 0));
}
function tFinish(t, id) {
  t.state = 'done'; t.champ = id; t.cur = []; t.rn = '';
  t.log.push('Campeón: ' + t.P[id].name);
}
function tRoundDone(t) {
  if (t.phase === 'ko') {
    const w = (t.kobye || []).concat(t.cur.map(m => m.win));
    return w.length === 1 ? tFinish(t, w[0]) : tKoRound(t, w);
  }
  t.ri++;
  if (t.ri < t.sched.length) { t.cur = t.sched[t.ri].map(x => mkMatch(t, x.a, x.b, x.g)); t.rn = 'Fecha ' + (t.ri + 1); return; }
  const tb = tTables(t);
  if (t.phase === 'liga') return tFinish(t, tb[0].rows[0].id);
  const q = [];                                       // grupos -> eliminatoria cruzada (1A-2B, 1B-2A, ...)
  for (let k = 0; k < tb.length; k += 2) { const A = tb[k].rows, B = tb[k + 1].rows; q.push(A[0].id, B[1].id, B[0].id, A[1].id); }
  t.phase = 'ko'; tKoRound(t, q);
}
function tSetRes(t, m, sa, sb) {
  if (m.res) return;
  clearTimeout(m.timer);
  m.res = { sa, sb }; m.live = false; m.active = false; m.win = sa >= sb ? m.a : m.b;
  const A = t.P[m.a], B = t.P[m.b];
  if (A.ws) A.ws.tmatch = null; if (B.ws) B.ws.tmatch = null;
  t.hist.push(m); t.log.push(`${A.name} ${sa}–${sb} ${B.name}`); if (t.log.length > 40) t.log.shift();
}
function tTimeout(t, m) {                             // alguien no apretó "Jugar" a tiempo
  if (m.res || m.live) return;
  if (m.ra && !m.rb) tSetRes(t, m, 1, 0); else if (m.rb && !m.ra) tSetRes(t, m, 0, 1);
  else if (t.phase === 'ko') tSetRes(t, m, Math.random() < .5 ? 1 : 0, 0); else tSetRes(t, m, 0, 0);
  tSchedule(t); tPush(t);
}
function tSchedule(t) {                               // cierra rondas, resuelve ausentes y activa los próximos partidos
  let guard = 0;
  while (t.state === 'run' && guard++ < 500) {
    for (const m of t.cur) {
      if (m.res || m.live) continue;
      const A = t.P[m.a], B = t.P[m.b];
      if (A.out || B.out) tSetRes(t, m, A.out ? 0 : 1, A.out && !B.out ? 1 : 0);
    }
    if (t.cur.length && t.cur.every(m => m.res)) { tRoundDone(t); continue; }
    break;
  }
  if (t.state !== 'run') return;
  const pend = t.cur.filter(m => !m.res && !m.live), busy = t.cur.some(m => m.live);
  const act = t.sim === 'sim' ? pend : (busy ? [] : pend.slice(0, 1));
  act.forEach(m => { if (!m.active) { m.active = true; m.ra = m.rb = false; m.timer = setTimeout(() => tTimeout(t, m), READY_MS); } });
}
function tStart(t) {
  t.state = 'run'; t.hist = []; t.log = []; t.mid = 0; t.champ = null;
  t.P = t.members.map(ws => ({ ws, name: ws.name, team: ws.team, out: false }));
  const ids = shuffle(t.P.map((_, i) => i));
  if (t.fmt === 'copa') { t.phase = 'ko'; t.groups = null; tKoRound(t, ids); }
  else {
    const G = t.fmt === 'liga' || ids.length <= 4 ? 1 : ids.length <= 8 ? 2 : 4;
    t.groups = Array.from({ length: G }, () => []); ids.forEach((id, i) => t.groups[i % G].push(id));
    t.phase = G === 1 ? 'liga' : 'grupos';
    const gr = t.groups.map(g => rr(g)), R = Math.max(...gr.map(x => x.length));
    t.sched = []; for (let r = 0; r < R; r++) t.sched.push(gr.flatMap((x, gi) => (x[r] || []).map(([a, b]) => ({ a, b, g: gi }))));
    t.ri = 0; t.cur = t.sched[0].map(x => mkMatch(t, x.a, x.b, x.g)); t.rn = 'Fecha 1';
  }
  tSchedule(t);
}
function tReady(w) {
  const t = w.tour; if (!t || t.state !== 'run') return;
  const pi = t.P.findIndex(p => p.ws === w); if (pi < 0) return;
  const m = t.cur.find(x => x.active && !x.res && !x.live && (x.a === pi || x.b === pi)); if (!m) return;
  if (m.a === pi) m.ra = true; else m.rb = true;
  if (m.ra && m.rb) {
    const A = t.P[m.a], B = t.P[m.b];
    if (A.out || B.out || A.ws.readyState !== 1 || B.ws.readyState !== 1) { tPush(t); return; }
    clearTimeout(m.timer); m.live = true; A.ws.tmatch = m; B.ws.tmatch = m;
    pair(A.ws, B.ws, MATCH_DUR, null, { ko: m.ph === 'ko', tm: true, A: { name: A.name, team: A.team }, B: { name: B.name, team: B.team } });
    tSchedule(t);
  }
  tPush(t);
}
function tResult(w, sa, sb) {
  const m = w.tmatch, t = w.tour; if (!m || !t || m.res) return;
  sa = Math.max(0, Math.min(30, sa | 0)); sb = Math.max(0, Math.min(30, sb | 0));
  if (m.ph === 'ko' && sa === sb) sa++;
  const wa = t.P[m.a].ws, wb = t.P[m.b].ws;
  tSetRes(t, m, sa, sb); wa.peer = null; wb.peer = null;   // el partido terminó: los dos quedan libres
  tSchedule(t); tPush(t);
}
function tForfeit(w) {
  const m = w.tmatch, t = w.tour; if (!m || !t || m.res) return;
  const isA = t.P[m.a].ws === w, wa = t.P[m.a].ws, wb = t.P[m.b].ws;
  tSetRes(t, m, isA ? 0 : 1, isA ? 1 : 0); wa.peer = null; wb.peer = null;
  tSchedule(t); tPush(t);
}
function tInfo(t, w) {
  const mem = t.state === 'lobby' ? t.members : t.P.map(p => p.ws);
  const o = { id: t.id, name: t.name, comp: t.comp, fmt: t.fmt, cap: t.cap, sim: t.sim, any: t.any, priv: t.priv, st: t.state,
    code: t.priv ? t.code : null, owner: t.owner.name, mine: w === t.owner,
    members: (t.state === 'lobby' ? t.members.map(x => ({ name: x.name, team: x.team })) : t.P.map(p => ({ name: p.name, team: p.team, out: p.out })))
      .map((x, i) => ({ ...x, owner: mem[i] === t.owner })) };
  if (t.state !== 'lobby') {
    const P = t.P, pi = P.findIndex(p => p.ws === w), my = t.cur.find(m => !m.res && (m.a === pi || m.b === pi));
    o.run = { done: t.state === 'done', phase: t.phase, rn: t.rn, champ: t.champ === null ? null : P[t.champ].name, log: t.log.slice(-10),
      tables: t.groups ? tTables(t).map(g => g.rows.map(r => ({ name: P[r.id].name, team: P[r.id].team, p: r.p, pts: r.pts, gd: r.gf - r.ga, me: r.id === pi }))) : [],
      round: t.cur.map(m => ({ a: P[m.a].name, b: P[m.b].name, sa: m.res ? m.res.sa : null, sb: m.res ? m.res.sb : null, s: m.res ? 'done' : m.live ? 'live' : 'pend' })),
      bye: (t.kobye || []).map(id => P[id].name),
      my: my ? { opp: P[my.a === pi ? my.b : my.a], live: my.live, active: my.active, ready: my.a === pi ? my.ra : my.rb, oppReady: my.a === pi ? my.rb : my.ra } : null };
    if (o.run.my) o.run.my.opp = { name: o.run.my.opp.name, team: o.run.my.opp.team };
    o.run.out = pi >= 0 ? P[pi].out : false;
  }
  return o;
}
const tPush = t => {
  const to = new Set([t.owner, ...(t.state === 'lobby' ? t.members : t.P.map(p => p.ws))]);
  to.forEach(w => { if (w.readyState === 1 && w.tour === t) send(w, { t: 'tstate', tr: tInfo(t, w) }); });
};
function tLeave(w) {
  const t = w.tour; if (!t) return; w.tour = null;
  if (t.state === 'lobby') {
    if (w === t.owner) { tours.delete(t.id); t.members.forEach(m => { m.tour = null; if (m !== w) send(m, { t: 'tclosed' }); }); }
    else { t.members = t.members.filter(m => m !== w); tPush(t); }
    return;
  }
  const p = t.P.find(x => x.ws === w);
  if (p) { p.out = true; if (w.tmatch && !w.tmatch.res) { w.tour = t; tForfeit(w); w.tour = null; } }
  if (t.state === 'run') tSchedule(t);
  if (t.P.every(x => x.out)) { (t.cur || []).forEach(m => clearTimeout(m.timer)); tours.delete(t.id); }
  else tPush(t);
}
function tJoin(w, t) {
  if (!t) return send(w, { t: 'error', msg: 'No existe ese torneo.' });
  if (t.state !== 'lobby') return send(w, { t: 'error', msg: 'El torneo ya empezó.' });
  if (w.peer || w.room || w.tour) return;
  if (t.members.length >= t.cap) return send(w, { t: 'error', msg: 'Torneo lleno.' });
  t.members.push(w); w.tour = t; tPush(t);
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

wss.on('connection', ws => {
  ws.alive = true; ws.n = 0; ws.t = Date.now(); ws.peer = null; ws.room = null; ws.tour = null;
  ws.name = 'Jugador' + (100 + (Math.random() * 900 | 0)); ws.team = ''; ws.lastChat = 0;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'count', n: wss.clients.size });
  if (CHAT) send(ws, { t: 'chatlog', list: chatlog });

  ws.on('message', raw => {
    const now = Date.now();
    if (now - ws.t > 1000) { ws.t = now; ws.n = 0; }
    if (++ws.n > 200) return;                         // límite de mensajes por segundo
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'hello': if (ws.tour && ws.tour.state !== 'lobby') break; ws.name = clean(m.name, 12) || ws.name; ws.team = clean(m.team, 40); break;
      case 'rooms': send(ws, { t: 'rooms', list: publicRooms() }); break;
      case 'create': {
        if (ws.peer || ws.room || ws.tour) break;
        leaveQueue(ws);
        const r = { id: ++rid, name: clean(m.name, 24) || 'Partido entre amigos', dur: DURS.includes(m.dur) ? m.dur : 150,
                    priv: !!m.priv, code: mkCode(), host: ws, guest: null };
        rooms.set(r.id, r); ws.room = r;
        send(ws, { t: 'created', id: r.id, name: r.name, code: r.priv ? r.code : null });
        break;
      }
      case 'join': joinRoom(ws, rooms.get(m.id)); break;
      case 'joincode': {
        const c = String(m.code || '').toUpperCase().trim();
        joinRoom(ws, [...rooms.values()].find(r => r.priv && r.code === c));
        break;
      }
      case 'find':
        if (ws.peer || ws.room) break;
        leaveQueue(ws); ws.team = clean(m.team, 40) || ws.team;
        { const o = queue.shift(); if (o) pair(o, ws, 150, null); else queue.push(ws); }
        break;
      case 'cancel': leaveQueue(ws); if (!ws.peer) dropRoom(ws); break;
      case 'relay': if (ws.peer) send(ws.peer, { t: 'relay', d: m.d }); break;
      case 'leave': unpair(ws); break;
      case 'tcreate': {
        if (ws.peer || ws.room || ws.tour || tours.size >= 100) break;
        const priv = !!m.priv; let code = '';
        if (priv) {
          code = normCode(m.code);
          if (!CODE_RE.test(code)) { send(ws, { t: 'error', msg: 'El código debe tener entre 4 y 10 letras o números.' }); break; }
          if ([...tours.values()].some(x => x.priv && x.code === code)) { send(ws, { t: 'error', msg: 'Ese código ya está en uso. Elegí otro.' }); break; }
        }
        const t = { id: ++tid, name: clean(m.name, 24) || 'Torneo entre amigos', comp: clean(m.comp, 30) || 'Personalizado',
          fmt: FMTS.includes(m.fmt) ? m.fmt : 'liga', cap: CAPS.includes(m.cap) ? m.cap : 8, sim: m.sim === 'uno' ? 'uno' : 'sim',
          any: !!m.any, priv, code, owner: ws, members: [], state: 'lobby' };
        if (m.part !== 'org') t.members.push(ws);
        tours.set(t.id, t); ws.tour = t; tPush(t);
        break;
      }
      case 'tjoin': tJoin(ws, tours.get(m.id)); break;
      case 'tjoincode': { const c = normCode(m.code); tJoin(ws, [...tours.values()].find(x => x.priv && x.code === c)); break; }
      case 'tleave': tLeave(ws); break;
      case 'tget': if (ws.tour) send(ws, { t: 'tstate', tr: tInfo(ws.tour, ws) }); break;
      case 'tstart': {
        const t = ws.tour;
        if (!t || t.owner !== ws || t.state !== 'lobby') break;
        if (t.members.length < 3) { send(ws, { t: 'error', msg: 'Hacen falta al menos 3 jugadores.' }); break; }
        tStart(t); tPush(t); break;
      }
      case 'tready': tReady(ws); break;
      case 'tresult': tResult(ws, m.sa, m.sb); break;
      case 'tlist': send(ws, { t: 'tlist', list: [...tours.values()].filter(x => !x.priv).slice(0, 50)
        .map(x => ({ id: x.id, name: x.name, comp: x.comp, fmt: x.fmt, cap: x.cap, any: x.any, st: x.state, n: x.state === 'lobby' ? x.members.length : x.P.length })) }); break;
      case 'chat': {
        if (!CHAT || now - ws.lastChat < 2000) break;
        const text = String(m.text || '')
          .replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|net|org|gg|xyz|io|me|ly|tv)\b\S*/gi, '[enlace]')
          .replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!text) break;
        ws.lastChat = now;
        const o = { t: 'chat', name: ws.name, team: ws.team, text, ts: now };
        chatlog.push(o); if (chatlog.length > 20) chatlog.shift();
        broadcast(o);
        break;
      }
    }
  });
  ws.on('close', () => { leaveQueue(ws); unpair(ws); tLeave(ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); });
  broadcast({ t: 'count', n: wss.clients.size });
}, 25000);

srv.listen(PORT, () => console.log('Servidor escuchando en el puerto', PORT));

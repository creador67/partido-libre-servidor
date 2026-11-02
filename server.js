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
  dropRoom(w);
  if (p) { p.peer = null; w.peer = null; send(p, { t: 'left' }); }
}
function pair(a, b, dur, room) {
  a.peer = b; b.peer = a; matches++;
  send(a, { t: 'match', role: 'host', opp: { name: b.name, team: b.team }, dur });
  send(b, { t: 'match', role: 'guest', opp: { name: a.name, team: a.team }, dur });
  if (room) { room.guest = b; b.room = room; }
}
function joinRoom(w, r) {
  if (!r || r.guest || r.host === w || w.peer) return send(w, { t: 'error', msg: 'La sala ya no está disponible.' });
  leaveQueue(w); dropRoom(w);
  pair(r.host, w, r.dur, r);
}

const tInfo = t => ({ id: t.id, name: t.name, comp: t.comp, fmt: t.fmt, cap: t.cap, sim: t.sim, any: t.any, priv: t.priv,
  code: t.priv ? t.code : null, owner: t.owner.name, members: t.members.map(w => ({ name: w.name, team: w.team, owner: w === t.owner })) });
const tPush = t => (t.members.includes(t.owner) ? t.members : t.members.concat(t.owner)).forEach(w => send(w, { t: 'tstate', tr: tInfo(t) }));
function tLeave(w) {                                 // si se va el organizador, el torneo se cierra
  const t = w.tour; if (!t) return; w.tour = null;
  if (w === t.owner) { tours.delete(t.id); t.members.forEach(m => { m.tour = null; if (m !== w) send(m, { t: 'tclosed' }); }); }
  else { t.members = t.members.filter(m => m !== w); tPush(t); }
}
function tJoin(w, t) {
  if (!t) return send(w, { t: 'error', msg: 'No existe ese torneo.' });
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
      case 'hello': ws.name = clean(m.name, 12) || ws.name; ws.team = clean(m.team, 40); break;
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
          any: !!m.any, priv, code, owner: ws, members: [] };
        if (m.part !== 'org') t.members.push(ws);
        tours.set(t.id, t); ws.tour = t; tPush(t);
        break;
      }
      case 'tjoin': tJoin(ws, tours.get(m.id)); break;
      case 'tjoincode': { const c = normCode(m.code); tJoin(ws, [...tours.values()].find(x => x.priv && x.code === c)); break; }
      case 'tleave': tLeave(ws); break;
      case 'tlist': send(ws, { t: 'tlist', list: [...tours.values()].filter(x => !x.priv).slice(0, 50)
        .map(x => ({ id: x.id, name: x.name, comp: x.comp, fmt: x.fmt, cap: x.cap, n: x.members.length })) }); break;
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

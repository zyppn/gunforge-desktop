/* ============================================================
   GUNFORGE authoritative PvP server (phase 1 skeleton)
   - Clients send INPUTS (move dir, look, fire intent), never positions.
   - The server owns positions, hits, HP, kills. Cheating a client
     therefore changes nothing the other players see.
   - Colyseus handles rooms, state sync (20 Hz patches), and reconnects.
   ============================================================ */
const http = require('http');
const { Server, Room } = require('@colyseus/core');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');

const TICK = 1000 / 30;           // 30 Hz simulation
const AW = 60, AD = 40;           // arena size — mirrors the client maps
const PLAYER_R = 0.5, EYE = 1.6;
const SPEED = 6.2;

/* one live session per callsign on this server — no parallel-room reward farming
   (interim identity until Supabase auth binds sessions to real accounts) */
const activeCallsigns = new Map(); // NAME -> sessionId

/* Maps: wall rects only — must match the client's MAPS geometry.
   (Phase 2: generate both from one shared JSON.) */
/* Wall + spawn data extracted VERBATIM from the client's MAPS — one source of truth. */
const MAPS = {
  foundry: { walls: [{x:9,z:6,w:13,d:1.5},{x:38,z:6,w:13,d:1.5},{x:9,z:29.5,w:13,d:1.5},{x:38,z:29.5,w:13,d:1.5},{x:28,z:14,w:4,d:9},{x:15,z:16.5,w:1.5,d:6},{x:43.5,z:16.5,w:1.5,d:6},{x:24,z:4,w:1.5,d:6},{x:34.5,z:27,w:1.5,d:6}],
    spawns: [[4,4],[56,4],[4,36],[56,36],[30,4],[30,36],[4,20],[56,20]] },
  dustrelay: { walls: [{x:12,z:10,w:7,d:7},{x:41,z:10,w:7,d:7},{x:12,z:23,w:7,d:7},{x:41,z:23,w:7,d:7},{x:28,z:5,w:4,d:4},{x:28,z:31,w:4,d:4},{x:4,z:17,w:6,d:1.5},{x:50,z:17,w:6,d:1.5}],
    spawns: [[4,4],[56,4],[4,36],[56,36],[30,18.5],[15,34],[45,4],[30,6]] },
  blacksite: { walls: [{x:0,z:12,w:17,d:1.5},{x:43,z:12,w:17,d:1.5},{x:0,z:23.5,w:17,d:1.5},{x:43,z:23.5,w:17,d:1.5},{x:25,z:0,w:1.5,d:10},{x:33.5,z:0,w:1.5,d:10},{x:25,z:30,w:1.5,d:10},{x:33.5,z:30,w:1.5,d:10},{x:28,z:16.5,w:4,d:4}],
    spawns: [[4,6],[56,6],[4,34],[56,34],[30,3],[30,37],[21,18.5],[39,18.5]] }
};

function circleRect(cx, cz, r, w){
  const nx = Math.max(w.x, Math.min(cx, w.x + w.w));
  const nz = Math.max(w.z, Math.min(cz, w.z + w.d));
  const dx = cx - nx, dz = cz - nz;
  return dx*dx + dz*dz < r*r;
}

/* ---- synced state ---- */
class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name: 'string', x: 'number', z: 'number', yaw: 'number',
  hp: 'number', kills: 'number', deaths: 'number', dead: 'boolean',
  wid: 'string', // weapon id for remote rendering
});
class ArenaState extends Schema {}
defineTypes(ArenaState, {
  players: { map: PlayerState },
  map: 'string',
  target: 'number',
  timeLeft: 'number',
  phase: 'string', // waiting | live | over
  rematchIn: 'number',
});

class ArenaRoom extends Room {
  onCreate(options){
    this.maxClients = 8;
    const state = new ArenaState();
    state.players = new MapSchema();
    state.map = MAPS[options.map] ? options.map : 'foundry';
    state.target = Math.max(1, Math.min(50, Number(options.target) || 20));
    state.timeLeft = 300;
    state.phase = 'waiting';
    state.rematchIn = 0;
    this.setState(state);
    this.walls = MAPS[state.map].walls;
    this.spawns = MAPS[state.map].spawns;
    this.inputs = new Map();   // sessionId -> latest input
    this.fireT = new Map();    // sessionId -> next allowed fire time

    this.onMessage('ping', (client, msg) => {
      client.send('pong', { t: msg && msg.t });
    });

    this.onMessage('input', (client, msg) => {
      // inputs only: {mx, mz (unit move dir), yaw, pitch, fire}
      if(typeof msg !== 'object') return;
      this.inputs.set(client.sessionId, {
        mx: clampN(msg.mx), mz: clampN(msg.mz),
        yaw: num(msg.yaw), pitch: clamp(num(msg.pitch), -1.4, 1.4),
        fire: !!msg.fire,
      });
    });

    this.setSimulationInterval(() => this.tick(), TICK);
  }

  onJoin(client, options){
    const p = new PlayerState();
    p.name = String(options.name || 'OPERATOR').slice(0, 18);
    const key = p.name.toUpperCase();
    if(activeCallsigns.has(key)){
      throw new Error('CALLSIGN "' + p.name + '" IS ALREADY IN A LIVE MATCH ON THIS SERVER');
    }
    activeCallsigns.set(key, client.sessionId);
    p.wid = String(options.wid || 'm17').slice(0, 16);
    const s = this.spawns[this.clients.length % this.spawns.length];
    p.x = s[0]; p.z = s[1]; p.yaw = 0;
    p.hp = 100; p.kills = 0; p.deaths = 0; p.dead = false;
    this.state.players.set(client.sessionId, p);
    this.broadcast('presence', { name: p.name, on: true }, { except: client });
    if(this.clients.length >= 2 && this.state.phase === 'waiting') this.state.phase = 'live';
  }

  onLeave(client){
    const gone = this.state.players.get(client.sessionId);
    if(gone){
      this.broadcast('presence', { name: gone.name, on: false });
      const key = gone.name.toUpperCase();
      if(activeCallsigns.get(key) === client.sessionId) activeCallsigns.delete(key);
      this.state.players.delete(client.sessionId); // only if it was ever added (rejected joins also hit onLeave)
    }
    this.inputs.delete(client.sessionId);
    this.fireT.delete(client.sessionId);
  }

  tick(){
    const dt = TICK / 1000;
    if(this.state.phase === 'live'){
      this.state.timeLeft = Math.max(0, this.state.timeLeft - dt);
      if(this.state.timeLeft <= 0) this.endRound();
    } else if(this.state.phase === 'over'){
      // the room persists: same operators, automatic rematch countdown
      this.state.rematchIn = Math.max(0, this.state.rematchIn - dt);
      if(this.state.rematchIn <= 0) this.resetMatch();
    }
    this.state.players.forEach((p, id) => {
      if(p.dead) return;
      const inp = this.inputs.get(id);
      if(!inp) return;
      p.yaw = inp.yaw;
      // server-side movement with wall collision — the client cannot teleport
      const len = Math.hypot(inp.mx, inp.mz);
      if(len > 0.01){
        const nx = p.x + (inp.mx/Math.max(1,len)) * SPEED * dt;
        const nz = p.z + (inp.mz/Math.max(1,len)) * SPEED * dt;
        if(!this.collides(nx, p.z)) p.x = clamp(nx, PLAYER_R, AW - PLAYER_R);
        if(!this.collides(p.x, nz)) p.z = clamp(nz, PLAYER_R, AD - PLAYER_R);
      }
      if(inp.fire) this.tryFire(id, p, inp);
    });
  }

  collides(x, z){
    for(const w of this.walls) if(circleRect(x, z, PLAYER_R, w)) return true;
    return false;
  }

  endRound(){
    this.state.phase = 'over';
    this.state.rematchIn = 12;
  }

  resetMatch(){
    let i = 0;
    this.state.players.forEach(p => {
      p.kills = 0; p.deaths = 0; p.hp = 100; p.dead = false;
      const s = this.spawns[i++ % this.spawns.length];
      p.x = s[0]; p.z = s[1];
    });
    this.fireT.clear();
    this.state.timeLeft = 300;
    this.state.phase = this.clients.length >= 2 ? 'live' : 'waiting';
    this.broadcast('rematch', {});
  }

  tryFire(id, p, inp){
    if(this.state.phase !== 'live') return; // no damage during waiting or results
    const now = Date.now();
    if((this.fireT.get(id) || 0) > now) return;
    this.fireT.set(id, now + 140); // phase 1: single generic ROF; phase 2 reads the verified loadout
    this.broadcast('shot', { id, x: p.x, z: p.z, yaw: inp.yaw }, { except: this.clients.find(c => c.sessionId === id) });
    // instant-trace hit registration on the server
    const dx = Math.cos(inp.yaw), dz = Math.sin(inp.yaw);
    let best = null, bestD = 60;
    this.state.players.forEach((t, tid) => {
      if(tid === id || t.dead) return;
      // project target onto the ray
      const rx = t.x - p.x, rz = t.z - p.z;
      const along = rx*dx + rz*dz;
      if(along < 0 || along > bestD) return;
      const perp = Math.abs(rx*dz - rz*dx);
      if(perp < 0.6 && this.losClear(p.x, p.z, t.x, t.z)){
        best = { t, tid }; bestD = along;
      }
    });
    if(best){
      best.t.hp -= 12; // phase 2: damage from the verified loadout
      if(best.t.hp <= 0){
        best.t.dead = true; best.t.deaths++;
        p.kills++;
        this.broadcast('kill', { killer: p.name, victim: best.t.name });
        if(p.kills >= this.state.target) this.endRound();
        this.clock.setTimeout(() => this.respawn(best.tid), 2500);
      }
    }
  }

  losClear(x1, z1, x2, z2){
    const steps = Math.ceil(Math.hypot(x2-x1, z2-z1) / 0.5);
    for(let i=1; i<steps; i++){
      const t = i/steps;
      const x = x1 + (x2-x1)*t, z = z1 + (z2-z1)*t;
      for(const w of this.walls) if(x > w.x && x < w.x+w.w && z > w.z && z < w.z+w.d) return false;
    }
    return true;
  }

  respawn(id){
    const p = this.state.players.get(id);
    if(!p) return;
    // farthest spawn from living enemies
    let best = this.spawns[0], bd = -1;
    for(const s of this.spawns){
      let d = 1e9;
      this.state.players.forEach(o => { if(!o.dead && o !== p) d = Math.min(d, Math.hypot(o.x-s[0], o.z-s[1])); });
      if(d > bd){ bd = d; best = s; }
    }
    p.x = best[0]; p.z = best[1]; p.hp = 100; p.dead = false;
  }
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function clampN(v){ return clamp(num(v), -1, 1); }
function num(v){ return typeof v === 'number' && isFinite(v) ? v : 0; }

/* ---- boot ---- */
const port = Number(process.env.PORT || 2567);
const server = http.createServer((req, res) => {
  // health endpoint: uptime pingers, load balancers, and humans checking the server is alive
  if(req.url === '/health' || req.url === '/'){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, up: Math.floor(process.uptime()) + 's' }));
  } else {
    res.writeHead(404); res.end();
  }
});
const game = new Server({ transport: new WebSocketTransport({ server }) });
game.define('arena', ArenaRoom);
server.listen(port, () => console.log('[gunforge-server] listening on :' + port));

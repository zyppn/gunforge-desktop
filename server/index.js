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
const LoadoutCore = require('./loadout-core.js');
const Admin = require('./supabase-admin.js');

const TICK = 1000 / 30;           // 30 Hz simulation
const AW = 60, AD = 40;           // arena size — mirrors the client maps
const PLAYER_R = 0.5, EYE = 1.6;
const SPEED = 6.0;   // MUST match the client's baseSpeed (6.0 * speedMul) or
                     // prediction and reconciliation fight each other forever

/* PvP ability tuning — deliberately its own table rather than reusing the
   client's offline numbers. Values that feel fine against bots (lifesteal above
   all) are oppressive in a duel where both players run the same build. */
const PVP = {
  burnDps:        4,     // incendiary damage per second
  burnDur:        3,     // and how long it lasts (refreshes, never stacks)
  slowDur:        1.5,   // cryo
  slowMul:        0.65,  // movement multiplier while chilled
  critChance:     0.12,  // deadeye
  critMul:        2,
  vampFrac:       0.08,  // 12% offline; toned down for PvP
  explDmg:        10,    // explosive splash
  explRadius:     2.2,
  critHeal:       6,     // Saint set
  killShield:     25,    // Bulwark set
  novaRadius:     4,     // Dragon set: ignite around a corpse
  homingCorridor: 1.5,   // "bullets curve toward enemies", done as hit forgiveness
  baseCorridor:   0.6,   // normal hit tolerance
  maxRange:       60,
};

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
/* Cosmetic slice of an equipped part — just enough for another client to BUILD
   the right geometry (vmOptic and friends branch on name) and colour it by
   rarity. Stats stay server-side in this.loadouts; nothing here is trusted for
   damage. Synced once per player per match, so the delta cost is negligible. */
class PartState extends Schema {}
defineTypes(PartState, {
  name: 'string', rarity: 'string', set: 'string', ability: 'string',
});
class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name: 'string', x: 'number', z: 'number', yaw: 'number',
  hp: 'number', kills: 'number', deaths: 'number', dead: 'boolean',
  wid: 'string',              // weapon id for remote rendering
  eq: { map: PartState },     // equipped parts by slot, for remote rendering
  burnT: 'number',            // seconds of incendiary burn remaining
  slowT: 'number',            // seconds of cryo slow remaining
  shield: 'number',           // Bulwark set: absorbs damage before HP
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
    this.maxClients = 8;   // matches the spawn table and the "#N OF 8" scoreboard;
                           // a 9th player gets their own room instead of a shared spawn
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
    this.loadouts = new Map(); // sessionId -> computed weapon stats (server-authoritative)
    this.playerIds = new Map(); // sessionId -> supabase players.id (verified)
    this.burnSrc = new Map();   // sessionId -> who set them alight (for kill credit)
    this.rewarded = false;      // guard: rewards granted once per round

    this.onMessage('ping', (client, msg) => {
      client.send('pong', { t: msg && msg.t });
    });

    this.onMessage('input', (client, msg) => {
      // inputs only: {mx, mz (unit move dir), yaw, pitch, fire}
      if(typeof msg !== 'object') return;
      this.inputs.set(client.sessionId, {
        mx: clampN(msg.mx), mz: clampN(msg.mz),
        yaw: num(msg.yaw), pitch: clamp(num(msg.pitch), -1.4, 1.4),
        ads: clamp(num(msg.ads), 0, 1),   // whitelisted, or the ADS speed match never arrives
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
    const cleanEq = LoadoutCore.sanitizeEquipped(p.wid, options.equipped);
    this.loadouts.set(client.sessionId, LoadoutCore.computeStats(p.wid, cleanEq));
    // publish the cosmetic slice so other clients can draw this player's build
    p.eq = new MapSchema();
    for(const slot in cleanEq){
      const cp = cleanEq[slot];
      if(!cp) continue;
      const ps = new PartState();
      ps.name = cp.name || '';
      ps.rarity = cp.rarity || 'common';
      ps.set = cp.set || '';
      ps.ability = cp.ability || '';
      p.eq.set(slot, ps);
    }
    // verify identity from the JWT the client sent — server trusts the token, not the name
    if(Admin.ENABLED && options.token){
      Admin.verifyUser(options.token).then(uid => uid && Admin.playerIdForUid(uid))
        .then(pid => { if(pid) this.playerIds.set(client.sessionId, pid); })
        .catch(()=>{});
    }
    const s = this.spawns[this.clients.length % this.spawns.length];
    p.x = s[0]; p.z = s[1]; p.yaw = 0;
    p.hp = 100; p.kills = 0; p.deaths = 0; p.dead = false;
    p.burnT = 0; p.slowT = 0; p.shield = 0;
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
    this.loadouts.delete(client.sessionId);
    this.playerIds.delete(client.sessionId);
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
    // ---- status effects: burn ticks, timers expire ----
    if(this.state.phase === 'live'){
      this.state.players.forEach((p, id) => {
        if(p.dead) return;
        if(p.slowT > 0) p.slowT = Math.max(0, p.slowT - dt);
        if(p.burnT > 0){
          p.burnT = Math.max(0, p.burnT - dt);
          p.hp -= PVP.burnDps * dt;          // burn bypasses shields, like the offline game
          if(p.hp <= 0){
            const srcId = this.burnSrc.get(id);
            const src = srcId && this.state.players.get(srcId);
            if(src && !src.dead && srcId !== id){
              this.killPlayer(srcId, src, p, id, this.loadouts.get(srcId) || {});
            } else {
              p.dead = true; p.deaths++; p.burnT = 0; p.slowT = 0; p.shield = 0;
              this.broadcast('kill', { killer: 'THE FIRE', victim: p.name });
              this.clock.setTimeout(() => this.respawn(id), 2500);
            }
          }
        }
      });
    }

    this.state.players.forEach((p, id) => {
      if(p.dead) return;
      const inp = this.inputs.get(id);
      if(!inp) return;
      p.yaw = inp.yaw;
      // server-side movement with wall collision — the client cannot teleport
      const len = Math.hypot(inp.mx, inp.mz);
      if(len > 0.01){
        // honour the loadout's speed modifier — it was being ignored, so +10% move
        // speed parts did nothing in live PvP. Clamped so a bad part can't fly.
        const pl = this.loadouts.get(id);
        // the client slows to 60% while aiming; mirror it or ADS guarantees drift
        const ads = Math.max(0, Math.min(1, Number(inp.ads) || 0));
        const chill = p.slowT > 0 ? PVP.slowMul : 1;   // cryo
        const spd = SPEED * Math.max(0.5, Math.min(1.6, (pl && pl.speedMul) || 1)) * (1 - ads * 0.4) * chill;
        const nx = p.x + (inp.mx/Math.max(1,len)) * spd * dt;
        const nz = p.z + (inp.mz/Math.max(1,len)) * spd * dt;
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
    this.grantRewards();
  }

  grantRewards(){
    if(this.rewarded || !Admin.ENABLED) return;
    this.rewarded = true;
    // rank players by kills for placement bonuses
    const rows = [];
    this.state.players.forEach((pl, sid) => rows.push({ sid, kills: pl.kills, deaths: pl.deaths }));
    rows.sort((a,b) => b.kills - a.kills);
    rows.forEach((r, idx) => {
      const pid = this.playerIds.get(r.sid);
      if(!pid) return; // unverified / offline account — no persisted reward
      const place = idx + 1;
      const credits = 40 + r.kills*10 + (place===1?50:place===2?25:0);
      const xp = 30 + r.kills*12 + (place===1?40:place===2?20:0);
      // server rolls the loot drop (same odds as before), so the client can't fabricate parts
      const part = LoadoutCore.rollServerDrop(r.kills);
      const statsDelta = { kills:r.kills, deaths:r.deaths, matches:1, wins: place===1?1:0 };
      Admin.grantReward(pid, { credits, xp, part, statsDelta })
        .then(res => {
          const client = this.clients.find(c => c.sessionId === r.sid);
          if(client) client.send('reward', { credits, xp, part: res.granted && res.granted.part ? part : null });
        }).catch(()=>{});
    });
  }

  resetMatch(){
    this.rewarded = false;
    let i = 0;
    this.state.players.forEach(p => {
      p.kills = 0; p.deaths = 0; p.hp = 100; p.dead = false;
      p.burnT = 0; p.slowT = 0; p.shield = 0;
      const s = this.spawns[i++ % this.spawns.length];
      p.x = s[0]; p.z = s[1];
    });
    this.fireT.clear();
    this.state.timeLeft = 300;
    this.state.phase = this.clients.length >= 2 ? 'live' : 'waiting';
    this.broadcast('rematch', {});
  }

  /* ------------------------------------------------------------------
     Hit registration.

     Was: one ray down a fixed 0.6m corridor, damage = dmg * pellets. That made
     the Warden an 8x-damage perfect-accuracy sniper at 60m and made every
     spread part inert. Now each pellet is its own jittered ray, so spread and
     pellet count both mean what they say.

     Abilities are implemented as EFFECTS rather than physics — homing widens
     the hit corridor, ricochet reflects the ray off one wall — so none of this
     needs a projectile system. See PVP for the tuning values.
     ------------------------------------------------------------------ */
  tryFire(id, p, inp){
    if(this.state.phase !== 'live') return; // no damage during waiting or results
    const now = Date.now();
    const ld = this.loadouts.get(id) || { rof:140, dmg:12, pellets:1, spread:0.05, abilities:[] };
    if((this.fireT.get(id) || 0) > now) return;
    this.fireT.set(id, now + ld.rof);
    this.broadcast('shot', { id, x: p.x, z: p.z, yaw: inp.yaw }, { except: this.clients.find(c => c.sessionId === id) });

    const ab = ld.abilities || [];
    const has = k => ab.indexOf(k) >= 0;
    const corridor = has('homing') ? PVP.homingCorridor : PVP.baseCorridor;
    const pierce = has('pierce_all') ? 99 : (has('pierce') ? 1 : 0);
    const bounces = has('ricochet') ? 1 : 0;
    const spread = Math.max(0, Number(ld.spread) || 0);
    const pellets = Math.max(1, ld.pellets || 1);

    for(let i = 0; i < pellets; i++){
      // per-pellet jitter: this is what finally makes spread mods matter
      const a = inp.yaw + (Math.random() - 0.5) * 2 * spread;
      this.castPellet(id, p, Math.cos(a), Math.sin(a), ld, corridor, pierce, bounces);
    }
  }

  /* One pellet. Walks the ray, damaging up to `pierce`+1 targets, and on
     ricochet reflects off the first wall it would have stopped at. */
  castPellet(id, p, dx, dz, ld, corridor, pierce, bounces){
    let ox = p.x, oz = p.z, hitsLeft = pierce + 1;
    const alreadyHit = new Set();

    for(let leg = 0; leg <= bounces && hitsLeft > 0; leg++){
      const targets = [];
      this.state.players.forEach((t, tid) => {
        if(tid === id || t.dead || alreadyHit.has(tid)) return;
        const rx = t.x - ox, rz = t.z - oz;
        const along = rx*dx + rz*dz;
        if(along < 0 || along > PVP.maxRange) return;
        const perp = Math.abs(rx*dz - rz*dx);
        if(perp < corridor && this.losClear(ox, oz, t.x, t.z)) targets.push({ t, tid, along });
      });
      targets.sort((a, b) => a.along - b.along);

      for(const hit of targets){
        if(hitsLeft <= 0) break;
        hitsLeft--; alreadyHit.add(hit.tid);
        this.applyHit(id, p, hit.t, hit.tid, ld);
      }

      if(leg < bounces && hitsLeft > 0){
        const r = this.reflect(ox, oz, dx, dz);
        if(!r) break;
        ox = r.x; oz = r.z; dx = r.dx; dz = r.dz;
      }
    }
  }

  /* Ricochet: march until a wall, then mirror the direction on the face we
     crossed. Geometry, not simulation — no bullet ever exists. */
  reflect(ox, oz, dx, dz){
    const step = 0.4;
    let x = ox, z = oz;
    for(let d = 0; d < PVP.maxRange; d += step){
      const nx = x + dx*step, nz = z + dz*step;
      for(const w of this.walls){
        const inNow = nx > w.x && nx < w.x+w.w && nz > w.z && nz < w.z+w.d;
        if(!inNow) continue;
        // which face did we cross? test each axis independently
        const hitX = !(x > w.x && x < w.x+w.w);
        return { x, z, dx: hitX ? -dx : dx, dz: hitX ? dz : -dz };
      }
      if(nx < 0 || nx > AW || nz < 0 || nz > AD){
        const outX = (nx < 0 || nx > AW);
        return { x, z, dx: outX ? -dx : dx, dz: outX ? dz : -dz };
      }
      x = nx; z = nz;
    }
    return null;
  }

  /* Damage one target, then every on-hit ability. */
  applyHit(id, p, t, tid, ld){
    const ab = ld.abilities || [];
    const has = k => ab.indexOf(k) >= 0;
    const tld = this.loadouts.get(tid);
    const tAb = (tld && tld.abilities) || [];

    let dmg = ld.dmg;   // per pellet now, NOT multiplied by pellet count
    const crit = has('deadeye') && Math.random() < PVP.critChance;
    if(crit) dmg *= PVP.critMul;

    // Juggernaut: 30% reduction while the target is firing
    const tInp = this.inputs.get(tid);
    if(tAb.indexOf('firing_resist') >= 0 && tInp && tInp.fire) dmg *= 0.7;

    dmg = this.damage(t, dmg);

    if(has('incendiary')){ t.burnT = Math.max(t.burnT, PVP.burnDur); this.burnSrc.set(tid, id); }
    if(has('cryo'))       t.slowT = Math.max(t.slowT, PVP.slowDur);
    if(has('vampiric'))   this.heal(p, dmg * PVP.vampFrac);
    if(crit && has('critheal')) this.heal(p, PVP.critHeal);   // Saint set

    if(has('explosive')){
      this.state.players.forEach((o, oid) => {
        if(oid === tid || oid === id || o.dead) return;
        if(Math.hypot(o.x - t.x, o.z - t.z) <= PVP.explRadius) this.damage(o, PVP.explDmg);
      });
      this.checkDeaths(id, p);
    }

    if(t.hp <= 0) this.killPlayer(id, p, t, tid, ld);
  }

  /* Shield soaks first. Returns the damage actually dealt, so lifesteal can't
     be farmed off overkill. */
  damage(t, amount){
    let left = amount;
    if(t.shield > 0){
      const absorbed = Math.min(t.shield, left);
      t.shield -= absorbed; left -= absorbed;
    }
    t.hp -= left;
    return amount;
  }

  heal(p, amount){
    if(!p || p.dead || amount <= 0) return;
    p.hp = Math.min(100, p.hp + amount);
  }

  // splash can drop someone who wasn't the primary target
  checkDeaths(killerId, killer){
    this.state.players.forEach((o, oid) => {
      if(!o.dead && o.hp <= 0) this.killPlayer(killerId, killer, o, oid, this.loadouts.get(killerId) || {});
    });
  }

  killPlayer(id, p, t, tid, ld){
    if(t.dead) return;
    const ab = ld.abilities || [];
    t.dead = true; t.deaths++; t.burnT = 0; t.slowT = 0; t.shield = 0;
    p.kills++;

    if(ab.indexOf('killshield') >= 0) p.shield = Math.min(50, p.shield + PVP.killShield);  // Bulwark
    if(ab.indexOf('fire_nova') >= 0){                                                      // Dragon
      this.state.players.forEach((o, oid) => {
        if(oid === tid || oid === id || o.dead) return;
        if(Math.hypot(o.x - t.x, o.z - t.z) <= PVP.novaRadius){
          o.burnT = Math.max(o.burnT, PVP.burnDur);
          this.burnSrc.set(oid, id);
        }
      });
    }

    this.broadcast('kill', { killer: p.name, victim: t.name });
    if(p.kills >= this.state.target) this.endRound();
    this.clock.setTimeout(() => this.respawn(tid), 2500);
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
    p.burnT = 0; p.slowT = 0; p.shield = 0;
    this.burnSrc.delete(id);
  }
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function clampN(v){ return clamp(num(v), -1, 1); }
function num(v){ return typeof v === 'number' && isFinite(v) ? v : 0; }

/* ---- boot ---- */
const port = Number(process.env.PORT || 2567);
function sendJson(res, code, obj){ res.writeHead(code, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'}); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  // CORS preflight for the reward endpoint
  if(req.method === 'OPTIONS'){ sendJson(res, 204, {}); return; }

  if(req.url === '/health' || req.url === '/'){
    sendJson(res, 200, { ok: true, up: Math.floor(process.uptime()) + 's', economy: Admin.ENABLED });
    return;
  }

  // Offline-match reward grant. The client reports an offline (bot) match result;
  // the server writes the reward to the verified account. Rewards are stamped
  // source:'offline' + bound:true so this loot can be walled off from the shared
  // economy later. PvP rewards still flow through the live room (server-verified).
  if(req.url === '/reward/offline' && req.method === 'POST'){
    let body = '';
    req.on('data', c => { body += c; if(body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        if(!Admin.ENABLED){ sendJson(res, 200, { ok:false, reason:'no-economy' }); return; }
        const jwt = (req.headers.authorization || '').replace(/^Bearer /,'');
        const uid = await Admin.verifyUser(jwt);
        if(!uid){ sendJson(res, 401, { ok:false, reason:'bad-token' }); return; }
        const pid = await Admin.playerIdForUid(uid);
        if(!pid){ sendJson(res, 404, { ok:false, reason:'no-player' }); return; }

        const data = JSON.parse(body || '{}');
        // Idempotency: the client may be replaying a queued match whose original
        // response was lost. Claim the id first — a duplicate grants nothing.
        const firstTime = await Admin.claimMatch(data.mid, pid);
        if(!firstTime){
          sendJson(res, 200, { ok:true, duplicate:true, credits:0, xp:0, part:null });
          return;
        }
        // SERVER decides the reward from reported result — client can't name credit amounts.
        // Clamp reported kills/mode to sane bounds so a forged report can't mint absurd rewards.
        const kills  = Math.max(0, Math.min(50, Number(data.kills) || 0));
        const win    = !!data.win;
        const mode   = String(data.mode || 'ffa').slice(0, 16);
        // offline economy (today: generous to unfreeze; later: capped/rarity-gated for offline)
        const credits = 30 + kills*8 + (win ? 40 : 0);
        const xp      = 25 + kills*10 + (win ? 30 : 0);
        // server rolls the drop (client can't fabricate parts); offline drops are BOUND
        const drop = LoadoutCore.rollServerDrop(kills);
        if(drop){ drop.source = 'offline'; drop.bound = true; }
        const statsDelta = { kills, deaths: Math.max(0,Math.min(50,Number(data.deaths)||0)), matches:1, wins: win?1:0 };
        const result = await Admin.grantReward(pid, { credits, xp, part: drop, statsDelta });
        sendJson(res, 200, { ok: true, credits, xp,
          part: (result.granted && result.granted.part) ? drop : null,
          lockerFull: !!(result.granted && result.granted.lockerFull) });
      } catch(e){ sendJson(res, 400, { ok:false, reason: String(e && e.message || e) }); }
    });
    return;
  }

  res.writeHead(404); res.end();
});
const transport = new WebSocketTransport({ server });
const game = new Server({ transport });
// Nagle's algorithm batches small packets, adding 40-200ms to tiny realtime messages — disable it per socket
transport.wss.on('connection', (ws) => { try{ ws._socket.setNoDelay(true); }catch(e){} });
// filterBy(['map']) so joinOrCreate only matches a room running the SAME map.
// Without it every player landed in the first room created, rendering their own
// choice while colliding against someone else's walls.
game.define('arena', ArenaRoom).filterBy(['map']);
server.listen(port, () => console.log('[gunforge-server] listening on :' + port));

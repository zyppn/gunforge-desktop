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
  critChance:     0.12,  // deadeye, first copy (loadout-core stacks it and adds Saint's +15%)
  critMul:        2,
  vampFrac:       0.08,  // 12% offline; toned down for PvP
  // explDmg is gone: HE Payload is now a fraction of the damage that triggered
  // it (LoadoutCore.splashDamage), so it stops scaling with rate of fire.
  explRadius:     3,     //                    (matches PvE)
  critHeal:       10,    // Saint set — Absolution, reworked to carry its own crit chance
  killShield:     25,    // Bulwark set
  novaRadius:     4,     // Dragon set: ignite around a corpse
  novaDmg:        14,    // PvE deals damage here too, PvP was only igniting
};

/* one live session per callsign on this server — no parallel-room reward farming
   (interim identity until Supabase auth binds sessions to real accounts) */
const activeCallsigns = new Map(); // NAME -> sessionId

/* Maps: wall rects only — must match the client's MAPS geometry.
   (Phase 2: generate both from one shared JSON.) */
/* Wall + spawn data extracted VERBATIM from the client's MAPS — one source of truth. */
/* Wall heights matter now that bullets are 3D: a round clears a 2.4u crate but
   not a 3.2u slab. These MUST stay identical to renderer/index.html's B(x,z,w,d,h)
   — same default, same per-wall overrides — or a shot that visibly sails over cover
   on your screen stops dead on the server. */
const WALL_H = 3.2;
const B = (x, z, w, d, h) => ({ x, z, w, d, h: h || WALL_H });
const MAPS = {
  foundry: { walls: [B(9,6,13,1.5),B(38,6,13,1.5),B(9,29.5,13,1.5),B(38,29.5,13,1.5),B(28,14,4,9,4.2),B(15,16.5,1.5,6),B(43.5,16.5,1.5,6),B(24,4,1.5,6),B(34.5,27,1.5,6)],
    spawns: [[4,4],[56,4],[4,36],[56,36],[30,4],[30,36],[4,20],[56,20]] },
  dustrelay: { walls: [B(12,10,7,7,2.4),B(41,10,7,7,2.4),B(12,23,7,7,2.4),B(41,23,7,7,2.4),B(28,5,4,4),B(28,31,4,4),B(4,17,6,1.5),B(50,17,6,1.5)],
    spawns: [[4,4],[56,4],[4,36],[56,36],[30,18.5],[15,34],[45,4],[30,2]] },   // [30,6] was INSIDE B(28,5,4,4)
  blacksite: { walls: [B(0,12,17,1.5),B(43,12,17,1.5),B(0,23.5,17,1.5),B(43,23.5,17,1.5),B(25,0,1.5,10),B(33.5,0,1.5,10),B(25,30,1.5,10),B(33.5,30,1.5,10),B(28,16.5,4,4,4.6)],
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
    this.shotN = new Map();    // sessionId -> shots fired, for the Swarm cadence
    this.loadouts = new Map(); // sessionId -> computed weapon stats (server-authoritative)
    this.playerIds = new Map(); // sessionId -> supabase players.id (verified)
    this.burnSrc = new Map();   // sessionId -> who set them alight (for kill credit)
    this.burnSpread = new Set();// sessionIds whose CURRENT burn arrived by contagion.
                                // Spread fire must not spread again, or one ignition
                                // chain-reacts through a choke and never stops.
    this.spreadT = 0;           // accumulator for the Dragon contagion cadence
    this.bullets = [];          // live projectiles — see stepBullets()
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
    this.burnSpread.delete(client.sessionId);
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
          if(p.burnT <= 0) this.burnSpread.delete(id);
          p.hp -= PVP.burnDps * dt;          // burn bypasses shields, like the offline game
          if(p.hp <= 0){
            const srcId = this.burnSrc.get(id);
            const src = srcId && this.state.players.get(srcId);
            if(src && !src.dead && srcId !== id){
              this.killPlayer(srcId, src, p, id, this.loadouts.get(srcId) || {});
            } else {
              p.dead = true; p.deaths++; p.burnT = 0; p.slowT = 0; p.shield = 0;
              this.burnSpread.delete(id);
              this.broadcast('kill', { killer: 'THE FIRE', victim: p.name });
              this.clock.setTimeout(() => this.respawn(id), LoadoutCore.RESPAWN_MS);
            }
          }
        }
      });
      this.spreadContagion(dt);
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
        // Ghost Protocol lifts the scope movement tax entirely
        const adsPen = LoadoutCore.adsSlow((pl && pl.abilities) || []);
        const spd = SPEED * Math.max(0.5, Math.min(1.6, (pl && pl.speedMul) || 1)) * (1 - ads * adsPen) * chill;
        const nx = p.x + (inp.mx/Math.max(1,len)) * spd * dt;
        const nz = p.z + (inp.mz/Math.max(1,len)) * spd * dt;
        if(!this.collides(nx, p.z)) p.x = clamp(nx, PLAYER_R, AW - PLAYER_R);
        if(!this.collides(p.x, nz)) p.z = clamp(nz, PLAYER_R, AD - PLAYER_R);
      }
      if(inp.fire) this.tryFire(id, p, inp);
    });

    // Rounds in flight advance AFTER movement and firing, so a bullet spawned
    // this tick doesn't get a free frame of travel before anyone has moved.
    if(this.state.phase === 'live') this.stepBullets(dt);
    else if(this.bullets.length) this.bullets.length = 0;
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

  /* Every client that finished the round MUST get exactly one 'reward' message,
     even when there is nothing to grant. The results screen paints itself from
     this message; with no message it sat on "Tallying rewards..." forever, which
     is what a dead economy, an unverified account and a failed write all looked
     like from the player's side. */
  rewardMsg(sid, msg){
    const client = this.clients.find(c => c.sessionId === sid);
    if(client) client.send('reward', msg);
  }

  grantRewards(){
    if(this.rewarded) return;
    this.rewarded = true;
    if(!Admin.ENABLED){
      this.state.players.forEach((pl, sid) =>
        this.rewardMsg(sid, { credits:0, xp:0, part:null, reason:'no-economy' }));
      return;
    }
    // rank players by kills for placement bonuses
    const rows = [];
    this.state.players.forEach((pl, sid) => rows.push({ sid, kills: pl.kills, deaths: pl.deaths }));
    rows.sort((a,b) => b.kills - a.kills);
    rows.forEach((r, idx) => {
      const pid = this.playerIds.get(r.sid);
      if(!pid){   // unverified / offline account — no persisted reward, but say so
        this.rewardMsg(r.sid, { credits:0, xp:0, part:null, reason:'not-signed-in' });
        return;
      }
      const place = idx + 1;
      const credits = 40 + r.kills*10 + (place===1?50:place===2?25:0);
      const xp = 30 + r.kills*12 + (place===1?40:place===2?20:0);
      // server rolls the loot drop (same odds as before), so the client can't fabricate parts
      const part = LoadoutCore.rollServerDrop(r.kills);
      const statsDelta = { kills:r.kills, deaths:r.deaths, matches:1, wins: place===1?1:0 };
      Admin.grantReward(pid, { credits, xp, part, statsDelta })
        .then(res => {
          const g = res && res.granted;
          this.rewardMsg(r.sid, {
            credits, xp,
            part: (g && g.part) ? part : null,
            lockerFull: !!(g && g.lockerFull),   // a forfeited drop is not "no drop"
          });
        })
        .catch(e => {
          console.error('[gunforge-server] reward grant failed', e && e.message || e);
          this.rewardMsg(r.sid, { credits:0, xp:0, part:null, reason:'grant-failed' });
        });
    });
  }

  resetMatch(){
    this.rewarded = false;
    let i = 0;
    this.burnSpread.clear();
    this.state.players.forEach(p => {
      p.kills = 0; p.deaths = 0; p.hp = 100; p.dead = false;
      p.burnT = 0; p.slowT = 0; p.shield = 0;
      const s = this.spawns[i++ % this.spawns.length];
      p.x = s[0]; p.z = s[1];
    });
    this.fireT.clear();
    this.bullets.length = 0;    // rounds in flight don't survive the round
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
    const ld = this.loadouts.get(id) || { rof:140, dmg:12, pellets:1, spread:0.05, bspd:560, abilities:[] };
    if((this.fireT.get(id) || 0) > now) return;
    this.fireT.set(id, now + ld.rof);

    const ab = ld.abilities || [];
    const has = k => ab.indexOf(k) >= 0;
    const pellets = Math.max(1, ld.pellets || 1);
    // Hornet Swarm fires one seeker in every HOMING.every rounds; the rest fly
    // straight. Legibility, not strength - see loadout-core.
    const shotN = (this.shotN.get(id) || 0) + 1;
    this.shotN.set(id, shotN);
    const seeker = has('homing') && (shotN % LoadoutCore.HOMING.every === 0);
    // Mirrors the client exactly: it builds its weapon with spread = L.spread * 0.55
    // and then tightens by (1 - adsT * 0.55) when aimed. The server used raw L.spread
    // and no ADS term at all, so it rolled a pattern ~1.8x wider than the one you saw
    // and aiming down sights made you slower without making you more accurate.
    const ads = Math.max(0, Math.min(1, Number(inp.ads) || 0));
    // The 0.55 is the base cone both sides bake in; the ADS tightening lives in
    // loadout-core so the client cannot disagree with the server about it.
    const sprd = LoadoutCore.fireSpread((Number(ld.spread) || 0) * 0.55, ads);
    const speed = (Number(ld.bspd) || 560) / 9;   // the client's player-bullet speed
    const pitch = Math.max(-1.4, Math.min(1.4, Number(inp.pitch) || 0));

    // aim vector from yaw+pitch, same basis the client fires along
    // Matches three.js Euler 'YXZ' applied to (0,0,-1), which is how the client
    // builds its own aim vector. y is +sin(pitch): the client does pitch -= movementY,
    // so looking up is POSITIVE pitch and the round must rise, not dive.
    const cp = Math.cos(pitch);
    const ax = Math.cos(inp.yaw) * cp, ay = Math.sin(pitch), az = Math.sin(inp.yaw) * cp;

    const wire = [];
    for(let i = 0; i < pellets; i++){
      let dx = ax + (Math.random()-0.5)*2*sprd;
      let dy = ay + (Math.random()-0.5)*2*sprd;
      let dz = az + (Math.random()-0.5)*2*sprd;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      const b = {
        owner: id,
        x: p.x + dx*(PLAYER_R + 0.35), y: EYE - 0.06, z: p.z + dz*(PLAYER_R + 0.35),
        vx: dx*speed, vy: dy*speed, vz: dz*speed,
        dmg: ld.dmg, life: 1.6,
        pierce: has('pierce_all') ? 99 : (has('pierce') ? 1 : 0),
        // AP Rounds: how much solid wall this round may cross before it stops
        // A seeker round carries no wall budget, and a piercing round does not
        // seek. Otherwise Hornet plus AP Rounds is a round that curves toward
        // someone through a wall (the target scan has no line of sight check)
        // and then punches through it. This way your straight rounds pierce
        // cover and your seeker rounds seek - one or the other, never both.
        wall: (has('pierce') || has('pierce_all')) && !seeker ? LoadoutCore.AP_WALL.budget : 0,
        thruWall: false,
        bounce: has('ricochet') ? 3 : 0,   // a single bounce almost never produced a hit
        homing: seeker,
        crit: Math.random() < (Number(ld.crit) || 0),   // build-dependent: stacked Deadeye + Saint
        hit: new Set(),
      };
      b.ox = b.x; b.oz = b.z;   // muzzle, for range falloff in applyHit
      this.bullets.push(b);
      // The shooter already predicted this round locally; everyone else gets the
      // exact vector so their tracer follows the same path this bullet will.
      wire.push(+b.x.toFixed(2), +b.y.toFixed(2), +b.z.toFixed(2),
                +b.vx.toFixed(2), +b.vy.toFixed(2), +b.vz.toFixed(2));
    }
    this.broadcast('shot', { id, b: wire, s: seeker ? 1 : 0, g: has('pierce_all') ? 1 : 0 },
                   { except: this.clients.find(c => c.sessionId === id) });
  }

  /* ------------------------------------------------------------------
     Bullets are simulated, not cast. This is a port of the client's PvE
     bullet loop (renderer/index.html) so that live combat resolves the same
     way free-for-all does: travel time, 3D spread, real wall and floor
     collision, homing that actually steers, ricochet that actually bounces.

     Deliberately NOT lag-compensated. At bspd/9 (~62 u/s) a 20u shot is in
     the air ~0.32s, in which a strafing target moves ~1.8u — you lead by
     over three player-radii regardless. Rewinding by a 50ms ping would
     correct ~0.3u of that, less than one radius, so the complexity buys
     almost nothing here. If real games at real ping say otherwise, rewind
     goes in stepBullets and nothing else has to change.
     ------------------------------------------------------------------ */
  stepBullets(dt){
    for(let i = this.bullets.length - 1; i >= 0; i--){
      const b = this.bullets[i];
      b.life -= dt;
      if(b.life <= 0){ this.bullets.splice(i, 1); continue; }

      // A seeker that has come through cover stops seeking. The target scan has
      // no line of sight check - it takes the nearest body inside HOMING.seek
      // whether you can see it or not - so AP Rounds plus the Hornet set would
      // otherwise be a round that punches through a wall and then curves onto
      // someone you cannot see. Fixing it here is cheaper and more predictable
      // than raycasting line of sight for every bullet, every tick.
      if(b.homing && !b.thruWall){
        const HM = LoadoutCore.HOMING;
        let ht = null, hd = HM.seek * HM.seek;
        this.state.players.forEach((t, tid) => {
          if(t.dead || tid === b.owner || b.hit.has(tid)) return;
          const ddx = t.x - b.x, ddz = t.z - b.z, dd = ddx*ddx + ddz*ddz;
          if(dd < hd){ hd = dd; ht = t; }
        });
        if(ht){
          const spd = Math.hypot(b.vx, b.vz);
          const cur = Math.atan2(b.vz, b.vx);
          let dA = Math.atan2(ht.z - b.z, ht.x - b.x) - cur;
          while(dA >  Math.PI) dA -= 2*Math.PI;
          while(dA < -Math.PI) dA += 2*Math.PI;
          if(Math.abs(dA) < HM.cone){    // only bend toward targets ahead — no boomerangs
            const na = cur + Math.max(-HM.turn*dt, Math.min(HM.turn*dt, dA));
            b.vx = Math.cos(na)*spd; b.vz = Math.sin(na)*spd;
            b.vy += Math.max(-6, Math.min(6, (1.1 - b.y)*HM.vert)) * dt;
          }
        }
      }

      /* Substep the flight. A round travels bspd/9 = ~62 u/s, so a single 1/30s
         tick advances it 2.07u — wider than a player (1.36u across) and wider than
         the thinnest wall (1.5u). Integrated in one jump it tunnels straight through
         both: in testing, an M17 shot at a target 6u away landed at 4.97 and then
         7.04 and never touched it. Cap each step well under the smallest thing a
         bullet can hit, so collision is independent of tick rate. */
      const dist = Math.hypot(b.vx, b.vz, b.vy) * dt;
      const steps = Math.max(1, Math.ceil(dist / 0.3));
      const sdt = dt / steps;
      let dead = false, consumed = false;
      const owner = this.state.players.get(b.owner);

      for(let sIdx = 0; sIdx < steps && !dead && !consumed; sIdx++){
        const nx = b.x + b.vx*sdt, ny = b.y + b.vy*sdt, nz = b.z + b.vz*sdt;
        if(nx < 0.05 || nx > AW-0.05){ if(b.bounce > 0){ b.bounce--; b.vx *= -1; } else dead = true; }
        if(nz < 0.05 || nz > AD-0.05){ if(b.bounce > 0){ b.bounce--; b.vz *= -1; } else dead = true; }
        if(ny < 0.03){ if(b.bounce > 0){ b.bounce--; b.vy *= -1; } else dead = true; }
        if(ny > 9) dead = true;
        if(!dead){
          for(const w of this.walls){
            if(nx > w.x && nx < w.x+w.w && nz > w.z && nz < w.z+w.d && ny < w.h){
              // AP Rounds burn their wall budget instead of stopping. Thin
              // cover (every long barrier here is 1.5u) stops being absolute;
              // the 4u pillars still eat the round.
              if(b.wall > 0){
                b.wall -= Math.hypot(b.vx, b.vy, b.vz) * sdt;
                b.thruWall = true;
                if(b.wall <= 0) dead = true;
              } else if(b.bounce > 0){
                b.bounce--;
                if(b.x <= w.x || b.x >= w.x+w.w) b.vx *= -1; else b.vz *= -1;
              } else dead = true;
              break;
            }
          }
        }
        if(dead) break;
        b.x = nx; b.y = ny; b.z = nz;

        // entity hits — the same capsule the client uses (radius + 0.18, top 1.9)
        this.state.players.forEach((t, tid) => {
          if(consumed || t.dead || tid === b.owner || b.hit.has(tid)) return;
          const ddx = t.x - b.x, ddz = t.z - b.z;
          if(b.y > 0 && b.y < 1.9 && ddx*ddx + ddz*ddz < (PLAYER_R + 0.18)*(PLAYER_R + 0.18)){
            b.hit.add(tid);
            if(owner) this.applyHit(b.owner, owner, t, tid, this.loadouts.get(b.owner) || {}, b);
            if(b.pierce > 0) b.pierce--; else consumed = true;
          }
        });
      }
      if(dead || consumed){ this.bullets.splice(i, 1); continue; }
    }
  }

  /* Damage one target, then every on-hit ability. */
  applyHit(id, p, t, tid, ld, b){
    const ab = ld.abilities || [];
    const has = k => ab.indexOf(k) >= 0;
    const tld = this.loadouts.get(tid);
    const tAb = (tld && tld.abilities) || [];

    let dmg = ld.dmg;   // per pellet, NOT multiplied by pellet count
    // Range falloff, measured muzzle -> impact. Flat 1.0 for every weapon but
    // the LS-1; see FALLOFF in loadout-core. Applied BEFORE crit so a crit
    // doubles what actually landed rather than what the sniper would have done
    // from across the map.
    if(b && b.ox !== undefined){
      dmg *= LoadoutCore.rangeMul(ld.weaponId, Math.hypot(b.x - b.ox, b.z - b.oz));
    }
    // What HE Payload scales from: after range falloff, before crit. A crit
    // should double what it hits, not the blast radius as well.
    // a round that came through cover lands softer
    if(b && b.thruWall) dmg *= LoadoutCore.AP_WALL.dmgMul;
    const splashBase = dmg;
    // Crit is decided when the round leaves the barrel, exactly as PvE does it
    // (b.crit), so one pellet's luck can't be re-rolled per target it pierces.
    const crit = b ? !!b.crit : (Math.random() < (Number(ld.crit) || 0));
    if(crit) dmg *= PVP.critMul;

    // Dragon: burning flesh takes more, but only from the person burning it.
    // Read BEFORE the ignite below, so the round that lights them does not also
    // get the bonus - the first hit lights, every one after it burns hotter.
    if(has('fire_nova') && t.burnT > 0) dmg *= 1 + LoadoutCore.DRAGON.molten;

    // Juggernaut: 30% reduction while the target is firing
    const tInp = this.inputs.get(tid);
    if(tAb.indexOf('firing_resist') >= 0 && tInp && tInp.fire) dmg *= 0.7;

    dmg = this.damage(t, dmg);

    // The set carries its own ignition, so it is never a worse Incendiary and
    // does not eat one of the four ability slots it leaves you.
    if(has('incendiary') || has('fire_nova')){
      t.burnT = Math.max(t.burnT, PVP.burnDur); this.burnSrc.set(tid, id);
      this.burnSpread.delete(tid);          // a direct hit outranks a spread burn
    }
    if(has('cryo'))       t.slowT = Math.max(t.slowT, PVP.slowDur);
    if(has('vampiric'))   this.heal(p, dmg * PVP.vampFrac);
    if(crit && has('critheal')) this.heal(p, PVP.critHeal);   // Saint set

    if(has('explosive')){
      const ex = b ? b.x : t.x, ez = b ? b.z : t.z;   // splash from the impact, like PvE
      this.state.players.forEach((o, oid) => {
        if(oid === tid || oid === id || o.dead) return;
        if(Math.hypot(o.x - ex, o.z - ez) <= PVP.explRadius) this.damage(o, LoadoutCore.splashDamage(splashBase));
      });
      this.checkDeaths(id, p);
    }

    if(t.hp <= 0) this.killPlayer(id, p, t, tid, ld);
  }

  /* Shield soaks first. Returns the damage actually dealt, so lifesteal can't
     be farmed off overkill. */
  damage(t, amount){
    let left = amount;
    // A shield soaks at most SHIELD_SOAK of a hit; the rest always reaches hp.
    // Full absorption made Bulwark unbounded - see loadout-core.
    if(t.shield > 0){
      const absorbed = Math.min(t.shield, left * LoadoutCore.SHIELD_SOAK);
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

  /* Dragon contagion. Fire leaps from a burning player to enemies near them,
     checked on a slow cadence rather than every tick: at 30Hz a per-tick check
     would re-apply thirty times a second for no gain.

     Two guards keep it from running away. Fire that ARRIVED by spreading never
     spreads again (burnSpread), so a crowded choke cannot chain-react; and a
     spread burn is shorter than one you lit yourself, so standing near a
     burning enemy is a nudge rather than a sentence. */
  spreadContagion(dt){
    const D = LoadoutCore.DRAGON;
    this.spreadT += dt;
    if(this.spreadT < D.spreadEvery) return;
    this.spreadT = 0;
    // collect first: igniting inside the outer walk would let a player caught
    // this pass immediately spread it on in the same pass.
    const seeds = [];
    this.state.players.forEach((p, id) => {
      if(p.dead || p.burnT <= 0) return;
      if(this.burnSpread.has(id)) return;          // spread fire does not spread
      const srcId = this.burnSrc.get(id);
      if(!srcId || srcId === id) return;
      const ld = this.loadouts.get(srcId);
      if(!ld || (ld.abilities || []).indexOf('fire_nova') < 0) return;
      seeds.push({ x: p.x, z: p.z, victim: id, srcId });
    });
    if(!seeds.length) return;
    for(const s of seeds){
      this.state.players.forEach((o, oid) => {
        if(oid === s.victim || oid === s.srcId || o.dead) return;
        if(o.burnT > 0) return;                    // already alight; do not refresh
        if(Math.hypot(o.x - s.x, o.z - s.z) > D.spreadR) return;
        o.burnT = D.spreadDur;
        this.burnSrc.set(oid, s.srcId);            // kill credit still goes to the lighter
        this.burnSpread.add(oid);
      });
    }
  }

  killPlayer(id, p, t, tid, ld){
    if(t.dead) return;
    const ab = ld.abilities || [];
    t.dead = true; t.deaths++; t.burnT = 0; t.slowT = 0; t.shield = 0;
    this.burnSpread.delete(tid);
    p.kills++;

    if(ab.indexOf('killshield') >= 0) p.shield = Math.min(50, p.shield + PVP.killShield);  // Bulwark
    if(ab.indexOf('fire_nova') >= 0){                                                      // Dragon
      this.state.players.forEach((o, oid) => {
        if(oid === tid || oid === id || o.dead) return;
        if(Math.hypot(o.x - t.x, o.z - t.z) <= PVP.novaRadius){
          this.damage(o, PVP.novaDmg);          // PvE deals 14 here; PvP only ignited
          o.burnT = Math.max(o.burnT, PVP.burnDur);
          this.burnSrc.set(oid, id);
        }
      });
    }

    // killerId lets the victim's client read the killer's already-synced build
    // (p.eq) for the eliminated-by card, with no extra round trip.
    this.broadcast('kill', { killer: p.name, victim: t.name, killerId: id });
    if(p.kills >= this.state.target) this.endRound();
    this.clock.setTimeout(() => this.respawn(tid), LoadoutCore.RESPAWN_MS);
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
    this.burnSpread.delete(id);
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

  /* ---- daily store ------------------------------------------------------
     The shop is a pure function of (player id, store day), so there is nothing
     stored to fetch — the server just derives it. It does that itself rather
     than trusting the client's copy, which is what makes the purchase safe: you
     can only buy the item the server independently computed for slot N. */
  if(req.url === '/store' && req.method === 'POST'){
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
        const win = LoadoutCore.storeWindow(Date.now());
        const items = LoadoutCore.rollDailyStore(pid, win.key);
        const bought = await Admin.storePurchases(pid, win.key);
        sendJson(res, 200, { ok:true, day:win.key, opens:win.start, refreshAt:win.next, items, bought });
      } catch(e){ sendJson(res, 400, { ok:false, reason:String(e && e.message || e) }); }
    });
    return;
  }

  if(req.url === '/store/buy' && req.method === 'POST'){
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
        const idx = Number(data.idx);
        if(!Number.isInteger(idx) || idx < 0 || idx > 7){
          sendJson(res, 400, { ok:false, reason:'bad-slot' }); return;
        }
        // Re-derive rather than trust: the client sends only WHICH slot, never what
        // is in it. A forged price or a legendary in slot 0 cannot survive this.
        const win = LoadoutCore.storeWindow(Date.now());
        const item = LoadoutCore.rollDailyStore(pid, win.key)[idx];
        if(!item){ sendJson(res, 400, { ok:false, reason:'bad-slot' }); return; }

        const r = await Admin.buyStorePart(pid, win.key, idx, item.price, item);
        if(!r || !r.ok){ sendJson(res, 200, { ok:false, reason:(r && r.reason) || 'failed' }); return; }
        sendJson(res, 200, { ok:true, idx, price:item.price, part:r.part, credits:r.credits,
                             refreshAt:win.next });
      } catch(e){ sendJson(res, 400, { ok:false, reason:String(e && e.message || e) }); }
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

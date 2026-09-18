/* Headless PvP combat harness. Loads the REAL ArenaRoom out of server/index.js
   with the transport and Supabase layers stubbed, then drives tryFire directly. */
const path = require('path');
const Module = require('module');
const SRV = path.join(__dirname, '..');

let Captured = null;
class FakeRoom {
  constructor(){ this.clients = []; this.handlers = {}; this._timers = []; }
  setState(s){ this.state = s; }
  onMessage(k, fn){ this.handlers[k] = fn; }
  setSimulationInterval(){}
  broadcast(type, msg){ (this.bcast || (this.bcast = [])).push({type, msg}); }
  get clock(){ return { setTimeout: (fn, ms) => this._timers.push({fn, ms}) }; }
}
const stubs = {
  '@colyseus/core': {
    Room: FakeRoom,
    Server: class { constructor(){} define(n, k){ Captured = k; return { filterBy(){ return this; } }; } },
  },
  '@colyseus/ws-transport': { WebSocketTransport: class { constructor(){ this.wss = { on(){} }; } } },
};
const origLoad = Module._load;
Module._load = function(req, parent, isMain){
  if(stubs[req]) return stubs[req];
  if(req === './supabase-admin.js') return { ENABLED:false, verifyUser:async()=>null, playerIdForUid:async()=>null, grantMatchRewards:async()=>({}) };
  return origLoad.apply(this, arguments);
};
process.env.PORT = '0';
require(path.join(SRV, 'index.js'));
Module._load = origLoad;
if(!Captured) throw new Error('ArenaRoom not captured');

// ---- build a room with two players ----
function mkRoom(){
  const r = new Captured();
  r.onCreate({ map:'foundry' });
  return r;
}
let CS = 0;   // activeCallsigns is a process-wide map and onLeave never runs here
function join(r, sid, name, eq, wid){
  name = name + '#' + (++CS);
  const client = { sessionId: sid, send(){} };
  r.clients.push(client);
  r.onJoin(client, { name, wid: wid || 'm17', equipped: eq || {} });
  return r.state.players.get(sid);
}
// place A at the origin-ish looking straight down +x at B, `dist` away
function face(a, b, dist){
  a.x = 10; a.z = 10; b.x = 10 + dist; b.z = 10;
  return 0; // yaw 0 == +x, matching cos/sin use in castPellet
}
function input(r, sid, yaw){ r.inputs.set(sid, { mx:0, mz:0, yaw, pitch:0, ads:0, fire:true }); }
/* Combat is projectile-based now, so a shot does not resolve on the call that
   fires it. Fire once, then step the sim until every round has landed or died. */
function fireAndSettle(r, sid){
  const p = r.state.players.get(sid);
  r.state.phase = 'live';
  r.fireT.set(sid, -1);
  r.tryFire(sid, p, r.inputs.get(sid));
  // stop everyone else shooting back while the round is in the air
  r.state.players.forEach((_, oid) => {
    if(oid === sid) return;
    const o = r.inputs.get(oid) || { mx:0, mz:0, yaw:0, pitch:0, ads:0 };
    r.inputs.set(oid, Object.assign({}, o, { fire:false }));
  });
  const dt = 1/30;
  for(let i = 0; i < 80 && r.bullets.length; i++) r.stepBullets(dt);
}

let fails = 0;
function check(label, ok, detail){
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  if(!ok) fails++;
}

// ---------- 1. shotgun spread: damage falls off with range ----------
{
  const sample = (dist, trials) => {
    let total = 0;
    for(let i = 0; i < trials; i++){
      const r = mkRoom();
      const a = join(r, 'A', 'AAA' + i, {}, 'warden');
      const b = join(r, 'B', 'BBB' + i, {}, 'm17');
      face(a, b, dist);
      input(r, 'A', 0);
      fireAndSettle(r, 'A');
      total += (100 - b.hp);
    }
    return total / trials;
  };
  const ld = (() => { const r = mkRoom(); join(r, 'A', 'PROBE', {}, 'warden'); return r.loadouts.get('A'); })();
  console.log('\nSHOTGUN (' + ld.pellets + ' pellets x ' + ld.dmg.toFixed(1) + ' dmg, spread ' + ld.spread.toFixed(3) + ')');
  const near = sample(3, 400), far = sample(25, 400);
  console.log('    close (3m): ' + near.toFixed(1) + ' avg   far (25m): ' + far.toFixed(1) + ' avg');
  check('pellets are real (>1 pellet worth of damage up close)', near > ld.dmg * 1.5, near.toFixed(1));
  check('spread thins the pattern with range', far < near * 0.7, far.toFixed(1) + ' < ' + (near * 0.7).toFixed(1));
  check('a point-blank shotgun cannot exceed its full pattern', near <= ld.dmg * ld.pellets + 0.001);
}

// ---------- 2. deadeye crit rate lands near 12% ----------
{
  const eq = { frame: { slot:'frame', weapon:'m17', name:'Deadeye Frame', rarity:'legendary', ability:'deadeye', mods:{} } };
  const N = 6000;
  let crits = 0, base = null;
  for(let i = 0; i < N; i++){
    const r = mkRoom();
    const a = join(r, 'A', 'A' + i, eq, 'm17');
    const b = join(r, 'B', 'B' + i, {}, 'm17');
    face(a, b, 6); input(r, 'A', 0);    const ld = r.loadouts.get('A');
    if(base === null) base = ld.dmg;
    fireAndSettle(r, 'A');
    const dealt = 100 - b.hp;
    if(dealt > base * 1.5) crits++;
  }
  const rate = crits / N;
  console.log('\nDEADEYE  crit rate ' + (rate * 100).toFixed(2) + '% over ' + N + ' shots (target 12%)');
  check('crit rate within 2 points of 12%', Math.abs(rate - 0.12) < 0.02, (rate * 100).toFixed(2) + '%');
}

// ---------- 3. a full burn totals burnDps * burnDur ----------
{
  const eq = { barrel: { slot:'barrel', weapon:'m17', name:'Incendiary Barrel', rarity:'epic', ability:'incendiary', mods:{} } };
  const r = mkRoom();
  const a = join(r, 'A', 'TORCH', eq, 'm17');
  const b = join(r, 'B', 'TINDER', {}, 'm17');
  face(a, b, 6); input(r, 'A', 0);  r.state.phase = 'live';
  fireAndSettle(r, 'A');
  const afterShot = b.hp;
  check('incendiary sets a 3s burn', Math.abs(b.burnT - 3) < 1e-9, 'burnT=' + b.burnT);
  // stop A shooting, then tick 4 seconds of pure burn
  r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  const before = b.hp;
  let t = 0; const dt = 1 / 30;
  while(t < 4){ r.tick(); t += dt; }
  const burned = before - b.hp;
  console.log('\nINCENDIARY  shot ' + (100 - afterShot).toFixed(1) + ' impact, then ' + burned.toFixed(2) + ' burn (expect 12)');
  check('a full burn totals burnDps x burnDur = 12', Math.abs(burned - 12) < 0.5, burned.toFixed(2));
  check('the burn expires rather than ticking forever', b.burnT === 0);
}

// ---------- 4. pierce walks the ray through stacked targets ----------
{
  const mk = ability => {
    const eq = ability ? { barrel:{ slot:'barrel', weapon:'m17', name:'Pierce Barrel', rarity:'legendary', ability, mods:{} } } : {};
    const r = mkRoom();
    const a = join(r, 'A', 'PIERCER', eq, 'm17');
    const t1 = join(r, 'B', 'T1', {}, 'm17');
    const t2 = join(r, 'C', 'T2', {}, 'm17');
    const t3 = join(r, 'D', 'T3', {}, 'm17');
    a.x = 10; a.z = 10;
    t1.x = 14; t1.z = 10; t2.x = 18; t2.z = 10; t3.x = 22; t3.z = 10;  // dead in a line
    input(r, 'A', 0);    fireAndSettle(r, 'A');
    return [t1, t2, t3].map(t => +(100 - t.hp).toFixed(2));
  };
  const none = mk(null), one = mk('pierce'), all = mk('pierce_all');
  console.log('\nPIERCE   none: ' + JSON.stringify(none) + '  pierce: ' + JSON.stringify(one) + '  pierce_all: ' + JSON.stringify(all));
  check('no pierce stops at the first target', none[0] > 0 && none[1] === 0 && none[2] === 0);
  check('pierce carries through exactly one more', one[0] > 0 && one[1] > 0 && one[2] === 0);
  check('pierce_all hits the whole line', all.every(d => d > 0));
}

// ---------- 5. shields absorb before HP, and burn ignores them ----------
{
  const r = mkRoom();
  const a = join(r, 'A', 'SHOOTER', {}, 'm17');
  const b = join(r, 'B', 'TANK', {}, 'm17');
  face(a, b, 6); input(r, 'A', 0);
  b.shield = 25;
  fireAndSettle(r, 'A');
  console.log('\nSHIELD   after one shot: shield=' + b.shield.toFixed(1) + ' hp=' + b.hp.toFixed(1));
  check('damage eats the shield before HP', b.hp === 100 && b.shield < 25);
  b.shield = 25; b.burnT = 1; r.state.phase = 'live';
  r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  const hp0 = b.hp; r.tick();
  check('burn bypasses the shield', b.hp < hp0 && b.shield === 25);
}

// ---------- 6. vampiric heals the shooter, capped at 100 ----------
{
  const eq = { stock:{ slot:'stock', weapon:'m17', name:'Vampiric Stock', rarity:'legendary', ability:'vampiric', mods:{} } };
  const r = mkRoom();
  const a = join(r, 'A', 'LEECH', eq, 'm17');
  const b = join(r, 'B', 'FOOD', {}, 'm17');
  face(a, b, 6); input(r, 'A', 0);
  a.hp = 50;
  fireAndSettle(r, 'A');
  const dealt = 100 - b.hp, healed = a.hp - 50;
  console.log('\nVAMPIRIC dealt ' + dealt.toFixed(2) + ', healed ' + healed.toFixed(2) + ' (8% = ' + (dealt * 0.08).toFixed(2) + ')');
  check('lifesteal is 8% of damage dealt', Math.abs(healed - dealt * 0.08) < 0.01);
  a.hp = 99; b.hp = 100; fireAndSettle(r, 'A');
  check('lifesteal cannot overheal past 100', a.hp <= 100, 'hp=' + a.hp);
}

// ---------- 7. cryo halves nothing it shouldn't: slow applies, expires ----------
{
  const eq = { magazine:{ slot:'magazine', weapon:'m17', name:'Cryo Mag', rarity:'epic', ability:'cryo', mods:{} } };
  const r = mkRoom();
  const a = join(r, 'A', 'FROST', eq, 'm17');
  const b = join(r, 'B', 'CHILLED', {}, 'm17');
  face(a, b, 6); input(r, 'A', 0);  r.state.phase = 'live';
  fireAndSettle(r, 'A');
  check('cryo chills for 1.5s', Math.abs(b.slowT - 1.5) < 1e-9, 'slowT=' + b.slowT);
  r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  let t = 0; while(t < 2){ r.tick(); t += 1/30; }
  check('the chill wears off', b.slowT === 0);
}

// ---------- 8. rounds expire on their lifetime, as in PvE ----------
{
  const r = mkRoom();
  const a = join(r, 'A', 'SNIPE', {}, 'm17');
  join(r, 'B', 'NOBODY', {}, 'm17').x = 999;   // parked out of the way
  a.x = 1; a.z = 12;
  input(r, 'A', 0);
  r.state.phase = 'live'; r.fireT.set('A', -1);
  r.tryFire('A', a, r.inputs.get('A'));
  r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  let t = 0; const dt = 1/30;
  while(r.bullets.length && t < 3){ r.stepBullets(dt); t += dt; }
  console.log('\nLIFETIME    round gone after ' + t.toFixed(2) + 's (life 1.6s, or the far wall at ~59u)');
  check('a round does not live forever', r.bullets.length === 0 && t <= 1.7, t.toFixed(2) + 's');
}

// ---------- 9. no tunnelling: a round must hit at EVERY range, not just some ----------
{
  // Regression guard. Integrated in one 1/30s jump a bullet advances 2.07u while a
  // player is 1.36u wide, so hits landed or vanished depending on where the step
  // boundaries happened to fall. The LS-1 is the worst case at 128 u/s (4.3u a tick)
  // and is accurate enough that any miss here is tunnelling, not spread.
  const misses = [];
  for(let d = 2; d <= 30; d++){
    const r = mkRoom();
    const a = join(r, 'A', 'S', {}, 'ls1');   // spread 0.005: misses mean tunnelling, not dispersion
    const b = join(r, 'B', 'T', {}, 'm17');
    a.x = 2; a.z = 12; b.x = 2 + d; b.z = 12;   // z=12 is a clear lane in foundry
    input(r, 'A', 0); fireAndSettle(r, 'A');
    if(b.hp === 100) misses.push(d);
  }
  console.log('\nTUNNELLING  ranges 2-30u, misses at: ' + (misses.length ? misses.join(', ') : 'none'));
  check('a straight shot connects at every range', misses.length === 0, misses.join(','));
}

// ---------- 10. collision is tick-rate independent ----------
{
  const at = dt => {
    let hits = 0;
    for(let d = 2; d <= 25; d++){
      const r = mkRoom();
      const a = join(r, 'A', 'S', {}, 'ls1');   // accurate AND fastest: the worst case for tunnelling
      const b = join(r, 'B', 'T', {}, 'm17');
      a.x = 2; a.z = 12; b.x = 2 + d; b.z = 12;   // z=12 is a clear lane in foundry
      input(r, 'A', 0);
      r.state.phase = 'live'; r.fireT.set('A', -1);
      r.tryFire('A', a, r.inputs.get('A'));
      r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
      for(let i = 0; i < 200 && r.bullets.length; i++) r.stepBullets(dt);
      if(b.hp < 100) hits++;
    }
    return hits;
  };
  const fast = at(1/60), norm = at(1/30), slow = at(1/10);
  console.log('\nTICK RATE   hits at 60Hz/30Hz/10Hz: ' + fast + '/' + norm + '/' + slow + ' of 24');
  check('substepping makes hits independent of tick rate', fast === norm && norm === slow,
        fast + '/' + norm + '/' + slow);
}

// ---------- 11. travel time is real ----------
{
  const r = mkRoom();
  const a = join(r, 'A', 'S', {}, 'ls1');
  const b = join(r, 'B', 'T', {}, 'm17');
  a.x = 5; a.z = 12; b.x = 25; b.z = 12;          // 20u apart down the clear lane
  input(r, 'A', 0);
  r.state.phase = 'live'; r.fireT.set('A', -1);
  r.tryFire('A', a, r.inputs.get('A'));
  r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  check('the shot does not resolve on the tick it is fired', b.hp === 100);
  let ticks = 0;
  while(b.hp === 100 && ticks < 90){ r.stepBullets(1/30); ticks++; }
  const flight = ticks / 30;
  const expect = 20 / (1150/9);   // LS-1: bspd 1150, fired at bspd/9
  console.log('\nTRAVEL      20u took ' + flight.toFixed(3) + 's (' + (1150/9).toFixed(0)
    + ' u/s predicts ' + expect.toFixed(3) + 's)');
  check('flight time matches bullet speed', Math.abs(flight - expect) < 0.05, flight.toFixed(3) + 's');
}

// ---------- 12. wall height decides what a round survives ----------
{
  // dustrelay: B(12,10,7,7,2.4) is a 2.4u crate spanning x12-19. A flat round dies
  // in it; one angled up passes over. (No gravity, so an arced shot then sails over
  // the target too — clearing the cover is the thing under test.)
  const reach = pitch => {
    const r = new Captured(); r.onCreate({ map:'dustrelay' });
    const a = join(r, 'A', 'S', {}, 'm17');
    join(r, 'B', 'T', {}, 'm17').x = 999;
    a.x = 8; a.z = 13.5;
    r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch, ads:0, fire:true });
    r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
    r.state.phase = 'live'; r.fireT.set('A', -1);
    r.tryFire('A', a, r.inputs.get('A'));
    let far = a.x;
    for(let i = 0; i < 90 && r.bullets.length; i++){
      r.stepBullets(1/30);
      if(r.bullets[0]) far = Math.max(far, r.bullets[0].x);
    }
    return far;
  };
  const flat = reach(0), arced = reach(0.35);
  console.log('\nCOVER       2.4u crate spans x12-19. Flat round died at x=' + flat.toFixed(1)
    + ', arced round reached x=' + arced.toFixed(1));
  check('a flat round dies in the crate', flat < 19, 'x=' + flat.toFixed(1));
  check('an arced round clears it', arced > 25, 'x=' + arced.toFixed(1));
}

// ---------- 13. pitch is not inverted ----------
{
  const r = mkRoom();
  const a = join(r, 'A', 'S', {}, 'm17');
  const b = join(r, 'B', 'T', {}, 'm17');
  a.x = 5; a.z = 12; b.x = 15; b.z = 12;
  r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch:0.6, ads:0, fire:true });   // aiming well UP
  r.state.phase = 'live'; r.fireT.set('A', -1);
  r.tryFire('A', a, r.inputs.get('A'));
  const up = r.bullets.length ? r.bullets[0].vy : 0;
  console.log('\nPITCH       aiming up (+0.6) gives vy ' + up.toFixed(1));
  check('looking up sends the round up, not into the floor', up > 0, 'vy=' + up.toFixed(2));
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);

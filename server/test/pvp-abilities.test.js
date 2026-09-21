/* Smoke-run every ability through tryFire + a few ticks, so none of them throw
   and each one leaves the mark it is supposed to leave. */
const path = require('path'), Module = require('module');
const SRV = path.join(__dirname, '..');
let Captured = null;
class FakeRoom {
  constructor(){ this.clients = []; this._t = []; }
  setState(s){ this.state = s; } onMessage(){} setSimulationInterval(){}
  broadcast(type, msg){ (this.bcast || (this.bcast = [])).push({type, msg}); }
  get clock(){ return { setTimeout: (fn, ms) => this._t.push({fn, ms}) }; }
}
const stubs = {
  '@colyseus/core': { Room: FakeRoom, Server: class { define(n,k){ Captured = k; return { filterBy(){ return this; } }; } } },
  '@colyseus/ws-transport': { WebSocketTransport: class { constructor(){ this.wss = { on(){} }; } } },
};
const orig = Module._load;
Module._load = function(req){ if(stubs[req]) return stubs[req];
  if(req === './supabase-admin.js') return { ENABLED:false, verifyUser:async()=>null, playerIdForUid:async()=>null, grantMatchRewards:async()=>({}) };
  return orig.apply(this, arguments); };
process.env.PORT = '0';
require(path.join(SRV, 'index.js'));
Module._load = orig;

let CS = 0, fails = 0;
function scenario(ability, wid, extra){
  const r = new Captured(); r.onCreate({ map:'foundry' });
  const eq = { barrel: { slot:'barrel', weapon:wid, name:'Test Barrel', rarity:'legendary', ability, mods:{} } };
  const mk = (sid, e, w) => { const c = { sessionId:sid, send(){} }; r.clients.push(c);
    r.onJoin(c, { name:'OP' + (++CS), wid:w, equipped:e }); return r.state.players.get(sid); };
  const a = mk('A', eq, wid), b = mk('B', {}, 'm17'), c = mk('C', {}, 'm17');
  a.x = 10; a.z = 10; b.x = 14; b.z = 10; c.x = 15.5; c.z = 10;   // c sits inside splash range of b
  r.state.phase = 'live';
  r.inputs.set('A', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:true });
  r.inputs.set('B', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:!!(extra && extra.bFiring) });
  r.inputs.set('C', { mx:0, mz:0, yaw:0, pitch:0, ads:0, fire:false });
  r.fireT.set('A', -1);
  const ld = r.loadouts.get('A');
  return { r, a, b, c, ld, abilities: ld.abilities.slice().sort() };
}
function settle(r){ const dt=1/30; for(let i=0;i<80 && r.bullets.length;i++) r.stepBullets(dt); }
function shoot(sc){ sc.r.fireT.set('A',-1); sc.r.tryFire('A', sc.a, sc.r.inputs.get('A')); settle(sc.r); }
function check(label, ok, detail){
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  if(!ok) fails++;
}

const ABIL = ['incendiary','cryo','vampiric','deadeye','explosive','pierce','homing','ricochet'];
console.log('per-ability smoke run (no throws, ability actually reaches the loadout):');
for(const ab of ABIL){
  const s = scenario(ab, 'm17');
  let threw = null;
  try { shoot(s); for(let i=0;i<10;i++) s.r.tick(); }
  catch(e){ threw = e.message; }
  check(ab.padEnd(11) + ' resolves', !threw && s.abilities.indexOf(ab) >= 0,
        (threw || 'abilities=' + JSON.stringify(s.abilities)));
}

console.log('\nspecific effects:');
{ const s = scenario('explosive', 'm17');
  shoot(s);
  const C2 = require('../loadout-core.js');
  // HE Payload is a FRACTION of the hit now, not a flat 10, so a 13-damage M17
  // round splashes 7.8 and an LS-1 round splashes 44. Assert the ratio, not a number.
  const want = 100 - C2.splashDamage(13);
  check('explosive splashes a bystander for a share of the hit',
        Math.abs(s.c.hp - want) < 0.5,
        'bystander hp=' + s.c.hp.toFixed(1) + ', expected ' + want.toFixed(1));
  check('the direct hit still takes more than the splash', (100 - s.b.hp) > (100 - s.c.hp)); }
{ const s = scenario('deadeye', 'm17');   // no firing_resist on the target
  let plain = 0; for(let i = 0; i < 400; i++){ const x = scenario(null, 'm17');
    shoot(x); plain += 100 - x.b.hp; }
  let resist = 0; for(let i = 0; i < 400; i++){ const x = scenario(null, 'm17', {bFiring:true});
    x.b.hp = 100;
    // give B the jugg effect by hand: it is a SET bonus, not a part ability
    x.r.loadouts.get('B').abilities.push('firing_resist');
    shoot(x); resist += 100 - x.b.hp; }
  console.log('    plain ' + (plain/400).toFixed(2) + ' vs vs-a-firing-juggernaut ' + (resist/400).toFixed(2));
  check('firing_resist cuts incoming damage 30% while the target shoots',
        Math.abs((resist/400) / (plain/400) - 0.7) < 0.02, (resist/plain).toFixed(3)); }
{ const s = scenario(null, 'm17');
  s.r.loadouts.get('A').abilities.push('killshield');
  s.b.hp = 5; shoot(s);
  check('killshield grants a shield on the kill', s.b.dead && s.a.shield === 25, 'shield=' + s.a.shield); }
{ const s = scenario(null, 'm17');
  s.r.loadouts.get('A').abilities.push('fire_nova');
  s.b.hp = 5; shoot(s);
  check('fire_nova ignites bystanders around the corpse', s.b.dead && s.c.burnT > 0, 'c.burnT=' + s.c.burnT); }
{ const s = scenario('deadeye', 'm17');
  s.r.loadouts.get('A').abilities.push('critheal');
  s.a.hp = 50;
  let healed = false;
  for(let i = 0; i < 200 && !healed; i++){ const x = scenario('deadeye', 'm17');
    x.r.loadouts.get('A').abilities.push('critheal'); x.a.hp = 50;
    shoot(x);
    if(x.a.hp >= 56) healed = true; }
  check('critheal tops the shooter up on a crit', healed); }
/* Hornet Swarm must forgive a near miss, not do the aiming. Measured against
   the real server: sweep the target sideways and find the largest offset that
   still lands, with the set and without it. Seven times the plain tolerance is
   what this set used to be - you could aim most of the way past someone. */
{
  const HIT = 0.75, N = 40;
  const maxOffset = ability => {
    let best = 0;
    for(let off = 0; off <= 4.0; off += 0.1){
      let hits = 0;
      for(let i = 0; i < N; i++){
        const x = scenario(ability, 'm17');
        x.b.x = 20; x.b.z = 10 + off;        // 10u downrange, offset sideways
        x.c.x = 99;                          // bystander well out of the way
        shoot(x);
        if(x.b.hp < 100) hits++;
      }
      if(hits / N >= HIT) best = off; else break;
    }
    return best;
  };
  const withSet = maxOffset('homing'), plain = maxOffset(null);
  const ratio = plain > 0 ? withSet / plain : Infinity;
  console.log('    max sideways offset still hitting (target 10u away): set ' +
              withSet.toFixed(1) + 'u, plain ' + plain.toFixed(1) + 'u  ->  ' + ratio.toFixed(2) + 'x');
  check('the Swarm forgives what a plain round misses', withSet > plain,
        withSet.toFixed(1) + 'u vs ' + plain.toFixed(1) + 'u');
  // Bound, not a target: 0.1u steps at 10u resolve to ~0.6 degrees, so the
  // ratio carries a step of slack either way. It was SEVEN times before.
  check('but it does NOT aim for you (under 3x the plain tolerance)', ratio < 3.0,
        ratio.toFixed(2) + 'x');
  const C3 = require('../loadout-core.js');
  check('homing constants are shared, not hardcoded',
        C3.HOMING && C3.HOMING.seek > 0 && C3.HOMING.cone > 0 && C3.HOMING.turn > 0,
        JSON.stringify(C3.HOMING));
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);

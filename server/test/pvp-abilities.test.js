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

/* The shield must never fully absorb a hit. Full absorption is what made
   Bulwark unbounded: gain 25 per kill, spend <=25 per fight, take zero hp
   damage forever. A shielded player losing no hp at all is the bug. */
{
  const x = scenario('killshield', 'm17');
  x.a.shield = 50; x.a.hp = 100;
  const before = x.a.hp;
  x.r.damage(x.a, 20);
  const hpLost = before - x.a.hp, shieldUsed = 50 - x.a.shield;
  const C4 = require('../loadout-core.js');
  check('a shield soaks only part of a hit', hpLost > 0,
        '20 damage -> ' + hpLost.toFixed(1) + ' hp, ' + shieldUsed.toFixed(1) + ' shield');
  check('it soaks exactly SHIELD_SOAK of it',
        Math.abs(shieldUsed - 20*C4.SHIELD_SOAK) < 1e-9 &&
        Math.abs(hpLost - 20*(1-C4.SHIELD_SOAK)) < 1e-9,
        'soak=' + C4.SHIELD_SOAK);
  // and the economy is bounded: a full shield cannot outlast repeated hits
  const y = scenario('killshield', 'm17');
  y.a.shield = 50; y.a.hp = 100;
  let n = 0;
  while(y.a.hp > 0 && n < 500){ y.r.damage(y.a, 20); n++; }
  check('a full shield cannot make you immortal', n < 500, 'died after ' + n + ' hits of 20');
}
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
/* Hornet Swarm, measured the way it is actually used: against a target that is
   STRAFING, with the shot only partly led. The first version of this test fired
   at a stationary target, which is not what homing is for - it passed while the
   set was still turning a 58% hit rate into a 99% one at point blank. Aim at a
   moving target, lead it badly on purpose, and count what lands. */
{
  // 8u at 30% lead is the point that discriminates: closer and everything hits
  // regardless, further and nothing does. N is high because this is a coin-flip
  // measurement against the live server, which cannot be seeded from here.
  // 8u at 20% lead is where this discriminates: the set's whole value is
  // rescuing a badly led shot inside its seek radius.
  const SPD = 6, DIST = 8, LEAD = 0.2, N = 300;
  const rate = ability => {
    let hits = 0;
    for(let i = 0; i < N; i++){
      const x = scenario(ability, 'havoc9');
      // Alternate the shot counter so half the trials are seeker rounds and
      // half are not - that IS the set, and testing only the seekers would
      // measure a weapon nobody fires.
      x.r.shotN.set('A', i % 2);
      x.b.x = 10 + DIST; x.b.z = 10; x.c.x = 99;
      const dir = i % 2 ? 1 : -1;
      const speed = x.ld.bspd / 9;
      const aimZ = dir * SPD * (DIST / speed) * LEAD;     // partial lead
      x.r.inputs.set('A', { mx:0, mz:0, yaw:Math.atan2(aimZ, DIST), pitch:0, ads:0, fire:true });
      x.r.fireT.set('A', -1);
      x.r.tryFire('A', x.a, x.r.inputs.get('A'));
      const dt = 1/30;
      for(let k = 0; k < 60 && x.r.bullets.length; k++){
        x.b.z += dir * SPD * dt;          // the target keeps strafing mid-flight
        x.r.stepBullets(dt);
      }
      if(x.b.hp < 100) hits++;
    }
    return hits / N;
  };
  /* Seeded, with common random numbers: both arms face identical spread and
     crit draws, so the difference between them is the SET and not luck.
     Unseeded this measured a 4 to 17 point gap run to run and the assertion
     passed or failed at random. */
  const realRandom = Math.random;
  let _h = 0;
  const seedRng = () => {
    _h = 0x9E3779B9;
    Math.random = () => {
      _h = (_h + 0x6D2B79F5) | 0;
      let t = Math.imul(_h ^ (_h >>> 15), 1 | _h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  seedRng(); const withSet = rate('homing');
  seedRng(); const plain   = rate(null);
  Math.random = realRandom;
  console.log('    strafing target at ' + DIST + 'u, ' + (LEAD*100) + '% lead:  set ' +
              (withSet*100).toFixed(0) + '%, plain ' + (plain*100).toFixed(0) + '%');
  check('the Swarm rescues a badly led shot', withSet > plain + 0.08,
        (withSet*100).toFixed(0) + '% vs ' + (plain*100).toFixed(0) + '%');
  // It used to read 100% here. A set that cannot miss is not a set.
  check('but it is not a guaranteed hit', withSet < 0.92, (withSet*100).toFixed(0) + '%');
  const C3 = require('../loadout-core.js');
  check('homing constants are shared, not hardcoded',
        C3.HOMING && C3.HOMING.seek > 0 && C3.HOMING.turn > 0 && C3.HOMING.vert === 0,
        JSON.stringify(C3.HOMING));
  /* The cadence is the mechanic: one seeker in `every`, the rest dead straight.
     If this silently became every-round again it would be the 1.4.27 aimbot
     back, and the hit-rate check above would still pass. */
  {
    const y = scenario('homing', 'havoc9');
    y.r.shotN.set('A', 0);
    let seekers = 0;
    for(let k = 0; k < 6; k++){
      y.r.bullets.length = 0;
      y.r.fireT.set('A', -1);
      y.r.tryFire('A', y.a, y.r.inputs.get('A'));
      if(y.r.bullets.some(b => b.homing)) seekers++;
    }
    check('one round in ' + C3.HOMING.every + ' is a seeker, the rest fly straight',
          seekers === 6 / C3.HOMING.every, seekers + ' of 6');
    const z = scenario(null, 'havoc9');
    z.r.shotN.set('A', 0);
    let any = 0;
    for(let k = 0; k < 6; k++){
      z.r.bullets.length = 0; z.r.fireT.set('A', -1);
      z.r.tryFire('A', z.a, z.r.inputs.get('A'));
      if(z.r.bullets.some(b => b.homing)) any++;
    }
    check('no set means no seekers at all', any === 0, any + ' of 6');
  }
}

/* AP Rounds now punch through thin cover, not through people. Piercing an
   enemy measured at 2.8% of shots in a full FFA; thin cover is 8-12% of every
   shot on these maps, and every long barrier here is exactly 1.5u deep. */
{
  const C5 = require('../loadout-core.js');
  const wall = (x, w) => [{ x, z: 6, w, d: 8, h: 3.2 }];
  const shoot = (ability, thickness) => {
    const x = scenario(ability, 'm17');
    x.r.walls = wall(13, thickness);          // between shooter (x10) and target (x14)
    x.b.x = 18; x.b.z = 10; x.c.x = 99;
    shoot_(x);
    return { hp: x.b.hp, hit: x.b.hp < 100 };
  };
  const shoot_ = sc => { sc.r.fireT.set('A', -1);
    sc.r.tryFire('A', sc.a, sc.r.inputs.get('A')); settle(sc.r); };
  check('a plain round dies in 1u of cover', !shoot(null, 1.0).hit);
  const thin = shoot('pierce', 1.0);
  check('an AP round comes through 1u of cover', thin.hit, 'target hp=' + thin.hp.toFixed(1));
  check('but lands at ' + (C5.AP_WALL.dmgMul*100) + '% damage',
        Math.abs((100 - thin.hp) - 13 * C5.AP_WALL.dmgMul) < 0.6,
        'took ' + (100 - thin.hp).toFixed(1) + ', a clean hit is 13');
  /* 1.5u is the depth of every long barrier on these maps, and the budget has
     to EXCEED it - a budget equal to the wall is consumed to exactly zero at
     the far face and the round dies inside. Shipped at 1.5 once; it pierced
     nothing but corner-clips. */
  const barrier = shoot('pierce', 1.5);
  check('an AP round crosses a real 1.5u barrier', barrier.hit,
        'budget ' + C5.AP_WALL.budget + 'u vs a 1.5u wall');
  check('a 4u pillar still stops an AP round', !shoot('pierce', 4.0).hit,
        'budget is ' + C5.AP_WALL.budget + 'u');
  /* A seeker must not also pierce. The homing target scan has NO line of sight
     check, so a round that both seeks and pierces would curve onto someone
     behind a wall and then punch through it. */
  {
    const y = scenario('pierce', 'havoc9');
    y.r.loadouts.get('A').abilities.push('homing');
    y.r.shotN.set('A', 0);
    const budgets = [];
    for(let k = 0; k < 4; k++){
      y.r.bullets.length = 0; y.r.fireT.set('A', -1);
      y.r.tryFire('A', y.a, y.r.inputs.get('A'));
      const b = y.r.bullets[0];
      budgets.push({ seeker: !!b.homing, wall: b.wall });
    }
    check('a seeker round carries no wall budget',
          budgets.filter(b => b.seeker).every(b => b.wall === 0),
          budgets.map(b => (b.seeker?'seek':'pierce')+':'+b.wall).join(' '));
    check('a piercing round still gets its budget',
          budgets.filter(b => !b.seeker).every(b => b.wall === C5.AP_WALL.budget),
          String(C5.AP_WALL.budget));
  }
}

/* Ghost Protocol: the LS-1's legendary set was pierce-everything, multiplying
   that same 2.8%. It now overcharges the round instead, because travel time is
   what actually makes sniping hard. */
{
  const C5 = require('../loadout-core.js');
  const ghost = { barrel:{slot:'barrel',weapon:'ls1',rarity:'legendary',name:'Ghost Bore',mods:{},ability:null,set:'ghost'},
                  optic: {slot:'optic', weapon:'ls1',rarity:'legendary',name:'Ghost Lens',mods:{},ability:null,set:'ghost'} };
  const bare = C5.computeStats('ls1', {}), set = C5.computeStats('ls1', ghost);
  check('the set activates', set.abilities.indexOf('pierce_all') >= 0, set.abilities.join(','));
  check('and overcharges the round to x' + C5.OVERCHARGE,
        Math.abs(set.bspd - bare.bspd * C5.OVERCHARGE) < 1e-9,
        bare.bspd + ' -> ' + set.bspd);
  check('no set, no overcharge', bare.bspd === C5.weaponById('ls1').bspd, String(bare.bspd));
  /* It has to be big enough to FEEL like something. At x1.75 it was reported as
     unnoticeable, and the build model could not see the difference either -
     identical kills/life at x1.75, x2.2, x2.6 and x3.0, because that model
     shoots stationary targets and travel time only matters against moving ones.
     A 45u shot must land inside ~150ms or it reads as an ordinary bullet. */
  const flight45 = 45 / (set.bspd/9) * 1000;
  check('a 45u shot arrives in under 150ms', flight45 < 150, flight45.toFixed(0) + 'ms');
  // it must not leak onto every weapon
  const v = C5.computeStats('vkraptor', {});
  check('other weapons are untouched', v.bspd === C5.weaponById('vkraptor').bspd, String(v.bspd));
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);

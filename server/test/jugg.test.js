/* UNSTOPPABLE is a flat, unconditional 30%.
   It used to be gated on the target FIRING, and that gate went through three states
   worth remembering, because each was a real measurement:
     - raw fire input at the instant of the hit. The client sends fire:false for the
       whole reload, so the Goliath's 2.6s reload - the longest in the game - switched
       a four-piece legendary set off at the moment the player was most exposed.
     - trigger + 450ms tail + a server-derived reload. Correct, but invisible: 450ms is
       under perception and an 80-round magazine means the reload case almost never
       comes up, so the set read as arbitrary.
     - flat. 62.3% and 4th of 12, which is the configuration the ladder measured
       DIRECTLY rather than extrapolating - the uptime sweep's 100% row is this.
   These pin it flat. If a condition ever creeps back, this suite says so. */
const path = require('path'), Module = require('module');
const CORE = require('../loadout-core.js');   // the figure, read not restated
const SRV = path.join(__dirname, '..');
let Captured = null;
class FakeRoom {
  constructor(){ this.clients = []; this._t = []; }
  setState(s){ this.state = s; } onMessage(){} setSimulationInterval(){}
  broadcast(){} get clock(){ return { setTimeout: (fn, ms) => this._t.push({fn, ms}) }; }
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
const LC = require(path.join(SRV, 'loadout-core.js'));
const fs = require('fs');

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

const srv  = fs.readFileSync(path.join(SRV, 'index.js'), 'utf8');
const html = fs.readFileSync(path.join(SRV, '..', 'renderer', 'index.html'), 'utf8');

/* 1. the server applies it with no second term */
ok('server applies the resist unconditionally',
   /firing_resist'\) >= 0\) dmg \*= 1 - LoadoutCore\.JUGG_RESIST;/.test(srv));
ok('neither path still hardcodes the reduction',
   !/dmg \*= 0\.7/.test(srv) && !/dmg \*= 0\.7/.test(html));
ok('no firing gate is left on the server',
   !/firingResistOn/.test(srv) && !/tInp && tInp\.fire/.test(srv));

/* 2. and the state that only existed to feed that gate is gone, not orphaned */
for(const dead of ['lastShotAt', 'magLeft', 'reloadUntil'])
  ok('server no longer carries ' + dead, !new RegExp(dead).test(srv));
ok('RESIST_TAIL is retired from loadout-core', LC.RESIST_TAIL === undefined);
ok('and nothing still reads it', !/RESIST_TAIL/.test(srv) && !/RESIST_TAIL/.test(html));

/* 3. offline agrees, through the one predicate all three consumers share */
ok('offline predicate is equipment-only',
   /function firingResistOn\(e\)\{\s*\n\s*return !!\(e && e\.wep/.test(html));
ok('it does not look at lastFire or reloading',
   !/firingResistOn[\s\S]{0,300}lastFire/.test(html));
ok('the resist multiplier is still applied in exactly one place',
   (html.match(/firingResistOn\(t\)\) dmg \*= 1 - LoadoutCore\.JUGG_RESIST/g) || []).length === 1);
ok('firingResistOn is still defined once',
   (html.match(/function firingResistOn/g) || []).length === 1);

/* 4. the card matches. It said "while firing" through two behaviour changes. */
{
  const m = html.match(/bonus:'([^']*UNSTOPPABLE[^']*)'/);
  ok('the set card exists', !!m);
  if(m){
    const copy = m[1].toLowerCase();
    // The card COMPUTES its number from the constant, so the source string stops at
    // "take ". Assert it is derived rather than asserting a digit - a hardcoded 30
    // that silently disagrees with JUGG_RESIST is the exact failure worth catching.
    ok('the card derives its number from the shipped constant',
       /take '\+Math\.round\(LoadoutCore\.JUGG_RESIST\*100\)\+'% less damage/.test(html));
    ok('the card does not hardcode a percentage', !/take \d+% less damage/.test(html));
    ok('the card no longer says "while firing"', !/while firing/.test(copy));
    ok('nor promises anything about reloads or bursts', !/reload/.test(copy) && !/burst/.test(copy));
  }
}

/* 5. the damage actually lands at 0.7x, end to end through applyHit */
{
  const r = new Captured(); r.onCreate({ map:'foundry' });
  r.state.phase = 'live';
  let CS = 0;
  const mk = (wid, eq) => { const c = { sessionId:'s'+(++CS), send(){} }; r.clients.push(c);
    r.onJoin(c, { name:'P'+CS, wid, equipped: eq || {} }); return c.sessionId; };
  const jugg = {};
  for(const [slot, name] of Object.entries(LC.SETS.find(s => s.id === 'jugg').pieces))
    jugg[slot] = { slot, weapon:'goliath', name, rarity:'legendary', set:'jugg', mods:{} };
  const shooter = mk('vkraptor');
  const braced  = mk('goliath', jugg);
  const plain   = mk('goliath');
  const ld = r.loadouts.get(shooter);
  ok('the set resolves to firing_resist',
     (r.loadouts.get(braced).abilities || []).indexOf('firing_resist') >= 0);

  const hpAfter = tid => {
    const t = r.state.players.get(tid);
    t.hp = 100; t.shield = 0;
    r.inputs.set(tid, { fire:false });          // explicitly NOT firing
    r.applyHit(shooter, r.state.players.get(shooter), t, tid, ld, { crit:false });
    return t.hp;
  };
  const lossBraced = 100 - hpAfter(braced);
  const lossPlain  = 100 - hpAfter(plain);
  // read the figure from the constant; it moved once (0.30 -> 0.25) and two tests
  // restated it as a literal rather than asking
  ok('a target that is not firing still takes ' + Math.round(CORE.JUGG_RESIST*100) + '% less (' +
     lossBraced.toFixed(2) + ' vs ' + lossPlain.toFixed(2) + ')',
     Math.abs(lossBraced - lossPlain * (1 - CORE.JUGG_RESIST)) < 0.01);
}

console.log(fails ? '\n  jugg.test.js: ' + fails + ' FAILED' : '  jugg.test.js: all passed');
process.exit(fails ? 1 : 0);

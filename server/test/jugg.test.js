/* Juggernaut's -30% is only worth anything if it is ON. Its whole ladder position
   turns on trigger uptime: 4th of 12 at full uptime, 8th at 60% - below its own
   freebuild. These pin the window so that can't silently drift back.
   The bug this replaces: the resist read the raw fire input at the instant of the
   hit, and the client sends fire:false for the entire reload, so the Goliath's 2.6s
   reload - the longest in the game - turned a four-piece legendary set off at the
   exact moment the player was most exposed. */
const path = require('path'), Module = require('module');
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

let fails = 0, CS = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

function room(){
  const r = new Captured(); r.onCreate({ map:'foundry' });
  r.state.phase = 'live';
  const mk = wid => { const c = { sessionId:'s'+(++CS), send(){} }; r.clients.push(c);
    r.onJoin(c, { name:'P'+CS, wid, equipped:{} }); return c.sessionId; };
  return { r, mk };
}

/* 1. the window is shared, not two hardcoded numbers */
ok('RESIST_TAIL is exported from loadout-core', typeof LC.RESIST_TAIL === 'number' && LC.RESIST_TAIL > 0);
{
  const html = require('fs').readFileSync(path.join(SRV, '..', 'renderer', 'index.html'), 'utf8');
  // the condition spans more than one line, so take the whole statement, not one line
  const L = html.split('\n');
  const i = L.findIndex(l => l.includes("has('firing_resist')"));
  const stmt = i < 0 ? '' : L.slice(i, i + 3).join(' ');
  ok('offline path reads RESIST_TAIL rather than a literal',
     !!stmt && stmt.includes('RESIST_TAIL') && !/0\.45\b/.test(stmt));
  ok('offline path also covers the reload', /reloading/.test(stmt));
}

/* 2. trigger down -> on, regardless of anything else */
{
  const { r, mk } = room(); const id = mk('goliath');
  r.inputs.set(id, { fire:true });
  ok('trigger held counts as firing', r.firingResistOn(id) === true);
}

/* 3. trigger released -> still on inside the tail, off after it */
{
  const { r, mk } = room(); const id = mk('goliath');
  r.inputs.set(id, { fire:false });
  r.lastShotAt.set(id, Date.now() - (LC.RESIST_TAIL - 50));
  ok('still firing inside the tail', r.firingResistOn(id) === true);
  r.lastShotAt.set(id, Date.now() - (LC.RESIST_TAIL + 50));
  ok('not firing once the tail lapses', r.firingResistOn(id) === false);
}

/* 4. the reload the server derives for itself covers the whole reload,
      which is much longer than the tail on the one weapon that has this set */
{
  const { r, mk } = room(); const id = mk('goliath');
  const ld = LC.computeStats('goliath', {});
  ok('the Goliath reload outlasts the tail by a lot', ld.reload > LC.RESIST_TAIL * 3);
  r.inputs.set(id, { fire:false });
  r.lastShotAt.set(id, Date.now() - (LC.RESIST_TAIL + 50));   // tail already lapsed
  r.reloadUntil.set(id, Date.now() + 1000);
  ok('reloading still counts as firing', r.firingResistOn(id) === true);
  r.reloadUntil.set(id, Date.now() - 1);
  ok('and stops when the reload finishes', r.firingResistOn(id) === false);
}

/* 5. emptying the magazine is what arms that window, derived from server state alone */
{
  const { r, mk } = room(); const id = mk('goliath');
  const ld = r.loadouts.get(id);
  const p = r.state.players.get(id);
  const inp = { fire:true, yaw:0, pitch:0, ads:0 };
  for(let i = 0; i < ld.mag; i++){ r.fireT.set(id, 0); r.tryFire(id, p, inp); }
  ok('a full magazine of shots arms the reload window',
     (r.reloadUntil.get(id) || 0) > Date.now() + ld.reload - 200);
  ok('and the magazine counter wraps rather than going negative', r.magLeft.get(id) === ld.mag);
}

/* 6. nothing about this is forgeable: a client that never fires gets nothing */
{
  const { r, mk } = room(); const id = mk('goliath');
  r.inputs.set(id, { fire:false, reloading:true });   // a field the server must ignore
  ok('a client claiming to reload without firing gets no resist', r.firingResistOn(id) === false);
}

/* 7. per-player state is cleaned up, the way burnSpread had to be */
{
  const { r, mk } = room(); const id = mk('goliath');
  r.lastShotAt.set(id, Date.now()); r.magLeft.set(id, 3); r.reloadUntil.set(id, Date.now()+1);
  r.onLeave(r.clients.find(c => c.sessionId === id), true);
  ok('leaving clears the uptime state',
     !r.lastShotAt.has(id) && !r.magLeft.has(id) && !r.reloadUntil.has(id));
}

/* 8. the card has to describe the behaviour the code actually has. The old copy said
      "while firing" full stop, which was true of the version this replaced and is now
      an understatement - the set reads as weaker than it is, which is the same problem
      in a different place. */
{
  const html = require('fs').readFileSync(path.join(SRV, '..', 'renderer', 'index.html'), 'utf8');
  const m = html.match(/bonus:'([^']*UNSTOPPABLE[^']*)'/);
  ok('the set card exists', !!m);
  if(m){
    const copy = m[1].toLowerCase();
    ok('the card still states the 30%', /30% less damage/.test(copy));
    ok('the card mentions reloading, because the code covers it', /reload/.test(copy));
    ok('the card mentions the gap between bursts', /burst/.test(copy));
  }
}

console.log(fails ? '\n  jugg.test.js: ' + fails + ' FAILED' : '  jugg.test.js: all passed');
process.exit(fails ? 1 : 0);

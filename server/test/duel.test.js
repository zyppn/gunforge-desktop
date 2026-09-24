/* Weapon viability, as a tripwire.
 *
 * Every balance argument in this repo's history has been settled by a duel model that
 * lived in a scratchpad - which meant the numbers in the commit messages could not be
 * reproduced by anyone, including the next session. The model is now in server/test/duel/.
 * ladder.js runs the full thing; this runs a cut-down version on every ship.
 *
 * These bounds are a TRIPWIRE, NOT A TARGET. They are set wide on purpose: their job is
 * to catch a weapon becoming hopeless or becoming the answer, not to pin today's
 * numbers. Tuning a weapon and then tightening these to match would turn a safety net
 * into a ratchet.
 *
 * What the model cannot see: both sides open fire at t=0 at a fixed range and neither
 * can disengage, so a shotgun never closes and a sniper never opens unseen. The Warden
 * and the LS-1 are floors here, not measurements, and the floor below is set with that
 * in mind rather than as a claim that they are fine.
 *
 *   node server/test/duel.test.js
 */
const path = require('path');
const { runLadder } = require('./ladder.js');
const { C } = require('./duel/builds.js');
const core = require('../loadout-core.js');

let fails = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  if(!cond) fails++;
};

/* ---- 1. it is measuring the SHIPPED weapons ----
   A duel model quietly reading a stale copy of the weapon table would keep reporting
   yesterday's balance with total confidence. */
ok('the model reads the same loadout-core the server does', C === core);
for(const w of core.WEAPONS){
  const m = C.weaponById(w.id);
  ok('  ' + w.id + ' is the shipped row', m.dmg === w.dmg && m.rof === w.rof
     && m.spread === w.spread && m.bspd === w.bspd);
}

/* ---- 2. it is deterministic ----
   A flaky gate is worse than no gate: it trains you to re-run until it passes.

   Measured, so the claim is the true one: across FRESH PROCESSES the ladder is exact
   to six decimal places, which is how ladder.js is actually used. Within one process
   the first run differs from later ones by up to 0.4pt, because it is the run that
   fits and caches the stat templates; every run after it is stable. I traced that to
   the cache and did not chase the last fraction of a point - it is an order of
   magnitude inside the bounds below, and the CLI never sees it. So this checks the
   property that holds: repeat runs, once warm, are identical. */
const sig = L => [...L.entries()].map(([w, v]) => w + ':' + v.best.toFixed(6)).join('|');
{
  const TINY = { kit: 1, n: 3, ranges: [16], qs: [0.7] };
  runLadder(TINY);                                   // warm the template cache
  ok('repeat runs of the same ladder agree exactly',
     sig(runLadder(TINY)) === sig(runLadder(TINY)));
}
const CFG = { kit: 1, n: 30, ranges: [6, 16, 30], qs: [0.6, 0.85] };
const A = runLadder(CFG);

/* ---- 3. the ladder itself ---- */
const rows = [...A.entries()].sort((a, b) => b[1].best - a[1].best);
console.log('\n  ' + A.builds + ' builds, ' + A.duelsPerPairing + ' duels per pairing');
for(const [wid, v] of rows)
  console.log('    ' + C.weaponById(wid).name.padEnd(16)
    + (v.best*100).toFixed(1).padStart(6) + '%   best kit: ' + v.bestKit);

const vals = rows.map(r => r[1].best);
const lo = Math.min(...vals), hi = Math.max(...vals);

/* 35%: the M17 sat at 38% on the full ladder before the specialists were brought up,
   and that was a gun a new account owns and cannot win with. Below this and somebody's
   only weapon is a handicap. */
const worst = rows[rows.length-1];
ok('no weapon is hopeless (best kit >= 35%)', lo >= 0.35,
   C.weaponById(worst[0]).name + ' ' + (lo*100).toFixed(1) + '%');
/* 72%: the VK Raptor and the Havoc-9 were both at ~70% and interchangeable. One gun
   clearly above the rest is the state where the choice stops being a choice. */
const top = rows[0];
ok('no weapon is the answer (best kit <= 72%)', hi <= 0.72,
   C.weaponById(top[0]).name + ' ' + (hi*100).toFixed(1) + '%');
ok('the field is not pulling apart (spread <= 35pt)', (hi - lo) <= 0.35,
   ((hi-lo)*100).toFixed(0) + 'pt');

/* ---- 4. the model is not producing nonsense ----
   Bounds pass trivially if every duel is a coin flip. These are the sanity checks that
   the thing is actually simulating something. */
{
  const { build, fight } = require('./duel/builds.js');
  const rate = (X, Y, d) => {
    let w = 0;
    for(let i = 0; i < 250; i++){
      if(fight(X, Y, d, 0.8, {hp:100, sh:0})) w++;
      if(!fight(Y, X, d, 0.8, {hp:100, sh:0})) w++;
    }
    return w / 500;
  };
  /* Note what "bare" is NOT: every build in this model carries six legendary parts,
     because that is what a duel between two kitted players looks like. My first
     version of this check called an ability-less M17 "a bare pistol" and expected it
     to be crushed; it held its own at 43%, because it is not bare at all. Worth
     keeping in mind when reading the M17's ladder position too. */
  const plain  = build('plain',  'vkraptor', [], [], []);
  const kitted = build('kitted', 'vkraptor', [], ['deadeye','deadeye','deadeye'], []);
  ok('abilities beat no abilities on the same weapon',
     rate(kitted, plain, 16) > 0.55, (rate(kitted, plain, 16)*100).toFixed(0) + '%');

  /* Range identity. If these ever invert, the model has stopped describing the game
     whatever the win rates say. */
  const shot = build('shot', 'warden', [], ['deadeye'], []);
  const snip = build('snip', 'ls1',    [], ['deadeye'], []);
  ok('the shotgun owns point blank', rate(shot, snip, 3)  > 0.70,
     (rate(shot, snip, 3)*100).toFixed(0) + '%');
  ok('the sniper owns distance',     rate(shot, snip, 34) < 0.35,
     (rate(shot, snip, 34)*100).toFixed(0) + '% for the shotgun');
}

console.log('\n  NOTE  the Warden and the LS-1 are underrated here by construction:');
console.log('        neither can choose the engagement in this model. Read their');
console.log('        numbers as a floor. Full table: node server/test/ladder.js\n');

if(fails){ console.error('duel: ' + fails + ' failure(s)'); process.exit(1); }
console.log('duel: ok');

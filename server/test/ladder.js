/* The weapon ladder. Every freebuild against every other freebuild.
 *
 *   node server/test/ladder.js              the full table
 *   N=80 node server/test/ladder.js         more samples, slower
 *   KIT=2 node server/test/ladder.js        smaller ability space, much faster
 *
 * Deliberately NOT named *.test.js: ship.sh gates on that glob and a full run takes
 * minutes. duel.test.js runs a cut-down version of this on every ship; this file is
 * for when you are actually changing a weapon and want the whole picture.
 *
 * Freebuilds only - six legendary parts, no set pieces - so the number is the WEAPON,
 * not a set bonus. Both orderings of every pairing, so nobody gets a free first shot.
 *
 * What it cannot see, and why no number here is a verdict on its own: both sides open
 * fire at t=0 at a fixed range and neither can disengage. That gives a shotgun no way
 * to close and a sniper no way to open unseen, so the Warden and the LS-1 read as a
 * floor rather than a measurement. A weapon whose whole argument is choosing the
 * engagement is underrated here by construction.
 */
const { C, build, kits, fight, seedAll } = require('./duel/builds.js');

const DEFAULTS = {
  kit: +(process.env.KIT || 3),
  n: +(process.env.N || 40),
  ranges: [4, 9, 16, 25, 34],
  qs: [0.55, 0.72, 0.88],
};

function runLadder(opt){
  const o = Object.assign({}, DEFAULTS, opt || {});
  const field = [];
  for(const w of C.WEAPONS) for(const k of kits(o.kit))
    field.push(build(w.id + '|' + (k.join('+') || 'bare'), w.id, [], k, []));

  /* Reseed AFTER the field is built, not before. Both modules keep their generator in
     module state, and builds.js caches fitted stat templates per weapon - so the FIRST
     ladder in a process fits templates (drawing from the generator) and later ones hit
     the cache and draw nothing. Seeding at the top therefore still left run 2
     disagreeing with run 1. Seeding here makes the duel phase itself reproducible,
     whatever the cache was doing. */
  seedAll(o.seed || 20260924);

  const wins = new Map(), games = new Map();
  for(const b of field){ wins.set(b.tag, 0); games.set(b.tag, 0); }
  for(let i = 0; i < field.length; i++) for(let j = i + 1; j < field.length; j++){
    const A = field[i], B = field[j];
    let a = 0, n = 0;
    for(const d of o.ranges) for(const q of o.qs) for(let s = 0; s < o.n; s++){
      if(fight(A, B, d, q, {hp:100, sh:0})) a++;      // A shooting first
      if(!fight(B, A, d, q, {hp:100, sh:0})) a++;     // and B shooting first
      n += 2;
    }
    wins.set(A.tag, wins.get(A.tag) + a);       games.set(A.tag, games.get(A.tag) + n);
    wins.set(B.tag, wins.get(B.tag) + (n - a)); games.set(B.tag, games.get(B.tag) + n);
  }

  const out = new Map();
  for(const b of field){
    const r = wins.get(b.tag) / games.get(b.tag);
    const cur = out.get(b.wid) || { best: -1, bestKit: '', sum: 0, n: 0 };
    if(r > cur.best){ cur.best = r; cur.bestKit = b.tag.split('|')[1]; }
    cur.sum += r; cur.n++;
    out.set(b.wid, cur);
  }
  for(const v of out.values()) v.mean = v.sum / v.n;
  out.builds = field.length;
  out.duelsPerPairing = o.ranges.length * o.qs.length * o.n * 2;
  return out;
}
module.exports = { runLadder };

if(require.main === module){
  const t0 = Date.now();
  const L = runLadder();
  const rows = [...L.entries()].sort((a, b) => b[1].best - a[1].best);
  console.log('\nFREEBUILD LADDER   ' + L.builds + ' builds, '
    + L.duelsPerPairing + ' duels per pairing\n');
  console.log('  weapon            best kit   mean over kits   best kit is');
  for(const [wid, v] of rows)
    console.log('  ' + C.weaponById(wid).name.padEnd(17)
      + (v.best*100).toFixed(1).padStart(6) + '%'
      + (v.mean*100).toFixed(1).padStart(15) + '%'
      + '    ' + v.bestKit);
  const vals = rows.map(r => r[1].best);
  console.log('\n  spread ' + ((Math.max(...vals) - Math.min(...vals))*100).toFixed(0)
    + 'pt   (' + ((Date.now()-t0)/1000).toFixed(0) + 's)');
  console.log('\n  Reminder: the Warden and the LS-1 are floors, not measurements -');
  console.log('  this model gives neither a way to choose the engagement.\n');
}

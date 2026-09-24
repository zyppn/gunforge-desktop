/* Z-fighting, found by measurement instead of by eye.

   Two coplanar faces at the same depth make the depth buffer pick between them per
   pixel, and what you get is a stippled, flickering band along the seam. Every one of
   these has been caught the same way so far: someone looks at a render and says the
   edge looks wrong. That is a slow and unreliable instrument - the artifact only shows
   from certain angles, it survives a whole review at locker size, and by the time it is
   noticed the part has usually been rebuilt twice for unrelated reasons.

   It is also entirely mechanical to detect. Almost every mesh in this renderer is an
   axis-aligned box, so for each pair of boxes that overlap on two axes, the test checks
   whether they share an exact plane on the third. That is the condition, precisely.

   The fix is never a Z offset hack: it is to decide which of the two surfaces is meant
   to be in front and move it by a real amount - a lip that protrudes, a panel that
   recesses, a tenon that seats deeper. So the tolerance is deliberately tight. A 0.2mm
   separation is not a design decision, it is a coincidence, and it will fight anyway at
   the distances a viewmodel is seen from.

   Known-good exceptions live in ALLOW below, each with the reason it is one. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const THREE = require(path.join(ROOT, 'renderer', 'vendor', 'three.min.js'));
const LoadoutCore = require(path.join(ROOT, 'server', 'loadout-core.js'));

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

function lift(n){
  const i = html.indexOf('function ' + n + '(');
  if(i < 0) throw new Error('missing function ' + n);
  let j = html.indexOf('{', i), d = 0;
  for(; j < html.length; j++){
    if(html[j] === '{') d++;
    else if(html[j] === '}'){ d--; if(!d) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + n);
}
function liftConst(n){
  const i = html.indexOf('\nconst ' + n + ' = ');
  if(i < 0) throw new Error('missing const ' + n);
  return html.slice(i + 1, html.indexOf(';', i) + 1);
}
const COLOR_CONSTS = [...html.matchAll(/^const ([A-Z][A-Z0-9_]*) = 0x[0-9A-Fa-f]+;/gm)].map(m => m[1]);
const FNS = ['vmCyl','vmBox','vmTag','mat','shade','partMat','curvedPlate',
  'hazardFace','hazardBand','boltRow','vmFrame','vmBarrel',
  'vmMagazine','vmMagazineBody','vmForegrip','vmForegripBody','vmStock','vmStockBody',
  'fitScale','vmOptic','buildGunModel'];
const ctx = vm.createContext({ THREE, Math, console,
  WEAPONS: LoadoutCore.WEAPONS, SLOTS: LoadoutCore.SLOTS, SETS: LoadoutCore.SETS, LoadoutCore });
vm.runInContext('let VMT=null, VMT_AIM=null, VMT_ADS=null;\n'
  + ['RCOL','FIT_SPAN','HAZ'].concat(COLOR_CONSTS).map(liftConst).join('\n')
  + '\n' + FNS.map(lift).join('\n'), ctx);

/* A ratchet, not a clean sheet. Hornet, Dragon and Juggernaut were built before this
   test existed and carry a backlog; rewriting three sets the moment the test lands would
   mean changing geometry that has already been reviewed and signed off, for a defect
   nobody has reported in them. So each set records the number of distinct coplanar pairs
   it has today. Adding one fails. Removing one fails too, with the new number - lower
   the baseline in the same commit that earns it, and a set that reaches zero should be
   deleted from this table so it can never climb back.

   Bulwark is 0 and stays 0. */
const BASELINE = { saint: 0, hornet: 4, dragon: 4, bulwark: 0, ghost: 0, jugg: 5 };

const EPS = 1e-9;
const MIN_SEP = 0.0004;          // 0.4mm: below this two surfaces fight in practice
const AX = ['x','y','z'];

/* Only boxes. A curved or cylindrical surface cannot be coplanar with anything here,
   and its bounding box would produce nothing but false positives. */
function boxesOf(group){
  const out = [];
  group.updateMatrixWorld(true);
  group.traverse(o => {
    if(!o.isMesh || !o.geometry || o.geometry.type !== 'BoxGeometry') return;
    // a rotated box is not axis-aligned, so its faces cannot be compared this way
    const e = new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
    if(Math.abs(e.x) > 1e-6 || Math.abs(e.y) > 1e-6 || Math.abs(e.z) > 1e-6) return;
    const bb = new THREE.Box3().setFromObject(o);
    out.push({ bb, slot: o.userData.slot || '?' });
  });
  return out;
}

function clashes(boxes){
  const hits = [];
  for(let i = 0; i < boxes.length; i++) for(let j = i + 1; j < boxes.length; j++){
    const A = boxes[i].bb, B = boxes[j].bb;
    for(let a = 0; a < 3; a++){
      const u = AX[(a + 1) % 3], v = AX[(a + 2) % 3], w = AX[a];
      // must genuinely overlap on the other two axes, or the faces never meet
      const ovU = Math.min(A.max[u], B.max[u]) - Math.max(A.min[u], B.min[u]);
      const ovV = Math.min(A.max[v], B.max[v]) - Math.max(A.min[v], B.min[v]);
      if(ovU <= MIN_SEP || ovV <= MIN_SEP) continue;
      /* The boxes must INTERPENETRATE on this axis too. Two boxes merely butted
         face-to-face share a plane, but their normals point apart, so backface culling
         picks one and there is nothing to fight. It is two surfaces facing the SAME way
         at the same depth that flicker - which means one box has to reach into the
         other. Without this the test drowns in butt joints, and a test that cries wolf
         on every seam in the game is one nobody reads. */
      const ovW = Math.min(A.max[w], B.max[w]) - Math.max(A.min[w], B.min[w]);
      if(ovW <= MIN_SEP) continue;
      for(const f of ['min','max']){
        const d = Math.abs(A[f][w] - B[f][w]);       // same-facing pair: min/min or max/max
        if(d < MIN_SEP - EPS)
          hits.push({ slots: [boxes[i].slot, boxes[j].slot].sort().join('+'),
                      axis: w, face: f, gap: d, a: boxes[i], b: boxes[j] });
      }
    }
  }
  return hits;
}

/* Every set piece, on its own weapon, in the kit it ships as. A set's pieces are built
   to sit against each other, so they are exactly where a shared plane turns up. */
for(const set of LoadoutCore.SETS){
  const eq = {};
  for(const [slot, name] of Object.entries(set.pieces))
    eq[slot] = { weapon: set.weapon, slot, name, rarity: set.rarity, set: set.id };
  let g;
  try { g = ctx.buildGunModel(set.weapon, eq).group; }
  catch(e){ ok(set.id + ' builds', false); console.error('        ' + e.message); continue; }
  const hits = clashes(boxesOf(g));
  const seen = new Map();
  for(const h of hits) seen.set(h.slots + ' share their ' + h.face + ' ' + h.axis + ' face', h.gap);
  const base = BASELINE[set.id];
  if(base === undefined){
    ok(set.id + ' is not in BASELINE - add it (' + seen.size + ' coplanar pairs)', false);
  } else if(seen.size > base){
    ok(set.id + ' gained coplanar faces: ' + base + ' -> ' + seen.size, false);
  } else if(seen.size < base){
    ok(set.id + ' is cleaner than its baseline - set BASELINE.' + set.id + ' to ' + seen.size, false);
  } else ok(set.id + ' coplanar pairs: ' + seen.size, true);
  if(seen.size && (seen.size !== base || process.env.ZFIGHT_VERBOSE))
    for(const [k, gap] of seen) console.error('        ' + k + '  ' + (gap*1000).toFixed(2) + 'mm apart');
  if(process.env.ZFIGHT_VERBOSE) for(const h of hits){
    const d = b => '[' + AX.map(x => b.bb.min[x].toFixed(4) + '..' + b.bb.max[x].toFixed(4)).join(' ') + ']';
    console.error('          ' + h.face + ' ' + h.axis + '  A' + d(h.a) + '  B' + d(h.b));
  }
}

console.log(fails ? '\nzfight: ' + fails + ' failure(s)' : '\nzfight: all clear');
process.exit(fails ? 1 : 0);

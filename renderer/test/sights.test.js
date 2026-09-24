/* Can you actually see through the sight?

   Optics are modelled as real hollow geometry the camera looks through, so it is
   possible to ship one that looks superb in the locker and is a pinhole in the hands -
   and nothing else in the suite would notice, because the geometry is valid, the part
   renders, and the thumbnail is lovely. The first cut of the Ghost Lens did exactly
   this twice over: three rings sized 1.00 / 0.80 / 0.60 made the REAR one the aperture
   and choked the window to 3.2 degrees while the two in front of it did nothing, and a
   filled 3.5mm centre dot covered 1.2 degrees - most of a standing target at 32m.

   This measures the shipped geometry the way the player meets it: the real ADS solve
   from updateViewmodelPose (gun at -aim, eye at the origin), then raycasts.

   Real rays, not regex. A radius in the source tells you nothing without the distance
   it sits at. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const THREE = require(path.join(ROOT, 'renderer', 'vendor', 'three.min.js'));
const LoadoutCore = require(path.join(ROOT, 'server', 'loadout-core.js'));

let fails = 0;
const ok = (name, cond, note) => { if(!cond){ console.error('  FAIL  ' + name + (note ? '   [' + note + ']' : '')); fails++; } };

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
const FNS = ['vmCyl','vmBox','vmTag','mat','shade','partMat','vmFrame','vmBarrel','vmMagazine',
  'vmMagazineBody','vmForegrip','vmForegripBody','vmStock','vmStockBody','fitScale','vmOptic',
  'buildGunModel'];
const ctx = vm.createContext({ THREE, Math, console,
  WEAPONS: LoadoutCore.WEAPONS, SLOTS: LoadoutCore.SLOTS, SETS: LoadoutCore.SETS,
  LoadoutCore, equippedParts: () => ({}) });
vm.runInContext('let VMT=null, VMT_AIM=null, VMT_ADS=null;\n'
  + ['RCOL','GHOST_CYAN','FIT_SPAN'].map(liftConst).join('\n') + '\n'
  + FNS.map(lift).join('\n'), ctx);

/* A standing player is 1.8m. At 32m that is 1.61 degrees tall and 0.98 wide. */
const TGT_D = 32, TGT_H = 0.9, TGT_W = 0.28;

function sight(wid, optic, onlySlot){
  const built = ctx.buildGunModel(wid, { optic });
  const g = built.group;
  /* the aim solve, verbatim from updateViewmodelPose */
  const A = built.aim
    ? { ax:built.aim.x, ay:built.aim.y, az:built.aim.z, dist:built.ads.dist, fovDrop:built.ads.fovDrop }
    : { ax:0, ay:0.05, az:-0.28, dist:0.22, fovDrop:24 };
  g.position.set(-A.ax, -A.ay, -A.dist - A.az);
  g.updateMatrixWorld(true);
  /* reticles and glass are overlays you see THROUGH; only solid geometry blocks */
  const solids = [];
  g.traverse(o => {
    if(!o.isMesh || (o.material && o.material.transparent)) return;
    /* onlySlot isolates one component using buildGunModel's own vmTag stamps. Needed for
       the ring-alignment check: on the LS-1 the default 50cm barrel sits below the sight
       line and clips the lower field at 3.2 degrees, so measuring the whole gun was
       measuring the barrel and calling it a pinched sight. */
    if(onlySlot && o.userData.slot !== onlySlot) return;
    solids.push(o);
  });
  const rc = new THREE.Raycaster(); rc.far = 1.2;
  const O = new THREE.Vector3(), d = new THREE.Vector3();
  const blocked = ph => {
    for(let deg = 0.2; deg <= 16; deg += 0.2){
      const th = deg*Math.PI/180;
      d.set(Math.sin(th)*Math.cos(ph), Math.sin(th)*Math.sin(ph), -Math.cos(th)).normalize();
      rc.set(O, d);
      if(rc.intersectObjects(solids, false).length) return deg;
    }
    return 16;
  };
  let seen = 0, tot = 0;
  for(let ty = -TGT_H; ty <= TGT_H + 1e-6; ty += TGT_H/3)
    for(let tx = -TGT_W; tx <= TGT_W + 1e-6; tx += TGT_W/2){
      tot++; d.set(tx, ty, -TGT_D).normalize(); rc.set(O, d);
      if(!rc.intersectObjects(solids, false).length) seen++;
    }
  return { fov: 78 - A.fovDrop, up: blocked(Math.PI/2), down: blocked(-Math.PI/2),
           side: Math.min(blocked(0), blocked(Math.PI)), target: seen/tot };
}

const P = (wid, name, rarity, set) => ({ weapon:wid, slot:'optic', name, rarity, set });
/* Post-and-bead sights hide the target's lower body BY DESIGN - you hold the bead on
   what you want to hit. They are named here so that a NEW sight cannot quietly join
   them; anything not on this list has to stay fully clear. */
const POST_SIGHTS = ['(default)', 'Iron Ring'];
const OPTICS = [
  ['(default)',    null],
  ['Red Dot',      P(null,'Red Dot','legendary')],
  ['Holo Sight',   P(null,'Holo Sight','legendary')],
  ['ACOG-4',       P(null,'ACOG-4','legendary')],
  ['Iron Ring',    P(null,'Iron Ring','legendary')],
  ["Saint's Eye",  P(null,"Saint's Eye",'epic','saint')],
  ['Bulwark Ward', P(null,'Bulwark Ward','epic','bulwark')],
  ['Ghost Lens',   P(null,'Ghost Lens','legendary','ghost')],
];
const WIDS = LoadoutCore.WEAPONS.map(w => w.id);
const FLOOR = 3.5;          // no sight may be a pinhole, whatever it looks like
const POST_FLOOR = 0.55;    // even a post sight leaves most of the target showing

const R = {};
for(const wid of WIDS){
  R[wid] = {};
  for(const [name, part] of OPTICS){
    const p = part ? Object.assign({}, part, { weapon: wid }) : null;
    R[wid][name] = sight(wid, p);
  }
}

for(const wid of WIDS) for(const [name] of OPTICS){
  const r = R[wid][name], post = POST_SIGHTS.includes(name);
  ok(wid + ' / ' + name + ' is not a pinhole looking up',
     r.up >= FLOOR, 'up ' + r.up.toFixed(1) + 'deg');
  ok(wid + ' / ' + name + ' is not a pinhole looking sideways',
     r.side >= FLOOR, 'side ' + r.side.toFixed(1) + 'deg');
  if(post){
    ok(wid + ' / ' + name + ' still shows most of a target at ' + TGT_D + 'm',
       r.target >= POST_FLOOR, (r.target*100).toFixed(0) + '%');
  } else {
    ok(wid + ' / ' + name + ' shows ALL of a target at ' + TGT_D + 'm',
       r.target > 0.999, (r.target*100).toFixed(0) + '% visible');
    ok(wid + ' / ' + name + ' is clear below the reticle too',
       r.down >= 2.0, 'down ' + r.down.toFixed(1) + 'deg');
  }
}

/* The reticle is the other way to blind a sight, and the geometry checks above cannot
   see it: reticles are transparent overlays, so they never count as occlusion.

   The rule applies to sights that ZOOM, because those are the ones used at range. A red
   dot's mark is a filled dot wider than a torso at 32m and that is correct - it is a
   close-quarters sight. A magnifying sight is aimed at things it must not cover.

   What the Ghost Lens shipped with first was a FILLED 3.5mm circle: 0.56 deg at 34cm
   against a torso that is 0.50 deg half-width at 32m. The aim mark was wider than the
   thing you were aiming at, and solid, so you could not see the hit you were calling.
   A target's half-WIDTH is the yardstick, not its half-height - it is 1.61 deg tall and
   only 0.50 deg wide, and I got that backwards the first time I reasoned about it. */
const TORSO_HW = Math.atan(0.28/TGT_D)*180/Math.PI;    // 0.50 deg at 32m
function reticle(wid, optic){
  const built = ctx.buildGunModel(wid, { optic });
  const g = built.group;
  const A = built.aim
    ? { ax:built.aim.x, ay:built.aim.y, az:built.aim.z, dist:built.ads.dist, fovDrop:built.ads.fovDrop }
    : { ax:0, ay:0.05, az:-0.28, dist:0.22, fovDrop:24 };
  g.position.set(-A.ax, -A.ay, -A.dist - A.az);
  g.updateMatrixWorld(true);
  const marks = [];
  g.traverse(o => { if(o.isMesh && o.material && o.material.transparent
    && o.material.opacity > 0.5 && o.userData.slot === 'optic') marks.push(o); });
  const rc = new THREE.Raycaster(); rc.far = 1.2;
  const O = new THREE.Vector3(), d = new THREE.Vector3();
  const hit = (deg, ph) => {
    const th = deg*Math.PI/180;
    d.set(Math.sin(th)*Math.cos(ph), Math.sin(th)*Math.sin(ph), -Math.cos(th)).normalize();
    rc.set(O, d); return rc.intersectObjects(marks, false).length > 0;
  };
  let outer = 0;
  for(let deg = 0.02; deg <= 1.4; deg += 0.02) if(hit(deg, Math.PI/4)) outer = deg;
  /* 0.15 deg off-axis on the diagonal: clear of the crosshair arms (0.07 deg half-thick)
     and well inside any sane centre ring, so a hit here means the mark is FILLED. */
  const filled = hit(0.15, Math.PI/4);
  return { outer, filled, zooms: A.fovDrop >= 40, marks: marks.length };
}
for(const wid of WIDS) for(const [name, part] of OPTICS){
  const r = reticle(wid, part ? Object.assign({}, part, { weapon: wid }) : null);
  ok(wid + ' / ' + name + ' draws an aiming mark at all', r.marks > 0);
  if(!r.zooms) continue;                      // close-quarters sights are allowed a fat dot
  ok(wid + ' / ' + name + ' aim mark is finer than the torso it aims at',
     r.outer <= 0.45, r.outer.toFixed(2) + 'deg vs torso half-width ' + TORSO_HW.toFixed(2) + 'deg');
  ok(wid + ' / ' + name + ' aim mark is see-through at the centre',
     !r.filled, 'a magnifying sight must not hide its own point of impact');
}

/* A set optic is a reward. It must never see worse than the weapon's own bare sight. */
for(const wid of WIDS) for(const name of ["Saint's Eye", 'Bulwark Ward', 'Ghost Lens']){
  ok(wid + ' / ' + name + ' is no worse than the bare sight it replaces',
     R[wid][name].target >= R[wid]['(default)'].target,
     (R[wid][name].target*100).toFixed(0) + '% vs ' + (R[wid]['(default)'].target*100).toFixed(0) + '%');
}

/* The Ghost Lens is three rings in a row, and the failure mode is one of them being the
   aperture while the others do nothing. If they are sized to their distance from the eye
   they subtend the same angle, so the window is round-ish rather than pinched: up, down
   and sideways come out within half a degree of each other. */
for(const wid of WIDS){
  const r = sight(wid, Object.assign({}, OPTICS[7][1], { weapon: wid }), 'optic');
  const spread = Math.max(r.up, r.down, r.side) - Math.min(r.up, r.down, r.side);
  ok(wid + ' / Ghost Lens rings all subtend the same angle', spread <= 0.9,
     'up ' + r.up.toFixed(1) + ' side ' + r.side.toFixed(1) + ' down ' + r.down.toFixed(1));
}

if(fails){ console.error('\n  sights.test.js: ' + fails + ' FAILED'); process.exit(1); }
const g = R['ls1']['Ghost Lens'];
console.log('  sights: ' + WIDS.length*OPTICS.length + ' weapon/optic pairs clear;'
  + ' Ghost Lens on the LS-1 opens ' + g.up.toFixed(1) + 'deg up, ' + g.side.toFixed(1) + 'deg across'
  + ' (target at ' + TGT_D + 'm needs 0.8)');

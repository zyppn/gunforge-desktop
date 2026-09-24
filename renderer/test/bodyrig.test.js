/* The player body is a drop-in for code that already exists, not a free-standing model.
   Four things have to stay true and none of them show up in a diff:

   1. botMesh's userData contract. The walk cycle, the death camera, the health bar and
      the shield bubble all reach in by key; a renamed or dropped key does not throw,
      it just quietly stops animating.
   2. The hands stay on the weapon. The arms are two bones solved to grips that live in
      the gun's own space, so idle, aim and recoil are one code path - but an arm that
      cannot reach its grip silently gives up and goes straight, which looks exactly
      like the rigid planks this replaced. Every weapon is checked, in both poses.
   3. The body fits the server's hit cylinder. The hitbox is a cylinder in
      server/index.js and is NOT derived from the mesh, so geometry outside it is
      geometry players shoot at and watch pass through. The bounds are read out of the
      server here rather than copied, because a copied constant is how these two halves
      drift apart.
   4. Recoil does not accumulate. Folding the kick straight into gun.rotation.x and then
      lerping that same value toward its target next frame compounds it about sevenfold.

   Real geometry, not regex: three.js builds fine in Node as long as nothing asks for a
   WebGL context, and measuring transformed vertices is the only honest way to answer
   "is this inside the cylinder" or "is that hand on the grip". */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const THREE = require(path.join(ROOT, 'renderer', 'vendor', 'three.min.js'));
const LoadoutCore = require(path.join(ROOT, 'server', 'loadout-core.js'));

let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };

/* ---- the hit cylinder, read from the server that enforces it ---- */
const mR = server.match(/const PLAYER_R = ([\d.]+)/);
const mCyl = server.match(/b\.y > 0 && b\.y < ([\d.]+) && ddx\*ddx \+ ddz\*ddz < \(PLAYER_R \+ ([\d.]+)\)/);
ok('server still declares PLAYER_R', !!mR);
ok('server hit test still has the shape this test reads', !!mCyl);
if(!mR || !mCyl){ console.error('\nbodyrig: ' + fails + ' failure(s)'); process.exit(1); }
const HIT_R = parseFloat(mR[1]) + parseFloat(mCyl[2]);
const HIT_TOP = parseFloat(mCyl[1]);

/* ---- lift the real functions out of the shipped page ---- */
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
const FNS = ['vmCyl','vmBox','vmTag','mat','shade','partMat','vmFrame','vmBarrel','vmMagazine','vmMagazineBody',
  'vmForegrip','vmForegripBody','vmStock','vmStockBody','fitScale','vmOptic','buildGunModel',
  'aimBone','solveArm','fitGripZ','lerp','lerp3','poseUpper','mkArm','botMesh'];
/* Every top-level `const NAME = 0x...;` in the renderer, lifted automatically.
   Listing them by hand meant this file broke every time a set was given an accent
   colour - GHOST_CYAN once, SAINT_IVORY again - which trains you to add the name and
   move on rather than read the failure. */
const COLOR_CONSTS = [...html.matchAll(/^const ([A-Z][A-Z0-9_]*) = 0x[0-9A-Fa-f]+;/gm)].map(m => m[1]);
const CONSTS = ['RCOL','FIT_SPAN','ARM','GUN_HIP','GUN_ADS','POLE',
  '_v1','_pole','_elbow','_DOWN','_pR'].concat(COLOR_CONSTS);

const ctx = vm.createContext({
  THREE, Math, console,
  WEAPONS: LoadoutCore.WEAPONS, SLOTS: LoadoutCore.SLOTS, SETS: LoadoutCore.SETS,
  LoadoutCore, equippedParts: () => ({}),
});
vm.runInContext('let VMT=null, VMT_AIM=null, VMT_ADS=null;\n'
  + CONSTS.map(liftConst).join('\n') + '\n' + FNS.map(lift).join('\n'), ctx);

const WEAPONS = Object.keys(LoadoutCore.WEAPONS);
const build = (grunt, wid) => ctx.botMesh(0xE8734A, grunt, grunt ? null : { wid, eq: {} });
const settle = (u, aim, reloading) => { for(let i = 0; i < 60; i++) ctx.poseUpper(u, aim, reloading, 1/60, 7); };

/* ---- 1. the contract ---- */
const KEYS = ['hbFg','hbGroup','shSphere','legL','legR','gun','gunMuzzle','gunBase'];
for(const grunt of [false, true]){
  const who = grunt ? 'grunt' : 'player';
  const u = build(grunt, 'vkraptor').userData;
  for(const k of KEYS) ok(who + ' userData keeps ' + k, !!u[k]);
  ok(who + ' legs pivot at the hip (groups, not meshes)', u.legL.isGroup && u.legR.isGroup);
  ok(who + ' carries its own gun mount', !!(u.gunHip && u.gunAds));
}

/* ---- 2. the hands stay on the weapon, on every gun, in both poses ---- */
{
  const tip = new THREE.Vector3(), want = new THREE.Vector3();
  for(const wid of WEAPONS){
    const u = build(false, wid).userData;
    ok(wid + ' has two-bone arms',
       !!(u.arms && u.arms.R && u.arms.L && u.arms.R.up.isGroup && u.arms.R.fore.isGroup));
    if(!u.arms) continue;
    for(const aim of [0, 1]){
      settle(u, aim, false);
      u.gun.updateMatrix();
      for(const side of ['R','L']){
        const a = u.arms[side];
        ok(wid + ' ' + side + (aim ? ' aimed' : ' ready') + ' arm is not maxed out '
           + '(' + (a.reach*100).toFixed(0) + 'cm of ' + ((a.L1+a.L2)*100).toFixed(0) + ')', !a.straight);
        // where the forearm actually ends, vs the grip it was asked for
        tip.set(0, -a.L2, 0).applyQuaternion(a.fore.quaternion).add(a.fore.position);
        want.copy(a.grip).applyMatrix4(u.gun.matrix);
        ok(wid + ' ' + side + (aim ? ' aimed' : ' ready') + ' hand is on the grip '
           + '(' + (tip.distanceTo(want)*1000).toFixed(0) + 'mm off)', tip.distanceTo(want) < 0.005);
      }
    }
  }
}

/* ---- 3. poses differ, and the reload tilt survives the shared path ---- */
{
  const u = build(false, 'vkraptor').userData;
  settle(u, 0, false); const ready = u.gun.position.clone();
  settle(u, 1, false); const aimed = u.gun.position.clone();
  ok('the sight raises the weapon', aimed.y - ready.y > 0.15);
  // aimed, the weapon has to line up under the aiming eye - not out on the shoulder,
  // and not so high it covers the visor, which starts at 1.70
  const ADS = vm.runInContext('[GUN_ADS.x, GUN_ADS.y]', ctx);
  ok('the sight lines the weapon up under the eye (x ' + ADS[0] + ')', Math.abs(ADS[0]) < 0.12);
  ok('aimed weapon clears the visor (top ' + (ADS[1] + 0.12).toFixed(2) + ')', ADS[1] + 0.12 < 1.70);

  settle(u, 0, true);
  ok('reload tilt still applies', Math.abs(u.gunTilt - 0.85) < 0.01);

  // idle sway exists at rest and is gone on the sight
  settle(u, 0, false);
  let lo = Infinity, hi = -Infinity;
  for(let i = 0; i < 400; i++){ ctx.poseUpper(u, 0, false, 1/60, 7);
    lo = Math.min(lo, u.gun.position.y); hi = Math.max(hi, u.gun.position.y); }
  ok('the weapon breathes at rest (' + ((hi-lo)*1000).toFixed(0) + 'mm)', hi - lo > 0.008 && hi - lo < 0.05);
  settle(u, 1, false);
  lo = Infinity; hi = -Infinity;
  for(let i = 0; i < 400; i++){ ctx.poseUpper(u, 1, false, 1/60, 7);
    lo = Math.min(lo, u.gun.position.y); hi = Math.max(hi, u.gun.position.y); }
  ok('the sight is steady (' + ((hi-lo)*1000).toFixed(1) + 'mm)', hi - lo < 0.001);
}

/* ---- 4. recoil decays instead of accumulating ---- */
{
  const u = build(false, 'vkraptor').userData;
  settle(u, 0, false);
  const restPitch = u.gun.rotation.x, restZ = u.gun.position.z;
  let peak = 0;
  for(let shot = 0; shot < 12; shot++){        // a full auto burst
    u.kick = 1;
    for(let i = 0; i < 5; i++){ ctx.poseUpper(u, 0, false, 1/60, 7);
      peak = Math.max(peak, Math.abs(u.gun.rotation.x - restPitch)); }
  }
  ok('recoil pitch stays in proportion to one kick (' + peak.toFixed(3) + ' rad)', peak < 0.30);
  for(let i = 0; i < 200; i++) ctx.poseUpper(u, 0, false, 1/60, 7);
  ok('recoil pitch returns to rest', Math.abs(u.gun.rotation.x - restPitch) < 1e-3);
  ok('recoil recoil offset returns to rest', Math.abs(u.gun.position.z - restZ) < 1e-3);
  ok('a burst leaves no bias in the resting tilt', Math.abs(u.gunTilt) < 1e-3);
}

/* ---- 5. the hit envelope ---- */
for(const grunt of [false, true]){
  const who = grunt ? 'grunt' : 'player';
  const m = build(grunt, 'ls1'), u = m.userData;
  settle(u, 0, false);
  m.updateMatrixWorld(true);
  const skip = new Set();
  const mark = o => { if(!o) return; skip.add(o); o.children.forEach(mark); };
  mark(u.gun); mark(u.hbGroup); skip.add(u.shSphere);   // not part of the target
  let maxR = 0, maxY = -Infinity, minY = Infinity;
  const v = new THREE.Vector3();
  m.traverse(o => {
    if(!o.isMesh || skip.has(o)) return;
    const pos = o.geometry.attributes.position;
    for(let i = 0; i < pos.count; i++){
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      const r = Math.hypot(v.x, v.z);
      if(r > maxR) maxR = r;
      if(v.y > maxY) maxY = v.y;
      if(v.y < minY) minY = v.y;
    }
  });
  ok(who + ' fits the hit cylinder radius (' + maxR.toFixed(3) + ' <= ' + HIT_R + ')', maxR <= HIT_R);
  ok(who + ' fits under the hit ceiling (' + maxY.toFixed(3) + ' <= ' + HIT_TOP + ')', maxY <= HIT_TOP);
  ok(who + ' stands on the floor (' + minY.toFixed(3) + ')', Math.abs(minY) < 0.02);
}

/* ---- 6. a grunt has a claw, not arms, and keeps its own mount ---- */
{
  const u = build(true).userData;
  ok('grunt has no arm rig', !u.arms);
  let threw = false;
  try { for(let i = 0; i < 30; i++) ctx.poseUpper(u, 1, true, 1/60, 5); } catch(e){ threw = true; }
  ok('the shared pose survives a body with no arms', !threw);
  ok('grunt keeps its own claw mount, not the rifle mount',
     Math.abs(u.gunHip.x - 0.42) < 1e-6 && Math.abs(u.gunHip.y - 1.15) < 1e-6);
}

/* ---- 7. one pose implementation, not two ---- */
{
  const calls = (html.match(/poseUpper\(/g) || []).length;
  ok('poseUpper is defined once and called from both worlds (found ' + calls + ')', calls >= 3);
  ok('live remotes read the synced sight blend', /poseUpper\(u,\s*t\.ads/.test(html));
  ok('offline bots read their own sight blend', /poseUpper\(u,\s*e\.aimT/.test(html));
  ok('the client tells the server it is reloading', /reloading:\s*!!me\.reloading/.test(html));
  ok('the schema carries the sight blend', /ads:\s*'number'/.test(server));
  ok('the schema carries the reload flag', /reloading:\s*'boolean'/.test(server));
  ok('the server whitelists the reload flag', /reloading:\s*!!msg\.reloading/.test(server));
  ok('ads is clamped in one place on the server',
     (server.match(/Math\.max\(0, Math\.min\(1, Number\(inp\.ads\)/g) || []).length === 1);
}

if(fails){ console.error('\nbodyrig: ' + fails + ' failure(s)'); process.exit(1); }
console.log('bodyrig: ok');

/* The player body is a drop-in for code that already exists, not a free-standing model.
   Three things have to stay true and none of them show up in a diff:

   1. botMesh's userData contract. The walk cycle, the death camera, the health bar and
      the shield bubble all reach in by key; a renamed or dropped key does not throw,
      it just quietly stops animating.
   2. The arms follow the gun. The gun climbs 0.32 to the visor on ADS and for a long
      time nothing followed it, so the rifle left the hands mid-aim. That was invisible
      only because the old body was one flat colour.
   3. The body fits the server's hit cylinder. The hitbox is a cylinder in
      server/index.js and is NOT derived from the mesh, so geometry outside it is
      geometry players shoot at and watch pass through. The old sphere head sat 4cm
      above the ceiling. The bounds are read out of the server here rather than copied,
      because a copied constant is how these two halves drift apart.

   Real geometry, not regex: three.js builds fine in Node as long as nothing asks for a
   WebGL context, and measuring transformed vertices is the only honest way to answer
   "is this inside the cylinder". */
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
const FNS = ['vmCyl','vmBox','mat','partMat','vmFrame','vmBarrel','vmMagazine','vmMagazineBody',
  'vmForegrip','vmForegripBody','vmStock','vmStockBody','fitScale','vmOptic','buildGunModel',
  'poseArms','poseUpper','botMesh'];
const CONSTS = ['RCOL','FIT_SPAN','ARM_ADS'];

const ctx = vm.createContext({
  THREE, Math, console,
  WEAPONS: LoadoutCore.WEAPONS, SLOTS: LoadoutCore.SLOTS, SETS: LoadoutCore.SETS,
  LoadoutCore,
  equippedParts: () => ({}),
});
vm.runInContext('let VMT=null, VMT_AIM=null, VMT_ADS=null;\n'
  + CONSTS.map(liftConst).join('\n') + '\n' + FNS.map(lift).join('\n'), ctx);

const GUN = { wid: 'vkraptor', eq: {} };
const build = grunt => ctx.botMesh(0xE8734A, grunt, grunt ? null : GUN);

/* ---- 1. the contract ---- */
const KEYS = ['hbFg','hbGroup','shSphere','legL','legR','gun','gunMuzzle','gunBase'];
for(const grunt of [false, true]){
  const who = grunt ? 'grunt' : 'player';
  const u = build(grunt).userData;
  for(const k of KEYS) ok(who + ' userData keeps ' + k, !!u[k]);
  ok(who + ' legs pivot at the hip (groups, not meshes)', u.legL.isGroup && u.legR.isGroup);
}

/* ---- 2. the arm rig, and that it moves with the gun ---- */
{
  const m = build(false), u = m.userData;
  ok('player has arm groups', !!(u.armL && u.armR && u.armL.isGroup && u.armR.isGroup));
  ok('player stores a rest pose for both arms', !!(u.armLB && u.armRB));

  ctx.poseUpper(u, 0, false, 1/60, 7);
  const rest = { gy: u.gun.position.y, gx: u.gun.position.x,
                 rx: u.armR.rotation.x, rz: u.armR.rotation.z,
                 lx: u.armL.rotation.x, lz: u.armL.rotation.z };
  ctx.poseUpper(u, 1, false, 1/60, 7);
  const aim = { gy: u.gun.position.y, gx: u.gun.position.x,
                rx: u.armR.rotation.x, rz: u.armR.rotation.z,
                lx: u.armL.rotation.x, lz: u.armL.rotation.z };

  ok('gun rises to the visor on ADS', Math.abs((aim.gy - rest.gy) - 0.32) < 1e-9);
  ok('gun pulls inboard on ADS', aim.gx < rest.gx - 0.05);
  // the actual regression this file exists for
  const moved = a => Math.abs(aim[a] - rest[a]);
  ok('trigger arm follows the gun', moved('rx') > 0.2);
  ok('support arm follows the gun', moved('lx') > 0.2 || moved('lz') > 0.05);
  ok('arms return to rest when the sight drops',
     (ctx.poseUpper(u, 0, false, 1/60, 7), Math.abs(u.armR.rotation.x - rest.rx) < 1e-9));

  // reload tilt still reaches the gun through the shared path
  for(let i = 0; i < 180; i++) ctx.poseUpper(u, 0, true, 1/60, 7);
  ok('reload tilt still applies', Math.abs(u.gun.rotation.x - 0.85) < 0.01);

  // a grunt has a claw, not arms, and must not crash the shared pose
  const gu = build(true).userData;
  ok('grunt has no arm rig', !gu.armL && !gu.armR);
  let threw = false;
  try { ctx.poseUpper(gu, 1, true, 1/60, 5); } catch(e){ threw = true; }
  ok('shared pose survives a body with no arms', !threw);
}

/* ---- 3. the hit envelope ---- */
for(const grunt of [false, true]){
  const who = grunt ? 'grunt' : 'player';
  const m = build(grunt), u = m.userData;
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

/* ---- 4. one pose implementation, not two ---- */
{
  // Both worlds must route through poseUpper. Counting call sites is the check that
  // catches a future edit re-inlining the maths into one branch and drifting again.
  const calls = (html.match(/poseUpper\(/g) || []).length;
  ok('poseUpper is defined once and called from both worlds (found ' + calls + ')', calls >= 3);
  ok('live remotes read the synced sight blend', /poseUpper\(u,\s*t\.ads/.test(html));
  ok('offline bots read their own sight blend', /poseUpper\(u,\s*e\.aimT/.test(html));
  ok('the client tells the server it is reloading', /reloading:\s*!!me\.reloading/.test(html));
  ok('the schema carries the sight blend', /ads:\s*'number'/.test(server));
  ok('the schema carries the reload flag', /reloading:\s*'boolean'/.test(server));
  ok('the server whitelists the reload flag', /reloading:\s*!!msg\.reloading/.test(server));
  // one clamp of ads, not two
  ok('ads is clamped in one place on the server',
     (server.match(/Math\.max\(0, Math\.min\(1, Number\(inp\.ads\)/g) || []).length === 1);
}

if(fails){ console.error('\nbodyrig: ' + fails + ' failure(s)'); process.exit(1); }
console.log('bodyrig: ok');

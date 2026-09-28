/* Performance: what makes the game playable on a 2018 Intel Mac, and what must never
   change while doing it.

   1. Auto resolution steps down when a machine cannot hold its frame rate, ignores
      one-off hitches, steps back up only when there is real headroom, never re-tries a
      step that already failed, and remembers where it settled.
   2. Merging static meshes cuts draw calls without changing a single triangle: same
      vertices in the same places, mirrored parts still facing outwards, anything that
      fades or animates left alone.
   3. Spent particles and old scenes give their GPU memory back.

   node renderer/test/perf.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d !== undefined ? '   [' + d + ']' : '')); if(!cond) fails++; };
function lift(n){
  const m = html.match(new RegExp('(?:async\\s+)?function ' + n + '\\('));
  if(!m) throw new Error('missing function ' + n);
  let j = html.indexOf('{', html.indexOf(')', m.index)), d = 0;
  for(; j < html.length; j++){ if(html[j] === '{') d++; else if(html[j] === '}'){ d--; if(!d) return html.slice(m.index, j + 1); } }
  throw new Error('unbalanced ' + n);
}
const line = re => { const m = html.match(re); if(!m) throw new Error('missing ' + re); return m[0]; };

/* ---------------- 1. auto resolution ---------------- */
function perfCtx(dpr, store, gfx){
  store = store || new Map();
  const ctx = vm.createContext({ Math, String, parseInt, SETTINGS: { gfx: gfx || 'auto' }, saved: 0, saveSettings(){ ctx.saved++; }, paintGfx(){},
    window: { devicePixelRatio: dpr }, document: { hidden: false }, paused: false,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    renderer: { ratio: null, setPixelRatio(r){ this.ratio = r; } }, sizeRenderer: () => {} });
  vm.runInContext([line(/const GFX_MODES = [^\n]*;/), line(/const gfxMode = [^\n]*;/), lift('setGfx'), lift('gfxChanged'),
    line(/const PERF_LADDER = [^\n]*;/), line(/const PERF_KEY = [^\n]*;/), line(/const PERF = \{[^\n]*\};/),
    line(/try\{ PERF\.step = [^\n]*\n/), ...['perfTop','perfRatio','perfApply','perfMatchStart','perfFrame'].map(lift),
    'this.PERF = PERF;'].join('\n'), ctx);
  ctx.store = store;
  return ctx;
}
// play `secs` of frames at `fps` (with an optional hitch every `hitchEvery` frames)
function play(ctx, t0, secs, fps, hitchEvery){
  let t = t0; const dt = 1000 / fps;
  for(let i = 0; i < secs * fps; i++){ t += dt; const raw = hitchEvery && i % hitchEvery === 0 ? 120 : dt; ctx.perfFrame(t, raw); }
  return t;
}
{
  const c = perfCtx(2);
  ok('a Retina screen starts at full sharpness (2x)', c.perfRatio() === 2);
  c.perfMatchStart(0);
  let t = play(c, 0, 2, 30);
  ok('no judgement in the first seconds of a match (shaders compiling)', c.perfRatio() === 2);
  t = play(c, t, 3, 30);
  ok('a machine stuck at 30 FPS steps DOWN', c.perfRatio() < 2, c.perfRatio());
  t = play(c, t, 12, 30);
  ok('  and keeps stepping until it can hold its frame rate', c.perfRatio() <= 1.25, c.perfRatio());
  ok('  and never below the floor', c.perfRatio() >= 0.75);
  ok('  (a machine that fails every step stays on the floor while it keeps failing)', (play(c, t, 90, 30), c.perfRatio()) === 0.75);
  ok('the step it settled on is remembered for the next match', c.store.get('gf_render_step') === String(c.PERF.step));
  const c2 = perfCtx(2, c.store);
  ok('  and the next launch starts there, not at the top', c2.perfRatio() === c.perfRatio());
}
{
  const c = perfCtx(2); c.perfMatchStart(0);
  play(c, 0, 20, 60, 45);
  ok('occasional hitches (a GC pause every ~second) cost NO resolution', c.perfRatio() === 2);
}
{
  const c = perfCtx(2); c.perfMatchStart(0);
  let t = play(c, 0, 2.6, 40);                   // one heavy moment: falls one step
  ok('one heavy moment costs one step', c.perfRatio() === 1.75, c.perfRatio());
  t = play(c, t, 30, 60);
  ok('  30s of smooth play is not enough to retry a step that failed', c.perfRatio() === 1.75);
  t = play(c, t, 40, 60);
  ok('  a full minute is: it tries full sharpness once more', c.perfRatio() === 2, c.perfRatio());
  t = play(c, t, 1.6, 40);                       // and fails again
  t = play(c, t, 180, 60);
  ok('  failing a second time bans that step for the session (no see-sawing)', c.perfRatio() === 1.75, c.perfRatio());
}
{
  const c = perfCtx(2); c.perfMatchStart(0);
  let t = play(c, 0, 3.5, 40), fellTo = c.perfRatio();
  t = play(c, t, 3, 45);                          // lower resolution still not enough
  ok('a machine that is still struggling keeps going down', c.perfRatio() < fellTo, c.perfRatio());
}
{
  const c = perfCtx(2); c.perfMatchStart(0);
  play(c, 0, 6, 4);
  ok('a machine drawing 4 FPS is caught within seconds, not left waiting on a frame count', c.perfRatio() < 2, c.perfRatio());
}
{
  const c = perfCtx(1); c.perfMatchStart(0);
  ok('a normal (non-Retina) screen tops out at 1x - it never renders ABOVE the screen', c.perfRatio() === 1);
  play(c, 0, 30, 144);
  ok('  a fast machine stays at the top step', c.perfRatio() === 1);
}
{
  const c = perfCtx(2); c.perfMatchStart(0); c.paused = true;
  play(c, 0, 10, 20);
  ok('paused (menu open) never counts against the machine', c.perfRatio() === 2);
}
/* ---- the Graphics setting ---- */
{
  const c = perfCtx(2, null, 'high'); c.perfMatchStart(0);
  play(c, 0, 30, 25);
  ok('HIGH: full sharpness always, even at 25 FPS', c.perfRatio() === 2);
}
{
  const c = perfCtx(2, null, 'low'); c.perfMatchStart(0);
  ok('LOW on a Retina screen: starts at 1x, not 2x', c.perfRatio() === 1);
  play(c, 0, 8, 30);
  ok('  and auto can still take it lower if even that struggles', c.perfRatio() < 1 && c.perfRatio() >= 0.75, c.perfRatio());
  play(c, 8000, 200, 60);
  ok('  but never back above 1x', c.perfRatio() <= 1);
}
{
  const c = perfCtx(2); c.perfMatchStart(0);
  play(c, 0, 8, 30);
  ok('AUTO had stepped down', c.perfRatio() < 2);
  c.setGfx('high');
  ok('switching mode applies at once and is saved', c.perfRatio() === 2 && c.saved === 1 && c.SETTINGS.gfx === 'high');
  c.setGfx('auto');
  ok('  and a new mode starts clean - what AUTO learned before does not carry over', c.perfRatio() === 2 && Object.keys(c.PERF.fails).length === 0);
  c.setGfx('ultra');
  ok('an unknown mode is ignored', c.SETTINGS.gfx === 'auto');
}
ok('saved settings are checked: a bad value falls back to AUTO', /SETTINGS\.gfx\s*= GFX_MODES\.includes\(s\.gfx\) \? s\.gfx : 'auto';/.test(html));
ok('AUTO is the default, and RESET TO DEFAULT restores it',
   /let SETTINGS = \{[^}]*gfx: 'auto'/.test(html) && (html.match(/SETTINGS = \{ volume:0\.8, music:0\.6, sens:1\.0, gfx:'auto'/g) || []).length === 2);
ok('LOW turns anti-aliasing off (a fresh canvas, since a WebGL context keeps its first settings)',
   /const aa = gfxMode\(\) !== 'low';/.test(html) && /antialias:aa/.test(html) && /cv\.replaceWith\(fresh\)/.test(html));
ok('  and the fresh canvas keeps its click-to-aim listener', /cv\.replaceWith\(fresh\); cv = fresh;\s*cv\.addEventListener\('mousedown', onCanvasDown\)/.test(html));
ok('LOW uses per-vertex lighting', /if\(gfxMode\(\) === 'low'\) return new THREE\.MeshLambertMaterial/.test(html));
ok('LOW drops the muzzle light and cosmetic muzzle fire, but keeps hit sparks',
   /if\(gfxMode\(\) !== 'low'\) vm\.add\(muzzleLight\)/.test(html) && /if\(gfxMode\(\) === 'low'\) return;\s*\/\/ purely cosmetic/.test(html)
   && !/gfxMode/.test(lift('spawnSpark')));
ok('the setting is in home Settings AND the in-match panel', (html.match(/class="gfxhost"/g) || []).length === 2 && /\+'<div class="gfxhost">'\+gfxHtml\(\)/.test(html));
ok('no graphics mode touches field of view, fog or draw distance',
   !/fov|fog|\.far\b/i.test(['setGfx','gfxChanged','perfTop','perfRatio','initRenderer','mat'].map(lift).join('')));
ok('the renderer asks for the discrete GPU on dual-GPU Macs', /powerPreference:\s*'high-performance'/.test(html));
ok('resolution never touches what you can SEE: field of view and fog are not in the perf code',
   !/fov|fog|far\s*=/.test(['perfApply','perfFrame','perfRatio'].map(lift).join('')));

/* ---------------- 2. merged static meshes ---------------- */
{
  const ctx = vm.createContext({ console, Math, Map, Object, Array, Float32Array, Uint16Array, Uint32Array, Int32Array, ArrayBuffer, Symbol, Error, JSON, self: {} });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'three.min.js'), 'utf8'), ctx);
  vm.runInContext(['mergeKey', 'mergeStatic', 'disposeScene', 'disposeFx'].map(lift).join('\n')
    + '\nfunction mat(c, e, ei){ return new THREE.MeshStandardMaterial({color:c, roughness:0.85, metalness:0.15, emissive:e||0, emissiveIntensity:ei||0}); }', ctx);
  const T = ctx.THREE;
  const root = new T.Group(); root.position.set(5, 0, 3); root.rotation.y = 0.7;
  const parts = [];
  const add = (geo, color, pos, scale) => { const m = new T.Mesh(geo, ctx.mat(color)); m.position.set(...pos); if(scale) m.scale.set(...scale); root.add(m); parts.push(m); return m; };
  add(new T.BoxGeometry(1, 1, 1), 0xff0000, [0, 0, 0]);
  add(new T.BoxGeometry(0.5, 2, 0.5), 0xff0000, [1, 0, 0]);
  add(new T.CylinderGeometry(0.2, 0.2, 1, 8), 0x00ff00, [0, 1, 0]);
  add(new T.BoxGeometry(1, 0.2, 0.3), 0x00ff00, [0, -1, 0], [-1, 1, 1]);      // mirrored
  const flash = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ transparent: true, opacity: 0 })); root.add(flash);
  const worldTris = ms => { const out = []; for(const m of ms){ m.updateMatrixWorld(true); const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const p = g.attributes.position; for(let i = 0; i < p.count; i++){ const v = new T.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); out.push(v); } } return out; };
  root.updateMatrixWorld(true);
  const before = worldTris(parts);
  const beforeKey = before.map(v => v.toArray().map(x => x.toFixed(4)).join(',')).sort().join('|');
  const saved = ctx.mergeStatic(root, parts);
  const meshes = root.children.filter(o => o.isMesh && o.material.type === 'MeshStandardMaterial');
  ok('four static parts in two colours become two meshes (two draw calls)', saved === 2 && meshes.length === 2, meshes.length);
  const after = worldTris(meshes);
  ok('  with exactly the same number of vertices', after.length === before.length, after.length + ' vs ' + before.length);
  const afterKey = after.map(v => v.toArray().map(x => x.toFixed(4)).join(',')).sort().join('|');
  ok('  every vertex exactly where it was in the world', afterKey === beforeKey);
  // winding: every baked triangle's geometric normal must agree with its stored normal
  let bad = 0;
  for(const m of meshes){ const p = m.geometry.attributes.position, n = m.geometry.attributes.normal;
    for(let i = 0; i < p.count; i += 3){ const a = new T.Vector3().fromBufferAttribute(p, i), b = new T.Vector3().fromBufferAttribute(p, i+1), c = new T.Vector3().fromBufferAttribute(p, i+2);
      const fn = b.sub(a).cross(c.sub(a)).normalize(); if(fn.dot(new T.Vector3().fromBufferAttribute(n, i)) < 0.5) bad++; } }
  ok('  and every face still points outwards, mirrored parts included', bad === 0, bad + ' inverted');
  ok('a transparent, fading mesh (muzzle flash) is never merged', flash.parent === root);
  ok('the originals are gone from the scene (no double drawing)', parts.every(m => !m.parent));

  /* ---------------- 3. GPU memory comes back ---------------- */
  let freed = 0;
  const spark = new T.Mesh(new T.SphereGeometry(0.1, 6, 5), new T.MeshBasicMaterial({ transparent: true }));
  spark.geometry.addEventListener('dispose', () => freed++); spark.material.addEventListener('dispose', () => freed++);
  const sc = new T.Scene(); sc.add(spark);
  ctx.disposeFx(spark);
  ok('a spent particle frees its geometry AND its material', freed === 2 && !spark.parent);
  let sceneFreed = 0;
  const old = new T.Scene(); for(let i = 0; i < 5; i++){ const m = new T.Mesh(new T.BoxGeometry(), ctx.mat(0x123456)); m.geometry.addEventListener('dispose', () => sceneFreed++); old.add(m); }
  ctx.disposeScene(old);
  ok('the previous match\'s scene is freed when the next one is built', sceneFreed === 5);
  ok('expired particles go through disposeFx, not a bare scene.remove', /if\(f\.t<=0\)\{ disposeFx\(f\.mesh\);/.test(html));
  ok('buildScene frees the old scene first', /function buildScene\(map\)\{\s*disposeScene\(scene\);/.test(html));
}

console.log(fails ? '\nperf: ' + fails + ' failure(s)' : '\nperf: all clear');
process.exit(fails ? 1 : 0);

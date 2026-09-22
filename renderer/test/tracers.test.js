/* Set abilities have to be legible in flight. Ghost and Hornet already changed the
   round; Exhale and Unstoppable did not, so two of the six sets were invisible in
   play. These pin the treatments apart - a colour or a scale quietly collapsing onto
   another set's is the failure mode, and it is not one you notice in a diff. */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond) => { if(!cond){ console.error('  FAIL  ' + name); fails++; } };
const need = (re, what) => { const m = html.match(re); if(!m){ ok('source has ' + what, false); return null; } return m; };

const rgb = h => [(h>>16)&255, (h>>8)&255, h&255];
const far = (a, b) => rgb(a).reduce((s,v,i) => s + Math.abs(v - rgb(b)[i]), 0);

/* the four projectile treatments, read out of the shipped source */
const C = {};
for(const [k, re] of [['ghost', /ghost\s*\?\s*(0x[0-9A-Fa-f]+)/],
                      ['seeker', /seeker\s*\?\s*(0x[0-9A-Fa-f]+)/],
                      ['drake', /drake\s*\?\s*(0x[0-9A-Fa-f]+)/],
                      ['plain', /e\.isPlayer\s*\?\s*(0x[0-9A-Fa-f]+)\s*:\s*\(e\.grunt/]]){
  const m = need(re, k + ' tracer colour');
  if(m) C[k] = parseInt(m[1], 16);
}
ok('all four tracer colours present', Object.keys(C).length === 4);
if(Object.keys(C).length === 4){
  const names = Object.keys(C);
  for(let i = 0; i < names.length; i++) for(let j = i+1; j < names.length; j++){
    const d = far(C[names[i]], C[names[j]]);
    ok(names[i] + ' vs ' + names[j] + ' are tellable apart (got ' + d + ')', d >= 120);
  }
  // Exhale is fire: it has to be warm, and warmer than the plain gold round
  const [r,g,b] = rgb(C.drake);
  ok('exhale reads as fire, not as a gold round', r > 200 && g < 160 && b < 90 && r - b > 150);
}

/* shape, not just hue - colour alone is lost against a bright map */
const gs = need(/if\(ghost\)\{[\s\S]{0,200}?m\.scale\.set\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/, 'ghost scale');
const ds = need(/else if\(drake\)\{[\s\S]{0,200}?m\.scale\.set\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/, 'exhale scale');
if(gs && ds){
  const gz = +gs[3], dz = +ds[3];
  ok('ghost is the long streak', gz >= 4);
  ok('exhale is short and thick, not a second railgun', dz < gz / 2 && +ds[1] > +gs[1]);
}
ok('exhale spits fire off the muzzle', /if\(drake\)\s*spawnFlame\(/.test(html));

/* Unstoppable is the one set whose effect is invisible on the target */
ok('mitigated hits spark differently', /braced\)\{[\s\S]{0,160}spawnSpark\(/.test(html));
const sp = need(/braced\)\{\s*\n\s*spawnSpark\(p\.x,\s*p\.y,\s*p\.z,\s*(0x[0-9A-Fa-f]+)\)/, 'braced spark colour');
const np = need(/else spawnSpark\(p\.x,p\.y,p\.z,\s*b\.crit\?(0x[0-9A-Fa-f]+):(0x[0-9A-Fa-f]+)\)/, 'normal spark colour');
if(sp && np){
  ok('the braced spark is not the normal spark', far(parseInt(sp[1],16), parseInt(np[2],16)) >= 60);
  ok('nor the crit spark', far(parseInt(sp[1],16), parseInt(np[1],16)) >= 60);
}
ok('the brace overlay exists', /#bracov\{/.test(html) && /id="bracov"/.test(html));
ok('the brace overlay is driven by the shared predicate', /#bracov'\)\.style\.opacity[\s\S]{0,60}firingResistOn\(me\)/.test(html));
ok('the brace overlay hides on death', /#hud\.dead #bracov/.test(html));

/* one predicate owns the window, and the damage multiplier is applied in ONE place */
ok('firingResistOn is defined once', (html.match(/function firingResistOn/g) || []).length === 1);
ok('the resist multiplier is applied once', (html.match(/firingResistOn\(t\)\) dmg \*= 0\.7/g) || []).length === 1);
ok('the bullet path does not re-apply it', !/braced \? 0\.7 : 1/.test(html));

console.log(fails ? '\n  tracers.test.js: ' + fails + ' FAILED' : '  tracers.test.js: all passed');
process.exit(fails ? 1 : 0);

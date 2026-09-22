/* Bullet tunnelling, tested against the SHIPPED loop rather than a copy.

   The offline path advanced a whole frame between collision tests. At 60fps an
   LS-1 round covers 2.13u and a Ghost round 5.54u against a target 1.36u wide,
   so shots that visually hit did nothing; every other weapon sat at about one
   test inside the target and tunnelled on any dropped frame.

   This pulls the real stepping code out of index.html and fires bullets at a
   stationary target, so it fails if the substep is ever removed OR if a future
   speed increase outruns the 0.3u cap.

   node renderer/test/tunnel.test.js                                          */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const core = require('../../server/loadout-core.js');
let fails = 0;
const check = (l, ok, d) => { console.log((ok?'  PASS  ':'  FAIL  ')+l+(d?'   ['+d+']':'')); if(!ok) fails++; };

/* Lift the bullet loop out of the shipped file: from the `for` that walks
   G.bullets backwards through the line that closes it. */
const startPat = /for\(let i=G\.bullets\.length-1;i>=0;i--\)\{/g;
let m, src = null;   // reassigned by the regression check below
while((m = startPat.exec(html))){
  const from = m.index;
  let i = html.indexOf('{', from), depth = 0;
  for(; i < html.length; i++){
    if(html[i] === '{') depth++;
    else if(html[i] === '}'){ depth--; if(depth === 0) break; }
  }
  const body = html.slice(from, i+1);
  if(body.includes('spawnSpark') && body.includes('G.map.walls')) { src = body; break; }
}
if(!src) throw new Error('could not find the offline bullet loop');
check('found the shipped bullet loop', true, src.split('\n').length + ' lines');
check('it substeps at all', /Math\.ceil\(travel \/ 0\.3\)/.test(src));
check('and the collision test uses the SUBstep, not the frame',
      /nx = p\.x \+ b\.vx\*sdt/.test(src) && !/nx = p\.x \+ b\.vx\*dt/.test(src));

/* Run it. Minimal stubs: a bullet is a mesh position plus velocity, a target is
   an entity at a known spot. */
function fire(speed, dt, dist, pellets){
  let hits = 0;
  for(let n = 0; n < (pellets||1); n++){
    /* Mid-arena, not on the edge: the bounds check kills anything at z<0.05,
       so a lane down z=0 dies on frame one and every shot reads as a miss. */
    const Z = 20, X0 = 5;
    const target = { id:1, x:X0+dist, z:Z, r:0.5, dead:false, hp:100, maxhp:100,
                     burnT:0, slowT:0, shield:0, isPlayer:false, grunt:false,
                     wep:{abilities:new Set()} };
    const pos = { x:X0, y:1.2, z:Z,
      set(a,b2,c){ this.x=a; this.y=b2; this.z=c; } };
    const b = { mesh:{position:pos}, vx:speed, vy:0, vz:0, dmg:10, owner:{id:0,team:'blue'},
                life:1.6, wid:'m17', ox:0, oz:0, pierce:0, wall:0, thruWall:false,
                bounce:0, burn:false, dragon:false, homing:false, cryo:false,
                vamp:false, expl:false, crit:false, hitset:new Set() };
    b.ox = X0; b.oz = Z;
    const G = { bullets:[b], ents:[target], map:{walls:[]}, me:{x:0,z:0},
                elapsed:0, fx:[], dying:[], drops:[] };
    const sandbox = {
      G, dt, Math, Set, LoadoutCore: core, AW:60, AD:40,
      scene:{ remove(){}, add(){} },
      hostile:()=>true, spawnSpark(){}, spawnBurst(){}, sfx(){},
      damage:(e)=>{ hits++; e.dead = true; },
    };
    vm.createContext(sandbox);
    // 30 frames is well past the 20u flight we ask for
    vm.runInContext('for(let f=0;f<30 && G.bullets.length;f++){ '+src+' }', sandbox);
  }
  return hits;
}

console.log('\nA ROUND MUST NOT STEP OVER A PERSON');
const DT60 = 1/60, DT30 = 1/30;   // 30fps stands in for a dropped frame
for(const w of core.WEAPONS){
  const speed = w.bspd/9;                       // the renderer's own divisor
  const per60 = speed*DT60;
  check(w.id.padEnd(9) + ' hits at 60fps', fire(speed, DT60, 12) === 1,
        per60.toFixed(2) + 'u per frame, target 1.36u wide');
  check('  '.padEnd(11) + ' hits at 30fps too', fire(speed, DT30, 12) === 1,
        (speed*DT30).toFixed(2) + 'u per frame');
}
console.log('\nTHE TWO THAT ACTUALLY BROKE');
{
  const ls1 = core.weaponById('ls1').bspd/9;
  check('LS-1 lands at 60fps',  fire(ls1, DT60, 12) === 1, (ls1*DT60).toFixed(2)+'u/frame');
  const ghost = ls1 * core.OVERCHARGE;
  check('Ghost LS-1 lands at 60fps', fire(ghost, DT60, 12) === 1, (ghost*DT60).toFixed(2)+'u/frame');
  check('Ghost LS-1 lands at 30fps', fire(ghost, DT30, 12) === 1, (ghost*DT30).toFixed(2)+'u/frame');
  check('  and at a horrible 15fps',  fire(ghost, 1/15, 12) === 1, (ghost/15).toFixed(2)+'u/frame');
}
console.log('\nTHE CAP HOLDS FOR ANY FUTURE SPEED');
{
  // the guarantee is per-STEP distance, which must stay under the hit radius
  let worst = 0, worstId = '';
  for(const w of core.WEAPONS){
    for(const [lab,mul] of [['',1],[' +Ghost',core.OVERCHARGE]]){
      const speed = w.bspd/9*mul, travel = speed*DT30;
      const per = travel/Math.max(1, Math.ceil(travel/0.3));
      if(per > worst){ worst = per; worstId = w.id+lab; }
    }
  }
  check('worst per-step distance stays under the 0.68u hit radius',
        worst < 0.68, worst.toFixed(3) + 'u  (' + worstId + ')');
  check('  and under the 0.3u cap itself', worst <= 0.3 + 1e-9, worst.toFixed(3) + 'u');
}
/* A green test proves nothing unless it would have gone red. Mutate the lifted
   source back to the old per-frame stepping and check the LS-1 starts missing -
   if this section ever passes, the harness has stopped measuring anything. */
console.log('\nTHE TEST CATCHES THE REGRESSION IT IS FOR');
{
  const broken = src
    .replace(/const steps = Math\.max\(1, Math\.ceil\(travel \/ 0\.3\)\);/, 'const steps = 1;');
  const saved = src;
  src = broken;
  const ls1 = core.weaponById('ls1').bspd/9, ghost = ls1*core.OVERCHARGE;
  const a = fire(ls1, DT60, 12), b = fire(ghost, DT60, 12);
  src = saved;
  check('with the substep removed, the LS-1 misses', a === 0, a + ' hits');
  check('  and Ghost misses',                        b === 0, b + ' hits');
  check('and the real source still hits',            fire(ls1, DT60, 12) === 1);
}

console.log('\nSERVER AND RENDERER AGREE');
{
  const srv = fs.readFileSync(path.join(__dirname, '../../server/index.js'), 'utf8');
  const a = (srv.match(/Math\.ceil\(dist \/ 0\.3\)/) || [])[0];
  const b = (src.match(/Math\.ceil\(travel \/ 0\.3\)/) || [])[0];
  check('both cap the step at the same 0.3u', !!a && !!b, (a||'-') + '  /  ' + (b||'-'));
}
console.log('\n' + (fails ? fails + ' FAILED' : 'all tunnelling checks passed'));
process.exit(fails ? 1 : 0);

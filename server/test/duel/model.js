/* The duel model. Lifted verbatim out of the balance scratchpad it was developed in,
   with only the require paths and one stdout line changed - this is the instrument
   that produced every win-rate number in the commit log, and rewriting it to be
   tidier would silently invalidate all of them.

   It reads loadout-core directly, so it measures the shipped weapons and the shipped
   part pool, not a copy of them.
*/
/* ROUND ROBIN. Every candidate build fights every other, at every range and two
   lead qualities, and we rank by win rate. This is the instrument that has been
   missing all session: a one-way TTK cannot see the opponent's build, which is
   exactly how the Dragon set got shipped at a 39% win rate.

   MODELLED: deadeye (crit, stacked+capped), swift (move speed -> the lead your
   opponent needs), vampiric (8% lifesteal), incendiary (burn), cryo (slows the
   target, so THEY get easier to hit), critheal (Saint: +15% crit, 10hp/crit),
   firing_resist (Jugg: -30% taken while firing - in a duel, always),
   pierce_all (Ghost: bullet speed x2.6), fire_nova (Dragon: ignite, +15%
   molten), homing (Hornet: every 2nd round corrects its lead).
   NOT MODELLED, and these builds are therefore UNDERRATED here: killshield
   (Bulwark - the shield lands after a kill, so a 1v1 never sees it), explosive
   / pierce / ricochet (multi-target), and Dragon's contagion (needs 3 players). */
const C = require('../../loadout-core.js');
/* A set effect this model does not implement would quietly score as "no benefit",
   which looks like a balance finding instead of a missing feature. Fail loudly. */
/* Juggernaut's -30% applies only while the target is FIRING. The duel model had it
   always on, because both sides open fire at t=0 and never stop - that is a ceiling,
   not a measurement. RESIST_UP is the fraction of an engagement the trigger is
   actually down; 1 reproduces the old behaviour. */
if(C.JUGG_RESIST === undefined) throw new Error('loadout-core JUGG_RESIST is missing - stale stage?');
/* JUGG_R is the shipped reduction unless an experiment overrides it through the
   environment. This used to be tested by rewriting loadout-core in place, and two runs
   at different values then raced each other over one file and silently traded results -
   both reported the same numbers, which is how the swap was caught. */
const JUGG_R = process.env.JUGG_R !== undefined ? +process.env.JUGG_R : C.JUGG_RESIST;
if(!(JUGG_R >= 0 && JUGG_R <= 1)) throw new Error('bad JUGG_R: '+process.env.JUGG_R);
let RESIST_UP = 1;
function setResistUptime(u){ RESIST_UP = u; }
const KNOWN_EFFECTS = ['critheal','homing','fire_nova','killshield','pierce_all','firing_resist'];
for(const st of C.SETS) if(!KNOWN_EFFECTS.includes(st.effect))
  throw new Error('model does not implement set effect: '+st.effect+' ('+st.id+')');
const LEG=C.RAR.legendary.scale, EPI=C.RAR.epic.scale;
const R_HIT=0.68, EYE=1.54, TOP=1.9, TSPD=6.0, VAMP=0.08, CRIT_BASE=0.12;
let _s=1; const seed=n=>{_s=n>>>0||1;};
const rnd=()=>{_s|=0;_s=_s+0x6D2B79F5|0;let t=Math.imul(_s^_s>>>15,1|_s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};

function hitP(dist,sprd,speed,q,tspd,homing,N){
  let h=0,f=0;
  for(let i=0;i<N;i++){
    const dir=rnd()<0.5?1:-1, tof=dist/speed;
    // a seeker corrects most of the lead error it was given
    const seeker = homing && (i % C.HOMING.every === 0);
    const qq = seeker ? q + (1-q)*0.75 : q;
    const aimLead=tspd*tof*dir*qq;
    let dx=1,dy=(rnd()-0.5)*2*sprd,dz=aimLead/dist+(rnd()-0.5)*2*sprd;
    const L=Math.hypot(dx,dy,dz);dx/=L;dy/=L;dz/=L;
    const vx=dx, vz=dz-tspd*dir/speed, ax=-dist;
    const vv=vx*vx+vz*vz; if(vv<1e-9)continue;
    const av=ax*vx, t=-av/vv, d2=ax*ax-av*av/vv;
    if(d2>=R_HIT*R_HIT||t<=0)continue;
    const te=t-Math.sqrt((R_HIT*R_HIT-d2)/vv); if(te<=0)continue;
    const y=EYE+dy*te; if(y<=0||y>=TOP)continue;
    if(te/speed>1.6)continue;
    h++;f+=te/speed;
  }
  return {p:h/N, flight:h?f/h:dist/speed};
}
/* STACK is not exported, so read it out of the source rather than copying the
   numbers here where they would silently drift. */
const SRC = require('fs').readFileSync(require('path').join(__dirname, '../../loadout-core.js'), 'utf8');
const STACK = {};
for(const kind of ['deadeye','swift']){
  const m = SRC.match(new RegExp(kind+':\\s*\\{\\s*first:([\\d.]+),\\s*extra:([\\d.]+),\\s*cap:([\\d.]+)'));
  if(!m) throw new Error('could not read STACK.'+kind+' from loadout-core');
  STACK[kind] = { first:+m[1], extra:+m[2], cap:+m[3] };
}
if(process.env.DUEL_VERBOSE) console.log('  STACK read from source:', JSON.stringify(STACK));
const stack=(kind,n)=>{ if(!n) return 0; const s=STACK[kind];
  return Math.min(s.cap, s.first + s.extra*(n-1)); };

function mkBuild(name, wid, setPieces, ab){
  const nDead = ab.filter(a=>a==='deadeye').length;
  const nSwift= ab.filter(a=>a==='swift').length;
  const has = a=>ab.indexOf(a)>=0;
  let crit = nDead ? stack('deadeye', nDead) : 0;
  if(has('critheal')) crit += 0.15;                 // Saint carries its own
  const w = C.weaponById(wid);
  return { name, wid, setPieces, ab, has,
    crit: Math.min(0.6, crit),
    tspd: TSPD * (1 + stack('swift', nSwift)),
    vamp: has('vampiric'), burn: has('incendiary')||has('fire_nova'),
    cryo: has('cryo'), critheal: has('critheal'),
    resist: has('firing_resist'), homing: has('homing'),
    mol: has('fire_nova') ? C.DRAGON.molten : 0,
    guard: 0,   // the EXHALE guard was reverted in cd853b7; C.DRAGON.guard no longer exists,
                // and reading it here silently yielded undefined, which every test then skipped
    bspdMul: has('pierce_all') ? C.OVERCHARGE : 1 };
}
function statsFor(B, pick){
  const w=C.weaponById(B.wid); const m={dmg:1,rof:1,mag:1,reload:1,spread:1};
  for(let i=0;i<C.SLOTS.length;i++){
    const sc = B.setPieces.indexOf(C.SLOTS[i])>=0 ? EPI : LEG;
    const t = C.PART_POOL[C.SLOTS[i]][pick[i]].mods;
    for(const k in t) if(k in m) m[k]+=+(t[k]*sc).toFixed(3);
  }
  return { weaponId:B.wid, dmg:w.dmg*m.dmg, rof:Math.max(45,w.rof/m.rof),
    mag:Math.max(3,Math.round(w.mag*m.mag)), reload:Math.max(400,w.reload*m.reload),
    spread:Math.max(w.spread*C.SPREAD_FLOOR, w.spread*m.spread),
    bspd:w.bspd*B.bspdMul, pellets:w.pellets, crit:B.crit };
}
/* pick the stat template by one-way TTK - that part of the model is fine, it is
   only the BUILD comparison that needs a duel */
function fitTemplate(B,q){
  let bp=null,bs=1e9;
  for(let n=0;n<4096;n++){
    let v=n;const pk=[];for(let i=0;i<6;i++){pk.push(v%4);v=(v/4)|0;}
    const S=statsFor(B,pk);
    const sprd=C.fireSpread(S.spread*0.55,1), speed=S.bspd/9;
    seed(7); let sc=0;
    for(const d of [3,12.5,22.5,35]){
      const h=hitP(d,sprd,speed,q,TSPD,B.homing,1200);
      if(h.p<0.02){sc+=12;continue;}
      let t=0,hp=100,ammo=S.mag,burn=0,g=0;
      while(hp>0&&g++<900){
        if(ammo<=0){t+=S.reload/1000;ammo=S.mag;}
        const crit=rnd()<S.crit; let l=0;
        for(let j=0;j<S.pellets;j++) if(rnd()<h.p) l++;
        ammo--;
        const mb=(B.mol&&burn>0)?1+B.mol:1;
        if(l){hp-=l*S.dmg*C.rangeMul(B.wid,d)*(crit?2:1)*mb; if(B.burn)burn=3;}
        const st=S.rof/1000;
        if(burn>0){const bb=Math.min(burn,st);hp-=4*bb;burn-=bb;}
        t+=st;
      }
      sc+=t;
    }
    if(sc<bs){bs=sc;bp=pk;}
  }
  B.S = statsFor(B,bp);
  return B;
}
const PCACHE = new Map();
function pFor(A,D,d,q){                        // A shoots, D defends
  const dtspd = D.tspd * (A.cryo ? 0.80 : 1);  // cryo is up ~60% of the time in a duel
  // Keyed on the build's NAME. Two different builds sharing a name silently read each
  // other's hit probabilities - a pair of on/off variants named 'on' and 'off' across six
  // weapons had every weapon reading the first one's curve. Fold the stats that actually
  // drive hitP into the key so a name collision cannot do that again.
  const k = A.name+'|'+A.wid+'|'+A.S.spread.toFixed(5)+'|'+A.S.bspd+'|'+(A.homing?1:0)
            +'|'+dtspd.toFixed(3)+'|'+d+'|'+q;
  if(PCACHE.has(k)) return PCACHE.get(k);
  const sprd=C.fireSpread(A.S.spread*0.55,1), speed=A.S.bspd/9;
  seed(13);
  const r = hitP(d,sprd,speed,q,dtspd,A.homing,6000);
  PCACHE.set(k,r); return r;
}
function duel(A,B,d,q,N){
  const pA=pFor(A,B,d,q), pB=pFor(B,A,d,q);
  if(pA.p<0.02 && pB.p<0.02) return 0.5;
  const stepA=A.S.rof/1000, stepB=B.S.rof/1000;
  const mulA=C.rangeMul(A.wid,d), mulB=C.rangeMul(B.wid,d);
  let aw=0;
  for(let n=0;n<N;n++){
    let ha=100,hb=100,aa=A.S.mag,ab=B.S.mag,ba=0,bb=0,g=0;
    let ta=pA.flight, tb=pB.flight, rlA=0, rlB=0;
    while(ha>0&&hb>0&&g++<3000){
      if(ta<=tb){
        if(rlA>0){ta+=rlA;rlA=0;aa=A.S.mag;}
        else{
          const crit=rnd()<A.S.crit; let l=0;
          for(let j=0;j<A.S.pellets;j++) if(rnd()<pA.p) l++;
          aa--;
          let mb=(A.mol&&bb>0)?1+A.mol:1;
          if(B.guard&&ba>0) mb*=1-B.guard;      // B's set: A is on B's fire
          if(B.resist) mb *= 1 - JUGG_R*RESIST_UP;                 // Jugg: B is firing, always, in a duel
          if(l){ const dmg=l*A.S.dmg*mulA*(crit?2:1)*mb;
            hb-=dmg; if(A.burn)bb=3;
            if(A.vamp) ha=Math.min(100,ha+dmg*VAMP);
            if(crit&&A.critheal) ha=Math.min(100,ha+10); }
          if(aa<=0) rlA=A.S.reload/1000;
          ta+=stepA;
        }
      } else {
        if(rlB>0){tb+=rlB;rlB=0;ab=B.S.mag;}
        else{
          const crit=rnd()<B.S.crit; let l=0;
          for(let j=0;j<B.S.pellets;j++) if(rnd()<pB.p) l++;
          ab--;
          let mb=(B.mol&&ba>0)?1+B.mol:1;
          if(A.guard&&bb>0) mb*=1-A.guard;
          if(A.resist) mb *= 1 - JUGG_R*RESIST_UP;
          if(l){ const dmg=l*B.S.dmg*mulB*(crit?2:1)*mb;
            ha-=dmg; if(B.burn)ba=3;
            if(B.vamp) hb=Math.min(100,hb+dmg*VAMP);
            if(crit&&B.critheal) hb=Math.min(100,hb+10); }
          if(ab<=0) rlB=B.S.reload/1000;
          tb+=stepB;
        }
      }
      const dt=Math.min(stepA,stepB);
      if(ba>0){const x=Math.min(ba,dt);ha-=4*x;ba-=x;}
      if(bb>0){const x=Math.min(bb,dt);hb-=4*x;bb-=x;}
    }
    if(hb<=0&&ha>0) aw++; else if(hb<=0&&ha<=0) aw+=0.5;
  }
  return aw/N;
}
/* seed is exported so a caller can make a run reproducible. The generator is module
   state: two ladders in ONE process start from wherever the previous one left off, so
   they agree only across fresh processes unless the caller reseeds. That is fine for a
   sweep (each variant needs a fresh process anyway, because fitTemplate caches per
   weapon id and does not know a weapon changed) but not for a test that runs the same
   ladder twice and expects the same answer. */
module.exports={setResistUptime, C, mkBuild, fitTemplate, duel, TSPD, seed };

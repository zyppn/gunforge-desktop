/* Build assembly and the duel. Same provenance as model.js: lifted as-is.
   fight(A, B, distance, leadQuality, startState) runs one engagement to the death and
   returns whether A won.
*/
/* builds.js has its OWN generator - `let _s=1` below - separate from model.js's.
   Seeding one does not touch the other, and fight() draws from this one while
   fitTemplate draws from that one, so a reproducible run has to reset both. */
const { C, mkBuild, fitTemplate, duel, seed: seedModel } = require('./model.js');
const SOAK=C.SHIELD_SOAK, KILLSHIELD=C.BULWARK.perKill, SHIELD_CAP=C.BULWARK.cap, VAMPF=0.08;
if(!C.BULWARK) throw new Error('loadout-core has no BULWARK - stale stage?');
const R_HIT=0.68,EYE=1.54,TOP=1.9;
let _s=1; const seed=n=>{_s=n>>>0||1;};
const rnd=()=>{_s|=0;_s=_s+0x6D2B79F5|0;let t=Math.imul(_s^_s>>>15,1|_s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
function hitP(dist,sprd,speed,q,tspd,homing,N){let h=0,f=0;
  for(let i=0;i<N;i++){const dir=rnd()<0.5?1:-1,tof=dist/speed;
    const qq=(homing&&i%C.HOMING.every===0)?q+(1-q)*0.75:q;
    let dx=1,dy=(rnd()-0.5)*2*sprd,dz=tspd*tof*dir*qq/dist+(rnd()-0.5)*2*sprd;
    const L=Math.hypot(dx,dy,dz);dx/=L;dy/=L;dz/=L;
    const vx=dx,vz=dz-tspd*dir/speed,ax=-dist,vv=vx*vx+vz*vz; if(vv<1e-9)continue;
    const av=ax*vx,t=-av/vv,d2=ax*ax-av*av/vv;
    if(d2>=R_HIT*R_HIT||t<=0)continue;
    const te=t-Math.sqrt((R_HIT*R_HIT-d2)/vv); if(te<=0)continue;
    const y=EYE+dy*te; if(y<=0||y>=TOP)continue; if(te/speed>1.6)continue;
    h++;f+=te/speed;}
  return {p:h/N,flight:h?f/h:dist/speed};}
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
const PC=new Map();
function pFor(A,D,d,q){const ts=D.tspd*(A.cryo?0.80:1),
  k=A.tag+'|'+A.wid+'|'+A.S.spread.toFixed(5)+'|'+A.S.bspd+'|'+(A.homing?1:0)+'|'+ts.toFixed(3)+'|'+d+'|'+q;
  if(PC.has(k))return PC.get(k); seed(13);
  const r=hitP(d,C.fireSpread(A.S.spread*0.55,1),A.S.bspd/9,q,ts,A.homing,5000);
  PC.set(k,r);return r;}
function fight(A,B,d,q,st){
  const pA=pFor(A,B,d,q),pB=pFor(B,A,d,q);
  if(pA.p<0.02&&pB.p<0.02) return st;
  const sA=A.S.rof/1000,sB=B.S.rof/1000,mA=C.rangeMul(A.wid,d),mB=C.rangeMul(B.wid,d);
  let ha=st.hp,sa=st.sh,hb=100,sb=0,aa=A.S.mag,ab=B.S.mag,ba=0,bb=0,ta=pA.flight,tb=pB.flight,rA=0,rB=0,g=0;
  const take=(hp,sh,dm)=>{if(sh>0){const s=Math.min(sh,dm*SOAK);sh-=s;dm-=s;}return[hp-dm,sh];};
  while(ha>0&&hb>0&&g++<3000){
    if(ta<=tb){ if(rA>0){ta+=rA;rA=0;aa=A.S.mag;}
      else{const cr=rnd()<A.S.crit;let l=0;for(let j=0;j<A.S.pellets;j++)if(rnd()<pA.p)l++;aa--;
        let mb=(A.mol&&bb>0)?1+A.mol:1; if(B.resist)mb*=1-JUGG_R*RESIST_UP;
        if(l){const dm=l*A.S.dmg*mA*(cr?2:1)*mb;[hb,sb]=take(hb,sb,dm);if(A.burn)bb=3;
          if(A.vamp)ha=Math.min(100,ha+dm*VAMPF); if(cr&&A.critheal)ha=Math.min(100,ha+10);}
        if(aa<=0)rA=A.S.reload/1000; ta+=sA;}
    } else { if(rB>0){tb+=rB;rB=0;ab=B.S.mag;}
      else{const cr=rnd()<B.S.crit;let l=0;for(let j=0;j<B.S.pellets;j++)if(rnd()<pB.p)l++;ab--;
        let mb=(B.mol&&ba>0)?1+B.mol:1; if(A.resist)mb*=1-JUGG_R*RESIST_UP;
        if(l){const dm=l*B.S.dmg*mB*(cr?2:1)*mb;[ha,sa]=take(ha,sa,dm);if(B.burn)ba=3;
          if(B.vamp)hb=Math.min(100,hb+dm*VAMPF); if(cr&&B.critheal)hb=Math.min(100,hb+10);}
        if(ab<=0)rB=B.S.reload/1000; tb+=sB;} }
    const dt=Math.min(sA,sB);
    if(ba>0){const x=Math.min(ba,dt);ha-=4*x;ba-=x;}
    if(bb>0){const x=Math.min(bb,dt);hb-=4*x;bb-=x;}
  }
  if(ha<=0) return null;
  if(A.killshield) sa=Math.min(SHIELD_CAP,sa+KILLSHIELD);
  return {hp:ha,sh:sa};
}
/* templates cached per weapon+pieces+crit bucket - per-kit fitting does not finish */
const TPL=new Map();
function build(tag,wid,sp,kit,setAb){
  // which set is this, and therefore how good are its pieces
  const st=C.SETS.find(s=>s.weapon===wid && setAb.indexOf(s.effect)>=0);
  const setScale=st?C.RAR[st.rarity].scale:undefined;
  const b=mkBuild(tag,wid,sp,[...kit,...setAb],setScale);
  b.tag=tag; b.killshield=setAb.indexOf('killshield')>=0;
  const bucket=Math.round(b.crit*100/6)*6;
  const key=wid+'|'+sp.join(',')+'|'+bucket+'|'+(setScale||0);
  if(!TPL.has(key)){ const p=mkBuild('p',wid,sp,[],setScale); p.crit=bucket/100;
    fitTemplate(p,0.85); TPL.set(key,p.S); }
  /* The template is fitted from a build with NO abilities, so any ability that lands
     in the STAT block rather than on the build object is erased when S is copied over.
     crit was already restored here; bspd was not, which silently deleted pierce_all -
     Ghost has been measured as an LS-1 carrying two set pieces and no ability at all.
     Every stat-level ability multiplier must be re-applied here. */
  const T=TPL.get(key);
  b.S=Object.assign({},T,{crit:b.crit, bspd:T.bspd*b.bspdMul});
  if(b.bspdMul!==1 && b.S.bspd===T.bspd) throw new Error('bspdMul dropped again');
  return b;
}
const ONOFF=['vampiric','cryo','incendiary'];
function kits(k){const out=[];
  for(let nd=0;nd<=Math.min(k,4);nd++)for(let ns=0;ns+nd<=k;ns++){
    const rest=k-nd-ns; if(rest>ONOFF.length)continue;
    const pick=(i,cur)=>{if(cur.length===rest){out.push([...Array(nd).fill('deadeye'),...Array(ns).fill('swift'),...cur]);return;}
      if(i>=ONOFF.length)return; pick(i+1,[...cur,ONOFF[i]]); pick(i+1,cur);};
    pick(0,[]);} return out;}
const seedAll = n => { seedModel(n); seed(n); };
module.exports={C,build,kits,fight,mkBuild,fitTemplate,duel,seedAll,
  setResistUptime(u){ RESIST_UP=u; require('./model.js').setResistUptime(u); }};

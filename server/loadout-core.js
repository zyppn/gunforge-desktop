/* ============================================================
   GUNFORGE loadout core — THE single source of truth for weapon
   stats. Runs in BOTH the browser client and the Node server, so
   the damage a player sees in the armory is exactly the damage the
   server deals. If this drifts, builds lie — so it lives in one file.

   Loaded in Node via require(); loaded in the browser via a
   <script> tag that assigns to window.LoadoutCore.
   ============================================================ */
(function (root) {
  'use strict';

  const WEAPONS = [
    {id:'m17',     name:'M17',           type:'Pistol',        unlock:1,  dmg:13, rof:230,  mag:12, reload:1100, spread:0.050, bspd:560,  pellets:1},
    {id:'havoc9',  name:'Havoc-9',       type:'SMG',           unlock:3,  dmg:9,  rof:95,   mag:30, reload:1500, spread:0.090, bspd:520,  pellets:1},
    {id:'vkraptor',name:'VK Raptor',     type:'Assault Rifle', unlock:5,  dmg:12, rof:130,  mag:30, reload:1700, spread:0.085, bspd:640,  pellets:1},
    {id:'warden',  name:'Warden W12',    type:'Shotgun',       unlock:8,  dmg:8,  rof:620,  mag:6,  reload:2000, spread:0.120, bspd:560,  pellets:8},
    {id:'ls1',     name:'LS-1 Longshot', type:'Sniper',        unlock:12, dmg:65, rof:1100, mag:5,  reload:2100, spread:0.005, bspd:1150, pellets:1},
    {id:'goliath', name:'Goliath GX',    type:'LMG',           unlock:15, dmg:11, rof:125,  mag:80, reload:2600, spread:0.100, bspd:600,  pellets:1},
  ];

  const SLOTS = ['frame','barrel','magazine','foregrip','stock','optic'];

  // `pieces` and `rarity` mirror the client's SETS table so rollServerDrop can
  // mint real set pieces. id / weapon / need / effect must stay identical to the
  // client's copy in renderer/index.html or set bonuses will not line up.
  const SETS = [
    {id:'saint',   weapon:'m17',      need:2, effect:'critheal',      rarity:'epic',
     pieces:{barrel:"Saint's Whisper", optic:"Saint's Eye"}},
    {id:'hornet',  weapon:'havoc9',   need:3, effect:'homing',        rarity:'epic',
     pieces:{barrel:'Hornet Sting', magazine:'Hornet Hive', stock:'Hornet Shell'}},
    {id:'dragon',  weapon:'vkraptor', need:2, effect:'fire_nova',     rarity:'epic',
     pieces:{barrel:'Dragon Maw', magazine:'Dragon Heart'}},
    {id:'bulwark', weapon:'warden',   need:3, effect:'killshield',    rarity:'epic',
     pieces:{foregrip:'Bulwark Brace', stock:'Bulwark Chassis', optic:'Bulwark Ward'}},
    {id:'ghost',   weapon:'ls1',      need:2, effect:'pierce_all',    rarity:'legendary',
     pieces:{barrel:'Ghost Bore', optic:'Ghost Lens'}},
    {id:'jugg',    weapon:'goliath',  need:4, effect:'firing_resist', rarity:'legendary',
     pieces:{barrel:'Jugg Cannon', magazine:'Jugg Belt', foregrip:'Jugg Claw', stock:'Jugg Spine'}},
  ];

  /* ---- ability stacking --------------------------------------------------
     Abilities used to live in a Set, so a second Deadeye part was worth exactly
     nothing and nothing in the UI said so. The two abilities that are pure numbers
     now stack on a diminishing curve with a hard cap: the duplicate is worth
     finding, but six of them don't make a 72% crit build.
       Deadeye      12% for the first, +6% each extra, cap 30%
       Featherweight +10% for the first, +5% each extra, cap 25%
     The effect abilities (incendiary, cryo, pierce, ricochet, vampiric, explosive)
     stay non-stacking: they are on/off states, not quantities. */
  const STACK = {
    deadeye: { first:0.12, extra:0.06, cap:0.30 },
    swift:   { first:0.10, extra:0.05, cap:0.25 },
  };
  function stackValue(kind, n){
    if(!n) return 0;
    const s = STACK[kind];
    return Math.min(s.cap, s.first + s.extra * (n - 1));
  }
  // Sidearm Saint's Absolution now carries its own crit chance. It used to only
  // heal ON a crit while granting no crit chance of its own, so the set did
  // literally nothing unless you ALSO spent a slot on a Deadeye part.
  const SAINT_CRIT = 0.15;

  /* ---- range falloff -----------------------------------------------------
     Damage scaled by the distance from the muzzle to the impact. Only the
     sniper has an entry; every other weapon is flat, because their range
     limit is spread, not damage.

     The LS-1 needs one because 65 base two-shots at ANY distance and the
     max-damage build used to one-shot at any distance, which made it the best
     shotgun in the game as well as the best sniper - measured TTK at 3u was
     0.07s. Full damage from 20u out, 45% at 6u and closer, linear between.

     Deliberately measured from where the shot was TAKEN, not from the
     shooter's current position: the round is in the air for up to a fifth of
     a second and the shooter may have closed the gap since. */
  const FALLOFF = {
    ls1: { near: 6, far: 20, floor: 0.45 },
  };
  function rangeMul(weaponId, dist){
    const f = FALLOFF[weaponId];
    if(!f) return 1;
    const d = Number(dist) || 0;
    if(d >= f.far)  return 1;
    if(d <= f.near) return f.floor;
    return f.floor + (1 - f.floor) * (d - f.near) / (f.far - f.near);
  }

  /* ---- ADS ---------------------------------------------------------------
     How much aiming down sights tightens the cone. This was 0.55, which left
     every weapon at a quarter of its listed spread while scoped: against a
     0.68u hit radius the Warden landed all eight pellets at 25u and NOTHING
     had a range ceiling, so no weapon could own a band. At 0.30 spread starts
     working again past ~15u and the shotgun/SMG/LMG fall off as they should.

     Takes the spread AFTER the 0.55 base-cone multiplier that both the client
     and the server apply, so pass (stats.spread * 0.55). */
  const ADS_SPREAD = 0.30;
  function fireSpread(spread, ads){
    const a = Math.max(0, Math.min(1, Number(ads) || 0));
    return Math.max(0, Number(spread) || 0) * (1 - a * ADS_SPREAD);
  }

  const weaponById = id => WEAPONS.find(w => w.id === id) || WEAPONS[0];

  // Which sets are active given the equipped parts for a weapon.
  function activeSets(weaponId, equipped) {
    const count = {};
    for (const s of SLOTS) {
      const p = equipped && equipped[s];
      if (p && p.set) count[p.set] = (count[p.set] || 0) + 1;
    }
    return SETS.filter(st => st.weapon === weaponId && (count[st.id] || 0) >= st.need);
  }

  /* Compute final weapon stats from base weapon + equipped parts.
     `equipped` is an object keyed by slot, each value either null or
     { slot, weapon, rarity, set?, mods:{dmg,rof,mag,reload,spread,speed}, ability? }.
     Identical logic to the client's computeLoadout — keep them in lockstep. */
  function computeStats(weaponId, equipped) {
    const w = weaponById(weaponId);
    const m = { dmg:1, rof:1, mag:1, reload:1, spread:1, speed:1 };
    const abilities = new Set();
    const count = {};                 // how many parts carry each ability

    for (const s of SLOTS) {
      const p = equipped && equipped[s];
      if (!p) continue;
      // guard: a part only counts if it actually belongs to this weapon+slot
      if (p.weapon && p.weapon !== weaponId) continue;
      if (p.slot && p.slot !== s) continue;
      if (p.mods) for (const k in p.mods) if (k in m) m[k] += p.mods[k];
      if (p.ability) { abilities.add(p.ability); count[p.ability] = (count[p.ability] || 0) + 1; }
    }
    const sets = activeSets(weaponId, equipped);
    for (const st of sets) abilities.add(st.effect);

    return {
      weaponId: w.id,
      type: w.type,
      dmg:    w.dmg * m.dmg,
      rof:    Math.max(45, w.rof / m.rof),
      mag:    Math.max(3, Math.round(w.mag * m.mag)),
      reload: Math.max(400, w.reload * m.reload),
      spread: Math.max(w.spread * 0.25, w.spread * m.spread),
      bspd:   w.bspd,
      pellets:w.pellets,
      speedMul: m.speed + stackValue('swift', count.swift || 0),
      crit:   Math.min(0.5, stackValue('deadeye', count.deadeye || 0)
                          + (abilities.has('critheal') ? SAINT_CRIT : 0)),
      abilities: Array.from(abilities),
      stacks: { deadeye: count.deadeye || 0, swift: count.swift || 0 },
    };
  }

  /* Server-side sanitizer: given an UNTRUSTED equipped-parts object from
     a client, clamp every mod to a sane range so a hacked client can't
     send { dmg: 9999 }. Returns a cleaned equipped object safe to feed
     into computeStats. This is the anti-cheat gate for phase-2 (pre-DB):
     the client still supplies its loadout, but the server refuses absurd
     values. Phase-3 replaces the input entirely with DB-read parts. */
  const MOD_CAPS = { dmg:0.6, rof:0.6, mag:1.5, reload:0.6, spread:0.6, speed:0.4 };
  const VALID_RARITY = { common:1, uncommon:1, rare:1, epic:1, legendary:1 };

  function sanitizeEquipped(weaponId, equipped) {
    const out = {};
    if (!equipped || typeof equipped !== 'object') return out;
    for (const s of SLOTS) {
      const p = equipped[s];
      if (!p || typeof p !== 'object') { out[s] = null; continue; }
      if (p.weapon && p.weapon !== weaponId) { out[s] = null; continue; }
      const cleanMods = {};
      if (p.mods && typeof p.mods === 'object') {
        for (const k in MOD_CAPS) {
          const v = Number(p.mods[k]);
          if (isFinite(v)) cleanMods[k] = Math.max(-MOD_CAPS[k], Math.min(MOD_CAPS[k], v));
        }
      }
      out[s] = {
        slot: s,
        weapon: weaponId,
        // name drives which geometry the viewmodel builds (vmOptic branches on it),
        // so remote avatars need it to render the right part, not a generic block
        name: typeof p.name === 'string' ? p.name.slice(0, 40) : '',
        rarity: VALID_RARITY[p.rarity] ? p.rarity : 'common',
        set: typeof p.set === 'string' ? p.set.slice(0, 24) : undefined,
        ability: typeof p.ability === 'string' ? p.ability.slice(0, 24) : undefined,
        mods: cleanMods,
      };
    }
    return out;
  }


  /* ---- loot generation (server-authoritative drops) ---- */
  const RAR = {
    common:    { w:44, scale:1.0 },
    uncommon:  { w:27, scale:1.6 },
    rare:      { w:16, scale:2.3 },
    epic:      { w:9,  scale:3.0 },
    legendary: { w:4,  scale:4.0 },
  };
  const RKEYS = Object.keys(RAR);
  const PART_POOL = {
    frame:[{name:'Polymer Frame',mods:{speed:0.03}},{name:'Forged Frame',mods:{dmg:0.03}},{name:'Recon Frame',mods:{spread:-0.03,speed:0.015}},{name:'War Frame',mods:{dmg:0.02,mag:0.05}}],
    barrel:[{name:'Ported Barrel',mods:{spread:-0.05}},{name:'Heavy Barrel',mods:{dmg:0.035,spread:0.015}},{name:'CQB Barrel',mods:{rof:0.03}},{name:'Match Barrel',mods:{dmg:0.025,spread:-0.02}}],
    magazine:[{name:'Extended Mag',mods:{mag:0.10}},{name:'Quickload Mag',mods:{reload:-0.06}},{name:'Drum Feed',mods:{mag:0.14,reload:0.03}},{name:'Compact Mag',mods:{reload:-0.04,mag:-0.04,rof:0.02}}],
    foregrip:[{name:'Vertical Grip',mods:{spread:-0.04}},{name:'Angled Grip',mods:{rof:0.025}},{name:'Skeleton Grip',mods:{speed:0.02}},{name:'Tactical Grip',mods:{spread:-0.025,rof:0.015}}],
    stock:[{name:'Padded Stock',mods:{spread:-0.03}},{name:'Marksman Stock',mods:{dmg:0.02,spread:-0.015}},{name:'CQB Stock',mods:{speed:0.025}},{name:'Skeleton Stock',mods:{speed:0.02,rof:0.01}}],
    optic:[{name:'Red Dot',mods:{spread:-0.035}},{name:'Holo Sight',mods:{spread:-0.025,rof:0.01}},{name:'ACOG-4',mods:{dmg:0.03}},{name:'Iron Ring',mods:{speed:0.015,spread:-0.015}}],
  };
  /* Set drop weight ~ piece count, so a 4-piece set is not punished twice: once
     for needing more pieces and again for each being rarer. */
  const SET_WEIGHT = st => Object.keys(st.pieces).length;
  function pickSetWeighted(rnd){
    const total = SETS.reduce((a, st) => a + SET_WEIGHT(st), 0);
    let r = (rnd ? rnd() : Math.random()) * total;
    for(const st of SETS){ r -= SET_WEIGHT(st); if(r <= 0) return st; }
    return SETS[0];
  }
  function rollRarity(){
    const total = RKEYS.reduce((a,k)=>a+RAR[k].w,0);
    let r = Math.random()*total;
    for(const k of RKEYS){ r -= RAR[k].w; if(r<=0) return k; }
    return 'common';
  }
  function scaleMods(mods, rarity){
    const s = RAR[rarity].scale, out = {};
    for(const k in mods) out[k] = +(mods[k]*s).toFixed(3);
    return out;
  }
  // server-side drop: same odds as the client, but produced by the SERVER so
  // the client can never fabricate a part. Returns a part object or null.
  // Ability pool. minR is an index into RKEYS: 2=rare, 3=epic, 4=legendary.
  // Mirrors ABILITIES in renderer/index.html — the client owns the display
  // names and descriptions; the server only needs the ids and thresholds.
  const ABILITY_MINR = {
    incendiary:2, cryo:2, deadeye:2, swift:2,
    pierce:3, ricochet:3,
    vampiric:3, explosive:4,   // vampiric was legendary-gated but worth less than a RARE deadeye
  };
  function rollAbility(rarity){
    const ri = RKEYS.indexOf(rarity);
    if(ri < 2) return null;
    const chance = ri===2 ? 0.55 : ri===3 ? 0.8 : 1.0;
    if(Math.random() > chance) return null;
    const pool = Object.keys(ABILITY_MINR).filter(a => ABILITY_MINR[a] <= ri);
    return pool[Math.floor(Math.random()*pool.length)];
  }

  /* End-of-match drop, rolled SERVER-SIDE so a hacked client can't mint loot.
     Mirrors the client's rollDrop(kills, true): same 0.35+kills curve, same
     15% set-piece branch, same ability rolls. Offline callers stamp the result
     bound:true, so bot-farmed set pieces are usable but not auctionable. */
  function rollServerDrop(kills){
    const chance = 0.35 + Math.min((kills||0)*0.02, 0.25);
    if(Math.random() > chance) return null;
    // 20% of drops are set pieces (was 15%). Raised alongside the weighting below
    // so every set gets FASTER to finish and none gets slower.
    if(Math.random() < 0.20){
      // Weighted by piece count. A flat 1-in-6 meant a 4-piece set took 556 matches
      // to finish while a 2-piece took 200 - so the EPIC 3-piece sets were a longer
      // grind than the LEGENDARY 2-piece one, which is backwards. Weighting by
      // pieces brings them to 200 / 244 / 278.
      const set = pickSetWeighted();   // Math.random(); the store never sells set pieces
      const slots = Object.keys(set.pieces);
      const slot = slots[Math.floor(Math.random()*slots.length)];
      const base = PART_POOL[slot][Math.floor(Math.random()*PART_POOL[slot].length)];
      return { weapon:set.weapon, slot, rarity:set.rarity, name:set.pieces[slot],
               mods:scaleMods(base.mods, set.rarity), ability:null, set:set.id };
    }
    const wid = WEAPONS[Math.floor(Math.random()*WEAPONS.length)].id;
    const slot = SLOTS[Math.floor(Math.random()*SLOTS.length)];
    const rarity = rollRarity();
    const tpl = PART_POOL[slot][Math.floor(Math.random()*PART_POOL[slot].length)];
    return { weapon:wid, slot, rarity, name:tpl.name,
             mods:scaleMods(tpl.mods, rarity), ability:rollAbility(rarity), set:null };
  }


  /* ---- daily store -------------------------------------------------------
     Eight parts per player per day, refreshing at 7pm America/Chicago.

     Nothing is stored. The whole shop is a pure function of (player id, store
     day), so the server can re-derive exactly what a client was shown and
     validate a purchase against it — you cannot reroll by reloading, and you
     cannot buy an item you were never offered. Different players get different
     shops because the player id is in the seed.

     Real Chicago wall-clock, not a fixed UTC offset, so it stays 7pm through
     daylight saving rather than drifting to 8pm for half the year. */
  const STORE_TZ = 'America/Chicago';
  const STORE_HOUR = 19;
  const STORE_SLOTS = ['common','common','uncommon','uncommon','rare','rare','epic','BONUS'];
  const STORE_BONUS_LEGENDARY = 0.25;         // the 8th slot: 75% epic, 25% legendary
  const STORE_PRICE = { common:1000, uncommon:2500, rare:5000, epic:10000, legendary:25000 };

  function tzParts(ms){
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: STORE_TZ, hour12:false,
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const o = {};
    for(const part of dtf.formatToParts(new Date(ms))) if(part.type !== 'literal') o[part.type] = +part.value;
    if(o.hour === 24) o.hour = 0;             // some ICU builds report midnight as 24
    return o;
  }
  // UTC instant of a given Chicago wall-clock time. Solved twice so a DST
  // transition inside the guess corrects itself.
  function localToUtc(y, mo, d, h){
    const want = Date.UTC(y, mo - 1, d, h, 0, 0);
    let guess = want;
    for(let i = 0; i < 2; i++){
      const p2 = tzParts(guess);
      const off = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second) - (guess - guess % 1000);
      guess = want - off;
    }
    return guess;
  }
  const pad2 = n => (n < 10 ? '0' : '') + n;
  /* The window containing `nowMs`: when it opened, when it closes, and the
     Chicago calendar date of its opening, which is the seed key. */
  function storeWindow(nowMs){
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const p = tzParts(now);
    let start = localToUtc(p.year, p.month, p.day, STORE_HOUR);
    if(start > now){                           // before 7pm: the live window opened yesterday
      const q = tzParts(start - 24 * 3600 * 1000);
      start = localToUtc(q.year, q.month, q.day, STORE_HOUR);
    }
    const n = tzParts(start + 26 * 3600 * 1000);   // +26h lands safely on the next Chicago day
    const next = localToUtc(n.year, n.month, n.day, STORE_HOUR);
    const k = tzParts(start + 3600 * 1000);        // an hour in, so the date is unambiguously the window's
    return { start, next, key: k.year + '-' + pad2(k.month) + '-' + pad2(k.day) };
  }

  // FNV-1a -> mulberry32. Deterministic and identical in Node and the browser,
  // which is the whole point: both sides must derive the same eight parts.
  function seededRng(str){
    let h = 2166136261 >>> 0;
    for(let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return function(){
      h = (h + 0x6D2B79F5) >>> 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* The shop for one player on one day. Set pieces are deliberately excluded:
     they are the grind reward, and putting them behind credits would undercut
     the only long-term chase in the game. Abilities roll on the normal rarity
     gates, so a 10,000-credit epic is worth the same as a dropped one. */
  function rollDailyStore(playerKey, dayKey){
    const rnd = seededRng(String(playerKey || 'anon') + '|' + String(dayKey));
    const pick = arr => arr[Math.floor(rnd() * arr.length)];
    return STORE_SLOTS.map((want, i) => {
      const rarity = want !== 'BONUS' ? want
        : (rnd() < STORE_BONUS_LEGENDARY ? 'legendary' : 'epic');
      const weapon = pick(WEAPONS).id;
      const slot = pick(SLOTS);
      const tpl = pick(PART_POOL[slot]);
      // same ability gates as a drop, driven by the seeded stream
      const ri = RKEYS.indexOf(rarity);
      let ability = null;
      if(ri >= 2){
        const chance = ri === 2 ? 0.55 : ri === 3 ? 0.8 : 1.0;
        if(rnd() <= chance){
          const pool = Object.keys(ABILITY_MINR).filter(a => ABILITY_MINR[a] <= ri);
          ability = pool[Math.floor(rnd() * pool.length)];
        }
      }
      return { idx:i, weapon, slot, rarity, name:tpl.name,
               mods:scaleMods(tpl.mods, rarity), ability, set:null,
               price: STORE_PRICE[rarity] };
    });
  }

  const api = { WEAPONS, SLOTS, SETS, weaponById, activeSets, computeStats, sanitizeEquipped,
                rollServerDrop, storeWindow, rollDailyStore, STORE_PRICE, STORE_SLOTS,
                FALLOFF, rangeMul, ADS_SPREAD, fireSpread,
                PART_POOL, RAR };   // exported so the balance test can be exhaustive

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  else root.LoadoutCore = api;                                              // browser
})(typeof window !== 'undefined' ? window : this);

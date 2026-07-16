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
    {id:'havoc9',  name:'Havoc-9',       type:'SMG',           unlock:3,  dmg:8,  rof:95,   mag:30, reload:1500, spread:0.110, bspd:520,  pellets:1},
    {id:'vkraptor',name:'VK Raptor',     type:'Assault Rifle', unlock:5,  dmg:12, rof:130,  mag:30, reload:1700, spread:0.070, bspd:640,  pellets:1},
    {id:'warden',  name:'Warden W12',    type:'Shotgun',       unlock:8,  dmg:8,  rof:750,  mag:6,  reload:2000, spread:0.150, bspd:560,  pellets:8},
    {id:'ls1',     name:'LS-1 Longshot', type:'Sniper',        unlock:12, dmg:65, rof:1150, mag:5,  reload:2100, spread:0.005, bspd:1150, pellets:1},
    {id:'goliath', name:'Goliath GX',    type:'LMG',           unlock:15, dmg:11, rof:110,  mag:80, reload:3200, spread:0.100, bspd:600,  pellets:1},
  ];

  const SLOTS = ['frame','barrel','magazine','foregrip','stock','optic'];

  const SETS = [
    {id:'saint',   weapon:'m17',      need:2, effect:'critheal'},
    {id:'hornet',  weapon:'havoc9',   need:3, effect:'homing'},
    {id:'dragon',  weapon:'vkraptor', need:2, effect:'fire_nova'},
    {id:'bulwark', weapon:'warden',   need:3, effect:'killshield'},
    {id:'ghost',   weapon:'ls1',      need:2, effect:'pierce_all'},
    {id:'jugg',    weapon:'goliath',  need:4, effect:'firing_resist'},
  ];

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

    for (const s of SLOTS) {
      const p = equipped && equipped[s];
      if (!p) continue;
      // guard: a part only counts if it actually belongs to this weapon+slot
      if (p.weapon && p.weapon !== weaponId) continue;
      if (p.slot && p.slot !== s) continue;
      if (p.mods) for (const k in p.mods) if (k in m) m[k] += p.mods[k];
      if (p.ability) abilities.add(p.ability);
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
      speedMul: m.speed + (abilities.has('swift') ? 0.10 : 0),
      crit:   abilities.has('deadeye') ? 0.12 : 0,
      abilities: Array.from(abilities),
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
  function rollServerDrop(kills){
    const chance = 0.35 + Math.min((kills||0)*0.02, 0.25);
    if(Math.random() > chance) return null;
    const wid = WEAPONS[Math.floor(Math.random()*WEAPONS.length)].id;
    const slot = SLOTS[Math.floor(Math.random()*SLOTS.length)];
    const rarity = rollRarity();
    const tpl = PART_POOL[slot][Math.floor(Math.random()*PART_POOL[slot].length)];
    return { weapon:wid, slot, rarity, name:tpl.name, mods:scaleMods(tpl.mods, rarity), set:null };
  }

  const api = { WEAPONS, SLOTS, SETS, weaponById, activeSets, computeStats, sanitizeEquipped, rollServerDrop };

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  else root.LoadoutCore = api;                                              // browser
})(typeof window !== 'undefined' ? window : this);

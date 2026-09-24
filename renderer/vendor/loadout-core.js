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

  /* Weapon damage. Measured against the whole field as freebuilds - six legendary
     parts, no set - every build against every other at five ranges and three lead
     qualities. The M17 and the Warden were 38% and 44% while three automatics sat
     at 68-70%, so a new player's first two guns were free kills for anyone holding
     a third.

     Raising those two closed the ladder from a 32-point spread to 22, and the top
     three fell to 64-66 on their own, purely from meeting real opposition. Nothing
     was nerfed to do it. Every attempt to nerf down instead moved nothing: the
     Raptor lost 1 damage, 80 bullet speed and gained 29% spread in three separate
     runs and finished within a point of 70% each time - those are not the stats
     deciding these fights. */
  const WEAPONS = [
    // 13 -> 16. Unlock 1, so it should be the weakest gun; 38% against the field
    // is not weakest, it is unusable, and it is the only thing a new account owns.
    {id:'m17',     name:'M17',           type:'Pistol',        unlock:1,  dmg:16, rof:230,  mag:12, reload:1100, spread:0.050, bspd:560,  pellets:1},
    /* spread 0.110 -> 0.120. Paired with the Raptor's damage cut, not independent of
       it: at dmg 11 the rifle's lead over this at 45u fell to 9.5% and balance.test.js
       failed "the Havoc-9 loses badly to it at range". The role gap belongs in the
       SMG's own accuracy rather than in the rifle's damage - fixing it on the Raptor's
       side would have handed back the balance win it was bought with. 2.21s to kill at
       45u against the rifle's 1.68s; up close it still beats the rifle, which is the
       trade an SMG is supposed to make. */
    {id:'havoc9',  name:'Havoc-9',       type:'SMG',           unlock:3,  dmg:10, rof:95,   mag:30, reload:1500, spread:0.120, bspd:520,  pellets:1},
    /* 12 -> 11. It was the all-rounder with no weakness: near-top damage, the best
       accuracy of any automatic, and the fastest round that is not a sniper's. On a
       full six-ability build that compounded - crit, lifesteal and burn all scale off
       damage per shot - and it pulled 6.3 points clear while everything else flattened.
       One point off the top of that chain drops the lead to 1.1 and tightens
       best-to-worst from 20 to 14.
       Spread and bullet speed are deliberately untouched: what it loses is being best
       at everything, not what makes it a VK Raptor.

       I tried tightening spread to 0.070 to pay back the range identity and backed it
       out. It appeared to cost the Raptor 12 points at the lower tiers, which is not
       a thing 15 thousandths of spread can do - fitTemplate picks parts by one-way TTK
       rather than by duel win rate, and the tighter base flipped it from a damage
       build (dmg 14.52, rof 100) to an accuracy build (dmg 13.20, rof 114) that no
       player would choose. The harness changed its mind; the gun did not. */
    {id:'vkraptor',name:'VK Raptor',     type:'Assault Rifle', unlock:5,  dmg:11, rof:130,  mag:30, reload:1700, spread:0.085, bspd:640,  pellets:1},
    // 8 -> 9 per pellet, so 64 -> 72 a shell. An unlock-8 weapon has no business
    // at 44%. A 700ms cadence means one missed shell is most of a second with
    // nothing coming out, and the damage has to be worth that wait.
    {id:'warden',  name:'Warden W12',    type:'Shotgun',       unlock:8,  dmg:9,  rof:700,  mag:6,  reload:2000, spread:0.120, bspd:560,  pellets:8},
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
    /* need 3 -> 2. Three pieces was the wrong price on this weapon specifically: half
       your slots gone and half your parts dropped from legendary to epic, on the gun
       whose entire argument is firing fast enough to proc things. Measured at -8.6pt
       against its own freebuild - the worst set in the game, and a trap for anyone who
       liked the perk. At two pieces it is -1.2pt, level with the Havoc's own ceiling.

       Doubling the seeker cadence instead bought the same 7 points, which is how we
       know homing was never the weak part. Doing both put it top of the game at +8.4pt,
       i.e. mandatory, which is the opposite of a choice.

       All three pieces stay in the pool and ANY TWO activate it - activeSets tests
       >= need - so no inventory changes and nobody loses a part. It also brings the
       set in line with Dragonfire, Ghost and Saint, and cuts the grind to finish it
       from ~244 matches to ~200. */
    /* epic -> legendary. Two pieces at epic left Hornet at -0.9pt against a plain
       Havoc freebuild: no longer a trap after the piece-count cut, but still never
       the best thing to do with the gun. Legendary pieces scale their mods 4.0
       instead of 3.0 and put it at +1.7pt, 4th of 378 builds, without displacing the
       top - Juggernaut Goliath stays there at 70.6%.

       Paying in part quality rather than in a stronger effect is deliberate. Doubling
       the seeker cadence instead reached +8.4pt and made Hornet the single best build
       in the game, which is a set nobody chooses, they just take.

       It also lines up with the other legendary set: Ghost Protocol is 2pc legendary
       too. The distinction that earns it is effect strength - Dragonfire's molten
       bonus is a bigger effect than homing, so Dragonfire stays epic and Hornet gets
       the better parts to compensate.

       Drop RATE is unchanged: rollServerDrop picks a set, then stamps the piece with
       set.rarity, so this is a straight upgrade to the pieces and not a longer grind.
       Scrap value per piece goes 75 -> 200 as a side effect. */
    {id:'hornet',  weapon:'havoc9',   need:2, effect:'homing',        rarity:'legendary',
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
    // sniper: weak up close, full damage from 20u out
    ls1:    { d0: 6, m0: 0.45, d1: 20, m1: 1.00 },
    // shotgun: full damage to 8u, 45% by 22u. The Warden needed this for the
    // same reason but in the opposite direction - 8 pellets x 8 applies at ANY
    // distance, so it two-shot across the map and owned every band from 3u to
    // 22u. A shotgun's range limit is supposed to be its pattern; this makes
    // damage agree with that instead of fighting it.
    warden: { d0: 8, m0: 1.00, d1: 22, m1: 0.45 },
  };
  function rangeMul(weaponId, dist){
    const f = FALLOFF[weaponId];
    if(!f) return 1;
    const d = Number(dist) || 0;
    if(d <= f.d0) return f.m0;
    if(d >= f.d1) return f.m1;
    return f.m0 + (f.m1 - f.m0) * (d - f.d0) / (f.d1 - f.d0);
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

  /* The tightest cone any build may reach, as a fraction of the weapon's base
     spread. This was 0.25, and six spread parts is enough to hit the floor: the
     Warden went 0.120 -> 0.030, which after the base cone and ADS is a 0.40u
     pattern at 35u against a 0.68u target. It landed 86% of its pellets across
     the map. Spread-stacking was strictly the best thing to do with six slots
     on every weapon, which is also why no optimal build took a damage part. */
  const SPREAD_FLOOR = 0.50;

  /* ---- HE Payload --------------------------------------------------------
     Splash used to be a flat 10 per hit, which means it scaled with how OFTEN
     you hit - so the fastest weapon in the game won by construction. The
     Havoc-9 owned all eight PvE bands and beat the LS-1 by 239%.

     Scaling it off the damage that triggered it takes rate of fire out of the
     equation: a fast, weak gun splashes little and often, a slow, heavy one
     splashes hard and rarely, and splash DPS lands within a few percent across
     the roster. It also makes the legendary itself better - flat splash was
     worth 51% faster clears on an SMG and 19% on a sniper, so the same drop was
     a jackpot or a dud depending on which gun you played. This is 34-42% on
     everything.

     Fed the post-falloff, PRE-crit damage: a crit should double what it hits,
     not double the whole blast radius as well. */
  /* ---- Hornet Swarm (homing) --------------------------------------------
     Third pass. The set was reported as unnoticeable, and the measurement said
     why: the Havoc-9 fights at 3-6u, where you already hit 94-100% WITHOUT the
     set, so there was no headroom for a uniform nudge to work in. Turning the
     dial up could not fix that - 100% is 100%.

     So the fix is not strength, it is legibility. One round in `every` is a
     full-strength seeker and the rest fly perfectly straight. Same idea as the
     player suggested: you SEE the set work, because two rounds go where you
     pointed and the third visibly whips onto target.

     Hit rate at 8u on a target strafing at 6 u/s:

                            no lead   quarter   half
       no set                  44%      65%      86%
       1.4.28 (uniform nudge)  68%      89%     100%
       this (1 in 2 seeks)     72%      82%      93%

     Note the SHAPE, which is the point. Better than 1.4.28 at rescuing a shot
     you would clearly have whiffed, WORSE at guaranteeing a near miss. The
     "I pointed vaguely at him and it all landed" feeling came from near misses
     being automatic, and this gives that up deliberately.

     Cheaper, too: half the rounds skip the per-tick target scan entirely.

     vert stays 0. The seeker rounds are strong enough horizontally; snapping
     them to chest height as well would hand over vertical aim for free.

     The law is pure pursuit - it steers at where the target IS, never where it
     is going. That caps what it can do at range and is why `seek` stays tight:
     widening it made a 16u shot go from 19% to 1%, because the round spends
     the whole flight aiming behind a moving target. */
  const HOMING = {
    every: 2,     // 1 round in this many is a seeker; the rest fly straight
    seek: 8,      // acquisition radius, world units
    cone: 0.35,   // only bend toward a target within this angle of travel, rad
    turn: 1.2,    // rad/sec - full authority, but only on the seeker rounds
    vert: 0,      // no vertical assist - aim up and down yourself
  };

  /* ---- Bulwark (killshield) ----------------------------------------------
     The fraction of an incoming hit a shield may absorb. It used to be all of
     it, which made the set an unbounded economy rather than a bonus: you gain
     25 shield per kill, so if a fight costs you 25 or less you take ZERO hp
     damage and never die. At the Warden's 0.45s close-range TTK a fight costs
     about 14, so the shotgun set was simply immortality while you kept killing.

     Measured kills per life against a bare build, averaged over 15-50 damage
     per fight: before 50.94x, this 2.28x. For scale a single Vampiric part is
     2.36x and the 4-piece LEGENDARY Juggernaut set is 1.63x.

     Soaking only part of a hit is what removes the SHAPE of the problem -
     lowering the numbers just moves the break-even down, and decay made the
     set swing between 21x and 1.6x depending on how busy the lobby was. With
     a soak you always lose some hp, at every damage level, in every lobby.

     Raised 0.60 -> 0.75 alongside the pool. 0.75 is the saturation point: past
     it the pool empties before the fraction binds, so 90% and 100% measure
     identical to 75% - and 100% is exactly the unbounded case above, because
     nothing leaks to hp at all. It must not go higher while the pool is 50.

     (Deliberately placed AFTER the HOMING block: it sat between the Hornet
     comment and HOMING, and editing that region by slice deleted this constant
     three separate times in one session. The module still PARSED every time.) */
  /* Dragon set (EXHALE). The old set was a one-frame blast on a kill, which
     measured at 0.14 enemies caught - one kill in seven did anything at all,
     for the price of two ability slots. Three parts now:
       - the set ignites on its own, so it is never "Incendiary but worse"
       - a burning target takes MOLTEN more from the person who lit it, which
         is the part that pays the set's TTK cost (measured -5% vs no set)
       - the fire spreads, checked across the whole burn instead of one instant:
         42% of ignitions catch someone, against the nova's 13%
     SPREAD_DUR is shorter than a direct burn and spread fire never spreads
     again - without that, one ignition chain-reacts through a choke and the
     whole lobby burns forever. */
  const DRAGON = { molten: 0.15, spreadR: 4, spreadDur: 1.5, spreadEvery: 0.5 };

  /* Juggernaut's flat reduction. It was a bare 0.7 in server/index.js AND a second bare
   0.7 in the renderer, which is the same two-copies-of-a-number shape that let the PvP
   and offline paths of this very set drift apart before. It also means the balance model
   can read the shipped value instead of restating it. */
/* 0.30 -> 0.25. Juggernaut measured at a 75.1% ceiling - top of the game by 4.4
   points, seven of the top nine builds - and beat its nearest rival at EVERY range,
   93% of the time inside 10m. It had no losing condition.

   That was invisible until the duel model was fixed to scale set pieces by their own
   set's rarity; Juggernaut is legendary and four of its pieces were being measured as
   epic. The earlier reading of 68.8% with a clean 16m crossover was an artifact.

   25% puts the two ceilings level (71.2 Goliath, 70.6 Raptor) and restores a real
   crossover: the Goliath owns inside 16m, the Raptor owns past it. 20% measured
   better still - it gives the Raptor the higher ceiling and the crossover moves to
   14m - but this is the headline number on a legendary four-piece set, the most
   expensive thing in the game to assemble, and a third off it is a lot to take on
   duel evidence alone. The model never sees the Goliath survive a three-way fight on
   the hill, which is what the resist is for. 20% is the fallback if it still feels
   inevitable in Crucible. */
const JUGG_RESIST = 0.25;
const SHIELD_SOAK = 0.75;

  /* The shield POOL, which is the lever that actually adds mitigation. The
     absorb is `min(shield, hit * SOAK)` and the pool drops by what it absorbs,
     so a shield's TOTAL mitigation is its pool size no matter what the soak
     fraction is - raising the soak alone measured 0.878 -> 0.874 kills/life,
     i.e. nothing.

     At 25/50 Bulwark ran 0.89 kills/life in the close band against the Warden
     FREEBUILD's 1.25: the set cost three ability slots and gave back less than
     the abilities it displaced. At 50/75 it is 1.23 - even - and mid and long
     are untouched (0.24 / 0.05), so the Warden stays the polarised close-range
     weapon it should be. Longest life over 14k lives went 7 -> 13, not runaway.

     These live here because the cap used to be a bare 50 in four places,
     including the HUD bar's scaleX(shield/50), which silently overflowed its
     track the moment the cap moved. */
  const BULWARK = { perKill: 50, cap: 75 };

  /* ---- AP Rounds ---------------------------------------------------------
     Was "shots pierce through one enemy", which measured at 2.8% of shots even
     in a full seven-player FFA and 0.5% in a duel - two enemies almost never
     line up inside a 0.68u corridor. Comfortably the weakest thing in the game,
     at an EPIC gate.

     Armour-piercing should punch through cover, not through people. A round
     now carries a budget of solid wall it can cross, and deals reduced damage
     once it has. Measured against the real map geometry, share of ALL shots
     this opens up:

                        foundry  dustrelay  blacksite
       budget 1.5u        11.7%      7.7%      11.4%
       budget 2.5u        31.7%     13.2%      32.5%
       AP Rounds today     2.8%      2.8%       2.8%

     1.5u is deliberate: every long barrier on these maps is 1.5u deep and the
     pillars and crates are 4u, so thin cover stops being absolute while the
     real structure still stops a bullet. You are firing blind through it
     either way, so it rewards knowing where someone is rather than luck. */
  const AP_WALL = { budget: 1.8, dmgMul: 0.5 };
  /* 1.8, not 1.5. The barriers ARE 1.5u deep, and a budget equal to the wall is
     consumed to exactly zero at the far face - the round dies inside it. At 1.5
     the only shots that got through were ones clipping a corner, which is not
     the effect. 1.8 crosses a barrier you are FACING and still fails on an
     angled path (a 45 degree line through the same wall is 2.12u of solid).
     Opens 23% of shots on foundry and blacksite, 11% on dustrelay. */

  /* ---- Ghost Protocol ----------------------------------------------------
     The LS-1's legendary 2-piece set granted pierce-everything, which multiplies
     the 2.8% above - it was the worst set in the game, at the highest rarity.

     Travel time is the whole difficulty of sniping: at 45u a round is in the
     air 0.35s and a strafing target covers 2.1u, three hitbox radii. And the
     LS-1 has 0.005 spread, so it is binary - lead correctly and you always
     hit, lead slightly wrong and you always miss, with nothing in between.

     So the set attacks travel time. Hit% on a strafing target, 25% lead:

                    25u    35u    45u
       live 1150     0%     0%     0%
       x1.75        100%    44%     0%
       x2.17        100%   100%    31%     <- hands you 35u for free

     Shipped at x1.75 first and it was reported as not feeling special, which
     was fair: nothing in the build model could even SEE the change - the LS-1
     scored an identical 3.4 kills per life and identical ttk at x1.75, x2.2,
     x2.6 and x3.0, because that model fires at a stationary target and travel
     time only matters against a moving one. So x1.75 was caution against a
     ceiling the data never showed.

                    25u    35u    45u    55u
       x1.75        100%    44%     0%     0%
       x2.6         100%   100%   100%    28%

     x2.6 is 2990 u/s: a 45u shot arrives in 0.135s, about four ticks. Still a
     projectile, but one that crosses the arena before a strafing target can
     leave the space it was in. Past 55u you are leading again. */
  const OVERCHARGE = 2.6;

  /* Scoping costs 40% of your movement speed. For a sniper that is the whole
     tax - you cannot reposition while aiming - and Ghost Protocol lifts it.

     Why this and not more damage: the LS-1's crit ALREADY one-shots at 190, so
     its ceiling is maxed and no set can raise it that way. A guaranteed crit
     measured at 12.2 kills per life against a field of 4.5 to 6.3, which is
     double the best build in the game. The only room left is reliability and
     utility.

     Measured worth of moving at full speed while scoped: x1.25 effective
     health while you are aiming, comparable to four Featherweight parts. And
     it is a CEILING effect - it pays only if you actually move while scoped,
     where the speed buff is a floor effect that only pays if you lead badly.
     Together the set covers both: rank against the field goes #1/#1/#4/#9 by
     lead quality with speed alone, and #1/#1/#2/#4 with both. */
  const ADS_SLOW = 0.40;
  function adsSlow(abilities){
    const has = abilities && (abilities.indexOf ? abilities.indexOf('pierce_all') >= 0
                                                : abilities.has('pierce_all'));
    return has ? 0 : ADS_SLOW;
  }

  /* How long you stay dead. Shared, because the server owns respawn in live
     matches and the client owns it offline - if these drift, one mode gets a
     killcam that outlives the corpse. 4.5s rather than 2.5s: the eliminated-by
     card has a weapon, six parts and their abilities on it, and 2.5s is not
     enough time to read that. */
  const RESPAWN_MS = 4500;

  /* Which modes write to the career kill/death record.

     K/D is read as a claim about how you do against other people on even terms.
     Campaign is a horde mode - kills are free and deaths are a single-life reset,
     so it inflates one side and understates the other. TDM and KotH are objective
     modes where trading your life for the point is the correct play, and a record
     that punishes that teaches people to stop playing the objective. That leaves
     the two straight fights.

     Shared with the client rather than duplicated: the client banks stats when it
     is offline and the server banks them when it is not, and the two disagreeing
     is how you get a K/D that depends on your connection. */
  /* Part mods, small enough to sit in a Colyseus string field.

     They cannot be derived from the part's name on the receiving end: a set piece
     takes its mods from a RANDOM template of its slot, so two "Ghost Bore" barrels
     are genuinely different guns. Without this the death card could show a killer's
     set pieces with no numbers on them, which are exactly the ones worth seeing.

     Thousandths as integers - mods are already rounded to 3 places by scaleMods, so
     this is lossless and about a third the characters of the decimals. */
  const MOD_KEYS = ['dmg', 'rof', 'mag', 'reload', 'spread', 'speed'];
  function encodeMods(mods){
    if(!mods) return '';
    const out = [];
    for(const k of MOD_KEYS){
      const v = Number(mods[k]);
      if(v) out.push(k + ':' + Math.round(v * 1000));
    }
    return out.join(',');
  }
  function decodeMods(str){
    const out = {};
    if(!str) return out;
    for(const pair of String(str).split(',')){
      const i = pair.indexOf(':');
      if(i < 1) continue;
      const k = pair.slice(0, i);
      if(MOD_KEYS.indexOf(k) < 0) continue;       // never trust a key off the wire
      const v = Number(pair.slice(i + 1));
      if(isFinite(v) && v) out[k] = v / 1000;
    }
    return out;
  }

  const KD_MODES = ['ffa', 'live'];
  function countsForKD(mode){ return KD_MODES.indexOf(String(mode || '')) >= 0; }

  const HE_SPLASH_FRAC = 0.60;
  function splashDamage(dealt){
    return Math.max(0, Number(dealt) || 0) * HE_SPLASH_FRAC;
  }
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
      spread: Math.max(w.spread * SPREAD_FLOOR, w.spread * m.spread),
      bspd:   w.bspd * (abilities.has('pierce_all') ? OVERCHARGE : 1),   // Ghost Protocol
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
                FALLOFF, rangeMul, ADS_SPREAD, fireSpread, SPREAD_FLOOR, DRAGON,
                BULWARK,
                HE_SPLASH_FRAC, splashDamage, HOMING, JUGG_RESIST, SHIELD_SOAK,
                AP_WALL, OVERCHARGE, ADS_SLOW, adsSlow, RESPAWN_MS,
                KD_MODES, countsForKD,
                MOD_KEYS, encodeMods, decodeMods,
                PART_POOL, RAR };   // exported so the balance test can be exhaustive

  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  else root.LoadoutCore = api;                                              // browser
})(typeof window !== 'undefined' ? window : this);

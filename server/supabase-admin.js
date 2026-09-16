/* ============================================================
   GUNFORGE server-side Supabase admin.
   Holds the SERVICE-ROLE key (from env, never hardcoded) — this is
   the ONLY component allowed to write credits and parts. It bypasses
   RLS, so it must be trusted and server-only.

   Env vars required (set on the Oracle box, never committed):
     SUPABASE_URL          e.g. https://xxxx.supabase.co
     SUPABASE_SERVICE_KEY  the secret 'sb_secret_...' key
   If unset, the server runs in "no-economy" mode: matches work,
   but rewards aren't persisted (safe local-dev default).
   ============================================================ */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = !!(SUPABASE_URL && SERVICE_KEY);

function adminHeaders(extra) {
  return Object.assign({
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

// Verify a player's JWT and return their auth uid (or null if invalid).
// This is how the server trusts "you are account X" instead of taking
// the client's word for it.
async function verifyUser(jwt) {
  if (!ENABLED || !jwt) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + jwt },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}

// Look up the players.id (primary key) for an auth uid.
async function playerIdForUid(uid) {
  if (!ENABLED || !uid) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/players?select=id&auth_uid=eq.' + uid, { headers: adminHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows.length ? rows[0].id : null;
  } catch (e) { return null; }
}

/* Claim a match id so a replayed reward can't be granted twice.
   Returns true if this is the first time we've seen the id (caller should
   grant), false if it was already processed (caller should skip).
   Inserts with resolution=ignore-duplicates: PostgREST returns the new row on
   success and an empty array when the id already existed. On any error we
   return true — a rare double grant is a better failure than silently eating
   a player's reward, and if Supabase is unreachable the grant will fail too. */
async function claimMatch(mid, playerId){
  if(!ENABLED || !mid || !playerId) return true;   // no id -> nothing to dedupe against
  try{
    const r = await fetch(SUPABASE_URL + '/rest/v1/processed_matches', {
      method: 'POST',
      headers: adminHeaders({ 'Prefer': 'resolution=ignore-duplicates,return=representation' }),
      body: JSON.stringify({ mid: String(mid).slice(0, 64), player_id: playerId }),
    });
    if(!r.ok){
      console.error('[supabase] claimMatch failed', r.status, await r.text().catch(() => ''));
      return true;
    }
    const rows = await r.json().catch(() => []);
    return rows.length > 0;        // [] => the id was already there => duplicate
  }catch(e){
    console.error('[supabase] claimMatch threw', e && e.message || e);
    return true;
  }
}

/* How many parts this player is holding, excluding anything with an active
   listing (escrowed, not occupying locker space). Returns null if we can't tell,
   so callers can decide whether to grant rather than guessing a number. */
async function partsHeld(playerId){
  if(!ENABLED || !playerId) return null;
  try{
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/parts_held', {
      method: 'POST', headers: adminHeaders(),
      body: JSON.stringify({ p_player: playerId }),
    });
    if(!r.ok){
      console.error('[supabase] parts_held failed', r.status, await r.text().catch(() => ''));
      return null;
    }
    const n = await r.json().catch(() => null);
    return typeof n === 'number' ? n : null;
  }catch(e){
    console.error('[supabase] parts_held threw', e && e.message || e);
    return null;
  }
}

const PART_CAP = 200;   // keep in step with part_cap() in migration 004

/* Grant a match reward to a verified account. Atomic-ish: credits via
   an RPC that adds (never sets), parts via insert. Returns what was granted. */
async function grantReward(playerId, { credits = 0, xp = 0, part = null, statsDelta = null }) {
  if (!ENABLED || !playerId) return { ok: false, reason: 'no-economy' };
  const granted = { credits: 0, xp: 0, part: null };
  try {
    // credits + xp + stats: use the add_progress RPC (server-defined, additive, overflow-safe)
    if (credits || xp || statsDelta) {
      const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/add_progress', {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({
          p_player: playerId,
          p_credits: credits | 0,
          p_xp: xp | 0,
          p_stats: statsDelta || {},
        }),
      });
      if (r.ok) { granted.credits = credits | 0; granted.xp = xp | 0; }
      else {
        console.error('[supabase] add_progress failed', r.status, await r.text().catch(() => ''));
      }
    }
    // part: insert into the owner's inventory, if the locker has room.
    // A full locker forfeits the drop rather than silently failing the insert —
    // the client says so on the results screen instead of showing nothing.
    if (part) {
      const held = await partsHeld(playerId);
      if(held !== null && held >= PART_CAP){
        granted.lockerFull = true;
        return { ok: true, granted };
      }
      const r = await fetch(SUPABASE_URL + '/rest/v1/parts', {
        method: 'POST', headers: adminHeaders({ 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          owner_id: playerId,
          weapon_id: part.weapon, slot: part.slot, rarity: part.rarity,
          name: part.name, mods: part.mods || {}, set_id: part.set || null,
          ability: part.ability || null,
          source: part.source || 'pvp', bound: !!part.bound,
        }),
      });
      if (r.ok) { const rows = await r.json(); granted.part = rows[0] || null; }
      else {
        console.error('[supabase] parts insert failed', r.status, await r.text().catch(() => ''));
      }
    }
    return { ok: true, granted };
  } catch (e) {
    console.error('[supabase] grantReward threw', e && e.message || e);
    return { ok: false, reason: String(e && e.message || e) };
  }
}

module.exports = { ENABLED, PART_CAP, verifyUser, playerIdForUid, claimMatch, partsHeld, grantReward };

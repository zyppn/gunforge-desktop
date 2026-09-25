/* One active session per account, newest wins.

   Two copies of the game on one account - two PCs, or a bot farm - means parallel
   earning, and a live match where one account holds two seats and farms itself. So
   every launch of the client makes a random session id and CLAIMS the account with
   it; the most recent claim is the only one the server honours. Every other copy
   finds out on its next heartbeat (or instantly, if it holds a PvP seat) and signs
   itself out.

   Enforcement is here, not in the client: rewards, store purchases and PvP seats all
   ask isCurrent(), so a modified client that ignores being signed out still earns
   nothing.

   `store` persists the claim so a server restart does not hand the account back to
   whichever device checks in first. If the store is unavailable (the table not
   migrated, Supabase down), claims still work from memory and say so in the log -
   an outage must not refuse every reward in the game. */
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

function createSessions(store, opt){
  const o = Object.assign({ claimCooldownMs: 3000, log: console }, opt || {});
  const cache = new Map();            // pid -> { session, at }
  const listeners = [];               // fn(pid, newSession, oldSession)
  let warned = false;
  const warn = (what, e) => { if(!warned){ warned = true;
    o.log.error('[sessions] ' + what + ' failed - running from memory only:', e && e.message || e); } };

  async function read(pid){
    if(cache.has(pid)) return cache.get(pid);
    let row = null;
    try{ row = store ? await store.get(pid) : null; }catch(e){ warn('read', e); }
    if(row) cache.set(pid, row);
    return row;
  }
  async function current(pid){ const r = await read(pid); return r ? r.session : null; }

  /* The two-bot loophole is claiming back and forth. A claim inside the cooldown of the
     previous one by a DIFFERENT session is refused, so the account cannot be flipped
     faster than a person could sign in on a second machine. */
  async function claim(pid, session, now){
    now = now || Date.now();
    if(!pid || !SESSION_RE.test(String(session || ''))) return { ok:false, reason:'bad-session' };
    const prev = await read(pid);
    if(prev && prev.session === session) return { ok:true, same:true };
    if(prev && now - prev.at < o.claimCooldownMs) return { ok:false, reason:'too-fast' };
    const rec = { session, at: now };
    cache.set(pid, rec);
    try{ if(store) await store.set(pid, rec); }catch(e){ warn('write', e); }
    if(prev) for(const fn of listeners){ try{ fn(pid, session, prev.session); }catch(e){ o.log.error(e); } }
    return { ok:true, superseded: prev ? prev.session : null };
  }

  /* Strict: no claim on record is NOT current. Otherwise two bots that simply never
     claim would both pass. */
  async function isCurrent(pid, session){
    if(!pid || !session) return false;
    return (await current(pid)) === session;
  }

  return { claim, current, isCurrent, onSupersede: fn => listeners.push(fn), SESSION_RE };
}

module.exports = { createSessions, SESSION_RE };

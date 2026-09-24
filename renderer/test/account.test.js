/* Accounts: the promise is that a player's locker survives. Four ways it can break, and
   none of them throw - they just leave someone with an empty locker:

   1. Linking an email must upgrade the SAME auth user. players.auth_uid points at the uid;
      if linking ever minted a new user, the row would be orphaned with everything on it.
   2. Signing in on a new PC must land on the original uid.
   3. A flaky Supabase must never cost anyone their account. ensureAuth used to answer ANY
      non-2xx refresh by creating a fresh guest and saving it over the old session - one
      503 at launch and the only token that could reach the locker was gone.
   4. Two callers at boot must not mint two guests.

   The auth functions are lifted out of the shipped index.html and run against a fake
   GoTrue that implements the endpoints and failure codes they rely on.

   node renderer/test/account.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d ? '   [' + d + ']' : '')); if(!cond) fails++; };

function lift(n){
  const m = html.match(new RegExp('(?:async\\s+)?function ' + n + '\\('));
  if(!m) throw new Error('missing function ' + n);
  const i = m.index;
  let j = html.indexOf('{', html.indexOf(')', i)), d = 0;
  for(; j < html.length; j++){
    if(html[j] === '{') d++;
    else if(html[j] === '}'){ d--; if(!d) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + n);
}
const line = re => { const m = html.match(re); if(!m) throw new Error('missing ' + re); return m[0]; };
const SRC = [
  line(/const AUTH = \{[^\n]*\};/), line(/const AUTH_EMAIL_RE = [^\n]*;/),
  line(/let AUTH_NEEDS_SIGNIN = [^\n]*;/), line(/let _authInflight = [^\n]*;/),
  ...['authStore','authApply','authSave','authAnonymousSignIn','authRefresh','ensureAuth','_ensureAuth',
      'authCall','authErrText','authLinkEmail','authSendLoginCode','authVerifyCode',
      'b64url','pkcePair','discordErrText','discordAuth'].map(lift),
  line(/const DISCORD_SCOPES = [^\n]*;/),
].join('\n');

/* ---- a fake GoTrue ---------------------------------------------------------------- */
function fakeAuth(){
  const S = { users: new Map(), refresh: new Map(), access: new Map(), pending: new Map(), seq: 0,
              calls: [], mode: 'up', sent: [], oauth: new Map(), codes: new Map(), redirects: [],
              manualLinking: true, discord: 'd100', approve: true };
  const newUser = extra => { const id = 'u' + (++S.seq); const u = Object.assign({ id, is_anonymous: true, email: null }, extra); S.users.set(id, u); return u; };
  const session = u => { const a = 'at' + (++S.seq), r = 'rt' + (++S.seq);
    S.access.set(a, u.id); S.refresh.set(r, u.id);
    return { access_token: a, refresh_token: r, expires_in: 3600, user: Object.assign({}, u) }; };
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  S.fetch = async (url, opt) => {
    const u = new URL(url), b = JSON.parse(opt.body || '{}'), p = u.pathname + u.search;
    S.calls.push(opt.method + ' ' + u.pathname);
    if(S.mode === 'down') throw new TypeError('fetch failed');
    if(S.mode === '503') return resp(503, { msg: 'upstream' });
    if(S.mode === '429') return resp(429, { error_code: 'over_request_rate_limit', msg: 'rate limit' });
    const who = () => S.access.get(String((opt.headers || {}).Authorization || '').replace('Bearer ', ''));
    if(p === '/auth/v1/signup' && opt.method === 'POST') return resp(200, session(newUser()));
    if(p === '/auth/v1/token?grant_type=refresh_token'){
      const id = S.refresh.get(b.refresh_token);
      if(!id) return resp(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      S.refresh.delete(b.refresh_token);
      return resp(200, session(S.users.get(id)));
    }
    if(u.pathname === '/auth/v1/user' && opt.method === 'PUT'){
      const id = who(); if(!id) return resp(401, { msg: 'no session' });
      if([...S.users.values()].some(x => x.email === b.email))
        return resp(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
      S.pending.set(b.email, { code: '482913', type: 'email_change', id }); S.sent.push(b.email);
      return resp(200, Object.assign({}, S.users.get(id), { new_email: b.email }));
    }
    if(u.pathname === '/auth/v1/otp'){
      const x = [...S.users.values()].find(x => x.email === b.email);
      if(!x && b.create_user === false) return resp(422, { error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      S.pending.set(b.email, { code: '771204', type: 'email', id: x.id }); S.sent.push(b.email);
      return resp(200, {});
    }
    if(u.pathname === '/auth/v1/verify'){
      const pd = S.pending.get(b.email);
      if(!pd || pd.code !== b.token || pd.type !== b.type)
        return resp(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      S.pending.delete(b.email);
      const usr = S.users.get(pd.id);
      if(pd.type === 'email_change'){ usr.email = b.email; usr.is_anonymous = false; }
      return resp(200, session(usr));
    }
    if(u.pathname === '/auth/v1/user/identities/authorize' && opt.method === 'GET'){
      if(opt.body !== undefined) throw new TypeError('Request with GET/HEAD method cannot have body.');
      const id = who(); if(!id) return resp(401, { msg: 'no session' });
      if(!S.manualLinking) return resp(404, { error_code: 'manual_linking_disabled', msg: 'Manual linking is disabled' });
      const st = 'st' + (++S.seq);
      S.oauth.set(st, { kind: 'link', uid: id, challenge: u.searchParams.get('code_challenge'),
                        redirect: u.searchParams.get('redirect_to') });
      return resp(200, { url: 'https://discord.com/oauth2/authorize?client_id=1&state=' + st });
    }
    if(p === '/auth/v1/token?grant_type=pkce'){
      const c = S.codes.get(b.auth_code);
      if(!c) return resp(400, { error_code: 'flow_state_not_found', msg: 'invalid flow state' });
      const h = require('crypto').createHash('sha256').update(b.code_verifier).digest('base64url');
      if(h !== c.challenge) return resp(400, { error_code: 'bad_code_verifier', msg: 'code challenge does not match' });
      S.codes.delete(b.auth_code);
      return resp(200, session(S.users.get(c.uid)));
    }
    return resp(404, { msg: 'no route ' + p });
  };
  /* The player's browser and Discord. `S.discord` is who they are signed in to Discord
     as; `S.approve` false is them clicking Cancel. Returns what the loopback would. */
  S.browser = url => {
    const u = new URL(url);
    if(S.approve === false) return { error: 'access_denied', error_description: 'The resource owner denied the request' };
    let flow;
    if(u.hostname === 'discord.com') flow = S.oauth.get(u.searchParams.get('state'));
    else if(u.pathname === '/auth/v1/authorize')
      flow = { kind: 'login', challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_to') };
    if(!flow || !flow.challenge) return { error: 'invalid_request', error_description: 'no flow' };
    const owner = [...S.users.values()].find(x => x.discord === S.discord);
    let uid;
    if(flow.kind === 'link'){
      if(owner && owner.id !== flow.uid) return { error: 'server_error', error_code: 'identity_already_exists', error_description: 'Identity is already linked to another user' };
      const usr = S.users.get(flow.uid);
      usr.discord = S.discord; usr.is_anonymous = false; usr.email = S.discord + '@discord.example';
      usr.user_metadata = { full_name: 'Op ' + S.discord };
      uid = usr.id;
    } else {
      uid = owner ? owner.id : newUser({ discord: S.discord, is_anonymous: false, email: S.discord + '@discord.example',
                                          user_metadata: { full_name: 'Op ' + S.discord } }).id;
    }
    const code = 'code' + (++S.seq);
    S.codes.set(code, { uid, challenge: flow.challenge });
    S.redirects.push(flow.redirect);
    return { code };
  };
  return S;
}
function client(S, store){
  store = store || new Map();
  const ctx = vm.createContext({
    console: { error(){}, log(){} }, JSON, Date, Math, URL, Promise, String, Object, Error, TypeError,
    fetch: (...a) => S.fetch(...a),
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) },
    toast: m => { ctx.__toasts.push(m); }, __toasts: [],
    BACKEND: { supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' },
    HAS_SUPABASE: () => true,
    crypto: globalThis.crypto, TextEncoder, URLSearchParams, btoa, Uint8Array,
    gunforgeNative: {
      oauthListen: async () => ({ redirect: 'http://127.0.0.1:53682/auth/callback' }),
      oauthOpen: async url => S.browser(url),
      oauthCancel: async () => true,
    },
  });
  ctx.window = ctx;
  vm.runInContext(SRC + '\nthis.__get = () => ({ AUTH, AUTH_NEEDS_SIGNIN });', ctx);
  ctx.store = store;
  return ctx;
}
const expire = c => { const a = JSON.parse(c.store.get('gf_auth')); a.expires = 0; c.store.set('gf_auth', JSON.stringify(a)); };

(async () => {
  /* ---- 1. linking keeps the uid ---- */
  {
    const S = fakeAuth(), c = client(S);
    const uid = await c.ensureAuth();
    ok('a fresh install gets a guest', !!uid && c.__get().AUTH.anon === true);
    const sent = await c.authLinkEmail('op@example.com');
    ok('link sends a code', sent.ok && S.sent.includes('op@example.com'));
    const bad = await c.authVerifyCode('op@example.com', '000000', 'email_change');
    ok('a wrong code is refused in plain language', !bad.ok && /wrong or has expired/.test(bad.err), bad.err);
    await c.authLinkEmail('op@example.com');
    const v = await c.authVerifyCode('op@example.com', '482 913', 'email_change');
    ok('the right code links', v.ok);
    ok('THE UID IS UNCHANGED after linking', v.uid === uid, uid + ' -> ' + v.uid);
    ok('the account now reads as secured', c.__get().AUTH.anon === false && c.__get().AUTH.email === 'op@example.com');
    ok('the secured state survives a restart', JSON.parse(c.store.get('gf_auth')).anon === false);
    const again = await c.authLinkEmail('other@example.com');
    ok('a secured account cannot be re-linked', !again.ok);

    /* ---- 2. a new PC signs in to the same uid ---- */
    const pc2 = client(S);
    const guest2 = await pc2.ensureAuth();
    ok('the new PC starts as its own guest', guest2 && guest2 !== uid);
    const taken = await pc2.authLinkEmail('op@example.com');
    ok('linking an email that is taken says to sign in instead', !taken.ok && /SIGN IN/.test(taken.err), taken.err);
    const nobody = await pc2.authSendLoginCode('nobody@example.com');
    ok('signing in with an unknown email says so', !nobody.ok && /No account/.test(nobody.err), nobody.err);
    const s2 = await pc2.authSendLoginCode('op@example.com');
    const v2 = await pc2.authVerifyCode('op@example.com', '771204', 'email');
    ok('sign-in on a new PC lands on the ORIGINAL uid', s2.ok && v2.ok && v2.uid === uid, v2.uid);
  }

  /* ---- 3. a flaky Supabase never costs an account ---- */
  for(const mode of ['down', '503', '429']){
    const S = fakeAuth(), c = client(S);
    const uid = await c.ensureAuth();
    expire(c);
    S.mode = mode;
    const got = await c.ensureAuth();
    S.mode = 'up';
    ok('refresh failing with ' + mode + ' does NOT create a new guest', got === null && !S.calls.slice(1).includes('POST /auth/v1/signup'));
    ok('  and the saved session is untouched', JSON.parse(c.store.get('gf_auth')).uid === uid);
    const back = await c.ensureAuth();
    ok('  and the same account comes back once it recovers', back === uid);
  }
  {
    const S = fakeAuth(), c = client(S);
    await c.ensureAuth(); await c.authLinkEmail('sec@example.com');
    const v = await c.authVerifyCode('sec@example.com', '482913', 'email_change');
    expire(c); S.refresh.clear();                     // revoked: every refresh token is dead
    const got = await c.ensureAuth();
    ok('a SECURED account with a dead token asks to sign in, never makes a guest',
       got === null && c.__get().AUTH_NEEDS_SIGNIN === true && JSON.parse(c.store.get('gf_auth')).uid === v.uid);
    await c.authSendLoginCode('sec@example.com');
    const r = await c.authVerifyCode('sec@example.com', '771204', 'email');
    ok('  and signing in restores it', r.ok && r.uid === v.uid && c.__get().AUTH_NEEDS_SIGNIN === false);
  }
  {
    const S = fakeAuth(), c = client(S);
    const uid = await c.ensureAuth();
    expire(c); S.refresh.clear();
    const got = await c.ensureAuth();
    ok('a GUEST with a dead token starts over - and says so', got && got !== uid && c.__toasts.some(t => /EXPIRED/.test(t)));
  }

  /* ---- 4. single flight ---- */
  {
    const S = fakeAuth(), c = client(S);
    const [a, b, d] = await Promise.all([c.ensureAuth(), c.ensureAuth(), c.ensureAuth()]);
    ok('three callers at boot share one guest', a && a === b && b === d
       && S.calls.filter(x => x === 'POST /auth/v1/signup').length === 1);
  }

  /* ---- 5. Discord ---- */
  {
    const S = fakeAuth(), c = client(S);
    const uid = await c.ensureAuth();
    const r = await c.discordAuth('link');
    ok('Discord link succeeds', r.ok, r.err);
    ok('THE UID IS UNCHANGED after linking Discord', r.uid === uid, uid + ' -> ' + r.uid);
    ok('  the account reads as secured, with the Discord name', c.__get().AUTH.anon === false && c.__get().AUTH.name === 'Op d100');
    ok('  the callback went to the loopback listener', S.redirects[0] === 'http://127.0.0.1:53682/auth/callback');

    const pc2 = client(S);
    await pc2.ensureAuth();
    const s2 = await pc2.discordAuth('login');
    ok('signing in with Discord on a new PC lands on the ORIGINAL uid', s2.ok && s2.uid === uid, s2.uid);

    const pc3 = client(S);
    const g3 = await pc3.ensureAuth();
    const clash = await pc3.discordAuth('link');
    ok('linking a Discord that already has an account says so', !clash.ok && clash.code === 'identity_already_exists', clash.err);
    ok('  and leaves this PC on its own guest', pc3.__get().AUTH.uid === g3);

    S.discord = 'd200';
    const fresh = client(S); await fresh.ensureAuth();
    const n = await fresh.discordAuth('login');
    ok('a Discord with no account yet gets a new one on sign-in', n.ok && n.uid !== uid);

    S.approve = false;
    const den = await client(S).discordAuth('login');
    ok('cancelling on Discord is reported in plain language', !den.ok && /cancelled/i.test(den.err), den.err);
    S.approve = true;

    S.manualLinking = false;
    const off = client(S); await off.ensureAuth();
    const dis = await off.discordAuth('link');
    ok('linking with manual linking switched off says it is a setup problem', !dis.ok && /server setup/.test(dis.err), dis.err);
    S.manualLinking = true;
  }
  {
    // the verifier is the only thing that makes the code worth anything
    const S = fakeAuth(), c = client(S);
    await c.ensureAuth();
    const orig = S.browser;
    S.browser = url => { const r = orig(url); const k = S.codes.get(r.code); k.challenge = 'someone-elses-challenge'; return r; };
    const r = await c.discordAuth('login');
    ok('a code that does not match our PKCE verifier is refused', !r.ok);
  }

  console.log(fails ? '\naccount: ' + fails + ' failure(s)' : '\naccount: all clear');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

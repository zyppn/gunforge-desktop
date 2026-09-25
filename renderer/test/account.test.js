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
      'b64url','pkcePair','discordErrText','discordAuth',
      'loginUsername','hasDiscord','loginFieldErr','loginErrText','authCreateLogin','authPasswordSignIn','authSignOut','sessionClaim','sessionCheck','authSignedOut','authSetSignedOut'].map(lift),
  line(/const SIGNED_OUT_KEY = [^\n]*;/),
  line(/const newSessionId = [\s\S]*?join\(''\)\);/), line(/let SESSION_ID = [^\n]*;/), line(/let SESSION_LOST = [^\n]*;/),
  line(/const DISCORD_SCOPES = [^\n]*;/), line(/const LOGIN_DOMAIN = [^\n]*;/), line(/const USERNAME_RE = [^\n]*;/),
  line(/const MIN_PASSWORD = [^\n]*;/), line(/const usernameEmail = [^\n]*;/),
].join('\n');

/* ---- a fake GoTrue ---------------------------------------------------------------- */
function fakeAuth(){
  const S = { users: new Map(), refresh: new Map(), access: new Map(), pending: new Map(), seq: 0,
              calls: [], mode: 'up', sent: [], oauth: new Map(), codes: new Map(), redirects: [],
              manualLinking: true, discord: 'd100', approve: true, confirmEmail: false };
  const newUser = extra => { const id = 'u' + (++S.seq); const u = Object.assign({ id, is_anonymous: true, email: null }, extra); S.users.set(id, u); return u; };
  const session = u => { const a = 'at' + (++S.seq), r = 'rt' + (++S.seq);
    S.access.set(a, u.id); S.refresh.set(r, u.id);
    const providers = [].concat(u.is_anonymous ? ['anonymous'] : [], u.discord ? ['discord'] : [], u.password ? ['email'] : []);
    return { access_token: a, refresh_token: r, expires_in: 3600,
             user: Object.assign({}, u, { app_metadata: { providers } }) }; };
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
      if(b.password && !S.confirmEmail){                     // "Confirm email" off: applied at once
        const usr = S.users.get(id);
        if(b.password.length < 6) return resp(422, { error_code: 'weak_password', msg: 'Password should be at least 6 characters' });
        usr.email = b.email; usr.password = b.password; usr.is_anonymous = false;
        return resp(200, Object.assign({}, usr));
      }
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
    if(p === '/auth/v1/logout?scope=local'){
      const id = who(); if(!id) return resp(401, { msg: 'no session' });
      for(const [r, uid] of [...S.refresh]) if(uid === id) S.refresh.delete(r);   // revoke this user's refresh tokens
      S.loggedOut = (S.loggedOut || 0) + 1;
      return resp(204, null);
    }
    if(p === '/auth/v1/token?grant_type=password'){
      const x = [...S.users.values()].find(x => x.email === b.email && x.password && x.password === b.password);
      if(!x) return resp(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return resp(200, session(x));
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
      /* GoTrue fills the user's email from the new identity only if it has none (a guest).
         An account that already has one - a username login - keeps it; overwriting it here
         would model Discord silently breaking the password login, which is not what happens. */
      usr.discord = S.discord; usr.is_anonymous = false;
      if(!usr.email) usr.email = S.discord + '@discord.example';
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
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                  removeItem: k => store.delete(k) },
    toast: m => { ctx.__toasts.push(m); }, __toasts: [],
    BACKEND: { supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' },
    HAS_SUPABASE: () => true,
    crypto: globalThis.crypto, TextEncoder, URLSearchParams, btoa, Uint8Array, Array,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),   // the 3.2s claim retry, compressed
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

  /* ---- 6. username + password, and both on one account ---- */
  {
    const S = fakeAuth(), c = client(S);
    const uid = await c.ensureAuth();
    for(const [u, pw, why] of [['ab', 'longenough1', 'short username'], ['bad name', 'longenough1', 'space'],
                               ['jacob', 'short', 'short password']]){
      const r = await c.authCreateLogin(u, pw);
      ok('refuses a login with a ' + why + ' before calling the server', !r.ok && !S.calls.includes('PUT /auth/v1/user'), r.err);
    }
    const r = await c.authCreateLogin('Jacob', 'hunter2hunter2');
    ok('a guest can create a login', r.ok, r.err);
    ok('THE UID IS UNCHANGED after creating a login', r.uid === uid, uid + ' -> ' + r.uid);
    ok('  usernames are case-insensitive and stored lower case', c.loginUsername() === 'jacob');
    ok('  the account reads as secured', c.__get().AUTH.anon === false);
    ok('  the hidden address is under our own domain', S.users.get(uid).email === 'jacob@players.voxabase.com');
    const twice = await c.authCreateLogin('other', 'hunter2hunter2');
    ok('an account cannot get a second login', !twice.ok, twice.err);

    const d = await c.discordAuth('link');
    ok('the same account can ALSO connect Discord', d.ok && d.uid === uid && c.hasDiscord() && c.loginUsername() === 'jacob');

    const pc2 = client(S); await pc2.ensureAuth();
    const wrong = await pc2.authPasswordSignIn('jacob', 'nope-nope-nope');
    ok('a wrong password says so plainly', !wrong.ok && wrong.err === 'Wrong username or password.', wrong.err);
    const s2 = await pc2.authPasswordSignIn('JACOB', 'hunter2hunter2');
    ok('signing in by username on a new PC lands on the ORIGINAL uid', s2.ok && s2.uid === uid);
    const pc3 = client(S); await pc3.ensureAuth();
    const s3 = await pc3.discordAuth('login');
    ok('  and Discord on a third PC lands on it too', s3.ok && s3.uid === uid);

    const pc4 = client(S); await pc4.ensureAuth();
    const taken = await pc4.authCreateLogin('jacob', 'another-password');
    ok('a taken username says so', !taken.ok && taken.err === 'That username is taken.', taken.err);
  }
  {
    // Discord first, login second - the other order
    const S = fakeAuth(); S.discord = 'd300';
    const c = client(S); const uid = await c.ensureAuth();
    await c.discordAuth('link');
    const r = await c.authCreateLogin('second_way', 'hunter2hunter2');
    ok('a Discord account can add a login and keep its uid', r.ok && r.uid === uid, r.err);
    const again = client(S); await again.ensureAuth();
    ok('  and Discord still signs in to it afterwards', (await again.discordAuth('login')).uid === uid);
  }
  {
    // "Confirm email" left on: the login would silently never work
    const S = fakeAuth(); S.confirmEmail = true;
    const c = client(S); await c.ensureAuth();
    const r = await c.authCreateLogin('jacob', 'hunter2hunter2');
    ok('with Confirm email on, creating a login reports a setup problem instead of pretending',
       !r.ok && r.setup === true && /Confirm email/.test(r.err), r.err);
  }

  /* ---- 7. sign out ---- */
  {
    const S = fakeAuth(); S.discord = 'd700';
    const c = client(S);
    const uid = await c.ensureAuth();
    await c.discordAuth('link');
    const refreshBefore = JSON.parse(c.store.get('gf_auth')).refresh;
    await c.authSignOut();
    ok('sign out tells the server to revoke the session', S.loggedOut === 1);
    ok('  and this PC forgets the account', !c.store.has('gf_auth') && c.__get().AUTH.uid === null);
    ok('  and the old refresh token is dead server-side', !S.refresh.has(refreshBefore));
    const g = await c.ensureAuth();
    ok('the next launch on that PC is a brand-new guest', g && g !== uid && c.__get().AUTH.anon === true);
    const back = await c.discordAuth('login');
    ok('signing back in with Discord returns the SAME account', back.ok && back.uid === uid);

    const off = client(S); await off.ensureAuth(); await off.discordAuth('login');
    S.mode = 'down';
    await off.authSignOut();
    S.mode = 'up';
    ok('signing out works offline too (the revoke is best-effort)', !off.store.has('gf_auth'));
  }

  /* ---- 7b. a signed-out PC mints no guest until asked ---- */
  {
    const S = fakeAuth(); S.discord = 'd750';
    const c = client(S);
    const uid = await c.ensureAuth(); await c.discordAuth('link');
    await c.authSignOut(); c.authSetSignedOut(true);            // what forgetAccount does
    const signups = () => S.calls.filter(x => x === 'POST /auth/v1/signup').length;
    const before = signups();
    ok('signed out: ensureAuth creates NO guest', await c.ensureAuth() === null && signups() === before);
    const c2 = client(S, c.store);                              // quit and relaunch while signed out
    ok('  not even after a relaunch', await c2.ensureAuth() === null && signups() === before);
    const back = await c2.discordAuth('login');
    ok('signing in clears the signed-out state and lands on the same account', back.ok && back.uid === uid && !c2.authSignedOut());
    c2.authSetSignedOut(true); await c2.authSignOut(); c2.authSetSignedOut(false);   // PLAY AS GUEST
    const g = await c2.ensureAuth();
    ok('choosing PLAY AS GUEST creates exactly one guest', g && g !== uid && signups() === before + 1);
  }

  /* ---- 8. one active session: the client side ---- */
  {
    const S = fakeAuth();
    const c = client(S);
    await c.ensureAuth();
    let server = { current: true, claim: 'ok', down: false, claims: 0, lostCalls: 0 };
    const realFetch = c.fetch;
    c.fetch = async (url, opt) => {
      if(!String(url).startsWith('http://arena')) return realFetch(url, opt);
      if(server.down) throw new TypeError('fetch failed');
      const b = JSON.parse(opt.body || '{}');
      if(url.endsWith('/session/claim')){ server.claims++;
        const r = server.claim; if(server.claim === 'too-fast-once'){ server.claim = 'ok'; return { ok:false, json: async () => ({ ok:false, reason:'too-fast' }) }; }
        return { ok: r === 'ok', json: async () => (r === 'ok' ? { ok:true } : { ok:false, reason:r }) }; }
      if(url.endsWith('/session/check')) return { ok:true, json: async () => ({ ok:true, current: server.current }) };
      return { ok:false, json: async () => ({}) };
    };
    vm.runInContext('liveHttpUrl = () => "http://arena"; ACCOUNT = { playerId: "pidA" }; ' +
      'sessionSuperseded = () => { __lost++; };', Object.assign(c, { __lost: 0 }));
    ok('each launch makes a random session id the server accepts', /^[A-Za-z0-9_-]{16,64}$/.test(c.SESSION_ID || vm.runInContext('SESSION_ID', c)));
    ok('claiming works', await c.sessionClaim() === 'ok');
    server.claim = 'too-fast-once'; const n0 = server.claims;
    ok('a claim inside the cooldown is retried once and then lands', await c.sessionClaim() === 'ok' && server.claims === n0 + 2);
    server.down = true;
    ok('the heartbeat NEVER signs out when the server cannot be reached', await c.sessionCheck() === 'offline' && c.__lost === 0);
    server.down = false; server.current = true;
    ok('still current: nothing happens', await c.sessionCheck() === 'current' && c.__lost === 0);
    server.current = null; const n1 = server.claims;
    ok('the server forgot the claim: take it back quietly', await c.sessionCheck() === 'reclaimed' && server.claims === n1 + 1 && c.__lost === 0);
    server.current = false;
    ok('another device took the account: sign out', await c.sessionCheck() === 'lost' && c.__lost === 1);
  }

  console.log(fails ? '\naccount: ' + fails + ' failure(s)' : '\naccount: all clear');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

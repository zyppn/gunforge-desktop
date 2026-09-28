/* Money that moves while you are not looking.

   1. The live wallet. A sale pays the seller inside the BUYER's transaction, on the
      buyer's PC. The seller's game has to hear about it by itself: over a Realtime
      socket, or by polling when the socket is not there. Either way the sale must be
      announced exactly once, the part must leave the locker, and the balance must be
      the database's.
   2. Match rewards. The results screen and the outbox are one request now (sendReward);
      it carries this launch's session, and re-claims the session once if the server
      forgot it, instead of every match landing on "salvage pending".
   3. First launch ever makes no account: the sign-in screen does.

   node renderer/test/wallet.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let fails = 0;
const ok = (name, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (d !== undefined ? '   [' + d + ']' : '')); if(!cond) fails++; };
function lift(n){
  const m = html.match(new RegExp('(?:async\\s+)?function ' + n + '\\('));
  if(!m) throw new Error('missing function ' + n);
  let j = html.indexOf('{', html.indexOf(')', m.index)), d = 0;
  for(; j < html.length; j++){ if(html[j] === '{') d++; else if(html[j] === '}'){ d--; if(!d) return html.slice(m.index, j + 1); } }
  throw new Error('unbalanced ' + n);
}
const line = re => { const m = html.match(re); if(!m) throw new Error('missing ' + re); return m[0]; };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/* ---------------- 1. live wallet ---------------- */
function walletCtx(){
  const sockets = [];
  class FakeWS {
    constructor(url){ this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(t){ this.sent.push(JSON.parse(t)); }
    close(){ this.readyState = 3; this.closed = true; }
    open(){ this.readyState = 1; this.onopen && this.onopen(); }
    recv(m){ this.onmessage && this.onmessage({ data: JSON.stringify(m) }); }
    drop(){ this.readyState = 3; this.onclose && this.onclose(); }
  }
  const timers = { intervals: new Set(), timeouts: [] };
  const ctx = vm.createContext({
    console, JSON, Date, Math, String, Object, Array, Set, Promise, encodeURIComponent,
    WebSocket: FakeWS,
    setInterval: (fn, ms) => { const h = { fn, ms }; timers.intervals.add(h); return h; },
    clearInterval: h => timers.intervals.delete(h),
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.timeouts.push(h); return h; },
    clearTimeout: h => { const i = timers.timeouts.indexOf(h); if(i >= 0) timers.timeouts.splice(i, 1); },
    BACKEND: { supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' },
    HAS_SUPABASE: () => true, authSignedOut: () => false,
    AUTH: { token: 'jwt-1' }, ACCOUNT: { online: true, playerId: 'pid-me' },
    P: { credits: 500, inventory: [{ uid: 'u-barrel', name: 'Dragon Maw' }, { uid: 'u-keep', name: 'Keeper' }], listedUids: ['u-barrel'] },
    toasts: [], toast: m => ctx.toasts.push(m), sfx: () => {},
    refreshChips: () => {}, renderAuction: () => { ctx.auctionPaints++; }, repaintParts: () => {}, auctionPaints: 0,
    creditsFetches: 0, dbCredits: 500,
    refreshCredits: async () => { ctx.creditsFetches++; ctx.P.credits = ctx.dbCredits; },
    polled: [], sbSelect: async q => { ctx.polled.push(q); return ctx.pollRows || []; },
    document: { getElementById: id => id === 'auction' ? { classList: { contains: () => true } } : null },
  });
  vm.runInContext([line(/const LIVE_POLL_MS = [^\n]*;/), line(/const LIVE = \{[\s\S]*?seen:new Set\(\) \};/),
    ...['liveSend','liveWalletStop','liveWalletStart','liveRetry','livePollStart','livePollStop','livePoll','liveBalance','liveSold'].map(lift),
    'this.LIVE = LIVE;'].join('\n'), ctx);
  return { ctx, sockets, timers };
}
(async () => {
  {
    const { ctx, sockets, timers } = walletCtx();
    ctx.liveWalletStart();
    const ws = sockets[0];
    ok('opens one Realtime socket to the project', sockets.length === 1 && /^wss:\/\/proj\.supabase\.co\/realtime\/v1\/websocket\?apikey=anon&vsn=1\.0\.0$/.test(ws.url), ws.url);
    ok('polls until the channel is confirmed (never a silent gap)', [...timers.intervals].some(h => h.ms === 10000));
    ws.open();
    const join = ws.sent[0];
    const pc = join && join.payload.config.postgres_changes;
    ok('joins with the account token', join.event === 'phx_join' && join.payload.access_token === 'jwt-1');
    ok('  watching MY balance', pc.some(c => c.table === 'players' && c.event === 'UPDATE' && c.filter === 'id=eq.pid-me'));
    ok('  and MY listings', pc.some(c => c.table === 'listings' && c.event === 'UPDATE' && c.filter === 'seller_id=eq.pid-me'));
    ws.recv({ topic: join.topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: [{ id: 1 }, { id: 2 }] } } });
    ok('once confirmed, the poll stops', ctx.LIVE.joined && ![...timers.intervals].some(h => h.ms === 10000));
    const beat = [...timers.intervals].find(h => h.ms === 25000);
    ctx.AUTH.token = 'jwt-2'; beat.fn();
    ok('heartbeats, and hands the channel the refreshed token', ws.sent.some(m => m.event === 'heartbeat') && ws.sent.some(m => m.event === 'access_token' && m.payload.access_token === 'jwt-2'));

    ctx.dbCredits = 750;
    const sale = { topic: join.topic, event: 'postgres_changes', payload: { data: { table: 'listings', type: 'UPDATE',
      record: { id: 'L1', seller_id: 'pid-me', part_uid: 'u-barrel', price: 250, status: 'sold', resolved_at: '2099-01-01T00:00:00Z' } } } };
    ws.recv(sale); await tick();
    ok('A SALE IS ANNOUNCED THE MOMENT IT HAPPENS, with the part and the price', ctx.toasts.length === 1 && /SOLD .* Dragon Maw .* \+250 CR/.test(ctx.toasts[0]), ctx.toasts[0]);
    ok('  the balance comes from the database', ctx.creditsFetches === 1 && ctx.P.credits === 750);
    ok('  the sold part leaves the locker and its LISTED tag goes', !ctx.P.inventory.some(p => p.uid === 'u-barrel') && ctx.P.inventory.length === 1 && !ctx.P.listedUids.length);
    ws.recv(sale); ctx.pollRows = [sale.payload.data.record]; await ctx.livePoll(); await tick();
    ok('  and it is announced ONCE, even if the socket and the poll both report it', ctx.toasts.length === 1);
    ws.recv({ topic: join.topic, event: 'postgres_changes', payload: { data: { table: 'listings', record: { id: 'L2', seller_id: 'pid-me', status: 'cancelled' } } } });
    ok('a delist is not a sale', ctx.toasts.length === 1);
    ws.recv({ topic: join.topic, event: 'postgres_changes', payload: { data: { table: 'players', record: { id: 'pid-me', credits: 910 } } } });
    ok('any balance change shows at once (and the auction repaints its BUY buttons)', ctx.P.credits === 910 && ctx.auctionPaints > 0);
    ws.recv({ topic: join.topic, event: 'postgres_changes', payload: { data: { table: 'players', record: { id: 'someone-else', credits: 1 } } } });
    ok('someone else\'s row is ignored', ctx.P.credits === 910);

    ws.drop();
    ok('socket lost: the poll takes over and a reconnect is scheduled',
       [...timers.intervals].some(h => h.ms === 10000) && timers.timeouts.some(t => t.ms >= 2000));
    timers.timeouts.pop().fn(); sockets[1].open();
    ok('  and it reconnects', sockets.length === 2 && sockets[1].sent[0].event === 'phx_join');
    ctx.liveWalletStop();
    ok('signing out closes the socket and stops every timer', sockets[1].closed && timers.intervals.size === 0 && ctx.LIVE.pid === null);
  }
  {
    const { ctx, sockets, timers } = walletCtx();
    ctx.liveWalletStart(); sockets[0].open();
    const t = sockets[0].sent[0].topic;
    sockets[0].recv({ topic: t, event: 'system', payload: { status: 'error', message: 'table not in publication' } });
    ok('Realtime not switched on (migration 021 not run): falls back to polling', [...timers.intervals].some(h => h.ms === 10000));
    ctx.pollRows = [{ id: 'L9', seller_id: 'pid-me', part_uid: 'u-keep', price: 40, status: 'sold', resolved_at: '2099-01-02T00:00:00Z' }];
    await ctx.livePoll(); await tick();
    ok('  and a sale found by the poll is announced the same way', /SOLD .* Keeper .* \+40 CR/.test(ctx.toasts[0] || ''), ctx.toasts[0]);
    ok('  the poll asks only for sales since the last one it saw', /resolved_at=gt\./.test(ctx.polled[0]) && ctx.LIVE.since === '2099-01-02T00:00:00Z');
  }

  /* ---------------- 2. match rewards ---------------- */
  {
    const calls = [];
    let server = [];
    const ctx = vm.createContext({ console, JSON, Object, Promise, AbortController,
      setTimeout, clearTimeout, AUTH: { token: 'jwt' }, SESSION_ID: 'sess-A', claims: 0,
      liveHttpUrl: () => 'http://arena',
      sessionClaim: async () => { ctx.claims++; return 'ok'; },
      fetch: async (url, opt) => { calls.push({ url, body: JSON.parse(opt.body) }); const [st, j] = server.shift(); return { status: st, json: async () => j }; } });
    vm.runInContext(lift('sendReward'), ctx);
    server = [[200, { ok: true, credits: 60 }]];
    let r = await ctx.sendReward({ mid: 'm1', kills: 3 });
    ok('the results screen\'s reward carries this launch\'s session', r.ok && calls[0].url === 'http://arena/reward/offline' && calls[0].body.session === 'sess-A' && calls[0].body.mid === 'm1');
    calls.length = 0; server = [[409, { ok: false, reason: 'no-session' }], [200, { ok: true }]];
    r = await ctx.sendReward({ mid: 'm2' });
    ok('server forgot the session: claim it back and send once more - paid, not "pending"', r.ok && ctx.claims === 1 && calls.length === 2);
    server = [[409, { ok: false, reason: 'superseded' }]];
    r = await ctx.sendReward({ mid: 'm3' });
    ok('signed in on another device: reported as such, not queued as "offline"', r.superseded === true);
    const fetches = (html.match(/fetch\(liveHttpUrl\(\)\s*\+\s*'\/reward\/offline'/g) || []).length;
    ok('there is exactly ONE place that posts a reward (no second copy to drift)', fetches === 1, fetches);
    ok('  and the results screen uses it', /await sendReward\(\{ mid, kills, deaths, win, mode \}/.test(html));
  }

  /* ---------------- 3. first launch ---------------- */
  {
    const store = new Map();
    const ctx = vm.createContext({ JSON, localStorage: { getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) } });
    vm.runInContext([line(/const SIGNED_OUT_KEY = [^\n]*;/), lift('authStore'), lift('authSignedOut'), lift('authSetSignedOut')].join('\n'), ctx);
    const boot = line(/if\(!authStore\(\) && !authSignedOut\(\)\) authSetSignedOut\(true\);/);
    ok('the first-launch check runs before boot asks for an account',
       html.indexOf(boot) < html.indexOf('if(await ensureAuth()) await sessionClaim();'));
    vm.runInContext(boot, ctx);
    ok('first launch ever (nothing saved): the sign-in screen, no guest', vm.runInContext('authSignedOut()', ctx) === true);
    store.clear(); store.set('gf_auth', JSON.stringify({ token: 't', refresh: 'r' }));
    vm.runInContext(boot, ctx);
    ok('an existing player keeps their session', vm.runInContext('authSignedOut()', ctx) === false);
  }

  console.log(fails ? '\nwallet: ' + fails + ' failure(s)' : '\nwallet: all clear');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

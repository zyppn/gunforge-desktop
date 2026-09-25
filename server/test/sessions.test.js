/* One active session per account, newest wins (server/sessions.js).

   Two copies of the game on one account must not both earn: not two PCs, not a bot
   farm, not one account holding two seats in a live match and farming itself. This
   drives the REAL ArenaRoom and the REAL HTTP handler out of server/index.js, with
   Colyseus, the HTTP server and Supabase stubbed, and checks the three places that
   pay out: PvP seats, /reward/offline and /store/buy.

     node server/test/sessions.test.js                                              */
const path = require('path'), Module = require('module'), { EventEmitter } = require('events');
const SRV = path.join(__dirname, '..');
const { createSessions } = require(path.join(SRV, 'sessions.js'));

let fails = 0;
const ok = (label, cond, d) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (d ? '   [' + d + ']' : '')); if(!cond) fails++; };
const S = n => ('sess-' + n + '-' + 'x'.repeat(16)).slice(0, 24);

(async () => {
  /* ---- 1. the rules, on their own ---- */
  {
    const mem = new Map();
    const store = { get: async p => mem.get(p) || null, set: async (p, r) => { mem.set(p, r); } };
    const ss = createSessions(store, { claimCooldownMs: 3000, log: { error(){} } });
    const kicked = []; ss.onSupersede((pid, nw, old) => kicked.push([pid, nw, old]));
    ok('a session id that is not a random token is refused', !(await ss.claim('p1', 'short')).ok);
    ok('first claim wins the account', (await ss.claim('p1', S(1), 1000)).ok && await ss.isCurrent('p1', S(1)));
    ok('re-claiming with the same session is a no-op', (await ss.claim('p1', S(1), 1500)).same === true && kicked.length === 0);
    ok('a second device inside the cooldown is refused (two bots flipping the account)',
       (await ss.claim('p1', S(2), 2000)).reason === 'too-fast' && await ss.isCurrent('p1', S(1)));
    const r = await ss.claim('p1', S(2), 5000);
    ok('after the cooldown the NEWEST device wins', r.ok && r.superseded === S(1) && await ss.isCurrent('p1', S(2)));
    ok('  and the old device is no longer current', !(await ss.isCurrent('p1', S(1))));
    ok('  and the server is told who to kick', kicked.length === 1 && kicked[0][2] === S(1));
    ok('no claim on record is NOT current (bots that never claim both fail)', !(await ss.isCurrent('p9', S(9))));
    const fresh = createSessions(store, { log: { error(){} } });
    ok('a claim survives a server restart', await fresh.isCurrent('p1', S(2)));
    const broken = createSessions({ get: async () => { throw new Error('no table'); }, set: async () => { throw new Error('no table'); } },
                                  { log: { error(){} } });
    ok('if the table is missing, claims still work from memory', (await broken.claim('p2', S(3))).ok && await broken.isCurrent('p2', S(3)));
  }

  /* ---- 2. the real server ---- */
  let Room = null, handler = null;
  const sessions = createSessions(null, { claimCooldownMs: 0, log: { error(){} } });
  class FakeRoom {
    constructor(){ this.clients = []; this.handlers = {}; }
    setState(s){ this.state = s; } onMessage(k, fn){ this.handlers[k] = fn; } setSimulationInterval(){}
    broadcast(){} get clock(){ return { setTimeout(){} }; }
  }
  const TOK = { tokA: 'uidA', tokB: 'uidB' }, PID = { uidA: 'pidA', uidB: 'pidB' };
  const claimed = [];
  const Admin = { ENABLED: true, sessionStore: null,
    verifyUser: async t => TOK[t] || null, playerIdForUid: async u => PID[u] || null,
    claimMatch: async (mid) => { claimed.push(mid); return true; },
    grantReward: async () => ({ granted: {} }), storePurchases: async () => [],
    buyStorePart: async () => ({ ok: true, part: {}, credits: 0 }) };
  const stubs = {
    '@colyseus/core': { Room: FakeRoom, Server: class { define(n, k){ Room = k; return { filterBy(){ return this; } }; } } },
    '@colyseus/ws-transport': { WebSocketTransport: class { constructor(){ this.wss = { on(){} }; } } },
    'http': { createServer: h => { handler = h; return { listen(){} }; } },
    './supabase-admin.js': Admin,
    './sessions.js': { createSessions: () => sessions },
  };
  const orig = Module._load;
  Module._load = function(req){ return stubs[req] || orig.apply(this, arguments); };
  require(path.join(SRV, 'index.js'));
  Module._load = orig;

  const call = (url, body, token) => new Promise(resolve => {
    const req = new EventEmitter(); req.url = url; req.method = 'POST';
    req.headers = token ? { authorization: 'Bearer ' + token } : {}; req.destroy = () => {};
    const res = { writeHead(code){ this.code = code; }, end(txt){ resolve({ code: this.code, body: txt ? JSON.parse(txt) : null }); } };
    handler(req, res);
    req.emit('data', JSON.stringify(body)); req.emit('end');
  });
  let seq = 0;
  const mkClient = () => ({ sessionId: 'c' + (++seq), msgs: [], left: null,
    send(t, m){ this.msgs.push(t); }, leave(code){ this.left = code; } });
  const join = async (room, token, session, name) => {
    const c = mkClient(); room.clients.push(c);
    const auth = await room.onAuth(c, { token, session });
    room.onJoin(c, { name, wid: 'm17', equipped: {} }, auth);
    return c;
  };

  // claim + check over HTTP
  const c1 = await call('/session/claim', { session: S('pc1') }, 'tokA');
  ok('/session/claim needs a real token', (await call('/session/claim', { session: S('x') }, 'nope')).code === 401);
  ok('/session/claim gives this launch the account', c1.code === 200 && c1.body.ok && c1.body.pid === 'pidA');
  ok('/session/check says yes to the active device', (await call('/session/check', { pid: 'pidA', session: S('pc1') })).body.current === true);

  // PvP seats
  const arena = new Room(); arena.onCreate({ map: 'foundry' });
  const seatA = await join(arena, 'tokA', S('pc1'), 'JACOB');
  ok('the active device takes a live seat', arena.playerIds.get(seatA.sessionId) === 'pidA');

  await call('/session/claim', { session: S('pc2') }, 'tokA');      // the account is signed in on a second PC
  ok('a new sign-in elsewhere removes the old device from its match AT ONCE',
     seatA.msgs.includes('superseded') && seatA.left === 4001);
  ok('/session/check now tells the old device it lost', (await call('/session/check', { pid: 'pidA', session: S('pc1') })).body.current === false);

  let refused = null;
  try{ await join(arena, 'tokA', S('pc1'), 'JACOB'); }catch(e){ refused = e.message; }
  ok('the old device cannot rejoin with its stale session', /ANOTHER DEVICE/.test(refused || ''), refused);

  const seatB = await join(arena, 'tokA', S('pc2'), 'JACOB');
  ok('the new device joins - under the same callsign, which the old seat released', arena.playerIds.get(seatB.sessionId) === 'pidA');

  const arena2 = new Room(); arena2.onCreate({ map: 'foundry' });
  await join(arena2, 'tokA', S('pc2'), 'JACOB-2');
  ok('one account cannot hold seats in two matches (newest wins)', seatB.msgs.includes('superseded'));

  let noClaim = null;
  try{ await join(arena, 'tokB', S('b1'), 'SOMEONE'); }catch(e){ noClaim = e.message; }
  ok('an account that never claimed a session is refused a seat', /ANOTHER DEVICE/.test(noClaim || ''), noClaim);

  // rewards and the store: only the active device earns or spends
  const stale = await call('/reward/offline', { mid: 'm-stale', kills: 5, win: true, session: S('pc1') }, 'tokA');
  ok('the old device is refused match rewards', stale.code === 409 && stale.body.reason === 'superseded');
  ok('  and its match id is NOT burned, so it can still be claimed later', !claimed.includes('m-stale'));
  const none = await call('/reward/offline', { mid: 'm-none', kills: 5, win: true }, 'tokB');
  ok('a device that never claimed is told to claim, not paid', none.code === 409 && none.body.reason === 'no-session');
  const good = await call('/reward/offline', { mid: 'm-good', kills: 5, win: true, session: S('pc2') }, 'tokA');
  ok('the active device is paid', good.code === 200 && good.body.ok && claimed.includes('m-good'));
  const buyStale = await call('/store/buy', { idx: 0, session: S('pc1') }, 'tokA');
  ok('the old device cannot buy from the store', buyStale.code === 409 && buyStale.body.reason === 'superseded');
  const buyGood = await call('/store/buy', { idx: 0, session: S('pc2') }, 'tokA');
  ok('the active device can', buyGood.code === 200 && buyGood.body.ok);
})().catch(e => { console.error(e); fails++; }).then(() => {
  console.log(fails ? '\nsessions: ' + fails + ' failure(s)' : '\nsessions: all clear');
  process.exit(fails ? 1 : 0);
});

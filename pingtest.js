// Pure websocket round-trip probe — no game loop, no rendering, just the wire.
// Run from the repo root:  node pingtest.js
global.WebSocket = require('./server/node_modules/ws');
const fs = require('fs');
const src = fs.readFileSync('./renderer/vendor/colyseus.js', 'utf8');
(new Function('window','self','global', src + ';global.Colyseus=(typeof Colyseus!=="undefined")?Colyseus:window.Colyseus;'))(globalThis, globalThis, globalThis);

(async () => {
  const c = new Colyseus.Client('ws://143.47.107.61:2567');
  const room = await c.joinOrCreate('arena', { name: 'PINGTEST' });
  ['presence','kill','shot','rematch'].forEach(t => room.onMessage(t, () => {}));
  const times = [];
  let sentAt = 0, n = 0;
  room.onMessage('pong', () => {
    const rtt = performance.now() - sentAt;
    times.push(rtt);
    console.log('rtt ' + Math.round(rtt) + 'ms');
    if(++n < 10){ setTimeout(send, 300); }
    else {
      const s = [...times].sort((a,b) => a-b);
      console.log('--- min / median / max: ' + Math.round(s[0]) + ' / ' + Math.round(s[5]) + ' / ' + Math.round(s[9]) + ' ms ---');
      room.leave(); process.exit(0);
    }
  });
  function send(){ sentAt = performance.now(); room.send('ping', { t: sentAt }); }
  setTimeout(send, 500);
})().catch(e => { console.log('probe error:', e.message); process.exit(1); });
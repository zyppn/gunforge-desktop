/* Loopback OAuth callback for the desktop app.

   Discord's login page runs in the player's own browser, where they are usually already
   signed in, and the result has to come back into the game somehow. The options were a
   custom gunforge:// protocol, an embedded login window, or this. A custom protocol needs
   OS registration that differs per platform (and is unreliable for Linux AppImages); an
   embedded window makes the player type their Discord password into our app, which is
   the thing OAuth exists to avoid. A one-shot HTTP listener on 127.0.0.1 is the approach
   RFC 8252 recommends for native apps, and it behaves the same on every OS.

   It is only a mailbox. The code it receives is useless without the PKCE verifier, which
   never leaves the renderer, so a local process that races us to this port can do no
   more than make one sign-in attempt fail.

   Fixed ports, not port 0: Supabase only redirects to URLs on its allow list, so each
   port here must be listed there (server/AUTH_SETUP.md). */
const http = require('http');

const PORTS = [53682, 53683, 53684];
const CALLBACK_PATH = '/auth/callback';

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell = (title, body) => '<!doctype html><meta charset="utf-8"><title>GUNFORGE</title>'
  + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0D1117;color:#C9D4DE;'
  + 'font:15px ui-monospace,Menlo,Consolas,monospace}main{max-width:460px;padding:28px;border:1px solid #1E2731;'
  + 'border-radius:8px;background:#131A22}h1{margin:0 0 10px;font-size:15px;letter-spacing:.1em;color:#E8A33D}'
  + 'p{margin:0;line-height:1.5;opacity:.85}</style><main><h1>' + title + '</h1><p>' + body + '</p></main>';
const OK_PAGE = shell('DISCORD CONNECTED', 'You can close this tab and return to GUNFORGE.');
const errPage = d => shell('SIGN-IN DID NOT FINISH', esc(d || 'Discord did not complete the sign-in.') + ' Return to GUNFORGE to try again.');
/* Errors can come back in the URL #fragment instead of the query, and a browser never
   sends the fragment to a server. This page reads it and hands it back as a query, so an
   error is reported instead of the game waiting five minutes for nothing. */
const RELAY_PAGE = shell('FINISHING…', '<span id="m">One moment.</span>')
  + '<script>var h=location.hash.slice(1);if(h){fetch(location.pathname+"?"+h).then(function(r){return r.text()})'
  + '.then(function(t){document.open();document.write(t);document.close()})}'
  + 'else{document.getElementById("m").textContent="No sign-in result arrived. Return to GUNFORGE and try again."}</script>';

/* Resolves once a port is bound: { redirect, port, result, close }. `result` settles
   exactly once, with { code } | { error, error_code, error_description } | { timeout } |
   { cancelled }, and the server closes itself as soon as it does. */
function oauthListen(opt){
  const o = Object.assign({ ports: PORTS, path: CALLBACK_PATH, timeoutMs: 5 * 60 * 1000 }, opt || {});
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if(i >= o.ports.length){ reject(new Error('no free callback port: ' + o.ports.join(', '))); return; }
      const port = o.ports[i++];
      let settle, done = false, timer = null;
      const result = new Promise(r => { settle = r; });
      const server = http.createServer((req, res) => {
        let u; try{ u = new URL(req.url, 'http://127.0.0.1'); }catch(e){ res.writeHead(400); res.end(); return; }
        if(req.method !== 'GET' || u.pathname !== o.path){ res.writeHead(404, { 'Connection': 'close' }); res.end(); return; }
        const q = Object.fromEntries(u.searchParams);
        /* Connection: close, because this server is gone the moment it answers. A kept-
           alive socket outlives it, and the next attempt on the same port would be sent
           down that dead socket and hang up. */
        const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'close' };
        if(done){ res.writeHead(410, html); res.end(errPage('This sign-in link was already used.')); return; }
        if(q.code){ res.writeHead(200, html); res.end(OK_PAGE); finish({ code: q.code }); return; }
        if(q.error || q.error_code){
          res.writeHead(200, html); res.end(errPage(q.error_description));
          finish({ error: q.error || 'error', error_code: q.error_code || '', error_description: q.error_description || '' });
          return;
        }
        res.writeHead(200, html); res.end(RELAY_PAGE);
      });
      const finish = v => {
        if(done) return;
        done = true; clearTimeout(timer); settle(v);
        setImmediate(() => server.close());
      };
      server.once('error', err => {
        if(err.code === 'EADDRINUSE') tryNext();
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        timer = setTimeout(() => finish({ timeout: true }), o.timeoutMs);
        resolve({ redirect: 'http://127.0.0.1:' + port + o.path, port, result,
                  close: () => finish({ cancelled: true }), server });
      });
    };
    tryNext();
  });
}

/* The renderer asks main to open a URL in the player's browser. Only the auth hosts:
   shell.openExternal with an arbitrary URL is a well-known way to turn a renderer bug
   into running something on the player's machine. */
function isAuthUrl(url){
  let u; try{ u = new URL(url); }catch(e){ return false; }
  if(u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return h.endsWith('.supabase.co') || h === 'discord.com' || h.endsWith('.discord.com');
}

module.exports = { oauthListen, isAuthUrl, PORTS, CALLBACK_PATH };

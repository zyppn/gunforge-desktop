# Accounts, backups and the database: one-time setup

Everything here is done in the Supabase dashboard (project `rrpqxsiqvjhwbryencpj`)
or on the arena server. None of it is in code, which is why it is written down.

## 1. Check who can call the economy functions (do this first)

SQL editor:

```sql
select p.proname,
       p.prosecdef                                               as security_definer,
       has_function_privilege('anon', p.oid, 'execute')          as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as players_can_call
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by 1;
```

`add_progress` and `buy_store_part` must read **false / false**. If either reads true,
any copy of the game can call it directly with its own parameters (free parts, free
credits, for any player). Run `migrations/015_server_only_rpcs.sql`, then re-run the
query. The arena server uses the service key and is unaffected.

## 2. Save `add_progress` into the repo

It exists only in the live database. Dump it:

```sql
select pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'add_progress';
```

Paste the output into `migrations/016_add_progress.sql` (as `create or replace function`),
then remove `add_progress` from `KNOWN_MISSING` in `server/test/rpcs.test.js`. That test
fails until both are done, in either order.

## 3. Backups

Dashboard → Database → Backups shows what the plan keeps. The Free plan keeps
nothing; Pro keeps daily backups for 7 days, restorable only into this same project.
Either way, keep our own: `server/ops/backup-db.sh` dumps the `public` schema nightly
on the arena server. Setup steps are at the top of that file. The connection string is
Project Settings → Database → Connection string → **Session pooler** (the direct
connection is IPv6-only and the Oracle box may not route IPv6).

Test a restore once, into a scratch project. A backup nobody has restored is a hope.

## 4. Email sign-in

The client links an email to the guest account (the uid does not change, so the locker
stays) and signs in on other PCs with a 6-digit code.

1. **Custom SMTP — required.** Supabase's built-in mailer only delivers to members of
   your Supabase organization, and only a few messages an hour. Real players get
   nothing. Authentication → Emails → SMTP Settings. Resend's free tier is enough to
   start; verify a sending domain.
2. **Templates must contain the code.** Authentication → Emails → Templates. In both
   **Change Email Address** (used when a guest secures their account) and **Magic Link**
   (used to sign in) put `{{ .Token }}` in the body. Without it the email contains only
   a link, which cannot finish a sign-in inside the desktop app. Suggested body:
   `Your GUNFORGE code is {{ .Token }}. It expires in 10 minutes.`
3. Authentication → Providers → Email: keep **Email** enabled, set **Email OTP
   Expiration** to 600, OTP length 6.
4. Authentication → Sign In / Up: **Allow anonymous sign-ins** stays ON — every new
   install starts as a guest.
5. Authentication → Rate Limits: raise the email limit once SMTP is in (the default is
   sized for the built-in mailer).

`renderer/test/account.test.js` checks the client side against these endpoints.

## 5. Moving to Steam later

Accounts are keyed by the Supabase user id (`players.auth_uid`), not by how someone
signs in, so a Steam login attaches to an existing user rather than replacing it:

- The Steam build gets a session ticket from Steamworks (`GetAuthTicketForWebApi`) and
  sends it to the arena server, which verifies it with Steam's Web API
  (`ISteamUserAuth/AuthenticateUserTicket`) and gets a SteamID.
- First time: the player proves the account they already have (email code, or the
  guest session still on that PC), and the server stores the SteamID against that
  Supabase user. After that, the SteamID alone signs them in.
- Supabase has no built-in Steam provider (Steam is OpenID 2.0, not OAuth), so the
  arena server issues the session — it holds the service key and can do this.

What makes this work is that players have a recoverable identity **before** the
move. A guest who never secured their account can still carry over from the same PC
(the guest session is on disk), but not from a new one.

# GUNFORGE PvP server

Authoritative game server. Clients send inputs; the server owns truth.

## Run locally
    cd server && npm install && npm start     # ws://localhost:2567

## Deploy (Fly.io, ~free / Hetzner ~$5/mo)
Any Node host works. Expose the port, set PORT env. WebSockets required.

## Phases
1. DONE  — rooms, input-driven movement w/ collision, server hit-scan, kills, respawns
2. NEXT  — client netcode in renderer (join, send inputs, render remote players)
3. THEN  — verified loadouts: server pulls the player's equipped parts from Supabase
           and computes damage/ROF/spread itself (client stats become display-only)
4. THEN  — Supabase auth token on join; Steam session tickets swap in here later

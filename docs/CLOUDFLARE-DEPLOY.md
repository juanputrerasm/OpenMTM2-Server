# Deploying the room server on Cloudflare, step by step

This guide starts from nothing: no Cloudflare account, no Wrangler. At the end, OpenMTM2 players
can type your server's address under **Online rooms** and play. It takes about 15 minutes.

What the Worker is and what the free plan allows: [CLOUDFLARE.md](CLOUDFLARE.md).

## What you need

- A computer with **Node 22.18 or newer** (`node --version`). Get it from https://nodejs.org.
- **This repository** on that computer:
  ```sh
  git clone https://github.com/juanputrerasm/OpenMTM2-Server.git
  cd OpenMTM2-Server
  ```
- **An email address** for the Cloudflare account.

No payment card. The free plan never asks for one, and nothing is ever billed.

## Step 1: Make a Cloudflare account

1. Go to https://dash.cloudflare.com/sign-up.
2. Type your email and a password, then click **Sign up**.
3. Open the email Cloudflare sends you and click the link to verify the address. Some features stay
   locked until you do.
4. If the dashboard asks you to add a website or domain, skip it. A Worker needs no domain.

You are now on the free plan. Leave the plan as it is: don't pick "Workers Paid".

## Step 2: Choose your workers.dev name

Each account gets one free address of the form `<something>.workers.dev`. Your server will be at
`openmtm2-rooms.<something>.workers.dev`, and players will see and type this name, so pick
something short and neutral, such as `openmtm2` or your nickname.

1. In the dashboard's left menu, open **Compute (Workers)** (in some accounts it is called
   **Workers & Pages**).
2. If it shows a **workers.dev subdomain** box, type the name you want and confirm.

If you don't see the box, skip this step. Wrangler asks for the name in step 4 instead.

## Step 3: Connect Wrangler to your account

Wrangler is Cloudflare's command-line tool. It runs through `npx`, so there is nothing to install.
In a terminal, inside the `OpenMTM2-Server` folder:

```sh
npx wrangler login
```

1. The first time, `npx` asks `Ok to proceed? (y)`. Type `y`.
2. Your browser opens on a Cloudflare page. Log in if asked, then click **Allow**.
3. The terminal says `Successfully logged in`.

Check it:

```sh
npx wrangler whoami
```

It shows your email and your account ID.

## Step 4 (optional): Try it on your computer first

```sh
npm run worker:dev
```

This runs the Worker locally at `http://localhost:8787`. Run OpenMTM2 locally, type `localhost:8787`
under **Online rooms**, and create a room. Press `x` (or Ctrl+C) in the terminal to stop.

## Step 5: Check the settings

Open [cloudflare/wrangler.toml](../cloudflare/wrangler.toml). The lines you may want to change are
under `[vars]`:

| Line | What it does |
|---|---|
| `OPENMTM2_NAME` | The server's name, as players see it |
| `OPENMTM2_MOTD` | A message shown to players. Empty for none |
| `OPENMTM2_ORIGINS` | The web pages allowed to connect, comma separated. It must include the page OpenMTM2 is played from. `"*"` allows any |
| `OPENMTM2_LOCATION` | Where the rooms run: `enam` (eastern North America), `wnam` (western North America). Pick the one closer to most players |
| `maxRooms`, `maxPlayers` | Up to how many rooms, and how many players a room |

Leave the rest as it is. `name = "openmtm2-rooms"` is the first part of the address. You can
change it, but change it before the first deploy.

## Step 6: Deploy

```sh
npm run worker:deploy
```

- If your account has no workers.dev name yet, Wrangler asks for one now. Type it and confirm
  (see step 2 for how to choose).
- At the end it prints the address:
  ```
  Deployed openmtm2-rooms triggers
    https://openmtm2-rooms.<something>.workers.dev
  ```

The first deploy also creates the Durable Object that holds the rooms. Nothing else to set up.

## Step 7: Check it works

```sh
curl https://openmtm2-rooms.<something>.workers.dev/status
```

The answer looks like `{"rooms":0,"players":0,...,"maxRooms":20,"maxPlayers":8}`. You can also open
that address in a browser.

A new workers.dev address can take a minute or two to start answering. If `curl` fails right after
the first deploy, wait and try again.

## Step 8: Play

In OpenMTM2, under **Online rooms**, type the address without `https://`:

```
openmtm2-rooms.<something>.workers.dev
```

Create a room. Other players type the same address and see it in the list. Share the address with
them.

## Step 9 (optional): Turn on the admin endpoints

The admin endpoints let you list rooms, close a room, kick a player and ban an address. They stay
off until you set a token.

1. Make a long random token:
   ```sh
   openssl rand -hex 24
   ```
2. Store it in Cloudflare (it is a secret: it never goes in a file or on GitHub):
   ```sh
   npx wrangler secret put OPENMTM2_ADMIN_TOKEN --config cloudflare/wrangler.toml
   ```
   Paste the token when asked. This restarts the server.
3. Use it:
   ```sh
   TOKEN=<your token>
   URL=https://openmtm2-rooms.<something>.workers.dev
   curl -H "Authorization: Bearer $TOKEN" $URL/admin/rooms
   curl -H "Authorization: Bearer $TOKEN" -X POST $URL/admin/rooms/ABCD/close
   curl -H "Authorization: Bearer $TOKEN" -X POST $URL/admin/members/12/kick
   curl -H "Authorization: Bearer $TOKEN" -X POST -H "content-type: application/json" \
        -d '{"ip":"203.0.113.7","minutes":60,"reason":"griefing"}' $URL/admin/bans
   curl -H "Authorization: Bearer $TOKEN" -X DELETE $URL/admin/bans/203.0.113.7
   ```
   `minutes: 0` bans for good. Room codes and member numbers come from `/admin/rooms`.

## Day to day

| To | Do |
|---|---|
| Change a setting | Edit `cloudflare/wrangler.toml`, then `npm run worker:deploy` |
| Update to a new version | `git pull`, then `npm run worker:deploy` |
| Watch the log live | `npm run worker:tail` (Ctrl+C to stop) |
| See usage | Dashboard, **Compute (Workers)**, **openmtm2-rooms**, **Metrics** |
| Take the server down | `npx wrangler delete --config cloudflare/wrangler.toml` |

Every deploy, and every `secret put`, restarts the server and drops everyone connected. Rooms and
races in progress are lost; bans are kept. Deploy when nobody is racing.

## When something goes wrong

| What you see | Why, and what to do |
|---|---|
| `npx wrangler login` opens no browser | Copy the link the terminal prints into a browser by hand |
| `You need to register a workers.dev subdomain` | Do step 2, or answer Wrangler's question in step 6 |
| An error mentioning Durable Objects and the free plan | The file must keep `new_sqlite_classes` in `[[migrations]]`. The free plan only allows that kind |
| OpenMTM2 cannot connect, and the log says 403 | The page OpenMTM2 runs from is missing from `OPENMTM2_ORIGINS`. Add it and deploy |
| 429 Too Many Requests | Too many connections from one address. See `maxConnectionsPerIp` in [DAEMON.md](DAEMON.md) |
| `The server's settings are wrong: ...` | A setting in `wrangler.toml` is invalid; the message names it. Fix it and deploy |
| Everything fails until late in the day | The daily free requests ran out (about 2.3 hours of 8-player racing). They come back at 00:00 UTC, which is 7 or 8 pm US Eastern time. See [CLOUDFLARE.md](CLOUDFLARE.md#what-the-free-plan-allows) |

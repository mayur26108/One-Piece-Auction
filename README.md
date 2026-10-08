# Grand Line Bounty Auction

A free, self-hosted multiplayer auction game inspired by One Piece. It is intentionally **name-only**: there are no character images.

## What the game does

- Host chooses 2–8 players.
- Host chooses one starting budget for every player (for example, 50).
- Host chooses a bid timer (default 20 seconds; custom 5–120 seconds).
- One random, never-repeated character name is revealed at a time.
- Each connected player enters a whole-number bid and locks it.
- A bid can never exceed that player's remaining budget.
- Highest valid bid wins and the amount is deducted immediately.
- Full rosters (6/6) stop participating in paid bidding.
- If the highest bid is tied, the server randomly picks one tied player.
- If nobody submits a positive bid, the character is randomly assigned for 0.
- If a player reaches 0 budget before getting six characters, paid bidding stops for them; after the remaining auction reaches the exact number of empty slots that belong to bankrupt players, the leftover names automatically fill those slots so the game can never get stuck.
- End screen shows every player's six-character crew and remaining budget.

## Run it on your computer

### 1. Install Node.js
Install Node.js 18 or newer from https://nodejs.org/

### 2. Open this folder in a terminal

```bash
cd one-piece-bounty-auction
```

### 3. Install dependencies

```bash
npm install
```

### 4. Start the host server

```bash
npm start
```

Then open:

http://localhost:3000

The computer running this command is the host/server. Keep the terminal open during the game.

## Let friends join on the same Wi‑Fi

All players connect to the **same Wi‑Fi/LAN** as the host.

On Windows, find your host computer's local IP:

```powershell
ipconfig
```

Look for the IPv4 Address, for example `192.168.1.25`.

Friends open:

```text
http://192.168.1.25:3000
```

You create the lobby and receive a 5-character room code. Give that room code to your friends. They choose **Join a lobby**, enter the code, and use their own names.

If Windows Firewall asks whether Node.js should communicate on the network, allow it on your **Private network**.

## Invite friends over the internet

`localhost` and `192.168.x.x` only work on your computer/LAN. For friends who are somewhere else, use a free tunnel that exposes your local server temporarily.

A simple option is Cloudflare Tunnel (cloudflared). Install it from:

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Keep `npm start` running, then in a second terminal run:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will print a temporary `https://...trycloudflare.com` URL. Send that URL to your friends. They still enter the same in-game room code.

For a casual party game, this is easier than configuring router port forwarding. Do not expose an unprotected server publicly if you intend to run it for strangers.

## Using your exact character database

The app reads:

```text
data/characters.json
```

It expects an array of names:

```json
[
  "Monkey D. Luffy",
  "Roronoa Zoro",
  "Nami"
]
```

I included a starter One Piece character pool because the exact "One Piece Characters – Complete Database" file was not attached in this chat. The game itself does not depend on the starter list: you can replace `data/characters.json` with your own full database.

There is also an importer:

```bash
node tools/normalize-characters.js path/to/your-database.json
```

It understands common formats such as:

- `{"characters":[...]}`
- `[{"name":{"en":"MONKEY D. LUFFY"}}, ...]`
- `[{"name":"Monkey D. Luffy"}, ...]`
- `["Monkey D. Luffy", "Roronoa Zoro", ...]`

The importer removes duplicate names and sorts them.

## File structure

```text
one-piece-bounty-auction/
├─ server.js
├─ package.json
├─ README.md
├─ data/
│  └─ characters.json
├─ tools/
│  └─ normalize-characters.js
└─ public/
   ├─ index.html
   ├─ styles.css
   └─ app.js
```

## Important gameplay detail

A player is never charged for a bid that loses. Money is only deducted from the winner's budget after the auction resolves.

All important auction decisions happen on the server, not in the browser. That means the host's screen and the other players' screens all receive the same authoritative result.

## Attribution / theme note

The visual design is a fan-made, One Piece-inspired theme and does not ship character artwork. One public One Piece data package describes itself as a character-name dataset sourced from One Piece Wikia; this project instead keeps the character list local and editable so you can use your own complete database. 

For personal/fan use, respect the applicable rights and trademarks of One Piece and its publishers.

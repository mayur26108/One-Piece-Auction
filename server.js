const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_BUDGET = 1000000;
const DEFAULT_TIMER = 20;
const CHARACTERS_PER_PLAYER = 6;
const ROUND_REVEAL_MS = 1300;
const RESULT_HOLD_MS = 2300;
const DISCONNECT_GRACE_MS = 120000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });

const characterFile = path.join(__dirname, 'data', 'characters.json');
const characterPool = JSON.parse(fs.readFileSync(characterFile, 'utf8'));
if (!Array.isArray(characterPool) || characterPool.length < 48) {
  throw new Error('characters.json must contain at least 48 names.');
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/network-info', (_req, res) => {
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${PORT}`);
    }
  }
  res.json({ lanUrls: [...new Set(urls)] });
});
app.get('*path', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = new Map();

function uid() {
  return crypto.randomBytes(12).toString('hex');
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(items) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function safeName(raw) {
  const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return value.slice(0, 20);
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    budget: player.budget,
    startingBudget: player.startingBudget,
    characters: player.characters.slice(),
    characterCount: player.characters.length,
    connected: Boolean(player.socketId),
    isHost: player.id === player.roomHostId,
  };
}

function getAllPlayers(room) {
  return Array.from(room.players.values()).map(p => ({ ...publicPlayer({ ...p, roomHostId: room.hostId }) }));
}

function remainingSlots(room) {
  return Array.from(room.players.values()).reduce((sum, p) => sum + Math.max(0, CHARACTERS_PER_PLAYER - p.characters.length), 0);
}

function exhaustedSlots(room) {
  return Array.from(room.players.values()).reduce((sum, p) => {
    if (p.budget <= 0 && p.characters.length < CHARACTERS_PER_PLAYER) return sum + (CHARACTERS_PER_PLAYER - p.characters.length);
    return sum;
  }, 0);
}

function eligiblePaidPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.characters.length < CHARACTERS_PER_PLAYER && p.budget > 0 && p.socketId);
}

function eligibleSlotPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.characters.length < CHARACTERS_PER_PLAYER);
}

function roomState(room, viewerId) {
  return {
    roomCode: room.code,
    phase: room.phase,
    status: room.status,
    isHost: viewerId === room.hostId,
    hostId: room.hostId,
    settings: room.settings,
    players: getAllPlayers(room),
    round: room.round,
    totalRounds: room.totalRounds,
    charactersRemaining: room.remainingCharacters.length + (room.currentCharacter ? 1 : 0),
    currentCharacter: room.status === 'auction' || room.status === 'result' || room.status === 'fill' ? room.currentCharacter : null,
    timerEndsAt: room.timerEndsAt,
    bidsReceived: room.bids.size,
    eligibleBidderCount: eligiblePaidPlayers(room).length,
    viewerBid: room.bids.get(viewerId)?.amount ?? null,
    viewerBidLocked: Boolean(room.bids.get(viewerId)?.locked),
    result: room.result,
    fillPickerId: room.fillPickerId,
    message: room.message,
  };
}

function broadcastState(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('state', roomState(room, player.id));
  }
}

function addSystemMessage(room, message) {
  room.message = message;
}

function clearRound(room) {
  room.bids = new Map();
  room.result = null;
  room.timerEndsAt = null;
  for (const player of room.players.values()) {
    player.submitted = false;
    player.lockedBid = null;
  }
}

function finish(room) {
  clearTimeout(room.timeoutHandle);
  room.timeoutHandle = null;
  room.status = 'finished';
  room.phase = 'finished';
  room.currentCharacter = null;
  room.result = null;
  room.timerEndsAt = null;
  addSystemMessage(room, 'The crews are complete. The Grand Line standings are final.');
  broadcastState(room);
}

function shouldEnterFillPhase(room) {
  const slots = remainingSlots(room);
  if (slots <= 0) return true;
  const exhausted = exhaustedSlots(room);
  return exhausted > 0 && exhausted === slots;
}

function chooseFillPicker(room) {
  const zeroBudget = Array.from(room.players.values())
    .filter(p => p.budget <= 0 && p.characters.length < CHARACTERS_PER_PLAYER)
    .sort((a, b) => a.characters.length - b.characters.length || a.name.localeCompare(b.name));
  if (zeroBudget.length) return zeroBudget[0].id;
  const needs = eligibleSlotPlayers(room).sort((a, b) => a.characters.length - b.characters.length || a.name.localeCompare(b.name));
  return needs[0]?.id || null;
}

function beginFillPhase(room) {
  clearTimeout(room.timeoutHandle);
  room.timeoutHandle = null;
  room.status = 'fill';
  room.phase = 'fill';
  room.fillPickerId = chooseFillPicker(room);
  addSystemMessage(room, 'Budget exhausted. The remaining characters now fill the remaining roster slots.');
  startFillRound(room);
}

function startFillRound(room) {
  if (remainingSlots(room) <= 0) return finish(room);
  if (room.remainingCharacters.length === 0) return finish(room);
  room.round += 1;
  room.totalRounds = room.settings.playerCount * CHARACTERS_PER_PLAYER;
  room.currentCharacter = room.remainingCharacters.shift();
  room.result = null;
  room.timerEndsAt = null;
  room.fillPickerId = chooseFillPicker(room);
  addSystemMessage(room, `${room.players.get(room.fillPickerId)?.name || 'A crew'} receives the leftover pick.`);
  broadcastState(room);
  setTimeout(() => {
    if (!rooms.has(room.code) || room.status !== 'fill' || !room.currentCharacter) return;
    const picker = room.players.get(room.fillPickerId);
    if (picker && picker.characters.length < CHARACTERS_PER_PLAYER) {
      picker.characters.push(room.currentCharacter);
      room.result = { character: room.currentCharacter, winnerId: picker.id, winnerName: picker.name, bid: 0, reason: 'Free fill' };
    }
    room.currentCharacter = null;
    broadcastState(room);
    setTimeout(() => startFillRound(room), ROUND_REVEAL_MS);
  }, ROUND_REVEAL_MS);
}

function revealNextAuction(room) {
  if (remainingSlots(room) <= 0) return finish(room);
  if (room.remainingCharacters.length === 0) return finish(room);
  if (shouldEnterFillPhase(room)) return beginFillPhase(room);

  clearTimeout(room.timeoutHandle);
  room.timeoutHandle = null;
  clearRound(room);
  room.status = 'auction';
  room.phase = 'auction';
  room.round += 1;
  room.totalRounds = room.settings.playerCount * CHARACTERS_PER_PLAYER;
  room.currentCharacter = room.remainingCharacters.shift();
  room.timerEndsAt = Date.now() + (room.settings.timerSeconds * 1000);
  addSystemMessage(room, `Bid now. Highest valid bid wins. Ties are decided randomly.`);
  broadcastState(room);

  room.timeoutHandle = setTimeout(() => resolveAuction(room, 'timer'), room.settings.timerSeconds * 1000 + 40);
}

function resolveAuction(room, reason) {
  if (!rooms.has(room.code) || room.status !== 'auction' || !room.currentCharacter) return;
  clearTimeout(room.timeoutHandle);
  room.timeoutHandle = null;

  const eligible = eligiblePaidPlayers(room);
  const entries = eligible.map(player => {
    const bid = room.bids.get(player.id);
    const amount = bid ? Math.max(0, Math.min(player.budget, Number(bid.amount) || 0)) : 0;
    return { player, amount };
  });

  let maxBid = 0;
  for (const entry of entries) maxBid = Math.max(maxBid, entry.amount);

  let contenders = entries.filter(e => e.amount === maxBid);
  if (maxBid === 0) {
    // When nobody places a positive bid, the character is freely/randomly assigned
    // among everyone who still has a roster slot, including bankrupt players.
    contenders = eligibleSlotPlayers(room).map(player => ({ player, amount: 0 }));
  }

  if (!contenders.length) return finish(room);
  const winnerEntry = contenders[Math.floor(Math.random() * contenders.length)];
  const winner = winnerEntry.player;
  const bidAmount = winnerEntry.amount;
  winner.budget -= bidAmount;
  winner.characters.push(room.currentCharacter);

  room.result = {
    character: room.currentCharacter,
    winnerId: winner.id,
    winnerName: winner.name,
    bid: bidAmount,
    reason: maxBid > 0 ? (contenders.length > 1 ? 'Tie — random tiebreak' : 'Highest bid') : 'No positive bids — random assignment',
  };
  room.status = 'result';
  room.phase = 'result';
  room.timerEndsAt = null;
  const winnerNote = bidAmount > 0 ? `${winner.name} wins for ${bidAmount}.` : `${winner.name} gets it for free.`;
  addSystemMessage(room, winnerNote);
  broadcastState(room);

  if (remainingSlots(room) <= 0) return setTimeout(() => finish(room), RESULT_HOLD_MS);
  setTimeout(() => {
    if (rooms.has(room.code) && room.status === 'result') revealNextAuction(room);
  }, RESULT_HOLD_MS);
}

function createRoom(hostName, settings) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: {
      playerCount: settings.playerCount,
      startingBudget: settings.startingBudget,
      timerSeconds: settings.timerSeconds,
      charactersPerPlayer: CHARACTERS_PER_PLAYER,
    },
    status: 'lobby',
    phase: 'lobby',
    round: 0,
    totalRounds: settings.playerCount * CHARACTERS_PER_PLAYER,
    remainingCharacters: [],
    currentCharacter: null,
    timerEndsAt: null,
    bids: new Map(),
    result: null,
    fillPickerId: null,
    message: 'Waiting for the crew to join.',
    timeoutHandle: null,
  };
  const token = uid();
  const player = {
    id: uid(),
    token,
    name: hostName,
    socketId: null,
    startingBudget: settings.startingBudget,
    budget: settings.startingBudget,
    characters: [],
    submitted: false,
    lockedBid: null,
    disconnectTimer: null,
  };
  room.hostId = player.id;
  room.players.set(player.id, player);
  rooms.set(code, room);
  return { room, player };
}

function startGame(room) {
  if (room.status !== 'lobby') return { ok: false, error: 'Game already started.' };
  if (room.players.size !== room.settings.playerCount) return { ok: false, error: `Exactly ${room.settings.playerCount} players must be in the lobby.` };
  const disconnected = Array.from(room.players.values()).filter(p => !p.socketId);
  if (disconnected.length) return { ok: false, error: 'Everyone must be connected before starting.' };
  const needed = room.settings.playerCount * CHARACTERS_PER_PLAYER;
  if (characterPool.length < needed) return { ok: false, error: `Not enough characters in the database. Need ${needed}, have ${characterPool.length}.` };
  room.remainingCharacters = shuffle(characterPool);
  room.status = 'starting';
  room.phase = 'starting';
  room.message = 'The auction is about to begin…';
  broadcastState(room);
  setTimeout(() => {
    if (rooms.has(room.code) && room.status === 'starting') revealNextAuction(room);
  }, ROUND_REVEAL_MS);
  return { ok: true };
}

function findPlayerBySocket(socketId) {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (player.socketId === socketId) return { room, player };
    }
  }
  return null;
}

io.on('connection', socket => {
  socket.on('create_room', ({ name, playerCount, startingBudget, timerSeconds } = {}, ack) => {
    const playerName = safeName(name);
    const count = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Number(playerCount) || 3));
    const budget = Math.max(1, Math.min(MAX_BUDGET, Number(startingBudget) || 50));
    const timer = Math.max(5, Math.min(120, Number(timerSeconds) || DEFAULT_TIMER));
    if (!playerName) return ack?.({ ok: false, error: 'Enter your name.' });
    const { room, player } = createRoom(playerName, { playerCount: count, startingBudget: budget, timerSeconds: timer });
    player.socketId = socket.id;
    socket.data.playerToken = player.token;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    ack?.({ ok: true, roomCode: room.code, playerToken: player.token, playerId: player.id });
    broadcastState(room);
  });

  socket.on('join_room', ({ roomCode, name, playerToken } = {}, ack) => {
    const code = String(roomCode || '').trim().toUpperCase();
    const playerName = safeName(name);
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Lobby not found. Check the room code.' });

    let player = null;
    for (const p of room.players.values()) {
      if (playerToken && p.token === playerToken) {
        player = p;
        break;
      }
    }
    if (player) {
      player.socketId = socket.id;
      player.name = player.name || playerName;
      clearTimeout(player.disconnectTimer);
    } else {
      if (!playerName) return ack?.({ ok: false, error: 'Enter your name.' });
      if (room.status !== 'lobby') return ack?.({ ok: false, error: 'This game has already started.' });
      if (room.players.size >= room.settings.playerCount) return ack?.({ ok: false, error: 'This lobby is full.' });
      const duplicate = Array.from(room.players.values()).some(p => p.name.toLowerCase() === playerName.toLowerCase());
      if (duplicate) return ack?.({ ok: false, error: 'That player name is already taken in this lobby.' });
      player = {
        id: uid(), token: uid(), name: playerName, socketId: socket.id,
        startingBudget: room.settings.startingBudget, budget: room.settings.startingBudget,
        characters: [], submitted: false, lockedBid: null, disconnectTimer: null,
      };
      room.players.set(player.id, player);
    }
    socket.data.playerToken = player.token;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    ack?.({ ok: true, roomCode: room.code, playerToken: player.token, playerId: player.id });
    addSystemMessage(room, `${player.name} is in the lobby.`);
    broadcastState(room);
  });

  socket.on('start_game', (_payload, ack) => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return ack?.({ ok: false, error: 'You are not in a lobby.' });
    const { room, player } = found;
    if (player.id !== room.hostId) return ack?.({ ok: false, error: 'Only the host can start the game.' });
    const result = startGame(room);
    ack?.(result);
  });

  socket.on('submit_bid', ({ amount } = {}, ack) => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return ack?.({ ok: false, error: 'You are not in a lobby.' });
    const { room, player } = found;
    if (room.status !== 'auction') return ack?.({ ok: false, error: 'Bids are not open right now.' });
    if (player.characters.length >= CHARACTERS_PER_PLAYER) return ack?.({ ok: false, error: 'Your roster is full.' });
    if (player.budget <= 0) return ack?.({ ok: false, error: 'Your budget is exhausted. You are out of paid bidding.' });
    const numeric = Number(amount);
    if (!Number.isInteger(numeric) || numeric < 0) return ack?.({ ok: false, error: 'Bid must be a whole number, 0 or more.' });
    if (numeric > player.budget) return ack?.({ ok: false, error: `You only have ${player.budget} remaining.` });
    room.bids.set(player.id, { amount: numeric, locked: true });
    player.submitted = true;
    player.lockedBid = numeric;
    addSystemMessage(room, `${player.name} locked a bid.`);
    broadcastState(room);
    const eligibleCount = eligiblePaidPlayers(room).length;
    const submittedCount = eligiblePaidPlayers(room).filter(p => room.bids.get(p.id)).length;
    if (eligibleCount > 0 && submittedCount >= eligibleCount) {
      setTimeout(() => resolveAuction(room, 'all_bids'), 80);
    }
    ack?.({ ok: true });
  });

  socket.on('leave_room', (_payload, ack) => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return ack?.({ ok: true });
    const { room, player } = found;
    room.players.delete(player.id);
    if (room.status !== 'lobby') {
      // A leaving player keeps their already-earned characters out of the auction.
      // If this makes the game impossible, end it rather than silently corrupting scores.
      if (room.players.size < MIN_PLAYERS || remainingSlots(room) > room.remainingCharacters.length + (room.currentCharacter ? 1 : 0)) {
        addSystemMessage(room, 'A player left the game; the host must restart this lobby.');
      }
    }
    if (player.id === room.hostId) {
      const next = Array.from(room.players.values()).find(p => p.socketId);
      if (next) room.hostId = next.id;
    }
    if (room.players.size === 0) {
      clearTimeout(room.timeoutHandle);
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const found = findPlayerBySocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    player.socketId = null;
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => {
      if (!player.socketId && room.players.has(player.id) && room.status === 'lobby') {
        room.players.delete(player.id);
        if (room.hostId === player.id) {
          const next = Array.from(room.players.values())[0];
          room.hostId = next?.id || null;
        }
        broadcastState(room);
      }
    }, DISCONNECT_GRACE_MS);
    if (player.id === room.hostId) {
      const next = Array.from(room.players.values()).find(p => p.socketId && p.id !== player.id);
      if (next) room.hostId = next.id;
    }
    broadcastState(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Grand Line Bounty Auction running on http://localhost:${PORT}`);
  console.log(`LAN clients: use your computer's local IPv4 address with port ${PORT}.`);
});

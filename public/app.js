const socket = io();

const els = id => document.getElementById(id);
const views = {
  landing: els('landingView'), lobby: els('lobbyView'), game: els('gameView'), finish: els('finishView')
};
const storageKeys = { token: 'gla_player_token', room: 'gla_room_code', player: 'gla_player_id' };
let state = null;
let timerFrame = null;
let lastResultSignature = '';

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}
function setRoom(code) {
  els('roomPill').classList.toggle('hidden', !code);
  els('roomCodeText').textContent = code || '—';
  els('shareCode').textContent = code || '—';
}
function toast(message) {
  const t = els('toast'); t.textContent = message; t.classList.remove('hidden'); t.classList.remove('show');
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(window.__toast); window.__toast = setTimeout(() => t.classList.add('hidden'), 3200);
}
function saveSession(data) {
  localStorage.setItem(storageKeys.token, data.playerToken);
  localStorage.setItem(storageKeys.room, data.roomCode);
  localStorage.setItem(storageKeys.player, data.playerId);
}
function clearSession(){ Object.values(storageKeys).forEach(k => localStorage.removeItem(k)); }
function getSession(){ return { token: localStorage.getItem(storageKeys.token), room: localStorage.getItem(storageKeys.room), player: localStorage.getItem(storageKeys.player) }; }
function customTimerValue(){
  const mode = els('timerSeconds').value;
  if(mode !== 'custom') return Number(mode);
  return Math.max(5, Math.min(120, Number(els('customTimer').value)||20));
}
function findMe(){ return state?.players?.find(p => p.id === getSession().player) || null; }

els('timerSeconds').addEventListener('change', () => els('customTimerWrap').classList.toggle('hidden', els('timerSeconds').value !== 'custom'));
els('createForm').addEventListener('submit', e => {
  e.preventDefault();
  els('createError').textContent = '';
  socket.emit('create_room', {
    name: els('hostName').value.trim(), playerCount: Number(els('playerCount').value),
    startingBudget: Number(els('startingBudget').value), timerSeconds: customTimerValue()
  }, result => {
    if(!result?.ok){ els('createError').textContent = result?.error || 'Could not create room.'; return; }
    saveSession(result); setRoom(result.roomCode); showView('lobby');
  });
});

els('joinForm').addEventListener('submit', e => {
  e.preventDefault();
  els('joinError').textContent = '';
  socket.emit('join_room', { roomCode: els('joinRoom').value.trim(), name: els('joinName').value.trim(), playerToken: getSession().token }, result => {
    if(!result?.ok){ els('joinError').textContent = result?.error || 'Could not join room.'; return; }
    saveSession(result); setRoom(result.roomCode); showView('lobby');
  });
});

els('copyInvite').addEventListener('click', async () => {
  if(!state?.roomCode) return;
  let url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomCode)}`;
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
    try {
      const info = await fetch('/network-info').then(r => r.json());
      if (info?.lanUrls?.[0]) url = `${info.lanUrls[0]}${location.pathname}?room=${encodeURIComponent(state.roomCode)}`;
    } catch {}
  }
  const text = `Grand Line Bounty Auction — Join here: ${url} — Room code: ${state.roomCode}`;
  try { await navigator.clipboard.writeText(text); toast('Invite details copied.'); }
  catch { toast(`Room code: ${state.roomCode}`); }
});

els('startGame').addEventListener('click', () => {
  els('lobbyError').textContent = '';
  socket.emit('start_game', {}, result => { if(!result?.ok) els('lobbyError').textContent = result?.error || 'Could not start.'; });
});

els('bidForm').addEventListener('submit', e => {
  e.preventDefault();
  const me = findMe();
  const value = Number(els('bidInput').value);
  if(!Number.isInteger(value) || value < 0){ toast('Enter a whole-number bid.'); return; }
  if(me && value > me.budget){ toast(`Your budget is only ${me.budget}.`); return; }
  socket.emit('submit_bid', { amount: value }, result => { if(!result?.ok) toast(result?.error || 'Bid rejected.'); });
});

els('backHome').addEventListener('click', () => { clearSession(); state=null; setRoom(null); showView('landing'); location.href = location.pathname; });

socket.on('connect', () => {
  const session = getSession();
  const qsRoom = new URLSearchParams(location.search).get('room');
  if(session.token && session.room){
    socket.emit('join_room', { roomCode: session.room, playerToken: session.token, name: '' }, result => {
      if(!result?.ok){ clearSession(); if(qsRoom) els('joinRoom').value = qsRoom; return; }
      saveSession(result); setRoom(result.roomCode);
    });
  } else if(qsRoom) els('joinRoom').value = qsRoom.toUpperCase();
});

socket.on('state', incoming => {
  state = incoming; setRoom(incoming.roomCode); render(incoming);
});
socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));

function render(incoming){
  if(incoming.status === 'lobby') return renderLobby(incoming);
  if(incoming.status === 'starting' || incoming.status === 'auction' || incoming.status === 'result' || incoming.status === 'fill') return renderGame(incoming);
  if(incoming.status === 'finished') return renderFinish(incoming);
}
function renderLobby(s){
  showView('lobby');
  els('crewCount').textContent = `${s.players.length} / ${s.settings.playerCount}`;
  els('lobbyStatus').textContent = s.players.length === s.settings.playerCount ? 'All seats are filled. Host can start.' : `Waiting for ${s.settings.playerCount - s.players.length} more player(s)…`;
  els('startGame').disabled = !s.isHost || s.players.length !== s.settings.playerCount || s.players.some(p => !p.connected);
  els('inviteHint').textContent = `Same Wi‑Fi: send this page URL + room code. Internet: use the tunnel instructions in README.md.`;
  els('playerList').innerHTML = s.players.map((p, i) => `
    <div class="player-row">
      <div class="player-left"><div class="avatar">${i+1}</div><div class="player-meta"><strong>${escapeHtml(p.name)} ${p.isHost ? '★' : ''}</strong><span class="${p.connected ? '' : 'disconnected'}">${p.connected ? 'Connected' : 'Disconnected'}</span></div></div>
      <div class="badge">${p.startingBudget} B</div>
    </div>`).join('');
}
function renderGame(s){
  showView('game');
  els('charsLeft').textContent = s.charactersRemaining;
  els('roundText').textContent = `${Math.min(s.round, s.totalRounds)} / ${s.totalRounds}`;
  els('gameMessage').textContent = s.message || '';
  els('characterName').textContent = s.currentCharacter || (s.status === 'starting' ? 'READY' : '—');
  els('phaseKicker').textContent = s.status === 'fill' ? 'LEFTOVER FILL' : `ROUND ${s.round}`;
  els('phaseTitle').textContent = s.status === 'result' ? 'Character claimed' : s.status === 'fill' ? 'Final roster fill' : s.status === 'starting' ? 'Set your sails' : 'Place your bid';

  const me = findMe();
  els('bidInput').disabled = s.status !== 'auction' || !me || me.budget <= 0 || me.characterCount >= s.settings.charactersPerPlayer;
  els('bidForm').classList.toggle('hidden', s.status !== 'auction');
  els('timerBox').classList.toggle('hidden', s.status !== 'auction');
  els('resultBox').classList.toggle('hidden', s.status !== 'result');
  if(me){
    els('bidHelp').textContent = me.budget <= 0 ? 'Budget exhausted — your remaining slots will be filled from the leftovers.' : `Remaining budget: ${me.budget}`;
    if(s.viewerBid !== null) els('bidInput').value = s.viewerBid;
  }

  if(s.status === 'result' && s.result){
    els('resultWinner').textContent = s.result.winnerName;
    els('resultMeta').textContent = s.result.bid > 0 ? `Won ${s.result.character} for ${s.result.bid} • ${s.result.reason}` : `Won ${s.result.character} for 0 • ${s.result.reason}`;
  }
  renderScoreboard(s);
  updateTimer(s);
}
function renderScoreboard(s){
  els('bidCount').textContent = s.status === 'auction' ? `${s.bidsReceived} / ${s.eligibleBidderCount}` : '—';
  els('scoreboard').innerHTML = s.players.map(p => {
    const pct = Math.min(100, Math.max(0, (p.characterCount / s.settings.charactersPerPlayer) * 100));
    const chars = p.characters.length ? p.characters.join(' • ') : 'No characters yet';
    return `<div class="score-row"><div class="score-head"><strong>${escapeHtml(p.name)}</strong><span class="money">${p.budget}</span></div><div class="progress"><span style="width:${pct}%"></span></div><div class="score-foot"><span>${p.characterCount}/${s.settings.charactersPerPlayer} characters</span><span>${p.budget <= 0 ? 'BANKRUPT' : p.connected ? 'ONLINE' : 'OFFLINE'}</span></div><div class="score-characters">${escapeHtml(chars)}</div></div>`;
  }).join('');
}
function renderFinish(s){
  showView('finish');
  els('finalScoreboard').innerHTML = s.players.map(p => `
    <div class="final-card"><div class="eyebrow">${escapeHtml(p.name)}</div><h3>CREW COMPLETE</h3><div class="final-money">${p.budget} B LEFT</div><div class="final-chars">${p.characters.map(c => `<div class="char-chip">${escapeHtml(c)}</div>`).join('')}</div></div>`).join('');
}
function updateTimer(s){
  cancelAnimationFrame(timerFrame);
  if(s.status !== 'auction' || !s.timerEndsAt){ els('timerNumber').textContent='—'; els('timerFill').style.width='0%'; return; }
  const total = s.settings.timerSeconds*1000;
  const tick = () => {
    const left = Math.max(0, s.timerEndsAt - Date.now());
    els('timerNumber').textContent = Math.ceil(left/1000);
    els('timerFill').style.width = `${(left/total)*100}%`;
    if(left>0) timerFrame = requestAnimationFrame(tick);
  };
  tick();
}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

// Populate room code from URL after page load.
(() => { const room = new URLSearchParams(location.search).get('room'); if(room) els('joinRoom').value = room.toUpperCase(); })();

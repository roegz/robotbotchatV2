// game.js
// Dessin collaboratif en temps reel, sur fond blanc, avec un ami (invitation
// a accepter/refuser, comme un appel) ou dans un groupe (pas d'invitation
// necessaire, on est deja entre amis dans le groupe). Fonctionne independamment
// d'un appel : les deux peuvent tourner en meme temps.

const COLORS = ['#2A2A24', '#B3462C', '#C08A2E', '#3F6652', '#4C6A8A', '#8A4C6A', '#7A5A3A', '#FFFFFF'];
const STROKE_SIZE_PX = 4; // taille de trait fixe, a l'echelle du canvas de celui qui dessine

const gameOverlayEl = document.getElementById('game-overlay');
const gameTitleEl = document.getElementById('game-title');
const gameCanvas = document.getElementById('game-canvas');
const gameCtx = gameCanvas.getContext('2d');
const gamePaletteEl = document.getElementById('game-palette');
const btnGame = document.getElementById('btn-game');
const btnGameStop = document.getElementById('btn-game-stop');
const btnGameClear = document.getElementById('btn-game-clear');

const drawIncomingEl = document.getElementById('draw-incoming');
const drawIncomingNameEl = document.getElementById('draw-incoming-name');
const btnDrawAccept = document.getElementById('btn-draw-accept');
const btnDrawReject = document.getElementById('btn-draw-reject');

const drawWaitingEl = document.getElementById('draw-waiting');
const drawWaitingNameEl = document.getElementById('draw-waiting-name');
const btnDrawCancel = document.getElementById('btn-draw-cancel');

let gameMode = null; // 'friend' | 'group' | null
let gamePeerId = null;
let gamePeerPseudo = '';
let gameGroupId = null;
let pendingInviteId = null; // on attend que cette personne accepte notre invitation
let pendingIncomingId = null; // cette personne nous a invite, on n'a pas encore repondu
let pendingIncomingPseudo = '';
let currentColor = COLORS[0];
let isDrawing = false;
let lastPoint = null;
let strokeHistory = []; // pour pouvoir redessiner si la fenetre change de taille

function socket() {
  return RBC.state.socket;
}

// --------------------------- palette ---------------------------

COLORS.forEach((color, index) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'color-swatch' + (index === 0 ? ' is-selected' : '');
  btn.style.background = color;
  btn.addEventListener('click', () => {
    currentColor = color;
    gamePaletteEl.querySelectorAll('.color-swatch').forEach((el) => el.classList.remove('is-selected'));
    btn.classList.add('is-selected');
  });
  gamePaletteEl.appendChild(btn);
});

// --------------------------- canvas ---------------------------

function resizeCanvas() {
  gameCanvas.width = gameCanvas.clientWidth;
  gameCanvas.height = gameCanvas.clientHeight;
  redrawAll();
}
window.addEventListener('resize', () => {
  if (!gameOverlayEl.hidden) resizeCanvas();
});

function redrawAll() {
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  strokeHistory.forEach((s) => drawNormalizedSegment(s.x0, s.y0, s.x1, s.y1, s.color, s.size));
}

function drawRawSegment(x0, y0, x1, y1, color, sizePx) {
  gameCtx.strokeStyle = color;
  gameCtx.lineWidth = sizePx;
  gameCtx.lineCap = 'round';
  gameCtx.lineJoin = 'round';
  gameCtx.beginPath();
  gameCtx.moveTo(x0, y0);
  gameCtx.lineTo(x1, y1);
  gameCtx.stroke();
}

function drawNormalizedSegment(nx0, ny0, nx1, ny1, color, nsize) {
  drawRawSegment(
    nx0 * gameCanvas.width,
    ny0 * gameCanvas.height,
    nx1 * gameCanvas.width,
    ny1 * gameCanvas.height,
    color,
    nsize * gameCanvas.width
  );
}

function getRelativePoint(evt) {
  const rect = gameCanvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

function sendStroke(strokeNormalized) {
  if (!socket()) return;
  if (gameMode === 'friend' && gamePeerId) {
    socket().emit('draw:stroke', { to: gamePeerId, stroke: strokeNormalized });
  } else if (gameMode === 'group' && gameGroupId) {
    socket().emit('draw:group:stroke', { groupId: gameGroupId, stroke: strokeNormalized });
  }
}

function handleLocalSegment(p0, p1) {
  drawRawSegment(p0.x, p0.y, p1.x, p1.y, currentColor, STROKE_SIZE_PX);
  const stroke = {
    x0: p0.x / gameCanvas.width,
    y0: p0.y / gameCanvas.height,
    x1: p1.x / gameCanvas.width,
    y1: p1.y / gameCanvas.height,
    color: currentColor,
    size: STROKE_SIZE_PX / gameCanvas.width,
  };
  strokeHistory.push(stroke);
  sendStroke(stroke);
}

gameCanvas.addEventListener('pointerdown', (e) => {
  if (!gameMode) return;
  isDrawing = true;
  lastPoint = getRelativePoint(e);
  gameCanvas.setPointerCapture(e.pointerId);
});
gameCanvas.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  const point = getRelativePoint(e);
  handleLocalSegment(lastPoint, point);
  lastPoint = point;
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((evtName) => {
  gameCanvas.addEventListener(evtName, () => {
    isDrawing = false;
    lastPoint = null;
  });
});

// --------------------------- ouverture / fermeture ---------------------------

function openGameOverlay(title) {
  strokeHistory = [];
  gameTitleEl.textContent = title;
  gameOverlayEl.hidden = false;
  requestAnimationFrame(resizeCanvas);
}

function closeGame(silent) {
  if (gameMode === 'friend' && gamePeerId && !silent) {
    socket().emit('draw:end', { to: gamePeerId });
  }
  gameMode = null;
  gamePeerId = null;
  gamePeerPseudo = '';
  gameGroupId = null;
  strokeHistory = [];
  gameOverlayEl.hidden = true;
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
}

btnGameStop.addEventListener('click', () => closeGame(false));

btnGameClear.addEventListener('click', () => {
  gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  strokeHistory = [];
  if (gameMode === 'friend' && gamePeerId) socket().emit('draw:clear', { to: gamePeerId });
  else if (gameMode === 'group' && gameGroupId) socket().emit('draw:group:clear', { groupId: gameGroupId });
});

// --------------------------- lancer une session (ami) ---------------------------

btnGame.addEventListener('click', () => {
  if (gameMode) {
    RBC.showToast('Tu es deja dans une session de dessin.', true);
    return;
  }
  if (RBC.state.activeGroupId) {
    const group = getGroupById(RBC.state.activeGroupId);
    if (!group) return;
    gameMode = 'group';
    gameGroupId = group.id;
    openGameOverlay(group.name);
  } else if (RBC.state.activeFriendId) {
    const friend = RBC.getFriendById(RBC.state.activeFriendId);
    if (!friend) return;
    if (!friend.online) {
      RBC.showToast(friend.pseudo + " n'est pas en ligne pour le moment.", true);
      return;
    }
    pendingInviteId = friend.id;
    drawWaitingNameEl.textContent = friend.pseudo;
    drawWaitingEl.hidden = false;
    socket().emit('draw:invite', { to: friend.id });
  }
});

btnDrawCancel.addEventListener('click', () => {
  if (pendingInviteId) socket().emit('draw:cancel', { to: pendingInviteId });
  drawWaitingEl.hidden = true;
  pendingInviteId = null;
});

function handleDrawIncoming({ fromId, fromPseudo }) {
  if (gameMode) {
    socket().emit('draw:reject', { to: fromId });
    return;
  }
  pendingIncomingId = fromId;
  pendingIncomingPseudo = fromPseudo;
  drawIncomingNameEl.textContent = fromPseudo;
  drawIncomingEl.hidden = false;
}

btnDrawReject.addEventListener('click', () => {
  if (pendingIncomingId) socket().emit('draw:reject', { to: pendingIncomingId });
  drawIncomingEl.hidden = true;
  pendingIncomingId = null;
});

btnDrawAccept.addEventListener('click', () => {
  const peerId = pendingIncomingId;
  const peerPseudo = pendingIncomingPseudo;
  drawIncomingEl.hidden = true;
  pendingIncomingId = null;
  gameMode = 'friend';
  gamePeerId = peerId;
  gamePeerPseudo = peerPseudo;
  socket().emit('draw:accept', { to: peerId });
  openGameOverlay(peerPseudo);
});

function handleDrawAccepted({ fromId }) {
  if (fromId !== pendingInviteId) return;
  drawWaitingEl.hidden = true;
  const friend = RBC.getFriendById(fromId);
  gameMode = 'friend';
  gamePeerId = fromId;
  gamePeerPseudo = friend ? friend.pseudo : '';
  pendingInviteId = null;
  openGameOverlay(gamePeerPseudo);
}

function handleDrawRejected({ fromId }) {
  if (fromId !== pendingInviteId) return;
  drawWaitingEl.hidden = true;
  RBC.showToast('Demande de dessin refusee.');
  pendingInviteId = null;
}

function handleDrawCancelled({ fromId }) {
  if (fromId !== pendingIncomingId) return;
  drawIncomingEl.hidden = true;
  pendingIncomingId = null;
}

function handleDrawEnd({ fromId }) {
  if (gameMode === 'friend' && gamePeerId === fromId) {
    RBC.showToast(gamePeerPseudo + ' a arrete le dessin.');
    closeGame(true);
  }
}

function handleDrawStroke({ fromId, stroke }) {
  if (gameMode === 'friend' && gamePeerId === fromId) {
    strokeHistory.push(stroke);
    drawNormalizedSegment(stroke.x0, stroke.y0, stroke.x1, stroke.y1, stroke.color, stroke.size);
  }
}

function handleDrawClear({ fromId }) {
  if (gameMode === 'friend' && gamePeerId === fromId) {
    gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
    strokeHistory = [];
  }
}

function handleGroupDrawStroke({ groupId, stroke }) {
  if (gameMode === 'group' && gameGroupId === groupId) {
    strokeHistory.push(stroke);
    drawNormalizedSegment(stroke.x0, stroke.y0, stroke.x1, stroke.y1, stroke.color, stroke.size);
  }
}

function handleGroupDrawClear({ groupId }) {
  if (gameMode === 'group' && gameGroupId === groupId) {
    gameCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
    strokeHistory = [];
  }
}

// si l'ami avec qui on dessine (ou avec qui on a une invitation en cours) se
// deconnecte, on ferme proprement au lieu de rester bloque a attendre.
RBC.closeGameIfPeer = function (userId) {
  if (pendingInviteId === userId) {
    drawWaitingEl.hidden = true;
    pendingInviteId = null;
    RBC.showToast('La personne invitee s\u2019est deconnectee.', true);
  }
  if (pendingIncomingId === userId) {
    drawIncomingEl.hidden = true;
    pendingIncomingId = null;
  }
  if (gameMode === 'friend' && gamePeerId === userId) {
    RBC.showToast(gamePeerPseudo + ' s\u2019est deconnecte.', true);
    closeGame(true);
  }
};

// --------------------------- branchement des evenements socket ---------------------------

RBC.onSocketReady(function (socketInstance) {
  socketInstance.on('draw:incoming', handleDrawIncoming);
  socketInstance.on('draw:accepted', handleDrawAccepted);
  socketInstance.on('draw:rejected', handleDrawRejected);
  socketInstance.on('draw:cancelled', handleDrawCancelled);
  socketInstance.on('draw:end', handleDrawEnd);
  socketInstance.on('draw:stroke', handleDrawStroke);
  socketInstance.on('draw:clear', handleDrawClear);
  socketInstance.on('draw:group:stroke', handleGroupDrawStroke);
  socketInstance.on('draw:group:clear', handleGroupDrawClear);
  socketInstance.on('disconnect', () => {
    if (gameMode) closeGame(true);
    drawWaitingEl.hidden = true;
    drawIncomingEl.hidden = true;
    pendingInviteId = null;
    pendingIncomingId = null;
  });
});

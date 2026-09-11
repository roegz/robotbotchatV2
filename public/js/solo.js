// solo.js
// Petit jeu 100% local (aucun echange reseau) pour s'occuper quand on est
// seul : un Snake classique. Le meilleur score est garde dans le navigateur
// (localStorage) pour se souvenir du record d'une visite a l'autre.

const SOLO_GRID_SIZE = 18;
const SOLO_TICK_MS = 130;
const SOLO_BEST_KEY = 'rbc_snake_best';

const soloOverlayEl = document.getElementById('solo-game-overlay');
const soloCanvas = document.getElementById('solo-canvas');
const soloCtx = soloCanvas.getContext('2d');
const soloScoreEl = document.getElementById('solo-score');
const soloMessageEl = document.getElementById('solo-overlay-message');
const soloMessageTextEl = document.getElementById('solo-overlay-text');
const btnSoloGame = document.getElementById('btn-solo-game');
const btnSoloClose = document.getElementById('btn-solo-close');
const btnSoloRestart = document.getElementById('btn-solo-restart');

let soloCellPx = 20;
let soloSnake = [];
let soloDir = { x: 1, y: 0 };
let soloNextDir = { x: 1, y: 0 };
let soloFood = null;
let soloScore = 0;
let soloBestScore = 0;
let soloTimer = null;
let soloRunning = false;

function soloLoadBest() {
  try {
    soloBestScore = parseInt(localStorage.getItem(SOLO_BEST_KEY) || '0', 10) || 0;
  } catch (e) {
    soloBestScore = 0;
  }
}

function soloSaveBest() {
  try {
    localStorage.setItem(SOLO_BEST_KEY, String(soloBestScore));
  } catch (e) {
    // stockage indisponible (navigation privee, etc.) : tant pis, pas bloquant
  }
}

function soloUpdateScoreLabel() {
  soloScoreEl.textContent = 'Score : ' + soloScore + ' — Record : ' + soloBestScore;
}

function soloResizeCanvas() {
  const wrap = soloCanvas.parentElement;
  const available = Math.min(wrap.clientWidth, wrap.clientHeight, 480) - 16;
  soloCellPx = Math.max(8, Math.floor(available / SOLO_GRID_SIZE));
  const pixelSize = soloCellPx * SOLO_GRID_SIZE;
  soloCanvas.width = pixelSize;
  soloCanvas.height = pixelSize;
  soloDraw();
}
window.addEventListener('resize', () => {
  if (!soloOverlayEl.hidden) soloResizeCanvas();
});

function soloRandomFood() {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * SOLO_GRID_SIZE), y: Math.floor(Math.random() * SOLO_GRID_SIZE) };
  } while (soloSnake.some((s) => s.x === pos.x && s.y === pos.y));
  return pos;
}

function soloStart() {
  const mid = Math.floor(SOLO_GRID_SIZE / 2);
  soloSnake = [
    { x: mid, y: mid },
    { x: mid - 1, y: mid },
    { x: mid - 2, y: mid },
  ];
  soloDir = { x: 1, y: 0 };
  soloNextDir = { x: 1, y: 0 };
  soloFood = soloRandomFood();
  soloScore = 0;
  soloUpdateScoreLabel();
  soloMessageEl.hidden = true;
  soloRunning = true;
  if (soloTimer) clearInterval(soloTimer);
  soloTimer = setInterval(soloTick, SOLO_TICK_MS);
  soloDraw();
}

function soloTick() {
  soloDir = soloNextDir;
  const head = soloSnake[0];
  const newHead = { x: head.x + soloDir.x, y: head.y + soloDir.y };
  const hitsWall = newHead.x < 0 || newHead.y < 0 || newHead.x >= SOLO_GRID_SIZE || newHead.y >= SOLO_GRID_SIZE;
  const hitsSelf = soloSnake.some((s) => s.x === newHead.x && s.y === newHead.y);
  if (hitsWall || hitsSelf) {
    soloGameOver();
    return;
  }
  soloSnake.unshift(newHead);
  if (newHead.x === soloFood.x && newHead.y === soloFood.y) {
    soloScore += 1;
    soloUpdateScoreLabel();
    soloFood = soloRandomFood();
  } else {
    soloSnake.pop();
  }
  soloDraw();
}

function soloGameOver() {
  soloRunning = false;
  if (soloTimer) {
    clearInterval(soloTimer);
    soloTimer = null;
  }
  const isRecord = soloScore > soloBestScore && soloScore > 0;
  if (isRecord) {
    soloBestScore = soloScore;
    soloSaveBest();
  }
  soloUpdateScoreLabel();
  soloMessageTextEl.textContent = 'Perdu ! Score : ' + soloScore + (isRecord ? ' — nouveau record !' : '');
  soloMessageEl.hidden = false;
}

function soloDraw() {
  soloCtx.clearRect(0, 0, soloCanvas.width, soloCanvas.height);
  soloSnake.forEach((seg, i) => {
    soloCtx.fillStyle = i === 0 ? '#2E4C3C' : '#3F6652';
    soloCtx.fillRect(seg.x * soloCellPx + 1, seg.y * soloCellPx + 1, soloCellPx - 2, soloCellPx - 2);
  });
  if (soloFood) {
    soloCtx.fillStyle = '#C08A2E';
    soloCtx.beginPath();
    soloCtx.arc(
      soloFood.x * soloCellPx + soloCellPx / 2,
      soloFood.y * soloCellPx + soloCellPx / 2,
      soloCellPx / 2.6,
      0,
      Math.PI * 2
    );
    soloCtx.fill();
  }
}

function soloSetDirection(dx, dy) {
  if (!soloRunning) return;
  // empeche de faire un demi-tour direct sur soi-meme
  if (soloSnake.length > 1 && dx === -soloDir.x && dy === -soloDir.y) return;
  soloNextDir = { x: dx, y: dy };
}

const SOLO_KEY_MAP = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
};

document.addEventListener('keydown', (e) => {
  if (soloOverlayEl.hidden) return;
  const dir = SOLO_KEY_MAP[e.key];
  if (dir) {
    e.preventDefault();
    soloSetDirection(dir[0], dir[1]);
  }
});

const SOLO_DIR_BUTTON_MAP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
document.querySelectorAll('.solo-dir-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = SOLO_DIR_BUTTON_MAP[btn.dataset.dir];
    if (d) soloSetDirection(d[0], d[1]);
  });
});

btnSoloRestart.addEventListener('click', soloStart);

btnSoloGame.addEventListener('click', () => {
  soloLoadBest();
  soloOverlayEl.hidden = false;
  requestAnimationFrame(() => {
    soloResizeCanvas();
    soloStart();
  });
});

btnSoloClose.addEventListener('click', () => {
  soloRunning = false;
  if (soloTimer) {
    clearInterval(soloTimer);
    soloTimer = null;
  }
  soloOverlayEl.hidden = true;
});

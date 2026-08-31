// server.js
// Point d'entree du site "robotbotchatV2".
// Sert le site statique (public/), expose une petite API REST pour
// l'authentification et les amis, et gere le temps reel (messages,
// notifications, signalisation des appels video) via Socket.IO.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('./db');

const PORT = process.env.PORT || 3000;

// En production (Render), pense a definir la variable d'environnement JWT_SECRET
// (Dashboard Render -> ton service -> Environment -> Add Environment Variable).
// Sans ca, une cle aleatoire est generee au demarrage : ca fonctionne, mais tout
// le monde est deconnecte a chaque redemarrage du serveur.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    "[robotbotchatV2] Aucune variable d'environnement JWT_SECRET definie : une cle temporaire a ete generee. " +
      'Definis JWT_SECRET sur Render pour eviter de deconnecter tout le monde a chaque redemarrage.'
  );
}
const TOKEN_LIFETIME = '90d'; // duree de connexion : reste connecte 90 jours sans se reconnecter

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // pingTimeout/pingInterval un peu plus genereux : evite des deconnexions
  // intempestives quand le service Render se reveille apres une mise en veille.
  pingTimeout: 20000,
  pingInterval: 15000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const PSEUDO_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;

function signToken(user) {
  return jwt.sign({ id: user.id, pseudo: user.pseudo }, JWT_SECRET, { expiresIn: TOKEN_LIFETIME });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non connecte.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.pseudo = payload.pseudo;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide, reconnecte-toi.' });
  }
}

// qui est en ligne : userId -> Set(socket.id)  (Set pour gerer plusieurs onglets/appareils)
const onlineUsers = new Map();
function isOnline(userId) {
  return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

// ---------------------------------------------------------------------------
// API - authentification
// ---------------------------------------------------------------------------

app.post('/api/register', (req, res) => {
  const { pseudo, password } = req.body || {};
  if (typeof pseudo !== 'string' || !PSEUDO_REGEX.test(pseudo)) {
    return res.status(400).json({
      error: 'Pseudo invalide (3 a 20 caracteres : lettres, chiffres, - ou _).',
    });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caracteres.' });
  }
  if (db.getUserByPseudo(pseudo)) {
    return res.status(409).json({ error: 'Ce pseudo est deja pris.' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = db.createUser(pseudo, passwordHash);
  const token = signToken(user);
  res.json({ token, id: user.id, pseudo: user.pseudo });
});

app.post('/api/login', (req, res) => {
  const { pseudo, password } = req.body || {};
  if (typeof pseudo !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Pseudo et mot de passe requis.' });
  }
  const user = db.getUserByPseudo(pseudo);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
  }
  const token = signToken(user);
  res.json({ token, id: user.id, pseudo: user.pseudo });
});

app.get('/api/me', authRequired, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
  res.json({ id: user.id, pseudo: user.pseudo });
});

// ---------------------------------------------------------------------------
// API - amis
// ---------------------------------------------------------------------------

app.get('/api/friends', authRequired, (req, res) => {
  const friends = db.getFriends(req.userId).map((f) => ({ ...f, online: isOnline(f.id) }));
  res.json(friends);
});

app.get('/api/friends/requests', authRequired, (req, res) => {
  res.json(db.getIncomingRequests(req.userId));
});

app.get('/api/search', authRequired, (req, res) => {
  const q = String(req.query.q || '');
  if (q.length < 2) return res.json([]);
  const results = db.searchUsers(q, req.userId).map((u) => {
    let status = 'none';
    if (db.areFriends(req.userId, u.id)) status = 'friend';
    else {
      const pending = db.getPendingRequestBetween(req.userId, u.id);
      if (pending) status = pending.from === req.userId ? 'sent' : 'received';
    }
    return { ...u, status };
  });
  res.json(results);
});

app.post('/api/friends/request', authRequired, (req, res) => {
  const targetPseudo = req.body && req.body.pseudo;
  if (typeof targetPseudo !== 'string' || !targetPseudo.trim()) {
    return res.status(400).json({ error: 'Pseudo requis.' });
  }
  const target = db.getUserByPseudo(targetPseudo.trim());
  if (!target) return res.status(404).json({ error: "Ce pseudo n'existe pas." });
  if (target.id === req.userId) return res.status(400).json({ error: "Tu ne peux pas t'ajouter toi-meme." });
  if (db.areFriends(req.userId, target.id)) return res.status(409).json({ error: 'Vous etes deja amis.' });
  const existing = db.getPendingRequestBetween(req.userId, target.id);
  if (existing) return res.status(409).json({ error: 'Une demande est deja en attente.' });

  const request = db.createFriendRequest(req.userId, target.id);
  // notifie le destinataire en temps reel s'il est connecte
  io.to(target.id).emit('friend:request:incoming', {
    requestId: request.id,
    fromId: req.userId,
    fromPseudo: req.pseudo,
    createdAt: request.createdAt,
  });
  res.json({ ok: true });
});

app.post('/api/friends/respond', authRequired, (req, res) => {
  const { requestId, accept } = req.body || {};
  if (typeof requestId !== 'string') return res.status(400).json({ error: 'Requete invalide.' });
  const original = db.getRequestById(requestId);
  const updated = db.respondToRequest(requestId, req.userId, !!accept);
  if (!updated) return res.status(404).json({ error: 'Demande introuvable ou deja traitee.' });

  // previens celui qui avait envoye la demande
  if (original) {
    io.to(original.from).emit('friend:request:responded', {
      requestId,
      accepted: !!accept,
      byPseudo: req.pseudo,
      byId: req.userId,
    });
  }
  res.json({ ok: true, accepted: !!accept });
});

app.get('/api/messages/:friendId', authRequired, (req, res) => {
  const friendId = req.params.friendId;
  if (!db.areFriends(req.userId, friendId)) {
    return res.status(403).json({ error: "Vous n'etes pas amis." });
  }
  res.json(db.getConversation(req.userId, friendId));
});

// ---------------------------------------------------------------------------
// Socket.IO - temps reel (messages + appels video)
// ---------------------------------------------------------------------------

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    socket.pseudo = payload.pseudo;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.userId;
  socket.join(uid); // une "room" par utilisateur : simplifie l'envoi cible, peu importe le nombre d'onglets ouverts

  const wasOffline = !isOnline(uid);
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
  onlineUsers.get(uid).add(socket.id);

  if (wasOffline) {
    db.getFriends(uid).forEach((f) => io.to(f.id).emit('presence:update', { userId: uid, online: true }));
  }

  // --- Messages ---
  socket.on('message:send', (payload, ack) => {
    try {
      const to = payload && payload.to;
      let content = payload && payload.content;
      content = typeof content === 'string' ? content.trim() : '';
      if (!to || !content || content.length > 2000) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Message vide ou invalide.' });
        return;
      }
      if (!db.areFriends(uid, to)) {
        if (typeof ack === 'function') ack({ ok: false, error: "Vous n'etes pas amis." });
        return;
      }
      const msg = db.saveMessage(uid, to, content);
      io.to(to).emit('message:new', msg);
      io.to(uid).emit('message:new', msg); // pour resynchroniser les autres onglets de l'expediteur
      if (typeof ack === 'function') ack({ ok: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Erreur serveur.' });
    }
  });

  // --- Signalisation WebRTC (appel audio/video) ---
  // Le serveur ne fait que relayer les messages entre les deux amis, tout le
  // traitement audio/video se fait directement entre les deux navigateurs.
  socket.on('call:invite', ({ to, video } = {}) => {
    if (!to || !db.areFriends(uid, to)) return;
    io.to(to).emit('call:incoming', { fromId: uid, fromPseudo: socket.pseudo, video: !!video });
  });
  socket.on('call:accept', ({ to } = {}) => {
    if (!to) return;
    io.to(to).emit('call:accepted', { fromId: uid });
  });
  socket.on('call:reject', ({ to } = {}) => {
    if (!to) return;
    io.to(to).emit('call:rejected', { fromId: uid });
  });
  socket.on('call:cancel', ({ to } = {}) => {
    if (!to) return;
    io.to(to).emit('call:cancelled', { fromId: uid });
  });
  socket.on('call:offer', ({ to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit('call:offer', { fromId: uid, sdp });
  });
  socket.on('call:answer', ({ to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit('call:answer', { fromId: uid, sdp });
  });
  socket.on('call:ice-candidate', ({ to, candidate } = {}) => {
    if (!to || !candidate) return;
    io.to(to).emit('call:ice-candidate', { fromId: uid, candidate });
  });
  socket.on('call:end', ({ to } = {}) => {
    if (!to) return;
    io.to(to).emit('call:end', { fromId: uid });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(uid);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      onlineUsers.delete(uid);
      db.getFriends(uid).forEach((f) => io.to(f.id).emit('presence:update', { userId: uid, online: false }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[robotbotchatV2] Serveur demarre sur le port ${PORT}`);
});

// Nettoyage automatique : les messages de plus de 24h sont supprimes.
// On le fait au demarrage (au cas ou le serveur etait eteint depuis un moment)
// puis toutes les 15 minutes.
db.purgeOldMessages();
setInterval(() => db.purgeOldMessages(), 15 * 60 * 1000);

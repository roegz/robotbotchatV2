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
const webpush = require('web-push');

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

// Panel admin : pseudo reserve + mot de passe uniquement dans une variable
// d'environnement Render (jamais en clair dans le code, le repo est public).
// Sans ADMIN_PASSWORD defini sur Render, la connexion admin reste desactivee.
const ADMIN_PSEUDO = 'robotbot';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
if (!ADMIN_PASSWORD) {
  console.warn(
    '[robotbotchatV2] Aucune variable ADMIN_PASSWORD definie : le panel admin restera inaccessible tant que ' +
      "cette variable n'est pas ajoutee sur Render (Environment -> Add Environment Variable)."
  );
}
const ADMIN_TOKEN_LIFETIME = '12h';

// Serveur TURN (optionnel) : sans ca, les appels n'utilisent que des
// serveurs STUN publics et echouent sur les reseaux tres restrictifs
// (voir README). Si TURN_CREDENTIALS_URL est defini sur Render (ex. avec
// un compte gratuit Metered.ca), le serveur va chercher des identifiants
// TURN temporaires a cette URL et les transmet au navigateur.
const TURN_CREDENTIALS_URL = process.env.TURN_CREDENTIALS_URL || null;
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const TURN_CACHE_MS = 60 * 60 * 1000; // les identifiants sont temporaires : on les regenere toutes les heures
let turnCache = { servers: null, fetchedAt: 0 };

async function getIceServers() {
  if (!TURN_CREDENTIALS_URL) return FALLBACK_ICE_SERVERS;
  const now = Date.now();
  if (turnCache.servers && now - turnCache.fetchedAt < TURN_CACHE_MS) return turnCache.servers;
  try {
    const response = await fetch(TURN_CREDENTIALS_URL);
    if (!response.ok) throw new Error('reponse HTTP ' + response.status);
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      turnCache = { servers: data, fetchedAt: now };
      return data;
    }
    throw new Error('reponse inattendue (pas un tableau de serveurs ICE)');
  } catch (e) {
    console.warn(
      '[robotbotchatV2] Impossible de recuperer les identifiants TURN (' +
        e.message +
        '), les appels retombent sur STUN seul.'
    );
    return FALLBACK_ICE_SERVERS;
  }
}

// Notifications push (optionnel) : permettent d'etre prevenu d'un message ou
// d'un appel meme quand le site est ferme. Il faut definir sur Render deux
// variables d'environnement : VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY.
// Sans elles, les notifications "appli fermee" sont desactivees (les
// notifications quand le site est ouvert marchent quand meme).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@robotbotchatv2.onrender.com';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.warn('[robotbotchatV2] Cles VAPID invalides, notifications push desactivees :', e.message);
  }
} else {
  console.warn(
    '[robotbotchatV2] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non definies : pas de notifications quand le site est ferme.'
  );
}

// Envoie une notification push a tous les appareils d'un utilisateur, mais
// SEULEMENT s'il n'est pas deja connecte (sinon le site ouvert s'en charge).
function sendPushToUser(userId, payload) {
  if (!PUSH_ENABLED || isOnline(userId)) return;
  const subs = db.getPushSubscriptionsForUser(userId);
  subs.forEach((sub) => {
    webpush
      .sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 60 * 60 })
      .catch((err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          db.removePushSubscriptionByEndpoint(sub.endpoint); // appareil desinscrit : on nettoie
        }
      });
  });
}

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

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_LIFETIME });
}

function adminRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non connecte.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Acces refuse.' });
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

// participants actuellement dans un appel de groupe : groupId -> Map(userId -> { pseudo, video })
const groupCallParticipants = new Map();

function broadcastGroupCallStatus(groupId) {
  const group = db.getGroupById(groupId);
  if (!group) return;
  const participants = groupCallParticipants.get(groupId);
  const count = participants ? participants.size : 0;
  group.members.forEach((memberId) => io.to(memberId).emit('group:call:status', { groupId, count }));
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
  if (pseudo.toLowerCase() === ADMIN_PSEUDO.toLowerCase()) {
    return res.status(409).json({ error: 'Ce pseudo est reserve.' });
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
// API - groupes
// ---------------------------------------------------------------------------

app.get('/api/groups', authRequired, (req, res) => {
  res.json(db.getGroupsForUser(req.userId).map(db.groupWithPseudos));
});

app.post('/api/groups', authRequired, (req, res) => {
  const { name, memberIds } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) {
    return res.status(400).json({ error: 'Nom de groupe invalide (1 a 30 caracteres).' });
  }
  const ids = Array.isArray(memberIds) ? memberIds.filter((id) => typeof id === 'string') : [];
  const invalid = ids.some((id) => id !== req.userId && !db.areFriends(req.userId, id));
  if (invalid) return res.status(400).json({ error: 'Tu ne peux ajouter que tes amis.' });

  const group = db.createGroup(req.userId, name.trim(), ids);
  const full = db.groupWithPseudos(group);
  full.members.forEach((m) => {
    if (m.id !== req.userId) io.to(m.id).emit('group:updated', full);
  });
  res.json(full);
});

app.post('/api/groups/:id/members', authRequired, (req, res) => {
  const groupId = req.params.id;
  if (!db.isGroupMember(groupId, req.userId)) {
    return res.status(403).json({ error: "Tu n'es pas membre de ce groupe." });
  }
  const memberId = req.body && req.body.memberId;
  if (typeof memberId !== 'string') return res.status(400).json({ error: 'Ami invalide.' });
  if (!db.areFriends(req.userId, memberId)) {
    return res.status(400).json({ error: 'Tu ne peux ajouter que tes amis.' });
  }
  const group = db.addMemberToGroup(groupId, memberId);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });

  const full = db.groupWithPseudos(group);
  full.members.forEach((m) => io.to(m.id).emit('group:updated', full));
  res.json(full);
});

app.get('/api/groups/:id/messages', authRequired, (req, res) => {
  const groupId = req.params.id;
  if (!db.isGroupMember(groupId, req.userId)) {
    return res.status(403).json({ error: "Tu n'es pas membre de ce groupe." });
  }
  res.json(db.getGroupConversation(groupId));
});

// ---------------------------------------------------------------------------
// API - serveurs ICE (STUN + TURN si configure) pour les appels audio/video
// ---------------------------------------------------------------------------

app.get('/api/ice-servers', authRequired, async (req, res) => {
  const iceServers = await getIceServers();
  res.json({ iceServers });
});

// ---------------------------------------------------------------------------
// API - notifications push
// ---------------------------------------------------------------------------

app.get('/api/push/public-key', authRequired, (req, res) => {
  res.json({ publicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', authRequired, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Notifications push non configurees.' });
  const sub = req.body && req.body.subscription;
  const saved = db.addPushSubscription(req.userId, sub);
  if (!saved) return res.status(400).json({ error: 'Abonnement invalide.' });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authRequired, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint === 'string') db.removePushSubscriptionByEndpoint(endpoint);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API - salon "General" (ouvert a tous les comptes, sans besoin d'etre ami)
// ---------------------------------------------------------------------------

app.get('/api/general/messages', authRequired, (req, res) => {
  res.json(db.getGeneralConversation());
});

// ---------------------------------------------------------------------------
// API - panel admin (stats globales uniquement : pas de pseudos, pas d'IP)
// ---------------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const { pseudo, password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Panel admin non configure sur ce serveur (variable ADMIN_PASSWORD manquante sur Render).",
    });
  }
  const pseudoOk = typeof pseudo === 'string' && pseudo.toLowerCase() === ADMIN_PSEUDO.toLowerCase();
  const passwordOk = typeof password === 'string' && password === ADMIN_PASSWORD;
  if (!pseudoOk || !passwordOk) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  res.json({ token: signAdminToken() });
});

app.get('/api/admin/stats', adminRequired, (req, res) => {
  const stats = db.getStats();
  stats.onlineUsers = onlineUsers.size;
  res.json(stats);
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
  socket.join('general'); // tout compte connecte est automatiquement dans le salon General

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
      sendPushToUser(to, {
        title: socket.pseudo,
        body: content.length > 120 ? content.slice(0, 117) + '...' : content,
        tag: 'msg-' + uid,
        data: { type: 'friend', friendId: uid },
      });
      if (typeof ack === 'function') ack({ ok: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Erreur serveur.' });
    }
  });

  // --- Messages de groupe ---
  socket.on('group:message:send', (payload, ack) => {
    try {
      const groupId = payload && payload.groupId;
      let content = payload && payload.content;
      content = typeof content === 'string' ? content.trim() : '';
      if (!groupId || !content || content.length > 2000) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Message vide ou invalide.' });
        return;
      }
      if (!db.isGroupMember(groupId, uid)) {
        if (typeof ack === 'function') ack({ ok: false, error: "Tu n'es pas membre de ce groupe." });
        return;
      }
      const msg = db.saveGroupMessage(groupId, uid, content);
      const group = db.getGroupById(groupId);
      group.members.forEach((memberId) => {
        io.to(memberId).emit('group:message:new', msg);
        if (memberId !== uid) {
          sendPushToUser(memberId, {
            title: group.name,
            body: socket.pseudo + ' : ' + (content.length > 120 ? content.slice(0, 117) + '...' : content),
            tag: 'group-' + groupId,
            data: { type: 'group', groupId },
          });
        }
      });
      if (typeof ack === 'function') ack({ ok: true, message: msg });
    } catch (e) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Erreur serveur.' });
    }
  });

  // --- Salon "General" (ouvert a tous, pas besoin d'etre ami) ---
  socket.on('general:message:send', (payload, ack) => {
    try {
      let content = payload && payload.content;
      content = typeof content === 'string' ? content.trim() : '';
      if (!content || content.length > 2000) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Message vide ou invalide.' });
        return;
      }
      const msg = db.saveGeneralMessage(uid, socket.pseudo, content);
      io.to('general').emit('general:message:new', msg);
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
    sendPushToUser(to, {
      title: 'Appel entrant',
      body: socket.pseudo + (video ? " t'appelle en vidéo" : " t'appelle"),
      tag: 'call-' + uid,
      requireInteraction: true,
      data: { type: 'call', friendId: uid },
    });
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

  // --- Dessin en direct avec un ami (invitation a accepter/refuser, comme un appel) ---
  socket.on('draw:invite', ({ to } = {}) => {
    if (!to || !db.areFriends(uid, to)) return;
    io.to(to).emit('draw:incoming', { fromId: uid, fromPseudo: socket.pseudo });
  });
  socket.on('draw:accept', ({ to } = {}) => {
    if (to) io.to(to).emit('draw:accepted', { fromId: uid });
  });
  socket.on('draw:reject', ({ to } = {}) => {
    if (to) io.to(to).emit('draw:rejected', { fromId: uid });
  });
  socket.on('draw:cancel', ({ to } = {}) => {
    if (to) io.to(to).emit('draw:cancelled', { fromId: uid });
  });
  socket.on('draw:stroke', ({ to, stroke } = {}) => {
    if (!to || !stroke || !db.areFriends(uid, to)) return;
    io.to(to).emit('draw:stroke', { fromId: uid, stroke });
  });
  socket.on('draw:clear', ({ to } = {}) => {
    if (!to || !db.areFriends(uid, to)) return;
    io.to(to).emit('draw:clear', { fromId: uid });
  });
  socket.on('draw:end', ({ to } = {}) => {
    if (to) io.to(to).emit('draw:end', { fromId: uid });
  });

  // --- Dessin en direct dans un groupe (pas d'invitation, deja entre amis) ---
  socket.on('draw:group:stroke', ({ groupId, stroke } = {}) => {
    if (!groupId || !stroke || !db.isGroupMember(groupId, uid)) return;
    const group = db.getGroupById(groupId);
    group.members.forEach((memberId) => {
      if (memberId !== uid) io.to(memberId).emit('draw:group:stroke', { groupId, fromId: uid, stroke });
    });
  });
  socket.on('draw:group:clear', ({ groupId } = {}) => {
    if (!groupId || !db.isGroupMember(groupId, uid)) return;
    const group = db.getGroupById(groupId);
    group.members.forEach((memberId) => {
      if (memberId !== uid) io.to(memberId).emit('draw:group:clear', { groupId, fromId: uid });
    });
  });

  // --- Appel de groupe (maillage : chaque paire de participants a sa propre connexion) ---
  socket.on('group:call:join', ({ groupId, video } = {}) => {
    if (!groupId || !db.isGroupMember(groupId, uid)) return;
    if (!groupCallParticipants.has(groupId)) groupCallParticipants.set(groupId, new Map());
    const participants = groupCallParticipants.get(groupId);
    if (participants.has(uid)) return; // deja dans l'appel (autre onglet), on ignore
    const existing = Array.from(participants.entries()).map(([id, info]) => ({
      id,
      pseudo: info.pseudo,
      video: info.video,
      screen: !!info.screen,
    }));
    participants.set(uid, { pseudo: socket.pseudo, video: !!video, screen: false });
    socket.emit('group:call:joined', { groupId, participants: existing });
    existing.forEach((p) => {
      io.to(p.id).emit('group:call:peer-joined', { groupId, fromId: uid, fromPseudo: socket.pseudo, video: !!video });
    });
    broadcastGroupCallStatus(groupId);
  });

  socket.on('group:call:leave', ({ groupId } = {}) => {
    if (!groupId) return;
    const participants = groupCallParticipants.get(groupId);
    if (!participants || !participants.has(uid)) return;
    participants.delete(uid);
    if (participants.size === 0) groupCallParticipants.delete(groupId);
    participants.forEach((info, memberId) => io.to(memberId).emit('group:call:peer-left', { groupId, fromId: uid }));
    broadcastGroupCallStatus(groupId);
  });

  // --- Partage d'ecran : la video passe par la connexion existante, ces messages
  // servent juste a prevenir les autres pour qu'ils adaptent l'affichage. ---
  socket.on('call:screen', ({ to, on } = {}) => {
    if (typeof to !== 'string') return;
    io.to(to).emit('call:screen', { fromId: uid, on: !!on });
  });
  socket.on('group:call:screen', ({ groupId, on } = {}) => {
    const participants = groupCallParticipants.get(groupId);
    if (!participants || !participants.has(uid)) return;
    participants.get(uid).screen = !!on;
    participants.forEach((info, memberId) => {
      if (memberId !== uid) io.to(memberId).emit('group:call:screen', { groupId, fromId: uid, on: !!on });
    });
  });

  socket.on('group:call:offer', ({ groupId, to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit('group:call:offer', { groupId, fromId: uid, sdp });
  });
  socket.on('group:call:answer', ({ groupId, to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit('group:call:answer', { groupId, fromId: uid, sdp });
  });
  socket.on('group:call:ice-candidate', ({ groupId, to, candidate } = {}) => {
    if (!to || !candidate) return;
    io.to(to).emit('group:call:ice-candidate', { groupId, fromId: uid, candidate });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(uid);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(uid);
        db.getFriends(uid).forEach((f) => io.to(f.id).emit('presence:update', { userId: uid, online: false }));
      }
    }
    // si la personne etait dans un appel de groupe, on previent les autres participants
    groupCallParticipants.forEach((participants, groupId) => {
      if (participants.has(uid)) {
        participants.delete(uid);
        participants.forEach((info, memberId) => io.to(memberId).emit('group:call:peer-left', { groupId, fromId: uid }));
        if (participants.size === 0) groupCallParticipants.delete(groupId);
        broadcastGroupCallStatus(groupId);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`[robotbotchatV2] Serveur demarre sur le port ${PORT}`);
});

// Nettoyage automatique : les messages de plus de 24h sont supprimes.
// On le fait au demarrage (au cas ou le serveur etait eteint depuis un moment)
// puis toutes les 15 minutes.
db.purgeOldMessages();
db.purgeOldGroupMessages();
db.purgeOldGeneralMessages();
setInterval(() => {
  db.purgeOldMessages();
  db.purgeOldGroupMessages();
  db.purgeOldGeneralMessages();
}, 15 * 60 * 1000);

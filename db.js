// db.js
// Stockage simple base sur un fichier JSON local.
// Choix volontaire : pas de base de donnees native (SQLite, etc.) pour eviter
// les soucis de compilation au deploiement. Adapte a un usage personnel /
// petit groupe d'amis. Voir le README pour la note sur la persistance sur Render.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');

function emptyDB() {
  return { users: [], friendRequests: [], friendships: [], messages: [], groups: [], groupMessages: [] };
}

let db = emptyDB();

function load() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      db = raw.trim() ? JSON.parse(raw) : emptyDB();
      // Securite : s'assurer que toutes les cles existent meme sur un vieux fichier
      db.users = db.users || [];
      db.friendRequests = db.friendRequests || [];
      db.friendships = db.friendships || [];
      db.messages = db.messages || [];
      db.groups = db.groups || [];
      db.groupMessages = db.groupMessages || [];
    } else {
      db = emptyDB();
      persist();
    }
  } catch (err) {
    console.error("[db] Impossible de lire data/db.json, on repart d'une base vide :", err.message);
    db = emptyDB();
  }
}

function persist() {
  // Ecriture synchrone volontaire : le volume de donnees vise (chat personnel)
  // reste petit, donc pas besoin d'une file d'ecriture asynchrone complexe.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
  fs.renameSync(tmp, DB_FILE); // ecriture atomique : evite un fichier corrompu si crash pendant l'ecriture
}

load();

// ---------- Utilisateurs ----------

function getUserByPseudo(pseudo) {
  const lower = String(pseudo).toLowerCase();
  return db.users.find((u) => u.pseudo.toLowerCase() === lower) || null;
}

function getUserById(id) {
  return db.users.find((u) => u.id === id) || null;
}

function createUser(pseudo, passwordHash) {
  const user = { id: uuidv4(), pseudo, passwordHash, createdAt: Date.now() };
  db.users.push(user);
  persist();
  return user;
}

function searchUsers(query, excludeId) {
  const q = String(query).toLowerCase().trim();
  if (!q) return [];
  return db.users
    .filter((u) => u.id !== excludeId && u.pseudo.toLowerCase().includes(q))
    .slice(0, 15)
    .map((u) => ({ id: u.id, pseudo: u.pseudo }));
}

// ---------- Amis ----------

function friendshipKey(a, b) {
  return [a, b].sort().join('_');
}

function areFriends(a, b) {
  const key = friendshipKey(a, b);
  return db.friendships.some((f) => f.key === key);
}

function getFriends(userId) {
  return db.friendships
    .filter((f) => f.users.includes(userId))
    .map((f) => {
      const otherId = f.users[0] === userId ? f.users[1] : f.users[0];
      const other = getUserById(otherId);
      return other ? { id: other.id, pseudo: other.pseudo, since: f.createdAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.pseudo.localeCompare(b.pseudo));
}

function getPendingRequestBetween(a, b) {
  return (
    db.friendRequests.find(
      (r) => r.status === 'pending' && ((r.from === a && r.to === b) || (r.from === b && r.to === a))
    ) || null
  );
}

function createFriendRequest(fromId, toId) {
  const reqObj = { id: uuidv4(), from: fromId, to: toId, status: 'pending', createdAt: Date.now() };
  db.friendRequests.push(reqObj);
  persist();
  return reqObj;
}

function getIncomingRequests(userId) {
  return db.friendRequests
    .filter((r) => r.to === userId && r.status === 'pending')
    .map((r) => {
      const sender = getUserById(r.from);
      return sender ? { requestId: r.id, fromId: r.from, fromPseudo: sender.pseudo, createdAt: r.createdAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getRequestById(id) {
  return db.friendRequests.find((r) => r.id === id) || null;
}

function respondToRequest(requestId, userId, accept) {
  const reqObj = getRequestById(requestId);
  if (!reqObj || reqObj.to !== userId || reqObj.status !== 'pending') return null;
  reqObj.status = accept ? 'accepted' : 'declined';
  if (accept) {
    const key = friendshipKey(reqObj.from, reqObj.to);
    if (!db.friendships.some((f) => f.key === key)) {
      db.friendships.push({ id: uuidv4(), users: [reqObj.from, reqObj.to], key, createdAt: Date.now() });
    }
  }
  persist();
  return reqObj;
}

// ---------- Messages ----------

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // les messages disparaissent 24h apres avoir ete envoyes

function purgeOldMessages() {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  const before = db.messages.length;
  db.messages = db.messages.filter((m) => m.createdAt >= cutoff);
  if (db.messages.length !== before) persist();
}

function saveMessage(fromId, toId, content) {
  const msg = { id: uuidv4(), from: fromId, to: toId, content, createdAt: Date.now() };
  db.messages.push(msg);
  persist();
  return msg;
}

function getConversation(userA, userB, limit = 300) {
  purgeOldMessages();
  const msgs = db.messages.filter(
    (m) => (m.from === userA && m.to === userB) || (m.from === userB && m.to === userA)
  );
  msgs.sort((a, b) => a.createdAt - b.createdAt);
  return msgs.slice(-limit);
}

// ---------- Groupes ----------

function createGroup(ownerId, name, memberIds) {
  const uniqueMembers = Array.from(new Set([ownerId, ...memberIds]));
  const group = { id: uuidv4(), name, ownerId, members: uniqueMembers, createdAt: Date.now() };
  db.groups.push(group);
  persist();
  return group;
}

function getGroupsForUser(userId) {
  return db.groups.filter((g) => g.members.includes(userId));
}

function getGroupById(id) {
  return db.groups.find((g) => g.id === id) || null;
}

function isGroupMember(groupId, userId) {
  const g = getGroupById(groupId);
  return !!g && g.members.includes(userId);
}

function addMemberToGroup(groupId, newMemberId) {
  const g = getGroupById(groupId);
  if (!g) return null;
  if (!g.members.includes(newMemberId)) {
    g.members.push(newMemberId);
    persist();
  }
  return g;
}

function groupWithPseudos(g) {
  return {
    id: g.id,
    name: g.name,
    ownerId: g.ownerId,
    createdAt: g.createdAt,
    members: g.members
      .map((id) => {
        const u = getUserById(id);
        return u ? { id: u.id, pseudo: u.pseudo } : null;
      })
      .filter(Boolean),
  };
}

function purgeOldGroupMessages() {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  const before = db.groupMessages.length;
  db.groupMessages = db.groupMessages.filter((m) => m.createdAt >= cutoff);
  if (db.groupMessages.length !== before) persist();
}

function saveGroupMessage(groupId, fromId, content) {
  const msg = { id: uuidv4(), groupId, from: fromId, content, createdAt: Date.now() };
  db.groupMessages.push(msg);
  persist();
  return msg;
}

function getGroupConversation(groupId, limit = 300) {
  purgeOldGroupMessages();
  const msgs = db.groupMessages.filter((m) => m.groupId === groupId);
  msgs.sort((a, b) => a.createdAt - b.createdAt);
  return msgs.slice(-limit);
}

module.exports = {
  getUserByPseudo,
  getUserById,
  createUser,
  searchUsers,
  areFriends,
  getFriends,
  getPendingRequestBetween,
  createFriendRequest,
  getIncomingRequests,
  getRequestById,
  respondToRequest,
  saveMessage,
  getConversation,
  purgeOldMessages,
  createGroup,
  getGroupsForUser,
  getGroupById,
  isGroupMember,
  addMemberToGroup,
  groupWithPseudos,
  saveGroupMessage,
  getGroupConversation,
  purgeOldGroupMessages,
};

// app.js
// Logique principale du site : connexion/inscription, liste d'amis,
// demandes d'amis, messagerie en temps reel. La partie appel video
// est dans call.js (elle reutilise RBC.state et RBC.* definis ici).

window.RBC = {};
const RBC = window.RBC;
RBC.socketReadyHandlers = [];
RBC.onSocketReady = function (fn) {
  RBC.socketReadyHandlers.push(fn);
};

RBC.state = {
  token: null,
  me: null, // { id, pseudo }
  friends: [], // [{ id, pseudo, online }]
  pendingRequests: [], // [{ requestId, fromId, fromPseudo, createdAt }]
  groups: [], // [{ id, name, ownerId, members:[{id,pseudo}] }]
  activeFriendId: null,
  activeGroupId: null,
  socket: null,
};

const AVATAR_PALETTE = ['#3F6652', '#7A5A3A', '#4C6A8A', '#8A4C6A', '#6A7A3A', '#B3462C', '#5A5A9A'];
const GROUP_COLOR = '#C08A2E';

// --------------------------- utilitaires ---------------------------

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (RBC.state.token) headers['Authorization'] = 'Bearer ' + RBC.state.token;
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || 'Erreur serveur.');
  return data;
}
RBC.api = api;

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' is-error' : '');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .25s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
RBC.showToast = showToast;

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function avatarColor(pseudo) {
  let hash = 0;
  for (let i = 0; i < pseudo.length; i++) hash = pseudo.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function makeAvatar(pseudo, online) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = avatarColor(pseudo);
  div.textContent = pseudo.charAt(0).toUpperCase();
  const dot = document.createElement('span');
  dot.className = 'dot' + (online ? ' is-online' : '');
  div.appendChild(dot);
  return div;
}

function makeGroupAvatar(name) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = GROUP_COLOR;
  div.textContent = (name.trim().charAt(0) || '?').toUpperCase();
  return div;
}

function getFriendById(id) {
  return RBC.state.friends.find((f) => f.id === id) || null;
}
RBC.getFriendById = getFriendById;

function getGroupById(id) {
  return RBC.state.groups.find((g) => g.id === id) || null;
}

function upsertGroup(group) {
  const idx = RBC.state.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) RBC.state.groups[idx] = group;
  else RBC.state.groups.push(group);
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}

// --------------------------- ecran connexion ---------------------------

const authScreen = document.getElementById('auth-screen');
const appScreen = document.getElementById('app-screen');
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

function setAuthTab(which) {
  const loginActive = which === 'login';
  tabLogin.classList.toggle('is-active', loginActive);
  tabRegister.classList.toggle('is-active', !loginActive);
  tabLogin.setAttribute('aria-selected', String(loginActive));
  tabRegister.setAttribute('aria-selected', String(!loginActive));
  formLogin.hidden = !loginActive;
  formRegister.hidden = loginActive;
  document.getElementById('login-error').textContent = '';
  document.getElementById('register-error').textContent = '';
}
tabLogin.addEventListener('click', () => setAuthTab('login'));
tabRegister.addEventListener('click', () => setAuthTab('register'));

formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pseudo = document.getElementById('login-pseudo').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    const data = await api('/api/login', { method: 'POST', body: { pseudo, password } });
    onAuthSuccess(data);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

formRegister.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pseudo = document.getElementById('register-pseudo').value.trim();
  const password = document.getElementById('register-password').value;
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';
  try {
    const data = await api('/api/register', { method: 'POST', body: { pseudo, password } });
    onAuthSuccess(data);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function onAuthSuccess(data) {
  RBC.state.token = data.token;
  RBC.state.me = { id: data.id, pseudo: data.pseudo };
  localStorage.setItem('rbc_token', data.token);
  showApp();
}

function showApp() {
  authScreen.hidden = true;
  appScreen.hidden = false;
  document.getElementById('me-pseudo').textContent = RBC.state.me.pseudo;
  connectSocket();
  loadFriends();
  loadRequests();
  loadGroups();
}

function logout() {
  localStorage.removeItem('rbc_token');
  if (RBC.state.socket) RBC.state.socket.disconnect();
  RBC.state = {
    token: null,
    me: null,
    friends: [],
    pendingRequests: [],
    groups: [],
    activeFriendId: null,
    activeGroupId: null,
    socket: null,
  };
  appScreen.hidden = true;
  authScreen.hidden = false;
  formLogin.reset();
  formRegister.reset();
  setAuthTab('login');
}
document.getElementById('btn-logout').addEventListener('click', logout);

// --------------------------- socket.io ---------------------------

function connectSocket() {
  const socket = io({ auth: { token: RBC.state.token } });
  RBC.state.socket = socket;

  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') {
      showToast('Session expiree, reconnecte-toi.', true);
      logout();
    }
  });

  socket.on('message:new', (msg) => {
    const otherId = msg.from === RBC.state.me.id ? msg.to : msg.from;
    if (RBC.state.activeFriendId === otherId) {
      const messagesEl = document.getElementById('messages');
      const wasNearBottom = isNearBottom(messagesEl);
      appendDayDividerIfNeeded(msg.createdAt);
      appendMessageNode(msg);
      if (wasNearBottom || msg.from === RBC.state.me.id) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else if (msg.from !== RBC.state.me.id) {
      const friend = getFriendById(msg.from);
      showToast((friend ? friend.pseudo : 'Quelqu\u2019un') + ' t\u2019a envoye un message.');
    }
  });

  socket.on('presence:update', ({ userId, online }) => {
    const friend = getFriendById(userId);
    if (!friend) return;
    friend.online = online;
    updateFriendPresenceInList(userId, online);
    if (RBC.state.activeFriendId === userId) updateChatHeaderStatus(friend);
    if (!online && typeof RBC.closeGameIfPeer === 'function') RBC.closeGameIfPeer(userId);
  });

  socket.on('friend:request:incoming', (req) => {
    RBC.state.pendingRequests.unshift(req);
    updateRequestsBadge();
    renderRequestsList();
    showToast(req.fromPseudo + ' t\u2019a envoye une demande d\u2019ami.');
  });

  socket.on('friend:request:responded', ({ accepted, byPseudo }) => {
    if (accepted) {
      showToast(byPseudo + ' a accepte ta demande d\u2019ami \u2014 vous etes amis !');
      loadFriends();
    } else {
      showToast(byPseudo + ' a refuse ta demande d\u2019ami.');
    }
  });

  socket.on('group:message:new', (msg) => {
    if (RBC.state.activeGroupId === msg.groupId) {
      const messagesEl = document.getElementById('messages');
      const wasNearBottom = isNearBottom(messagesEl);
      appendDayDividerIfNeeded(msg.createdAt);
      appendGroupMessageNode(msg);
      if (wasNearBottom || msg.from === RBC.state.me.id) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    } else if (msg.from !== RBC.state.me.id) {
      const group = getGroupById(msg.groupId);
      const sender = group ? group.members.find((m) => m.id === msg.from) : null;
      showToast(
        (sender ? sender.pseudo : 'Quelqu\u2019un') + ' a ecrit dans ' + (group ? group.name : 'un groupe') + '.'
      );
    }
  });

  socket.on('group:updated', (group) => {
    upsertGroup(group);
    renderGroupsList();
    if (RBC.state.activeGroupId === group.id) updateGroupChatHeader(group);
  });

  // permet a call.js / game.js de brancher leurs propres ecouteurs
  // une fois que la connexion socket existe.
  RBC.socketReadyHandlers.forEach((fn) => fn(socket));
}

// --------------------------- liste d'amis ---------------------------

const friendsListEl = document.getElementById('friends-list');
const friendsEmptyEl = document.getElementById('friends-empty');

async function loadFriends() {
  try {
    const friends = await api('/api/friends');
    RBC.state.friends = friends;
    renderFriendsList();
    if (RBC.state.activeFriendId) {
      const active = getFriendById(RBC.state.activeFriendId);
      if (active) updateChatHeaderStatus(active);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderFriendsList() {
  friendsListEl.querySelectorAll('.friend-item').forEach((el) => el.parentElement.remove());
  friendsEmptyEl.hidden = RBC.state.friends.length > 0;
  RBC.state.friends.forEach((friend) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'friend-item';
    btn.dataset.id = friend.id;
    if (friend.id === RBC.state.activeFriendId) btn.classList.add('is-active');
    btn.appendChild(makeAvatar(friend.pseudo, friend.online));
    const textWrap = document.createElement('div');
    textWrap.className = 'friend-text';
    const nameEl = document.createElement('div');
    nameEl.className = 'friend-name';
    nameEl.textContent = friend.pseudo;
    const statusEl = document.createElement('div');
    statusEl.className = 'friend-status';
    statusEl.textContent = friend.online ? 'en ligne' : 'hors ligne';
    textWrap.appendChild(nameEl);
    textWrap.appendChild(statusEl);
    btn.appendChild(textWrap);
    btn.addEventListener('click', () => openChat(friend.id));
    li.appendChild(btn);
    friendsListEl.appendChild(li);
  });
}

function updateFriendPresenceInList(userId, online) {
  const btn = friendsListEl.querySelector('.friend-item[data-id="' + cssEscape(userId) + '"]');
  if (!btn) return;
  const dot = btn.querySelector('.dot');
  if (dot) dot.classList.toggle('is-online', online);
  const statusEl = btn.querySelector('.friend-status');
  if (statusEl) statusEl.textContent = online ? 'en ligne' : 'hors ligne';
}

function cssEscape(str) {
  return window.CSS && CSS.escape ? CSS.escape(str) : str.replace(/["\\]/g, '\\$&');
}

// --------------------------- conversation active ---------------------------

const chatEmptyEl = document.getElementById('chat-empty');
const chatActiveEl = document.getElementById('chat-active');
const messagesEl = document.getElementById('messages');
let lastMsgDayKey = null;

function updateChatHeaderStatus(friend) {
  document.getElementById('chat-header-status').textContent = friend.online ? 'en ligne' : 'hors ligne';
  const avatarSlot = document.getElementById('chat-header-avatar');
  avatarSlot.innerHTML = '';
  avatarSlot.appendChild(makeAvatar(friend.pseudo, friend.online));
}

function setChatHeaderMode(mode) {
  const isGroup = mode === 'group';
  document.getElementById('btn-call-audio').hidden = isGroup;
  document.getElementById('btn-call-video').hidden = isGroup;
  document.getElementById('btn-group-add-member').hidden = !isGroup;
  document.getElementById('btn-group-call-audio').hidden = !isGroup;
  document.getElementById('btn-group-call-video').hidden = !isGroup;
}

async function openChat(friendId) {
  const friend = getFriendById(friendId);
  if (!friend) return;
  RBC.state.activeFriendId = friendId;
  RBC.state.activeGroupId = null;
  lastMsgDayKey = null;

  chatEmptyEl.hidden = true;
  chatActiveEl.hidden = false;
  setChatHeaderMode('friend');
  document.getElementById('chat-header-name').textContent = friend.pseudo;
  updateChatHeaderStatus(friend);

  friendsListEl.querySelectorAll('.friend-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.id === friendId);
  });
  groupsListEl.querySelectorAll('.group-item').forEach((el) => el.classList.remove('is-active'));

  appScreen.classList.remove('view-list');
  appScreen.classList.add('view-chat');

  messagesEl.innerHTML = '';
  try {
    const history = await api('/api/messages/' + friendId);
    history.forEach((msg) => {
      appendDayDividerIfNeeded(msg.createdAt);
      appendMessageNode(msg);
    });
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  } catch (err) {
    showToast(err.message, true);
  }
  document.getElementById('message-input').focus();
}

document.getElementById('btn-back').addEventListener('click', () => {
  appScreen.classList.remove('view-chat');
  appScreen.classList.add('view-list');
});

function dayKey(ts) {
  return new Date(ts).toDateString();
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yesterday.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

function appendDayDividerIfNeeded(ts) {
  const key = dayKey(ts);
  if (key === lastMsgDayKey) return;
  lastMsgDayKey = key;
  const div = document.createElement('div');
  div.className = 'msg-day-divider';
  div.textContent = formatDayLabel(ts);
  messagesEl.appendChild(div);
}

function appendMessageNode(msg) {
  const isMine = msg.from === RBC.state.me.id;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMine ? 'is-mine' : 'is-theirs');
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.content;
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(msg.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
}

function appendGroupMessageNode(msg) {
  const isMine = msg.from === RBC.state.me.id;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (isMine ? 'is-mine' : 'is-theirs');
  let container = row;
  if (!isMine) {
    const col = document.createElement('div');
    col.className = 'msg-col';
    const group = getGroupById(RBC.state.activeGroupId);
    const sender = group ? group.members.find((m) => m.id === msg.from) : null;
    const label = document.createElement('div');
    label.className = 'msg-sender';
    label.textContent = sender ? sender.pseudo : 'Inconnu';
    col.appendChild(label);
    row.appendChild(col);
    container = col;
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.content;
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(msg.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  bubble.appendChild(time);
  container.appendChild(bubble);
  messagesEl.appendChild(row);
}

document.getElementById('form-message').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !RBC.state.socket) return;
  if (RBC.state.activeGroupId) {
    input.value = '';
    RBC.state.socket.emit('group:message:send', { groupId: RBC.state.activeGroupId, content }, (ack) => {
      if (!ack || !ack.ok) showToast((ack && ack.error) || "Impossible d'envoyer le message.", true);
    });
  } else if (RBC.state.activeFriendId) {
    input.value = '';
    RBC.state.socket.emit('message:send', { to: RBC.state.activeFriendId, content }, (ack) => {
      if (!ack || !ack.ok) showToast((ack && ack.error) || "Impossible d'envoyer le message.", true);
    });
  }
});

// --------------------------- modales ---------------------------

const modalBackdrop = document.getElementById('modal-backdrop');

function openModal(id) {
  closeModals();
  modalBackdrop.hidden = false;
  document.getElementById(id).hidden = false;
}
function closeModals() {
  modalBackdrop.hidden = true;
  document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
}
modalBackdrop.addEventListener('click', closeModals);
document.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModals));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModals();
});

// --------------------------- ajout d'ami ---------------------------

const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');

document.getElementById('btn-add-friend').addEventListener('click', () => {
  searchInput.value = '';
  searchResultsEl.innerHTML = '';
  openModal('modal-add-friend');
  searchInput.focus();
});

const runSearch = debounce(async (q) => {
  if (q.length < 2) {
    searchResultsEl.innerHTML = '';
    return;
  }
  try {
    const results = await api('/api/search?q=' + encodeURIComponent(q));
    renderSearchResults(results);
  } catch (err) {
    showToast(err.message, true);
  }
}, 300);

searchInput.addEventListener('input', () => runSearch(searchInput.value.trim()));

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (results.length === 0) {
    const li = document.createElement('li');
    li.className = 'result-tag';
    li.style.padding = '8px';
    li.textContent = 'Aucun resultat.';
    searchResultsEl.appendChild(li);
    return;
  }
  results.forEach((user) => {
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.appendChild(makeAvatar(user.pseudo, false));
    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = user.pseudo;
    li.appendChild(name);

    if (user.status === 'friend') {
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = 'Deja ami';
      li.appendChild(tag);
    } else if (user.status === 'sent') {
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = 'Demande envoyee';
      li.appendChild(tag);
    } else if (user.status === 'received') {
      const tag = document.createElement('span');
      tag.className = 'result-tag';
      tag.textContent = "T'a envoye une demande";
      li.appendChild(tag);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.padding = '7px 12px';
      btn.style.fontSize = '13px';
      btn.textContent = 'Ajouter';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/friends/request', { method: 'POST', body: { pseudo: user.pseudo } });
          const tag = document.createElement('span');
          tag.className = 'result-tag';
          tag.textContent = 'Demande envoyee';
          btn.replaceWith(tag);
          showToast('Demande envoyee a ' + user.pseudo + '.');
        } catch (err) {
          btn.disabled = false;
          showToast(err.message, true);
        }
      });
      li.appendChild(btn);
    }
    searchResultsEl.appendChild(li);
  });
}

// --------------------------- demandes recues ---------------------------

const requestsListEl = document.getElementById('requests-list');
const requestsEmptyEl = document.getElementById('requests-empty');
const requestsBadge = document.getElementById('requests-badge');

async function loadRequests() {
  try {
    RBC.state.pendingRequests = await api('/api/friends/requests');
    updateRequestsBadge();
    renderRequestsList();
  } catch (err) {
    showToast(err.message, true);
  }
}

function updateRequestsBadge() {
  const n = RBC.state.pendingRequests.length;
  requestsBadge.hidden = n === 0;
  requestsBadge.textContent = String(n);
}

function renderRequestsList() {
  requestsListEl.querySelectorAll('.request-item').forEach((el) => el.remove());
  requestsEmptyEl.hidden = RBC.state.pendingRequests.length > 0;
  RBC.state.pendingRequests.forEach((reqItem) => {
    const li = document.createElement('li');
    li.className = 'request-item';
    li.appendChild(makeAvatar(reqItem.fromPseudo, false));
    const name = document.createElement('div');
    name.className = 'request-name';
    name.textContent = reqItem.fromPseudo;
    li.appendChild(name);
    const actions = document.createElement('div');
    actions.className = 'request-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'btn btn-primary';
    acceptBtn.textContent = 'Accepter';
    acceptBtn.addEventListener('click', () => respondToRequest(reqItem, true, li));
    const declineBtn = document.createElement('button');
    declineBtn.className = 'btn btn-danger';
    declineBtn.textContent = 'Refuser';
    declineBtn.addEventListener('click', () => respondToRequest(reqItem, false, li));
    actions.appendChild(declineBtn);
    actions.appendChild(acceptBtn);
    li.appendChild(actions);
    requestsListEl.appendChild(li);
  });
}

async function respondToRequest(reqItem, accept, li) {
  try {
    await api('/api/friends/respond', { method: 'POST', body: { requestId: reqItem.requestId, accept } });
    RBC.state.pendingRequests = RBC.state.pendingRequests.filter((r) => r.requestId !== reqItem.requestId);
    li.remove();
    updateRequestsBadge();
    requestsEmptyEl.hidden = RBC.state.pendingRequests.length > 0;
    if (accept) {
      showToast('Vous etes maintenant amis avec ' + reqItem.fromPseudo + '.');
      loadFriends();
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

document.getElementById('btn-requests').addEventListener('click', () => {
  openModal('modal-requests');
});

// --------------------------- groupes ---------------------------

const groupsListEl = document.getElementById('groups-list');
const groupsEmptyEl = document.getElementById('groups-empty');

async function loadGroups() {
  try {
    RBC.state.groups = await api('/api/groups');
    renderGroupsList();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderGroupsList() {
  groupsListEl.querySelectorAll('.group-item').forEach((el) => el.parentElement.remove());
  groupsEmptyEl.hidden = RBC.state.groups.length > 0;
  RBC.state.groups.forEach((group) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'friend-item group-item';
    btn.dataset.id = group.id;
    if (group.id === RBC.state.activeGroupId) btn.classList.add('is-active');
    btn.appendChild(makeGroupAvatar(group.name));
    const textWrap = document.createElement('div');
    textWrap.className = 'friend-text';
    const nameEl = document.createElement('div');
    nameEl.className = 'friend-name';
    nameEl.textContent = group.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'friend-status';
    statusEl.textContent = group.members.length + ' membres';
    textWrap.appendChild(nameEl);
    textWrap.appendChild(statusEl);
    btn.appendChild(textWrap);
    btn.addEventListener('click', () => openGroupChat(group.id));
    li.appendChild(btn);
    groupsListEl.appendChild(li);
  });
}

function updateGroupChatHeader(group) {
  document.getElementById('chat-header-name').textContent = group.name;
  document.getElementById('chat-header-status').textContent = group.members.length + ' membres';
  const avatarSlot = document.getElementById('chat-header-avatar');
  avatarSlot.innerHTML = '';
  avatarSlot.appendChild(makeGroupAvatar(group.name));
}

async function openGroupChat(groupId) {
  const group = getGroupById(groupId);
  if (!group) return;
  RBC.state.activeFriendId = null;
  RBC.state.activeGroupId = groupId;
  lastMsgDayKey = null;

  chatEmptyEl.hidden = true;
  chatActiveEl.hidden = false;
  setChatHeaderMode('group');
  updateGroupChatHeader(group);

  friendsListEl.querySelectorAll('.friend-item').forEach((el) => el.classList.remove('is-active'));
  groupsListEl.querySelectorAll('.group-item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.id === groupId);
  });

  appScreen.classList.remove('view-list');
  appScreen.classList.add('view-chat');

  messagesEl.innerHTML = '';
  try {
    const history = await api('/api/groups/' + groupId + '/messages');
    history.forEach((msg) => {
      appendDayDividerIfNeeded(msg.createdAt);
      appendGroupMessageNode(msg);
    });
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  } catch (err) {
    showToast(err.message, true);
  }
  document.getElementById('message-input').focus();
}

document.getElementById('btn-create-group').addEventListener('click', () => {
  document.getElementById('group-name-input').value = '';
  renderGroupMembersPicker();
  openModal('modal-create-group');
});

function renderGroupMembersPicker() {
  const list = document.getElementById('group-members-picker');
  list.innerHTML = '';
  if (RBC.state.friends.length === 0) {
    const li = document.createElement('li');
    li.className = 'result-tag';
    li.style.padding = '8px';
    li.textContent = "Tu n'as pas encore d'amis a ajouter.";
    list.appendChild(li);
    return;
  }
  RBC.state.friends.forEach((friend) => {
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.appendChild(makeAvatar(friend.pseudo, friend.online));
    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = friend.pseudo;
    li.appendChild(name);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.id;
    checkbox.className = 'group-member-checkbox';
    li.appendChild(checkbox);
    list.appendChild(li);
  });
}

document.getElementById('btn-confirm-create-group').addEventListener('click', async () => {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) {
    showToast('Donne un nom au groupe.', true);
    return;
  }
  const memberIds = Array.from(document.querySelectorAll('.group-member-checkbox:checked')).map((cb) => cb.value);
  try {
    const group = await api('/api/groups', { method: 'POST', body: { name, memberIds } });
    upsertGroup(group);
    renderGroupsList();
    closeModals();
    showToast('Groupe cree : ' + group.name + '.');
    openGroupChat(group.id);
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btn-group-add-member').addEventListener('click', () => {
  if (!RBC.state.activeGroupId) return;
  renderGroupAddList();
  openModal('modal-group-members');
});

function renderGroupAddList() {
  const list = document.getElementById('group-add-list');
  list.innerHTML = '';
  const group = getGroupById(RBC.state.activeGroupId);
  if (!group) return;
  const memberIds = new Set(group.members.map((m) => m.id));
  const candidates = RBC.state.friends.filter((f) => !memberIds.has(f.id));
  if (candidates.length === 0) {
    const li = document.createElement('li');
    li.className = 'result-tag';
    li.style.padding = '8px';
    li.textContent = 'Tous tes amis sont deja dans ce groupe.';
    list.appendChild(li);
    return;
  }
  candidates.forEach((friend) => {
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.appendChild(makeAvatar(friend.pseudo, friend.online));
    const name = document.createElement('div');
    name.className = 'result-name';
    name.textContent = friend.pseudo;
    li.appendChild(name);
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.style.padding = '7px 12px';
    btn.style.fontSize = '13px';
    btn.textContent = 'Ajouter';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const updated = await api('/api/groups/' + group.id + '/members', {
          method: 'POST',
          body: { memberId: friend.id },
        });
        upsertGroup(updated);
        renderGroupsList();
        if (RBC.state.activeGroupId === updated.id) updateGroupChatHeader(updated);
        li.remove();
        showToast(friend.pseudo + ' a ete ajoute au groupe.');
      } catch (err) {
        btn.disabled = false;
        showToast(err.message, true);
      }
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

// --------------------------- demarrage ---------------------------

(function boot() {
  setAuthTab('login');
  const saved = localStorage.getItem('rbc_token');
  if (!saved) return;
  RBC.state.token = saved;
  api('/api/me')
    .then((data) => {
      RBC.state.me = { id: data.id, pseudo: data.pseudo };
      showApp();
    })
    .catch(() => {
      localStorage.removeItem('rbc_token');
      RBC.state.token = null;
    });
})();

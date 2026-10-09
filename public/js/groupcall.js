// groupcall.js
// Appel de groupe (audio ou video), avec ou sans camera. Contrairement a
// l'appel 1-a-1, il n'y a pas d'invitation a accepter : on est deja entre
// amis dans le groupe, donc cliquer sur "appeler" rejoint directement
// l'appel en cours (ou en demarre un). Techniquement c'est un "maillage" :
// chaque participant a sa propre connexion WebRTC avec chacun des autres.
// Adapte a de petits groupes (jusqu'a 5-6 personnes) ; au-dela, chaque
// navigateur devrait gerer trop de connexions en parallele.
//
// Convention pour eviter que deux personnes s'envoient une offre en meme
// temps : c'est toujours celui qui REJOINT l'appel en dernier qui envoie
// l'offre vers chacune des personnes deja presentes.

const gcOverlayEl = document.getElementById('group-call-active');
const gcTitleEl = document.getElementById('group-call-title');
const gcStatusEl = document.getElementById('group-call-status');
const gcGridEl = document.getElementById('group-call-grid');
const btnGroupCallAudio = document.getElementById('btn-group-call-audio');
const btnGroupCallVideo = document.getElementById('btn-group-call-video');
const btnGcToggleMic = document.getElementById('btn-gc-toggle-mic');
const btnGcToggleCam = document.getElementById('btn-gc-toggle-cam');
const btnGcHangup = document.getElementById('btn-gc-hangup');
const btnGcDevices = document.getElementById('btn-gc-devices');
const gcDevicePanel = document.getElementById('gc-device-panel');
const gcMicSelect = document.getElementById('gc-mic-select');
const gcCamSelect = document.getElementById('gc-cam-select');
const gcCamSelectWrap = document.getElementById('gc-cam-select-wrap');
const btnGcToggleScreen = document.getElementById('btn-gc-toggle-screen');
let gcScreenTrack = null; // piste du partage d'ecran en cours (null si pas de partage)

let gcGroupId = null;
let gcWithVideo = true;
let gcLocalStream = null;
let gcMicEnabled = true;
let gcCamEnabled = true;
let gcLocalTile = null;
const gcPeers = new Map(); // userId -> { pc, pseudo, tile, videoEl, avatarEl, pendingCandidates }
const gcKnownCounts = {}; // pour ne notifier qu'au demarrage d'un appel, pas a chaque personne qui rejoint

function socket() {
  return RBC.state.socket;
}

function gcCreateTile(peerId, pseudo) {
  const tile = document.createElement('div');
  tile.className = 'gc-tile';
  tile.dataset.id = peerId;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Jamais de `hidden` sur cette video : elle porte le son distant, et la
  // mettre en display:none peut couper ce son sur certains mobiles. Sans
  // camera, c'est l'avatar (ajoute juste apres, par-dessus) qui la recouvre
  // visuellement — voir la regle CSS .gc-tile-avatar.

  const avatar = document.createElement('div');
  avatar.className = 'avatar gc-tile-avatar';
  avatar.style.background = avatarColor(pseudo);
  avatar.textContent = pseudo.charAt(0).toUpperCase();

  const label = document.createElement('div');
  label.className = 'gc-tile-label';
  label.textContent = pseudo;

  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(label);
  gcGridEl.appendChild(tile);
  return { tile, videoEl: video, avatarEl: avatar };
}

function gcCreatePeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: currentIceServers() }); // defini dans call.js (meme liste STUN/TURN que l'appel 1-a-1)
  gcLocalStream.getTracks().forEach((track) => pc.addTrack(track, gcLocalStream));
  // Sans camera, on reserve quand meme un emplacement video (vide) pour que le
  // partage d'ecran puisse s'y brancher plus tard sans renegociation.
  if (gcLocalStream.getVideoTracks().length === 0) {
    pc.addTransceiver('video', { direction: 'sendrecv', streams: [gcLocalStream] });
  }
  // Quelqu'un rejoint pendant qu'on partage notre ecran : il doit le voir tout de suite.
  if (gcScreenTrack) {
    const sender = findVideoSender(pc); // defini dans call.js
    if (sender) sender.replaceTrack(gcScreenTrack).catch(() => {});
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket().emit('group:call:ice-candidate', { groupId: gcGroupId, to: peerId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const entry = gcPeers.get(peerId);
    if (!entry || !e.streams[0]) return;
    entry.videoEl.srcObject = e.streams[0];
    attemptAutoplay(entry.videoEl, gcOverlayEl); // defini dans call.js
    gcRefreshTile(entry);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) gcRemovePeer(peerId);
  };
  return pc;
}

// Montre la video (camera ou ecran partage) ou l'avatar. On ne met JAMAIS la
// video en `hidden` : ca couperait son son sur pas mal de mobiles. Sans image,
// l'avatar la recouvre juste visuellement (voir la regle CSS .gc-tile-avatar).
function gcRefreshTile(entry) {
  entry.avatarEl.hidden = !!(entry.cameraOn || entry.screenOn);
  entry.tile.classList.toggle('is-screen', !!entry.screenOn);
}

function gcFlushCandidates(entry) {
  entry.pendingCandidates.forEach((c) => entry.pc.addIceCandidate(c).catch(() => {}));
  entry.pendingCandidates = [];
}

function gcRemovePeer(peerId) {
  const entry = gcPeers.get(peerId);
  if (!entry) return;
  entry.pc.close();
  entry.tile.remove();
  gcPeers.delete(peerId);
  gcStatusEl.textContent = gcPeers.size + 1 + ' participant' + (gcPeers.size > 0 ? 's' : '');
}

// --------------------------- rejoindre / quitter ---------------------------

async function joinGroupCall(groupId, withVideo) {
  if (gcGroupId) {
    RBC.showToast('Tu es deja en appel de groupe.', true);
    return;
  }
  // getPreferredDeviceId / PREFERRED_MIC_KEY / PREFERRED_CAM_KEY sont definis
  // dans call.js (meme choix de peripherique que l'appel 1-a-1).
  const micId = getPreferredDeviceId(PREFERRED_MIC_KEY);
  const camId = withVideo ? getPreferredDeviceId(PREFERRED_CAM_KEY) : null;
  try {
    gcLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: micId ? { deviceId: { exact: micId } } : true,
      video: withVideo ? (camId ? { deviceId: { exact: camId } } : true) : false,
    });
  } catch (e) {
    try {
      gcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    } catch (e2) {
      RBC.showToast("Impossible d'acceder au micro" + (withVideo ? '/a la camera' : '') + '.', true);
      return;
    }
  }
  gcGroupId = groupId;
  gcWithVideo = withVideo;
  gcMicEnabled = true;
  gcCamEnabled = withVideo;
  btnGcToggleCam.hidden = !withVideo;
  btnGcToggleMic.classList.remove('is-off');
  btnGcToggleCam.classList.remove('is-off');

  const group = getGroupById(groupId);
  gcTitleEl.textContent = group ? group.name : 'Appel de groupe';
  gcStatusEl.textContent = '1 participant';
  gcGridEl.innerHTML = '';
  gcOverlayEl.hidden = false;

  const { tile, videoEl, avatarEl } = gcCreateTile('me', (RBC.state.me.pseudo || '') + ' (toi)');
  videoEl.muted = true;
  videoEl.srcObject = gcLocalStream;
  videoEl.hidden = !withVideo;
  avatarEl.hidden = withVideo;
  gcLocalTile = { tile, videoEl, avatarEl };

  gcCamSelectWrap.hidden = !withVideo;
  populateDeviceSelects(gcMicSelect, withVideo ? gcCamSelect : null, gcLocalStream); // defini dans call.js

  socket().emit('group:call:join', { groupId, video: withVideo });
}

function leaveGroupCall() {
  if (!gcGroupId) return;
  if (gcScreenTrack) {
    gcScreenTrack.onended = null;
    gcScreenTrack.stop();
    gcScreenTrack = null;
  }
  btnGcToggleScreen.classList.remove('is-sharing');
  socket().emit('group:call:leave', { groupId: gcGroupId });
  gcPeers.forEach((entry) => {
    entry.pc.close();
    entry.tile.remove();
  });
  gcPeers.clear();
  if (gcLocalTile) {
    gcLocalTile.tile.remove();
    gcLocalTile = null;
  }
  if (gcLocalStream) {
    gcLocalStream.getTracks().forEach((t) => t.stop());
    gcLocalStream = null;
  }
  gcGroupId = null;
  gcOverlayEl.hidden = true;
  gcDevicePanel.hidden = true;
}

btnGroupCallAudio.addEventListener('click', () => {
  if (RBC.state.activeGroupId) joinGroupCall(RBC.state.activeGroupId, false);
});
btnGroupCallVideo.addEventListener('click', () => {
  if (RBC.state.activeGroupId) joinGroupCall(RBC.state.activeGroupId, true);
});
btnGcHangup.addEventListener('click', leaveGroupCall);

btnGcToggleMic.addEventListener('click', () => {
  if (!gcLocalStream) return;
  gcMicEnabled = !gcMicEnabled;
  gcLocalStream.getAudioTracks().forEach((t) => (t.enabled = gcMicEnabled));
  btnGcToggleMic.classList.toggle('is-off', !gcMicEnabled);
});
btnGcToggleCam.addEventListener('click', () => {
  if (!gcLocalStream) return;
  gcCamEnabled = !gcCamEnabled;
  gcLocalStream.getVideoTracks().forEach((t) => (t.enabled = gcCamEnabled));
  btnGcToggleCam.classList.toggle('is-off', !gcCamEnabled);
  if (gcLocalTile && !gcScreenTrack) {
    gcLocalTile.videoEl.hidden = !gcCamEnabled;
    gcLocalTile.avatarEl.hidden = gcCamEnabled;
  }
});

// --------------------------- panneau de choix micro / camera ---------------------------

btnGcDevices.addEventListener('click', () => {
  gcDevicePanel.hidden = !gcDevicePanel.hidden;
});

// En appel de groupe, changer de peripherique doit remplacer la piste sur
// CHAQUE connexion ouverte avec les autres participants (maillage) : un seul
// getUserMedia, puis la meme nouvelle piste est donnee a tout le monde
// (switchMediaDevice gere un tableau de connexions, voir call.js).
gcMicSelect.addEventListener('change', () => {
  if (!gcLocalStream || !gcMicSelect.value) return;
  const peerConnections = Array.from(gcPeers.values()).map((entry) => entry.pc);
  switchMediaDevice('audio', gcMicSelect.value, gcLocalStream, peerConnections, PREFERRED_MIC_KEY, gcMicEnabled);
});

gcCamSelect.addEventListener('change', () => {
  if (!gcLocalStream || !gcCamSelect.value) return;
  const peerConnections = gcScreenTrack ? [] : Array.from(gcPeers.values()).map((entry) => entry.pc);
  switchMediaDevice('video', gcCamSelect.value, gcLocalStream, peerConnections, PREFERRED_CAM_KEY, gcCamEnabled).then(() => {
    if (gcLocalTile) gcLocalTile.videoEl.srcObject = gcLocalStream; // force le rafraichissement de l'aperçu local
  });
});

// --------------------------- signalisation ---------------------------

async function gcConnectToExisting(peerId, pseudo, cameraOn, screenOn) {
  const { tile, videoEl, avatarEl } = gcCreateTile(peerId, pseudo);
  const pc = gcCreatePeerConnection(peerId);
  const newEntry = { pc, pseudo, tile, videoEl, avatarEl, pendingCandidates: [], cameraOn: !!cameraOn, screenOn: !!screenOn };
  gcPeers.set(peerId, newEntry);
  gcRefreshTile(newEntry);
  gcStatusEl.textContent = gcPeers.size + 1 + ' participants';
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket().emit('group:call:offer', { groupId: gcGroupId, to: peerId, sdp: offer });
  } catch (e) {
    RBC.showToast('Erreur de connexion avec ' + pseudo + '.', true);
  }
}

RBC.onSocketReady(function (socketInstance) {
  socketInstance.on('group:call:joined', ({ groupId, participants }) => {
    if (groupId !== gcGroupId) return;
    participants.forEach((p) => gcConnectToExisting(p.id, p.pseudo, p.video, p.screen));
  });

  socketInstance.on('group:call:peer-joined', ({ groupId, fromId, fromPseudo, video }) => {
    if (groupId !== gcGroupId || gcPeers.has(fromId)) return;
    // quelqu'un rejoint : on prepare une connexion et on attend son offre
    const { tile, videoEl, avatarEl } = gcCreateTile(fromId, fromPseudo);
    const pc = gcCreatePeerConnection(fromId);
    const newEntry = { pc, pseudo: fromPseudo, tile, videoEl, avatarEl, pendingCandidates: [], cameraOn: !!video, screenOn: false };
    gcPeers.set(fromId, newEntry);
    gcRefreshTile(newEntry);
    gcStatusEl.textContent = gcPeers.size + 1 + ' participants';
  });

  socketInstance.on('group:call:screen', ({ groupId, fromId, on }) => {
    if (groupId !== gcGroupId) return;
    const entry = gcPeers.get(fromId);
    if (!entry) return;
    entry.screenOn = !!on;
    gcRefreshTile(entry);
    if (on) attemptAutoplay(entry.videoEl, gcOverlayEl);
  });

  socketInstance.on('group:call:peer-left', ({ groupId, fromId }) => {
    if (groupId !== gcGroupId) return;
    gcRemovePeer(fromId);
  });

  socketInstance.on('group:call:offer', async ({ groupId, fromId, sdp }) => {
    if (groupId !== gcGroupId) return;
    const entry = gcPeers.get(fromId);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      gcFlushCandidates(entry);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      socket().emit('group:call:answer', { groupId: gcGroupId, to: fromId, sdp: answer });
    } catch (e) {
      RBC.showToast('Erreur de connexion avec ' + entry.pseudo + '.', true);
    }
  });

  socketInstance.on('group:call:answer', async ({ groupId, fromId, sdp }) => {
    if (groupId !== gcGroupId) return;
    const entry = gcPeers.get(fromId);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      gcFlushCandidates(entry);
    } catch (e) {
      RBC.showToast('Erreur de connexion avec ' + entry.pseudo + '.', true);
    }
  });

  socketInstance.on('group:call:ice-candidate', ({ groupId, fromId, candidate }) => {
    if (groupId !== gcGroupId) return;
    const entry = gcPeers.get(fromId);
    if (!entry) return;
    if (entry.pc.remoteDescription) entry.pc.addIceCandidate(candidate).catch(() => {});
    else entry.pendingCandidates.push(candidate);
  });

  socketInstance.on('group:call:status', ({ groupId, count }) => {
    const prev = gcKnownCounts[groupId] || 0;
    gcKnownCounts[groupId] = count;
    if (gcGroupId === groupId) return; // deja dans cet appel, pas besoin de notifier
    if (prev === 0 && count > 0) {
      const group = getGroupById(groupId);
      RBC.showToast(
        (group ? group.name : 'Un groupe') + ' : un appel de groupe vient de commencer, tu peux le rejoindre.'
      );
    }
  });

  socketInstance.on('disconnect', () => {
    if (gcGroupId) leaveGroupCall();
  });
});

// --------------------------- partage d'ecran (appel de groupe) ---------------------------
// Meme principe que l'appel 1-a-1 (voir call.js) : la piste "ecran" est donnee
// a CHAQUE connexion ouverte (maillage), puis la camera revient a l'arret.

async function gcStartScreenShare() {
  if (!gcGroupId || !gcLocalStream || gcScreenTrack) return;
  const track = await captureScreenTrack(); // defini dans call.js
  if (!track) return;
  if (!gcGroupId) {
    track.stop(); // on a quitte l'appel pendant le choix de l'ecran
    return;
  }
  for (const entry of gcPeers.values()) {
    const sender = findVideoSender(entry.pc);
    if (sender) await sender.replaceTrack(track).catch(() => {});
  }
  gcScreenTrack = track;
  track.onended = () => gcStopScreenShare(); // bouton "Arreter le partage" du navigateur
  if (gcLocalTile) {
    gcLocalTile.videoEl.srcObject = new MediaStream([track]);
    gcLocalTile.videoEl.hidden = false;
    gcLocalTile.avatarEl.hidden = true;
    gcLocalTile.tile.classList.add('is-screen');
  }
  btnGcToggleScreen.classList.add('is-sharing');
  socket().emit('group:call:screen', { groupId: gcGroupId, on: true });
}

async function gcStopScreenShare() {
  if (!gcScreenTrack) return;
  const track = gcScreenTrack;
  gcScreenTrack = null;
  track.onended = null;
  track.stop();
  const cam = gcLocalStream ? gcLocalStream.getVideoTracks()[0] : null;
  for (const entry of gcPeers.values()) {
    const sender = findVideoSender(entry.pc);
    if (sender) await sender.replaceTrack(cam || null).catch(() => {});
  }
  if (gcLocalTile && gcLocalStream) {
    gcLocalTile.videoEl.srcObject = gcLocalStream;
    gcLocalTile.tile.classList.remove('is-screen');
    const camOn = !!cam && gcCamEnabled;
    gcLocalTile.videoEl.hidden = !camOn;
    gcLocalTile.avatarEl.hidden = camOn;
  }
  btnGcToggleScreen.classList.remove('is-sharing');
  if (gcGroupId) socket().emit('group:call:screen', { groupId: gcGroupId, on: false });
}

// Pas de partage d'ecran possible sur telephone : on cache le bouton (regarder reste possible).
if (!screenShareSupported()) {
  btnGcToggleScreen.hidden = true;
}
btnGcToggleScreen.addEventListener('click', () => {
  if (gcScreenTrack) gcStopScreenShare();
  else gcStartScreenShare();
});

// call.js
// Gere les appels audio/video en pair-a-pair via WebRTC. Le serveur ne sert
// que de relais de signalisation (voir server.js) ; le flux audio/video passe
// directement entre les deux navigateurs une fois la connexion etablie.
//
// Remarque : par defaut, seuls des serveurs STUN publics sont utilises (pas
// de serveur TURN), ce qui peut echouer si l'un des deux reseaux est tres
// restrictif (voir README). Si un serveur TURN est configure cote serveur
// (variable TURN_CREDENTIALS_URL sur Render), RBC.state.iceServers contient
// les identifiants recuperes via /api/ice-servers (voir app.js) et prend le
// relais automatiquement ; sinon on retombe sur cette liste STUN par defaut.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

function currentIceServers() {
  return RBC.state.iceServers && RBC.state.iceServers.length ? RBC.state.iceServers : ICE_SERVERS;
}

// Sur certains navigateurs (surtout iPhone/Safari), la lecture automatique
// du son distant peut etre bloquee silencieusement (aucune erreur visible,
// juste pas de son). Si ca arrive, on retente des que la personne touche
// l'ecran d'appel : un "geste utilisateur" debloque toujours la lecture.
function attemptAutoplay(mediaEl, retryContainerEl) {
  const playPromise = mediaEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => {
      const resume = () => {
        mediaEl.play().catch(() => {});
      };
      const target = retryContainerEl || document;
      target.addEventListener('click', resume, { once: true });
      target.addEventListener('touchend', resume, { once: true });
    });
  }
}

const callIncomingEl = document.getElementById('call-incoming');
const callIncomingName = document.getElementById('call-incoming-name');
const btnCallAccept = document.getElementById('btn-call-accept');
const btnCallReject = document.getElementById('btn-call-reject');

const callActiveEl = document.getElementById('call-active');
const callActiveName = document.getElementById('call-active-name');
const callActiveStatus = document.getElementById('call-active-status');
const localVideoEl = document.getElementById('local-video');
const remoteVideoEl = document.getElementById('remote-video');
const remoteAudioEl = document.getElementById('remote-audio');
remoteVideoEl.muted = true; // l'image seulement : le son passe par remoteAudioEl

const btnHangup = document.getElementById('btn-hangup');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');

const btnCallAudio = document.getElementById('btn-call-audio');
const btnCallVideo = document.getElementById('btn-call-video');
const callVideoWrapEl = document.querySelector('.call-video-wrap');
const callAudioVisualEl = document.getElementById('call-audio-visual');
const callAudioAvatarSlot = document.getElementById('call-audio-avatar-slot');

const btnCallDevices = document.getElementById('btn-call-devices');
const callDevicePanel = document.getElementById('call-device-panel');
const callMicSelect = document.getElementById('call-mic-select');
const callCamSelect = document.getElementById('call-cam-select');
const callCamSelectWrap = document.getElementById('call-cam-select-wrap');
const btnToggleScreen = document.getElementById('btn-toggle-screen');

let pc = null;
let localStream = null;
let currentCallPeerId = null;
let currentCallPeerPseudo = '';
let currentCallWithVideo = true;
let incomingCallWithVideo = true;
let pendingCandidates = [];
// Role et phase de l'appel en cours : evitent les melanges quand deux personnes
// s'appellent en meme temps. callRole : 'caller' (j'appelle) ou 'callee' (je recois).
// callPhase : 'calling' (ca sonne chez l'autre) | 'ringing' (ca sonne chez moi) | 'connecting'.
let callRole = null;
let callPhase = null;
let ringTimer = null; // l'appelant raccroche tout seul si personne ne repond
let incomingTimer = null; // la banniere d'appel disparait toute seule si l'appelant est parti
const RING_TIMEOUT_MS = 40000;
let micEnabled = true;
let camEnabled = true;
let screenTrack = null; // piste du partage d'ecran en cours (null si pas de partage)
let remoteScreenOn = false; // l'autre personne partage son ecran

function socket() {
  return RBC.state.socket;
}

// --------------------------- choix du micro / de la camera ---------------------------
// Comme sur Discord : on peut choisir quel microphone/quelle camera utiliser,
// avant ou pendant l'appel, et le choix est retenu pour la prochaine fois.

const PREFERRED_MIC_KEY = 'rbc_preferred_mic_id';
const PREFERRED_CAM_KEY = 'rbc_preferred_cam_id';

function getPreferredDeviceId(key) {
  try {
    return localStorage.getItem(key) || null;
  } catch (e) {
    return null;
  }
}
function setPreferredDeviceId(key, id) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch (e) {
    // tant pis, le choix ne sera juste pas retenu la prochaine fois
  }
}

async function listInputDevices(kind) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === kind);
  } catch (e) {
    return [];
  }
}

function fillDeviceSelect(selectEl, devices, activeDeviceId, fallbackLabel) {
  selectEl.innerHTML = '';
  if (devices.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = fallbackLabel;
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || fallbackLabel + ' ' + (i + 1);
    if (d.deviceId === activeDeviceId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

async function populateDeviceSelects(micSelectEl, camSelectEl, stream) {
  const micDevices = await listInputDevices('audioinput');
  const activeMicId = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].getSettings().deviceId : null;
  fillDeviceSelect(micSelectEl, micDevices, activeMicId, 'Microphone');

  if (camSelectEl) {
    const camDevices = await listInputDevices('videoinput');
    const activeCamId = stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].getSettings().deviceId : null;
    fillDeviceSelect(camSelectEl, camDevices, activeCamId, 'Caméra');
  }
}

// Remplace la piste audio (ou video) en cours par une nouvelle venant d'un
// autre peripherique, sans raccrocher : UN SEUL getUserMedia pour le nouveau
// flux, puis RTCRtpSender.replaceTrack() sur chaque connexion ouverte (une
// seule en appel 1-a-1, plusieurs en appel de groupe) pour le faire passer
// dans l'appel en cours.
async function switchMediaDevice(kind, deviceId, stream, peerConnections, savedKey, currentlyEnabled) {
  const constraints = kind === 'audio' ? { audio: { deviceId: { exact: deviceId } } } : { video: { deviceId: { exact: deviceId } } };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    RBC.showToast('Impossible de basculer sur ce périphérique.', true);
    return;
  }
  const newTrack = kind === 'audio' ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];
  if (!newTrack) return;

  const oldTracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
  oldTracks.forEach((t) => {
    stream.removeTrack(t);
    t.stop();
  });
  stream.addTrack(newTrack);

  newTrack.enabled = currentlyEnabled !== false;

  const list = Array.isArray(peerConnections) ? peerConnections : peerConnections ? [peerConnections] : [];
  list.forEach((peerConnection) => {
    const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === kind);
    if (sender) sender.replaceTrack(newTrack).catch(() => {});
  });

  setPreferredDeviceId(savedKey, deviceId);
}

async function getLocalStream(withVideo) {
  const micId = getPreferredDeviceId(PREFERRED_MIC_KEY);
  const camId = withVideo ? getPreferredDeviceId(PREFERRED_CAM_KEY) : null;
  const constraints = {
    audio: micId ? { deviceId: { exact: micId } } : true,
    video: withVideo ? (camId ? { deviceId: { exact: camId } } : true) : false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (micId || camId) {
      // Le peripherique prefere n'existe peut-etre plus (debranche) : on retente sans contrainte precise.
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
      } catch (err2) {
        RBC.showToast("Impossible d'acceder au micro" + (withVideo ? '/a la camera' : '') + " (verifie les autorisations du navigateur).", true);
        throw err2;
      }
    }
    RBC.showToast("Impossible d'acceder au micro" + (withVideo ? '/a la camera' : '') + " (verifie les autorisations du navigateur).", true);
    throw err;
  }
}

function createPeerConnection(peerId) {
  const conn = new RTCPeerConnection({ iceServers: currentIceServers() });

  localStream.getTracks().forEach((track) => conn.addTrack(track, localStream));
  // Appel audio : on reserve quand meme un emplacement video (vide). Le partage
  // d'ecran viendra s'y brancher plus tard sans renegociation.
  if (localStream.getVideoTracks().length === 0) {
    conn.addTransceiver('video', { direction: 'sendrecv', streams: [localStream] });
  }

  conn.onicecandidate = (event) => {
    if (event.candidate) {
      socket().emit('call:ice-candidate', { to: peerId, candidate: event.candidate });
    }
  };

  conn.ontrack = (event) => {
    if (!event.streams[0]) return;
    remoteVideoEl.srcObject = event.streams[0]; // l'image
    remoteAudioEl.srcObject = event.streams[0]; // le son
    remoteVideoEl.play().catch(() => {});
    attemptAutoplay(remoteAudioEl, callActiveEl);
    tryPlay(remoteAudioEl, callSoundBtn);
    callActiveStatus.textContent = 'en cours';
  };

  let disconnectTimer = null;
  conn.onconnectionstatechange = () => {
    const state = conn.connectionState;
    if (state === 'connected') {
      clearTimeout(disconnectTimer);
      return;
    }
    if (state === 'disconnected') {
      // Micro-coupure du reseau (wifi -> 4G, tunnel...) : souvent ca revient tout
      // seul en quelques secondes, donc on laisse 8 s avant de raccrocher.
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (pc === conn && conn.connectionState === 'disconnected' && currentCallPeerId) endCall(true);
      }, 8000);
      return;
    }
    if (['failed', 'closed'].includes(state) && currentCallPeerId && pc === conn) {
      clearTimeout(disconnectTimer);
      if (state === 'failed') {
        RBC.showToast('La connexion vidéo a échoué (réseau trop restrictif).', true);
      }
      endCall(true);
    }
  };

  return conn;
}

function flushPendingCandidates() {
  if (!pc || !pc.remoteDescription) return;
  pendingCandidates.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  pendingCandidates = [];
}

function openCallOverlay(peerPseudo, statusText, withVideo) {
  callActiveName.textContent = peerPseudo;
  callActiveStatus.textContent = statusText;
  callActiveEl.hidden = false;
  micEnabled = true;
  camEnabled = true;
  btnToggleMic.classList.remove('is-off');
  btnToggleCam.classList.remove('is-off');
  btnToggleScreen.classList.remove('is-sharing');
  remoteScreenOn = false;
  callVideoWrapEl.classList.remove('is-screen');
  acquireWakeLock();

  callCamSelectWrap.hidden = !withVideo;
  populateDeviceSelects(callMicSelect, withVideo ? callCamSelect : null, localStream);

  if (withVideo) {
    callVideoWrapEl.classList.remove('is-audio-call');
    callAudioVisualEl.hidden = true;
    localVideoEl.hidden = false;
    localVideoEl.srcObject = localStream;
    btnToggleCam.hidden = false;
  } else {
    // Jamais `hidden` ici (voir la regle CSS .is-audio-call) : ca couperait
    // le son distant sur pas mal de mobiles.
    callVideoWrapEl.classList.add('is-audio-call');
    callAudioVisualEl.hidden = false;
    localVideoEl.hidden = true;
    callAudioAvatarSlot.innerHTML = '';
    const bigAvatar = document.createElement('div');
    bigAvatar.className = 'avatar call-audio-avatar-circle';
    bigAvatar.style.background = avatarColor(peerPseudo);
    bigAvatar.textContent = peerPseudo.charAt(0).toUpperCase();
    callAudioAvatarSlot.appendChild(bigAvatar);
    btnToggleCam.hidden = true;
  }
}

// --------------------------- lancer un appel (appelant) ---------------------------

btnCallAudio.addEventListener('click', () => startCall(false));
btnCallVideo.addEventListener('click', () => startCall(true));

async function startCall(withVideo) {
  const friendId = RBC.state.activeFriendId;
  if (!friendId) return;
  if (currentCallPeerId) {
    RBC.showToast('Tu es deja en appel.', true);
    return;
  }
  const friend = RBC.getFriendById(friendId);
  if (!friend) return;
  if (!friend.online) {
    RBC.showToast(friend.pseudo + " n'est pas en ligne pour le moment.", true);
    return;
  }

  // On reserve l'appel TOUT DE SUITE, avant de demander le micro (ce qui peut
  // prendre du temps) : sinon, si l'autre nous appelle au meme moment, les deux
  // appareils se melangent et le son ne passe que dans un sens.
  currentCallPeerId = friendId;
  currentCallPeerPseudo = friend.pseudo;
  currentCallWithVideo = withVideo;
  callRole = 'caller';
  callPhase = 'calling';

  let stream;
  try {
    stream = await getLocalStream(withVideo);
  } catch (e) {
    if (currentCallPeerId === friendId && callRole === 'caller') resetCallState();
    return;
  }
  if (currentCallPeerId !== friendId || callRole !== 'caller') {
    // l'appel a change pendant l'attente (ex : appels croises) : on lache ce micro
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  localStream = stream;
  openCallOverlay(friend.pseudo, 'Appel en cours\u2026', withVideo);
  socket().emit('call:invite', { to: friendId, video: withVideo });

  // Personne ne repond : on raccroche tout seul et la sonnerie s'arrete chez l'autre.
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    if (callRole !== 'caller' || callPhase !== 'calling' || currentCallPeerId !== friendId) return;
    RBC.showToast(friend.pseudo + " n'a pas répondu.");
    socket().emit('call:cancel', { to: friendId });
    endCall(true);
  }, RING_TIMEOUT_MS);
}

// Remet a zero l'etat d'appel quand l'ecran d'appel n'a pas (encore) ete ouvert.
function resetCallState() {
  clearTimeout(ringTimer);
  clearTimeout(incomingTimer);
  currentCallPeerId = null;
  currentCallPeerPseudo = '';
  callRole = null;
  callPhase = null;
  callIncomingEl.hidden = true;
}

function handleCallAccepted({ fromId }) {
  if (fromId !== currentCallPeerId || callRole !== 'caller' || callPhase !== 'calling' || pc || !localStream) return;
  clearTimeout(ringTimer);
  callPhase = 'connecting';
  (async () => {
    pc = createPeerConnection(currentCallPeerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket().emit('call:offer', { to: currentCallPeerId, sdp: offer });
      callActiveStatus.textContent = 'connexion\u2026';
    } catch (e) {
      RBC.showToast("Erreur lors du demarrage de l'appel.", true);
      endCall(true);
    }
  })();
}

function handleCallRejected({ fromId }) {
  if (fromId !== currentCallPeerId || callRole !== 'caller') return;
  RBC.showToast(currentCallPeerPseudo + " a refuse l'appel.");
  endCall(true);
}

// --------------------------- recevoir un appel (appele) ---------------------------

function handleIncomingCall({ fromId, fromPseudo, video }) {
  // Appels croises : on s'appelait en meme temps. Regle simple et identique des
  // deux cotes : la personne dont l'identifiant est le plus petit garde son
  // appel, l'autre abandonne le sien et repond tout de suite.
  if (fromId === currentCallPeerId && callRole === 'caller' && callPhase === 'calling') {
    if (RBC.state.me.id < fromId) return;
    endCall(true);
    acceptIncoming(fromId, fromPseudo, !!video);
    return;
  }
  // deja en appel (ou en train d'appeler quelqu'un d'autre) -> "occupe"
  if (currentCallPeerId) {
    socket().emit('call:reject', { to: fromId });
    return;
  }
  currentCallPeerId = fromId;
  currentCallPeerPseudo = fromPseudo;
  callRole = 'callee';
  callPhase = 'ringing';
  incomingCallWithVideo = !!video;
  callIncomingName.textContent = fromPseudo + (video ? ' (appel video)' : ' (appel audio)');
  callIncomingEl.hidden = false;

  // Securite : si l'appelant est parti sans qu'on l'ait su, la banniere s'enleve seule.
  clearTimeout(incomingTimer);
  incomingTimer = setTimeout(() => {
    if (callRole !== 'callee' || callPhase !== 'ringing' || currentCallPeerId !== fromId) return;
    resetCallState();
    if (RBC.notify && RBC.notify.missedCall) RBC.notify.missedCall(fromPseudo);
  }, RING_TIMEOUT_MS + 10000);
}

btnCallReject.addEventListener('click', () => {
  if (callRole === 'callee' && callPhase === 'ringing' && currentCallPeerId) {
    socket().emit('call:reject', { to: currentCallPeerId });
  }
  resetCallState();
});

btnCallAccept.addEventListener('click', () => {
  if (callRole !== 'callee' || callPhase !== 'ringing') return;
  acceptIncoming(currentCallPeerId, currentCallPeerPseudo, incomingCallWithVideo);
});

async function acceptIncoming(peerId, peerPseudo, withVideo) {
  clearTimeout(incomingTimer);
  callIncomingEl.hidden = true;
  currentCallPeerId = peerId;
  currentCallPeerPseudo = peerPseudo;
  callRole = 'callee';
  callPhase = 'connecting';

  let stream;
  try {
    stream = await getLocalStream(withVideo);
  } catch (e) {
    socket().emit('call:reject', { to: peerId });
    if (currentCallPeerId === peerId) resetCallState();
    return;
  }
  if (currentCallPeerId !== peerId || callRole !== 'callee') {
    // l'appelant a raccroche pendant qu'on autorisait le micro
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  localStream = stream;
  currentCallWithVideo = withVideo;
  pc = createPeerConnection(peerId);
  openCallOverlay(peerPseudo, "en attente de l'appelant\u2026", withVideo);
  socket().emit('call:accept', { to: peerId });
}

// L'appelant a raccroche avant qu'on reponde : la banniere et la sonnerie s'arretent.
function handleCallCancelled({ fromId }) {
  if (fromId !== currentCallPeerId || callRole !== 'callee') return;
  const name = currentCallPeerPseudo;
  const wasRinging = callPhase === 'ringing';
  if (wasRinging) resetCallState();
  else endCall(true); // il a raccroche pendant qu'on repondait
  RBC.showToast(name + " a annulé l'appel.");
  if (RBC.notify && RBC.notify.missedCall) RBC.notify.missedCall(name);
}

// Un autre appareil de la meme personne (appli + navigateur ouverts) a deja repondu ou refuse.
function handleHandledElsewhere({ fromId }) {
  if (callRole === 'callee' && callPhase === 'ringing' && fromId === currentCallPeerId) {
    resetCallState();
    RBC.showToast('Appel pris sur un autre appareil.');
  }
}

// --------------------------- offre / reponse SDP ---------------------------

async function handleOffer({ fromId, sdp }) {
  if (fromId !== currentCallPeerId || callRole !== 'callee' || !pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket().emit('call:answer', { to: fromId, sdp: answer });
  } catch (e) {
    RBC.showToast("Erreur lors de la connexion de l'appel.", true);
    endCall(true);
  }
}

async function handleAnswer({ fromId, sdp }) {
  if (fromId !== currentCallPeerId || callRole !== 'caller' || !pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    flushPendingCandidates();
  } catch (e) {
    RBC.showToast("Erreur lors de la connexion de l'appel.", true);
    endCall(true);
  }
}

function handleIceCandidate({ fromId, candidate }) {
  if (fromId !== currentCallPeerId) return;
  if (pc && pc.remoteDescription) {
    pc.addIceCandidate(candidate).catch(() => {});
  } else {
    pendingCandidates.push(candidate);
  }
}

// --------------------------- terminer l'appel ---------------------------

function endCall(silent) {
  const peerId = currentCallPeerId;
  clearTimeout(ringTimer);
  clearTimeout(incomingTimer);
  callRole = null;
  callPhase = null;
  audioHealth.reset();
  releaseWakeLock();
  if (screenTrack) {
    screenTrack.onended = null;
    screenTrack.stop();
    screenTrack = null;
  }
  remoteScreenOn = false;
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  pendingCandidates = [];
  currentCallPeerId = null;
  currentCallPeerPseudo = '';
  callActiveEl.hidden = true;
  callIncomingEl.hidden = true;
  localVideoEl.srcObject = null;
  remoteVideoEl.srcObject = null;
  remoteAudioEl.srcObject = null;
  callVideoWrapEl.classList.remove('is-audio-call');
  callVideoWrapEl.classList.remove('is-screen');
  localVideoEl.hidden = false;
  btnToggleScreen.classList.remove('is-sharing');
  callAudioVisualEl.hidden = true;
  btnToggleCam.hidden = false;
  callDevicePanel.hidden = true;
  if (!silent && peerId && socket()) {
    socket().emit('call:end', { to: peerId });
  }
}

btnHangup.addEventListener('click', () => {
  // Pendant que ca sonne chez l'autre : on "annule" (sa banniere disparait).
  if (callRole === 'caller' && callPhase === 'calling' && currentCallPeerId) {
    socket().emit('call:cancel', { to: currentCallPeerId });
    endCall(true);
    return;
  }
  endCall(false);
});

function handleRemoteEnd({ fromId }) {
  if (fromId !== currentCallPeerId) return;
  if (callRole === 'callee' && callPhase === 'ringing') {
    handleCallCancelled({ fromId }); // l'appelant est parti avant qu'on reponde
    return;
  }
  RBC.showToast('Appel termine.');
  endCall(true);
}

// --------------------------- micro / camera ---------------------------

btnToggleMic.addEventListener('click', () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  btnToggleMic.classList.toggle('is-off', !micEnabled);
});

btnToggleCam.addEventListener('click', () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
  btnToggleCam.classList.toggle('is-off', !camEnabled);
});

// --------------------------- panneau de choix micro / camera ---------------------------

btnCallDevices.addEventListener('click', () => {
  callDevicePanel.hidden = !callDevicePanel.hidden;
});

callMicSelect.addEventListener('change', () => {
  if (!localStream || !callMicSelect.value) return;
  switchMediaDevice('audio', callMicSelect.value, localStream, pc, PREFERRED_MIC_KEY, micEnabled);
});

callCamSelect.addEventListener('change', () => {
  if (!localStream || !callCamSelect.value) return;
  switchMediaDevice('video', callCamSelect.value, localStream, screenTrack ? null : pc, PREFERRED_CAM_KEY, camEnabled).then(() => {
    localVideoEl.srcObject = localStream; // force le rafraichissement de l'aperçu local
  });
});

// --------------------------- branchement des evenements socket ---------------------------

RBC.onSocketReady(function (socketInstance) {
  socketInstance.on('call:incoming', handleIncomingCall);
  socketInstance.on('call:accepted', handleCallAccepted);
  socketInstance.on('call:rejected', handleCallRejected);
  socketInstance.on('call:cancelled', handleCallCancelled);
  socketInstance.on('call:handled-elsewhere', handleHandledElsewhere);
  socketInstance.on('call:offer', handleOffer);
  socketInstance.on('call:answer', handleAnswer);
  socketInstance.on('call:ice-candidate', handleIceCandidate);
  socketInstance.on('call:end', handleRemoteEnd);
  socketInstance.on('call:screen', handleRemoteScreen);
  socketInstance.on('disconnect', () => {
    if (currentCallPeerId) endCall(true);
  });
});

// --------------------------- partage d'ecran ---------------------------
// Comme sur Discord : un bouton pour montrer son ecran a l'autre personne
// pendant l'appel. L'ecran remplace la camera (ou occupe l'emplacement video
// reserve en appel audio), puis la camera revient quand on arrete.
// Fonctions partagees avec groupcall.js (charge apres ce fichier).

function screenShareSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

// Emplacement video (sender) d'une connexion : celui de la camera, ou celui
// reserve a vide en appel audio.
function findVideoSender(peerConnection) {
  const t = peerConnection
    .getTransceivers()
    .find((tr) => tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video');
  return t ? t.sender : null;
}

// Ouvre le selecteur d'ecran/fenetre du navigateur. Renvoie la piste video, ou
// null si la personne annule.
async function captureScreenTrack() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0] || null;
    if (track && 'contentHint' in track) track.contentHint = 'detail'; // texte plus net
    return track;
  } catch (e) {
    return null;
  }
}

// Affichage cote spectateur : si l'appel est audio, l'ecran partage fait apparaitre la video.
function applyCallLayout() {
  const showVideo = currentCallWithVideo || remoteScreenOn;
  callVideoWrapEl.classList.toggle('is-audio-call', !showVideo);
  callVideoWrapEl.classList.toggle('is-screen', remoteScreenOn);
  callAudioVisualEl.hidden = showVideo;
  localVideoEl.hidden = !currentCallWithVideo;
}

function handleRemoteScreen({ fromId, on }) {
  if (fromId !== currentCallPeerId) return;
  remoteScreenOn = !!on;
  applyCallLayout();
  remoteVideoEl.play().catch(() => {});
}

async function startScreenShare() {
  if (!pc || !localStream || screenTrack) return;
  const track = await captureScreenTrack();
  if (!track) return;
  const sender = findVideoSender(pc);
  if (!sender || !pc) {
    track.stop();
    RBC.showToast("Impossible de partager l'écran pour cet appel.", true);
    return;
  }
  try {
    await sender.replaceTrack(track);
  } catch (e) {
    track.stop();
    RBC.showToast("Impossible de partager l'écran pour cet appel.", true);
    return;
  }
  screenTrack = track;
  track.onended = () => stopScreenShare(); // bouton "Arreter le partage" du navigateur
  if (currentCallWithVideo) localVideoEl.srcObject = new MediaStream([track]);
  btnToggleScreen.classList.add('is-sharing');
  if (currentCallPeerId) socket().emit('call:screen', { to: currentCallPeerId, on: true });
}

async function stopScreenShare() {
  if (!screenTrack) return;
  const track = screenTrack;
  screenTrack = null;
  track.onended = null;
  track.stop();
  if (pc) {
    const sender = findVideoSender(pc);
    const cam = localStream ? localStream.getVideoTracks()[0] : null;
    if (sender) await sender.replaceTrack(cam || null).catch(() => {});
  }
  if (currentCallWithVideo && localStream) localVideoEl.srcObject = localStream;
  btnToggleScreen.classList.remove('is-sharing');
  if (currentCallPeerId && socket()) socket().emit('call:screen', { to: currentCallPeerId, on: false });
}

// Sur telephone, les navigateurs ne savent pas partager l'ecran (mais savent
// tres bien regarder celui des autres) : on cache simplement le bouton.
if (!screenShareSupported()) {
  btnToggleScreen.hidden = true;
}
btnToggleScreen.addEventListener('click', () => {
  if (screenTrack) stopScreenShare();
  else startScreenShare();
});

// --------------------------- garde-fous pendant l'appel ---------------------------
// Probleme classique : "au debut on s'entend, puis l'un des deux n'entend plus
// l'autre". Causes les plus frequentes, corrigees ici :
//  1. Le micro s'arrete tout seul (ecran du telephone qui se verrouille, appli
//     mise en arriere-plan, autre appli qui prend le micro) : on garde l'ecran
//     allume pendant l'appel et on relance le micro automatiquement s'il s'arrete.
//  2. Le navigateur met en pause le son recu : on le remet en lecture.
// Ces fonctions sont aussi utilisees par groupcall.js.

let wakeLock = null;

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (e) {
    // pas grave : certains appareils/navigateurs ne le permettent pas
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

let micRecovering = false;
let lastMicRecoverAt = 0;

// Si la piste micro est coupee (terminee), en reprend une nouvelle et la
// redonne a toutes les connexions de l'appel. Renvoie true si le micro a ete relance.
async function recoverMicIfNeeded(stream, peerConnections, enabled, force) {
  if (!stream || micRecovering) return false;
  const current = stream.getAudioTracks()[0];
  if (!force && current && current.readyState === 'live') return false;
  if (Date.now() - lastMicRecoverAt < 4000) return false;
  lastMicRecoverAt = Date.now();
  micRecovering = true;
  try {
    const micId = getPreferredDeviceId(PREFERRED_MIC_KEY);
    let fresh;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true });
    } catch (e) {
      fresh = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const newTrack = fresh.getAudioTracks()[0];
    if (!newTrack) return false;
    stream.getAudioTracks().forEach((t) => {
      stream.removeTrack(t);
      t.stop();
    });
    stream.addTrack(newTrack);
    newTrack.enabled = enabled !== false; // si on avait coupe le micro a la main, ca reste coupe
    peerConnections.forEach((peerConnection) => {
      const tr = peerConnection
        .getTransceivers()
        .find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === 'audio');
      if (tr) tr.sender.replaceTrack(newTrack).catch(() => {});
    });
    return true;
  } catch (e) {
    return false; // on reessaiera au prochain passage
  } finally {
    micRecovering = false;
  }
}

// Remet en lecture un element qui joue le son de l'autre s'il a ete mis en pause.
function keepRemotePlaying(mediaEl) {
  if (mediaEl && mediaEl.srcObject && mediaEl.paused) mediaEl.play().catch(() => {});
}

async function callKeeperTick() {
  if (!pc || !localStream || !currentCallPeerId) return;
  if (await recoverMicIfNeeded(localStream, [pc], micEnabled)) RBC.showToast('Micro relancé automatiquement.');
  tryPlay(remoteAudioEl, callSoundBtn);
  audioHealth.tick();
}
setInterval(callKeeperTick, 2500);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // On revient sur l'appli : l'ecran peut s'etre verrouille entre-temps.
  if (currentCallPeerId) acquireWakeLock();
  callKeeperTick();
});

// --------------------------- "Son coupe" : reactiver le son d'un clic ---------------------------
// Certains navigateurs / applis installees bloquent le son de l'autre tant
// qu'on n'a pas touche l'ecran (alors que ca marche dans un navigateur normal).
// Quand ca arrive, un bandeau apparait ; un clic dessus (ou n'importe ou sur
// l'ecran d'appel) remet le son. Utilise aussi par groupcall.js.

const callSoundBtn = document.getElementById('btn-enable-sound');

// Essaie de lancer la lecture. Renvoie true si le son joue, false s'il est bloque.
// Affiche/cache le bandeau passe en parametre selon le resultat.
function tryPlay(mediaEl, bannerEl) {
  if (!mediaEl || !mediaEl.srcObject) return Promise.resolve(true);
  mediaEl.muted = false;
  mediaEl.volume = 1;
  return mediaEl
    .play()
    .then(() => {
      if (bannerEl) bannerEl.hidden = true;
      return true;
    })
    .catch(() => {
      if (bannerEl) bannerEl.hidden = false;
      return false;
    });
}

// Un geste de l'utilisateur debloque aussi le moteur audio du navigateur (Safari surtout).
function unlockAudioEngine() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch (e) {
    // pas grave
  }
}

callSoundBtn.addEventListener('click', async () => {
  unlockAudioEngine();
  remoteVideoEl.play().catch(() => {});
  const ok = await tryPlay(remoteAudioEl, callSoundBtn);
  if (!ok) RBC.showToast("Impossible d'activer le son : vérifie le volume et la sortie audio de l'appareil.", true);
});
// Taper n'importe ou sur l'ecran d'appel tente aussi de remettre le son.
callActiveEl.addEventListener('click', () => {
  unlockAudioEngine();
  tryPlay(remoteAudioEl, callSoundBtn);
});

// --------------------------- diagnostic du son pendant l'appel ---------------------------
// Toutes les 2,5 s on regarde si des donnees audio passent vraiment dans les
// DEUX sens et on l'ecrit sous le nom (ex : "connecté, mais on ne reçoit rien
// de Paul"). Ca montre tout de suite de quel cote est le probleme, et si c'est
// ton micro qui n'envoie plus rien, il est relance automatiquement.

const audioHealth = {
  lastIn: 0,
  lastOut: 0,
  stallIn: 0,
  stallOut: 0,
  forcedMic: false,
  busy: false,
  reset() {
    this.lastIn = 0;
    this.lastOut = 0;
    this.stallIn = 0;
    this.stallOut = 0;
    this.forcedMic = false;
  },
  async tick() {
    if (this.busy || !pc || pc.connectionState !== 'connected') return;
    this.busy = true;
    try {
      let inBytes = 0;
      let outBytes = 0;
      const report = await pc.getStats();
      report.forEach((r) => {
        const kind = r.kind || r.mediaType;
        if (kind !== 'audio') return;
        if (r.type === 'inbound-rtp') inBytes += r.bytesReceived || 0;
        if (r.type === 'outbound-rtp') outBytes += r.bytesSent || 0;
      });
      this.stallIn = inBytes > this.lastIn ? 0 : this.stallIn + 1;
      this.stallOut = outBytes > this.lastOut ? 0 : this.stallOut + 1;
      this.lastIn = inBytes;
      this.lastOut = outBytes;

      const name = currentCallPeerPseudo || "l'autre personne";
      const noIn = this.stallIn >= 3;
      const noOut = this.stallOut >= 3 && micEnabled;
      if (noIn && noOut) callActiveStatus.textContent = 'connecté, mais aucun son ne passe';
      else if (noOut) callActiveStatus.textContent = "connecté, mais ton micro n'envoie rien";
      else if (noIn) callActiveStatus.textContent = 'connecté, mais on ne reçoit rien de ' + name;
      else callActiveStatus.textContent = 'en cours';

      if (noOut && !this.forcedMic && localStream) {
        this.forcedMic = true; // une seule tentative par appel
        if (await recoverMicIfNeeded(localStream, [pc], micEnabled, true)) RBC.showToast('Micro relancé automatiquement.');
      }
    } catch (e) {
      // pas grave, on reessaiera
    } finally {
      this.busy = false;
    }
  },
};

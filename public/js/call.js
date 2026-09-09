// call.js
// Gere les appels audio/video en pair-a-pair via WebRTC. Le serveur ne sert
// que de relais de signalisation (voir server.js) ; le flux audio/video passe
// directement entre les deux navigateurs une fois la connexion etablie.
//
// Remarque : seuls des serveurs STUN publics sont utilises, pas de serveur
// TURN. Ca fonctionne dans la grande majorite des cas, mais un appel peut
// echouer si l'un des deux reseaux est tres restrictif (voir README).

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

const callIncomingEl = document.getElementById('call-incoming');
const callIncomingName = document.getElementById('call-incoming-name');
const btnCallAccept = document.getElementById('btn-call-accept');
const btnCallReject = document.getElementById('btn-call-reject');

const callActiveEl = document.getElementById('call-active');
const callActiveName = document.getElementById('call-active-name');
const callActiveStatus = document.getElementById('call-active-status');
const localVideoEl = document.getElementById('local-video');
const remoteVideoEl = document.getElementById('remote-video');

const btnHangup = document.getElementById('btn-hangup');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');

const btnCallAudio = document.getElementById('btn-call-audio');
const btnCallVideo = document.getElementById('btn-call-video');
const callVideoWrapEl = document.querySelector('.call-video-wrap');
const callAudioVisualEl = document.getElementById('call-audio-visual');
const callAudioAvatarSlot = document.getElementById('call-audio-avatar-slot');

let pc = null;
let localStream = null;
let currentCallPeerId = null;
let currentCallPeerPseudo = '';
let currentCallWithVideo = true;
let incomingCallWithVideo = true;
let pendingCandidates = [];
let micEnabled = true;
let camEnabled = true;

function socket() {
  return RBC.state.socket;
}

async function getLocalStream(withVideo) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch (err) {
    RBC.showToast("Impossible d'acceder au micro" + (withVideo ? '/a la camera' : '') + " (verifie les autorisations du navigateur).", true);
    throw err;
  }
}

function createPeerConnection(peerId) {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => conn.addTrack(track, localStream));

  conn.onicecandidate = (event) => {
    if (event.candidate) {
      socket().emit('call:ice-candidate', { to: peerId, candidate: event.candidate });
    }
  };

  conn.ontrack = (event) => {
    remoteVideoEl.srcObject = event.streams[0];
    callActiveStatus.textContent = 'en cours';
  };

  conn.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(conn.connectionState) && currentCallPeerId) {
      if (conn.connectionState === 'failed') {
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

  if (withVideo) {
    callVideoWrapEl.hidden = false;
    callAudioVisualEl.hidden = true;
    localVideoEl.srcObject = localStream;
    btnToggleCam.hidden = false;
  } else {
    callVideoWrapEl.hidden = true;
    callAudioVisualEl.hidden = false;
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

  try {
    localStream = await getLocalStream(withVideo);
  } catch (e) {
    return;
  }

  currentCallPeerId = friendId;
  currentCallPeerPseudo = friend.pseudo;
  currentCallWithVideo = withVideo;
  openCallOverlay(friend.pseudo, 'Appel en cours\u2026', withVideo);
  socket().emit('call:invite', { to: friendId, video: withVideo });
}

function handleCallAccepted({ fromId }) {
  if (fromId !== currentCallPeerId) return;
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
  if (fromId !== currentCallPeerId) return;
  RBC.showToast(currentCallPeerPseudo + " a refuse l'appel.");
  endCall(true);
}

// --------------------------- recevoir un appel (appele) ---------------------------

function handleIncomingCall({ fromId, fromPseudo, video }) {
  // deja en appel ou en train d'appeler -> on decroche pas, signal "occupe"
  if (currentCallPeerId) {
    socket().emit('call:reject', { to: fromId });
    return;
  }
  currentCallPeerId = fromId;
  currentCallPeerPseudo = fromPseudo;
  incomingCallWithVideo = !!video;
  callIncomingName.textContent = fromPseudo + (video ? ' (appel video)' : ' (appel audio)');
  callIncomingEl.hidden = false;
}

btnCallReject.addEventListener('click', () => {
  if (currentCallPeerId) socket().emit('call:reject', { to: currentCallPeerId });
  callIncomingEl.hidden = true;
  currentCallPeerId = null;
  currentCallPeerPseudo = '';
});

btnCallAccept.addEventListener('click', async () => {
  const peerId = currentCallPeerId;
  const peerPseudo = currentCallPeerPseudo;
  const withVideo = incomingCallWithVideo;
  callIncomingEl.hidden = true;
  try {
    localStream = await getLocalStream(withVideo);
  } catch (e) {
    socket().emit('call:reject', { to: peerId });
    currentCallPeerId = null;
    return;
  }
  currentCallWithVideo = withVideo;
  pc = createPeerConnection(peerId);
  openCallOverlay(peerPseudo, "en attente de l'appelant\u2026", withVideo);
  socket().emit('call:accept', { to: peerId });
});

function handleCallCancelled({ fromId }) {
  if (fromId !== currentCallPeerId) return;
  RBC.showToast(currentCallPeerPseudo + " a annule l'appel.");
  callIncomingEl.hidden = true;
  currentCallPeerId = null;
  currentCallPeerPseudo = '';
}

// --------------------------- offre / reponse SDP ---------------------------

async function handleOffer({ fromId, sdp }) {
  if (fromId !== currentCallPeerId || !pc) return;
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
  if (fromId !== currentCallPeerId || !pc) return;
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
  callVideoWrapEl.hidden = false;
  callAudioVisualEl.hidden = true;
  btnToggleCam.hidden = false;
  if (!silent && peerId && socket()) {
    socket().emit('call:end', { to: peerId });
  }
}

btnHangup.addEventListener('click', () => endCall(false));

function handleRemoteEnd({ fromId }) {
  if (fromId !== currentCallPeerId) return;
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

// --------------------------- branchement des evenements socket ---------------------------

RBC.onSocketReady(function (socketInstance) {
  socketInstance.on('call:incoming', handleIncomingCall);
  socketInstance.on('call:accepted', handleCallAccepted);
  socketInstance.on('call:rejected', handleCallRejected);
  socketInstance.on('call:cancelled', handleCallCancelled);
  socketInstance.on('call:offer', handleOffer);
  socketInstance.on('call:answer', handleAnswer);
  socketInstance.on('call:ice-candidate', handleIceCandidate);
  socketInstance.on('call:end', handleRemoteEnd);
  socketInstance.on('disconnect', () => {
    if (currentCallPeerId) endCall(true);
  });
});

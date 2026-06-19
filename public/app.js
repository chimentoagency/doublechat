'use strict';

const state = {
  ws: null,
  pc: null,
  localStream: null,
  pipWindow: null,
};

const $ = (id) => document.getElementById(id);
const localVideo    = $('local-video');
const remoteVideo   = $('remote-video');
const statusEl      = $('status');
const muteAudioBtn  = $('mute-audio');
const muteVideoBtn  = $('mute-video');
const popoutBtn     = $('popout');

// ── Media ────────────────────────────────────────────────────────────────────

async function init() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 15 },
      audio: true,
    });
    localVideo.srcObject = state.localStream;
  } catch (err) {
    setStatus('Camera/mic access denied', 'error');
    return;
  }
  connectSignaling();
}

// ── Signaling ─────────────────────────────────────────────────────────────────

function connectSignaling() {
  const ws = new WebSocket(`wss://${location.host}`);
  state.ws = ws;

  ws.onopen = () => setStatus('Waiting for partner...', 'waiting');

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    await handleSignal(msg);
  };

  ws.onclose = () => {
    setStatus('Server disconnected — reconnecting...', 'error');
    setTimeout(connectSignaling, 3000);
  };

  ws.onerror = () => ws.close();
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'full':
      setStatus('Session full (max 2 participants)', 'error');
      break;

    case 'peers':
      // We joined and the other person is already here — wait for their offer
      if (msg.count === 2) setStatus('Partner found — connecting...', 'connecting');
      break;

    case 'peer-joined':
      // We were already here when the other person joined — we initiate
      if (msg.count === 2 && !state.pc) {
        setStatus('Partner connected — starting call...', 'connecting');
        await startCall();
      }
      break;

    case 'peer-left':
      setStatus('Partner disconnected', 'waiting');
      teardown();
      break;

    case 'offer':
      await handleOffer(msg.sdp);
      break;

    case 'answer':
      if (state.pc) await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      break;

    case 'ice':
      if (state.pc && msg.candidate) await state.pc.addIceCandidate(msg.candidate);
      break;
  }
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

// ── WebRTC ───────────────────────────────────────────────────────────────────

function buildPeerConnection() {
  // No STUN/TURN needed — both peers are on the same LAN
  const pc = new RTCPeerConnection({ iceServers: [] });

  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);

  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;
  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    // Also update the video element inside a live pip window
    if (state.pipWindow && !state.pipWindow.closed) {
      const pipVid = state.pipWindow.document.getElementById('pip-video');
      if (pipVid) pipVid.srcObject = remoteStream;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected')                        setStatus('Connected', 'connected');
    else if (s === 'disconnected' || s === 'failed') setStatus('Connection lost — waiting...', 'waiting');
  };

  // Attempt ICE restart on transient failure
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') pc.restartIce();
  };

  return pc;
}

async function startCall() {
  state.pc = buildPeerConnection();
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: offer.sdp });
}

async function handleOffer(sdp) {
  state.pc = buildPeerConnection();
  await state.pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  send({ type: 'answer', sdp: answer.sdp });
}

function teardown() {
  state.pc?.close();
  state.pc = null;
  remoteVideo.srcObject = null;
}

// ── Controls ──────────────────────────────────────────────────────────────────

muteAudioBtn.addEventListener('click', () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  muteAudioBtn.textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
  muteAudioBtn.classList.toggle('muted', !track.enabled);
});

muteVideoBtn.addEventListener('click', () => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  muteVideoBtn.textContent = track.enabled ? 'Stop Video' : 'Start Video';
  muteVideoBtn.classList.toggle('muted', !track.enabled);
});

// ── Picture-in-Picture ────────────────────────────────────────────────────────

popoutBtn.addEventListener('click', handlePopout);

async function handlePopout() {
  // Document PiP (Chrome 116+): full custom HTML, always-on-top
  if ('documentPictureInPicture' in window) {
    if (state.pipWindow && !state.pipWindow.closed) {
      state.pipWindow.close();
      return;
    }
    try {
      const pip = await window.documentPictureInPicture.requestWindow({ width: 400, height: 300 });
      state.pipWindow = pip;
      popoutBtn.textContent = 'Close Pop-Out';

      // Inject styles
      const style = pip.document.createElement('style');
      style.textContent = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; height: 100vh; display: flex; flex-direction: column; }
        video { flex: 1; width: 100%; object-fit: cover; display: block; }
        .pip-label { font: 500 0.75rem system-ui,sans-serif; color: rgba(255,255,255,.7);
                     padding: 0.3rem 0.6rem; background: rgba(0,0,0,.5); }
      `;
      pip.document.head.appendChild(style);

      const label = pip.document.createElement('div');
      label.className = 'pip-label';
      label.textContent = 'Partner — DoubleChat';
      pip.document.body.appendChild(label);

      const vid = pip.document.createElement('video');
      vid.id = 'pip-video';
      vid.autoplay = true;
      vid.playsInline = true;
      vid.srcObject = remoteVideo.srcObject;
      pip.document.body.appendChild(vid);

      pip.addEventListener('pagehide', () => {
        state.pipWindow = null;
        popoutBtn.textContent = 'Pop Out';
      });
      return;
    } catch {}
  }

  // Fallback: standard video PiP (always-on-top, video only)
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    popoutBtn.textContent = 'Pop Out';
  } else if (remoteVideo.requestPictureInPicture) {
    await remoteVideo.requestPictureInPicture();
    popoutBtn.textContent = 'Close Pop-Out';
    remoteVideo.addEventListener('leavepictureinpicture', () => {
      popoutBtn.textContent = 'Pop Out';
    }, { once: true });
  } else {
    alert('Picture-in-Picture is not supported in this browser.');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status status-${type}`;
}

init();

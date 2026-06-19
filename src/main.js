import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  ws: null,
  pc: null,
  localStream: null,
  alwaysOnTop: false,
  pipWindow: null,
};

const appWindow = getCurrentWindow();

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

// ── Setup screen ──────────────────────────────────────────────────────────────

$('btn-host').addEventListener('click', async () => {
  hide('role-btns');
  show('host-panel');

  const ips = await invoke('get_local_ips');
  const container = $('host-ips');
  if (ips.length === 0) {
    container.textContent = 'Could not detect LAN IP. Check network connection.';
  } else {
    ips.forEach((addr) => {
      const chip = document.createElement('div');
      chip.className = 'ip-chip';
      chip.textContent = addr;
      chip.title = 'Click to copy';
      chip.addEventListener('click', () => navigator.clipboard.writeText(addr));
      container.appendChild(chip);
    });
  }

  await startMedia();
  connectSignaling('127.0.0.1:3717');
});

$('btn-join').addEventListener('click', () => {
  hide('role-btns');
  show('join-panel');
  $('host-ip-input').focus();
});

$('btn-connect').addEventListener('click', joinWithInput);
$('host-ip-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinWithInput();
});

async function joinWithInput() {
  const raw = $('host-ip-input').value.trim();
  if (!raw) return;
  const addr = raw.includes(':') ? raw : `${raw}:3717`;
  await startMedia();
  connectSignaling(addr);
}

// ── Media ─────────────────────────────────────────────────────────────────────

async function startMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 15 },
      audio: true,
    });
    $('local-video').srcObject = state.localStream;
  } catch (err) {
    showJoinError('Camera/mic access denied: ' + err.message);
  }
}

// ── Signaling ─────────────────────────────────────────────────────────────────

function connectSignaling(addr) {
  const ws = new WebSocket(`ws://${addr}`);
  state.ws = ws;
  setStatus('Connecting...');

  ws.onopen = () => setStatus('Waiting for partner...');

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    await handleSignal(msg);
  };

  ws.onclose = () => {
    if ($('call-screen').classList.contains('hidden')) {
      showJoinError('Could not connect to host. Check the address and try again.');
    } else {
      setStatus('Disconnected — reconnecting...');
      setTimeout(() => connectSignaling(addr), 3000);
    }
  };

  ws.onerror = () => ws.close();
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'full':
      showJoinError('Session is full (max 2 participants).');
      state.ws?.close();
      break;

    case 'peers':
      if (msg.count === 1) setStatus('Waiting for partner...');
      if (msg.count === 2) {
        // We joined and a partner is already waiting — wait for their offer
        enterCallScreen();
        setStatus('Partner found — connecting...');
      }
      break;

    case 'peer-joined':
      if (msg.count === 2 && !state.pc) {
        // We were already here — initiate
        enterCallScreen();
        setStatus('Partner connected — starting call...');
        await startCall();
      }
      break;

    case 'peer-left':
      setStatus('Partner disconnected');
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

// ── WebRTC ────────────────────────────────────────────────────────────────────

function buildPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: [] });

  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);

  const remoteStream = new MediaStream();
  $('remote-video').srcObject = remoteStream;

  pc.ontrack = (e) => {
    remoteStream.addTrack(e.track);
    // Keep pip window in sync if open
    if (state.pipWindow && !state.pipWindow.closed) {
      const pipVid = state.pipWindow.document.getElementById('pip-vid');
      if (pipVid) pipVid.srcObject = remoteStream;
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') setStatus('Connected');
    else if (s === 'disconnected' || s === 'failed') {
      setStatus('Connection lost — waiting...');
      pc.restartIce();
    }
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
  $('remote-video').srcObject = null;
}

// ── Controls ──────────────────────────────────────────────────────────────────

$('btn-mute-mic').addEventListener('click', () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('btn-mute-mic').textContent = track.enabled ? 'Mute Mic' : 'Unmute Mic';
  $('btn-mute-mic').classList.toggle('muted', !track.enabled);
});

$('btn-mute-cam').addEventListener('click', () => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('btn-mute-cam').textContent = track.enabled ? 'Stop Video' : 'Start Video';
  $('btn-mute-cam').classList.toggle('muted', !track.enabled);
});

$('btn-on-top').addEventListener('click', async () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  await appWindow.setAlwaysOnTop(state.alwaysOnTop);
  $('btn-on-top').textContent = state.alwaysOnTop
    ? 'Always on Top: On'
    : 'Always on Top: Off';
  $('btn-on-top').classList.toggle('active', state.alwaysOnTop);
});

// ── Pop-out (Document PiP → fallback video PiP) ───────────────────────────────

$('btn-popout').addEventListener('click', handlePopout);

async function handlePopout() {
  // Close existing pip if open
  if (state.pipWindow && !state.pipWindow.closed) {
    state.pipWindow.close();
    return;
  }
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return;
  }

  const remoteVideo = $('remote-video');

  // Document PiP (Edge/Chrome 116+) — full custom HTML, always-on-top
  if ('documentPictureInPicture' in window) {
    try {
      const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 320 });
      state.pipWindow = pip;
      $('btn-popout').textContent = 'Close Pop-Out';

      pip.document.head.innerHTML = `<style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#000;height:100vh;display:flex;flex-direction:column;font-family:system-ui,sans-serif}
        .bar{padding:.3rem .6rem;background:rgba(0,0,0,.6);color:rgba(255,255,255,.8);font-size:.75rem;display:flex;justify-content:space-between;align-items:center}
        video{flex:1;width:100%;object-fit:cover;display:block}
      </style>`;

      const bar = pip.document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = '<span>DoubleChat — Partner</span>';
      pip.document.body.appendChild(bar);

      const vid = pip.document.createElement('video');
      vid.id = 'pip-vid';
      vid.autoplay = true;
      vid.playsInline = true;
      vid.srcObject = remoteVideo.srcObject;
      pip.document.body.appendChild(vid);

      pip.addEventListener('pagehide', () => {
        state.pipWindow = null;
        $('btn-popout').textContent = 'Pop Out';
      });
      return;
    } catch {}
  }

  // Fallback: standard video PiP (always-on-top, video only)
  if (remoteVideo.requestPictureInPicture) {
    await remoteVideo.requestPictureInPicture();
    $('btn-popout').textContent = 'Close Pop-Out';
    remoteVideo.addEventListener('leavepictureinpicture', () => {
      $('btn-popout').textContent = 'Pop Out';
    }, { once: true });
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function enterCallScreen() {
  hide('setup-screen');
  show('call-screen');
}

function setStatus(text) {
  $('call-status').textContent = text;
}

function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  show('join-error');
}

// ── Auto-update banner ────────────────────────────────────────────────────────

listen('update-ready', (event) => {
  $('update-msg').textContent = `DoubleChat ${event.payload} has been downloaded.`;
  show('update-banner');
});

$('btn-restart').addEventListener('click', () => relaunch());

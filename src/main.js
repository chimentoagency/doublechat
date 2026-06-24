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
  mode: 'idle',            // 'idle' | 'listening' | 'calling' | 'in-call'
  callPeerIp: null,
  callPeerName: null,
  callPeerHostname: null,  // mDNS device name, stable across IP changes
};

// hostname → { name, ip, port } for currently-online DoubleChat peers
const livePeers = new Map();

let deviceName = 'Unknown Device';
const appWindow = getCurrentWindow();
const LISTEN_ADDR = '127.0.0.1:3717';

// ── DOM helpers ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

// ── Startup ───────────────────────────────────────────────────────────────────

async function init() {
  $('copyright-year').textContent = new Date().getFullYear();
  deviceName = await invoke('get_device_name');
  renderContacts();
  startListening();

  listen('mdns-peer-found', (e) => {
    livePeers.set(e.payload.name, e.payload);
    renderNearby();
  });

  listen('mdns-peer-lost', (e) => {
    livePeers.delete(e.payload);
    renderNearby();
  });
}

init();

// ── Contacts (localStorage) ───────────────────────────────────────────────────

function loadContacts() {
  try { return JSON.parse(localStorage.getItem('dc-contacts') || '[]'); }
  catch { return []; }
}

function saveContacts(contacts) {
  localStorage.setItem('dc-contacts', JSON.stringify(contacts));
}

function upsertContact(name, ip, hostname = null) {
  const contacts = loadContacts();
  const existing = contacts.find((c) =>
    (hostname && c.hostname === hostname) || c.lastIp === ip || c.ip === ip
  );
  if (existing) {
    existing.name = name;
    if (hostname) existing.hostname = hostname;
    existing.lastIp = ip;
    existing.lastSeen = new Date().toISOString();
  } else {
    contacts.unshift({
      id: crypto.randomUUID(),
      name,
      hostname: hostname || null,
      lastIp: ip,
      lastSeen: new Date().toISOString(),
    });
  }
  saveContacts(contacts);
  renderContacts();
}

function deleteContact(id) {
  saveContacts(loadContacts().filter((c) => c.id !== id));
  renderContacts();
}

function renderContacts() {
  const contacts = loadContacts();
  const list = $('contacts-list');
  list.innerHTML = '';

  if (contacts.length === 0) {
    show('no-contacts');
    return;
  }

  hide('no-contacts');
  contacts.forEach((c) => {
    const ip = c.lastIp || c.ip || '';
    const hostname = c.hostname || null;
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `
      <div class="contact-info">
        <span class="contact-name">${escHtml(c.name)}</span>
        <span class="contact-ip">${escHtml(ip)}</span>
      </div>
      <div class="contact-actions">
        <button class="ctrl-btn accent call-btn"
          data-ip="${escHtml(ip)}"
          data-hostname="${escHtml(hostname || '')}">Call</button>
        <button class="ctrl-btn danger del-btn" data-id="${c.id}">✕</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.call-btn').forEach((btn) =>
    btn.addEventListener('click', () =>
      callContact(btn.dataset.ip, btn.dataset.hostname || null)
    )
  );
  list.querySelectorAll('.del-btn').forEach((btn) =>
    btn.addEventListener('click', () => deleteContact(btn.dataset.id))
  );
}

// ── Nearby (mDNS) ─────────────────────────────────────────────────────────────

function renderNearby() {
  const list = $('nearby-list');
  list.innerHTML = '';

  if (livePeers.size === 0) {
    hide('nearby-section');
    return;
  }

  show('nearby-section');
  for (const peer of livePeers.values()) {
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `
      <div class="contact-info">
        <span class="contact-name">
          <span class="online-dot"></span>${escHtml(peer.name)}
        </span>
      </div>
      <div class="contact-actions">
        <button class="ctrl-btn accent" data-hostname="${escHtml(peer.name)}">Call</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => {
      const p = livePeers.get(peer.name);
      if (p) callContact(`${p.ip}:${p.port}`, p.name);
    });
    list.appendChild(row);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Listening mode ────────────────────────────────────────────────────────────

function startListening() {
  if (state.ws) return;

  const ws = new WebSocket(`ws://${LISTEN_ADDR}`);
  state.ws = ws;
  state.mode = 'listening';

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (state.mode === 'listening') {
      if (msg.type === 'call-request') {
        state.callPeerName     = msg.name || msg.ip || 'Unknown';
        state.callPeerIp       = msg.ip  || null;
        state.callPeerHostname = msg.hostname || null;
        showIncomingCall(state.callPeerName);
      }
      if (msg.type === 'peer-left') {
        hide('incoming-overlay');
      }
    } else {
      await handleSignal(msg);
    }
  };

  ws.onclose = () => {
    state.ws = null;
    if (state.mode === 'listening') setTimeout(startListening, 3000);
  };

  ws.onerror = () => ws.close();
}

// ── Setup screen actions ──────────────────────────────────────────────────────

$('btn-share-address').addEventListener('click', async () => {
  hide('action-btns');
  hide('contacts-section');
  show('share-panel');

  const ips = await invoke('get_local_ips');
  const container = $('host-ips');
  container.innerHTML = '';
  if (ips.length === 0) {
    container.textContent = 'No LAN IP detected. Check your network.';
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
});

$('btn-manual-connect').addEventListener('click', () => {
  hide('action-btns');
  hide('contacts-section');
  show('connect-panel');
  $('host-ip-input').focus();
});

$('btn-back-share').addEventListener('click', showHome);
$('btn-back-connect').addEventListener('click', showHome);

$('btn-connect').addEventListener('click', connectFromInput);
$('host-ip-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectFromInput(); });

function connectFromInput() {
  const raw = $('host-ip-input').value.trim();
  if (!raw) return;
  const addr = raw.includes(':') ? raw : `${raw}:3717`;
  callContact(addr, null);
}

async function callContact(addr, hostname = null) {
  // Resolve fresh IP via mDNS if peer is currently online
  if (hostname && livePeers.has(hostname)) {
    const peer = livePeers.get(hostname);
    addr = `${peer.ip}:${peer.port}`;
  }

  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }

  const myIps = await invoke('get_local_ips');
  const myIp = myIps[0] || '';

  const ws = new WebSocket(`ws://${addr}`);
  state.ws = ws;
  state.mode = 'calling';
  state.callPeerIp       = addr;
  state.callPeerHostname = hostname;

  ws.onopen = () => {
    send({ type: 'call-request', name: deviceName, hostname: deviceName, ip: myIp });
    setStatus('Calling...');
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    if (state.mode === 'calling') {
      if (msg.type === 'call-accepted') {
        await startMedia();
        enterCallScreen();
        await startCall();
      }
      if (msg.type === 'call-declined') {
        showJoinError('Call was declined.');
        resetToListening();
      }
      if (msg.type === 'peer-left') {
        showJoinError('No answer — partner may not be available.');
        resetToListening();
      }
    } else {
      await handleSignal(msg);
    }
  };

  ws.onclose = () => {
    if (state.mode === 'calling') {
      showJoinError('Could not reach that address. Check IP and try again.');
      resetToListening();
    } else if (state.mode === 'in-call') {
      setStatus('Connection lost — reconnecting...');
      setTimeout(() => { if (state.ws === ws) callContact(addr, hostname); }, 3000);
    }
  };

  ws.onerror = () => ws.close();
}

// ── Incoming call handling ────────────────────────────────────────────────────

function showIncomingCall(name) {
  $('incoming-name').textContent = name;
  show('incoming-overlay');
}

$('btn-accept').addEventListener('click', async () => {
  hide('incoming-overlay');
  send({ type: 'call-accepted' });
  state.mode = 'in-call';
  await startMedia();
  enterCallScreen();
});

$('btn-decline').addEventListener('click', () => {
  send({ type: 'call-declined' });
  hide('incoming-overlay');
  resetToListening();
});

// ── Media ─────────────────────────────────────────────────────────────────────

async function startMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, frameRate: 15 },
      audio: true,
    });
    $('local-video').srcObject = state.localStream;
    await populateDeviceSelectors();
  } catch (err) {
    showJoinError('Camera/mic access denied: ' + err.message);
  }
}

async function populateDeviceSelectors() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const curAudio = state.localStream?.getAudioTracks()[0]?.getSettings().deviceId;
  const curVideo = state.localStream?.getVideoTracks()[0]?.getSettings().deviceId;

  fillDevSelect('sel-audio', devices.filter((d) => d.kind === 'audioinput'), curAudio, 'Microphone');
  fillDevSelect('sel-video', devices.filter((d) => d.kind === 'videoinput'), curVideo, 'Camera');
}

function fillDevSelect(id, devices, curDeviceId, fallback) {
  const wrap = $(id);
  const list = wrap.querySelector('.dev-select-list');
  const btnLabel = wrap.querySelector('.dev-select-btn span');

  list.innerHTML = '';

  if (devices.length === 0) {
    btnLabel.textContent = 'No device found';
    wrap.dataset.value = '';
    const li = document.createElement('li');
    li.textContent = 'No device found';
    li.style.cssText = 'opacity:0.5;cursor:default;pointer-events:none';
    list.appendChild(li);
    wrap.querySelector('.dev-select-btn').onclick = (e) => {
      e.stopPropagation();
      list.classList.toggle('hidden');
    };
    return;
  }

  devices.forEach((d, i) => {
    const li = document.createElement('li');
    li.dataset.value = d.deviceId;
    li.textContent = d.label || `${fallback} ${i + 1}`;
    if (d.deviceId === curDeviceId || (!curDeviceId && i === 0)) {
      li.classList.add('selected');
      btnLabel.textContent = li.textContent;
      wrap.dataset.value = d.deviceId;
    }
    li.addEventListener('click', () => {
      list.querySelectorAll('li').forEach((el) => el.classList.remove('selected'));
      li.classList.add('selected');
      btnLabel.textContent = li.textContent;
      wrap.dataset.value = d.deviceId;
      list.classList.add('hidden');
      reinitMedia();
    });
    list.appendChild(li);
  });

  wrap.querySelector('.dev-select-btn').onclick = (e) => {
    e.stopPropagation();
    const otherId = id === 'sel-audio' ? 'sel-video' : 'sel-audio';
    $(otherId).querySelector('.dev-select-list').classList.add('hidden');
    list.classList.toggle('hidden');
  };
}

async function reinitMedia() {
  const audioId = $('sel-audio').dataset.value;
  const videoId = $('sel-video').dataset.value;
  state.localStream?.getTracks().forEach((t) => t.stop());
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: videoId }, width: 640, height: 480, frameRate: 15 },
      audio: { deviceId: { exact: audioId } },
    });
    $('local-video').srcObject = state.localStream;
    if (state.pc) {
      for (const sender of state.pc.getSenders()) {
        if (sender.track?.kind === 'audio') {
          const t = state.localStream.getAudioTracks()[0];
          if (t) await sender.replaceTrack(t);
        } else if (sender.track?.kind === 'video') {
          const t = state.localStream.getVideoTracks()[0];
          if (t) await sender.replaceTrack(t);
        }
      }
    }
  } catch (err) {
    console.error('Device switch failed:', err);
  }
}

document.addEventListener('click', () => {
  document.querySelectorAll('.dev-select-list').forEach((l) => l.classList.add('hidden'));
});

// ── Signaling (in-call relay) ─────────────────────────────────────────────────

async function handleSignal(msg) {
  switch (msg.type) {
    case 'peer-left':
      setStatus('Partner disconnected');
      teardown();
      promptSaveContact();
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

  pc.ontrack = (e) => {
    if (e.streams?.[0]) {
      $('remote-video').srcObject = e.streams[0];
      $('remote-video').play().catch(() => {});
      if (state.pipWindow && !state.pipWindow.closed) {
        const pipVid = state.pipWindow.document.getElementById('pip-vid');
        if (pipVid) pipVid.srcObject = e.streams[0];
      }
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      state.mode = 'in-call';
      setStatus('Connected');
    } else if (s === 'disconnected' || s === 'failed') {
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

// ── Save contact prompt ───────────────────────────────────────────────────────

function promptSaveContact() {
  const ip       = state.callPeerIp;
  const hostname = state.callPeerHostname;
  if (!ip) return;

  const contacts = loadContacts();
  const existing = contacts.find((c) =>
    (hostname && c.hostname === hostname) || c.lastIp === ip || c.ip === ip
  );
  if (existing) {
    existing.lastSeen = new Date().toISOString();
    if (hostname) existing.hostname = hostname;
    existing.lastIp = ip;
    saveContacts(contacts);
    renderContacts();
    return;
  }

  $('save-ip-display').textContent = ip;
  $('save-name-input').value = state.callPeerName || hostname || '';
  show('save-overlay');
}

$('btn-save-confirm').addEventListener('click', () => {
  const name = $('save-name-input').value.trim() || $('save-ip-display').textContent;
  upsertContact(name, $('save-ip-display').textContent, state.callPeerHostname);
  hide('save-overlay');
});

$('btn-save-skip').addEventListener('click', () => hide('save-overlay'));

// ── Hang Up ───────────────────────────────────────────────────────────────────

$('btn-hangup').addEventListener('click', hangUp);

async function hangUp() {
  if (state.pipWindow && !state.pipWindow.closed) state.pipWindow.close();
  if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => {});

  if (state.alwaysOnTop) {
    state.alwaysOnTop = false;
    await appWindow.setAlwaysOnTop(false);
  }

  const hadCall = !!state.pc;
  teardown();

  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  $('local-video').srcObject = null;

  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }

  $('btn-mute-mic').textContent = 'Mute Mic';
  $('btn-mute-mic').classList.remove('muted');
  $('btn-mute-cam').textContent = 'Stop Video';
  $('btn-mute-cam').classList.remove('muted');
  $('btn-on-top').textContent = 'Always on Top: Off';
  $('btn-on-top').classList.remove('active');
  $('btn-popout').textContent = 'Pop Out';
  closeSettings();

  if (hadCall) promptSaveContact();

  showHome();
  resetToListening();
}

function resetToListening() {
  state.mode = 'idle';
  state.callPeerIp       = null;
  state.callPeerName     = null;
  state.callPeerHostname = null;
  setTimeout(startListening, 500);
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
  $('btn-on-top').textContent = state.alwaysOnTop ? 'Always on Top: On' : 'Always on Top: Off';
  $('btn-on-top').classList.toggle('active', state.alwaysOnTop);
});

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-setup').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('settings-overlay')) closeSettings();
});

$('btn-request-access').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    updatePermUI('granted', 'granted');
  } catch (err) {
    updatePermUI(err.name === 'NotAllowedError' ? 'denied' : 'prompt',
                 err.name === 'NotAllowedError' ? 'denied' : 'prompt');
  }
});

async function openSettings() {
  show('settings-overlay');
  await checkPermissions();
}

function closeSettings() {
  hide('settings-overlay');
  document.querySelectorAll('.dev-select-list').forEach((l) => l.classList.add('hidden'));
}

async function checkPermissions() {
  try {
    const [mic, cam] = await Promise.all([
      navigator.permissions.query({ name: 'microphone' }),
      navigator.permissions.query({ name: 'camera' }),
    ]);
    const refresh = () => updatePermUI(mic.state, cam.state);
    mic.onchange = refresh;
    cam.onchange = refresh;
    refresh();
  } catch {
    // Permissions API unsupported — probe via getUserMedia directly
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.getTracks().forEach((t) => t.stop());
      updatePermUI('granted', 'granted');
    } catch (err) {
      updatePermUI(err.name === 'NotAllowedError' ? 'denied' : 'prompt',
                   err.name === 'NotAllowedError' ? 'denied' : 'prompt');
    }
  }
}

function updatePermUI(micState, camState) {
  const label = (s) => s === 'granted' ? 'Allowed' : s === 'denied' ? 'Blocked' : 'Not requested';
  $('perm-mic-status').textContent = label(micState);
  $('perm-mic-status').dataset.state = micState;
  $('perm-cam-status').textContent = label(camState);
  $('perm-cam-status').dataset.state = camState;

  const anyDenied = micState === 'denied' || camState === 'denied';
  const anyPrompt = micState === 'prompt' || camState === 'prompt';
  const allGranted = micState === 'granted' && camState === 'granted';

  $('perm-denied-msg').classList.toggle('hidden', !anyDenied);
  $('btn-request-access').classList.toggle('hidden', !anyPrompt);
  $('devices-section').classList.toggle('hidden', !allGranted);

  if (allGranted) populateDeviceSelectors();
}

// ── Pop-out ───────────────────────────────────────────────────────────────────

$('btn-popout').addEventListener('click', handlePopout);

async function handlePopout() {
  if (state.pipWindow && !state.pipWindow.closed) { state.pipWindow.close(); return; }
  if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }

  const remoteVideo = $('remote-video');

  if ('documentPictureInPicture' in window) {
    try {
      const pip = await window.documentPictureInPicture.requestWindow({ width: 420, height: 320 });
      state.pipWindow = pip;
      $('btn-popout').textContent = 'Close Pop-Out';

      pip.document.head.innerHTML = `<style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#000;height:100vh;display:flex;flex-direction:column;font-family:system-ui,sans-serif}
        .bar{padding:.3rem .6rem;background:rgba(0,0,0,.6);color:rgba(255,255,255,.8);font-size:.75rem}
        video{flex:1;width:100%;object-fit:cover;display:block}
      </style>`;
      const bar = pip.document.createElement('div');
      bar.className = 'bar';
      bar.textContent = 'DoubleChat — Partner';
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
  hide('incoming-overlay');
  show('call-screen');
}

function showHome() {
  hide('call-screen');
  hide('share-panel');
  hide('connect-panel');
  show('setup-screen');
  show('action-btns');
  show('contacts-section');
  hide('join-error');
  $('host-ip-input').value = '';
}

function setStatus(text) {
  $('call-status').textContent = text;
}

function showJoinError(msg) {
  show('connect-panel');
  hide('action-btns');
  hide('contacts-section');
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

/* 탈모모니터링Cam — 카메라폰 ↔ 모니터폰 WebRTC 직접 연결
 * 연결 정보 교환(시그널링)만 PeerJS 공개 중계를 쓰고, 영상·사진은 P2P로 직접 전송한다. */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// 시그널링 서버: 기본은 PeerJS 공개 서버. 테스트용으로 ?sig=host:port 지정 가능
function peerOptions() {
  const o = {
    debug: 1,
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ] },
  };
  const sig = qs.get('sig');
  if (sig) {
    const [host, port] = sig.split(':');
    Object.assign(o, { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:' });
  }
  return o;
}

const ID_PREFIX = 'dcam-';
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const codeOf = (id) => id.slice(ID_PREFIX.length).toUpperCase();
const idOf = (code) => ID_PREFIX + code.trim().toLowerCase();

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(prefix, text, state) {
  $(prefix + 'Status').textContent = text;
  $(prefix + 'Led').className = 'led' + (state ? ' ' + state : '');
}
function flash(el) { el.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('go'))); }
// 이름 규칙: 연월일_시분초 (예: 20261018_160412) — 파일 이름과 사진 속 글씨에 함께 사용
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && mode) keepAwake(); });

let mode = null;          // 'cam' | 'mon'
let peer = null;
let cleanup = [];

function show(id) {
  for (const s of ['home', 'cam', 'mon']) $(s).hidden = s !== id;
}
// 촬영·모니터 화면은 전체화면으로. 브라우저 정책상 화면을 한 번 터치해야 켜짐
function enterFull() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function exitFull() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
document.addEventListener('pointerdown', () => { if (mode) enterFull(); });
function goHome() {
  cleanup.forEach((f) => { try { f(); } catch {} });
  cleanup = [];
  try { peer?.destroy(); } catch {}
  peer = null; mode = null;
  try { wakeLock?.release(); } catch {}
  exitFull();
  history.replaceState(null, '', location.pathname + (qs.get('sig') ? '?sig=' + qs.get('sig') : ''));
  show('home');
}
document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', goHome));

/* ============================ 카메라폰 ============================ */
async function startCamera() {
  mode = 'cam'; show('cam'); keepAwake();
  setStatus('cam', '카메라 켜는 중', '');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    setStatus('cam', '카메라를 쓸 수 없음', 'off');
    toast('카메라 권한을 허용해 주세요. 주소창 왼쪽 자물쇠에서 바꿀 수 있습니다.', 5000);
    return;
  }
  const video = $('camVideo');
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  cleanup.push(() => stream.getTracks().forEach((t) => t.stop()));

  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const torchOK = !!caps.torch;
  let torchOn = false;
  async function setTorch(on) {
    if (!torchOK) return false;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchOn = on; } catch { return false; }
    $('camTorch').classList.toggle('on', torchOn);
    send({ t: 'state', torch: torchOn });
    return true;
  }
  $('camTorch').hidden = !torchOK;
  $('camTorch').onclick = () => setTorch(!torchOn);

  let conn = null, call = null;
  const send = (m) => { try { if (conn?.open) conn.send(m); } catch {} };

  function showPairing(on) {
    $('camPair').hidden = !on;
    $('camShowQr').hidden = on || !conn;
  }
  $('camShowQr').onclick = () => { $('camPair').hidden = !$('camPair').hidden; };

  // 고화질 사진: ImageCapture.takePhoto 우선, 실패하면 영상 프레임 캡처
  async function takePhoto() {
    let blob = null;
    if ('ImageCapture' in window) {
      try {
        const ic = new ImageCapture(track);
        blob = await Promise.race([
          ic.takePhoto(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
      } catch { blob = null; }
      if (torchOn) setTorch(true); // 일부 기기는 촬영 후 플래시가 꺼짐
    }
    if (!blob) {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    }
    return blob;
  }

  async function shoot(fromRemote) {
    flash($('camFlash'));
    send({ t: 'busy' });
    const shotAt = new Date();
    const name = `${stamp(shotAt)}.jpg`;
    const blob = await takePhoto();
    if (!blob) { send({ t: 'error', msg: '촬영 실패' }); return; }
    if (fromRemote && conn?.open) {
      const buf = await blob.arrayBuffer();
      send({ t: 'photo', name, time: shotAt.getTime(), type: blob.type || 'image/jpeg', buf });
    } else {
      saveBlob(await finishPhoto(blob, shotAt), name);
      toast('이 폰에 저장했습니다');
    }
  }
  $('camSelfShot').onclick = () => shoot(false);

  // 고정 ID: 한 번 연결한 모니터폰은 다음에도 같은 링크로 재접속 가능
  let myId = store.get('dc_cam_id') || ID_PREFIX + randCode();
  function openPeer(retry) {
    peer = new Peer(myId, peerOptions());
    peer.on('open', (id) => {
      store.set('dc_cam_id', id);
      const url = `${location.origin}${location.pathname}?join=${codeOf(id)}${qs.get('sig') ? '&sig=' + qs.get('sig') : ''}`;
      drawQR(url);
      $('camCode').textContent = codeOf(id);
      setStatus('cam', '모니터폰 연결 대기', '');
      showPairing(true);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && !retry) {
        // 이전 세션이 아직 서버에 남아있음 → 잠시 후 재시도, 그래도 안 되면 새 코드
        setTimeout(() => { try { peer.destroy(); } catch {} ; openPeer(true); }, 3000);
        return;
      }
      if (e.type === 'unavailable-id') {
        myId = ID_PREFIX + randCode();
        try { peer.destroy(); } catch {}
        openPeer(false);
        return;
      }
      if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        setStatus('cam', '중계 서버 연결 실패 · 재시도 중', 'off');
      }
    });
    peer.on('disconnected', () => { if (mode === 'cam' && peer && !peer.destroyed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500); });
    peer.on('connection', (c) => {
      // 새 모니터가 오면 이전 연결은 정리
      try { conn?.close(); } catch {}
      try { call?.close(); } catch {}
      conn = c;
      c.on('open', () => {
        call = peer.call(c.peer, stream);
        setStatus('cam', '모니터폰 연결됨', 'on');
        showPairing(false);
        send({ t: 'hello', torch: torchOK, torchOn });
      });
      c.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'shoot') shoot(true);
        else if (m.t === 'torch') setTorch(!!m.on);
      });
      const lost = () => {
        if (conn !== c) return;
        conn = null; call = null;
        setStatus('cam', '연결 끊김 · 대기 중', '');
        showPairing(true);
      };
      c.on('close', lost); c.on('error', lost);
    });
  }
  openPeer(false);
}

function drawQR(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  $('qrBox').innerHTML = qr.createImgTag(6, 0);
}

/* ============================ 모니터폰 ============================ */
function startMonitor(code) {
  mode = 'mon'; show('mon'); keepAwake();
  const video = $('monVideo');
  let conn = null, camId = null, retryTimer = null, connected = false;
  let timer = Number(store.get('dc_timer') || 0);
  let torchOn = false, torchOK = false, busy = false;
  const send = (m) => { try { if (conn?.open) conn.send(m); } catch {} };

  const last = store.get('dc_last_cam');
  $('lastCam').hidden = !last;
  $('lastCam').onclick = () => connectTo(last);
  $('codeForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('codeInput').value.replace(/[^a-z0-9]/gi, '');
    if (v.length !== 6) { toast('코드 6자리를 입력하세요'); return; }
    connectTo(v.toUpperCase());
  };

  function setConnected(on) {
    connected = on;
    $('join').hidden = on;
    $('shutter').disabled = !on;
    $('tTorch').disabled = !on || !torchOK;
  }
  setConnected(false);
  setStatus('mon', '대기', '');

  peer = new Peer(peerOptions());
  let peerReady = new Promise((res) => peer.on('open', res));
  peer.on('call', (c) => {
    c.answer();
    c.on('stream', (s) => { video.srcObject = s; video.play().catch(() => {}); });
  });
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') {
      setStatus('mon', '카메라폰을 찾는 중', '');
      scheduleRetry();
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      setStatus('mon', '중계 서버 연결 실패 · 재시도 중', 'off');
      scheduleRetry();
    }
  });
  peer.on('disconnected', () => { if (mode === 'mon' && peer && !peer.destroyed) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 1500); });

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (camId && mode === 'mon') retryTimer = setTimeout(() => connectTo(codeOf(camId)), 3000);
  }
  cleanup.push(() => clearTimeout(retryTimer));

  async function connectTo(c) {
    camId = idOf(c);
    store.set('dc_last_cam', codeOf(camId));
    setStatus('mon', '연결 중', '');
    await peerReady;
    if (mode !== 'mon') return;
    try { conn?.close(); } catch {}
    const cn = peer.connect(camId, { reliable: true, serialization: 'binary' });
    conn = cn;
    cn.on('open', () => {
      clearTimeout(retryTimer);
      setStatus('mon', '연결됨', 'on');
      setConnected(true);
      toast('연결됐습니다');
    });
    cn.on('data', onData);
    const lost = () => {
      if (conn !== cn) return;
      conn = null; busy = false; $('shutter').classList.remove('busy');
      if (connected) toast('연결이 끊겼습니다. 다시 연결하는 중…');
      setConnected(false);
      $('join').hidden = true; // 재연결 중에는 마지막 화면 유지
      $('shutter').disabled = true;
      setStatus('mon', '재연결 중', 'off');
      scheduleRetry();
    };
    cn.on('close', lost); cn.on('error', lost);
  }

  function onData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      torchOK = !!m.torch; torchOn = !!m.torchOn;
      $('tTorch').disabled = !torchOK; $('tTorch').classList.toggle('on', torchOn);
    } else if (m.t === 'state') {
      torchOn = !!m.torch; $('tTorch').classList.toggle('on', torchOn);
    } else if (m.t === 'busy') {
      flash($('monFlash'));
      setStatus('mon', '사진 받는 중', 'on');
    } else if (m.t === 'photo') {
      busy = false; $('shutter').classList.remove('busy');
      setStatus('mon', '연결됨', 'on');
      receivePhoto(m);
    } else if (m.t === 'error') {
      busy = false; $('shutter').classList.remove('busy');
      toast(m.msg || '촬영 실패');
    }
  }

  async function receivePhoto(m) {
    const raw = new Blob([m.buf], { type: m.type || 'image/jpeg' });
    const blob = await finishPhoto(raw, new Date(m.time || Date.now()));
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = url; img.alt = m.name;
    img.onclick = () => openViewer(blob, url, m.name);
    $('strip').prepend(img);
    saveBlob(blob, m.name);
    toast('사진을 저장했습니다 (다운로드 폴더)');
  }

  // 셔터 + 타이머
  const TIMERS = [0, 3, 5, 10];
  const timerLabel = () => (timer ? `타이머 ${timer}초` : '타이머 끔');
  $('tTimerLbl').textContent = timerLabel(); $('tTimer').classList.toggle('on', !!timer);
  $('tTimer').onclick = () => {
    timer = TIMERS[(TIMERS.indexOf(timer) + 1) % TIMERS.length];
    store.set('dc_timer', timer);
    $('tTimerLbl').textContent = timerLabel(); $('tTimer').classList.toggle('on', !!timer);
  };
  let counting = false;
  $('shutter').onclick = async () => {
    if (!connected || busy || counting) return;
    if (timer) {
      counting = true;
      const el = $('count'); el.hidden = false;
      for (let i = timer; i > 0; i--) { el.textContent = i; navigator.vibrate?.(40); await new Promise((r) => setTimeout(r, 1000)); }
      el.hidden = true; counting = false;
      if (!connected) return;
    }
    busy = true; $('shutter').classList.add('busy');
    navigator.vibrate?.(30);
    send({ t: 'shoot' });
    setTimeout(() => { if (busy) { busy = false; $('shutter').classList.remove('busy'); toast('응답이 없습니다. 다시 눌러 주세요'); } }, 20000);
  };
  $('tTorch').onclick = () => send({ t: 'torch', on: !torchOn });

  const guideOn = store.get('dc_guide') === '1';
  $('guide').hidden = !guideOn; $('tGuide').classList.toggle('on', guideOn);
  $('tGuide').onclick = () => {
    const on = $('guide').hidden; $('guide').hidden = !on; $('tGuide').classList.toggle('on', on);
    store.set('dc_guide', on ? '1' : '0');
  };

  cleanup.push(() => { try { conn?.close(); } catch {} ; video.srcObject = null; });
  if (code) connectTo(code);
}

/* ============================ 사진 처리 ============================ */
// 오른쪽 아래에 촬영 일시(연월일_시분초) 새기기. 사진 방향은 폰이 찍은 그대로 유지
async function finishPhoto(blob, date) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const text = stamp(date);
  const fs = Math.max(14, Math.round(Math.min(c.width, c.height) * 0.04));
  const pad = Math.round(fs * 0.6);
  g.font = `700 ${fs}px ui-monospace, "Roboto Mono", monospace`;
  g.textAlign = 'right'; g.textBaseline = 'bottom';
  const x = c.width - pad, y = c.height - pad;
  g.lineJoin = 'round'; g.lineWidth = Math.max(3, fs * 0.18);
  g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, x, y);
  g.fillStyle = '#ffffff'; g.fillText(text, x, y);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
let viewing = null;
function openViewer(blob, url, name) {
  viewing = { blob, name };
  $('viewImg').src = url; $('viewer').hidden = false;
  $('vShare').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'image/jpeg' })] }));
}
$('vClose').onclick = () => { $('viewer').hidden = true; viewing = null; };
$('vSave').onclick = () => { if (viewing) { saveBlob(viewing.blob, viewing.name); toast('저장했습니다'); } };
$('vShare').onclick = async () => {
  if (!viewing) return;
  try { await navigator.share({ files: [new File([viewing.blob], viewing.name, { type: 'image/jpeg' })] }); } catch {}
};

/* ============================ 앱 설치 ============================ */
const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { $('installBtn').hidden = true; $('installHelp').hidden = true; toast('홈 화면에 설치했습니다'); });
$('installBtn').hidden = !!standalone;
$('installBtn').onclick = async () => {
  if (installEvt) {
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    installEvt = null;
  } else {
    $('installHelp').hidden = !$('installHelp').hidden;
  }
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ============================ 시작 ============================ */
$('pickCam').onclick = () => { enterFull(); startCamera(); };
$('pickMon').onclick = () => { enterFull(); startMonitor(null); };
const join = qs.get('join');
if (join && /^[a-z0-9]{6}$/i.test(join)) startMonitor(join.toUpperCase());

window.__dc = { get peer() { return peer; }, get mode() { return mode; } };
})();

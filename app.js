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

// 홈 버튼·다른 앱으로 나가면 카메라와 연결을 끄고 첫 화면으로 (잠깐 가려지는 경우는 무시)
let hideTimer = null;
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.visibilityState === 'hidden' && mode) hideTimer = setTimeout(() => { if (document.visibilityState === 'hidden' && mode) goHome(); }, 800);
});

// 사진에 날짜 넣기: 한 번 정하면 바꿀 때까지 이 폰에 기억 (기본: 넣기)
let stampOn = store.get('dc_stamp') !== '0';
function syncStampButtons() {
  document.querySelectorAll('[data-stamp]').forEach((b) => {
    b.classList.toggle('on', stampOn);
    const l = b.querySelector('span') || b; l.textContent = stampOn ? '날짜 켬' : '날짜 끔';
  });
}
document.querySelectorAll('[data-stamp]').forEach((b) => b.addEventListener('click', () => {
  stampOn = !stampOn; store.set('dc_stamp', stampOn ? '1' : '0'); syncStampButtons();
  toast(stampOn ? '사진에 날짜를 넣습니다' : '사진에 날짜를 넣지 않습니다');
}));
syncStampButtons();

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
// 폰은 손가락을 뗄 때(click/touchend)만 전체화면을 허용함
['click', 'touchend'].forEach((ev) => document.addEventListener(ev, () => { if (mode) enterFull(); }, { passive: true }));
const updateFsBtn = () => document.querySelectorAll('[data-fs]').forEach((b) => (b.hidden = !!document.fullscreenElement || !document.documentElement.requestFullscreen));
document.addEventListener('fullscreenchange', updateFsBtn);
document.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', enterFull));
updateFsBtn();
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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, zoom: true },
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

  // 확대·축소: 카메라가 지원하면 실제 카메라 줌, 아니면 모니터 폰에서 디지털 줌
  const zoomCap = caps.zoom && caps.zoom.max > caps.zoom.min
    ? { min: caps.zoom.min, max: Math.min(caps.zoom.max, caps.zoom.min * 10), step: caps.zoom.step || 0.1 } : null;
  let zoomTimer = null, zoomWant = zoomCap ? (track.getSettings().zoom || zoomCap.min) : 1;
  function setZoom(z) {
    if (!zoomCap) return;
    zoomWant = Math.min(zoomCap.max, Math.max(zoomCap.min, z));
    if (zoomTimer) return; // 너무 잦은 변경은 묶어서 처리
    zoomTimer = setTimeout(async () => {
      zoomTimer = null;
      try { await track.applyConstraints({ advanced: [{ zoom: zoomWant }] }); } catch {}
    }, 60);
  }

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
      // 고화질 사진의 가로·세로 방향이 화면 영상과 다르면 화면 그대로인 영상 프레임을 사용
      if (blob) {
        try {
          const b = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          if ((b.width >= b.height) !== (video.videoWidth >= video.videoHeight)) blob = null;
          b.close();
        } catch {}
      }
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
    const aspect = video.videoWidth / video.videoHeight;
    if (fromRemote && conn?.open) {
      const buf = await blob.arrayBuffer();
      send({ t: 'photo', name, time: shotAt.getTime(), type: blob.type || 'image/jpeg', aspect, buf });
    } else {
      const view = visibleFrac(video.parentElement, video.videoWidth, video.videoHeight, 1);
      saveBlob(await finishPhoto(blob, shotAt, { aspect, ...view }), name);
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
        send({ t: 'hello', torch: torchOK, torchOn, zoom: zoomCap && { ...zoomCap, value: zoomWant } });
      });
      c.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'shoot') shoot(true);
        else if (m.t === 'torch') setTorch(!!m.on);
        else if (m.t === 'zoom') setZoom(Number(m.value));
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
  let zoomHW = null, zoom = 1; // zoomHW: 카메라 줌 범위 (없으면 디지털 줌 1~4배)
  let mirror = store.get('dc_mirror') !== '0'; // 좌우 반전(거울 모드), 기본 켜짐
  let shotView = null; // 셔터를 누른 순간 화면에 보이던 범위

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
      zoomHW = m.zoom || null;
      setupZoom(zoomHW ? zoomHW.value : 1);
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
    const view = shotView || currentView();
    shotView = null;
    const blob = await finishPhoto(raw, new Date(m.time || Date.now()), { aspect: m.aspect, ...view });
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
    shotView = currentView();
    send({ t: 'shoot' });
    setTimeout(() => { if (busy) { busy = false; $('shutter').classList.remove('busy'); toast('응답이 없습니다. 다시 눌러 주세요'); } }, 20000);
  };
  $('tTorch').onclick = () => send({ t: 'torch', on: !torchOn });

  // 확대·축소: 슬라이더 + 두 손가락 벌리기/오므리기
  const zRange = () => (zoomHW ? [zoomHW.min, zoomHW.max] : [1, 4]);
  const zBase = () => (zoomHW ? zoomHW.min : 1);
  function applyZoom(z, fromSlider) {
    const [lo, hi] = zRange();
    zoom = Math.min(hi, Math.max(lo, z));
    const rel = zoom / zBase();
    $('zLbl').textContent = (rel < 10 ? rel.toFixed(1) : Math.round(rel)) + 'x';
    if (!fromSlider) $('zoom').value = zoom;
    updateTransform();
    if (zoomHW) send({ t: 'zoom', value: zoom });
  }
  function setupZoom(start) {
    const [lo, hi] = zRange(), el = $('zoom');
    el.min = lo; el.max = hi; el.step = zoomHW ? (zoomHW.step || 0.1) : 0.05;
    $('zoomBar').hidden = false;
    applyZoom(start);
  }
  $('zoom').oninput = (e) => applyZoom(Number(e.target.value), true);
  $('zReset').onclick = () => applyZoom(zBase());
  const pts = new Map(); let pinch = null;
  const stage = $('monStage');
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2 && connected) pinch = { d: dist(), z: zoom }; });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) applyZoom(pinch.z * (dist() / pinch.d));
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => stage.addEventListener(ev, up));
  cleanup.push(() => { video.style.transform = ''; $('zoomBar').hidden = true; });

  // 좌우 반전: 카메라 폰을 움직이는 방향과 화면이 같은 쪽으로 움직이게 함. 저장 사진에도 똑같이 적용
  function updateTransform() {
    const z = zoomHW ? 1 : zoom;
    video.style.transform = `scale(${mirror ? -z : z}, ${z})`;
  }
  function currentView() {
    return { ...visibleFrac(stage, video.videoWidth, video.videoHeight, zoomHW ? 1 : zoom), mirror };
  }
  $('tMirror').classList.toggle('on', mirror);
  $('tMirror').onclick = () => {
    mirror = !mirror; store.set('dc_mirror', mirror ? '1' : '0');
    $('tMirror').classList.toggle('on', mirror); updateTransform();
  };
  updateTransform();

  const guideOn = store.get('dc_guide') !== '0'; // 기본값: 가이드 켜짐
  $('guide').hidden = !guideOn; $('tGuide').classList.toggle('on', guideOn);
  $('tGuide').onclick = () => {
    const on = $('guide').hidden; $('guide').hidden = !on; $('tGuide').classList.toggle('on', on);
    store.set('dc_guide', on ? '1' : '0');
  };

  cleanup.push(() => { try { conn?.close(); } catch {} ; video.srcObject = null; });
  if (code) connectTo(code);
}

/* ============================ 사진 처리 ============================ */
// 화면(꽉 채우기 + 확대)에 실제로 보이는 비율. fx·fy = 영상 가로·세로 중 화면에 보이는 몫
function visibleFrac(el, vw, vh, z = 1) {
  const r = el.getBoundingClientRect();
  if (!vw || !vh || !r.width || !r.height) return { fx: 1 / z, fy: 1 / z };
  const s = Math.max(r.width / vw, r.height / vh);
  return { fx: Math.min(1, r.width / s / vw) / z, fy: Math.min(1, r.height / s / vh) / z };
}
// 화면에 보이던 범위 그대로 잘라 저장 + 오른쪽 아래에 촬영 일시(연월일 시분초, 프리텐다드)
// opt.aspect: 화면 영상의 가로세로비 (고화질 사진은 화각이 더 넓어서 먼저 영상 비율로 맞춤)
async function finishPhoto(blob, date, opt = {}) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const bw = bmp.width, bh = bmp.height;
  let cw = bw, ch = bh;
  if (opt.aspect > 0) { if (bw / bh > opt.aspect) cw = bh * opt.aspect; else ch = bw / opt.aspect; }
  cw = Math.max(1, Math.round(cw * Math.min(1, opt.fx || 1)));
  ch = Math.max(1, Math.round(ch * Math.min(1, opt.fy || 1)));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  if (opt.mirror) { g.translate(cw, 0); g.scale(-1, 1); }
  g.drawImage(bmp, Math.round((bw - cw) / 2), Math.round((bh - ch) / 2), cw, ch, 0, 0, cw, ch);
  g.setTransform(1, 0, 0, 1, 0, 0);
  bmp.close?.();
  if (!stampOn) return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const text = stamp(date).replace('_', ' '); // 사진 속 표기: 20261018 160412
  const fs = Math.max(14, Math.round(Math.min(c.width, c.height) * 0.04));
  const pad = Math.round(fs * 0.6);
  const font = `700 ${fs}px Pretendard, "Pretendard Variable", sans-serif`;
  try { await document.fonts.load(font, text); } catch {}
  g.font = font;
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

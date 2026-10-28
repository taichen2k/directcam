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

// 중계 서버(TURN): 두 폰 사이 직접 길이 막힌 네트워크에서도 연결되게 함. 주소가 비어 있으면 사용 안 함
// Metered 무료 TURN: https://<앱이름>.metered.live/api/v1/turn/credentials?apiKey=<키>
const TURN_URL = '';
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
let iceCache = null;
async function loadIce() {
  if (!TURN_URL) return STUN;
  if (iceCache) return iceCache;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const list = await fetch(TURN_URL, { signal: ctl.signal, cache: 'no-store' }).then((r) => r.json());
    clearTimeout(t);
    if (Array.isArray(list) && list.length) iceCache = [...STUN, ...list];
  } catch {}
  return iceCache || STUN;
}
loadIce();

// 시그널링 서버: 기본은 PeerJS 공개 서버. 테스트용으로 ?sig=host:port 지정 가능
function peerOptions() {
  const o = {
    debug: 1,
    config: { iceServers: iceCache || STUN },
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
    b.setAttribute('aria-pressed', stampOn ? 'true' : 'false');
  });
}
document.querySelectorAll('[data-stamp]').forEach((b) => b.addEventListener('click', () => {
  stampOn = !stampOn; store.set('dc_stamp', stampOn ? '1' : '0'); syncStampButtons();
  toast(stampOn ? '날짜 표시 켬: 사진에 날짜를 넣습니다' : '날짜 표시 끔: 사진에 날짜를 넣지 않습니다');
}));
syncStampButtons();

let mode = null;          // 'cam' | 'mon'
let peer = null;
let cleanup = [];
let sayBye = null;        // 종료할 때 상대 폰에 알리는 함수
let monSend = null;       // 모니터 폰 → 카메라 폰 메시지 (사진 보관/삭제 결정)

// 화면 속 화면(팝업 플레이어)으로 앱이 계속 도는 것을 막음: 뜨면 바로 종료
['camVideo', 'monVideo'].forEach((id) => {
  const v = $(id);
  v.disablePictureInPicture = true;
  v.addEventListener('enterpictureinpicture', () => {
    try { document.exitPictureInPicture?.().catch(() => {}); } catch {}
    if (mode) goHome();
  });
});
addEventListener('pagehide', () => { if (mode) goHome(); });

function show(id) {
  for (const s of ['home', 'cam', 'mon', 'lib']) $(s).hidden = s !== id;
}
// 촬영·모니터 화면은 전체화면으로. 브라우저 정책상 화면을 한 번 터치해야 켜짐
// 아이폰은 웹 전체화면을 지원하지 않음(홈 화면에 설치하면 전체화면), 아이패드는 webkit 방식
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsReq = (el) => el.requestFullscreen || el.webkitRequestFullscreen;
function enterFull() {
  const el = document.documentElement, req = fsReq(el);
  if (fsEl() || !req) return;
  try { const r = req.call(el, { navigationUI: 'hide' }); r?.catch?.(() => {}); } catch {}
}
function exitFull() {
  if (!fsEl()) return;
  try { const r = (document.exitFullscreen || document.webkitExitFullscreen).call(document); r?.catch?.(() => {}); } catch {}
}
// 전체화면은 쓰지 않음: 폰 아래쪽 홈·뒤로가기 버튼 줄이 항상 보이도록 (전체화면 버튼도 숨김)
const updateFsBtn = () => document.querySelectorAll('[data-fs]').forEach((b) => (b.hidden = true));
document.addEventListener('fullscreenchange', updateFsBtn);
document.addEventListener('webkitfullscreenchange', updateFsBtn);
document.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', enterFull));
updateFsBtn();
// 종료: 상대 폰에도 알려서 둘 다 함께 끝냄
function goHome(msg) {
  try { sayBye?.(); } catch {}
  sayBye = null; monSend = null;
  closeViewer();
  cleanup.forEach((f) => { try { f(); } catch {} });
  cleanup = [];
  const p = peer;
  setTimeout(() => { try { p?.destroy(); } catch {} }, 400); // 종료 알림이 상대에게 전달될 시간
  peer = null; mode = null;
  if (typeof msg === 'string') setTimeout(() => toast(msg, 3500), 50);
  try { wakeLock?.release(); } catch {}
  exitFull();
  history.replaceState(history.state, '', location.pathname + (qs.get('sig') ? '?sig=' + qs.get('sig') : ''));
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
      video: { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 4032 }, height: { ideal: 3024 }, frameRate: { ideal: 30 }, zoom: true },
    });
  } catch (e) {
    setStatus('cam', '카메라를 쓸 수 없음', 'off');
    toast('카메라 권한을 허용해 주세요. 주소창 왼쪽 자물쇠에서 바꿀 수 있습니다.', 5000);
    return;
  }
  await loadIce();
  if (mode !== 'cam') { stream.getTracks().forEach((t) => t.stop()); return; }
  const video = $('camVideo');
  video.srcObject = stream; video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  cleanup.push(() => stream.getTracks().forEach((t) => t.stop()));

  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const torchOK = !!caps.torch;
  // 플래시: 켜 두면 사진 찍는 순간에만 잠깐 켜짐 (torchOn = 플래시 사용 설정)
  let torchOn = false;
  async function light(on) {
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }
  function setTorch(on) {
    if (!torchOK) return false;
    torchOn = on;
    $('camTorch').classList.toggle('on', torchOn);
    send({ t: 'state', torch: torchOn });
    return true;
  }
  $('camTorch').hidden = !torchOK;
  $('camTorch').onclick = () => { setTorch(!torchOn); toast(torchOn ? '플래시 켬: 찍을 때만 잠깐 켜집니다' : '플래시 끔'); };

  // 접사: 카메라가 허용하면 초점을 가장 가까운 거리로 고정 (웹에서는 접사 렌즈 자체를 고를 수 없음)
  const fModes = caps.focusMode || [];
  const macroOK = !!(caps.focusDistance && fModes.includes('manual'));
  let macroOn = false;
  async function setMacro(on) {
    if (!macroOK) return;
    try {
      if (on) await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: caps.focusDistance.min }] });
      else await track.applyConstraints({ advanced: [{ focusMode: fModes.includes('continuous') ? 'continuous' : fModes[0] }] });
      macroOn = on;
    } catch {}
    send({ t: 'state', macro: macroOn });
  }

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
  sayBye = () => send({ t: 'bye' });

  function showPairing(on) {
    $('camPair').hidden = !on;
    $('camShowQr').hidden = on || !conn;
  }
  $('camShowQr').onclick = () => { $('camPair').hidden = !$('camPair').hidden; };

  // 초점: 화면 가운데에 맞춤. 셔터를 누르면 가운데로 한 번 더 맞춘 뒤 촬영
  async function centerFocus(mode) {
    try { await track.applyConstraints({ advanced: [{ focusMode: mode, pointsOfInterest: [{ x: 0.5, y: 0.5 }] }] }); }
    catch { try { await track.applyConstraints({ advanced: [{ focusMode: mode }] }); } catch {} }
  }
  if (fModes.includes('continuous')) centerFocus('continuous');
  // 모니터 폰에서 가운데 빨간 점을 누르면 가운데로 초점을 다시 맞춤 (접사 중이면 접사를 끄고 자동 초점으로)
  async function refocus() {
    if (macroOn) await setMacro(false);
    let done = false;
    // 이미 맞았다고 보고 렌즈가 안 움직이는 경우가 있어, 초점을 먼 곳으로 한 번 풀었다가 다시 가운데로 잡게 함
    const fd = caps.focusDistance;
    if (fModes.includes('manual') && fd) {
      const far = Number.isFinite(fd.max) ? fd.max : fd.min * 20;
      try { await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: far }] }); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    if (fModes.includes('single-shot')) {
      await centerFocus('single-shot'); done = true;
      setTimeout(() => { if (!macroOn && fModes.includes('continuous')) centerFocus('continuous'); }, 1500);
    } else if (fModes.includes('continuous')) {
      await centerFocus('continuous'); done = true;
    }
    // 결과를 모니터 폰에 알려 줌 (이 카메라가 웹에서 초점 조절을 허용하는지 확인용)
    send({ t: 'focused', ok: done, modes: fModes.join(', ') });
  }

  // 사진 = 모니터에 보내는 바로 그 영상 화면 (화각·확대·방향이 모니터 화면과 똑같음)
  async function takePhoto() {
    if (!video.videoWidth) return null;
    const refocus = !macroOn && fModes.includes('single-shot');
    const useFlash = torchOn && torchOK;
    if (useFlash) await light(true);
    if (refocus) await centerFocus('single-shot');
    if (refocus || useFlash) await new Promise((r) => setTimeout(r, useFlash ? 900 : 700)); // 초점·밝기가 자리 잡을 시간
    // 손떨림 대비: 약 0.8초 동안 화면 8장을 잡아 가운데가 가장 선명한 한 장을 고름
    const grab = async () => {
      try { return await createImageBitmap(video); } catch {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        return createImageBitmap(c);
      }
    };
    let best = null, bestScore = -1;
    for (let i = 0; i < 8; i++) {
      const b = await grab();
      const s = sharpness(b);
      if (s > bestScore) { best?.close?.(); best = b; bestScore = s; } else b.close?.();
      await new Promise((r) => setTimeout(r, 100));
    }
    if (useFlash) light(false);
    if (refocus && fModes.includes('continuous')) centerFocus('continuous');
    return best;
  }
  // 가운데 영역의 선명도 점수 (밝기 변화가 큰 테두리가 많을수록 선명)
  const sc = document.createElement('canvas'); sc.width = sc.height = 256;
  const sg = sc.getContext('2d', { willReadFrequently: true });
  function sharpness(b) {
    const s = Math.min(b.width, b.height) * 0.5;
    sg.drawImage(b, (b.width - s) / 2, (b.height - s) / 2, s, s, 0, 0, 256, 256);
    const d = sg.getImageData(0, 0, 256, 256).data, W = 256;
    const L = new Float32Array(W * W);
    for (let i = 0; i < W * W; i++) L[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    let sum = 0, sq = 0, n = 0;
    for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W];
      sum += v; sq += v * v; n++;
    }
    return sq / n - (sum / n) ** 2;
  }

  // 카메라 폰에는 항상 자동 저장. 모니터 폰에서 찍으면 모니터 화면 설정(확대·좌우 반전·날짜 표시)대로 만들고 사진을 보냄
  const shots = []; // 이번에 찍은 사진 (브라우저가 저장을 묻느라 저장이 안 됐을 때 종료 후 다시 저장하도록)
  async function shoot(opt) {
    flash($('camFlash'));
    send({ t: 'busy' });
    const shotAt = new Date();
    const name = `${stamp(shotAt)}.jpg`;
    const raw = await takePhoto();
    if (!raw) { send({ t: 'error', msg: '촬영 실패' }); return; }
    const photo = await finishPhoto(raw, shotAt, {
      aspect: video.videoWidth / video.videoHeight, fx: Number(opt?.fx) || 1, fy: Number(opt?.fy) || 1,
      mirror: !!opt?.mirror, stamp: opt && 'stamp' in opt ? !!opt.stamp : stampOn,
    });
    shots.push({ photo, name });
    libAdd(photo, name, shotAt.getTime());
    if (IOS) toast(`사진 ${shots.length}장 보관 중 · 끝나면 사진 앱에 저장`, 2500); // 아이폰은 버튼을 눌러야만 저장 가능
    else { saveBlob(photo, name); toast('사진을 저장했습니다'); }
    if (opt && conn?.open) send({ t: 'photo', name, type: 'image/jpeg', later: IOS, buf: await photo.arrayBuffer() });
  }
  cleanup.push(() => { if (shots.length) setTimeout(() => openSaveSheet(shots.slice()), 150); });
  $('camSelfShot').onclick = () => shoot(null);

  // 모니터 화면을 선명하게: 화질(해상도)을 낮추지 말고 데이터를 넉넉히 써서 보내도록 (같은 와이파이라 데이터 요금 없음)
  try { track.contentHint = 'detail'; } catch {}
  function sharpStream(cl) {
    const pc = cl?.peerConnection; if (!pc) return;
    const tune = async () => {
      const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video'); if (!s) return;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 4000000;
        p.degradationPreference = 'balanced'; // 해상도만 고집하면 사진 전송이 느려져서 균형 모드
        await s.setParameters(p);
      } catch {}
    };
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') tune(); });
    tune();
  }

  // 고정 ID: 한 번 연결한 모니터폰은 다음에도 같은 링크로 재접속 가능
  let myId = store.get('dc_cam_id') || ID_PREFIX + randCode();
  function openPeer(retry) {
    peer = new Peer(myId, peerOptions());
    peer.on('open', (id) => {
      store.set('dc_cam_id', id);
      const url = `${location.origin}${location.pathname}?join=${codeOf(id)}${qs.get('sig') ? '&sig=' + qs.get('sig') : ''}`;
      drawQR(url);
      $('camCode').textContent = codeOf(id);
      setStatus('cam', '모니터 폰 연결 대기', '');
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
        sharpStream(call);
        setStatus('cam', '모니터 폰 연결됨', 'on');
        showPairing(false);
        send({ t: 'hello', torch: torchOK, torchOn, macro: macroOK, macroOn, zoom: zoomCap && { ...zoomCap, value: zoomWant } });
      });
      c.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'bye') { goHome('모니터 폰이 종료되어 함께 종료했습니다'); return; }
        if (m.t === 'shoot') shoot({ fx: m.fx, fy: m.fy, mirror: m.mirror, stamp: m.stamp });
        else if (m.t === 'torch') setTorch(!!m.on);
        else if (m.t === 'macro') setMacro(!!m.on);
        else if (m.t === 'focus') refocus();
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
async function startMonitor(code) {
  mode = 'mon'; show('mon'); keepAwake();
  setStatus('mon', '준비 중', '');
  // 같은 와이파이·핫스팟에서 직접 연결되도록: 카메라 권한이 있어야 브라우저가 이 폰의 내부 주소를 상대에게 알려 줌
  // (권한이 없으면 주소를 가려서 보내는데, 일부 폰·브라우저 조합에서는 상대가 그 주소를 못 알아봐 연결이 안 됨)
  try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); } catch {}
  await loadIce();
  if (mode !== 'mon') return;
  const video = $('monVideo');
  let conn = null, camId = null, retryTimer = null, connected = false;
  let timer = Number(store.get('dc_timer') || 0);
  let torchOn = false, torchOK = false, busy = false;
  const send = (m) => { try { if (conn?.open) conn.send(m); } catch {} };
  sayBye = () => send({ t: 'bye' });
  let zoomHW = null, zoom = 1; // zoomHW: 카메라 줌 범위 (없으면 디지털 줌 1~4배)
  let mirror = store.get('dc_mirror') !== '0'; // 좌우 반전(거울 모드), 기본 켜짐
  let autoSave = store.get('dc_autosave') !== '0'; // 자동 저장, 기본 켜짐
  $('tAuto').classList.toggle('on', autoSave);
  $('tAuto').onclick = () => {
    autoSave = !autoSave; store.set('dc_autosave', autoSave ? '1' : '0'); $('tAuto').classList.toggle('on', autoSave);
    toast(autoSave ? '자동 저장 켬: 모니터 폰에도 바로 저장합니다' : '자동 저장 끔: 찍을 때마다 이 폰에 저장할지 묻습니다', 3000);
  };

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
    $('focusDot').hidden = !on;
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
      setStatus('mon', '카메라 폰을 찾는 중', '');
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
    const slow = setTimeout(() => { if (mode === 'mon' && !peer?.open) setStatus('mon', '중계 서버 연결 안 됨 · 인터넷 확인', 'off'); }, 10000);
    await peerReady;
    clearTimeout(slow);
    if (mode !== 'mon') return;
    try { conn?.close(); } catch {}
    const cn = peer.connect(camId, { reliable: true, serialization: 'binary' });
    conn = cn;
    // 카메라 폰은 찾았는데 15초 안에 직접 연결이 안 되면: 두 폰이 서로 닿지 않는 네트워크(다른 와이파이·LTE·손님용 와이파이 등)
    setTimeout(() => {
      if (conn !== cn || cn.open || mode !== 'mon') return;
      setStatus('mon', '직접 연결 안 됨 · 네트워크 확인', 'off');
      iceReport(cn).then((r) => { $('netDiag').textContent = r.trim(); $('netHelp').hidden = false; });
      scheduleRetry();
    }, 15000);
    cn.on('open', () => {
      clearTimeout(retryTimer);
      setStatus('mon', '연결됨', 'on');
      setConnected(true);
      toast('연결됐습니다');
    });
    cn.on('data', onData);
    const lost = () => {
      if (conn !== cn || mode !== 'mon') return; // 이미 종료한 뒤에는 재연결 안내를 띄우지 않음
      conn = null; busy = false; $('shutter').classList.remove('busy');
      if (connected) toast('연결이 끊겼습니다. 다시 연결하는 중…');
      setConnected(false);
      $('join').hidden = true; // 재연결 중에는 마지막 화면 유지
      $('shutter').disabled = true; $('focusDot').hidden = true;
      setStatus('mon', '재연결 중', 'off');
      scheduleRetry();
    };
    cn.on('close', lost); cn.on('error', lost);
  }

  // 연결 실패 원인 확인용: 양쪽이 주고받은 주소 종류 (내부 주소/가린 주소/외부 주소)
  async function iceReport(cn) {
    try {
      const st = await cn.peerConnection.getStats();
      const kind = (c) => (c.candidateType === 'host' ? ((c.address || c.ip || '').endsWith('.local') ? '가림' : '내부') : c.candidateType === 'srflx' ? '외부' : c.candidateType);
      const L = new Set(), R = new Set(), LN = new Set(), RN = new Set(); let pairs = 0, ok = 0;
      // 내부 주소의 앞 3자리(예: 192.168.0)만 비교: 같으면 같은 와이파이 망
      const net = (c) => { const a = c.address || c.ip || ''; return c.candidateType === 'host' && /^\d+\.\d+\.\d+\.\d+$/.test(a) ? a.split('.').slice(0, 3).join('.') : null; };
      st.forEach((x) => {
        if (x.type === 'local-candidate') { L.add(kind(x)); const n = net(x); if (n) LN.add(n); }
        if (x.type === 'remote-candidate') { R.add(kind(x)); const n = net(x); if (n) RN.add(n); }
        if (x.type === 'candidate-pair') { pairs++; if (x.state === 'succeeded') ok++; }
      });
      const same = [...LN].some((n) => RN.has(n));
      const nets = LN.size && RN.size ? ` / 망 ${[...LN].join(',')} ↔ ${[...RN].join(',')} ${same ? '같음' : '다름'}` : '';
      return ` (진단: 이 폰 ${[...L].join('·') || '없음'} / 카메라 폰 ${[...R].join('·') || '없음'} / 시도 ${pairs} 성공 ${ok}${nets})`;
    } catch { return ''; }
  }

  function onData(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'bye') { goHome('카메라 폰이 종료되어 함께 종료했습니다'); return; }
    if (m.t === 'hello') {
      torchOK = !!m.torch; torchOn = !!m.torchOn;
      $('tTorch').disabled = !torchOK; $('tTorch').classList.toggle('on', torchOn);
      zoomHW = m.zoom || null;
      setupZoom(zoomHW ? zoomHW.value : 1);
      $('tMacro').hidden = !m.macro; macroOn = !!m.macroOn; $('tMacro').classList.toggle('on', macroOn);
    } else if (m.t === 'state') {
      if ('torch' in m) { torchOn = !!m.torch; $('tTorch').classList.toggle('on', torchOn); }
      if ('macro' in m) { macroOn = !!m.macro; $('tMacro').classList.toggle('on', macroOn); }
    } else if (m.t === 'focused') {
      toast(m.ok ? '가운데로 초점을 다시 맞췄습니다' : `이 카메라 폰은 브라우저에서 초점 조절을 허용하지 않습니다${m.modes ? ' (' + m.modes + ')' : ''}`, 3000);
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

  const monShots = []; // 아이폰·아이패드 모니터: 자동 저장 사진을 모아 두었다가 끝날 때 한 번에 저장
  cleanup.push(() => { if (monShots.length) setTimeout(() => openSaveSheet(monShots.splice(0), 'mon'), 150); });
  function receivePhoto(m) {
    const blob = new Blob([m.buf], { type: m.type || 'image/jpeg' });
    const libP = libAdd(blob, m.name, dateFromName(m.name));
    libP.then(() => ghostRefresh());
    const camMsg = m.later ? '카메라 폰에 보관했습니다 (끝나면 저장)' : '카메라 폰에 저장했습니다';
    if (autoSave && IOS) { monShots.push({ photo: blob, name: m.name }); peekPhoto(blob); toast(`이 폰에 ${monShots.length}장 보관 중 · 끝나면 사진 앱에 저장`, 2500); }
    else if (autoSave) { saveBlob(blob, m.name); peekPhoto(blob); toast(m.later ? '이 폰에 저장했습니다 (카메라 폰은 끝나면 저장)' : '두 폰 모두 저장했습니다'); }
    else { openViewer(blob, m.name, libP); toast(camMsg); }
  }
  monSend = send;

  // 셔터 + 타이머
  const TIMERS = [0, 3, 5, 10];
  const timerLabel = () => (timer ? `타이머 ${timer}초` : '타이머 끔');
  $('tTimerLbl').textContent = timerLabel(); $('tTimer').classList.toggle('on', !!timer);
  $('tTimer').onclick = () => {
    timer = TIMERS[(TIMERS.indexOf(timer) + 1) % TIMERS.length];
    store.set('dc_timer', timer);
    $('tTimerLbl').textContent = timerLabel(); $('tTimer').classList.toggle('on', !!timer);
  };
  let counting = false, checkedOnce = false;
  // 촬영 전 체크리스트: 연결 후 첫 촬영 때 한 번 확인 (건너뛰기 가능)
  $('shutter').onclick = () => {
    if (!connected || busy || counting) return;
    if (!checkedOnce) { openCheck(); return; }
    doShoot();
  };
  function openCheck() {
    document.querySelectorAll('#checkSheet .ck').forEach((c) => { c.checked = false; });
    $('ckGo').disabled = true; $('checkSheet').hidden = false;
  }
  document.querySelectorAll('#checkSheet .ck').forEach((c) => { c.onchange = () => { $('ckGo').disabled = ![...document.querySelectorAll('#checkSheet .ck')].every((x) => x.checked); }; });
  $('ckGo').onclick = () => { checkedOnce = true; $('checkSheet').hidden = true; doShoot(); };
  $('ckSkip').onclick = () => { checkedOnce = true; $('checkSheet').hidden = true; doShoot(); };
  cleanup.push(() => { $('checkSheet').hidden = true; });
  const doShoot = async () => {
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
    send({ t: 'shoot', ...viewFrac(), mirror, stamp: stampOn });
    setTimeout(() => { if (busy) { busy = false; $('shutter').classList.remove('busy'); toast('응답이 없습니다. 다시 눌러 주세요'); } }, 20000);
  };
  $('tTorch').onclick = () => { send({ t: 'torch', on: !torchOn }); toast(!torchOn ? '플래시 켬: 찍을 때만 잠깐 켜집니다' : '플래시 끔'); };
  // 가운데 빨간 점: 누르면 카메라 폰이 가운데로 초점을 다시 맞춤
  $('focusDot').addEventListener('pointerdown', (e) => e.stopPropagation());
  $('focusDot').onclick = () => {
    if (!connected) return;
    send({ t: 'focus' }); navigator.vibrate?.(15);
    const d = $('focusDot'); d.classList.remove('ping'); void d.offsetWidth; d.classList.add('ping');
    toast('가운데로 초점을 다시 맞춥니다', 1500);
  };
  let macroOn = false;
  $('tMacro').onclick = () => { send({ t: 'macro', on: !macroOn }); toast(!macroOn ? '접사 켬: 가까운 거리에 초점을 맞춥니다' : '접사 끔: 자동 초점'); };

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

  // 지금 화면에 보이는 영상의 몫 (자르지 않고 전체 표시 + 디지털 확대일 때 가운데 부분)
  function viewFrac() {
    const z = zoomHW ? 1 : zoom, r = stage.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !r.width || z <= 1) return { fx: 1 / z, fy: 1 / z };
    const s = Math.min(r.width / vw, r.height / vh) * z;
    return { fx: Math.min(1, r.width / (vw * s)), fy: Math.min(1, r.height / (vh * s)) };
  }
  // 좌우 반전: 카메라 폰을 움직이는 방향과 화면이 같은 쪽으로 움직이게 함. 저장 사진에도 똑같이 적용
  function updateTransform() {
    const z = zoomHW ? 1 : zoom;
    video.style.transform = `scale(${mirror ? -z : z}, ${z})`;
  }
  $('tMirror').classList.toggle('on', mirror);
  $('tMirror').onclick = () => {
    mirror = !mirror; store.set('dc_mirror', mirror ? '1' : '0');
    $('tMirror').classList.toggle('on', mirror); updateTransform();
  };
  updateTransform();

  // 겹쳐보기: 기준 사진(첫 사진·직전 사진·직접 고른 사진)을 반투명하게 겹쳐 같은 위치·거리로 맞춤
  let ghostOn = store.get('dc_ghost') === '1';
  let ghostRef = store.get('dc_ghost_ref') || 'first';
  let ghostAlpha = Number(store.get('dc_ghost_a') || 35);
  let refBright = null, ghostUrl = null;
  async function ghostRefresh() {
    const list = await LIB.all().catch(() => []);
    if (mode !== 'mon') return;
    const p = ghostRef === 'first' ? list[0] : ghostRef === 'last' ? list[list.length - 1] : (list.find((x) => String(x.id) === ghostRef) || list[0]);
    if (ghostUrl) { URL.revokeObjectURL(ghostUrl); ghostUrl = null; }
    if (p) { ghostUrl = URL.createObjectURL(p.blob); $('ghost').src = ghostUrl; refBright = p.bright ?? null; }
    else { $('ghost').removeAttribute('src'); refBright = null; }
    const kind = ghostRef === 'first' ? '첫 사진' : ghostRef === 'last' ? '직전' : '';
    $('gRef').textContent = p ? `기준 ▾ ${kind} ${fmtDate(p.date, true)}`.replace('  ', ' ') : '기준 사진 없음';
    applyGhost();
  }
  function applyGhost() {
    $('ghost').hidden = !(ghostOn && $('ghost').getAttribute('src'));
    $('ghostBar').hidden = !ghostOn;
    $('ghost').style.opacity = ghostAlpha / 100;
    $('tGhost').classList.toggle('on', ghostOn);
    $('gAlpha').value = ghostAlpha; $('gPct').textContent = ghostAlpha + '%';
  }
  $('tGhost').onclick = async () => {
    ghostOn = !ghostOn; store.set('dc_ghost', ghostOn ? '1' : '0');
    await ghostRefresh();
    if (ghostOn && !$('ghost').getAttribute('src')) toast('아직 앱에 저장된 사진이 없습니다. 한 장 찍으면 다음부터 겹쳐 볼 수 있습니다', 3500);
  };
  $('gAlpha').oninput = (e) => { ghostAlpha = Number(e.target.value); store.set('dc_ghost_a', ghostAlpha); applyGhost(); };
  $('gRef').onclick = async () => {
    const list = await LIB.all().catch(() => []);
    const box = $('refThumbs'); box.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src)); box.innerHTML = '';
    list.slice().reverse().forEach((p) => {
      const b = document.createElement('button'); b.className = 'pick' + (String(p.id) === ghostRef ? ' on' : '');
      const i = document.createElement('img'); i.src = URL.createObjectURL(p.thumb || p.blob); i.alt = p.name;
      const s = document.createElement('span'); s.textContent = fmtDate(p.date, true);
      b.append(i, s); b.onclick = () => setRef(String(p.id)); box.appendChild(b);
    });
    $('refFirst').classList.toggle('on', ghostRef === 'first'); $('refLast').classList.toggle('on', ghostRef === 'last');
    $('refSheet').hidden = false;
  };
  const setRef = (r) => { ghostRef = r; store.set('dc_ghost_ref', r); closeRefSheet(); ghostRefresh(); };
  $('refFirst').onclick = () => setRef('first');
  $('refLast').onclick = () => setRef('last');
  $('refClose').onclick = closeRefSheet;
  ghostRefresh();
  cleanup.push(() => {
    closeRefSheet(); $('ghost').hidden = true; $('ghostBar').hidden = true; $('ghost').removeAttribute('src');
    if (ghostUrl) URL.revokeObjectURL(ghostUrl); ghostUrl = null;
  });

  // 밝기 경고: 1초마다 화면 가운데 밝기를 재서 너무 어둡거나(조명 부족) 너무 밝으면(직사광선) 안내
  const lc = document.createElement('canvas'); lc.width = lc.height = 48;
  const lg = lc.getContext('2d', { willReadFrequently: true });
  const lightTimer = setInterval(() => {
    const tip = $('lightTip');
    if (!connected || !video.videoWidth) { tip.hidden = true; return; }
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(vw, vh) * 0.6;
    try { lg.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, 48, 48); } catch { return; }
    const { mean, clip } = lumaOf(lg, 0, 0, 48, 48);
    let msg = '', info = false;
    if (mean < 40) msg = '어두워요 · 조명을 확인하세요';
    else if (clip > 0.25 || mean > 215) msg = '너무 밝아요 · 직사광선을 피하세요';
    else if (ghostOn && refBright != null && Math.abs(mean - refBright) > 35) { msg = mean > refBright ? '기준 사진보다 밝아요 · 조명을 맞춰 보세요' : '기준 사진보다 어두워요 · 조명을 맞춰 보세요'; info = true; }
    tip.textContent = msg; tip.classList.toggle('info', info); tip.hidden = !msg;
  }, 1000);
  cleanup.push(() => { clearInterval(lightTimer); $('lightTip').hidden = true; });

  const guideOn = store.get('dc_guide') !== '0'; // 기본값: 가이드 켜짐
  $('guide').hidden = !guideOn; $('tGuide').classList.toggle('on', guideOn);
  $('tGuide').onclick = () => {
    const on = $('guide').hidden; $('guide').hidden = !on; $('tGuide').classList.toggle('on', on);
    store.set('dc_guide', on ? '1' : '0');
  };

  cleanup.push(() => { video.srcObject = null; }); // 연결은 goHome에서 종료 알림 후 닫음
  if (code) connectTo(code);
}

/* ============================ 사진 처리 ============================ */
// 화면에 보이는 그대로 저장 + 오른쪽 아래에 촬영 일시(연월일 시분초, 프리텐다드)
// 화면은 카메라 영상 전체를 자르지 않고 보여줌. opt.aspect: 영상 비율(사진과 다를 때만 맞춤), fx·fy: 확대 배율만큼의 가운데 몫
async function finishPhoto(src, date, opt = {}) {
  const bmp = src instanceof Blob ? await createImageBitmap(src, { imageOrientation: 'from-image' }) : src;
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
  if (!(opt.stamp ?? stampOn)) return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
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
// 아이폰·아이패드: 공유 창의 「이미지 저장」으로 사진 앱에 저장 (버튼을 누를 때만 가능)
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function saveToPhotos(list) {
  const files = list.map((s) => new File([s.photo], s.name, { type: 'image/jpeg' }));
  if (IOS && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return true; }
    catch (e) { return e?.name === 'AbortError' ? false : saveEach(list); }
  }
  return saveEach(list);
}
async function saveEach(list) {
  for (const s of list) { saveBlob(s.photo, s.name); if (list.length > 1) await new Promise((r) => setTimeout(r, 350)); }
  return true;
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
// 자동 저장 끔일 때 모니터 폰에서 묻는 창: 이 폰에 저장 / 삭제 / 닫기 (카메라 폰에는 이미 저장됨). 화면에 남기지 않음
let viewing = null;
function openViewer(blob, name, libP) {
  closeViewer();
  const url = URL.createObjectURL(blob);
  viewing = { blob, name, url, libP };
  $('viewImg').src = url; $('viewer').hidden = false;
}
function closeViewer() {
  if (!viewing) return;
  $('viewer').hidden = true; $('viewImg').removeAttribute('src');
  URL.revokeObjectURL(viewing.url); viewing = null;
}
$('vClose').onclick = () => closeViewer();
$('vDelete').onclick = () => {
  if (!viewing) return;
  viewing.libP?.then((id) => { if (id) LIB.del(id).catch(() => {}); });
  closeViewer(); toast('이 폰에서는 지웠습니다');
};
$('vSave').onclick = async () => {
  if (!viewing) return;
  const v = viewing;
  if (await saveToPhotos([{ photo: v.blob, name: v.name }])) { if (viewing === v) closeViewer(); toast('이 폰에도 저장했습니다'); }
};

// 자동 저장 켬일 때: 찍힌 사진을 잠깐 작게 보여주고 사라짐
let peekTimer = null;
function peekPhoto(blob) {
  const img = $('peek'); clearTimeout(peekTimer);
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob); img.hidden = false;
  peekTimer = setTimeout(() => { img.hidden = true; URL.revokeObjectURL(img.src); img.removeAttribute('src'); }, 2000);
}

// 카메라 폰: 촬영이 끝나면 이번에 찍은 사진을 보여주고 한 번에 다시 저장할 수 있게 함
let sheetShots = [];
function openSaveSheet(list, who) {
  sheetShots = list;
  $('sheetCount').textContent = list.length;
  $('sheetMsg').textContent = IOS
    ? '아직 저장되지 않았습니다. 「모두 저장」을 누른 뒤 「이미지 저장」을 고르면 사진 앱에 저장됩니다.'
    : who === 'mon' ? '「모두 저장」을 눌러 이 폰에 저장하세요.'
    : '카메라 폰에 자동으로 저장했습니다. 브라우저 설정 때문에 저장되지 않았다면 「모두 저장」을 눌러 주세요.';
  const box = $('sheetThumbs'); box.innerHTML = '';
  list.slice(-12).forEach((s) => { const i = document.createElement('img'); i.src = URL.createObjectURL(s.photo); i.alt = s.name; box.appendChild(i); });
  $('saveSheet').hidden = false;
}
function closeSaveSheet() {
  $('sheetThumbs').querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  $('sheetThumbs').innerHTML = ''; sheetShots = []; $('saveSheet').hidden = true;
}
$('sheetSave').onclick = async () => {
  const n = sheetShots.length;
  if (await saveToPhotos(sheetShots)) { toast(`${n}장을 저장했습니다`); closeSaveSheet(); }
};
$('sheetClose').onclick = closeSaveSheet;
// 직접 연결이 안 될 때 안내 창 (크롬은 폰 설정에서 '주변 기기' 권한이 있어야 같은 와이파이의 다른 폰과 연결됨)
$('netClose').onclick = () => { $('netHelp').hidden = true; };

/* ============================ 앱 안 사진첩 (겹쳐보기·비교용) ============================ */
// 웹앱은 갤러리를 읽을 수 없어서, 찍은 사진을 이 폰의 앱 저장 공간(IndexedDB)에도 보관
const LIB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('jeongsuricam', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('photos', mode); const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req && req.result); t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    put: (o) => run('readwrite', (s) => s.put(o)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
    all: async () => ((await run('readonly', (s) => s.getAll())) || []).sort((a, b) => a.date - b.date),
  };
})();
const DAY = 86400000;
const p2 = (n) => String(n).padStart(2, '0');
function fmtDate(ms, short) {
  const d = new Date(ms);
  return short ? `${p2(d.getMonth() + 1)}.${p2(d.getDate())}` : `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
// 파일 이름(20261018_160412.jpg)에서 촬영 일시를 읽음. 없으면 파일 날짜
function dateFromName(n, fallback) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(n || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : (fallback || Date.now());
}
// 사진 오른쪽 아래에 앱이 찍어 넣은 "20261018 160412" 글자를 읽어 촬영 일시로 씀
// (같은 글꼴로 숫자 모양을 그려 놓고 한 글자씩 맞춰 보는 방식, 인터넷 없이 폰 안에서 처리)
async function dateFromStamp(blob) {
  const FONT = (px) => `700 ${px}px Pretendard, "Pretendard Variable", sans-serif`;
  try { await document.fonts.load(FONT(28), '0123456789'); } catch {}
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const fs0 = Math.max(14, Math.round(Math.min(W, H) * 0.04)), pad0 = Math.round(fs0 * 0.6);
  const N = 28, k = N / fs0;
  const sw = fs0 * 11, sh = pad0 + fs0 * 1.7;
  const cw = Math.round(sw * k), ch = Math.round(sh * k);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, W - sw, H - sh, sw, sh, 0, 0, cw, ch); bmp.close?.();
  const L = lumaArr(g.getImageData(0, 0, cw, ch).data);
  let best = null;
  for (const s of [0.9, 0.95, 1, 1.05, 1.1]) {
    const F = N * s, lw = Math.max(3 * k, F * 0.18), padK = pad0 * k * s;
    const tpl = [];
    const m = document.createElement('canvas').getContext('2d'); m.font = FONT(F);
    for (let d = 0; d < 10; d++) {
      const adv = m.measureText(String(d)).width;
      const tw = Math.ceil(adv + lw + 2), th = ch;
      const t = document.createElement('canvas'); t.width = tw; t.height = th;
      const tg = t.getContext('2d', { willReadFrequently: true });
      const draw = (bg) => {
        tg.clearRect(0, 0, tw, th);
        if (bg) { tg.fillStyle = bg; tg.fillRect(0, 0, tw, th); }
        tg.font = FONT(F); tg.textAlign = 'left'; tg.textBaseline = 'bottom'; tg.lineJoin = 'round'; tg.lineWidth = lw;
        tg.strokeStyle = 'rgba(0,0,0,0.75)'; tg.strokeText(String(d), lw / 2 + 1, th - padK);
        tg.fillStyle = '#fff'; tg.fillText(String(d), lw / 2 + 1, th - padK);
        return tg.getImageData(0, 0, tw, th).data;
      };
      const a = draw(null), v = draw('#808080');
      const px = [];
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const i = (y * tw + x) * 4;
        if (a[i + 3] > 80) px.push(x, y, v[i] * 0.3 + v[i + 1] * 0.59 + v[i + 2] * 0.11);
      }
      let mu = 0; for (let j = 2; j < px.length; j += 3) mu += px[j]; mu /= px.length / 3;
      let vv = 0; for (let j = 2; j < px.length; j += 3) vv += (px[j] - mu) ** 2;
      tpl.push({ adv, off: lw / 2 + 1, px, mu, sd: Math.sqrt(vv) || 1 });
    }
    const space = m.measureText(' ').width;
    const ncc = (T, ox, oy) => {
      const P = T.px, n = P.length / 3; let sp = 0, sq = 0, sc = 0;
      for (let j = 0; j < P.length; j += 3) {
        const x = P[j] + ox, y = P[j + 1] + oy;
        const l = x >= 0 && y >= 0 && x < cw && y < ch ? L[y * cw + x] : 0;
        sp += l; sq += l * l; sc += l * (P[j + 2] - T.mu);
      }
      const sdI = Math.sqrt(Math.max(1e-6, sq - sp * sp / n));
      return sc / (sdI * T.sd);
    };
    let cur = cw - padK, digits = '', sum = 0, oyPrev = 0;
    for (let i = 0; i < 14; i++) {
      if (i === 6) cur -= space;
      let bb = null;
      for (let d = 0; d < 10; d++) {
        const T = tpl[d], left = cur - T.adv;
        for (let dx = -3; dx <= 3; dx++) for (let dy = -4; dy <= 4; dy++) {
          const ox = Math.round(left - T.off + dx), sc = ncc(T, ox, dy + (i ? oyPrev : 0));
          if (!bb || sc > bb.sc) bb = { d, sc, dx, dy };
        }
      }
      if (i === 0) oyPrev = bb.dy; // 첫 글자에서 찾은 높이를 나머지에 적용(±4px 더 찾음)
      else oyPrev += bb.dy;
      digits = bb.d + digits; sum += bb.sc; cur = cur - tpl[bb.d].adv + bb.dx;
    }
    const score = sum / 14;
    if (!best || score > best.score) best = { digits, score, s };
  }
  const t = best.digits;
  const Y = +t.slice(0, 4), Mo = +t.slice(4, 6), D = +t.slice(6, 8), h = +t.slice(8, 10), mi = +t.slice(10, 12), se = +t.slice(12, 14);
  const ok = best.score > 0.55 && Y >= 2020 && Y <= 2099 && Mo >= 1 && Mo <= 12 && D >= 1 && D <= 31 && h < 24 && mi < 60 && se < 60;
  const date = ok ? new Date(Y, Mo - 1, D, h, mi, se) : null;
  if (date && date.getDate() !== D) return { ok: false, ...best };
  return { ok, date: date && date.getTime(), ...best };
}
function lumaArr(d) {
  const L = new Float32Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  return L;
}
// 촬영 일시 찾기: 파일 이름(연월일_시분초) → 사진 속 날짜 글자 → 파일 날짜(부정확) 순서
async function findDate(blob, name, fallback) {
  const m = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name || '');
  if (m) return { date: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), src: 'name' };
  try { const r = await dateFromStamp(blob); if (r.ok) return { date: r.date, src: 'stamp' }; } catch {}
  return { date: fallback || Date.now(), src: 'file' };
}
// 영역의 평균 밝기(0~255)와 하얗게 날아간 비율
function lumaOf(g, x, y, w, h) {
  const d = g.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
  let s = 0, n = 0, hi = 0;
  for (let i = 0; i < d.length; i += 8) { const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; s += l; n++; if (l > 245) hi++; }
  return { mean: s / n, clip: hi / n };
}
async function libAdd(blob, name, date, src = 'name') {
  try {
    navigator.storage?.persist?.().catch(() => {});
    const all = await LIB.all();
    const dup = all.find((p) => Math.abs(p.date - date) < 1000 && (p.name === name || p.blob?.size === blob.size));
    if (dup) return dup.id;
    const bmp = await createImageBitmap(blob);
    const tw = 240, th = Math.max(1, Math.round(bmp.height * tw / bmp.width));
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, tw, th); bmp.close?.();
    const bright = lumaOf(g, tw / 4 | 0, th / 4 | 0, tw / 2 | 0, th / 2 | 0).mean;
    const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.75));
    let id = date; while (all.some((p) => p.id === id)) id++;
    await LIB.put({ id, name, date, src, blob, thumb, bright });
    return id;
  } catch { return null; }
}

function closeRefSheet() {
  $('refThumbs').querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src));
  $('refThumbs').innerHTML = ''; $('refSheet').hidden = true;
}

/* ============================ 사진 비교 화면 ============================ */
let libList = [], slotA = null, slotB = null, active = 'A', split = 50;
let libMode = store.get('dc_cmp') === 'slide' ? 'slide' : 'side';
const libUrls = new Map();
function urlOf(p, thumb) {
  const k = p.id + (thumb ? 't' : 'f');
  if (!libUrls.has(k)) libUrls.set(k, URL.createObjectURL(thumb ? (p.thumb || p.blob) : p.blob));
  return libUrls.get(k);
}
async function loadLib() {
  libList = await LIB.all().catch(() => []);
  const has = (id) => libList.some((p) => p.id === id);
  if (!has(slotA)) slotA = libList[0]?.id ?? null;
  if (!has(slotB)) slotB = libList[libList.length - 1]?.id ?? null;
}
let selMode = false; const sel = new Set();
// 예전에 불러온 사진 중 날짜를 파일 날짜로 잡은 것은 사진 속 날짜 글자로 다시 읽음 (한 번만)
async function fixOldDates() {
  const todo = libList.filter((p) => !p.src && !/\d{8}_\d{6}/.test(p.name || ''));
  if (!todo.length) return false;
  toast(`사진 속 날짜를 읽는 중… (${todo.length}장)`, 15000);
  let n = 0;
  for (const p of todo) {
    const r = await findDate(p.blob, p.name, p.date);
    if (r.src === 'stamp') n++;
    p.date = r.date; p.src = r.src;
    await LIB.put(p).catch(() => {});
  }
  toast(`${n}장의 날짜를 사진 속 글자로 고쳤습니다`);
  return true;
}
async function openLib() {
  show('lib'); selMode = false; sel.clear();
  await loadLib(); renderLib();
  if (await fixOldDates()) { await loadLib(); slotA = libList[0]?.id ?? null; slotB = libList[libList.length - 1]?.id ?? null; active = 'A'; renderLib(); }
}
function closeLib() { libUrls.forEach((u) => URL.revokeObjectURL(u)); libUrls.clear(); selMode = false; sel.clear(); show('home'); }
// N개월 전과 가장 가까운 사진 (가장 최근 사진 기준)
function photoMonthsAgo(n) {
  if (libList.length < 2) return null;
  const last = libList[libList.length - 1], target = last.date - n * 30 * DAY;
  const older = libList.filter((p) => p.id !== last.id && last.date - p.date >= n * 30 * DAY - 5 * DAY);
  if (!older.length) return null;
  return older.reduce((a, b) => (Math.abs(b.date - target) < Math.abs(a.date - target) ? b : a));
}
function renderLib() {
  const first = libList[0];
  const A = libList.find((p) => p.id === slotA), B = libList.find((p) => p.id === slotB);
  const label = (p) => (p ? `${fmtDate(p.date).slice(0, 10)} (${Math.floor((p.date - first.date) / DAY) + 1}일째)${p.src === 'file' ? ' · 날짜 추정' : ''}` : '-');
  $('slotAd').textContent = label(A); $('slotBd').textContent = label(B);
  $('slotA').classList.toggle('on', active === 'A' && !selMode); $('slotB').classList.toggle('on', active === 'B' && !selMode);
  $('mSide').classList.toggle('on', libMode === 'side'); $('mSlide').classList.toggle('on', libMode === 'slide');
  const empty = !libList.length;
  $('libEmpty').hidden = !empty;
  $('cmpSide').hidden = empty || libMode !== 'side';
  $('cmpSlide').hidden = empty || libMode !== 'slide';
  const setImg = (id, p) => { if (p) $(id).src = urlOf(p); else $(id).removeAttribute('src'); };
  setImg('imgA1', A); setImg('imgB1', B); setImg('imgA2', A); setImg('imgB2', B);
  $('cmpSlide').style.setProperty('--split', split + '%');
  document.querySelectorAll('#lib [data-months]').forEach((b) => { b.disabled = !photoMonthsAgo(Number(b.dataset.months)); });
  $('libQuick').hidden = selMode; $('libSelBar').hidden = !selMode;
  $('libSelMode').disabled = empty;
  $('libSelDel').textContent = `${sel.size}장 삭제`; $('libSelDel').disabled = !sel.size;
  $('libSelAll').textContent = sel.size && sel.size === libList.length ? '선택 해제' : '전체 선택';
  $('libHint').innerHTML = empty ? '' : selMode
    ? '지울 사진을 눌러 고르세요 (갤러리에 저장된 파일은 그대로 남습니다)'
    : active === 'A' ? '아래에서 <b class="ya">기준(노랑)</b> 사진을 고르세요' : '아래에서 <b class="gb">비교(초록)</b> 사진을 고르세요';
  const strip = $('libStrip'); strip.innerHTML = '';
  strip.classList.toggle('selecting', selMode);
  libList.slice().reverse().forEach((p) => {
    const b = document.createElement('button');
    b.className = selMode ? (sel.has(p.id) ? 'x' : '') : (p.id === slotA ? 'a' : '') + (p.id === slotB ? ' b' : '');
    const i = document.createElement('img'); i.src = urlOf(p, true); i.alt = p.name; i.loading = 'lazy';
    const sp = document.createElement('span'); sp.textContent = fmtDate(p.date, true);
    b.append(i, sp);
    if (selMode) { if (sel.has(p.id)) { const t = document.createElement('i'); t.textContent = '✓'; b.appendChild(t); } }
    else if (p.id === slotA || p.id === slotB) { const t = document.createElement('i'); t.textContent = p.id === slotA ? '기준' : '비교'; b.appendChild(t); }
    b.onclick = () => {
      if (selMode) { sel.has(p.id) ? sel.delete(p.id) : sel.add(p.id); }
      else if (active === 'A') { slotA = p.id; active = 'B'; } // 기준을 고르면 바로 비교 칸으로 넘어감
      else slotB = p.id;
      renderLib();
    };
    strip.appendChild(b);
  });
}
$('pickLib').onclick = openLib;
$('libBack').onclick = closeLib;
$('slotA').onclick = () => { selMode = false; active = 'A'; renderLib(); };
$('slotB').onclick = () => { selMode = false; active = 'B'; renderLib(); };
$('mSide').onclick = () => { libMode = 'side'; store.set('dc_cmp', libMode); renderLib(); };
$('mSlide').onclick = () => { libMode = 'slide'; store.set('dc_cmp', libMode); renderLib(); };
document.querySelectorAll('#lib [data-months]').forEach((b) => {
  b.onclick = () => {
    const p = photoMonthsAgo(Number(b.dataset.months)); if (!p) return;
    slotA = p.id; slotB = libList[libList.length - 1].id; active = 'B'; renderLib();
  };
});
// 여러 장 삭제
$('libSelMode').onclick = () => { selMode = true; sel.clear(); renderLib(); };
$('libSelCancel').onclick = () => { selMode = false; sel.clear(); renderLib(); };
$('libSelAll').onclick = () => {
  if (sel.size === libList.length) sel.clear(); else libList.forEach((p) => sel.add(p.id));
  renderLib();
};
$('libSelDel').onclick = async () => {
  if (!sel.size) return;
  const all = sel.size === libList.length;
  if (!confirm(`${all ? '사진 전체' : '고른 사진'} ${sel.size}장을 앱 사진첩에서 지울까요?\n(갤러리에 저장된 사진 파일은 그대로 남습니다)`)) return;
  const n = sel.size;
  for (const id of sel) {
    await LIB.del(id).catch(() => {});
    ['t', 'f'].forEach((k) => { const u = libUrls.get(id + k); if (u) { URL.revokeObjectURL(u); libUrls.delete(id + k); } });
  }
  sel.clear(); selMode = false;
  await loadLib(); renderLib(); toast(`${n}장을 앱 사진첩에서 지웠습니다`);
};
$('libImport').onclick = () => $('libFile').click();
$('libFile').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  let n = 0, guess = 0, i = 0;
  for (const f of files) {
    toast(`사진 넣는 중… ${++i}/${files.length}`, 15000);
    const r = await findDate(f, f.name, f.lastModified);
    if (await libAdd(f, f.name, r.date, r.src)) { n++; if (r.src === 'file') guess++; }
  }
  await loadLib(); slotA = libList[0]?.id ?? null; slotB = libList[libList.length - 1]?.id ?? null; active = 'A';
  renderLib();
  toast(`${n}장을 넣었습니다` + (guess ? ` · ${guess}장은 사진 속 날짜를 못 읽어 파일 날짜로 넣었습니다` : ''), 4000);
};
// 슬라이드 비교: 화면을 좌우로 끌어 기준·비교 사진 경계를 움직임
(() => {
  const el = $('cmpSlide'); let drag = false;
  const at = (e) => { const r = el.getBoundingClientRect(); split = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)); el.style.setProperty('--split', split + '%'); };
  el.addEventListener('pointerdown', (e) => { drag = true; el.setPointerCapture(e.pointerId); at(e); });
  el.addEventListener('pointermove', (e) => { if (drag) at(e); });
  ['pointerup', 'pointercancel'].forEach((ev) => el.addEventListener(ev, () => { drag = false; }));
})();

/* ============================ 뒤로가기 버튼 ============================ */
// 폰의 뒤로가기를 누르면 앱이 바로 닫히지 않도록: 열린 창 닫기 → 촬영 화면에서 첫 화면으로 → 첫 화면에서는 한 번 더 눌러야 종료
let backArmed = false, backTimer = null;
const pushGuard = () => { if (!history.state || !history.state.dcGuard) history.pushState({ dcGuard: 1 }, ''); };
addEventListener('popstate', () => {
  if (!$('viewer').hidden) closeViewer();
  else if (!$('netHelp').hidden) $('netHelp').hidden = true;
  else if (!$('saveSheet').hidden) closeSaveSheet();
  else if (!$('installHelp').hidden) $('installHelp').hidden = true;
  else if (!$('refSheet').hidden) closeRefSheet();
  else if (!$('checkSheet').hidden) $('checkSheet').hidden = true;
  else if (!$('lib').hidden) closeLib();
  else if (mode) goHome();
  else if (!backArmed) {
    backArmed = true;
    toast('뒤로 버튼을 한 번 더 누르면 종료됩니다', 2000);
    clearTimeout(backTimer);
    backTimer = setTimeout(() => { backArmed = false; pushGuard(); }, 2000);
    return; // 2초 안에 한 번 더 누르면 그대로 앱 종료
  }
  pushGuard();
});
pushGuard();

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
$('pickCam').onclick = () => startCamera();
$('pickMon').onclick = () => startMonitor(null);
const join = qs.get('join');
if (join && /^[a-z0-9]{6}$/i.test(join)) startMonitor(join.toUpperCase());

window.__dc = { get peer() { return peer; }, get mode() { return mode; } };
})();

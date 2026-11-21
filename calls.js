/**
 * FastMessage — calls.js
 * ----------------------------------------------------------------------------
 * НАСТОЯЩИЕ аудио- и видеозвонки на WebRTC.
 * Firebase Realtime Database используется ТОЛЬКО как signaling-канал:
 * через неё передаются SDP offer/answer и ICE-кандидаты. Сами аудио и видео
 * идут напрямую между устройствами (peer-to-peer), минуя Firebase.
 *
 * Структура signaling:
 *   calls/{callId}/
 *     callerId, receiverId, video, status, createdAt, endedAt
 *     offer:  {type, sdp}
 *     answer: {type, sdp}
 *     candidates/
 *       caller/{pushId}   — кандидаты звонящего
 *       callee/{pushId}   — кандидаты принимающего
 *
 * Статусы: ringing → accepted → connected → ended
 *          либо rejected / missed / busy / failed
 *
 * ВАЖНО о TURN: публичные STUN-серверы решают только задачу определения
 * внешнего адреса. Если оба абонента за «строгим» NAT (symmetric NAT,
 * частый случай в мобильных сетях и корпоративных Wi-Fi), прямое соединение
 * не установится — нужен TURN-ретранслятор. Вставьте свои данные в
 * TURN_SERVERS ниже. Выдуманные публичные TURN-креды здесь намеренно НЕ
 * указаны: они бы не работали.
 */

import {
  ctx, P, ICE_SERVERS, privateChatId, logActivity,
  ref, push, set, update, remove, get, onValue, onChildAdded,
  serverTimestamp, track, untrackGroup, emit, on
} from './firebase.js';

import { $, toast, escapeHtml, formatDuration, isMobile } from './app.js';
import {
  fetchProfile, displayName, avatarHtml, privacyAllows, cachedProfile
} from './profile.js';
import { isContact, isBlocked, checkBlockedBy } from './contacts.js';
import { appendCallMessage } from './messages.js';

/* ──────────────────────────────────────────────────────────────────────────
   КОНФИГУРАЦИЯ ICE
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Впишите сюда свой TURN-сервер, если звонки не соединяются в мобильных сетях.
 * Пример (coturn / Twilio / Metered — любой провайдер):
 *
 *   { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
 *
 * Пустой массив = работаем только на STUN.
 */
export const TURN_SERVERS = [
  // Бесплатный публичный TURN (Open Relay от Metered) — подходит для проверки.
  // Для постоянной работы заведите свой TURN (Metered / Twilio / coturn)
  // и замените значения ниже.
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

function iceConfig() {
  return {
    iceServers: [...ICE_SERVERS, ...TURN_SERVERS],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ ЗВОНКА
   ────────────────────────────────────────────────────────────────────────── */

const call = {
  id: null,
  peerId: null,
  peerProfile: null,
  isCaller: false,
  video: false,
  status: 'idle',        // idle | ringing | outgoing | connected | ended
  pc: null,
  localStream: null,
  remoteStream: null,
  /** отписки signaling-слушателей */
  unsubs: [],
  /** ICE-кандидаты, пришедшие до установки remoteDescription */
  pendingCandidates: [],
  remoteDescSet: false,
  startedAt: 0,
  timerId: null,
  statsId: null,
  micOn: true,
  camOn: true,
  speakerOn: true,
  facingMode: 'user',
  ringTimeout: null,
  /** защита от двойного завершения */
  closing: false
};

export function isInCall() {
  return call.status !== 'idle' && call.status !== 'ended';
}

/* ──────────────────────────────────────────────────────────────────────────
   РИНГТОН (WebAudio — без внешних файлов)
   ────────────────────────────────────────────────────────────────────────── */

const ring = { ctx: null, timer: null };

function startRingtone(incoming) {
  stopRingtone();
  try {
    ring.ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { return; }

  const beep = () => {
    if (!ring.ctx) return;
    const now = ring.ctx.currentTime;
    const notes = incoming ? [587.33, 783.99] : [440];

    notes.forEach((freq, i) => {
      const osc = ring.ctx.createOscillator();
      const gain = ring.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.34);
      gain.gain.linearRampToValueAtTime(0.12, now + i * 0.34 + 0.04);
      gain.gain.linearRampToValueAtTime(0, now + i * 0.34 + 0.3);
      osc.connect(gain).connect(ring.ctx.destination);
      osc.start(now + i * 0.34);
      osc.stop(now + i * 0.34 + 0.34);
    });
  };

  beep();
  ring.timer = setInterval(beep, incoming ? 1800 : 2600);
}

function stopRingtone() {
  clearInterval(ring.timer);
  ring.timer = null;
  if (ring.ctx) { ring.ctx.close().catch(() => {}); ring.ctx = null; }
}

/* ──────────────────────────────────────────────────────────────────────────
   МЕДИАПОТОК
   ────────────────────────────────────────────────────────────────────────── */

async function getLocalStream(video) {
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: video ? {
      facingMode: call.facingMode,
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }
    } : false
  };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Видео может быть недоступно — пробуем хотя бы звук.
    if (video) {
      try {
        const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
        call.video = false;
        call.camOn = false;
        showCallError('Камера недоступна — продолжаем со звуком.');
        return audioOnly;
      } catch (e2) {
        throw mediaError(e2);
      }
    }
    throw mediaError(err);
  }
}

function mediaError(err) {
  const map = {
    NotAllowedError: 'Доступ к камере/микрофону запрещён. Разрешите его в настройках сайта.',
    PermissionDeniedError: 'Доступ к камере/микрофону запрещён.',
    NotFoundError: 'Камера или микрофон не найдены.',
    NotReadableError: 'Устройство занято другим приложением.',
    OverconstrainedError: 'Камера не поддерживает запрошенные параметры.',
    SecurityError: 'Доступ к медиа требует HTTPS или localhost.'
  };
  const e = new Error(map[err.name] || err.message || 'Не удалось получить доступ к устройствам.');
  e.name = err.name;
  return e;
}

/* ──────────────────────────────────────────────────────────────────────────
   PEER CONNECTION
   ────────────────────────────────────────────────────────────────────────── */

function createPeerConnection(candidatesPath) {
  const pc = new RTCPeerConnection(iceConfig());

  // Свои кандидаты отправляем в свою ветку.
  pc.onicecandidate = (e) => {
    if (!e.candidate || !call.id) return;
    push(ref(ctx.db, `${P.call(call.id)}/candidates/${candidatesPath}`), e.candidate.toJSON())
      .catch((err) => console.warn('[calls] ICE send:', err.code));
  };

  pc.ontrack = (e) => {
    if (!call.remoteStream) call.remoteStream = new MediaStream();
    e.streams[0].getTracks().forEach((tr) => {
      if (!call.remoteStream.getTracks().includes(tr)) call.remoteStream.addTrack(tr);
    });
    attachRemoteStream();
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      onConnected();
    } else if (s === 'disconnected') {
      setStatusText('Связь нестабильна…');
      setQuality('weak');
    } else if (s === 'failed') {
      showCallError(
        TURN_SERVERS.length
          ? 'Не удалось установить прямое соединение.'
          : 'Не удалось соединиться напрямую. Вероятно, требуется TURN-сервер (см. README).'
      );
      endCall('failed');
    }
  };

 pc.oniceconnectionstatechange = () => {
  console.log('[CALL DEBUG] ICE:', pc.iceConnectionState);
  console.log('[CALL DEBUG] CONNECTION:', pc.connectionState);
  console.log('[CALL DEBUG] SIGNALING:', pc.signalingState);

  if (pc.iceConnectionState === 'checking') {
    setStatusText('Устанавливаем соединение…');
  }

  if (pc.iceConnectionState === 'failed') {
    console.error('[CALL DEBUG] ICE FAILED — TURN kerak yoki candidate almashinuvida xato');
  }

  if (pc.iceConnectionState === 'disconnected') {
    console.warn('[CALL DEBUG] ICE DISCONNECTED');
  };
};

  return pc;
}

/** Применяет кандидатов, накопленных до установки remoteDescription. */
async function flushPendingCandidates() {
  if (!call.pc || !call.remoteDescSet) return;
  const list = call.pendingCandidates;
  call.pendingCandidates = [];
  for (const c of list) {
    try {
      await call.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) {
      console.warn('[calls] addIceCandidate (отложенный):', e.message);
    }
  }
}

function listenRemoteCandidates(path) {
  const r = ref(ctx.db, `${P.call(call.id)}/candidates/${path}`);
  const unsub = onChildAdded(r, async (snap) => {
    const cand = snap.val();
    if (!cand || !call.pc) return;

    if (!call.remoteDescSet) {
      call.pendingCandidates.push(cand);
      return;
    }
    try {
      await call.pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.warn('[calls] addIceCandidate:', e.message);
    }
  }, (err) => console.warn('[calls] candidates listen:', err.code));

  call.unsubs.push(unsub);
  track(unsub, 'call');
}

/* ──────────────────────────────────────────────────────────────────────────
   ИСХОДЯЩИЙ ЗВОНОК
   ────────────────────────────────────────────────────────────────────────── */

export async function startCall(peerId, video) {
  if (isInCall()) {
    toast('Вы уже в разговоре', 'Завершите текущий звонок.', 'warn');
    return;
  }
  if (!peerId || peerId === ctx.uid) return;

  if (!window.RTCPeerConnection) {
    toast('Звонки недоступны', 'Браузер не поддерживает WebRTC.', 'error');
    return;
  }
  if (!window.isSecureContext) {
    toast('Нужен HTTPS', 'Камера и микрофон работают только по HTTPS или на localhost.', 'error');
    return;
  }

  const peer = await fetchProfile(peerId);
  if (!peer) { toast('Пользователь не найден', '', 'error'); return; }

  if (isBlocked(peerId)) {
    toast('Пользователь заблокирован', 'Разблокируйте его, чтобы позвонить.', 'warn');
    return;
  }
  if (await checkBlockedBy(peerId)) {
    toast('Звонок невозможен', 'Пользователь ограничил связь.', 'warn');
    return;
  }
  if (!privacyAllows(peer, 'calls', isContact(peerId))) {
    toast('Звонок невозможен', `${displayName(peer)} принимает звонки не от всех.`, 'warn');
    return;
  }

  // Не звоним тому, кто уже разговаривает.
  const busy = await isPeerBusy(peerId);
  if (busy) {
    toast('Занято', `${displayName(peer)} сейчас в другом разговоре.`, 'warn');
    return;
  }

  call.id = push(ref(ctx.db, 'calls')).key;
  call.peerId = peerId;
  call.peerProfile = peer;
  call.isCaller = true;
  call.video = !!video;
  call.camOn = !!video;
  call.micOn = true;
  call.status = 'outgoing';
  call.remoteDescSet = false;
  call.pendingCandidates = [];
  call.closing = false;

  openCallUI(false);
  setStatusText('Вызов…');
  startRingtone(false);

  try {
    call.localStream = await getLocalStream(call.video);
    attachLocalStream();

    call.pc = createPeerConnection('caller');
    call.localStream.getTracks().forEach((tr) => call.pc.addTrack(tr, call.localStream));

   
const offer = await call.pc.createOffer({
  offerToReceiveAudio: true,
  offerToReceiveVideo: call.video
});

// 1. Avval Firebase'da qo'ng'iroq hujjatini yaratamiz.
await set(ref(ctx.db, P.call(call.id)), {
  id: call.id,
  callerId: ctx.uid,
  callerName: displayName(ctx.profile),
  callerPhoto: ctx.profile.photoURL || '',
  receiverId: peerId,
  video: call.video,
  status: 'ringing',
  offer: { type: offer.type, sdp: offer.sdp },
  createdAt: Date.now()
});
logActivity('call', peerId, { video: !!call.video });

// 2. Endi ICE kandidatlarini yuborish xavfsizroq.
await call.pc.setLocalDescription(offer);

// 3. Tinglovchilarni ishga tushiramiz.
listenRemoteCandidates('callee');
watchCallDoc();

// 4. Ikkinchi foydalanuvchiga kiruvchi qo'ng'iroq haqida xabar.
await update(ref(ctx.db, P.userCalls(peerId)), {
  incomingCallId: call.id
});


    // Если не ответили за 45 секунд — считаем пропущенным.
    call.ringTimeout = setTimeout(() => {
      if (call.status === 'outgoing') {
        toast('Нет ответа', displayName(peer), 'warn');
        endCall('missed');
      }
    }, 45000);

  } catch (err) {
    console.error('[calls] startCall:', err);
    toast('Звонок не удался', err.message || String(err), 'error');
    showCallError(err.message);
    await endCall('failed');
  }
}

async function isPeerBusy(peerId) {
  try {
    const snap = await get(ref(ctx.db, P.userCalls(peerId)));
    if (!snap.exists()) return false;
    const v = snap.val();
    if (!v.activeCallId || !v.at) return false;
    // Запись «протухает» через 2 минуты — защита от зависших флагов.
    return Date.now() - v.at < 120000;
  } catch (e) {
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ВХОДЯЩИЙ ЗВОНОК
   ────────────────────────────────────────────────────────────────────────── */

/** Глобальный слушатель входящих. Запускается при входе в приложение. */
export function listenIncomingCalls() {
  const r = ref(ctx.db, P.userCalls(ctx.uid));

  const unsub = onValue(r, async (snap) => {
    const data = snap.val();
    if (!data || !data.incomingCallId) return;

    const callId = data.incomingCallId;

    // Уже в разговоре — сразу сообщаем «занято».
    if (isInCall()) {
      await update(ref(ctx.db, P.call(callId)), { status: 'busy', endedAt: Date.now() }).catch(() => {});
      await remove(ref(ctx.db, `${P.userCalls(ctx.uid)}/incomingCallId`)).catch(() => {});
      return;
    }

    const callSnap = await get(ref(ctx.db, P.call(callId))).catch(() => null);
    if (!callSnap || !callSnap.exists()) {
      await remove(ref(ctx.db, `${P.userCalls(ctx.uid)}/incomingCallId`)).catch(() => {});
      return;
    }

    const doc = callSnap.val();
    if (doc.status !== 'ringing' || doc.receiverId !== ctx.uid) return;
    // Звонок старше 60 секунд — протух.
    if (Date.now() - (doc.createdAt || 0) > 60000) {
      await remove(ref(ctx.db, `${P.userCalls(ctx.uid)}/incomingCallId`)).catch(() => {});
      return;
    }

    presentIncoming(doc);
  }, (err) => console.warn('[calls] incoming listen:', err.code));

  track(unsub, 'session');
}

async function presentIncoming(doc) {
  const peer = await fetchProfile(doc.callerId);

  if (isBlocked(doc.callerId)) {
    await update(ref(ctx.db, P.call(doc.id)), { status: 'rejected', endedAt: Date.now() }).catch(() => {});
    await remove(ref(ctx.db, `${P.userCalls(ctx.uid)}/incomingCallId`)).catch(() => {});
    return;
  }

  call.id = doc.id;
  call.peerId = doc.callerId;
  call.peerProfile = peer;
  call.isCaller = false;
  call.video = !!doc.video;
  call.camOn = !!doc.video;
  call.micOn = true;
  call.status = 'ringing';
  call.remoteDescSet = false;
  call.pendingCandidates = [];
  call.closing = false;

  openCallUI(true);
  startRingtone(true);
  if (navigator.vibrate) navigator.vibrate([340, 180, 340, 180, 340]);

  watchCallDoc();

  // Звонящий мог отменить — тогда UI закроется через watchCallDoc.
  call.ringTimeout = setTimeout(() => {
    if (call.status === 'ringing') endCall('missed');
  }, 48000);
}

export async function acceptCall() {
  if (call.status !== 'ringing' || !call.id) return;

  clearTimeout(call.ringTimeout);
  stopRingtone();
  $('callIncoming').classList.add('hidden');
  setStatusText('Соединяем…');

  try {
    const snap = await get(ref(ctx.db, P.call(call.id)));
    if (!snap.exists()) { await endCall('failed'); return; }
    const doc = snap.val();
    if (!doc.offer) { showCallError('Данные звонка повреждены.'); await endCall('failed'); return; }

    call.localStream = await getLocalStream(call.video);
    attachLocalStream();

    call.pc = createPeerConnection('callee');
    call.localStream.getTracks().forEach((tr) => call.pc.addTrack(tr, call.localStream));

    await call.pc.setRemoteDescription(new RTCSessionDescription(doc.offer));
    call.remoteDescSet = true;
    await flushPendingCandidates();

    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);

    await update(ref(ctx.db, P.call(call.id)), {
      answer: { type: answer.type, sdp: answer.sdp },
      status: 'accepted',
      acceptedAt: Date.now()
    });

    await set(ref(ctx.db, P.userCalls(ctx.uid)), {
      activeCallId: call.id,
      at: Date.now()
    });

    listenRemoteCandidates('caller');
    call.status = 'connected';

  } catch (err) {
    console.error('[calls] acceptCall:', err);
    toast('Звонок не удался', err.message || String(err), 'error');
    showCallError(err.message);
    await endCall('failed');
  }
}

export async function rejectCall() {
  if (!call.id) return;
  update(ref(ctx.db, P.call(call.id)), {
    status: 'rejected', endedAt: Date.now()
  }).catch(() => {});
  await endCall('rejected');
}

/* ──────────────────────────────────────────────────────────────────────────
   СЛЕЖЕНИЕ ЗА ДОКУМЕНТОМ ЗВОНКА
   ────────────────────────────────────────────────────────────────────────── */

function watchCallDoc() {
  const callId = call.id;
  const unsub = onValue(ref(ctx.db, P.call(callId)), async (snap) => {
    if (call.id !== callId) return;

    if (!snap.exists()) {
      if (isInCall()) await endCall('ended', true);
      return;
    }

    const doc = snap.val();

    // Звонящий: пришёл answer — применяем.
    if (call.isCaller && doc.answer && call.pc && !call.remoteDescSet) {
      try {
        await call.pc.setRemoteDescription(new RTCSessionDescription(doc.answer));
        call.remoteDescSet = true;
        await flushPendingCandidates();
        stopRingtone();
        setStatusText('Соединяем…');
        call.status = 'connected';
        await set(ref(ctx.db, P.userCalls(ctx.uid)), { activeCallId: callId, at: Date.now() });
      } catch (e) {
        showCallError('Ошибка согласования соединения.');
        await endCall('failed');
        return;
      }
    }

    if (doc.status === 'rejected' && call.isCaller) {
      toast('Звонок отклонён', displayName(call.peerProfile), 'warn');
      await endCall('rejected', true);
    } else if (doc.status === 'busy' && call.isCaller) {
      toast('Занято', 'Собеседник сейчас в другом разговоре.', 'warn');
      await endCall('busy', true);
    } else if (doc.status === 'ended' || doc.status === 'missed' || doc.status === 'failed') {
      await endCall(doc.status, true);
    }
  }, (err) => console.warn('[calls] doc listen:', err.code));

  call.unsubs.push(unsub);
  track(unsub, 'call');
}

/* ──────────────────────────────────────────────────────────────────────────
   СОЕДИНЕНИЕ УСТАНОВЛЕНО
   ────────────────────────────────────────────────────────────────────────── */

function onConnected() {
  if (call.startedAt) return;  // уже шло

  stopRingtone();
  clearTimeout(call.ringTimeout);
  call.startedAt = Date.now();
  call.status = 'connected';

  setStatusText('Соединено');
  setQuality('good');
  $('callTimer').classList.remove('hidden');
  $('callIncoming').classList.add('hidden');

  call.timerId = setInterval(() => {
    const sec = Math.floor((Date.now() - call.startedAt) / 1000);
    $('callTimer').textContent = formatDuration(sec, true);
  }, 500);

  startStatsMonitor();

  update(ref(ctx.db, P.call(call.id)), { status: 'connected', connectedAt: Date.now() })
    .catch(() => {});
}

/** Периодически смотрим качество связи. */
function startStatsMonitor() {
  clearInterval(call.statsId);
  let lastLost = 0;
  let lastTotal = 0;

  call.statsId = setInterval(async () => {
    if (!call.pc) return;
    try {
      const stats = await call.pc.getStats();
      let lost = 0, total = 0, rtt = 0;

      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && !r.isRemote) {
          lost += r.packetsLost || 0;
          total += (r.packetsReceived || 0) + (r.packetsLost || 0);
        }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
          rtt = Math.max(rtt, r.currentRoundTripTime);
        }
      });

      const dLost = lost - lastLost;
      const dTotal = total - lastTotal;
      lastLost = lost; lastTotal = total;

      const lossRate = dTotal > 0 ? dLost / dTotal : 0;

      if (lossRate > 0.08 || rtt > 0.45) setQuality('bad', 'Плохая связь');
      else if (lossRate > 0.03 || rtt > 0.22) setQuality('weak', 'Связь нестабильна');
      else setQuality('good', rtt ? `Пинг ${Math.round(rtt * 1000)} мс` : 'Хорошая связь');
    } catch (e) { /* noop */ }
  }, 3000);
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАВЕРШЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {string} reason ended | rejected | missed | failed | busy
 * @param {boolean} remote true — инициатива пришла с той стороны
 */
export async function endCall(reason = 'ended', remote = false) {
  if (call.closing) return;
  call.closing = true;

  const { id, peerId, isCaller, video, startedAt } = call;
  const duration = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;

  stopRingtone();
  clearTimeout(call.ringTimeout);
  clearInterval(call.timerId);
  clearInterval(call.statsId);

  // 1. Останавливаем все дорожки — камера и микрофон должны погаснуть.
  if (call.localStream) {
    call.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  }
  if (call.remoteStream) {
    call.remoteStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  }

    // 2. Закрываем peer connection.
    if (call.pc) {
      try {
        call.pc.getSenders().forEach((s) => { try { s.track && s.track.stop(); } catch (e) {} });
        call.pc.onicecandidate = null;
        call.pc.ontrack = null;
        call.pc.onconnectionstatechange = null;
        call.pc.oniceconnectionstatechange = null;
        call.pc.close();
      } catch (e) { /* noop */ }
    }

  // 3. Снимаем слушатели signaling.
  call.unsubs.forEach((u) => { try { u(); } catch (e) {} });
  call.unsubs = [];
  untrackGroup('call');

  // 4. Чистим signaling в базе — он больше не нужен.
  // Не ждём ответа сервера (без await): при плохой сети окно иначе зависает,
  // и звонок невозможно завершить. Firebase сам доставит запись по порядку.
  if (id && !remote) {
    update(ref(ctx.db, P.call(id)), {
      status: reason === 'ended' ? 'ended' : reason,
      endedAt: Date.now(),
      duration
    }).catch(() => {});
  }

  if (id) {
    // Удаляем кандидатов — они занимают место и не нужны после разговора.
    remove(ref(ctx.db, `${P.call(id)}/candidates`)).catch(() => {});
    if (peerId) {
      remove(ref(ctx.db, `${P.userCalls(peerId)}/incomingCallId`)).catch(() => {});
    }
    remove(ref(ctx.db, P.userCalls(ctx.uid))).catch(() => {});

    // Через минуту убираем и сам документ звонка.
    setTimeout(() => { remove(ref(ctx.db, P.call(id))).catch(() => {}); }, 60000);
  }

  // 5. Запись в историю чата.
  if (peerId && (isCaller || duration > 0 || reason === 'missed' || reason === 'rejected')) {
    const chatId = privateChatId(ctx.uid, peerId);
    const status = duration > 0 ? 'ended' : (reason === 'ended' ? 'missed' : reason);
    appendCallMessage(chatId, peerId, { video, status, duration }).catch(() => {});
  }

  // 6. Сброс состояния и UI.
  Object.assign(call, {
    id: null, peerId: null, peerProfile: null, isCaller: false,
    video: false, status: 'idle', pc: null, localStream: null, remoteStream: null,
    pendingCandidates: [], remoteDescSet: false, startedAt: 0,
    timerId: null, statsId: null, micOn: true, camOn: true,
    speakerOn: true, facingMode: 'user', ringTimeout: null, closing: false
  });

  closeCallUI();
  emit('call:ended', { reason, duration });
}

/* ──────────────────────────────────────────────────────────────────────────
   УПРАВЛЕНИЕ ВО ВРЕМЯ ЗВОНКА
   ────────────────────────────────────────────────────────────────────────── */

export function toggleMic() {
  if (!call.localStream) return;
  call.micOn = !call.micOn;
  call.localStream.getAudioTracks().forEach((t) => { t.enabled = call.micOn; });

  const btn = $('callMicBtn');
  btn.classList.toggle('off', !call.micOn);
  btn.querySelector('use').setAttribute('href', call.micOn ? '#i-mic' : '#i-mic-off');
}

export function toggleCam() {
  if (!call.localStream) return;
  const tracks = call.localStream.getVideoTracks();
  if (!tracks.length) {
    toast('Камера не используется', 'Это аудиозвонок.', 'warn');
    return;
  }

  call.camOn = !call.camOn;
  tracks.forEach((t) => { t.enabled = call.camOn; });

  const btn = $('callCamBtn');
  btn.classList.toggle('off', !call.camOn);
  btn.querySelector('use').setAttribute('href', call.camOn ? '#i-video' : '#i-video-off');
  $('callLocalOff').classList.toggle('hidden', call.camOn);
}

/** Переключение между фронтальной и основной камерой. */
export async function switchCamera() {
  if (!call.localStream || !call.pc) return;
  const videoTrack = call.localStream.getVideoTracks()[0];
  if (!videoTrack) {
    toast('Камера не используется', 'Это аудиозвонок.', 'warn');
    return;
  }

  call.facingMode = call.facingMode === 'user' ? 'environment' : 'user';

  try {
    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: call.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const newTrack = fresh.getVideoTracks()[0];

    // Подменяем дорожку в уже установленном соединении — без пересогласования.
    const sender = call.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);

    call.localStream.removeTrack(videoTrack);
    videoTrack.stop();
    call.localStream.addTrack(newTrack);
    newTrack.enabled = call.camOn;

    const lv = $('localVideo');
    lv.srcObject = call.localStream;
    lv.classList.toggle('no-mirror', call.facingMode === 'environment');
  } catch (err) {
    call.facingMode = call.facingMode === 'user' ? 'environment' : 'user';
    toast('Не удалось сменить камеру', err.message, 'warn');
  }
}

export function toggleSpeaker() {
  call.speakerOn = !call.speakerOn;
  const remote = $('remoteVideo');
  const audio = $('remoteAudio');
  remote.muted = !call.speakerOn;
  audio.muted = !call.speakerOn;

  const btn = $('callSpeakerBtn');
  btn.classList.toggle('off', !call.speakerOn);
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНТЕРФЕЙС ЗВОНКА
   ────────────────────────────────────────────────────────────────────────── */

function openCallUI(incoming) {
  const peer = call.peerProfile;
  const name = displayName(peer);
  const showPhoto = peer ? privacyAllows(peer, 'avatar', isContact(call.peerId)) : false;

  $('callOverlay').classList.remove('hidden');
  $('callError').classList.add('hidden');
  $('callTimer').classList.add('hidden');
  $('callTimer').textContent = '00:00';
  $('callQuality').textContent = '';
  $('callQuality').className = 'call-quality';

  $('callPeerName').textContent = name;
  $('incomingName').textContent = name;
  $('incomingType').textContent = call.video ? 'Входящий видеозвонок' : 'Входящий аудиозвонок';

  $('callPeerAvatar').outerHTML = avatarHtml(peer, 'xl', { showPhoto, id: 'callPeerAvatar' });
  $('incomingAvatar').outerHTML = avatarHtml(peer, 'xl', { showPhoto, id: 'incomingAvatar' })
    .replace('class="avatar xl', 'class="avatar xl pulse');

  $('callIncoming').classList.toggle('hidden', !incoming);
  $('callControls').classList.toggle('hidden', incoming);

  // Кнопки камеры показываем только в видеозвонке.
  $('callCamBtn').classList.toggle('hidden', !call.video);
  $('callSwitchCamBtn').classList.toggle('hidden', !call.video || !isMobile());
  $('callLocalWrap').classList.toggle('hidden', !call.video);

  $('callMicBtn').classList.remove('off');
  $('callCamBtn').classList.remove('off');
  $('callSpeakerBtn').classList.remove('off');
  $('callMicBtn').querySelector('use').setAttribute('href', '#i-mic');
  $('callCamBtn').querySelector('use').setAttribute('href', '#i-video');

  $('remoteVideo').classList.remove('on');
  $('callRemotePoster').classList.remove('off');
  $('callLocalOff').classList.add('hidden');

  // Экран не должен гаснуть во время разговора.
  requestWakeLock();
}

function closeCallUI() {
  $('callOverlay').classList.add('hidden');
  $('callIncoming').classList.add('hidden');
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('remoteAudio').srcObject = null;
  $('callError').classList.add('hidden');
  releaseWakeLock();
}

function attachLocalStream() {
  const lv = $('localVideo');
  lv.srcObject = call.localStream;
  lv.classList.toggle('no-mirror', call.facingMode === 'environment');

  const hasVideo = call.localStream.getVideoTracks().length > 0;
  $('callLocalWrap').classList.toggle('hidden', !hasVideo);
  $('callCamBtn').classList.toggle('hidden', !hasVideo);
  $('callSwitchCamBtn').classList.toggle('hidden', !hasVideo || !isMobile());
}

function attachRemoteStream() {
  const rv = $('remoteVideo');
  const ra = $('remoteAudio');

  // Видео и аудио в разные элементы: так звук идёт даже если видео нет.
  rv.srcObject = call.remoteStream;
  ra.srcObject = call.remoteStream;
  rv.muted = true;   // звук воспроизводит <audio>, иначе будет двойной

  rv.play().catch(() => {});
  ra.play().catch(() => {});

  const hasVideo = call.remoteStream.getVideoTracks().some((t) => t.readyState === 'live');
  rv.classList.toggle('on', hasVideo);
  $('callRemotePoster').classList.toggle('off', hasVideo);
}

function setStatusText(text) {
  $('callStatus').textContent = text;
}

function setQuality(level, text) {
  const el = $('callQuality');
  el.className = `call-quality ${level}`;
  el.textContent = text || '';
}

function showCallError(text) {
  const el = $('callError');
  el.textContent = text;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

/* Wake Lock — чтобы экран не гас во время звонка. */
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* не критично */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ──────────────────────────────────────────────────────────────────────────
   УВЕДОМЛЕНИЕ ПОЛУЧАТЕЛЯ
   Запись в userCalls/{peer}/incomingCallId — это «звонок телефона».
   ────────────────────────────────────────────────────────────────────────── */

async function ringPeer(peerId, callId) {
  await set(ref(ctx.db, `${P.userCalls(peerId)}/incomingCallId`), callId);
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initCallsUI() {
  $('callAcceptBtn').addEventListener('click', acceptCall);
  $('callRejectBtn').addEventListener('click', rejectCall);
  $('callEndBtn').addEventListener('click', () => endCall('ended'));
  $('callMicBtn').addEventListener('click', toggleMic);
  $('callCamBtn').addEventListener('click', toggleCam);
  $('callSwitchCamBtn').addEventListener('click', switchCamera);
  $('callSpeakerBtn').addEventListener('click', toggleSpeaker);

  // Перетаскивание окна локального видео
  makeDraggable($('callLocalWrap'));

  // Запуск звонка из любого места приложения
  on('call:start', async ({ uid, video }) => {
    await startCall(uid, video);
    if (call.id && call.isCaller) await ringPeer(uid, call.id).catch(() => {});
  });

  // Закрытие вкладки во время разговора — корректно завершаем.
  window.addEventListener('beforeunload', () => {
    if (isInCall() && call.id) {
      try {
        navigator.sendBeacon && null;  // RTDB REST недоступен без токена — чистим синхронно
        update(ref(ctx.db, P.call(call.id)), { status: 'ended', endedAt: Date.now() });
        remove(ref(ctx.db, P.userCalls(ctx.uid)));
      } catch (e) { /* noop */ }
    }
  });

  // Esc завершает звонок
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isInCall()) endCall('ended');
  });
}

function makeDraggable(el) {
  if (!el) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  const down = (e) => {
    const p = e.touches ? e.touches[0] : e;
    dragging = true;
    sx = p.clientX; sy = p.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    el.style.transition = 'none';
  };

  const move = (e) => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const nx = Math.max(8, Math.min(ox + p.clientX - sx, window.innerWidth - el.offsetWidth - 8));
    const ny = Math.max(8, Math.min(oy + p.clientY - sy, window.innerHeight - el.offsetHeight - 8));
    el.style.left = nx + 'px';
    el.style.top = ny + 'px';
    el.style.right = 'auto';
    if (e.cancelable) e.preventDefault();
  };

  const up = () => { dragging = false; el.style.transition = ''; };

  el.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  el.addEventListener('touchstart', down, { passive: true });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);
}

export { call as callState, ringPeer };

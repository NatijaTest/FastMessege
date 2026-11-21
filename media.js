/**
 * FastMessage — media.js
 * ----------------------------------------------------------------------------
 * Файлы, фото, видео, аудио, голосовые сообщения, просмотрщик изображений.
 *
 * Хранилище:
 *   Основной путь — Firebase Storage (uploadBytesResumable + getDownloadURL).
 *   Если Storage недоступен (не включён на тарифе / не настроен CORS),
 *   небольшие изображения автоматически сжимаются и сохраняются как data-URI
 *   прямо в сообщение. Крупные файлы в этом режиме отправить нельзя —
 *   пользователь получит честное объяснение, а не «тихую» ошибку.
 */

import {
  ctx, storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from './firebase.js';

import { $, toast, escapeHtml, formatBytes, formatDuration } from './app.js';
import { sendMediaMessage } from './messages.js';
import { uploadChunked, CHUNKED_LIMIT } from './filestore.js';

/* ──────────────────────────────────────────────────────────────────────────
   ЛИМИТЫ
   ────────────────────────────────────────────────────────────────────────── */

export const LIMITS = {
  image: 12 * 1024 * 1024,
  video: 60 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  file: 40 * 1024 * 1024,
  /** Предел для резервного режима data-URI (RTDB не любит большие строки). */
  inlineFallback: 320 * 1024
};

/** Включается, если Storage отказал — чтобы не повторять неудачные попытки. */
let storageBroken = false;

export function isStorageAvailable() {
  return !!ctx.storage && !storageBroken;
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАГРУЗКА В STORAGE
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Загружает файл в Storage с индикатором прогресса.
 * @param {File|Blob} file
 * @param {string} path путь в бакете
 * @param {(pct:number)=>void} [onProgress]
 */
export function uploadToStorage(file, path, onProgress) {
  return new Promise((resolve, reject) => {
    if (!ctx.storage) {
      reject(new Error('Firebase Storage не подключён к проекту.'));
      return;
    }

    const task = uploadBytesResumable(storageRef(ctx.storage, path), file, {
      contentType: file.type || 'application/octet-stream',
      cacheControl: 'public,max-age=31536000'
    });

    // Если Storage «молчит» (не включён / нужен платный тариф) — не ждём минутами.
    let stallTimer = setTimeout(() => {
      storageBroken = true;
      try { task.cancel(); } catch (e) { /* noop */ }
      reject(Object.assign(new Error('Storage не отвечает'), { code: 'storage/stalled' }));
    }, 10000);

    task.on(
      'state_changed',
      (snap) => {
        if (stallTimer && snap.bytesTransferred > 0) { clearTimeout(stallTimer); stallTimer = null; }
        if (onProgress && snap.totalBytes) {
          onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
        }
      },
      (err) => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        if (err.code === 'storage/unauthorized' ||
            err.code === 'storage/unknown' ||
            err.code === 'storage/retry-limit-exceeded') {
          storageBroken = true;
        }
        reject(err);
      },
      async () => {
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        try {
          resolve({ url: await getDownloadURL(task.snapshot.ref), path });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

export async function deleteFromStorage(path) {
  if (!ctx.storage || !path) return;
  try {
    await deleteObject(storageRef(ctx.storage, path));
  } catch (e) { /* файла может уже не быть */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   СЖАТИЕ ИЗОБРАЖЕНИЙ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Масштабирует изображение и отдаёт Blob + размеры.
 * Нужно и для экономии трафика, и для резервного data-URI режима.
 */
export function compressImage(file, maxSide = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;

      if (width > maxSide || height > maxSide) {
        const k = Math.min(maxSide / width, maxSide / height);
        width = Math.round(width * k);
        height = Math.round(height * k);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => blob
          ? resolve({ blob, width, height })
          : reject(new Error('Не удалось обработать изображение.')),
        'image/jpeg',
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Файл не похож на изображение.'));
    };
    img.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    r.readAsDataURL(blob);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   АВАТАРЫ, СТИКЕРЫ, GIF
   ────────────────────────────────────────────────────────────────────────── */

export async function uploadAvatar(file, uid) {
  const { blob } = await compressImage(file, 512, 0.86);

  if (isStorageAvailable()) {
    try {
      const res = await uploadToStorage(blob, `avatars/${uid}/${Date.now()}.jpg`);
      return res.url;
    } catch (err) {
      console.warn('[media] avatar → Storage недоступен, переходим на data-URI:', err.code);
    }
  }

  // Резерв: маленький аватар помещается в профиль как data-URI.
  const small = await compressImage(file, 192, 0.7);
  const dataUrl = await blobToDataUrl(small.blob);
  if (dataUrl.length > 120 * 1024) {
    throw new Error('Firebase Storage недоступен, а изображение слишком большое для резервного режима.');
  }
  return dataUrl;
}

export async function uploadSticker(file) {
  const { blob } = await compressImage(file, 512, 0.9);
  if (isStorageAvailable()) {
    try {
      const res = await uploadToStorage(blob, `stickers/${ctx.uid}/${Date.now()}.png`);
      return res.url;
    } catch (e) { /* падаем в резерв */ }
  }
  const small = await compressImage(file, 256, 0.8);
  return blobToDataUrl(small.blob);
}

export async function uploadGif(file) {
  if (isStorageAvailable()) {
    try {
      const res = await uploadToStorage(file, `gifs/${ctx.uid}/${Date.now()}_${safeName(file.name)}`);
      return res.url;
    } catch (e) { /* падаем в резерв */ }
  }
  if (file.size > LIMITS.inlineFallback) {
    throw new Error('Firebase Storage недоступен. GIF до 320 КБ можно отправить без него.');
  }
  return blobToDataUrl(file);
}

function safeName(name) {
  return String(name || 'file')
    .replace(/[^\w.\-]+/g, '_')
    .slice(-60);
}

/* ──────────────────────────────────────────────────────────────────────────
   ОЧЕРЕДЬ ВЛОЖЕНИЙ КОМПОЗЕРА
   ────────────────────────────────────────────────────────────────────────── */

/** @type {{id:string,file:File,kind:string,previewUrl:string}[]} */
let pending = [];

function kindOf(file, hint) {
  if (hint && hint !== 'auto') return hint;
  const m = file.type || '';
  if (m.startsWith('image/')) return m === 'image/gif' ? 'gif' : 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

function limitFor(kind) {
  if (kind === 'image' || kind === 'gif') return LIMITS.image;
  if (kind === 'video') return LIMITS.video;
  if (kind === 'audio') return LIMITS.audio;
  return LIMITS.file;
}

export function queueFiles(files, hint = 'auto') {
  const list = [...files];
  for (const file of list) {
    const kind = kindOf(file, hint);
    const limit = limitFor(kind);

    if (file.size > limit) {
      toast('Файл слишком большой', `${escapeHtml(file.name)} — максимум ${formatBytes(limit)}.`, 'warn');
      continue;
    }

    pending.push({
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7),
      file,
      kind,
      previewUrl: (kind === 'image' || kind === 'gif' || kind === 'video')
        ? URL.createObjectURL(file) : ''
    });
  }
  renderAttachPreview();
}

function renderAttachPreview() {
  const box = $('attachPreview');
  if (!box) return;

  if (!pending.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = pending.map((p) => {
    let inner;
    if (p.kind === 'image' || p.kind === 'gif') {
      inner = `<img src="${p.previewUrl}" alt="" />`;
    } else if (p.kind === 'video') {
      inner = `<video src="${p.previewUrl}" muted></video>`;
    } else {
      const icon = p.kind === 'audio' ? 'i-speaker' : 'i-file';
      inner = `<svg class="ac-type"><use href="#${icon}"/></svg>`;
    }
    return `
      <div class="attach-chip" data-pending="${p.id}">
        ${inner}
        <span class="ac-name">${escapeHtml(p.file.name)}</span>
        <button class="ac-remove" data-remove-pending="${p.id}"><svg><use href="#i-x"/></svg></button>
      </div>`;
  }).join('');
}

function removePending(id) {
  const item = pending.find((p) => p.id === id);
  if (item && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  pending = pending.filter((p) => p.id !== id);
  renderAttachPreview();
}

export function clearPending() {
  pending.forEach((p) => { if (p.previewUrl) URL.revokeObjectURL(p.previewUrl); });
  pending = [];
  renderAttachPreview();
}

export function hasPending() { return pending.length > 0; }

/**
 * Отправляет все вложения из очереди.
 * Текст из композера прикрепляется к первому файлу как подпись.
 */
export async function sendPendingFiles(caption = '') {
  if (!pending.length) return;
  const items = [...pending];
  pending = [];
  renderAttachPreview();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const media = await prepareMedia(item);
      await sendMediaMessage({
        type: item.kind,
        media,
        text: i === 0 ? caption : ''
      });
    } catch (err) {
      toast('Файл не отправлен', `${escapeHtml(item.file.name)}: ${err.message}`, 'error');
    } finally {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }
}

/** Готовит объект media: грузит файл и собирает метаданные. */
async function prepareMedia(item) {
  const { file, kind } = item;
  const base = {
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream'
  };

  // Изображения сжимаем перед отправкой.
  if (kind === 'image') {
    const { blob, width, height } = await compressImage(file);
    base.width = width;
    base.height = height;
    base.size = blob.size;

    const res = await storeBlob(blob, 'images', file.name, 'image/jpeg', 'jpg');
    return { ...base, ...res, mime: 'image/jpeg' };
  }

  if (kind === 'video') {
    base.duration = await probeDuration(file, 'video').catch(() => 0);
  }
  if (kind === 'audio' || kind === 'voice') {
    base.duration = await probeDuration(file, 'audio').catch(() => 0);
  }

  const folder = kind === 'video' ? 'videos' : kind === 'audio' ? 'audio' : kind === 'gif' ? 'gifs' : 'files';
  const res = await storeBlob(file, folder, file.name, base.mime);
  return { ...base, ...res };
}

/**
 * Сохраняет файл: сначала Firebase Storage, при любой проблеме — RTDB-куски.
 * Возвращает { url, path, ... } для поля media.
 */
async function storeBlob(blob, folder, name, mime, forceExt) {
  if (isStorageAvailable()) {
    try {
      return await uploadToStorage(blob, storagePath(folder, name, forceExt));
    } catch (err) {
      console.warn('[media] Storage недоступен, используем резервное хранилище:', err.code || err.message);
    }
  }
  if (blob.size > CHUNKED_LIMIT) throw storageHint();
  return uploadChunked(blob, mime);
}

function storagePath(folder, name, forceExt) {
  const clean = safeName(name);
  const final = forceExt ? clean.replace(/\.[^.]+$/, '') + '.' + forceExt : clean;
  return `chat/${ctx.uid}/${folder}/${Date.now()}_${final}`;
}

function storageHint() {
  return new Error(
    'Файл слишком большой для резервного режима (до 15 МБ). ' +
    'Для больших файлов включите Firebase Storage (нужен тариф Blaze) и опубликуйте storage.rules.'
  );
}

/** Узнаёт длительность медиафайла. */
function probeDuration(file, tag) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    const url = URL.createObjectURL(file);
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };

    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Math.round(el.duration || 0));
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('metadata')); };
    el.src = url;
    setTimeout(() => done(0), 4000);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   ГОЛОСОВЫЕ СООБЩЕНИЯ
   ────────────────────────────────────────────────────────────────────────── */

const recorder = {
  media: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  timer: null,
  audioCtx: null,
  analyser: null,
  rafId: 0,
  waveform: [],
  cancelled: false
};

function pickMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export async function startVoiceRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast('Запись недоступна', 'Браузер не поддерживает запись звука.', 'error');
    return false;
  }

  try {
    recorder.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    toast('Нет доступа к микрофону',
      err.name === 'NotAllowedError'
        ? 'Разрешите доступ к микрофону в настройках сайта.'
        : err.message, 'error');
    return false;
  }

  recorder.chunks = [];
  recorder.waveform = [];
  recorder.cancelled = false;
  recorder.startedAt = Date.now();

  const mime = pickMime();
  recorder.media = new MediaRecorder(recorder.stream, mime ? { mimeType: mime } : undefined);
  recorder.media.ondataavailable = (e) => { if (e.data.size) recorder.chunks.push(e.data); };
  recorder.media.start(120);

  // Визуализация уровня
  try {
    recorder.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = recorder.audioCtx.createMediaStreamSource(recorder.stream);
    recorder.analyser = recorder.audioCtx.createAnalyser();
    recorder.analyser.fftSize = 512;
    src.connect(recorder.analyser);
    drawWave();
  } catch (e) { /* визуализация необязательна */ }

  $('voiceRecorder').classList.remove('hidden');
  $('composer').querySelector('.composer-main').classList.add('hidden');

  recorder.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - recorder.startedAt) / 1000);
    $('voiceTime').textContent = formatDuration(sec);
    if (sec >= 300) stopVoiceRecording(true);  // ограничение 5 минут
  }, 200);

  return true;
}

function drawWave() {
  const box = $('voiceWave');
  const data = new Uint8Array(recorder.analyser.frequencyBinCount);

  const tick = () => {
    if (!recorder.analyser) return;
    recorder.analyser.getByteTimeDomainData(data);

    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
    }
    recorder.waveform.push(Math.min(1, peak * 1.6));
    if (recorder.waveform.length > 240) recorder.waveform.shift();

    const bars = recorder.waveform.slice(-46);
    box.innerHTML = bars
      .map((v) => `<i style="height:${Math.max(3, Math.round(v * 26))}px"></i>`).join('');

    recorder.rafId = requestAnimationFrame(tick);
  };
  tick();
}

function teardownRecorder() {
  clearInterval(recorder.timer);
  cancelAnimationFrame(recorder.rafId);
  recorder.timer = null;
  recorder.rafId = 0;

  if (recorder.stream) recorder.stream.getTracks().forEach((t) => t.stop());
  recorder.stream = null;

  if (recorder.audioCtx) { recorder.audioCtx.close().catch(() => {}); recorder.audioCtx = null; }
  recorder.analyser = null;
  recorder.media = null;

  $('voiceRecorder').classList.add('hidden');
  $('composer').querySelector('.composer-main').classList.remove('hidden');
  $('voiceTime').textContent = '0:00';
  $('voiceWave').innerHTML = '';
}

export function cancelVoiceRecording() {
  if (!recorder.media) { teardownRecorder(); return; }
  recorder.cancelled = true;
  try { recorder.media.stop(); } catch (e) { /* noop */ }
  teardownRecorder();
  toast('Запись отменена', '', 'warn');
}

export async function stopVoiceRecording() {
  if (!recorder.media) return;

  const duration = Math.max(1, Math.round((Date.now() - recorder.startedAt) / 1000));
  const waveform = compactWaveform(recorder.waveform);
  const mime = recorder.media.mimeType || 'audio/webm';

  const blob = await new Promise((resolve) => {
    recorder.media.onstop = () => resolve(new Blob(recorder.chunks, { type: mime }));
    try { recorder.media.stop(); } catch (e) { resolve(new Blob(recorder.chunks, { type: mime })); }
  });

  const cancelled = recorder.cancelled;
  teardownRecorder();
  if (cancelled || !blob.size) return;

  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: mime });

  try {
    const res = await storeBlob(file, 'voice', file.name, mime);
    const media = { ...res, name: file.name, size: file.size, mime, duration, waveform };
    await sendMediaMessage({ type: 'voice', media });
  } catch (err) {
    toast('Голосовое не отправлено', err.message, 'error');
  }
}

/** Сжимает дорожку уровня до 28 столбиков для компактного хранения. */
function compactWaveform(src) {
  const target = 28;
  if (!src.length) return [];
  const out = [];
  const step = src.length / target;
  for (let i = 0; i < target; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = from; j < to && j < src.length; j++) max = Math.max(max, src[j]);
    out.push(Math.round(max * 100) / 100);
  }
  return out;
}

export function isRecording() { return !!recorder.media; }

/* ──────────────────────────────────────────────────────────────────────────
   ВОСПРОИЗВЕДЕНИЕ АУДИО В ЛЕНТЕ
   ────────────────────────────────────────────────────────────────────────── */

let currentAudio = null;
let currentHolder = null;

export function playAudioMessage(holder) {
  if (!holder) return;
  const url = holder.dataset.audio;
  if (!url) return;

  // Повторный клик по тому же сообщению — пауза/продолжение.
  if (currentHolder === holder && currentAudio) {
    if (currentAudio.paused) currentAudio.play();
    else currentAudio.pause();
    syncAudioIcon();
    return;
  }

  stopCurrentAudio();

  currentAudio = new Audio(url);
  currentHolder = holder;

  const bars = [...holder.querySelectorAll('.audio-wave i')];
  const timeEl = holder.querySelector('[data-audio-time]');

  currentAudio.addEventListener('timeupdate', () => {
    if (!currentAudio || !currentAudio.duration) return;
    const pct = currentAudio.currentTime / currentAudio.duration;
    const upTo = Math.round(pct * bars.length);
    bars.forEach((b, i) => b.classList.toggle('played', i < upTo));
    if (timeEl) timeEl.textContent = formatDuration(Math.round(currentAudio.currentTime));
  });

  currentAudio.addEventListener('ended', () => {
    bars.forEach((b) => b.classList.remove('played'));
    if (timeEl) timeEl.textContent = formatDuration(Math.round(currentAudio.duration || 0));
    stopCurrentAudio();
  });

  currentAudio.addEventListener('error', () => {
    toast('Не удалось воспроизвести', 'Файл недоступен.', 'error');
    stopCurrentAudio();
  });

  currentAudio.play().then(syncAudioIcon).catch((err) => {
    toast('Не удалось воспроизвести', err.message, 'error');
    stopCurrentAudio();
  });

  // Перемотка кликом по дорожке
  const wave = holder.querySelector('.audio-wave');
  if (wave && !wave.dataset.seekable) {
    wave.dataset.seekable = '1';
    wave.addEventListener('click', (e) => {
      if (currentHolder !== holder || !currentAudio || !currentAudio.duration) return;
      const r = wave.getBoundingClientRect();
      currentAudio.currentTime = ((e.clientX - r.left) / r.width) * currentAudio.duration;
    });
  }
}

function syncAudioIcon() {
  document.querySelectorAll('[data-audio-play] use').forEach((u) => u.setAttribute('href', '#i-play'));
  if (currentHolder && currentAudio && !currentAudio.paused) {
    const use = currentHolder.querySelector('[data-audio-play] use');
    if (use) use.setAttribute('href', '#i-pause');
  }
}

export function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
  currentHolder = null;
  syncAudioIcon();
}

/* ──────────────────────────────────────────────────────────────────────────
   ПРОСМОТРЩИК ИЗОБРАЖЕНИЙ
   ────────────────────────────────────────────────────────────────────────── */

export function openLightbox(url, caption = '') {
  if (!url) return;
  $('lightboxImg').src = url;
  $('lightboxDownload').href = url;
  $('lightboxCaption').textContent = caption;
  $('lightboxCaption').classList.toggle('hidden', !caption);
  $('lightbox').classList.remove('hidden');
}

export function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightboxImg').src = '';
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initMediaUI() {
  // Меню прикрепления
  const menu = $('attachMenu');
  $('attachBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('hidden') &&
        !e.target.closest('#attachMenu') && !e.target.closest('#attachBtn')) {
      menu.classList.add('hidden');
    }
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-attach]');
    if (!btn) return;
    menu.classList.add('hidden');
    const map = {
      image: 'fileInputImage',
      video: 'fileInputVideo',
      audio: 'fileInputAudio',
      doc: 'fileInputDoc'
    };
    $(map[btn.dataset.attach]).click();
  });

  const bind = (inputId, hint) => {
    $(inputId).addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) queueFiles(e.target.files, hint);
      e.target.value = '';
    });
  };
  bind('fileInputImage', 'image');
  bind('fileInputVideo', 'video');
  bind('fileInputAudio', 'audio');
  bind('fileInputDoc', 'file');

  $('attachPreview').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-pending]');
    if (btn) removePending(btn.dataset.removePending);
  });

  // Перетаскивание файлов в окно чата
  const area = $('chatArea');
  ['dragenter', 'dragover'].forEach((evt) => {
    area.addEventListener(evt, (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      area.style.outline = '2px dashed var(--accent)';
      area.style.outlineOffset = '-10px';
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    area.addEventListener(evt, (e) => {
      if (evt === 'drop') e.preventDefault();
      area.style.outline = '';
    });
  });
  area.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    queueFiles(e.dataTransfer.files);
  });

  // Вставка изображения из буфера
  $('messageInput').addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); queueFiles(files); }
  });

  // Голосовые
  $('voiceBtn').addEventListener('click', startVoiceRecording);
  $('voiceSendBtn').addEventListener('click', stopVoiceRecording);
  $('voiceCancelBtn').addEventListener('click', cancelVoiceRecording);

  // Просмотрщик
  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
}

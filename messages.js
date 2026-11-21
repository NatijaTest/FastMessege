/**
 * FastMessage — messages.js
 * ----------------------------------------------------------------------------
 * Лента сообщений: загрузка с пагинацией, отправка, статусы доставки и
 * прочтения, typing indicator, ответы, редактирование, удаление, пересылка,
 * реакции, копирование, закрепление и поиск по чату.
 *
 * Схема сообщения (messages/{chatId}/{messageId}):
 *   id, chatId, senderId, type, text, createdAt, editedAt, deleted,
 *   replyTo:{id,senderId,name,text}, forwardFrom:{uid,name},
 *   media:{url,path,name,size,mime,width,height,duration,waveform},
 *   sticker, reactions:{uid:emoji}, readBy:{uid:timestamp}
 */

import {
  ctx, P,
  ref, push, set, update, remove, get, query, orderByChild,
  limitToLast, endAt, serverTimestamp, increment,
  onChildAdded, onChildChanged, onChildRemoved, track, listen,
  untrackGroup, emit, logActivity
} from './firebase.js';

import { chunkKey, getCachedChunkUrl, loadChunked } from './filestore.js';

import {
  $, toast, escapeHtml, linkify, formatTime, formatDateSep, isEmojiOnly,
  confirmDialog, openModal, closeModal, openContextMenu, copyText,
  formatBytes, formatDuration, t
} from './app.js';

import {
  fetchProfile, displayName, avatarHtml, cachedProfile, privacyAllows
} from './profile.js';

import { isContact, isBlocked, amIBlockedBy, contactsState } from './contacts.js';
import { openLightbox, playAudioMessage } from './media.js';

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ
   ────────────────────────────────────────────────────────────────────────── */

const PAGE = 40;

const state = {
  chatId: null,
  peerId: null,
  /** id -> message */
  messages: new Map(),
  /** отсортированный массив id */
  order: [],
  oldestKey: null,
  hasMore: false,
  loadingMore: false,
  atBottom: true,
  newWhileAway: 0,
  /** reply / edit */
  replyTo: null,
  editing: null,
  /** поиск */
  searchActive: false,
  searchTerm: '',
  searchHits: [],
  searchIndex: -1,
  /** пересылка */
  forwarding: null,
  typingSentAt: 0,
  typingTimer: null,
  menuMessageId: null
};

export function activeMessagesChat() { return state.chatId; }
export function getMessage(id) { return state.messages.get(id) || null; }

/* ──────────────────────────────────────────────────────────────────────────
   ОТКРЫТИЕ / ЗАКРЫТИЕ ЧАТА
   ────────────────────────────────────────────────────────────────────────── */

export async function openMessages(chatId, peerId) {
  state.chatId = chatId;
  state.peerId = peerId;
  state.messages.clear();
  state.order = [];
  state.oldestKey = null;
  state.hasMore = false;
  state.atBottom = true;
  state.newWhileAway = 0;
  state.replyTo = null;
  state.editing = null;

  $('messagesList').innerHTML = '';
  $('loadMoreWrap').classList.add('hidden');
  hideComposerContext();
  updateScrollDownBtn();

  await loadInitial();
  startRealtime();
  watchTyping();
  watchPinned();
}

export function closeMessages() {
  stopTyping();
  state.chatId = null;
  state.peerId = null;
  state.messages.clear();
  state.order = [];
  $('messagesList').innerHTML = '';
  setChatSearchActive(false);
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАГРУЗКА
   ────────────────────────────────────────────────────────────────────────── */

async function loadInitial() {
  const chatId = state.chatId;
  try {
    const q = query(ref(ctx.db, P.messages(chatId)), orderByChild('createdAt'), limitToLast(PAGE));
    const snap = await get(q);
    const items = [];
    snap.forEach((child) => { items.push({ id: child.key, ...child.val() }); });

    if (state.chatId !== chatId) return;

    items.forEach((m) => state.messages.set(m.id, m));
    state.order = items.map((m) => m.id);
    state.oldestKey = items.length ? items[0].createdAt : null;
    state.hasMore = items.length >= PAGE;
    $('loadMoreWrap').classList.toggle('hidden', !state.hasMore);

    renderAll();
    scrollToBottom(false);
    markIncomingRead();
  } catch (err) {
    console.error('[messages] loadInitial', err);
    $('messagesList').innerHTML =
      `<div class="empty-state small"><svg><use href="#i-info"/></svg><p>Не удалось загрузить сообщения: ${escapeHtml(err.code || err.message)}</p></div>`;
  }
}

async function loadMore() {
  if (state.loadingMore || !state.hasMore || !state.oldestKey) return;
  state.loadingMore = true;
  const btn = $('loadMoreBtn');
  btn.textContent = 'Загружаем…';

  const chatId = state.chatId;
  const scroller = $('messagesScroll');
  const prevHeight = scroller.scrollHeight;

  try {
    const q = query(
      ref(ctx.db, P.messages(chatId)),
      orderByChild('createdAt'),
      endAt(state.oldestKey),
      limitToLast(PAGE + 1)
    );
    const snap = await get(q);
    const items = [];
    snap.forEach((child) => {
      if (!state.messages.has(child.key)) items.push({ id: child.key, ...child.val() });
    });

    if (state.chatId !== chatId) return;

    if (!items.length) {
      state.hasMore = false;
      $('loadMoreWrap').classList.add('hidden');
      return;
    }

    items.forEach((m) => state.messages.set(m.id, m));
    state.order = [...items.map((m) => m.id), ...state.order];
    state.oldestKey = items[0].createdAt;
    state.hasMore = items.length >= PAGE;
    $('loadMoreWrap').classList.toggle('hidden', !state.hasMore);

    renderAll();
    scroller.scrollTop = scroller.scrollHeight - prevHeight;
  } catch (err) {
    toast('Ошибка загрузки', err.code || err.message, 'error');
  } finally {
    state.loadingMore = false;
    btn.textContent = 'Загрузить ещё';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   REALTIME
   ────────────────────────────────────────────────────────────────────────── */

function startRealtime() {
  const chatId = state.chatId;
  const base = ref(ctx.db, P.messages(chatId));
  const recent = query(base, orderByChild('createdAt'), limitToLast(PAGE));

  track(onChildAdded(recent, (snap) => {
    if (state.chatId !== chatId) return;
    if (state.messages.has(snap.key)) return;
    const m = { id: snap.key, ...snap.val() };
    state.messages.set(m.id, m);
    state.order.push(m.id);
    sortOrder();
    renderAll();

    if (m.senderId === ctx.uid || state.atBottom) {
      scrollToBottom(true);
    } else {
      state.newWhileAway++;
    }
    updateScrollDownBtn();
    markIncomingRead();
  }, (err) => console.warn('[messages] onChildAdded', err.code)), 'chat');

  track(onChildChanged(base, (snap) => {
    if (state.chatId !== chatId) return;
    if (!state.messages.has(snap.key)) return;
    state.messages.set(snap.key, { id: snap.key, ...snap.val() });
    renderAll();
  }, () => {}), 'chat');

  track(onChildRemoved(base, (snap) => {
    if (state.chatId !== chatId) return;
    state.messages.delete(snap.key);
    state.order = state.order.filter((id) => id !== snap.key);
    renderAll();
  }, () => {}), 'chat');
}

function sortOrder() {
  state.order.sort((a, b) => {
    const ma = state.messages.get(a);
    const mb = state.messages.get(b);
    return (ma ? ma.createdAt || 0 : 0) - (mb ? mb.createdAt || 0 : 0);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   ОТМЕТКА «ПРОЧИТАНО»
   ────────────────────────────────────────────────────────────────────────── */

let readTimer = null;

function markIncomingRead() {
  if (document.visibilityState !== 'visible') return;
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    const chatId = state.chatId;
    if (!chatId) return;

    const patch = {};
    let last = null;
    for (const id of state.order) {
      const m = state.messages.get(id);
      if (!m || m.senderId === ctx.uid || m.deleted) continue;
      if (m.readBy && m.readBy[ctx.uid]) continue;
      patch[`${P.messages(chatId)}/${id}/readBy/${ctx.uid}`] = Date.now();
      last = m;
    }

    if (last) {
      patch[`${P.chat(chatId)}/lastMessage/read`] = true;
    }
    patch[`${P.userChat(ctx.uid, chatId)}/unread`] = 0;

    try {
      await update(ref(ctx.db), patch);
    } catch (e) {
      console.warn('[messages] markRead', e.code);
    }
  }, 320);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.chatId) markIncomingRead();
});

/* ──────────────────────────────────────────────────────────────────────────
   ОТРИСОВКА
   ────────────────────────────────────────────────────────────────────────── */

function statusHtml(m) {
  if (m.senderId !== ctx.uid) return '';
  if (m.pending) return '<span class="msg-status"><svg><use href="#i-clock"/></svg></span>';
  const read = !!(m.readBy && state.peerId && m.readBy[state.peerId]);
  return `<span class="msg-status ${read ? 'read' : ''}"><svg><use href="#i-${read ? 'check-double' : 'check'}"/></svg></span>`;
}

function highlight(html) {
  if (!state.searchActive || !state.searchTerm) return html;
  const term = state.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(${term})`, 'gi'), '<mark>$1</mark>');
}

const chunkLoading = new Set();
const chunkFailed = new Set();

/** Для файлов из резервного хранилища подставляет blob-URL (скачивает при первом показе). */
function hydrateMedia(m) {
  const media = m.media || {};
  if (!media.chunked || media.url) return media;
  const key = chunkKey(media);
  const cached = getCachedChunkUrl(key);
  if (cached) return { ...media, url: cached };
  if (!chunkLoading.has(key) && !chunkFailed.has(key)) {
    chunkLoading.add(key);
    loadChunked(media)
      .then(() => { chunkLoading.delete(key); renderAll(); })
      .catch((e) => { chunkLoading.delete(key); chunkFailed.add(key); console.warn('[messages] chunk', e); });
  }
  return { ...media, url: '' };
}

function bodyHtml(m) {
  if (m.deleted) return '<div class="msg-text msg-deleted">Сообщение удалено</div>';

  const media = hydrateMedia(m);
  let html = '';

  switch (m.type) {
    case 'image':
      html += `<div class="msg-media"><img src="${escapeHtml(media.url)}" alt="" loading="lazy" data-lightbox="${escapeHtml(media.url)}" data-caption="${escapeHtml(media.name || '')}" /></div>`;
      break;
    case 'gif':
      html += `<div class="msg-media gif"><img src="${escapeHtml(media.url)}" alt="GIF" loading="lazy" data-lightbox="${escapeHtml(media.url)}" /></div>`;
      break;
    case 'sticker':
      html += media.url
        ? `<div class="msg-media sticker"><img src="${escapeHtml(media.url)}" alt="стикер" loading="lazy" /></div>`
        : `<div class="msg-text"><span class="emoji-only">${escapeHtml(m.sticker || '🙂')}</span></div>`;
      break;
    case 'video':
      html += `<div class="msg-media"><video src="${escapeHtml(media.url)}" controls preload="metadata" playsinline></video></div>`;
      break;
    case 'voice':
    case 'audio': {
      const bars = (media.waveform && media.waveform.length ? media.waveform : defaultWave())
        .map((v) => `<i style="height:${Math.max(3, Math.round(v * 24))}px"></i>`).join('');
      html += `
        <div class="msg-audio" data-audio="${escapeHtml(media.url)}" data-mid="${m.id}">
          <button class="audio-play" data-audio-play><svg><use href="#i-play"/></svg></button>
          <div class="audio-body">
            <div class="audio-wave">${bars}</div>
            <div class="audio-meta">
              <span>${m.type === 'voice' ? 'Голосовое' : escapeHtml(media.name || 'Аудио')}</span>
              <span data-audio-time>${formatDuration(media.duration || 0)}</span>
            </div>
          </div>
        </div>`;
      break;
    }
    case 'file':
      html += `
        <div class="msg-file">
          <span class="file-icon"><svg><use href="#i-file"/></svg></span>
          <span class="file-info">
            <span class="file-name">${escapeHtml(media.name || 'Файл')}</span>
            <span class="file-size">${formatBytes(media.size || 0)}</span>
          </span>
          <a class="file-dl" href="${escapeHtml(media.url)}" target="_blank" rel="noopener" download><svg><use href="#i-download"/></svg></a>
        </div>`;
      break;
    default:
      break;
  }

  if (m.text) {
    const only = isEmojiOnly(m.text);
    html += `<div class="msg-text">${only
      ? `<span class="emoji-only">${escapeHtml(m.text)}</span>`
      : highlight(linkify(m.text))}</div>`;
  }

  return html;
}

function defaultWave() {
  return Array.from({ length: 28 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 1.1)));
}

function reactionsHtml(m) {
  const r = m.reactions || {};
  const uids = Object.keys(r);
  if (!uids.length) return '';

  const groups = {};
  uids.forEach((u) => {
    const e = r[u];
    if (!groups[e]) groups[e] = [];
    groups[e].push(u);
  });

  return `<div class="msg-reactions">${Object.entries(groups).map(([emoji, list]) => `
    <button class="reaction-pill ${list.includes(ctx.uid) ? 'mine' : ''}"
            data-react="${escapeHtml(emoji)}" data-mid="${m.id}">
      <span class="r-emoji">${escapeHtml(emoji)}</span>
      <span class="r-count">${list.length}</span>
    </button>`).join('')}</div>`;
}

function replyHtml(m) {
  if (!m.replyTo) return '';
  return `
    <div class="msg-reply" data-jump="${escapeHtml(m.replyTo.id || '')}">
      <div class="msg-reply-body">
        <div class="msg-reply-name">${escapeHtml(m.replyTo.name || 'Сообщение')}</div>
        <div class="msg-reply-text">${escapeHtml(m.replyTo.text || '')}</div>
      </div>
    </div>`;
}

function forwardHtml(m) {
  if (!m.forwardFrom) return '';
  return `<div class="msg-forward"><svg><use href="#i-forward"/></svg> Переслано от ${escapeHtml(m.forwardFrom.name || 'пользователя')}</div>`;
}

function systemHtml(m) {
  if (m.type !== 'call') {
    return `<div class="msg-system">${escapeHtml(m.text || '')}</div>`;
  }
  const missed = m.callStatus === 'missed' || m.callStatus === 'rejected';
  const icon = m.callVideo ? 'i-video' : 'i-phone';
  let label;
  if (missed) label = m.senderId === ctx.uid ? 'Звонок без ответа' : 'Пропущенный звонок';
  else label = `Звонок · ${formatDuration(m.callDuration || 0)}`;
  return `<div class="msg-system call ${missed ? 'missed' : ''}"><svg><use href="#${icon}"/></svg>${escapeHtml(label)}</div>`;
}

function renderAll() {
  const list = $('messagesList');
  if (!list) return;

  sortOrder();

  let html = '';
  let lastDay = '';
  let prev = null;

  for (const id of state.order) {
    const m = state.messages.get(id);
    if (!m) continue;

    const day = formatDateSep(m.createdAt);
    if (day !== lastDay) {
      html += `<div class="date-sep">${escapeHtml(day)}</div>`;
      lastDay = day;
      prev = null;
    }

    if (m.type === 'system' || m.type === 'call') {
      html += systemHtml(m);
      prev = null;
      continue;
    }

    const out = m.senderId === ctx.uid;
    const grouped = !!prev &&
      prev.senderId === m.senderId &&
      Math.abs((m.createdAt || 0) - (prev.createdAt || 0)) < 5 * 60 * 1000 &&
      !m.replyTo && !m.forwardFrom;

    const peerProfile = out ? ctx.profile : cachedProfile(m.senderId);
    const avatar = out ? '' : avatarHtml(peerProfile, 'sm', {
      showPhoto: peerProfile ? privacyAllows(peerProfile, 'avatar', isContact(m.senderId)) : false
    }).replace('class="avatar sm', 'class="avatar sm msg-avatar');

    const mediaOnly = !m.text && ['image', 'video', 'gif'].includes(m.type);
    const stickerOnly = m.type === 'sticker' && !m.text;

    html += `
      <div class="msg-row ${out ? 'out' : 'in'} ${grouped ? 'grouped' : ''}" data-mid="${m.id}">
        ${avatar}
        <div class="bubble ${mediaOnly ? 'media-only' : ''} ${stickerOnly ? 'sticker-only' : ''}" data-bubble="${m.id}">
          ${forwardHtml(m)}
          ${replyHtml(m)}
          ${bodyHtml(m)}
          <div class="msg-foot">
            ${m.editedAt && !m.deleted ? '<span class="msg-edited">изменено</span>' : ''}
            <span class="msg-time">${formatTime(m.createdAt)}</span>
            ${statusHtml(m)}
          </div>
          ${reactionsHtml(m)}
        </div>
      </div>`;

    prev = m;
  }

  list.innerHTML = html;
}

/* ──────────────────────────────────────────────────────────────────────────
   ПРОКРУТКА
   ────────────────────────────────────────────────────────────────────────── */

export function scrollToBottom(smooth = true) {
  const s = $('messagesScroll');
  if (!s) return;
  s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  state.atBottom = true;
  state.newWhileAway = 0;
  updateScrollDownBtn();
}

function updateScrollDownBtn() {
  const btn = $('scrollDownBtn');
  const badge = $('scrollDownBadge');
  if (!btn) return;
  btn.classList.toggle('hidden', state.atBottom);
  if (badge) {
    badge.textContent = state.newWhileAway > 99 ? '99+' : state.newWhileAway;
    badge.classList.toggle('hidden', !state.newWhileAway);
  }
}

function jumpTo(mid) {
  const el = document.querySelector(`.bubble[data-bubble="${mid}"]`);
  if (!el) {
    toast('Сообщение не загружено', 'Прокрутите выше и нажмите «Загрузить ещё».', 'warn');
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('highlight');
  void el.offsetWidth;
  el.classList.add('highlight');
}

/* ──────────────────────────────────────────────────────────────────────────
   ОТПРАВКА
   ────────────────────────────────────────────────────────────────────────── */

function canSend() {
  if (!state.chatId || !state.peerId) return false;
  if (isBlocked(state.peerId)) {
    toast('Пользователь заблокирован', 'Разблокируйте его, чтобы писать.', 'warn');
    return false;
  }
  if (amIBlockedBy(state.peerId)) {
    toast('Сообщение не доставлено', 'Пользователь ограничил переписку.', 'warn');
    return false;
  }
  return true;
}

/** Короткое описание сообщения для превью в списке чатов. */
function previewOf(msg) {
  return {
    text: (msg.text || '').slice(0, 160),
    type: msg.type,
    senderId: msg.senderId,
    fileName: msg.media && msg.media.name ? msg.media.name : null,
    sticker: msg.sticker || null,
    createdAt: Date.now(),
    read: false
  };
}

/**
 * Базовая запись сообщения в БД + обновление метаданных чата и счётчика
 * непрочитанных у собеседника — одной атомарной операцией.
 */
async function writeMessage(payload) {
  const chatId = state.chatId;
  const peerId = state.peerId;
  const node = push(ref(ctx.db, P.messages(chatId)));
  const id = node.key;

  const msg = {
    id,
    chatId,
    senderId: ctx.uid,
    createdAt: Date.now(),
    type: 'text',
    text: '',
    ...payload
  };

  // Оптимистичная отрисовка: сообщение видно сразу, с часиками.
  state.messages.set(id, { ...msg, pending: true });
  state.order.push(id);
  renderAll();
  scrollToBottom(true);

  const updates = {};
  updates[`${P.messages(chatId)}/${id}`] = msg;
  updates[`${P.chat(chatId)}/lastMessage`] = previewOf(msg);
  updates[`${P.chat(chatId)}/updatedAt`] = serverTimestamp();

  updates[`${P.userChat(ctx.uid, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(ctx.uid, chatId)}/peerId`] = peerId;
  updates[`${P.userChat(ctx.uid, chatId)}/updatedAt`] = Date.now();

  updates[`${P.userChat(peerId, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(peerId, chatId)}/peerId`] = ctx.uid;
  updates[`${P.userChat(peerId, chatId)}/updatedAt`] = Date.now();
  updates[`${P.userChat(peerId, chatId)}/unread`] = increment(1);

  try {
    await update(ref(ctx.db), updates);
    logActivity('msg', peerId, { type: String(msg.type || 'text').slice(0, 20), len: (msg.text || '').length });
    const cur = state.messages.get(id);
    if (cur) { delete cur.pending; state.messages.set(id, cur); renderAll(); }
  } catch (err) {
    state.messages.delete(id);
    state.order = state.order.filter((x) => x !== id);
    renderAll();
    toast('Сообщение не отправлено', err.code || err.message, 'error');
    throw err;
  }

  stopTyping();
  return id;
}

/** Отправка/сохранение текста из композера. */
export async function sendFromComposer() {
  const input = $('messageInput');
  const text = input.value.trim();

  // Режим редактирования
  if (state.editing) {
    const m = state.messages.get(state.editing);
    if (!m) { cancelEdit(); return; }
    if (!text) { cancelEdit(); return; }

    try {
      await update(ref(ctx.db, P.message(state.chatId, m.id)), {
        text,
        editedAt: Date.now()
      });
      const meta = await get(ref(ctx.db, `${P.chat(state.chatId)}/lastMessage`));
      if (meta.exists() && meta.val().createdAt === m.createdAt) {
        await update(ref(ctx.db, `${P.chat(state.chatId)}/lastMessage`), { text: text.slice(0, 160) });
      }
      toast('Изменено', '', 'success');
    } catch (err) {
      toast('Не удалось изменить', err.code || err.message, 'error');
    }
    cancelEdit();
    return;
  }

  if (!text) return;
  if (!canSend()) return;

  input.value = '';
  autoGrow();

  const payload = { type: 'text', text };
  if (state.replyTo) payload.replyTo = state.replyTo;

  hideComposerContext();
  state.replyTo = null;

  await writeMessage(payload).catch(() => {});
}

/** Отправка медиа (вызывается из media.js после загрузки файла). */
export async function sendMediaMessage({ type, media, text }) {
  if (!canSend()) return null;
  const payload = { type, media, text: text || '' };
  if (state.replyTo) { payload.replyTo = state.replyTo; state.replyTo = null; hideComposerContext(); }
  return writeMessage(payload).catch(() => null);
}

/** Отправка стикера (эмодзи-стикер или картинка). */
export async function sendStickerMessage(sticker) {
  if (!canSend()) return;
  const payload = typeof sticker === 'string'
    ? { type: 'sticker', sticker }
    : { type: 'sticker', media: sticker };
  await writeMessage(payload).catch(() => {});
}

/** Отправка GIF. */
export async function sendGifMessage(media) {
  if (!canSend()) return;
  await writeMessage({ type: 'gif', media }).catch(() => {});
}

/** Системное сообщение о звонке (вызывается из calls.js). */
export async function appendCallMessage(chatId, peerId, info) {
  const node = push(ref(ctx.db, P.messages(chatId)));
  const msg = {
    id: node.key,
    chatId,
    senderId: ctx.uid,
    type: 'call',
    text: '',
    callVideo: !!info.video,
    callStatus: info.status,
    callDuration: info.duration || 0,
    createdAt: Date.now()
  };

  const updates = {};
  updates[`${P.messages(chatId)}/${msg.id}`] = msg;
  updates[`${P.chat(chatId)}/lastMessage`] = previewOf(msg);
  updates[`${P.userChat(ctx.uid, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(ctx.uid, chatId)}/peerId`] = peerId;
  updates[`${P.userChat(ctx.uid, chatId)}/updatedAt`] = Date.now();
  updates[`${P.userChat(peerId, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(peerId, chatId)}/peerId`] = ctx.uid;
  updates[`${P.userChat(peerId, chatId)}/updatedAt`] = Date.now();

  await update(ref(ctx.db), updates).catch((e) =>
    console.warn('[messages] appendCallMessage', e.code));
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕДАКТИРОВАНИЕ / УДАЛЕНИЕ / РЕАКЦИИ
   ────────────────────────────────────────────────────────────────────────── */

function startReply(mid) {
  const m = state.messages.get(mid);
  if (!m) return;
  const name = m.senderId === ctx.uid
    ? 'Вы'
    : displayName(cachedProfile(m.senderId));

  state.editing = null;
  state.replyTo = { id: m.id, senderId: m.senderId, name, text: previewText(m) };
  showComposerContext('reply', 'Ответ ' + name, state.replyTo.text);
  $('messageInput').focus();
}

function startEdit(mid) {
  const m = state.messages.get(mid);
  if (!m || m.senderId !== ctx.uid || m.deleted) return;

  state.replyTo = null;
  state.editing = mid;
  $('messageInput').value = m.text || '';
  autoGrow();
  showComposerContext('edit', 'Редактирование', previewText(m));
  $('cancelEditBtn').classList.remove('hidden');
  $('messageInput').focus();
}

function cancelEdit() {
  state.editing = null;
  $('messageInput').value = '';
  autoGrow();
  $('cancelEditBtn').classList.add('hidden');
  hideComposerContext();
}

function previewText(m) {
  if (m.deleted) return 'Сообщение удалено';
  if (m.text) return m.text.slice(0, 90);
  switch (m.type) {
    case 'image': return '📷 Фото';
    case 'video': return '🎬 Видео';
    case 'voice': return '🎤 Голосовое';
    case 'audio': return '🎵 Аудио';
    case 'file': return '📎 ' + ((m.media && m.media.name) || 'Файл');
    case 'gif': return 'GIF';
    case 'sticker': return (m.sticker || '🙂') + ' Стикер';
    default: return '';
  }
}

async function deleteMessage(mid, forAll) {
  const m = state.messages.get(mid);
  if (!m) return;

  try {
    if (forAll && m.senderId === ctx.uid) {
      // «Удалить у всех» — помечаем как удалённое, чтобы собеседник тоже увидел.
      await update(ref(ctx.db, P.message(state.chatId, mid)), {
        deleted: true,
        text: '',
        media: null,
        sticker: null,
        reactions: null
      });
      const lm = await get(ref(ctx.db, `${P.chat(state.chatId)}/lastMessage`));
      if (lm.exists() && lm.val().createdAt === m.createdAt) {
        await update(ref(ctx.db, `${P.chat(state.chatId)}/lastMessage`), {
          text: 'Сообщение удалено', type: 'text', fileName: null, sticker: null
        });
      }
    } else {
      await remove(ref(ctx.db, P.message(state.chatId, mid)));
    }
    toast('Удалено', '', 'success');
  } catch (err) {
    toast('Не удалось удалить', err.code || err.message, 'error');
  }
}

async function toggleReaction(mid, emoji) {
  const m = state.messages.get(mid);
  if (!m) return;
  const mine = m.reactions && m.reactions[ctx.uid];
  const path = `${P.message(state.chatId, mid)}/reactions/${ctx.uid}`;
  try {
    if (mine === emoji) await set(ref(ctx.db, path), null);
    else await set(ref(ctx.db, path), emoji);
  } catch (err) {
    toast('Не удалось поставить реакцию', err.code || err.message, 'error');
  }
}

async function pinMessage(mid) {
  const m = state.messages.get(mid);
  if (!m) return;
  try {
    await set(ref(ctx.db, `${P.chat(state.chatId)}/pinnedMessage`), {
      id: mid,
      text: previewText(m),
      by: ctx.uid,
      at: Date.now()
    });
    toast('Закреплено', '', 'success');
  } catch (err) {
    toast('Не удалось закрепить', err.code || err.message, 'error');
  }
}

async function unpinMessage() {
  await set(ref(ctx.db, `${P.chat(state.chatId)}/pinnedMessage`), null).catch(() => {});
}

function watchPinned() {
  const chatId = state.chatId;
  listen(ref(ctx.db, `${P.chat(chatId)}/pinnedMessage`), (snap) => {
    if (state.chatId !== chatId) return;
    const bar = $('pinnedBar');
    if (!snap.exists()) { bar.classList.add('hidden'); bar.dataset.mid = ''; return; }
    const v = snap.val();
    bar.classList.remove('hidden');
    bar.dataset.mid = v.id || '';
    $('pinnedText').textContent = v.text || 'Закреплённое сообщение';
  }, 'chat');
}

/* ──────────────────────────────────────────────────────────────────────────
   ПЕРЕСЫЛКА
   ────────────────────────────────────────────────────────────────────────── */

async function openForward(mid) {
  const m = state.messages.get(mid);
  if (!m) return;
  state.forwarding = m;

  $('forwardSearchInput').value = '';
  await renderForwardList('');
  openModal('modalForward');
}

async function renderForwardList(term) {
  const box = $('forwardList');
  const uids = new Set([...contactsState.contacts ? Object.keys(contactsState.contacts) : []]);

  // Плюс те, с кем уже есть чаты.
  const chatsSnap = await get(ref(ctx.db, P.userChats(ctx.uid))).catch(() => null);
  if (chatsSnap && chatsSnap.exists()) {
    Object.values(chatsSnap.val()).forEach((c) => { if (c && c.peerId) uids.add(c.peerId); });
  }

  const profiles = (await Promise.all([...uids].map((u) => fetchProfile(u)))).filter(Boolean);
  const lower = (term || '').toLowerCase();
  const visible = lower
    ? profiles.filter((p) =>
        displayName(p).toLowerCase().includes(lower) ||
        (p.username || '').toLowerCase().includes(lower))
    : profiles;

  if (!visible.length) {
    box.innerHTML = '<div class="empty-state small"><svg><use href="#i-users"/></svg><p>Некому переслать</p></div>';
    return;
  }

  box.innerHTML = visible.map((p) => `
    <button class="row-item" data-fwd="${p.uid}">
      ${avatarHtml(p, 'sm', { showPhoto: privacyAllows(p, 'avatar', isContact(p.uid)) })}
      <span class="row-body">
        <span class="row-top"><span class="row-name">${escapeHtml(displayName(p))}</span></span>
        <span class="row-bottom"><span class="row-text">@${escapeHtml(p.username || '')}</span></span>
      </span>
      <span class="row-icon"><svg><use href="#i-forward"/></svg></span>
    </button>`).join('');
}

async function doForward(targetUid) {
  const m = state.forwarding;
  if (!m) return;

  const { ensurePrivateChat } = await import('./chat.js');
  const chatId = await ensurePrivateChat(targetUid);

  const node = push(ref(ctx.db, P.messages(chatId)));
  const fromName = m.senderId === ctx.uid
    ? displayName(ctx.profile)
    : displayName(cachedProfile(m.senderId));

  const msg = {
    id: node.key,
    chatId,
    senderId: ctx.uid,
    type: m.type,
    text: m.text || '',
    media: m.media || null,
    sticker: m.sticker || null,
    forwardFrom: { uid: m.senderId, name: fromName },
    createdAt: Date.now()
  };

  const updates = {};
  updates[`${P.messages(chatId)}/${msg.id}`] = msg;
  updates[`${P.chat(chatId)}/lastMessage`] = previewOf(msg);
  updates[`${P.userChat(ctx.uid, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(ctx.uid, chatId)}/peerId`] = targetUid;
  updates[`${P.userChat(ctx.uid, chatId)}/updatedAt`] = Date.now();
  updates[`${P.userChat(targetUid, chatId)}/chatId`] = chatId;
  updates[`${P.userChat(targetUid, chatId)}/peerId`] = ctx.uid;
  updates[`${P.userChat(targetUid, chatId)}/updatedAt`] = Date.now();
  updates[`${P.userChat(targetUid, chatId)}/unread`] = increment(1);

  try {
    await update(ref(ctx.db), updates);
    closeModal();
    state.forwarding = null;
    const p = await fetchProfile(targetUid);
    toast('Переслано', displayName(p), 'success');
  } catch (err) {
    toast('Не удалось переслать', err.code || err.message, 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   TYPING
   ────────────────────────────────────────────────────────────────────────── */

function sendTyping() {
  if (!state.chatId) return;
  const now = Date.now();
  if (now - state.typingSentAt < 2500) return;
  state.typingSentAt = now;
  set(ref(ctx.db, P.typingUser(state.chatId, ctx.uid)), now).catch(() => {});

  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTyping, 5000);
}

function stopTyping() {
  clearTimeout(state.typingTimer);
  state.typingSentAt = 0;
  if (!state.chatId) return;
  set(ref(ctx.db, P.typingUser(state.chatId, ctx.uid)), null).catch(() => {});
}

function watchTyping() {
  const chatId = state.chatId;
  const peer = state.peerId;

  listen(ref(ctx.db, P.typingUser(chatId, peer)), (snap) => {
    if (state.chatId !== chatId) return;
    const ts = snap.val();
    const active = !!ts && Date.now() - ts < 6000;

    $('typingIndicator').classList.toggle('hidden', !active);
    const st = $('chatPeerStatus');
    if (active) {
      $('typingText').textContent = `${displayName(cachedProfile(peer))} печатает…`;
      st.textContent = 'печатает…';
      st.classList.add('typing');
      setTimeout(() => {
        if (state.chatId === chatId) {
          const stillTs = ts;
          if (Date.now() - stillTs >= 6000) {
            $('typingIndicator').classList.add('hidden');
            st.classList.remove('typing');
          }
        }
      }, 6200);
    } else {
      st.classList.remove('typing');
    }
  }, 'chat');
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОИСК ПО ЧАТУ
   ────────────────────────────────────────────────────────────────────────── */

export function setChatSearchActive(on) {
  state.searchActive = on;
  const bar = $('chatSearchBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !on);
  if (on) {
    setTimeout(() => $('chatSearchInput').focus(), 80);
  } else {
    state.searchTerm = '';
    state.searchHits = [];
    state.searchIndex = -1;
    $('chatSearchInput').value = '';
    $('chatSearchCount').textContent = '';
    renderAll();
  }
}

function runChatSearch() {
  const term = $('chatSearchInput').value.trim();
  state.searchTerm = term;

  if (!term) {
    state.searchHits = [];
    state.searchIndex = -1;
    $('chatSearchCount').textContent = '';
    renderAll();
    return;
  }

  const lower = term.toLowerCase();
  state.searchHits = state.order.filter((id) => {
    const m = state.messages.get(id);
    return m && !m.deleted && (m.text || '').toLowerCase().includes(lower);
  });

  state.searchIndex = state.searchHits.length ? state.searchHits.length - 1 : -1;
  renderAll();
  updateSearchCount();
  if (state.searchIndex >= 0) jumpTo(state.searchHits[state.searchIndex]);
}

function updateSearchCount() {
  const el = $('chatSearchCount');
  if (!state.searchHits.length) {
    el.textContent = state.searchTerm ? 'нет совпадений' : '';
    return;
  }
  el.textContent = `${state.searchIndex + 1} / ${state.searchHits.length}`;
}

function stepSearch(delta) {
  if (!state.searchHits.length) return;
  state.searchIndex = (state.searchIndex + delta + state.searchHits.length) % state.searchHits.length;
  updateSearchCount();
  jumpTo(state.searchHits[state.searchIndex]);
}

/* ──────────────────────────────────────────────────────────────────────────
   КОМПОЗЕР
   ────────────────────────────────────────────────────────────────────────── */

function autoGrow() {
  const el = $('messageInput');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  updateSendButton();
}

function updateSendButton() {
  const has = $('messageInput').value.trim().length > 0 || state.editing;
  $('sendBtn').classList.toggle('hidden', !has);
  $('voiceBtn').classList.toggle('hidden', !!has);
}

function showComposerContext(kind, title, text) {
  const box = $('composerContext');
  box.classList.remove('hidden');
  $('composerContextIcon').querySelector('use')
    .setAttribute('href', kind === 'edit' ? '#i-edit' : '#i-reply');
  $('composerContextTitle').textContent = title;
  $('composerContextText').textContent = text;
}

function hideComposerContext() {
  $('composerContext').classList.add('hidden');
  $('cancelEditBtn').classList.add('hidden');
}

export function clearComposer() {
  $('messageInput').value = '';
  state.replyTo = null;
  state.editing = null;
  hideComposerContext();
  autoGrow();
}

/** Вставляет текст (эмодзи) в позицию курсора. */
export function insertIntoComposer(text) {
  const el = $('messageInput');
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.focus();
  autoGrow();
  sendTyping();
}

/** Текущий reply — нужен media.js, чтобы прикрепить его к файлу. */
export function currentReply() { return state.replyTo; }

/* ──────────────────────────────────────────────────────────────────────────
   КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ
   ────────────────────────────────────────────────────────────────────────── */

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉'];

function showReactionBar(mid, x, y) {
  const bar = $('reactionBar');
  bar.innerHTML = QUICK_REACTIONS
    .map((e) => `<button data-quick-react="${e}" data-mid="${mid}">${e}</button>`).join('');
  bar.classList.remove('hidden');

  const w = QUICK_REACTIONS.length * 38 + 14;
  const left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8));
  const top = Math.max(8, y - 56);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function hideReactionBar() {
  $('reactionBar').classList.add('hidden');
}

async function showMessageMenu(mid, x, y) {
  const m = state.messages.get(mid);
  if (!m) return;
  const mine = m.senderId === ctx.uid;
  state.menuMessageId = mid;

  showReactionBar(mid, x, y);

  const items = [
    { icon: 'i-reply', label: 'Ответить', action: () => startReply(mid), hidden: m.deleted },
    {
      icon: 'i-copy',
      label: 'Копировать текст',
      hidden: !m.text || m.deleted,
      action: () => { copyText(m.text); toast('Скопировано', '', 'success'); }
    },
    { icon: 'i-forward', label: 'Переслать', action: () => openForward(mid), hidden: m.deleted },
    { icon: 'i-edit', label: 'Изменить', action: () => startEdit(mid), hidden: !mine || m.deleted || !m.text },
    { icon: 'i-pin', label: 'Закрепить', action: () => pinMessage(mid), hidden: m.deleted },
    {
      icon: 'i-download',
      label: 'Скачать файл',
      hidden: !m.media || !(m.media.url || m.media.chunked),
      action: () => window.open(hydrateMedia(m).url, '_blank', 'noopener')
    },
    { separator: true },
    {
      icon: 'i-trash',
      label: mine ? 'Удалить у всех' : 'Удалить у себя',
      danger: true,
      action: async () => {
        const ok = await confirmDialog({
          title: 'Удалить сообщение',
          text: mine
            ? 'Сообщение будет помечено как удалённое у обоих собеседников.'
            : 'Сообщение исчезнет только из вашей ленты.',
          okText: 'Удалить'
        });
        if (ok) await deleteMessage(mid, mine);
      }
    }
  ];

  openContextMenu('msgMenu', items, x, y, hideReactionBar);
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initMessagesUI() {
  const input = $('messageInput');

  input.addEventListener('input', () => { autoGrow(); sendTyping(); });
  input.addEventListener('blur', stopTyping);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromComposer();
    } else if (e.key === 'Escape') {
      if (state.editing) cancelEdit();
      else if (state.replyTo) { state.replyTo = null; hideComposerContext(); }
    } else if (e.key === 'ArrowUp' && !input.value.trim()) {
      // Быстрое редактирование последнего своего сообщения.
      const lastMine = [...state.order].reverse()
        .map((id) => state.messages.get(id))
        .find((m) => m && m.senderId === ctx.uid && m.text && !m.deleted);
      if (lastMine) { e.preventDefault(); startEdit(lastMine.id); }
    }
  });

  $('sendBtn').addEventListener('click', sendFromComposer);
  $('cancelEditBtn').addEventListener('click', cancelEdit);
  $('composerContextClose').addEventListener('click', () => {
    if (state.editing) cancelEdit();
    else { state.replyTo = null; hideComposerContext(); }
  });

  // Прокрутка
  const scroller = $('messagesScroll');
  scroller.addEventListener('scroll', () => {
    const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const wasBottom = state.atBottom;
    state.atBottom = dist < 90;
    if (state.atBottom) {
      state.newWhileAway = 0;
      if (!wasBottom) markIncomingRead();
    }
    updateScrollDownBtn();

    if (scroller.scrollTop < 80 && state.hasMore && !state.loadingMore) loadMore();
  }, { passive: true });

  $('scrollDownBtn').addEventListener('click', () => scrollToBottom(true));
  $('loadMoreBtn').addEventListener('click', loadMore);

  // Клики внутри ленты
  $('messagesList').addEventListener('click', (e) => {
    const lb = e.target.closest('[data-lightbox]');
    if (lb) { openLightbox(lb.dataset.lightbox, lb.dataset.caption || ''); return; }

    const react = e.target.closest('[data-react]');
    if (react) { toggleReaction(react.dataset.mid, react.dataset.react); return; }

    const jump = e.target.closest('[data-jump]');
    if (jump && jump.dataset.jump) { jumpTo(jump.dataset.jump); return; }

    const playBtn = e.target.closest('[data-audio-play]');
    if (playBtn) {
      const holder = playBtn.closest('[data-audio]');
      playAudioMessage(holder);
      return;
    }
  });

  // Контекстное меню сообщения
  $('messagesList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row) return;
    e.preventDefault();
    showMessageMenu(row.dataset.mid, e.clientX, e.clientY);
  });

  let hold = null;
  $('messagesList').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.msg-row');
    if (!row) return;
    const touch = e.touches[0];
    hold = setTimeout(() => {
      hold = null;
      if (navigator.vibrate) navigator.vibrate(12);
      showMessageMenu(row.dataset.mid, touch.clientX, touch.clientY);
    }, 480);
  }, { passive: true });
  const cancelHold = () => { if (hold) { clearTimeout(hold); hold = null; } };
  $('messagesList').addEventListener('touchend', cancelHold);
  $('messagesList').addEventListener('touchmove', cancelHold, { passive: true });

  // Двойной клик — быстрый ответ
  $('messagesList').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.msg-row');
    if (row) startReply(row.dataset.mid);
  });

  // Быстрые реакции
  $('reactionBar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-react]');
    if (!btn) return;
    toggleReaction(btn.dataset.mid, btn.dataset.quickReact);
    hideReactionBar();
    $('msgMenu').classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#reactionBar') && !e.target.closest('#msgMenu')) hideReactionBar();
  });

  // Поиск по чату
  $('chatSearchBtn').addEventListener('click', () => setChatSearchActive(!state.searchActive));
  $('chatSearchClose').addEventListener('click', () => setChatSearchActive(false));
  let searchTimer;
  $('chatSearchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runChatSearch, 260);
  });
  $('chatSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') setChatSearchActive(false);
  });
  $('chatSearchPrev').addEventListener('click', () => stepSearch(-1));
  $('chatSearchNext').addEventListener('click', () => stepSearch(1));

  // Закреплённое
  $('pinnedBar').addEventListener('click', (e) => {
    if (e.target.closest('#pinnedUnpin')) { unpinMessage(); return; }
    const mid = $('pinnedBar').dataset.mid;
    if (mid) jumpTo(mid);
  });

  // Пересылка
  let fwdTimer;
  $('forwardSearchInput').addEventListener('input', () => {
    clearTimeout(fwdTimer);
    fwdTimer = setTimeout(() => renderForwardList($('forwardSearchInput').value.trim()), 260);
  });
  $('forwardList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-fwd]');
    if (row) doForward(row.dataset.fwd);
  });

  autoGrow();
}

export { state as messagesState, startReply, previewText };

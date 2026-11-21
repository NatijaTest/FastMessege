/**
 * FastMessage — chat.js
 * ----------------------------------------------------------------------------
 * Список чатов, открытие чата, шапка чата, статусы собеседника,
 * закрепление / архив / без звука / удаление чата, глобальный поиск.
 *
 * Структура данных:
 *   chats/{chatId}            — метаданные чата (участники, последнее сообщение)
 *   userChats/{uid}/{chatId}  — личная проекция чата для пользователя
 *                               (unread, pinned, archived, muted)
 */

import {
  ctx, P, privateChatId,
  ref, get, set, update, remove, serverTimestamp,
  listen, untrackGroup, emit, on
} from './firebase.js';

import {
  $, toast, escapeHtml, formatChatTime, t, confirmDialog,
  isMobile, openContextMenu
} from './app.js';

import {
  fetchProfile, watchProfile, watchPresence, displayName, avatarHtml,
  badgesHtml, presenceText, privacyAllows, cachedProfile, cachedPresence
} from './profile.js';

import {
  isContact, isBlocked, checkBlockedBy, amIBlockedBy,
  openUserInfo, closeUserInfo, searchUsers, userRowHtml, blockUser, unblockUser
} from './contacts.js';

import {
  openMessages, closeMessages, clearComposer, setChatSearchActive
} from './messages.js';

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  /** chatId -> userChat-запись */
  chats: {},
  /** chatId -> метаданные chats/{chatId} */
  meta: {},
  /** активный чат */
  activeChatId: null,
  activePeerUid: null,
  filter: 'all',
  searchTerm: '',
  /** отписки, привязанные к активному чату */
  peerUnsubs: [],
  /** chatId -> true, пока подписка на meta уже создана */
  metaWatched: new Set()
};

export function activeChatId() { return state.activeChatId; }
export function activePeerUid() { return state.activePeerUid; }
export function chatRecord(chatId) { return state.chats[chatId] || null; }
export function chatMeta(chatId) { return state.meta[chatId] || null; }

/* ──────────────────────────────────────────────────────────────────────────
   ПОДПИСКА НА СПИСОК ЧАТОВ
   ────────────────────────────────────────────────────────────────────────── */

export function startChatsListener() {
  listen(ref(ctx.db, P.userChats(ctx.uid)), (snap) => {
    state.chats = snap.val() || {};

    // Для каждого чата держим подписку на его метаданные —
    // так последнее сообщение и typing обновляются мгновенно.
    Object.keys(state.chats).forEach(watchChatMeta);

    renderChatList();
    updateUnreadBadges();
  }, 'session');
}

function watchChatMeta(chatId) {
  if (state.metaWatched.has(chatId)) return;
  state.metaWatched.add(chatId);

  listen(ref(ctx.db, P.chat(chatId)), (snap) => {
    if (!snap.exists()) {
      delete state.meta[chatId];
      return;
    }
    state.meta[chatId] = snap.val();

    // Профиль собеседника нужен для имени в списке.
    const peer = peerOf(snap.val());
    if (peer) watchProfile(peer, () => renderChatList(), 'session');

    renderChatList();
  }, 'session');

  // Индикатор «печатает» в списке чатов.
  listen(ref(ctx.db, P.typing(chatId)), (snap) => {
    const typing = snap.val() || {};
    const meta = state.meta[chatId];
    const peer = meta ? peerOf(meta) : null;
    const isTyping = !!(peer && typing[peer] && Date.now() - typing[peer] < 6000);

    const row = document.querySelector(`#chatList .row-item[data-chat="${chatId}"] .row-text`);
    if (row) {
      if (isTyping) row.innerHTML = '<span class="typing-now">печатает…</span>';
      else renderChatList();
    }
  }, 'session');
}

/** uid собеседника в приватном чате. */
export function peerOf(meta) {
  if (!meta || !meta.members) return null;
  return Object.keys(meta.members).find((u) => u !== ctx.uid) || null;
}

export function resetChatState() {
  state.chats = {};
  state.meta = {};
  state.activeChatId = null;
  state.activePeerUid = null;
  state.metaWatched.clear();
  state.searchTerm = '';
  clearPeerWatchers();
  $('chatView').classList.add('hidden');
  $('chatPlaceholder').classList.remove('hidden');
  $('chatList').innerHTML = '';
}

function clearPeerWatchers() {
  state.peerUnsubs.forEach((u) => { try { u(); } catch (e) { /* noop */ } });
  state.peerUnsubs = [];
}

/* ──────────────────────────────────────────────────────────────────────────
   СОЗДАНИЕ / ОТКРЫТИЕ ЧАТА
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Гарантирует существование приватного чата с пользователем.
 * Возвращает chatId.
 */
export async function ensurePrivateChat(peerUid) {
  const chatId = privateChatId(ctx.uid, peerUid);
  const metaRef = ref(ctx.db, P.chat(chatId));
  const snap = await get(metaRef);

  if (!snap.exists()) {
    await set(metaRef, {
      id: chatId,
      type: 'private',
      members: { [ctx.uid]: true, [peerUid]: true },
      createdBy: ctx.uid,
      createdAt: serverTimestamp(),
      lastMessage: null
    });
  }

  // Личная проекция — создаём обеим сторонам, чтобы чат появился у собеседника.
  const mine = await get(ref(ctx.db, P.userChat(ctx.uid, chatId)));
  if (!mine.exists()) {
    await set(ref(ctx.db, P.userChat(ctx.uid, chatId)), {
      chatId,
      peerId: peerUid,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
      updatedAt: serverTimestamp()
    });
  }

  return chatId;
}

/** Открывает чат с пользователем (создавая его при необходимости). */
export async function openChatWith(peerUid) {
  if (!peerUid || peerUid === ctx.uid) return;
  try {
    const chatId = await ensurePrivateChat(peerUid);
    await openChat(chatId, peerUid);
  } catch (err) {
    console.error('[chat] openChatWith', err);
    toast('Не удалось открыть чат', err.message, 'error');
  }
}

/** Открывает уже существующий чат. */
export async function openChat(chatId, peerUid) {
  if (!chatId) return;

  // Сначала глушим слушатели предыдущего чата.
  untrackGroup('chat');
  clearPeerWatchers();
  setChatSearchActive(false);

  state.activeChatId = chatId;
  state.activePeerUid = peerUid || (state.meta[chatId] ? peerOf(state.meta[chatId]) : null);

  if (!state.activePeerUid) {
    const snap = await get(ref(ctx.db, P.chat(chatId)));
    if (snap.exists()) {
      state.meta[chatId] = snap.val();
      state.activePeerUid = peerOf(snap.val());
    }
  }

  const peer = state.activePeerUid;
  if (!peer) return;

  $('chatPlaceholder').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  document.querySelector('.app-screen').classList.add('chat-open');

  clearComposer();
  renderChatList();

  // Шапка: имя, аватар, статус — живые.
  const paintHead = (p) => {
    if (!p || state.activePeerUid !== peer) return;
    const contact = isContact(peer);
    const showPhoto = privacyAllows(p, 'avatar', contact);

    $('chatPeerAvatar').outerHTML = avatarHtml(p, 'sm', {
      showPhoto, id: 'chatPeerAvatar', presence: cachedPresence(peer)
    });
    $('chatPeerName').innerHTML = `${escapeHtml(displayName(p))} ${badgesHtml(p)}`;
    paintStatus();
  };

  const paintStatus = () => {
    if (state.activePeerUid !== peer) return;
    const p = cachedProfile(peer);
    const el = $('chatPeerStatus');
    const pres = cachedPresence(peer);
    el.textContent = presenceText(p, pres, isContact(peer));
    el.classList.toggle('online', !!(pres && pres.online));
  };

  state.peerUnsubs.push(watchProfile(peer, paintHead, 'chat'));
  state.peerUnsubs.push(watchPresence(peer, () => {
    paintStatus();
    const dot = $('chatPeerAvatar') && $('chatPeerAvatar').parentElement
      ? $('chatPeerAvatar').parentElement.querySelector('.presence-dot')
      : null;
    if (dot) dot.classList.toggle('online', cachedPresence(peer).online);
  }, 'chat'));

  // Блокировки
  await checkBlockedBy(peer);
  renderBlockedBar(peer);

  // Лента сообщений
  await openMessages(chatId, peer);

  // Сбрасываем счётчик непрочитанных
  await update(ref(ctx.db, P.userChat(ctx.uid, chatId)), { unread: 0 }).catch(() => {});

  emit('chat:opened', { chatId, peer });
}

export function closeChat() {
  untrackGroup('chat');
  clearPeerWatchers();
  closeMessages();
  state.activeChatId = null;
  state.activePeerUid = null;
  $('chatView').classList.add('hidden');
  $('chatPlaceholder').classList.remove('hidden');
  document.querySelector('.app-screen').classList.remove('chat-open');
  closeUserInfo();
  renderChatList();
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОЛОСА БЛОКИРОВКИ
   ────────────────────────────────────────────────────────────────────────── */

export function renderBlockedBar(peerUid) {
  const bar = $('blockedBar');
  const composer = $('composer');
  if (!bar || !composer) return;

  const iBlocked = isBlocked(peerUid);
  const theyBlocked = amIBlockedBy(peerUid);

  if (!iBlocked && !theyBlocked) {
    bar.classList.add('hidden');
    composer.classList.remove('hidden');
    return;
  }

  bar.classList.remove('hidden');
  composer.classList.add('hidden');

  if (iBlocked) {
    $('blockedBarText').textContent = 'Вы заблокировали этого пользователя';
    $('blockedBarAction').classList.remove('hidden');
    $('blockedBarAction').textContent = 'Разблокировать';
  } else {
    $('blockedBarText').textContent = 'Вы не можете писать этому пользователю';
    $('blockedBarAction').classList.add('hidden');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ДЕЙСТВИЯ НАД ЧАТОМ
   ────────────────────────────────────────────────────────────────────────── */

export async function togglePin(chatId) {
  const rec = state.chats[chatId];
  await update(ref(ctx.db, P.userChat(ctx.uid, chatId)), { pinned: !(rec && rec.pinned) });
}

export async function toggleArchive(chatId) {
  const rec = state.chats[chatId];
  const next = !(rec && rec.archived);
  await update(ref(ctx.db, P.userChat(ctx.uid, chatId)), { archived: next, pinned: false });
  if (next && state.activeChatId === chatId) closeChat();
  toast(next ? 'Чат в архиве' : 'Чат возвращён', '', 'success');
}

export async function toggleMute(chatId) {
  const rec = state.chats[chatId];
  await update(ref(ctx.db, P.userChat(ctx.uid, chatId)), { muted: !(rec && rec.muted) });
}

export async function markRead(chatId) {
  await update(ref(ctx.db, P.userChat(ctx.uid, chatId)), { unread: 0 }).catch(() => {});
}

/** Удаляет чат только у себя: своя проекция + свои счётчики. */
export async function deleteChatForMe(chatId) {
  await remove(ref(ctx.db, P.userChat(ctx.uid, chatId)));
  if (state.activeChatId === chatId) closeChat();
  toast('Чат удалён', 'Он убран только у вас.', 'success');
}

/* ──────────────────────────────────────────────────────────────────────────
   ОТРИСОВКА СПИСКА ЧАТОВ
   ────────────────────────────────────────────────────────────────────────── */

function lastMessagePreview(meta) {
  const lm = meta && meta.lastMessage;
  if (!lm) return '<span style="opacity:.6">Нет сообщений</span>';

  const mine = lm.senderId === ctx.uid;
  const prefix = mine ? '<svg><use href="#i-check"/></svg>' : '';

  let text;
  switch (lm.type) {
    case 'image':   text = '📷 Фото'; break;
    case 'video':   text = '🎬 Видео'; break;
    case 'audio':   text = '🎵 Аудио'; break;
    case 'voice':   text = '🎤 Голосовое сообщение'; break;
    case 'file':    text = '📎 ' + (lm.fileName || 'Документ'); break;
    case 'gif':     text = 'GIF'; break;
    case 'sticker': text = (lm.sticker || '🙂') + ' Стикер'; break;
    case 'call':    text = '📞 Звонок'; break;
    default:        text = lm.deleted ? 'Сообщение удалено' : (lm.text || '');
  }

  return prefix + escapeHtml(String(text).slice(0, 120));
}

export function renderChatList() {
  const box = $('chatList');
  const empty = $('chatListEmpty');
  if (!box) return;

  // Глобальный поиск показывает свою ленту.
  if (state.searchTerm) return;

  let items = Object.values(state.chats).filter((c) => c && c.chatId);

  if (state.filter === 'archived') items = items.filter((c) => c.archived);
  else if (state.filter === 'unread') items = items.filter((c) => !c.archived && c.unread > 0);
  else items = items.filter((c) => !c.archived);

  items.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
    const ta = (state.meta[a.chatId] && state.meta[a.chatId].lastMessage &&
                state.meta[a.chatId].lastMessage.createdAt) || a.updatedAt || 0;
    const tb = (state.meta[b.chatId] && state.meta[b.chatId].lastMessage &&
                state.meta[b.chatId].lastMessage.createdAt) || b.updatedAt || 0;
    return tb - ta;
  });

  if (!items.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    const h = empty.querySelector('h3');
    const p = empty.querySelector('p');
    if (state.filter === 'archived') { h.textContent = 'Архив пуст'; p.textContent = 'Сюда попадают скрытые чаты.'; }
    else if (state.filter === 'unread') { h.textContent = 'Всё прочитано'; p.textContent = 'Непрочитанных сообщений нет.'; }
    else { h.textContent = 'Пока нет чатов'; p.textContent = 'Найдите человека по @username и начните переписку.'; }
    return;
  }
  empty.classList.add('hidden');

  box.innerHTML = items.map((c) => {
    const meta = state.meta[c.chatId];
    const peerUid = c.peerId || (meta ? peerOf(meta) : null);
    const p = peerUid ? cachedProfile(peerUid) : null;
    const name = p ? displayName(p) : 'Загрузка…';
    const showPhoto = p ? privacyAllows(p, 'avatar', isContact(peerUid)) : false;
    const lm = meta && meta.lastMessage;
    const time = lm && lm.createdAt ? formatChatTime(lm.createdAt) : '';
    const unread = c.unread || 0;

    const avatar = p
      ? avatarHtml(p, 'md', { showPhoto, presence: cachedPresence(peerUid) })
      : '<span class="avatar md"><span>…</span></span>';

    const statusIcon = (lm && lm.senderId === ctx.uid && !unread)
      ? `<span class="msg-status ${lm.read ? 'read' : ''}"><svg><use href="#i-${lm.read ? 'check-double' : 'check'}"/></svg></span>`
      : '';

    return `
      <button class="row-item ${state.activeChatId === c.chatId ? 'active' : ''}"
              data-chat="${c.chatId}" data-peer="${peerUid || ''}">
        ${avatar}
        <span class="row-body">
          <span class="row-top">
            <span class="row-name">${escapeHtml(name)} ${p ? badgesHtml(p) : ''}</span>
            ${c.pinned ? '<span class="row-icon"><svg><use href="#i-pin"/></svg></span>' : ''}
            <span class="row-time">${time}</span>
          </span>
          <span class="row-bottom">
            <span class="row-text">${lastMessagePreview(meta)}</span>
            <span class="row-meta">
              ${statusIcon}
              ${c.muted ? '<span class="row-icon"><svg><use href="#i-bell-off"/></svg></span>' : ''}
              ${unread ? `<span class="row-badge ${c.muted ? 'muted' : ''}">${unread > 99 ? '99+' : unread}</span>` : ''}
            </span>
          </span>
        </span>
      </button>
    `;
  }).join('');

  // Профили, которых ещё нет в кэше, подтянутся и перерисуют список.
  items.forEach((c) => {
    const meta = state.meta[c.chatId];
    const peerUid = c.peerId || (meta ? peerOf(meta) : null);
    if (peerUid && !cachedProfile(peerUid)) {
      fetchProfile(peerUid).then((p) => { if (p) renderChatList(); });
    }
  });
}

/** Суммарный счётчик непрочитанных для бейджей на вкладках. */
export function updateUnreadBadges() {
  const total = Object.values(state.chats)
    .filter((c) => c && !c.archived && !c.muted)
    .reduce((sum, c) => sum + (c.unread || 0), 0);

  [$('tabBadgeChats'), $('mobileBadgeChats')].forEach((el) => {
    if (!el) return;
    el.textContent = total > 99 ? '99+' : total;
    el.classList.toggle('hidden', total === 0);
  });

  document.title = total ? `(${total}) FastMessage` : 'FastMessage';
  emit('unread:total', total);
}

/* ──────────────────────────────────────────────────────────────────────────
   ГЛОБАЛЬНЫЙ ПОИСК
   ────────────────────────────────────────────────────────────────────────── */

let globalSearchTimer;

async function runGlobalSearch(term) {
  const box = $('globalSearchResults');
  const list = $('chatList');
  const empty = $('chatListEmpty');
  const filters = $('chatFilters');

  state.searchTerm = term;

  if (!term) {
    box.classList.add('hidden');
    box.innerHTML = '';
    list.classList.remove('hidden');
    filters.classList.remove('hidden');
    renderChatList();
    return;
  }

  list.classList.add('hidden');
  empty.classList.add('hidden');
  filters.classList.add('hidden');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="skel-row"><div class="skeleton skel-circle"></div><div class="skel-lines"><div class="skeleton skel-line"></div><div class="skeleton skel-line short"></div></div></div>';

  const lower = term.toLowerCase();

  // Локально: чаты, чей собеседник подходит по имени.
  const localRows = [];
  for (const c of Object.values(state.chats)) {
    const meta = state.meta[c.chatId];
    const peerUid = c.peerId || (meta ? peerOf(meta) : null);
    const p = peerUid ? cachedProfile(peerUid) : null;
    if (!p) continue;
    if (displayName(p).toLowerCase().includes(lower) ||
        (p.username || '').toLowerCase().includes(lower)) {
      localRows.push({ chat: c, profile: p });
    }
  }

  const users = await searchUsers(term);
  const localUids = new Set(localRows.map((r) => r.profile.uid));
  const newUsers = users.filter((u) => !localUids.has(u.uid));

  let html = '';

  if (localRows.length) {
    html += '<div class="list-section-title">Чаты</div><div class="list">';
    html += localRows.map(({ chat, profile }) => `
      <button class="row-item" data-chat="${chat.chatId}" data-peer="${profile.uid}">
        ${avatarHtml(profile, 'md', { showPhoto: privacyAllows(profile, 'avatar', isContact(profile.uid)) })}
        <span class="row-body">
          <span class="row-top"><span class="row-name">${escapeHtml(displayName(profile))} ${badgesHtml(profile)}</span></span>
          <span class="row-bottom"><span class="row-text">@${escapeHtml(profile.username || '')}</span></span>
        </span>
      </button>
    `).join('');
    html += '</div>';
  }

  if (newUsers.length) {
    html += '<div class="list-section-title">Люди</div><div class="list">';
    html += newUsers.map((p) => userRowHtml(p)).join('');
    html += '</div>';
  }

  if (!html) {
    html = '<div class="empty-state small"><svg><use href="#i-search"/></svg><p>Ничего не найдено</p></div>';
  }

  box.innerHTML = html;
}

/* ──────────────────────────────────────────────────────────────────────────
   КОНТЕКСТНОЕ МЕНЮ ЧАТА
   ────────────────────────────────────────────────────────────────────────── */

async function showChatMenu(chatId, x, y) {
  const rec = state.chats[chatId];
  if (!rec) return;
  const peerUid = rec.peerId;

  const items = [
    {
      icon: 'i-pin',
      label: rec.pinned ? 'Открепить' : 'Закрепить',
      action: () => togglePin(chatId)
    },
    {
      icon: rec.muted ? 'i-bell' : 'i-bell-off',
      label: rec.muted ? 'Включить уведомления' : 'Без звука',
      action: () => toggleMute(chatId)
    },
    {
      icon: 'i-archive',
      label: rec.archived ? 'Вернуть из архива' : 'В архив',
      action: () => toggleArchive(chatId)
    },
    {
      icon: 'i-check-double',
      label: 'Отметить прочитанным',
      action: () => markRead(chatId),
      hidden: !rec.unread
    },
    { separator: true },
    {
      icon: 'i-info',
      label: 'Профиль',
      action: () => openUserInfo(peerUid),
      hidden: !peerUid
    },
    {
      icon: 'i-ban',
      label: isBlocked(peerUid) ? 'Разблокировать' : 'Заблокировать',
      danger: !isBlocked(peerUid),
      hidden: !peerUid,
      action: async () => {
        if (isBlocked(peerUid)) await unblockUser(peerUid);
        else await blockUser(peerUid);
        if (state.activePeerUid === peerUid) renderBlockedBar(peerUid);
      }
    },
    {
      icon: 'i-trash',
      label: 'Удалить чат',
      danger: true,
      action: async () => {
        const ok = await confirmDialog({
          title: 'Удалить чат',
          text: 'Чат исчезнет только у вас. У собеседника переписка сохранится.',
          okText: 'Удалить'
        });
        if (ok) await deleteChatForMe(chatId);
      }
    }
  ];

  openContextMenu('chatMenu', items, x, y);
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initChatUI() {
  // Клик по чату
  $('chatList').addEventListener('click', (e) => {
    const row = e.target.closest('.row-item');
    if (!row) return;
    openChat(row.dataset.chat, row.dataset.peer || null);
  });

  // Контекстное меню: правый клик и долгое нажатие
  $('chatList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row-item');
    if (!row) return;
    e.preventDefault();
    showChatMenu(row.dataset.chat, e.clientX, e.clientY);
  });

  let holdTimer = null;
  $('chatList').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.row-item');
    if (!row) return;
    const touch = e.touches[0];
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      showChatMenu(row.dataset.chat, touch.clientX, touch.clientY);
    }, 520);
  }, { passive: true });
  const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  $('chatList').addEventListener('touchend', cancelHold);
  $('chatList').addEventListener('touchmove', cancelHold, { passive: true });

  // Фильтры
  $('chatFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('#chatFilters .chip').forEach((c) => {
      c.classList.toggle('active', c === chip);
    });
    renderChatList();
  });

  // Результаты глобального поиска
  $('globalSearchResults').addEventListener('click', (e) => {
    const row = e.target.closest('.row-item');
    if (!row) return;
    if (row.dataset.chat) openChat(row.dataset.chat, row.dataset.peer || null);
    else if (row.dataset.uid) openChatWith(row.dataset.uid);
    $('globalSearchInput').value = '';
    $('globalSearchClear').classList.add('hidden');
    runGlobalSearch('');
  });

  // Поле поиска
  const input = $('globalSearchInput');
  input.addEventListener('input', () => {
    const term = input.value.trim();
    $('globalSearchClear').classList.toggle('hidden', !term);
    clearTimeout(globalSearchTimer);
    globalSearchTimer = setTimeout(() => runGlobalSearch(term), 320);
  });
  $('globalSearchClear').addEventListener('click', () => {
    input.value = '';
    $('globalSearchClear').classList.add('hidden');
    runGlobalSearch('');
    input.focus();
  });

  // Шапка чата
  $('chatBackBtn').addEventListener('click', () => {
    document.querySelector('.app-screen').classList.remove('chat-open');
    closeUserInfo();
  });

  $('chatHeadPeer').addEventListener('click', () => {
    if (state.activePeerUid) openUserInfo(state.activePeerUid);
  });

  $('chatMenuBtn').addEventListener('click', (e) => {
    if (!state.activeChatId) return;
    const r = e.currentTarget.getBoundingClientRect();
    showChatMenu(state.activeChatId, r.left - 150, r.bottom + 6);
  });

  $('newChatBtn').addEventListener('click', () => $('findPeopleBtn').click());

  // Полоса блокировки
  $('blockedBarAction').addEventListener('click', async () => {
    const peer = state.activePeerUid;
    if (!peer) return;
    await unblockUser(peer);
    renderBlockedBar(peer);
  });

  // Реакция на изменения блокировок
  on('user:blocked', (uid) => { if (uid === state.activePeerUid) renderBlockedBar(uid); });
  on('user:unblocked', (uid) => { if (uid === state.activePeerUid) renderBlockedBar(uid); });

  // Звонки из шапки
  $('audioCallBtn').addEventListener('click', () => {
    if (state.activePeerUid) emit('call:start', { uid: state.activePeerUid, video: false });
  });
  $('videoCallBtn').addEventListener('click', () => {
    if (state.activePeerUid) emit('call:start', { uid: state.activePeerUid, video: true });
  });
}

export { state as chatState };

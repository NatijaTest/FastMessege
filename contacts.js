/**
 * FastMessage — contacts.js
 * ----------------------------------------------------------------------------
 * Поиск людей, контакты, блокировки, жалобы, панель профиля собеседника.
 */

import {
  ctx, P,
  ref, get, set, remove, update, query, orderByChild, startAt, endAt,
  limitToLast, push, serverTimestamp, listen, emit
} from './firebase.js';

import {
  $, toast, setLoading, showError, escapeHtml, t, confirmDialog, openModal, closeModal
} from './app.js';

import {
  fetchProfile, watchProfile, watchPresence, displayName, avatarHtml,
  badgesHtml, presenceText, privacyAllows, cachedPresence
} from './profile.js';

import { normalizeUsername, errorText } from './auth.js';
import { openChatWith } from './chat.js';

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  /** uid -> {addedAt} */
  contacts: {},
  /** uid -> true */
  blocked: {},
  /** кто заблокировал МЕНЯ (узнаём при открытии чата) */
  blockedBy: new Set(),
  /** открытый в правой панели пользователь */
  infoUid: null,
  infoUnsubs: []
};

export function isContact(uid) {
  return !!state.contacts[uid];
}

export function isBlocked(uid) {
  return !!state.blocked[uid];
}

export function blockedList() {
  return Object.keys(state.blocked);
}

export function contactsList() {
  return Object.keys(state.contacts);
}

export function amIBlockedBy(uid) {
  return state.blockedBy.has(uid);
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОДПИСКИ
   ────────────────────────────────────────────────────────────────────────── */

export function startContactsListeners() {
  listen(ref(ctx.db, P.contacts(ctx.uid)), (snap) => {
    state.contacts = snap.val() || {};
    renderContacts();
    emit('contacts:changed', state.contacts);
  }, 'session');

  listen(ref(ctx.db, P.blocked(ctx.uid)), (snap) => {
    state.blocked = snap.val() || {};
    renderBlockedList();
    const n = Object.keys(state.blocked).length;
    $('blockedCount').textContent = n;
    emit('blocked:changed', state.blocked);
  }, 'session');
}

export function resetContactsState() {
  state.contacts = {};
  state.blocked = {};
  state.blockedBy.clear();
  state.infoUid = null;
  clearInfoWatchers();
}

/** Проверяет, не заблокировал ли нас собеседник (нужно перед отправкой/звонком). */
export async function checkBlockedBy(uid) {
  try {
    const snap = await get(ref(ctx.db, P.block(uid, ctx.uid)));
    if (snap.exists() && snap.val()) state.blockedBy.add(uid);
    else state.blockedBy.delete(uid);
  } catch (e) {
    // Правила могут не дать прочитать чужой список — это нормально.
  }
  return state.blockedBy.has(uid);
}

/* ──────────────────────────────────────────────────────────────────────────
   ДЕЙСТВИЯ
   ────────────────────────────────────────────────────────────────────────── */

export async function addContact(uid) {
  if (uid === ctx.uid) return;
  await set(ref(ctx.db, P.contact(ctx.uid, uid)), {
    addedAt: serverTimestamp()
  });
  const p = await fetchProfile(uid);
  toast('Контакт добавлен', displayName(p), 'success');
}

export async function removeContact(uid) {
  await remove(ref(ctx.db, P.contact(ctx.uid, uid)));
  toast('Контакт удалён', '', 'success');
}

export async function blockUser(uid) {
  await set(ref(ctx.db, P.block(ctx.uid, uid)), {
    at: serverTimestamp()
  });
  const p = await fetchProfile(uid);
  toast('Пользователь заблокирован', displayName(p), 'success');
  emit('user:blocked', uid);
}

export async function unblockUser(uid) {
  await remove(ref(ctx.db, P.block(ctx.uid, uid)));
  toast('Разблокирован', '', 'success');
  emit('user:unblocked', uid);
}

export async function reportUser(uid, reason, comment) {
  const node = push(ref(ctx.db, P.reports()));
  await set(node, {
    id: node.key,
    reporterId: ctx.uid,
    reporterName: displayName(ctx.profile),
    targetId: uid,
    reason,
    comment: comment || '',
    status: 'open',
    createdAt: serverTimestamp()
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОИСК ПОЛЬЗОВАТЕЛЕЙ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Ищет по точному @username и по префиксу имени.
 * Поиск по username работает через индекс usernames/ — он быстрый и дешёвый.
 */
export async function searchUsers(raw) {
  const term = String(raw || '').trim().toLowerCase();
  if (term.length < 2) return [];

  const found = new Map();

  // 1. Точный username
  const uname = normalizeUsername(term);
  if (uname.length >= 3) {
    try {
      const snap = await get(ref(ctx.db, P.username(uname)));
      if (snap.exists()) {
        const p = await fetchProfile(snap.val());
        if (p && p.uid !== ctx.uid) found.set(p.uid, p);
      }
    } catch (e) { /* noop */ }
  }

  // 2. Префиксный поиск по username
  try {
    const q = query(
      ref(ctx.db, 'users'),
      orderByChild('usernameLower'),
      startAt(uname),
      endAt(uname + ''),
      limitToLast(20)
    );
    const snap = await get(q);
    if (snap.exists()) {
      snap.forEach((child) => {
        const p = { uid: child.key, ...child.val() };
        if (p.uid !== ctx.uid) found.set(p.uid, p);
      });
    }
  } catch (e) {
    console.warn('[contacts] поиск по username:', e.code);
  }

  // 3. Префиксный поиск по имени
  try {
    const q = query(
      ref(ctx.db, 'users'),
      orderByChild('searchName'),
      startAt(term),
      endAt(term + ''),
      limitToLast(20)
    );
    const snap = await get(q);
    if (snap.exists()) {
      snap.forEach((child) => {
        const p = { uid: child.key, ...child.val() };
        if (p.uid !== ctx.uid) found.set(p.uid, p);
      });
    }
  } catch (e) {
    console.warn('[contacts] поиск по имени:', e.code);
  }

  return [...found.values()].filter((p) => !p.banned);
}

/* ──────────────────────────────────────────────────────────────────────────
   ОТРИСОВКА СПИСКОВ
   ────────────────────────────────────────────────────────────────────────── */

function userRowHtml(p, opts = {}) {
  const { actions = '', sub = '' } = opts;
  const contact = isContact(p.uid);
  const showPhoto = privacyAllows(p, 'avatar', contact);
  const pres = cachedPresence(p.uid);

  return `
    <button class="row-item" data-uid="${p.uid}">
      ${avatarHtml(p, 'sm', { showPhoto, presence: pres })}
      <span class="row-body">
        <span class="row-top">
          <span class="row-name">${escapeHtml(displayName(p))} ${badgesHtml(p)}</span>
        </span>
        <span class="row-bottom">
          <span class="row-text">${sub || '@' + escapeHtml(p.username || '')}</span>
        </span>
      </span>
      ${actions ? `<span class="row-actions">${actions}</span>` : ''}
    </button>
  `;
}

export async function renderContacts() {
  const box = $('contactList');
  const empty = $('contactListEmpty');
  if (!box) return;

  const uids = Object.keys(state.contacts);
  $('contactsCount').textContent = uids.length;

  if (!uids.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const profiles = (await Promise.all(uids.map((u) => fetchProfile(u)))).filter(Boolean);
  profiles.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ru'));

  const filter = ($('contactSearchInput').value || '').trim().toLowerCase();
  const visible = filter
    ? profiles.filter((p) =>
        displayName(p).toLowerCase().includes(filter) ||
        (p.username || '').toLowerCase().includes(filter))
    : profiles;

  box.innerHTML = visible.map((p) => userRowHtml(p, {
    actions: `
      <button class="icon-btn tiny" data-contact-action="call" data-uid="${p.uid}" title="Позвонить"><svg><use href="#i-phone"/></svg></button>
      <button class="icon-btn tiny danger" data-contact-action="remove" data-uid="${p.uid}" title="Удалить из контактов"><svg><use href="#i-trash"/></svg></button>
    `
  })).join('');

  // Живые presence-точки
  visible.forEach((p) => {
    watchPresence(p.uid, () => {
      const row = box.querySelector(`.row-item[data-uid="${p.uid}"] .presence-dot`);
      if (row) row.classList.toggle('online', cachedPresence(p.uid).online);
    }, 'session');
  });
}

async function renderBlockedList() {
  const box = $('blockedList');
  const empty = $('blockedEmpty');
  if (!box) return;

  const uids = Object.keys(state.blocked);
  if (!uids.length) {
    box.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const profiles = (await Promise.all(uids.map((u) => fetchProfile(u)))).filter(Boolean);
  box.innerHTML = profiles.map((p) => `
    <div class="row-item">
      ${avatarHtml(p, 'sm', { showPhoto: false })}
      <div class="row-body">
        <div class="row-top"><span class="row-name">${escapeHtml(displayName(p))}</span></div>
        <div class="row-bottom"><span class="row-text">@${escapeHtml(p.username || '')}</span></div>
      </div>
      <button class="btn btn-ghost btn-sm" data-unblock="${p.uid}">Разблокировать</button>
    </div>
  `).join('');
}

/* Поиск людей (модалка) */
async function runPeopleSearch(inputId, boxId, emptyId) {
  const term = $(inputId).value.trim();
  const box = $(boxId);
  const empty = $(emptyId);

  if (term.length < 2) {
    box.innerHTML = '';
    if (empty) { empty.classList.remove('hidden'); empty.querySelector('p').textContent = 'Введите минимум 2 символа'; }
    return;
  }

  box.innerHTML = `
    <div class="skel-row"><div class="skeleton skel-circle"></div><div class="skel-lines"><div class="skeleton skel-line"></div><div class="skeleton skel-line short"></div></div></div>
    <div class="skel-row"><div class="skeleton skel-circle"></div><div class="skel-lines"><div class="skeleton skel-line"></div><div class="skeleton skel-line short"></div></div></div>
  `;
  if (empty) empty.classList.add('hidden');

  const results = await searchUsers(term);

  if (!results.length) {
    box.innerHTML = '';
    if (empty) { empty.classList.remove('hidden'); empty.querySelector('p').textContent = 'Никого не нашли'; }
    return;
  }

  box.innerHTML = results.map((p) => userRowHtml(p, {
    actions: isContact(p.uid)
      ? '<span class="row-icon" title="Уже в контактах"><svg><use href="#i-check"/></svg></span>'
      : `<button class="icon-btn tiny" data-contact-action="add" data-uid="${p.uid}" title="Добавить в контакты"><svg><use href="#i-user-plus"/></svg></button>`
  })).join('');
}

/* ──────────────────────────────────────────────────────────────────────────
   ПАНЕЛЬ ПРОФИЛЯ СОБЕСЕДНИКА
   ────────────────────────────────────────────────────────────────────────── */

function clearInfoWatchers() {
  state.infoUnsubs.forEach((u) => { try { u(); } catch (e) { /* noop */ } });
  state.infoUnsubs = [];
}

export async function openUserInfo(uid) {
  if (!uid) return;
  state.infoUid = uid;
  clearInfoWatchers();

  document.querySelector('.app-screen').classList.add('with-info');
  $('infoPanel').classList.remove('hidden');

  const paint = (p) => {
    if (!p || state.infoUid !== uid) return;
    const contact = isContact(uid);
    const showPhoto = privacyAllows(p, 'avatar', contact);

    $('infoAvatar').outerHTML = avatarHtml(p, 'xl', { showPhoto, id: 'infoAvatar' });
    $('infoName').innerHTML = `${escapeHtml(displayName(p))} ${badgesHtml(p)}`;
    $('infoUsername').textContent = '@' + (p.username || '');
    $('infoBio').textContent = p.bio || '';
    $('infoBio').classList.toggle('hidden', !p.bio);

    $('infoContactLabel').textContent = contact ? 'Удалить из контактов' : 'Добавить в контакты';
    $('infoBlockLabel').textContent = isBlocked(uid) ? 'Разблокировать' : 'Заблокировать';

    const st = $('infoStatus');
    st.textContent = presenceText(p, cachedPresence(uid), contact);
  };

  state.infoUnsubs.push(watchProfile(uid, paint, 'info'));
  state.infoUnsubs.push(watchPresence(uid, () => {
    const p = ctx.profile && uid === ctx.uid ? ctx.profile : null;
    const cur = p || null;
    const st = $('infoStatus');
    if (st && state.infoUid === uid) {
      import('./profile.js').then((m) => {
        const prof = m.cachedProfile(uid);
        if (prof) st.textContent = presenceText(prof, cachedPresence(uid), isContact(uid));
      });
    }
  }, 'info'));

  emit('info:opened', uid);
}

export function closeUserInfo() {
  state.infoUid = null;
  clearInfoWatchers();
  document.querySelector('.app-screen').classList.remove('with-info');
  $('infoPanel').classList.add('hidden');
}

export function currentInfoUid() {
  return state.infoUid;
}

/* ──────────────────────────────────────────────────────────────────────────
   ЖАЛОБЫ
   ────────────────────────────────────────────────────────────────────────── */

let reportTargetUid = null;

export function openReportDialog(uid) {
  reportTargetUid = uid;
  $('reportComment').value = '';
  $('reportReason').value = 'spam';
  $('reportError').classList.remove('show');
  openModal('modalReport');
}

async function submitReport() {
  if (!reportTargetUid) return;
  const btn = $('reportSubmit');
  const reason = $('reportReason').value;
  const comment = $('reportComment').value.trim();

  setLoading(btn, true);
  try {
    await reportUser(reportTargetUid, reason, comment);
    closeModal();
    toast('Жалоба отправлена', 'Администратор рассмотрит обращение.', 'success');
    reportTargetUid = null;
  } catch (err) {
    showError('reportError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initContactsUI() {
  // Список контактов: клики
  $('contactList').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-contact-action]');
    if (action) {
      e.stopPropagation();
      const uid = action.dataset.uid;
      if (action.dataset.contactAction === 'remove') {
        const p = await fetchProfile(uid);
        const ok = await confirmDialog({
          title: 'Удалить контакт',
          text: `Удалить ${displayName(p)} из контактов? Переписка сохранится.`,
          okText: 'Удалить'
        });
        if (ok) await removeContact(uid);
      } else if (action.dataset.contactAction === 'call') {
        emit('call:start', { uid, video: false });
      }
      return;
    }
    const row = e.target.closest('.row-item');
    if (row) openChatWith(row.dataset.uid);
  });

  $('contactSearchInput').addEventListener('input', renderContacts);

  // Поиск людей
  $('findPeopleBtn').addEventListener('click', () => {
    $('findPeopleInput').value = '';
    $('findPeopleResults').innerHTML = '';
    $('findPeopleEmpty').classList.remove('hidden');
    $('findPeopleEmpty').querySelector('p').textContent = 'Введите минимум 2 символа';
    openModal('modalFindPeople');
    setTimeout(() => $('findPeopleInput').focus(), 120);
  });
  $('emptyStartChatBtn').addEventListener('click', () => $('findPeopleBtn').click());

  let searchTimer;
  $('findPeopleInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runPeopleSearch('findPeopleInput', 'findPeopleResults', 'findPeopleEmpty'), 380);
  });

  $('findPeopleResults').addEventListener('click', async (e) => {
    const action = e.target.closest('[data-contact-action]');
    if (action) {
      e.stopPropagation();
      if (action.dataset.contactAction === 'add') {
        await addContact(action.dataset.uid);
        runPeopleSearch('findPeopleInput', 'findPeopleResults', 'findPeopleEmpty');
      }
      return;
    }
    const row = e.target.closest('.row-item');
    if (row) {
      closeModal();
      openChatWith(row.dataset.uid);
    }
  });

  // Заблокированные
  $('blockedListBtn').addEventListener('click', () => {
    renderBlockedList();
    openModal('modalBlocked');
  });
  $('blockedList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unblock]');
    if (btn) await unblockUser(btn.dataset.unblock);
  });

  // Правая панель
  $('infoCloseBtn').addEventListener('click', closeUserInfo);

  $('infoMessageBtn').addEventListener('click', () => {
    if (state.infoUid) { openChatWith(state.infoUid); closeUserInfo(); }
  });
  $('infoAudioBtn').addEventListener('click', () => {
    if (state.infoUid) emit('call:start', { uid: state.infoUid, video: false });
  });
  $('infoVideoBtn').addEventListener('click', () => {
    if (state.infoUid) emit('call:start', { uid: state.infoUid, video: true });
  });

  $('infoContactBtn').addEventListener('click', async () => {
    const uid = state.infoUid;
    if (!uid) return;
    if (isContact(uid)) await removeContact(uid);
    else await addContact(uid);
    openUserInfo(uid);
  });

  $('infoBlockBtn').addEventListener('click', async () => {
    const uid = state.infoUid;
    if (!uid) return;
    if (isBlocked(uid)) {
      await unblockUser(uid);
    } else {
      const p = await fetchProfile(uid);
      const ok = await confirmDialog({
        title: 'Заблокировать',
        text: `${displayName(p)} не сможет писать вам и звонить. Продолжить?`,
        okText: 'Заблокировать'
      });
      if (ok) await blockUser(uid);
    }
    openUserInfo(uid);
  });

  $('infoReportBtn').addEventListener('click', () => {
    if (state.infoUid) openReportDialog(state.infoUid);
  });

  $('reportSubmit').addEventListener('click', submitReport);
}

export { state as contactsState, userRowHtml };

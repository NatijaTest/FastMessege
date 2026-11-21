/**
 * FastMessage — accounts.js
 * ----------------------------------------------------------------------------
 * Управление несколькими аккаунтами на одном устройстве.
 *
 * Как это устроено:
 *   Каждому аккаунту выделяется «слот» — отдельное именованное Firebase-
 *   приложение (acc1, acc2, …). Firebase Auth хранит сессию каждого
 *   приложения отдельно, поэтому несколько пользователей могут быть
 *   залогинены одновременно, а переключение между ними не требует пароля.
 *
 * ПАРОЛИ НИГДЕ НЕ СОХРАНЯЮТСЯ. В localStorage лежат только:
 *   - номер слота,
 *   - uid, email, отображаемое имя и аватар (для списка аккаунтов).
 *   Сами токены хранит Firebase SDK в IndexedDB.
 */

import {
  ctx, getSlotApp, destroySlotApp, activateSlot,
  untrackGroup, emit, signOut, ref, get, P
} from './firebase.js';

import { $, toast, initials, avatarClass, escapeHtml } from './app.js';

const LS_KEY = 'fm.accounts.v1';
const LS_ACTIVE = 'fm.activeSlot.v1';
const MAX_ACCOUNTS = 6;

/**
 * @typedef {Object} AccountEntry
 * @property {string} slot
 * @property {string} uid
 * @property {string} email
 * @property {string} name
 * @property {string} username
 * @property {string} photoURL
 * @property {number} unread
 */

/** @type {AccountEntry[]} */
let accountList = [];

/** Слот, который был выделен под вход, но ещё не подтверждён аккаунтом. */
let pendingSlot = null;

/* ──────────────────────────────────────────────────────────────────────────
   ХРАНИЛИЩЕ
   ────────────────────────────────────────────────────────────────────────── */

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    accountList = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(accountList)) accountList = [];
  } catch (e) {
    accountList = [];
  }
  return accountList;
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(accountList));
  } catch (e) {
    console.warn('[accounts] не удалось сохранить список:', e);
  }
}

export function list() {
  return [...accountList];
}

export function count() {
  return accountList.length;
}

export function getActiveSlot() {
  try {
    return localStorage.getItem(LS_ACTIVE) || null;
  } catch (e) {
    return null;
  }
}

function setActiveSlot(slot) {
  try {
    if (slot) localStorage.setItem(LS_ACTIVE, slot);
    else localStorage.removeItem(LS_ACTIVE);
  } catch (e) { /* noop */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   СЛОТЫ
   ────────────────────────────────────────────────────────────────────────── */

/** Находит свободный номер слота и резервирует его. */
export function allocateSlot() {
  const used = new Set(accountList.map((a) => a.slot));
  if (pendingSlot) used.delete(pendingSlot);

  for (let i = 1; i <= MAX_ACCOUNTS + 2; i++) {
    const slot = `acc${i}`;
    if (!used.has(slot)) {
      pendingSlot = slot;
      return slot;
    }
  }
  throw new Error(`Достигнут лимит в ${MAX_ACCOUNTS} аккаунтов.`);
}

/** Делает слот активным контекстом и возвращает его bundle. */
export function useSlot(slot) {
  return activateSlot(slot);
}

/** Освобождает зарезервированный, но так и не использованный слот. */
export function releaseUnusedSlot() {
  if (!pendingSlot) return;
  const known = accountList.some((a) => a.slot === pendingSlot);
  if (!known) {
    const slot = pendingSlot;
    pendingSlot = null;
    destroySlotApp(slot).catch(() => {});
  } else {
    pendingSlot = null;
  }
}

export function findSlotByEmail(email) {
  const e = String(email || '').toLowerCase();
  const found = accountList.find((a) => (a.email || '').toLowerCase() === e);
  return found ? found.slot : null;
}

export function findSlotByUid(uid) {
  const found = accountList.find((a) => a.uid === uid);
  return found ? found.slot : null;
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕГИСТРАЦИЯ АККАУНТА В СПИСКЕ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Запоминает аккаунт (или обновляет его данные) после успешного входа.
 * @param {Object} profile профиль из RTDB
 */
export function remember(profile) {
  if (!profile || !profile.uid) return;

  const slot = ctx.slot;
  const name = `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || profile.username || 'Без имени';

  const entry = {
    slot,
    uid: profile.uid,
    email: profile.email || '',
    name,
    username: profile.username || '',
    photoURL: profile.photoURL || '',
    unread: 0
  };

  // Один uid — один слот.
  const sameUid = accountList.findIndex((a) => a.uid === profile.uid);
  if (sameUid >= 0 && accountList[sameUid].slot !== slot) {
    const stale = accountList[sameUid].slot;
    accountList.splice(sameUid, 1);
    destroySlotApp(stale).catch(() => {});
  }

  const idx = accountList.findIndex((a) => a.slot === slot);
  if (idx >= 0) accountList[idx] = { ...accountList[idx], ...entry };
  else accountList.push(entry);

  pendingSlot = null;
  setActiveSlot(slot);
  save();
  render();
}

/** Обновляет счётчик непрочитанных у неактивного аккаунта (для бейджа). */
export function setUnread(slot, n) {
  const a = accountList.find((x) => x.slot === slot);
  if (!a) return;
  a.unread = n;
  save();
  render();
}

/* ──────────────────────────────────────────────────────────────────────────
   ПЕРЕКЛЮЧЕНИЕ
   ────────────────────────────────────────────────────────────────────────── */

let switching = false;

/**
 * Переключает активный аккаунт.
 * Критично: сначала обрываем ВСЕ подписки текущего аккаунта,
 * иначе чужие сообщения дорисуются в новый интерфейс.
 */
export async function switchTo(slot) {
  if (switching || slot === ctx.slot) return;
  const entry = accountList.find((a) => a.slot === slot);
  if (!entry) return;

  switching = true;
  try {
    emit('account:switching', entry);

    // 1. Гасим все realtime-слушатели и UI предыдущего аккаунта.
    untrackGroup();

    // 2. Активируем слот.
    const bundle = useSlot(slot);
    const user = bundle.auth.currentUser;

    if (!user) {
      // Сессия истекла (например, пароль сменили на другом устройстве).
      toast('Нужно войти заново', `Сессия ${entry.email} истекла.`, 'warn');
      emit('account:reauth-needed', entry);
      switching = false;
      return;
    }

    ctx.user = user;
    setActiveSlot(slot);

    // 3. Подтягиваем профиль и поднимаем приложение заново.
    const snap = await get(ref(bundle.db, P.user(user.uid)));
    if (!snap.exists()) {
      emit('account:reauth-needed', entry);
      switching = false;
      return;
    }

    ctx.profile = { uid: user.uid, ...snap.val() };
    entry.unread = 0;
    save();

    emit('account:switched', ctx.profile);
    render();
    toast('Аккаунт переключён', entry.name, 'success');
  } catch (err) {
    console.error('[accounts] switchTo:', err);
    toast('Не удалось переключиться', err.message, 'error');
  } finally {
    switching = false;
  }
}

/**
 * Выход из аккаунта: завершает сессию Firebase и убирает запись с устройства.
 * Возвращает слот следующего аккаунта или null, если аккаунтов не осталось.
 */
export async function logoutSlot(slot) {
  const idx = accountList.findIndex((a) => a.slot === slot);
  if (idx < 0) return null;

  const isActive = slot === ctx.slot;
  if (isActive) untrackGroup();

  try {
    const bundle = getSlotApp(slot);
    await signOut(bundle.auth);
  } catch (e) {
    console.warn('[accounts] signOut:', e);
  }

  accountList.splice(idx, 1);
  save();
  await destroySlotApp(slot);

  const next = accountList.length ? accountList[0].slot : null;
  setActiveSlot(next);
  render();
  return next;
}

/** Убирает аккаунт из списка устройства, не трогая сам аккаунт в Firebase. */
export async function forgetSlot(slot) {
  return logoutSlot(slot);
}

/** Вызывается после удаления аккаунта из Firebase целиком. */
export async function dropSlot(slot) {
  const idx = accountList.findIndex((a) => a.slot === slot);
  if (idx >= 0) {
    accountList.splice(idx, 1);
    save();
  }
  await destroySlotApp(slot);
  const next = accountList.length ? accountList[0].slot : null;
  setActiveSlot(next);
  render();
  return next;
}

/* ──────────────────────────────────────────────────────────────────────────
   ВОССТАНОВЛЕНИЕ СЕССИИ ПРИ СТАРТЕ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Пытается восстановить последнюю активную сессию.
 * @returns {Promise<{slot:string,user:Object}|null>}
 */
export async function restore() {
  load();
  if (!accountList.length) return null;

  const preferred = getActiveSlot();
  const order = [
    ...accountList.filter((a) => a.slot === preferred),
    ...accountList.filter((a) => a.slot !== preferred)
  ];

  for (const entry of order) {
    const bundle = getSlotApp(entry.slot);
    const user = await waitForAuth(bundle.auth);
    if (user) {
      activateSlot(entry.slot);
      ctx.user = user;
      setActiveSlot(entry.slot);
      return { slot: entry.slot, user };
    }
  }

  return null;
}

/** Ждёт первое срабатывание onAuthStateChanged — нужно при старте страницы. */
function waitForAuth(auth) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(auth.currentUser || null); }, 7000);
    const unsub = auth.onAuthStateChanged(
      (u) => { cleanup(); resolve(u); },
      () => { cleanup(); resolve(null); }
    );
    function cleanup() {
      clearTimeout(timer);
      try { unsub(); } catch (e) { /* noop */ }
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНТЕРФЕЙС
   ────────────────────────────────────────────────────────────────────────── */

function avatarHtml(entry, size = 'xs') {
  if (entry.photoURL) {
    return `<span class="avatar ${size}"><img src="${escapeHtml(entry.photoURL)}" alt="" loading="lazy" /></span>`;
  }
  return `<span class="avatar ${size} ${avatarClass(entry.uid || entry.name)}"><span>${initials(entry.name)}</span></span>`;
}

/** Перерисовывает переключатель в сайдбаре и модалку управления. */
export function render() {
  const cur = accountList.find((a) => a.slot === ctx.slot);

  const nameEl = $('accountCurrentName');
  const avaEl = $('accountCurrentAvatar');
  if (nameEl && cur) nameEl.textContent = cur.name;
  if (avaEl && cur) {
    avaEl.outerHTML = avatarHtml(cur, 'xs').replace('class="avatar xs', 'id="accountCurrentAvatar" class="avatar xs');
  }

  // Выпадающий список
  const listEl = $('accountList');
  if (listEl) {
    const rows = accountList.map((a) => `
      <button class="account-item ${a.slot === ctx.slot ? 'active' : ''}" data-slot="${a.slot}">
        ${avatarHtml(a, 'sm')}
        <span class="account-item-info">
          <span class="account-item-name">${escapeHtml(a.name)}</span>
          <span class="account-item-sub">@${escapeHtml(a.username || '—')}</span>
        </span>
        ${a.unread ? `<span class="account-item-badge">${a.unread > 99 ? '99+' : a.unread}</span>` : ''}
        ${a.slot === ctx.slot ? '<svg class="ctx-check" style="width:16px;height:16px"><use href="#i-check"/></svg>' : ''}
      </button>
    `).join('');

    const canAdd = accountList.length < MAX_ACCOUNTS;
    listEl.innerHTML = rows + (canAdd
      ? '<button class="account-add" data-action="add"><svg><use href="#i-plus"/></svg> Добавить аккаунт</button>'
      : `<div class="auth-note" style="padding:8px">Максимум ${MAX_ACCOUNTS} аккаунтов</div>`);
  }

  renderManageList();
}

function renderManageList() {
  const box = $('accountsManageList');
  if (!box) return;

  box.innerHTML = accountList.map((a) => `
    <div class="row-item" data-slot="${a.slot}">
      ${avatarHtml(a, 'sm')}
      <div class="row-body">
        <div class="row-top">
          <span class="row-name">${escapeHtml(a.name)}</span>
          ${a.slot === ctx.slot ? '<span class="row-time" style="color:var(--success)">активен</span>' : ''}
        </div>
        <div class="row-bottom">
          <span class="row-text">${escapeHtml(a.email || '@' + a.username)}</span>
        </div>
      </div>
      <div class="row-actions">
        ${a.slot !== ctx.slot
          ? `<button class="icon-btn tiny" data-acc-action="switch" data-slot="${a.slot}" title="Переключиться"><svg><use href="#i-chevron-right"/></svg></button>`
          : ''}
        <button class="icon-btn tiny danger" data-acc-action="logout" data-slot="${a.slot}" title="Выйти"><svg><use href="#i-logout"/></svg></button>
      </div>
    </div>
  `).join('');

  const addBtn = $('addAccountBtn');
  if (addBtn) addBtn.disabled = accountList.length >= MAX_ACCOUNTS;
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initAccountsUI(handlers) {
  load();

  const btn = $('accountCurrentBtn');
  const listEl = $('accountList');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = listEl.classList.toggle('hidden');
    btn.classList.toggle('open', !open);
  });

  document.addEventListener('click', (e) => {
    if (listEl.classList.contains('hidden')) return;
    if (e.target.closest('#accountSwitcher')) return;
    listEl.classList.add('hidden');
    btn.classList.remove('open');
  });

  listEl.addEventListener('click', (e) => {
    const add = e.target.closest('[data-action="add"]');
    if (add) {
      listEl.classList.add('hidden');
      btn.classList.remove('open');
      handlers.onAddAccount();
      return;
    }
    const item = e.target.closest('.account-item');
    if (!item) return;
    listEl.classList.add('hidden');
    btn.classList.remove('open');
    switchTo(item.dataset.slot);
  });

  // Модалка управления
  const manage = $('accountsManageList');
  manage.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-acc-action]');
    if (actionBtn) {
      e.stopPropagation();
      const { accAction, slot } = actionBtn.dataset;
      if (accAction === 'switch') {
        handlers.onCloseModal();
        switchTo(slot);
      } else if (accAction === 'logout') {
        handlers.onLogoutSlot(slot);
      }
      return;
    }
    const row = e.target.closest('.row-item');
    if (row && row.dataset.slot !== ctx.slot) {
      handlers.onCloseModal();
      switchTo(row.dataset.slot);
    }
  });

  $('addAccountBtn').addEventListener('click', () => {
    handlers.onCloseModal();
    handlers.onAddAccount();
  });

  render();
}

export { MAX_ACCOUNTS };

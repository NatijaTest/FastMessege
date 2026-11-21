/**
 * FastMessage — app.js
 * ----------------------------------------------------------------------------
 * Точка входа: утилиты, локализация, модальные окна, тосты, контекстные меню,
 * навигация и жизненный цикл приложения (вход → загрузка → переключение
 * аккаунтов → выход).
 */

import {
  ctx, P, activateSlot, untrackGroup, on, emit,
  ref, get, onAuthStateChanged, listen
} from './firebase.js';

/* ──────────────────────────────────────────────────────────────────────────
   БАЗОВЫЕ УТИЛИТЫ
   ────────────────────────────────────────────────────────────────────────── */

export function $(id) {
  return document.getElementById(id);
}

export function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Превращает ссылки и @упоминания в кликабельные элементы. */
export function linkify(text) {
  const safe = escapeHtml(text);
  return safe
    .replace(/(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)@([a-z0-9_]{3,24})\b/gi, '$1<span class="mention">@$2</span>');
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 200) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < wait) return;
    last = now;
    fn(...args);
  };
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

/** Стабильный градиент аватара по строке. */
export function avatarClass(seed) {
  const s = String(seed || 'x');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return 'av-g' + (hash % 8);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** mm:ss, при withHours и длительности > часа — hh:mm:ss */
export function formatDuration(sec, withHours = false) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;

  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  if (withHours) return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

export function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();

  if (isSameDay(d, now)) return formatTime(ts);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return t('yesterday');

  if (now - d < 7 * 24 * 3600 * 1000) {
    return d.toLocaleDateString(localeTag(), { weekday: 'short' });
  }
  return d.toLocaleDateString(localeTag(), { day: '2-digit', month: '2-digit' });
}

export function formatDateSep(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();

  if (isSameDay(d, now)) return t('today');

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return t('yesterday');

  return d.toLocaleDateString(localeTag(), {
    day: 'numeric', month: 'long',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
  });
}

export function formatLastSeen(ts) {
  if (!ts) return t('offline');
  const diff = Date.now() - ts;

  if (diff < 60000) return t('justNow');
  if (diff < 3600000) {
    const m = Math.floor(diff / 60000);
    return `${t('lastSeen')} ${m} ${plural(m, ['минуту', 'минуты', 'минут'])} ${t('ago')}`;
  }

  const d = new Date(ts);
  if (isSameDay(d, new Date())) return `${t('lastSeen')} ${t('todayAt')} ${formatTime(ts)}`;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(d, yesterday)) return `${t('lastSeen')} ${t('yesterdayAt')} ${formatTime(ts)}`;

  return `${t('lastSeen')} ${d.toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' })}`;
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

/** Сообщение только из эмодзи (до 3 штук) — рисуем крупно. */
export function isEmojiOnly(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 12) return false;
  const stripped = s.replace(/[\s‍️]/g, '');
  if (!stripped) return false;
  const emojiRe = /^(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}])+$/u;
  return emojiRe.test(stripped) && [...stripped].length <= 3;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* noop */ }
  document.body.removeChild(ta);
  return Promise.resolve();
}

/* ──────────────────────────────────────────────────────────────────────────
   ЛОКАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

const I18N = {
  ru: {
    online: 'в сети', offline: 'не в сети', lastSeen: 'был(а)',
    today: 'Сегодня', yesterday: 'Вчера', todayAt: 'сегодня в',
    yesterdayAt: 'вчера в', justNow: 'только что', ago: 'назад',
    saved: 'Сохранено', chats: 'Чаты', contacts: 'Контакты',
    settings: 'Настройки', admin: 'Админ', message: 'Сообщение',
    search: 'Поиск', send: 'Отправить', cancel: 'Отмена',
    newMessage: 'Новое сообщение'
  },
  uz: {
    online: 'onlayn', offline: 'oflayn', lastSeen: 'oxirgi marta',
    today: 'Bugun', yesterday: 'Kecha', todayAt: 'bugun soat',
    yesterdayAt: 'kecha soat', justNow: 'hozirgina', ago: 'oldin',
    saved: 'Saqlandi', chats: 'Chatlar', contacts: 'Kontaktlar',
    settings: 'Sozlamalar', admin: 'Admin', message: 'Xabar',
    search: 'Qidirish', send: 'Yuborish', cancel: 'Bekor qilish',
    newMessage: 'Yangi xabar'
  },
  en: {
    online: 'online', offline: 'offline', lastSeen: 'last seen',
    today: 'Today', yesterday: 'Yesterday', todayAt: 'today at',
    yesterdayAt: 'yesterday at', justNow: 'just now', ago: 'ago',
    saved: 'Saved', chats: 'Chats', contacts: 'Contacts',
    settings: 'Settings', admin: 'Admin', message: 'Message',
    search: 'Search', send: 'Send', cancel: 'Cancel',
    newMessage: 'New message'
  }
};

let currentLang = 'ru';

export function setLanguage(lang) {
  currentLang = I18N[lang] ? lang : 'ru';
  document.documentElement.lang = currentLang;
  applyTranslations();
}

export function getLanguage() { return currentLang; }

export function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.ru[key] || key;
}

function localeTag() {
  return { ru: 'ru-RU', uz: 'uz-UZ', en: 'en-US' }[currentLang] || 'ru-RU';
}

/** Переводит подписи навигации и плейсхолдеры. */
function applyTranslations() {
  const map = [
    ['[data-tab="chats"] span', 'chats'],
    ['[data-tab="contacts"] span', 'contacts'],
    ['[data-tab="settings"] span', 'settings'],
    ['[data-tab="admin"] span', 'admin']
  ];
  map.forEach(([sel, key]) => {
    document.querySelectorAll(sel).forEach((el) => { el.textContent = t(key); });
  });

  const input = $('messageInput');
  if (input) input.placeholder = t('message');
}

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ ЗАГРУЗКИ И ОШИБОК В ФОРМАХ
   ────────────────────────────────────────────────────────────────────────── */

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

export function showError(elementId, text) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  el.classList.remove('success');
}

/* ──────────────────────────────────────────────────────────────────────────
   ТОСТЫ
   ────────────────────────────────────────────────────────────────────────── */

const ICONS = {
  info: 'i-info', success: 'i-check', error: 'i-x', warn: 'i-bell'
};

/**
 * @param {string} title
 * @param {string} text
 * @param {'info'|'success'|'error'|'warn'} type
 * @param {{icon?:string, avatar?:string, duration?:number, onClick?:Function}} [opts]
 */
export function toast(title, text = '', type = 'info', opts = {}) {
  const host = $('toastHost');
  if (!host) return;

  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const iconHtml = opts.avatar
    ? `<span class="toast-icon"><img src="${escapeHtml(opts.avatar)}" alt="" /></span>`
    : `<span class="toast-icon"><svg><use href="#${opts.icon || ICONS[type] || ICONS.info}"/></svg></span>`;

  el.innerHTML = `
    ${iconHtml}
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${text ? `<div class="toast-text">${escapeHtml(text)}</div>` : ''}
    </div>`;

  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };

  el.addEventListener('click', () => {
    if (opts.onClick) opts.onClick();
    close();
  });

  host.appendChild(el);
  setTimeout(close, opts.duration || 4200);

  // Не копим больше пяти уведомлений.
  while (host.children.length > 5) host.firstElementChild.remove();
}

/* ──────────────────────────────────────────────────────────────────────────
   МОДАЛЬНЫЕ ОКНА
   ────────────────────────────────────────────────────────────────────────── */

let openModalId = null;

export function openModal(id) {
  const host = $('modalHost');
  const modal = $(id);
  if (!host || !modal) return;

  if (openModalId && openModalId !== id) $(openModalId).classList.add('hidden');

  host.classList.remove('hidden');
  modal.classList.remove('hidden');
  openModalId = id;
}

export function closeModal() {
  const host = $('modalHost');
  if (!host) return;
  host.classList.add('hidden');
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  openModalId = null;
}

/**
 * Диалог подтверждения.
 * @returns {Promise<boolean|string>} true/false, либо введённую строку при requireInput
 */
export function confirmDialog({ title, text, okText = 'Подтвердить', requireInput = false, inputPlaceholder = '' }) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').querySelector('.btn-label').textContent = okText;
    $('confirmError').classList.remove('show');

    const field = $('confirmInputField');
    const input = $('confirmInput');
    field.classList.toggle('hidden', !requireInput);
    input.value = '';
    input.placeholder = inputPlaceholder;

    openModal('modalConfirm');
    if (requireInput) setTimeout(() => input.focus(), 120);

    const cleanup = () => {
      $('confirmOk').removeEventListener('click', onOk);
      $('confirmCancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      setLoading($('confirmOk'), false);
    };

    const onOk = () => {
      if (requireInput && !input.value) {
        showError('confirmError', 'Введите значение.');
        return;
      }
      const value = requireInput ? input.value : true;
      cleanup();
      closeModal();
      resolve(value);
    };

    const onCancel = () => {
      cleanup();
      closeModal();
      resolve(requireInput ? '' : false);
    };

    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };

    $('confirmOk').addEventListener('click', onOk);
    $('confirmCancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   КОНТЕКСТНЫЕ МЕНЮ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {string} menuId  id контейнера меню
 * @param {Array}  items   [{icon,label,action,danger,hidden,separator,checked}]
 * @param {number} x, y    координаты
 * @param {Function} [onClose]
 */
export function openContextMenu(menuId, items, x, y, onClose) {
  const menu = $(menuId);
  if (!menu) return;

  const visible = items.filter((i) => !i.hidden);
  menu.innerHTML = visible.map((item, idx) => {
    if (item.separator) return '<div class="ctx-sep"></div>';
    return `
      <button data-ctx-index="${idx}" class="${item.danger ? 'danger' : ''}">
        ${item.icon ? `<svg><use href="#${item.icon}"/></svg>` : ''}
        <span>${escapeHtml(item.label)}</span>
        ${item.checked ? '<svg class="ctx-check"><use href="#i-check"/></svg>' : ''}
      </button>`;
  }).join('');

  menu.classList.remove('hidden');

  // Удерживаем меню в пределах экрана.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const close = () => {
    menu.classList.add('hidden');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', close);
    if (onClose) onClose();
  };

  const onDocClick = (e) => {
    const btn = e.target.closest('[data-ctx-index]');
    if (btn && menu.contains(btn)) {
      e.preventDefault();
      e.stopPropagation();
      const item = visible[Number(btn.dataset.ctxIndex)];
      close();
      if (item && item.action) item.action();
      return;
    }
    close();
  };

  const onEsc = (e) => { if (e.key === 'Escape') close(); };

  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', close);
  }, 0);
}

/* ──────────────────────────────────────────────────────────────────────────
   НАВИГАЦИЯ ПО ВКЛАДКАМ
   ────────────────────────────────────────────────────────────────────────── */

let currentTab = 'chats';

export function switchTab(tab) {
  currentTab = tab;

  document.querySelectorAll('.side-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.mnav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pane === tab);
  });

  if (tab === 'admin') {
    import('./admin.js').then((m) => m.loadAdminPanel());
  }

  // На мобильном показываем сайдбар.
  if (isMobile()) {
    document.querySelector('.app-screen').classList.remove('chat-open');
  }
}

export function getCurrentTab() { return currentTab; }

/* ──────────────────────────────────────────────────────────────────────────
   ЭКРАНЫ
   ────────────────────────────────────────────────────────────────────────── */

function showBoot(hint) {
  $('bootScreen').classList.remove('hidden');
  if (hint) $('bootHint').textContent = hint;
}

function hideBoot() {
  const el = $('bootScreen');
  el.style.transition = 'opacity .32s ease';
  el.style.opacity = '0';
  setTimeout(() => { el.classList.add('hidden'); el.style.opacity = ''; }, 330);
}

function showAuth() {
  hideBoot();
  $('authScreen').classList.remove('hidden');
  $('appScreen').classList.add('hidden');
}

function showApp() {
  hideBoot();
  $('authScreen').classList.add('hidden');
  $('appScreen').classList.remove('hidden');
}

/* ──────────────────────────────────────────────────────────────────────────
   ЖИЗНЕННЫЙ ЦИКЛ
   ────────────────────────────────────────────────────────────────────────── */

// Модули подгружаются динамически, чтобы избежать циклических импортов
// на этапе инициализации.
let M = {};

async function loadModules() {
  const [
    auth, accounts, profile, contacts, chat, messages,
    emojiMod, media, calls, admin, settings, stars
  ] = await Promise.all([
    import('./auth.js'), import('./accounts.js'), import('./profile.js'),
    import('./contacts.js'), import('./chat.js'), import('./messages.js'),
    import('./emoji.js'), import('./media.js'), import('./calls.js'),
    import('./admin.js'), import('./settings.js'), import('./stars.js')
  ]);

  M = { auth, accounts, profile, contacts, chat, messages, emoji: emojiMod, media, calls, admin, settings, stars };
  return M;
}

/** Поднимает приложение для вошедшего пользователя. */
async function bootApp(profileData) {
  ctx.profile = profileData;

  // Заблокированным вход закрыт.
  if (profileData.banned) {
    await M.auth.logoutCurrent();
    showAuth();
    M.auth.showAuthPanel('main');
    M.auth.setAuthMode('login');
    toast('Доступ заблокирован', 'Ваш аккаунт заблокирован администратором.', 'error', { duration: 9000 });
    return;
  }

  showApp();

  M.accounts.remember(profileData);
  M.profile.renderMyProfile();
  M.profile.initPresence();

  M.contacts.startContactsListeners();
  M.chat.startChatsListener();
  M.calls.listenIncomingCalls();
  M.settings.startAnnouncementsWatcher();

  M.settings.watchOwnBanStatus(async () => {
    toast('Аккаунт заблокирован', 'Администратор ограничил доступ.', 'error', { duration: 9000 });
    setTimeout(() => handleLogout(), 2500);
  });

  M.stars.startStars();

  if (profileData.isAdmin || profileData.isModerator) {
    M.admin.loadAdminPanel();
  }

  watchIncomingNotifications();
  switchTab('chats');
}

/** Уведомления о новых сообщениях в неактивных чатах. */
function watchIncomingNotifications() {
  let known = null;

  listen(ref(ctx.db, P.userChats(ctx.uid)), async (snap) => {
    const data = snap.val() || {};

    if (known === null) { known = data; return; }

    for (const [chatId, rec] of Object.entries(data)) {
      const prev = known[chatId];
      const grew = rec.unread > ((prev && prev.unread) || 0);
      const isActive = M.chat.activeChatId() === chatId && document.visibilityState === 'visible';

      if (grew && !isActive && !rec.muted) {
        const peer = await M.profile.fetchProfile(rec.peerId);
        const meta = M.chat.chatMeta(chatId);
        const lm = meta && meta.lastMessage;

        if (M.settings.shouldShowToastNotification()) {
          toast(
            M.profile.displayName(peer),
            lm ? previewForToast(lm) : t('newMessage'),
            'info',
            {
              avatar: peer && peer.photoURL ? peer.photoURL : null,
              icon: 'i-chat',
              onClick: () => { M.chat.openChat(chatId, rec.peerId); switchTab('chats'); }
            }
          );
        }
        M.settings.playNotificationSound();
      }
    }

    known = data;
  }, 'session');
}

function previewForToast(lm) {
  switch (lm.type) {
    case 'image': return '📷 Фото';
    case 'video': return '🎬 Видео';
    case 'voice': return '🎤 Голосовое сообщение';
    case 'audio': return '🎵 Аудио';
    case 'file': return '📎 ' + (lm.fileName || 'Документ');
    case 'gif': return 'GIF';
    case 'sticker': return (lm.sticker || '🙂') + ' Стикер';
    case 'call': return '📞 Звонок';
    default: return lm.text || t('newMessage');
  }
}

/** Полная очистка состояния при выходе или смене аккаунта. */
function teardownSession() {
  untrackGroup();
  M.profile.clearProfileCache();
  M.contacts.resetContactsState();
  M.chat.resetChatState();
  M.messages.closeMessages();
  M.media.clearPending();
  M.media.stopCurrentAudio();
  M.admin.resetAdminState();
  M.stars.resetStars();
  if (M.calls.isInCall()) M.calls.endCall('ended');
  closeModal();
  ctx.profile = null;
}

async function handleLogout() {
  const slot = ctx.slot;
  await M.profile.goOffline();
  teardownSession();

  const next = await M.accounts.logoutSlot(slot);

  if (next) {
    await M.accounts.switchTo(next);
  } else {
    showAuth();
    M.auth.setAddingAccount(false);
    M.auth.showAuthPanel('main');
    M.auth.setAuthMode('login');
  }
}

/** Добавление ещё одного аккаунта: показываем экран входа поверх приложения. */
function handleAddAccount() {
  M.auth.setAddingAccount(true);
  M.auth.showAuthPanel('main');
  M.auth.setAuthMode('login');
  $('loginForm').reset();
  $('registerForm').reset();
  showAuth();
  toast('Добавление аккаунта', 'Войдите в другой аккаунт — текущий останется активным.', 'info');
}

/* ──────────────────────────────────────────────────────────────────────────
   ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ
   ────────────────────────────────────────────────────────────────────────── */

function initGlobalUI() {
  // Вкладки
  document.querySelectorAll('.side-tab, .mnav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Модалки
  $('modalBackdrop').addEventListener('click', closeModal);
  document.querySelectorAll('[data-close-modal]').forEach((b) => {
    b.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').classList.contains('hidden')) { M.media.closeLightbox(); return; }
    if (!$('modalHost').classList.contains('hidden')) { closeModal(); return; }
    if (!$('pickerPanel').classList.contains('hidden')) { M.emoji.closePicker(); }
  });

  // Горячие клавиши
  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      switchTab('chats');
      $('globalSearchInput').focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && M.chat.activeChatId()) {
      e.preventDefault();
      M.messages.setChatSearchActive(true);
      return;
    }
    if (e.key === '/' && !inField) {
      e.preventDefault();
      $('globalSearchInput').focus();
    }
  });

  // Событие «закрыть модалку» из модулей
  on('modal:close', closeModal);

  // Профиль обновился — перерисовать сайдбар и список аккаунтов
  on('profile:updated', (p) => {
    M.profile.renderMyProfile();
    M.accounts.remember(p);
  });

  // Переключение аккаунта
  on('account:switching', () => {
    teardownSession();
    showBoot('Переключаем аккаунт…');
  });

  on('account:switched', async (profileData) => {
    await bootApp(profileData);
  });

  on('account:reauth-needed', (entry) => {
    hideBoot();
    M.auth.setAddingAccount(true);
    showAuth();
    M.auth.showAuthPanel('main');
    M.auth.setAuthMode('login');
    if (entry && entry.email) $('loginEmail').value = entry.email;
    toast('Требуется вход', 'Сессия истекла — введите пароль ещё раз.', 'warn');
  });

  on('account:deleted', async ({ nextSlot }) => {
    teardownSession();
    if (nextSlot) await M.accounts.switchTo(nextSlot);
    else { showAuth(); M.auth.showAuthPanel('main'); M.auth.setAuthMode('login'); }
  });

  // Готовность профиля после входа/регистрации
  on('auth:ready', async (profileData) => {
    M.auth.setAddingAccount(false);
    await bootApp(profileData);
  });

  // Сеть
  window.addEventListener('offline', () => {
    toast('Нет соединения', 'Сообщения отправятся, когда связь восстановится.', 'warn', { duration: 6000 });
  });
  window.addEventListener('online', () => {
    toast('Связь восстановлена', '', 'success');
  });

  // Высота вьюпорта на мобильных (адресная строка)
  const setVh = () => {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  };
  setVh();
  window.addEventListener('resize', throttle(setVh, 180));
}

/* ──────────────────────────────────────────────────────────────────────────
   СТАРТ
   ────────────────────────────────────────────────────────────────────────── */

async function start() {
  showBoot('Загружаем модули…');

  try {
    await loadModules();
  } catch (err) {
    $('bootHint').textContent = 'Не удалось загрузить приложение: ' + err.message;
    console.error(err);
    return;
  }

  // Настройки применяем до всего остального — тема не должна «мигать».
  M.settings.applyAllSettings();

  // Инициализация интерфейсов
  M.auth.initAuthUI();
  M.profile.initProfileUI();
  M.contacts.initContactsUI();
  M.chat.initChatUI();
  M.messages.initMessagesUI();
  M.emoji.initEmojiUI();
  M.media.initMediaUI();
  M.calls.initCallsUI();
  M.admin.initAdminUI();
  M.stars.initStarsUI();

  M.settings.initSettingsUI({
    onLogout: handleLogout,
    onEditProfile: () => { M.profile.openEditProfile(); openModal('modalEditProfile'); },
    onOpenSettings: () => switchTab('settings')
  });

  M.accounts.initAccountsUI({
    onAddAccount: handleAddAccount,
    onCloseModal: closeModal,
    onLogoutSlot: async (slot) => {
      const entry = M.accounts.list().find((a) => a.slot === slot);
      const ok = await confirmDialog({
        title: 'Выйти из аккаунта',
        text: `Выйти из ${entry ? entry.name : 'аккаунта'}? Он будет убран с этого устройства.`,
        okText: 'Выйти'
      });
      if (!ok) return;

      if (slot === ctx.slot) {
        await handleLogout();
      } else {
        await M.accounts.logoutSlot(slot);
        toast('Готово', 'Аккаунт убран с устройства.', 'success');
      }
    }
  });

  initGlobalUI();

  // Отправка файлов из очереди вместе с текстом
  $('sendBtn').addEventListener('click', async () => {
    if (M.media.hasPending()) {
      const caption = $('messageInput').value.trim();
      $('messageInput').value = '';
      await M.media.sendPendingFiles(caption);
    }
  }, true);

  $('messageInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && M.media.hasPending()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const caption = $('messageInput').value.trim();
      $('messageInput').value = '';
      await M.media.sendPendingFiles(caption);
    }
  }, true);

  // Страница подтверждения входа (ссылка из письма двухэтапной проверки)
  try {
    const tw = await import('./twostep.js');
    if (await tw.handleApprovalLink()) return;
  } catch (e) { console.warn('[app] twostep:', e); }

  // Восстановление сессии
  showBoot('Проверяем сессию…');

  try {
    const restored = await M.accounts.restore();

    if (restored) {
      const snap = await get(ref(ctx.db, P.user(restored.user.uid))).catch(() => null);

      if (snap && snap.exists() && snap.val().username) {
        await bootApp({ uid: restored.user.uid, ...snap.val() });
      } else {
        showAuth();
        await M.auth.routeAfterAuth(restored.user);
      }
    } else {
      // Нет сохранённых сессий — чистый экран входа.
      activateSlot(M.accounts.allocateSlot());
      showAuth();
      M.auth.showAuthPanel('main');
      M.auth.setAuthMode('login');
    }
  } catch (err) {
    console.error('[app] восстановление сессии:', err);
    activateSlot('acc1');
    showAuth();
    toast('Не удалось восстановить сессию', err.message, 'warn');
  }
}

/* Глобальный перехват необработанных ошибок — чтобы не падать молча. */
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason || {};
  const code = err.code || '';
  if (code.includes('permission-denied') || code === 'PERMISSION_DENIED') {
    console.warn('[app] отказано в доступе:', err);
    return;
  }
  console.error('[app] необработанная ошибка:', err);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

export { M as modules };

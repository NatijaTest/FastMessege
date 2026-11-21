/**
 * FastMessage — settings.js
 * ----------------------------------------------------------------------------
 * Тема, язык, обои, уведомления внутри приложения, смена пароля,
 * удаление аккаунта, объявления администрации.
 */

import {
  ctx, P, ref, set, onValue, query, orderByChild, limitToLast, listen, emit
} from './firebase.js';

import {
  $, toast, setLoading, showError, openModal, closeModal,
  confirmDialog, escapeHtml, setLanguage, getLanguage, t
} from './app.js';

import { changePassword, deleteOwnAccount, errorText } from './auth.js';
import { displayName } from './profile.js';
import * as accounts from './accounts.js';

/* ──────────────────────────────────────────────────────────────────────────
   ХРАНИЛИЩЕ НАСТРОЕК (локальные предпочтения устройства)
   ────────────────────────────────────────────────────────────────────────── */

const LS_KEY = 'fm.settings.v1';

const defaults = {
  theme: 'dark',
  lang: 'ru',
  wallpaper: 'aurora',
  notifyToast: true,
  notifySound: true
};

let settings = { ...defaults };

export function get(key) { return settings[key]; }

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    settings = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch (e) {
    settings = { ...defaults };
  }
  return settings;
}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ }
}

export function setSetting(key, value) {
  settings[key] = value;
  persist();
  applySetting(key, value);
}

function applySetting(key, value) {
  switch (key) {
    case 'theme':
      document.documentElement.setAttribute('data-theme', value);
      document.querySelector('meta[name="theme-color"]')
        .setAttribute('content', value === 'light' ? '#EEF2F9' : '#080D18');
      if ($('themeSwitch')) $('themeSwitch').checked = value === 'dark';
      updateThemeIcon();
      break;
    case 'wallpaper':
      $('chatArea').dataset.wallpaper = value;
      break;
    case 'lang':
      setLanguage(value);
      if ($('langSelect')) $('langSelect').value = value;
      if ($('authLangSelect')) $('authLangSelect').value = value;
      break;
    default:
      break;
  }
}

function updateThemeIcon() {
  const btn = $('authThemeToggle');
  if (!btn) return;
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', settings.theme === 'dark' ? '#i-sun' : '#i-moon');
}

/** Применяет все настройки при старте. */
export function applyAllSettings() {
  loadSettings();
  Object.entries(settings).forEach(([k, v]) => applySetting(k, v));

  if ($('notifyToastSwitch')) $('notifyToastSwitch').checked = settings.notifyToast;
  if ($('notifySoundSwitch')) $('notifySoundSwitch').checked = settings.notifySound;
  if ($('wallpaperSelect')) $('wallpaperSelect').value = settings.wallpaper;
}

export function toggleTheme() {
  setSetting('theme', settings.theme === 'dark' ? 'light' : 'dark');
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗВУК УВЕДОМЛЕНИЙ
   ────────────────────────────────────────────────────────────────────────── */

let soundCtx = null;

export function playNotificationSound() {
  if (!settings.notifySound) return;
  try {
    if (!soundCtx) soundCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = soundCtx.currentTime;

    [880, 1174.66].forEach((freq, i) => {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.07, now + i * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.22);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.26);
    });
  } catch (e) { /* звук не критичен */ }
}

export function shouldShowToastNotification() {
  return settings.notifyToast;
}

/* ──────────────────────────────────────────────────────────────────────────
   СМЕНА ПАРОЛЯ
   ────────────────────────────────────────────────────────────────────────── */

async function handlePasswordSubmit(e) {
  e.preventDefault();
  const btn = $('passwordSubmit');
  const cur = $('currentPassword').value;
  const next = $('newPassword').value;
  const next2 = $('newPassword2').value;

  if (!cur) return showError('passwordError', 'Введите текущий пароль.');
  if (next.length < 6) return showError('passwordError', 'Новый пароль — минимум 6 символов.');
  if (next !== next2) return showError('passwordError', 'Новые пароли не совпадают.');
  if (next === cur) return showError('passwordError', 'Новый пароль совпадает со старым.');

  setLoading(btn, true);
  try {
    await changePassword(cur, next);
    closeModal();
    $('passwordForm').reset();
    toast('Пароль изменён', 'Используйте новый пароль при следующем входе.', 'success');
  } catch (err) {
    showError('passwordError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   УДАЛЕНИЕ АККАУНТА
   ────────────────────────────────────────────────────────────────────────── */

async function handleDeleteAccount() {
  const password = await confirmDialog({
    title: 'Удалить аккаунт',
    text: 'Профиль, контакты и список чатов будут удалены безвозвратно. ' +
          'Для подтверждения введите пароль.',
    okText: 'Удалить навсегда',
    requireInput: true,
    inputPlaceholder: 'Ваш пароль'
  });

  if (!password) return;

  try {
    const slot = ctx.slot;
    await deleteOwnAccount(password);
    const next = await accounts.dropSlot(slot);
    toast('Аккаунт удалён', '', 'success');
    emit('account:deleted', { nextSlot: next });
  } catch (err) {
    toast('Не удалось удалить', errorText(err), 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ОБЪЯВЛЕНИЯ АДМИНИСТРАЦИИ
   ────────────────────────────────────────────────────────────────────────── */

const SEEN_KEY = 'fm.announce.seen';

function seenIds() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function markSeen(id) {
  const list = seenIds();
  if (list.includes(id)) return;
  list.unshift(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) { /* noop */ }
}

/** Показывает новые объявления администрации как уведомления. */
export function startAnnouncementsWatcher() {
  const q = query(ref(ctx.db, P.announcements()), orderByChild('createdAt'), limitToLast(5));
  let first = true;

  listen(q, (snap) => {
    if (!snap.exists()) { first = false; return; }

    const items = [];
    snap.forEach((child) => { items.push({ id: child.key, ...child.val() }); });

    const seen = seenIds();
    items.forEach((a) => {
      // При первом запуске показываем только свежие (за последние сутки).
      const fresh = Date.now() - (a.createdAt || 0) < 24 * 3600 * 1000;
      if (seen.includes(a.id)) return;
      if (first && !fresh) { markSeen(a.id); return; }

      markSeen(a.id);
      toast(a.title || 'Объявление', a.text || '', 'warn', { icon: 'i-megaphone', duration: 10000 });
      playNotificationSound();
    });

    first = false;
  }, 'session');
}

/* ──────────────────────────────────────────────────────────────────────────
   БЛОКИРОВКА АККАУНТА АДМИНИСТРАТОРОМ
   ────────────────────────────────────────────────────────────────────────── */

/** Следит за флагом banned у собственного профиля. */
export function watchOwnBanStatus(onBanned) {
  listen(ref(ctx.db, `${P.user(ctx.uid)}/banned`), (snap) => {
    if (snap.val() === true) onBanned();
  }, 'session');

  // Переключатель двухэтапного подтверждения отражает значение из профиля.
  listen(ref(ctx.db, `${P.user(ctx.uid)}/twoStep`), (snap) => {
    const sw = $('twoStepSwitch');
    if (sw) sw.checked = snap.val() === true;
  }, 'session');
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initSettingsUI(handlers) {
  applyAllSettings();

  $('themeSwitch').addEventListener('change', (e) => {
    setSetting('theme', e.target.checked ? 'dark' : 'light');
  });

  $('authThemeToggle').addEventListener('click', toggleTheme);

  $('langSelect').addEventListener('change', (e) => setSetting('lang', e.target.value));
  $('authLangSelect').addEventListener('change', (e) => setSetting('lang', e.target.value));

  $('wallpaperSelect').addEventListener('change', (e) => setSetting('wallpaper', e.target.value));

  $('notifyToastSwitch').addEventListener('change', (e) => setSetting('notifyToast', e.target.checked));
  $('notifySoundSwitch').addEventListener('change', (e) => {
    setSetting('notifySound', e.target.checked);
    if (e.target.checked) playNotificationSound();
  });

  $('changePasswordBtn').addEventListener('click', () => {
    $('passwordForm').reset();
    $('passwordError').classList.remove('show');
    openModal('modalPassword');
  });
  $('passwordForm').addEventListener('submit', handlePasswordSubmit);

  $('manageAccountsBtn').addEventListener('click', () => {
    accounts.render();
    openModal('modalAccounts');
  });

  $('logoutBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Выйти из аккаунта',
      text: `Выйти из аккаунта ${displayName(ctx.profile)}? Другие добавленные аккаунты останутся.`,
      okText: 'Выйти'
    });
    if (ok) handlers.onLogout();
  });

  $('deleteAccountBtn').addEventListener('click', handleDeleteAccount);

  $('twoStepSwitch').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const ok = await confirmDialog({
      title: on ? 'Включить двухэтапное подтверждение' : 'Отключить двухэтапное подтверждение',
      text: on
        ? 'При каждом новом входе по паролю на вашу почту будет приходить письмо с вопросом «Вы входите в аккаунт?». Без подтверждения вход не откроется.'
        : 'Новые входы будут открываться без подтверждения по почте.',
      okText: on ? 'Включить' : 'Отключить'
    });
    if (!ok) { e.target.checked = !on; return; }
    try {
      await set(ref(ctx.db, `${P.user(ctx.uid)}/twoStep`), on);
      toast(on ? 'Включено' : 'Отключено', '', 'success');
    } catch (err) {
      e.target.checked = !on;
      toast('Не удалось сохранить', err.code || err.message, 'error');
    }
  });

  $('editProfileBtn').addEventListener('click', handlers.onEditProfile);
  $('myAvatarBtn').addEventListener('click', handlers.onOpenSettings);
}

export { settings };

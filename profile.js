/**
 * FastMessage — profile.js
 * ----------------------------------------------------------------------------
 * Профиль пользователя: отображение, редактирование, presence (онлайн/был в сети),
 * настройки приватности и кэш чужих профилей.
 */

import {
  ctx, P,
  ref, get, set, update, onValue, onDisconnect, serverTimestamp,
  runTransaction, listen, track, emit, updateProfile
} from './firebase.js';

import {
  $, toast, setLoading, showError, initials, avatarClass,
  escapeHtml, formatLastSeen, t
} from './app.js';

import { validateUsername, isUsernameFree, errorText } from './auth.js';
import { uploadAvatar } from './media.js';

/* ──────────────────────────────────────────────────────────────────────────
   КЭШ ПРОФИЛЕЙ
   Нужен, чтобы не дёргать базу при каждой отрисовке списка чатов.
   ────────────────────────────────────────────────────────────────────────── */

const profileCache = new Map();   // uid -> profile
const profileWatchers = new Map(); // uid -> Set<callback>
const presenceCache = new Map();  // uid -> {online, lastSeen}

export function cachedProfile(uid) {
  return profileCache.get(uid) || null;
}

export function cachedPresence(uid) {
  return presenceCache.get(uid) || { online: false, lastSeen: 0 };
}

/** Загружает профиль (с кэшем). */
export async function fetchProfile(uid, force = false) {
  if (!uid) return null;
  if (!force && profileCache.has(uid)) return profileCache.get(uid);

  try {
    const snap = await get(ref(ctx.db, P.user(uid)));
    if (!snap.exists()) return null;
    const profile = { uid, ...snap.val() };
    profileCache.set(uid, profile);
    return profile;
  } catch (e) {
    console.warn('[profile] fetch', uid, e.code);
    return null;
  }
}

/** Подписка на живые изменения профиля. */
export function watchProfile(uid, cb, group = 'session') {
  if (!profileWatchers.has(uid)) {
    profileWatchers.set(uid, new Set());

    listen(ref(ctx.db, P.user(uid)), (snap) => {
      if (!snap.exists()) return;
      const profile = { uid, ...snap.val() };
      profileCache.set(uid, profile);
      const set_ = profileWatchers.get(uid);
      if (set_) for (const h of [...set_]) { try { h(profile); } catch (e) { /* noop */ } }
    }, group);
  }

  profileWatchers.get(uid).add(cb);
  const cached = profileCache.get(uid);
  if (cached) cb(cached);
  else fetchProfile(uid).then((p) => { if (p) cb(p); });

  return () => {
    const set_ = profileWatchers.get(uid);
    if (set_) set_.delete(cb);
  };
}

/** Подписка на присутствие пользователя. */
export function watchPresence(uid, cb, group = 'session') {
  const unsub = listen(ref(ctx.db, P.presence(uid)), (snap) => {
    const val = snap.val() || { online: false, lastSeen: 0 };
    presenceCache.set(uid, val);
    cb(val);
  }, group);
  return unsub;
}

export function clearProfileCache() {
  profileCache.clear();
  profileWatchers.clear();
  presenceCache.clear();
}

/* ──────────────────────────────────────────────────────────────────────────
   PRESENCE СОБСТВЕННОГО АККАУНТА
   ────────────────────────────────────────────────────────────────────────── */

let presenceInited = false;

export function initPresence() {
  if (!ctx.uid) return;
  presenceInited = true;

  const myRef = ref(ctx.db, P.presence(ctx.uid));
  const connectedRef = ref(ctx.db, '.info/connected');

  const unsub = onValue(connectedRef, async (snap) => {
    if (snap.val() !== true) return;

    // Когда соединение оборвётся — Firebase сам запишет «офлайн».
    try {
      await onDisconnect(myRef).set({ online: false, lastSeen: serverTimestamp() });
      await set(myRef, { online: true, lastSeen: serverTimestamp() });
    } catch (e) {
      console.warn('[presence]', e.code);
    }
  });
  track(unsub, 'session');

  // Вкладка скрыта — считаем «не в сети», но соединение держим.
  const onVis = () => {
    if (!ctx.uid || !presenceInited) return;
    set(ref(ctx.db, P.presence(ctx.uid)), {
      online: document.visibilityState === 'visible',
      lastSeen: serverTimestamp()
    }).catch(() => {});
  };
  document.addEventListener('visibilitychange', onVis);
  track(() => document.removeEventListener('visibilitychange', onVis), 'session');
}

export async function goOffline() {
  if (!ctx.uid) return;
  presenceInited = false;
  try {
    await set(ref(ctx.db, P.presence(ctx.uid)), { online: false, lastSeen: serverTimestamp() });
  } catch (e) { /* noop */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   ПРИВАТНОСТЬ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Можно ли показать поле профиля данному зрителю.
 * ВАЖНО: это UI-уровень. Настоящая защита — правила БД (см. database.rules.json).
 * @param {Object} profile чей профиль
 * @param {'lastSeen'|'avatar'|'calls'} field
 * @param {boolean} isContact состоит ли зритель в контактах владельца
 */
export function privacyAllows(profile, field, isContact) {
  const mode = (profile && profile.privacy && profile.privacy[field]) || 'everyone';
  if (mode === 'everyone') return true;
  if (mode === 'nobody') return false;
  return !!isContact;
}

export async function savePrivacy(patch) {
  if (!ctx.uid) return;
  const next = { ...(ctx.profile.privacy || {}), ...patch };
  await update(ref(ctx.db, P.user(ctx.uid)), { privacy: next, updatedAt: serverTimestamp() });
  ctx.profile.privacy = next;
  toast(t('saved'), 'Настройки приватности обновлены.', 'success');
}

/* ──────────────────────────────────────────────────────────────────────────
   ОТОБРАЖЕНИЕ ИМЕНИ / АВАТАРА
   ────────────────────────────────────────────────────────────────────────── */

export function displayName(profile) {
  if (!profile) return 'Пользователь';
  const full = `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
  return full || profile.username || 'Пользователь';
}

export function badgesHtml(profile) {
  if (!profile) return '';
  let html = '';
  if (profile.verified) {
    html += '<span class="badge-verified" title="Подтверждённый аккаунт"><svg><use href="#i-verified"/></svg></span>';
  }
  if (Number(profile.premiumUntil) > Date.now()) {
    html += '<span class="badge-premium" title="Premium">💎</span>';
  }
  if (profile.isAdmin) {
    html += '<span class="badge-admin" title="Администратор"><svg><use href="#i-crown"/></svg></span>';
  }
  return html;
}

/**
 * HTML аватара. showPhoto=false — скрываем фото по настройкам приватности.
 */
export function avatarHtml(profile, size = 'sm', opts = {}) {
  const { showPhoto = true, presence = null, id = '' } = opts;
  const name = displayName(profile);
  const idAttr = id ? ` id="${id}"` : '';

  const inner = (showPhoto && profile && profile.photoURL)
    ? `<img src="${escapeHtml(profile.photoURL)}" alt="" loading="lazy" />`
    : `<span>${initials(name)}</span>`;

  const cls = (showPhoto && profile && profile.photoURL) ? '' : ` ${avatarClass(profile ? profile.uid || name : name)}`;
  const av = `<span${idAttr} class="avatar ${size}${cls}">${inner}</span>`;

  if (!presence) return av;
  const dot = presence.online ? '<span class="presence-dot online"></span>' : '<span class="presence-dot"></span>';
  return `<span class="avatar-wrap ${size === 'xs' ? 'xs' : ''}">${av}${dot}</span>`;
}

/** Текст статуса: «в сети» / «был(а) в сети …» / «—» при скрытой приватности. */
export function presenceText(profile, presence, isContact) {
  if (!privacyAllows(profile, 'lastSeen', isContact)) return 'был(а) недавно';
  if (presence && presence.online) return t('online');
  if (presence && presence.lastSeen) return formatLastSeen(presence.lastSeen);
  return t('offline');
}

/* ──────────────────────────────────────────────────────────────────────────
   СОБСТВЕННЫЙ ПРОФИЛЬ В ИНТЕРФЕЙСЕ
   ────────────────────────────────────────────────────────────────────────── */

export function renderMyProfile() {
  const p = ctx.profile;
  if (!p) return;

  const name = displayName(p);

  const myAvatar = $('myAvatar');
  if (myAvatar) {
    myAvatar.outerHTML = avatarHtml(p, 'sm', { id: 'myAvatar' });
  }

  const sAvatar = $('settingsAvatar');
  if (sAvatar) sAvatar.outerHTML = avatarHtml(p, 'lg', { id: 'settingsAvatar' });

  const sName = $('settingsName');
  if (sName) sName.innerHTML = `${escapeHtml(name)} ${badgesHtml(p)}`;

  const sUser = $('settingsUsername');
  if (sUser) sUser.textContent = '@' + (p.username || '');

  const sBio = $('settingsBio');
  if (sBio) sBio.textContent = p.bio || '';

  // Приватность в селектах
  const pv = p.privacy || {};
  if ($('privacyLastSeen')) $('privacyLastSeen').value = pv.lastSeen || 'everyone';
  if ($('privacyAvatar')) $('privacyAvatar').value = pv.avatar || 'everyone';
  if ($('privacyCalls')) $('privacyCalls').value = pv.calls || 'everyone';

  // Админ-вкладка
  const showAdmin = !!(p.isAdmin || p.isModerator);
  $('adminTabBtn').classList.toggle('hidden', !showAdmin);
  $('mobileAdminBtn').classList.toggle('hidden', !showAdmin);
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕДАКТИРОВАНИЕ ПРОФИЛЯ
   ────────────────────────────────────────────────────────────────────────── */

let editAvatarFile = null;
let editAvatarRemoved = false;

export function openEditProfile() {
  const p = ctx.profile;
  if (!p) return;

  editAvatarFile = null;
  editAvatarRemoved = false;

  $('editFirstName').value = p.firstName || '';
  $('editLastName').value = p.lastName || '';
  $('editUsername').value = p.username || '';
  $('editBio').value = p.bio || '';
  $('editBioCount').textContent = (p.bio || '').length;
  $('editUsernameStatus').textContent = '';
  $('editUsernameStatus').className = 'input-status';
  $('editProfileError').classList.remove('show');

  renderEditAvatar();
}

function renderEditAvatar() {
  const box = $('editAvatarPreview');
  const p = ctx.profile;
  if (!box || !p) return;

  if (editAvatarFile) {
    box.innerHTML = `<img src="${URL.createObjectURL(editAvatarFile)}" alt="" />`;
    box.className = 'avatar-preview';
  } else if (!editAvatarRemoved && p.photoURL) {
    box.innerHTML = `<img src="${escapeHtml(p.photoURL)}" alt="" />`;
    box.className = 'avatar-preview';
  } else {
    box.innerHTML = `<span>${initials(displayName(p))}</span>`;
    box.className = `avatar-preview ${avatarClass(p.uid)}`;
  }
}

async function handleEditSubmit(e) {
  e.preventDefault();
  const btn = $('editProfileSubmit');
  const p = ctx.profile;
  if (!p) return;

  const firstName = $('editFirstName').value.trim();
  const lastName = $('editLastName').value.trim();
  const bio = $('editBio').value.trim();
  const uv = validateUsername($('editUsername').value);

  if (!firstName) return showError('editProfileError', 'Введите имя.');
  if (!uv.ok) return showError('editProfileError', uv.text);

  setLoading(btn, true);
  try {
    const oldUsername = p.username;
    const newUsername = uv.value;

    // Смена username — атомарно занимаем новый, затем освобождаем старый.
    if (newUsername !== oldUsername) {
      const free = await isUsernameFree(newUsername, ctx.uid);
      if (!free) {
        setLoading(btn, false);
        return showError('editProfileError', 'Этот username уже занят.');
      }

      const claim = await runTransaction(ref(ctx.db, P.username(newUsername)), (cur) => {
        if (cur === null || cur === ctx.uid) return ctx.uid;
        return undefined;
      });
      if (!claim.committed) {
        setLoading(btn, false);
        return showError('editProfileError', 'Этот username только что заняли.');
      }
    }

    // Аватар
    let photoURL = p.photoURL || '';
    if (editAvatarFile) {
      try {
        photoURL = await uploadAvatar(editAvatarFile, ctx.uid);
      } catch (err) {
        toast('Аватар не загружен', errorText(err), 'warn');
      }
    } else if (editAvatarRemoved) {
      photoURL = '';
    }

    const patch = {
      firstName,
      lastName,
      bio,
      username: newUsername,
      usernameLower: newUsername,
      photoURL,
      searchName: `${firstName} ${lastName}`.trim().toLowerCase(),
      updatedAt: serverTimestamp()
    };

    await update(ref(ctx.db, P.user(ctx.uid)), patch);

    if (newUsername !== oldUsername && oldUsername) {
      await set(ref(ctx.db, P.username(oldUsername)), null).catch(() => {});
    }

    await updateProfile(ctx.auth.currentUser, {
      displayName: firstName,
      photoURL: photoURL || null
    }).catch(() => {});

    Object.assign(ctx.profile, patch);
    profileCache.set(ctx.uid, ctx.profile);

    editAvatarFile = null;
    editAvatarRemoved = false;

    renderMyProfile();
    emit('profile:updated', ctx.profile);
    emit('modal:close');
    toast(t('saved'), 'Профиль обновлён.', 'success');
  } catch (err) {
    showError('editProfileError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initProfileUI() {
  $('editProfileForm').addEventListener('submit', handleEditSubmit);

  $('editAvatarBtn').addEventListener('click', () => $('editAvatarInput').click());
  $('editAvatarInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      toast('Файл слишком большой', 'Максимум 5 МБ для аватара.', 'warn');
      return;
    }
    editAvatarFile = f;
    editAvatarRemoved = false;
    renderEditAvatar();
  });
  $('editAvatarClear').addEventListener('click', () => {
    editAvatarFile = null;
    editAvatarRemoved = true;
    $('editAvatarInput').value = '';
    renderEditAvatar();
  });

  $('editBio').addEventListener('input', (e) => {
    $('editBioCount').textContent = e.target.value.length;
  });

  $('privacyLastSeen').addEventListener('change', (e) => savePrivacy({ lastSeen: e.target.value }));
  $('privacyAvatar').addEventListener('change', (e) => savePrivacy({ avatar: e.target.value }));
  $('privacyCalls').addEventListener('change', (e) => savePrivacy({ calls: e.target.value }));
}

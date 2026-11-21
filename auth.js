/**
 * FastMessage — auth.js
 * ----------------------------------------------------------------------------
 * Регистрация, вход, подтверждение email, восстановление пароля,
 * создание профиля, смена пароля, удаление аккаунта.
 */

import {
  ctx, ADMIN_EMAIL, P,
  ref, get, set, update, remove, runTransaction, serverTimestamp,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendEmailVerification, sendPasswordResetEmail, updateProfile,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, deleteUser,
  emit
} from './firebase.js';

import { $, toast, setLoading, showError, debounce, initials, avatarClass } from './app.js';
import { uploadAvatar } from './media.js';
import * as accounts from './accounts.js';
import { requireTwoStep } from './twostep.js';

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ ЭКРАНА АВТОРИЗАЦИИ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  mode: 'login',           // 'login' | 'register'
  panel: 'main',           // 'main' | 'reset' | 'verify' | 'profile'
  /** Выбранный файл аватара при создании профиля. */
  setupAvatarFile: null,
  /** true — идёт добавление ЕЩЁ одного аккаунта (а не первый вход). */
  addingAccount: false,
  usernameOk: false,
  checkedUsername: ''
};

export function isAddingAccount() {
  return state.addingAccount;
}

export function setAddingAccount(v) {
  state.addingAccount = !!v;
}

/* ──────────────────────────────────────────────────────────────────────────
   ПЕРЕКЛЮЧЕНИЕ ПАНЕЛЕЙ
   ────────────────────────────────────────────────────────────────────────── */

const PANELS = {
  main: 'authPanelMain',
  reset: 'authPanelReset',
  verify: 'authPanelVerify',
  profile: 'authPanelProfile'
};

export function showAuthPanel(name) {
  state.panel = name;
  for (const [key, id] of Object.entries(PANELS)) {
    $(id).classList.toggle('hidden', key !== name);
  }
  const sub = $('authSubtitle');
  if (name === 'profile') sub.textContent = 'Последний шаг — расскажите о себе';
  else if (name === 'verify') sub.textContent = 'Проверьте почту';
  else if (name === 'reset') sub.textContent = 'Восстановление доступа';
  else sub.textContent = 'Быстрые сообщения. Настоящие звонки.';
}

export function setAuthMode(mode) {
  state.mode = mode;
  $('loginForm').classList.toggle('hidden', mode !== 'login');
  $('registerForm').classList.toggle('hidden', mode !== 'register');
  document.querySelectorAll('.auth-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.authtab === mode);
  });
  $('authTabInk').classList.toggle('right', mode === 'register');
  clearErrors();
}

function clearErrors() {
  ['loginError', 'registerError', 'resetError', 'verifyError', 'profileSetupError']
    .forEach((id) => {
      const el = $(id);
      if (el) { el.classList.remove('show', 'success'); el.textContent = ''; }
    });
}

/* ──────────────────────────────────────────────────────────────────────────
   ПЕРЕВОД ОШИБОК FIREBASE
   ────────────────────────────────────────────────────────────────────────── */

const ERRORS = {
  'auth/invalid-email': 'Некорректный email.',
  'auth/user-disabled': 'Этот аккаунт отключён.',
  'auth/user-not-found': 'Пользователь с таким email не найден.',
  'auth/wrong-password': 'Неверный пароль.',
  'auth/invalid-credential': 'Неверный email или пароль.',
  'auth/invalid-login-credentials': 'Неверный email или пароль.',
  'auth/email-already-in-use': 'Этот email уже зарегистрирован.',
  'auth/weak-password': 'Пароль слишком простой — минимум 6 символов.',
  'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже.',
  'auth/network-request-failed': 'Нет связи с сервером. Проверьте интернет.',
  'auth/requires-recent-login': 'Для этого действия нужно войти заново.',
  'auth/missing-password': 'Введите пароль.',
  'auth/operation-not-allowed': 'Вход по email отключён в настройках Firebase.',
  'auth/popup-closed-by-user': 'Окно было закрыто.',
  'permission-denied': 'Недостаточно прав — проверьте правила базы данных.',
  PERMISSION_DENIED: 'Недостаточно прав — проверьте правила базы данных.'
};

export function errorText(err) {
  if (!err) return 'Неизвестная ошибка.';
  const code = err.code || err.message || '';
  for (const [key, text] of Object.entries(ERRORS)) {
    if (code.includes(key)) return text;
  }
  return err.message ? String(err.message).replace('Firebase: ', '') : 'Произошла ошибка.';
}

/* ──────────────────────────────────────────────────────────────────────────
   USERNAME
   ────────────────────────────────────────────────────────────────────────── */

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

export function normalizeUsername(v) {
  return String(v || '').trim().toLowerCase().replace(/^@+/, '');
}

export function validateUsername(v) {
  const u = normalizeUsername(v);
  if (!u) return { ok: false, text: 'Введите username' };
  if (u.length < 3) return { ok: false, text: 'Минимум 3 символа' };
  if (u.length > 24) return { ok: false, text: 'Максимум 24 символа' };
  if (!USERNAME_RE.test(u)) return { ok: false, text: 'Только a-z, 0-9 и _' };
  if (/^\d+$/.test(u)) return { ok: false, text: 'Нельзя только цифры' };
  return { ok: true, value: u };
}

/** Проверяет занятость username. ownUid — чтобы собственный не считался занятым. */
export async function isUsernameFree(username, ownUid) {
  const snap = await get(ref(ctx.db, P.username(username)));
  if (!snap.exists()) return true;
  return snap.val() === ownUid;
}

/** Живая проверка username в форме. */
function wireUsernameCheck(inputId, statusId, hintId) {
  const input = $(inputId);
  const status = $(statusId);
  if (!input || !status) return;

  const run = debounce(async () => {
    const raw = input.value;
    const v = validateUsername(raw);
    state.checkedUsername = normalizeUsername(raw);

    if (!v.ok) {
      status.textContent = v.text;
      status.className = 'input-status bad';
      state.usernameOk = false;
      input.closest('.input-wrap').classList.add('error');
      input.closest('.input-wrap').classList.remove('ok');
      return;
    }

    status.textContent = 'проверяем…';
    status.className = 'input-status load';

    try {
      const free = await isUsernameFree(v.value, ctx.uid);
      // Пока шла проверка, пользователь мог изменить ввод.
      if (normalizeUsername(input.value) !== v.value) return;

      state.usernameOk = free;
      status.textContent = free ? 'свободен' : 'занят';
      status.className = `input-status ${free ? 'ok' : 'bad'}`;
      input.closest('.input-wrap').classList.toggle('ok', free);
      input.closest('.input-wrap').classList.toggle('error', !free);
    } catch (e) {
      status.textContent = '';
      status.className = 'input-status';
      state.usernameOk = false;
      if (hintId) $(hintId).textContent = errorText(e);
    }
  }, 420);

  input.addEventListener('input', () => {
    const cleaned = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (cleaned !== input.value) input.value = cleaned;
    status.textContent = '';
    status.className = 'input-status';
    state.usernameOk = false;
    run();
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   СИЛА ПАРОЛЯ
   ────────────────────────────────────────────────────────────────────────── */

function passwordScore(pw) {
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

function renderPwStrength(pw) {
  const bar = $('pwStrengthBar');
  const label = $('pwStrengthLabel');
  if (!bar) return;
  if (!pw) { bar.style.width = '0'; label.textContent = ''; return; }

  const score = passwordScore(pw);
  const map = [
    { w: '20%', c: '#F43F5E', t: 'Очень слабый' },
    { w: '40%', c: '#FB7185', t: 'Слабый' },
    { w: '62%', c: '#F59E0B', t: 'Средний' },
    { w: '82%', c: '#38BDF8', t: 'Хороший' },
    { w: '100%', c: '#22C55E', t: 'Отличный' }
  ];
  const m = map[score];
  bar.style.width = m.w;
  bar.style.background = m.c;
  label.textContent = m.t;
  label.style.color = m.c;
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕГИСТРАЦИЯ / ВХОД
   ────────────────────────────────────────────────────────────────────────── */

async function handleRegister(e) {
  e.preventDefault();
  clearErrors();

  const email = $('registerEmail').value.trim();
  const pw = $('registerPassword').value;
  const pw2 = $('registerPassword2').value;
  const btn = $('registerSubmit');

  if (!email) return showError('registerError', 'Введите email.');
  if (pw.length < 6) return showError('registerError', 'Пароль должен быть не короче 6 символов.');
  if (pw !== pw2) return showError('registerError', 'Пароли не совпадают.');

  setLoading(btn, true);
  try {
    // Новый аккаунт всегда создаётся в свободном слоте.
    const slot = accounts.allocateSlot();
    const bundle = accounts.useSlot(slot);

    const cred = await createUserWithEmailAndPassword(bundle.auth, email, pw);
    await sendEmailVerification(cred.user);

    ctx.user = cred.user;
    $('verifyEmailLabel').textContent = email;
    showAuthPanel('verify');
    toast('Письмо отправлено', 'Подтвердите email по ссылке из письма.', 'success');
  } catch (err) {
    showError('registerError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  clearErrors();

  const email = $('loginEmail').value.trim();
  const pw = $('loginPassword').value;
  const btn = $('loginSubmit');

  if (!email) return showError('loginError', 'Введите email.');
  if (!pw) return showError('loginError', 'Введите пароль.');

  // Не даём войти в уже добавленный аккаунт дважды.
  const dup = accounts.findSlotByEmail(email);
  if (dup && dup !== ctx.slot) {
    showError('loginError', 'Этот аккаунт уже добавлен. Переключитесь на него в списке аккаунтов.');
    return;
  }

  setLoading(btn, true);
  try {
    const slot = accounts.allocateSlot();
    const bundle = accounts.useSlot(slot);
    const cred = await signInWithEmailAndPassword(bundle.auth, email, pw);
    ctx.user = cred.user;
    // Дальше всё решает onAuthStateChanged в app.js → routeAfterAuth().
    await routeAfterAuth(cred.user, { fresh: true });
  } catch (err) {
    showError('loginError', errorText(err));
    accounts.releaseUnusedSlot();
  } finally {
    setLoading(btn, false);
  }
}

/**
 * Решает, что показать после успешного входа:
 * экран подтверждения email, создание профиля или само приложение.
 */
export async function routeAfterAuth(user, opts = {}) {
  if (!user) return;

  await user.reload().catch(() => {});

  if (!user.emailVerified) {
    $('verifyEmailLabel').textContent = user.email || '—';
    showAuthPanel('verify');
    emit('auth:needs-verification', user);
    return;
  }

  const snap = await get(ref(ctx.db, P.user(user.uid))).catch(() => null);
  if (!snap || !snap.exists() || !snap.val().username) {
    prefillProfileSetup(user);
    showAuthPanel('profile');
    emit('auth:needs-profile', user);
    return;
  }

  // Двухэтапное подтверждение: только при свежем входе по паролю.
  if (opts.fresh && snap.val().twoStep === true) {
    const ok = await requireTwoStep(user);
    if (!ok) {
      await logoutCurrent();
      accounts.releaseUnusedSlot();
      showAuthPanel('main');
      setAuthMode('login');
      showError('loginError', 'Вход не подтверждён. Если это были не вы — смените пароль.');
      return;
    }
  }

  ctx.profile = { uid: user.uid, ...snap.val() };
  emit('auth:ready', ctx.profile);
}

function prefillProfileSetup(user) {
  const base = (user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
  const un = $('setupUsername');
  if (un && !un.value) {
    un.value = base.slice(0, 24);
    un.dispatchEvent(new Event('input'));
  }
  const fn = $('setupFirstName');
  if (fn && !fn.value && base) fn.value = base.charAt(0).toUpperCase() + base.slice(1);
  renderSetupAvatar();
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОДТВЕРЖДЕНИЕ EMAIL
   ────────────────────────────────────────────────────────────────────────── */

async function handleVerifyCheck() {
  const btn = $('verifyCheckBtn');
  const user = ctx.auth && ctx.auth.currentUser;
  if (!user) return showError('verifyError', 'Сессия истекла. Войдите заново.');

  setLoading(btn, true);
  try {
    await user.reload();
    if (user.emailVerified) {
      toast('Email подтверждён', 'Добро пожаловать в FastMessage!', 'success');
      await routeAfterAuth(user);
    } else {
      showError('verifyError', 'Пока не подтверждён. Откройте ссылку из письма и попробуйте снова.');
    }
  } catch (err) {
    showError('verifyError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

async function handleVerifyResend() {
  const btn = $('verifyResendBtn');
  const user = ctx.auth && ctx.auth.currentUser;
  if (!user) return showError('verifyError', 'Сессия истекла. Войдите заново.');

  setLoading(btn, true);
  try {
    await sendEmailVerification(user);
    const el = $('verifyError');
    el.textContent = 'Письмо отправлено повторно.';
    el.classList.add('show', 'success');
  } catch (err) {
    showError('verifyError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ВОССТАНОВЛЕНИЕ ПАРОЛЯ
   ────────────────────────────────────────────────────────────────────────── */

async function handleReset(e) {
  e.preventDefault();
  clearErrors();
  const email = $('resetEmail').value.trim();
  const btn = $('resetSubmit');
  if (!email) return showError('resetError', 'Введите email.');

  setLoading(btn, true);
  try {
    const bundle = accounts.useSlot(ctx.slot || accounts.allocateSlot());
    await sendPasswordResetEmail(bundle.auth, email);
    const el = $('resetError');
    el.textContent = 'Письмо со ссылкой отправлено. Проверьте почту.';
    el.classList.add('show', 'success');
  } catch (err) {
    showError('resetError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   СОЗДАНИЕ ПРОФИЛЯ
   ────────────────────────────────────────────────────────────────────────── */

function renderSetupAvatar() {
  const box = $('setupAvatarPreview');
  if (!box) return;
  const name = $('setupFirstName') ? $('setupFirstName').value : '';
  if (state.setupAvatarFile) {
    const url = URL.createObjectURL(state.setupAvatarFile);
    box.innerHTML = `<img src="${url}" alt="" />`;
  } else {
    box.innerHTML = `<span>${initials(name || '?')}</span>`;
    box.className = `avatar-preview ${avatarClass(name || 'x')}`;
  }
}

async function handleProfileSetup(e) {
  e.preventDefault();
  clearErrors();

  const user = ctx.auth && ctx.auth.currentUser;
  if (!user) return showError('profileSetupError', 'Сессия истекла. Войдите заново.');

  const firstName = $('setupFirstName').value.trim();
  const lastName = $('setupLastName').value.trim();
  const bio = $('setupBio').value.trim();
  const uv = validateUsername($('setupUsername').value);
  const btn = $('profileSetupSubmit');

  if (!firstName) return showError('profileSetupError', 'Введите имя.');
  if (!uv.ok) return showError('profileSetupError', uv.text);

  setLoading(btn, true);
  try {
    const username = uv.value;

    // Атомарно занимаем username: транзакция не даст двум людям взять один и тот же.
    const claim = await runTransaction(ref(ctx.db, P.username(username)), (cur) => {
      if (cur === null || cur === user.uid) return user.uid;
      return undefined; // отмена — уже занят
    });
    if (!claim.committed) {
      setLoading(btn, false);
      return showError('profileSetupError', 'Этот username только что заняли. Выберите другой.');
    }

    let photoURL = '';
    if (state.setupAvatarFile) {
      try {
        photoURL = await uploadAvatar(state.setupAvatarFile, user.uid);
      } catch (err) {
        toast('Аватар не загружен', errorText(err), 'warn');
      }
    }

    const isAdmin = (user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();

    const profile = {
      uid: user.uid,
      email: user.email,
      firstName,
      lastName: lastName || '',
      username,
      usernameLower: username,
      bio: bio || '',
      photoURL: photoURL || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      isAdmin,
      verified: isAdmin,
      banned: false,
      privacy: { lastSeen: 'everyone', avatar: 'everyone', calls: 'everyone' },
      searchName: `${firstName} ${lastName}`.trim().toLowerCase()
    };

    await set(ref(ctx.db, P.user(user.uid)), profile);
    await updateProfile(user, { displayName: firstName, photoURL: photoURL || null }).catch(() => {});

    ctx.profile = profile;
    state.setupAvatarFile = null;
    emit('auth:ready', profile);
    toast('Профиль создан', `Добро пожаловать, ${firstName}!`, 'success');
  } catch (err) {
    showError('profileSetupError', errorText(err));
  } finally {
    setLoading(btn, false);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   СМЕНА ПАРОЛЯ / УДАЛЕНИЕ АККАУНТА
   ────────────────────────────────────────────────────────────────────────── */

export async function changePassword(current, next) {
  const user = ctx.auth.currentUser;
  if (!user) throw new Error('Нет активной сессии.');
  const cred = EmailAuthProvider.credential(user.email, current);
  await reauthenticateWithCredential(user, cred);
  await updatePassword(user, next);
}

/**
 * Полное удаление аккаунта: сначала чистим данные в БД
 * (пока токен ещё действителен), затем удаляем пользователя Auth.
 */
export async function deleteOwnAccount(password) {
  const user = ctx.auth.currentUser;
  if (!user) throw new Error('Нет активной сессии.');

  const cred = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, cred);

  const uid = user.uid;
  const username = ctx.profile && ctx.profile.username;

  // Снимаем свои чаты с публичных веток, насколько позволяют правила.
  try {
    const myChats = await get(ref(ctx.db, P.userChats(uid)));
    if (myChats.exists()) {
      const ids = Object.keys(myChats.val());
      await Promise.all(ids.map((id) => remove(ref(ctx.db, P.userChat(uid, id))).catch(() => {})));
    }
  } catch (e) { /* правила могут запретить — не критично */ }

  const cleanup = {};
  cleanup[P.user(uid)] = null;
  cleanup[P.presence(uid)] = null;
  cleanup[P.contacts(uid)] = null;
  cleanup[P.blocked(uid)] = null;
  cleanup[P.notifications(uid)] = null;
  if (username) cleanup[P.username(username)] = null;

  await update(ref(ctx.db), cleanup).catch(() => {});
  await deleteUser(user);
}

export async function logoutCurrent() {
  try {
    await signOut(ctx.auth);
  } catch (e) {
    console.warn('[auth] signOut:', e);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ UI
   ────────────────────────────────────────────────────────────────────────── */

export function initAuthUI() {
  // Вкладки «Вход» / «Регистрация»
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authtab));
  });

  // Показ/скрытие пароля — работает для всех полей с data-pwtoggle
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pwtoggle]');
    if (!btn) return;
    const input = $(btn.dataset.pwtoggle);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  });

  $('loginForm').addEventListener('submit', handleLogin);
  $('registerForm').addEventListener('submit', handleRegister);
  $('resetForm').addEventListener('submit', handleReset);
  $('profileSetupForm').addEventListener('submit', handleProfileSetup);

  $('registerPassword').addEventListener('input', (e) => renderPwStrength(e.target.value));

  $('forgotPasswordBtn').addEventListener('click', () => {
    $('resetEmail').value = $('loginEmail').value.trim();
    showAuthPanel('reset');
  });
  $('resetBackBtn').addEventListener('click', () => showAuthPanel('main'));

  $('verifyCheckBtn').addEventListener('click', handleVerifyCheck);
  $('verifyResendBtn').addEventListener('click', handleVerifyResend);
  $('verifyLogoutBtn').addEventListener('click', async () => {
    await logoutCurrent();
    accounts.releaseUnusedSlot();
    showAuthPanel('main');
    setAuthMode('login');
  });

  // Аватар при создании профиля
  $('setupAvatarBtn').addEventListener('click', () => $('setupAvatarInput').click());
  $('setupAvatarInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      toast('Файл слишком большой', 'Максимум 5 МБ для аватара.', 'warn');
      return;
    }
    state.setupAvatarFile = f;
    renderSetupAvatar();
  });
  $('setupAvatarClear').addEventListener('click', () => {
    state.setupAvatarFile = null;
    $('setupAvatarInput').value = '';
    renderSetupAvatar();
  });
  $('setupFirstName').addEventListener('input', renderSetupAvatar);

  $('setupBio').addEventListener('input', (e) => {
    $('setupBioCount').textContent = e.target.value.length;
  });

  wireUsernameCheck('setupUsername', 'setupUsernameStatus', 'setupUsernameHint');
  wireUsernameCheck('editUsername', 'editUsernameStatus');

  setAuthMode('login');
  showAuthPanel('main');
}

export { state as authState, renderSetupAvatar };

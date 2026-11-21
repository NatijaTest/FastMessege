/**
 * FastMessage — firebase.js
 * ----------------------------------------------------------------------------
 * Единая точка инициализации Firebase и реэкспорта SDK.
 *
 * Почему здесь «несколько приложений» (named apps):
 *   Firebase Auth хранит сессию под ключом firebase:authUser:{apiKey}:{appName}.
 *   Создавая отдельное приложение на каждый слот аккаунта (acc1, acc2, ...),
 *   мы получаем НЕСКОЛЬКО одновременно живых сессий без хранения паролей.
 *   Переключение аккаунта = смена активного слота, а не повторный логин.
 *
 * Все остальные модули импортируют Firebase ТОЛЬКО отсюда,
 * чтобы в проекте была ровно одна версия SDK.
 */

import {
  initializeApp,
  getApps,
  getApp,
  deleteApp
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';

import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  indexedDBLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  updateProfile,
  updatePassword,
  updateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  deleteUser,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

import {
  getDatabase,
  ref,
  child,
  push,
  set,
  update,
  remove,
  get,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  off,
  query,
  orderByChild,
  orderByKey,
  equalTo,
  limitToLast,
  startAt,
  endAt,
  serverTimestamp,
  onDisconnect,
  runTransaction,
  increment
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';

import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js';

import {
  initializeAppCheck,
  ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app-check.js';

/* ──────────────────────────────────────────────────────────────────────────
   КОНФИГУРАЦИЯ ПРОЕКТА
   ────────────────────────────────────────────────────────────────────────── */

export const firebaseConfig = {
  apiKey: 'AIzaSyAsRxWuA3PdLR1YuVXrNnstfKHjkJvK5nA',
  authDomain: 'fastmaseege.firebaseapp.com',
  projectId: 'fastmaseege',
  storageBucket: 'fastmaseege.firebasestorage.app',
  messagingSenderId: '1025193920711',
  appId: '1:1025193920711:web:4abc08ed3bed333bc156e2',
  measurementId: 'G-5H3Z9HJN1M',
  databaseURL: 'https://fastmaseege-default-rtdb.firebaseio.com'
};

/** Email главного администратора (используется только для UI-подсказок). */
export const ADMIN_EMAIL = 'mtzeroxtreme2004@gmail.com';

/**
 * App Check / reCAPTCHA v3.
 * ВАЖНО: оставлено пустым намеренно. App Check включается только после того,
 * как вы зарегистрируете сайт в Firebase Console → App Check → reCAPTCHA v3
 * и получите site key. Пока ключа нет — App Check НЕ инициализируется,
 * иначе все запросы к базе начнут отклоняться. Инструкция в README.md.
 */
export const APP_CHECK_SITE_KEY = '';

/** Публичные STUN-серверы. TURN настраивается в calls.js (см. README). */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

/* ──────────────────────────────────────────────────────────────────────────
   СЛОТЫ АККАУНТОВ
   ────────────────────────────────────────────────────────────────────────── */

const slotCache = new Map();

/**
 * Возвращает (создавая при необходимости) Firebase-приложение для слота.
 * @param {string} slot например 'acc1'
 */
export function getSlotApp(slot) {
  if (slotCache.has(slot)) return slotCache.get(slot);

  let app;
  const existing = getApps().find((a) => a.name === slot);
  if (existing) {
    app = existing;
  } else {
    app = initializeApp(firebaseConfig, slot);
  }

  const auth = getAuth(app);
  // Сессия должна переживать перезагрузку страницы.
  setPersistence(auth, indexedDBLocalPersistence).catch(() =>
    setPersistence(auth, browserLocalPersistence).catch(() => {})
  );

  const bundle = {
    slot,
    app,
    auth,
    db: getDatabase(app),
    storage: safeStorage(app)
  };

  if (APP_CHECK_SITE_KEY) {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true
      });
    } catch (e) {
      console.warn('[FastMessage] App Check не инициализирован:', e.message);
    }
  }

  slotCache.set(slot, bundle);
  return bundle;
}

function safeStorage(app) {
  try {
    return getStorage(app);
  } catch (e) {
    console.warn('[FastMessage] Firebase Storage недоступен:', e.message);
    return null;
  }
}

/** Полностью уничтожает слот (используется при удалении аккаунта с устройства). */
export async function destroySlotApp(slot) {
  const bundle = slotCache.get(slot);
  slotCache.delete(slot);
  if (bundle) {
    try {
      await deleteApp(bundle.app);
    } catch (e) {
      /* приложение могло быть уже удалено */
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   АКТИВНЫЙ КОНТЕКСТ
   Все модули работают с ctx.db / ctx.auth / ctx.uid текущего аккаунта.
   ────────────────────────────────────────────────────────────────────────── */

export const ctx = {
  slot: null,
  app: null,
  auth: null,
  db: null,
  storage: null,
  /** @type {import('firebase/auth').User|null} */
  user: null,
  /** Профиль из RTDB users/{uid} */
  profile: null,
  get uid() {
    return this.user ? this.user.uid : null;
  },
  get isAdmin() {
    return !!(this.profile && this.profile.isAdmin);
  }
};

/** Делает слот активным контекстом. */
export function activateSlot(slot) {
  const bundle = getSlotApp(slot);
  ctx.slot = bundle.slot;
  ctx.app = bundle.app;
  ctx.auth = bundle.auth;
  ctx.db = bundle.db;
  ctx.storage = bundle.storage;
  ctx.user = bundle.auth.currentUser;
  ctx.profile = null;
  return bundle;
}

/* ──────────────────────────────────────────────────────────────────────────
   МИНИ-ШИНА СОБЫТИЙ (чтобы модули не импортировали друг друга по кругу)
   ────────────────────────────────────────────────────────────────────────── */

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off_(event, handler);
}

export function off_(event, handler) {
  const set_ = listeners.get(event);
  if (set_) set_.delete(handler);
}

export function emit(event, payload) {
  const set_ = listeners.get(event);
  if (!set_) return;
  for (const h of [...set_]) {
    try {
      h(payload);
    } catch (e) {
      console.error(`[FastMessage] обработчик события «${event}» упал:`, e);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕЕСТР REALTIME-ПОДПИСОК
   Любой onValue/onChildAdded регистрируется здесь, чтобы при смене аккаунта
   или выходе все слушатели гарантированно отключились (утечки памяти и
   «чужие» данные в UI — главная проблема мульти-аккаунтных клиентов).
   ────────────────────────────────────────────────────────────────────────── */

const subscriptions = new Set();

/**
 * Регистрирует функцию отписки в группе.
 * @param {Function} unsub
 * @param {string} group имя группы ('session' | 'chat' | 'calls' | ...)
 */
export function track(unsub, group = 'session') {
  const entry = { unsub, group };
  subscriptions.add(entry);
  return () => {
    subscriptions.delete(entry);
    try {
      unsub();
    } catch (e) {
      /* noop */
    }
  };
}

/** Отключает все подписки группы (или вообще все, если группа не указана). */
export function untrackGroup(group) {
  for (const entry of [...subscriptions]) {
    if (group && entry.group !== group) continue;
    subscriptions.delete(entry);
    try {
      entry.unsub();
    } catch (e) {
      /* noop */
    }
  }
}

/** Удобная обёртка: подписка onValue с автоматической регистрацией. */
export function listen(reference, callback, group = 'session', errorCb) {
  const unsub = onValue(
    reference,
    callback,
    errorCb ||
      ((err) => console.warn('[FastMessage] listen error:', reference.toString(), err.code))
  );
  return track(unsub, group);
}

/* ──────────────────────────────────────────────────────────────────────────
   ХЕЛПЕРЫ ПУТЕЙ
   ────────────────────────────────────────────────────────────────────────── */

export const P = {
  user: (uid) => `users/${uid}`,
  username: (name) => `usernames/${String(name).toLowerCase()}`,
  presence: (uid) => `presence/${uid}`,
  contacts: (uid) => `contacts/${uid}`,
  contact: (uid, peer) => `contacts/${uid}/${peer}`,
  blocked: (uid) => `blockedUsers/${uid}`,
  block: (uid, peer) => `blockedUsers/${uid}/${peer}`,
  userChats: (uid) => `userChats/${uid}`,
  userChat: (uid, chatId) => `userChats/${uid}/${chatId}`,
  chat: (chatId) => `chats/${chatId}`,
  messages: (chatId) => `messages/${chatId}`,
  message: (chatId, mid) => `messages/${chatId}/${mid}`,
  typing: (chatId) => `typing/${chatId}`,
  typingUser: (chatId, uid) => `typing/${chatId}/${uid}`,
  call: (callId) => `calls/${callId}`,
  userCalls: (uid) => `userCalls/${uid}`,
  notifications: (uid) => `notifications/${uid}`,
  reports: () => 'reports',
  announcements: () => 'announcements'
};

/**
 * Журнал активности для админ-панели. Пишутся ТОЛЬКО метаданные
 * (кто, кому, когда, тип, длина) — текст сообщений в журнал не попадает.
 * Запись «по возможности»: ошибка журнала никогда не ломает основное действие.
 */
export function logActivity(kind, to, extra = {}) {
  try {
    if (!ctx.db || !ctx.uid) return;
    set(push(ref(ctx.db, 'activityLog')), {
      kind, from: ctx.uid, to: to || '', at: Date.now(), ...extra
    }).catch(() => {});
  } catch (e) { /* журнал не критичен */ }
}

/** ID приватного чата — детерминирован и одинаков у обоих участников. */
export function privateChatId(a, b) {
  return [a, b].sort().join('_');
}

/* ──────────────────────────────────────────────────────────────────────────
   РЕЭКСПОРТ SDK
   ────────────────────────────────────────────────────────────────────────── */

export {
  // app
  initializeApp,
  getApps,
  getApp,
  deleteApp,
  // auth
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendEmailVerification,
  sendPasswordResetEmail,
  onAuthStateChanged,
  updateProfile,
  updatePassword,
  updateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  deleteUser,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  // database
  getDatabase,
  ref,
  child,
  push,
  set,
  update,
  remove,
  get,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  off,
  query,
  orderByChild,
  orderByKey,
  equalTo,
  limitToLast,
  startAt,
  endAt,
  serverTimestamp,
  onDisconnect,
  runTransaction,
  increment,
  // storage
  getStorage,
  storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
};

/**
 * FastMessage — admin.js
 * ----------------------------------------------------------------------------
 * Админ-панель: статистика, список и поиск пользователей, блокировка,
 * жалобы, системные объявления.
 *
 * ━━━ О РЕАЛЬНОЙ ЗАЩИТЕ АДМИНИСТРАТОРА ━━━
 *
 * Проверка `ctx.profile.isAdmin` в этом файле — ТОЛЬКО для интерфейса.
 * Любой пользователь может открыть DevTools и выставить себе этот флаг
 * в памяти браузера. Поэтому админ-панель откроется — но ни одна операция
 * не пройдёт, потому что настоящий контроль живёт в правилах базы данных.
 *
 * В database.rules.json доступ закреплён за конкретным UID:
 *
 *   "admins": { ".read": "auth != null", ".write": false }
 *
 * Узел admins/{uid} заполняется ОДИН раз вручную через консоль Firebase —
 * из приложения в него записать нельзя. Правила ссылаются на него так:
 *
 *   root.child('admins').child(auth.uid).val() === true
 *
 * Это даёт серверную проверку без Cloud Functions. Поле users/{uid}/isAdmin
 * существует только для отрисовки значка: правила запрещают его менять
 * самому пользователю, а записать его может лишь тот, кто уже в admins/.
 *
 * Полноценные Custom Claims (`admin: true` в токене) требуют Firebase Admin
 * SDK, то есть серверного кода — а он в этом проекте по условию исключён.
 * Имитировать claims обычным JavaScript бессмысленно: это не защита.
 * Описанный подход через admins/ — максимум надёжности в рамках
 * «только клиент + правила RTDB», и он действительно работает на сервере.
 */

import {
  ctx, P,
  ref, get, set, update, remove, push, query, orderByChild,
  limitToLast, serverTimestamp, listen, onValue
} from './firebase.js';

import { staffAction, readBalance, readPremium, GIFTS } from './stars.js';

import {
  $, toast, escapeHtml, confirmDialog, openModal, closeModal,
  formatChatTime, formatLastSeen, setLoading
} from './app.js';

import {
  fetchProfile, displayName, avatarHtml, badgesHtml, cachedPresence
} from './profile.js';

import { openChatWith } from './chat.js';

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  users: [],
  reports: [],
  announcements: [],
  tab: 'users',
  userFilter: '',
  /** подтверждённый сервером признак администратора */
  serverAdmin: false,
  loaded: false
};

export function isServerAdmin() { return state.serverAdmin; }

/* ──────────────────────────────────────────────────────────────────────────
   ПРОВЕРКА ПРАВ
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Пытается прочитать admins/{uid}. Это и есть настоящая проверка:
 * если правила не дают доступа к админским операциям, панель всё равно
 * останется бесполезной, но мы хотя бы честно покажем состояние.
 */
export async function verifyAdmin() {
  if (!ctx.uid) return false;
  try {
    const snap = await get(ref(ctx.db, `admins/${ctx.uid}`));
    state.serverAdmin = snap.exists() && snap.val() === true;
  } catch (e) {
    state.serverAdmin = false;
  }

  const warn = $('adminWarning');
  if (warn) {
    if (state.serverAdmin) {
      warn.style.background = 'rgba(34,197,94,.1)';
      warn.style.borderColor = 'rgba(34,197,94,.26)';
      warn.querySelector('svg use').setAttribute('href', '#i-shield');
      warn.querySelector('svg').style.color = 'var(--success)';
      warn.querySelector('b').textContent = 'Права администратора подтверждены сервером';
      warn.querySelector('p').textContent =
        'Ваш UID есть в узле admins/ — правила базы данных разрешают административные операции.';
    } else {
      warn.querySelector('b').textContent = 'Серверные права не подтверждены';
      warn.querySelector('p').innerHTML =
        'Панель открыта по признаку в профиле, но правила базы данных отклонят изменения. ' +
        'Добавьте <code>admins/' + escapeHtml(ctx.uid) + ': true</code> в консоли Firebase (см. README).';
    }
  }

  return state.serverAdmin;
}

/* ──────────────────────────────────────────────────────────────────────────
   СТАТИСТИКА
   ────────────────────────────────────────────────────────────────────────── */

async function loadStats() {
  // Пользователи
  try {
    const snap = await get(ref(ctx.db, 'users'));
    const users = [];
    let online = 0;

    if (snap.exists()) {
      snap.forEach((child) => {
        users.push({ uid: child.key, ...child.val() });
      });
    }

    state.users = users;
    $('statUsers').textContent = users.length;

    // Онлайн
    const pres = await get(ref(ctx.db, 'presence')).catch(() => null);
    if (pres && pres.exists()) {
      pres.forEach((child) => { if (child.val() && child.val().online) online++; });
    }
    $('statOnline').textContent = online;
  } catch (err) {
    $('statUsers').textContent = '—';
    $('statOnline').textContent = '—';
    console.warn('[admin] users:', err.code);
  }

  // Чаты и сообщения
  try {
    const chats = await get(ref(ctx.db, 'chats'));
    $('statChats').textContent = chats.exists() ? Object.keys(chats.val()).length : 0;
  } catch (e) {
    $('statChats').textContent = '—';
  }

  try {
    const msgs = await get(ref(ctx.db, 'messages'));
    let total = 0;
    if (msgs.exists()) {
      msgs.forEach((chat) => {
        const v = chat.val();
        total += v ? Object.keys(v).length : 0;
      });
    }
    $('statMessages').textContent = total >= 1000
      ? (total / 1000).toFixed(1).replace('.0', '') + 'K'
      : total;
  } catch (e) {
    $('statMessages').textContent = '—';
  }
}

/* ────────────────────────────────────────────────────────────────��─────────
   СПИСОК ПОЛЬЗОВАТЕЛЕЙ
   ────────────────────────────────────────────────────────────────────────── */

function renderUsers() {
  const box = $('adminUserList');
  if (!box) return;

  const term = state.userFilter.trim().toLowerCase();
  let list = [...state.users];

  if (term) {
    list = list.filter((u) =>
      displayName(u).toLowerCase().includes(term) ||
      (u.username || '').toLowerCase().includes(term) ||
      (u.email || '').toLowerCase().includes(term) ||
      u.uid.toLowerCase().includes(term));
  }

  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const shown = list.slice(0, 120);

  if (!shown.length) {
    box.innerHTML = '<div class="empty-state small"><svg><use href="#i-users"/></svg><p>Пользователи не найдены</p></div>';
    return;
  }

  box.innerHTML = shown.map((u) => `
    <button class="row-item" data-admin-user="${u.uid}">
      ${avatarHtml(u, 'sm', { showPhoto: true })}
      <span class="row-body">
        <span class="row-top">
          <span class="row-name">${escapeHtml(displayName(u))} ${badgesHtml(u)}</span>
          ${u.banned ? '<span class="report-reason">BAN</span>' : ''}
        </span>
        <span class="row-bottom">
          <span class="row-text">@${escapeHtml(u.username || '—')} · ${escapeHtml(u.email || '')}</span>
        </span>
      </span>
      <svg class="chev" style="width:16px;height:16px;color:var(--muted-2)"><use href="#i-chevron-right"/></svg>
    </button>
  `).join('') + (list.length > shown.length
    ? `<div class="auth-note" style="padding:10px">Показаны первые ${shown.length} из ${list.length}. Уточните поиск.</div>`
    : '');
}

/* ──────────────────────────────────────────────────────────────────────────
   КАРТОЧКА ПОЛЬЗОВАТЕЛЯ
   ────────────────────────────────────────────────────────────────────────── */

async function openUserCard(uid) {
  const u = state.users.find((x) => x.uid === uid) || await fetchProfile(uid);
  if (!u) { toast('Пользователь не найден', '', 'error'); return; }

  const pres = await get(ref(ctx.db, P.presence(uid))).catch(() => null);
  const presence = pres && pres.exists() ? pres.val() : { online: false, lastSeen: 0 };

  let msgCount = '—';
  try {
    const chatsSnap = await get(ref(ctx.db, P.userChats(uid)));
    msgCount = chatsSnap.exists() ? Object.keys(chatsSnap.val()).length + ' чатов' : '0 чатов';
  } catch (e) { /* noop */ }

  const isAdm = !!(ctx.profile && ctx.profile.isAdmin);
  const starsBal = await readBalance(uid);
  const premUntil = isAdm ? await readPremium(uid) : 0;

  $('adminUserBody').innerHTML = `
    <div class="admin-user-card">
      <div class="admin-user-top">
        ${avatarHtml(u, 'lg', { showPhoto: true })}
        <div>
          <div style="font-size:17px;font-weight:700;display:flex;align-items:center;gap:5px">
            ${escapeHtml(displayName(u))} ${badgesHtml(u)}
          </div>
          <div style="color:var(--accent);font-size:13px;font-weight:600">@${escapeHtml(u.username || '—')}</div>
          <div style="color:var(--muted);font-size:12px">
            ${presence.online ? 'в сети' : escapeHtml(formatLastSeen(presence.lastSeen))}
          </div>
        </div>
      </div>

      ${u.bio ? `<div class="report-comment">${escapeHtml(u.bio)}</div>` : ''}

      <dl class="admin-kv">
        <dt>UID</dt><dd>${escapeHtml(u.uid)}</dd>
        <dt>Email</dt><dd>${escapeHtml(u.email || '—')}</dd>
        <dt>Регистрация</dt><dd>${u.createdAt ? escapeHtml(new Date(u.createdAt).toLocaleString('ru')) : '—'}</dd>
        <dt>Активность</dt><dd>${escapeHtml(msgCount)}</dd>
        <dt>Статус</dt><dd>${u.banned ? '<span style="color:var(--danger)">заблокирован</span>' : 'активен'}</dd>
        <dt>Верификация</dt><dd>${u.verified ? 'да' : 'нет'}</dd>
        <dt>Админ</dt><dd>${u.isAdmin ? 'да' : 'нет'}</dd>
        <dt>Модератор</dt><dd>${u.isModerator ? 'да' : 'нет'}</dd>
        <dt>Premium</dt><dd>${premUntil > Date.now() ? '💎 до ' + new Date(premUntil).toLocaleDateString('ru') : 'нет'}</dd>
        <dt>Звёзды</dt><dd>${starsBal == null ? '—' : '⭐ ' + starsBal.toLocaleString('ru')}</dd>
      </dl>

      <div class="admin-user-actions">
        <button class="btn btn-ghost btn-sm" data-admin-act="message" data-uid="${u.uid}">
          <svg><use href="#i-chat"/></svg> Написать
        </button>
        ${isAdm ? `<button class="btn btn-ghost btn-sm" data-admin-act="verify" data-uid="${u.uid}">
          <svg><use href="#i-verified"/></svg> ${u.verified ? 'Снять галочку' : 'Выдать галочку'}
        </button>` : ''}
        <button class="btn btn-ghost btn-sm" data-admin-act="stars-add" data-uid="${u.uid}">⭐ Начислить звёзды</button>
        ${isAdm ? `
        <button class="btn btn-ghost btn-sm" data-admin-act="stars-set" data-uid="${u.uid}">⭐ Задать баланс</button>
        <button class="btn btn-ghost btn-sm" data-admin-act="gift" data-uid="${u.uid}">🎁 Подарить бесплатно</button>
        <button class="btn btn-ghost btn-sm" data-admin-act="premium-give" data-uid="${u.uid}">💎 Выдать Premium</button>
        ${premUntil > Date.now() ? `<button class="btn btn-ghost btn-sm" data-admin-act="premium-remove" data-uid="${u.uid}">💎 Снять Premium</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-admin-act="mod" data-uid="${u.uid}">🛡 ${u.isModerator ? 'Снять модератора' : 'Назначить модератором'}</button>` : ''}
        <button class="btn ${u.banned ? 'btn-ghost' : 'btn-danger'} btn-sm" data-admin-act="ban" data-uid="${u.uid}">
          <svg><use href="#i-ban"/></svg> ${u.banned ? 'Разблокировать' : 'Заблокировать'}
        </button>
      </div>

      ${(isAdm && !state.serverAdmin) ? `
        <div class="admin-warning" style="margin:0">
          <svg><use href="#i-info"/></svg>
          <div><b>Операции будут отклонены</b>
          <p>Ваш UID отсутствует в узле admins/ — правила базы данных не пропустят изменения.</p></div>
        </div>` : ''}
    </div>
  `;

  openModal('modalAdminUser');
}

/* ──────────────────────────────────────────────────────────────────────────
   АДМИНИСТРАТИВНЫЕ ОПЕРАЦИИ
   ────────────────────────────────────────────────────────────────────────── */

async function setBanned(uid, banned) {
  if (uid === ctx.uid) {
    toast('Нельзя заблокировать себя', '', 'warn');
    return;
  }
  try {
    await update(ref(ctx.db, P.user(uid)), {
      banned,
      bannedAt: banned ? Date.now() : null,
      bannedBy: banned ? ctx.uid : null
    });
    const local = state.users.find((u) => u.uid === uid);
    if (local) local.banned = banned;
    renderUsers();
    closeModal();
    toast(banned ? 'Пользователь заблокирован' : 'Пользователь разблокирован', '', 'success');
  } catch (err) {
    toast('Операция отклонена',
      'Правила базы данных не разрешили изменение. Проверьте узел admins/ в консоли Firebase.',
      'error');
  }
}

async function setVerified(uid, verified) {
  try {
    await update(ref(ctx.db, P.user(uid)), { verified });
    const local = state.users.find((u) => u.uid === uid);
    if (local) local.verified = verified;
    renderUsers();
    closeModal();
    toast(verified ? 'Галочка выдана' : 'Галочка снята', '', 'success');
  } catch (err) {
    toast('Операция отклонена', 'Недостаточно прав по правилам базы данных.', 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ЖАЛОБЫ
   ────────────────────────────────────────────────────────────────────────── */

const REASONS = {
  spam: 'Спам',
  abuse: 'Оскорбления',
  fraud: 'Мошенничество',
  content: 'Контент',
  other: 'Другое'
};

function startReportsListener() {
  listen(ref(ctx.db, P.reports()), async (snap) => {
    const list = [];
    if (snap.exists()) {
      snap.forEach((child) => { list.push({ id: child.key, ...child.val() }); });
    }
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    state.reports = list;

    const open = list.filter((r) => r.status === 'open').length;
    const badge = $('adminReportsBadge');
    if (badge) {
      badge.textContent = open;
      badge.classList.toggle('hidden', open === 0);
    }

    await renderReports();
  }, 'session', (err) => {
    $('adminReportList').innerHTML =
      `<div class="empty-state small"><svg><use href="#i-info"/></svg><p>Нет доступа к жалобам: ${escapeHtml(err.code)}</p></div>`;
  });
}

async function renderReports() {
  const box = $('adminReportList');
  const empty = $('adminReportsEmpty');
  if (!box) return;

  if (!state.reports.length) {
    box.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const rows = await Promise.all(state.reports.slice(0, 60).map(async (r) => {
    const target = await fetchProfile(r.targetId);
    const reporter = await fetchProfile(r.reporterId);

    return `
      <div class="report-card">
        <div class="report-head">
          <span class="report-reason">${escapeHtml(REASONS[r.reason] || r.reason)}</span>
          ${r.status !== 'open'
            ? `<span class="report-reason" style="background:rgba(34,197,94,.14);color:#4ADE80">${r.status === 'resolved' ? 'РЕШЕНО' : 'ОТКЛОНЕНО'}</span>`
            : ''}
          <span class="report-time">${escapeHtml(formatChatTime(r.createdAt))}</span>
        </div>
        <div class="report-line">На: <b>${escapeHtml(displayName(target))}</b> @${escapeHtml((target && target.username) || '—')}</div>
        <div class="report-line">От: <b>${escapeHtml(displayName(reporter) || r.reporterName || '—')}</b></div>
        ${r.comment ? `<div class="report-comment">${escapeHtml(r.comment)}</div>` : ''}
        <div class="report-actions">
          <button class="btn btn-ghost btn-sm" data-report-act="open-user" data-uid="${escapeHtml(r.targetId)}">
            <svg><use href="#i-info"/></svg> Профиль
          </button>
          ${!target || !target.banned
            ? `<button class="btn btn-danger btn-sm" data-report-act="ban" data-uid="${escapeHtml(r.targetId)}" data-rid="${r.id}"><svg><use href="#i-ban"/></svg> Заблокировать</button>`
            : ''}
          ${r.status === 'open'
            ? `<button class="btn btn-ghost btn-sm" data-report-act="resolve" data-rid="${r.id}"><svg><use href="#i-check"/></svg> Решено</button>
               <button class="btn btn-ghost btn-sm" data-report-act="dismiss" data-rid="${r.id}"><svg><use href="#i-x"/></svg> Отклонить</button>`
            : `<button class="btn btn-ghost btn-sm" data-report-act="delete" data-rid="${r.id}"><svg><use href="#i-trash"/></svg> Удалить</button>`}
        </div>
      </div>`;
  }));

  box.innerHTML = rows.join('');
}

async function setReportStatus(rid, status) {
  try {
    await update(ref(ctx.db, `${P.reports()}/${rid}`), {
      status,
      reviewedBy: ctx.uid,
      reviewedAt: Date.now()
    });
    toast('Жалоба обновлена', '', 'success');
  } catch (err) {
    toast('Операция отклонена', 'Недостаточно прав.', 'error');
  }
}

async function deleteReport(rid) {
  try {
    await remove(ref(ctx.db, `${P.reports()}/${rid}`));
  } catch (err) {
    toast('Не удалось удалить', 'Недостаточно прав.', 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ОБЪЯВЛЕНИЯ
   ────────────────────────────────────────────────────────────────────────── */

function startAnnouncementsListener() {
  listen(query(ref(ctx.db, P.announcements()), orderByChild('createdAt'), limitToLast(20)), (snap) => {
    const list = [];
    if (snap.exists()) {
      snap.forEach((child) => { list.push({ id: child.key, ...child.val() }); });
    }
    list.reverse();
    state.announcements = list;
    renderAnnouncements();
  }, 'session');
}

function renderAnnouncements() {
  const box = $('announceList');
  if (!box) return;

  if (!state.announcements.length) {
    box.innerHTML = '<div class="empty-state small"><svg><use href="#i-megaphone"/></svg><p>Объявлений нет</p></div>';
    return;
  }

  box.innerHTML = state.announcements.map((a) => `
    <div class="announce-card">
      <h4>${escapeHtml(a.title || 'Объявление')}</h4>
      <p>${escapeHtml(a.text || '')}</p>
      <div class="announce-meta">
        <span>${escapeHtml(formatChatTime(a.createdAt))}</span>
        <button class="icon-btn tiny danger" data-del-announce="${a.id}" title="Удалить"><svg><use href="#i-trash"/></svg></button>
      </div>
    </div>`).join('');
}

async function publishAnnouncement() {
  const title = $('announceTitle').value.trim();
  const text = $('announceText').value.trim();
  const btn = $('announceSendBtn');

  if (!title && !text) {
    toast('Пустое объявление', 'Введите заголовок или текст.', 'warn');
    return;
  }

  setLoading(btn, true);
  try {
    const node = push(ref(ctx.db, P.announcements()));
    await set(node, {
      id: node.key,
      title: title || 'Объявление',
      text,
      authorId: ctx.uid,
      authorName: displayName(ctx.profile),
      createdAt: Date.now()
    });
    $('announceTitle').value = '';
    $('announceText').value = '';
    toast('Объявление опубликовано', 'Пользователи увидят его сразу.', 'success');
  } catch (err) {
    toast('Не удалось опубликовать',
      'Правила базы данных отклонили запись. Проверьте узел admins/.', 'error');
  } finally {
    setLoading(btn, false);
  }
}

async function deleteAnnouncement(id) {
  try {
    await remove(ref(ctx.db, `${P.announcements()}/${id}`));
    toast('Удалено', '', 'success');
  } catch (err) {
    toast('Не удалось удалить', 'Недостаточно прав.', 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАГРУЗКА ПАНЕЛИ
   ────────────────────────────────────────────────────────────────────────── */

export async function loadAdminPanel() {
  if (!ctx.profile || !(ctx.profile.isAdmin || ctx.profile.isModerator)) return;

  const adminMode = !!ctx.profile.isAdmin;
  // Модератору доступны только пользователи и жалобы.
  document.querySelectorAll('[data-admintab="announce"],[data-admintab="gifts"],[data-admintab="log"]').forEach((c) => {
    c.classList.toggle('hidden', !adminMode);
  });
  const warnBox = $('adminWarning');
  if (warnBox) warnBox.classList.toggle('hidden', !adminMode);

  if (adminMode) { startLog(); await verifyAdmin(); }
  await loadStats().catch((e) => console.warn('[admin] статистика:', e));
  renderUsers();

  if (!state.loaded) {
    state.loaded = true;
    startReportsListener();
    startAnnouncementsListener();
  }
}

export function resetAdminState() {
  state.users = [];
  state.reports = [];
  state.announcements = [];
  state.serverAdmin = false;
  state.loaded = false;
  state.userFilter = '';
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────────
   ЖУРНАЛ АКТИВНОСТИ (только метаданные: кто → кому, когда, тип)
   Текст личных сообщений в журнал НЕ записывается.
   ────────────────────────────────────────────────────────────────────────── */

const logState = { items: [], filter: 'all', names: new Map() };

const LOG_TYPE_RU = {
  text: 'текст', image: 'фото', video: 'видео', audio: 'голосовое', voice: 'голосовое',
  file: 'файл', sticker: 'стикер', gif: 'GIF', call: 'звонок'
};
const LOG_ADMIN_RU = {
  'stars-add': 'начислил звёзды', 'stars-set': 'задал баланс', 'premium-give': 'выдал Premium',
  'premium-remove': 'снял Premium', 'mod-on': 'назначил модератора', 'mod-off': 'снял модератора'
};

function startLog() {
  const q = query(ref(ctx.db, 'activityLog'), orderByChild('at'), limitToLast(200));
  listen(q, (snap) => {
    const items = [];
    snap.forEach((c) => { items.push({ id: c.key, ...c.val() }); });
    logState.items = items.reverse();
    renderLog();
  }, 'session');
}

async function logName(uid) {
  if (!uid) return '—';
  if (logState.names.has(uid)) return logState.names.get(uid);
  let name = uid.slice(0, 6);
  try {
    const p = await fetchProfile(uid);
    if (p) name = `${displayName(p)}${p.username ? ' @' + p.username : ''}`;
  } catch (e) { /* noop */ }
  logState.names.set(uid, name);
  return name;
}

function logWhat(i) {
  if (i.kind === 'msg') {
    return `💬 ${LOG_TYPE_RU[i.type] || i.type || 'сообщение'}${i.len ? ' · ' + i.len + ' симв.' : ''}`;
  }
  if (i.kind === 'call') return i.video ? '📹 видеозвонок' : '📞 аудиозвонок';
  if (i.kind === 'gift') {
    const g = GIFTS.find((x) => x.id === i.gift);
    return `🎁 подарок ${g ? g.emoji + ' ' + g.name : (i.gift || '')}${i.price ? ' · ⭐ ' + Number(i.price).toLocaleString('ru') : ''}`;
  }
  if (i.kind === 'admin') {
    return `👑 ${LOG_ADMIN_RU[i.type] || i.type || 'действие'}${i.price ? ' · ' + Number(i.price).toLocaleString('ru') : ''}`;
  }
  return i.kind || '';
}

async function renderLog() {
  const pane = $('adminLogPane');
  if (!pane) return;

  const items = logState.items.filter((i) => logState.filter === 'all' || i.kind === logState.filter);
  const ids = [...new Set(items.flatMap((i) => [i.from, i.to]))];
  await Promise.all(ids.map(logName));

  const chip = (f, label) =>
    `<button class="chip ${logState.filter === f ? 'active' : ''}" data-log-filter="${f}">${label}</button>`;

  pane.innerHTML = `
    <div class="fm-log-note">
      В журнале видно, кто, кому и когда писал или звонил, и тип сообщения.
      Текст личных сообщений не записывается: переписки остаются приватными.
      Содержимое смотрите только в жалобах («Жалобы»).
    </div>
    <div class="chip-row">
      ${chip('all', 'Все')}${chip('msg', '💬 Сообщения')}${chip('call', '📞 Звонки')}
      ${chip('gift', '🎁 Подарки')}${chip('admin', '👑 Админ')}
    </div>
    <div class="fm-log-list">
      ${items.length ? items.map((i) => `
        <div class="fm-log-row">
          <div class="fm-log-top"><span>${new Date(i.at || Date.now()).toLocaleString('ru')}</span></div>
          <div class="fm-log-who">${escapeHtml(logNameSync(i.from))} → ${escapeHtml(logNameSync(i.to))}</div>
          <div class="fm-log-what">${escapeHtml(logWhat(i))}</div>
        </div>`).join('') : '<div class="empty-state small"><p>Записей пока нет.</p></div>'}
    </div>
    ${items.length ? '<button class="btn btn-ghost btn-block" id="adminLogClear">🗑 Очистить журнал</button>' : ''}`;
}

const logNameSync = (uid) => (uid ? logState.names.get(uid) || uid.slice(0, 6) : '—');

export function initAdminUI() {
  // Вкладки внутри панели
  document.querySelectorAll('[data-admintab]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tab = chip.dataset.admintab;
      document.querySelectorAll('[data-admintab]').forEach((c) => {
        c.classList.toggle('active', c === chip);
      });
      document.querySelectorAll('.admin-pane').forEach((p) => {
        p.classList.toggle('active', p.dataset.adminpane === state.tab);
      });
    });
  });

  // Журнал: фильтры и очистка
  const logPane = $('adminLogPane');
  if (logPane) {
    logPane.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-log-filter]');
      if (f) { logState.filter = f.dataset.logFilter; renderLog(); return; }
      if (e.target.closest('#adminLogClear')) {
        const ok = await confirmDialog({ title: 'Очистить журнал', text: 'Все записи журнала будут удалены.', okText: 'Очистить' });
        if (!ok) return;
        try { await set(ref(ctx.db, 'activityLog'), null); toast('Журнал очищен', '', 'success'); }
        catch (err) { toast('Не удалось очистить', err.message || String(err), 'error'); }
      }
    });
  }

  // Поиск пользователей
  let searchTimer;
  $('adminUserSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { state.userFilter = v; renderUsers(); }, 240);
  });

  $('adminUserList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-admin-user]');
    if (row) openUserCard(row.dataset.adminUser);
  });

  // Действия в карточке
  $('adminUserBody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-admin-act]');
    if (!btn) return;
    const uid = btn.dataset.uid;
    const act = btn.dataset.adminAct;

    if (act === 'message') {
      closeModal();
      openChatWith(uid);
      return;
    }

    if (['stars-add', 'stars-set', 'gift', 'mod', 'premium-give', 'premium-remove'].includes(act)) {
      await staffAction(act, uid);
      return;
    }

    const u = state.users.find((x) => x.uid === uid) || await fetchProfile(uid);

    if (act === 'ban') {
      const banned = !!(u && u.banned);
      const ok = await confirmDialog({
        title: banned ? 'Разблокировать' : 'Заблокировать пользователя',
        text: banned
          ? `Вернуть ${displayName(u)} доступ к сервису?`
          : `${displayName(u)} потеряет доступ к отправке сообщений и звонкам.`,
        okText: banned ? 'Разблокировать' : 'Заблокировать'
      });
      if (ok) await setBanned(uid, !banned);
    } else if (act === 'verify') {
      await setVerified(uid, !(u && u.verified));
    }
  });

  // Жалобы
  $('adminReportList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-report-act]');
    if (!btn) return;
    const { reportAct, uid, rid } = btn.dataset;

    if (reportAct === 'open-user') { openUserCard(uid); return; }

    if (reportAct === 'ban') {
      const u = await fetchProfile(uid);
      const ok = await confirmDialog({
        title: 'Заблокировать пользователя',
        text: `${displayName(u)} потеряет доступ к сервису. Жалоба будет помечена решённой.`,
        okText: 'Заблокировать'
      });
      if (ok) {
        await setBanned(uid, true);
        await setReportStatus(rid, 'resolved');
      }
      return;
    }

    if (reportAct === 'resolve') await setReportStatus(rid, 'resolved');
    else if (reportAct === 'dismiss') await setReportStatus(rid, 'dismissed');
    else if (reportAct === 'delete') await deleteReport(rid);
  });

  // Объявления
  $('announceSendBtn').addEventListener('click', publishAnnouncement);
  $('announceList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-announce]');
    if (!btn) return;
    const ok = await confirmDialog({
      title: 'Удалить объявление', text: 'Объявление исчезнет у всех пользователей.', okText: 'Удалить'
    });
    if (ok) await deleteAnnouncement(btn.dataset.delAnnounce);
  });
}

export { state as adminState };

/**
 * FastMessage — twostep.js
 * ----------------------------------------------------------------------------
 * Двухэтапное подтверждение входа через письмо Firebase.
 *
 * Поток:
 *  1. Пользователь ввёл верный email+пароль, а в профиле включено twoStep.
 *  2. Создаётся запрос loginRequests/{uid} (status: pending) и на почту уходит
 *     письмо со ссылкой (sendSignInLinkToEmail).
 *  3. Владелец открывает ссылку (на любом устройстве) → экран
 *     «Вы входите в аккаунт?» → «Да» (approved) или «Нет» (denied).
 *  4. Исходное устройство слушает status: approved → входит, denied → выход.
 *
 * ВАЖНО: в консоли Firebase включите Authentication → Sign-in method →
 * Email/Password → «Email link (passwordless sign-in)», а домен сайта должен
 * быть в Authorized domains. Это «мягкая» защита на стороне клиента.
 */
import {
  ctx, getSlotApp, ref, set, remove, onValue, update, get,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut
} from './firebase.js';

const WAIT_MS = 10 * 60 * 1000;
const EMAIL_KEY = 'fm.2fa.email';

function overlay(html) {
  let el = document.getElementById('fm2faOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fm2faOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(8,13,24,.96);padding:16px;font-family:inherit;color:#fff';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="max-width:420px;width:100%;background:#131b2e;border:1px solid #26324d;
    border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center">${html}</div>`;
  return el;
}
function closeOverlay() {
  const el = document.getElementById('fm2faOverlay');
  if (el) el.remove();
}
const btn = (id, text, primary) =>
  `<button id="${id}" style="margin:6px 4px 0;padding:11px 18px;border-radius:10px;border:0;cursor:pointer;
    font-size:15px;font-weight:600;${primary ? 'background:#3b82f6;color:#fff' : 'background:#26324d;color:#fff'}">${text}</button>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Вызывается при свежем входе. Возвращает true, если вход подтверждён. */
export function requireTwoStep(user) {
  return new Promise((resolve) => {
    const uid = user.uid;
    const reqId = Math.random().toString(36).slice(2, 12);
    const reqRef = ref(ctx.db, `loginRequests/${uid}`);
    let unsub = null;
    let timer = null;
    let finished = false;

    const finish = async (ok) => {
      if (finished) return;
      finished = true;
      if (unsub) unsub();
      clearTimeout(timer);
      await remove(reqRef).catch(() => {});
      closeOverlay();
      resolve(ok);
    };

    const sendMail = async () => {
      const url = `${location.origin}${location.pathname}?fm2fa=${uid}.${reqId}`;
      await sendSignInLinkToEmail(ctx.auth, user.email, { url, handleCodeInApp: true });
      try { localStorage.setItem(EMAIL_KEY, user.email); } catch (e) { /* noop */ }
    };

    const render = (note = '') => {
      const el = overlay(`
        <div style="font-size:38px">📧</div>
        <h2 style="margin:8px 0">Подтвердите вход</h2>
        <p style="opacity:.85;line-height:1.5">Мы отправили письмо на <b>${esc(user.email)}</b>.<br>
        Откройте ссылку из письма и нажмите «Да, это я». Эта страница сама продолжит вход.</p>
        <p id="fm2faNote" style="color:#fbbf24;min-height:20px">${esc(note)}</p>
        ${btn('fm2faResend', 'Отправить ещё раз', false)}${btn('fm2faCancel', 'Отмена', false)}`);
      el.querySelector('#fm2faResend').onclick = async () => {
        try { await sendMail(); render('Письмо отправлено повторно.'); }
        catch (e) { render('Не удалось отправить: ' + (e.code || e.message)); }
      };
      el.querySelector('#fm2faCancel').onclick = () => finish(false);
    };

    (async () => {
      try {
        await set(reqRef, { id: reqId, status: 'pending', at: Date.now() });
        await sendMail();
        render();
      } catch (e) {
        render('Не удалось отправить письмо: ' + (e.code || e.message) +
          '. Проверьте, что в Firebase включён «Email link».');
      }

      unsub = onValue(ref(ctx.db, `loginRequests/${uid}`), (snap) => {
        const v = snap.val();
        if (!v || v.id !== reqId) return;
        if (v.status === 'approved') finish(true);
        else if (v.status === 'denied') finish(false);
      }, () => {});
      timer = setTimeout(() => finish(false), WAIT_MS);
    })();
  });
}

/**
 * Страница-подтверждение: открывается по ссылке из письма.
 * Возвращает true, если страница обработана (основное приложение запускать не нужно).
 */
export async function handleApprovalLink() {
  const raw = new URLSearchParams(location.search).get('fm2fa');
  if (!raw) return false;
  const app = getSlotApp('approve');
  if (!isSignInWithEmailLink(app.auth, location.href)) return false;

  const [uid, reqId] = raw.split('.');
  let email = '';
  try { email = localStorage.getItem(EMAIL_KEY) || ''; } catch (e) { /* noop */ }

  const askEmail = (note = '') => {
    const el = overlay(`
      <div style="font-size:38px">🔐</div>
      <h2 style="margin:8px 0">Введите ваш email</h2>
      <p style="opacity:.85">Для подтверждения введите почту, на которую пришло письмо.</p>
      <input id="fm2faEmail" type="email" value="${esc(email)}" placeholder="email"
        style="width:100%;padding:11px;border-radius:10px;border:1px solid #26324d;background:#0b1120;color:#fff;box-sizing:border-box">
      <p style="color:#f87171;min-height:20px">${esc(note)}</p>${btn('fm2faGo', 'Продолжить', true)}`);
    el.querySelector('#fm2faGo').onclick = () => proceed(el.querySelector('#fm2faEmail').value.trim());
  };

  const done = (icon, title, text) => {
    overlay(`<div style="font-size:38px">${icon}</div><h2 style="margin:8px 0">${title}</h2>
      <p style="opacity:.85;line-height:1.5">${text}</p>`);
  };

  const proceed = async (mail) => {
    try {
      const cred = await signInWithEmailLink(app.auth, mail, location.href);
      if (cred.user.uid !== uid) {
        await signOut(app.auth);
        return askEmail('Эта ссылка предназначена для другого аккаунта.');
      }
      const snap = await get(ref(app.db, `loginRequests/${uid}`));
      const v = snap.val();
      if (!v || v.id !== reqId || v.status !== 'pending') {
        await signOut(app.auth);
        return done('⌛', 'Запрос устарел', 'Этот вход уже подтверждён, отклонён или истёк.');
      }

      const when = new Date(v.at).toLocaleString();
      const el = overlay(`
        <div style="font-size:38px">🛡️</div>
        <h2 style="margin:8px 0">Вы входите в аккаунт?</h2>
        <p style="opacity:.85;line-height:1.5">Попытка входа: ${esc(when)}.<br>Если это не вы — нажмите «Нет» и смените пароль.</p>
        ${btn('fm2faYes', 'Да, это я', true)}${btn('fm2faNo', 'Нет, это не я', false)}`);

      const answer = async (status) => {
        await update(ref(app.db, `loginRequests/${uid}`), { status }).catch(() => {});
        await signOut(app.auth).catch(() => {});
        history.replaceState(null, '', location.pathname);
        done(status === 'approved' ? '✅' : '⛔',
          status === 'approved' ? 'Вход подтверждён' : 'Вход отклонён',
          status === 'approved' ? 'Можно вернуться на устройство, где вы входили.' : 'Доступ к аккаунту не предоставлен. Рекомендуем сменить пароль.');
      };
      el.querySelector('#fm2faYes').onclick = () => answer('approved');
      el.querySelector('#fm2faNo').onclick = () => answer('denied');
    } catch (e) {
      askEmail('Не удалось подтвердить: ' + (e.code || e.message));
    }
  };

  if (email) proceed(email); else askEmail();
  return true;
}

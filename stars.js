/**
 * FastMessage — stars.js
 * ----------------------------------------------------------------------------
 * Валюта «Fast Message Stars», магазин подарков, заработок звёзд за время на
 * сайте (макс. 100 в сутки), анимация открытия подарка (3-2-1 → огонь),
 * инструменты администратора и модератора.
 *
 * Данные в базе:
 *   stars/{uid}/balance   баланс
 *   stars/{uid}/earn      { day, amount } — заработок за текущие сутки (UTC)
 *   stars/{uid}/pending   покупка, оплаченная, но ещё не доставленная
 *   giftCatalog/{id}      { price } — цены (меняет только админ)
 *   gifts/{uid}/{key}     полученные подарки
 *   moderators/{uid}      true — модератор (пишет только админ)
 *
 * Безопасность — в database_rules.json: клиент не может сам увеличить баланс
 * сверх лимита, не может получить подарок без списания звёзд.
 */

import {
  ctx, P, ref, get, set, update, push, listen, logActivity
} from './firebase.js';

import {
  $, toast, escapeHtml, openModal, closeModal, switchTab
} from './app.js';

import { fetchProfile, displayName } from './profile.js';
import { contactsList } from './contacts.js';

/* ──────────────────────────────────────────────────────────────────────────
   НАСТРОЙКИ
   ────────────────────────────────────────────────────────────────────────── */

const DAILY_CAP = 100;          // максимум звёзд за сутки
const SECONDS_PER_STAR = 180;   // 1 звезда за 3 минуты активности

/** Каталог подарков (картинки — эмодзи, названия собственные). */
export const GIFTS = [
  ['heart', '💝', 'Сердечко', 15], ['teddy', '🧸', 'Мишка', 15],
  ['candy', '🍭', 'Леденец', 15], ['hat', '🎩', 'Шляпа фокусника', 15],
  ['box', '🎁', 'Подарок', 25], ['rose', '🌹', 'Роза', 25],
  ['sakura', '🌸', 'Сакура', 25], ['balloon', '🎈', 'Шарик', 25],
  ['bouquet', '💐', 'Букет', 50], ['cake', '🎂', 'Торт', 50],
  ['rocket', '🚀', 'Ракета', 50], ['champagne', '🍾', 'Шампанское', 50],
  ['cup', '🏆', 'Кубок', 100], ['ring', '💍', 'Кольцо', 100],
  ['diamond', '💎', 'Бриллиант', 100], ['watch', '⌚', 'Часы', 100],
  ['lamp', '🪔', 'Лампа джинна', 150], ['ball', '🔮', 'Хрустальный шар', 150],
  ['monkey', '🐵', 'Обезьянка', 200], ['potion', '🧪', 'Зелье', 200],
  ['surprise', '🎪', 'Цирк', 300], ['dice', '🎲', 'Удача', 300],
  ['bear', '🐻', 'Большой мишка', 500], ['crystal', '💠', 'Кристалл', 500],
  ['crown', '👑', 'Корона', 1000], ['love', '💘', 'Зелье любви', 1000],
  ['bag', '👜', 'Сумочка', 2500], ['car', '🏎️', 'Спорткар', 2500],
  ['coin', '🪙', 'Золотая монета', 5000], ['castle', '🏰', 'Замок', 5000],
  ['dragon', '🐉', 'Дракон', 10000], ['unicorn', '🦄', 'Единорог', 10000],
  ['island', '🏝️', 'Остров', 50000], ['plane', '✈️', 'Самолёт', 50000],
  ['yacht', '🛥️', 'Яхта', 100000], ['ufo', '🛸', 'НЛО', 100000],
  ['frog', '🐸', 'Лягушка', 600000],
  // Рыночные подарки (цены округлены до кратных 5 — нужно для продажи за 80%)
  ['dog', '🐕', 'Пёс в куртке', 425], ['noodles', '🍜', 'Лапша', 425],
  ['lantern', '🏮', 'Фонарик', 425], ['lolly', '🍭', 'Радужный леденец', 425],
  ['popsicle', '🍫', 'Шоколадное эскимо', 425], ['flamingo', '🦩', 'Фламинго-круг', 410],
  ['olives', '🫒', 'Пакетик оливок', 425], ['backpack', '🎒', 'Рюкзак', 425],
  ['cupcake8', '🧁', 'Капкейк «8»', 425], ['poop', '💩', 'Смешная какашка', 425],
  ['snowman', '⛄', 'Новогодний снеговик', 375], ['stocking', '🧦', 'Новогодний носок', 425],
  ['bangle', '📿', 'Золотой браслет', 9075], ['oscar', '🏆', 'Золотая статуэтка', 5355],
  ['goldlamp', '🪔', 'Золотая лампа', 2615], ['brick', '🧱', 'Красный кирпич', 5960],
  ['blackbear', '🧸', 'Чёрный мишка', 36415], ['skullpotion', '🧪', 'Ядовитое зелье', 4505],
  ['sunglasses', '🕶️', 'Тёмные очки', 10960], ['biceps', '💪', 'Золотой бицепс', 9125],
  ['helmet', '🪖', 'Шлем спартанца', 13535], ['cap', '🧢', 'Кепка', 30250],
  ['plum', '🍇', 'Сочная слива', 18455], ['froggy', '🐸', 'Лягушонок с сердечком', 515000]
].map(([id, emoji, name, price]) => ({ id, emoji, name, price }));

const GIFT_BY_ID = Object.fromEntries(GIFTS.map((g) => [g.id, g]));

/* ── Анимации подарков (CSS-классы ga-* в style.css) ───────────────────── */
const GIFT_ANIM = {
  teddy: 'wake', bear: 'wake', blackbear: 'wake',
  heart: 'pulse', love: 'pulse', bouquet: 'pulse', cupcake8: 'pulse', biceps: 'pulse', froggy: 'pulse',
  candy: 'swing', lolly: 'swing', rose: 'swing', watch: 'swing', bag: 'swing', lantern: 'swing', stocking: 'swing',
  hat: 'wiggle', lamp: 'wiggle', goldlamp: 'wiggle', potion: 'wiggle', skullpotion: 'wiggle', dog: 'wiggle', popsicle: 'wiggle', poop: 'wiggle',
  box: 'shake', champagne: 'shake', dragon: 'shake', noodles: 'shake', brick: 'shake', helmet: 'shake',
  sakura: 'float', balloon: 'float', castle: 'float', island: 'float', yacht: 'float', ufo: 'float', flamingo: 'float', snowman: 'float',
  cake: 'bounce', crown: 'bounce', unicorn: 'bounce', olives: 'bounce', cap: 'bounce', plum: 'bounce',
  cup: 'glow', oscar: 'glow', ring: 'glow', diamond: 'glow', ball: 'glow', crystal: 'glow', sunglasses: 'glow',
  monkey: 'jump', surprise: 'jump', frog: 'jump', backpack: 'jump',
  dice: 'spin', coin: 'spin', bangle: 'spin',
  rocket: 'launch', car: 'launch', plane: 'launch'
};
const GIFT_FX = { blackbear: 'ga-dark', skullpotion: 'ga-green' };

/** Эмодзи подарка с анимацией. */
function artHtml(g) {
  const anim = GIFT_ANIM[g.id] || 'bounce';
  return `<span class="ga ga-${anim} ${GIFT_FX[g.id] || ''}">${g.emoji}</span>`;
}

/** Кейсы. odds: [цена подарка, шанс %]. Лягушка (600000 ⭐) — только в «Удачном». */
export const CASES = [
  { id: 'basic',   emoji: '📦', name: 'Обычный кейс',    price: 200,  odds: [[15, 55], [25, 30], [50, 10], [100, 4], [500, 1]] },
  { id: 'normal',  emoji: '🎁', name: 'Нормальный кейс', price: 500,  odds: [[25, 40], [50, 30], [100, 20], [500, 9], [1000, 1]] },
  { id: 'lucky',   emoji: '🍀', name: 'Удачный кейс',    price: 1000, odds: [[100, 25], [500, 60], [1000, 14], [600000, 1]] },
  { id: 'premium', emoji: '💎', name: 'Premium-кейс',    price: 0, hidden: true, odds: [[25, 45], [50, 30], [100, 15], [500, 7], [1000, 2.5], [2500, 0.5]] }
];
const CASE_BY_ID = Object.fromEntries(CASES.map((c) => [c.id, c]));
const SELL_PERCENT = 80;   // продажа подарка: 80% от цены (должно совпадать с правилами)

const caseGiftIds = (c) => GIFTS.filter((g) => c.odds.some(([p]) => p === g.price)).map((g) => g.id);
const errText = (e) => (e && e.message ? e.message : String(e));

function tier(price) {
  if (price >= 100000) return 'legend';
  if (price >= 5000) return 'epic';
  if (price >= 500) return 'rare';
  return 'common';
}

const TIER_LABEL = { legend: 'Легендарный', epic: 'Эпичный', rare: 'Редкий', common: '' };

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  balance: 0,
  earn: { day: 0, amount: 0 },
  catalog: {},          // id → цена из базы
  catalogLoaded: false,
  gifts: [],            // полученные подарки
  giftsKnown: null,     // ключи, известные после первой загрузки
  tab: 'shop',
  buyGift: null,
  adminTarget: null,    // { uid, name } — режим «бесплатный подарок от админа»
  secs: 0,
  lastActive: Date.now(),
  timer: null,
  busy: false,
  started: false,
  premiumUntil: 0,
  caseCat: {},          // caseCatalog из базы
  sellOff: false,
  welcomeShown: false,
  pcase: null,          // запись о последнем премиум-кейсе
  caseRec: null,       // запись о бесплатном кейсе (если уже открыт)
  caseLoaded: false,
  caseToasted: false,
  caseFinishing: false
};

const fmt = (n) => Number(n || 0).toLocaleString('ru');
const todayIdx = () => Math.floor(Date.now() / 86400000);
const isAdminUI = () => !!(ctx.profile && ctx.profile.isAdmin);
const isStaffUI = () => !!(ctx.profile && (ctx.profile.isAdmin || ctx.profile.isModerator));

const isPremium = () => state.premiumUntil > Date.now();
const dailyCap = () => (isPremium() ? DAILY_CAP * 2 : DAILY_CAP);
const secsPerStar = () => (isPremium() ? SECONDS_PER_STAR / 2 : SECONDS_PER_STAR);
const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru');

function priceOf(id) {
  if (state.catalog[id] != null) return state.catalog[id];
  return GIFT_BY_ID[id] ? GIFT_BY_ID[id].price : 0;
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАПУСК / ОСТАНОВКА
   ────────────────────────────────────────────────────────────────────────── */

export function startStars() {
  if (!ctx.uid) return;
  resetStars();
  state.started = true;

  // Баланс, заработок, незавершённая покупка
  listen(ref(ctx.db, `stars/${ctx.uid}`), (snap) => {
    const v = snap.val() || {};
    state.balance = Number(v.balance) || 0;
    state.earn = v.earn && v.earn.day === todayIdx()
      ? { day: v.earn.day, amount: Number(v.earn.amount) || 0 }
      : { day: todayIdx(), amount: 0 };
    renderWallet();
    if (!state.busy) {
      if (v.pending) finishPending(v.pending);
      else if (v.cpending) finishCasePurchase(v.cpending);
      else if (v.sale) finishSale(v.sale);
    }
  }, 'session');

  // Цены
  listen(ref(ctx.db, 'giftCatalog'), (snap) => {
    const v = snap.val() || {};
    state.catalog = {};
    Object.keys(v).forEach((id) => { if (v[id] && typeof v[id].price === 'number') state.catalog[id] = v[id].price; });
    state.catalogLoaded = Object.keys(state.catalog).length > 0;
    renderPane();
    renderCatalogAdmin();
    maybeShowWelcome();
  }, 'session');

  // Каталог кейсов и настройки
  listen(ref(ctx.db, 'caseCatalog'), (snap) => {
    state.caseCat = snap.val() || {};
    renderPane();
    renderCatalogAdmin();
    maybeShowWelcome();
  }, 'session');
  listen(ref(ctx.db, 'config'), (snap) => {
    const v = snap.val() || {};
    state.sellOff = v.sellOff === true;
    renderPane();
    renderCatalogAdmin();
  }, 'session');

  // Premium
  listen(ref(ctx.db, `premium/${ctx.uid}`), (snap) => {
    const v = snap.val();
    state.premiumUntil = v && Number(v.until) ? Number(v.until) : 0;
    renderPane();
  }, 'session');

  // Премиум-кейс (раз в сутки)
  listen(ref(ctx.db, `pcases/${ctx.uid}`), (snap) => {
    state.pcase = snap.exists() ? snap.val() : null;
    if (state.pcase && !state.busy) finishCase(state.pcase, 'pcases');
    renderPane();
  }, 'session');

  // Бесплатный кейс (один на аккаунт)
  listen(ref(ctx.db, `cases/${ctx.uid}`), (snap) => {
    state.caseRec = snap.exists() ? snap.val() : null;
    state.caseLoaded = true;
    if (state.caseRec && !state.busy) finishCase(state.caseRec);
    maybeShowWelcome();
    renderPane();
  }, 'session');

  // Входящие подарки
  listen(ref(ctx.db, `gifts/${ctx.uid}`), (snap) => {
    const v = snap.val() || {};
    state.gifts = Object.entries(v)
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    const keys = new Set(state.gifts.map((g) => g.key));
    if (state.giftsKnown) {
      state.gifts.filter((g) => !state.giftsKnown.has(g.key) && !g.opened).forEach((g) => {
        const gift = GIFT_BY_ID[g.giftId];
        toast('🎁 Вам подарок!', gift ? gift.name : 'Нажмите, чтобы открыть', 'success', {
          duration: 9000,
          onClick: () => { switchTab('stars'); setTab('mine'); openReceived(g.key); }
        });
      });
    }
    state.giftsKnown = keys;
    renderPane();
  }, 'session');

  // Заработок за время на сайте
  try {
    const saved = JSON.parse(localStorage.getItem(`fm_stars_secs_${ctx.uid}`) || 'null');
    state.secs = saved && saved.day === todayIdx() ? Number(saved.secs) || 0 : 0;
  } catch (e) { state.secs = 0; }

  state.timer = setInterval(tickEarn, 10000);
  renderPane();
}

export function resetStars() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.balance = 0;
  state.earn = { day: 0, amount: 0 };
  state.catalog = {};
  state.catalogLoaded = false;
  state.gifts = [];
  state.giftsKnown = null;
  state.adminTarget = null;
  state.busy = false;
  state.started = false;
  state.caseRec = null;
  state.premiumUntil = 0;
  state.caseCat = {};
  state.sellOff = false;
  state.welcomeShown = false;
  state.pcase = null;
  state.caseLoaded = false;
  state.caseToasted = false;
  state.caseFinishing = false;
  renderPane();
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАРАБОТОК ЗА ВРЕМЯ НА САЙТЕ
   ────────────────────────────────────────────────────────────────────────── */

function markActive() { state.lastActive = Date.now(); }

async function tickEarn() {
  if (!ctx.uid || !state.started) return;
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - state.lastActive > 60000) return; // бездействие не считаем

  const day = todayIdx();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(`fm_stars_secs_${ctx.uid}`) || 'null'); } catch (e) { /* noop */ }
  if (!saved || saved.day !== day) state.secs = 0;

  state.secs += 10;
  try { localStorage.setItem(`fm_stars_secs_${ctx.uid}`, JSON.stringify({ day, secs: state.secs })); } catch (e) { /* noop */ }

  const target = Math.min(dailyCap(), Math.floor(state.secs / secsPerStar()));
  const current = state.earn.day === day ? state.earn.amount : 0;

  if (target > current && !state.busy) {
    state.busy = true;
    try {
      await update(ref(ctx.db, `stars/${ctx.uid}`), {
        balance: state.balance + (target - current),
        'earn/day': day,
        'earn/amount': target
      });
    } catch (e) {
      console.warn('[stars] начисление не прошло:', e.code || e.message);
    }
    state.busy = false;
  }
  renderWallet();
}

/* ──────────────────────────────────────────────────────────────────────────
   ПОКУПКА ПОДАРКА (двухшаговая, чтобы не потерять звёзды при обрыве связи)
   ────────────────────────────────────────────────────────────────────────── */

async function finishPending(p) {
  if (!p || !p.key || !p.to) return;
  state.busy = true;
  try {
    await update(ref(ctx.db), {
      [`gifts/${p.to}/${p.key}`]: {
        giftId: p.giftId, from: ctx.uid, price: p.price,
        at: Date.now(), msg: p.msg || '', opened: false
      },
      [`stars/${ctx.uid}/pending`]: null
    });
    logActivity('gift', p.to, { gift: String(p.giftId).slice(0, 40), price: p.price });
  } catch (err) {
    console.error('[stars] доставка подарка:', err);
    toast('Подарок не доставлен', 'Звёзды сохранены — повторим при следующем входе.', 'warn');
  }
  state.busy = false;
}

async function buyGift(gift, toUid, msg) {
  const price = priceOf(gift.id);

  if (!state.catalogLoaded) {
    toast('Магазин не готов', 'Администратор ещё не загрузил каталог цен.', 'warn');
    return false;
  }
  if (toUid === ctx.uid) { toast('Выберите другого получателя', '', 'warn'); return false; }
  if (state.balance < price) {
    toast('Недостаточно звёзд', `Нужно ${fmt(price)} ⭐, у вас ${fmt(state.balance)} ⭐`, 'warn');
    return false;
  }

  const key = push(ref(ctx.db, `gifts/${toUid}`)).key;
  const pending = { key, giftId: gift.id, to: toUid, price, msg: msg || '' };

  state.busy = true;
  try {
    // Шаг 1: списываем звёзды и фиксируем покупку одной записью.
    await update(ref(ctx.db, `stars/${ctx.uid}`), {
      balance: state.balance - price,
      pending
    });
    // Шаг 2: доставляем подарок получателю.
    await finishPending(pending);
    return true;
  } catch (err) {
    console.error('[stars] покупка:', err);
    toast('Покупка отклонена', `${errText(err)}. Проверьте правила базы и каталог (Админ → Подарки).`, 'error', { duration: 9000 });
    return false;
  } finally {
    state.busy = false;
  }
}

/* ── Бесплатный кейс ──────────────────────────────────────────────────── */

// [цена подарка, шанс %]. Подарки дороже 1000 ⭐ из кейса не выпадают.
const CASE_ODDS = CASE_BY_ID.basic.odds;

// Premium-кейс: лучше шансы, потолок 2500 ⭐.
const PCASE_ODDS = CASE_BY_ID.premium.odds;

function rollCase(odds = CASE_ODDS, pool = null) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = Math.random() * 100;
    let acc = 0;
    let price = odds[0][0];
    for (const [p, w] of odds) {
      acc += w;
      if (r < acc) { price = p; break; }
    }
    const list = GIFTS.filter((g) => g.price === price && (!pool || pool[g.id] === true));
    if (list.length) return list[Math.floor(Math.random() * list.length)];
  }
  return GIFTS.find((g) => g.price === odds[0][0]);
}

const poolOf = (id) => (state.caseCat[id] && state.caseCat[id].pool) || null;

/** Доставляет подарок из кейса (безопасно вызывать повторно). */
async function finishCase(rec, node = 'cases') {
  if (!rec || !rec.key || state.caseFinishing) return;
  state.caseFinishing = true;
  try {
    const exists = await get(ref(ctx.db, `gifts/${ctx.uid}/${rec.key}`));
    if (!exists.exists()) {
      await set(ref(ctx.db, `gifts/${ctx.uid}/${rec.key}`), {
        giftId: rec.giftId, from: ctx.uid, price: rec.price,
        at: Date.now(), msg: node === 'pcases' ? 'Premium-кейс' : 'Бесплатный кейс', opened: false, case: true
      });
    }
  } catch (err) {
    console.warn('[stars] доставка из кейса:', err.code || err.message);
  }
  state.caseFinishing = false;
}

async function doFreeCase() {
  if (state.caseRec || state.busy) return null;
  if (!state.catalogLoaded || !state.caseCat.basic) {
    toast('Кейс пока недоступен', 'Администратор ещё не загрузил каталог подарков.', 'warn');
    return null;
  }
  const gift = rollCase(CASE_ODDS, poolOf('basic'));
  const rec = {
    key: push(ref(ctx.db, `gifts/${ctx.uid}`)).key,
    giftId: gift.id, price: priceOf(gift.id), at: Date.now()
  };

  state.busy = true;
  try {
    await set(ref(ctx.db, `cases/${ctx.uid}`), rec);   // шаг 1: фиксируем результат
    await finishCase(rec);                              // шаг 2: выдаём подарок
  } catch (err) {
    console.error('[stars] кейс:', err);
    toast('Кейс не открылся', errText(err), 'error', { duration: 9000 });
    state.busy = false;
    return null;
  }
  state.busy = false;
  return { gift, value: rec.price, key: rec.key };
}

function openCase() {
  if (state.caseRec) return;
  openCaseScreen(CASE_BY_ID.basic, 'free');
}

async function doPremiumCase() {
  if (state.busy) return null;
  if (!isPremium()) { toast('Нужен Premium', 'Premium-кейс доступен подписчикам.', 'warn'); return null; }
  if (!state.catalogLoaded || !state.caseCat.premium) {
    toast('Кейс пока недоступен', 'Администратор ещё не загрузил каталог.', 'warn');
    return null;
  }
  const gift = rollCase(PCASE_ODDS, poolOf('premium'));
  const rec = {
    key: push(ref(ctx.db, `gifts/${ctx.uid}`)).key,
    giftId: gift.id, price: priceOf(gift.id), at: Date.now(), day: todayIdx()
  };

  state.busy = true;
  try {
    await set(ref(ctx.db, `pcases/${ctx.uid}`), rec);
    await finishCase(rec, 'pcases');
  } catch (err) {
    console.error('[stars] premium-кейс:', err);
    toast('Кейс не открылся', errText(err), 'error', { duration: 9000 });
    state.busy = false;
    return null;
  }
  state.busy = false;
  return { gift, value: rec.price, key: rec.key };
}

function openPremiumCase() {
  if (!isPremium()) { toast('Нужен Premium', 'Premium-кейс доступен подписчикам.', 'warn'); return; }
  openCaseScreen(CASE_BY_ID.premium, 'premium');
}

function maybeShowWelcome() {
  if (state.welcomeShown || !state.caseLoaded || state.caseRec) return;
  if (!state.catalogLoaded || !state.caseCat.basic || !ctx.uid) return;
  state.welcomeShown = true;
  openCaseScreen(CASE_BY_ID.basic, 'free');
}

/* ── Покупка кейса в магазине ─────────────────────────────────────────── */

const casePrice = (id) => (state.caseCat[id] && state.caseCat[id].price != null ? state.caseCat[id].price : CASE_BY_ID[id].price);

async function finishCasePurchase(cp) {
  if (!cp || !cp.key) return false;
  const c = CASE_BY_ID[cp.caseId];
  state.busy = true;
  try {
    await update(ref(ctx.db), {
      [`gifts/${ctx.uid}/${cp.key}`]: {
        giftId: cp.giftId, from: ctx.uid, price: cp.value, at: Date.now(),
        msg: `Кейс: ${c ? c.name : ''}`.slice(0, 120), opened: false, case: true
      },
      [`stars/${ctx.uid}/cpending`]: null
    });
    state.busy = false;
    return true;
  } catch (err) {
    console.error('[stars] выдача из кейса:', err);
    toast('Подарок из кейса не выдан', 'Звёзды сохранены — повторим при следующем входе.', 'warn');
    state.busy = false;
    return false;
  }
}

async function doPaidCase(id) {
  const c = CASE_BY_ID[id];
  if (!c || c.hidden || state.busy) return null;
  const cost = casePrice(id);

  if (!state.catalogLoaded || !state.caseCat[id]) {
    toast('Магазин не готов', 'Администратор должен нажать «Админ → Подарки → Загрузить каталог».', 'warn');
    return null;
  }
  if (state.balance < cost) {
    toast('Недостаточно звёзд', `Нужно ${fmt(cost)} ⭐, у вас ${fmt(state.balance)} ⭐`, 'warn');
    return null;
  }

  const gift = rollCase(c.odds, poolOf(id));
  const cp = {
    key: push(ref(ctx.db, `gifts/${ctx.uid}`)).key,
    caseId: id, giftId: gift.id, cost, value: priceOf(gift.id)
  };

  state.busy = true;
  try {
    await update(ref(ctx.db, `stars/${ctx.uid}`), { balance: state.balance - cost, cpending: cp });
  } catch (err) {
    console.error('[stars] покупка кейса:', err);
    toast('Покупка отклонена', errText(err), 'error', { duration: 9000 });
    state.busy = false;
    return null;
  }
  state.busy = false;

  if (!(await finishCasePurchase(cp))) return null;
  return { gift, value: cp.value, key: cp.key };
}

function buyCase(id) {
  const c = CASE_BY_ID[id];
  if (!c || c.hidden) return;
  if (!state.catalogLoaded || !state.caseCat[id]) {
    toast('Магазин не готов', 'Администратор должен нажать «Админ → Подарки → Загрузить каталог».', 'warn');
    return;
  }
  openCaseScreen(c, 'paid');
}

/* ── Экран открытия кейса: лента-рулетка с подарками ──────────────────── */

let caseScreenOpen = false;

function openCaseScreen(c, mode) {
  if (caseScreenOpen) return;
  caseScreenOpen = true;

  const free = mode === 'free';
  const prem = mode === 'premium';
  const cost = mode === 'paid' ? casePrice(c.id) : 0;
  const pool = poolOf(c.id);

  const possible = GIFTS
    .filter((g) => (pool ? pool[g.id] === true : caseGiftIds(c).includes(g.id)))
    .sort((a, b) => priceOf(b.id) - priceOf(a.id));

  const openLabel = (again) => (free || prem ? 'ОТКРЫТЬ' : `${again ? 'ОТКРЫТЬ ЕЩЁ' : 'ОТКРЫТЬ'} · ⭐ ${fmt(cost)}`);
  const card = (g) => {
    const t = tier(priceOf(g.id));
    return `<div class="fmc-card tier-${t}"><div class="fmc-card-art">${g.emoji}</div><div class="fmc-card-name">${escapeHtml(g.name)}</div></div>`;
  };

  const host = document.createElement('div');
  host.className = 'fmc-host';
  host.innerHTML = `
    <div class="fmc-top">
      <button class="fmc-close" id="fmcClose" aria-label="Закрыть">✕</button>
      <div class="fmc-title">${free ? 'Ваш первый кейс!' : escapeHtml(c.name)}</div>
      <div class="fmc-bal" id="fmcBal">⭐ ${fmt(state.balance)}</div>
    </div>
    <div class="fmc-roulette">
      <div class="fmc-marker"></div>
      <div class="fmc-viewport"><div class="fmc-strip" id="fmcStrip"></div></div>
      <div class="fmc-sparks" id="fmcSparks"></div>
    </div>
    <div class="fmc-result hidden" id="fmcResult"></div>
    <button class="fmc-open" id="fmcOpen">${openLabel(false)}</button>
    <div class="fmc-sub">Возможные подарки в кейсе:</div>
    <div class="fmc-grid">${possible.map(card).join('')}</div>`;
  document.body.appendChild(host);

  const strip = host.querySelector('#fmcStrip');
  const viewport = host.querySelector('.fmc-viewport');
  const openBtn = host.querySelector('#fmcOpen');
  const closeBtn = host.querySelector('#fmcClose');
  const result = host.querySelector('#fmcResult');
  const sparks = host.querySelector('#fmcSparks');
  let spinning = false;

  const randomItem = () => rollCase(c.odds, pool) || possible[0];

  // Лента: сначала просто случайные подарки; перед вращением на нужное место ставим выигрыш.
  const fillStrip = (winGift, winIndex) => {
    const items = [];
    for (let i = 0; i < winIndex + 14; i++) items.push(i === winIndex && winGift ? winGift : randomItem());
    strip.style.transition = 'none';
    strip.style.transform = 'translateX(0)';
    strip.innerHTML = items.map(card).join('');
    void strip.offsetWidth;
  };
  fillStrip(null, 30);

  const spin = (winGift) => new Promise((resolve) => {
    const winIndex = 36 + Math.floor(Math.random() * 8);
    fillStrip(winGift, winIndex);

    const cards = strip.children;
    const pitch = cards[1].offsetLeft - cards[0].offsetLeft;
    const w = cards[0].offsetWidth;
    const jitter = (Math.random() - 0.5) * w * 0.6;                 // остановка не строго по центру карточки
    const target = -(cards[winIndex].offsetLeft + w / 2 - viewport.clientWidth / 2 + jitter);

    // Долгая «живая» остановка: разгон → плавное торможение → несколько коротких
    // «подкрадываний» с паузами, пока лента не встанет на подарок.
    const go = (px, sec, ease) => new Promise((res) => {
      strip.style.transition = `transform ${sec}s ${ease}`;
      strip.style.transform = `translateX(${px}px)`;
      let d = false;
      const fin = (e) => {
        if (e && e.target !== strip) return;
        if (d) return;
        d = true;
        strip.removeEventListener('transitionend', fin);
        res();
      };
      strip.addEventListener('transitionend', fin);
      setTimeout(() => fin(), sec * 1000 + 500);
    });
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      await go(target + pitch * 4.2, 10, 'cubic-bezier(0.12, 0.55, 0.25, 1)');
      await go(target + pitch * 2.0, 4.5, 'cubic-bezier(0.4, 0, 0.3, 1)');
      await pause(600);
      await go(target + pitch * 0.9, 3.2, 'cubic-bezier(0.4, 0, 0.3, 1)');
      await pause(700);
      await go(target + pitch * 0.3, 2.6, 'cubic-bezier(0.4, 0, 0.3, 1)');
      await pause(900);
      await go(target, 2.2, 'ease-in-out');
      await pause(400);
      cards[winIndex].classList.add('win');
      resolve();
    })();
  });

  const burstSparks = () => {
    sparks.innerHTML = '';
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('span');
      p.textContent = i % 3 === 0 ? '✨' : '🔥';
      const a = Math.random() * Math.PI * 2;
      const d = 70 + Math.random() * 130;
      p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
      p.style.setProperty('--dy', `${Math.sin(a) * d - 30}px`);
      p.style.setProperty('--r', `${Math.random() * 360 - 180}deg`);
      p.style.animationDelay = `${Math.random() * 0.15}s`;
      sparks.appendChild(p);
    }
  };

  const close = () => {
    host.remove();
    caseScreenOpen = false;
    renderPane();
  };
  closeBtn.addEventListener('click', () => { if (!spinning) close(); });

  openBtn.addEventListener('click', async () => {
    if (spinning) return;
    spinning = true;
    openBtn.disabled = true;
    closeBtn.disabled = true;
    result.classList.add('hidden');

    const res = free ? await doFreeCase() : prem ? await doPremiumCase() : await doPaidCase(c.id);
    if (!res) {                                   // ошибка/нет звёзд — остаёмся на экране
      spinning = false;
      openBtn.disabled = false;
      closeBtn.disabled = false;
      return;
    }

    await spin(res.gift);
    burstSparks();

    const t = tier(res.value);
    result.innerHTML = `
      <div class="fmc-result-art">${artHtml({ ...res.gift })}</div>
      <div class="fmc-result-text">
        <small>Вам выпало</small>
        <b>${escapeHtml(res.gift.name)}</b>
        <span>⭐ ${fmt(res.value)}${TIER_LABEL[t] ? ' · ' + TIER_LABEL[t] : ''}</span>
      </div>`;
    result.className = `fmc-result tier-${t}`;
    host.querySelector('#fmcBal').textContent = `⭐ ${fmt(state.balance)}`;
    update(ref(ctx.db, `gifts/${ctx.uid}/${res.key}`), { opened: true }).catch(() => {});

    spinning = false;
    closeBtn.disabled = false;
    if (mode === 'paid') {
      openBtn.textContent = openLabel(true);
      openBtn.disabled = false;
    } else {
      openBtn.textContent = 'ЗАБРАТЬ';
      openBtn.disabled = false;
      openBtn.onclick = close;
      openBtn.replaceWith(openBtn.cloneNode(true));
      host.querySelector('#fmcOpen').addEventListener('click', close);
    }
  });
}

/* ── Продажа подарков (80% цены) ──────────────────────────────────────── */

async function finishSale(sale) {
  if (!sale || !sale.key) return false;
  state.busy = true;
  try {
    // 1) метка «продан» (чтобы подарок нельзя было выдать повторно)
    const sold = await get(ref(ctx.db, `soldKeys/${ctx.uid}/${sale.key}`));
    if (!sold.exists()) await set(ref(ctx.db, `soldKeys/${ctx.uid}/${sale.key}`), true);
    // 2) удаляем подарок
    const g = await get(ref(ctx.db, `gifts/${ctx.uid}/${sale.key}`));
    if (g.exists()) await set(ref(ctx.db, `gifts/${ctx.uid}/${sale.key}`), null);
    // 3) зачисляем звёзды
    const b = await get(ref(ctx.db, `stars/${ctx.uid}/balance`));
    const bal = b.exists() ? Number(b.val()) || 0 : 0;
    await update(ref(ctx.db, `stars/${ctx.uid}`), { balance: bal + sale.amount, sale: null });
    state.busy = false;
    return true;
  } catch (err) {
    console.error('[stars] продажа:', err);
    toast('Продажа не завершена', errText(err), 'error', { duration: 9000 });
    state.busy = false;
    return false;
  }
}

async function sellGift(key) {
  const g = state.gifts.find((x) => x.key === key);
  if (!g || !(g.price > 0) || state.busy) return;
  if (state.sellOff) { toast('Продажа отключена', 'Администратор временно отключил продажу.', 'warn'); return; }
  const gift = GIFT_BY_ID[g.giftId] || { name: 'Подарок' };
  const amount = (g.price * SELL_PERCENT) / 100;
  if (!window.confirm(`Продать «${gift.name}» за ${fmt(amount)} ⭐? Подарок исчезнет.`)) return;

  state.busy = true;
  try {
    await set(ref(ctx.db, `stars/${ctx.uid}/sale`), { key, amount });
  } catch (err) {
    console.error('[stars] продажа:', err);
    toast('Продажа отклонена', errText(err), 'error', { duration: 9000 });
    state.busy = false;
    return;
  }
  state.busy = false;
  if (await finishSale({ key, amount })) toast('Продано', `+${fmt(amount)} ⭐`, 'success');
}

async function adminGift(gift, toUid, msg) {
  try {
    const key = push(ref(ctx.db, `gifts/${toUid}`)).key;
    await set(ref(ctx.db, `gifts/${toUid}/${key}`), {
      giftId: gift.id, from: ctx.uid, price: priceOf(gift.id), at: Date.now(), msg: msg || '', opened: false
    });
    return true;
  } catch (err) {
    toast('Не удалось отправить', 'Нужны права администратора (узел admins/).', 'error');
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   АНИМАЦИЯ ОТКРЫТИЯ: маленький подарок → 3-2-1 → огонь → большой подарок
   ────────────────────────────────────────────────────────────────────────── */

let revealBusy = false;

function playReveal({ gift, caption, text }) {
  if (revealBusy) return Promise.resolve();
  revealBusy = true;

  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'fmr-host';
    host.innerHTML = `
      <div class="fmr-stage">
        <div class="fmr-count" id="fmrCount">3</div>
        <div class="fmr-box" id="fmrBox">🎁</div>
        <div class="fmr-fire" id="fmrFire"></div>
        <div class="fmr-final tier-${tier(gift.price)}" id="fmrFinal">
          <div class="fmr-final-art">${artHtml(gift)}</div>
          <div class="fmr-final-name">${escapeHtml(gift.name)}</div>
          <div class="fmr-final-caption">${escapeHtml(caption || '')}</div>
          ${text ? `<div class="fmr-final-text">«${escapeHtml(text)}»</div>` : ''}
          <button class="btn btn-primary" id="fmrClose">Отлично!</button>
        </div>
      </div>`;
    document.body.appendChild(host);

    const count = host.querySelector('#fmrCount');
    const box = host.querySelector('#fmrBox');
    const fire = host.querySelector('#fmrFire');
    const final = host.querySelector('#fmrFinal');

    const done = () => { host.remove(); revealBusy = false; resolve(); };
    host.querySelector('#fmrClose').addEventListener('click', done);

    let n = 3;
    const step = () => {
      if (n > 0) {
        count.textContent = String(n);
        count.classList.remove('pop'); void count.offsetWidth; count.classList.add('pop');
        n -= 1;
        setTimeout(step, 900);
      } else {
        // Огонь
        count.classList.add('hidden');
        host.classList.add('burst');
        for (let i = 0; i < 28; i++) {
          const p = document.createElement('span');
          p.textContent = i % 3 === 0 ? '✨' : '🔥';
          const a = Math.random() * Math.PI * 2;
          const d = 90 + Math.random() * 150;
          p.style.setProperty('--dx', `${Math.cos(a) * d}px`);
          p.style.setProperty('--dy', `${Math.sin(a) * d - 40}px`);
          p.style.setProperty('--r', `${Math.random() * 360 - 180}deg`);
          p.style.animationDelay = `${Math.random() * 0.18}s`;
          fire.appendChild(p);
        }
        setTimeout(() => { box.classList.add('hidden'); final.classList.add('show'); }, 650);
      }
    };
    step();
  });
}

async function openReceived(key) {
  const g = state.gifts.find((x) => x.key === key);
  if (!g) return;
  const gift = GIFT_BY_ID[g.giftId];
  if (!gift) return;

  const from = g.from ? await fetchProfile(g.from).catch(() => null) : null;
  const caption = `От ${from ? displayName(from) : 'неизвестного'}`;
  const first = !g.opened;

  const p = playReveal({ gift: { ...gift, price: g.price || gift.price }, caption, text: g.msg });
  if (first) {
    update(ref(ctx.db, `gifts/${ctx.uid}/${key}`), { opened: true }).catch(() => {});
  }
  await p;
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНТЕРФЕЙС: вкладка «Звёзды»
   ────────────────────────────────────────────────────────────────────────── */

const TG_BUY = 'Guest5214';

function tgBuyUrl(what = 'stars') {
  const who = ctx.profile && ctx.profile.username ? '@' + ctx.profile.username : '';
  const text = `Хочу купить ${what === 'premium' ? 'Premium' : 'звёзды'} FastMessage. Мой аккаунт: ${who} (UID: ${ctx.uid || ''})`;
  return `https://t.me/${TG_BUY}?text=${encodeURIComponent(text)}`;
}

function premiumHtml() {
  const canCase = isPremium() && (!state.pcase || state.pcase.day !== todayIdx());
  return `
    <div class="fm-premium ${isPremium() ? 'on' : ''}">
      <div class="fm-premium-top">
        <span class="fm-premium-ico">💎</span>
        <div class="fm-premium-info"><b>Fast Message Premium</b>
          <small>${isPremium() ? 'Активен до ' + fmtDate(state.premiumUntil) : 'Не подключён'}</small></div>
      </div>
      <ul class="fm-premium-perks">
        <li>💎 Значок Premium рядом с именем</li>
        <li>⚡ Звёзды за время на сайте в 2 раза быстрее</li>
        <li>📈 Лимит заработка 200 ⭐ в сутки вместо 100</li>
        <li>📦 Premium-кейс каждый день (лучшие шансы, до 2500 ⭐)</li>
      </ul>
      ${isPremium()
        ? `<button class="btn btn-primary btn-sm" id="fmPcaseOpen" ${canCase ? '' : 'disabled'}>${canCase ? '📦 Открыть Premium-кейс' : 'Premium-кейс уже открыт сегодня'}</button>`
        : `<a class="btn btn-primary btn-sm fm-tg" href="${tgBuyUrl('premium')}" target="_blank" rel="noopener">✈️ Купить Premium в Telegram</a>`}
    </div>`;
}

function setTab(t) { state.tab = t; renderPane(); }

function renderWallet() {
  const bal = $('fmBal');
  if (!bal) return;
  bal.textContent = fmt(state.balance);

  const day = todayIdx();
  const amt = state.earn.day === day ? state.earn.amount : 0;
  $('fmEarnText').textContent = `Сегодня за время на сайте: ${amt} / ${dailyCap()} ⭐`;
  $('fmEarnBar').style.width = `${Math.min(100, (amt / dailyCap()) * 100)}%`;
}

function renderPane() {
  const pane = $('fmStarsPane');
  if (!pane) return;

  const unopened = state.gifts.filter((g) => !g.opened).length;

  pane.innerHTML = `
    <div class="fm-wallet">
      <div class="fm-wallet-top">
        <span class="fm-wallet-star">⭐</span>
        <div>
          <div class="fm-wallet-bal"><b id="fmBal">${fmt(state.balance)}</b></div>
          <div class="fm-wallet-name">Fast Message Stars</div>
        </div>
      </div>
      <div class="fm-earn"><div class="fm-earn-bar"><i id="fmEarnBar"></i></div>
        <div class="fm-earn-text" id="fmEarnText"></div>
        <div class="fm-earn-hint">1 ⭐ за каждые ${secsPerStar() >= 60 ? secsPerStar() / 60 + ' мин' : secsPerStar() + ' сек'} активности, максимум ${dailyCap()} в сутки.${isPremium() ? ' 💎 Premium: в 2 раза быстрее и больше.' : ''}</div>
      </div>
      <a class="btn btn-primary btn-sm fm-tg" href="${tgBuyUrl()}" target="_blank" rel="noopener">✈️ Купить звёзды в Telegram</a>
    </div>

    ${premiumHtml()}

    ${(!state.caseRec && state.caseLoaded) ? `
      <div class="fm-case">
        <span class="fm-case-art">📦</span>
        <div class="fm-case-info"><b>Бесплатный кейс</b>
          <small>Один на аккаунт. Чаще всего выпадает подарок за 15–25 ⭐, редкие подарки — меньше 1%.</small></div>
        <button class="btn btn-primary btn-sm" id="fmCaseOpen">Открыть</button>
      </div>` : ''}

    ${state.adminTarget ? `
      <div class="fm-admin-banner">
        👑 Режим администратора: бесплатный подарок для <b>${escapeHtml(state.adminTarget.name)}</b>
        <button class="btn btn-ghost btn-sm" id="fmAdminCancel">Отмена</button>
      </div>` : ''}

    <div class="chip-row">
      <button class="chip ${state.tab === 'shop' ? 'active' : ''}" data-fm-tab="shop">🎁 Подарки</button>
      <button class="chip ${state.tab === 'cases' ? 'active' : ''}" data-fm-tab="cases">📦 Кейсы</button>
      <button class="chip ${state.tab === 'mine' ? 'active' : ''}" data-fm-tab="mine">📦 Мои подарки${unopened ? ` (${unopened})` : ''}</button>
    </div>

    ${state.tab === 'shop' ? shopHtml() : state.tab === 'cases' ? casesHtml() : mineHtml()}
  `;
  renderWallet();
}

function shopHtml() {
  const note = state.catalogLoaded ? '' : `
    <div class="fm-note">Цены ещё не загружены. Администратор: «Админ → Подарки → Загрузить каталог».</div>`;
  const cards = [...GIFTS].sort((a, b) => priceOf(a.id) - priceOf(b.id)).map((g) => {
    const price = priceOf(g.id);
    const t = tier(price);
    return `
      <button class="fm-gift tier-${t}" data-fm-gift="${g.id}">
        ${TIER_LABEL[t] ? `<i class="fm-gift-badge">${TIER_LABEL[t]}</i>` : ''}
        <span class="fm-gift-art">${artHtml(g)}</span>
        <span class="fm-gift-name">${escapeHtml(g.name)}</span>
        <span class="fm-gift-price">⭐ ${fmt(price)}</span>
      </button>`;
  }).join('');
  return `${note}<div class="fm-gift-grid">${cards}</div>`;
}

function mineHtml() {
  if (!state.gifts.length) {
    return `<div class="empty-state small"><p>Пока нет подарков. Откройте кейс или попросите друзей прислать вам!</p></div>`;
  }
  return `<div class="fm-mine">${state.gifts.map((g) => {
    const gift = GIFT_BY_ID[g.giftId] || { emoji: '🎁', name: 'Подарок', price: g.price };
    const canSell = g.price > 0 && !state.sellOff;
    return `
      <div class="fm-mine-row">
        <button class="fm-mine-main" data-fm-open="${g.key}">
          <span class="fm-mine-art">${artHtml(gift)}</span>
          <span class="fm-mine-info">
            <b>${escapeHtml(gift.name)}</b>
            <small>${new Date(g.at || Date.now()).toLocaleString('ru')}</small>
          </span>
          ${g.opened ? '' : '<span class="fm-mine-tag new">🔥 Открыть</span>'}
        </button>
        ${canSell ? `<button class="btn btn-ghost btn-sm" data-fm-sell="${g.key}">Продать ⭐ ${fmt(g.price * SELL_PERCENT / 100)}</button>` : ''}
      </div>`;
  }).join('')}</div>`;
}

function casesHtml() {
  const ready = state.catalogLoaded && Object.keys(state.caseCat).length > 0;
  const note = ready ? '' : '<div class="fm-note">Кейсы ещё не загружены. Администратор: «Админ → Подарки → Загрузить каталог».</div>';
  const oddsLine = ([p, w]) => (p === 600000 ? `🐸 Лягушка — ${w}%` : `≈ ${fmt(p)} ⭐ — ${w}%`);
  return note + `<div class="fm-cases">${CASES.filter((c) => !c.hidden).map((c) => `
    <div class="fm-case-shop">
      <div class="fm-case-shop-top">
        <span class="fm-case-art">${c.emoji}</span>
        <div class="fm-case-info"><b>${c.name}</b><small>Шансы выпадения подарков</small></div>
      </div>
      <ul class="fm-odds">${c.odds.map((o) => `<li>${oddsLine(o)}</li>`).join('')}</ul>
      <button class="btn btn-primary btn-sm" data-fm-buycase="${c.id}">Купить за ⭐ ${fmt(casePrice(c.id))}</button>
    </div>`).join('')}</div>`;
}

/* ── Окно покупки ─────────────────────────────────────────────────────── */

async function openBuyModal(giftId) {
  const gift = GIFT_BY_ID[giftId];
  if (!gift) return;
  state.buyGift = gift;
  const price = priceOf(gift.id);
  const admin = !!state.adminTarget;

  $('fmBuyArt').innerHTML = artHtml(gift);
  $('fmBuyName').textContent = gift.name;
  $('fmBuyPrice').textContent = admin ? 'Бесплатно (админ)' : `⭐ ${fmt(price)}`;
  $('fmGiftMsg').value = '';
  $('fmGiftUser').value = '';
  $('fmBuyRecipient').classList.toggle('hidden', admin);
  $('fmBuyOk').querySelector('.btn-label').textContent = admin ? 'Отправить' : 'Купить и отправить';

  const sel = $('fmGiftTo');
  sel.innerHTML = '<option value="">— выберите из контактов —</option>';
  openModal('modalGiftBuy');

  for (const uid of contactsList()) {
    const p = await fetchProfile(uid).catch(() => null);
    if (!p) continue;
    const o = document.createElement('option');
    o.value = uid;
    o.textContent = `${displayName(p)} (@${p.username || '—'})`;
    sel.appendChild(o);
  }
}

async function onBuyConfirm() {
  const gift = state.buyGift;
  if (!gift) return;
  const msg = $('fmGiftMsg').value.trim().slice(0, 120);
  const btn = $('fmBuyOk');
  btn.disabled = true;

  try {
    if (state.adminTarget) {
      const to = state.adminTarget;
      if (await adminGift(gift, to.uid, msg)) {
        closeModal();
        toast('Подарок отправлен', `${gift.name} → ${to.name}`, 'success');
        state.adminTarget = null;
        renderPane();
      }
      return;
    }

    let to = $('fmGiftTo').value;
    const uname = $('fmGiftUser').value.trim().replace(/^@/, '').toLowerCase();
    if (uname) {
      const s = await get(ref(ctx.db, P.username(uname))).catch(() => null);
      if (!s || !s.exists()) { toast('Пользователь не найден', `@${uname}`, 'warn'); return; }
      to = s.val();
    }
    if (!to) { toast('Выберите получателя', '', 'warn'); return; }

    const recipient = await fetchProfile(to).catch(() => null);
    if (await buyGift(gift, to, msg)) {
      closeModal();
      await playReveal({
        gift: { ...gift, price: priceOf(gift.id) },
        caption: `Отправлено: ${recipient ? displayName(recipient) : 'получателю'}`,
        text: msg
      });
    }
  } finally {
    btn.disabled = false;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   АДМИН / МОДЕРАТОР
   ────────────────────────────────────────────────────────────────────────── */

/** Действия из карточки пользователя в админ-панели. */
export async function staffAction(act, uid) {
  const p = await fetchProfile(uid).catch(() => null);
  const name = p ? displayName(p) : uid;

  try {
    if (act === 'stars-add') {
      const n = parseInt(window.prompt(`Сколько звёзд начислить пользователю ${name}?`, '100'), 10);
      if (!n || n <= 0) return;
      const snap = await get(ref(ctx.db, `stars/${uid}/balance`)).catch(() => null);
      const cur = snap && snap.exists() ? Number(snap.val()) || 0 : 0;
      await update(ref(ctx.db, `stars/${uid}`), { balance: cur + n });
      toast('Звёзды начислены', `${name}: +${fmt(n)} ⭐`, 'success');
      logActivity('admin', uid, { type: 'stars-add', price: n });
    } else if (act === 'stars-set' && isAdminUI()) {
      const n = parseInt(window.prompt(`Установить баланс пользователю ${name} (число ≥ 0):`, '0'), 10);
      if (isNaN(n) || n < 0) return;
      await update(ref(ctx.db, `stars/${uid}`), { balance: n });
      toast('Баланс изменён', `${name}: ${fmt(n)} ⭐`, 'success');
      logActivity('admin', uid, { type: 'stars-set', price: n });
    } else if (act === 'gift' && isAdminUI()) {
      state.adminTarget = { uid, name };
      state.tab = 'shop';
      closeModal();
      switchTab('stars');
      renderPane();
    } else if (act === 'premium-give' && isAdminUI()) {
      const days = parseInt(window.prompt(`На сколько дней выдать Premium пользователю ${name}? (7, 30, 365…)`, '30'), 10);
      if (!days || days < 1) return;
      const cur = await readPremium(uid);
      const until = Math.max(Date.now(), cur) + days * 86400000;
      // Сначала авторитетная запись, затем зеркало для значка (правила сверяют их).
      await set(ref(ctx.db, `premium/${uid}`), { until, by: ctx.uid, at: Date.now() });
      await set(ref(ctx.db, `users/${uid}/premiumUntil`), until);
      toast('Premium выдан', `${name}: до ${fmtDate(until)}`, 'success');
      logActivity('admin', uid, { type: 'premium-give', len: days });
    } else if (act === 'premium-remove' && isAdminUI()) {
      await set(ref(ctx.db, `premium/${uid}`), null);
      await set(ref(ctx.db, `users/${uid}/premiumUntil`), null);
      toast('Premium снят', name, 'success');
      logActivity('admin', uid, { type: 'premium-remove' });
    } else if (act === 'mod' && isAdminUI()) {
      const snap = await get(ref(ctx.db, `moderators/${uid}`)).catch(() => null);
      const on = !(snap && snap.exists() && snap.val() === true);
      await update(ref(ctx.db), {
        [`moderators/${uid}`]: on ? true : null,
        [`users/${uid}/isModerator`]: on
      });
      toast(on ? 'Модератор назначен' : 'Модератор снят', name, 'success');
      logActivity('admin', uid, { type: on ? 'mod-on' : 'mod-off' });
    }
  } catch (err) {
    console.error('[stars] staffAction:', err);
    toast('Операция отклонена', 'Правила базы данных не разрешили изменение.', 'error');
  }
}

/** До какого времени (мс) действует Premium у пользователя; 0 — нет. */
export async function readPremium(uid) {
  try {
    const s = await get(ref(ctx.db, `premium/${uid}/until`));
    return s.exists() ? Number(s.val()) || 0 : 0;
  } catch (e) { return 0; }
}

/** Баланс пользователя для карточки (админ/модератор). */
export async function readBalance(uid) {
  try {
    const s = await get(ref(ctx.db, `stars/${uid}/balance`));
    return s.exists() ? Number(s.val()) || 0 : 0;
  } catch (e) { return null; }
}

/** Панель «Подарки» в админке: каталог и цены. */
async function renderCatalogAdmin() {
  const pane = $('adminGiftsPane');
  if (!pane || !isAdminUI()) return;

  pane.innerHTML = `
    <button class="btn btn-primary btn-block" id="fmSyncCatalog">⭐ Загрузить каталог (добавить недостающее)</button>
    <button class="btn btn-ghost btn-block" id="fmResetCases">♻️ Пересоздать кейсы (сбросить шансы и цены)</button>
    <div class="list-section-title">Переключатели</div>
    <div class="fm-mine">
      <div class="fm-mine-row"><span class="fm-mine-info"><b>Продажа подарков</b><small>${state.sellOff ? 'сейчас ВЫКЛЮЧЕНА' : 'сейчас включена'}</small></span>
        <button class="btn btn-ghost btn-sm" id="fmToggleSell">${state.sellOff ? 'Включить' : 'Выключить'}</button></div>
      <div class="fm-mine-row"><span class="fm-mine-info"><b>🐸 Лягушка в Удачном кейсе</b><small>${frogInLucky() ? 'сейчас ВКЛЮЧЕНА (1%)' : 'сейчас выключена'}</small></span>
        <button class="btn btn-ghost btn-sm" id="fmToggleFrog">${frogInLucky() ? 'Выключить' : 'Включить'}</button></div>
    </div>
    <div class="list-section-title">Цены кейсов (нажмите, чтобы изменить)</div>
    <div class="fm-mine">
      ${CASES.filter((c) => !c.hidden).map((c) => `
        <button class="fm-mine-row" data-fm-cprice="${c.id}">
          <span class="fm-mine-art">${c.emoji}</span>
          <span class="fm-mine-info"><b>${c.name}</b><small>${c.id}</small></span>
          <span class="fm-mine-tag">⭐ ${fmt(casePrice(c.id))}${state.caseCat[c.id] ? '' : ' (не в базе)'}</span>
        </button>`).join('')}
    </div>
    <div class="list-section-title">Цены подарков (нажмите, чтобы изменить)</div>
    <div class="fm-mine">
      ${GIFTS.map((g) => `
        <button class="fm-mine-row" data-fm-price="${g.id}">
          <span class="fm-mine-art">${g.emoji}</span>
          <span class="fm-mine-info"><b>${escapeHtml(g.name)}</b><small>${g.id}</small></span>
          <span class="fm-mine-tag">⭐ ${fmt(priceOf(g.id))}${state.catalog[g.id] == null ? ' (не в базе)' : ''}</span>
        </button>`).join('')}
    </div>`;
}

const frogInLucky = () => !!(state.caseCat.lucky && state.caseCat.lucky.pool && state.caseCat.lucky.pool.frog === true);

function casePayload(c) {
  const pool = {};
  caseGiftIds(c).forEach((id) => { pool[id] = true; });
  return { price: c.price, pool };
}

async function resetCases() {
  if (!window.confirm('Пересоздать все кейсы (цены и шансы вернутся к стандартным)?')) return;
  try {
    const all = {};
    CASES.forEach((c) => { all[c.id] = casePayload(c); });
    await set(ref(ctx.db, 'caseCatalog'), all);
    toast('Кейсы пересозданы', '', 'success');
  } catch (err) { toast('Операция отклонена', errText(err), 'error'); }
}

async function toggleSell() {
  try { await set(ref(ctx.db, 'config/sellOff'), !state.sellOff); }
  catch (err) { toast('Операция отклонена', errText(err), 'error'); }
}

async function toggleFrog() {
  try {
    await set(ref(ctx.db, 'caseCatalog/lucky/pool/frog'), frogInLucky() ? null : true);
  } catch (err) { toast('Операция отклонена', errText(err), 'error'); }
}

async function editCasePrice(id) {
  const c = CASE_BY_ID[id];
  const n = parseInt(window.prompt(`Новая цена кейса «${c.name}» (в ⭐):`, String(casePrice(id))), 10);
  if (!n || n < 1) return;
  try { await set(ref(ctx.db, `caseCatalog/${id}/price`), n); toast('Цена изменена', `${c.name}: ${fmt(n)} ⭐`, 'success'); }
  catch (err) { toast('Операция отклонена', errText(err), 'error'); }
}

async function syncCatalog() {
  try {
    const snap = await get(ref(ctx.db, 'giftCatalog')).catch(() => null);
    const have = snap && snap.exists() ? snap.val() : {};
    const patch = {};
    GIFTS.forEach((g) => { if (!have[g.id]) patch[`${g.id}/price`] = g.price; });
    if (Object.keys(patch).length) await update(ref(ctx.db, 'giftCatalog'), patch);

    const csnap = await get(ref(ctx.db, 'caseCatalog')).catch(() => null);
    const chave = csnap && csnap.exists() ? csnap.val() : {};
    const cpatch = {};
    CASES.forEach((c) => { if (!chave[c.id]) cpatch[c.id] = casePayload(c); });
    if (Object.keys(cpatch).length) await update(ref(ctx.db, 'caseCatalog'), cpatch);

    const added = Object.keys(patch).length + Object.keys(cpatch).length;
    toast(added ? 'Каталог загружен' : 'Каталог уже загружен', added ? `Добавлено записей: ${added}` : '', added ? 'success' : 'info');
  } catch (err) {
    toast('Операция отклонена', errText(err), 'error', { duration: 9000 });
  }
}

async function editPrice(id) {
  const g = GIFT_BY_ID[id];
  const n = parseInt(window.prompt(`Новая цена для «${g.name}» (в ⭐):`, String(priceOf(id))), 10);
  if (!n || n < 1) return;
  try {
    await set(ref(ctx.db, `giftCatalog/${id}/price`), n);
    toast('Цена изменена', `${g.name}: ${fmt(n)} ⭐`, 'success');
  } catch (err) {
    toast('Операция отклонена', 'Нужны права администратора.', 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ ИНТЕРФЕЙСА
   ────────────────────────────────────────────────────────────────────────── */

export function initStarsUI() {
  if ($('fmStarsPane')) return;

  // Кнопки вкладки (ПК и мобильная панель)
  const side = document.querySelector('#sidebarTabs .side-tab[data-tab="settings"]');
  if (side) {
    const b = document.createElement('button');
    b.className = 'side-tab'; b.id = 'fmStarsTabBtn'; b.dataset.tab = 'stars';
    b.innerHTML = '<span class="fm-tab-ico">⭐</span><span>Звёзды</span>';
    b.addEventListener('click', () => switchTab('stars'));
    side.before(b);
  }
  const mob = document.querySelector('.mnav-btn[data-tab="settings"]');
  if (mob) {
    const b = document.createElement('button');
    b.className = 'mnav-btn'; b.id = 'fmStarsMobBtn'; b.dataset.tab = 'stars';
    b.innerHTML = '<span class="fm-tab-ico">⭐</span><span>Звёзды</span>';
    b.addEventListener('click', () => switchTab('stars'));
    mob.before(b);
  }

  // Панель
  const settingsPane = document.querySelector('.tab-pane[data-pane="settings"]');
  const pane = document.createElement('section');
  pane.className = 'tab-pane';
  pane.dataset.pane = 'stars';
  pane.id = 'fmStarsPane';
  if (settingsPane) settingsPane.after(pane);

  // Окно покупки
  const host = $('modalHost');
  if (host) {
    const m = document.createElement('div');
    m.className = 'modal small hidden';
    m.id = 'modalGiftBuy';
    m.innerHTML = `
      <header class="modal-head"><h3>Подарок</h3>
        <button class="icon-btn" data-close-modal><svg><use href="#i-x"/></svg></button></header>
      <div class="modal-body">
        <div class="fm-buy-top">
          <div class="fm-buy-art" id="fmBuyArt">🎁</div>
          <div class="fm-buy-name" id="fmBuyName">—</div>
          <div class="fm-buy-price" id="fmBuyPrice">—</div>
        </div>
        <div id="fmBuyRecipient">
          <div class="field"><label for="fmGiftTo">Кому</label>
            <div class="input-wrap"><select id="fmGiftTo"></select></div></div>
          <div class="field"><label for="fmGiftUser">или @username</label>
            <div class="input-wrap"><input type="text" id="fmGiftUser" placeholder="username" autocomplete="off" /></div></div>
        </div>
        <div class="field"><label for="fmGiftMsg">Сообщение (необязательно)</label>
          <div class="input-wrap"><input type="text" id="fmGiftMsg" maxlength="120" placeholder="С праздником!" /></div></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close-modal>Отмена</button>
          <button class="btn btn-primary" id="fmBuyOk"><span class="btn-label">Купить и отправить</span></button>
        </div>
      </div>`;
    host.appendChild(m);
    m.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
    $('fmBuyOk').addEventListener('click', onBuyConfirm);
  }

  // Делегирование кликов в панели
  pane.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-fm-tab]');
    if (tab) { setTab(tab.dataset.fmTab); return; }
    const g = e.target.closest('[data-fm-gift]');
    if (g) { openBuyModal(g.dataset.fmGift); return; }
    const sb = e.target.closest('[data-fm-sell]');
    if (sb) { sellGift(sb.dataset.fmSell); return; }
    const bc = e.target.closest('[data-fm-buycase]');
    if (bc) { buyCase(bc.dataset.fmBuycase); return; }
    const o = e.target.closest('[data-fm-open]');
    if (o) { openReceived(o.dataset.fmOpen); return; }
    if (e.target.closest('#fmCaseOpen')) { openCase(); return; }
    if (e.target.closest('#fmPcaseOpen')) { openPremiumCase(); return; }
    if (e.target.closest('#fmAdminCancel')) { state.adminTarget = null; renderPane(); }
  });

  // Админка: вкладка «Подарки»
  const chip = document.querySelector('[data-admintab="gifts"]');
  if (chip) chip.addEventListener('click', renderCatalogAdmin);
  const gp = $('adminGiftsPane');
  if (gp) {
    gp.addEventListener('click', (e) => {
      if (e.target.closest('#fmSyncCatalog')) { syncCatalog(); return; }
      if (e.target.closest('#fmResetCases')) { resetCases(); return; }
      if (e.target.closest('#fmToggleSell')) { toggleSell(); return; }
      if (e.target.closest('#fmToggleFrog')) { toggleFrog(); return; }
      const cp = e.target.closest('[data-fm-cprice]');
      if (cp) { editCasePrice(cp.dataset.fmCprice); return; }
      const r = e.target.closest('[data-fm-price]');
      if (r) editPrice(r.dataset.fmPrice);
    });
  }

  // Активность пользователя (для заработка)
  ['mousemove', 'keydown', 'touchstart', 'scroll', 'click'].forEach((ev) => {
    window.addEventListener(ev, markActive, { passive: true, capture: true });
  });

  renderPane();
}

export { isStaffUI };

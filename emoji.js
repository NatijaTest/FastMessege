/**
 * FastMessage — emoji.js
 * ----------------------------------------------------------------------------
 * Панель эмодзи (категории, поиск, недавние), GIF-панель и стикеры.
 *
 * Принципиально без платных сторонних API:
 *   - эмодзи — встроенный набор с русскими ключевыми словами;
 *   - стикеры — крупные эмодзи-паки + пользовательские картинки;
 *   - GIF — локальная библиотека пользователя (свои загрузки) + готовые
 *     анимированные SVG-пресеты, не требующие сети.
 */

import { ctx } from './firebase.js';
import { $, toast, escapeHtml, confirmDialog } from './app.js';
import { sendStickerMessage, sendGifMessage, insertIntoComposer } from './messages.js';
import { uploadSticker, uploadGif } from './media.js';

/* ──────────────────────────────────────────────────────────────────────────
   НАБОР ЭМОДЗИ
   ────────────────────────────────────────────────────────────────────────── */

const EMOJI = {
  smileys: {
    icon: '😀',
    title: 'Смайлы и эмоции',
    items: [
      ['😀', 'улыбка смех радость'], ['😃', 'улыбка радость'], ['😄', 'смех радость'],
      ['😁', 'улыбка зубы'], ['😆', 'смех хохот'], ['😅', 'смех пот'],
      ['🤣', 'ржу смех катаюсь'], ['😂', 'слёзы смех ржака'], ['🙂', 'лёгкая улыбка'],
      ['🙃', 'перевёрнутый ирония'], ['😉', 'подмигивание'], ['😊', 'румянец мило'],
      ['😇', 'ангел нимб'], ['🥰', 'влюблён сердечки'], ['😍', 'любовь глаза сердца'],
      ['🤩', 'звёзды восторг'], ['😘', 'поцелуй'], ['😗', 'чмок'], ['😚', 'поцелуй закрытые'],
      ['😙', 'поцелуй улыбка'], ['🥲', 'слеза улыбка'], ['😋', 'вкусно язык'],
      ['😛', 'язык'], ['😜', 'язык подмигивание'], ['🤪', 'сумасшедший дурачок'],
      ['😝', 'язык зажмурился'], ['🤑', 'деньги доллар'], ['🤗', 'обнимашки'],
      ['🤭', 'ой рука рот'], ['🤫', 'тсс тихо'], ['🤔', 'думаю размышление'],
      ['🤐', 'молния рот молчу'], ['🤨', 'бровь скепсис'], ['😐', 'нейтрально'],
      ['😑', 'без эмоций'], ['😶', 'без рта'], ['😏', 'ухмылка'], ['😒', 'недовольство'],
      ['🙄', 'закатил глаза'], ['😬', 'неловко гримаса'], ['🤥', 'врёт нос'],
      ['😌', 'облегчение'], ['😔', 'грусть задумчивость'], ['😪', 'сонный'],
      ['🤤', 'слюни'], ['😴', 'сплю зззз'], ['😷', 'маска болезнь'],
      ['🤒', 'температура болею'], ['🤕', 'травма бинт'], ['🤢', 'тошнит'],
      ['🤮', 'рвота'], ['🤧', 'чихает'], ['🥵', 'жарко'], ['🥶', 'холодно'],
      ['😵', 'без сознания'], ['🤯', 'взрыв мозга'], ['🤠', 'ковбой'],
      ['🥳', 'праздник вечеринка'], ['😎', 'очки круто'], ['🤓', 'ботаник'],
      ['🧐', 'монокль'], ['😕', 'смущение'], ['😟', 'беспокойство'], ['🙁', 'грусть'],
      ['😮', 'удивление ох'], ['😯', 'ого'], ['😲', 'шок'], ['😳', 'покраснел'],
      ['🥺', 'умоляю пожалуйста'], ['😦', 'хмурый рот открыт'], ['😧', 'страдание'],
      ['😨', 'страх'], ['😰', 'тревога пот'], ['😥', 'печаль облегчение'],
      ['😢', 'плачу слеза'], ['😭', 'рыдаю'], ['😱', 'крик ужас'],
      ['😖', 'мучение'], ['😣', 'упорство'], ['😞', 'разочарование'],
      ['😓', 'холодный пот'], ['😩', 'устал'], ['😫', 'утомлён'],
      ['🥱', 'зевок'], ['😤', 'пар из носа злость'], ['😡', 'злой красный'],
      ['😠', 'сердитый'], ['🤬', 'ругань мат'], ['😈', 'чертёнок'],
      ['👿', 'злой чёрт'], ['💀', 'череп'], ['💩', 'какашка'],
      ['🤡', 'клоун'], ['👻', 'призрак'], ['👽', 'инопланетянин'],
      ['🤖', 'робот'], ['🎃', 'тыква хэллоуин']
    ]
  },
  gestures: {
    icon: '👍',
    title: 'Жесты и люди',
    items: [
      ['👍', 'лайк класс палец вверх'], ['👎', 'дизлайк палец вниз'], ['👌', 'окей'],
      ['🤌', 'щепотка итальянский'], ['✌️', 'мир виктория'], ['🤞', 'скрестил пальцы удача'],
      ['🤟', 'люблю тебя'], ['🤘', 'рок коза'], ['🤙', 'позвони'],
      ['👈', 'влево'], ['👉', 'вправо'], ['👆', 'вверх'], ['👇', 'вниз'],
      ['☝️', 'указательный'], ['✋', 'ладонь стоп'], ['🤚', 'тыльная ладонь'],
      ['🖐️', 'рука пальцы'], ['🖖', 'вулкан'], ['👋', 'привет пока машу'],
      ['🤝', 'рукопожатие договор'], ['🙏', 'спасибо молитва пожалуйста'],
      ['✍️', 'пишу'], ['💪', 'сила мышцы'], ['🦾', 'протез сила'],
      ['👏', 'аплодисменты браво'], ['🙌', 'ура руки'], ['👐', 'открытые ладони'],
      ['🤲', 'ладони вместе'], ['🫶', 'сердце руками'], ['🤦', 'фейспалм'],
      ['🤷', 'пожимаю плечами'], ['💅', 'маникюр'], ['👶', 'младенец'],
      ['🧒', 'ребёнок'], ['👦', 'мальчик'], ['👧', 'девочка'], ['🧑', 'человек'],
      ['👨', 'мужчина'], ['👩', 'женщина'], ['🧔', 'борода'], ['👴', 'дедушка'],
      ['👵', 'бабушка'], ['👮', 'полицейский'], ['👷', 'строитель'],
      ['💂', 'охранник'], ['🕵️', 'детектив'], ['👨‍⚕️', 'врач'], ['👨‍🎓', 'студент'],
      ['👨‍🏫', 'учитель'], ['👨‍💻', 'программист'], ['👨‍🚀', 'космонавт'],
      ['🦸', 'супергерой'], ['🧙', 'маг волшебник'], ['🧚', 'фея'],
      ['👨‍👩‍👧', 'семья'], ['💑', 'пара'], ['💏', 'поцелуй пара'],
      ['🚶', 'идёт'], ['🏃', 'бежит'], ['💃', 'танец'], ['🕺', 'танцует']
    ]
  },
  nature: {
    icon: '🌿',
    title: 'Животные и природа',
    items: [
      ['🐶', 'собака пёс'], ['🐱', 'кот кошка'], ['🐭', 'мышь'], ['🐹', 'хомяк'],
      ['🐰', 'кролик заяц'], ['🦊', 'лиса'], ['🐻', 'медведь'], ['🐼', 'панда'],
      ['🐨', 'коала'], ['🐯', 'тигр'], ['🦁', 'лев'], ['🐮', 'корова'],
      ['🐷', 'свинья'], ['🐸', 'лягушка'], ['🐵', 'обезьяна'], ['🙈', 'не вижу обезьяна'],
      ['🙉', 'не слышу'], ['🙊', 'молчу'], ['🐔', 'курица'], ['🐧', 'пингвин'],
      ['🐦', 'птица'], ['🦆', 'утка'], ['🦉', 'сова'], ['🦇', 'летучая мышь'],
      ['🐺', 'волк'], ['🐗', 'кабан'], ['🐴', 'лошадь'], ['🦄', 'единорог'],
      ['🐝', 'пчела'], ['🐛', 'гусеница'], ['🦋', 'бабочка'], ['🐌', 'улитка'],
      ['🐞', 'божья коровка'], ['🐜', 'муравей'], ['🕷️', 'паук'], ['🦂', 'скорпион'],
      ['🐢', 'черепаха'], ['🐍', 'змея'], ['🦎', 'ящерица'], ['🐙', 'осьминог'],
      ['🦑', 'кальмар'], ['🦐', 'креветка'], ['🦀', 'краб'], ['🐠', 'рыба'],
      ['🐬', 'дельфин'], ['🐳', 'кит'], ['🦈', 'акула'], ['🐊', 'крокодил'],
      ['🐘', 'слон'], ['🦏', 'носорог'], ['🐪', 'верблюд'], ['🦒', 'жираф'],
      ['🐑', 'овца'], ['🐐', 'коза'], ['🦌', 'олень'], ['🐕', 'пёс'],
      ['🌵', 'кактус'], ['🌲', 'ёлка дерево'], ['🌳', 'дерево'], ['🌴', 'пальма'],
      ['🌱', 'росток'], ['🍀', 'клевер удача'], ['🍁', 'клён осень'], ['🍂', 'листья осень'],
      ['🌺', 'цветок'], ['🌻', 'подсолнух'], ['🌹', 'роза'], ['🌷', 'тюльпан'],
      ['🌸', 'сакура'], ['💐', 'букет'], ['🌞', 'солнце'], ['🌝', 'луна'],
      ['⭐', 'звезда'], ['🌟', 'звёздочка'], ['✨', 'блёстки'], ['⚡', 'молния'],
      ['🔥', 'огонь'], ['🌈', 'радуга'], ['☁️', 'облако'], ['🌧️', 'дождь'],
      ['❄️', 'снежинка'], ['⛄', 'снеговик'], ['🌊', 'волна море']
    ]
  },
  food: {
    icon: '🍔',
    title: 'Еда и напитки',
    items: [
      ['🍏', 'яблоко'], ['🍎', 'яблоко красное'], ['🍐', 'груша'], ['🍊', 'апельсин'],
      ['🍋', 'лимон'], ['🍌', 'банан'], ['🍉', 'арбуз'], ['🍇', 'виноград'],
      ['🍓', 'клубника'], ['🫐', 'черника'], ['🍈', 'дыня'], ['🍒', 'вишня'],
      ['🍑', 'персик'], ['🥭', 'манго'], ['🍍', 'ананас'], ['🥥', 'кокос'],
      ['🥝', 'киви'], ['🍅', 'помидор'], ['🥑', 'авокадо'], ['🥦', 'брокколи'],
      ['🥕', 'морковь'], ['🌽', 'кукуруза'], ['🌶️', 'перец острый'], ['🥔', 'картошка'],
      ['🍞', 'хлеб'], ['🥐', 'круассан'], ['🥖', 'багет'], ['🧀', 'сыр'],
      ['🥚', 'яйцо'], ['🍳', 'яичница'], ['🥞', 'блины'], ['🥓', 'бекон'],
      ['🍔', 'бургер'], ['🍟', 'картошка фри'], ['🍕', 'пицца'], ['🌭', 'хот-дог'],
      ['🥪', 'сэндвич'], ['🌮', 'тако'], ['🌯', 'буррито шаурма'], ['🥙', 'лаваш'],
      ['🍝', 'паста спагетти'], ['🍜', 'лапша рамен'], ['🍲', 'суп'], ['🍣', 'суши'],
      ['🍤', 'креветки'], ['🍚', 'рис'], ['🍛', 'карри'], ['🥗', 'салат'],
      ['🍦', 'мороженое'], ['🍰', 'торт'], ['🎂', 'торт день рождения'], ['🧁', 'капкейк'],
      ['🍪', 'печенье'], ['🍫', 'шоколад'], ['🍬', 'конфета'], ['🍭', 'леденец'],
      ['🍯', 'мёд'], ['☕', 'кофе'], ['🍵', 'чай'], ['🧃', 'сок'],
      ['🥤', 'напиток'], ['🍺', 'пиво'], ['🍻', 'пиво кружки'], ['🍷', 'вино'],
      ['🥂', 'шампанское тост'], ['🍾', 'бутылка праздник'], ['🥃', 'виски'], ['🍹', 'коктейль']
    ]
  },
  activity: {
    icon: '⚽',
    title: 'Активность',
    items: [
      ['⚽', 'футбол мяч'], ['🏀', 'баскетбол'], ['🏈', 'американский футбол'],
      ['⚾', 'бейсбол'], ['🎾', 'теннис'], ['🏐', 'волейбол'], ['🏉', 'регби'],
      ['🎱', 'бильярд'], ['🏓', 'пинг-понг'], ['🏸', 'бадминтон'], ['🥅', 'ворота'],
      ['🏒', 'хоккей'], ['🏑', 'хоккей на траве'], ['🥍', 'лакросс'], ['🏏', 'крикет'],
      ['🥊', 'бокс'], ['🥋', 'карате'], ['⛳', 'гольф'], ['⛸️', 'коньки'],
      ['🎣', 'рыбалка'], ['🤿', 'дайвинг'], ['🎿', 'лыжи'], ['🛷', 'санки'],
      ['🏂', 'сноуборд'], ['🏋️', 'штанга зал'], ['🤸', 'гимнастика'], ['🤼', 'борьба'],
      ['🤽', 'водное поло'], ['🚴', 'велосипед'], ['🏆', 'кубок победа'],
      ['🥇', 'золото первое'], ['🥈', 'серебро'], ['🥉', 'бронза'], ['🏅', 'медаль'],
      ['🎖️', 'награда'], ['🎯', 'цель дартс'], ['🎮', 'игры геймпад'],
      ['🕹️', 'джойстик'], ['🎲', 'кубик'], ['🧩', 'пазл'], ['🎸', 'гитара'],
      ['🎹', 'пианино'], ['🥁', 'барабаны'], ['🎺', 'труба'], ['🎻', 'скрипка'],
      ['🎤', 'микрофон караоке'], ['🎧', 'наушники'], ['🎬', 'кино хлопушка'],
      ['🎨', 'рисование палитра'], ['🎭', 'театр'], ['🎪', 'цирк'], ['🎊', 'конфетти'],
      ['🎉', 'праздник ура'], ['🎁', 'подарок'], ['🎈', 'шарик']
    ]
  },
  travel: {
    icon: '🚗',
    title: 'Путешествия',
    items: [
      ['🚗', 'машина авто'], ['🚕', 'такси'], ['🚙', 'внедорожник'], ['🚌', 'автобус'],
      ['🚎', 'троллейбус'], ['🏎️', 'гонки'], ['🚓', 'полиция машина'], ['🚑', 'скорая'],
      ['🚒', 'пожарная'], ['🚐', 'фургон'], ['🚚', 'грузовик'], ['🚜', 'трактор'],
      ['🏍️', 'мотоцикл'], ['🛵', 'скутер'], ['🚲', 'велосипед'], ['🛴', 'самокат'],
      ['🚂', 'поезд'], ['🚆', 'электричка'], ['🚇', 'метро'], ['🚊', 'трамвай'],
      ['✈️', 'самолёт'], ['🛫', 'взлёт'], ['🛬', 'посадка'], ['🚀', 'ракета'],
      ['🛸', 'нло'], ['🚁', 'вертолёт'], ['⛵', 'парусник'], ['🚤', 'катер'],
      ['🛳️', 'лайнер'], ['⚓', 'якорь'], ['⛽', 'заправка'], ['🚦', 'светофор'],
      ['🗺️', 'карта'], ['🗿', 'моаи'], ['🗽', 'статуя свободы'], ['🗼', 'башня токио'],
      ['🏰', 'замок'], ['🏯', 'замок япония'], ['🏟️', 'стадион'], ['🎡', 'колесо обозрения'],
      ['🎢', 'горки'], ['🏖️', 'пляж'], ['🏝️', 'остров'], ['🏔️', 'горы'],
      ['🌋', 'вулкан'], ['🏕️', 'кемпинг'], ['🏠', 'дом'], ['🏢', 'офис'],
      ['🏨', 'отель'], ['🏥', 'больница'], ['🏦', 'банк'], ['🏫', 'школа'],
      ['⛪', 'церковь'], ['🕌', 'мечеть'], ['🌆', 'город закат'], ['🌃', 'ночной город'],
      ['🌉', 'мост'], ['🎑', 'луна'], ['🧳', 'чемодан']
    ]
  },
  objects: {
    icon: '💡',
    title: 'Объекты',
    items: [
      ['⌚', 'часы'], ['📱', 'телефон'], ['💻', 'ноутбук'], ['⌨️', 'клавиатура'],
      ['🖥️', 'компьютер'], ['🖨️', 'принтер'], ['🖱️', 'мышь'], ['💾', 'дискета'],
      ['💿', 'диск'], ['📷', 'фотоаппарат'], ['📹', 'видеокамера'], ['📺', 'телевизор'],
      ['📻', 'радио'], ['🔋', 'батарея'], ['🔌', 'розетка'], ['💡', 'лампочка идея'],
      ['🔦', 'фонарик'], ['🕯️', 'свеча'], ['📔', 'блокнот'], ['📖', 'книга'],
      ['📚', 'книги'], ['📝', 'записка'], ['✏️', 'карандаш'], ['🖊️', 'ручка'],
      ['📌', 'кнопка'], ['📎', 'скрепка'], ['✂️', 'ножницы'], ['📏', 'линейка'],
      ['🗂️', 'папки'], ['📁', 'папка'], ['📅', 'календарь'], ['📊', 'диаграмма'],
      ['📈', 'рост график'], ['📉', 'падение график'], ['💼', 'портфель'],
      ['🔑', 'ключ'], ['🔒', 'замок закрыт'], ['🔓', 'замок открыт'], ['🔨', 'молоток'],
      ['🪛', 'отвёртка'], ['🔧', 'гаечный ключ'], ['⚙️', 'шестерёнка настройки'],
      ['🧲', 'магнит'], ['💉', 'шприц'], ['💊', 'таблетка'], ['🩺', 'стетоскоп'],
      ['🚪', 'дверь'], ['🪑', 'стул'], ['🛏️', 'кровать'], ['🚿', 'душ'],
      ['🧴', 'бутылочка'], ['🧻', 'бумага'], ['🧹', 'метла'], ['🛒', 'тележка'],
      ['💰', 'деньги мешок'], ['💵', 'доллары'], ['💳', 'карта банковская'],
      ['💎', 'алмаз'], ['⚖️', 'весы'], ['🔗', 'ссылка'], ['📦', 'коробка посылка'],
      ['✉️', 'письмо'], ['📧', 'email'], ['📨', 'входящее'], ['📬', 'почта']
    ]
  },
  symbols: {
    icon: '❤️',
    title: 'Символы',
    items: [
      ['❤️', 'сердце любовь'], ['🧡', 'оранжевое сердце'], ['💛', 'жёлтое сердце'],
      ['💚', 'зелёное сердце'], ['💙', 'синее сердце'], ['💜', 'фиолетовое сердце'],
      ['🖤', 'чёрное сердце'], ['🤍', 'белое сердце'], ['🤎', 'коричневое сердце'],
      ['💔', 'разбитое сердце'], ['❣️', 'восклицание сердце'], ['💕', 'два сердца'],
      ['💞', 'сердца'], ['💓', 'биение'], ['💗', 'растущее сердце'], ['💖', 'сверкающее'],
      ['💘', 'стрела амур'], ['💝', 'подарок сердце'], ['💟', 'украшение сердце'],
      ['☮️', 'мир'], ['✝️', 'крест'], ['☪️', 'полумесяц'], ['🕉️', 'ом'],
      ['☸️', 'дхарма'], ['✡️', 'звезда давида'], ['🔯', 'шестиконечная'],
      ['☯️', 'инь-ян'], ['♈', 'овен'], ['♉', 'телец'], ['♊', 'близнецы'],
      ['♋', 'рак'], ['♌', 'лев'], ['♍', 'дева'], ['♎', 'весы'],
      ['♏', 'скорпион'], ['♐', 'стрелец'], ['♑', 'козерог'], ['♒', 'водолей'],
      ['♓', 'рыбы'], ['🆔', 'id'], ['⚠️', 'внимание'], ['🚸', 'дети'],
      ['⛔', 'стоп'], ['🚫', 'запрещено'], ['❌', 'нет крестик'], ['⭕', 'круг'],
      ['✅', 'да галочка'], ['☑️', 'отмечено'], ['✔️', 'галочка'], ['❓', 'вопрос'],
      ['❗', 'восклицание'], ['💯', 'сто'], ['🔞', '18+'], ['♻️', 'переработка'],
      ['🔔', 'колокольчик'], ['🔕', 'без звука'], ['🎵', 'нота'], ['🎶', 'музыка'],
      ['💤', 'сон'], ['💢', 'злость'], ['💥', 'взрыв'], ['💫', 'головокружение'],
      ['💦', 'капли'], ['💨', 'ветер'], ['🕐', 'час'], ['⏰', 'будильник'],
      ['⏳', 'песочные часы'], ['🔴', 'красный круг'], ['🟢', 'зелёный круг'],
      ['🔵', 'синий круг'], ['⚫', 'чёрный круг'], ['⚪', 'белый круг'],
      ['🟥', 'красный квадрат'], ['🟩', 'зелёный квадрат'], ['🟦', 'синий квадрат']
    ]
  }
};

const RECENT_KEY = 'fm.emoji.recent';
const MAX_RECENT = 32;

function getRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function pushRecent(emoji) {
  let list = getRecent().filter((e) => e !== emoji);
  list.unshift(emoji);
  list = list.slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* noop */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   СТИКЕРЫ
   ────────────────────────────────────────────────────────────────────────── */

const STICKER_PACKS = {
  favorites: { icon: '⭐', title: 'Избранное', items: [] },
  custom: { icon: '🖼️', title: 'Мои стикеры', items: [] },
  mood: {
    icon: '😎',
    title: 'Настроение',
    items: ['😂', '🥰', '😎', '🤯', '🥳', '😴', '🤔', '🙃', '😤', '🥺',
            '😭', '🤩', '😇', '🤪', '😏', '🫶', '🤗', '😱', '🥵', '🤠']
  },
  reactions: {
    icon: '👍',
    title: 'Реакции',
    items: ['👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🤟', '👌', '🤌',
            '🔥', '💯', '✅', '❌', '⚡', '✨', '🎉', '🏆', '💎', '🚀']
  },
  love: {
    icon: '❤️',
    title: 'Любовь',
    items: ['❤️', '💕', '💖', '💘', '💝', '😍', '😘', '🥰', '💋', '🌹',
            '💐', '🫰', '💞', '💓', '😻', '💌', '🤍', '💜', '🧡', '💚']
  },
  animals: {
    icon: '🐶',
    title: 'Животные',
    items: ['🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵',
            '🦄', '🐧', '🦉', '🐙', '🦋', '🐝', '🐢', '🦖', '🐬', '🦈']
  },
  party: {
    icon: '🎉',
    title: 'Праздник',
    items: ['🎉', '🎊', '🎂', '🎁', '🎈', '🍾', '🥂', '🍻', '🎆', '🎇',
            '✨', '🪅', '🧁', '🍰', '🎄', '🎃', '🪩', '🥳', '🎸', '🎤']
  }
};

const FAV_KEY = 'fm.stickers.fav';
const CUSTOM_STICKERS_KEY = 'fm.stickers.custom';
const CUSTOM_GIFS_KEY = 'fm.gifs.custom';

function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeStore(key, arr) {
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) { /* noop */ }
}

/* ──────────────────────────────────────────────────────────────────────────
   ВСТРОЕННЫЕ GIF-ПРЕСЕТЫ
   Анимированные SVG в data-URI: работают офлайн, не требуют API.
   ────────────────────────────────────────────────────────────────────────── */

function svgGif(label, body, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
    <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/>
    </linearGradient></defs>
    <rect width="320" height="240" fill="url(#b)"/>
    ${body}
    <text x="160" y="222" font-family="Segoe UI,Arial" font-size="17" font-weight="700"
          fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const BUILTIN_GIFS = [
  {
    id: 'g-hi', name: 'Привет', tags: 'привет hi hello салют',
    url: svgGif('Привет!', `
      <text x="160" y="118" font-size="78" text-anchor="middle">👋
        <animateTransform attributeName="transform" type="rotate"
          values="-16 160 100;16 160 100;-16 160 100" dur="1s" repeatCount="indefinite"/>
      </text>`, ['#38BDF8', '#6366F1'])
  },
  {
    id: 'g-love', name: 'Сердце', tags: 'любовь сердце love',
    url: svgGif('Люблю', `
      <text x="160" y="120" font-size="80" text-anchor="middle">❤️
        <animateTransform attributeName="transform" type="scale"
          values="1;1.22;1" dur=".85s" repeatCount="indefinite"
          additive="sum"/>
      </text>`, ['#F43F5E', '#8B5CF6'])
  },
  {
    id: 'g-lol', name: 'Смех', tags: 'смех lol ржу хаха',
    url: svgGif('Ахаха', `
      <text x="160" y="120" font-size="80" text-anchor="middle">😂
        <animateTransform attributeName="transform" type="translate"
          values="0 0;0 -16;0 0" dur=".6s" repeatCount="indefinite"/>
      </text>`, ['#F59E0B', '#EF4444'])
  },
  {
    id: 'g-ok', name: 'Отлично', tags: 'ок класс лайк супер',
    url: svgGif('Отлично!', `
      <text x="160" y="120" font-size="78" text-anchor="middle">👍
        <animateTransform attributeName="transform" type="scale"
          values="1;1.18;1" dur=".7s" repeatCount="indefinite" additive="sum"/>
      </text>`, ['#10B981', '#06B6D4'])
  },
  {
    id: 'g-party', name: 'Ура', tags: 'праздник ура вечеринка поздравляю',
    url: svgGif('Ура!', `
      <text x="160" y="120" font-size="78" text-anchor="middle">🎉
        <animateTransform attributeName="transform" type="rotate"
          values="-12 160 100;12 160 100;-12 160 100" dur=".8s" repeatCount="indefinite"/>
      </text>
      <circle cx="60" cy="40" r="7" fill="#FDE047"><animate attributeName="cy" values="40;200;40" dur="2s" repeatCount="indefinite"/></circle>
      <circle cx="260" cy="60" r="7" fill="#38BDF8"><animate attributeName="cy" values="60;210;60" dur="2.4s" repeatCount="indefinite"/></circle>
      <circle cx="200" cy="30" r="6" fill="#F43F5E"><animate attributeName="cy" values="30;190;30" dur="1.8s" repeatCount="indefinite"/></circle>`,
      ['#8B5CF6', '#EC4899'])
  },
  {
    id: 'g-think', name: 'Думаю', tags: 'думаю хм размышление',
    url: svgGif('Хм…', `
      <text x="160" y="120" font-size="78" text-anchor="middle">🤔
        <animateTransform attributeName="transform" type="rotate"
          values="0 160 100;10 160 100;0 160 100" dur="1.4s" repeatCount="indefinite"/>
      </text>`, ['#64748B', '#1E293B'])
  },
  {
    id: 'g-sad', name: 'Грустно', tags: 'грусть плачу печаль',
    url: svgGif('Грустно', `
      <text x="160" y="118" font-size="78" text-anchor="middle">😢</text>
      <circle cx="146" cy="128" r="5" fill="#BAE6FD">
        <animate attributeName="cy" values="128;190" dur="1.2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;0" dur="1.2s" repeatCount="indefinite"/>
      </circle>`, ['#0EA5E9', '#1E3A8A'])
  },
  {
    id: 'g-fire', name: 'Огонь', tags: 'огонь круто fire топ',
    url: svgGif('Огонь!', `
      <text x="160" y="120" font-size="80" text-anchor="middle">🔥
        <animateTransform attributeName="transform" type="scale"
          values="1;1.15;.95;1" dur=".55s" repeatCount="indefinite" additive="sum"/>
      </text>`, ['#F97316', '#DC2626'])
  },
  {
    id: 'g-sleep', name: 'Сплю', tags: 'сон сплю спокойной ночи',
    url: svgGif('Спать…', `
      <text x="160" y="120" font-size="76" text-anchor="middle">😴</text>
      <text x="216" y="74" font-size="26" fill="#fff" opacity=".9">z
        <animate attributeName="y" values="74;48" dur="1.6s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;0" dur="1.6s" repeatCount="indefinite"/>
      </text>`, ['#1E293B', '#4C1D95'])
  },
  {
    id: 'g-run', name: 'Бегу', tags: 'бегу спешу опаздываю',
    url: svgGif('Уже бегу!', `
      <text x="80" y="120" font-size="72" text-anchor="middle">🏃
        <animateTransform attributeName="transform" type="translate"
          values="0 0;160 0;0 0" dur="2s" repeatCount="indefinite"/>
      </text>`, ['#22C55E', '#0F766E'])
  },
  {
    id: 'g-clap', name: 'Браво', tags: 'аплодисменты браво молодец',
    url: svgGif('Браво!', `
      <text x="160" y="120" font-size="78" text-anchor="middle">👏
        <animateTransform attributeName="transform" type="scale"
          values="1;.86;1" dur=".4s" repeatCount="indefinite" additive="sum"/>
      </text>`, ['#FBBF24', '#B45309'])
  },
  {
    id: 'g-rocket', name: 'Поехали', tags: 'ракета старт поехали',
    url: svgGif('Поехали!', `
      <text x="160" y="150" font-size="74" text-anchor="middle">🚀
        <animateTransform attributeName="transform" type="translate"
          values="0 30;0 -40;0 30" dur="1.8s" repeatCount="indefinite"/>
      </text>`, ['#6366F1', '#0F172A'])
  }
];

/* ──────────────────────────────────────────────────────────────────────────
   СОСТОЯНИЕ ПАНЕЛИ
   ────────────────────────────────────────────────────────────────────────── */

const state = {
  open: false,
  tab: 'emoji',
  emojiCat: 'recent',
  emojiSearch: '',
  stickerPack: 'mood',
  gifSearch: ''
};

export function isPickerOpen() { return state.open; }

export function openPicker(tab) {
  state.open = true;
  $('pickerPanel').classList.remove('hidden');
  if (tab) switchPickerTab(tab);
  else renderCurrentTab();
}

export function closePicker() {
  state.open = false;
  $('pickerPanel').classList.add('hidden');
}

export function togglePicker(tab) {
  if (state.open && (!tab || tab === state.tab)) closePicker();
  else openPicker(tab);
}

function switchPickerTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.picker-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.picker === tab);
  });
  document.querySelectorAll('.picker-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.pickerpane === tab);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (state.tab === 'emoji') { renderEmojiCats(); renderEmojiGrid(); }
  else if (state.tab === 'gif') renderGifGrid();
  else renderStickerPacks(), renderStickerGrid();
}

/* ──────────────────────────────────────────────────────────────────────────
   ЭМОДЗИ: ОТРИСОВКА
   ────────────────────────────────────────────────────────────────────────── */

function renderEmojiCats() {
  const box = $('emojiCats');
  const cats = [
    { key: 'recent', icon: '🕐', title: 'Недавние' },
    ...Object.entries(EMOJI).map(([key, c]) => ({ key, icon: c.icon, title: c.title }))
  ];
  box.innerHTML = cats.map((c) => `
    <button class="emoji-cat ${state.emojiCat === c.key ? 'active' : ''}"
            data-emoji-cat="${c.key}" title="${escapeHtml(c.title)}">${c.icon}</button>
  `).join('');
}

function renderEmojiGrid() {
  const grid = $('emojiGrid');
  const term = state.emojiSearch.trim().toLowerCase();

  if (term) {
    const hits = [];
    for (const cat of Object.values(EMOJI)) {
      for (const [emoji, keywords] of cat.items) {
        if (keywords.includes(term) || keywords.split(' ').some((k) => k.startsWith(term))) {
          hits.push(emoji);
        }
      }
    }
    grid.innerHTML = hits.length
      ? hits.map((e) => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('')
      : '<div class="emoji-group-title">Ничего не найдено</div>';
    return;
  }

  if (state.emojiCat === 'recent') {
    const recent = getRecent();
    if (!recent.length) {
      grid.innerHTML = '<div class="emoji-group-title">Недавних пока нет — выберите категорию</div>' +
        EMOJI.smileys.items.slice(0, 40)
          .map(([e]) => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('');
      return;
    }
    grid.innerHTML = '<div class="emoji-group-title">Недавние</div>' +
      recent.map((e) => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('');
    return;
  }

  const cat = EMOJI[state.emojiCat];
  if (!cat) { grid.innerHTML = ''; return; }
  grid.innerHTML = `<div class="emoji-group-title">${escapeHtml(cat.title)}</div>` +
    cat.items.map(([e]) => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('');
}

/* ──────────────────────────────────────────────────────────────────────────
   СТИКЕРЫ: ОТРИСОВКА
   ────────────────────────────────────────────────────────────────────────── */

function renderStickerPacks() {
  const box = $('stickerPacks');
  STICKER_PACKS.favorites.items = readStore(FAV_KEY);
  STICKER_PACKS.custom.items = readStore(CUSTOM_STICKERS_KEY);

  box.innerHTML = Object.entries(STICKER_PACKS).map(([key, pack]) => {
    const thumb = key === 'custom' && pack.items.length
      ? `<img src="${escapeHtml(pack.items[0].url)}" alt="" />`
      : pack.icon;
    return `<button class="sticker-pack ${state.stickerPack === key ? 'active' : ''}"
                    data-sticker-pack="${key}" title="${escapeHtml(pack.title)}">${thumb}</button>`;
  }).join('');
}

function renderStickerGrid() {
  const grid = $('stickerGrid');
  const pack = STICKER_PACKS[state.stickerPack];
  if (!pack) { grid.innerHTML = ''; return; }

  if (state.stickerPack === 'custom') {
    const items = readStore(CUSTOM_STICKERS_KEY);
    grid.innerHTML = items.length
      ? items.map((s) => `
          <button class="sticker-item" data-custom-sticker="${escapeHtml(s.url)}">
            <img src="${escapeHtml(s.url)}" alt="стикер" loading="lazy" />
            <span class="st-fav" data-del-sticker="${escapeHtml(s.url)}" title="Удалить">✖</span>
          </button>`).join('')
      : '<div class="emoji-group-title" style="grid-column:1/-1">Загрузите свой стикер кнопкой ниже</div>';
    return;
  }

  if (state.stickerPack === 'favorites') {
    const favs = readStore(FAV_KEY);
    grid.innerHTML = favs.length
      ? favs.map((e) => stickerBtn(e, true)).join('')
      : '<div class="emoji-group-title" style="grid-column:1/-1">Избранных нет. Нажмите ⭐ на стикере.</div>';
    return;
  }

  const favs = readStore(FAV_KEY);
  grid.innerHTML = pack.items.map((e) => stickerBtn(e, favs.includes(e))).join('');
}

function stickerBtn(emoji, isFav) {
  return `<button class="sticker-item" data-sticker="${emoji}">${emoji}
    <span class="st-fav ${isFav ? 'on' : ''}" data-fav="${emoji}" title="В избранное">${isFav ? '⭐' : '☆'}</span>
  </button>`;
}

function toggleFavSticker(emoji) {
  let favs = readStore(FAV_KEY);
  if (favs.includes(emoji)) favs = favs.filter((e) => e !== emoji);
  else favs.unshift(emoji);
  writeStore(FAV_KEY, favs.slice(0, 60));
  renderStickerPacks();
  renderStickerGrid();
}

/* ──────────────────────────────────────────────────────────────────────────
   GIF: ОТРИСОВКА
   ────────────────────────────────────────────────────────────────────────── */

function renderGifGrid() {
  const grid = $('gifGrid');
  const term = state.gifSearch.trim().toLowerCase();

  const custom = readStore(CUSTOM_GIFS_KEY);
  let items = [
    ...custom.map((g) => ({ ...g, custom: true })),
    ...BUILTIN_GIFS
  ];

  if (term) {
    items = items.filter((g) =>
      (g.name || '').toLowerCase().includes(term) ||
      (g.tags || '').toLowerCase().includes(term));
  }

  if (!items.length) {
    grid.innerHTML = '<div class="emoji-group-title" style="grid-column:1/-1">Ничего не найдено. Загрузите свой GIF.</div>';
    return;
  }

  grid.innerHTML = items.map((g) => `
    <button class="gif-item" data-gif="${escapeHtml(g.url)}" data-gif-name="${escapeHtml(g.name || 'GIF')}">
      <img src="${escapeHtml(g.url)}" alt="${escapeHtml(g.name || 'GIF')}" loading="lazy" />
      <span class="gif-label">${escapeHtml(g.name || 'GIF')}</span>
      ${g.custom ? `<span class="gif-del" data-del-gif="${escapeHtml(g.id)}"><svg><use href="#i-x"/></svg></span>` : ''}
    </button>`).join('');
}

/* ──────────────────────────────────────────────────────────────────────────
   ЗАГРУЗКА СВОИХ СТИКЕРОВ И GIF
   ────────────────────────────────────────────────────────────────────────── */

async function handleStickerUpload(file) {
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    toast('Файл слишком большой', 'Стикер — максимум 3 МБ.', 'warn');
    return;
  }
  try {
    const url = await uploadSticker(file);
    const items = readStore(CUSTOM_STICKERS_KEY);
    items.unshift({ url, name: file.name, at: Date.now() });
    writeStore(CUSTOM_STICKERS_KEY, items.slice(0, 40));
    state.stickerPack = 'custom';
    renderStickerPacks();
    renderStickerGrid();
    toast('Стикер добавлен', '', 'success');
  } catch (err) {
    toast('Не удалось загрузить', err.message, 'error');
  }
}

async function handleGifUpload(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('Файл слишком большой', 'GIF — максимум 8 МБ.', 'warn');
    return;
  }
  try {
    const url = await uploadGif(file);
    const items = readStore(CUSTOM_GIFS_KEY);
    items.unshift({
      id: 'u' + Date.now(),
      url,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 24),
      tags: 'мои свои custom'
    });
    writeStore(CUSTOM_GIFS_KEY, items.slice(0, 40));
    renderGifGrid();
    toast('GIF добавлен', '', 'success');
  } catch (err) {
    toast('Не удалось загрузить', err.message, 'error');
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   ИНИЦИАЛИЗАЦИЯ
   ────────────────────────────────────────────────────────────────────────── */

export function initEmojiUI() {
  $('emojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePicker('emoji');
  });
  $('pickerCloseBtn').addEventListener('click', closePicker);

  document.querySelectorAll('.picker-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchPickerTab(tab.dataset.picker));
  });

  // Закрытие по клику снаружи
  document.addEventListener('click', (e) => {
    if (!state.open) return;
    if (e.target.closest('#pickerPanel') || e.target.closest('#emojiBtn')) return;
    closePicker();
  });

  // --- Эмодзи ---
  $('emojiCats').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji-cat]');
    if (!btn) return;
    state.emojiCat = btn.dataset.emojiCat;
    state.emojiSearch = '';
    $('emojiSearchInput').value = '';
    renderEmojiCats();
    renderEmojiGrid();
  });

  $('emojiGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji]');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    pushRecent(emoji);
    insertIntoComposer(emoji);
  });

  let emojiTimer;
  $('emojiSearchInput').addEventListener('input', (e) => {
    clearTimeout(emojiTimer);
    const v = e.target.value;
    emojiTimer = setTimeout(() => { state.emojiSearch = v; renderEmojiGrid(); }, 180);
  });

  // --- Стикеры ---
  $('stickerPacks').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sticker-pack]');
    if (!btn) return;
    state.stickerPack = btn.dataset.stickerPack;
    renderStickerPacks();
    renderStickerGrid();
  });

  $('stickerGrid').addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFavSticker(fav.dataset.fav); return; }

    const del = e.target.closest('[data-del-sticker]');
    if (del) {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: 'Удалить стикер', text: 'Убрать стикер из вашей коллекции?', okText: 'Удалить'
      });
      if (!ok) return;
      const items = readStore(CUSTOM_STICKERS_KEY).filter((s) => s.url !== del.dataset.delSticker);
      writeStore(CUSTOM_STICKERS_KEY, items);
      renderStickerPacks();
      renderStickerGrid();
      return;
    }

    const custom = e.target.closest('[data-custom-sticker]');
    if (custom) {
      await sendStickerMessage({ url: custom.dataset.customSticker, name: 'sticker' });
      closePicker();
      return;
    }

    const btn = e.target.closest('[data-sticker]');
    if (btn) {
      await sendStickerMessage(btn.dataset.sticker);
      closePicker();
    }
  });

  $('stickerUploadBtn').addEventListener('click', () => $('stickerUploadInput').click());
  $('stickerUploadInput').addEventListener('change', (e) => {
    handleStickerUpload(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  // --- GIF ---
  $('gifGrid').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-gif]');
    if (del) {
      e.stopPropagation();
      const items = readStore(CUSTOM_GIFS_KEY).filter((g) => g.id !== del.dataset.delGif);
      writeStore(CUSTOM_GIFS_KEY, items);
      renderGifGrid();
      return;
    }
    const btn = e.target.closest('[data-gif]');
    if (!btn) return;
    await sendGifMessage({ url: btn.dataset.gif, name: btn.dataset.gifName, mime: 'image/gif' });
    closePicker();
  });

  let gifTimer;
  $('gifSearchInput').addEventListener('input', (e) => {
    clearTimeout(gifTimer);
    const v = e.target.value;
    gifTimer = setTimeout(() => { state.gifSearch = v; renderGifGrid(); }, 200);
  });

  $('gifUploadBtn').addEventListener('click', () => $('gifUploadInput').click());
  $('gifUploadInput').addEventListener('change', (e) => {
    handleGifUpload(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  renderEmojiCats();
  renderEmojiGrid();
  renderStickerPacks();
  renderStickerGrid();
  renderGifGrid();
}

export { EMOJI, STICKER_PACKS, BUILTIN_GIFS };

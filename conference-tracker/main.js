/*
 * Conference Tracker — виджет Obsidian для отслеживания дат форумов,
 * выставок, конференций и дней поля.
 *
 * Плагин не требует сборки: это обычный CommonJS-файл, который Obsidian
 * загружает напрямую. Вся логика дат вынесена в чистые функции и покрыта
 * тестами (см. tests/).
 */

'use strict';

const obsidian = require('obsidian');

const Plugin = obsidian.Plugin;
const ItemView = obsidian.ItemView;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const Modal = obsidian.Modal;
const MarkdownRenderChild = obsidian.MarkdownRenderChild;
const Notice = obsidian.Notice || function noopNotice() {};
const setIcon = typeof obsidian.setIcon === 'function' ? obsidian.setIcon : function noopSetIcon() {};

const VIEW_TYPE = 'conference-tracker-view';
const CODE_BLOCK = 'conferences';
const DATA_VERSION = 1;

const CATEGORIES = ['Форум', 'Выставка', 'Конференция', 'День поля', 'Другое'];
const VIEW_MODES = ['upcoming', 'all', 'past'];
const VIEW_LABELS = {
  upcoming: 'Предстоящие',
  all: 'Все',
  past: 'Прошедшие',
};

const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const DEFAULT_SETTINGS = {
  showPast: true,
  showTentative: true,
  showHero: true,
  openOnStartup: false,
};

/**
 * События, которые добавляются при первом запуске плагина.
 * Даты проверены по официальным источникам на 8 ноября 2026 года.
 * После установки их можно спокойно менять и удалять.
 */
const DEFAULT_EVENTS = [
  {
    id: 'agroneweek',
    title: 'Агронеделя',
    fullTitle: 'Сибирская аграрная неделя',
    category: 'Выставка',
    start: '2026-11-10',
    end: '2026-11-12',
    expectedMonth: '',
    place: 'Новосибирск · МВК «Новосибирск Экспоцентр», ул. Станционная, 104',
    url: 'https://sibagroweek.ru/',
    note: 'Международная агропромышленная выставка и Новосибирский агропродовольственный форум. Даты следующей недели обычно объявляют летом.',
    previous: '2025 — 5–7 ноября',
  },
  {
    id: 'technoprom',
    title: 'Технопром',
    fullTitle: 'Международный форум технологического развития',
    category: 'Форум',
    start: '',
    end: '',
    expectedMonth: '2027-08',
    place: 'Новосибирск · «Новосибирск Экспоцентр»',
    url: 'https://форумтехнопром.рф/',
    note: 'XIII форум прошёл 26–28 августа 2026 года. Даты 2027 года пока не объявлены — уточняйте на официальном сайте.',
    previous: '2026 — 26–28 августа',
  },
  {
    id: 'field-day',
    title: 'День поля',
    fullTitle: 'День поля Новосибирской области',
    category: 'День поля',
    start: '',
    end: '',
    expectedMonth: '2027-07',
    place: 'Новосибирский район · учхоз «Практик», п. Тулинский',
    url: 'https://mcx.nso.ru/page/3447',
    note: 'Обычно проходит в конце июля — начале августа. Точную дату публикует Минсельхоз Новосибирской области.',
    previous: '',
  },
];

/* ------------------------------------------------------------------ */
/* Даты: чистые функции                                                */
/* ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Проверяет строку формата ГГГГ-ММ-ДД (с учётом реального календаря). */
function parseISODate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const stamp = Date.UTC(year, month - 1, day);
  const date = new Date(stamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
    stamp: Math.round(stamp / 86400000),
  };
}

function isValidISODate(value) {
  return parseISODate(value) !== null;
}

/** Номер дня (UTC) для локальной календарной даты — без сюрпризов с часовыми поясами. */
function dayNumberFromDate(date) {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function todayDayNumber(date) {
  return dayNumberFromDate(date instanceof Date ? date : new Date());
}

function parseMonth(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function monthKey(value) {
  const parsed = parseMonth(value);
  return parsed ? parsed.year * 100 + parsed.month : 0;
}

/** «10 ноября 2026» */
function formatDateRu(value) {
  const parsed = parseISODate(value);
  if (!parsed) return '';
  return `${parsed.day} ${MONTHS_GENITIVE[parsed.month - 1]} ${parsed.year}`;
}

/** «10–12 ноября 2026», «28 февраля — 2 марта 2027», «10 ноября 2026» */
function formatRangeRu(start, end) {
  const from = parseISODate(start);
  if (!from) return '';
  const to = parseISODate(end);

  if (!to || to.stamp === from.stamp) {
    return formatDateRu(start);
  }

  // Если даты введены в обратном порядке — показываем по возрастанию.
  const first = to.stamp > from.stamp ? from : to;
  const last = to.stamp > from.stamp ? to : from;

  if (first.year === last.year && first.month === last.month) {
    return `${first.day}–${last.day} ${MONTHS_GENITIVE[first.month - 1]} ${first.year}`;
  }

  if (first.year === last.year) {
    return (
      `${first.day} ${MONTHS_GENITIVE[first.month - 1]} — ` +
      `${last.day} ${MONTHS_GENITIVE[last.month - 1]} ${first.year}`
    );
  }

  return `${formatDateRu(to.stamp > from.stamp ? start : end)} — ${formatDateRu(
    to.stamp > from.stamp ? end : start,
  )}`;
}

/** «август 2027» — для ориентировочных дат. */
function formatMonthRu(value) {
  const parsed = parseMonth(value);
  if (!parsed) return '';
  return `${MONTHS_NOMINATIVE[parsed.month - 1]} ${parsed.year}`;
}

/** «Август 2027» — для заголовков групп. */
function formatMonthTitle(value) {
  const formatted = formatMonthRu(value);
  return formatted ? formatted.charAt(0).toUpperCase() + formatted.slice(1) : '';
}

/** Русские формы множественного числа: pluralRu(3, ['день','дня','дней']) → 'дня' */
function pluralRu(count, forms) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/**
 * Состояние события на заданный день.
 * kind: tentative | upcoming | ongoing | past.
 */
function getEventState(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const source = event && typeof event === 'object' ? event : {};
  const start = parseISODate(source.start);

  if (!start) {
    return {
      kind: 'tentative',
      startDay: null,
      endDay: null,
      length: 0,
      days: null,
      daysAgo: null,
    };
  }

  const endParsed = parseISODate(source.end);
  const startDay = start.stamp;
  const endDay = endParsed && endParsed.stamp >= startDay ? endParsed.stamp : startDay;
  const length = endDay - startDay + 1;

  if (today < startDay) {
    return { kind: 'upcoming', startDay, endDay, length, days: startDay - today, daysAgo: null };
  }

  if (today <= endDay) {
    return {
      kind: 'ongoing',
      startDay,
      endDay,
      length,
      days: 0,
      dayIndex: today - startDay + 1,
      lastDay: today === endDay,
      daysAgo: null,
    };
  }

  return { kind: 'past', startDay, endDay, length, days: null, daysAgo: today - endDay };
}

/** Текст бейджа: «Через 3 дня», «Идёт · день 2 из 3», «Завершилось». */
function formatCountdown(state) {
  if (!state) return '';
  switch (state.kind) {
    case 'tentative':
      return 'Дата уточняется';
    case 'upcoming': {
      const days = state.days;
      if (days === 1) return 'Завтра';
      return `Через ${days} ${pluralRu(days, ['день', 'дня', 'дней'])}`;
    }
    case 'ongoing':
      if (state.length === 1) return 'Сегодня';
      if (state.lastDay) return 'Последний день';
      return `Идёт · день ${state.dayIndex} из ${state.length}`;
    case 'past': {
      const daysAgo = state.daysAgo;
      if (daysAgo === 1) return 'Завершилось вчера';
      return `Завершилось ${daysAgo} ${pluralRu(daysAgo, ['день', 'дня', 'дней'])} назад`;
    }
    default:
      return '';
  }
}

function stateRank(state) {
  if (state.kind === 'upcoming' || state.kind === 'ongoing') return 0;
  if (state.kind === 'tentative') return 1;
  return 2;
}

/**
 * Сортировка: сначала текущие и будущие по дате начала, затем события
 * с неуточнённой датой по ориентировочному месяцу, затем прошедшие —
 * от свежих к старым.
 */
function sortEvents(events, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  return (Array.isArray(events) ? events : [])
    .map((event) => ({ event, state: getEventState(event, today) }))
    .sort((a, b) => {
      const rankDiff = stateRank(a.state) - stateRank(b.state);
      if (rankDiff !== 0) return rankDiff;

      if (stateRank(a.state) === 0) {
        return (
          a.state.startDay - b.state.startDay ||
          String(a.event.title).localeCompare(String(b.event.title), 'ru')
        );
      }

      if (stateRank(a.state) === 1) {
        const keyA = monthKey(a.event.expectedMonth) || 999999;
        const keyB = monthKey(b.event.expectedMonth) || 999999;
        return keyA - keyB || String(a.event.title).localeCompare(String(b.event.title), 'ru');
      }

      return b.state.endDay - a.state.endDay;
    });
}

function isVisibleInMode(state, mode, settings) {
  if (state.kind === 'tentative') {
    return settings.showTentative !== false && mode !== 'past';
  }
  if (state.kind === 'past') {
    return settings.showPast !== false && mode !== 'upcoming';
  }
  return mode !== 'past';
}

function countForMode(events, mode, settings, nowDay) {
  const safeSettings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const safeMode = VIEW_MODES.includes(mode) ? mode : 'upcoming';
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  return (Array.isArray(events) ? events : []).filter((event) =>
    isVisibleInMode(getEventState(event, today), safeMode, safeSettings),
  ).length;
}

/** Оставляет события, подходящие под выбранную вкладку и настройки. */
function filterEvents(events, mode, settings, nowDay) {
  const safeMode = VIEW_MODES.includes(mode) ? mode : 'upcoming';
  const safeSettings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();

  const sorted = sortEvents(events, today);
  return sorted.filter(({ state }) => isVisibleInMode(state, safeMode, safeSettings));
}

/** Событие для блока «Ближайшее событие»: текущее или следующее по дате. */
function pickHero(items) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item.state.kind === 'ongoing' || item.state.kind === 'upcoming') return item;
  }
  return null;
}

/**
 * Группирует элементы списка в секции: месяцы для будущих событий,
 * «Дата уточняется» и «Прошедшие».
 */
function buildSections(items, mode) {
  const sections = [];
  const index = new Map();

  for (const item of items) {
    const { event, state } = item;
    let key;
    let title;

    if (state.kind === 'tentative') {
      key = '__tentative';
      title = 'Дата уточняется';
    } else if (state.kind === 'past') {
      key = '__past';
      title = 'Прошедшие';
    } else {
      key = `month:${String(event.start).slice(0, 7)}`;
      title = formatMonthTitle(String(event.start).slice(0, 7));
    }

    let section = index.get(key);
    if (!section) {
      section = { key, title, items: [] };
      index.set(key, section);
      sections.push(section);
    }
    section.items.push(item);
  }

  // В режиме «Предстоящие» заголовки месяцев выглядят лишними.
  if (mode === 'upcoming' && sections.length === 1 && !sections[0].key.startsWith('__')) {
    return [{ key: 'flat', title: '', items: sections[0].items }];
  }

  return sections;
}

/* ------------------------------------------------------------------ */
/* Нормализация данных                                                 */
/* ------------------------------------------------------------------ */

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUrl(value) {
  const url = trimString(value);
  if (!url) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

let idCounter = 0;

function generateId() {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `evt-${Date.now().toString(36)}-${random}-${idCounter}`;
}

function normalizeEvent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const start = isValidISODate(source.start) ? source.start.trim() : '';
  let end = isValidISODate(source.end) ? source.end.trim() : '';
  if (!start || !end || parseISODate(end).stamp < parseISODate(start).stamp) {
    end = '';
  }

  const expectedMonth = parseMonth(source.expectedMonth) ? source.expectedMonth.trim() : '';

  return {
    id: trimString(source.id) || generateId(),
    title: trimString(source.title),
    fullTitle: trimString(source.fullTitle),
    category: trimString(source.category) || 'Другое',
    start,
    end,
    expectedMonth,
    place: trimString(source.place),
    url: normalizeUrl(source.url),
    note: trimString(source.note),
    previous: trimString(source.previous),
    tentative: !start,
    createdAt: trimString(source.createdAt) || new Date().toISOString(),
  };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    showPast: source.showPast !== false,
    showTentative: source.showTentative !== false,
    showHero: source.showHero !== false,
    openOnStartup: source.openOnStartup === true,
  };
}

function normalizeData(raw) {
  if (raw === null || raw === undefined) {
    return {
      version: DATA_VERSION,
      events: DEFAULT_EVENTS.map((event) => normalizeEvent(event)),
      settings: Object.assign({}, DEFAULT_SETTINGS),
    };
  }

  const source = typeof raw === 'object' ? raw : {};
  const events = Array.isArray(source.events)
    ? source.events.map((event) => normalizeEvent(event)).filter((event) => event.title)
    : DEFAULT_EVENTS.map((event) => normalizeEvent(event));

  return {
    version: DATA_VERSION,
    events,
    settings: normalizeSettings(source.settings),
  };
}

/* ------------------------------------------------------------------ */
/* Параметры блока кода                                                */
/* ------------------------------------------------------------------ */

function parseBoolean(value, fallback) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (['true', 'yes', '1', 'on', 'да'].includes(normalized)) return true;
  if (['false', 'no', '0', 'off', 'нет'].includes(normalized)) return false;
  return fallback;
}

function parseCodeBlockOptions(source) {
  const options = {};
  String(source || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (!match) return;
      const key = match[1].toLowerCase().replace(/-/g, '_');
      const value = match[2].replace(/^["']|["']$/g, '');

      switch (key) {
        case 'view':
        case 'mode':
          if (VIEW_MODES.includes(value.toLowerCase())) options.view = value.toLowerCase();
          break;
        case 'limit': {
          const limit = parseInt(value, 10);
          if (Number.isFinite(limit) && limit > 0) {
            options.limit = limit;
          } else if (limit === 0) {
            options.limit = 0;
          }
          break;
        }
        case 'hero':
          options.showHero = parseBoolean(value, true);
          break;
        case 'filters':
          options.showFilters = parseBoolean(value, true);
          break;
        case 'compact':
          options.compact = parseBoolean(value, false);
          break;
        case 'title':
          options.title = value;
          break;
        default:
          break;
      }
    });

  return options;
}

/* ------------------------------------------------------------------ */
/* DOM-помощники                                                       */
/* ------------------------------------------------------------------ */

function createElSafe(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function addIconButton(parent, iconName, label, onClick) {
  const button = createElSafe('button', 'ct-icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  try {
    setIcon(button, iconName);
  } catch (error) {
    /* старые версии Obsidian могут не поддерживать иконку */
  }
  if (!button.firstChild) button.textContent = '•';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  parent.appendChild(button);
  return button;
}

function createMetaRow(iconName, text) {
  const row = createElSafe('div', 'ct-meta');
  const icon = createElSafe('span', 'ct-meta-icon');
  try {
    setIcon(icon, iconName);
  } catch (error) {
    /* без иконки */
  }
  row.appendChild(icon);
  row.appendChild(createElSafe('span', 'ct-meta-text', text));
  return row;
}

/* ------------------------------------------------------------------ */
/* Отрисовка виджета                                                   */
/* ------------------------------------------------------------------ */

function heroLabel(state) {
  if (state.kind === 'ongoing') return 'Сейчас идёт';
  if (state.kind === 'upcoming') return 'Ближайшее событие';
  if (state.kind === 'past') return 'Недавно завершилось';
  return 'Ожидается';
}

function renderHero(parent, item) {
  const { event, state } = item;
  const hero = createElSafe('div', 'ct-hero');
  hero.dataset.state = state.kind;
  hero.dataset.category = event.category || 'Другое';

  hero.appendChild(createElSafe('div', 'ct-hero-label', heroLabel(state)));

  const titleRow = createElSafe('div', 'ct-hero-title-row');
  titleRow.appendChild(createElSafe('div', 'ct-hero-title', event.title));
  hero.appendChild(titleRow);

  if (state.kind === 'upcoming') {
    const count = createElSafe('div', 'ct-hero-count');
    count.appendChild(createElSafe('span', 'ct-hero-num', String(state.days)));
    count.appendChild(
      createElSafe('span', 'ct-hero-unit', pluralRu(state.days, ['день', 'дня', 'дней'])),
    );
    count.appendChild(createElSafe('span', 'ct-hero-unit-note', 'до начала'));
    hero.appendChild(count);
  } else if (state.kind === 'ongoing') {
    const count = createElSafe('div', 'ct-hero-count');
    if (state.length === 1) {
      count.appendChild(createElSafe('span', 'ct-hero-text', 'Сегодня'));
    } else {
      count.appendChild(
        createElSafe(
          'span',
          'ct-hero-num',
          state.lastDay ? 'Финал' : `${state.dayIndex}/${state.length}`,
        ),
      );
      count.appendChild(createElSafe('span', 'ct-hero-unit-note', 'день события'));
    }
    hero.appendChild(count);
  }

  hero.appendChild(
    createElSafe('div', 'ct-hero-date', formatRangeRu(event.start, event.end)),
  );
  if (event.place) {
    hero.appendChild(createElSafe('div', 'ct-hero-place', event.place));
  }

  parent.appendChild(hero);
}

function renderBadge(state) {
  const badge = createElSafe('span', 'ct-badge', formatCountdown(state));
  badge.dataset.state = state.kind;
  return badge;
}

function renderCard(parent, item, context) {
  const { event, state } = item;
  const card = createElSafe('div', 'ct-card');
  card.dataset.state = state.kind;
  card.dataset.category = event.category || 'Другое';

  const body = createElSafe('div', 'ct-card-body');
  card.appendChild(body);

  const top = createElSafe('div', 'ct-card-top');
  body.appendChild(top);

  const titles = createElSafe('div', 'ct-card-titles');
  const title = createElSafe('div', 'ct-card-title', event.title);
  if (event.fullTitle) title.title = event.fullTitle;
  titles.appendChild(title);
  if (event.fullTitle && event.fullTitle !== event.title && !context.compact) {
    titles.appendChild(createElSafe('div', 'ct-card-subtitle', event.fullTitle));
  }
  top.appendChild(titles);
  top.appendChild(renderBadge(state));

  const dateText =
    state.kind === 'tentative'
      ? event.expectedMonth
        ? `Ориентир: ${formatMonthRu(event.expectedMonth)}`
        : 'Без даты'
      : formatRangeRu(event.start, event.end);
  body.appendChild(createMetaRow('calendar-days', dateText));

  if (event.place) {
    body.appendChild(createMetaRow('map-pin', event.place));
  }

  if (event.note && !context.compact) {
    body.appendChild(createElSafe('div', 'ct-card-note', event.note));
  }

  const footer = createElSafe('div', 'ct-card-foot');
  footer.appendChild(createElSafe('span', 'ct-chip', event.category || 'Другое'));

  if (event.url) {
    const link = createElSafe('a', 'ct-link', 'Сайт ↗');
    link.href = event.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    footer.appendChild(link);
  }

  if (event.previous && !context.compact) {
    footer.appendChild(createElSafe('span', 'ct-previous', `Прошлый раз: ${event.previous}`));
  }
  body.appendChild(footer);

  if (context.canEdit) {
    const actions = createElSafe('div', 'ct-card-actions');
    addIconButton(actions, 'pencil', 'Изменить событие', () => context.onEdit(event));
    addIconButton(actions, 'trash-2', 'Удалить событие', () => context.onDelete(event));
    card.appendChild(actions);
  }

  parent.appendChild(card);
}

function renderTabs(parent, activeMode, events, settings, nowDay, onChange) {
  const tabs = createElSafe('div', 'ct-tabs');
  const modes = settings.showPast === false ? ['upcoming', 'all'] : ['upcoming', 'all', 'past'];

  modes.forEach((mode) => {
    const count = countForMode(events, mode, settings, nowDay);
    const tab = createElSafe('button', 'ct-tab');
    tab.type = 'button';
    tab.dataset.mode = mode;
    if (mode === activeMode) tab.classList.add('is-active');
    tab.appendChild(createElSafe('span', 'ct-tab-label', VIEW_LABELS[mode]));
    tab.appendChild(createElSafe('span', 'ct-tab-count', String(count)));
    tab.addEventListener('click', () => onChange(mode));
    tabs.appendChild(tab);
  });

  parent.appendChild(tabs);
}

/**
 * Рисует виджет в произвольный контейнер. Используется и боковой панелью,
 * и блоком ```conferences``` внутри заметки.
 */
function renderWidget(container, plugin, options) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, plugin.getSettings());
  const opts = Object.assign(
    {
      compact: false,
      showHeader: true,
      showFilters: true,
      showHero: null,
      view: null,
      limit: 0,
      title: '',
      inline: false,
      now: null,
    },
    options || {},
  );

  const state = {
    view: VIEW_MODES.includes(opts.view) ? opts.view : 'upcoming',
    limit: Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 0,
  };

  const root = createElSafe('div', 'ct-widget');
  if (opts.compact) root.classList.add('ct-widget--compact');
  if (opts.inline) root.classList.add('ct-widget--inline');
  container.appendChild(root);

  function draw() {
    clearNode(root);
    const events = plugin.getEvents() || [];
    const nowDay = Number.isFinite(opts.now) ? opts.now : todayDayNumber();
    const showHero = opts.showHero === null ? settings.showHero !== false : !!opts.showHero;

    if (opts.title) {
      root.appendChild(createElSafe('div', 'ct-widget-title', opts.title));
    }

    if (opts.showHeader) {
      const header = createElSafe('div', 'ct-header');
      const textBlock = createElSafe('div', 'ct-header-text');
      textBlock.appendChild(createElSafe('div', 'ct-title', 'Конференции'));
      const subtitleParts = [
        `${events.length} ${pluralRu(events.length, ['событие', 'события', 'событий'])}`,
      ];
      const heroItem = pickHero(sortEvents(events, nowDay));
      if (heroItem && heroItem.state.kind === 'upcoming') {
        subtitleParts.push(
          `ближайшее через ${heroItem.state.days} ${pluralRu(heroItem.state.days, [
            'день',
            'дня',
            'дней',
          ])}`,
        );
      } else if (heroItem && heroItem.state.kind === 'ongoing') {
        subtitleParts.push('одно идёт сейчас');
      }
      textBlock.appendChild(createElSafe('div', 'ct-subtitle', subtitleParts.join(' · ')));
      header.appendChild(textBlock);

      const actions = createElSafe('div', 'ct-header-actions');
      addIconButton(actions, 'plus', 'Добавить событие', () => plugin.openEventModal());
      addIconButton(actions, 'refresh-cw', 'Обновить', () => draw());
      header.appendChild(actions);
      root.appendChild(header);
    }

    if (opts.showFilters) {
      renderTabs(root, state.view, events, settings, nowDay, (mode) => {
        state.view = mode;
        draw();
      });
    }

    let items = filterEvents(events, state.view, settings, nowDay);
    if (state.limit > 0) items = items.slice(0, state.limit);

    if (showHero && state.view !== 'past') {
      const heroItem = pickHero(items.length > 0 ? items : filterEvents(events, 'all', settings, nowDay));
      if (heroItem) renderHero(root, heroItem);
    }

    if (items.length === 0) {
      const empty = createElSafe('div', 'ct-empty');
      let emptyTitle = 'Предстоящих событий нет';
      if (state.view === 'past') emptyTitle = 'Прошедших событий нет';
      if (state.view === 'all') emptyTitle = 'Событий нет';
      empty.appendChild(createElSafe('div', 'ct-empty-title', emptyTitle));
      empty.appendChild(
        createElSafe(
          'div',
          'ct-empty-text',
          events.length === 0
            ? 'Добавьте форум, выставку или конференцию — виджет посчитает дни до начала.'
            : 'Измените фильтр или добавьте новое событие.',
        ),
      );
      if (events.length === 0) {
        const button = createElSafe('button', 'ct-primary-btn', 'Добавить событие');
        button.type = 'button';
        button.addEventListener('click', () => plugin.openEventModal());
        empty.appendChild(button);
      }
      root.appendChild(empty);
      return;
    }

    const sections = buildSections(items, state.view);
    sections.forEach((section) => {
      if (section.title) {
        root.appendChild(createElSafe('div', 'ct-section-title', section.title));
      }
      const list = createElSafe('div', 'ct-list');
      section.items.forEach((item) => {
        renderCard(list, item, {
          compact: !!opts.compact,
          canEdit: true,
          onEdit: (event) => plugin.openEventModal(event),
          onDelete: (event) => plugin.deleteEvent(event),
        });
      });
      root.appendChild(list);
    });
  }

  draw();
  return { refresh: draw, element: root };
}

/* ------------------------------------------------------------------ */
/* Блок ```conferences``` внутри заметки                               */
/* ------------------------------------------------------------------ */

class ConferenceCodeBlock extends MarkdownRenderChild {
  constructor(containerEl, plugin, options) {
    super(containerEl);
    this.plugin = plugin;
    this.options = options || {};
    this.unsubscribe = null;
  }

  onload() {
    this.unsubscribe = this.plugin.onChange(() => this.draw());
    this.draw();
  }

  onunload() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  draw() {
    clearNode(this.containerEl);
    renderWidget(
      this.containerEl,
      this.plugin,
      Object.assign(
        {
          inline: true,
          compact: true,
          showHeader: false,
          showFilters: true,
          showHero: null,
          view: 'upcoming',
        },
        this.options,
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Модальные окна                                                      */
/* ------------------------------------------------------------------ */

class ConfirmModal extends Modal {
  constructor(app, title, message, onConfirm, confirmLabel) {
    super(app);
    this.titleText = title;
    this.message = message;
    this.onConfirm = onConfirm;
    this.confirmLabel = confirmLabel || 'Удалить';
  }

  onOpen() {
    const content = this.contentEl;
    content.classList.add('ct-modal');
    if (this.titleEl) this.titleEl.textContent = this.titleText;
    content.appendChild(createElSafe('p', 'ct-modal-text', this.message));

    new Setting(content)
      .addButton((button) =>
        button.setButtonText('Отмена').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose() {
    clearNode(this.contentEl);
  }
}

class EventModal extends Modal {
  constructor(app, plugin, event) {
    super(app);
    this.plugin = plugin;
    this.event = event || null;
    this.draft = event
      ? Object.assign({}, event)
      : {
          id: '',
          title: '',
          fullTitle: '',
          category: 'Конференция',
          start: '',
          end: '',
          expectedMonth: '',
          place: '',
          url: '',
          note: '',
          previous: '',
          tentative: false,
        };
    this.errorsEl = null;
    this.dateFields = null;
    this.expectedFields = null;
  }

  onOpen() {
    this.contentEl.classList.add('ct-modal');
    if (this.titleEl) {
      this.titleEl.textContent = this.event ? 'Изменить событие' : 'Новое событие';
    }
    this.renderForm();
  }

  onClose() {
    clearNode(this.contentEl);
  }

  renderForm() {
    const content = this.contentEl;
    clearNode(content);

    const nameSetting = new Setting(content)
      .setName('Название')
      .setDesc('Так событие будет называться в виджете.');
    nameSetting.addText((text) => {
      text
        .setPlaceholder('Например, Технопром')
        .setValue(this.draft.title || '')
        .onChange((value) => {
          this.draft.title = value;
        });
      text.inputEl.classList.add('ct-input-wide');
    });

    new Setting(content).setName('Полное название').addText((text) => {
      text
        .setPlaceholder('Необязательно: расшифровка или подзаголовок')
        .setValue(this.draft.fullTitle || '')
        .onChange((value) => {
          this.draft.fullTitle = value;
        });
      text.inputEl.classList.add('ct-input-wide');
    });

    new Setting(content).setName('Категория').addDropdown((dropdown) => {
      const categories = CATEGORIES.slice();
      if (this.draft.category && !categories.includes(this.draft.category)) {
        categories.push(this.draft.category);
      }
      categories.forEach((category) => dropdown.addOption(category, category));
      dropdown.setValue(this.draft.category || 'Другое').onChange((value) => {
        this.draft.category = value;
      });
    });

    new Setting(content)
      .setName('Дата уточняется')
      .setDesc('Включите, если точные даты ещё не объявлены.')
      .addToggle((toggle) =>
        toggle.setValue(!!this.draft.tentative).onChange((value) => {
          this.draft.tentative = value;
          if (value) {
            this.draft.start = '';
            this.draft.end = '';
          }
          this.syncDateFields();
        }),
      );

    this.dateFields = createElSafe('div', 'ct-modal-section');
    content.appendChild(this.dateFields);

    new Setting(this.dateFields).setName('Дата начала').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.draft.start || '').onChange((value) => {
        this.draft.start = value;
      });
    });

    new Setting(this.dateFields).setName('Дата окончания').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.draft.end || '').onChange((value) => {
        this.draft.end = value;
      });
    });

    this.expectedFields = createElSafe('div', 'ct-modal-section');
    content.appendChild(this.expectedFields);

    new Setting(this.expectedFields)
      .setName('Ориентировочный месяц')
      .setDesc('Покажет «Ориентир: август 2027» вместо точной даты.')
      .addText((text) => {
        text.inputEl.type = 'month';
        text.setValue(this.draft.expectedMonth || '').onChange((value) => {
          this.draft.expectedMonth = value;
        });
      });

    new Setting(content).setName('Место').addText((text) => {
      text
        .setPlaceholder('Город · площадка')
        .setValue(this.draft.place || '')
        .onChange((value) => {
          this.draft.place = value;
        });
      text.inputEl.classList.add('ct-input-wide');
    });

    new Setting(content).setName('Сайт').addText((text) => {
      text
        .setPlaceholder('https://…')
        .setValue(this.draft.url || '')
        .onChange((value) => {
          this.draft.url = value;
        });
      text.inputEl.classList.add('ct-input-wide');
    });

    new Setting(content).setName('Заметка').addTextArea((text) => {
      text
        .setPlaceholder('Что важно не забыть: регистрация, стенд, контакты…')
        .setValue(this.draft.note || '')
        .onChange((value) => {
          this.draft.note = value;
        });
      text.inputEl.rows = 3;
      text.inputEl.classList.add('ct-input-wide');
    });

    new Setting(content)
      .setName('Прошлое проведение')
      .setDesc('Необязательно: например, «2026 — 26–28 августа».')
      .addText((text) => {
        text
          .setPlaceholder('2026 — 26–28 августа')
          .setValue(this.draft.previous || '')
          .onChange((value) => {
            this.draft.previous = value;
          });
        text.inputEl.classList.add('ct-input-wide');
      });

    this.errorsEl = createElSafe('div', 'ct-form-errors');
    content.appendChild(this.errorsEl);

    new Setting(content)
      .addButton((button) =>
        button
          .setButtonText(this.event ? 'Сохранить' : 'Добавить')
          .setCta()
          .onClick(() => this.save()),
      )
      .addButton((button) => button.setButtonText('Отмена').onClick(() => this.close()));

    this.syncDateFields();
  }

  syncDateFields() {
    const tentative = !!this.draft.tentative;
    if (this.dateFields) this.dateFields.style.display = tentative ? 'none' : '';
    if (this.expectedFields) this.expectedFields.style.display = tentative ? '' : 'none';
  }

  validate() {
    const errors = [];
    if (!trimString(this.draft.title)) {
      errors.push('Укажите название события.');
    }

    if (!this.draft.tentative && !this.draft.start) {
      errors.push('Укажите дату начала или включите «Дата уточняется».');
    }

    if (this.draft.start) {
      if (!isValidISODate(this.draft.start)) {
        errors.push('Дата начала должна быть в формате ГГГГ-ММ-ДД.');
      }
      if (this.draft.end) {
        if (!isValidISODate(this.draft.end)) {
          errors.push('Дата окончания должна быть в формате ГГГГ-ММ-ДД.');
        } else if (
          isValidISODate(this.draft.start) &&
          parseISODate(this.draft.end).stamp < parseISODate(this.draft.start).stamp
        ) {
          errors.push('Дата окончания не может быть раньше даты начала.');
        }
      }
    } else if (this.draft.expectedMonth && !parseMonth(this.draft.expectedMonth)) {
      errors.push('Ориентировочный месяц должен быть в формате ГГГГ-ММ.');
    }

    return errors;
  }

  async save() {
    const errors = this.validate();
    if (this.errorsEl) {
      clearNode(this.errorsEl);
      if (errors.length > 0) {
        errors.forEach((message) => {
          this.errorsEl.appendChild(createElSafe('div', 'ct-error', message));
        });
        this.errorsEl.style.display = '';
      } else {
        this.errorsEl.style.display = 'none';
      }
    }
    if (errors.length > 0) {
      new Notice(errors[0]);
      return;
    }

    const payload = Object.assign({}, this.draft);
    if (payload.tentative || !payload.start) {
      payload.start = '';
      payload.end = '';
      payload.tentative = true;
    } else {
      payload.expectedMonth = '';
      payload.tentative = false;
    }

    await this.plugin.upsertEvent(payload);
    this.close();
    new Notice(this.event ? 'Событие обновлено' : 'Событие добавлено');
  }
}

/* ------------------------------------------------------------------ */
/* Боковая панель                                                      */
/* ------------------------------------------------------------------ */

class ConferenceTrackerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.unsubscribe = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Конференции';
  }

  getIcon() {
    return 'calendar-days';
  }

  async onOpen() {
    this.contentEl.classList.add('ct-panel');
    this.unsubscribe = this.plugin.onChange(() => this.render());
    this.render();
  }

  async onClose() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  render() {
    clearNode(this.contentEl);
    renderWidget(this.contentEl, this.plugin, {
      showHeader: true,
      showFilters: true,
      showHero: true,
      compact: false,
      inline: false,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

class ConferenceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const container = this.containerEl;
    clearNode(container);
    container.classList.add('ct-settings');

    container.appendChild(createElSafe('h2', 'ct-settings-title', 'Конференции'));
    container.appendChild(
      createElSafe(
        'p',
        'ct-settings-intro',
        'Виджет отслеживает даты форумов, выставок и конференций. Настройки применяются сразу.',
      ),
    );

    this.addToggle(
      'Показывать прошедшие события',
      'Вкладка «Прошедшие» и архив в списке «Все».',
      this.plugin.settings.showPast,
      (value) => {
        this.plugin.settings.showPast = value;
        this.plugin.persist();
      },
    );

    this.addToggle(
      'Показывать события с неуточнённой датой',
      'Например, «Технопром — ориентир: август 2027».',
      this.plugin.settings.showTentative,
      (value) => {
        this.plugin.settings.showTentative = value;
        this.plugin.persist();
      },
    );

    this.addToggle(
      'Показывать блок «Ближайшее событие»',
      'Крупный обратный отсчёт над списком.',
      this.plugin.settings.showHero,
      (value) => {
        this.plugin.settings.showHero = value;
        this.plugin.persist();
      },
    );

    this.addToggle(
      'Открывать панель при запуске Obsidian',
      'Панель появится в правой боковой области автоматически.',
      this.plugin.settings.openOnStartup,
      (value) => {
        this.plugin.settings.openOnStartup = value;
        this.plugin.persist();
      },
    );

    container.appendChild(createElSafe('h3', 'ct-settings-heading', 'Данные'));

    const configDir = this.app && this.app.vault ? this.app.vault.configDir : '.obsidian';
    const dataPath = `${configDir}/plugins/${this.plugin.manifest.id}/data.json`;
    container.appendChild(
      createElSafe(
        'p',
        'ct-settings-note',
        `События хранятся в ${dataPath} и синхронизируются вместе с настройками хранилища. Резервная копия — этот файл.`,
      ),
    );

    new Setting(container)
      .setName('Скопировать список как Markdown')
      .setDesc('Таблица со всеми событиями — удобно вставить в заметку.')
      .addButton((button) =>
        button.setButtonText('Скопировать').onClick(() => this.plugin.copyAsMarkdown()),
      );

    new Setting(container)
      .setName('Сбросить события к исходным')
      .setDesc('Вернутся «Технопром», «День поля» и «Агронеделя».')
      .addButton((button) =>
        button
          .setButtonText('Сбросить')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              'Сбросить события?',
              'Все ваши события будут заменены тремя событиями по умолчанию.',
              () => this.plugin.resetEvents(),
              'Сбросить',
            ).open();
          }),
      );
  }

  addToggle(name, description, value, onChange) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addToggle((toggle) => toggle.setValue(!!value).onChange(onChange));
  }
}

/* ------------------------------------------------------------------ */
/* Плагин                                                              */
/* ------------------------------------------------------------------ */

class ConferenceTrackerPlugin extends Plugin {
  async onload() {
    const raw = await this.loadData();
    this.data = normalizeData(raw);
    this.settings = this.data.settings;
    this.listeners = new Set();

    if (raw === null || raw === undefined) {
      await this.saveData(this.data);
    }

    this.addRibbonIcon('calendar-days', 'Конференции: открыть панель', () => {
      this.activateView();
    });

    this.registerView(VIEW_TYPE, (leaf) => new ConferenceTrackerView(leaf, this));
    this.addSettingTab(new ConferenceSettingTab(this.app, this));

    this.addCommand({
      id: 'open-panel',
      name: 'Открыть панель конференций',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'add-event',
      name: 'Добавить событие',
      callback: () => this.openEventModal(),
    });

    this.addCommand({
      id: 'copy-as-markdown',
      name: 'Скопировать список событий как Markdown',
      callback: () => this.copyAsMarkdown(),
    });

    this.registerMarkdownCodeBlockProcessor(CODE_BLOCK, (source, el, ctx) => {
      ctx.addChild(new ConferenceCodeBlock(el, this, parseCodeBlockOptions(source)));
    });

    if (this.settings.openOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        this.activateView();
      });
    }
  }

  onunload() {
    if (this.listeners) this.listeners.clear();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  getEvents() {
    return this.data ? this.data.events : [];
  }

  getSettings() {
    return this.settings || Object.assign({}, DEFAULT_SETTINGS);
  }

  onChange(callback) {
    if (!this.listeners) this.listeners = new Set();
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
    if (!this.listeners) return;
    Array.from(this.listeners).forEach((callback) => {
      try {
        callback();
      } catch (error) {
        console.error('Conference Tracker: ошибка обновления вида', error);
      }
    });
  }

  async persist() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
    this.notify();
  }

  async upsertEvent(draft) {
    const event = normalizeEvent(draft);
    if (!event.title) return null;

    const index = this.data.events.findIndex((item) => item.id === event.id);
    if (index >= 0) {
      event.createdAt = this.data.events[index].createdAt || event.createdAt;
      this.data.events[index] = event;
    } else {
      this.data.events.push(event);
    }

    await this.persist();
    return event;
  }

  async deleteEvent(event) {
    new ConfirmModal(
      this.app,
      'Удалить событие?',
      `«${event.title}» больше не будет отображаться в виджете.`,
      async () => {
        this.data.events = this.data.events.filter((item) => item.id !== event.id);
        await this.persist();
        new Notice('Событие удалено');
      },
    ).open();
  }

  async resetEvents() {
    this.data.events = DEFAULT_EVENTS.map((event) => normalizeEvent(event));
    await this.persist();
    new Notice('События восстановлены по умолчанию');
  }

  openEventModal(event) {
    new EventModal(this.app, this, event).open();
  }

  async activateView() {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);
    let leaf = existing.length > 0 ? existing[0] : null;

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      leaf = rightLeaf || workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    workspace.revealLeaf(leaf);
    return leaf;
  }

  buildMarkdownTable() {
    const lines = [
      '| Событие | Даты | Место | Сайт |',
      '| --- | --- | --- | --- |',
    ];

    sortEvents(this.data.events).forEach(({ event, state }) => {
      const dates =
        state.kind === 'tentative'
          ? `Дата уточняется${event.expectedMonth ? ` (ориентир: ${formatMonthRu(event.expectedMonth)})` : ''}`
          : formatRangeRu(event.start, event.end);
      lines.push(
        `| ${event.title} | ${dates} | ${event.place || '—'} | ${event.url || '—'} |`,
      );
    });

    return lines.join('\n');
  }

  async copyAsMarkdown() {
    const markdown = this.buildMarkdownTable();
    try {
      await navigator.clipboard.writeText(markdown);
      new Notice('Список событий скопирован в буфер обмена');
    } catch (error) {
      console.error('Conference Tracker: не удалось скопировать', error);
      new Notice('Не удалось скопировать список — проверьте разрешения буфера обмена');
    }
  }
}

module.exports = ConferenceTrackerPlugin;
module.exports.__internals = {
  VIEW_TYPE,
  CODE_BLOCK,
  DEFAULT_EVENTS,
  DEFAULT_SETTINGS,
  CATEGORIES,
  parseISODate,
  isValidISODate,
  dayNumberFromDate,
  todayDayNumber,
  parseMonth,
  formatDateRu,
  formatRangeRu,
  formatMonthRu,
  formatMonthTitle,
  pluralRu,
  getEventState,
  formatCountdown,
  sortEvents,
  filterEvents,
  countForMode,
  pickHero,
  buildSections,
  normalizeEvent,
  normalizeData,
  normalizeSettings,
  parseCodeBlockOptions,
  renderWidget,
  ConferenceTrackerView,
  ConferenceCodeBlock,
  EventModal,
  pad2,
};

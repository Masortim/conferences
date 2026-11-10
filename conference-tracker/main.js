/*
 * Conference Tracker — виджет Obsidian для отслеживания дат форумов,
 * выставок, конференций и дней поля.
 *
 * Ключевые идеи:
 *  - у события есть «проведения» (editions): каждое со своими датами и местом;
 *  - карточка показывает ближайшее/текущее проведение и то, где и когда
 *    событие было в прошлый раз;
 *  - даты и места могут подтягиваться автоматически с официальных сайтов
 *    (JSON-LD, микроразметка, текстовые даты), ручные правки не затираются.
 *
 * Плагин не требует сборки: это обычный CommonJS-файл, который Obsidian
 * загружает напрямую. Чистые функции покрыты тестами (см. tests/).
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
const requestUrl = typeof obsidian.requestUrl === 'function' ? obsidian.requestUrl : null;

const VIEW_TYPE = 'conference-tracker-view';
const CODE_BLOCK = 'conferences';
const DATA_VERSION = 2;
const SYNC_TIMEOUT_MS = 15000;
const MAX_EDITIONS = 12;

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

const STOP_WORDS = new Set([
  'день', 'поля', 'форум', 'выставка', 'конференция', 'всероссийский',
  'международный', 'ежегодный', 'аграрный', 'агропромышленный',
]);

const DEFAULT_SETTINGS = {
  showPast: true,
  showTentative: true,
  showHero: true,
  openOnStartup: false,
  autoSync: true,
  syncIntervalHours: 12,
  lastSyncAt: '',
  lastSyncSummary: '',
};

/**
 * Определения событий по умолчанию: только метаданные и источники.
 * Даты и места здесь не хранятся — плагин получает их с официальных сайтов
 * при запуске и по команде обновления.
 */
const DEFAULT_EVENTS = [
  {
    id: 'agroneweek',
    title: 'Агронеделя',
    fullTitle: 'Сибирская аграрная неделя',
    category: 'Выставка',
    url: 'https://sibagroweek.ru/',
    note: 'Международная агропромышленная выставка и Новосибирский агропродовольственный форум.',
    sync: { sources: ['https://sibagroweek.ru/'] },
  },
  {
    id: 'technoprom',
    title: 'Технопром',
    fullTitle: 'Международный форум технологического развития',
    category: 'Форум',
    url: 'https://форумтехнопром.рф/',
    note: 'Даты и место публикуются на официальном сайте форума.',
    sync: { sources: ['https://форумтехнопром.рф/'] },
  },
  {
    id: 'field-day',
    title: 'День поля',
    fullTitle: 'Всероссийский день поля',
    category: 'День поля',
    url: 'https://russian-field-day.ru/',
    note: 'Всероссийский день поля ежегодно меняет регион; в плагине учитываются только Новосибирская область и Алтайский край.',
    regions: ['Новосибирская область', 'Новосибирск', 'Алтай'],
    sync: { sources: ['https://russian-field-day.ru/'] },
  },
];

/* ------------------------------------------------------------------ */
/* Даты: чистые функции                                                */
/* ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Разбирает ГГГГ-ММ-ДД; возвращает null для несуществующих дат. */
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

  return { year, month, day, stamp: Math.round(stamp / 86400000) };
}

function isValidISODate(value) {
  return parseISODate(value) !== null;
}

function makeISO(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return isValidISODate(iso) ? iso : '';
}

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

/** Номер месяца (ГГГГММ) для дня, посчитанного от 1970-01-01. */
function monthKeyAt(dayNumber) {
  const date = new Date(dayNumber * 86400000);
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;
}

/** «10 ноября 2026» */
function formatDateRu(value) {
  const parsed = parseISODate(value);
  if (!parsed) return '';
  return `${parsed.day} ${MONTHS_GENITIVE[parsed.month - 1]} ${parsed.year}`;
}

/** «10–12 ноября 2026», «28 февраля — 2 марта 2027» */
function formatRangeRu(start, end) {
  const from = parseISODate(start);
  if (!from) return '';
  const to = parseISODate(end);

  if (!to || to.stamp === from.stamp) {
    return formatDateRu(start);
  }

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

function formatMonthRu(value) {
  const parsed = parseMonth(value);
  if (!parsed) return '';
  return `${MONTHS_NOMINATIVE[parsed.month - 1]} ${parsed.year}`;
}

function formatMonthTitle(value) {
  const formatted = formatMonthRu(value);
  return formatted ? formatted.charAt(0).toUpperCase() + formatted.slice(1) : '';
}

/** «08.11.2026, 14:05» из ISO-строки */
function formatDateTimeRu(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}, ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Русские формы множественного числа. */
function pluralRu(count, forms) {
  const abs = Math.abs(count) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/* ------------------------------------------------------------------ */
/* Проведения и их состояния                                           */
/* ------------------------------------------------------------------ */

/**
 * Состояние одного проведения: upcoming | ongoing | past.
 * Для пустых дат возвращает tentative.
 */
function editionState(edition, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const source = edition && typeof edition === 'object' ? edition : {};
  const start = parseISODate(source.start);

  if (!start) {
    return { kind: 'tentative', startDay: null, endDay: null, length: 0, days: null, daysAgo: null };
  }

  const endParsed = parseISODate(source.end);
  const startDay = start.stamp;
  const endDay = endParsed && endParsed.stamp >= startDay ? endParsed.stamp : startDay;
  const length = endDay - startDay + 1;

  // Предварительная дата не даёт точного счётчика «через N дней».
  // Если она уже наступила, событие действительно идёт — показываем «Идёт».
  if (source.tentative === true && today < startDay) {
    return { kind: 'tentative', startDay, endDay, length, days: null, daysAgo: null };
  }

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

function editionEndDay(edition) {
  const start = parseISODate(edition && edition.start);
  if (!start) return 0;
  const end = parseISODate(edition.end);
  return end && end.stamp >= start.stamp ? end.stamp : start.stamp;
}

function compareEditionsDesc(a, b) {
  const aStart = parseISODate(a.start);
  const bStart = parseISODate(b.start);
  return (bStart ? bStart.stamp : 0) - (aStart ? aStart.stamp : 0);
}

/** Проверяет, попадает ли место проведения в разрешённые регионы события. */
function editionAllowedInRegions(edition, event) {
  const regions = event && Array.isArray(event.regions) ? event.regions : [];
  if (regions.length === 0) return true;

  const place = trimString(edition && edition.place);
  if (!place) return true; // место неизвестно — не скрываем проведение

  const haystack = place.toLowerCase();
  return regions.some((region) => haystack.includes(region.toLowerCase()));
}

function sortedEditions(event) {
  const list = event && Array.isArray(event.editions) ? event.editions.slice() : [];
  return list
    .filter((edition) => parseISODate(edition.start))
    .filter((edition) => editionAllowedInRegions(edition, event))
    .sort(compareEditionsDesc);
}

function yearFromDay(dayNumber) {
  const date = new Date(dayNumber * 86400000);
  return date.getUTCFullYear();
}

function editionYear(edition) {
  const parsed = parseISODate(edition && edition.start);
  return parsed ? parsed.year : 0;
}

/** Ближайшее текущее или будущее проведение. */
function getNearestEdition(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  let best = null;
  let bestState = null;

  sortedEditions(event).forEach((edition) => {
    const state = editionState(edition, today);
    if (state.kind !== 'upcoming' && state.kind !== 'ongoing') return;
    if (!best || state.startDay < bestState.startDay) {
      best = edition;
      bestState = state;
    }
  });

  return best;
}

/** Последнее завершившееся проведение. */
function getLastPastEdition(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const past = sortedEditions(event).filter((edition) => editionState(edition, today).kind === 'past');
  return past[0] || null;
}

/** Ближайшее предварительное (ещё не подтверждённое) проведение. */
function getTentativeEdition(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const candidates = sortedEditions(event)
    .filter((edition) => editionState(edition, today).kind === 'tentative')
    .sort((a, b) => parseISODate(a.start).stamp - parseISODate(b.start).stamp);
  return candidates[0] || null;
}

function getPastEditions(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  return sortedEditions(event).filter((edition) => editionState(edition, today).kind === 'past');
}

/**
 * Прошлое проведение, которое интересует пользователя:
 * текущего года, если оно уже прошло, иначе — прошлого года
 * (пока проведение текущего года ещё ожидается или не состоялось).
 */
function getRelevantPastEdition(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const currentYear = yearFromDay(today);
  const past = getPastEditions(event, today);

  const expectedThisYear = sortedEditions(event).some((edition) => {
    if (editionYear(edition) !== currentYear) return false;
    const state = editionState(edition, today);
    return state.kind === 'upcoming' || state.kind === 'ongoing';
  });

  if (expectedThisYear) {
    return past.find((edition) => editionYear(edition) === currentYear - 1) || null;
  }

  return (
    past.find((edition) => editionYear(edition) === currentYear) ||
    past.find((edition) => editionYear(edition) === currentYear - 1) ||
    null
  );
}

/**
 * Общее состояние события: состояние ближайшего проведения, иначе
 * «дата уточняется» (если задан ориентир), иначе состояние последнего
 * прошедшего проведения.
 */
function getEventState(event, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const nearest = getNearestEdition(event, today);
  if (nearest) return editionState(nearest, today);

  const lastPast = getLastPastEdition(event, today);
  const expected = parseMonth(event && event.expectedMonth);
  // Ориентир из прошлого месяца уже неактуален — не показываем «Дата уточняется».
  const hasExpectedMonth = expected && expected.year * 100 + expected.month >= monthKeyAt(today);

  if (hasExpectedMonth) {
    return { kind: 'tentative', startDay: null, endDay: null, length: 0, days: null, daysAgo: null };
  }

  if (getTentativeEdition(event, today)) {
    return { kind: 'tentative', startDay: null, endDay: null, length: 0, days: null, daysAgo: null };
  }

  if (lastPast) return editionState(lastPast, today);

  return { kind: 'tentative', startDay: null, endDay: null, length: 0, days: null, daysAgo: null };
}

/**
 * Элемент списка: что показывать в карточке и что считать «прошлым разом».
 */
function buildItem(event, mode, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const nearest = getNearestEdition(event, today);
  const lastPast = getRelevantPastEdition(event, today);
  const tentativeEdition = nearest ? null : getTentativeEdition(event, today);
  const history = lastPast ? [lastPast] : [];
  const state = getEventState(event, today);

  let display = nearest;
  let displayState = nearest ? editionState(nearest, today) : null;

  if (mode === 'past') {
    display = lastPast;
    displayState = lastPast ? editionState(lastPast, today) : null;
  } else if (!display && lastPast && state.kind === 'past') {
    display = lastPast;
    displayState = editionState(lastPast, today);
  }

  return {
    event,
    state,
    nearest,
    lastPast,
    tentativeEdition,
    history,
    display,
    displayState,
  };
}

function isItemVisible(item, mode, settings) {
  const safeSettings = Object.assign({}, DEFAULT_SETTINGS, settings || {});

  if (mode === 'past') {
    return !!item.lastPast && safeSettings.showPast !== false;
  }

  if (mode === 'upcoming') {
    if (item.state.kind === 'past') return false;
    if (item.state.kind === 'tentative') return safeSettings.showTentative !== false;
    return true;
  }

  if (item.state.kind === 'tentative') {
    return safeSettings.showTentative !== false;
  }
  if (item.state.kind === 'past') {
    // Старое прошлое (позапрошлый год и раньше) не показываем вовсе.
    if (!item.lastPast) return false;
    return safeSettings.showPast !== false;
  }
  return true;
}

function stateRank(state) {
  if (state.kind === 'upcoming' || state.kind === 'ongoing') return 0;
  if (state.kind === 'tentative') return 1;
  return 2;
}

function sortItems(items, mode) {
  const list = items.slice();
  list.sort((a, b) => {
    if (mode === 'past') {
      const aEnd = a.displayState ? a.displayState.endDay : 0;
      const bEnd = b.displayState ? b.displayState.endDay : 0;
      return bEnd - aEnd;
    }

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

    const aEnd = a.lastPast ? editionEndDay(a.lastPast) : 0;
    const bEnd = b.lastPast ? editionEndDay(b.lastPast) : 0;
    return bEnd - aEnd || String(a.event.title).localeCompare(String(b.event.title), 'ru');
  });
  return list;
}

function buildItems(events, mode, settings, nowDay) {
  const safeMode = VIEW_MODES.includes(mode) ? mode : 'upcoming';
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const items = (Array.isArray(events) ? events : [])
    .map((event) => buildItem(event, safeMode, today))
    .filter((item) => isItemVisible(item, safeMode, settings));
  return sortItems(items, safeMode);
}

function countForMode(events, mode, settings, nowDay) {
  return buildItems(events, mode, settings, nowDay).length;
}

/** Ближайшее событие для крупного блока. */
function pickHero(items) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item.displayState && (item.displayState.kind === 'ongoing' || item.displayState.kind === 'upcoming')) {
      return item;
    }
  }
  return null;
}

function buildSections(items, mode) {
  const sections = [];
  const index = new Map();

  for (const item of items) {
    let key;
    let title;

    if (mode === 'past') {
      key = '__past';
      title = 'Прошедшие';
    } else if (!item.display || !item.displayState) {
      key = '__tentative';
      title = 'Дата уточняется';
    } else if (item.displayState.kind === 'past') {
      key = '__past';
      title = 'Прошедшие';
    } else {
      key = `month:${String(item.display.start).slice(0, 7)}`;
      title = formatMonthTitle(String(item.display.start).slice(0, 7));
    }

    let section = index.get(key);
    if (!section) {
      section = { key, title, items: [] };
      index.set(key, section);
      sections.push(section);
    }
    section.items.push(item);
  }

  if (mode === 'past') {
    return sections.map((section) => Object.assign({}, section, { title: '' }));
  }

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

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(value) {
  const url = trimString(value);
  if (!url) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function normalizeRegions(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((region) => trimString(region))
        .filter(Boolean)
        .slice(0, 10),
    ),
  );
}

let idCounter = 0;

function generateId() {
  idCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `evt-${Date.now().toString(36)}-${random}-${idCounter}`;
}

function normalizeEdition(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const start = isValidISODate(source.start) ? source.start.trim() : '';
  if (!start) return null;

  const endRaw = isValidISODate(source.end) ? source.end.trim() : '';
  const end = endRaw && parseISODate(endRaw).stamp >= parseISODate(start).stamp ? endRaw : '';

  return {
    id: trimString(source.id) || generateId(),
    start,
    end,
    place: trimString(source.place),
    url: normalizeUrl(source.url),
    note: trimString(source.note),
    source: source.source === 'auto' ? 'auto' : 'manual',
    sourceUrl: normalizeUrl(source.sourceUrl),
    checkedAt: trimString(source.checkedAt),
    // Старые авто-даты без явного признака считаем предварительными:
    // они могли быть выведены из текста без года. Повторная синхронизация
    // подтвердит дату, если на сайте есть точный год или JSON-LD.
    tentative:
      source.tentative === undefined ? source.source === 'auto' : source.tentative === true,
  };
}

function normalizeSync(raw, eventUrl) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const url = normalizeUrl(eventUrl);

  let sources = [];
  if (Array.isArray(source.sources)) {
    sources = source.sources.map(normalizeUrl).filter(Boolean);
  } else if (url) {
    sources = [url];
  }

  return {
    enabled: source.enabled !== false && sources.length > 0,
    sources: Array.from(new Set(sources)).slice(0, 5),
    lastSync: trimString(source.lastSync),
    lastResult: trimString(source.lastResult),
    lastError: trimString(source.lastError),
  };
}

function dedupeEditions(editions) {
  const seen = new Set();
  const result = [];
  editions
    .slice()
    .sort(compareEditionsDesc)
    .forEach((edition) => {
      const key = `${edition.start}|${edition.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(edition);
    });
  return result.slice(0, MAX_EDITIONS);
}

function normalizeEvent(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  let editions = Array.isArray(source.editions)
    ? source.editions.map(normalizeEdition).filter(Boolean)
    : [];

  // Миграция данных версии 1: start/end/place + произвольная строка previous.
  if (editions.length === 0 && isValidISODate(source.start)) {
    const legacy = normalizeEdition({
      start: source.start,
      end: source.end,
      place: source.place,
      url: source.url,
      source: 'manual',
    });
    if (legacy) editions = [legacy];
  }

  editions = dedupeEditions(editions);

  const expectedMonth = parseMonth(source.expectedMonth) ? source.expectedMonth.trim() : '';
  const url = normalizeUrl(source.url);

  return {
    id: trimString(source.id) || generateId(),
    title: trimString(source.title),
    fullTitle: trimString(source.fullTitle),
    category: trimString(source.category) || 'Другое',
    url,
    note: trimString(source.note),
    expectedMonth,
    editions,
    regions: normalizeRegions(source.regions),
    historyNote: trimString(source.previous) || trimString(source.historyNote),
    sync: normalizeSync(source.sync, url),
    createdAt: trimString(source.createdAt) || new Date().toISOString(),
  };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(source.syncIntervalHours);
  return {
    showPast: source.showPast !== false,
    showTentative: source.showTentative !== false,
    showHero: source.showHero !== false,
    openOnStartup: source.openOnStartup === true,
    autoSync: source.autoSync !== false,
    syncIntervalHours: [1, 6, 12, 24, 72].includes(interval) ? interval : 12,
    lastSyncAt: trimString(source.lastSyncAt),
    lastSyncSummary: trimString(source.lastSyncSummary),
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
/* Разбор страниц официальных сайтов                                   */
/* ------------------------------------------------------------------ */

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanText(value) {
  return decodeHtmlEntities(String(value))
    .replace(/\s+/g, ' ')
    .replace(/\s*[·|]\s*$/, '')
    .trim();
}

function stripHtml(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return match ? cleanText(match[1]) : '';
}

function isoFromDateValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) {
    const iso = `${match[1]}-${match[2]}-${match[3]}`;
    return isValidISODate(iso) ? iso : '';
  }

  const stamp = Date.parse(trimmed);
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp);
  return makeISO(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function composeJsonLdPlace(location) {
  if (!location) return '';
  if (typeof location === 'string') return cleanText(location);
  if (Array.isArray(location)) {
    for (const item of location) {
      const composed = composeJsonLdPlace(item);
      if (composed) return composed;
    }
    return '';
  }

  const parts = [];
  const regionName = typeof location.name === 'string' ? cleanText(location.name) : '';
  const address = location.address;

  if (address && typeof address === 'object') {
    if (typeof address.addressRegion === 'string' && address.addressRegion.trim()) {
      parts.push(cleanText(address.addressRegion));
    }
    if (regionName) parts.push(regionName);
    if (typeof address.addressLocality === 'string' && address.addressLocality.trim()) {
      parts.push(cleanText(address.addressLocality));
    } else if (typeof address.streetAddress === 'string' && address.streetAddress.trim()) {
      parts.push(cleanText(address.streetAddress));
    }
  } else if (typeof address === 'string' && address.trim()) {
    if (regionName) parts.push(regionName);
    parts.push(cleanText(address));
  } else if (regionName) {
    parts.push(regionName);
  }

  const unique = [];
  parts.forEach((part) => {
    if (part && !unique.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
      unique.push(part);
    }
  });
  return unique.join(' · ').slice(0, 190);
}

function isEventNode(node) {
  if (!node || typeof node !== 'object') return false;
  const type = node['@type'];
  const list = Array.isArray(type) ? type : [type];
  return list.some(
    (value) => typeof value === 'string' && /event$/i.test(value.trim()) && !/series$/i.test(value.trim()),
  );
}

function parseJsonLdEvents(html) {
  const events = [];
  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRe.exec(String(html || '')))) {
    const raw = match[1]
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\uFEFF/, '')
      .trim();
    if (!raw) continue;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      continue;
    }

    const queue = [data];
    const seen = new Set();
    let guard = 0;

    while (queue.length > 0 && guard < 200) {
      guard += 1;
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);

      if (Array.isArray(node)) {
        node.forEach((item) => queue.push(item));
        continue;
      }

      if (isEventNode(node)) {
        const start = isoFromDateValue(node.startDate);
        if (start) {
          events.push({
            name: cleanText(node.name || ''),
            start,
            end: isoFromDateValue(node.endDate),
            place: composeJsonLdPlace(node.location),
            url: typeof node.url === 'string' ? normalizeUrl(node.url) : '',
            method: 'json-ld',
            confidence: 0.96,
          });
        }
      }

      Object.keys(node).forEach((key) => {
        if (key === 'location' || key === 'address') return;
        const value = node[key];
        if (value && typeof value === 'object') queue.push(value);
      });
    }
  }

  return events;
}

function monthNumber(name) {
  return MONTHS_GENITIVE.indexOf(String(name).toLowerCase()) + 1;
}

/**
 * Ищет в тексте диапазоны дат в русском формате.
 * Возвращает [{ start, end, index, explicitYear }].
 */
function findDateRanges(text, referenceYear, nowDay) {
  const months = MONTHS_GENITIVE.join('|');
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const results = [];
  const consumed = [];

  function overlaps(start, end) {
    return consumed.some((range) => start < range.end && end > range.start);
  }

  function push(start, end, index, length, explicitYear, inferredNextYear) {
    if (!start) return;
    if (overlaps(index, index + length)) return;
    consumed.push({ start: index, end: index + length });
    results.push({
      start,
      end: end || start,
      index,
      explicitYear: !!explicitYear,
      // Дата без года, которую пришлось перенести на следующий год:
      // это лишь предположение, а не подтверждённое расписание.
      inferredNextYear: !!inferredNextYear,
    });
  }

  function inferYear(month, day) {
    const initial = makeISO(referenceYear, month, day);
    if (!initial) return { iso: '', year: referenceYear };
    if (parseISODate(initial).stamp < today - 45) {
      return { iso: makeISO(referenceYear + 1, month, day), year: referenceYear + 1 };
    }
    return { iso: initial, year: referenceYear };
  }

  // «28 февраля — 2 марта 2027»
  const crossMonthRe = new RegExp(
    `(\\d{1,2})\\s+(${months})\\s*[–—−-]\\s*(\\d{1,2})\\s+(${months})\\s+(\\d{4})`,
    'gi',
  );
  let match;
  while ((match = crossMonthRe.exec(text))) {
    const monthFrom = monthNumber(match[2]);
    const monthTo = monthNumber(match[4]);
    const yearTo = Number(match[5]);
    const yearFrom = monthTo < monthFrom ? yearTo - 1 : yearTo;
    push(
      makeISO(yearFrom, monthFrom, Number(match[1])),
      makeISO(yearTo, monthTo, Number(match[3])),
      match.index,
      match[0].length,
      true,
    );
  }

  // «с 3 по 5 июля 2025», «с 27 августа по 30 августа 2025»
  const fromToRe = new RegExp(
    `(?<![а-яёa-z])с\\s+(\\d{1,2})(?:\\s+(${months}))?(?:\\s+(\\d{4}))?\\s+по\\s+(\\d{1,2})\\s+(${months})(?:\\s+(\\d{4}))?`,
    'gi',
  );
  while ((match = fromToRe.exec(text))) {
    const monthTo = monthNumber(match[5]);
    const monthFrom = match[2] ? monthNumber(match[2]) : monthTo;
    const yearToRaw = match[6] ? Number(match[6]) : null;
    const yearFromRaw = match[3] ? Number(match[3]) : null;
    let yearFrom;
    let yearTo;

    if (yearFromRaw || yearToRaw) {
      yearFrom = yearFromRaw || yearToRaw;
      yearTo = yearToRaw || yearFromRaw;
      if (monthTo < monthFrom) {
        if (!yearFromRaw) yearFrom = yearTo - 1;
        else yearTo = yearFrom + 1;
      }
    } else {
      const inferred = inferYear(monthFrom, Number(match[1]));
      yearFrom = inferred.year;
      yearTo = monthTo < monthFrom ? yearFrom + 1 : yearFrom;
    }

    push(
      makeISO(yearFrom, monthFrom, Number(match[1])),
      makeISO(yearTo, monthTo, Number(match[4])),
      match.index,
      match[0].length,
      !!(match[3] || match[6]),
      !match[3] && !match[6] && yearFrom > referenceYear,
    );
  }

  // «16–18 июля 2026»
  const sameMonthRe = new RegExp(
    `(\\d{1,2})\\s*[–—−-]\\s*(\\d{1,2})\\s+(${months})\\s+(\\d{4})`,
    'gi',
  );
  while ((match = sameMonthRe.exec(text))) {
    const month = monthNumber(match[3]);
    const year = Number(match[4]);
    push(
      makeISO(year, month, Number(match[1])),
      makeISO(year, month, Number(match[2])),
      match.index,
      match[0].length,
      true,
    );
  }

  // «16–18 июля» без года — год выводим из контекста страницы.
  const sameMonthNoYearRe = new RegExp(
    `(\\d{1,2})\\s*[–—−-]\\s*(\\d{1,2})\\s+(${months})(?!\\s*\\d{4})`,
    'gi',
  );
  while ((match = sameMonthNoYearRe.exec(text))) {
    const month = monthNumber(match[3]);
    const inferred = inferYear(month, Number(match[1]));
    if (!inferred.iso) continue;
    push(
      inferred.iso,
      makeISO(inferred.year, month, Number(match[2])),
      match.index,
      match[0].length,
      false,
      inferred.year > referenceYear,
    );
  }

  // «16 июля 2026»
  const singleDayRe = new RegExp(`(\\d{1,2})\\s+(${months})\\s+(\\d{4})`, 'gi');
  while ((match = singleDayRe.exec(text))) {
    const month = monthNumber(match[2]);
    const year = Number(match[3]);
    const iso = makeISO(year, month, Number(match[1]));
    push(iso, iso, match.index, match[0].length, true);
  }

  return results.sort((a, b) => a.index - b.index);
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesTitle(text, title) {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(title);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;

  const words = needle
    .split(/[^a-zа-я0-9]+/i)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

  return words.some((word) => haystack.includes(word));
}

function normalizeRegionLabel(value) {
  return cleanText(value)
    .replace(/([А-ЯЁ][а-яё-]+)ой\s+области$/i, (_, stem) => `${stem}ая область`)
    .replace(/([А-ЯЁ][а-яё-]+)ом\s+крае$/i, (_, stem) => `${stem}ий край`)
    .replace(/([А-ЯЁ][а-яё-]+)ем\s+крае$/i, (_, stem) => `${stem}ий край`)
    .replace(/([А-ЯЁ][а-яё-]+)ой\s+области$/i, (_, stem) => `${stem}ая область`);
}

function cleanVenueLabel(value) {
  let venue = cleanText(value);
  const closeQuote = venue.indexOf('»');
  if (closeQuote >= 0) venue = venue.slice(0, closeQuote + 1);

  venue = venue.replace(
    /\s+(?:пройдёт|пройдет|пройдут|состоится|состоятся|будет|проходит|пройдет)\b[\s\S]*$/i,
    '',
  );
  venue = venue.replace(/[\s,;:-]+$/, '');

  if (!venue.includes('«') && venue.endsWith('»')) {
    venue = venue.slice(0, -1).trim();
  }
  return venue;
}

function extractPlaceNear(text, index) {
  const around = text.slice(Math.max(0, index - 350), Math.min(text.length, index + 450));
  const parts = [];

  const region =
    /([А-ЯЁ][а-яё-]+\s+(?:край|крае|края|область|области)|Республика\s+[А-ЯЁ][а-яё-]+)/.exec(
      around,
    );
  if (region) parts.push(normalizeRegionLabel(region[1]));

  const venue =
    /((?:МВК|МВЦ|КВЦ|Экспоцентр|ЭКСПО|конгресс-?центр|выставочный (?:центр|комплекс)|Сибирский агропарк|агропарк|учхоз|КФХ)\s*[^.;:\n]{0,70})/i.exec(
      around,
    );

  if (venue) {
    const cleaned = cleanVenueLabel(venue[1]);
    if (cleaned) parts.push(cleaned);
  } else {
    const city = /(?:г\.\s*|город\s+)([А-ЯЁ][а-яё-]+(?:-[А-ЯЁ][а-яё-]+)?)/.exec(around);
    if (city) parts.push(cleanText(city[1]));
  }

  const unique = [];
  parts.forEach((part) => {
    if (part && !unique.some((existing) => existing.toLowerCase() === part.toLowerCase())) {
      unique.push(part);
    }
  });

  return unique.join(' · ').slice(0, 190);
}

function extractReferenceYear(html, text, nowDay) {
  const head = `${extractTitle(html)} ${text.slice(0, 1500)}`;
  const match = /\b(20\d{2})\b/.exec(head);
  if (match) return Number(match[1]);
  return new Date(nowDay * 86400000).getUTCFullYear();
}

/**
 * Явная пометка «даты уточняются» рядом с найденным диапазоном.
 * В этом случае дата сохраняется как предварительная, без точного счётчика.
 */
function mentionsTentativeDate(text) {
  const value = String(text || '');
  return (
    /(?:даты|дата|сроки)[^.!?]{0,60}(?:уточняются|уточняется|уточнят|уточним|не объявлен|не определ[её]н|неизвестн|будут объявлен|будет объявлен|станут известн|будут известн)/i.test(
      value,
    ) ||
    /(?:предварительн|ориентировочн)[^.!?]{0,50}(?:дата|даты|сроки|проведен)/i.test(value) ||
    /\b(?:TBD|to be announced)\b/i.test(value)
  );
}

/**
 * Разбирает страницу мероприятия и возвращает кандидатов на дату/место.
 */
function parseEventPage(html, options) {
  const opts = options || {};
  const title = opts.title || '';
  const nowDay = Number.isFinite(opts.nowDay) ? opts.nowDay : todayDayNumber();
  const sourceUrl = normalizeUrl(opts.sourceUrl || '');
  const text = stripHtml(html);
  const referenceYear = extractReferenceYear(html, text, nowDay);
  const candidates = [];

  parseJsonLdEvents(html).forEach((item) => {
    candidates.push(Object.assign({}, item, { sourceUrl, tentative: false }));
  });

  findDateRanges(text, referenceYear, nowDay).forEach((range) => {
    const windowStart = Math.max(0, range.index - 320);
    const windowEnd = Math.min(text.length, range.index + 420);
    const around = text.slice(windowStart, windowEnd);
    const place = extractPlaceNear(text, range.index);
    const state = editionState({ start: range.start, end: range.end }, nowDay);

    let confidence = range.explicitYear ? 0.55 : 0.45;
    if (matchesTitle(around, title)) confidence += 0.15;
    if (place) confidence += 0.2;
    if (state.kind === 'upcoming' || state.kind === 'ongoing') confidence += 0.1;
    confidence = Math.min(confidence, 0.85);

    if (confidence >= 0.6) {
      candidates.push({
        start: range.start,
        end: range.end,
        place,
        name: '',
        method: 'text',
        confidence,
        sourceUrl,
        tentative: range.inferredNextYear || mentionsTentativeDate(around),
      });
    }
  });

  candidates.sort((a, b) => b.confidence - a.confidence);
  return { candidates, pageTitle: extractTitle(html), referenceYear, textLength: text.length };
}

/**
 * Выбирает кандидата на предстоящее проведение: только будущее/текущее,
 * не дальше двух лет, с максимальной уверенностью.
 */
function pickSyncCandidate(candidates, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const acceptable = [];

  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    if (!candidate || !isValidISODate(candidate.start)) return;
    const state = editionState({ start: candidate.start, end: candidate.end }, today);
    if (state.kind !== 'upcoming' && state.kind !== 'ongoing') return;
    if (Number.isFinite(state.days) && state.days > 730) return;
    acceptable.push(Object.assign({}, candidate, { state }));
  });

  acceptable.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.state.startDay - b.state.startDay ||
      String(a.place).length - String(b.place).length,
  );

  const seen = new Set();
  for (const candidate of acceptable) {
    const key = `${candidate.start}|${candidate.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    return candidate;
  }

  return null;
}

/**
 * Прошедшие проведения, которые нужны для строки «Прошлый раз»:
 * только текущий и прошлый год. Более старые даты не импортируются.
 */
function pickPastSyncCandidates(candidates, nowDay) {
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const currentYear = yearFromDay(today);
  const minYear = currentYear - 1;
  const acceptable = [];
  const seen = new Set();

  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    if (!candidate || !isValidISODate(candidate.start)) return;
    const parsed = parseISODate(candidate.start);
    if (!parsed || parsed.year < minYear) return;
    const state = editionState({ start: candidate.start, end: candidate.end }, today);
    if (state.kind !== 'past') return;
    const key = `${candidate.start}|${candidate.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    acceptable.push(Object.assign({}, candidate, { state }));
  });

  acceptable.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.state.startDay - a.state.startDay ||
      String(a.place).length - String(b.place).length,
  );
  return acceptable;
}

/**
 * Применяет найденного кандидата к событию.
 * Ручное предстоящее проведение не перезаписывается — фиксируется конфликт.
 */
function applySyncCandidate(event, candidate, nowISO, nowDay, options) {
  const opts = options || {};
  const today = Number.isFinite(nowDay) ? nowDay : todayDayNumber();
  const result = { event: cloneData(event), action: 'none', conflict: '' };
  const target = result.event;
  if (!Array.isArray(target.editions)) target.editions = [];

  if (!candidate || !isValidISODate(candidate.start)) return result;

  const targetState = editionState({ start: candidate.start, end: candidate.end }, today);
  const isFuture = targetState.kind === 'upcoming' || targetState.kind === 'ongoing';
  // Прошедшие даты нужны только для «Прошлого раза»; обычный синк их не добавляет.
  if (targetState.kind === 'past' && !opts.allowPast) return result;

  if (!editionAllowedInRegions({ place: candidate.place }, target)) {
    result.skipped = 'region';
    return result;
  }

  const same = target.editions.find((edition) => edition.start === candidate.start);
  if (same) {
    let changed = false;
    if (candidate.end && !same.end) {
      same.end = candidate.end;
      changed = true;
    }
    if (candidate.place && !same.place) {
      same.place = candidate.place;
      changed = true;
    }
    if (candidate.sourceUrl && !same.sourceUrl) {
      same.sourceUrl = candidate.sourceUrl;
      changed = true;
    }
    if (
      same.source !== 'manual' &&
      typeof candidate.tentative === 'boolean' &&
      same.tentative !== candidate.tentative
    ) {
      same.tentative = candidate.tentative;
      changed = true;
    }
    same.checkedAt = nowISO;
    if (changed && same.source !== 'manual') same.source = 'auto';
    result.action = changed ? 'updated' : 'confirmed';
    return result;
  }

  if (isFuture) {
    const upcoming = target.editions.filter((edition) => {
      const state = editionState(edition, today);
      return state.kind === 'upcoming' || state.kind === 'ongoing';
    });
    const manualUpcoming = upcoming.find((edition) => edition.source !== 'auto');

    if (manualUpcoming) {
      result.action = 'conflict';
      result.conflict =
        `На сайте: ${formatRangeRu(candidate.start, candidate.end)}` +
        (candidate.place ? ` · ${candidate.place}` : '');
      return result;
    }

    target.editions = target.editions.filter((edition) => {
      const state = editionState(edition, today);
      const futureTentative = state.kind === 'tentative' && state.startDay !== null;
      return !(
        edition.source === 'auto' &&
        (state.kind === 'upcoming' || state.kind === 'ongoing' || futureTentative)
      );
    });
  }

  const edition = normalizeEdition({
    start: candidate.start,
    end: candidate.end,
    place: candidate.place,
    source: 'auto',
    sourceUrl: candidate.sourceUrl,
    checkedAt: nowISO,
    tentative: candidate.tentative === true,
  });

  if (edition) target.editions.push(edition);
  target.editions = dedupeEditions(target.editions);
  if (isFuture) target.expectedMonth = candidate.start.slice(0, 7);
  result.action = 'added';
  return result;
}

function syncErrorMessage(error) {
  const message = error && error.message ? error.message : String(error || 'ошибка');
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

/**
 * Обновляет одно событие по списку источников.
 * fetcher(url) → Promise<string|{text}> — внедряется для тестов.
 */
async function syncEventWithFetcher(event, fetcher, options) {
  const opts = options || {};
  const nowDay = Number.isFinite(opts.nowDay) ? opts.nowDay : todayDayNumber();
  const nowISO = opts.nowISO || new Date().toISOString();
  const working = cloneData(event);
  const sources = working.sync && Array.isArray(working.sync.sources) ? working.sync.sources.slice(0, 3) : [];
  const candidates = [];
  const errors = [];

  for (const sourceUrl of sources) {
    try {
      const response = await fetcher(sourceUrl);
      const html = typeof response === 'string' ? response : (response && response.text) || '';
      if (!html) throw new Error('пустой ответ');
      const parsed = parseEventPage(html, {
        title: working.title,
        nowDay,
        sourceUrl,
      });
      candidates.push(...parsed.candidates);
    } catch (error) {
      errors.push(`${sourceUrl}: ${syncErrorMessage(error)}`);
    }
  }

  const best = pickSyncCandidate(candidates, nowDay);
  const pastCandidates = pickPastSyncCandidates(candidates, nowDay);
  const result = {
    event: working,
    action: 'none',
    candidate: best,
    errors,
    message: '',
  };

  working.sync = Object.assign({}, working.sync, {
    lastSync: nowISO,
    lastError: errors.join('; '),
  });

  if (!best && pastCandidates.length === 0) {
    working.sync.lastResult = '';
    result.message = errors.length > 0 ? 'Не удалось получить данные' : 'Даты не найдены';
    return result;
  }

  let updated = working;
  let applied = null;

  if (best) {
    applied = applySyncCandidate(working, best, nowISO, nowDay);
    updated = applied.event;

    if (applied.skipped === 'region') {
      updated.sync = Object.assign({}, working.sync, { lastResult: '' });
      result.event = updated;
      result.skipped = 'region';
      result.message = 'Дата вне разрешённых регионов';
      return result;
    }
  }

  // Прошедшие проведения текущего и прошлого года нужны только для «Прошлого раза».
  let historyAdded = 0;
  let historyUpdated = 0;
  pastCandidates.forEach((candidate) => {
    const history = applySyncCandidate(updated, candidate, nowISO, nowDay, { allowPast: true });
    updated = history.event;
    if (history.action === 'added') historyAdded += 1;
    if (history.action === 'updated') historyUpdated += 1;
  });

  if (applied) {
    updated.sync = Object.assign({}, working.sync, {
      lastError: applied.conflict ? '' : errors.join('; '),
      lastResult:
        applied.conflict ||
        `${formatRangeRu(best.start, best.end)}${best.place ? ` · ${best.place}` : ''}`,
    });
    result.event = updated;
    result.action = applied.action;
    const historyNote =
      historyAdded > 0
        ? ` · история: ${historyAdded}`
        : historyUpdated > 0
          ? ' · история уточнена'
          : '';
    result.message = (applied.conflict || describeSyncAction(applied.action, best)) + historyNote;
    return result;
  }

  updated.sync = Object.assign({}, working.sync, { lastResult: '' });
  result.event = updated;

  if (historyAdded > 0) {
    const first = pastCandidates[0];
    result.action = 'added';
    result.message =
      `В истории найдено: ${formatRangeRu(first.start, first.end)}` +
      (first.place ? ` · ${first.place}` : '');
  } else if (historyUpdated > 0) {
    result.action = 'updated';
    result.message = 'История уточнена';
  } else {
    result.message = 'Даты не найдены';
  }
  return result;
}

function describeSyncAction(action, candidate) {
  const range = formatRangeRu(candidate.start, candidate.end);
  const place = candidate.place ? ` · ${candidate.place}` : '';
  if (candidate && candidate.tentative) {
    if (action === 'added') return `Ориентир: ${range}${place}`;
    if (action === 'updated') return `Ориентир уточнён: ${range}${place}`;
    return `Без изменений: ${range}${place}`;
  }
  if (action === 'added') return `Найдено: ${range}${place}`;
  if (action === 'updated') return `Уточнено: ${range}${place}`;
  if (action === 'confirmed') return `Без изменений: ${range}${place}`;
  return 'Без изменений';
}

function summarizeSyncResults(results) {
  const list = Array.isArray(results) ? results : [];
  const added = list.filter((item) => item.action === 'added').length;
  const updated = list.filter((item) => item.action === 'updated').length;
  const conflicts = list.filter((item) => item.action === 'conflict').length;
  const skipped = list.filter((item) => item.skipped === 'region').length;
  const failed = list.filter((item) => item.errors && item.errors.length > 0 && item.action === 'none').length;
  const parts = [];
  if (added) parts.push(`новых дат: ${added}`);
  if (updated) parts.push(`уточнено: ${updated}`);
  if (conflicts) parts.push(`расхождений с сайтом: ${conflicts}`);
  if (skipped) parts.push(`вне разрешённых регионов: ${skipped}`);
  if (failed) parts.push(`не удалось проверить: ${failed}`);
  return parts.length > 0 ? `Обновление завершено — ${parts.join(', ')}` : 'Обновление завершено — изменений нет';
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
          if (Number.isFinite(limit) && limit >= 0) options.limit = limit;
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

/**
 * Разбирает CSS-цвет в {r, g, b, a}. Понимает #rgb/#rrggbb, rgb()/rgba()
 * и color(srgb ...), которые может вернуть getComputedStyle.
 * Возвращает null, если цвет задан в неподдерживаемом формате.
 */
function parseCssColor(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'transparent' || text === 'none') return null;

  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((char) => char + char)
        .join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }

  match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (match) {
    const parts = match[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) =>
      part.endsWith('%') ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part);
    const alpha = (part) => {
      if (part === undefined) return 1;
      const number = part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 1;
    };
    const color = {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: alpha(parts[3]),
    };
    return [color.r, color.g, color.b].every(Number.isFinite) ? color : null;
  }

  match = /^color\(srgb\s+([^)]+)\)$/.exec(text);
  if (match) {
    const parts = match[1].split(/[\s\/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part) => {
      const value = Number.parseFloat(part);
      const normalized = part.endsWith('%') ? value / 100 : value;
      return Math.min(1, Math.max(0, normalized)) * 255;
    };
    const alpha = (part) => {
      if (part === undefined) return 1;
      const value = Number.parseFloat(part);
      return part.endsWith('%') ? value / 100 : value;
    };
    const color = {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: Number.isFinite(alpha(parts[3])) ? Math.min(1, Math.max(0, alpha(parts[3]))) : 1,
    };
    return [color.r, color.g, color.b].every(Number.isFinite) ? color : null;
  }

  return null;
}

/** Относительная яркость цвета по WCAG. */
function relativeLuminance(color) {
  const channel = (value) => {
    const normalized = Math.min(1, Math.max(0, value / 255));
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * Возвращает почти чёрный или белый цвет — тот, что контрастнее на фоне.
 * Пустая строка означает «фон неизвестен, оставляем цвета темы».
 */
function readableTextColor(background) {
  const color = parseCssColor(background);
  if (!color || color.a < 0.95) return '';
  const luminance = relativeLuminance(color);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithBlack >= contrastWithWhite ? '#111111' : '#ffffff';
}

/**
 * Идущая карточка получает зелёный фон. Подбираем к нему цвет текста
 * по фактическому фону, чтобы он оставался читаемым в любой теме.
 */
function applyReadableCardText(card) {
  if (!card || card.dataset.state !== 'ongoing') return '';
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return '';
  const computed = window.getComputedStyle(card);
  const fg = readableTextColor(computed && computed.backgroundColor);
  if (!fg) return '';
  card.style.setProperty('--ct-fg', fg);
  card.style.setProperty(
    '--ct-fg-muted',
    fg === '#ffffff' ? 'rgba(255, 255, 255, 0.82)' : 'rgba(17, 17, 17, 0.78)',
  );
  return fg;
}

function addIconButton(parent, iconName, label, onClick) {
  const button = createElSafe('button', 'ct-icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  try {
    setIcon(button, iconName);
  } catch (error) {
    /* старые версии Obsidian могут не знать иконку */
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

function createMetaRow(iconName, text, className) {
  const row = createElSafe('div', `ct-meta${className ? ` ${className}` : ''}`);
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
  return 'Ближайшее событие';
}

function renderHero(parent, item) {
  const edition = item.display;
  const state = item.displayState;
  const event = item.event;
  if (!edition || !state) return;

  const hero = createElSafe('div', 'ct-hero');
  hero.dataset.state = state.kind;
  hero.dataset.category = event.category || 'Другое';

  hero.appendChild(createElSafe('div', 'ct-hero-label', heroLabel(state)));
  hero.appendChild(createElSafe('div', 'ct-hero-title', event.title));

  const count = createElSafe('div', 'ct-hero-count');
  if (state.kind === 'upcoming') {
    count.appendChild(createElSafe('span', 'ct-hero-num', String(state.days)));
    count.appendChild(createElSafe('span', 'ct-hero-unit', pluralRu(state.days, ['день', 'дня', 'дней'])));
    count.appendChild(createElSafe('span', 'ct-hero-unit-note', 'до начала'));
  } else if (state.kind === 'ongoing') {
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
      count.appendChild(
        createElSafe('span', 'ct-hero-unit-note', state.lastDay ? 'последний день' : 'день события'),
      );
    }
  }
  hero.appendChild(count);

  hero.appendChild(createElSafe('div', 'ct-hero-date', formatRangeRu(edition.start, edition.end)));
  hero.appendChild(
    createElSafe('div', 'ct-hero-place', edition.place || 'Место уточняется'),
  );

  parent.appendChild(hero);
}

/**
 * Плейсхолдер вместо крупного блока, пока с сайтов не загружены даты.
 * Даты и места не хранятся в коде, поэтому первый запуск начинается с этой карточки.
 */
function renderHeroPlaceholder(parent, plugin, options) {
  const opts = options || {};
  const knownDates = !!opts.tentativeOnly;
  const hero = createElSafe('div', 'ct-hero');
  hero.dataset.state = 'tentative';
  hero.dataset.category = 'Другое';

  hero.appendChild(createElSafe('div', 'ct-hero-label', 'Даты и места'));
  hero.appendChild(
    createElSafe(
      'div',
      'ct-hero-title',
      knownDates ? 'Следующие даты уточняются' : 'Загрузка с официальных сайтов',
    ),
  );

  const count = createElSafe('div', 'ct-hero-count');
  count.appendChild(createElSafe('span', 'ct-hero-text', 'Дата уточняется'));
  hero.appendChild(count);

  hero.appendChild(
    createElSafe(
      'div',
      'ct-hero-date',
      knownDates
        ? opts.hint || 'Организаторы ещё не объявили точные даты.'
        : 'Плагин читает страницы событий и заполняет даты сам.',
    ),
  );
  hero.appendChild(
    createElSafe(
      'div',
      'ct-hero-place',
      knownDates
        ? 'Точная дата не считается известной, пока её не подтвердит сайт.'
        : 'Если сайт недоступен, дату можно вписать вручную.',
    ),
  );

  if (typeof plugin.syncAll === 'function') {
    const action = createElSafe('div', 'ct-hero-action');
    const button = createElSafe('button', 'ct-primary-btn', 'Обновить');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Обновляем…';
      try {
        await plugin.syncAll({ notify: true });
      } finally {
        button.disabled = false;
        button.textContent = 'Обновить';
      }
    });
    action.appendChild(button);
    hero.appendChild(action);
  }

  parent.appendChild(hero);
}

function renderBadge(state) {
  const badge = createElSafe('span', 'ct-badge', state ? formatCountdown(state) : 'Дата уточняется');
  badge.dataset.state = state ? state.kind : 'tentative';
  return badge;
}

function renderHistoryDetails(parent, item, compact) {
  const history = item.history || [];
  if (compact || history.length < 2) return;

  const details = createElSafe('details', 'ct-history');
  const summary = createElSafe('summary', 'ct-history-summary');
  summary.textContent = `История проведений · ${history.length}`;
  details.appendChild(summary);

  const list = createElSafe('div', 'ct-history-list');
  history.forEach((edition) => {
    const row = createElSafe('div', 'ct-history-item');
    const date = createElSafe('span', 'ct-history-date', formatRangeRu(edition.start, edition.end));
    row.appendChild(date);
    if (edition.place) {
      row.appendChild(createElSafe('span', 'ct-history-place', edition.place));
    }
    list.appendChild(row);
  });
  details.appendChild(list);
  parent.appendChild(details);
}

function renderCard(parent, item, context) {
  const event = item.event;
  const edition = item.display;
  const state = item.displayState;
  const card = createElSafe('div', 'ct-card');
  card.dataset.state = state ? state.kind : 'tentative';
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

  const dateText = edition
    ? formatRangeRu(edition.start, edition.end)
    : event.expectedMonth
      ? `Ориентир: ${formatMonthRu(event.expectedMonth)}`
      : item.tentativeEdition
        ? `Ориентир: ${formatMonthRu(String(item.tentativeEdition.start).slice(0, 7))}`
        : 'Дата не указана';
  body.appendChild(createMetaRow('calendar-days', dateText));

  const placeText = edition && edition.place ? edition.place : 'Место уточняется';
  body.appendChild(createMetaRow('map-pin', placeText, edition && edition.place ? '' : 'ct-meta--muted'));

  if (item.lastPast && item.lastPast !== edition) {
    const past = item.lastPast;
    const pastText =
      `${formatRangeRu(past.start, past.end)}` + (past.place ? ` · ${past.place}` : '');
    const row = createMetaRow('history', `Прошлый раз: ${pastText}`, 'ct-meta--past');
    body.appendChild(row);
  } else if (!edition && event.historyNote) {
    body.appendChild(createMetaRow('history', `Прошлый раз: ${event.historyNote}`, 'ct-meta--past'));
  }

  if (event.sync && event.sync.lastResult && event.sync.lastResult.startsWith('На сайте:')) {
    body.appendChild(
      createElSafe('div', 'ct-sync-conflict', event.sync.lastResult),
    );
  }

  if (event.note && !context.compact) {
    body.appendChild(createElSafe('div', 'ct-card-note', event.note));
  }

  renderHistoryDetails(body, item, context.compact);

  const footer = createElSafe('div', 'ct-card-foot');
  footer.appendChild(createElSafe('span', 'ct-chip', event.category || 'Другое'));

  if (edition && edition.source === 'auto') {
    const autoChip = createElSafe('span', 'ct-chip ct-chip--auto', 'авто');
    const checked = edition.checkedAt ? ` ${formatDateTimeRu(edition.checkedAt)}` : '';
    autoChip.title = `Дата и место получены с сайта${checked}`;
    footer.appendChild(autoChip);
  }

  if (event.url) {
    const link = createElSafe('a', 'ct-link', 'Сайт ↗');
    link.href = event.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    footer.appendChild(link);
  }

  if (!context.compact && event.sync && event.sync.lastSync) {
    const status = createElSafe('span', 'ct-previous');
    if (event.sync.lastError && !event.sync.lastResult) {
      status.textContent = 'Авто: ошибка';
      status.classList.add('ct-sync-error');
      status.title = event.sync.lastError;
    } else {
      status.textContent = `Проверено ${formatDateTimeRu(event.sync.lastSync).slice(0, 10)}`;
      if (event.sync.lastResult) status.title = event.sync.lastResult;
    }
    footer.appendChild(status);
  }

  body.appendChild(footer);

  if (context.canEdit) {
    const actions = createElSafe('div', 'ct-card-actions');
    if (typeof context.onSync === 'function' && event.sync && event.sync.enabled && event.sync.sources.length > 0) {
      addIconButton(actions, 'refresh-cw', 'Проверить даты на сайте', () => context.onSync(event));
    }
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
      const allItems = buildItems(events, 'upcoming', settings, nowDay);
      const heroItem = pickHero(allItems);
      if (heroItem && heroItem.displayState.kind === 'upcoming') {
        subtitleParts.push(
          `ближайшее через ${heroItem.displayState.days} ${pluralRu(heroItem.displayState.days, [
            'день',
            'дня',
            'дней',
          ])}`,
        );
      } else if (heroItem && heroItem.displayState.kind === 'ongoing') {
        subtitleParts.push('одно идёт сейчас');
      }
      textBlock.appendChild(createElSafe('div', 'ct-subtitle', subtitleParts.join(' · ')));
      header.appendChild(textBlock);

      const actions = createElSafe('div', 'ct-header-actions');
      addIconButton(actions, 'plus', 'Добавить событие', () => plugin.openEventModal());
      if (typeof plugin.syncAll === 'function') {
        addIconButton(actions, 'refresh-cw', 'Обновить даты с сайтов', () => plugin.syncAll({ notify: true }));
      }
      header.appendChild(actions);
      root.appendChild(header);
    }

    if (opts.showFilters) {
      renderTabs(root, state.view, events, settings, nowDay, (mode) => {
        state.view = mode;
        draw();
      });
    }

    let items = buildItems(events, state.view, settings, nowDay);
    if (state.limit > 0) items = items.slice(0, state.limit);

    if (showHero && state.view !== 'past') {
      const heroPool =
        items.length > 0 ? items : buildItems(events, 'upcoming', settings, nowDay);
      const heroItem = pickHero(heroPool);
      if (heroItem) {
        renderHero(root, heroItem);
      } else if (
        items.length > 0 &&
        items.every((item) => !item.displayState || item.displayState.kind === 'tentative')
      ) {
        const hasContext = items.some(
          (item) => item.event.editions.length > 0 || item.event.expectedMonth,
        );
        const months = Array.from(
          new Set(items.map((item) => item.event.expectedMonth).filter(Boolean)),
        ).slice(0, 3);
        renderHeroPlaceholder(root, plugin, {
          tentativeOnly: hasContext,
          hint: months.length
            ? `Ориентир: ${months.map((month) => formatMonthRu(month)).join(' · ')}`
            : '',
        });
      }
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
          onSync:
            typeof plugin.syncEventById === 'function'
              ? (event) => plugin.syncEventById(event.id, true)
              : null,
        });
      });
      root.appendChild(list);
    });

    // Карточки уже в документе — можно измерить фактический фон
    // и подобрать к нему читаемый цвет текста.
    root.querySelectorAll('.ct-card[data-state="ongoing"]').forEach(applyReadableCardText);
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
      .addButton((button) => button.setButtonText('Отмена').onClick(() => this.close()))
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

function createDateInput(value, label, onChange) {
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'ct-input-date';
  input.value = value || '';
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => onChange(input.value));
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function createTextInput(value, placeholder, label, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ct-input-text';
  input.value = value || '';
  input.placeholder = placeholder || '';
  if (label) input.setAttribute('aria-label', label);
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

class EventModal extends Modal {
  constructor(app, plugin, event) {
    super(app);
    this.plugin = plugin;
    this.event = event || null;
    const source = event || {};

    this.draft = {
      id: source.id || '',
      title: source.title || '',
      fullTitle: source.fullTitle || '',
      category: source.category || 'Конференция',
      url: source.url || '',
      note: source.note || '',
      expectedMonth: source.expectedMonth || '',
      regions: Array.isArray(source.regions) ? source.regions.slice() : [],
      historyNote: source.historyNote || '',
      sync: source.sync ? cloneData(source.sync) : { enabled: true, sources: [] },
    };

    this.nextEdition = null;
    this.tentativeEdition = null;
    this.history = [];
    this.tentative = false;
    this.nextStart = '';
    this.nextEnd = '';
    this.nextPlace = '';
    this.syncEnabled = this.draft.sync.enabled !== false;
    this.syncSourcesText = (this.draft.sync.sources || []).join('\n');

    if (event) {
      const today = todayDayNumber();
      const nearest = getNearestEdition(event, today);
      if (nearest) {
        this.nextEdition = cloneData(nearest);
        this.nextStart = nearest.start;
        this.nextEnd = nearest.end || '';
        this.nextPlace = nearest.place || '';
      }
      this.tentative = !nearest;
      if (!nearest) {
        const tentative = getTentativeEdition(event, today);
        if (tentative) {
          this.tentativeEdition = cloneData(tentative);
          if (!this.draft.expectedMonth) {
            this.draft.expectedMonth = String(tentative.start).slice(0, 7);
          }
        }
      }
      this.history = sortedEditions(event)
        .filter((edition) => !nearest || edition.start !== nearest.start)
        .filter(
          (edition) => !this.tentativeEdition || edition.start !== this.tentativeEdition.start,
        )
        .map((edition) => cloneData(edition));
    } else {
      this.tentative = false;
    }

    this.errorsEl = null;
    this.dateFields = null;
    this.expectedFields = null;
    this.historyListEl = null;
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

    new Setting(content)
      .setName('Название')
      .setDesc('Так событие будет называться в виджете.')
      .addText((text) => {
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
      .setDesc('Включите, если точные даты следующего проведения ещё не объявлены.')
      .addToggle((toggle) =>
        toggle.setValue(!!this.tentative).onChange((value) => {
          this.tentative = value;
          this.syncVisibility();
        }),
      );

    this.dateFields = createElSafe('div', 'ct-modal-section');
    content.appendChild(this.dateFields);

    new Setting(this.dateFields).setName('Дата начала').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.nextStart || '').onChange((value) => {
        this.nextStart = value;
      });
    });

    new Setting(this.dateFields).setName('Дата окончания').addText((text) => {
      text.inputEl.type = 'date';
      text.setValue(this.nextEnd || '').onChange((value) => {
        this.nextEnd = value;
      });
    });

    new Setting(this.dateFields)
      .setName('Место проведения')
      .setDesc('Город или регион · площадка.')
      .addText((text) => {
        text
          .setPlaceholder('Например, Алтайский край · Сибирский агропарк')
          .setValue(this.nextPlace || '')
          .onChange((value) => {
            this.nextPlace = value;
          });
        text.inputEl.classList.add('ct-input-wide');
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

    const historyHeading = createElSafe('div', 'ct-modal-heading');
    historyHeading.textContent = 'История проведений';
    content.appendChild(historyHeading);
    content.appendChild(
      createElSafe(
        'div',
        'ct-modal-hint',
        'Даты и места прошлых лет. Именно они показываются в карточке как «Прошлый раз».',
      ),
    );

    this.historyListEl = createElSafe('div', 'ct-history-editor');
    content.appendChild(this.historyListEl);

    const addHistoryButton = createElSafe('button', 'ct-secondary-btn', '+ Добавить проведение');
    addHistoryButton.type = 'button';
    addHistoryButton.addEventListener('click', () => {
      this.history.push({ start: '', end: '', place: '', source: 'manual' });
      this.renderHistoryRows();
    });
    content.appendChild(addHistoryButton);

    const syncHeading = createElSafe('div', 'ct-modal-heading');
    syncHeading.textContent = 'Автообновление';
    content.appendChild(syncHeading);

    new Setting(content)
      .setName('Искать даты на официальном сайте')
      .setDesc('Плагин читает страницу и обновляет предстоящее проведение, не затирая ручные правки.')
      .addToggle((toggle) =>
        toggle.setValue(!!this.syncEnabled).onChange((value) => {
          this.syncEnabled = value;
        }),
      );

    new Setting(content)
      .setName('Источники')
      .setDesc('По одному адресу в строке. Пусто — используется адрес из поля «Сайт».')
      .addTextArea((text) => {
        text
          .setPlaceholder('https://example.ru/')
          .setValue(this.syncSourcesText)
          .onChange((value) => {
            this.syncSourcesText = value;
          });
        text.inputEl.rows = 2;
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

    this.renderHistoryRows();
    this.syncVisibility();
  }

  renderHistoryRows() {
    if (!this.historyListEl) return;
    clearNode(this.historyListEl);

    if (this.history.length === 0) {
      this.historyListEl.appendChild(
        createElSafe('div', 'ct-history-empty', 'Проведений пока нет — добавьте прошлые годы.'),
      );
      return;
    }

    this.history.forEach((row, index) => {
      const wrapper = createElSafe('div', 'ct-history-row');

      wrapper.appendChild(
        createDateInput(row.start, 'Дата начала', (value) => {
          this.history[index].start = value;
        }),
      );
      wrapper.appendChild(
        createDateInput(row.end, 'Дата окончания', (value) => {
          this.history[index].end = value;
        }),
      );
      wrapper.appendChild(
        createTextInput(row.place || '', 'Место проведения', 'Место проведения', (value) => {
          this.history[index].place = value;
        }),
      );

      const remove = createElSafe('button', 'ct-icon-btn', '');
      remove.type = 'button';
      remove.title = 'Удалить проведение';
      remove.setAttribute('aria-label', 'Удалить проведение');
      try {
        setIcon(remove, 'trash-2');
      } catch (error) {
        remove.textContent = '×';
      }
      remove.addEventListener('click', () => {
        this.history.splice(index, 1);
        this.renderHistoryRows();
      });
      wrapper.appendChild(remove);

      this.historyListEl.appendChild(wrapper);
    });
  }

  syncVisibility() {
    if (this.dateFields) this.dateFields.style.display = this.tentative ? 'none' : '';
    if (this.expectedFields) this.expectedFields.style.display = this.tentative ? '' : 'none';
  }

  validate() {
    const errors = [];
    if (!trimString(this.draft.title)) {
      errors.push('Укажите название события.');
    }

    if (this.tentative) {
      if (this.draft.expectedMonth && !parseMonth(this.draft.expectedMonth)) {
        errors.push('Ориентировочный месяц должен быть в формате ГГГГ-ММ.');
      }
    } else {
      if (!this.nextStart) {
        errors.push('Укажите дату начала или включите «Дата уточняется».');
      } else if (!isValidISODate(this.nextStart)) {
        errors.push('Дата начала должна быть в формате ГГГГ-ММ-ДД.');
      }
      if (this.nextEnd) {
        if (!isValidISODate(this.nextEnd)) {
          errors.push('Дата окончания должна быть в формате ГГГГ-ММ-ДД.');
        } else if (
          isValidISODate(this.nextStart) &&
          parseISODate(this.nextEnd).stamp < parseISODate(this.nextStart).stamp
        ) {
          errors.push('Дата окончания не может быть раньше даты начала.');
        }
      }
      if (
        this.nextPlace &&
        !editionAllowedInRegions({ place: this.nextPlace }, this.draft)
      ) {
        errors.push(
          `Место вне разрешённых регионов: ${this.draft.regions.join(', ')}.`,
        );
      }
    }

    const seen = new Set(this.nextStart ? [this.nextStart] : []);
    this.history.forEach((row, index) => {
      if (!row.start && !row.end && !trimString(row.place)) return;
      if (!row.start) {
        errors.push(`Прошлое проведение №${index + 1}: укажите дату начала.`);
        return;
      }
      if (!isValidISODate(row.start)) {
        errors.push(`Прошлое проведение №${index + 1}: неверная дата начала.`);
        return;
      }
      if (row.end && !isValidISODate(row.end)) {
        errors.push(`Прошлое проведение №${index + 1}: неверная дата окончания.`);
      } else if (row.end && parseISODate(row.end).stamp < parseISODate(row.start).stamp) {
        errors.push(`Прошлое проведение №${index + 1}: окончание раньше начала.`);
      }
      if (seen.has(row.start)) {
        errors.push(`Прошлое проведение №${index + 1}: дата ${row.start} уже указана.`);
      }
      if (row.place && !editionAllowedInRegions({ place: row.place }, this.draft)) {
        errors.push(
          `Прошлое проведение №${index + 1}: место вне разрешённых регионов (${this.draft.regions.join(', ')}).`,
        );
      }
      seen.add(row.start);
    });

    return errors;
  }

  buildEditions() {
    const editions = [];

    this.history.forEach((row) => {
      if (!row.start) return;
      const edition = normalizeEdition(
        Object.assign({}, row, {
          source: row.source === 'auto' ? 'auto' : 'manual',
        }),
      );
      if (edition) editions.push(edition);
    });

    if (this.tentative && this.tentativeEdition) {
      const edition = normalizeEdition(
        Object.assign({}, this.tentativeEdition, { tentative: true }),
      );
      if (edition) editions.push(edition);
    }

    if (!this.tentative && this.nextStart) {
      const edition = normalizeEdition({
        start: this.nextStart,
        end: this.nextEnd,
        place: this.nextPlace,
        source: this.nextEdition ? this.nextEdition.source : 'manual',
        sourceUrl: this.nextEdition ? this.nextEdition.sourceUrl : '',
        checkedAt: this.nextEdition ? this.nextEdition.checkedAt : '',
        id: this.nextEdition ? this.nextEdition.id : '',
      });
      if (edition) editions.push(edition);
    }

    return dedupeEditions(editions);
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

    const sources = this.syncSourcesText
      .split(/\r?\n/)
      .map((value) => normalizeUrl(value))
      .filter(Boolean);
    const fallbackSources = normalizeUrl(this.draft.url);
    const finalSources = sources.length > 0 ? sources : fallbackSources ? [fallbackSources] : [];

    const payload = Object.assign({}, this.draft, {
      editions: this.buildEditions(),
      previous: this.draft.historyNote || '',
      expectedMonth: this.draft.expectedMonth || '',
      sync: {
        enabled: this.syncEnabled,
        sources: Array.from(new Set(finalSources)),
        lastSync: this.draft.sync.lastSync || '',
        lastResult: this.draft.sync.lastResult || '',
        lastError: this.draft.sync.lastError || '',
      },
    });

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
    // Даты и места не хранятся в коде — подтягиваем их с сайтов при открытии панели.
    if (typeof this.plugin.maybeAutoSync === 'function') this.plugin.maybeAutoSync();
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

    container.appendChild(createElSafe('h3', 'ct-settings-heading', 'Автообновление дат'));

    this.addToggle(
      'Обновлять даты и места с официальных сайтов',
      'Плагин читает страницы источников и подставляет даты и места. Прошедшее проведение текущего или прошлого года сохраняется для строки «Прошлый раз». Ручные правки не затираются.',
      this.plugin.settings.autoSync,
      (value) => {
        this.plugin.settings.autoSync = value;
        this.plugin.persist();
      },
    );

    new Setting(container)
      .setName('Как часто проверять')
      .setDesc('При запуске Obsidian и при открытии панели, но не чаще выбранного интервала.')
      .addDropdown((dropdown) => {
        dropdown.addOption('1', 'Каждый час');
        dropdown.addOption('6', 'Раз в 6 часов');
        dropdown.addOption('12', 'Раз в 12 часов');
        dropdown.addOption('24', 'Раз в сутки');
        dropdown.addOption('72', 'Раз в 3 дня');
        dropdown.setValue(String(this.plugin.settings.syncIntervalHours)).onChange((value) => {
          this.plugin.settings.syncIntervalHours = Number(value) || 12;
          this.plugin.persist();
        });
      });

    const statusParts = [];
    if (this.plugin.settings.lastSyncAt) {
      statusParts.push(`Последняя проверка: ${formatDateTimeRu(this.plugin.settings.lastSyncAt)}.`);
    } else {
      statusParts.push('Проверок ещё не было.');
    }
    if (this.plugin.settings.lastSyncSummary) {
      statusParts.push(this.plugin.settings.lastSyncSummary);
    }

    const syncStatus = createElSafe('p', 'ct-settings-note', statusParts.join(' '));
    container.appendChild(syncStatus);

    new Setting(container)
      .setName('Проверить сайты сейчас')
      .setDesc('Запросит страницы и покажет, что удалось найти.')
      .addButton((button) =>
        button.setButtonText('Обновить').onClick(async () => {
          button.setButtonText('Обновляю…');
          button.setDisabled(true);
          try {
            const results = await this.plugin.syncAll({ notify: true });
            button.setButtonText('Обновить');
            button.setDisabled(false);
            syncStatus.textContent = [
              this.plugin.settings.lastSyncAt
                ? `Последняя проверка: ${formatDateTimeRu(this.plugin.settings.lastSyncAt)}.`
                : '',
              this.plugin.settings.lastSyncSummary,
            ]
              .filter(Boolean)
              .join(' ');
            return results;
          } catch (error) {
            button.setButtonText('Обновить');
            button.setDisabled(false);
            new Notice(`Не удалось обновить: ${syncErrorMessage(error)}`);
          }
          return null;
        }),
      );

    container.appendChild(createElSafe('h3', 'ct-settings-heading', 'Данные'));

    const configDir = this.app && this.app.vault ? this.app.vault.configDir : '.obsidian';
    const dataPath = `${configDir}/plugins/${this.plugin.manifest.id}/data.json`;
    container.appendChild(
      createElSafe(
        'p',
        'ct-settings-note',
        `События и история проведений хранятся в ${dataPath} и синхронизируются вместе с настройками хранилища. Резервная копия — этот файл.`,
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
      .setDesc('Вернутся «Технопром», «День поля» и «Агронеделя» с историей проведений.')
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
    this.syncing = false;

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
      id: 'sync-events',
      name: 'Обновить даты и места с сайтов',
      callback: () => this.syncAll({ notify: true }),
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

    if (this.settings.autoSync) {
      this.app.workspace.onLayoutReady(() => {
        this.maybeAutoSync();
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
    // Дат в коде нет — после сброса их нужно заново загрузить с сайтов.
    this.settings.lastSyncAt = '';
    this.settings.lastSyncSummary = '';
    await this.persist();
    new Notice(
      this.settings.autoSync
        ? 'События восстановлены — даты загружаются с сайтов'
        : 'События восстановлены — даты можно ввести вручную',
    );
    this.maybeAutoSync();
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
    this.maybeAutoSync();
    return leaf;
  }

  async fetchPage(url) {
    if (typeof requestUrl !== 'function') {
      throw new Error('запросы к сайтам недоступны в этой версии Obsidian');
    }

    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('таймаут запроса')), SYNC_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([
        requestUrl({
          url,
          method: 'GET',
          throw: false,
          headers: { Accept: 'text/html,application/xhtml+xml' },
        }),
        timeout,
      ]);

      if (response && response.status && response.status >= 400) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response && typeof response.text === 'string' ? response.text : '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async syncEventById(id, notify) {
    const event = this.data.events.find((item) => item.id === id);
    if (!event) return null;
    if (!event.sync || !event.sync.enabled || event.sync.sources.length === 0) {
      if (notify) new Notice('У этого события не настроены источники автообновления');
      return null;
    }

    const nowDay = todayDayNumber();
    const nowISO = new Date().toISOString();
    let result;
    try {
      result = await syncEventWithFetcher(event, (url) => this.fetchPage(url), { nowDay, nowISO });
    } catch (error) {
      if (notify) new Notice(`Не удалось обновить: ${syncErrorMessage(error)}`);
      return null;
    }

    const index = this.data.events.findIndex((item) => item.id === id);
    if (index >= 0) this.data.events[index] = result.event;

    this.settings.lastSyncAt = nowISO;
    this.settings.lastSyncSummary = summarizeSyncResults([result]);
    await this.persist();
    if (notify) new Notice(`${event.title}: ${result.message}`);
    return result;
  }

  async syncAll(options) {
    const opts = options || {};
    if (this.syncing) {
      if (opts.notify) new Notice('Обновление уже выполняется');
      return null;
    }

    this.syncing = true;
    const nowDay = todayDayNumber();
    const nowISO = new Date().toISOString();
    const results = [];

    try {
      for (const event of this.data.events) {
        if (!event.sync || !event.sync.enabled || event.sync.sources.length === 0) continue;
        try {
          const result = await syncEventWithFetcher(event, (url) => this.fetchPage(url), {
            nowDay,
            nowISO,
          });
          const index = this.data.events.findIndex((item) => item.id === event.id);
          if (index >= 0) this.data.events[index] = result.event;
          results.push(result);
        } catch (error) {
          results.push({ event, action: 'none', errors: [syncErrorMessage(error)], message: 'Ошибка' });
        }
      }

      this.settings.lastSyncAt = nowISO;
      this.settings.lastSyncSummary = summarizeSyncResults(results);
      await this.persist();

      if (opts.notify) new Notice(this.settings.lastSyncSummary);
      return results;
    } finally {
      this.syncing = false;
    }
  }

  async maybeAutoSync() {
    if (!this.settings.autoSync) return;
    if (this.syncing) return;
    const interval = Math.max(1, Number(this.settings.syncIntervalHours) || 12) * 3600 * 1000;
    const last = Date.parse(this.settings.lastSyncAt || '');
    if (Number.isFinite(last) && Date.now() - last < interval) return;
    try {
      await this.syncAll({ notify: false });
    } catch (error) {
      console.error('Conference Tracker: автообновление не удалось', error);
    }
  }

  buildMarkdownTable() {
    const lines = ['| Событие | Ближайшее | Место | Прошлый раз |', '| --- | --- | --- | --- |'];
    const nowDay = todayDayNumber();
    const items = buildItems(this.data.events, 'all', this.settings, nowDay);

    items.forEach((item) => {
      const event = item.event;
      const next = item.display;
      const last = item.lastPast;
      const nextText = next
        ? formatRangeRu(next.start, next.end)
        : event.expectedMonth
          ? `Дата уточняется (ориентир: ${formatMonthRu(event.expectedMonth)})`
          : '—';
      const nextPlace = next && next.place ? next.place : '—';
      const lastText = last
        ? `${formatRangeRu(last.start, last.end)}${last.place ? ` · ${last.place}` : ''}`
        : event.historyNote || '—';
      lines.push(`| ${event.title} | ${nextText} | ${nextPlace} | ${lastText} |`);
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
  DATA_VERSION,
  MAX_EDITIONS,
  SYNC_TIMEOUT_MS,
  CODE_BLOCK,
  DEFAULT_EVENTS,
  DEFAULT_SETTINGS,
  CATEGORIES,
  parseISODate,
  isValidISODate,
  makeISO,
  dayNumberFromDate,
  todayDayNumber,
  parseMonth,
  formatDateRu,
  formatRangeRu,
  formatMonthRu,
  formatMonthTitle,
  formatDateTimeRu,
  pluralRu,
  editionState,
  formatCountdown,
  getNearestEdition,
  getLastPastEdition,
  getTentativeEdition,
  getPastEditions,
  getRelevantPastEdition,
  editionAllowedInRegions,
  normalizeRegions,
  yearFromDay,
  getEventState,
  buildItem,
  buildItems,
  countForMode,
  pickHero,
  buildSections,
  sortItems,
  normalizeEdition,
  normalizeEvent,
  normalizeData,
  normalizeSettings,
  normalizeSync,
  dedupeEditions,
  parseCodeBlockOptions,
  decodeHtmlEntities,
  stripHtml,
  parseJsonLdEvents,
  findDateRanges,
  extractPlaceNear,
  parseEventPage,
  parseCssColor,
  relativeLuminance,
  readableTextColor,
  applyReadableCardText,
  pickSyncCandidate,
  pickPastSyncCandidates,
  applySyncCandidate,
  syncEventWithFetcher,
  summarizeSyncResults,
  renderWidget,
  renderHeroPlaceholder,
  ConferenceTrackerView,
  ConferenceCodeBlock,
  EventModal,
  pad2,
};

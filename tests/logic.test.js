'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPluginModule } = require('./helpers');

const { pluginModule } = loadPluginModule();
const api = pluginModule.__internals;

const NOW = api.todayDayNumber(new Date(2026, 10, 8)); // 8 ноября 2026

function edition(start, end, place, extra) {
  return Object.assign({ start, end: end || '', place: place || '' }, extra || {});
}

function makeEvent(overrides) {
  return Object.assign(
    {
      id: 'test',
      title: 'Событие',
      category: 'Конференция',
      url: '',
      note: '',
      expectedMonth: '',
      editions: [],
      sync: { enabled: false, sources: [] },
    },
    overrides || {},
  );
}

function ids(items) {
  return items.map((item) => item.event.id);
}

/* ---------------- Даты и форматирование ---------------- */

test('parseISODate принимает только существующие даты', () => {
  assert.equal(api.isValidISODate('2026-11-08'), true);
  assert.equal(api.isValidISODate('2024-02-29'), true);
  assert.equal(api.isValidISODate(' 2026-11-08 '), true);

  assert.equal(api.isValidISODate('2026-02-30'), false);
  assert.equal(api.isValidISODate('2026-13-01'), false);
  assert.equal(api.isValidISODate('08.11.2026'), false);
  assert.equal(api.isValidISODate('2026-1-1'), false);
  assert.equal(api.isValidISODate(''), false);
  assert.equal(api.isValidISODate(null), false);
});

test('formatDateRu и formatRangeRu склоняют месяцы', () => {
  assert.equal(api.formatDateRu('2026-11-08'), '8 ноября 2026');
  assert.equal(api.formatRangeRu('2026-11-10', '2026-11-12'), '10–12 ноября 2026');
  assert.equal(api.formatRangeRu('2026-11-10', ''), '10 ноября 2026');
  assert.equal(api.formatRangeRu('2026-11-10', '2026-11-10'), '10 ноября 2026');
  assert.equal(api.formatRangeRu('2027-02-28', '2027-03-02'), '28 февраля — 2 марта 2027');
  assert.equal(api.formatRangeRu('2026-12-30', '2027-01-02'), '30 декабря 2026 — 2 января 2027');
  assert.equal(api.formatRangeRu('2026-11-12', '2026-11-10'), '10–12 ноября 2026');
  assert.equal(api.formatRangeRu('', ''), '');
  assert.equal(api.formatMonthRu('2027-08'), 'август 2027');
  assert.equal(api.formatMonthTitle('2027-08'), 'Август 2027');
});

test('pluralRu выбирает правильную форму', () => {
  const forms = ['день', 'дня', 'дней'];
  assert.equal(api.pluralRu(1, forms), 'день');
  assert.equal(api.pluralRu(2, forms), 'дня');
  assert.equal(api.pluralRu(4, forms), 'дня');
  assert.equal(api.pluralRu(5, forms), 'дней');
  assert.equal(api.pluralRu(11, forms), 'дней');
  assert.equal(api.pluralRu(21, forms), 'день');
  assert.equal(api.pluralRu(22, forms), 'дня');
  assert.equal(api.pluralRu(0, forms), 'дней');
});

/* ---------------- Проведения ---------------- */

test('editionState определяет фазу проведения', () => {
  const upcoming = api.editionState(edition('2026-11-10', '2026-11-12'), NOW);
  assert.equal(upcoming.kind, 'upcoming');
  assert.equal(upcoming.days, 2);
  assert.equal(upcoming.length, 3);

  const tomorrow = api.editionState(edition('2026-11-09'), NOW);
  assert.equal(tomorrow.kind, 'upcoming');
  assert.equal(tomorrow.days, 1);

  const ongoing = api.editionState(edition('2026-11-07', '2026-11-09'), NOW);
  assert.equal(ongoing.kind, 'ongoing');
  assert.equal(ongoing.dayIndex, 2);
  assert.equal(ongoing.length, 3);
  assert.equal(ongoing.lastDay, false);

  const lastDay = api.editionState(edition('2026-11-06', '2026-11-08'), NOW);
  assert.equal(lastDay.kind, 'ongoing');
  assert.equal(lastDay.lastDay, true);

  const oneDay = api.editionState(edition('2026-11-08'), NOW);
  assert.equal(oneDay.kind, 'ongoing');
  assert.equal(oneDay.length, 1);

  const past = api.editionState(edition('2026-11-01', '2026-11-03'), NOW);
  assert.equal(past.kind, 'past');
  assert.equal(past.daysAgo, 5);

  const tentative = api.editionState({}, NOW);
  assert.equal(tentative.kind, 'tentative');
});

test('formatCountdown даёт понятные подписи', () => {
  assert.equal(api.formatCountdown(api.editionState(edition('2026-11-09'), NOW)), 'Завтра');
  assert.equal(api.formatCountdown(api.editionState(edition('2026-11-11'), NOW)), 'Через 3 дня');
  assert.equal(api.formatCountdown(api.editionState(edition('2026-11-08'), NOW)), 'Сегодня');
  assert.equal(
    api.formatCountdown(api.editionState(edition('2026-11-07', '2026-11-09'), NOW)),
    'Идёт · день 2 из 3',
  );
  assert.equal(
    api.formatCountdown(api.editionState(edition('2026-11-06', '2026-11-08'), NOW)),
    'Последний день',
  );
  assert.equal(
    api.formatCountdown(api.editionState(edition('2026-11-01', '2026-11-03'), NOW)),
    'Завершилось 5 дней назад',
  );
  assert.equal(
    api.formatCountdown(api.editionState(edition('2026-11-06', '2026-11-07'), NOW)),
    'Завершилось вчера',
  );
  assert.equal(api.formatCountdown(api.editionState({}, NOW)), 'Дата уточняется');
});

test('getNearestEdition и getLastPastEdition выбирают правильные проведения', () => {
  const event = makeEvent({
    editions: [
      edition('2027-07-15', '2027-07-17', 'Алтайский край'),
      edition('2026-11-10', '2026-11-12', 'Новосибирск'),
      edition('2025-11-05', '2025-11-07', 'Новосибирск'),
      edition('2024-11-06', '2024-11-08', 'Новосибирск'),
    ],
  });

  assert.equal(api.getNearestEdition(event, NOW).start, '2026-11-10');
  assert.equal(api.getLastPastEdition(event, NOW).start, '2025-11-05');
  assert.equal(api.getPastEditions(event, NOW).length, 2);

  const ongoing = makeEvent({
    editions: [edition('2026-11-07', '2026-11-09'), edition('2026-12-01')],
  });
  assert.equal(api.getNearestEdition(ongoing, NOW).start, '2026-11-07');

  assert.equal(api.getNearestEdition(makeEvent(), NOW), null);
  assert.equal(api.getLastPastEdition(makeEvent(), NOW), null);
});

test('getEventState учитывает ближайшее, ориентир и прошлое', () => {
  const upcoming = makeEvent({
    editions: [edition('2026-11-10', '2026-11-12'), edition('2025-11-05', '2025-11-07')],
  });
  assert.equal(api.getEventState(upcoming, NOW).kind, 'upcoming');
  assert.equal(api.getEventState(upcoming, NOW).days, 2);

  const withExpected = makeEvent({
    expectedMonth: '2027-07',
    editions: [edition('2026-07-16', '2026-07-18')],
  });
  assert.equal(api.getEventState(withExpected, NOW).kind, 'tentative');

  const pastOnly = makeEvent({ editions: [edition('2026-07-16', '2026-07-18')] });
  assert.equal(api.getEventState(pastOnly, NOW).kind, 'past');

  assert.equal(api.getEventState(makeEvent(), NOW).kind, 'tentative');

  const staleExpected = makeEvent({
    expectedMonth: '2026-07',
    editions: [edition('2025-07-03', '2025-07-05')],
  });
  assert.equal(api.getEventState(staleExpected, NOW).kind, 'past');

  const currentExpected = makeEvent({ expectedMonth: '2026-11' });
  assert.equal(api.getEventState(currentExpected, NOW).kind, 'tentative');
});

test('buildItem показывает ближайшее проведение и «прошлый раз»', () => {
  const fieldDay = makeEvent({
    id: 'field-day',
    title: 'День поля',
    expectedMonth: '2027-07',
    editions: [
      edition('2026-07-16', '2026-07-18', 'Алтайский край · Сибирский агропарк'),
      edition('2025-07-03', '2025-07-05', 'Волгоградская область · КФХ «Чердынцев»'),
      edition('2024-06-20', '2024-06-22', 'Ставропольский край · МВД «МинводыЭКСПО»'),
    ],
  });

  const item = api.buildItem(fieldDay, 'upcoming', NOW);
  assert.equal(item.display, null);
  assert.equal(item.state.kind, 'tentative');
  assert.ok(item.lastPast);
  assert.equal(item.lastPast.start, '2026-07-16');
  assert.equal(item.lastPast.place, 'Алтайский край · Сибирский агропарк');
  assert.equal(item.history.length, 3);

  const agroneweek = makeEvent({
    id: 'agroneweek',
    editions: [
      edition('2026-11-10', '2026-11-12', 'Новосибирск'),
      edition('2025-11-05', '2025-11-07', 'Новосибирск'),
    ],
  });
  const upcomingItem = api.buildItem(agroneweek, 'upcoming', NOW);
  assert.equal(upcomingItem.display.start, '2026-11-10');
  assert.equal(upcomingItem.lastPast.start, '2025-11-05');
  assert.equal(upcomingItem.history.length, 1);

  const pastItem = api.buildItem(agroneweek, 'past', NOW);
  assert.equal(pastItem.display.start, '2025-11-05');
  assert.equal(pastItem.displayState.kind, 'past');
});

test('buildItems фильтрует и сортирует события', () => {
  const events = api.normalizeData(null).events;
  const settings = Object.assign({}, api.DEFAULT_SETTINGS);

  const upcoming = api.buildItems(events, 'upcoming', settings, NOW);
  assert.deepEqual(ids(upcoming), ['agroneweek', 'field-day', 'technoprom']);

  const all = api.buildItems(events, 'all', settings, NOW);
  assert.deepEqual(ids(all), ['agroneweek', 'field-day', 'technoprom']);

  const past = api.buildItems(events, 'past', settings, NOW);
  assert.equal(past.length, 3);
  assert.deepEqual(past.map((item) => item.display.start), [
    '2026-08-26',
    '2026-07-16',
    '2025-11-05',
  ]);

  assert.equal(api.buildItems(events, 'upcoming', { showTentative: false }, NOW).length, 1);
  assert.equal(api.buildItems(events, 'past', { showPast: false }, NOW).length, 0);

  const noPast = api.buildItems(events, 'all', { showPast: false }, NOW);
  assert.equal(noPast.length, 3);

  assert.equal(api.countForMode(events, 'upcoming', settings, NOW), 3);
  assert.equal(api.countForMode(events, 'past', settings, NOW), 3);
});

test('событие только с прошлым не попадает во вкладку «Предстоящие»', () => {
  const pastOnly = api.normalizeEvent({
    id: 'archive',
    title: 'Архивное событие',
    editions: [{ start: '2024-05-01', end: '2024-05-02', place: 'Москва' }],
  });
  const events = [pastOnly];
  const settings = Object.assign({}, api.DEFAULT_SETTINGS);

  assert.equal(api.buildItems(events, 'upcoming', settings, NOW).length, 0);
  assert.equal(api.buildItems(events, 'all', settings, NOW).length, 1);
  assert.equal(api.buildItems(events, 'past', settings, NOW).length, 1);

  const item = api.buildItem(pastOnly, 'all', NOW);
  assert.equal(item.state.kind, 'past');
  assert.equal(item.display.start, '2024-05-01');
});

test('buildSections группирует по месяцам и статусам', () => {
  const events = api.normalizeData(null).events;
  const settings = Object.assign({}, api.DEFAULT_SETTINGS);

  const sections = api.buildSections(api.buildItems(events, 'all', settings, NOW), 'all');
  assert.deepEqual(
    sections.map((section) => section.title),
    ['Ноябрь 2026', 'Дата уточняется'],
  );

  const pastSections = api.buildSections(api.buildItems(events, 'past', settings, NOW), 'past');
  assert.equal(pastSections.length, 1);
  assert.equal(pastSections[0].title, '');

  const onlyUpcoming = api.buildItems([events[0]], 'upcoming', settings, NOW);
  const flat = api.buildSections(onlyUpcoming, 'upcoming');
  assert.equal(flat.length, 1);
  assert.equal(flat[0].title, '');
});

test('pickHero возвращает ближайшее текущее или будущее событие', () => {
  const events = api.normalizeData(null).events;
  const items = api.buildItems(events, 'upcoming', api.DEFAULT_SETTINGS, NOW);
  const hero = api.pickHero(items);
  assert.ok(hero);
  assert.equal(hero.event.id, 'agroneweek');

  const fieldDay = events.find((event) => event.id === 'field-day');
  assert.equal(api.pickHero([api.buildItem(fieldDay, 'upcoming', NOW)]), null);
});

/* ---------------- Нормализация ---------------- */

test('normalizeEvent переносит старые данные в проведения', () => {
  const migrated = api.normalizeEvent({
    id: 'technoprom',
    title: '  Технопром  ',
    start: '2026-08-26',
    end: '2026-08-20',
    place: 'Новосибирск',
    previous: '2025 — 27–30 августа',
    url: 'форумтехнопром.рф',
  });

  assert.equal(migrated.title, 'Технопром');
  assert.equal(migrated.editions.length, 1);
  assert.equal(migrated.editions[0].start, '2026-08-26');
  assert.equal(migrated.editions[0].end, '');
  assert.equal(migrated.editions[0].place, 'Новосибирск');
  assert.equal(migrated.historyNote, '2025 — 27–30 августа');
  assert.equal(migrated.url, 'https://форумтехнопром.рф');
  assert.deepEqual(migrated.sync.sources, ['https://форумтехнопром.рф']);
  assert.equal(migrated.sync.enabled, true);
});

test('normalizeEvent сортирует и дедублирует проведения', () => {
  const normalized = api.normalizeEvent({
    title: 'Событие',
    expectedMonth: '2027-13',
    editions: [
      { start: '2025-01-10', end: '2025-01-11', place: 'A' },
      { start: '2026-01-10', end: '2026-01-11', place: 'B' },
      { start: '2025-01-10', end: '2025-01-11', place: 'C' },
      { start: '', place: 'D' },
      { start: '2027-02-30' },
    ],
  });

  assert.equal(normalized.expectedMonth, '');
  assert.deepEqual(
    normalized.editions.map((edition) => edition.start),
    ['2026-01-10', '2025-01-10'],
  );
  assert.equal(normalized.editions[1].place, 'A');
});

test('normalizeData: события по умолчанию и настройки', () => {
  const seeded = api.normalizeData(null);
  assert.equal(seeded.events.length, 3);
  assert.deepEqual(
    seeded.events.map((event) => event.id),
    ['agroneweek', 'technoprom', 'field-day'],
  );
  seeded.events.forEach((event) => {
    assert.equal(event.editions.length, 3);
    assert.ok(event.url.startsWith('https://'));
    assert.equal(event.sync.enabled, true);
    assert.ok(event.sync.sources.length > 0);
  });

  const fieldDay = seeded.events.find((event) => event.id === 'field-day');
  assert.equal(fieldDay.editions[0].start, '2026-07-16');
  assert.match(fieldDay.editions[0].place, /Алтайский край/);
  assert.match(fieldDay.editions[0].place, /Сибирский агропарк/);
  assert.equal(fieldDay.expectedMonth, '2027-07');

  assert.deepEqual(seeded.settings, api.DEFAULT_SETTINGS);

  const empty = api.normalizeData({ events: [], settings: { showPast: false } });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.settings.showPast, false);
  assert.equal(empty.settings.syncIntervalHours, 12);

  const titleOnly = api.normalizeData({ events: [{ title: 'Без даты' }] });
  assert.equal(titleOnly.events.length, 1);

  assert.equal(api.normalizeData({ settings: { syncIntervalHours: 5 } }).settings.syncIntervalHours, 12);
  assert.equal(api.normalizeData({ settings: { syncIntervalHours: 24 } }).settings.syncIntervalHours, 24);
});

/* ---------------- Разбор страниц ---------------- */

const ALTAI_TEXT = `
<html><head><title>Всероссийский день поля — 2026</title></head>
<body><h1>Всероссийский день поля</h1>
<p>С 16 по 18 июля 2026 года в Алтайском крае на площадке «Сибирский агропарк»
пройдёт главная полевая выставка страны.</p>
</body></html>`;

const JSON_LD_PAGE = `
<html><head><title>Всероссийский день поля 2027</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Всероссийский день поля",
  "startDate": "2027-07-15",
  "endDate": "2027-07-17",
  "location": {
    "@type": "Place",
    "name": "Сибирский агропарк",
    "address": {
      "@type": "PostalAddress",
      "addressRegion": "Алтайский край",
      "addressLocality": "пос. Прутской"
    }
  }
}
</script></head>
<body><h1>Всероссийский день поля</h1><p>С 15 по 17 июля 2027 года.</p></body></html>`;

test('findDateRanges распознаёт русские форматы дат', () => {
  const ranges = api.findDateRanges(
    'С 16 по 18 июля 2026 года, затем 10–12 ноября 2026, ' +
      'далее 28 февраля — 2 марта 2027 и 30 декабря — 2 января 2027.',
    2026,
    NOW,
  );

  assert.deepEqual(
    ranges.map((range) => [range.start, range.end]),
    [
      ['2026-07-16', '2026-07-18'],
      ['2026-11-10', '2026-11-12'],
      ['2027-02-28', '2027-03-02'],
      ['2026-12-30', '2027-01-02'],
    ],
  );
});

test('findDateRanges выводит год для диапазона без года', () => {
  const ranges = api.findDateRanges('Выставка пройдёт 10–12 ноября.', 2026, NOW);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, '2026-11-10');
  assert.equal(ranges[0].explicitYear, false);

  const later = api.todayDayNumber(new Date(2027, 2, 1)); // 1 марта 2027
  const nextYear = api.findDateRanges('Выставка пройдёт 10–12 ноября.', 2026, later);
  assert.equal(nextYear[0].start, '2027-11-10');
});

test('findDateRanges не разбирает даты внутри скриптов', () => {
  const html = '<script>var d = "16–18 июля 2026";</script><p>Без дат</p>';
  assert.deepEqual(api.findDateRanges(api.stripHtml(html), 2026, NOW), []);
});

test('parseJsonLdEvents читает schema.org Event', () => {
  const events = api.parseJsonLdEvents(JSON_LD_PAGE);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, '2027-07-15');
  assert.equal(events[0].end, '2027-07-17');
  assert.match(events[0].place, /Алтайский край/);
  assert.match(events[0].place, /Сибирский агропарк/);
  assert.equal(events[0].method, 'json-ld');

  assert.deepEqual(api.parseJsonLdEvents('<script type="application/ld+json">не json</script>'), []);
  assert.deepEqual(api.parseJsonLdEvents('<p>Без разметки</p>'), []);
});

test('parseEventPage находит дату и место в тексте', () => {
  const parsed = api.parseEventPage(ALTAI_TEXT, {
    title: 'День поля',
    nowDay: NOW,
    sourceUrl: 'https://russian-field-day.ru/',
  });

  const candidate = parsed.candidates[0];
  assert.equal(candidate.start, '2026-07-16');
  assert.equal(candidate.end, '2026-07-18');
  assert.equal(candidate.place, 'Алтайский край · Сибирский агропарк');
  assert.equal(candidate.sourceUrl, 'https://russian-field-day.ru/');
  assert.ok(candidate.confidence >= 0.7);
});

test('parseEventPage отдаёт приоритет JSON-LD', () => {
  const parsed = api.parseEventPage(JSON_LD_PAGE, { title: 'День поля', nowDay: NOW });
  assert.ok(parsed.candidates.length >= 1);
  const top = parsed.candidates[0];
  assert.equal(top.method, 'json-ld');
  assert.equal(top.start, '2027-07-15');
  assert.ok(top.confidence > 0.9);
});

test('pickSyncCandidate выбирает будущее, а не архив', () => {
  const candidates = [
    { start: '2026-07-16', end: '2026-07-18', confidence: 0.95, place: 'Алтай' },
    { start: '2027-07-15', end: '2027-07-17', confidence: 0.7, place: 'Алтай' },
  ];
  assert.equal(api.pickSyncCandidate(candidates, NOW).start, '2027-07-15');

  const pastOnly = [
    { start: '2026-07-16', end: '2026-07-18', confidence: 0.95 },
    { start: '2025-07-03', end: '2025-07-05', confidence: 0.9 },
  ];
  assert.equal(api.pickSyncCandidate(pastOnly, NOW), null);

  const farFuture = [{ start: '2029-07-15', end: '2029-07-17', confidence: 0.95 }];
  assert.equal(api.pickSyncCandidate(farFuture, NOW), null);
});

test('applySyncCandidate добавляет автоматическое проведение', () => {
  const event = makeEvent({
    id: 'field-day',
    expectedMonth: '2027-07',
    editions: [edition('2026-07-16', '2026-07-18', 'Алтайский край · Сибирский агропарк')],
  });
  const candidate = {
    start: '2027-07-15',
    end: '2027-07-17',
    place: 'Алтайский край · Сибирский агропарк',
    confidence: 0.9,
    sourceUrl: 'https://russian-field-day.ru/',
  };

  const result = api.applySyncCandidate(event, candidate, '2026-11-08T10:00:00.000Z', NOW);
  assert.equal(result.action, 'added');
  assert.equal(result.event.editions.length, 2);
  const added = result.event.editions.find((item) => item.start === '2027-07-15');
  assert.ok(added);
  assert.equal(added.source, 'auto');
  assert.equal(added.checkedAt, '2026-11-08T10:00:00.000Z');
  assert.equal(result.event.expectedMonth, '2027-07');
  // исходный объект не мутирован
  assert.equal(event.editions.length, 1);
});

test('applySyncCandidate уточняет место у существующей даты', () => {
  const event = makeEvent({
    editions: [edition('2027-07-15', '2027-07-17', '')],
  });
  const result = api.applySyncCandidate(
    event,
    {
      start: '2027-07-15',
      end: '2027-07-17',
      place: 'Алтайский край · Сибирский агропарк',
      sourceUrl: 'https://russian-field-day.ru/',
    },
    '2026-11-08T10:00:00.000Z',
    NOW,
  );

  assert.equal(result.action, 'updated');
  assert.equal(result.event.editions[0].place, 'Алтайский край · Сибирский агропарк');
  assert.equal(result.event.editions[0].sourceUrl, 'https://russian-field-day.ru/');
});

test('applySyncCandidate не перезаписывает ручную дату', () => {
  const event = makeEvent({
    editions: [edition('2027-07-01', '2027-07-03', 'Москва', { source: 'manual' })],
  });
  const result = api.applySyncCandidate(
    event,
    { start: '2027-07-15', end: '2027-07-17', place: 'Алтай', confidence: 0.9 },
    '2026-11-08T10:00:00.000Z',
    NOW,
  );

  assert.equal(result.action, 'conflict');
  assert.match(result.conflict, /^На сайте: 15–17 июля 2027/);
  assert.equal(result.event.editions.length, 1);
  assert.equal(result.event.editions[0].start, '2027-07-01');
});

test('applySyncCandidate заменяет прежнюю авто-дату и игнорирует прошлое', () => {
  const event = makeEvent({
    editions: [
      edition('2027-07-01', '2027-07-03', 'Москва', { source: 'auto' }),
      edition('2026-07-16', '2026-07-18', 'Алтай'),
    ],
  });
  const result = api.applySyncCandidate(
    event,
    { start: '2027-07-15', end: '2027-07-17', place: 'Алтай' },
    '2026-11-08T10:00:00.000Z',
    NOW,
  );

  assert.equal(result.action, 'added');
  assert.equal(result.event.editions.length, 2);
  assert.equal(result.event.editions.filter((item) => item.source === 'auto').length, 1);
  assert.equal(result.event.editions.find((item) => item.source === 'auto').start, '2027-07-15');

  const pastCandidate = api.applySyncCandidate(
    event,
    { start: '2026-07-16', end: '2026-07-18', place: 'Алтай' },
    '2026-11-08T10:00:00.000Z',
    NOW,
  );
  assert.equal(pastCandidate.action, 'none');
});

test('syncEventWithFetcher обновляет событие и пишет статус', async () => {
  const event = api.normalizeEvent({
    id: 'field-day',
    title: 'День поля',
    expectedMonth: '2027-07',
    editions: [{ start: '2026-07-16', end: '2026-07-18', place: 'Алтайский край' }],
    sync: { sources: ['https://russian-field-day.ru/'] },
  });

  const result = await api.syncEventWithFetcher(
    event,
    async () => JSON_LD_PAGE,
    { nowDay: NOW, nowISO: '2026-11-08T10:00:00.000Z' },
  );

  assert.equal(result.action, 'added');
  assert.equal(result.event.editions.length, 2);
  assert.equal(result.event.sync.lastSync, '2026-11-08T10:00:00.000Z');
  assert.match(result.event.sync.lastResult, /15–17 июля 2027/);
  assert.ok(result.event.sync.lastResult.includes('Алтайский край'));
  assert.equal(result.errors.length, 0);
  assert.match(result.message, /^Найдено: 15–17 июля 2027/);
});

test('syncEventWithFetcher фиксирует ошибки источников', async () => {
  const event = api.normalizeEvent({
    id: 'technoprom',
    title: 'Технопром',
    url: 'https://форумтехнопром.рф/',
    editions: [{ start: '2026-08-26', end: '2026-08-28' }],
  });

  const result = await api.syncEventWithFetcher(
    event,
    async () => {
      throw new Error('HTTP 403');
    },
    { nowDay: NOW, nowISO: '2026-11-08T10:00:00.000Z' },
  );

  assert.equal(result.action, 'none');
  assert.equal(result.errors.length, 1);
  assert.match(result.event.sync.lastError, /HTTP 403/);
  assert.equal(result.message, 'Не удалось получить данные');

  const empty = await api.syncEventWithFetcher(event, async () => '<p>Ничего нет</p>', {
    nowDay: NOW,
    nowISO: '2026-11-08T10:00:00.000Z',
  });
  assert.equal(empty.action, 'none');
  assert.equal(empty.message, 'Даты не найдены');
});

test('summarizeSyncResults собирает сводку', () => {
  const summary = api.summarizeSyncResults([
    { action: 'added', errors: [] },
    { action: 'updated', errors: [] },
    { action: 'conflict', errors: [] },
    { action: 'none', errors: ['HTTP 500'] },
  ]);
  assert.match(summary, /новых дат: 1/);
  assert.match(summary, /уточнено: 1/);
  assert.match(summary, /расхождений с сайтом: 1/);
  assert.match(summary, /не удалось проверить: 1/);

  assert.match(api.summarizeSyncResults([]), /изменений нет/);
});

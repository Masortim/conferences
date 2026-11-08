'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPluginModule } = require('./helpers');

const { pluginModule } = loadPluginModule();
const api = pluginModule.__internals;

const NOW = api.todayDayNumber(new Date(2026, 10, 8)); // 8 ноября 2026

function event(overrides) {
  return Object.assign(
    {
      id: 'test',
      title: 'Событие',
      category: 'Конференция',
      start: '',
      end: '',
      expectedMonth: '',
    },
    overrides,
  );
}

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

test('getEventState определяет фазу события', () => {
  const upcoming = api.getEventState(event({ start: '2026-11-10', end: '2026-11-12' }), NOW);
  assert.equal(upcoming.kind, 'upcoming');
  assert.equal(upcoming.days, 2);
  assert.equal(upcoming.length, 3);

  const tomorrow = api.getEventState(event({ start: '2026-11-09' }), NOW);
  assert.equal(tomorrow.kind, 'upcoming');
  assert.equal(tomorrow.days, 1);

  const ongoing = api.getEventState(event({ start: '2026-11-07', end: '2026-11-09' }), NOW);
  assert.equal(ongoing.kind, 'ongoing');
  assert.equal(ongoing.dayIndex, 2);
  assert.equal(ongoing.length, 3);
  assert.equal(ongoing.lastDay, false);

  const lastDay = api.getEventState(event({ start: '2026-11-06', end: '2026-11-08' }), NOW);
  assert.equal(lastDay.kind, 'ongoing');
  assert.equal(lastDay.lastDay, true);

  const oneDay = api.getEventState(event({ start: '2026-11-08' }), NOW);
  assert.equal(oneDay.kind, 'ongoing');
  assert.equal(oneDay.length, 1);

  const past = api.getEventState(event({ start: '2026-11-01', end: '2026-11-03' }), NOW);
  assert.equal(past.kind, 'past');
  assert.equal(past.daysAgo, 5);

  const tentative = api.getEventState(event({ expectedMonth: '2027-08' }), NOW);
  assert.equal(tentative.kind, 'tentative');
});

test('getEventState не зависит от порядка дат и часового пояса', () => {
  const inverted = api.getEventState(event({ start: '2026-11-12', end: '2026-11-10' }), NOW);
  assert.equal(inverted.length, 1);

  const backToBack = api.getEventState(event({ start: '2026-11-12', end: '2026-11-10' }), NOW);
  assert.equal(backToBack.kind, 'upcoming');
  assert.equal(backToBack.days, 4);
});

test('formatCountdown даёт понятные подписи', () => {
  assert.equal(api.formatCountdown(api.getEventState(event({ start: '2026-11-09' }), NOW)), 'Завтра');
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-11' }), NOW)),
    'Через 3 дня',
  );
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-08' }), NOW)),
    'Сегодня',
  );
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-07', end: '2026-11-09' }), NOW)),
    'Идёт · день 2 из 3',
  );
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-06', end: '2026-11-08' }), NOW)),
    'Последний день',
  );
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-01', end: '2026-11-03' }), NOW)),
    'Завершилось 5 дней назад',
  );
  assert.equal(
    api.formatCountdown(api.getEventState(event({ start: '2026-11-06', end: '2026-11-07' }), NOW)),
    'Завершилось вчера',
  );
  assert.equal(api.formatCountdown(api.getEventState(event({}), NOW)), 'Дата уточняется');
});

test('sortEvents: текущие, будущие, без даты, прошедшие', () => {
  const events = [
    event({ id: 'past-old', title: 'Старое', start: '2026-10-10', end: '2026-10-12' }),
    event({ id: 'tentative-none', title: 'Без даты' }),
    event({ id: 'upcoming', title: 'Будущее', start: '2026-12-01' }),
    event({ id: 'past-recent', title: 'Недавнее', start: '2026-10-30', end: '2026-11-01' }),
    event({ id: 'tentative-aug', title: 'Август', expectedMonth: '2027-08' }),
    event({ id: 'ongoing', title: 'Сейчас', start: '2026-11-07', end: '2026-11-09' }),
    event({ id: 'tentative-jul', title: 'Июль', expectedMonth: '2027-07' }),
  ];

  const order = api.sortEvents(events, NOW).map((item) => item.event.id);
  assert.deepEqual(order, [
    'ongoing',
    'upcoming',
    'tentative-jul',
    'tentative-aug',
    'tentative-none',
    'past-recent',
    'past-old',
  ]);
});

test('filterEvents учитывает вкладку и настройки', () => {
  const events = [
    event({ id: 'upcoming', start: '2026-12-01' }),
    event({ id: 'ongoing', start: '2026-11-07', end: '2026-11-09' }),
    event({ id: 'tentative' }),
    event({ id: 'past', start: '2026-10-01', end: '2026-10-02' }),
  ];
  const settings = { showPast: true, showTentative: true };

  const ids = (items) => items.map((item) => item.event.id);

  assert.deepEqual(ids(api.filterEvents(events, 'upcoming', settings, NOW)), [
    'ongoing',
    'upcoming',
    'tentative',
  ]);
  assert.deepEqual(ids(api.filterEvents(events, 'past', settings, NOW)), ['past']);
  assert.deepEqual(ids(api.filterEvents(events, 'all', settings, NOW)), [
    'ongoing',
    'upcoming',
    'tentative',
    'past',
  ]);

  assert.deepEqual(
    ids(api.filterEvents(events, 'all', { showPast: false, showTentative: true }, NOW)),
    ['ongoing', 'upcoming', 'tentative'],
  );
  assert.deepEqual(
    ids(api.filterEvents(events, 'upcoming', { showPast: true, showTentative: false }, NOW)),
    ['ongoing', 'upcoming'],
  );

  assert.equal(api.countForMode(events, 'all', settings, NOW), 4);
  assert.equal(api.countForMode(events, 'past', settings, NOW), 1);
});

test('pickHero возвращает ближайшее текущее или будущее событие', () => {
  const items = api.sortEvents(
    [
      event({ id: 'tentative', title: 'Без даты' }),
      event({ id: 'upcoming', title: 'Будущее', start: '2026-12-01' }),
      event({ id: 'past', title: 'Прошлое', start: '2026-10-01' }),
    ],
    NOW,
  );

  const hero = api.pickHero(items);
  assert.ok(hero);
  assert.equal(hero.event.id, 'upcoming');

  assert.equal(api.pickHero(api.sortEvents([event({})], NOW)), null);
});

test('buildSections группирует по месяцам и статусам', () => {
  const sections = api.buildSections(
    api.sortEvents(
      [
        event({ id: 'a', start: '2026-12-01' }),
        event({ id: 'b', start: '2026-12-03' }),
        event({ id: 'c', start: '2027-01-15' }),
        event({ id: 'd' }),
        event({ id: 'e', start: '2026-10-01', end: '2026-10-02' }),
      ],
      NOW,
    ),
    'all',
  );

  assert.deepEqual(
    sections.map((section) => section.title),
    ['Декабрь 2026', 'Январь 2027', 'Дата уточняется', 'Прошедшие'],
  );

  const upcomingSections = api.buildSections(
    api.sortEvents([event({ id: 'a', start: '2026-12-01' })], NOW),
    'upcoming',
  );
  assert.equal(upcomingSections.length, 1);
  assert.equal(upcomingSections[0].title, '');
});

test('normalizeEvent приводит данные к безопасному виду', () => {
  const normalized = api.normalizeEvent({
    title: '  Технопром  ',
    start: '2026-08-26',
    end: '2026-08-20',
    url: 'форумтехнопром.рф',
    category: '',
  });

  assert.equal(normalized.title, 'Технопром');
  assert.equal(normalized.start, '2026-08-26');
  assert.equal(normalized.end, '');
  assert.equal(normalized.url, 'https://форумтехнопром.рф');
  assert.equal(normalized.category, 'Другое');
  assert.equal(normalized.tentative, false);
  assert.ok(normalized.id);

  const tentative = api.normalizeEvent({ title: 'День поля', expectedMonth: '2027-07' });
  assert.equal(tentative.tentative, true);
  assert.equal(tentative.start, '');
  assert.equal(tentative.expectedMonth, '2027-07');

  const badMonth = api.normalizeEvent({ title: 'Х', expectedMonth: '2027-13' });
  assert.equal(badMonth.expectedMonth, '');
});

test('normalizeData не теряет пустой список событий', () => {
  const seeded = api.normalizeData(null);
  assert.equal(seeded.events.length, 3);
  assert.deepEqual(
    seeded.events.map((item) => item.id),
    ['agroneweek', 'technoprom', 'field-day'],
  );
  assert.deepEqual(seeded.settings, api.DEFAULT_SETTINGS);

  const empty = api.normalizeData({ events: [], settings: { showPast: false } });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.settings.showPast, false);
  assert.equal(empty.settings.showTentative, true);

  const filtered = api.normalizeData({ events: [{ title: '   ' }, { title: 'Ок' }] });
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.events[0].title, 'Ок');
});

test('parseCodeBlockOptions читает параметры блока', () => {
  const options = api.parseCodeBlockOptions(
    [
      'view: all',
      'limit: 3',
      'hero: false',
      'filters: no',
      'compact: true',
      'title: "Мои события"',
    ].join('\n'),
  );

  assert.equal(options.view, 'all');
  assert.equal(options.limit, 3);
  assert.equal(options.showHero, false);
  assert.equal(options.showFilters, false);
  assert.equal(options.compact, true);
  assert.equal(options.title, 'Мои события');

  const invalid = api.parseCodeBlockOptions('view: вчера\nlimit: -2\nhero: может быть');
  assert.equal(invalid.view, undefined);
  assert.equal(invalid.limit, undefined);
  assert.equal(invalid.showHero, true);
  assert.deepEqual(api.parseCodeBlockOptions(''), {});
});

test('события по умолчанию корректны', () => {
  assert.equal(api.DEFAULT_EVENTS.length, 3);

  const ids = api.DEFAULT_EVENTS.map((item) => item.id);
  assert.deepEqual(ids, ['agroneweek', 'technoprom', 'field-day']);

  const agroneweek = api.getEventState(api.DEFAULT_EVENTS[0], NOW);
  assert.equal(agroneweek.kind, 'upcoming');
  assert.equal(api.formatRangeRu('2026-11-10', '2026-11-12'), '10–12 ноября 2026');

  api.DEFAULT_EVENTS.forEach((item) => {
    assert.ok(item.title);
    assert.ok(item.url.startsWith('https://'));
    assert.ok(item.category);
  });
});

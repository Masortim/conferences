'use strict';

/**
 * Данные для тестов интерфейса и синхронизации.
 * В самом плагине даты и места не хранятся — только в этих фикстурах
 * и в демонстрационном превью.
 */
function sampleEvents(api) {
  return [
    api.normalizeEvent({
      id: 'agroneweek',
      title: 'Агронеделя',
      fullTitle: 'Сибирская аграрная неделя',
      category: 'Выставка',
      url: 'https://sibagroweek.ru/',
      note: 'Международная агропромышленная выставка и Новосибирский агропродовольственный форум.',
      expectedMonth: '2027-11',
      editions: [
        {
          start: '2026-11-10',
          end: '2026-11-12',
          place: 'Новосибирск · МВК «Новосибирск Экспоцентр»',
        },
        {
          start: '2025-11-05',
          end: '2025-11-07',
          place: 'Новосибирск · МВК «Новосибирск Экспоцентр»',
        },
      ],
      sync: { sources: ['https://sibagroweek.ru/'] },
    }),
    api.normalizeEvent({
      id: 'technoprom',
      title: 'Технопром',
      fullTitle: 'Международный форум технологического развития',
      category: 'Форум',
      url: 'https://форумтехнопром.рф/',
      note: 'Даты и место публикуются на официальном сайте форума.',
      expectedMonth: '2027-08',
      editions: [
        {
          start: '2026-08-26',
          end: '2026-08-28',
          place: 'Новосибирск · «Новосибирск Экспоцентр»',
        },
      ],
      sync: { sources: ['https://форумтехнопром.рф/'] },
    }),
    api.normalizeEvent({
      id: 'field-day',
      title: 'День поля',
      fullTitle: 'Всероссийский день поля',
      category: 'День поля',
      url: 'https://russian-field-day.ru/',
      note: 'Всероссийский день поля ежегодно меняет регион; учитываются НСО и Алтай.',
      expectedMonth: '2027-07',
      regions: ['Новосибирская область', 'Новосибирск', 'Алтай'],
      editions: [
        {
          start: '2026-07-16',
          end: '2026-07-18',
          place: 'Алтайский край · Сибирский агропарк, пос. Прутской',
        },
      ],
      sync: { sources: ['https://russian-field-day.ru/'] },
    }),
  ];
}

function sampleData(api) {
  return {
    version: api.DATA_VERSION,
    events: sampleEvents(api),
    settings: Object.assign({}, api.DEFAULT_SETTINGS),
  };
}

module.exports = { sampleEvents, sampleData };

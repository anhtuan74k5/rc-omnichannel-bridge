const COUNTRY_ALIASES = new Map([
  ['my', 'Q30'],
  ['hoa ky', 'Q30'],
  ['hoa ki', 'Q30'],
  ['nuoc my', 'Q30'],
  ['united states', 'Q30'],
  ['usa', 'Q30'],
  ['us', 'Q30'],
  ['viet nam', 'Q881'],
  ['vietnam', 'Q881'],
  ['nuoc viet nam', 'Q881'],
  ['anh', 'Q145'],
  ['vuong quoc anh', 'Q145'],
  ['united kingdom', 'Q145'],
  ['uk', 'Q145'],
  ['phap', 'Q142'],
  ['france', 'Q142'],
  ['duc', 'Q183'],
  ['germany', 'Q183'],
  ['nhat', 'Q17'],
  ['nhat ban', 'Q17'],
  ['japan', 'Q17'],
  ['han quoc', 'Q884'],
  ['south korea', 'Q884'],
  ['trung quoc', 'Q148'],
  ['china', 'Q148'],
]);

const WEATHER_CODES = new Map([
  [0, 'trời quang'],
  [1, 'ít mây'],
  [2, 'mây rải rác'],
  [3, 'nhiều mây'],
  [45, 'sương mù'],
  [48, 'sương mù đóng băng'],
  [51, 'mưa phùn nhẹ'],
  [53, 'mưa phùn vừa'],
  [55, 'mưa phùn dày'],
  [61, 'mưa nhẹ'],
  [63, 'mưa vừa'],
  [65, 'mưa to'],
  [71, 'tuyết nhẹ'],
  [73, 'tuyết vừa'],
  [75, 'tuyết dày'],
  [80, 'mưa rào nhẹ'],
  [81, 'mưa rào vừa'],
  [82, 'mưa rào mạnh'],
  [95, 'dông'],
  [96, 'dông kèm mưa đá nhẹ'],
  [99, 'dông kèm mưa đá mạnh'],
]);

function formatTemperature(value) {
  return String(value).replace('.', ',');
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWeatherQuestion(message) {
  const normalized = normalizeText(message);
  return /\b(thoi tiet|nhiet do|troi mua|troi nang|weather|temperature)\b/.test(normalized);
}

function extractWeatherLocation(message) {
  const normalized = normalizeText(message)
    .replace(/(hien tai|bay gio)\d*/g, ' ')
    .replace(/\b(hom nay|today|now|currently)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/\b(?:o|tai|in|at)\s+(.+)$/);
  const rawLocation = match
    ? match[1]
    : normalized.replace(/\b(thoi tiet|nhiet do|troi mua|troi nang|weather|temperature)\b/g, ' ');

  return rawLocation
    .replace(/\b(the nao|ra sao|nhu nao|khong|ko|khong vay|vay|la)\b/g, ' ')
    .replace(/\b\d{1,2}(?:\s+\d{1,2})?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getOfficeType(message) {
  const normalized = normalizeText(message);
  if (/\b(thu tuong|prime minister|head of government)\b/.test(normalized)) {
    return {
      kind: 'prime_minister',
      label: 'head of government/prime minister',
      statementProperty: 'P6',
      valueProperty: 'P6',
    };
  }

  if (/\b(tong thong|chu tich nuoc|president|head of state)\b/.test(normalized)) {
    return {
      kind: 'president',
      label: 'head of state/president',
      statementProperty: 'P35',
      valueProperty: 'P35',
    };
  }

  return null;
}

function extractCountryName(message) {
  const normalized = normalizeText(message)
    .replace(/\b(hien tai|bay gio|current|now|today)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/\b(?:cua|nuoc|of|in)\s+(.+)$/);
  if (!match) return '';

  return match[1]
    .replace(/\b(la ai|ai|la|dang|duong nhiem)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getOfficeWikipediaTitle(countryId, officeKind) {
  const titles = new Map([
    ['Q30:president', 'President_of_the_United_States'],
    ['Q881:president', 'President_of_Vietnam'],
    ['Q881:prime_minister', 'Prime_Minister_of_Vietnam'],
    ['Q145:prime_minister', 'Prime_Minister_of_the_United_Kingdom'],
    ['Q142:president', 'President_of_France'],
    ['Q142:prime_minister', 'Prime_Minister_of_France'],
    ['Q183:president', 'President_of_Germany'],
    ['Q183:prime_minister', 'Chancellor_of_Germany'],
    ['Q17:prime_minister', 'Prime_Minister_of_Japan'],
    ['Q884:president', 'President_of_South_Korea'],
    ['Q148:president', 'President_of_the_People%27s_Republic_of_China'],
    ['Q148:prime_minister', 'Premier_of_China'],
  ]);

  return titles.get(`${countryId}:${officeKind}`) || '';
}

async function lookupPoliticalOfficeFromWikipedia(countryId, office) {
  const title = getOfficeWikipediaTitle(countryId, office.kind);
  if (!title) return null;

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
  const summaryRes = await fetch(summaryUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'rc-omnichannel-bridge/1.0',
    },
  });
  const summaryData = await summaryRes.json();
  if (!summaryRes.ok || !summaryData.extract) return null;

  const apiUrl = new URL('https://en.wikipedia.org/w/api.php');
  apiUrl.searchParams.set('action', 'parse');
  apiUrl.searchParams.set('page', title);
  apiUrl.searchParams.set('prop', 'wikitext');
  apiUrl.searchParams.set('format', 'json');

  const wikiRes = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'rc-omnichannel-bridge/1.0',
    },
  });
  const wikiData = await wikiRes.json();
  const wikitext = wikiData.parse && wikiData.parse.wikitext ? wikiData.parse.wikitext['*'] : '';
  const incumbent = extractWikiInfoboxValue(wikitext, 'incumbent');
  const incumbentSince = extractWikiInfoboxValue(wikitext, 'incumbentsince');
  const source = summaryData.content_urls && summaryData.content_urls.desktop
    ? summaryData.content_urls.desktop.page
    : summaryUrl;

  const directReply = incumbent
    ? `${summaryData.title}: ${incumbent}${incumbentSince ? `, giữ chức từ ${incumbentSince}` : ''}. Nguồn: Wikipedia (${source}).`
    : '';

  return {
    directReply,
    context: [
      'Live political office lookup from Wikipedia:',
      `Page: ${summaryData.title}`,
      incumbent ? `Incumbent: ${incumbent}` : '',
      incumbentSince ? `Incumbent since: ${incumbentSince}` : '',
      `Summary: ${summaryData.extract}`,
      `Source: ${source}`,
    ].filter(Boolean).join('\n'),
  };
}

function extractWikiInfoboxValue(wikitext, fieldName) {
  const pattern = new RegExp(`^\\|\\s*${fieldName}\\s*=\\s*(.+)$`, 'im');
  const match = String(wikitext || '').match(pattern);
  if (!match) return '';

  return match[1]
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref\b[^/]*\/>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'''/g, '')
    .replace(/''/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function lookupWeather(message) {
  if (!isWeatherQuestion(message)) return null;

  const location = extractWeatherLocation(message);
  if (!location) {
    return {
      directReply: 'Bạn muốn xem thời tiết ở khu vực nào? Ví dụ: "Thời tiết Hà Nội hôm nay thế nào?"',
    };
  }

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name', location);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'vi');
  geoUrl.searchParams.set('format', 'json');

  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();
  const place = geoData.results && geoData.results[0];
  if (!geoRes.ok || !place) {
    return {
      directReply: `Mình chưa tìm được địa điểm "${location}". Bạn gửi rõ hơn tên thành phố/tỉnh giúp mình nhé.`,
    };
  }

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.searchParams.set('latitude', String(place.latitude));
  forecastUrl.searchParams.set('longitude', String(place.longitude));
  forecastUrl.searchParams.set('current', 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m');
  forecastUrl.searchParams.set('timezone', 'auto');

  const forecastRes = await fetch(forecastUrl);
  const forecast = await forecastRes.json();
  if (!forecastRes.ok || !forecast.current) {
    return null;
  }

  const current = forecast.current;
  const weatherText = WEATHER_CODES.get(current.weather_code) || `mã thời tiết ${current.weather_code}`;
  const placeName = `${place.name}${place.country ? `, ${place.country}` : ''}`;
  const reply = [
    `Thời tiết hiện tại ở ${placeName}: ${weatherText}, ${formatTemperature(current.temperature_2m)}°C.`,
    `Độ ẩm ${current.relative_humidity_2m}%, gió ${formatTemperature(current.wind_speed_10m)} km/h.`,
    `Cập nhật lúc ${current.time}. Nguồn: Open-Meteo.`,
  ].join(' ');

  return {
    directReply: reply,
    context: [
      `Live weather lookup from Open-Meteo for ${placeName}:`,
      `Time: ${current.time}`,
      `Condition: ${weatherText}`,
      `Temperature: ${current.temperature_2m} C`,
      `Humidity: ${current.relative_humidity_2m}%`,
      `Wind speed: ${current.wind_speed_10m} km/h`,
      'Source: Open-Meteo geocoding and forecast APIs.',
    ].join('\n'),
  };
}

async function resolveCountryEntityId(countryName) {
  const normalized = normalizeText(countryName);
  if (COUNTRY_ALIASES.has(normalized)) {
    return COUNTRY_ALIASES.get(normalized);
  }

  if (!normalized) return '';

  const url = new URL('https://www.wikidata.org/w/api.php');
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', countryName);
  url.searchParams.set('language', 'vi');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.search || !data.search[0]) {
    return '';
  }

  return data.search[0].id;
}

async function lookupPoliticalOffice(message) {
  const office = getOfficeType(message);
  if (!office) return null;

  const countryName = extractCountryName(message);
  if (!countryName) {
    return {
      directReply: 'Bạn muốn hỏi chức danh hiện tại của quốc gia nào?',
    };
  }

  const countryId = await resolveCountryEntityId(countryName);
  if (!countryId) return null;

  const wikipedia = await lookupPoliticalOfficeFromWikipedia(countryId, office);
  if (wikipedia) return wikipedia;

  const query = `
SELECT ?person ?personLabel ?countryLabel WHERE {
  wd:${countryId} rdfs:label ?countryLabel.
  FILTER(LANG(?countryLabel) = "vi" || LANG(?countryLabel) = "en")
  wd:${countryId} p:${office.statementProperty} ?statement.
  ?statement ps:${office.valueProperty} ?person.
  FILTER NOT EXISTS { ?statement pq:P582 ?endDate. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "vi,en". }
}
LIMIT 5`;

  const url = new URL('https://query.wikidata.org/sparql');
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'rc-omnichannel-bridge/1.0',
    },
  });
  const data = await res.json();
  const rows = data.results && data.results.bindings ? data.results.bindings : [];
  if (!res.ok || rows.length === 0) {
    return null;
  }

  const names = [...new Set(rows.map((row) => row.personLabel && row.personLabel.value).filter(Boolean))];
  const countryLabel = rows[0].countryLabel && rows[0].countryLabel.value;

  return {
    context: [
      `Live political office lookup from Wikidata:`,
      `Country: ${countryLabel || countryName}`,
      `Office type: ${office.label}`,
      `Current holder(s): ${names.join(', ')}`,
      'Source: Wikidata SPARQL query for current statement without end date.',
    ].join('\n'),
  };
}

async function getLiveContext(message) {
  try {
    const weather = await lookupWeather(message);
    if (weather) return weather;

    const politicalOffice = await lookupPoliticalOffice(message);
    if (politicalOffice) return politicalOffice;
  } catch (err) {
    console.error('[live-lookup] Lookup failed:', err.message);
  }

  return null;
}

module.exports = {
  getLiveContext,
};

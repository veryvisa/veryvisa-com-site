import { distanceMetres } from './location-index.mjs';

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const SQFT_PER_SQM = 10.763910416709722;
const FT_PER_M = 3.280839895013123;

export const DEVELOPMENT_SOURCES = {
  multiplex: 'https://bylaws.vancouver.ca/zoning/zoning-by-law-district-schedule-r1-1.pdf',
  multiplexGuide: 'https://bylaws.vancouver.ca/bulletin/bulletin-r1-1-how-to-guide.pdf',
  laneway: 'https://bylaws.vancouver.ca/zoning/zoning-by-law-consolidated.pdf',
  toa: 'https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/265_2023',
  plannedStations: 'https://www.broadwaysubway.ca/about/stations/',
  openStations: 'https://www.translink.ca/schedules-and-maps/skytrain',
};

export const DEVELOPMENT_LABELS = {
  r1_6: '宽度与面积均达 6 户门槛',
  r1_5: '宽度与面积均达 5 户门槛',
  r1_4: '宽度与面积均达 4 户门槛',
  below: '未达 R1-1 多户最低门槛',
  review: '需逐址核对',
};

const TOA_STATION_NAMES = [
  '', '29th Avenue Station', 'Arbutus Station', 'Broadway – City Hall Station', 'Bridgeport Station', 'Burrard Station',
  'Commercial – Broadway Station', 'Dunbar Loop Exchange', 'Gilmore Station', 'Granville Station', 'Great Northern Way – Emily Carr Station',
  'Joyce – Collingwood Station', 'King Edward Station', 'Kootenay Loop Exchange', 'Langara – 49th Avenue Station',
  'Main Street – Science World Station', 'Marine Drive Station', 'Mount Pleasant Station', 'Nanaimo Station',
  'Oakridge – 41st Avenue Station', 'Oak – VGH Station', 'Olympic Village Station', 'Renfrew Station', 'Rupert Station',
  'South Granville Station', 'Stadium – Chinatown Station', 'Vancouver City Centre Station', 'VCC – Clark Station',
  'Waterfront Station', 'Yaletown – Roundhouse Station',
];

export function toaStationName(value) {
  if (Number.isInteger(Number(value)) && TOA_STATION_NAMES[Number(value)]) return TOA_STATION_NAMES[Number(value)];
  return typeof value === 'string' ? value : '';
}

function ruleValue(rules, id) {
  const value = rules?.rules?.find((rule) => rule.id === id)?.value;
  if (!Number.isFinite(Number(value))) throw new TypeError(`开发潜力规则缺数值：${id}`);
  return Number(value);
}

export function deriveMultiplexPotential(record, rules) {
  if (record?.zoning !== 'R1-1') return 'review';
  const frontageFt = finite(record.frontage_ft_approx), areaSqft = finite(record.lot_area_sqft);
  if (frontageFt === null || areaSqft === null) return 'review';
  const frontageM = frontageFt / FT_PER_M, areaM2 = areaSqft / SQFT_PER_SQM;
  for (const units of [6, 5, 4]) {
    const frontage = ruleValue(rules, `r1-multiplex-${units}-frontage`);
    const area = ruleValue(rules, `r1-multiplex-${units}-area`);
    if (frontageM + 1e-9 >= frontage && areaM2 + 1e-9 >= area) return `r1_${units}`;
  }
  return 'below';
}

const tierFor = (station, metres, rules) => {
  if (station.type === 'bus') {
    if (metres <= ruleValue(rules, 'toa-bus-tier-4')) return 4;
    if (metres <= ruleValue(rules, 'toa-bus-tier-5')) return 5;
    return null;
  }
  if (metres <= ruleValue(rules, 'toa-rail-tier-1')) return 1;
  if (metres <= ruleValue(rules, 'toa-rail-tier-2')) return 2;
  if (metres <= ruleValue(rules, 'toa-rail-tier-3')) return 3;
  return null;
};

const TIER_DENSITY_ORDER = { 1: 5, 2: 4, 3: 3, 4: 4, 5: 3 };

export function deriveToa(record, rules) {
  if (![record?.lat, record?.lon].every((value) => finite(value) !== null)) return null;
  const candidates = (rules?.stations || []).map((station) => {
    const metres = distanceMetres(record, { lat: station.latitude, lon: station.longitude });
    return { station, metres, tier: tierFor(station, metres, rules) };
  }).filter((item) => item.tier !== null).sort((a, b) => TIER_DENSITY_ORDER[b.tier] - TIER_DENSITY_ORDER[a.tier] || a.metres - b.metres);
  if (!candidates.length) return null;
  const chosen = candidates[0];
  return { stationId: chosen.station.id, station: chosen.station.name, metres: Math.round(chosen.metres), tier: chosen.tier, planned: chosen.station.status === 'planned' };
}

export function toaBand(tier) {
  if (tier === 1 || tier === 4) return 200;
  if (tier === 2 || tier === 5) return 400;
  if (tier === 3) return 800;
  return null;
}

export function toaLabel(row) {
  const tier = finite(row?.toa_tier), metres = finite(row?.toa_m), band = toaBand(tier);
  const station = toaStationName(row?.toa_station);
  if (tier === null || metres === null || !station) return '不在本次点位初筛范围内';
  const type = tier >= 4 ? '公交换乘点' : '铁路站';
  return `${band} 米层 · ${station}${row.toa_planned ? '（规划中）' : ''} · 约 ${Math.round(metres)} 米 · ${type}`;
}

export function lanewayLabel(row) {
  if (row?.lane === true) return '有后巷，可进一步核对 laneway house';
  if (row?.lane === false) return '索引未见后巷；其他后部车辆通道条件需逐址核对';
  return '后部车辆通道需逐址核对';
}

const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

export function decodeLocationShard(shard) {
  if (!Array.isArray(shard?.fields) || !Array.isArray(shard?.records)) throw new TypeError('位置索引分片格式无效');
  return shard.records.map((values) => Object.fromEntries(shard.fields.map((field, index) => [field, values[index]])));
}

const toRad = (degrees) => degrees * Math.PI / 180;
export function distanceMetres(a, b) {
  const aLat = finite(a?.lat), aLon = finite(a?.lon), bLat = finite(b?.lat), bLon = finite(b?.lon);
  if ([aLat, aLon, bLat, bLon].some((value) => value === null)) return Infinity;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const ROAD_WORDS = new Map([
  ['AVENUE', 'AV'], ['AVE', 'AV'], ['STREET', 'ST'], ['ROAD', 'RD'], ['BOULEVARD', 'BLVD'],
  ['DRIVE', 'DR'], ['COURT', 'CT'], ['PLACE', 'PL'], ['LANE', 'LN'], ['HIGHWAY', 'HWY'], ['TERRACE', 'TER'],
  ['WEST', 'W'], ['EAST', 'E'], ['NORTH', 'N'], ['SOUTH', 'S'],
]);

export function normalizeIndexAddress(value) {
  return String(value || '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map((token) => {
    const ordinal = token.match(/^(\d+)(?:ST|ND|RD|TH)$/);
    return ordinal?.[1] || ROAD_WORDS.get(token) || token;
  }).join(' ');
}

export function findLocationRecord(records, { address = '', point = null } = {}) {
  return matchLocationRecord(records, { address, point }).record;
}

export function matchLocationRecord(records, { address = '', point = null } = {}) {
  const wanted = normalizeIndexAddress(address);
  const exact = wanted ? records.filter((record) => normalizeIndexAddress(record.address) === wanted) : [];
  const candidates = exact.length ? exact : records;
  if (point && candidates.length) {
    const nearest = candidates.map((record) => ({ record, metres: distanceMetres(point, record) })).sort((a, b) => a.metres - b.metres)[0];
    if (exact.length) return { record: nearest.record, method: 'exact', metres: Number.isFinite(nearest.metres) ? nearest.metres : null };
    if (nearest.metres <= 40) return { record: nearest.record, method: 'nearest', metres: nearest.metres };
    return { record: null, method: 'unmatched', metres: Number.isFinite(nearest.metres) ? nearest.metres : null };
  }
  if (exact.length) return { record: exact[0], method: 'exact', metres: null };
  return { record: null, method: 'unmatched', metres: null };
}

const share = (count, total) => total ? Number((count * 100 / total).toFixed(1)) : 0;
const summarizeBins = (records, bins, field) => bins.map((bin) => {
  const count = records.filter((record) => {
    const value = finite(record[field]);
    return value !== null && (bin.min === null || value >= bin.min) && (bin.max === null || value < bin.max);
  }).length;
  return { ...bin, count, share: share(count, records.length) };
});

export const AREA_BINS = [
  { key: 'under-4000', label: '小于四千平方英尺', min: null, max: 4000, query: { lot_max: 3999.9 } },
  { key: '4000-6000', label: '四千至六千平方英尺', min: 4000, max: 6000.1, query: { lot_min: 4000, lot_max: 6000 } },
  { key: 'over-6000', label: '大于六千平方英尺', min: 6000.1, max: null, query: { lot_min: 6000.1 } },
];

export const FRONTAGE_BINS = [
  { key: 'under-40', label: '窄于四十英尺', min: null, max: 40, query: { frontage_max: 39.9 } },
  { key: '40-55', label: '四十至五十五英尺', min: 40, max: 55.1, query: { frontage_min: 40, frontage_max: 55 } },
  { key: 'over-55', label: '宽于五十五英尺', min: 55.1, max: null, query: { frontage_min: 55.1 } },
];

export const AMENITY_COVERAGE = [
  { key: 'rapid', label: '快线公交站', field: 'r_m', max: 800, query: { rapid_max: 800 } },
  { key: 'park', label: '公园点位', field: 'p_m', max: 300, query: { park_max: 300 } },
  { key: 'community', label: '社区中心', field: 'c_m', max: 800, query: { community_max: 800 } },
  { key: 'library', label: '公共图书馆', field: 'l_m', max: 800, query: { library_max: 800 } },
];

export const DEVELOPMENT_BINS = [
  { key: 'r1_6', label: '宽度与面积均达六户门槛', query: { devpot: 'r1_6' } },
  { key: 'r1_5', label: '宽度与面积均达五户门槛', query: { devpot: 'r1_5' } },
  { key: 'r1_4', label: '宽度与面积均达四户门槛', query: { devpot: 'r1_4' } },
  { key: 'below', label: '未达 R1-1 多户最低门槛', query: { devpot: 'below' } },
  { key: 'review', label: '需逐址核对', query: { devpot: 'review' } },
];

export function summarizeLocationRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('位置索引记录必须是数组');
  const total = records.length;
  const orientations = [...new Set(records.map((record) => record.front_orientation).filter(Boolean))].sort().map((value) => {
    const count = records.filter((record) => record.front_orientation === value).length;
    return { key: value, label: value, count, share: share(count, total), query: { orient: value } };
  });
  const ratio = (field, key, label, param) => {
    const count = records.filter((record) => record[field] === true).length;
    return { key, label, count, share: share(count, total), query: { [param]: 'yes' } };
  };
  return {
    count: total,
    area: summarizeBins(records, AREA_BINS, 'lot_area_sqft'),
    frontage: summarizeBins(records, FRONTAGE_BINS, 'frontage_ft_approx'),
    orientations,
    ratios: [
      ratio('corner_lot', 'corner', '角地', 'corner'),
      ratio('lane', 'lane', '有后巷', 'lane'),
      ratio('major_road', 'major', '临主干道', 'major'),
    ],
    amenities: AMENITY_COVERAGE.map((item) => {
      const count = records.filter((record) => {
        const value = finite(record[item.field]);
        return value !== null && value <= item.max;
      }).length;
      return { ...item, count, share: share(count, total) };
    }),
    development: DEVELOPMENT_BINS.map((item) => {
      const count = records.filter((record) => record.devpot === item.key).length;
      return { ...item, count, share: share(count, total) };
    }),
  };
}

export function searchUrl(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value !== null && value !== undefined) params.set(key, String(value));
  return `/veryvisa-com-site/home/search/?${params.toString()}`;
}

import { decodeLocationShard, distanceMetres, matchLocationRecord, searchUrl } from './location-index.mjs';
import { DEVELOPMENT_LABELS, DEVELOPMENT_SOURCES, lanewayLabel, toaLabel } from './home-development.mjs';
import { ERA_FIELDS, ERA_FIELD_LABELS, eraAnchor, eraForYear, eraItemText } from './home-era.mjs';
import { lookupMetroAddress, renderMetroResult, renderReferralCard, renderYearEra } from './metro-era.mjs';
import { lookupSiteLayers, renderOverlayReferral, renderSiteLayers, siteLayerPlaceholder, siteLayersFor } from './site-layers.mjs';

const API_ROOT = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets';
const AMENITY_SOURCES = {
  rapid: 'https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data',
  park: 'https://opendata.vancouver.ca/explore/dataset/parks-polygon-representation/',
  community: 'https://opendata.vancouver.ca/explore/dataset/community-centres/',
  library: 'https://opendata.vancouver.ca/explore/dataset/libraries/',
};

export const DATASETS = {
  addresses: { id: 'property-addresses', label: 'Property addresses（物业地址）' },
  assessments: { id: 'property-tax-report', label: 'Property tax report（物业税评估报告）' },
  permits: { id: 'issued-building-permits', label: 'Issued building permits（已签发建筑许可）' },
  heritage: { id: 'heritage-sites', label: 'Heritage sites（文物地点）' },
  flood: { id: 'designated-floodplain', label: 'Designated floodplain（指定洪泛区）' },
};

const CACHE_VERSION = 3;
const PAGE_SIZE = 100;
const ROAD_WORDS = new Map([
  ['AVENUE', 'AV'], ['AVE', 'AV'], ['AV', 'AV'],
  ['STREET', 'ST'], ['ST', 'ST'],
  ['ROAD', 'RD'], ['RD', 'RD'],
  ['BOULEVARD', 'BLVD'], ['BLVD', 'BLVD'],
  ['DRIVE', 'DR'], ['DR', 'DR'],
  ['COURT', 'CT'], ['CT', 'CT'],
  ['PLACE', 'PL'], ['PL', 'PL'],
  ['LANE', 'LN'], ['LN', 'LN'],
  ['HIGHWAY', 'HWY'], ['HWY', 'HWY'],
  ['TERRACE', 'TER'], ['TER', 'TER'],
]);
const DIRECTIONS = new Map([
  ['WEST', 'W'], ['W', 'W'], ['EAST', 'E'], ['E', 'E'],
  ['NORTH', 'N'], ['N', 'N'], ['SOUTH', 'S'], ['S', 'S'],
]);

export class CityDataError extends Error {
  constructor(dataset, status = 0) {
    super(`City data request failed: ${dataset} (${status || 'network'})`);
    this.name = 'CityDataError';
    this.dataset = dataset;
    this.status = status;
  }
}

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const datasetUrl = (dataset) => `https://opendata.vancouver.ca/explore/dataset/${dataset.id}/`;
const apiUrl = (dataset, params = {}) => {
  const url = new URL(`${API_ROOT}/${dataset.id}/records`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  return url.toString();
};
const odsText = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function normalizeToken(token) {
  const ordinal = token.match(/^(\d+)(?:ST|ND|RD|TH)$/);
  if (ordinal) return ordinal[1];
  return ROAD_WORDS.get(token) || DIRECTIONS.get(token) || token;
}

export function normalizeStreet(value) {
  const tokens = String(value || '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(normalizeToken);
  const directions = tokens.filter((token) => ['W', 'E', 'N', 'S'].includes(token));
  const body = tokens.filter((token) => !['W', 'E', 'N', 'S'].includes(token));
  return [...body, ...directions].join(' ');
}

export function validateInput({ civicNumber, street }) {
  const number = String(civicNumber || '').trim().toUpperCase();
  const streetText = String(street || '').trim();
  if (!/^\d{1,6}[A-Z]?$/.test(number)) throw new TypeError('请输入有效门牌号（只填数字，可带一个字母）。');
  if (normalizeStreet(streetText).length < 2) throw new TypeError('请输入街名，例如 W 12th Ave。');
  return { civicNumber: number, street: streetText, streetKey: normalizeStreet(streetText) };
}

async function fetchJson(url, dataset, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new CityDataError(dataset.id);
  }
  if (!response?.ok) throw new CityDataError(dataset.id, response?.status);
  try {
    return await response.json();
  } catch {
    throw new CityDataError(dataset.id, response.status);
  }
}

async function fetchAll(dataset, params, fetchImpl, maxRecords = 9900) {
  const output = [];
  for (let offset = 0; offset < maxRecords; offset += PAGE_SIZE) {
    const json = await fetchJson(apiUrl(dataset, { ...params, limit: PAGE_SIZE, offset }), dataset, fetchImpl);
    const rows = Array.isArray(json.results) ? json.results : [];
    output.push(...rows);
    const total = Math.min(Number(json.total_count) || rows.length, maxRecords);
    if (!rows.length || output.length >= total || rows.length < PAGE_SIZE) break;
  }
  return output;
}

function pointFrom(record) {
  const lon = finite(record?.geo_point_2d?.lon ?? record?.geom?.geometry?.coordinates?.[0]);
  const lat = finite(record?.geo_point_2d?.lat ?? record?.geom?.geometry?.coordinates?.[1]);
  return lon === null || lat === null ? null : { lon, lat };
}

export async function queryAddressCandidates(input, fetchImpl = fetch) {
  const clean = validateInput(input);
  const rows = await fetchAll(DATASETS.addresses, {
    where: `civic_number=${odsText(clean.civicNumber)}`,
    select: 'civic_number,std_street,pcoord,site_id,geo_local_area,geom,geo_point_2d',
  }, fetchImpl);
  const seen = new Set();
  return rows.filter((row) => String(row.civic_number || '').toUpperCase() === clean.civicNumber && normalizeStreet(row.std_street) === clean.streetKey).map((row) => ({
    civicNumber: String(row.civic_number),
    street: String(row.std_street || ''),
    pcoord: String(row.pcoord || ''),
    siteId: String(row.site_id || ''),
    localArea: String(row.geo_local_area || ''),
    point: pointFrom(row),
  })).filter((row) => row.pcoord && !seen.has(`${row.pcoord}|${row.siteId}`) && seen.add(`${row.pcoord}|${row.siteId}`));
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 同一分层产权楼各单位登记的建年取出现最多的那个（并列取较早者）；没有就返回 null，不猜。
function modeYear(values) {
  const counts = new Map();
  for (const value of values) { const year = Number(value); if (Number.isInteger(year) && year > 1800) counts.set(year, (counts.get(year) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

export function summarizeAssessments(records) {
  const byYear = new Map();
  for (const record of records) {
    const year = String(record.report_year || record.tax_assessment_year || '');
    const land = finite(record.current_land_value), improvement = finite(record.current_improvement_value);
    if (!/^20\d{2}$/.test(year) || land === null || improvement === null) continue;
    const row = { ...record, year, land, improvement, total: land + improvement };
    const group = byYear.get(year) || [];
    group.push(row);
    byYear.set(year, group);
  }
  const years = [...byYear.keys()].sort();
  if (!years.length) return { mode: 'none', history: [] };
  const latestYear = byYear.has('2026') ? '2026' : years.at(-1);
  const latest = byYear.get(latestYear);
  const isStrata = latest.some((row) => String(row.legal_type).toUpperCase() === 'STRATA');
  const history = years.map((year) => {
    const values = byYear.get(year).map((row) => row.total);
    return { year, count: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values) };
  });
  if (isStrata) return { mode: 'strata', latestYear, count: latest.length, median: median(latest.map((row) => row.total)), min: Math.min(...latest.map((row) => row.total)), max: Math.max(...latest.map((row) => row.total)), yearBuilt: modeYear(latest.map((row) => row.year_built)), history };
  const current = latest[0];
  return {
    mode: 'land', latestYear, land: current.land, improvement: current.improvement, total: current.total,
    yearBuilt: current.year_built || null, bigImprovementYear: current.big_improvement_year || null,
    zoningDistrict: current.zoning_district || null, zoningClassification: current.zoning_classification || null,
    taxLevy: finite(current.tax_levy), history,
  };
}

async function fetchAssessments(candidate, fetchImpl) {
  const rows = await fetchAll(DATASETS.assessments, {
    where: `land_coordinate=${odsText(candidate.pcoord)}`,
    select: 'legal_type,land_coordinate,zoning_district,zoning_classification,current_land_value,current_improvement_value,tax_assessment_year,year_built,big_improvement_year,tax_levy,report_year',
    order_by: 'report_year desc',
  }, fetchImpl);
  return summarizeAssessments(rows);
}

function addressTokensMatch(address, candidate) {
  const firstPart = String(address || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const tokens = firstPart.split(/\s+/).filter(Boolean).map(normalizeToken);
  const targetStreet = normalizeStreet(candidate.street).split(' ');
  return tokens.includes(candidate.civicNumber) && targetStreet.every((token) => tokens.includes(token));
}

function tenYearsAgo(now) {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - 10);
  return date.toISOString().slice(0, 10);
}

function truncate(value, length = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

async function fetchPermits(candidate, fetchImpl, now) {
  const query = `${candidate.civicNumber} ${candidate.street}`;
  const rows = await fetchAll(DATASETS.permits, {
    where: `search(address,${odsText(query)}) and issuedate >= date'${tenYearsAgo(now)}'`,
    select: 'permitnumber,issuedate,projectvalue,typeofwork,address,projectdescription',
    order_by: 'issuedate desc',
  }, fetchImpl);
  return rows.filter((row) => addressTokensMatch(row.address, candidate)).map((row) => ({
    permitNumber: String(row.permitnumber || ''), issueDate: String(row.issuedate || ''),
    projectValue: finite(row.projectvalue), typeOfWork: String(row.typeofwork || '未注明'),
    description: truncate(row.projectdescription),
  })).sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

async function fetchHeritage(candidate, fetchImpl) {
  const clauses = [`streetnumber=${odsText(candidate.civicNumber)} and search(streetname,${odsText(candidate.street)})`];
  if (candidate.point) clauses.push(`within_distance(geom, geom'POINT(${candidate.point.lon} ${candidate.point.lat})', 10 m)`);
  const rows = await fetchAll(DATASETS.heritage, {
    where: `(${clauses.join(') or (')})`,
    select: 'id,streetnumber,streetname,category,buildingnamespecifics,evaluationgroup,municipaldesignationm,status,geom,geo_point_2d',
  }, fetchImpl);
  return rows.filter((row) => addressTokensMatch(`${row.streetnumber || ''} ${row.streetname || ''}`, candidate) || (candidate.point && pointFrom(row) && Math.abs(pointFrom(row).lon - candidate.point.lon) < 0.0002 && Math.abs(pointFrom(row).lat - candidate.point.lat) < 0.0002)).map((row) => ({
    name: String(row.buildingnamespecifics || '未注明名称'), category: String(row.category || '未注明类别'),
    evaluationGroup: String(row.evaluationgroup || ''), municipalDesignation: String(row.municipaldesignationm || ''), status: String(row.status || ''),
  }));
}

async function fetchFlood(candidate, fetchImpl) {
  if (!candidate.point) return [];
  return fetchAll(DATASETS.flood, {
    where: `intersects(geom, geom'POINT(${candidate.point.lon} ${candidate.point.lat})')`,
    select: 'object_id,name,description',
  }, fetchImpl).then((rows) => rows.map((row) => ({ name: String(row.name || '未注明名称'), description: String(row.description || '') })));
}

function settledBlock(result, dataset) {
  return result.status === 'fulfilled' ? { ok: true, data: result.value } : { ok: false, dataset: result.reason?.dataset || dataset.id };
}

export async function fetchAddressDetails(candidate, { fetchImpl = fetch, now = new Date() } = {}) {
  const queryTime = new Date(now).toISOString();
  const [assessments, permits, heritage, flood] = await Promise.allSettled([
    fetchAssessments(candidate, fetchImpl), fetchPermits(candidate, fetchImpl, now),
    fetchHeritage(candidate, fetchImpl), fetchFlood(candidate, fetchImpl),
  ]);
  return {
    status: 'complete', candidate, queryTime,
    assessments: settledBlock(assessments, DATASETS.assessments),
    permits: settledBlock(permits, DATASETS.permits),
    heritage: settledBlock(heritage, DATASETS.heritage),
    flood: settledBlock(flood, DATASETS.flood),
  };
}

export async function lookupAddress(input, options = {}) {
  const now = options.now || new Date();
  try {
    const clean = validateInput(input);
    const candidates = await queryAddressCandidates(clean, options.fetchImpl || fetch);
    if (!candidates.length) return { status: 'no-results', queryTime: new Date(now).toISOString(), input: clean };
    if (candidates.length > 1) return { status: 'choose', queryTime: new Date(now).toISOString(), candidates };
    return fetchAddressDetails(candidates[0], { ...options, now });
  } catch (error) {
    if (error instanceof TypeError) return { status: 'invalid', message: error.message };
    return { status: 'error', queryTime: new Date(now).toISOString(), dataset: error?.dataset || DATASETS.addresses.id };
  }
}

const money = (value) => value === null || value === undefined ? '未公布' : new Intl.NumberFormat('zh-Hans-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(Number(value));
const number = (value) => new Intl.NumberFormat('zh-Hans-CA').format(Number(value));
const queryTimeText = (iso) => new Intl.DateTimeFormat('zh-Hans-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Vancouver' }).format(new Date(iso));
const sourceLine = (dataset, queryTime, prefix = '数据集') => `<p class="dataset-source">${h(prefix)}：<a href="${datasetUrl(dataset)}">${h(dataset.label)}</a> · 查询时间：${h(queryTimeText(queryTime))}</p>`;
const datasetError = (dataset, queryTime) => `<section class="result-card result-error"><h2>${h(dataset.label)}</h2><p>市府数据接口暂时不可用。可稍后重试，或直接打开<a href="${datasetUrl(dataset)}">市府数据门户</a>。</p>${sourceLine(dataset, queryTime)}</section>`;

function chart(history) {
  const rows = history.filter((row) => Number.isFinite(row.median));
  if (!rows.length) return '';
  const width = 620, height = 210, padX = 48, padY = 30;
  const values = rows.map((row) => row.median), min = Math.min(...values), max = Math.max(...values), spread = Math.max(max - min, 1);
  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? width / 2 : padX + index * ((width - padX * 2) / (rows.length - 1));
    const y = height - padY - ((row.median - min) / spread) * (height - padY * 2);
    return { ...row, x, y };
  });
  return `<figure class="assessment-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="历年总评估走势"><title>历年总评估走势</title><line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" class="chart-axis"/><polyline points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" class="chart-line"/>${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4"><title>${h(p.year)}：${h(money(p.median))}</title></circle><text x="${p.x}" y="${height - 8}" text-anchor="middle">${h(p.year)}</text>`).join('')}</svg><figcaption>折线使用各年总评估价；strata 楼使用每户中位数。</figcaption></figure>`;
}

function renderAssessment(block, queryTime) {
  if (!block.ok) return datasetError(DATASETS.assessments, queryTime);
  const a = block.data;
  if (a.mode === 'none') return `<section class="result-card"><h2>评估与地税</h2><p>此数据集未见记录。</p>${sourceLine(DATASETS.assessments, queryTime)}</section>`;
  if (a.mode === 'strata') return `<section class="result-card"><h2>评估与地税 · Strata 楼</h2><p class="result-lede">${h(a.latestYear)} 年共有 <strong>${h(number(a.count))}</strong> 条单位评估记录；总评估价中位数为 <strong>${h(money(a.median))}</strong>，范围为 ${h(money(a.min))} 至 ${h(money(a.max))}。本页不逐户列出。</p>${chart(a.history)}${sourceLine(DATASETS.assessments, queryTime)}</section>`;
  return `<section class="result-card"><h2>评估、建年与地税</h2><dl class="result-facts"><div><dt>${h(a.latestYear)} 土地评估</dt><dd>${h(money(a.land))}</dd></div><div><dt>${h(a.latestYear)} 建筑评估</dt><dd>${h(money(a.improvement))}</dd></div><div><dt>${h(a.latestYear)} 总评估</dt><dd>${h(money(a.total))}</dd></div>${a.total > 0 ? `<div><dt>建筑占总评估</dt><dd>${h(Math.round((a.improvement / a.total) * 100))}%</dd></div>` : ''}<div><dt>登记建年</dt><dd>${h(a.yearBuilt || '未公布')}</dd></div><div><dt>大修年</dt><dd>${h(a.bigImprovementYear || '未公布')}</dd></div><div><dt>分区</dt><dd>${h([a.zoningDistrict, a.zoningClassification].filter(Boolean).join(' · ') || '未公布')}</dd></div><div><dt>物业税</dt><dd>${h(money(a.taxLevy))}</dd></div></dl>${a.total > 0 ? '<p class="result-caution">建筑占总评估：按本年评估的建筑部分除以总评估，在您的浏览器里即时计算，本站不保存。占比低表示评估价主要来自土地；这是评估口径，不是市场价，也不反映房屋状况。</p>' : ''}${chart(a.history)}${sourceLine(DATASETS.assessments, queryTime)}</section>`;
}

function renderPermits(block, queryTime) {
  if (!block.ok) return datasetError(DATASETS.permits, queryTime);
  const rows = block.data;
  const content = rows.length ? `<div class="permit-list">${rows.map((row) => `<article><h3>${h(row.typeOfWork)} · ${h(row.issueDate || '日期未公布')}</h3><p><span class="permit-id">${h(row.permitNumber)}</span> · 工程金额 ${h(money(row.projectValue))}</p><p>${h(row.description || '简述未公布')}</p></article>`).join('')}</div>` : '<p>此数据集近十年未见匹配记录。</p>';
  return `<section class="result-card"><h2>近十年已签发建筑许可</h2>${content}${sourceLine(DATASETS.permits, queryTime)}</section>`;
}

function renderHeritage(block, queryTime) {
  if (!block.ok) return datasetError(DATASETS.heritage, queryTime);
  const rows = block.data;
  const content = rows.length ? `<ul>${rows.map((row) => `<li><strong>${h(row.name)}</strong>：${h(row.category)}${row.evaluationGroup ? ` · 评定 ${h(row.evaluationGroup)}` : ''}${row.municipalDesignation ? ` · 市级指定 ${h(row.municipalDesignation)}` : ''}</li>`).join('')}</ul>` : '<p>此数据集未见记录。</p>';
  return `<section class="result-card"><h2>文物地点命中</h2>${content}<p class="result-caution">未命中只表示该数据集的本次查询未见记录，不代表不存在其他限制。</p>${sourceLine(DATASETS.heritage, queryTime)}</section>`;
}

function renderFlood(block, queryTime) {
  if (!block.ok) return datasetError(DATASETS.flood, queryTime);
  const rows = block.data;
  const content = rows.length ? `<ul>${rows.map((row) => `<li><strong>${h(row.name)}</strong>${row.description ? `：${h(row.description)}` : ''}</li>`).join('')}</ul>` : '<p>此数据集未见记录。</p>';
  return `<section class="result-card"><h2>指定洪泛区图层命中</h2>${content}<p class="result-caution">以物业地址代表点与市府图层相交判断；未命中不等于“无风险”。</p>${sourceLine(DATASETS.flood, queryTime)}</section>`;
}

export async function loadPositionRecord(result, communityData = {}, fetchImpl = fetch) {
  return (await loadPositionMatch(result, communityData, fetchImpl))?.record || null;
}

export async function loadPositionMatch(result, communityData = {}, fetchImpl = fetch) {
  if (result?.status !== 'complete') return null;
  const community = communityData?.[result.candidate.localArea];
  if (!community?.slug) return { record: null, method: 'unmatched', metres: null };
  try {
    const response = await fetchImpl(`/veryvisa-com-site/home/data/${encodeURIComponent(community.slug)}.json`);
    if (!response?.ok) return { record: null, method: 'unmatched', metres: null };
    const records = decodeLocationShard(await response.json());
    return matchLocationRecord(records, {
      address: `${result.candidate.civicNumber} ${result.candidate.street}`,
      point: result.candidate.point,
    });
  } catch {
    return { record: null, method: 'unmatched', metres: null };
  }
}

const yesNo = (value) => value === true ? '是' : value === false ? '否' : '待核';
function renderPosition(result) {
  const row = result.position;
  const match = result.positionMatch || { method: row ? 'exact' : 'unmatched', metres: null };
  const matchLabel = match.method === 'exact' ? '门牌精确' : match.method === 'nearest' ? '四十米最近点' : '未命中';
  const matchDistance = Number.isFinite(match.metres) ? `${number(match.metres)} 米` : '无可用距离';
  if (!row) return `<section class="result-card"><h2>位置索引</h2><p><strong>命中方式：</strong>${matchLabel} · <strong>距离：</strong>${h(matchDistance)}</p><p>本次未能把市府地址记录与温西位置索引中的地块稳定对应；请继续以市府原始图层核对。</p></section>`;
  const frontage = finite(row.frontage_ft_approx);
  const bandMin = frontage === null ? null : Math.floor(frontage / 5) * 5;
  const filters = { local: row.local_area };
  if (bandMin !== null) { filters.frontage_min = bandMin; filters.frontage_max = bandMin + 5; }
  const compareLink = searchUrl(filters);
  const distance = (value, source) => finite(value) === null ? '待核' : `<a class="amenity-value" href="${source}">${h(number(value))} 米 <span>源</span></a>`;
  const lowWarning = row.w_conf === '低' ? '<p class="result-caution"><strong>宽度可能偏差较大，按测量图为准。</strong></p>' : '';
  return `<section class="result-card position-index-card"><h2>地块位置索引</h2><p><strong>命中方式：</strong>${matchLabel} · <strong>距离：</strong>${h(matchDistance)}</p><dl class="result-facts"><div><dt>临街宽度</dt><dd>${frontage === null ? '待核' : `${h(frontage.toLocaleString('zh-Hans-CA', { maximumFractionDigits: 1 }))} 英尺（近似，${h(row.w_conf || '待核')}置信）`}</dd></div><div><dt>朝向</dt><dd>${h(row.front_orientation || '待核')}</dd></div><div><dt>角地</dt><dd>${yesNo(row.corner_lot)}</dd></div><div><dt>后巷</dt><dd>${yesNo(row.lane)}</dd></div><div><dt>临主干道</dt><dd>${yesNo(row.major_road)}</dd></div><div><dt>多户潜力初筛</dt><dd><a href="${DEVELOPMENT_SOURCES.multiplex}">${h(DEVELOPMENT_LABELS[row.devpot] || DEVELOPMENT_LABELS.review)} <span>源</span></a></dd></div><div><dt>Laneway 初筛</dt><dd><a href="${DEVELOPMENT_SOURCES.laneway}">${h(lanewayLabel(row))} <span>源</span></a></dd></div><div><dt>TOA 距离分层</dt><dd><a href="${DEVELOPMENT_SOURCES.toa}">${h(toaLabel(row))} <span>源</span></a></dd></div><div><dt>最近天车</dt><dd>${h(row.nearest_skytrain || '待核')}${finite(row.skytrain_m) === null ? '' : ` · ${h(number(row.skytrain_m))} 米`}</dd></div><div><dt>快线公交</dt><dd>${distance(row.r_m, AMENITY_SOURCES.rapid)}</dd></div><div><dt>公园点位</dt><dd>${distance(row.p_m, AMENITY_SOURCES.park)}</dd></div><div><dt>社区中心</dt><dd>${distance(row.c_m, AMENITY_SOURCES.community)}</dd></div><div><dt>公共图书馆</dt><dd>${distance(row.l_m, AMENITY_SOURCES.library)}</dd></div><div><dt>洪泛图层</dt><dd>${row.floodplain === true ? '命中' : row.floodplain === false ? '未命中' : '待核'}</dd></div><div><dt>文物图层</dt><dd>${row.heritage === true ? '命中' : row.heritage === false ? '未命中' : '待核'}</dd></div><div><dt>分区</dt><dd>${h(row.zoning || '待核')}</dd></div></dl>${lowWarning}<p class="result-caution">多户、laneway 与 TOA 都是初筛，不是可建性结论；开发许可以市府审批为准。设施距离为直线距离，不是步行路线；TOA 与设施距离按地块代表点计算，不替代法定地块边界判断；临街宽度与朝向为几何近似；洪泛或文物未命中不表示没有风险或限制。</p><p><a class="cta fallback" data-home-link href="${h(compareLink)}">检索同社区同宽度地块</a></p><p class="dataset-source">规则：<a href="${DEVELOPMENT_SOURCES.multiplex}">R1-1</a> · <a href="${DEVELOPMENT_SOURCES.multiplexGuide}">multiplex 指南</a> · <a href="${DEVELOPMENT_SOURCES.laneway}">laneway</a> · <a href="${DEVELOPMENT_SOURCES.toa}">TOA 法规</a>；数据：温西位置索引分片 · 不含逐户评估价</p></section>`;
}

function renderCommunity(result, communityData) {
  const { candidate, assessments, queryTime } = result;
  const community = communityData?.[candidate.localArea];
  if (!community) return `<section class="result-card"><h2>社区对照</h2><p>${h(candidate.localArea || '社区未识别')}不在本站温西十社区的现有范围内。</p>${sourceLine(DATASETS.addresses, queryTime)}</section>`;
  if (!assessments.ok || assessments.data.mode === 'none') return `<section class="result-card"><h2>社区对照</h2><p><a href="/veryvisa-com-site/home/vancouver-west/${h(community.slug)}/">${h(community.zh)} ${h(candidate.localArea)}</a>：本次没有可用于对照的评估值。</p>${sourceLine(DATASETS.assessments, queryTime, '社区汇总来源')}</section>`;
  const type = assessments.data.mode === 'strata' ? 'strata' : 'land';
  const subject = type === 'strata' ? assessments.data.median : assessments.data.total;
  const benchmark = finite(community[type]?.median);
  let comparison = '社区中位数暂不可用';
  if (benchmark && Number.isFinite(subject)) {
    const delta = (subject / benchmark - 1) * 100;
    comparison = Math.abs(delta) < 0.5 ? `与社区中位数 ${money(benchmark)} 接近` : `${delta > 0 ? '高于' : '低于'}社区中位数 ${money(benchmark)} 约 ${Math.abs(delta).toFixed(1)}%`;
  }
  const label = type === 'strata' ? '该楼单位评估中位数' : '该地块总评估价';
  return `<section class="result-card"><h2>社区对照</h2><p>所在社区：<a href="/veryvisa-com-site/home/vancouver-west/${h(community.slug)}/">${h(community.zh)} ${h(candidate.localArea)}</a>。</p><p>${h(label)}${h(comparison)}。</p><p class="result-caution">这里只与站内同类型物业的二〇二六年社区中位数比较，不是市场估价。</p>${sourceLine(DATASETS.assessments, queryTime, `社区汇总来源（核对 ${community[type]?.checkedAt || '待补'}）`)}</section>`;
}

function renderSchools(result, schoolData) {
  const point = result.position || result.candidate.point, schools = Array.isArray(schoolData?.schools) ? schoolData.schools : [];
  const nearby = schools.map((school) => ({ ...school, metres: distanceMetres(point, school) })).filter((school) => school.metres <= 800).sort((a, b) => a.metres - b.metres);
  const list = nearby.length ? `<ul class="nearby-school-list">${nearby.map((school) => `<li><a data-home-link href="/veryvisa-com-site/home/schools/${h(school.slug)}/">${h(school.name)}</a><span>${school.level === 'secondary' ? '中学' : '小学'} · 直线约 ${h(Math.round(school.metres))} 米</span></li>`).join('')}</ul>` : '<p>位置索引点位八百米内未见本站收录的常规公立小学或中学。</p>';
  return `<section class="result-card"><h2>八百米内的公立学校</h2>${list}<p class="result-caution">周边≠学区。这里按学校点位与地块位置计算直线距离，不表示地址所属学校。</p><p><a href="${h(schoolData?.official_locator || 'https://www.vsb.bc.ca/your-school-catchment')}">用 VSB 官方 School Locator 核对地址</a></p></section>`;
}

const PERMIT_CATEGORY_LABELS = { demolition: '拆除', new_building: '新建', alteration: '改建', addition: '加建', plumbing: '给排水', electrical: '电气', oil_tank: '油罐' };
const PERMIT_SEARCH = 'https://plposweb.vancouver.ca/Public/Default.aspx?PossePresentation=PermitSearchByNumber';

export function renderEraCard(result, eraData = { eras: [] }) {
  const assessment = result.assessments?.ok ? result.assessments.data : null;
  const isStrata = assessment?.mode === 'strata';
  const isLand = assessment?.mode === 'land';
  const knownType = isStrata || isLand || Number.isInteger(Number(result.position?.year_built)) && result.position?.year_built;
  if (!knownType) return '<section class="result-card era-card"><h2>年代档案</h2><p>这次没能判定房型和登记建年。请按房型打开年代档：</p><p class="era-entry"><a href="/veryvisa-com-site/home/era/">独立屋年代档</a><a href="/veryvisa-com-site/home/era/strata/">公寓与联排年代档</a></p></section>';
  const year = isStrata ? assessment.yearBuilt : isLand ? assessment.yearBuilt : result.position?.year_built;
  const eras = isStrata ? (eraData.strata || []) : (eraData.eras || []);
  const base = isStrata ? '/veryvisa-com-site/home/era/strata/' : '/veryvisa-com-site/home/era/';
  const typeLabel = isStrata ? '公寓与联排（分层产权）' : '独立屋';
  const era = eraForYear(eras, year);
  if (!era) return `<section class="result-card era-card"><h2>年代档案 · ${h(typeLabel)}</h2><p>登记建年未公布，暂时不能归档；请从许可、卖方披露和验房资料继续核对。</p><p class="era-entry"><a href="${base}">打开${h(typeLabel)}年代档</a></p></section>`;
  const groups = ERA_FIELDS.map((field) => {
    const items = (era[field] || []).filter((item) => item.status === 'verified');
    return items.length ? `<section><h3>${h(ERA_FIELD_LABELS[field])}</h3><ul>${items.map((item) => `<li>${h(eraItemText(item))} <a href="${h(item.source_url)}" title="${h(item.source_title)}">出处</a></li>`).join('')}</ul></section>` : '';
  }).join('');
  const improvementYear = isLand ? assessment.bigImprovementYear : isStrata ? null : result.position?.big_improvement_year;
  const improvement = improvementYear ? `<p class="result-caution">${h(improvementYear)} 年有过大修，大修不等于电线、水管、屋顶都换过，请看许可记录。</p>` : '';
  const permits = !isStrata && Array.isArray(result.position?.permits) ? result.position.permits : [];
  const permitTimeline = permits.length ? `<section class="era-permits"><h3>索引许可时间线</h3><ul>${permits.map((permit) => {
    const [permitYear, category, permitNumber] = Array.isArray(permit) ? permit : [permit.year, permit.category, permit.permit_number];
    return `<li>${h(permitYear || '年份未公布')} · ${h(PERMIT_CATEGORY_LABELS[category] || category || '类别待核')} · <a href="${PERMIT_SEARCH}">${h(permitNumber || '许可号未公布')}</a></li>`;
  }).join('')}</ul><p class="result-caution">开放索引只覆盖其数据年份；许可签发不等于工程已经完工验收。按许可号打开市府查询继续核对。</p></section>` : '';
  const scopeNote = isStrata ? '按这栋楼各单位登记的建成年份归档；这是该年代分层产权楼的核对清单，不是对这栋楼或任何单元的结论。如果这里其实是各户有自己地块的独立屋或联排（空地分层产权，bare land strata），房子通常不在法团保险里，口径更接近独立屋，请同时看独立屋年代档。' : '按登记建年归档；这是该年代的核对清单，不是对单栋房屋的结论。';
  const other = isStrata ? '<a href="/veryvisa-com-site/home/era/">独立屋年代档</a>' : '<a href="/veryvisa-com-site/home/era/strata/">公寓与联排年代档</a>';
  return `<section class="result-card era-card"><p class="eyebrow">${h(era.id)} · ${h(typeLabel)}</p><h2><a href="${base}#${eraAnchor(era.id)}">${h(era.label)}</a></h2><p>${scopeNote}</p>${improvement}${permitTimeline}<div class="era-card-groups">${groups}</div><p class="metadata">房型判断来自评估数据集的产权类型；判断不对时，可改看${other}。</p></section>`;
}

export function renderResult(result, communityData = {}, schoolData = {}, eraData = { eras: [] }) {
  if (result.status === 'invalid') return `<div class="result-message result-error" role="alert">${h(result.message)}</div>`;
  if (result.status === 'error') return `<div class="result-message result-error" role="alert"><p>市府数据接口暂时不可用。</p><p><a href="${datasetUrl(DATASETS.addresses)}">直接打开市府物业地址数据集</a></p></div>`;
  if (result.status === 'no-results') return `<div class="result-message"><h2>没有找到匹配地址</h2><p>请只填门牌号与街名，并检查东西方向、街道类型和拼写。</p>${sourceLine(DATASETS.addresses, result.queryTime)}</div>`;
  if (result.status === 'choose') return `<section class="result-card"><h2>请选择地址</h2><p>市府地址数据返回了多个匹配项：</p><div class="address-choices">${result.candidates.map((candidate, index) => `<button type="button" data-address-choice="${index}">${h(candidate.civicNumber)} ${h(candidate.street)} · ${h(candidate.localArea || '社区未注明')}</button>`).join('')}</div>${sourceLine(DATASETS.addresses, result.queryTime)}</section>`;
  const c = result.candidate;
  return `<div class="address-result-heading"><p class="eyebrow">查询结果</p><h2>${h(c.civicNumber)} ${h(c.street)}</h2><p>市府地块坐标号：${h(c.pcoord)} · 社区：${h(c.localArea || '未注明')}${c.point ? ` · 坐标：${h(c.point.lat.toFixed(6))}, ${h(c.point.lon.toFixed(6))}` : ''}</p>${sourceLine(DATASETS.addresses, result.queryTime)}</div>${renderPosition(result)}${renderSchools(result, schoolData)}${renderAssessment(result.assessments, result.queryTime)}${renderEraCard(result, eraData)}${renderPermits(result.permits, result.queryTime)}${renderHeritage(result.heritage, result.queryTime)}${renderFlood(result.flood, result.queryTime)}${renderCommunity(result, communityData)}`;
}

function readCommunityData(documentRef) {
  try { return JSON.parse(documentRef.getElementById('address-check-community-data')?.textContent || '{}'); } catch { return {}; }
}
function readSchoolData(documentRef) {
  try { return JSON.parse(documentRef.getElementById('address-check-school-data')?.textContent || '{}'); } catch { return {}; }
}
function readEraData(documentRef) {
  try { return JSON.parse(documentRef.getElementById('home-era-profiles')?.textContent || '{"eras":[]}'); } catch { return { eras: [] }; }
}
function readSiteData(documentRef) {
  try { return JSON.parse(documentRef.getElementById('home-site-layers')?.textContent || '{"cities":{}}'); } catch { return { cities: {} }; }
}
function readMetroData(documentRef) {
  try { return JSON.parse(documentRef.getElementById('home-metro-era')?.textContent || '{"cities":{},"referrals":[]}'); } catch { return { cities: {}, referrals: [] }; }
}
// 城市分支：'vancouver' 走市府实时接口；素里、新西敏、北温区、满地宝查静态分桶；其余城市只出调档卡。
export function cityMode(code, metroData = { cities: {}, referrals: [] }) {
  if (!code || code === 'vancouver') return { mode: 'vancouver' };
  if (metroData.cities?.[code]) return { mode: 'metro', city: metroData.cities[code] };
  const referral = (metroData.referrals || []).find((city) => city.code === code);
  return referral ? { mode: 'referral', city: referral } : { mode: 'vancouver' };
}
const METRO_EXAMPLES = { sur: [['12355', '21A Ave'], ['10617', '132A St']], nw: [['1009', 'Howay St'], ['10', 'Laguna Crt']], dnv: [['1002', 'Canyon Blvd'], ['3825', 'Cates Landing Way']], mr: [['11567', 'River Wynd']] };
// 没有逐址建年、但有许可区或管网分桶的城市（填门牌即查两栏）。
const SITE_EXAMPLES = { coq: [['1322', 'Genest Way'], ['2500', 'Arundel Lane']], bby: [['4728', 'Brentwood Dr']], wv: [['1005', '13th St']] };
const VANCOUVER_EXAMPLES = [['453', 'W 12th Ave'], ['2250', 'W 10th Ave'], ['5515', 'Boundary Road']];
function cacheKey(input) { const clean = validateInput(input); return `vv-address-check:v${CACHE_VERSION}:${clean.civicNumber}|${clean.streetKey}`; }
function readCache(storage, input) {
  try { const parsed = JSON.parse(storage.getItem(cacheKey(input))); return parsed?.version === CACHE_VERSION ? parsed.result : null; } catch { return null; }
}
function writeCache(storage, input, result) {
  if (result.status !== 'complete' || [result.assessments, result.permits, result.heritage, result.flood].some((block) => !block.ok)) return;
  try { storage.setItem(cacheKey(input), JSON.stringify({ version: CACHE_VERSION, result })); } catch { /* sessionStorage may be disabled */ }
}

export function initAddressCheck(documentRef = document, windowRef = window) {
  const form = documentRef.querySelector('[data-address-form]'), output = documentRef.querySelector('[data-address-output]'), status = documentRef.querySelector('[data-address-status]');
  if (!form || !output) return;
  const communityData = readCommunityData(documentRef);
  const schoolData = readSchoolData(documentRef);
  const eraData = readEraData(documentRef);
  const metroData = readMetroData(documentRef);
  const siteData = readSiteData(documentRef);
  const citySelect = form.elements.city;
  let lastInput = null, pendingCandidates = [], pendingMetro = null, siteToken = 0;
  // 「限制与风险」「管网」两栏：结果先出，占位块随后按同一门牌取一桶填上；新查询开始后旧的回填作废。
  const attachSiteLayers = async (code, input, addressKnown = false) => {
    const token = ++siteToken;
    const slot = output.querySelector('[data-site-layers]'); if (!slot) return;
    const results = await lookupSiteLayers(input, code, siteData);
    if (token !== siteToken) return;
    slot.innerHTML = renderSiteLayers(results, code, siteData, { addressKnown });
  };
  const show = (result) => { output.innerHTML = renderResult(result, communityData, schoolData, eraData); pendingCandidates = result.candidates || []; };
  const setBusy = (busy, message = '') => { form.querySelector('button[type="submit"]').disabled = busy; form.setAttribute('aria-busy', String(busy)); if (status) status.textContent = message; };
  const currentCity = () => cityMode(citySelect?.value, metroData);
  const showReferral = (city, input = null) => {
    const filled = input && String(input.civicNumber || '').trim() && String(input.street || '').trim() && siteLayersFor(siteData, city.code).length;
    output.innerHTML = `${renderReferralCard(city)}${renderOverlayReferral(city.code, siteData)}${filled ? siteLayerPlaceholder(city.code, siteData) : ''}`;
    setBusy(false, `${city.zh}没有开放逐址建年数据，已列出调档入口。`);
    if (filled) attachSiteLayers(city.code, input);
  };
  const runMetro = async (input, city) => {
    setBusy(true, `正在载入${city.zh}年代索引分片…`);
    const result = await lookupMetroAddress(input, city);
    pendingMetro = result.status === 'metro-choose' ? result : null;
    const site = result.status === 'metro' || result.status === 'metro-none' ? siteLayerPlaceholder(city.code, siteData) : '';
    output.innerHTML = `${renderMetroResult(result, metroData.cities, eraData)}${site}`;
    setBusy(false, result.status === 'metro' ? '查询完成。' : '请查看下方提示。');
    if (site) attachSiteLayers(city.code, result.status === 'metro' ? { civicNumber: result.record.civic, street: result.record.street_key } : input, result.status === 'metro');
  };
  const showVancouver = (result) => {
    show(result);
    if (result.status !== 'complete') return;
    const site = siteLayerPlaceholder('vw', siteData);
    if (!site) return;
    output.insertAdjacentHTML('beforeend', site);
    attachSiteLayers('vw', { civicNumber: result.candidate.civicNumber, street: result.candidate.street, localArea: result.candidate.localArea }, true);
  };
  const run = async (input) => {
    lastInput = input;
    const cached = readCache(windowRef.sessionStorage, input);
    if (cached) { showVancouver(cached); setBusy(false, '已显示本次浏览会话中的缓存结果。'); return; }
    setBusy(true, '正在查询温哥华市开放数据…');
    const rawResult = await lookupAddress(input);
    const positionMatch = rawResult.status === 'complete' ? await loadPositionMatch(rawResult, communityData) : null;
    const result = rawResult.status === 'complete' ? { ...rawResult, position: positionMatch.record, positionMatch } : rawResult;
    showVancouver(result); writeCache(windowRef.sessionStorage, input, result);
    setBusy(false, result.status === 'complete' ? '查询完成。' : '请查看下方提示。');
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const choice = currentCity(), input = { civicNumber: form.elements.civicNumber.value, street: form.elements.street.value };
    if (choice.mode === 'referral') return showReferral(choice.city, input);
    if (choice.mode === 'metro') return runMetro(input, choice.city);
    return run(input);
  });
  output.addEventListener('submit', (event) => {
    const yearForm = event.target.closest('[data-era-year-form]'); if (!yearForm) return;
    event.preventDefault();
    const box = yearForm.parentElement.querySelector('[data-era-year-output]');
    if (box) box.innerHTML = renderYearEra(yearForm.elements.year.value, yearForm.elements.type.value, eraData);
  });
  output.addEventListener('click', async (event) => {
    const metroButton = event.target.closest('[data-metro-choice]');
    if (metroButton && pendingMetro) {
      const record = pendingMetro.candidates[Number(metroButton.dataset.metroChoice)]; if (!record) return;
      const code = pendingMetro.city, site = siteLayerPlaceholder(code, siteData);
      output.innerHTML = `${renderMetroResult({ status: 'metro', city: code, method: 'exact', record }, metroData.cities, eraData)}${site}`;
      pendingMetro = null;
      if (site) attachSiteLayers(code, { civicNumber: record.civic, street: record.street_key }, true);
      return;
    }
    const button = event.target.closest('[data-address-choice]'); if (!button) return;
    const candidate = pendingCandidates[Number(button.dataset.addressChoice)]; if (!candidate) return;
    setBusy(true, '正在查询所选地块…');
    const rawResult = await fetchAddressDetails(candidate);
    const positionMatch = await loadPositionMatch(rawResult, communityData);
    const result = { ...rawResult, position: positionMatch.record, positionMatch };
    showVancouver(result); if (lastInput) writeCache(windowRef.sessionStorage, lastInput, result);
    setBusy(false, '查询完成。');
  });
  const exampleBox = documentRef.querySelector('[data-address-examples]');
  let examples = VANCOUVER_EXAMPLES;
  const drawExamples = () => {
    const choice = currentCity();
    examples = choice.mode === 'metro' ? (METRO_EXAMPLES[choice.city.code] || []) : choice.mode === 'referral' ? (SITE_EXAMPLES[choice.city.code] || []) : VANCOUVER_EXAMPLES;
    if (exampleBox) exampleBox.innerHTML = examples.map(([civicNumber, street], index) => `<button type="button" data-address-example="${index}">${h(civicNumber)} ${h(street)}</button>`).join('');
  };
  if (exampleBox) {
    drawExamples();
    exampleBox.addEventListener('click', (event) => { const button = event.target.closest('[data-address-example]'); if (!button) return; const [civicNumber, street] = examples[Number(button.dataset.addressExample)]; form.elements.civicNumber.value = civicNumber; form.elements.street.value = street; form.elements.street.focus(); });
  }
  citySelect?.addEventListener('change', () => {
    drawExamples();
    const choice = currentCity();
    const required = choice.mode !== 'referral';
    form.elements.civicNumber.required = required; form.elements.street.required = required;
    if (choice.mode === 'referral') showReferral(choice.city);
  });
}

if (typeof document !== 'undefined') initAddressCheck();

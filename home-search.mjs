import { decodeLocationShard, distanceMetres } from './location-index.mjs';
import { DEVELOPMENT_LABELS, DEVELOPMENT_SOURCES, lanewayLabel, toaBand, toaLabel } from './home-development.mjs';
import { eraAnchor, eraForYear, hasImprovementYear } from './home-era.mjs';

const API = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/property-tax-report/records';
const BATCH_SIZE = 50;
const RESULT_LIMIT = 200;
const RENDER_CHUNK = 24;
const AMENITY_SOURCES = {
  rapid: 'https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data',
  park: 'https://opendata.vancouver.ca/explore/dataset/parks-polygon-representation/',
  community: 'https://opendata.vancouver.ca/explore/dataset/community-centres/',
  library: 'https://opendata.vancouver.ca/explore/dataset/libraries/',
};

export const slugifySchool = (name) => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const h = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const finite = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const money = (value) => new Intl.NumberFormat('zh-Hans-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(value);
const number = (value, digits = 0) => new Intl.NumberFormat('zh-Hans-CA', { maximumFractionDigits: digits }).format(value);

export const decodeShard = decodeLocationShard;
export { distanceMetres };

const inRange = (value, min, max) => {
  const n = finite(value), low = finite(min), high = finite(max);
  if ((low !== null || high !== null) && n === null) return false;
  return (low === null || n >= low) && (high === null || n <= high);
};
const yesNo = (actual, wanted) => !wanted || (wanted === 'yes' ? actual === true : actual === false);
export function filterRecords(records, filters) {
  return records.filter((row) => {
    if (filters.local && row.local_area !== filters.local) return false;
    if (filters.eras?.length && !filters.eras.includes(eraForYear(filters.eraProfiles || [], row.year_built)?.id)) return false;
    if (filters.hasImprovement && !hasImprovementYear(row)) return false;
    if (filters.nearSchool) {
      const radius = finite(filters.r) ?? 800;
      if (!Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lon)) || distanceMetres(filters.nearSchool, row) > radius) return false;
    }
    if (!inRange(row.lot_area_sqft, filters.lotMin, filters.lotMax)) return false;
    if (!inRange(row.frontage_ft_approx, filters.frontageMin, filters.frontageMax)) return false;
    if (filters.orient && row.front_orientation !== filters.orient) return false;
    if (!yesNo(row.corner_lot, filters.corner) || !yesNo(row.lane, filters.lane) || !yesNo(row.major_road, filters.major) || !yesNo(row.floodplain, filters.flood) || !yesNo(row.heritage, filters.heritage)) return false;
    if (filters.skytrainMax && !inRange(row.skytrain_m, null, filters.skytrainMax)) return false;
    if (filters.rapidMax && !inRange(row.r_m, null, filters.rapidMax)) return false;
    if (filters.parkMax && !inRange(row.p_m, null, filters.parkMax)) return false;
    if (filters.communityMax && !inRange(row.c_m, null, filters.communityMax)) return false;
    if (filters.libraryMax && !inRange(row.l_m, null, filters.libraryMax)) return false;
    if (filters.zoning && row.zoning !== filters.zoning) return false;
    if (filters.devpot && row.devpot !== filters.devpot) return false;
    if (filters.toaTier && String(toaBand(row.toa_tier) || '') !== filters.toaTier) return false;
    if (filters.toaStatus && (row.toa_tier == null || (filters.toaStatus === 'planned') !== (row.toa_planned === true))) return false;
    return true;
  }).slice(0, RESULT_LIMIT);
}

export function widthConfidenceNote(records, filters = {}) {
  const hasWidthFilter = finite(filters.frontageMin) !== null || finite(filters.frontageMax) !== null;
  if (!hasWidthFilter) return '设定宽度后显示低置信地块数。';
  const count = records.filter((row) => row.w_conf === '低').length;
  return `含低置信地块 ${count.toLocaleString('zh-Hans-CA')} 块`;
}

const fieldMap = {
  local: 'local', near: 'near', r: 'r', lotMin: 'lot_min', lotMax: 'lot_max', frontageMin: 'frontage_min', frontageMax: 'frontage_max',
  orient: 'orient', corner: 'corner', lane: 'lane', major: 'major', skytrainMax: 'skytrain_max', rapidMax: 'rapid_max', parkMax: 'park_max', communityMax: 'community_max', libraryMax: 'library_max', flood: 'flood', heritage: 'heritage', zoning: 'zoning',
  devpot: 'devpot', toaTier: 'toa_tier', toaStatus: 'toa_status',
  priceMin: 'price_min', priceMax: 'price_max',
};

function formFilters(form, schoolsBySlug) {
  const filters = Object.fromEntries(Object.keys(fieldMap).map((key) => [key, String(form.elements[key]?.value || '').trim()]));
  filters.eras = [...form.querySelectorAll('input[name="era"]:checked')].map((input) => input.value);
  filters.hasImprovement = form.elements.hasImprovement?.checked === true;
  filters.nearSchool = schoolsBySlug.get(filters.near);
  return filters;
}

function syncUrl(form, windowRef) {
  const url = new URL(windowRef.location.href);
  for (const [key, param] of Object.entries(fieldMap)) {
    const value = String(form.elements[key]?.value || '').trim();
    if (value) url.searchParams.set(param, value); else url.searchParams.delete(param);
  }
  url.searchParams.delete('era');
  for (const input of form.querySelectorAll('input[name="era"]:checked')) url.searchParams.append('era', input.value);
  if (form.elements.hasImprovement?.checked) url.searchParams.set('improved', '1'); else url.searchParams.delete('improved');
  windowRef.history.replaceState(null, '', url);
}

function hydrateForm(form, windowRef) {
  const params = new URLSearchParams(windowRef.location.search);
  for (const [key, param] of Object.entries(fieldMap)) if (form.elements[key]) form.elements[key].value = params.get(param) || '';
  const eras = new Set(params.getAll('era'));
  for (const input of form.querySelectorAll('input[name="era"]')) input.checked = eras.has(input.value);
  if (form.elements.hasImprovement) form.elements.hasImprovement.checked = params.get('improved') === '1';
}

function unique(records, field) { return [...new Set(records.map((row) => row[field]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'en')); }
function option(value, label = value) { return `<option value="${h(value)}">${h(label)}</option>`; }
function fillSelect(select, values, map = (value) => [value, value]) {
  const first = select.querySelector('option')?.outerHTML || '<option value="">不限</option>';
  select.innerHTML = first + values.map((value) => option(...map(value))).join('');
}

function recordCard(row, key, eraProfiles = []) {
  const pid = row.pid ? ` data-pid="${h(row.pid)}" data-price-state="pending"` : ' data-price-state="missing"';
  const assessment = row.pid ? '等待市府实时数据' : '市府索引没有可查询编号';
  const distance = (value, source) => finite(value) === null ? '待核' : `<a class="amenity-value" href="${source}">${number(value)} 米 <span>源</span></a>`;
  const era = eraForYear(eraProfiles, row.year_built);
  const eraLabel = era ? `<p><strong>年代档：</strong><a href="/veryvisa-com-site/home/era/#${eraAnchor(era.id)}">${h(era.label)}</a></p>` : '<p><strong>年代档：</strong>建年未登记</p>';
  const widthWarning = eraLabel + (row.w_conf === '低' ? '<p class="result-caution">宽度可能偏差较大，按测量图为准。</p>' : '');
  return `<article class="search-result" data-result-key="${h(key)}"${pid}><div><p class="eyebrow">${h(row.local_area)}</p><h3>${h(row.address || '市府地址资料暂缺')}</h3></div><dl><div><dt>地块</dt><dd>${number(row.lot_area_sqft)} 平方英尺</dd></div><div><dt>临街宽度</dt><dd>${number(row.frontage_ft_approx, 1)} 英尺（近似，${h(row.w_conf || '待核')}置信）</dd></div><div><dt>朝向</dt><dd>${h(row.front_orientation || '待核')}</dd></div><div><dt>分区</dt><dd>${h(row.zoning || '待核')}</dd></div><div><dt>多户潜力初筛</dt><dd><a href="${DEVELOPMENT_SOURCES.multiplex}">${h(DEVELOPMENT_LABELS[row.devpot] || DEVELOPMENT_LABELS.review)} <span>源</span></a></dd></div><div><dt>Laneway 初筛</dt><dd><a href="${DEVELOPMENT_SOURCES.laneway}">${h(lanewayLabel(row))} <span>源</span></a></dd></div><div><dt>TOA 初筛</dt><dd><a href="${DEVELOPMENT_SOURCES.toa}">${h(toaLabel(row))} <span>源</span></a></dd></div><div><dt>天车</dt><dd>${h(row.nearest_skytrain || '待核')} · ${number(row.skytrain_m)} 米</dd></div><div><dt>快线公交</dt><dd>${distance(row.r_m, AMENITY_SOURCES.rapid)}</dd></div><div><dt>公园点位</dt><dd>${distance(row.p_m, AMENITY_SOURCES.park)}</dd></div><div><dt>社区中心</dt><dd>${distance(row.c_m, AMENITY_SOURCES.community)}</dd></div><div><dt>公共图书馆</dt><dd>${distance(row.l_m, AMENITY_SOURCES.library)}</dd></div><div><dt>政府评估价</dt><dd data-assessment>${assessment}</dd></div></dl><p class="result-flags">${row.corner_lot ? '角地 · ' : ''}${row.lane ? '有后巷 · ' : ''}${row.major_road ? '临主干道 · ' : ''}${row.floodplain ? '洪泛图层命中 · ' : ''}${row.heritage ? '文物图层命中' : ''}</p>${widthWarning}<p class="result-caution">多户、laneway 与 TOA 都是初筛，不是可建性结论；开发许可以市府逐址审批为准。设施与 TOA 距离为地块代表点直线距离，不是法定地块边界判断或步行路线。</p></article>`;
}

function assessmentUrl(pids) {
  const url = new URL(API);
  const values = pids.map((pid) => `"${String(pid).replaceAll('"', '\\"')}"`).join(',');
  url.searchParams.set('where', `report_year=2026 and pid in (${values})`);
  url.searchParams.set('select', 'pid,current_land_value,current_improvement_value,report_year');
  url.searchParams.set('limit', '100');
  return url;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchWithBackoff(url, fetchImpl, metrics) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = performance.now();
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      metrics.requests += 1; metrics.elapsedMs += performance.now() - started;
      if (response.ok) return response.json();
      last = new Error(String(response.status));
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) { last = error; metrics.requests += 1; metrics.elapsedMs += performance.now() - started; }
    if (attempt < 3) { metrics.retries += 1; await wait(600 * (2 ** attempt)); }
  }
  throw last || new Error('city api unavailable');
}

export async function fetchAssessmentBatch(pids, { fetchImpl = fetch, metrics = { requests: 0, retries: 0, elapsedMs: 0 } } = {}) {
  if (!pids.length) return new Map();
  if (pids.length > BATCH_SIZE) throw new RangeError('assessment batch exceeds 50');
  const json = await fetchWithBackoff(assessmentUrl(pids), fetchImpl, metrics);
  const prices = new Map();
  for (const row of json.results || []) {
    const land = finite(row.current_land_value), improvement = finite(row.current_improvement_value);
    if (land !== null && improvement !== null) prices.set(String(row.pid), land + improvement);
  }
  metrics.returned = (metrics.returned || 0) + prices.size;
  return prices;
}

function initAssessmentLoader(results, getFilters, updateCount, windowRef) {
  const queued = new Set(), loaded = new Set(); let timer = null, running = false;
  const metrics = windowRef.__vvSearchMetrics = { requests: 0, retries: 0, elapsedMs: 0, returned: 0, batchSizes: [] };
  const applyPriceVisibility = (card, filters) => {
    if (card.dataset.priceState !== 'loaded') { card.hidden = false; return; }
    const price = Number(card.dataset.price), min = finite(filters.priceMin), max = finite(filters.priceMax);
    card.hidden = (min !== null && price < min) || (max !== null && price > max);
  };
  const flush = async () => {
    if (running) return; running = true; timer = null;
    while (queued.size) {
      const pids = [...queued].slice(0, BATCH_SIZE); pids.forEach((pid) => queued.delete(pid)); metrics.batchSizes.push(pids.length);
      try {
        const prices = await fetchAssessmentBatch(pids, { metrics });
        for (const pid of pids) {
          const cards = results.querySelectorAll(`[data-pid="${CSS.escape(pid)}"]`);
          for (const card of cards) {
            const price = prices.get(pid), output = card.querySelector('[data-assessment]');
            if (Number.isFinite(price)) { card.dataset.priceState = 'loaded'; card.dataset.price = String(price); output.textContent = money(price); }
            else { card.dataset.priceState = 'missing'; output.textContent = '市府本次未返回评估价'; }
            applyPriceVisibility(card, getFilters());
          }
          loaded.add(pid);
        }
      } catch {
        for (const pid of pids) {
          for (const card of results.querySelectorAll(`[data-pid="${CSS.escape(pid)}"]`)) {
            card.dataset.priceState = 'error'; card.querySelector('[data-assessment]').textContent = '市府接口暂不可用，稍后再试';
          }
          loaded.add(pid);
        }
      }
      updateCount();
    }
    running = false;
  };
  const queueCard = (card) => {
    const pid = card.dataset.pid; if (!pid || loaded.has(pid)) return;
    queued.add(pid); if (!timer) timer = setTimeout(flush, 120);
  };
  const observer = 'IntersectionObserver' in windowRef ? new windowRef.IntersectionObserver((entries) => entries.filter((entry) => entry.isIntersecting).forEach((entry) => queueCard(entry.target)), { rootMargin: '500px 0px' }) : null;
  return {
    observe(card) { if (observer) observer.observe(card); else queueCard(card); },
    refilter() { results.querySelectorAll('[data-pid]').forEach((card) => applyPriceVisibility(card, getFilters())); updateCount(); },
    disconnect() { observer?.disconnect(); clearTimeout(timer); },
  };
}

async function loadRecords(files, fetchImpl) {
  const shards = await Promise.all(files.map(async (file) => {
    const response = await fetchImpl(`/veryvisa-com-site/home/data/${encodeURIComponent(file)}`); if (!response.ok) throw new Error(file); return response.json();
  }));
  return shards.flatMap(decodeShard);
}

function readJsonScript(documentRef, id, fallback) { try { return JSON.parse(documentRef.getElementById(id)?.textContent || JSON.stringify(fallback)); } catch { return fallback; } }

export async function initHomeSearch(documentRef = document, windowRef = window, fetchImpl = fetch) {
  const form = documentRef.querySelector('[data-home-search-form]'), results = documentRef.querySelector('[data-home-search-results]'), status = documentRef.querySelector('[data-home-search-status]');
  if (!form || !results) return;
  const widthStatus = documentRef.createElement('p');
  widthStatus.className = 'metadata'; widthStatus.dataset.widthConfidence = '';
  widthStatus.textContent = '设定宽度后显示低置信地块数。';
  form.elements.frontageMax?.closest('.filter-pair')?.after(widthStatus);
  hydrateForm(form, windowRef); status.textContent = '正在读取温西地块索引…';
  let records;
  try { records = await loadRecords(readJsonScript(documentRef, 'home-search-files', []), fetchImpl); } catch { status.textContent = '检索数据暂不可用，请稍后再试。'; return; }
  const eraProfiles = readJsonScript(documentRef, 'home-era-profiles', { eras: [] }).eras || [];
  const improvementControl = form.querySelector('[data-improvement-filter]');
  if (improvementControl) improvementControl.hidden = !records.some((row) => Object.hasOwn(row, 'big_improvement_year'));
  const schools = readJsonScript(documentRef, 'home-search-schools', []), schoolsBySlug = new Map(schools.map((school) => [school.slug, school]));
  fillSelect(form.elements.local, unique(records, 'local_area'));
  fillSelect(form.elements.near, schools, (school) => [school.slug, school.name]);
  fillSelect(form.elements.orient, unique(records, 'front_orientation'));
  fillSelect(form.elements.zoning, unique(records, 'zoning'));
  hydrateForm(form, windowRef);
  let filtered = [], rendered = 0, loader;
  const currentFilters = () => ({ ...formFilters(form, schoolsBySlug), eraProfiles });
  const countVisible = () => results.querySelectorAll('.search-result:not([hidden])').length;
  const updateCount = () => {
    const pending = results.querySelectorAll('[data-price-state="pending"]').length;
    status.textContent = `静态条件命中 ${filtered.length.toLocaleString('zh-Hans-CA')} 套，已显示 ${countVisible().toLocaleString('zh-Hans-CA')} 套${pending ? `；${pending.toLocaleString('zh-Hans-CA')} 套评估价待查` : ''}。`;
    widthStatus.textContent = widthConfidenceNote(filtered, currentFilters());
  };
  const append = () => {
    const slice = filtered.slice(rendered, rendered + RENDER_CHUNK); if (!slice.length) return;
    const shell = documentRef.createElement('div'); shell.innerHTML = slice.map((row, index) => recordCard(row, rendered + index, eraProfiles)).join('');
    [...shell.children].forEach((card) => { results.append(card); loader.observe(card); }); rendered += slice.length; updateCount();
  };
  const render = () => {
    loader?.disconnect(); results.innerHTML = ''; rendered = 0; filtered = filterRecords(records, currentFilters());
    loader = initAssessmentLoader(results, currentFilters, updateCount, windowRef);
    if (!filtered.length) results.innerHTML = '<div class="panel"><h2>没有匹配地块</h2><p>请放宽社区、学校、设施距离、地块或风险条件后再试。</p></div>';
    else append(); updateCount();
  };
  form.addEventListener('input', () => { syncUrl(form, windowRef); render(); });
  form.addEventListener('change', () => { syncUrl(form, windowRef); render(); });
  documentRef.querySelector('[data-search-more]')?.addEventListener('click', append);
  const sentinel = documentRef.querySelector('[data-search-sentinel]');
  if (sentinel && 'IntersectionObserver' in windowRef) new windowRef.IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) append(); }, { rootMargin: '400px' }).observe(sentinel);
  render();
}

if (typeof document !== 'undefined') initHomeSearch();

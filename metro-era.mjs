// 大温其他城市的地址年代卡：素里、新西敏、北温区（建年）与满地宝（2013 年起许可史，建年未开放）读静态分桶索引（构建时由 scripts/metro_era.mjs 从 bc-home-advisor 生成），
// 其余没有开放数据的城市只给官方调档入口，并让读者自己填建年看年代档。
// 同一个模块在浏览器（地址页）和 node（构建、测试）里用：分桶键、门牌规范化两边必须是同一份代码。
import { ERA_FIELDS, ERA_FIELD_LABELS, eraAnchor, eraForYear } from './home-era.mjs';

// 各档通用条（item.ref）在地址卡里标「各档通用」，与 home-era.mjs::eraItemText 同口径；本地写一份，免得本模块依赖那份还在改的导出。
const eraItemText = (item) => (item?.ref ? `各档通用：${item.text}` : item?.text);

export const METRO_DATA_ROOT = '/veryvisa-com-site/home/era-data';

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// ---------------------------------------------------------------- 门牌规范化
const SUFFIX = new Map([
  ['AVENUE', 'AV'], ['AVE', 'AV'], ['AV', 'AV'], ['STREET', 'ST'], ['ST', 'ST'], ['ROAD', 'RD'], ['RD', 'RD'],
  ['BOULEVARD', 'BLVD'], ['BLVD', 'BLVD'], ['DRIVE', 'DR'], ['DR', 'DR'], ['COURT', 'CT'], ['CRT', 'CT'], ['CT', 'CT'],
  ['PLACE', 'PL'], ['PL', 'PL'], ['LANE', 'LN'], ['LN', 'LN'], ['HIGHWAY', 'HWY'], ['HWY', 'HWY'],
  ['TERRACE', 'TER'], ['TERR', 'TER'], ['TER', 'TER'], ['CRESCENT', 'CR'], ['CRES', 'CR'], ['CRESC', 'CR'], ['CR', 'CR'],
  ['SQUARE', 'SQ'], ['SQ', 'SQ'], ['PARKWAY', 'PKY'], ['PKWY', 'PKY'], ['PKY', 'PKY'], ['CIRCLE', 'CIR'], ['CIR', 'CIR'],
  ['WAY', 'WAY'], ['GATE', 'GATE'], ['CLOSE', 'CLOSE'], ['ROW', 'ROW'], ['MEWS', 'MEWS'], ['TRAIL', 'TRL'], ['TRL', 'TRL'],
  ['GREEN', 'GRN'], ['GRN', 'GRN'], ['WALK', 'WALK'], ['QUAY', 'QUAY'],
]);
const SUFFIX_CODES = new Set(SUFFIX.values());
const DIRECTIONS = new Map([['WEST', 'W'], ['W', 'W'], ['EAST', 'E'], ['E', 'E'], ['NORTH', 'N'], ['N', 'N'], ['SOUTH', 'S'], ['S', 'S']]);
const ORDINAL_WORDS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH', 'SIXTEENTH', 'SEVENTEENTH', 'EIGHTEENTH', 'NINETEENTH', 'TWENTIETH'];
const ORDINALS = new Map(ORDINAL_WORDS.map((word, index) => [word, String(index + 1)]));

function token(value) {
  const ordinal = value.match(/^(\d+)(?:ST|ND|RD|TH)$/);
  if (ordinal) return ordinal[1];
  return ORDINALS.get(value) || SUFFIX.get(value) || DIRECTIONS.get(value) || value;
}

// 街名 → 规范键（主体词在前、方向词在后）；同一函数处理索引里的地址和读者输入。
export function metroStreetKey(value) {
  const tokens = String(value || '').normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(token);
  const dirs = tokens.filter((t) => DIRECTIONS.has(t));
  const body = tokens.filter((t) => !DIRECTIONS.has(t));
  return [...body, ...dirs].join(' ');
}

// 主体键：去掉街道类型与方向，用来分桶，也用来在读者漏写 St/Ave 时兜底。
export function metroStreetCore(streetKey) {
  const body = String(streetKey || '').split(' ').filter((t) => t && !SUFFIX_CODES.has(t) && !DIRECTIONS.has(t));
  return body.length ? body.join(' ') : String(streetKey || '');
}

// 索引地址（已去掉单元前缀）→ [{civic, streetKey}]；门牌范围 1234-1236 与双拼写法 1002/1004 两个号都收。
export function parseMetroAddress(address) {
  const text = String(address || '').trim().toUpperCase();
  const match = text.match(/^(\d+[A-Z]?(?:\s*[-/]\s*\d+[A-Z]?)*)\s+(.+)$/);
  if (!match) return [];
  const streetKey = metroStreetKey(match[2]);
  if (!streetKey) return [];
  return [...new Set(match[1].split(/\s*[-/]\s*/).filter(Boolean))].map((civic) => ({ civic, streetKey }));
}

// FNV-1a，32 位；构建分桶与浏览器取桶共用。
export function bucketOf(core, buckets) {
  let hash = 0x811c9dc5;
  for (const char of String(core)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % Math.max(1, buckets);
}

export function bucketUrl(city, index) { return `${METRO_DATA_ROOT}/${city}/${index}.json`; }

// 分桶只存地址原文；门牌号与街名键在这里现算（门牌范围展开成两条），area 存的是 areas 表下标。
export function decodeMetroBucket(bucket) {
  if (!Array.isArray(bucket?.fields) || !Array.isArray(bucket?.records)) throw new Error('城市年代索引分桶格式无效');
  const areas = Array.isArray(bucket.areas) ? bucket.areas : [];
  return bucket.records.flatMap((row) => {
    const record = Object.fromEntries(bucket.fields.map((field, index) => [field, row[index]]));
    if (Number.isInteger(record.area)) record.area = areas[record.area] ?? null;
    return parseMetroAddress(record.address).map(({ civic, streetKey }) => ({ ...record, civic, street_key: streetKey }));
  });
}

// 读者输入 → 命中记录。先门牌＋完整街名，再门牌＋街名主体（漏写或写错街道类型时）。
export function matchMetroRecords(records, { civicNumber, street }) {
  const civic = String(civicNumber || '').trim().toUpperCase();
  const streetKey = metroStreetKey(street);
  const core = metroStreetCore(streetKey);
  const sameCivic = records.filter((row) => String(row.civic).toUpperCase() === civic);
  const exact = sameCivic.filter((row) => row.street_key === streetKey);
  if (exact.length) return { method: 'exact', records: exact };
  const loose = sameCivic.filter((row) => metroStreetCore(row.street_key) === core);
  return { method: loose.length ? 'core' : 'none', records: loose };
}

export async function lookupMetroAddress(input, city, { fetchImpl = fetch } = {}) {
  const civicNumber = String(input.civicNumber || '').trim().toUpperCase();
  if (!/^\d{1,6}[A-Z]?$/.test(civicNumber)) return { status: 'invalid', message: '请输入有效门牌号（只填数字，可带一个字母）。' };
  const streetKey = metroStreetKey(input.street);
  if (streetKey.length < 2) return { status: 'invalid', message: '请输入街名，例如 132A St 或 Sixth Ave。' };
  const index = bucketOf(metroStreetCore(streetKey), city.buckets);
  let bucket;
  try {
    const response = await fetchImpl(bucketUrl(city.code, index));
    if (!response?.ok) throw new Error(String(response?.status));
    bucket = await response.json();
  } catch {
    return { status: 'metro-error', city: city.code };
  }
  const match = matchMetroRecords(decodeMetroBucket(bucket), { civicNumber, street: input.street });
  if (!match.records.length) return { status: 'metro-none', city: city.code, input: { civicNumber, street: String(input.street || '').trim() } };
  if (match.records.length > 1) return { status: 'metro-choose', city: city.code, candidates: match.records };
  return { status: 'metro', city: city.code, method: match.method, record: match.records[0] };
}

// ---------------------------------------------------------------- 房型与年代档
const DETACHED_USES = new Set(['sfd', 'duplex', 'coach', 'suite', 'mobile', 'farm']);
const STRATA_USES = new Set(['rowhouse', 'townhouse', 'lowrise', 'lowrise_mixed', 'highrise']);
export const USE_LABELS = { sfd: '独立屋', duplex: '双拼', rowhouse: '排屋', townhouse: '联排', lowrise: '低层公寓', lowrise_mixed: '低层公寓（底层非住宅）', highrise: '高层公寓', mobile: '移动屋', farm: '农场建筑', coach: '车库屋', suite: '附属套间', nonres: '非住宅建筑', accessory: '附属建筑（车库、棚屋等）' };

// 'detached' | 'strata' | 'nonres' | null（数据未注明用途）。新西敏没有用途字段，按登记住宅单元数只认三户以上的多户楼。
export function metroEraType(record) {
  if (DETACHED_USES.has(record.use)) return 'detached';
  if (STRATA_USES.has(record.use)) return 'strata';
  if (record.use === 'nonres') return 'nonres';
  if (!record.use && Number(record.res_units) >= 3) return 'strata';
  return null;
}

const TYPE_TEXT = { detached: '独立屋', strata: '公寓与联排（分层产权）' };
const TYPE_BASE = { detached: '/veryvisa-com-site/home/era/', strata: '/veryvisa-com-site/home/era/strata/' };
const erasFor = (eraData, type) => (type === 'strata' ? eraData.strata : eraData.eras) || [];

function eraGroups(era) {
  return ERA_FIELDS.map((field) => {
    const items = (era[field] || []).filter((item) => item.status === 'verified');
    return items.length ? `<section><h3>${h(ERA_FIELD_LABELS[field])}</h3><ul>${items.map((item) => `<li>${h(eraItemText(item))} <a href="${h(item.source_url)}" title="${h(item.source_title)}">出处</a></li>`).join('')}</ul></section>` : '';
  }).join('');
}

// 按建年和房型给一张年代档卡体；房型不明时两种档都点名，让读者自己选。
export function renderEraBlock(year, type, eraData, { scope = '', groups = true } = {}) {
  if (type === 'nonres') return '<p>开放数据把此址主楼登记为非住宅建筑，住宅年代档不适用。</p>';
  if (!type) {
    const pair = ['detached', 'strata'].map((kind) => [kind, eraForYear(erasFor(eraData, kind), year)]).filter(([, era]) => era);
    if (!pair.length) return '<p>这个年份不在年代档范围内。</p>';
    return `<p>开放数据没有注明此址的房型。按建年 ${h(year)}：</p><ul class="era-pair">${pair.map(([kind, era]) => `<li>${h(TYPE_TEXT[kind])}看 <a href="${TYPE_BASE[kind]}#${eraAnchor(era.id)}">${h(era.id)} · ${h(era.label)}</a></li>`).join('')}</ul>`;
  }
  const era = eraForYear(erasFor(eraData, type), year);
  if (!era) return `<p>建年未登记，暂时不能归档；请从许可、卖方披露和验房资料继续核对。</p><p class="era-entry"><a href="${TYPE_BASE[type]}">打开${h(TYPE_TEXT[type])}年代档</a></p>`;
  const note = scope || (type === 'strata' ? '按登记建年归档；这是该年代分层产权楼的核对清单，不是对这栋楼或任何单元的结论。' : '按登记建年归档；这是该年代的核对清单，不是对单栋房屋的结论。');
  return `<p class="eyebrow">${h(era.id)} · ${h(TYPE_TEXT[type])}</p><h3 class="era-title"><a href="${TYPE_BASE[type]}#${eraAnchor(era.id)}">${h(era.label)}</a></h3><p>${h(note)}</p>${groups ? `<div class="era-card-groups">${eraGroups(era)}</div>` : ''}`;
}

// 年代档正文各栏放在四层时间线之后（同温哥华地址卡：先建年与许可，再核对清单）。
function groupsFor(year, type, eraData) {
  if (!['detached', 'strata'].includes(type)) return '';
  const era = eraForYear(erasFor(eraData, type), year);
  return era ? `<div class="era-card-groups">${eraGroups(era)}</div>` : '';
}

// ---------------------------------------------------------------- 结构类型（北温区）
// 代码与英文释义取分片表头 structural_classes 原样（区府字段域），中文只作括注。是否「未加固砌体」也按官方释义判，不另立代码表。
const STRUCT_ZH = { W1: '轻型木结构', W2: '大型木结构', S1: '钢抗弯框架', S2: '钢支撑框架', S3: '轻钢结构', S4: '钢框架加现浇混凝土剪力墙', S5: '钢框架填充未加固砌体墙', C1: '混凝土抗弯框架', C2: '混凝土剪力墙', C3: '混凝土框架填充未加固砌体墙', PC1: '预制混凝土提升墙', PC2: '预制混凝土框架加剪力墙', RM1: '配筋砌体承重墙', RM2: '配筋砌体承重墙', URM: '未加固砌体承重墙', MH: '移动屋' };
const STRUCT_HEIGHT = { L: '低层', M: '中层', H: '高层' };
export const STRUCTURAL_DISCLAIMER = '这是区府沿用加拿大自然资源部地震模型（HAZUS）的建筑分类清册，不是对这栋楼的结构鉴定。';
// 1990 年后新建的楼按现行规范不会是未加固砌体；清册仍这样记的（如 2017 年的 Cates Landing Way 三栋公寓），多是 2012 年整批估值沿用或误填。
export const URM_MISMATCH_FROM = 1990;
const OLD_HOUSE_INSURANCE = '/veryvisa-com-site/home/guide/old-house-insurance/';

export function isUnreinforcedMasonry(code, legend = {}) { return Boolean(code && /unreinforced masonry/i.test(legend[code] || '')); }

export function structuralZh(code) {
  const text = String(code || '');
  if (STRUCT_ZH[text]) return STRUCT_ZH[text];
  const m = text.match(/^(.*?)([LMH])$/);
  if (m && STRUCT_ZH[m[1]]) return `${STRUCT_ZH[m[1]]}，${STRUCT_HEIGHT[m[2]]}`;
  if (m && m[1] === 'URM') return `${STRUCT_ZH.URM}，${STRUCT_HEIGHT[m[2]]}`;
  return '';
}

export function structuralLine(record, city) {
  const legend = city.structural_classes;
  if (!legend) return '';
  const code = record.structural_class;
  const stories = Number.isInteger(record.stories) && record.stories > 0 ? `清册登记层数：${record.stories}。` : '';
  if (!code) return `<div class="era-structural"><p>结构类型：清册未登记。${h(stories)}</p></div>`;
  const zh = structuralZh(code);
  const official = legend[code] ? ` · ${legend[code]}` : '';
  const urm = isUnreinforcedMasonry(code, legend);
  const mismatch = urm && Number(record.year_built) >= URM_MISMATCH_FROM;
  const urmLine = urm ? `<p class="result-caution">清册登记为未加固砌体（${h(code)}），买保险和验房时问清楚；地震险的买法见<a href="${OLD_HOUSE_INSURANCE}">老房投保</a>。</p>` : '';
  const mismatchLine = mismatch ? `<p class="result-caution" data-structural-mismatch>登记年份与分类不一致（${h(record.year_built)} 年建、却记为未加固砌体），以现场为准。</p>` : '';
  return `<div class="era-structural"><p>结构类型：<span lang="en">${h(code)}${h(official)}</span>${zh ? `（${h(zh)}）` : ''}。${h(stories)}</p><p class="metadata">${h(STRUCTURAL_DISCLAIMER)}</p>${urmLine}${mismatchLine}</div>`;
}

// ---------------------------------------------------------------- 渲染
export const METRO_PERMIT_LABELS = { addition_alteration: '加建或改建', demolition: '拆除', new_building: '新建', electrical: '电气', gas: '燃气', plumbing: '给排水与地暖', tank: '储罐', other: '其他' };
const SALE_DISCLOSURE = '/veryvisa-com-site/home/guide/sale-disclosure-defects/';

const ymd = (value) => { const s = String(value || ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s; };

function structuresLine(record) {
  const others = Array.isArray(record.structures) ? record.structures : [];
  if (!others.length) return '';
  const count = 1 + others.reduce((sum, [, , n]) => sum + (Number(n) || 1), 0);
  const years = [record.year_built, ...others.map(([, year]) => year)].map(Number).filter((y) => Number.isInteger(y) && y > 1800);
  const span = years.length ? `建年 ${Math.min(...years)}–${Math.max(...years)}` : '建年未全登记';
  return `<p class="result-caution">此址登记有 ${h(count)} 栋建筑，${h(span)}；上面的建年取主楼，其余各栋要分开看。</p>`;
}

// 「拆过旧楼再建」：新西敏拆除清册里的同址记录。原建年缺失的不猜。
export function rebuildSentences(record) {
  const rows = Array.isArray(record.demolished) ? record.demolished : [];
  return rows.map(([demolishYear, originalYear]) => {
    const original = Number.isInteger(Number(originalYear)) && originalYear ? `原建于 ${originalYear} 年` : '原建年未登记';
    const now = record.year_built ? `，现楼建于 ${record.year_built} 年` : '';
    return `此址 ${demolishYear || '某'} 年拆旧楼（${original}）${now}。`;
  });
}

function permitTimeline(record, city) {
  const permits = Array.isArray(record.permits) ? [...record.permits].sort((a, b) => Number(b[0]) - Number(a[0])) : [];
  const from = ymd(city.permit_from);
  const label = (category) => city.permit_labels?.[category] || METRO_PERMIT_LABELS[category] || category || '类别待核';
  const list = city.has_permits === false
    ? ''
    : permits.length
      ? `<ul>${permits.map(([year, category, number]) => `<li>${h(year || '年份未公布')} · ${h(label(category))} · <span class="permit-id">${h(number || '许可号未公布')}</span></li>`).join('')}</ul>`
      : `<p>开放数据自 ${h(from)} 起未见此门牌的许可记录。这不等于此前没有改建，只说明这段时间里没有签发记录。</p>`;
  const rebuilt = rebuildSentences(record);
  const rebuiltBlock = rebuilt.length ? `<section class="era-rebuilt"><h3>拆过旧楼再建</h3>${rebuilt.map((line) => `<p>${h(line)}</p>`).join('')}<p class="result-caution">来自市府拆除建筑清册；同址拆旧再建说明现楼不是原来那栋，年代档按现楼建年读。</p></section>` : '';
  const earlier = (city.records_lookup || []).map((entry) => `<a href="${h(entry.url)}">${h(entry.label)}</a>`).join('；');
  // 满地宝：市府不公开建年。新建许可只说明那年签发过新建许可，不等于建成年份，不能拿来推建年。
  const yearBlock = city.permits_only
    ? `<p>${h(city.zh)}市府不公开建年，这里不显示建年。下面的「新建」许可只说明那年签发过新建许可，不等于房子建成的年份。</p>`
    : `<p>${record.year_built ? `${h(city.gov || '市府')}建筑清册登记的主楼建年为 ${h(record.year_built)} 年。` : `${h(city.gov || '市府')}建筑清册没有登记此址建年。`}</p>${structuralLine(record, city)}${structuresLine(record)}`;
  const permitHead = city.has_permits === false ? '二 · 许可史' : `二 · 许可史（开放数据自 ${h(from)} 起）`;
  const scope = city.has_permits === false ? h(city.permit_scope) : `${h(city.permit_scope)}许可签发不等于工程已经完工验收。`;
  return `<section class="era-permits"><h3>一 · 建年</h3>${yearBlock}<h3>${permitHead}</h3>${list}<p class="result-caution">${scope}</p>${rebuiltBlock}<h3>三 · 更早的记录去哪查</h3><p>${earlier || '向市府建筑部门查询。'}</p><h3>四 · 卖方披露</h3><p>开放数据看不到未报批的改建。向卖方要物业披露声明，逐项问改建、加建和有没有拿许可；读法见<a href="${SALE_DISCLOSURE}">卖房隐蔽缺陷披露</a>。</p></section>`;
}

function attribution(city) {
  const sources = (city.datasets || []).map((d) => `<a href="${h(d.url)}">${h(d.label)}</a>`).join('、');
  return `<p class="dataset-source">数据：${sources}（取数 ${h(city.fetched_at)}）· ${h(city.attribution)} <a href="${h(city.licence_url)}">许可证</a></p>`;
}

const YEAR_FORM = '<form class="era-year-form" data-era-year-form><label>建成年份<input name="year" inputmode="numeric" maxlength="4" placeholder="例如 1978"></label><label>房型<select name="type"><option value="detached">独立屋</option><option value="strata">公寓与联排</option></select></label><button type="submit">看年代档</button></form><div data-era-year-output aria-live="polite"></div>';

// 只有许可史的城市（满地宝）：卡头写明口径，年代档由读者自填建年。
function renderPermitsOnlyCard(record, city) {
  return `<section class="result-card era-card" data-metro-era="${h(city.code)}"><h2>许可档案 · 2013 年起许可史，建年未开放</h2>${permitTimeline(record, city)}<p>知道建年的话（卖方资料、挂牌信息或市府档案），可以自己填进来看对应的年代档：</p>${YEAR_FORM}${attribution(city)}</section>`;
}

export function renderMetroEraCard(record, city, eraData) {
  if (city.permits_only) return renderPermitsOnlyCard(record, city);
  const type = metroEraType(record);
  const label = !record.use && type === 'strata' ? '多户住宅楼' : type ? (type === 'nonres' ? '非住宅' : TYPE_TEXT[type]) : '房型未注明';
  const inferred = !record.use && type === 'strata';
  const use = record.use ? `开放数据登记的主楼用途：${USE_LABELS[record.use] || record.use}。` : inferred ? `开放数据没有房型字段；此址登记有 ${record.res_units} 个住宅单元，按多户楼读分层产权年代档。出租公寓楼没有法团，储备金与折旧报告那几条不适用，外墙与年代问题照样适用。` : '';
  return `<section class="result-card era-card" data-metro-era="${h(city.code)}"><h2>年代档案 · ${h(label)}</h2>${use ? `<p class="metadata">${h(use)}</p>` : ''}${renderEraBlock(record.year_built, type || (record.year_built ? null : 'detached'), eraData, { groups: false })}${permitTimeline(record, city)}${groupsFor(record.year_built, type, eraData)}${attribution(city)}</section>`;
}

export function renderMetroResult(result, cities, eraData) {
  const city = cities[result.city];
  if (result.status === 'invalid') return `<div class="result-message result-error" role="alert">${h(result.message)}</div>`;
  if (result.status === 'metro-error') return `<div class="result-message result-error" role="alert"><p>${h(city.zh)}年代索引暂时没能载入，请稍后重试。</p>${attribution(city)}</div>`;
  if (result.status === 'metro-none') {
    const scope = city.permits_only
      ? `${h(city.zh)}索引只收 ${h(ymd(city.permit_from))} 起至少有一条已签发许可的门牌，大约是全市${h(city.coverage_text)}门牌；查不到多半是这段时间没有签发记录，也可能是门牌写法不同。`
      : `开放数据大约覆盖${h(city.coverage_text)}门牌，没有收录的门牌请直接向市府查。`;
    return `<div class="result-message"><h2>${h(city.zh)}索引里没有这个门牌</h2><p>请检查门牌号与街名拼写，街道类型（St、Ave、Cres）和方向（E、W）可省略。${scope}</p>${attribution(city)}</div>`;
  }
  if (result.status === 'metro-choose') return `<section class="result-card"><h2>请选择地址</h2><p>${h(city.zh)}索引里有多个相近的门牌：</p><div class="address-choices">${result.candidates.map((row, index) => `<button type="button" data-metro-choice="${index}">${h(row.address)}</button>`).join('')}</div></section>`;
  const r = result.record;
  return `<div class="address-result-heading"><p class="eyebrow">查询结果 · ${h(city.zh)}</p><h2>${h(r.address)}</h2><p>${h(city.zh)}${r.area && !['unknown', 'no-building-record', city.default_area].includes(r.area) ? ` · ${h(city.area_zh?.[r.area] || r.area)}` : ''}${result.method === 'core' ? ' · 按街名主体匹配，请核对街道类型' : ''}</p></div>${renderMetroEraCard(r, city, eraData)}`;
}

// 没有开放数据的城市：官方调档入口＋读者自填建年。
export function renderReferralCard(city) {
  const links = (city.reader_lookup || []).map((entry) => `<li><a href="${h(entry.url)}">${h(entry.label)}</a></li>`).join('');
  return `<section class="result-card era-card era-referral" data-referral-city="${h(city.code)}"><h2>${h(city.zh)}：该市未开放逐址建年与许可数据</h2><p>这里不显示建年和许可史。要查一栋房子的建成年代和历次许可，请向市府调档：</p><ul class="referral-links">${links}</ul><p>知道建年的话（卖方资料、挂牌信息或市府档案），可以自己填进来看对应的年代档：</p>${YEAR_FORM}<p class="result-caution">许可签发不等于工程已经完工验收；开放数据之外的改建，要看卖方披露与验房。</p></section>`;
}

export function renderYearEra(yearText, type, eraData) {
  const year = Number(String(yearText || '').trim());
  if (!Number.isInteger(year) || year < 1850 || year > 2100) return '<p class="result-error">请填四位数的建成年份。</p>';
  return renderEraBlock(year, type === 'strata' ? 'strata' : 'detached', eraData, { scope: '按您填的建年归档；这是该年代的核对清单，不是对单栋房屋的结论。' });
}

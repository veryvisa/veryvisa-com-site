// 地址页「限制与风险」与「管网」两栏：读构建时生成的静态分桶（scripts/site_layers.mjs），浏览器与 node（构建门、测试）共用。
// 措辞一律取 bc-home-advisor coverage.json 的 page_wording，只做两处改动（2026-10-22 pipes 交付报告「最没把握」第 2、3 条）：
//   ① 「门前供水主管」→「最近的市政供水主管」（主管按地块边界 25 米内量，转角地与有后巷的地块可能取到侧街或后巷那条）；
//   ② 合流制那句（2026-10-22 中心裁决恢复提示）：不用 sentence_rules 的「暴雨时倒灌风险较高」这种评判句，改写成市府公开页上的事实句＋出处＋可做的事
//      （温哥华、本拿比各取本市官方页原句的意思，见 COMBINED_NOTES；原句里没有的意思不写）；
// 另：材质代码不在对照表里的（CAS、CC、ACC、Municipex 等）和 PB（可能是聚丁烯也可能是铅）一律原样显示，后接「代码以市府字段说明为准」。
// 不画风险等级、不给颜色分级；每块末尾固定接 page_wording 的免责句、数据出处与取数日期、官方查询入口。
import { bucketOf, matchMetroRecords, metroStreetCore, metroStreetKey, parseMetroAddress } from './metro-era.mjs';

const h = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// 两栏各放哪些层。开发申请 dev_apps（2026-10-22 接）在「限制与风险」栏，排在许可区之后。
// 「地块与街区」栏（2026-10-22 接）：地块（宽深面积、分区、文物、地役权线索）、门前树、短租（社区级）。
export const PANELS = {
  lot: { title: '地块与街区', lede: '市府地块图、树木清单与社区牌照统计的公开记录', layers: ['parcels', 'trees', 'str'] },
  risk: { title: '限制与风险', lede: '市府许可区、规划图层与附近开发申请的公开记录', layers: ['overlays', 'dev_apps'] },
  pipes: { title: '管网', lede: '市政台账里这个门牌的支管与最近的主管', layers: ['pipes', 'pipes_house'] },
};
export const CODE_NOTE = '代码以市府字段说明为准';
export const UNTRANSLATED_CODES = new Set(['PB']);
const STATUS_ZH = { in_service: '目前在用', abandoned: '已停用' };
const PIPE_FIELDS = ['address', 'san_lateral_year', 'san_lateral_material', 'san_lateral_status', 'water_service_year', 'water_service_material', 'water_main_year', 'water_main_material', 'sewer_main_type'];

export function siteBucketUrl(manifest, layer, city, index) { return `${manifest.root || '/veryvisa-com-site/home/site-data'}/${layer}/${city}/${index}.json`; }

export function decodeSiteBucket(bucket) {
  if (!Array.isArray(bucket?.fields) || !Array.isArray(bucket?.records)) throw new Error('分桶格式无效');
  return bucket.records.flatMap((row) => {
    const record = Object.fromEntries(bucket.fields.map((field, index) => [field, row[index]]));
    return parseMetroAddress(record.address).map(({ civic, streetKey }) => ({ ...record, civic, street_key: streetKey }));
  });
}

// 一个城市在本站有哪些层（清单里有元数据的才算）。
export function siteLayersFor(manifest, code) {
  const city = manifest?.cities?.[code];
  if (!city) return [];
  return Object.values(PANELS).flatMap((panel) => panel.layers).filter((layer) => city[layer]?.buckets || city[layer]?.inline);
}

// 查一个门牌在该城市各层的记录；每层只取一桶。返回 { layer: { status: 'hit'|'none'|'choose'|'error', records, method } }。
export async function lookupSiteLayers(input, code, manifest, { fetchImpl = fetch } = {}) {
  const civicNumber = String(input.civicNumber || '').trim().toUpperCase();
  const streetKey = metroStreetKey(input.street);
  const out = {};
  if (!/^\d{1,6}[A-Z]?$/.test(civicNumber) || streetKey.length < 2) return out;
  await Promise.all(siteLayersFor(manifest, code).map(async (layer) => {
    const meta = manifest.cities[code][layer];
    if (meta.inline) { out[layer] = lookupInline(layer, input, meta); return; }
    const index = bucketOf(metroStreetCore(streetKey), meta.buckets);
    try {
      const response = await fetchImpl(siteBucketUrl(manifest, layer, code, index));
      if (!response?.ok) throw new Error(String(response?.status));
      const bucket = await response.json();
      if (layer === 'dev_apps' && meta.mode === 'council') { out[layer] = matchCouncilStreet(bucket, streetKey); return; }
      const match = matchMetroRecords(decodeSiteBucket(bucket), { civicNumber, street: input.street });
      if (layer === 'dev_apps') {
        const unique = [...new Map(match.records.map((r) => [r.address, r])).values()];
        if (unique.length === 1) unique[0].apps = await loadDevApps(unique[0].near, meta, manifest, code, fetchImpl);
        out[layer] = { status: unique.length === 1 ? 'hit' : unique.length ? 'choose' : 'none', records: unique, method: match.method };
        return;
      }
      const unique = [...new Map(match.records.map((r) => [r.address, r])).values()];
      out[layer] = { status: unique.length === 1 ? 'hit' : unique.length ? 'choose' : 'none', records: unique, method: match.method };
    } catch {
      out[layer] = { status: 'error', records: [] };
    }
  }));
  return out;
}

// 内嵌层（不分桶）：短租按地址接口回来的社区名（local area）对上清单里的社区表。
export function lookupInline(layer, input, meta) {
  if (layer !== 'str') return { status: 'none', records: [] };
  const area = String(input.localArea || '').trim();
  if (!area) return { status: 'unknown', records: [] };
  const n = meta.areas?.[area];
  return n === undefined ? { status: 'none', records: [{ local_area: area }] } : { status: 'hit', records: [{ local_area: area, n }] };
}

// 开发申请（素里、高贵林）：门牌行里是 [申请序号, 米, …]，申请表按序号切片在 apps-<k>.json；只取用到的几片。
export function devAppChunkOf(index, starts) {
  let chunk = 0;
  (starts || [0]).forEach((start, k) => { if (index >= start) chunk = k; });
  return chunk;
}
async function loadDevApps(near, meta, manifest, code, fetchImpl) {
  const list = Array.isArray(near) ? near : [];
  const chunks = [...new Set(list.filter((_, i) => i % 2 === 0).map((index) => devAppChunkOf(index, meta.app_chunks)))];
  const table = new Map();
  await Promise.all(chunks.map(async (k) => {
    const response = await fetchImpl(`${manifest.root || '/veryvisa-com-site/home/site-data'}/dev_apps/${code}/apps-${k}.json`);
    if (!response?.ok) throw new Error(String(response?.status));
    const doc = await response.json();
    doc.records.forEach((row, i) => table.set(doc.start + i, Object.fromEntries(doc.fields.map((field, j) => [field, row[j]]))));
  }));
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    const app = table.get(list[i]);
    if (!app) throw new Error('申请表缺序号');
    out.push({ ...app, metres: list[i + 1] });
  }
  return out;
}
// 温哥华：按街名对上（不是按距离）。先完整街名，再街名主体（主体只对上一条街才算）。
export function matchCouncilStreet(bucket, streetKey) {
  if (!Array.isArray(bucket?.records)) throw new Error('分桶格式无效');
  const rows = bucket.records.map(([street, votes]) => ({ street, key: metroStreetKey(street), votes }));
  const exact = rows.filter((row) => row.key === streetKey);
  if (exact.length) return { status: 'hit', records: exact, method: 'exact' };
  const core = metroStreetCore(streetKey);
  const loose = rows.filter((row) => metroStreetCore(row.key) === core);
  return loose.length === 1 ? { status: 'hit', records: loose, method: 'core' } : { status: 'none', records: [], method: 'none' };
}

// ---------------------------------------------------------------- 句子
const links = (entries) => (entries || []).map((entry) => `<a href="${h(entry.url)}">${h(entry.label)}</a>`).join('；');
function sourceLine(meta, zh) {
  const datasets = (meta.sources || []).filter((s) => s.url).map((s) => `<a href="${h(s.url)}">${h(s.label)}</a>`).join('、');
  return `<p class="dataset-source">数据：${h(zh)}开放数据 ${datasets}（取数 ${h(meta.fetched_at)}）· ${h(meta.attribution)} <a href="${h(meta.licence_url)}">许可证</a></p>`;
}

// 高贵林开发许可区按附表区分（page_wording.dpa_note 的两类说法）。
export function dpaScheduleNote(label) {
  if (/^Sch A\b/.test(String(label))) return '这是附表 A「邻里中心开发许可区」，主要管建筑形式与外观。';
  if (/^Sch B\b/.test(String(label))) return '这是附表 B「环境开发许可区」。';
  return '';
}

export function overlaySentence(entry, wording) {
  const [code, label, basis, fcl] = entry;
  const template = wording?.[code];
  if (!template) return null;
  const fclText = code === 'creek' && fcl !== null && fcl !== undefined && wording.creek_fcl ? wording.creek_fcl.replace('{fcl}', String(fcl)) : '';
  let text = template.replace('{label}', String(label ?? '')).replace('{fcl}', fclText).trim();
  if (basis === 'parcel') text = text.replace(/^这个地址落在/, '这块地有一部分落在');
  if (code === 'dpa') text = `${text}${dpaScheduleNote(label)}`;
  return text;
}

// 「没落区」的口径按市分：北温区按地块重叠判，素里、高贵林、温哥华按门牌点判（地块部分在区内的会漏）。
export function overlayBasisNote(meta, city) {
  return meta?.parcel_basis
    ? `${city.zh}按地块判断：地块与区有重叠（按区府地块边线内缩 1.5 米，只共用一条界线的不算）就算落区。`
    : `${city.zh}按门牌位置判断：门牌点不在区内、但地块有一部分在区内的情况，这里不会显示，以市府地图为准。`;
}

export function renderOverlays(result, meta, city, { addressKnown = false } = {}) {
  const names = (meta.sources || []).map((s) => s.label).join('、');
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}许可区分桶暂时没能载入，请稍后重试或直接用下面的市府地图。</p>`;
  else if (result.status === 'choose') body = `<p>按街名主体匹配到多个门牌：${result.records.map((r) => h(r.address)).join('、')}。请补全街道类型（St、Ave 等）再查。</p>`;
  else if (result.status === 'hit') {
    const record = result.records[0];
    const lines = (record.overlays || []).map((entry) => overlaySentence(entry, meta.wording)).filter(Boolean);
    const partial = (record.overlays || []).some((entry) => entry[2] === 'parcel');
    body = `<ul class="site-layer-list">${lines.map((line) => `<li>${h(line)}</li>`).join('')}</ul>${partial ? '<p class="metadata">「这块地有一部分落在」：门牌所在的主楼位置不在区内，只是地块的一部分在区内（按区府地块边线内缩 1.5 米判断，只共用一条界线的不算）。</p>' : ''}${result.method === 'core' ? `<p class="metadata">按街名主体匹配到 ${h(record.address)}，请核对街道类型。</p>` : ''}`;
  } else {
    body = addressKnown
      ? `<p>本站收录的${h(city.zh)}图层（${h(names)}）里，这个门牌没有落区。</p><p class="metadata">${h(overlayBasisNote(meta, city))}没落区只说明不在这几层里，不等于不受影响，也不等于没有其他限制；本站没收的图层不在这次范围内。</p>`
      : `<p>本站收录的${h(city.zh)}图层（${h(names)}）里，没有查到这个门牌落区；也可能是门牌写法与市府地址不同。</p><p class="metadata">${h(overlayBasisNote(meta, city))}</p>`;
  }
  return `<div class="site-layer" data-site-layer="overlays"><h3>${h(city.zh)}：许可区与规划图层</h3>${body}<p class="result-caution">${h(meta.wording?.disclaimer || '')}</p><p>官方查询：${links(meta.lookup)}</p>${sourceLine(meta, city.zh)}</div>`;
}

export function materialText(code, materials = {}) {
  if (code === null || code === undefined || code === '') return null;
  const value = String(code);
  const known = materials[value];
  if (known && !UNTRANSLATED_CODES.has(value)) return `${known.en}（${known.zh}）`;
  return `${value}（${CODE_NOTE}）`;
}
const statusText = (status) => (status ? STATUS_ZH[status] || `台账状态 ${status}` : null);

function clause(head, year, material, status) {
  const parts = [year ? `${year} 年铺设` : null, material].filter(Boolean);
  if (!parts.length && !status) return null;
  const main = parts.length ? `${head} ${parts.join('、')}` : `${head}年份与材质未登记`;
  return status ? `${main}，${status}` : main;
}

// pipes.page_wording.sentence_zh 按 sentence_rules 拼：空值整句去掉；材质英文＋中文括注；状态中文。
export function pipeSentences(record, meta) {
  const m = meta.materials || {};
  const clauses = [
    clause('污水支管市政段', record.san_lateral_year, materialText(record.san_lateral_material, m), statusText(record.san_lateral_status)),
    clause('供水接驳市政段', record.water_service_year, materialText(record.water_service_material, m), null),
    clause('最近的市政供水主管', record.water_main_year, materialText(record.water_main_material, m), null),
  ].filter(Boolean);
  // 只有主管一句时（温哥华、本拿比）说「离这个地址最近的…」，免得读成「这个地址的最近的」。
  const lead = clauses.length === 1 && clauses[0].startsWith('最近的') ? `离这个地址${clauses[0]}` : `这个地址的${clauses.join('；')}`;
  const out = clauses.length ? [`市政记录：${lead}。`] : [];
  if (record.sewer_main_type === 'Combined') out.push('最近的市政污水主管为合流制（雨污合流）：雨水和生活污水走同一根管。');
  return out;
}

// 合流制的事实句、出处与可做的事（2026-10-22 用 fcgbbs/bin/web_ai/fetch_text.js 打开官方页核过原句，见 reports/home-devapps-wire-1022.md）。
// 温哥华：combined-sewer-overflows 页「During heavy rainfall, sewer pipes and wastewater treatment plants can get overwhelmed…This helps prevent
//   back-ups and flooding of properties」；plumbing-and-drainage-repair-tips 页「the City recommends preventative sewer maintenance and the use of an
//   outside clean-out to reduce the chance of sewer backups」。本拿比：storm-and-sanitary-sewers 页「can't carry all the sewage flows…during wet weather」
//   与「a grant of up to $2,500」。最后一句（请持牌水管工看防回流阀）是本站给的可做的事，不算市府原话。
export const COMBINED_NOTES = {
  vw: {
    text: '市府说明：强降雨时，下水管和污水处理厂容量有限，可能应付不了多出来的雨水；合流管这时把多余的雨污水排进附近水体，是为了避免沿线物业污水倒灌和水浸（{cso}）。市府建议定期清通自家下水连接管、在屋外加装清扫口（clean-out），以减少污水倒流进屋（{cleanout}）。地下室有没有装防回流阀（backwater valve），可请持牌水管工查看（以市府说明为准）。',
    links: { cso: { label: '温哥华市府：合流制溢流', url: 'https://vancouver.ca/home-property-development/combined-sewer-overflows.aspx' }, cleanout: { label: '温哥华市府：下水连接管定期清通', url: 'https://vancouver.ca/home-property-development/scheduled-sewer-connection-cleaning.aspx' } },
  },
  bby: {
    text: '市府说明：雨天合流管网输送不了全部污水，多余部分会排入 Burrard Inlet 和 Fraser River，市府计划把合流管逐步改成分流（{sewers}）。街上换成分流管后，符合条件的房主可申请最高 2,500 加元补助，把自家合流下水管改接过去（以市府说明为准）。地下室有没有装防回流阀（backwater valve），可请持牌水管工查看。',
    links: { sewers: { label: '本拿比市府：雨水与污水管', url: 'https://www.burnaby.ca/services-and-payments/water-and-sewers/storm-and-sanitary-sewers' } },
  },
};
export function combinedNote(code) {
  const note = COMBINED_NOTES[code];
  if (!note) return '';
  return `<p class="combined-note">${h(note.text).replace(/\{(\w+)\}/g, (_, key) => (note.links[key] ? `<a href="${h(note.links[key].url)}">${h(note.links[key].label)}</a>` : ''))}</p>`;
}

function pipeDisclaimer(meta) {
  const text = String(meta.wording?.disclaimer_zh || '');
  const lookup = meta.wording?.lookup;
  const parts = text.split('（链接）');
  if (parts.length === 2 && lookup?.url) return `${h(parts[0])}（<a href="${h(lookup.url)}" title="${h(lookup.label)}">打开</a>）${h(parts[1])}`;
  return h(text.replace(/（链接）/g, ''));
}

export function renderPipes(result, meta, city) {
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}管网分桶暂时没能载入，请稍后重试或直接用下面的市府地图。</p>`;
  else if (result.status === 'choose') body = `<p>按街名主体匹配到多个门牌：${result.records.map((r) => h(r.address)).join('、')}。请补全街道类型（St、Ave 等）再查。</p>`;
  else if (result.status === 'none') body = `<p>${h(city.zh)}市政管网索引里没有这个门牌；也可能是门牌写法与市府地址不同。可用下面的市府地图直接查。</p>`;
  else {
    const record = result.records[0];
    const lines = pipeSentences(record, meta);
    const scope = [!meta.has_laterals ? `${city.zh}没有公开到户的污水支管数据` : null, !meta.has_water_services ? '没有公开供水接驳数据' : null].filter(Boolean);
    body = `${lines.length ? lines.map((line) => `<p>${h(line)}</p>`).join('') : '<p>市政台账里没有关联到这个门牌的支管或主管记录。</p>'}${record.sewer_main_type === 'Combined' ? combinedNote(city.code) : ''}${scope.length ? `<p class="metadata">${h(scope.join('，'))}，这里只到街段的主管。</p>` : ''}<p class="metadata">「最近的」主管按地块边界 ${h(meta.main_radius_m ?? 25)} 米内量；转角地和有后巷的地块，可能取到侧街或后巷的那条。</p>${result.method === 'core' ? `<p class="metadata">按街名主体匹配到 ${h(record.address)}，请核对街道类型。</p>` : ''}`;
  }
  return `<div class="site-layer" data-site-layer="pipes"><h3>${h(city.zh)}：市政管网台账</h3>${body}<p class="result-caution">${pipeDisclaimer(meta)}</p><p>官方查询：${links(meta.lookup)}</p>${sourceLine(meta, city.zh)}</div>`;
}

// ---------------------------------------------------------------- 开发申请
// 措辞只用 coverage.json dev_apps.page_wording（站点改动见 reports/home-devapps-wire-1022.md）：
//   主句 {n} 只数 kind=planning 且立项年份不早于 old_before_year（2021）的；较早立项的在审件与市政配套工程放进 summary_more 那句，旧件注「（YYYY 年立项，状态久未更新）」；
//   高贵林较早立项但市府记为已批的，留在主句并注「（YYYY 年立项）」（summary_more 那句只讲「仍为在审」，放不下已批件）；
//   主句 {items} 改成列表（句子前后两半原样保留）；每类按距离最多列 DEV_LIST_MAX 件，其余写件数，指去市府地图；
//   高贵林没有逐件页：主句去掉「点开看市府项目页」，接 coq_link 句（{project_no} 一处只说「按项目号查」），并说明已批项目里有的可能已经建成。
export const DEV_LIST_MAX = 10;
export const DEV_MORE_MAX = 5;
const DESC_MAX = 160;
const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? ''));
const short = (text) => { const t = String(text || '').trim(); return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX)}…` : t; };

export function devAppItemHtml(app, wording, { oldYear, inMore = false } = {}) {
  const template = app.metres === 0 ? wording.item_inside : wording.item;
  const label = '\u0000';
  const text = fill(template, { project_no: label, description: short(app.description) || '市府未写说明', status: app.status, metres: app.metres });
  const number = app.link ? `<a href="${h(app.link)}">${h(app.project_no)}</a>` : h(app.project_no);
  let note = '';
  if (oldYear && Number(app.year) < oldYear) note = app.group === 'active' ? fill('（{year_of_app} 年立项，状态久未更新）', { year_of_app: app.year }) : `（${app.year} 年立项）`;
  const prefix = inMore && app.kind === 'engineering' ? wording.engineering_prefix : '';
  return `${h(prefix)}${h(text).replace(label, number)}${h(note)}`;
}

export function splitDevApps(apps, oldYear, code) {
  const isMain = (app) => app.kind === 'planning' && (!oldYear || Number(app.year) >= oldYear || (code === 'coq' && app.group === 'approved'));
  return { main: apps.filter(isMain), more: apps.filter((app) => !isMain(app)) };
}

export function renderDevApps(result, meta, city, { addressKnown = false } = {}) {
  const w = meta.wording || {};
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}开发申请分桶暂时没能载入，请稍后重试或直接用下面的市府入口。</p>`;
  else if (meta.mode === 'council') body = renderCouncil(result, meta);
  else if (result.status === 'choose') body = `<p>按街名主体匹配到多个门牌：${result.records.map((r) => h(r.address)).join('、')}。请补全街道类型（St、Ave 等）再查。</p>`;
  else if (result.status === 'none') {
    body = addressKnown
      ? `<p>${h(w.none)}</p>`
      : `<p>${h(city.zh)}开发申请索引里没有这个门牌附近的记录；也可能是门牌写法与市府地址不同（附近没有在审或已批申请的门牌也不在索引里）。可用下面的市府入口直接查。</p>`;
  } else {
    const record = result.records[0];
    const apps = record.apps || [];
    const { main, more } = splitDevApps(apps, meta.old_before_year, city.code);
    const parts = [];
    const coq = city.code === 'coq';
    if (main.length) {
      const [head, tail] = String(w.summary).split('{items}');
      const tailText = coq ? '。' : tail.replace(/^，/, '');
      parts.push(`<p>${h(fill(head, { n: main.length }))}</p><ul class="site-layer-list dev-app-list">${main.slice(0, DEV_LIST_MAX).map((app) => `<li>${devAppItemHtml(app, w, { oldYear: meta.old_before_year })}</li>`).join('')}</ul>`);
      if (main.length > DEV_LIST_MAX) parts.push(`<p class="metadata">按距离只列最近 ${DEV_LIST_MAX} 件，其余 ${main.length - DEV_LIST_MAX} 件请在市府地图上看。</p>`);
      if (!coq && tailText.replace(/。$/, '')) parts.push(`<p>${h(tailText)}</p>`);
    }
    if (more.length) {
      const sentence = fill(w.summary_more, { m: more.length });
      parts.push(`<p>${h(main.length ? sentence : sentence.replace(/^另有/, `${meta.near_radius_m || 500} 米内有`))}</p><ul class="site-layer-list dev-app-list">${more.slice(0, DEV_MORE_MAX).map((app) => `<li>${devAppItemHtml(app, w, { oldYear: meta.old_before_year, inMore: true })}</li>`).join('')}</ul>`);
      if (more.length > DEV_MORE_MAX) parts.push(`<p class="metadata">这一类按距离只列最近 ${DEV_MORE_MAX} 件，其余 ${more.length - DEV_MORE_MAX} 件请在市府地图上看。</p>`);
    }
    if (!apps.length) parts.push(`<p>${h(w.none)}</p>`);
    if (apps.some((app) => app.group === 'approved')) parts.push(`<p class="metadata">${h(w.approved_note)}${coq ? '高贵林这份数据也列出近年已批准的项目，其中有的可能已经建成。' : ''}</p>`);
    if (coq && w.coq_link && meta.coq_lookup) {
      const [a, b] = String(w.coq_link).replace(/\s*\{project_no\}\s*/, '').split('{lookup}');
      parts.push(`<p>${h(a)}<a href="${h(meta.coq_lookup)}">${h(meta.coq_lookup)}</a>${h(b)}</p>`);
    }
    parts.push(`<p class="metadata">距离是${coq ? '地块中心' : '门牌点'}到申请地块边线的直线距离（在地块内记 0），只当量级看。${result.method === 'core' ? `按街名主体匹配到 ${h(record.address)}，请核对街道类型。` : ''}</p>`);
    body = parts.join('');
  }
  return `<div class="site-layer" data-site-layer="dev_apps"><h3>${h(city.zh)}：${meta.mode === 'council' ? '市议会改划与开发表决' : '附近的开发申请'}</h3>${body}<p class="result-caution">${h(w.disclaimer || '')}</p><p>官方查询：${links(meta.lookup)}</p>${sourceLine(meta, city.zh)}</div>`;
}

// 温哥华：按街名列近 24 个月表决；同一天同一议程的几次表决（修正案与主动议）并成一项。
function renderCouncil(result, meta) {
  const w = meta.wording || {};
  const [head] = String(w.vw_street).split('{date}');
  let body;
  if (result.status === 'hit') {
    const votes = result.records[0].votes || [];
    const multi = votes.some((vote) => vote[3].length > 1);
    body = `<p>${h(head)}</p><ul class="site-layer-list dev-app-list">${votes.slice(0, DEV_LIST_MAX).map(([voteDate, , agenda, decisions]) => `<li>${h(fill('{date} {agenda}（{decision}）', { date: voteDate, agenda, decision: decisions.join('、') }))}</li>`).join('')}</ul>${votes.length > DEV_LIST_MAX ? `<p class="metadata">只列最近 ${DEV_LIST_MAX} 项，其余 ${votes.length - DEV_LIST_MAX} 项请看市府议程。</p>` : ''}${multi ? '<p class="metadata">同一议程的修正案和主动议分开表决，所以一个事项可能有几个表决结果。</p>' : ''}<p class="metadata">表决窗口 ${h(meta.since)} 至 ${h(meta.until)}；${result.method === 'core' ? '按街名主体对上，请核对街道方向与类型。' : '按街名对上。'}</p>`;
  } else body = `<p>${h(w.vw_none)}</p>`;
  return `${body}<p>${h(w.vw_note)}</p>${devReferralSentence(w.referral, meta.lookup_links || null)}`;
}

// 温哥华、本拿比在途申请入口句（page_wording.referral 原句，{vw}/{bby} 换成市府链接）。
export function devReferralSentence(sentence, linksByCity) {
  if (!sentence || !linksByCity) return '';
  const html = h(sentence).replace(/\{(\w+)\}/g, (_, key) => (linksByCity[key] || []).map((entry) => `<a href="${h(entry.url)}">${h(entry.label)}</a>`).join('、'));
  return `<p>${html}</p>`;
}

// ---------------------------------------------------------------- 地块、门前树、短租、到户合流支管（2026-10-22 接，车道 coverage.<车道>.json）
// 读者句一律取该车道 page_wording 原句，只按其 rules 填空与删子句：
//   地块：宽为空删尺寸子句；分区为空删分区子句；strata＝Y 接 strata_zh；地役权图则号非空才接 easement_zh（「?」与空号不列，全空就去掉括号）；
//         文物附例号放括号；西温 PID 为空删 PID 子句，句尾网址做成链接。温哥华只有地役权线索：分片里没有的门牌整块不出。
//   门前树：树种去重用「、」，胸径取最大三棵用「 与 」，超过三棵加「等」；素里没有胸径、用「附近」句；附例只给市府链接，不说受不受保护，不写种植年份。
//   短租：社区约数（不足 3 用 area_small）＋截至日期＋规则句（省府、市府链接）＋省府原句＋免责；不评分。
const num = (value) => (Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : String(value ?? ''));
const urlLinks = (html) => html.replace(/https:\/\/[^\s<>"'，。；）]+/g, (url) => `<a href="${url}">${url}</a>`);
function layerBlock(layer, heading, body, meta, city, caution) {
  return `<div class="site-layer" data-site-layer="${layer}"><h3>${h(city.zh)}：${h(heading)}</h3>${body}<p class="result-caution">${caution}</p><p>官方查询：${links(meta.lookup)}</p>${sourceLine(meta, city.zh)}</div>`;
}
const chooseBody = (result) => `<p>按街名主体匹配到多个门牌：${result.records.map((r) => h(r.address)).join('、')}。请补全街道类型（St、Ave 等）再查。</p>`;
const coreNote = (result, record) => (result.method === 'core' ? `<p class="metadata">按街名主体匹配到 ${h(record.address)}，请核对街道类型。</p>` : '');

export function parcelSentences(record, wording) {
  const sentence = wording?.sentence || {};
  const template = String(sentence.sentence_zh || '');
  const out = [];
  if (template.includes('{lot_width_ft}') || template.includes('{zone}')) {
    // 本拿比、西温：「按…量算：地块约 W × D 英尺，约 A 平方英尺；Z 分区；…」按「；」切开，空值子句整段去掉。
    const lead = template.match(/^[^：]*：/)?.[0] || '';
    let parts = template.slice(lead.length).split('；');
    if (record.lot_width_ft === null || record.lot_width_ft === undefined) parts = parts.filter((part) => !part.includes('{lot_width_ft}'));
    if (!record.zone) parts = parts.filter((part) => !/^\{zone\}/.test(part));
    if (!record.pid) parts = parts.map((part) => part.replace(/PID \{pid\}.*$/, '')).filter((part) => part.replace(/[。\s]/g, ''));
    let heritage = '';
    if (sentence.heritage_zh) {
      const hz = sentence.heritage_zh;
      heritage = record.heritage_status ? (hz[record.heritage_status] || String(hz.other || '').replace('{heritage_status}', record.heritage_status)) : hz.none;
      if (record.heritage_bylaw) heritage += `（${record.heritage_bylaw}）`;
    }
    let text = (parts.length ? lead : '') + parts.join('；');
    text = fill(text, { lot_width_ft: num(record.lot_width_ft), lot_depth_ft: num(record.lot_depth_ft), lot_area_sqft: num(record.lot_area_sqft), zone: record.zone, pid: record.pid, heritage });
    if (text && !/[。]$/.test(text.trim()) && !/https?:\/\/\S+$/.test(text.trim())) text = `${text.replace(/[；，\s]+$/, '')}。`;
    if (text) out.push(text);
    if (record.strata === 'Y' && sentence.strata_zh) out.push(sentence.strata_zh);
  }
  const plans = (record.easement || []).map((p) => String(p ?? '').trim()).filter((p) => p && p !== '?');
  const easeTemplate = sentence.easement_zh || (template.includes('{easement_labels}') ? template : null);
  if (easeTemplate && Array.isArray(record.easement) && record.easement.length) {
    const key = easeTemplate.includes('{easement_plans}') ? 'easement_plans' : 'easement_labels';
    const text = plans.length ? fill(easeTemplate, { [key]: plans.join('、') }) : easeTemplate.replace(/（[^（）]*\{\w+\}[^（）]*）/, '');
    out.push(text);
  }
  return out;
}

export function renderParcels(result, meta, city) {
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}地块分桶暂时没能载入，请稍后重试或直接用下面的市府地图。</p>`;
  else if (result.status === 'choose') body = chooseBody(result);
  else if (result.status === 'none') {
    if (meta.hits_only) return '';
    body = `<p>${h(city.zh)}地块索引里没有这个门牌；也可能是门牌写法与市府地址不同。可用下面的市府地图直接查。</p>`;
  } else {
    const record = result.records[0];
    const lines = parcelSentences(record, meta.wording);
    body = `${lines.map((line) => `<p>${urlLinks(h(line))}</p>`).join('')}${meta.has_size ? '<p class="metadata">宽和深按地块图形量出（取地块最小外接矩形的短边与长边），规整地块就是临街宽；转角地、旗形地、扇形地的「宽」可能量到侧边。</p>' : ''}${coreNote(result, record)}`;
  }
  return layerBlock('parcels', meta.hits_only ? '地块地役权线索' : '地块', body, meta, city, h(meta.wording?.disclaimer_zh || ''));
}

export function treeSentence(record, meta) {
  const w = meta.wording || {};
  const species = (record.species || []).join('、');
  if (meta.near) return fill(w.sentence_sur_zh, { n: record.n, species, designation: (record.designation || []).join('、') });
  const dbh = record.dbh || [];
  let template = String(w.sentence_zh || '');
  if (!dbh.length) template = template.replace(/，胸径 \{diameters\} cm/, '');
  return fill(template, { n: record.n, species, diameters: `${dbh.join(' 与 ')}${record.n > 3 && dbh.length ? '等' : ''}` });
}
function bylawPointer(meta) {
  const w = meta.wording || {};
  if (!w.bylaw_pointer_zh || !w.bylaw_url) return '';
  const [a, b] = String(w.bylaw_pointer_zh).split('{bylaw_url}');
  return `<p>${h(a)}<a href="${h(w.bylaw_url)}">${h(w.bylaw_url)}</a>${h(b || '')}</p>`;
}
export function renderTrees(result, meta, city, { addressKnown = false } = {}) {
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}树木分桶暂时没能载入，请稍后重试。</p>`;
  else if (result.status === 'choose') body = chooseBody(result);
  else if (result.status === 'none') {
    const list = meta.near ? `${city.zh}市府登记的重要树木清单` : `${city.zh}市府公共树木清单`;
    body = addressKnown
      ? `<p>本站收录的${h(list)}里，没有挂到这个门牌的树（私有地上的树不在清单里）。</p>`
      : `<p>本站收录的${h(list)}里，没有查到这个门牌；也可能是门牌写法与市府地址不同。</p>`;
  } else {
    const record = result.records[0];
    body = `<p>${h(treeSentence(record, meta))}</p>${meta.near ? '<p class="metadata">素里这份清单是公私地上的登记重要树木，按 30 米内最近的门牌挂上，可能在邻地或公园里。</p>' : ''}${coreNote(result, record)}`;
  }
  return layerBlock('trees', meta.near ? '附近登记的重要树木' : '门前树', `${body}${bylawPointer(meta)}`, meta, city, h(meta.wording?.disclaimer_zh || ''));
}

export function strRulesHtml(meta) {
  const w = meta.wording || {};
  const link = (url) => (url ? `<a href="${h(url)}">${h(url)}</a>` : '');
  return h(w.rules || '').replace('{province_url}', link(meta.province_url)).replace('{city_url}', link(meta.city_url));
}
export function renderStr(result, meta, city) {
  const w = meta.wording || {};
  let body;
  if (result?.status === 'hit') {
    const { local_area: area, n } = result.records[0];
    const small = n === meta.small || (Number.isFinite(Number(n)) && Number(n) < 3);
    body = `<p>${h(fill(small ? w.area_small : w.area, { local_area: area, n: num(n), city_n: num(meta.city_n), as_of: meta.as_of }))}</p>`;
  } else if (result?.status === 'none') body = `<p>市府短租牌照统计里没有「${h(result.records[0]?.local_area || '')}」这个社区的有效牌照记录（全市约 ${h(num(meta.city_n))} 个，截至 ${h(meta.as_of)}）。</p>`;
  else body = `<p class="metadata">这个门牌没有识别出所在社区（local area），社区级的短租牌照数无从对应。</p>`;
  const quote = (meta.province_quote || []).length ? `<blockquote class="source-quote" lang="en"><p>${meta.province_quote.map((line) => h(line)).join(' ')}</p><p class="metadata">— 省府页原文${meta.province_updated ? `（页面更新于 ${h(meta.province_updated)}）` : ''}</p></blockquote>` : '';
  return layerBlock('str', '社区短租牌照', `${body}<p>${strRulesHtml(meta)}</p>${quote}`, meta, city, h(w.disclaimer || ''));
}

// 本拿比到户接驳：只出合流制那一句（中心裁决，供水接驳、污水支管两层不上站）；分片只收有合流支管的门牌，没有就整块不出。
export function combinedLateralHtml(record, meta) {
  const w = meta.wording || {};
  const material = materialText(record.combined_lateral_material, meta.materials || {});
  let text = String(w.sentence_combined_zh || '');
  if (!record.combined_lateral_year) text = text.replace(/\{combined_lateral_year\} 年铺设、?/, '');
  if (!material) text = text.replace(/、?\{combined_lateral_material\}/, '');
  text = fill(text, { combined_lateral_year: record.combined_lateral_year, combined_lateral_material: material });
  const [a, b] = text.split('（链接）');
  return b === undefined || !w.subsidy?.url ? `<p>${h(text.replace('（链接）', ''))}</p>` : `<p>${h(a)}（<a href="${h(w.subsidy.url)}">${h(w.subsidy.label || '市府页面')}</a>）${h(b)}</p>`;
}
export function renderPipesHouse(result, meta, city) {
  let body;
  if (!result || result.status === 'error') body = `<p class="result-error">${h(city.zh)}到户接驳分桶暂时没能载入，请稍后重试。</p>`;
  else if (result.status === 'choose') body = chooseBody(result);
  else if (result.status === 'none') return '';
  else body = `${combinedLateralHtml(result.records[0], meta)}${coreNote(result, result.records[0])}`;
  return layerBlock('pipes_house', '到户合流支管', body, meta, city, h(meta.wording?.disclaimer_zh || ''));
}

export const RENDERERS = { overlays: renderOverlays, pipes: renderPipes, dev_apps: renderDevApps, parcels: renderParcels, trees: renderTrees, str: renderStr, pipes_house: renderPipesHouse };

// 两栏：每栏只放该城市实际有的层；一层都没有的栏不出。
export function renderSiteLayers(results, code, manifest, { addressKnown = false } = {}) {
  const city = manifest?.cities?.[code];
  if (!city) return '';
  const known = addressKnown || Object.values(results || {}).some((r) => r?.status === 'hit');
  return Object.entries(PANELS).map(([key, panel]) => {
    const blocks = panel.layers.filter((layer) => (city[layer]?.buckets || city[layer]?.inline) && RENDERERS[layer]).map((layer) => RENDERERS[layer](results?.[layer], layer === 'dev_apps' ? { ...city[layer], lookup_links: manifest.dev_referral?.links } : city[layer], city, { addressKnown: known }));
    if (key === 'risk' && !city.dev_apps) blocks.push(renderDevReferral(code, manifest));
    return blocks.filter(Boolean).length ? `<section class="result-card site-layers" data-site-panel="${h(key)}"><h2>${h(panel.title)}</h2><p class="metadata">${h(panel.lede)}；不评分，以市府官方图层与记录为准。</p>${blocks.filter(Boolean).join('')}</section>` : '';
  }).join('');
}

// 本拿比：没有在途开发申请的开放数据，只给入口句（取 coverage.dev_apps.referrals 与 page_wording.referral）。
export function renderDevReferral(code, manifest) {
  const ref = manifest?.dev_referral;
  if (!ref?.links?.[code]) return '';
  return `<div class="site-layer" data-site-layer="dev_apps"><h3>${h(manifest.cities?.[code]?.zh || '')}：附近的开发申请</h3>${devReferralSentence(ref.sentence, ref.links)}<p class="result-caution">${h(ref.disclaimer || '')}</p></div>`;
}

// 西温、北温市：许可区没有开放数据，只给市府入口（page_wording.referral 原句，入口取 overlays.referrals）。
export function renderOverlayReferral(code, manifest) {
  const ref = manifest?.overlay_referrals?.[code];
  if (!ref) return '';
  const sentence = String(manifest.overlay_referral_sentence || '');
  const linked = Object.entries(manifest.overlay_referrals).reduce((text, [key, entry]) => text.replace(`{${key}}`, `\u0000${key}\u0000`), sentence);
  const html = h(linked).replace(/\u0000(\w+)\u0000/g, (_, key) => `<a href="${h(manifest.overlay_referrals[key].url)}">${h(manifest.overlay_referrals[key].name)}</a>`);
  return `<section class="result-card site-layers" data-site-panel="risk"><h2>限制与风险</h2><p>${html}</p><p class="result-caution">${h(manifest.disclaimer || '')}</p></section>`;
}

export function siteLayerPlaceholder(code, manifest) {
  return siteLayersFor(manifest, code).length ? '<div data-site-layers aria-live="polite"><p class="metadata">正在载入地块、门前树、许可区、管网与开发申请分桶…</p></div>' : '';
}

export { PIPE_FIELDS };

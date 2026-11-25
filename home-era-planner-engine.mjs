// 房龄与大修年 → 未来十年大件日历（/home/era/planner/ 的计算核心，浏览器与单测共用，零外部请求）。
// 模型由构建期从 src/data/home-era-planner.json、年代档与专题页本页事实拼成；本文件不含任何年限常数。
// 口径：寿命区间只来自带原句的已核事实，没有原句的部件只给「查验房报告」与链接，不出年份；结果一律是区间。

export const HORIZON_YEARS = 10;
const ERA_NOTE_FIELDS = ['checks', 'inspection_extra', 'insurance_questions', 'typical'];

export function parseYear(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const year = Number(String(value).trim());
  return Number.isInteger(year) ? year : NaN;
}

export function eraOf(eras, year) {
  return (eras || []).find((era) => (era.from === null || year >= era.from) && (era.to === null || year <= era.to)) || null;
}

const verified = (items) => (items || []).filter((item) => item.status === 'verified');

// 区间相对展望期的位置：over＝整个区间在今年之前已结束；past＝起点已到或已过；in-horizon＝起点落在展望期内；beyond＝展望期内不到。
function windowStatus(from, to, horizon) {
  if (to !== null && to < horizon.from) return 'over';
  if (from <= horizon.from) return 'past';
  if (from <= horizon.to) return 'in-horizon';
  return 'beyond';
}

function yearsInside(from, to, horizon) {
  const out = [];
  for (let year = Math.max(from, horizon.from); year <= Math.min(to ?? horizon.to, horizon.to); year += 1) out.push(year);
  return out;
}

export function planPart(part, { builtYear, replacedYear, horizon, era }) {
  const base = Number.isInteger(replacedYear) ? { year: replacedYear, source: 'replaced' } : { year: builtYear, source: 'built' };
  const pattern = part.match ? new RegExp(part.match, 'i') : null;
  const exclude = part.exclude ? new RegExp(part.exclude, 'i') : null;
  const seen = new Set();
  const eraNotes = pattern && era ? ERA_NOTE_FIELDS.flatMap((field) => verified(era[field]).map((item) => ({ ...item, field })))
    .filter((item) => pattern.test(item.text) && !(exclude && exclude.test(item.text)) && !seen.has(item.text) && seen.add(item.text)) : [];
  const result = { key: part.key, label: part.label, base, age: horizon.from - base.year, window: null, calendarYears: [], noYearReason: null, eraNotes, topics: part.topics || [], lifespan: part.lifespan || null };
  const life = part.lifespan;
  if (!life || !Number.isInteger(life.minYears)) {
    result.noYearReason = part.noYearReason || '站内还没有写明这个部件使用年限的原句';
    return result;
  }
  const from = base.year + life.minYears;
  const to = Number.isInteger(life.maxYears) ? base.year + life.maxYears : null;
  result.window = { from, to, status: windowStatus(from, to, horizon), kind: life.kind || 'lifespan' };
  result.calendarYears = yearsInside(from, to, horizon);
  return result;
}

// 新房保修：按法规列明的起算日（入住、入住许可、过户等，因房屋类型而异）；登记建年与起算日可能差一年，所以到期写成两年的区间。
// 强制保修只覆盖在 startYear 年中起申请许可的房子，建年紧挨 startYear 的判不了。
export function planWarranty(warranty, { builtYear, horizon }) {
  if (!warranty || !Number.isInteger(warranty.startYear)) return { applies: 'unknown', rows: [] };
  const applies = builtYear < warranty.startYear ? 'no' : builtYear <= warranty.startYear + 1 ? 'unknown' : 'yes';
  if (applies === 'no') return { applies, rows: [], topics: warranty.topics || [] };
  const rows = (warranty.terms || []).filter((term) => Number.isInteger(term.years)).map((term) => {
    const from = builtYear + term.years, to = from + 1;
    const status = to < horizon.from ? 'expired' : from <= horizon.from ? 'now' : from <= horizon.to ? 'in-horizon' : 'beyond';
    return { key: term.key, label: term.label, years: term.years, from, to, status, calendarYears: yearsInside(from, to, horizon) };
  });
  return { applies, rows, topics: warranty.topics || [] };
}

export function planHome(input, model, { currentYear }) {
  const errors = [];
  const horizon = { from: currentYear, to: currentYear + HORIZON_YEARS };
  const builtYear = parseYear(input?.builtYear);
  if (builtYear === null) return { ok: false, errors: ['请先填建造年份'] };
  if (Number.isNaN(builtYear) || builtYear < 1800 || builtYear > currentYear + 5) return { ok: false, errors: ['建造年份需要是四位年份，且不晚于近几年'] };
  const era = eraOf(model.eras, builtYear);
  const replaced = {};
  for (const part of model.parts) {
    const year = parseYear(input?.replaced?.[part.key]);
    if (year === null) continue;
    if (Number.isNaN(year) || year > currentYear) errors.push(`${part.label}的更换年份需要是今年或以前的四位年份，已按建年推算`);
    else if (year < builtYear) errors.push(`${part.label}的更换年份早于建造年份，已按建年推算`);
    else replaced[part.key] = year;
  }
  const parts = model.parts.map((part) => planPart(part, { builtYear, replacedYear: replaced[part.key], horizon, era }));
  return {
    ok: true,
    errors,
    builtYear,
    horizon,
    era: era ? {
      id: era.id,
      label: era.label,
      anchor: `era-${era.id.toLowerCase()}`,
      inspection: [...verified(era.checks), ...verified(era.inspection_extra)],
      insurance: verified(era.insurance_questions),
      topics: model.eraTopics?.[era.id] || [],
    } : null,
    parts,
    warranty: planWarranty(model.warranty, { builtYear, horizon }),
  };
}

export const ERA_FIELDS = ['typical', 'pros', 'livability', 'checks', 'inspection_extra', 'insurance_questions', 'holding_cost', 'financing'];
export const ERA_FIELD_LABELS = { typical: '常见情况', pros: '可能的优点', livability: '住着怎样', checks: '要查什么', inspection_extra: '验房外加查', insurance_questions: '投保常被问', holding_cost: '持有成本驱动', financing: '贷款方常问' };

export function eraForYear(eras, year) {
  const value = Number(year);
  if (!Number.isInteger(value) || value < 1800 || value > 2200) return null;
  return (eras || []).find((era) => (era.from === null || value >= era.from) && (era.to === null || value <= era.to)) || null;
}

export function verifiedEra(era) {
  if (!era) return null;
  return {
    ...era,
    ...Object.fromEntries(ERA_FIELDS.map((field) => [field, (era[field] || []).filter((item) => item.status === 'verified')])),
  };
}

export function hasImprovementYear(record) {
  return Number.isInteger(Number(record?.big_improvement_year)) && Number(record.big_improvement_year) > 0;
}

export function eraAnchor(id) {
  return `era-${String(id || '').toLowerCase()}`;
}

// 各档通用条（data.common）只存一份；年代档里写 {"ref":"<id>"}，读入时展开成完整条目并保留 ref，
// 年代档页把 ref 渲染成指向「各档通用」节的链接，地址卡等只显示一档的地方照常显示全文并标「各档通用」。
export function resolveEraRefs(data) {
  const common = new Map((data?.common || []).map((item) => [item.id, item]));
  return {
    ...data,
    eras: (data?.eras || []).map((era) => ({
      ...era,
      ...Object.fromEntries(ERA_FIELDS.map((field) => [field, (era[field] || []).map((item) => (item?.ref && common.has(item.ref) ? { ...common.get(item.ref), ref: item.ref } : item))])),
    })),
  };
}

export function eraItemText(item) {
  return item?.ref ? `各档通用：${item.text}` : item?.text;
}

export function commonAnchor(id) {
  return `era-common-${String(id || '').toLowerCase()}`;
}

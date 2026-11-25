export const BRIEF_COMMUTE_FILTERS = Object.freeze({
  ubc: Object.freeze({ rapid_max: '800' }),
  downtown: Object.freeze({ skytrain_max: '800' }),
  airport: Object.freeze({ skytrain_max: '800' }),
  richmond: Object.freeze({ skytrain_max: '800' }),
});

export const BRIEF_REDEVELOPMENT_FILTERS = Object.freeze({
  no: Object.freeze({}),
  consider: Object.freeze({ frontage_min: '50', zoning: 'R1-1' }),
  priority: Object.freeze({ frontage_min: '55.1', zoning: 'R1-1' }),
});

const cleanNumber = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d+(?:\.\d+)?$/.test(text) || Number(text) < 0) throw new TypeError(`${label}必须是非负数`);
  return String(Number(text));
};

const uniqueStrings = (values) => [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];

export function buildBriefSearchPaths(values, entities = {}) {
  const schoolSlugs = new Set((entities.schools || []).map((school) => school.slug));
  const localAreas = new Set((entities.communities || []).map((community) => community.en));
  const schools = uniqueStrings(values.schools);
  const local = String(values.local || '').trim();
  const commute = String(values.commute || '').trim();
  const redevelopment = String(values.redevelopment || 'no').trim();
  const priceMin = cleanNumber(values.priceMin, '预算下限');
  const priceMax = cleanNumber(values.priceMax, '预算上限');

  if (priceMin && priceMax && Number(priceMin) > Number(priceMax)) throw new RangeError('预算下限不能高于上限');
  if (local && !localAreas.has(local)) throw new RangeError('偏好社区不在可选实体中');
  if (schools.some((slug) => !schoolSlugs.has(slug))) throw new RangeError('目标学校不在可选实体中');
  if (commute && !BRIEF_COMMUTE_FILTERS[commute]) throw new RangeError('通勤点没有登记映射');
  if (!BRIEF_REDEVELOPMENT_FILTERS[redevelopment]) throw new RangeError('拆建偏好没有登记映射');

  const base = {
    ...(priceMin ? { price_min: priceMin } : {}),
    ...(priceMax ? { price_max: priceMax } : {}),
    ...(local ? { local } : {}),
    ...(commute ? BRIEF_COMMUTE_FILTERS[commute] : {}),
    ...BRIEF_REDEVELOPMENT_FILTERS[redevelopment],
  };
  const targets = schools.length ? schools : [null];
  return targets.map((near) => {
    const params = new URLSearchParams(base);
    if (near) {
      params.set('near', near);
      params.set('r', '800');
    }
    return `/veryvisa-com-site/home/search/${params.size ? `?${params}` : ''}`;
  });
}

export function briefRepresentativeCases(entities) {
  const rows = [
    { label: '空条件', values: {} },
    { label: '预算上下限', values: { priceMin: '1500000', priceMax: '3000000' } },
    ...Object.keys(BRIEF_COMMUTE_FILTERS).map((commute) => ({ label: `通勤 ${commute}`, values: { commute } })),
    ...Object.keys(BRIEF_REDEVELOPMENT_FILTERS).map((redevelopment) => ({ label: `拆建 ${redevelopment}`, values: { redevelopment } })),
    ...(entities.communities || []).map((community) => ({ label: `社区 ${community.en}`, values: { local: community.en } })),
    ...(entities.schools || []).map((school) => ({ label: `学校 ${school.slug}`, values: { schools: [school.slug] } })),
  ];
  const firstTwo = (entities.schools || []).slice(0, 2).map((school) => school.slug);
  if (firstTwo.length === 2) rows.push({ label: '学校多选', values: { schools: firstTwo, commute: 'ubc', redevelopment: 'consider' } });
  return rows.flatMap((row) => buildBriefSearchPaths(row.values, entities).map((path) => ({ ...row, path })));
}

function selectedValues(select) {
  return [...select.selectedOptions].map((option) => option.value).filter(Boolean);
}

export function initHomeBrief(documentRef = document, windowRef = window) {
  const form = documentRef.querySelector('[data-home-brief-form]');
  if (!form) return;
  const entities = JSON.parse(documentRef.getElementById('home-brief-entities')?.textContent || '{"schools":[],"communities":[]}');
  const output = documentRef.querySelector('[data-home-brief-output]');
  const status = documentRef.querySelector('[data-home-brief-status]');
  const copyAll = documentRef.querySelector('[data-copy-brief-links]');
  let currentUrls = [];

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const fields = form.elements;
      const paths = buildBriefSearchPaths({
        priceMin: fields.priceMin.value,
        priceMax: fields.priceMax.value,
        schools: selectedValues(fields.schools),
        commute: fields.commute.value,
        redevelopment: fields.redevelopment.value,
        local: fields.local.value,
      }, entities);
      currentUrls = paths.map((path) => new URL(path, windowRef.location.origin).toString());
      output.innerHTML = currentUrls.map((url, index) => `<li><a href="${url.replaceAll('&', '&amp;')}">${url.replaceAll('&', '&amp;')}</a><button type="button" data-copy-brief-link="${index}">复制这条</button></li>`).join('');
      status.textContent = `已在本页生成 ${currentUrls.length.toLocaleString('zh-Hans-CA')} 条网址；没有发送或保存表单内容。`;
      copyAll.disabled = false;
    } catch (error) {
      currentUrls = [];
      output.innerHTML = '';
      copyAll.disabled = true;
      status.textContent = error.message;
    }
  });

  output.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-copy-brief-link]');
    if (!button) return;
    await windowRef.navigator.clipboard.writeText(currentUrls[Number(button.dataset.copyBriefLink)]);
    status.textContent = '已复制这条网址。';
  });
  copyAll.addEventListener('click', async () => {
    await windowRef.navigator.clipboard.writeText(currentUrls.join('\n'));
    status.textContent = `已复制 ${currentUrls.length.toLocaleString('zh-Hans-CA')} 条网址。`;
  });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initHomeBrief();

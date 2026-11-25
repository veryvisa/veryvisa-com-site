// /home/era/planner/ 浏览器端：读页面内嵌模型，按输入实时渲染；不发请求、不存储。计算见 /home-era-planner-engine.mjs。
import { planHome } from '/veryvisa-com-site/home-era-planner-engine.mjs';

const form = document.querySelector('[data-era-plan-form]');
const output = document.querySelector('[data-era-plan-output]');
const modelNode = document.querySelector('#era-plan-model');

if (form && output && modelNode) {
  const model = JSON.parse(modelNode.textContent);
  const currentYear = new Date().getFullYear();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const anchor = (href, text, title) => {
    const a = el('a', '', text);
    a.href = href;
    if (title) a.title = title;
    return a;
  };
  const section = (title) => {
    const wrapper = el('section', 'cost-result-section');
    wrapper.append(el('h3', '', title));
    output.append(wrapper);
    return wrapper;
  };
  const factList = (parent, items) => {
    const list = el('ul', 'era-plan-list');
    for (const item of items) {
      const li = el('li');
      li.append(el('span', '', item.text), ' ', anchor(item.source_url, '出处', item.source_title));
      list.append(li);
    }
    parent.append(list);
  };
  const topicLine = (parent, label, topics) => {
    if (!topics?.length) return;
    const p = el('p', 'era-plan-links');
    p.append(`${label}：`);
    topics.forEach((topic, index) => { if (index) p.append('、'); p.append(anchor(topic.href, topic.title)); });
    parent.append(p);
  };
  const strip = (horizon, years, label) => {
    const row = el('div', 'era-plan-strip');
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', label);
    for (let year = horizon.from; year <= horizon.to; year += 1) {
      const cell = el('span', years.includes(year) ? 'on' : '', String(year).slice(2));
      cell.title = String(year);
      row.append(cell);
    }
    return row;
  };
  const range = (from, to) => (to === null ? `${from} 年起` : `${from}–${to} 年间`);

  const partText = (part, horizon) => {
    const w = part.window;
    if (w.kind === 'insurer-preference') {
      if (w.status === 'past') return `已在保险公司通常希望的更新年限之外（${range(w.from, w.to)}）。投保或续保时可能被追问屋顶年份，验房报告的屋顶一节要细看。`;
      if (w.status === 'in-horizon') return `${range(w.from, w.to)}超出保险公司通常希望的更新年限，落在未来十年之内。`;
      return `未来十年内还在保险公司通常希望的更新年限之内（${range(w.from, w.to)}才超出）。`;
    }
    if (w.kind === 'useful-life-estimate') {
      if (w.status === 'over') return `已超过 BC 住宅租务处估计的使用年限（${range(w.from, w.to)}）。若一直没换过，这一项请优先请持牌技师查看。`;
      if (w.status === 'past') return `已到 BC 住宅租务处估计的使用年限（${range(w.from, w.to)}）。这是参考年数，状况以验房为准。`;
      if (w.status === 'in-horizon') return `${range(w.from, w.to)}到 BC 住宅租务处估计的使用年限，落在未来十年之内。`;
      return `未来十年内不到 BC 住宅租务处估计的使用年限（${range(w.from, w.to)}）。`;
    }
    if (w.status === 'over') return `已超过使用年限区间（${range(w.from, w.to)}）。若一直没换过，这一项请优先请持牌技师查看。`;
    if (w.status === 'past') return `已进入使用年限区间（${range(w.from, w.to)}）。`;
    if (w.status === 'in-horizon') return `${range(w.from, w.to)}进入使用年限区间。`;
    return `未来十年内不到使用年限区间（${range(w.from, w.to)}）。`;
  };

  function render() {
    const input = { builtYear: form.elements.builtYear.value, replaced: {} };
    for (const part of model.parts) input.replaced[part.key] = form.elements[`replaced-${part.key}`].value;
    const plan = planHome(input, model, { currentYear });
    output.replaceChildren();
    if (!plan.ok) {
      output.append(el('p', '', plan.errors.join('；')));
      return;
    }
    const { horizon } = plan;

    const head = el('section', 'cost-summary era-plan-summary');
    head.append(el('p', 'eyebrow', `建于 ${plan.builtYear} 年 · 展望 ${horizon.from}–${horizon.to} 年`));
    if (plan.era) {
      const h = el('h3');
      h.append(anchor(`/veryvisa-com-site/home/era/#${plan.era.anchor}`, plan.era.label));
      head.append(h, el('p', 'metadata', '下面是这一年代的一般规律，不是对这栋房子的判断。'));
    } else head.append(el('p', '', '这个年份没有落进年代档，只显示大件日历。'));
    for (const message of plan.errors) head.append(el('p', 'metadata', message));
    output.append(head);

    if (plan.era) {
      const inspect = section('按年代该重点验什么');
      factList(inspect, plan.era.inspection);
      const insure = section('保险问卷常问的');
      factList(insure, plan.era.insurance);
      topicLine(insure, '这一年代的专题', plan.era.topics);
    }

    const calendar = section(`未来十年大件日历（${horizon.from}–${horizon.to}）`);
    const list = el('ul', 'cost-list era-plan-calendar');
    for (const part of plan.parts) {
      const li = el('li', `cost-row${part.window ? '' : ' cost-pending'}`);
      const top = el('div', 'cost-row-top');
      top.append(el('span', 'cost-label', part.label), el('strong', 'cost-value', part.window ? range(part.window.from, part.window.to) : '不出年份'));
      li.append(top);
      li.append(el('p', 'metadata', part.base.source === 'replaced' ? `按您填的 ${part.base.year} 年更换算起` : `未填更换年，按建造年份 ${part.base.year} 年推；若一直没换过，已用约 ${part.age} 年`));
      if (part.window) {
        li.append(el('p', '', partText(part, horizon)));
        if (part.calendarYears.length) li.append(strip(horizon, part.calendarYears, `${part.label}在展望期内的落点`));
        const src = el('p', 'metadata');
        src.append(`依据：${part.lifespan.subject}「${part.lifespan.quote}」 `, anchor(part.lifespan.source_url, '原文'), '，站内见 ', anchor(part.lifespan.page.href, part.lifespan.page.title));
        li.append(src);
      } else {
        li.append(el('p', '', `${part.noYearReason}。请看验房报告对这一项的描述，或请相应的持牌技师查看。`));
      }
      if (part.eraNotes.length) {
        li.append(el('p', 'metadata', part.base.source === 'replaced' ? '按建年常见（您填了更换年，请用许可记录或发票核对换了哪些）：' : '按建年常见：'));
        factList(li, part.eraNotes);
      }
      topicLine(li, '细节', part.topics);
      list.append(li);
    }
    calendar.append(list);

    const w = plan.warranty;
    const warranty = section('新房保修');
    if (w.applies === 'no') warranty.append(el('p', '', `建造年份早于 ${model.warranty.startYear} 年，按规定没有强制新房保修（${model.warranty.startValue}起申请许可的新房才有）。`));
    else {
      if (w.applies === 'unknown') warranty.append(el('p', '', `建造年份紧挨 ${model.warranty.startValue}，要看建筑许可是哪天申请的，才知道有没有强制新房保修。`));
      const rows = el('ul', 'cost-list');
      for (const row of w.rows) {
        const li = el('li', 'cost-row');
        const top = el('div', 'cost-row-top');
        top.append(el('span', 'cost-label', `${row.label}（${row.years} 年）`), el('strong', 'cost-value', `${row.from}–${row.to} 年间到期`));
        li.append(top);
        li.append(el('p', 'metadata', row.status === 'expired' ? '按年份推算已经到期。' : row.status === 'now' ? '按年份推算就在今明两年到期，请按保修起算日（入住、入住许可或过户等）核对。' : row.status === 'in-horizon' ? '落在未来十年之内，保修随房转给下一任业主。' : '未来十年之后才到期。'));
        if (row.calendarYears.length) li.append(strip(horizon, row.calendarYears, `${row.label}在展望期内的到期区间`));
        rows.append(li);
      }
      warranty.append(rows);
    }
    topicLine(warranty, '细节', model.warranty.topics);

    output.append(el('p', 'metadata', '区间按年份相加得出，是排问题清单用的提醒；部件真实状况以验房、许可记录和卖方披露为准。'));
  }

  form.addEventListener('input', render);
  form.addEventListener('submit', (event) => { event.preventDefault(); render(); });
  render();
}

import { calculateHomeCost } from '/veryvisa-com-site/home-cost-engine.mjs';

const form = document.querySelector('[data-home-cost-form]');
const output = document.querySelector('[data-home-cost-output]');
const ruleNode = document.querySelector('#home-cost-rules');

if (form && output && ruleNode) {
  const rules = JSON.parse(ruleNode.textContent);
  const priceInput = form.elements.price;
  const downPaymentInput = form.elements.downPaymentPercent;
  priceInput.value = String(rules.ptt.firstTime.fullThreshold);
  downPaymentInput.value = String(rules.downPayment.highPriceRate * 100);

  const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const sourceButton = (sourceId) => {
    if (!sourceId) return null;
    const button = el('button', 'fact-source result-source', '源');
    button.type = 'button';
    button.dataset.homeCostSource = sourceId;
    button.setAttribute('aria-label', '查看这项参数的出处');
    return button;
  };
  const addRow = (list, label, value, note, sourceId, state = '') => {
    const item = el('li', `cost-row${state ? ` ${state}` : ''}`);
    const top = el('div', 'cost-row-top');
    top.append(el('span', 'cost-label', label), el('strong', 'cost-value', value));
    const button = sourceButton(sourceId);
    if (button) top.append(button);
    item.append(top);
    if (note) item.append(el('p', 'metadata', note));
    list.append(item);
  };
  const section = (title) => {
    const wrapper = el('section', 'cost-result-section');
    wrapper.append(el('h3', '', title));
    const list = el('ul', 'cost-list');
    wrapper.append(list);
    output.append(wrapper);
    return list;
  };
  const exemptionLabel = (item) => ({
    full: '符合全额区间',
    partial: '符合部分区间',
    'over-limit': '超过价格门槛',
    ineligible: '身份条件不符',
    'pending-eligibility': '资格参数待核',
    'not-requested': '未选择',
  }[item.status] ?? '未计入');

  function render() {
    const price = Number(priceInput.value);
    const downPaymentPercent = Number(downPaymentInput.value);
    output.replaceChildren();
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(downPaymentPercent) || downPaymentPercent < 0 || downPaymentPercent > 100) {
      output.append(el('p', 'result-message', '请填写有效房价与首付比例。'));
      return;
    }
    let result;
    try {
      result = calculateHomeCost({
        price,
        downPaymentRatio: downPaymentPercent / 100,
        firstTimeBuyer: form.elements.firstTimeBuyer.checked,
        newlyBuilt: form.elements.newlyBuilt.checked,
        residency: form.elements.residency.value,
      }, rules);
    } catch {
      output.append(el('p', 'result-message', '输入暂时无法计算，请检查后重试。'));
      return;
    }

    const summary = el('section', 'cost-summary');
    summary.append(el('p', 'eyebrow', '当前估算'));
    summary.append(el('strong', 'cost-summary-number', money.format(result.cashNeededAtCompletion)));
    summary.append(el('p', 'metadata', '成交前需准备的首付，加上本页能计算的 PTT 与外国买家附加税。首付会形成房屋权益，不等同于费用。待核参数未计入。'));
    output.append(summary);

    const cash = section('资金与最低首付');
    addRow(cash, '按输入比例计算的首付', money.format(result.downPayment), `输入比例：${percent.format(result.downPayment / result.price)}`);
    addRow(cash, '规则要求的最低首付', money.format(result.minimumDownPayment), result.downPaymentShortfall ? `目前少于最低要求 ${money.format(result.downPaymentShortfall)}。` : '输入首付不低于本页规则算出的最低额。', rules.downPayment.sourceId, result.downPaymentShortfall ? 'cost-warning' : '');

    const ptt = section('产权转让税明细');
    for (const row of result.ptt.breakdown) {
      const range = row.upper === null ? `超过 ${money.format(row.lower)} 的部分` : `${money.format(row.lower)} 至 ${money.format(row.upper)} 的部分`;
      addRow(ptt, row.kind === 'residential-surcharge' ? '高价值住宅附加档' : range, money.format(row.tax), `${money.format(row.taxable)} × ${percent.format(row.rate)}`, row.sourceId);
    }
    addRow(ptt, '豁免前 PTT', money.format(result.ptt.grossTax), '各税档相加。');
    addRow(ptt, '首次购房者豁免判断', exemptionLabel(result.ptt.firstTime), `${result.ptt.firstTime.reason} 估算减免 ${money.format(result.ptt.firstTime.amount)}。`, rules.ptt.firstTime.sourceIds[0]);
    addRow(ptt, '新建房豁免判断', exemptionLabel(result.ptt.newHome), `${result.ptt.newHome.reason} 估算减免 ${money.format(result.ptt.newHome.amount)}。`, rules.ptt.newHome.sourceIds[0]);
    addRow(ptt, '实际采用的豁免', money.format(result.ptt.applied.amount), result.ptt.applied.kind === 'none' ? '没有豁免计入。' : '两项同时出现时采用较高一项，不重复相加。');
    addRow(ptt, '估算应付 PTT', money.format(result.ptt.netTax), '豁免前 PTT 减去采用的豁免。');

    const other = section('其他一次性项目');
    addRow(other, '外国买家附加税', money.format(result.foreignBuyerTax), result.foreignBuyerTax ? '按外国人身份与全部房价估算；联邦购买禁令及例外仍须另行核对。' : '当前身份选择不计外国买家附加税。', rules.ptt.foreignBuyer.sourceId);
    addRow(other, '已知一次性税费小计', money.format(result.knownOneTimeCosts), '只含估算应付 PTT 与外国买家附加税。');
    for (const label of ['律师或公证费', '验房费', '估价费', '房屋保险', '按揭保险费率', '搬家及调整款']) addRow(other, label, '待核参数／需报价', '事实台账没有可用金额，不计入合计。', null, 'cost-pending');

    const mortgage = section('贷款压力测试');
    addRow(mortgage, '合格利率口径', '取两者较高', `合同利率加 ${percent.format(rules.stressTest.buffer)}，或 ${percent.format(rules.stressTest.floor)}。本页没有收入、负债与合同利率，因此不判断可贷金额。`, rules.stressTest.sourceId);

    const holding = section('第一年持有成本与申报提示');
    addRow(holding, '温哥华市空置税', '可能涉及年度申报，参数待核', '位于温哥华市的住宅请向市府核对当年申报与自住、出租等规则；事实台账没有可用的市级税率及豁免参数，因此不计入合计。', null, 'cost-pending');
    addRow(holding, 'BC 投机与空置税', rules.speculation.appliesToVancouver ? '可能适用，需申报判断' : '待核适用区域', `温哥华市在台账所列适用区域内；是否缴税取决于身份、居住、出租与豁免。台账所列公民或永久居民税率为 ${percent.format(rules.speculation.citizenPrRate)}，本页不把潜在税额计入合计。`, rules.speculation.areaSourceId);
    addRow(holding, '地税、物业费与维修', '待核参数／需报价', '需用具体地址、物业文件与报价核对，不计入合计。', null, 'cost-pending');
  }

  form.addEventListener('input', render);
  form.addEventListener('change', render);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-home-cost-source]');
    if (!button) return;
    const fact = [...document.querySelectorAll('[data-fact-id]')].find((node) => node.dataset.factId === button.dataset.homeCostSource);
    if (!fact) return;
    const details = fact.querySelector('details');
    if (details) details.open = true;
    fact.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  render();
}

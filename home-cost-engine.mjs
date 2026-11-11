const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0;

function assertRate(value, label) {
  if (!finiteNonNegative(value) || value > 1) throw new RangeError(`invalid ${label}`);
}

function assertThreshold(value, label) {
  if (!finiteNonNegative(value)) throw new RangeError(`invalid ${label}`);
}

function validateRules(rules) {
  if (!rules || !Array.isArray(rules.ptt?.brackets) || !rules.ptt.brackets.length) throw new TypeError('missing PTT rules');
  let prior = 0;
  for (const [index, bracket] of rules.ptt.brackets.entries()) {
    assertRate(bracket.rate, 'PTT rate');
    if (bracket.upTo !== null) {
      assertThreshold(bracket.upTo, 'PTT threshold');
      if (bracket.upTo <= prior) throw new RangeError('PTT thresholds must increase');
      prior = bracket.upTo;
    } else if (index !== rules.ptt.brackets.length - 1) throw new RangeError('open PTT bracket must be last');
  }
  for (const [label, exemption] of Object.entries({ firstTime: rules.ptt.firstTime, newHome: rules.ptt.newHome })) {
    if (!exemption) throw new TypeError(`missing ${label} rules`);
    assertThreshold(exemption.fullThreshold, `${label} full threshold`);
    assertThreshold(exemption.phaseOutThreshold, `${label} phase-out threshold`);
    if (exemption.phaseOutThreshold <= exemption.fullThreshold) throw new RangeError(`invalid ${label} phase-out range`);
  }
  assertThreshold(rules.ptt.firstTime.exemptValueCap, 'first-time exempt value cap');
  assertThreshold(rules.ptt.residentialSurcharge.threshold, 'residential surcharge threshold');
  assertRate(rules.ptt.residentialSurcharge.rate, 'residential surcharge rate');
  assertRate(rules.ptt.foreignBuyer.rate, 'foreign-buyer rate');
  assertThreshold(rules.downPayment.baseThreshold, 'down-payment base threshold');
  assertThreshold(rules.downPayment.highPriceThreshold, 'down-payment high-price threshold');
  if (rules.downPayment.highPriceThreshold <= rules.downPayment.baseThreshold) throw new RangeError('invalid down-payment thresholds');
  for (const rate of [rules.downPayment.baseRate, rules.downPayment.remainderRate, rules.downPayment.highPriceRate]) assertRate(rate, 'down-payment rate');
  assertRate(rules.stressTest.buffer, 'stress-test buffer');
  assertRate(rules.stressTest.floor, 'stress-test floor');
}

export function calculatePtt(price, rules) {
  if (!finiteNonNegative(price)) throw new RangeError('invalid price');
  validateRules(rules);
  const breakdown = [];
  let lower = 0;
  let standardTax = 0;
  for (const bracket of rules.ptt.brackets) {
    const upper = bracket.upTo ?? price;
    const taxable = Math.max(0, Math.min(price, upper) - lower);
    if (taxable > 0) {
      const tax = taxable * bracket.rate;
      breakdown.push({ kind: 'standard', lower, upper: bracket.upTo, taxable, rate: bracket.rate, tax, sourceId: bracket.sourceId });
      standardTax += tax;
    }
    if (price <= upper) break;
    lower = upper;
  }
  const surchargeTax = Math.max(0, price - rules.ptt.residentialSurcharge.threshold) * rules.ptt.residentialSurcharge.rate;
  if (surchargeTax > 0) breakdown.push({
    kind: 'residential-surcharge',
    lower: rules.ptt.residentialSurcharge.threshold,
    upper: null,
    taxable: price - rules.ptt.residentialSurcharge.threshold,
    rate: rules.ptt.residentialSurcharge.rate,
    tax: surchargeTax,
    sourceId: rules.ptt.residentialSurcharge.sourceId,
  });
  return { standardTax, surchargeTax, grossTax: standardTax + surchargeTax, breakdown };
}

function phaseOutFactor(price, exemption) {
  if (price <= exemption.fullThreshold) return 1;
  if (price >= exemption.phaseOutThreshold) return 0;
  return (exemption.phaseOutThreshold - price) / (exemption.phaseOutThreshold - exemption.fullThreshold);
}

function firstTimeExemption(price, input, rules) {
  if (!input.firstTimeBuyer) return { kind: 'first-time', status: 'not-requested', amount: 0, factor: 0, reason: '未选择首次购房者。' };
  if (input.residency === 'foreign') return { kind: 'first-time', status: 'ineligible', amount: 0, factor: 0, reason: '外国人身份不符合台账所列公民或永久居民条件。' };
  const factor = phaseOutFactor(price, rules.ptt.firstTime);
  if (factor === 0) return { kind: 'first-time', status: 'over-limit', amount: 0, factor, reason: '房价已达到或超过部分豁免完全消失门槛。' };
  const cappedPrice = Math.min(price, rules.ptt.firstTime.exemptValueCap);
  const amount = calculatePtt(cappedPrice, rules).grossTax * factor;
  return {
    kind: 'first-time',
    status: factor === 1 ? 'full' : 'partial',
    amount,
    factor,
    reason: factor === 1 ? '房价在全额豁免上限内；估算免除免税适用金额对应的 PTT。' : '房价落在部分豁免区间；估算按区间线性递减。',
  };
}

function newHomeExemption(price, input, rules, grossPtt) {
  if (!input.newlyBuilt) return { kind: 'new-home', status: 'not-requested', amount: 0, factor: 0, reason: '未选择符合条件的新建住房。' };
  if (input.residency === 'foreign') return { kind: 'new-home', status: 'pending-eligibility', amount: 0, factor: 0, reason: '台账没有外国买家的新建房豁免资格参数，保守不计入。' };
  const factor = phaseOutFactor(price, rules.ptt.newHome);
  if (factor === 0) return { kind: 'new-home', status: 'over-limit', amount: 0, factor, reason: '房价已达到或超过新建房豁免完全消失门槛。' };
  return {
    kind: 'new-home',
    status: factor === 1 ? 'full' : 'partial',
    amount: grossPtt * factor,
    factor,
    reason: factor === 1 ? '房价在新建房全额豁免上限内；仍须另行确认入住等资格。' : '房价落在新建房部分豁免区间；估算按区间线性递减，仍须另行确认其他资格。',
  };
}

export function minimumDownPayment(price, rules) {
  if (!finiteNonNegative(price)) throw new RangeError('invalid price');
  validateRules(rules);
  const rule = rules.downPayment;
  if (price <= rule.baseThreshold) return price * rule.baseRate;
  if (price < rule.highPriceThreshold) return rule.baseThreshold * rule.baseRate + (price - rule.baseThreshold) * rule.remainderRate;
  return price * rule.highPriceRate;
}

export function qualifyingRate(contractRate, rules) {
  assertRate(contractRate, 'contract rate');
  validateRules(rules);
  return Math.max(contractRate + rules.stressTest.buffer, rules.stressTest.floor);
}

export function calculateHomeCost(input, rules) {
  const { price, downPaymentRatio, firstTimeBuyer = false, newlyBuilt = false, residency = 'citizen' } = input ?? {};
  if (!finiteNonNegative(price) || price === 0) throw new RangeError('invalid price');
  assertRate(downPaymentRatio, 'down-payment ratio');
  if (!['citizen', 'pr', 'foreign'].includes(residency)) throw new RangeError('invalid residency');
  validateRules(rules);

  const gross = calculatePtt(price, rules);
  const firstTime = firstTimeExemption(price, { firstTimeBuyer, residency }, rules);
  const newHome = newHomeExemption(price, { newlyBuilt, residency }, rules, gross.grossTax);
  const applied = [firstTime, newHome].reduce((best, item) => item.amount > best.amount ? item : best, { kind: 'none', amount: 0, status: 'none', factor: 0, reason: '没有可计入的 PTT 豁免。' });
  const netPtt = Math.max(0, gross.grossTax - applied.amount);
  const foreignBuyerTax = residency === 'foreign' ? price * rules.ptt.foreignBuyer.rate : 0;
  const minimumDown = minimumDownPayment(price, rules);
  const downPayment = price * downPaymentRatio;

  return {
    price,
    ptt: { ...gross, firstTime, newHome, applied, netTax: netPtt },
    foreignBuyerTax,
    minimumDownPayment: minimumDown,
    downPayment,
    downPaymentShortfall: Math.max(0, minimumDown - downPayment),
    knownOneTimeCosts: netPtt + foreignBuyerTax,
    cashNeededAtCompletion: downPayment + netPtt + foreignBuyerTax,
  };
}

const ALLOWED = new Set(['a', 'p', 's', 'lang']);
const params = new URLSearchParams(location.search);
for (const key of [...params.keys()]) if (!ALLOWED.has(key)) params.delete(key);
const advisorCode = /^[a-z0-9]{2,8}$/.test(params.get('a') || '') ? params.get('a') : '';
const partnerCode = /^[a-z0-9]{2,8}$/.test(params.get('p') || '') ? params.get('p') : '';
if (advisorCode) sessionStorage.setItem('vv_a', advisorCode);
const registry = JSON.parse(document.getElementById('public-registry')?.textContent || '{"advisors":[],"partners":[],"licensees":[]}');
const advisor = registry.advisors.find(x => x.code === advisorCode && x.status === 'verified');
if (advisor) {
  const licensed = advisor.licence_keys.some(key => registry.licensees.some(x => x.key === key && x.status === 'verified'));
  if (licensed) document.querySelectorAll('[data-cta-mode="primary"]').forEach(link => {
    link.textContent = `预约 ${advisor.display_name}`;
    const target = new URL(link.href, location.origin); target.searchParams.set('a', advisor.code); link.href = target.toString();
  });
  document.querySelectorAll('a[href^="/veryvisa-com-site/"]').forEach(link => { const target = new URL(link.href, location.origin); target.searchParams.set('a', advisor.code); link.href = target.toString(); });
}
const partner = registry.partners.find(x => x.code === partnerCode && x.status === 'verified');
if (partner) {
  const banner = document.querySelector('[data-partner-referral]');
  banner.textContent = `此页由 ${partner.display_name}（${partner.profession}）转给您`;
  banner.hidden = false;
}
document.querySelectorAll('[data-fact-next-review]').forEach((el) => {
  const due = el.getAttribute('data-fact-next-review');
  const kind = el.getAttribute('data-fact-kind');
  if (!due || new Date(due + 'T23:59:59Z') >= new Date()) return;
  el.classList.add('fact-stale');
  if (kind === 'quote' || kind === 'rate') el.querySelector('[data-fact-value]').textContent = '请顾问按您的情况出价';
  else el.querySelector('[data-fact-age]').textContent = '待复核';
});
document.querySelectorAll('[data-check-item]').forEach((box) => {
  const mask = Number.parseInt(params.get('s') || '0', 36);
  const bit = Number(box.getAttribute('data-check-item'));
  box.checked = Number.isSafeInteger(mask) && mask >= 0 && Boolean(mask & (2 ** bit));
});
document.querySelector('[data-copy-checklist]')?.addEventListener('click', async () => {
  let mask = 0;
  document.querySelectorAll('[data-check-item]:checked').forEach(box => { mask += 2 ** Number(box.getAttribute('data-check-item')); });
  const url = new URL(location.href); url.search = ''; if (mask) url.searchParams.set('s', mask.toString(36));
  await navigator.clipboard.writeText(url.toString());
});

// 「源」按钮：点开或收起同一事实的出处与核对日（答案页与房产页默认收起）。
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('.fact-source');
  const details = button?.parentElement?.querySelector('details');
  if (details) details.open = !details.open;
});

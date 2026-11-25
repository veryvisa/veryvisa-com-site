// 温西对照表：点表头按该列排序（无依赖）。单元格 data-sort 存原始值，数字按数值比较。
for (const table of document.querySelectorAll('table[data-sortable]')) {
  const heads = [...table.tHead.rows[0].cells];
  heads.forEach((th, i) => {
    const btn = th.querySelector('button');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
      heads.forEach((h) => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', dir);
      const body = table.tBodies[0];
      const rows = [...body.rows];
      rows.sort((a, b) => {
        const x = a.cells[i].dataset.sort ?? '', y = b.cells[i].dataset.sort ?? '';
        const nx = Number(x), ny = Number(y);
        const c = x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : String(x).localeCompare(String(y), 'en');
        return dir === 'ascending' ? c : -c;
      });
      for (const r of rows) body.appendChild(r);
    });
  });
}

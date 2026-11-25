const dataNode = document.getElementById('home-subareas-data');
const reviewData = JSON.parse(dataNode?.textContent || '{"subareas":[]}');
const areas = reviewData.subareas || [];
const form = document.querySelector('[data-subarea-review-form]');
const output = document.querySelector('[data-review-output]');
const error = document.querySelector('[data-review-error]');
const progress = document.querySelector('[data-review-progress]');
const copyButton = document.querySelector('[data-copy-review]');
const copyStatus = document.querySelector('[data-copy-status]');

const selectedCount = () => areas.filter((area) => form?.querySelector(`input[name="decision-${area.id}"]:checked`)).length;
const updateProgress = () => {
  const count = selectedCount();
  progress.textContent = count === areas.length ? '全部片区已选择，可以生成确认结果。' : `已选择 ${count} 个片区，还有 ${areas.length - count} 个待选。`;
};

form?.addEventListener('change', (event) => {
  if (event.target.matches('input[type="radio"]')) {
    const card = event.target.closest('[data-subarea-card]');
    card?.classList.toggle('needs-change', event.target.value === '要改');
    if (event.target.value === '要改') card?.querySelector('textarea')?.focus();
    updateProgress();
  }
});

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  error.hidden = true;
  const missing = areas.find((area) => !form.querySelector(`input[name="decision-${area.id}"]:checked`));
  if (missing) {
    error.textContent = `请先确认「${missing.name_zh} ${missing.name_en}」。`;
    error.hidden = false;
    form.querySelector(`[data-subarea-card="${missing.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const missingNote = areas.find((area) => form.querySelector(`input[name="decision-${area.id}"]:checked`)?.value === '要改' && !form.elements[`note-${area.id}`].value.trim());
  if (missingNote) {
    error.textContent = `「${missingNote.name_zh} ${missingNote.name_en}」选择了要改，请补一句修改意见。`;
    error.hidden = false;
    form.elements[`note-${missingNote.id}`].focus();
    return;
  }
  output.value = areas.map((area) => {
    const decision = form.querySelector(`input[name="decision-${area.id}"]:checked`).value;
    const note = form.elements[`note-${area.id}`].value.trim() || '无';
    return `${area.name_zh} ${area.name_en}｜${decision}｜${note.replaceAll('\n', ' ')}`;
  }).join('\n');
  copyButton.disabled = false;
  copyStatus.textContent = '确认结果已生成，尚未复制。';
  output.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

copyButton?.addEventListener('click', async () => {
  if (!output.value) return;
  try {
    await navigator.clipboard.writeText(output.value);
  } catch {
    output.focus();
    output.select();
    document.execCommand('copy');
  }
  copyStatus.textContent = '已复制，可以粘贴到微信或邮件。';
});

function featureCollection() {
  const palette = ['#0f766e', '#2563eb', '#9333ea', '#c2410c', '#047857', '#be123c', '#4f46e5'];
  return {
    type: 'FeatureCollection',
    features: areas.map((area, index) => ({
      type: 'Feature',
      properties: { id: area.id, name_zh: area.name_zh, name_en: area.name_en, color: palette[index % palette.length] },
      geometry: area.geometry,
    })),
  };
}

function popupContent(area) {
  const box = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `${area.name_zh} ${area.name_en}`;
  const text = document.createElement('p');
  text.textContent = `北至 ${area.bounds.north}；南至 ${area.bounds.south}；东至 ${area.bounds.east}；西至 ${area.bounds.west}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '去确认这一区';
  button.addEventListener('click', () => document.querySelector(`[data-subarea-card="${area.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  box.append(title, text, button);
  return box;
}

function initMap() {
  const mapNode = document.getElementById('subarea-map');
  const fallback = document.querySelector('[data-map-fallback]');
  if (!mapNode || !globalThis.maplibregl) {
    if (fallback) fallback.textContent = '地图组件暂时不可用；请使用下方四至文字继续审核。';
    return;
  }
  const map = new maplibregl.Map({
    container: mapNode,
    center: [-123.159, 49.238],
    zoom: 11.4,
    attributionControl: true,
    style: {
      version: 8,
      sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => {
    fallback?.remove();
    map.addSource('subareas', { type: 'geojson', data: featureCollection() });
    map.addLayer({ id: 'subarea-fill', type: 'fill', source: 'subareas', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.22 } });
    map.addLayer({ id: 'subarea-line', type: 'line', source: 'subareas', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
    const bounds = new maplibregl.LngLatBounds();
    for (const area of areas) for (const point of area.geometry.coordinates[0]) bounds.extend(point);
    map.fitBounds(bounds, { padding: 24, maxZoom: 12.6 });
  });
  map.on('click', 'subarea-fill', (event) => {
    const area = areas.find((item) => item.id === event.features?.[0]?.properties?.id);
    if (area) new maplibregl.Popup({ closeButton: true }).setLngLat(event.lngLat).setDOMContent(popupContent(area)).addTo(map);
  });
  map.on('mouseenter', 'subarea-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'subarea-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('error', () => {
    if (fallback) fallback.textContent = '开放底图暂时不可用；草案边界和下方文字审核仍可使用。';
  });
}

updateProgress();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMap, { once: true });
else initMap();

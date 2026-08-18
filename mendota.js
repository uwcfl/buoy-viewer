/* mendota.js — Lake Mendota configuration
 * Depends on: shared.js (provides toChicago, dateStr, initBuoyApp)
 */

/* ---------- Config ---------- */

const MENDOTA_DEPTHS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const MENDOTA_WT_KEYS = MENDOTA_DEPTHS.map((_, i) => `wt${i + 1}`);

const MENDOTA_SIMPLE_VARS = {
  airTL: { label: 'Air Temp', unit: '\u00b0C' },
  rhL: { label: 'Relative Humidity', unit: '%' },
  pco2ppm_Avg: { label: 'pCO\u2082', unit: 'ppm' },
  spCond: { label: 'Specific Conductivity', unit: '\u00b5S/cm' },
  pH: { label: 'pH', unit: '' },
  chlorYSI: { label: 'Chlorophyll', unit: 'RFU' },
  phycoYSI: { label: 'Phycocyanin', unit: 'RFU' },
  turbid: { label: 'Turbidity', unit: 'FNU' },
  fdom: { label: 'fDOM', unit: 'RFU' },
  IRTL: { label: 'IR Surface Temp', unit: '\u00b0C' },
  pco2volt_Avg: { label: 'pCO\u2082 Sensor Voltage', unit: 'mV', voltage: true },
  battYSI: { label: 'Battery Voltage', unit: 'V', voltage: true },
};

const MENDOTA_GROUPS = [
  { key: 'wtprofile', label: 'Water Temp Profile', kind: 'profile' },
  { key: 'waterT', label: 'Water Temp (YSI)', kind: 'simple', vkey: 'waterT', unit: '\u00b0C' },
  { key: 'do', label: 'Dissolved Oxygen', kind: 'do' },
  { key: 'par', label: 'PAR', kind: 'par' },
  { key: 'wind', label: 'Wind', kind: 'wind' },
  ...Object.keys(MENDOTA_SIMPLE_VARS).map(k => ({
    key: k, label: MENDOTA_SIMPLE_VARS[k].label, kind: 'simple', vkey: k, unit: MENDOTA_SIMPLE_VARS[k].unit,
  })),
];

/* ---------- Parsing ---------- */

const FILE_PREFIX = 'https://mendota-buoy-proxy.uwcfl.workers.dev/mendota_buoy_limnodata.';
const COL_INDEX = {}; // header name → column index, filled on first file load

function parseMendotaFile(text) {
  const rows = d3.csvParseRows(text);
  const header = rows[1];
  header.forEach((h, i) => COL_INDEX[h] = i);
  const data = rows.slice(4).filter(r => r.length > 1 && r[0]);
  const num = v => { const f = parseFloat(v); return (v === undefined || v === 'NAN' || isNaN(f)) ? null : f; };
  return data.map(r => {
    const rec = { timestamp: toChicago(new Date(r[0].replace(' ', 'T') + 'Z')) };
    MENDOTA_WT_KEYS.forEach((k, i) => rec[k] = num(r[COL_INDEX[`watertemp(${i + 1})`]]));
    for (const k of ['airTL', 'rhL', 'wsL', 'wdL', 'IRTL', 'pco2ppm_Avg', 'PAR_above_Avg',
      'PAR_below_Avg', 'pco2volt_Avg', 'waterT', 'spCond', 'pH', 'do_raw',
      'do_sat', 'chlorYSI', 'phycoYSI', 'turbid', 'fdom', 'battYSI']) {
      rec[k] = num(r[COL_INDEX[k]]);
    }
    return rec;
  });
}

/* ---------- Fetch ---------- */

async function mendotaFetchRaw(d) {
  try {
    const url = `${FILE_PREFIX}${dateStr(d)}.csv`;
    const resp = await fetch(url);
    if (!resp.ok) return 'missing';
    const text = await resp.text();
    return parseMendotaFile(text);
  } catch (_) {
    return 'missing';
  }
}

/* ---------- Init ---------- */

initBuoyApp({
  cacheName: 'mendota',
  depths: MENDOTA_DEPTHS,
  wtKeys: MENDOTA_WT_KEYS,
  simpleVars: MENDOTA_SIMPLE_VARS,
  groups: MENDOTA_GROUPS,
  earliest: new Date(new Date().getFullYear(), 3, 1), // April 1
  buoyImgSrc: 'assets/buoy.png',
  miniCardDepths: [0, 5, 10, 15, 20],
  // Preserve original defaults: voltage vars hidden, waterT hidden
  defaultVisible: [
    'wtprofile', 'do', 'par', 'wind',
    'airTL', 'rhL', 'pco2ppm_Avg', 'spCond', 'pH',
    'chlorYSI', 'phycoYSI', 'turbid', 'fdom', 'IRTL',
  ],
  fetchRaw: mendotaFetchRaw,
});

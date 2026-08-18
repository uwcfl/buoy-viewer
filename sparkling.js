/* sparkling.js — Sparkling Lake configuration and data fetching
 * Depends on: shared.js (provides toChicago, dateStr, initBuoyApp)
 */

const SPARKLING_DEPTHS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18];
const SPARKLING_WT_KEYS = SPARKLING_DEPTHS.map((_, i) => `wt${i + 1}`);

const SPARKLING_SIMPLE_VARS = {
  air_temp: { label: 'Air Temp', unit: '\u00b0C' },
  rel_hum: { label: 'Relative Humidity', unit: '%' },
  par: { label: 'PAR', unit: '\u00b5mol/m\u00b2/s' },
  spec_cond: { label: 'Specific Conductivity', unit: '\u00b5S/cm' },
  barom_pres_mbar: { label: 'Barometric Pressure', unit: 'mbar' },
  vapor_pres: { label: 'Vapor Pressure', unit: 'kPa' },
  sat_vapor_pres: { label: 'Sat Vapor Pressure', unit: 'kPa' },
  co2_atmos: { label: 'CO\u2082 Atmospheric', unit: 'ppm' },
  co2_dissolved: { label: 'CO\u2082 Dissolved', unit: 'ppm' },
  precip_mm: { label: 'Precipitation', unit: 'mm' },
  csi_surf_temp: { label: 'CSI Surface Temp', unit: '\u00b0C' },
};

const SPARKLING_GROUPS = [
  { key: 'wtprofile', label: 'Water Temp Profile', kind: 'profile' },
  { key: 'do', label: 'Dissolved Oxygen', kind: 'do' },
  { key: 'wind', label: 'Wind', kind: 'wind' },
  ...Object.keys(SPARKLING_SIMPLE_VARS).map(k => ({
    key: k, label: SPARKLING_SIMPLE_VARS[k].label, kind: 'simple', vkey: k, unit: SPARKLING_SIMPLE_VARS[k].unit,
  })),
];

function parseDualEndpoints(exportText, watertempText) {
  const num = v => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (s === '' || s === 'NAN' || s === '-99') return null;
    const f = parseFloat(s);
    return (isNaN(f) || f === -99) ? null : f;
  };

  const exportRows = d3.csvParse(exportText);
  const watertempRows = d3.csvParse(watertempText);

  // Map watertemp rows by TIMESTAMP for fast lookup
  const wtMap = new Map();
  watertempRows.forEach(r => {
    if (r.TIMESTAMP) wtMap.set(r.TIMESTAMP.trim(), r);
  });

  const records = [];

  exportRows.forEach(r => {
    const tsStr = r.TIMESTAMP ? r.TIMESTAMP.trim() : null;
    if (!tsStr) return;

    const wtRow = wtMap.get(tsStr);

    // Date parsing (data is already in local Chicago time zone)
    const rec = { timestamp: new Date(tsStr.replace(' ', 'T')) };

    // Parse wind (Sparkling has wind_speed_2m)
    const wsVal = num(r.wind_speed || r.wind_speed_2m);
    const wdVal = num(r.wind_dir);
    rec.wsL = wsVal;
    rec.wdL = wdVal;

    // Parse DO
    rec.do_raw = num(r.do_raw);
    rec.do_sat = num(r.do_sat);

    // Parse Simple Variables
    rec.air_temp = num(r.air_temp);
    rec.rel_hum = num(r.rel_hum);
    rec.par = num(r.par);
    rec.spec_cond = num(r.spec_cond);
    rec.barom_pres_mbar = num(r.barom_pres_mbar);
    rec.vapor_pres = num(r.vapor_pres);
    rec.sat_vapor_pres = num(r.sat_vapor_pres);
    rec.co2_atmos = num(r.co2_atmos);
    rec.co2_dissolved = num(r.co2_dissolved);
    rec.precip_mm = num(r.precip_mm);

    if (wtRow) {
      rec.csi_surf_temp = num(wtRow.CSI107SurfTemp);

      // Water temp profile mapping:
      // Depth 0 -> RBRSurfTemp
      rec[SPARKLING_WT_KEYS[0]] = num(wtRow.RBRSurfTemp);
      // Depths 1..24 -> RBRTempProfile(1..24)
      for (let i = 1; i < SPARKLING_DEPTHS.length; i++) {
        rec[SPARKLING_WT_KEYS[i]] = num(wtRow[`RBRTempProfile(${i})`]);
      }
    } else {
      rec.csi_surf_temp = null;
      SPARKLING_WT_KEYS.forEach(k => rec[k] = null);
    }

    records.push(rec);
  });

  return records;
}

async function sparklingFetchRaw(d) {
  try {
    const yyyy = d.getFullYear();
    const yyyymmdd = dateStr(d).replace(/-/g, '');
    const exportUrl = `https://buoy-export-proxy.uwcfl.workers.dev/Sparkling/${yyyy}/${yyyymmdd}`;
    const wtUrl = `https://buoy-watertemp-proxy.uwcfl.workers.dev/Sparkling/${yyyy}/${yyyymmdd}`;

    const [expResp, wtResp] = await Promise.all([
      fetch(exportUrl).catch(() => null),
      fetch(wtUrl).catch(() => null)
    ]);

    if (!expResp || !expResp.ok || !wtResp || !wtResp.ok) {
      return 'missing';
    }

    const [expText, wtText] = await Promise.all([
      expResp.text(),
      wtResp.text()
    ]);

    return parseDualEndpoints(expText, wtText);
  } catch (_) {
    return 'missing';
  }
}

initBuoyApp({
  cacheName: 'sparkling',
  depths: SPARKLING_DEPTHS,
  wtKeys: SPARKLING_WT_KEYS,
  simpleVars: SPARKLING_SIMPLE_VARS,
  groups: SPARKLING_GROUPS,
  earliest: new Date(new Date().getFullYear(), 4, 1), // May 1
  buoyImgSrc: null, // No buoy picture yet
  miniCardDepths: [0, 3.5, 7, 11, 14, 18], // 6 evenly-spaced depths including 0 and 18
  defaultVisible: [
    'wtprofile', 'do', 'wind', 'air_temp', 'rel_hum', 'par', 'spec_cond'
  ],
  fetchRaw: sparklingFetchRaw,
});

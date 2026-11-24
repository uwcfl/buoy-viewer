/* shared.js — Common utilities and rendering for Buoy Viewer
 *
 * Exports (global):
 *   toChicago(utcDate)  — convert UTC Date to local Chicago Date
 *   dateStr(d)          — format Date as "YYYY-MM-DD"
 *   initBuoyApp(config) — initialize app for one lake page
 *
 * config shape: {
 *   cacheName:       string,           // unique cache namespace per lake
 *   lakeName:        string,           // human-readable lake name for CSV filename
 *   depths:          number[],         // ordered sensor depths
 *   wtKeys:          string[],         // record keys for each depth (same length)
 *   simpleVars:      { [key]: { label, unit, voltage? } },
 *   groups:          Array<{ key, label, kind, vkey?, unit? }>,
 *   earliest:        Date,             // season start; only its month/day are used
 *   forceWinterModal: boolean,         // true → always show the "out for the winter" modal
 *   offlineHours:    number,           // hours without data before the "offline" modal (default 12)
 *   dataLagHours:    number,           // normal delay before data reaches the server (default 0);
 *                                      // added to every "no data for N hours" threshold
 *   waterTempRange:  [min, max],       // default °C range for the water temp profile (lines + heatmap);
 *                                      // widened automatically if readings fall outside it
 *   buoyImgSrc:      string | null,    // null → hide buoy image
 *   buoyCoords:      [lat, lng] | null, // decimal coords → image links to Google Maps
 *   miniCardDepths:  number[],         // depths shown in "Current Conditions" card
 *   defaultVisible:  string[] | null,  // group keys visible by default (null = all)
 *   fetchRaw:        async (d: Date) => records[] | 'missing',
 * }
 */

/* ---------- Time Utilities (global) ---------- */

const _chicagoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function toChicago(utcDate) {
  const parts = {};
  for (const p of _chicagoParts.formatToParts(utcDate)) parts[p.type] = p.value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return new Date(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
}

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Current time as a Chicago wall-clock Date (same convention as record timestamps)
function nowChicago() {
  return toChicago(new Date());
}

// End of the current Chicago day (used for day-granular loading, not for axis limits)
function endOfTodayChicago() {
  const d = nowChicago();
  d.setHours(23, 59, 59, 999);
  return d;
}

/* ---------- App Factory ---------- */

function initBuoyApp(config) {
  const DEPTHS = config.depths;
  const WT_KEYS = config.wtKeys;
  const SIMPLE_VARS = config.simpleVars;
  const GROUPS = config.groups;

  /* ---------- Viewing Season ----------
   * From Jan 1 until the season start (buoy deployment), there is no current-year
   * data, so the viewer shows the previous year's season instead.
   */
  const SEASON_MONTH = config.earliest.getMonth();
  const SEASON_DAY = config.earliest.getDate();
  const TODAY = nowChicago();
  const PRE_SEASON = TODAY < new Date(TODAY.getFullYear(), SEASON_MONTH, SEASON_DAY);
  const VIEW_YEAR = PRE_SEASON ? TODAY.getFullYear() - 1 : TODAY.getFullYear();
  const EARLIEST = new Date(VIEW_YEAR, SEASON_MONTH, SEASON_DAY);
  const SEASON_END = VIEW_YEAR < TODAY.getFullYear()
    ? new Date(VIEW_YEAR, 11, 31, 23, 59, 59, 999)
    : null;

  // Latest time the viewer may show: now, or Dec 31 when viewing a past season
  function latestBound() {
    return SEASON_END || nowChicago();
  }
  const MINI_CARD_DEPTHS = config.miniCardDepths;

  /* ---------- Buoy Image ---------- */

  const buoyWrap = document.getElementById('buoyWrap');
  const buoyImg = document.getElementById('buoyImg');

  if (config.buoyImgSrc && buoyWrap && buoyImg) {
    buoyImg.src = config.buoyImgSrc;
    function sizeBuoyWrap() {
      if (buoyImg.naturalWidth && buoyImg.naturalHeight) {
        const ratio = buoyImg.naturalWidth / buoyImg.naturalHeight;
        buoyWrap.style.width = `${buoyWrap.offsetHeight * ratio}px`;
      }
    }
    buoyImg.addEventListener('load', sizeBuoyWrap);
    window.addEventListener('resize', sizeBuoyWrap);
    if (buoyImg.complete) sizeBuoyWrap();

    if (config.buoyCoords) {
      const [lat, lng] = config.buoyCoords;
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      buoyWrap.style.cursor = 'pointer';
      buoyWrap.title = 'Open buoy location in Google Maps';
      buoyWrap.addEventListener('click', () => window.open(mapsUrl, '_blank', 'noopener'));
    }
  } else if (buoyWrap) {
    buoyWrap.style.display = 'none';
  }

  /* ---------- State ---------- */

  const defaultVis = config.defaultVisible
    ? new Set(config.defaultVisible)
    : new Set(GROUPS.map(g => g.key));

  const state = {
    domain: null,
    visible: defaultVis,
    userToggled: new Set(),
    showCurrentConditions: true,
    condUserToggled: false, // user clicked Show/Hide Current Conditions (overrides the auto default)
    depthOn: new Set(WT_KEYS),
    doUnit: 'sat',   // 'sat' | 'raw'
    windUnit: 'ms',    // 'ms' | 'mph'
    tempUnit: 'C',     // 'C' | 'F' (all temperature variables)
    wtProfileMode: 'heatmap', // 'lines' | 'heatmap'
    cache: new Map(), // dateStr → records[] | 'missing' | Promise
    droppedDays: new Set(), // dateStr of days after a 3+ day gap
  };

  /* ---------- Data Loading ---------- */

  const MAX_CACHE_AGE_MS = 48 * 60 * 60 * 1000;

  async function loadDay(d) {
    const key = dateStr(d);
    if (state.cache.has(key)) return state.cache.get(key);

    const loadPromise = (async () => {
      try {
        const isWithin48Hours = (nowChicago().getTime() - d.getTime()) < MAX_CACHE_AGE_MS;

        // Try persistent web cache for older days
        if (!isWithin48Hours && typeof caches !== 'undefined') {
          try {
            const webCache = await caches.open(`buoy-v1-${config.cacheName}`);
            const fakeUrl = `https://buoy-cache/${config.cacheName}/${key}`;
            const cached = await webCache.match(fakeUrl);
            if (cached) {
              const { fetchedAt, records: rawRecs } = await cached.json();
              if (Date.now() - fetchedAt <= MAX_CACHE_AGE_MS) {
                return rawRecs.map(r => ({ ...r, timestamp: new Date(r.timestamp) }));
              }
              await webCache.delete(fakeUrl);
            }
          } catch (_) { /* corrupt entry — fall through */ }
        }

        const records = await config.fetchRaw(d);

        // Store older days in persistent cache
        if (records !== 'missing' && !isWithin48Hours && typeof caches !== 'undefined') {
          try {
            const webCache = await caches.open(`buoy-v1-${config.cacheName}`);
            const fakeUrl = `https://buoy-cache/${config.cacheName}/${key}`;
            const body = JSON.stringify({
              fetchedAt: Date.now(),
              records: records.map(r => ({ ...r, timestamp: r.timestamp.toISOString() }))
            });
            await webCache.put(fakeUrl, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
          } catch (_) { /* cache write failed — ignore */ }
        }

        return records;
      } catch (_) {
        return 'missing';
      }
    })();

    state.cache.set(key, loadPromise);
    const result = await loadPromise;
    state.cache.set(key, result);
    return result;
  }

  async function loadRange(start, end) {
    const days = [];
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      d <= end; d.setDate(d.getDate() + 1)) {
      if (d < EARLIEST) continue;
      days.push(new Date(d));
    }
    document.getElementById('loadStatus').textContent = 'loading\u2026';
    await Promise.all(days.map(loadDay));
    document.getElementById('loadStatus').textContent = '';

    let missingStreak = 0;
    for (const d of days) {
      const key = dateStr(d);
      const v = state.cache.get(key);
      if (!v || v === 'missing') {
        missingStreak++;
      } else {
        if (missingStreak >= 3) state.droppedDays.add(key);
        missingStreak = 0;
      }
    }

    let recs = [];
    for (const d of days) {
      const key = dateStr(d);
      const v = state.cache.get(key);
      if (v && v !== 'missing' && !state.droppedDays.has(key)) recs = recs.concat(v);
    }
    recs.sort((a, b) => a.timestamp - b.timestamp);
    return maskFlatlines(recs);
  }

  /* ---------- Flatline Masking ----------
   * When a sensor (e.g. the YSI sonde) stops, the logger can keep writing its
   * last value. Treat any value (including 0) repeated unchanged for
   * FLATLINE_HOURS or more as missing (keeping the first reading of the run).
   * Water temp profile thermistors are exempt: at their resolution they
   * legitimately hold one value for 10+ hours. Zeros are kept for variables in
   * FLATLINE_ZERO_OK (PAR is 0 all night; no precipitation for days is real).
   */
  const FLATLINE_HOURS = 3;
  const FLATLINE_EXEMPT = new Set(WT_KEYS);
  const FLATLINE_ZERO_OK = new Set(['precip_mm', 'par', 'PAR_above_Avg', 'PAR_below_Avg']); // PAR reads 0 all night

  function maskFlatlines(records) {
    if (records.length < 2) return records;
    const minMs = FLATLINE_HOURS * 3600000;
    const out = records.slice();
    const copied = new Set(); // indexes already shallow-copied
    const keys = new Set();
    for (const r of records) for (const k in r) if (k !== 'timestamp' && !FLATLINE_EXEMPT.has(k)) keys.add(k);

    for (const k of keys) {
      let runStart = 0;
      for (let i = 1; i <= out.length; i++) {
        const same = i < out.length && out[i][k] != null && out[i][k] === out[runStart][k];
        if (same) continue;
        const v = out[runStart][k];
        const endIdx = i - 1;
        if (v != null && !(v === 0 && FLATLINE_ZERO_OK.has(k)) && endIdx > runStart &&
            out[endIdx].timestamp - out[runStart].timestamp >= minMs) {
          for (let j = runStart + 1; j <= endIdx; j++) {
            if (!copied.has(j)) { out[j] = { ...out[j] }; copied.add(j); }
            out[j][k] = null;
          }
        }
        runStart = i;
      }
    }
    return out;
  }

  // Search backward (a week at a time, in parallel) for the most recent record.
  // Returns the newest record timestamp, or null if the season has no data.
  async function findLatestAvailable() {
    const BATCH = 7;
    let d = SEASON_END ? new Date(SEASON_END) : endOfTodayChicago();
    for (let i = 0; i < 400 && d >= EARLIEST; i += BATCH) {
      const days = [];
      for (let j = 0; j < BATCH && d >= EARLIEST; j++) {
        days.push(new Date(d));
        d.setDate(d.getDate() - 1);
      }
      const results = await Promise.all(days.map(loadDay));
      for (const v of results) {
        if (v === 'missing' || !v.length) continue;
        let newest = null;
        for (const r of v) {
          if (hasAnyValue(r) && (!newest || r.timestamp > newest)) newest = r.timestamp;
        }
        if (newest) return newest;
      }
    }
    return null;
  }

  // True if a record has a valid reading for any variable
  function hasAnyValue(rec) {
    for (const k in rec) {
      if (k === 'timestamp') continue;
      const v = rec[k];
      if (v != null && !isNaN(v)) return true;
    }
    return false;
  }

  /* ---------- No-Data Modals ---------- */

  // Some buoys (Trout, Sparkling) upload in a once-a-day batch, so their newest
  // reading is normally up to a day old. Every staleness threshold adds this lag.
  const DATA_LAG_HOURS = config.dataLagHours ?? 0;
  const OFFLINE_HOURS = (config.offlineHours ?? 12) + DATA_LAG_HOURS;
  const WINTER_HOURS = 24 + DATA_LAG_HOURS;

  const ICON_OFFLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.5 5.2A15 15 0 0 1 22 8.8"/><path d="M5 12.6a10 10 0 0 1 3.4-1.9M13.5 10.3A10 10 0 0 1 19 12.6"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="0.8" fill="currentColor"/><path d="M3 3l18 18"/></svg>';
  const ICON_WINTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 2v20M4.2 6.5l15.6 9M4.2 17.5l15.6-9"/><path d="M9.5 3.5 12 6l2.5-2.5M9.5 20.5 12 18l2.5 2.5M3.3 10l3.4.9-.9 3.4M20.7 14l-3.4-.9.9-3.4M5.8 9.7l.9 3.4-3.4.9M18.2 14.3l-.9-3.4 3.4-.9"/></svg>';

  // Winter: forced in config, or no data (in any variable) for WINTER_HOURS while
  // it's Nov 1 – season start. Offline: no data for OFFLINE_HOURS. Winter takes priority.
  function noDataKind(lastReading) {
    if (config.forceWinterModal) return 'winter';
    const now = nowChicago();
    const ageMs = lastReading ? now - lastReading : Infinity;
    const offSeason = now.getMonth() >= 10 || PRE_SEASON; // Nov, Dec, or before deployment
    if (offSeason && ageMs > WINTER_HOURS * 3600000) return 'winter';
    if (ageMs > OFFLINE_HOURS * 3600000) return 'offline';
    return null;
  }

  function showNoDataModal(kind, lastReading) {
    const isWinter = kind === 'winter';
    const lastYear = lastReading ? lastReading.getFullYear() : VIEW_YEAR;
    const overlay = document.createElement('div');
    overlay.className = 'nodata-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'nodataTitle');
    overlay.innerHTML = `
      <div class="nodata-card${isWinter ? ' winter' : ''}">
        <div class="nodata-icon">${isWinter ? ICON_WINTER : ICON_OFFLINE}</div>
        <h2 class="nodata-title" id="nodataTitle">${isWinter
          ? 'The buoy has been taken out for the winter!'
          : 'It looks like the buoy is offline.'}</h2>
        <p class="nodata-msg">${isWinter
          ? 'Data collection will resume in the Spring.'
          : 'This is usually resolved in a day or two. Please check again later!'}</p>
        <p class="nodata-meta">${lastReading
          ? `Last reading: ${d3.timeFormat('%b %-d, %Y, %-I:%M %p')(lastReading)}` : ''}</p>
        <div class="nodata-actions">
          <button type="button" class="nodata-btn">${isWinter
            ? `Explore Data from ${lastYear}` : 'Explore Earlier Data'}</button>
        </div>
      </div>`;
    const btn = overlay.querySelector('.nodata-btn');
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    btn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    btn.focus();
  }

  /* ---------- Binning ---------- */

  function binMinutesFor(spanDays) {
    if (spanDays <= 2) return 5;
    if (spanDays <= 10) return 15;
    if (spanDays <= 35) return 60;
    if (spanDays <= 120) return 360;
    if (spanDays <= 400) return 1440;
    return 10080;
  }

  function binLabel(mins) {
    if (mins < 60) return `${mins}-minute averages`;
    if (mins < 1440) return `${mins / 60}-hour averages`;
    if (mins < 10080) return `${mins / 1440}-day averages`;
    return 'weekly averages';
  }

  function binRecords(records, minutes, circularKeys = new Set()) {
    const binMs = minutes * 60000;
    const bins = new Map();
    for (const r of records) {
      const t = r.timestamp.getTime();
      const bStart = Math.floor(t / binMs) * binMs;
      let b = bins.get(bStart);
      if (!b) { b = { time: new Date(bStart), sum: {}, sin: {}, cos: {}, count: {} }; bins.set(bStart, b); }
      for (const k in r) {
        if (k === 'timestamp') continue;
        const v = r[k];
        if (v === null || v === undefined || isNaN(v)) continue;
        if (circularKeys.has(k)) {
          const rad = v * Math.PI / 180;
          b.sin[k] = (b.sin[k] || 0) + Math.sin(rad);
          b.cos[k] = (b.cos[k] || 0) + Math.cos(rad);
        } else {
          b.sum[k] = (b.sum[k] || 0) + v;
        }
        b.count[k] = (b.count[k] || 0) + 1;
      }
    }
    return [...bins.values()].sort((a, b) => a.time - b.time).map(b => {
      const out = { time: b.time };
      for (const k in b.count) {
        if (circularKeys.has(k)) {
          out[k] = Math.atan2(b.sin[k] / b.count[k], b.cos[k] / b.count[k]) * 180 / Math.PI;
          if (out[k] < 0) out[k] += 360;
        } else {
          out[k] = b.sum[k] / b.count[k];
        }
      }
      return out;
    });
  }

  /* ---------- Rendering Helpers ---------- */

  const chartsEl = d3.select('#charts');
  const tooltip = d3.select('body').append('div').attr('class', 'tooltip').style('display', 'none');
  const MARGIN = { top: 8, right: 16, bottom: 22, left: 46 };
  const MS_TO_MPH = 2.23694;

  function fmtDate(d) { return d3.timeFormat('%Y-%m-%d %H:%M')(d); }

  // Current Conditions: a sensor silent for longer than this shows "–" (or its card is hidden)
  const STALE_SENSOR_HOURS = 6 + DATA_LAG_HOURS;
  // Current Conditions only shows data from this window
  const CURRENT_CONDITIONS_HOURS = 12 + DATA_LAG_HOURS;
  // While the buoy is reporting, a sensor with no data for this long has its chart hidden by default
  const SENSOR_HIDE_HOURS = 24 + DATA_LAG_HOURS;

  function staleCutoff() {
    return new Date(nowChicago().getTime() - STALE_SENSOR_HOURS * 3600000);
  }

  // Latest value for `key`, or null if the sensor hasn't reported in STALE_SENSOR_HOURS
  function getLastValue(records, key) {
    const cutoff = staleCutoff();
    for (let i = records.length - 1; i >= 0 && records[i].timestamp >= cutoff; i--) {
      if (records[i][key] != null && !isNaN(records[i][key])) return records[i][key];
    }
    return null;
  }

  function getLastDepthTemp(records, targetDepth) {
    const cutoff = staleCutoff();
    for (let i = records.length - 1; i >= 0 && records[i].timestamp >= cutoff; i--) {
      const val = interpolateTempAtDepth(records[i], targetDepth);
      if (val != null) return val;
    }
    return null;
  }

  // Records from the last SENSOR_HIDE_HOURS (independent of the selected range,
  // so Current Conditions stays current while browsing older data).
  async function loadRecentRecords() {
    const now = nowChicago();
    const since = new Date(now.getTime() - SENSOR_HIDE_HOURS * 3600000);
    const days = [];
    for (let d = new Date(since.getFullYear(), since.getMonth(), since.getDate()); d <= now; d.setDate(d.getDate() + 1)) {
      days.push(new Date(d));
    }
    const results = await Promise.all(days.map(loadDay));
    let recs = [];
    for (const v of results) if (v !== 'missing') recs = recs.concat(v);
    // Mask flatlines over the full loaded days, then keep the recent window
    recs.sort((a, b) => a.timestamp - b.timestamp);
    return maskFlatlines(recs)
      .filter(r => r.timestamp >= since && r.timestamp <= now && hasAnyValue(r));
  }

  // Max distance (m) a reading may be extended/interpolated away from a working
  // sensor when neighbouring sensors are missing (e.g. failed thermistors).
  const MAX_INTERP_GAP_M = 2;

  function interpolateTempAtDepth(rec, targetDepth) {
    let lowerIdx = -1, upperIdx = -1;
    for (let i = 0; i < DEPTHS.length; i++) {
      if (rec[WT_KEYS[i]] == null) continue;
      if (DEPTHS[i] <= targetDepth) lowerIdx = i;
      if (DEPTHS[i] >= targetDepth) { upperIdx = i; break; }
    }
    const hasLower = lowerIdx >= 0, hasUpper = upperIdx >= 0;

    if (hasLower && hasUpper) {
      const lowerDepth = DEPTHS[lowerIdx], upperDepth = DEPTHS[upperIdx];
      const lowerTemp = rec[WT_KEYS[lowerIdx]], upperTemp = rec[WT_KEYS[upperIdx]];
      if (lowerDepth === upperDepth) return lowerTemp;
      // Adjacent sensors both working: interpolate across the normal spacing.
      // Otherwise sensors in between are missing, so only trust the span if the
      // target is close to the working sensors on both sides.
      const adjacent = upperIdx - lowerIdx === 1;
      const dLow = targetDepth - lowerDepth, dUp = upperDepth - targetDepth;
      if (adjacent || (dLow <= MAX_INTERP_GAP_M && dUp <= MAX_INTERP_GAP_M)) {
        return lowerTemp + (dLow / (upperDepth - lowerDepth)) * (upperTemp - lowerTemp);
      }
      // Gap too large: fall back to the nearest side only if it is close enough.
      if (dLow <= MAX_INTERP_GAP_M && dLow <= dUp) return lowerTemp;
      if (dUp <= MAX_INTERP_GAP_M) return upperTemp;
      if (dLow <= MAX_INTERP_GAP_M) return lowerTemp;
      return null;
    }
    if (hasLower) {
      return (targetDepth - DEPTHS[lowerIdx] <= MAX_INTERP_GAP_M) ? rec[WT_KEYS[lowerIdx]] : null;
    }
    if (hasUpper) {
      return (DEPTHS[upperIdx] - targetDepth <= MAX_INTERP_GAP_M) ? rec[WT_KEYS[upperIdx]] : null;
    }
    return null;
  }

  function getCompassDirection(deg) {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.floor((deg / 22.5) + 0.5) % 16];
  }

  function makeSvg(container, height) {
    const width = container.node().clientWidth || 700;
    const svg = container.append('svg').attr('class', 'chart').attr('viewBox', `0 0 ${width} ${height}`);
    const clipId = 'clip-' + Math.random().toString(36).substring(2, 9);
    svg.append('defs').append('clipPath').attr('id', clipId).append('rect')
      .attr('x', MARGIN.left).attr('y', MARGIN.top)
      .attr('width', Math.max(0, width - MARGIN.left - MARGIN.right))
      .attr('height', Math.max(0, height - MARGIN.top - MARGIN.bottom));
    return { svg, width, height, clipId };
  }

  function xScaleFor(width) {
    return d3.scaleTime().domain(state.domain).range([MARGIN.left, width - MARGIN.right]);
  }

  function panel(group) {
    const div = chartsEl.append('div').attr('class', 'chart-panel').attr('id', `panel-${group.key}`);
    const top = div.append('div').attr('class', 'chart-title-row');
    top.append('div').attr('class', 'chart-title-group')
      .style('display', 'flex').style('align-items', 'baseline').style('gap', '8px')
      .append('div').attr('class', 'chart-title').text(group.label);
    return div;
  }

  function drawAxes(svg, x, y, width, height) {
    svg.append('g').attr('class', 'axis axis-bottom')
      .attr('transform', `translate(0,${height - MARGIN.bottom})`)
      .call(d3.axisBottom(x).ticks(Math.min(8, width / 90)));
    svg.append('g').attr('class', 'axis axis-left')
      .attr('transform', `translate(${MARGIN.left},0)`)
      .call(d3.axisLeft(y).ticks(5));
  }

  /* ---------- Interaction Helpers ---------- */

  function attachInteractions(svg, panelData, x, width, height, seriesInfo) {
    const guide = svg.append('line').attr('class', 'hover-line')
      .attr('y1', MARGIN.top).attr('y2', height - MARGIN.bottom).style('display', 'none');

    const overlay = svg.append('rect').attr('class', 'interaction-overlay')
      .attr('x', MARGIN.left).attr('y', MARGIN.top)
      .attr('width', width - MARGIN.left - MARGIN.right)
      .attr('height', height - MARGIN.top - MARGIN.bottom)
      .attr('fill', 'transparent').style('cursor', 'grab').style('touch-action', 'none');

    const activePointers = new Map();
    let isDragging = false, startX = 0, startDomain = null;
    let initialPinchDist = 0, initialPinchCenter = 0;

    function getPointerDistance() {
      const pts = Array.from(activePointers.values());
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    function getPointerCenter() {
      const pts = Array.from(activePointers.values());
      const rect = overlay.node().getBoundingClientRect();
      return ((pts[0].x + pts[1].x) / 2) - rect.left;
    }

    function updateHover(pointerX, pageX, pageY) {
      if (isDragging || activePointers.size > 0) {
        guide.style('display', 'none'); tooltip.style('display', 'none'); return;
      }
      const date = x.invert(pointerX);
      const bisect = d3.bisector(d => d.time).left;
      const i = bisect(panelData, date);
      const d = panelData[Math.max(0, Math.min(panelData.length - 1, i))];
      if (!d) return;
      guide.attr('x1', x(d.time)).attr('x2', x(d.time)).style('display', null);
      let html = `<b>${fmtDate(d.time)}</b><br>`;
      for (const s of seriesInfo) {
        const v = d[s.key];
        let valStr = '\u2013';
        if (v != null) valStr = s.formatter ? s.formatter(v, d) : v.toFixed(2);
        html += `<span style="color:${s.color}">\u25cf</span> ${s.label}: ${valStr}<br>`;
      }
      tooltip.style('display', null).html(html);
      const tw = tooltip.node().offsetWidth;
      const leftPos = pageX > window.innerWidth * (2 / 3) ? pageX - tw - 12 : pageX + 12;
      tooltip.style('left', leftPos + 'px').style('top', (pageY - 20) + 'px');
    }

    overlay
      .on('pointerdown', (event) => {
        overlay.node().setPointerCapture(event.pointerId);
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (activePointers.size === 1) {
          isDragging = false; startX = event.clientX;
          startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
        } else if (activePointers.size === 2) {
          isDragging = true;
          initialPinchDist = getPointerDistance();
          initialPinchCenter = getPointerCenter();
          startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
          guide.style('display', 'none'); tooltip.style('display', 'none');
        }
      })
      .on('pointermove', (event) => {
        if (activePointers.has(event.pointerId))
          activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const [mx] = d3.pointer(event);

        if (activePointers.size === 2 && startDomain && initialPinchDist > 0) {
          guide.style('display', 'none'); tooltip.style('display', 'none');
          const currentDist = getPointerDistance();
          if (currentDist <= 0) return;
          const factor = initialPinchDist / currentDist;
          const span = startDomain[1] - startDomain[0];
          let newSpan = Math.max(span * factor, 1000 * 60 * 60 * 6);
          newSpan = Math.min(newSpan, latestBound() - EARLIEST);
          const xBase = xScaleFor(width);
          const focalDate = xBase.invert(initialPinchCenter);
          const ratio = (focalDate - startDomain[0]) / span;
          let newStart = new Date(focalDate.getTime() - ratio * newSpan);
          let newEnd = new Date(focalDate.getTime() + (1 - ratio) * newSpan);
          if (newStart < EARLIEST) { newEnd = new Date(newEnd.getTime() + (EARLIEST - newStart)); newStart = new Date(EARLIEST); }
          const maxEnd = latestBound();
          if (newEnd > maxEnd) { newStart = new Date(newStart.getTime() - (newEnd - maxEnd)); newEnd = maxEnd; }
          state.domain = [newStart, newEnd];
          updateAllCharts(); scheduleRender(); return;
        }

        if (activePointers.size === 1 && startDomain) {
          const dx = event.clientX - startX;
          if (Math.abs(dx) > 3) { isDragging = true; overlay.style('cursor', 'grabbing'); guide.style('display', 'none'); tooltip.style('display', 'none'); }
          if (isDragging) {
            const plotWidth = width - MARGIN.left - MARGIN.right;
            const msPerPx = (startDomain[1] - startDomain[0]) / plotWidth;
            const dt = dx * msPerPx;
            let newStart = new Date(startDomain[0].getTime() - dt);
            let newEnd = new Date(startDomain[1].getTime() - dt);
            const span = startDomain[1] - startDomain[0];
            if (newStart < EARLIEST) { newStart = new Date(EARLIEST); newEnd = new Date(EARLIEST.getTime() + span); }
            const maxEnd = latestBound();
            if (newEnd > maxEnd) { newEnd = maxEnd; newStart = new Date(maxEnd.getTime() - span); }
            state.domain = [newStart, newEnd];
            updateAllCharts(); scheduleRender(); return;
          }
        }

        if (!isDragging && activePointers.size === 0) updateHover(mx, event.pageX, event.pageY);
      })
      .on('pointerup pointercancel', (event) => {
        if (activePointers.has(event.pointerId)) {
          try { overlay.node().releasePointerCapture(event.pointerId); } catch (_) { }
          activePointers.delete(event.pointerId);
        }
        if (activePointers.size === 0) { isDragging = false; overlay.style('cursor', 'grab'); }
      })
      .on('mouseleave', () => {
        if (!isDragging && activePointers.size === 0) { guide.style('display', 'none'); tooltip.style('display', 'none'); }
      });
  }

  function attachHeatmapInteractions(svg, panelData, x, y, width, height, maxDepth) {
    const vLine = svg.append('line').attr('class', 'hover-line')
      .attr('y1', MARGIN.top).attr('y2', height - MARGIN.bottom).style('display', 'none').style('pointer-events', 'none');
    const hLine = svg.append('line').attr('class', 'hover-line')
      .attr('x1', MARGIN.left).attr('x2', width - MARGIN.right).style('display', 'none').style('pointer-events', 'none');

    const overlay = svg.append('rect').attr('class', 'interaction-overlay')
      .attr('x', MARGIN.left).attr('y', MARGIN.top)
      .attr('width', width - MARGIN.left - MARGIN.right)
      .attr('height', height - MARGIN.top - MARGIN.bottom)
      .attr('fill', 'transparent').style('cursor', 'grab').style('touch-action', 'none');

    const activePointers = new Map();
    let isDragging = false, startX = 0, startDomain = null;

    function updateHover(pointerX, pointerY, pageX, pageY) {
      if (isDragging || activePointers.size > 0) {
        vLine.style('display', 'none'); hLine.style('display', 'none'); tooltip.style('display', 'none'); return;
      }
      const date = x.invert(pointerX);
      const bisect = d3.bisector(d => d.time).left;
      const i = bisect(panelData, date);
      const d = panelData[Math.max(0, Math.min(panelData.length - 1, i))];
      if (!d) return;
      const targetDepth = Math.max(0, Math.min(maxDepth, y.invert(pointerY)));
      const temp = interpolateTempAtDepth(d, targetDepth);
      vLine.attr('x1', x(d.time)).attr('x2', x(d.time)).style('display', null);
      hLine.attr('y1', pointerY).attr('y2', pointerY).style('display', null);
      const html = `<b>${fmtDate(d.time)}</b><br>Depth: ${targetDepth.toFixed(1)} m<br>Temp: ${temp != null ? temp.toFixed(2) + ' ' + tUnit() : '\u2013'}`;
      tooltip.style('display', null).html(html);
      const tw = tooltip.node().offsetWidth;
      const lp = pageX > window.innerWidth * (2 / 3) ? pageX - tw - 12 : pageX + 12;
      tooltip.style('left', lp + 'px').style('top', (pageY - 20) + 'px');
    }

    overlay
      .on('pointerdown', (event) => {
        overlay.node().setPointerCapture(event.pointerId);
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (activePointers.size === 1) {
          isDragging = false; startX = event.clientX;
          startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
        }
      })
      .on('pointermove', (event) => {
        if (activePointers.has(event.pointerId))
          activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const [mx, my] = d3.pointer(event);
        if (activePointers.size === 1 && startDomain) {
          const dx = event.clientX - startX;
          if (Math.abs(dx) > 3) { isDragging = true; overlay.style('cursor', 'grabbing'); vLine.style('display', 'none'); hLine.style('display', 'none'); tooltip.style('display', 'none'); }
          if (isDragging) {
            const plotWidth = width - MARGIN.left - MARGIN.right;
            const msPerPx = (startDomain[1] - startDomain[0]) / plotWidth;
            const dt = dx * msPerPx;
            let newStart = new Date(startDomain[0].getTime() - dt);
            let newEnd = new Date(startDomain[1].getTime() - dt);
            const span = startDomain[1] - startDomain[0];
            if (newStart < EARLIEST) { newStart = new Date(EARLIEST); newEnd = new Date(EARLIEST.getTime() + span); }
            const maxEnd = latestBound();
            if (newEnd > maxEnd) { newEnd = maxEnd; newStart = new Date(maxEnd.getTime() - span); }
            state.domain = [newStart, newEnd];
            updateAllCharts(); scheduleRender(); return;
          }
        }
        if (!isDragging && activePointers.size === 0) updateHover(mx, my, event.pageX, event.pageY);
      })
      .on('pointerup pointercancel', (event) => {
        if (activePointers.has(event.pointerId)) {
          try { overlay.node().releasePointerCapture(event.pointerId); } catch (_) { }
          activePointers.delete(event.pointerId);
        }
        if (activePointers.size === 0) { isDragging = false; overlay.style('cursor', 'grab'); }
      })
      .on('mouseleave', () => {
        if (!isDragging && activePointers.size === 0) { vLine.style('display', 'none'); hLine.style('display', 'none'); tooltip.style('display', 'none'); }
      });
  }

  /* ---------- Mini Cards ---------- */

  function renderMiniCards(recent) {
    const ccSince = new Date(nowChicago().getTime() - CURRENT_CONDITIONS_HOURS * 3600000);
    const records = recent.filter(r => r.timestamp >= ccSince);
    const fresh = records.filter(r => r.timestamp >= staleCutoff());
    const latestRec = records[records.length - 1];

    const section = chartsEl.append('div').attr('class', 'mini-cards-section');
    const header = section.append('div').attr('class', 'mini-cards-header');
    header.append('div').attr('class', 'mini-cards-title').text('Current Conditions');
    header.append('div').attr('class', 'mini-cards-timestamp').text(latestRec
      ? `As of ${fmtDate(latestRec.timestamp)}`
      : `No data in the last ${CURRENT_CONDITIONS_HOURS} hours`);
    const grid = section.append('div').attr('class', 'mini-cards-grid');

    GROUPS.forEach(g => {
      if (!state.visible.has(g.key)) return;
      // Hide cards for sensors with no data in STALE_SENSOR_HOURS
      if (!hasGroupAnyData(g, fresh)) return;
      const card = grid.append('div').attr('class', 'mini-card');

      if (g.kind === 'profile') {
        const titleRow = card.append('div').attr('class', 'mini-card-title');
        titleRow.append('span').text(g.label);
        addTempToggle(titleRow);
        const subGrid = card.append('div').attr('class', 'mini-card-grid-values');
        MINI_CARD_DEPTHS.forEach(depth => {
          const temp = getLastDepthTemp(records, depth);
          const item = subGrid.append('div').attr('class', 'mini-card-grid-item');
          item.append('span').attr('class', 'mini-card-grid-label').text(`${depth}m`);
          item.append('span').attr('class', 'mini-card-grid-val').text(temp != null ? `${temp.toFixed(1)}${tUnit()}` : '\u2013');
        });
      } else if (g.kind === 'do') {
        const titleRow = card.append('div').attr('class', 'mini-card-title');
        titleRow.append('span').text(g.label);
        const ut = titleRow.append('div').attr('class', 'unit-toggle');
        ['sat', 'raw'].forEach(u => {
          ut.append('button').text(u === 'sat' ? '%' : 'mg/L').classed('active', state.doUnit === u)
            .on('click', (e) => { e.stopPropagation(); state.doUnit = u; render(); });
        });
        const key = state.doUnit === 'sat' ? 'do_sat' : 'do_raw';
        const unit = state.doUnit === 'sat' ? '%' : 'mg/L';
        const val = getLastValue(records, key);
        card.append('div').attr('class', 'mini-card-value').text(val != null ? `${val.toFixed(2)} ${unit}` : '\u2013');
      } else if (g.kind === 'par') {
        card.append('div').attr('class', 'mini-card-title').append('span').text(g.label);
        const subGrid = card.append('div').attr('class', 'mini-card-grid-values');
        [{ k: 'PAR_above_Avg', lbl: 'Above' }, { k: 'PAR_below_Avg', lbl: 'Below' }].forEach(({ k, lbl }) => {
          const val = getLastValue(records, k);
          const item = subGrid.append('div').attr('class', 'mini-card-grid-item');
          item.append('span').attr('class', 'mini-card-grid-label').text(lbl);
          item.append('span').attr('class', 'mini-card-grid-val').text(val != null ? `${val.toFixed(1)} \u00b5mol/m\u00b2/s` : '\u2013');
        });
      } else if (g.kind === 'wind') {
        const titleRow = card.append('div').attr('class', 'mini-card-title');
        titleRow.append('span').text(g.label);
        const ut = titleRow.append('div').attr('class', 'unit-toggle');
        ['ms', 'mph'].forEach(u => {
          ut.append('button').text(u === 'ms' ? 'm/s' : 'mph').classed('active', state.windUnit === u)
            .on('click', (e) => { e.stopPropagation(); state.windUnit = u; render(); });
        });
        const ws = getLastValue(records, 'wsL');
        const wd = getLastValue(records, 'wdL');
        const isMph = state.windUnit === 'mph';
        const unit = isMph ? 'mph' : 'm/s';
        const dispWs = ws != null ? (isMph ? ws * MS_TO_MPH : ws) : null;
        const subGrid = card.append('div').attr('class', 'mini-card-grid-values');
        const iSpd = subGrid.append('div').attr('class', 'mini-card-grid-item');
        iSpd.append('span').attr('class', 'mini-card-grid-label').text('Speed');
        iSpd.append('span').attr('class', 'mini-card-grid-val').text(dispWs != null ? `${dispWs.toFixed(1)} ${unit}` : '\u2013');
        const iDir = subGrid.append('div').attr('class', 'mini-card-grid-item');
        iDir.append('span').attr('class', 'mini-card-grid-label').text('Direction');
        if (wd != null) {
          const towards = (wd + 180) % 360;
          iDir.append('span').attr('class', 'mini-card-grid-val').text(`${towards.toFixed(0)}\u00b0 (${getCompassDirection(towards)})`);
        } else {
          iDir.append('span').attr('class', 'mini-card-grid-val').text('\u2013');
        }
      } else if (g.kind === 'simple') {
        const titleRow = card.append('div').attr('class', 'mini-card-title');
        titleRow.append('span').text(g.label);
        if (isTempGroup(g)) addTempToggle(titleRow);
        const val = getLastValue(records, g.vkey);
        const unitStr = g.unit ? ` ${dispUnit(g.unit)}` : '';
        card.append('div').attr('class', 'mini-card-value').text(val != null ? `${val.toFixed(2)}${unitStr}` : '\u2013');
      }
    });

    if (grid.selectAll('.mini-card').empty()) {
      grid.append('div').attr('class', 'mini-cards-empty')
        .style('color', 'var(--muted)').style('font-size', '0.85rem').style('padding', '6px 2px')
        .text(`No sensors have reported in the last ${STALE_SENSOR_HOURS} hours.`);
    }
  }

  /* ---------- Temperature Units ---------- */

  const DEG_C = '\u00b0C';
  const TEMP_KEYS = new Set([
    ...WT_KEYS,
    ...GROUPS.filter(g => g.kind === 'simple' && g.unit === DEG_C).map(g => g.vkey),
  ]);
  const isF = () => state.tempUnit === 'F';
  const cToF = c => c * 9 / 5 + 32;
  function tUnit() { return isF() ? '\u00b0F' : DEG_C; }
  function dispUnit(u) { return u === DEG_C ? tUnit() : u; }
  function isTempGroup(g) { return g.kind === 'profile' || (g.kind === 'simple' && g.unit === DEG_C); }

  // Copy of records with temperature variables converted to the display unit
  function toDisplayTemps(recs) {
    if (!isF()) return recs;
    return recs.map(r => {
      const o = { ...r };
      for (const k of TEMP_KEYS) if (o[k] != null) o[k] = cToF(o[k]);
      return o;
    });
  }

  // °C / °F buttons (one setting shared by every temperature variable)
  function addTempToggle(container) {
    const ut = container.append('div').attr('class', 'unit-toggle');
    ['C', 'F'].forEach(u => {
      ut.append('button').text(`\u00b0${u}`).classed('active', state.tempUnit === u)
        .on('click', (e) => { e.stopPropagation(); state.tempUnit = u; render(); });
    });
  }

  /* ---------- Chart Renderers ---------- */

  // Default water temp range (°C) for the profile lines and heatmap, based on the
  // lake's annual range so colors/axes are comparable across any time window.
  // Readings outside it widen the range rather than being cut off.
  const WATER_TEMP_RANGE = config.waterTempRange || [0, 30];
  function waterTempDomain(binned, keys = WT_KEYS) {
    let [lo, hi] = isF() ? WATER_TEMP_RANGE.map(cToF) : WATER_TEMP_RANGE;
    for (const d of binned) {
      for (const k of keys) {
        const v = d[k];
        if (v == null || isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  }

  // Lines connect readings at most this far apart; longer gaps are left blank.
  // Never smaller than one bin, so binned lines stay continuous.
  const MAX_LINE_GAP_MS = 60 * 60000;
  function maxGapMs() {
    return Math.max(MAX_LINE_GAP_MS, (state.binMinutes || 0) * 60000);
  }

  // Build a line path for one series, breaking it wherever consecutive valid
  // points are more than maxGapMs() apart (instead of drawing across the gap).
  function gapLine(xScale, getV, yScale) {
    const line = d3.line().defined(p => p != null).x(p => xScale(p.time)).y(p => yScale(p.v));
    return (data) => {
      const pts = [];
      let prevT = null;
      const gap = maxGapMs();
      for (const d of data) {
        const v = getV(d);
        if (v == null || isNaN(v)) continue;
        if (prevT != null && d.time - prevT > gap) pts.push(null);
        pts.push({ time: d.time, v });
        prevT = d.time;
      }
      return line(pts);
    };
  }

  function renderSimple(group, records, binned) {
    const div = panel(group);
    const height = 160;
    const { svg, width, clipId } = makeSvg(div, height);
    const x = xScaleFor(width);
    const vals = binned.map(d => d[group.vkey]).filter(v => v != null);
    const y = d3.scaleLinear()
      .domain(vals.length ? [d3.min(vals), d3.max(vals)] : [0, 1]).nice()
      .range([height - MARGIN.bottom, MARGIN.top]);
    drawAxes(svg, x, y, width, height);
    div.select('.chart-title-group').append('div').attr('class', 'chart-sub').text(`${dispUnit(group.unit || '')}`.trim());
    if (isTempGroup(group)) addTempToggle(div.select('.chart-title-row'));

    const plotArea = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const line = gapLine(x, d => d[group.vkey], y);
    plotArea.append('path').datum(binned).attr('class', 'legend-line').attr('stroke', '#14708c').attr('d', line);

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      const l = gapLine(xNew, d => d[group.vkey], y);
      plotArea.select('path.legend-line').attr('d', l);
    };

    attachInteractions(svg, binned, x, width, height, [{ key: group.vkey, label: group.label, color: '#14708c' }]);
  }

  function renderProfile(group, records, binned) {
    const div = panel(group);
    const top = div.select('.chart-title-row');
    const controls = top.append('div').style('display', 'flex').style('gap', '10px');
    addTempToggle(controls);
    const ut = controls.append('div').attr('class', 'unit-toggle');
    [{ id: 'lines', label: 'Lines' }, { id: 'heatmap', label: 'Heatmap' }].forEach(m => {
      ut.append('button').text(m.label).classed('active', state.wtProfileMode === m.id)
        .on('click', () => { state.wtProfileMode = m.id; render(); });
    });
    if (state.wtProfileMode === 'lines') renderProfileLines(div, group, records, binned);
    else renderProfileHeatmap(div, group, records, binned);
  }

  function renderProfileLines(div, group, records, binned) {
    const maxDepth = DEPTHS[DEPTHS.length - 1];
    const dt = div.append('div').attr('class', 'depth-toggles');
    const color = d3.scaleLinear().domain([0, maxDepth]).range(['#72bcd4', '#0b3d4c']);

    DEPTHS.forEach((depth, i) => {
      const key = WT_KEYS[i];
      const on = state.depthOn.has(key);
      dt.append('span').attr('class', 'depth-swatch' + (on ? '' : ' off'))
        .style('background', color(depth)).text(`${depth}m`)
        .on('click', function () {
          if (state.depthOn.has(key)) state.depthOn.delete(key); else state.depthOn.add(key);
          render();
        });
    });

    const height = 220;
    const { svg, width, clipId } = makeSvg(div, height);
    const x = xScaleFor(width);
    const activeKeys = WT_KEYS.filter(k => state.depthOn.has(k));
    const y = d3.scaleLinear().domain(waterTempDomain(binned, activeKeys)).nice()
      .range([height - MARGIN.bottom, MARGIN.top]);
    drawAxes(svg, x, y, width, height);
    div.select('.chart-title-group').append('div').attr('class', 'chart-sub')
      .text(`${tUnit()} \u2014 color = depth (light blue = shallow, deep blue = deep)`);

    const plotArea = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const seriesInfo = [];
    activeKeys.forEach((k, idx) => {
      const depth = DEPTHS[WT_KEYS.indexOf(k)];
      const c = color(depth);
      seriesInfo.push({ key: k, label: `${depth}m`, color: c });
      const line = gapLine(x, d => d[k], y);
      plotArea.append('path').datum(binned).attr('class', 'legend-line').attr('stroke', c).attr('d', line);
    });

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      activeKeys.forEach((k, idx) => {
        const l = gapLine(xNew, d => d[k], y);
        plotArea.selectAll('path.legend-line').filter((_, i) => i === idx).attr('d', l);
      });
    };

    attachInteractions(svg, binned, x, width, height, seriesInfo);
  }

  function renderProfileHeatmap(div, group, records, binned) {
    const maxDepth = DEPTHS[DEPTHS.length - 1];
    const [minTemp, maxTemp] = waterTempDomain(binned);

    const legendDiv = div.append('div').attr('class', 'heatmap-legend')
      .style('display', 'flex').style('align-items', 'center').style('gap', '8px')
      .style('margin', '4px 0 6px').style('font-size', '0.72rem').style('color', 'var(--muted)');
    legendDiv.append('span').text(`${minTemp.toFixed(1)}${tUnit()}`);
    legendDiv.append('div').style('height', '10px').style('width', '140px').style('border-radius', '3px')
      .style('background', 'linear-gradient(to right, #14708c, #d97a3c)');
    legendDiv.append('span').text(`${maxTemp.toFixed(1)}${tUnit()}`);

    const height = 220;
    const wrapper = div.append('div').style('position', 'relative');
    const colorScale = d3.scaleLinear().domain([minTemp, maxTemp]).range(['#14708c', '#d97a3c']).interpolate(d3.interpolateRgb).clamp(true);
    const { svg, width } = makeSvg(wrapper, height);
    svg.style('position', 'relative').style('z-index', '1');

    const canvas = wrapper.insert('canvas', 'svg')
      .style('position', 'absolute').style('left', '0').style('top', '0')
      .style('width', `${width}px`).style('height', `${height}px`).style('pointer-events', 'none')
      .attr('width', width).attr('height', height);
    const ctx = canvas.node().getContext('2d');
    const x = xScaleFor(width);
    const y = d3.scaleLinear().domain([0, maxDepth]).range([MARGIN.top, height - MARGIN.bottom]);

    svg.append('g').attr('class', 'axis axis-bottom')
      .attr('transform', `translate(0,${height - MARGIN.bottom})`)
      .call(d3.axisBottom(x).ticks(Math.min(8, width / 90)));
    svg.append('g').attr('class', 'axis axis-left')
      .attr('transform', `translate(${MARGIN.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}m`));

    div.select('.chart-title-group').append('div').attr('class', 'chart-sub')
      .text('Temperatures are interpolated between sensors; areas more than 2 m from a working sensor are left blank.');

    const T = binned.length;
    const D = 100;
    if (T > 0) {
      const offCanvas = document.createElement('canvas');
      offCanvas.width = T; offCanvas.height = D;
      const offCtx = offCanvas.getContext('2d');
      const imgData = offCtx.createImageData(T, D);

      for (let row = 0; row < D; row++) {
        const targetDepth = (row / (D - 1)) * maxDepth;
        for (let col = 0; col < T; col++) {
          const rec = binned[col];
          const temp = interpolateTempAtDepth(rec, targetDepth);
          const pixelIdx = (row * T + col) * 4;
          if (temp == null) {
            imgData.data[pixelIdx + 3] = 0;
          } else {
            const c = d3.rgb(colorScale(temp));
            imgData.data[pixelIdx] = c.r;
            imgData.data[pixelIdx + 1] = c.g;
            imgData.data[pixelIdx + 2] = c.b;
            imgData.data[pixelIdx + 3] = 255;
          }
        }
      }
      offCtx.putImageData(imgData, 0, 0);

      const drawHeatmap = (xScale) => {
        const plotWidth = width - MARGIN.left - MARGIN.right;
        const plotHeight = height - MARGIN.top - MARGIN.bottom;
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.beginPath(); ctx.rect(MARGIN.left, MARGIN.top, plotWidth, plotHeight); ctx.clip();
        for (let i = 0; i < T; i++) {
          const x0 = xScale(binned[i].time);
          // Stretch each column to the next bin, but not across gaps longer than maxGapMs()
          const binEnd = new Date(binned[i].time.getTime() + (state.binMinutes || 5) * 60000);
          let x1 = (i < T - 1 && binned[i + 1].time - binned[i].time <= maxGapMs())
            ? xScale(binned[i + 1].time) : xScale(binEnd);
          if (x1 <= x0) x1 = x0 + 1;
          if (x1 < MARGIN.left || x0 > width - MARGIN.right) continue;
          const x0Floor = Math.floor(x0);
          const drawW = Math.max(1, Math.ceil(x1) - x0Floor + 1);
          ctx.drawImage(offCanvas, i, 0, 1, D, x0Floor, MARGIN.top, drawW, plotHeight);
        }
        ctx.restore();
      };

      drawHeatmap(x);
      div.node()._updateX = () => {
        const xNew = xScaleFor(width);
        svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
        drawHeatmap(xNew);
      };
    }

    attachHeatmapInteractions(svg, binned, x, y, width, height, maxDepth);
  }

  function renderDO(group, records, binned) {
    const div = panel(group);
    const top = div.select('.chart-title-row');
    const ut = top.append('div').attr('class', 'unit-toggle');
    ['sat', 'raw'].forEach(u => {
      ut.append('button').text(u === 'sat' ? '%' : 'mg/L').classed('active', state.doUnit === u)
        .on('click', () => { state.doUnit = u; render(); });
    });
    const key = state.doUnit === 'sat' ? 'do_sat' : 'do_raw';
    const unit = state.doUnit === 'sat' ? '%' : 'mg/L';
    const height = 160;
    const { svg, width, clipId } = makeSvg(div, height);
    const x = xScaleFor(width);
    const vals = binned.map(d => d[key]).filter(v => v != null);
    const y = d3.scaleLinear().domain(vals.length ? [d3.min(vals), d3.max(vals)] : [0, 1]).nice()
      .range([height - MARGIN.bottom, MARGIN.top]);
    drawAxes(svg, x, y, width, height);
    div.select('.chart-title-group').append('div').attr('class', 'chart-sub').text(unit);

    const plotArea = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const line = gapLine(x, d => d[key], y);
    plotArea.append('path').datum(binned).attr('class', 'legend-line').attr('stroke', '#14708c').attr('d', line);

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      const l = gapLine(xNew, d => d[key], y);
      plotArea.select('path.legend-line').attr('d', l);
    };

    attachInteractions(svg, binned, x, width, height, [{ key, label: `DO (${unit})`, color: '#14708c' }]);
  }

  function renderPAR(group, records, binned) {
    const div = panel(group);
    const height = 160;
    const { svg, width, clipId } = makeSvg(div, height);
    const x = xScaleFor(width);
    const keys = [
      { k: 'PAR_above_Avg', label: 'Above water', color: '#d97a3c' },
      { k: 'PAR_below_Avg', label: 'Below water', color: '#14708c' }
    ];
    let allVals = [];
    binned.forEach(d => keys.forEach(s => { if (d[s.k] != null) allVals.push(d[s.k]); }));
    const y = d3.scaleLinear().domain(allVals.length ? [0, d3.max(allVals)] : [0, 1]).nice()
      .range([height - MARGIN.bottom, MARGIN.top]);
    drawAxes(svg, x, y, width, height);
    div.select('.chart-title-group').append('div').attr('class', 'chart-sub')
      .text('\u00b5mol m\u207b\u00b2 s\u207b\u00b9  \u2014 orange = above water, blue = below water');

    const plotArea = svg.append('g').attr('clip-path', `url(#${clipId})`);
    keys.forEach(s => {
      const line = gapLine(x, d => d[s.k], y);
      plotArea.append('path').datum(binned).attr('class', 'legend-line').attr('stroke', s.color).attr('d', line);
    });

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      keys.forEach((s, idx) => {
        const l = gapLine(xNew, d => d[s.k], y);
        plotArea.selectAll('path.legend-line').filter((_, i) => i === idx).attr('d', l);
      });
    };

    attachInteractions(svg, binned, x, width, height, keys.map(s => ({ key: s.k, label: s.label, color: s.color })));
  }

  function renderWind(group, records, binned, mins) {
    const div = panel(group);
    const top = div.select('.chart-title-row');
    const ut = top.append('div').attr('class', 'unit-toggle');
    ['ms', 'mph'].forEach(u => {
      ut.append('button').text(u === 'ms' ? 'm/s' : 'mph').classed('active', state.windUnit === u)
        .on('click', () => { state.windUnit = u; render(); });
    });
    const isMph = state.windUnit === 'mph';
    const unit = isMph ? 'mph' : 'm/s';
    const speedMult = isMph ? MS_TO_MPH : 1;

    const height = 170;
    const { svg, width, clipId } = makeSvg(div, height);
    const x = xScaleFor(width);
    const vals = binned.map(d => d.wsL != null ? d.wsL * speedMult : null).filter(v => v != null);
    const y = d3.scaleLinear().domain([0, vals.length ? d3.max(vals) : 1]).nice()
      .range([height - MARGIN.bottom, MARGIN.top]);
    drawAxes(svg, x, y, width, height);

    const plotWidth = width - MARGIN.left - MARGIN.right;
    const maxArrows = Math.max(1, Math.floor(plotWidth / 22));
    const step = Math.max(1, Math.ceil(binned.length / maxArrows));

    const arrowPts = [];
    for (let i = 0; i < binned.length; i += step) {
      const chunk = binned.slice(i, i + step).filter(d => d.wsL != null && d.wdL != null);
      if (!chunk.length) continue;
      let sinSum = 0, cosSum = 0, speedSum = 0;
      chunk.forEach(d => { const rad = d.wdL * Math.PI / 180; sinSum += Math.sin(rad); cosSum += Math.cos(rad); speedSum += d.wsL; });
      let avgWd = Math.atan2(sinSum / chunk.length, cosSum / chunk.length) * 180 / Math.PI;
      if (avgWd < 0) avgWd += 360;
      arrowPts.push({ time: chunk[Math.floor(chunk.length / 2)].time, wsL: (speedSum / chunk.length) * speedMult, wdL: avgWd });
    }

    const arrowIntervalMins = step * mins;
    function formatInterval(m) {
      if (m < 60) return `${m} min`;
      if (m < 1440) { const h = m / 60; return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`; }
      const d2 = m / 1440; return `${Number.isInteger(d2) ? d2 : d2.toFixed(1)} day`;
    }
    const spacingText = step > 1 ? ` (${formatInterval(arrowIntervalMins)} average)` : '';
    div.select('.chart-title-group').append('div').attr('class', 'chart-sub')
      .text(`${unit} \u2014 arrows show direction wind is blowing toward${spacingText}`);

    const plotArea = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const line = gapLine(x, d => (d.wsL != null ? d.wsL * speedMult : null), y);
    plotArea.append('path').datum(binned).attr('class', 'legend-line').attr('stroke', '#5c7680').attr('d', line);
    plotArea.selectAll('.wind-arrow').data(arrowPts).enter().append('path')
      .attr('class', 'wind-arrow').attr('d', 'M0,-7 L0,7 M0,-7 L-4,-2 M0,-7 L4,-2')
      .attr('stroke', '#d97a3c').attr('stroke-width', 1.6).attr('fill', 'none')
      .attr('transform', d => `translate(${x(d.time)},${y(d.wsL)}) rotate(${(d.wdL + 180) % 360})`);

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select('g.axis-bottom').call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      const l = gapLine(xNew, d => (d.wsL != null ? d.wsL * speedMult : null), y);
      plotArea.select('path.legend-line').attr('d', l);
      plotArea.selectAll('.wind-arrow').attr('transform', d => `translate(${xNew(d.time)},${y(d.wsL)}) rotate(${(d.wdL + 180) % 360})`);
    };

    attachInteractions(svg, binned, x, width, height, [
      {
        key: 'wsL',
        label: `Wind speed (${unit})`,
        color: '#5c7680',
        formatter: (v) => `${(v * speedMult).toFixed(2)}`
      },
      {
        key: 'wdL', label: 'Wind direction (towards)', color: '#d97a3c',
        formatter: (v) => { const t = (v + 180) % 360; return `${t.toFixed(0)}\u00b0 (${getCompassDirection(t)})`; }
      }
    ]);
  }

  /* ---------- Empty / Inactive Group helpers ---------- */

  function hasValidValue(v) {
    return v != null && !isNaN(v) && v !== 0 && v !== -99;
  }

  // Like hasGroupValidData, but any reading counts (including 0, e.g. PAR at night)
  function hasGroupAnyData(g, records) {
    const ok = v => v != null && !isNaN(v) && v !== -99;
    if (g.kind === 'simple') return records.some(r => ok(r[g.vkey]));
    if (g.kind === 'do') return records.some(r => ok(r.do_raw) || ok(r.do_sat));
    if (g.kind === 'par') return records.some(r => ok(r.PAR_above_Avg) || ok(r.PAR_below_Avg) || ok(r.par));
    if (g.kind === 'wind') return records.some(r => ok(r.wsL) || ok(r.wdL));
    if (g.kind === 'profile') return records.some(r => WT_KEYS.some(k => ok(r[k])));
    return false;
  }

  function hasGroupValidData(g, records) {
    if (!records || records.length === 0) return false;

    if (g.kind === 'simple') {
      return records.some(r => hasValidValue(r[g.vkey]));
    }
    if (g.kind === 'do') {
      return records.some(r => hasValidValue(r.do_raw) || hasValidValue(r.do_sat));
    }
    if (g.kind === 'par') {
      return records.some(r => hasValidValue(r.PAR_above_Avg) || hasValidValue(r.PAR_below_Avg) || hasValidValue(r.par));
    }
    if (g.kind === 'wind') {
      return records.some(r => hasValidValue(r.wsL));
    }
    if (g.kind === 'profile') {
      return records.some(r => WT_KEYS.some(k => hasValidValue(r[k])));
    }
    return false;
  }

  /* ---------- Toggles ---------- */

  function buildToggles() {
    const wrap = document.getElementById('varToggles');
    wrap.innerHTML = '';

    GROUPS.forEach(g => {
      // Buttons for ALL groups remain visible in the bar
      const isVisible = state.visible.has(g.key);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = g.label;
      btn.classList.toggle('active', isVisible);

      btn.addEventListener('click', () => {
        state.userToggled.add(g.key);
        if (state.visible.has(g.key)) {
          state.visible.delete(g.key);
        } else {
          state.visible.add(g.key);
        }
        render();
      });

      wrap.appendChild(btn);
    });

    const allVisible = GROUPS.every(g => state.visible.has(g.key));
    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.textContent = allVisible ? 'Hide All' : 'Show All';
    toggleAllBtn.style.fontWeight = 'bold';
    toggleAllBtn.addEventListener('click', () => {
      if (allVisible) {
        state.visible.clear();
        GROUPS.forEach(g => state.userToggled.add(g.key));
      } else {
        GROUPS.forEach(g => {
          state.visible.add(g.key);
          state.userToggled.add(g.key);
        });
      }
      render();
    });
    wrap.appendChild(toggleAllBtn);

    const toggleCondBtn = document.createElement('button');
    toggleCondBtn.type = 'button';
    toggleCondBtn.textContent = state.showCurrentConditions ? 'Hide Current Conditions' : 'Show Current Conditions';
    toggleCondBtn.style.fontWeight = 'bold';
    toggleCondBtn.classList.toggle('active', state.showCurrentConditions);
    toggleCondBtn.addEventListener('click', () => {
      state.showCurrentConditions = !state.showCurrentConditions;
      state.condUserToggled = true;
      render();
    });
    wrap.appendChild(toggleCondBtn);
  }

  /* ---------- Chart sync & debounce ---------- */

  function updateAllCharts() {
    if (!state.domain) return;
    document.getElementById('startDate').value = dateStr(state.domain[0]);
    document.getElementById('endDate').value = dateStr(state.domain[1]);
    chartsEl.selectAll('.chart-panel').each(function () { if (this._updateX) this._updateX(); });
  }

  let renderDebounceTimer = null;
  function scheduleRender(delay = 150) {
    if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => render(), delay);
  }

  /* ---------- Main Render ---------- */

  let renderToken = 0;

  async function render() {
    const token = ++renderToken;
    const [start, end] = state.domain;
    document.getElementById('startDate').value = dateStr(start);
    document.getElementById('endDate').value = dateStr(end);
    for (const id of ['startDate', 'endDate']) {
      const el = document.getElementById(id);
      el.min = dateStr(EARLIEST);
      el.max = dateStr(latestBound());
    }

    const [records, recent] = await Promise.all([loadRange(start, end), loadRecentRecords()]);
    if (token !== renderToken) return;

    // Is the buoy quiet (offline/winter modal conditions)?
    const lastRecent = recent.length ? recent[recent.length - 1].timestamp : null;
    const buoyQuiet = noDataKind(lastRecent) != null;

    // Modal conditions: hide Current Conditions, keep the usual chart defaults.
    // Otherwise: show Current Conditions and hide charts for sensors that have
    // gone silent for SENSOR_HIDE_HOURS (unless the user toggled them).
    if (!state.condUserToggled) state.showCurrentConditions = !buoyQuiet;
    if (!buoyQuiet) {
      GROUPS.forEach(g => {
        if (!state.userToggled.has(g.key) && !hasGroupAnyData(g, recent)) state.visible.delete(g.key);
      });
    }

    // Auto-untoggle any groups with no valid data (all NA / -99 / 0), unless explicitly toggled by user
    if (records.length > 0) {
      GROUPS.forEach(g => {
        if (!state.userToggled.has(g.key)) {
          if (!hasGroupValidData(g, records)) {
            state.visible.delete(g.key);
          }
        }
      });
    }

    const spanDays = (end - start) / 86400000;
    const mins = binMinutesFor(spanDays);
    state.binMinutes = mins;
    document.getElementById('binNote').textContent = `Showing ${binLabel(mins)}`;

    const binnedRaw = binRecords(records, mins, new Set(['wdL']));
    // Convert temperatures to the selected unit for display (bins are linear averages)
    const binned = toDisplayTemps(binnedRaw);
    const recordsD = toDisplayTemps(records);

    buildToggles();

    const savedScrollY = window.scrollY;
    const currentHeight = chartsEl.node().offsetHeight;
    if (currentHeight > 0) chartsEl.style('min-height', `${currentHeight}px`);

    chartsEl.html('');

    if (state.showCurrentConditions) renderMiniCards(toDisplayTemps(recent));

    GROUPS.forEach(g => {
      if (!state.visible.has(g.key)) return;
      if (g.kind === 'simple') renderSimple(g, recordsD, binned);
      else if (g.kind === 'profile') renderProfile(g, recordsD, binned);
      else if (g.kind === 'do') renderDO(g, recordsD, binned);
      else if (g.kind === 'par') renderPAR(g, recordsD, binned);
      else if (g.kind === 'wind') renderWind(g, recordsD, binned, mins);
    });

    window.scrollTo(0, savedScrollY);
    chartsEl.style('min-height', null);
  }

  function setDomain(start, end, doRender) {
    if (start < EARLIEST) start = new Date(EARLIEST);
    const maxEnd = latestBound();
    if (end > maxEnd) end = maxEnd;
    state.domain = [start, end];
    if (doRender) render();
  }

  /* ---------- CSV Download ---------- */

  function toSnakeCase(str) {
    return str
      .replace(/°C|℃/gi, '_c')
      .replace(/°/g, '_deg_')
      .replace(/%/g, '_pct_')
      .replace(/µ|μ/g, 'u')
      .replace(/²/g, '2')
      .replace(/³/g, '3')
      .replace(/₂/g, '2')
      .replace(/[./\\]/g, '_')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase();
  }

  function buildCsvColumns() {
    // Returns array of { header, getValue(rec) } for all currently visible vars
    const cols = [{ header: 'timestamp', getValue: r => fmtDate(r.timestamp) }];
    GROUPS.forEach(g => {
      if (!state.visible.has(g.key)) return;
      if (g.kind === 'simple') {
        const header = g.unit ? `${g.label} (${g.unit})` : g.label;
        cols.push({ header: toSnakeCase(header), getValue: r => r[g.vkey] != null ? r[g.vkey] : '' });
      } else if (g.kind === 'profile') {
        DEPTHS.forEach((depth, i) => {
          cols.push({ header: toSnakeCase(`Water Temp ${depth}m (°C)`), getValue: r => r[WT_KEYS[i]] != null ? r[WT_KEYS[i]] : '' });
        });
      } else if (g.kind === 'do') {
        cols.push({ header: toSnakeCase('DO Saturation (%)'), getValue: r => r.do_sat != null ? r.do_sat : '' });
        cols.push({ header: toSnakeCase('DO (mg/L)'), getValue: r => r.do_raw != null ? r.do_raw : '' });
      } else if (g.kind === 'par') {
        cols.push({ header: toSnakeCase('PAR Above (µmol/m²/s)'), getValue: r => r.PAR_above_Avg != null ? r.PAR_above_Avg : '' });
        cols.push({ header: toSnakeCase('PAR Below (µmol/m²/s)'), getValue: r => r.PAR_below_Avg != null ? r.PAR_below_Avg : '' });
      } else if (g.kind === 'wind') {
        cols.push({ header: toSnakeCase('Wind Speed (m/s)'), getValue: r => r.wsL != null ? r.wsL : '' });
        cols.push({ header: toSnakeCase('Wind Direction (°from)'), getValue: r => r.wdL != null ? r.wdL : '' });
      }
    });
    return cols;
  }

  function downloadCsv() {
    if (!state.domain) return;
    const [start, end] = state.domain;

    // Collect all cached records for the domain at original resolution
    let recs = [];
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      d <= end; d.setDate(d.getDate() + 1)) {
      if (d < EARLIEST) continue;
      const key = dateStr(d);
      const v = state.cache.get(key);
      if (v && v !== 'missing' && !state.droppedDays.has(key)) recs = recs.concat(v);
    }
    recs.sort((a, b) => a.timestamp - b.timestamp);

    const rows = recs;

    const cols = buildCsvColumns();
    const header = cols.map(c => c.header).join(',');
    const body = rows.map(r => cols.map(c => {
      const v = c.getValue(r);
      return v === '' ? '' : (typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : String(v));
    }).join(',')).join('\n');

    const lakeName = (config.lakeName || 'buoy').replace(/\s+/g, '_');
    const startStr = dateStr(start);
    const endStr = dateStr(end);
    const filename = `${lakeName}_${startStr}_to_${endStr}.csv`;

    const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  /* ---------- Header Controls ---------- */

  function parseLocalDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // CSV download button
  const dlBtn = document.createElement('button');
  dlBtn.id = 'csvDownloadBtn';
  dlBtn.type = 'button';
  dlBtn.title = 'Download data as CSV';
  dlBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="13" height="13" style="vertical-align:-2px;margin-right:4px"><path d="M8 12l-4-4h2.5V3h3v5H12L8 12zm-5 2h10v1.5H3V14z"/></svg>Download CSV';
  document.querySelector('.range-row').appendChild(dlBtn);
  dlBtn.addEventListener('click', downloadCsv);

  document.getElementById('startDate').addEventListener('change', (e) => {
    const [, end] = state.domain;
    setDomain(parseLocalDate(e.target.value), end, true);
  });
  document.getElementById('endDate').addEventListener('change', (e) => {
    const [start] = state.domain;
    const end = parseLocalDate(e.target.value);
    end.setHours(23, 59, 59, 999); // include the whole selected end day (clamped to now)
    setDomain(start, end, true);
  });
  document.querySelectorAll('.presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = btn.dataset.days;
      const end = latestBound();
      const start = days === 'all' ? new Date(EARLIEST) : new Date(end.getTime() - days * 86400000);
      setDomain(start, end, true);
    });
  });

  window.addEventListener('resize', () => render());

  /* ---------- Init ---------- */

  (async function init() {
    const lastReading = await findLatestAvailable();
    const kind = noDataKind(lastReading);
    if (kind) showNoDataModal(kind, lastReading);

    // Open on the 3 days leading up to the most recent data
    const latest = lastReading ? new Date(lastReading) : latestBound();
    latest.setHours(23, 59, 59, 999);
    const start = new Date(latest.getTime() - 3 * 86400000);
    start.setHours(0, 0, 0, 0);
    setDomain(start, latest, true);
  })();
}

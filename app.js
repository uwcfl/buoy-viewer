/* ---------- Config ---------- */

const DEPTHS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const WT_KEYS = DEPTHS.map((d, i) => `wt${i + 1}`); // maps to watertemp(1..23)
const FILE_PREFIX = "https://mendota-buoy-proxy.sam-r-blackburn.workers.dev/mendota_buoy_limnodata.";
const EARLIEST = new Date(new Date().getFullYear(), 3, 1); // Mar 1 current year

// single-series plots: key -> {label, unit}
const SIMPLE_VARS = {
  airTL: { label: "Air Temp", unit: "\u00b0C" },
  rhL: { label: "Relative Humidity", unit: "%" },
  pco2ppm_Avg: { label: "pCO\u2082", unit: "ppm" },
  spCond: { label: "Specific Conductivity", unit: "\u00b5S/cm" },
  pH: { label: "pH", unit: "" },
  chlorYSI: { label: "Chlorophyll", unit: "RFU" },
  phycoYSI: { label: "Phycocyanin", unit: "RFU" },
  turbid: { label: "Turbidity", unit: "FNU" },
  fdom: { label: "fDOM", unit: "RFU" },
  IRTL: { label: "IR Surface Temp", unit: "\u00b0C" },
  pco2volt_Avg: { label: "pCO\u2082 Sensor Voltage", unit: "mV", voltage: true },
  battYSI: { label: "Battery Voltage", unit: "V", voltage: true },
};

// group order for rendering (group key -> render kind)
const GROUPS = [
  { key: "wtprofile", label: "Water Temp Profile", kind: "profile" },
  { key: "waterT", label: "Water Temp (YSI)", kind: "simple", vkey: "waterT", unit: "\u00b0C" },
  { key: "do", label: "Dissolved Oxygen", kind: "do" },
  { key: "par", label: "PAR", kind: "par" },
  { key: "wind", label: "Wind", kind: "wind" },
  ...Object.keys(SIMPLE_VARS).map(k => ({ key: k, label: SIMPLE_VARS[k].label, kind: "simple", vkey: k, unit: SIMPLE_VARS[k].unit })),
];

const COL_INDEX = {}; // header name -> row index, filled on first file load

/* ---------- Buoy Image Styling ---------- */

const wrap = document.getElementById('buoyWrap');
const img = document.getElementById('buoyImg');

function sizeBuoyWrap() {
  if (img.naturalWidth && img.naturalHeight) {
    const ratio = img.naturalWidth / img.naturalHeight;
    wrap.style.width = `${wrap.offsetHeight * ratio}px`;
  }
}

img.addEventListener('load', sizeBuoyWrap);
window.addEventListener('resize', sizeBuoyWrap);
if (img.complete) sizeBuoyWrap();

/* ---------- State ---------- */

const state = {
  domain: null,           // [Date, Date] currently displayed
  visible: new Set(["wtprofile", "do", "par", "wind", "airTL", "rhL",
    "pco2ppm_Avg", "spCond", "pH", "chlorYSI", "phycoYSI", "turbid", "fdom"]),
  depthOn: new Set(WT_KEYS),
  doUnit: "sat", // 'sat' | 'raw'
  wtProfileMode: "heatmap", // 'lines' | 'heatmap'
  cache: new Map(),  // dateStr -> array of records, or 'missing'
  allNaCols: new Set(), // discovered lazily, hidden regardless of toggle unless user forces
  droppedDays: new Set(), // dateStr of days identified as following a 3+ day gap; persists once found
};

// Data files store TIMESTAMP in UTC; the app displays everything in Central time (CDT/CST).
// This converts a true UTC instant into a Date object whose LOCAL getters (getHours, getDate, etc.)
// return Chicago wall-clock time, regardless of the viewer's own browser timezone. d3's time scales
// and timeFormat read those local getters, so once timestamps are converted at parse time, every
// downstream axis/tooltip/bin boundary is already in Central time with no further changes needed.
const chicagoParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
function toChicago(utcDate) {
  const parts = {};
  for (const p of chicagoParts.formatToParts(utcDate)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour; // some engines report midnight as 24
  return new Date(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
}

const today = toChicago(new Date());
today.setHours(23, 59, 59, 999);

/* ---------- Data loading ---------- */

function dateStr(d) {
  // local calendar date, not UTC (avoids off-by-one near midnight in negative-UTC-offset zones)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseFile(text) {
  const rows = d3.csvParseRows(text);
  const header = rows[1];
  header.forEach((h, i) => COL_INDEX[h] = i);
  const data = rows.slice(4).filter(r => r.length > 1 && r[0]);
  const num = v => { const f = parseFloat(v); return (v === undefined || v === "NAN" || isNaN(f)) ? null : f; };
  return data.map(r => {
    // raw timestamp string is UTC (no offset in source); parse as UTC via "Z", then convert to Central
    const rec = { timestamp: toChicago(new Date(r[0].replace(" ", "T") + "Z")) };
    WT_KEYS.forEach((k, i) => rec[k] = num(r[COL_INDEX[`watertemp(${i + 1})`]]));
    for (const k of ["airTL", "rhL", "wsL", "wdL", "IRTL", "pco2ppm_Avg", "PAR_above_Avg",
      "PAR_below_Avg", "pco2volt_Avg", "waterT", "spCond", "pH", "do_raw",
      "do_sat", "chlorYSI", "phycoYSI", "turbid", "fdom", "battYSI"]) {
      rec[k] = num(r[COL_INDEX[k]]);
    }
    return rec;
  });
}

async function loadDay(d) {
  const key = dateStr(d);

  // Layer 1: In-Memory Check (Handles instant lookup & active in-flight requests)
  if (state.cache.has(key)) {
    return state.cache.get(key);
  }

  // Store the active Promise immediately to prevent duplicate requests if called concurrently
  const loadPromise = (async () => {
    try {
      const url = `${FILE_PREFIX}${key}.csv`;
      const webCache = await caches.open("buoy-data-cache");

      // Layer 2: Persistent Browser Cache Check
      let resp = await webCache.match(url);
      if (!resp) {
        resp = await fetch(url);
        if (resp.ok) {
          // Store a copy in the browser cache for future reloads
          webCache.put(url, resp.clone());
        }
      }

      if (!resp || !resp.ok) {
        return "missing";
      }

      const text = await resp.text();
      return parseFile(text);
    } catch (e) {
      return "missing";
    }
  })();

  // Track the pending promise in memory
  state.cache.set(key, loadPromise);

  // Once resolved, replace the promise with the final parsed result
  const result = await loadPromise;
  state.cache.set(key, result);
  return result;
}

// ensure every day in [start,end] is loaded (or known missing); returns merged records
async function loadRange(start, end) {
  const days = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    d <= end; d.setDate(d.getDate() + 1)) {
    if (d < EARLIEST) continue;
    days.push(new Date(d));
  }
  document.getElementById("loadStatus").textContent = "loading\u2026";
  await Promise.all(days.map(loadDay));
  document.getElementById("loadStatus").textContent = "";

  // Identify and drop days that follow a 3 day gap - mostly intended for start of year (bad data after deployment) 
  let missingStreak = 0;
  for (const d of days) {
    const key = dateStr(d);
    const v = state.cache.get(key);
    if (!v || v === "missing") {
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
    if (v && v !== "missing" && !state.droppedDays.has(key)) recs = recs.concat(v);
  }
  recs.sort((a, b) => a.timestamp - b.timestamp);
  return recs;
}

// find the most recent day with data, probing backward from today, to seed default range
async function findLatestAvailable() {
  let d = new Date(today);
  for (let i = 0; i < 400 && d >= EARLIEST; i++) {
    const v = await loadDay(d);
    if (v !== "missing" && v.length) return new Date(d);
    d.setDate(d.getDate() - 1);
  }
  return new Date(today);
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
  return "weekly averages";
}

// generic binning; circularKeys get vector-averaged (degrees)
function binRecords(records, minutes, circularKeys = new Set()) {
  const binMs = minutes * 60000;
  const bins = new Map();
  for (const r of records) {
    const t = r.timestamp.getTime();
    const bStart = Math.floor(t / binMs) * binMs;
    let b = bins.get(bStart);
    if (!b) { b = { time: new Date(bStart), sum: {}, sin: {}, cos: {}, count: {} }; bins.set(bStart, b); }
    for (const k in r) {
      if (k === "timestamp") continue;
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

/* ---------- Rendering ---------- */

const chartsEl = d3.select("#charts");
const tooltip = d3.select("body").append("div").attr("class", "tooltip").style("display", "none");

function fmtDate(d) { return d3.timeFormat("%Y-%m-%d %H:%M")(d); }

/* ---------- Helper to create SVG with clipPath ---------- */

function makeSvg(container, height) {
  const width = container.node().clientWidth || 700;
  const svg = container.append("svg")
    .attr("class", "chart")
    .attr("viewBox", `0 0 ${width} ${height}`);

  const clipId = "clip-" + Math.random().toString(36).substring(2, 9);
  svg.append("defs").append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("x", MARGIN.left)
    .attr("y", MARGIN.top)
    .attr("width", Math.max(0, width - MARGIN.left - MARGIN.right))
    .attr("height", Math.max(0, height - MARGIN.top - MARGIN.bottom));

  return { svg, width, height, clipId };
}

const MARGIN = { top: 8, right: 16, bottom: 22, left: 46 };

function xScaleFor(width) {
  return d3.scaleTime().domain(state.domain).range([MARGIN.left, width - MARGIN.right]);
}

function panel(group) {
  const div = chartsEl.append("div").attr("class", "chart-panel").attr("id", `panel-${group.key}`);
  const top = div.append("div").attr("class", "chart-title-row");
  const titleGroup = top.append("div").attr("class", "chart-title-group").style("display", "flex").style("align-items", "baseline").style("gap", "8px");
  titleGroup.append("div").attr("class", "chart-title").text(group.label);
  return div;
}

/* ---------- Compass Helper ---------- */

function getCompassDirection(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const val = Math.floor((deg / 22.5) + 0.5);
  return dirs[val % 16];
}

/* ---------- Depth Temperature Interpolator ---------- */

function interpolateTempAtDepth(rec, targetDepth) {
  let lowerDepth = null, lowerTemp = null;
  let upperDepth = null, upperTemp = null;

  for (let i = 0; i < DEPTHS.length; i++) {
    const dep = DEPTHS[i];
    const val = rec[WT_KEYS[i]];
    if (val == null) continue;

    if (dep <= targetDepth) {
      lowerDepth = dep;
      lowerTemp = val;
    }
    if (dep >= targetDepth && upperDepth == null) {
      upperDepth = dep;
      upperTemp = val;
      break;
    }
  }

  if (lowerTemp != null && upperTemp != null) {
    if (lowerDepth === upperDepth) return lowerTemp;
    const frac = (targetDepth - lowerDepth) / (upperDepth - lowerDepth);
    return lowerTemp + frac * (upperTemp - lowerTemp);
  }
  if (lowerTemp != null) return lowerTemp;
  if (upperTemp != null) return upperTemp;
  return null;
}

/* ---------- Interactive Updates & Rendering Helper ---------- */

function updateAllCharts() {
  if (!state.domain) return;
  document.getElementById("startDate").value = dateStr(state.domain[0]);
  document.getElementById("endDate").value = dateStr(state.domain[1]);
  chartsEl.selectAll(".chart-panel").each(function () {
    if (this._updateX) this._updateX();
  });
}

let renderDebounceTimer = null;
function scheduleRender(delay = 150) {
  if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
  renderDebounceTimer = setTimeout(() => {
    render();
  }, delay);
}

function drawAxes(svg, x, y, width, height) {
  svg.append("g").attr("class", "axis axis-bottom")
    .attr("transform", `translate(0,${height - MARGIN.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.min(8, width / 90)));
  svg.append("g").attr("class", "axis axis-left")
    .attr("transform", `translate(${MARGIN.left},0)`)
    .call(d3.axisLeft(y).ticks(5));
}

function attachInteractions(svg, panelData, x, width, height, seriesInfo) {
  const guide = svg.append("line").attr("class", "hover-line")
    .attr("y1", MARGIN.top).attr("y2", height - MARGIN.bottom).style("display", "none");

  const overlay = svg.append("rect").attr("class", "interaction-overlay")
    .attr("x", MARGIN.left).attr("y", MARGIN.top)
    .attr("width", width - MARGIN.left - MARGIN.right)
    .attr("height", height - MARGIN.top - MARGIN.bottom)
    .attr("fill", "transparent")
    .style("cursor", "grab")
    .style("touch-action", "none");

  const activePointers = new Map();
  let isDragging = false;
  let startX = 0;
  let startDomain = null;
  let initialPinchDist = 0;
  let initialPinchCenter = 0;

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
      guide.style("display", "none");
      tooltip.style("display", "none");
      return;
    }
    const date = x.invert(pointerX);
    const bisect = d3.bisector(d => d.time).left;
    const i = bisect(panelData, date);
    const d = panelData[Math.max(0, Math.min(panelData.length - 1, i))];
    if (!d) return;

    guide.attr("x1", x(d.time)).attr("x2", x(d.time)).style("display", null);
    let html = `<b>${fmtDate(d.time)}</b><br>`;
    for (const s of seriesInfo) {
      const v = d[s.key];
      let valStr = "\u2013";
      if (v != null) {
        valStr = s.formatter ? s.formatter(v, d) : v.toFixed(2);
      }
      html += `<span style="color:${s.color}">\u25cf</span> ${s.label}: ${valStr}<br>`;
    }
    tooltip.style("display", null).html(html)
      .style("left", (pageX + 12) + "px")
      .style("top", (pageY - 20) + "px");
  }

  overlay
    .on("pointerdown", (event) => {
      overlay.node().setPointerCapture(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size === 1) {
        isDragging = false;
        startX = event.clientX;
        startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
      } else if (activePointers.size === 2) {
        isDragging = true;
        initialPinchDist = getPointerDistance();
        initialPinchCenter = getPointerCenter();
        startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
        guide.style("display", "none");
        tooltip.style("display", "none");
      }
    })
    .on("pointermove", (event) => {
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      const [mx] = d3.pointer(event);

      // Mobile 2-finger pinch zoom
      if (activePointers.size === 2 && startDomain && initialPinchDist > 0) {
        guide.style("display", "none");
        tooltip.style("display", "none");

        const currentDist = getPointerDistance();
        if (currentDist <= 0) return;

        const factor = initialPinchDist / currentDist;
        const span = startDomain[1] - startDomain[0];
        let newSpan = Math.max(span * factor, 1000 * 60 * 60 * 6);
        newSpan = Math.min(newSpan, today - EARLIEST);

        const xBase = xScaleFor(width);
        const focalDate = xBase.invert(initialPinchCenter);
        const ratio = (focalDate - startDomain[0]) / span;

        let newStart = new Date(focalDate.getTime() - ratio * newSpan);
        let newEnd = new Date(focalDate.getTime() + (1 - ratio) * newSpan);

        if (newStart < EARLIEST) {
          newEnd = new Date(newEnd.getTime() + (EARLIEST - newStart));
          newStart = new Date(EARLIEST);
        }
        if (newEnd > today) {
          newStart = new Date(newStart.getTime() - (newEnd - today));
          newEnd = new Date(today);
        }

        state.domain = [newStart, newEnd];
        updateAllCharts();
        scheduleRender();
        return;
      }

      // Click and drag (Pan)
      if (activePointers.size === 1 && startDomain) {
        const dx = event.clientX - startX;
        if (Math.abs(dx) > 3) {
          isDragging = true;
          overlay.style("cursor", "grabbing");
          guide.style("display", "none");
          tooltip.style("display", "none");
        }

        if (isDragging) {
          const plotWidth = width - MARGIN.left - MARGIN.right;
          const msPerPx = (startDomain[1] - startDomain[0]) / plotWidth;
          const dt = dx * msPerPx;

          let newStart = new Date(startDomain[0].getTime() - dt);
          let newEnd = new Date(startDomain[1].getTime() - dt);

          const span = startDomain[1] - startDomain[0];
          if (newStart < EARLIEST) {
            newStart = new Date(EARLIEST);
            newEnd = new Date(EARLIEST.getTime() + span);
          }
          if (newEnd > today) {
            newEnd = new Date(today);
            newStart = new Date(today.getTime() - span);
          }

          state.domain = [newStart, newEnd];
          updateAllCharts();
          scheduleRender();
          return;
        }
      }

      if (!isDragging && activePointers.size === 0) {
        updateHover(mx, event.pageX, event.pageY);
      }
    })
    .on("pointerup pointercancel", (event) => {
      if (activePointers.has(event.pointerId)) {
        try { overlay.node().releasePointerCapture(event.pointerId); } catch (e) { }
        activePointers.delete(event.pointerId);
      }
      if (activePointers.size === 0) {
        isDragging = false;
        overlay.style("cursor", "grab");
      }
    })
    .on("mouseleave", () => {
      if (!isDragging && activePointers.size === 0) {
        guide.style("display", "none");
        tooltip.style("display", "none");
      }
    });
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
  div.select(".chart-title-group").append("div").attr("class", "chart-sub").text(`${group.unit || ""}`.trim());

  const plotArea = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const line = d3.line().defined(d => d[group.vkey] != null)
    .x(d => x(d.time)).y(d => y(d[group.vkey]));
  plotArea.append("path").datum(binned).attr("class", "legend-line")
    .attr("stroke", "#14708c").attr("d", line);

  div.node()._updateX = () => {
    const xNew = xScaleFor(width);
    svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
    const l = d3.line().defined(d => d[group.vkey] != null).x(d => xNew(d.time)).y(d => y(d[group.vkey]));
    plotArea.select("path.legend-line").attr("d", l);
  };

  attachInteractions(svg, binned, x, width, height, [{ key: group.vkey, label: group.label, color: "#14708c" }]);
}

function renderProfile(group, records, binned) {
  const div = panel(group);
  const top = div.select(".chart-title-row");
  const ut = top.append("div").attr("class", "unit-toggle");
  [
    { id: "lines", label: "Lines" },
    { id: "heatmap", label: "Heatmap" }
  ].forEach(m => {
    ut.append("button")
      .text(m.label)
      .classed("active", state.wtProfileMode === m.id)
      .on("click", () => { state.wtProfileMode = m.id; render(); });
  });

  if (state.wtProfileMode === "lines") {
    renderProfileLines(div, group, records, binned);
  } else {
    renderProfileHeatmap(div, group, records, binned);
  }
}

function renderProfileLines(div, group, records, binned) {
  const dt = div.append("div").attr("class", "depth-toggles");
  const color = d3.scaleLinear()
    .domain([0, 20])
    .range(["#72bcd4", "#0b3d4c"]);

  DEPTHS.forEach((depth, i) => {
    const key = WT_KEYS[i];
    const on = state.depthOn.has(key);
    dt.append("span")
      .attr("class", "depth-swatch" + (on ? "" : " off"))
      .style("background", color(depth))
      .text(`${depth}m`)
      .on("click", function () {
        if (state.depthOn.has(key)) state.depthOn.delete(key); else state.depthOn.add(key);
        render();
      });
  });

  const height = 220;
  const { svg, width, clipId } = makeSvg(div, height);
  const x = xScaleFor(width);
  const activeKeys = WT_KEYS.filter(k => state.depthOn.has(k));
  let allVals = [];
  binned.forEach(d => activeKeys.forEach(k => { if (d[k] != null) allVals.push(d[k]); }));
  const y = d3.scaleLinear().domain(allVals.length ? [d3.min(allVals), d3.max(allVals)] : [0, 30]).nice()
    .range([height - MARGIN.bottom, MARGIN.top]);
  drawAxes(svg, x, y, width, height);
  div.select(".chart-title-group").append("div").attr("class", "chart-sub").text("\u00b0C \u2014 color = depth (light blue = shallow, deep blue = deep)");

  const plotArea = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const seriesInfo = [];
  activeKeys.forEach((k, idx) => {
    const depth = DEPTHS[WT_KEYS.indexOf(k)];
    const c = color(depth);
    seriesInfo.push({ key: k, label: `${depth}m`, color: c });
    const line = d3.line().defined(d => d[k] != null).x(d => x(d.time)).y(d => y(d[k]));
    plotArea.append("path").datum(binned).attr("class", "legend-line").attr("stroke", c).attr("d", line);
  });

  div.node()._updateX = () => {
    const xNew = xScaleFor(width);
    svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
    activeKeys.forEach((k, idx) => {
      const l = d3.line().defined(d => d[k] != null).x(d => xNew(d.time)).y(d => y(d[k]));
      plotArea.selectAll("path.legend-line").filter((_, i) => i === idx).attr("d", l);
    });
  };

  attachInteractions(svg, binned, x, width, height, seriesInfo);
}

function renderProfileHeatmap(div, group, records, binned) {
  let allVals = [];
  binned.forEach(d => {
    WT_KEYS.forEach(k => { if (d[k] != null) allVals.push(d[k]); });
  });
  const minTemp = allVals.length ? d3.min(allVals) : 0;
  const maxTemp = allVals.length ? d3.max(allVals) : 30;

  // Temperature gradient legend
  const legendDiv = div.append("div").attr("class", "heatmap-legend")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "8px")
    .style("margin", "4px 0 6px")
    .style("font-size", "0.72rem")
    .style("color", "var(--muted)");

  legendDiv.append("span").text(`${minTemp.toFixed(1)}\u00b0C`);

  legendDiv.append("div")
    .style("height", "10px")
    .style("width", "140px")
    .style("border-radius", "3px")
    .style("background", "linear-gradient(to right, #14708c, #d97a3c)");

  legendDiv.append("span").text(`${maxTemp.toFixed(1)}\u00b0C`);

  const height = 220;
  const wrapper = div.append("div").style("position", "relative");

  const colorScale = d3.scaleLinear()
    .domain([minTemp, maxTemp])
    .range(["#14708c", "#d97a3c"])
    .interpolate(d3.interpolateRgb);

  const { svg, width } = makeSvg(wrapper, height);

  // Position SVG above canvas so the overlay captures pointer events
  svg
    .style("position", "relative")
    .style("z-index", "1");

  // Position canvas behind SVG and pass pointer events through
  const canvas = wrapper.insert("canvas", "svg")
    .style("position", "absolute")
    .style("left", "0")
    .style("top", "0")
    .style("width", `${width}px`)
    .style("height", `${height}px`)
    .style("pointer-events", "none")
    .attr("width", width)
    .attr("height", height);

  const ctx = canvas.node().getContext("2d");
  const x = xScaleFor(width);

  const y = d3.scaleLinear()
    .domain([0, 20])
    .range([MARGIN.top, height - MARGIN.bottom]);

  svg.append("g").attr("class", "axis axis-bottom")
    .attr("transform", `translate(0,${height - MARGIN.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.min(8, width / 90)));

  svg.append("g").attr("class", "axis axis-left")
    .attr("transform", `translate(${MARGIN.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}m`));

  div.select(".chart-title-group").append("div").attr("class", "chart-sub")
    .text("Temperatures are interpolated between sensors.");

  const T = binned.length;
  const D = 100;
  if (T > 0) {
    const offCanvas = document.createElement("canvas");
    offCanvas.width = T;
    offCanvas.height = D;
    const offCtx = offCanvas.getContext("2d");
    const imgData = offCtx.createImageData(T, D);

    for (let row = 0; row < D; row++) {
      const targetDepth = (row / (D - 1)) * 20;
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
      ctx.beginPath();
      ctx.rect(MARGIN.left, MARGIN.top, plotWidth, plotHeight);
      ctx.clip();

      for (let i = 0; i < T; i++) {
        const t0 = binned[i].time;
        const x0 = xScale(t0);
        let x1 = (i < T - 1) ? xScale(binned[i + 1].time) : x0 + (x0 - xScale(binned[Math.max(0, i - 1)].time));
        if (x1 <= x0) x1 = x0 + 1;

        if (x1 < MARGIN.left || x0 > width - MARGIN.right) continue;

        const sliceW = Math.max(0.5, x1 - x0 + 0.5);
        ctx.drawImage(offCanvas, i, 0, 1, D, x0, MARGIN.top, sliceW, plotHeight);
      }
      ctx.restore();
    };

    drawHeatmap(x);

    div.node()._updateX = () => {
      const xNew = xScaleFor(width);
      svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
      drawHeatmap(xNew);
    };
  }

  attachHeatmapInteractions(svg, binned, x, y, width, height);
}

function attachHeatmapInteractions(svg, panelData, x, y, width, height) {
  const vLine = svg.append("line").attr("class", "hover-line")
    .attr("y1", MARGIN.top).attr("y2", height - MARGIN.bottom).style("display", "none")
    .style("pointer-events", "none");
  const hLine = svg.append("line").attr("class", "hover-line")
    .attr("x1", MARGIN.left).attr("x2", width - MARGIN.right).style("display", "none")
    .style("pointer-events", "none");

  const overlay = svg.append("rect").attr("class", "interaction-overlay")
    .attr("x", MARGIN.left).attr("y", MARGIN.top)
    .attr("width", width - MARGIN.left - MARGIN.right)
    .attr("height", height - MARGIN.top - MARGIN.bottom)
    .attr("fill", "transparent")
    .style("cursor", "grab")
    .style("touch-action", "none");

  const activePointers = new Map();
  let isDragging = false;
  let startX = 0;
  let startDomain = null;

  function updateHover(pointerX, pointerY, pageX, pageY) {
    if (isDragging || activePointers.size > 0) {
      vLine.style("display", "none");
      hLine.style("display", "none");
      tooltip.style("display", "none");
      return;
    }

    const date = x.invert(pointerX);
    const bisect = d3.bisector(d => d.time).left;
    const i = bisect(panelData, date);
    const d = panelData[Math.max(0, Math.min(panelData.length - 1, i))];
    if (!d) return;

    const targetDepth = Math.max(0, Math.min(20, y.invert(pointerY)));
    const temp = interpolateTempAtDepth(d, targetDepth);

    vLine.attr("x1", x(d.time)).attr("x2", x(d.time)).style("display", null);
    hLine.attr("y1", pointerY).attr("y2", pointerY).style("display", null);

    let html = `<b>${fmtDate(d.time)}</b><br>`;
    html += `Depth: ${targetDepth.toFixed(1)} m<br>`;
    html += `Temp: ${temp != null ? temp.toFixed(2) + " \u00b0C" : "\u2013"}`;

    tooltip.style("display", null).html(html)
      .style("left", (pageX + 12) + "px")
      .style("top", (pageY - 20) + "px");
  }

  overlay
    .on("pointerdown", (event) => {
      overlay.node().setPointerCapture(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.size === 1) {
        isDragging = false;
        startX = event.clientX;
        startDomain = state.domain ? [new Date(state.domain[0]), new Date(state.domain[1])] : null;
      }
    })
    .on("pointermove", (event) => {
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }

      const [mx, my] = d3.pointer(event);

      if (activePointers.size === 1 && startDomain) {
        const dx = event.clientX - startX;
        if (Math.abs(dx) > 3) {
          isDragging = true;
          overlay.style("cursor", "grabbing");
          vLine.style("display", "none");
          hLine.style("display", "none");
          tooltip.style("display", "none");
        }

        if (isDragging) {
          const plotWidth = width - MARGIN.left - MARGIN.right;
          const msPerPx = (startDomain[1] - startDomain[0]) / plotWidth;
          const dt = dx * msPerPx;

          let newStart = new Date(startDomain[0].getTime() - dt);
          let newEnd = new Date(startDomain[1].getTime() - dt);
          const span = startDomain[1] - startDomain[0];
          if (newStart < EARLIEST) {
            newStart = new Date(EARLIEST);
            newEnd = new Date(EARLIEST.getTime() + span);
          }
          if (newEnd > today) {
            newEnd = new Date(today);
            newStart = new Date(today.getTime() - span);
          }

          state.domain = [newStart, newEnd];
          updateAllCharts();
          scheduleRender();
          return;
        }
      }

      if (!isDragging && activePointers.size === 0) {
        updateHover(mx, my, event.pageX, event.pageY);
      }
    })
    .on("pointerup pointercancel", (event) => {
      if (activePointers.has(event.pointerId)) {
        try { overlay.node().releasePointerCapture(event.pointerId); } catch (e) { }
        activePointers.delete(event.pointerId);
      }
      if (activePointers.size === 0) {
        isDragging = false;
        overlay.style("cursor", "grab");
      }
    })
    .on("mouseleave", () => {
      if (!isDragging && activePointers.size === 0) {
        vLine.style("display", "none");
        hLine.style("display", "none");
        tooltip.style("display", "none");
      }
    });
}

function renderDO(group, records, binned) {
  const div = panel(group);
  const top = div.select(".chart-title-row");
  const ut = top.append("div").attr("class", "unit-toggle");
  ["sat", "raw"].forEach(u => {
    ut.append("button")
      .text(u === "sat" ? "%" : "mg/L")
      .classed("active", state.doUnit === u)
      .on("click", () => { state.doUnit = u; render(); });
  });
  const key = state.doUnit === "sat" ? "do_sat" : "do_raw";
  const unit = state.doUnit === "sat" ? "%" : "mg/L";
  const height = 160;
  const { svg, width, clipId } = makeSvg(div, height);
  const x = xScaleFor(width);
  const vals = binned.map(d => d[key]).filter(v => v != null);
  const y = d3.scaleLinear().domain(vals.length ? [d3.min(vals), d3.max(vals)] : [0, 1]).nice()
    .range([height - MARGIN.bottom, MARGIN.top]);
  drawAxes(svg, x, y, width, height);
  div.select(".chart-title-group").append("div").attr("class", "chart-sub").text(unit);

  const plotArea = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const line = d3.line().defined(d => d[key] != null).x(d => x(d.time)).y(d => y(d[key]));
  plotArea.append("path").datum(binned).attr("class", "legend-line").attr("stroke", "#0b3d4c").attr("d", line);

  div.node()._updateX = () => {
    const xNew = xScaleFor(width);
    svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
    const l = d3.line().defined(d => d[key] != null).x(d => xNew(d.time)).y(d => y(d[key]));
    plotArea.select("path.legend-line").attr("d", l);
  };

  attachInteractions(svg, binned, x, width, height, [{ key, label: `DO (${unit})`, color: "#0b3d4c" }]);
}

function renderPAR(group, records, binned) {
  const div = panel(group);
  const height = 160;
  const { svg, width, clipId } = makeSvg(div, height);
  const x = xScaleFor(width);
  const keys = [{ k: "PAR_above_Avg", label: "Above water", color: "#d97a3c" },
  { k: "PAR_below_Avg", label: "Below water", color: "#14708c" }];
  let allVals = [];
  binned.forEach(d => keys.forEach(s => { if (d[s.k] != null) allVals.push(d[s.k]); }));
  const y = d3.scaleLinear().domain(allVals.length ? [0, d3.max(allVals)] : [0, 1]).nice()
    .range([height - MARGIN.bottom, MARGIN.top]);
  drawAxes(svg, x, y, width, height);
  div.select(".chart-title-group").append("div").attr("class", "chart-sub").text("\u00b5mol m\u207b\u00b2 s\u207b\u00b9  \u2014 orange = above water, blue = below water");

  const plotArea = svg.append("g").attr("clip-path", `url(#${clipId})`);
  keys.forEach(s => {
    const line = d3.line().defined(d => d[s.k] != null).x(d => x(d.time)).y(d => y(d[s.k]));
    plotArea.append("path").datum(binned).attr("class", "legend-line").attr("stroke", s.color).attr("d", line);
  });

  div.node()._updateX = () => {
    const xNew = xScaleFor(width);
    svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
    keys.forEach((s, idx) => {
      const l = d3.line().defined(d => d[s.k] != null).x(d => xNew(d.time)).y(d => y(d[s.k]));
      plotArea.selectAll("path.legend-line").filter((_, i) => i === idx).attr("d", l);
    });
  };

  attachInteractions(svg, binned, x, width, height, keys.map(s => ({ key: s.k, label: s.label, color: s.color })));
}

function renderWind(group, records, binned, mins) {
  const div = panel(group);
  const height = 170;
  const { svg, width, clipId } = makeSvg(div, height);
  const x = xScaleFor(width);
  const vals = binned.map(d => d.wsL).filter(v => v != null);
  const y = d3.scaleLinear().domain([0, vals.length ? d3.max(vals) : 1]).nice()
    .range([height - MARGIN.bottom, MARGIN.top]);
  drawAxes(svg, x, y, width, height);

  // Calculate subsampling step and arrow spacing interval
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const maxArrows = Math.max(1, Math.floor(plotWidth / 22));
  const step = Math.max(1, Math.ceil(binned.length / maxArrows));
  // const arrowPts = binned.filter((d, i) => i % step === 0 && d.wsL != null && d.wdL != null);
  // Calculate vector averages for each step block of arrows
  const arrowPts = [];
  for (let i = 0; i < binned.length; i += step) {
    const chunk = binned.slice(i, i + step).filter(d => d.wsL != null && d.wdL != null);
    if (!chunk.length) continue;

    let sinSum = 0, cosSum = 0, speedSum = 0;
    chunk.forEach(d => {
      const rad = d.wdL * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      speedSum += d.wsL;
    });

    let avgWd = Math.atan2(sinSum / chunk.length, cosSum / chunk.length) * 180 / Math.PI;
    if (avgWd < 0) avgWd += 360;

    arrowPts.push({
      time: chunk[Math.floor(chunk.length / 2)].time, // center time of block
      wsL: speedSum / chunk.length,
      wdL: avgWd
    });
  }

  const arrowIntervalMins = step * mins;
  function formatInterval(m) {
    if (m < 60) return `${m} min`;
    if (m < 1440) {
      const h = m / 60;
      return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
    }
    const d = m / 1440;
    return `${Number.isInteger(d) ? d : d.toFixed(1)} day`;
  }

  const arrowSpacingText = step > 1 ? ` (${formatInterval(arrowIntervalMins)} average)` : "";

  // Subtitle showing both data averaging period and arrow sampling spacing
  div.select(".chart-title-group").append("div").attr("class", "chart-sub")
    .text(`m/s \u2014 arrows show direction wind is blowing toward${arrowSpacingText}`);

  const plotArea = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const line = d3.line().defined(d => d.wsL != null).x(d => x(d.time)).y(d => y(d.wsL));
  plotArea.append("path").datum(binned).attr("class", "legend-line").attr("stroke", "#5c7680").attr("d", line);

  plotArea.selectAll(".wind-arrow").data(arrowPts).enter().append("path")
    .attr("class", "wind-arrow")
    .attr("d", "M0,-7 L0,7 M0,-7 L-4,-2 M0,-7 L4,-2")
    .attr("stroke", "#d97a3c").attr("stroke-width", 1.6).attr("fill", "none")
    .attr("transform", d => `translate(${x(d.time)},${y(d.wsL)}) rotate(${(d.wdL + 180) % 360})`);

  div.node()._updateX = () => {
    const xNew = xScaleFor(width);
    svg.select("g.axis-bottom").call(d3.axisBottom(xNew).ticks(Math.min(8, width / 90)));
    const l = d3.line().defined(d => d.wsL != null).x(d => xNew(d.time)).y(d => y(d.wsL));
    plotArea.select("path.legend-line").attr("d", l);
    plotArea.selectAll(".wind-arrow")
      .attr("transform", d => `translate(${xNew(d.time)},${y(d.wsL)}) rotate(${(d.wdL + 180) % 360})`);
  };

  const seriesInfo = [
    { key: "wsL", label: "Wind speed (m/s)", color: "#5c7680" },
    {
      key: "wdL",
      label: "Wind direction (towards)",
      color: "#d97a3c",
      formatter: (v) => {
        const towards = (v + 180) % 360;
        return `${towards.toFixed(0)}\u00b0 (${getCompassDirection(towards)})`;
      }
    }
  ];

  attachInteractions(svg, binned, x, width, height, seriesInfo);
}
/* ---------- Toggles UI ---------- */

function buildToggles() {
  const wrap = document.getElementById("varToggles");
  wrap.innerHTML = "";

  // Individual Variable Buttons
  GROUPS.forEach(g => {
    const isVisible = state.visible.has(g.key);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = g.label;
    btn.classList.toggle("active", isVisible);

    btn.addEventListener("click", () => {
      if (state.visible.has(g.key)) {
        state.visible.delete(g.key);
      } else {
        state.visible.add(g.key);
      }
      render();
    });

    wrap.appendChild(btn);
  });

  // Show / Hide All Button
  const allVisible = GROUPS.every(g => state.visible.has(g.key));
  const toggleAllBtn = document.createElement("button");
  toggleAllBtn.type = "button";
  toggleAllBtn.textContent = allVisible ? "Hide All" : "Show All";
  toggleAllBtn.style.fontWeight = "bold";

  toggleAllBtn.addEventListener("click", () => {
    if (allVisible) {
      state.visible.clear();
    } else {
      GROUPS.forEach(g => state.visible.add(g.key));
    }
    render();
  });
  wrap.appendChild(toggleAllBtn);
}

/* ---------- Main render ---------- */

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const [start, end] = state.domain;
  document.getElementById("startDate").value = dateStr(start);
  document.getElementById("endDate").value = dateStr(end);

  const records = await loadRange(start, end);
  if (token !== renderToken) return; // a newer render superseded this one

  // detect all-NaN columns among currently loaded data, to inform toggle labels
  Object.keys(SIMPLE_VARS).forEach(k => {
    const anyVal = records.some(r => r[k] != null);
    if (!anyVal && records.length) state.allNaCols.add(k); else state.allNaCols.delete(k);
  });

  const spanDays = (end - start) / 86400000;
  const mins = binMinutesFor(spanDays);
  document.getElementById("binNote").textContent = `Showing ${binLabel(mins)}`;

  const binned = binRecords(records, mins, new Set(["wdL"]));

  buildToggles();

  // 1. Lock height and save scroll position before clearing layout
  const savedScrollY = window.scrollY;
  const currentHeight = chartsEl.node().offsetHeight;
  if (currentHeight > 0) {
    chartsEl.style("min-height", `${currentHeight}px`);
  }

  chartsEl.html("");
  GROUPS.forEach(g => {
    if (!state.visible.has(g.key)) return;
    if (g.kind === "simple") renderSimple(g, records, binned);
    else if (g.kind === "profile") renderProfile(g, records, binned);
    else if (g.kind === "do") renderDO(g, records, binned);
    else if (g.kind === "par") renderPAR(g, records, binned);
    else if (g.kind === "wind") renderWind(g, records, binned, mins);
  });

  // 2. Restore scroll position and unlock height
  window.scrollTo(0, savedScrollY);
  chartsEl.style("min-height", null);
}

function setDomain(start, end, doRender) {
  if (start < EARLIEST) start = new Date(EARLIEST);
  if (end > today) end = new Date(today);
  state.domain = [start, end];
  if (doRender) render();
}

/* ---------- Header controls ---------- */

function parseLocalDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
document.getElementById("startDate").addEventListener("change", (e) => {
  const [, end] = state.domain;
  setDomain(parseLocalDate(e.target.value), end, true);
});
document.getElementById("endDate").addEventListener("change", (e) => {
  const [start] = state.domain;
  setDomain(start, parseLocalDate(e.target.value), true);
});
document.querySelectorAll(".presets button").forEach(btn => {
  btn.addEventListener("click", () => {
    const days = btn.dataset.days;
    const end = new Date(today);
    const start = days === "all" ? new Date(EARLIEST) : new Date(end.getTime() - days * 86400000);
    start.setHours(0, 0, 0, 0); // Normalize start time to midnight
    setDomain(start, end, true);
  });
});

window.addEventListener("resize", () => render());

/* ---------- Init ---------- */

(async function init() {
  const latest = await findLatestAvailable();
  const start = new Date(latest.getTime() - 7 * 86400000);
  start.setHours(0, 0, 0, 0);
  setDomain(start, latest, true);
})();

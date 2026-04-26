/* ═══════════════════════════════════════════════════
   CardioWatch AI — script.js
   ThingSpeak integration + Charts + AI Report Engine
═══════════════════════════════════════════════════ */

// ─── CONFIG (editable via Settings modal) ─────────────────────────────────
let CONFIG = {
  channelId : '',
  readApiKey: '',
  hrField   : 'field1',
  spo2Field : 'field2',
  tempField : 'field3',
  demoMode  : true,
  refresh   : 15000,
  patient   : { name:'Demo Patient', id:'PT-2024-001', diag:'Post-Cardiac Surgery Recovery' }
};

// ─── CLINICAL RANGES ──────────────────────────────────────────────────────
const RANGES = {
  hr  : { low:60, high:100, unit:'BPM',  label:'Heart Rate' },
  spo2: { low:95, high:100, unit:'%',    label:'SpO₂ Saturation' },
  temp: { low:36.1, high:37.2, unit:'°C', label:'Temperature' }
};

// ─── STATE ────────────────────────────────────────────────────────────────
let state = {
  hrArr   : [], spo2Arr  : [], tempArr : [],
  labels  : [],
  alerts  : [],
  latestHr: null, latestSpo2: null, latestTemp: null,
  refreshTimer: null
};

// ─── CHART INSTANCES ──────────────────────────────────────────────────────
let charts = {};

// ───────────────────────────────────────────────────────────────────────────
//  INIT
// ───────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  applyPatientInfo();
  initCharts();
  fetchData();
  startRefresh();
  loadSettings();
});

// ─── DEMO DATA GENERATOR ─────────────────────────────────────────────────
function generateDemoData(points = 30) {
  const feeds = [];
  const now = new Date();
  for (let i = points - 1; i >= 0; i--) {
    const t = new Date(now - i * 15000);
    const hr   = +(72 + (Math.random() - 0.5) * 20).toFixed(1);
    const spo2 = +(97 + (Math.random() - 0.5) * 4).toFixed(1);
    const temp = +(36.8 + (Math.random() - 0.5) * 1.2).toFixed(2);
    feeds.push({
      created_at: t.toISOString(),
      field1: '' + hr,
      field2: '' + spo2,
      field3: '' + temp
    });
  }
  return feeds;
}

// ─── THINGSPEAK FETCH ────────────────────────────────────────────────────
async function fetchData() {
  try {
    let feeds;
    if (CONFIG.demoMode || !CONFIG.channelId) {
      feeds = generateDemoData(40);
    } else {
      const url = `https://api.thingspeak.com/channels/${CONFIG.channelId}/feeds.json` +
                  `?api_key=${CONFIG.readApiKey}&results=40`;
      const res  = await fetch(url);
      const data = await res.json();
      feeds = data.feeds;
    }
    processFeeds(feeds);
  } catch (e) {
    console.warn('Fetch error, using demo:', e);
    processFeeds(generateDemoData(40));
  }
}

function processFeeds(feeds) {
  const fHr   = CONFIG.hrField;
  const fSpo2 = CONFIG.spo2Field;
  const fTemp = CONFIG.tempField;

  state.hrArr   = feeds.map(f => parseFloat(f[fHr])).filter(v => !isNaN(v));
  state.spo2Arr = feeds.map(f => parseFloat(f[fSpo2])).filter(v => !isNaN(v));
  state.tempArr = feeds.map(f => parseFloat(f[fTemp])).filter(v => !isNaN(v));
  state.labels  = feeds.map(f => {
    const d = new Date(f.created_at);
    return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  });

  state.latestHr   = state.hrArr.at(-1)   ?? null;
  state.latestSpo2 = state.spo2Arr.at(-1) ?? null;
  state.latestTemp = state.tempArr.at(-1) ?? null;

  updateUI();
  updateCharts();
  checkAlerts(state.latestHr, state.latestSpo2, state.latestTemp);
  updateSidebarStats();
  updateLastUpdate();
}

// ─── UI UPDATES ───────────────────────────────────────────────────────────
function updateUI() {
  setVital('hr',   state.latestHr,   state.hrArr,   RANGES.hr);
  setVital('spo2', state.latestSpo2, state.spo2Arr, RANGES.spo2);
  setVital('temp', state.latestTemp, state.tempArr, RANGES.temp);
  updateRecoveryScore();
}

function setVital(key, value, arr, range) {
  if (value === null) return;
  const el = id => document.getElementById(id);
  el(`${key}Value`).textContent = value.toFixed(key === 'temp' ? 1 : 0);

  const { status, cls, trend } = assessVital(value, arr, range);
  el(`${key}Status`).textContent  = status;
  el(`${key}Status`).className    = `stat-status ${cls}`;
  el(`${key}Trend`).textContent   = trend;

  const meta = arr.length ?
    `Avg: ${mean(arr).toFixed(1)}  Min: ${Math.min(...arr).toFixed(1)}  Max: ${Math.max(...arr).toFixed(1)}` : '—';
  el(`${key}Meta`) && (el(`${key}Meta`).textContent = meta);
}

function assessVital(value, arr, range) {
  const trend = trendArrow(arr);
  if (value < range.low * 0.9 || value > range.high * 1.1)
    return { status: `⚠ CRITICAL (${value} ${range.unit})`, cls: 'status-critical', trend };
  if (value < range.low || value > range.high)
    return { status: `⚠ Warning (${value} ${range.unit})`, cls: 'status-warning', trend };
  return { status: `✓ Normal (${value} ${range.unit})`, cls: 'status-normal', trend };
}

function trendArrow(arr) {
  if (arr.length < 4) return '→';
  const recent = arr.slice(-6), old = arr.slice(-12, -6);
  if (!old.length) return '→';
  const d = mean(recent) - mean(old);
  return d >  0.5 ? '↑' : d < -0.5 ? '↓' : '→';
}

function updateRecoveryScore() {
  const score = calcRecoveryScore(state.hrArr, state.spo2Arr, state.tempArr);
  if (score === null) return;

  document.getElementById('scoreValue').textContent = score;
  const status = score >= 80 ? { txt:'Good Recovery ✓', cls:'status-normal' }
               : score >= 60 ? { txt:'Moderate — Monitor', cls:'status-warning' }
               :               { txt:'⚠ Needs Attention', cls:'status-critical' };
  document.getElementById('scoreStatus').textContent = status.txt;
  document.getElementById('scoreStatus').className   = `stat-status ${status.cls}`;
  document.getElementById('sidebarScore').textContent = score + '/100';

  // Ring animation
  const circ = 2 * Math.PI * 24; // 150.8
  const offset = circ - (score / 100) * circ;
  document.getElementById('scoreRingPath').style.strokeDashoffset = offset;
  document.getElementById('scoreRingPath').style.stroke =
    score >= 80 ? '#00e676' : score >= 60 ? '#ffab40' : '#ff5252';
}

// ─── RECOVERY SCORE ALGORITHM ────────────────────────────────────────────
function calcRecoveryScore(hr, spo2, temp) {
  if (!hr.length || !spo2.length || !temp.length) return null;

  // SpO₂ component (45 pts) — safety-critical
  const mSpo2 = mean(spo2);
  const spo2Score = mSpo2 >= 97 ? 45 : mSpo2 >= 95 ? 38 : mSpo2 >= 92 ? 22 : 5;

  // HR component (30 pts)
  const mHr   = mean(hr);
  const hrScore = (mHr >= 60 && mHr <= 100) ? 30
               : (mHr >= 50 && mHr <= 110)  ? 20
               : (mHr >= 40 && mHr <= 120)  ? 10 : 3;

  // Temp component (25 pts)
  const mTemp = mean(temp);
  const tempScore = (mTemp >= 36.1 && mTemp <= 37.2) ? 25
                  : (mTemp >= 35.5 && mTemp <= 38.0) ? 15
                  : (mTemp >= 35.0 && mTemp <= 39.0) ? 8 : 2;

  return Math.min(100, spo2Score + hrScore + tempScore);
}

// ─── ALERT SYSTEM ────────────────────────────────────────────────────────
function checkAlerts(hr, spo2, temp) {
  const newAlerts = [];
  if (hr !== null) {
    if (hr < 50 || hr > 120)
      newAlerts.push({ msg:`Heart Rate CRITICAL: ${hr} BPM`, sev:'CRITICAL', type:'cr' });
    else if (hr < 60 || hr > 100)
      newAlerts.push({ msg:`Heart Rate Warning: ${hr} BPM`, sev:'WARN', type:'warn' });
  }
  if (spo2 !== null) {
    if (spo2 < 90)
      newAlerts.push({ msg:`SpO₂ CRITICAL: ${spo2}% — Hypoxia Risk`, sev:'CRITICAL', type:'cr' });
    else if (spo2 < 95)
      newAlerts.push({ msg:`SpO₂ Low: ${spo2}%`, sev:'WARN', type:'warn' });
  }
  if (temp !== null) {
    if (temp >= 39.0)
      newAlerts.push({ msg:`High Fever: ${temp}°C`, sev:'CRITICAL', type:'cr' });
    else if (temp > 37.5 || temp < 36.0)
      newAlerts.push({ msg:`Temperature abnormal: ${temp}°C`, sev:'WARN', type:'warn' });
  }

  newAlerts.forEach(a => {
    a.time = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    state.alerts.unshift(a);
  });
  if (state.alerts.length > 50) state.alerts = state.alerts.slice(0, 50);

  renderAlerts();
  document.getElementById('alertsToday').textContent =
    state.alerts.filter(a => a.sev === 'CRITICAL').length;
}

function renderAlerts() {
  const list = document.getElementById('alertList');
  if (!state.alerts.length) {
    list.innerHTML = '<div class="no-alerts">No alerts — All vitals within normal range ✅</div>';
    return;
  }
  list.innerHTML = state.alerts.slice(0, 10).map(a => `
    <div class="alert-item ${a.type === 'warn' ? 'alert-warn' : ''}">
      <span class="alert-time">${a.time}</span>
      <span class="alert-msg">${a.msg}</span>
      <span class="alert-sev">${a.sev}</span>
    </div>`).join('');
}

function clearAlerts() { state.alerts = []; renderAlerts(); }

// ─── SIDEBAR STATS ────────────────────────────────────────────────────────
function updateSidebarStats() {
  document.getElementById('readingsToday').textContent = state.hrArr.length;
  document.getElementById('totalPoints').textContent   = state.hrArr.length;
  document.getElementById('sidebarChannel').textContent =
    CONFIG.demoMode ? 'Demo' : (CONFIG.channelId || 'Demo');
}

function updateLastUpdate() {
  document.getElementById('lastUpdate').textContent =
    new Date().toLocaleTimeString();
}

// ─── CHARTS ───────────────────────────────────────────────────────────────
const CHART_OPT = (color, low, high) => ({
  responsive: true, maintainAspectRatio: false,
  animation: { duration: 500 },
  plugins: {
    legend: { display: false },
    tooltip: { mode:'index', intersect:false,
      backgroundColor:'rgba(13,21,38,0.95)', titleColor:'#90a4ae', bodyColor:'#e8eaf6',
      borderColor:'rgba(255,255,255,0.08)', borderWidth:1 }
  },
  scales: {
    x: { ticks:{ color:'#546e7a', font:{size:9}, maxTicksLimit:8 },
         grid:{ color:'rgba(255,255,255,0.04)' } },
    y: { ticks:{ color:'#546e7a', font:{size:10} },
         grid:{ color:'rgba(255,255,255,0.04)' },
         ...(low !== null ? {
           min: low - 5, max: high + 5,
           afterDataLimits(scale) {
             scale.min = Math.min(scale.min, low - 5);
             scale.max = Math.max(scale.max, high + 5);
           }
         } : {})
    }
  }
});

function mkDataset(arr, color) {
  return {
    data: arr, fill: true, tension: 0.4,
    borderColor: color, borderWidth: 2.5,
    pointBackgroundColor: color, pointRadius: 2.5, pointHoverRadius: 5,
    backgroundColor: (ctx) => {
      const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height);
      g.addColorStop(0, color + '40');
      g.addColorStop(1, color + '00');
      return g;
    }
  };
}

function initCharts() {
  charts.hr   = new Chart(document.getElementById('hrChart'),
    { type:'line', data:{ labels:[], datasets:[mkDataset([], '#ff5252')] },
      options: CHART_OPT('#ff5252', 60, 100) });
  charts.spo2 = new Chart(document.getElementById('spo2Chart'),
    { type:'line', data:{ labels:[], datasets:[mkDataset([], '#00b4d8')] },
      options: CHART_OPT('#00b4d8', 90, 100) });
  charts.temp = new Chart(document.getElementById('tempChart'),
    { type:'line', data:{ labels:[], datasets:[mkDataset([], '#ffab40')] },
      options: CHART_OPT('#ffab40', 35, 40) });
}

function updateCharts() {
  const L = state.labels;
  const updateChart = (chart, arr) => {
    chart.data.labels = L;
    chart.data.datasets[0].data = arr;
    chart.update('active');
  };
  updateChart(charts.hr,   state.hrArr);
  updateChart(charts.spo2, state.spo2Arr);
  updateChart(charts.temp, state.tempArr);
}

// ─── LIVE REFRESH ─────────────────────────────────────────────────────────
function startRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(fetchData, CONFIG.refresh);
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────
function openSettings() { openModal('settingsModal'); }

function saveSettings() {
  CONFIG.channelId  = document.getElementById('cfgChannel').value.trim();
  CONFIG.readApiKey = document.getElementById('cfgApiKey').value.trim();
  CONFIG.hrField    = document.getElementById('cfgHrField').value;
  CONFIG.spo2Field  = document.getElementById('cfgSpo2Field').value;
  CONFIG.tempField  = document.getElementById('cfgTempField').value;
  CONFIG.demoMode   = document.getElementById('cfgDemo').checked;
  CONFIG.refresh    = parseInt(document.getElementById('cfgRefresh').value);
  CONFIG.patient.name = document.getElementById('cfgName').value || 'Patient';
  CONFIG.patient.id   = document.getElementById('cfgId').value   || '—';
  CONFIG.patient.diag = document.getElementById('cfgDiag').value || 'Post-Cardiac Surgery Recovery';

  localStorage.setItem('cardioConfig', JSON.stringify(CONFIG));
  applyPatientInfo();
  startRefresh();
  fetchData();
  closeModal('settingsModal');
}

function loadSettings() {
  document.getElementById('cfgChannel').value  = CONFIG.channelId;
  document.getElementById('cfgApiKey').value   = CONFIG.readApiKey;
  document.getElementById('cfgHrField').value  = CONFIG.hrField;
  document.getElementById('cfgSpo2Field').value= CONFIG.spo2Field;
  document.getElementById('cfgTempField').value= CONFIG.tempField;
  document.getElementById('cfgDemo').checked   = CONFIG.demoMode;
  document.getElementById('cfgRefresh').value  = CONFIG.refresh;
  document.getElementById('cfgName').value     = CONFIG.patient.name;
  document.getElementById('cfgId').value       = CONFIG.patient.id;
  document.getElementById('cfgDiag').value     = CONFIG.patient.diag;
}

function loadConfig() {
  const saved = localStorage.getItem('cardioConfig');
  if (saved) { try { CONFIG = {...CONFIG, ...JSON.parse(saved)}; } catch(e){} }
}

function applyPatientInfo() {
  document.getElementById('patientName').textContent = CONFIG.patient.name;
  document.getElementById('patientId').textContent   = 'ID: ' + CONFIG.patient.id;
  document.getElementById('patientDiag').textContent = CONFIG.patient.diag;
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ─══════════════════════════════════════════════════════════════════════════
//  AI REPORT GENERATOR
// ═══════════════════════════════════════════════════════════════════════════
function generateReport() {
  const hr   = state.hrArr;
  const spo2 = state.spo2Arr;
  const temp = state.tempArr;

  if (!hr.length) {
    alert('No data available yet. Please wait for data to load.'); return;
  }

  const analysis = {
    hr  : analyzeParam(hr,   RANGES.hr),
    spo2: analyzeParam(spo2, RANGES.spo2),
    temp: analyzeParam(temp, RANGES.temp),
    score: calcRecoveryScore(hr, spo2, temp),
    alerts: state.alerts.slice(0, 10),
    timestamp: new Date().toLocaleString(),
    dataPoints: hr.length
  };

  const html = buildReportHTML(analysis);
  document.getElementById('reportBody').innerHTML = html;
  openModal('reportModal');
}

// ─── PARAMETER ANALYSIS ──────────────────────────────────────────────────
function analyzeParam(arr, range) {
  if (!arr.length) return null;
  const avg  = mean(arr);
  const mn   = Math.min(...arr);
  const mx   = Math.max(...arr);
  const sd   = stdDev(arr);
  const slope = linearSlope(arr);
  const anomalies = arr.filter(v => v < range.low || v > range.high).length;
  const pctNormal = (((arr.length - anomalies) / arr.length) * 100).toFixed(1);

  let status = 'NORMAL';
  if (avg < range.low * 0.9 || avg > range.high * 1.1) status = 'CRITICAL';
  else if (avg < range.low  || avg > range.high)        status = 'WARNING';

  let trendTxt = 'Stable';
  if (slope >  0.3) trendTxt = 'Increasing';
  if (slope < -0.3) trendTxt = 'Decreasing';

  return { avg, mn, mx, sd, slope, anomalies, pctNormal, status, trend: trendTxt, range };
}

// ─── NATURAL LANGUAGE GENERATION ─────────────────────────────────────────
function narrativeHR(a) {
  const { avg, status, trend, anomalies, pctNormal } = a;
  const base = `The patient's average heart rate over the monitoring period was ${avg.toFixed(1)} BPM, ` +
    `with a minimum of ${a.mn.toFixed(0)} BPM and maximum of ${a.mx.toFixed(0)} BPM. `;
  const statusText =
    status === 'NORMAL'   ? `This is within the normal clinical range of 60–100 BPM, indicating stable cardiac rhythm. ` :
    status === 'WARNING'  ? `This is outside the normal range of 60–100 BPM and warrants clinical review. ` :
                            `This is critically outside the normal range and requires immediate medical attention. `;
  const trendText = trend === 'Stable' ? `The heart rate trend is stable. ` :
    `The heart rate shows a ${trend.toLowerCase()} trend over the monitoring period, which should be monitored closely. `;
  const anomText = anomalies === 0 ? `All readings were within the normal range (100% compliance).` :
    `${anomalies} out of ${a.range ? state.hrArr.length : '?'} readings (${100 - parseFloat(pctNormal)}%) were outside the normal range.`;
  return base + statusText + trendText + anomText;
}

function narrativeSpo2(a) {
  const { avg, mn, status } = a;
  const base = `Average SpO₂ saturation was ${avg.toFixed(1)}% with a minimum recorded value of ${mn.toFixed(1)}%. `;
  const statusText =
    status === 'NORMAL'  ? `Oxygen saturation is maintained at clinically acceptable levels (≥95%), suggesting adequate respiratory function. ` :
    status === 'WARNING' ? `SpO₂ levels are below the recommended threshold of 95%. This may indicate early respiratory compromise and requires monitoring. ` :
                           `SpO₂ levels indicate possible hypoxia. Immediate clinical assessment and oxygen supplementation may be required. `;
  const critMin = mn < 92 ? `A minimum reading of ${mn.toFixed(1)}% was recorded — this level indicates potential hypoxemic risk. ` : '';
  return base + statusText + critMin;
}

function narrativeTemp(a) {
  const { avg, mx, status, trend } = a;
  const base = `Mean body temperature was ${avg.toFixed(2)}°C (normal range: 36.1–37.2°C), with a peak of ${mx.toFixed(2)}°C. `;
  const statusText =
    status === 'NORMAL'   ? `Temperature is within the normal physiological range, with no evidence of fever or hypothermia. ` :
    status === 'WARNING'  ? `Temperature readings are slightly outside the normal range. Low-grade fever or mild hypothermia may be present. ` :
                            `Temperature is critically abnormal. Fever or hypothermia management should be initiated promptly. `;
  const postSurgNote = `In post-surgical cardiac patients, mild temperature elevation (≤38.5°C) in the first 24–48 hours may be physiologically expected. ${trend !== 'Stable' ? `The ${trend.toLowerCase()} trend warrants monitoring.` : ''}`;
  return base + statusText + postSurgNote;
}

function narrativeSummary(score, hr, spo2, temp) {
  const grade = score >= 80 ? 'Good' : score >= 60 ? 'Moderate' : 'Concerning';
  const overview =
    score >= 80 ? `The patient demonstrates a good overall physiological recovery profile. All monitored vital signs are largely within clinically acceptable ranges. Continued monitoring is recommended while gradually reducing intensive monitoring frequency as recovery progresses.` :
    score >= 60 ? `The patient shows a moderate recovery status. Some vital sign parameters require clinical attention. The physician should review the flagged parameters and consider whether clinical intervention or enhanced monitoring is required.` :
                  `The patient's recovery score indicates a concerning physiological status. Multiple vital sign parameters are outside normal ranges. Immediate physician review is strongly recommended.`;
  return `AI Recovery Score: ${score}/100 (${grade}). ${overview}`;
}

function buildRecommendations(hr, spo2, temp) {
  const recs = [];
  if (spo2.status !== 'NORMAL' || spo2.mn < 95)
    recs.push('Review respiratory status and consider SpO₂ improvement measures (positioning, incentive spirometry).');
  if (hr.status !== 'NORMAL')
    recs.push('Cardiology review recommended for persistent heart rate abnormality outside 60–100 BPM range.');
  if (hr.trend === 'Increasing' && hr.avg > 90)
    recs.push('Monitor for signs of pain, anxiety, or fluid deficiency causing elevated heart rate trend.');
  if (temp.status !== 'NORMAL' || temp.mx > 38.0)
    recs.push('Assess for infection or inflammatory response if temperature exceeds 38.0°C persistently.');
  if (hr.anomalies > 5)
    recs.push('Frequent heart rate anomalies detected — consider Holter monitoring or 12-lead ECG.');
  recs.push('Continue current medication regimen as prescribed by the attending cardiologist.');
  recs.push('Maintain daily vital sign monitoring for a minimum of 14 days post-discharge.');
  recs.push('Report any chest pain, breathlessness, or palpitations immediately to the treating physician.');
  return recs;
}

// ─── REPORT HTML BUILDER ─────────────────────────────────────────────────
function buildReportHTML(a) {
  const { hr, spo2, temp, score, alerts, timestamp, dataPoints } = a;
  const recs = buildRecommendations(hr, spo2, temp);
  const scoreFill = score >= 80 ? '#00e676' : score >= 60 ? '#ffab40' : '#ff5252';

  const paramCard = (icon, name, value, unit, analysis, narrative, badgeCls) => `
    <div class="rpt-param">
      <div class="rpt-param-header">
        <div class="rpt-param-name">${icon} ${name}</div>
        <div class="rpt-param-badge ${badgeCls}">${analysis.status}</div>
      </div>
      <div class="rpt-stats-row">
        <div class="rpt-stat-chip"><strong>Avg</strong>  ${analysis.avg.toFixed(1)} ${unit}</div>
        <div class="rpt-stat-chip"><strong>Min</strong>  ${analysis.mn.toFixed(1)} ${unit}</div>
        <div class="rpt-stat-chip"><strong>Max</strong>  ${analysis.mx.toFixed(1)} ${unit}</div>
        <div class="rpt-stat-chip"><strong>StdDev</strong> ±${analysis.sd.toFixed(2)}</div>
        <div class="rpt-stat-chip"><strong>Trend</strong> ${analysis.trend}</div>
        <div class="rpt-stat-chip"><strong>In-Range</strong> ${analysis.pctNormal}%</div>
        <div class="rpt-stat-chip"><strong>Anomalies</strong> ${analysis.anomalies}</div>
      </div>
      <div class="rpt-analysis">${narrative}</div>
    </div>`;

  const statusBadge = s =>
    s === 'NORMAL' ? 'badge-normal' : s === 'WARNING' ? 'badge-warning' : 'badge-critical';

  return `
  <div class="rpt-header">
    <div class="rpt-logo">❤️</div>
    <div class="rpt-title">Cardiac Patient Monitoring Report</div>
    <div class="rpt-subtitle">AI-Generated Clinical Analysis — IoT-Based Cardiac Monitoring System</div>
    <div class="rpt-meta">
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Patient</span>
        <span class="rpt-meta-val">${CONFIG.patient.name}</span>
      </div>
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Patient ID</span>
        <span class="rpt-meta-val">${CONFIG.patient.id}</span>
      </div>
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Diagnosis</span>
        <span class="rpt-meta-val">${CONFIG.patient.diag}</span>
      </div>
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Generated</span>
        <span class="rpt-meta-val">${timestamp}</span>
      </div>
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Data Points</span>
        <span class="rpt-meta-val">${dataPoints} readings</span>
      </div>
      <div class="rpt-meta-item">
        <span class="rpt-meta-label">Channel</span>
        <span class="rpt-meta-val">${CONFIG.demoMode ? 'Demo Mode' : 'ThingSpeak #' + CONFIG.channelId}</span>
      </div>
    </div>
  </div>

  <!-- EXECUTIVE SUMMARY -->
  <div class="rpt-section">
    <div class="rpt-section-title">🤖 AI Executive Summary</div>
    <div class="rpt-score-box">
      <div>
        <div class="rpt-score-num" style="color:${scoreFill}">${score}</div>
        <div class="rpt-score-sub">Recovery Score / 100</div>
      </div>
      <div class="rpt-score-text">${narrativeSummary(score, hr, spo2, temp)}</div>
    </div>
  </div>

  <!-- VITAL SIGN ANALYSIS -->
  <div class="rpt-section">
    <div class="rpt-section-title">📊 Vital Sign Parameter Analysis</div>
    <div class="rpt-params">
      ${paramCard('❤️','Heart Rate', hr.avg, 'BPM', hr, narrativeHR(hr), statusBadge(hr.status))}
      ${paramCard('🫁','SpO₂ Saturation', spo2.avg, '%', spo2, narrativeSpo2(spo2), statusBadge(spo2.status))}
      ${paramCard('🌡','Body Temperature', temp.avg, '°C', temp, narrativeTemp(temp), statusBadge(temp.status))}
    </div>
  </div>

  <!-- ALERTS -->
  <div class="rpt-section">
    <div class="rpt-section-title">⚠️ Alert Summary</div>
    ${alerts.length === 0
      ? '<span class="rpt-no-alerts">✅ No alerts generated during monitoring period.</span>'
      : `<ul class="rpt-alerts-list">${alerts.map(a =>
          `<li class="rpt-alert-item">[${a.time}] ${a.msg} — ${a.sev}</li>`).join('')}
        </ul>`}
  </div>

  <!-- CLINICAL RECOMMENDATIONS -->
  <div class="rpt-section">
    <div class="rpt-section-title">💊 AI Clinical Recommendations</div>
    <ul class="rpt-recs-list">
      ${recs.map(r => `<li>${r}</li>`).join('')}
    </ul>
  </div>

  <!-- DISCLAIMER -->
  <div class="rpt-disclaimer">
    ⚠ <strong>Medical Disclaimer:</strong> This report is generated by an AI-assisted rule-based analysis
    engine based on IoT sensor data from the ThingSpeak cloud platform. It is intended as a clinical
    decision-support tool only and does not replace the judgment of a qualified medical professional.
    All findings and recommendations must be reviewed and validated by the attending cardiologist
    before any clinical action is taken. Sensor readings may be subject to motion artifact or
    calibration variance.
  </div>`;
}

function printReport() {
  window.print();
}

// ─── MATH UTILITIES ───────────────────────────────────────────────────────
function mean(arr) {
  return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
}
function stdDev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(v => (v-m)**2)));
}
function linearSlope(arr) {
  const n = arr.length; if (n < 2) return 0;
  const xs = arr.map((_,i) => i);
  const mx = mean(xs), my = mean(arr);
  const num = xs.reduce((s,x,i) => s + (x-mx)*(arr[i]-my), 0);
  const den = xs.reduce((s,x) => s + (x-mx)**2, 0);
  return den ? num/den : 0;
}

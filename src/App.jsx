import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Activity, Droplets, Thermometer, Wifi, Clock, Sparkles, Download, Stethoscope, User, Siren, PhoneForwarded, CheckCircle2, CircleStop } from "lucide-react";
import Chart from "react-apexcharts";

const DEFAULT_CHANNEL_ID = "3281642";
const DEFAULT_READ_API_KEY = "L3VW2XW8YKLYXPM1";
const DEFAULT_REFRESH_SEC = 5; // 5 second resolution as requested
const MAX_RESULTS = 30;
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
// WebSocket URL: connect directly to backend (port 4000) using the host IP
const WS_URL = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV
    ? `${window.location.hostname}:4000`
    : window.location.host;
  return `${proto}//${host}/api/ws`;
})();
const READ_KEY_REGEX = /^[A-Za-z0-9]{16}$/;
const ALERT_THRESHOLDS = {
  spo2Low: 92,
  hrLow: 55,
  hrHigh: 110,
  tempLow: 34.0,
  tempHigh: 38.0,
};
const DANGER_LIMITS = {
  spo2Low: 90,
  hrLow: 50,
  hrHigh: 120,
  tempLow: 32,
  tempHigh: 39.0,
};
const STORAGE_KEYS = {
  channelId: "aarga.thingspeak.channelId",
  refreshSec: "aarga.thingspeak.refreshSec",
  isAlertSystemEnabled: "aarga.alertSystem.enabled",
};

const VALID_PATIENTS = [
  { id: "P001", name: "Abinaya Sri" },
  { id: "P002", name: "Chandru" },
  { id: "P003", name: "Dharani" },
  { id: "P004", name: "Swathi" }
];
const buildThingSpeakClientUrl = (channelId, readApiKey, results = 30) =>
  `https://api.thingspeak.com/channels/${encodeURIComponent(channelId)}/feeds.json?results=${results}&api_key=${encodeURIComponent(readApiKey)}`;

const getSeriesStats = (values) => {
  const safeValues = values.filter((value) => Number.isFinite(value));
  if (!safeValues.length) {
    return { latest: null, min: null, max: null, average: null, trend: "No data" };
  }

  const latest = safeValues[safeValues.length - 1];
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const average = safeValues.reduce((total, value) => total + value, 0) / safeValues.length;
  const trendWindow = safeValues.slice(Math.max(0, safeValues.length - 6));
  const trendDelta = trendWindow.length > 1 ? trendWindow[trendWindow.length - 1] - trendWindow[0] : 0;

  let trend = "Stable";
  if (trendDelta > 1.5) trend = "Rising";
  if (trendDelta < -1.5) trend = "Falling";

  return {
    latest: Number(latest.toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    average: Number(average.toFixed(2)),
    trend,
  };
};

const buildAIInsights = ({ spo2Stats, hrStats, tempStats, dangerLimits = DANGER_LIMITS }) => {
  const insights = [];

  // SpO2
  if (spo2Stats.latest !== null && spo2Stats.latest < dangerLimits.spo2Low) {
    insights.push({
      clinical: `DANGER: SpO2 ${spo2Stats.latest}% - CRITICAL hypoxia.`,
      layperson: `Oxygen levels are dangerously low (${spo2Stats.latest}%). The patient is not getting enough oxygen and requires immediate medical intervention.`,
      type: "danger"
    });
  } else if (spo2Stats.latest !== null && spo2Stats.latest < ALERT_THRESHOLDS.spo2Low) {
    insights.push({
      clinical: `CAUTION: SpO2 ${spo2Stats.latest}% - Mild hypoxia.`,
      layperson: `Oxygen is slightly below ideal levels. Keep an eye on breathing, encourage deep breaths, and ensure the room is well-ventilated.`,
      type: "caution"
    });
  } else {
    insights.push({
      clinical: `NORMAL: SpO2 ${spo2Stats.latest}% - Normoxemia.`,
      layperson: `Oxygen saturation is healthy and within the normal expected range.`,
      type: "normal"
    });
  }

  // HR
  if (hrStats.latest !== null && hrStats.latest > dangerLimits.hrHigh) {
    insights.push({
      clinical: `DANGER: Heart Rate ${hrStats.latest} BPM - Severe Tachycardia.`,
      layperson: `Heart rate is extremely high, beating much faster than normal at resting state. Watch for chest pain. Immediate doctor review needed.`,
      type: "danger"
    });
  } else if (hrStats.latest !== null && hrStats.latest > ALERT_THRESHOLDS.hrHigh) {
    insights.push({
      clinical: `CAUTION: Heart Rate ${hrStats.latest} BPM - Mild Tachycardia.`,
      layperson: `Heart rate is slightly elevated. This could be due to stress, activity, or fever. Ensure the patient rests calmly.`,
      type: "caution"
    });
  } else if (hrStats.latest !== null && hrStats.latest < ALERT_THRESHOLDS.hrLow) {
    insights.push({
      clinical: `CAUTION: Heart Rate ${hrStats.latest} BPM - Bradycardia.`,
      layperson: `Heart rate is lower than average. If the patient is athletic, this may be fine, otherwise monitor if they feel dizzy.`,
      type: "caution"
    });
  } else {
    insights.push({
      clinical: `NORMAL: Heart Rate ${hrStats.latest} BPM - Normal sinus rhythm.`,
      layperson: `Heart rate is steady and healthy.`,
      type: "normal"
    });
  }

  // Temp
  if (tempStats.latest !== null && tempStats.latest > dangerLimits.tempHigh) {
    insights.push({
      clinical: `DANGER: Temperature ${tempStats.latest}°C - Severe Hyperthermia.`,
      layperson: `The patient is running a very high fever. Administer cooling measures and seek medical care urgently to prevent complications.`,
      type: "danger"
    });
  } else if (tempStats.latest !== null && tempStats.latest > ALERT_THRESHOLDS.tempHigh) {
    insights.push({
      clinical: `CAUTION: Temperature ${tempStats.latest}°C - Low-grade fever.`,
      layperson: `Body temperature is slightly elevated. Keep the patient hydrated and check again in a few hours.`,
      type: "caution"
    });
  } else {
    insights.push({
      clinical: `NORMAL: Temperature ${tempStats.latest}°C - Afebrile.`,
      layperson: `Body temperature is completely normal with no signs of fever.`,
      type: "normal"
    });
  }

  return insights;
};

const downloadClinicalPdf = ({ patientName, patientDetails, channelId, refreshSec, spo2Stats, hrStats, tempStats, activeAlerts, isConnected, dangerLimits = DANGER_LIMITS, recoveryScore }) => {
  const safeValue = (value, suffix = "") => (value === null ? "N/A" : `${value}${suffix}`);
  const insights = buildAIInsights({ spo2Stats, hrStats, tempStats, dangerLimits });
  const now = new Date().toLocaleString();
  const patientDisplayName = patientName.trim() || "Unknown Patient";
  const patientDisplayDetails = patientDetails.trim() || "Not provided";

  const insightsHtml = insights.map(i => `
    <div class="insight-row insight-${i.type}">
      <div class="insight-clin"><strong>Clinical Signature:</strong> ${i.clinical}</div>
      <div class="insight-lay"><strong>AI Translation:</strong> ${i.layperson}</div>
    </div>
  `).join("");

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cardiac Monitoring Clinical Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.5; background: #fff; }
    .container { width: 100%; max-width: 190mm; margin: 0 auto; }
    
    /* Letterhead */
    .letterhead { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 24px; }
    .letterhead-title h1 { font-size: 26px; font-weight: 900; color: #0f172a; margin-bottom: 4px; text-transform: uppercase; letter-spacing: -0.5px; }
    .letterhead-title span { font-size: 11px; font-weight: 700; color: #4f46e5; letter-spacing: 2px; text-transform: uppercase; }
    .letterhead-meta { text-align: right; font-size: 10px; color: #64748b; }
    .letterhead-meta strong { color: #0f172a; }

    /* Patient Details Block */
    .patient-block { display: flex; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .patient-info p { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: bold; margin-bottom: 4px; }
    .patient-info h2 { font-size: 20px; color: #0f172a; margin-bottom: 8px; }
    .patient-info .id-badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .vitals-score { text-align: right; }
    .vitals-score p { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: bold; margin-bottom: 4px; }
    .vitals-score .score-circle { display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 50%; background: #0f172a; color: #fff; font-size: 22px; font-weight: 900; border: 4px solid ${recoveryScore >= 85 ? '#22c55e' : recoveryScore >= 65 ? '#f59e0b' : '#ef4444'}; }

    /* Tables */
    .section-title { font-size: 14px; color: #0f172a; border-left: 4px solid #4f46e5; padding-left: 8px; margin-bottom: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { background: #f1f5f9; color: #475569; padding: 10px; text-align: left; font-size: 11px; font-weight: 800; border-bottom: 2px solid #cbd5e1; text-transform: uppercase; }
    td { padding: 12px 10px; border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #1e293b; }
    td.metric { font-weight: 700; color: #0f172a; }

    /* Insights Box */
    .insights-list { margin-bottom: 24px; }
    .insight-row { margin-bottom: 12px; padding: 12px 16px; border-radius: 8px; border-left: 4px solid; }
    .insight-normal { background: #f0fdf4; border-color: #22c55e; }
    .insight-caution { background: #fffbeb; border-color: #f59e0b; }
    .insight-danger { background: #fef2f2; border-color: #ef4444; }
    .insight-clin { font-size: 12px; color: #334155; margin-bottom: 6px; }
    .insight-lay { font-size: 14px; color: #0f172a; font-weight: 500; }

    /* Footer / Signature */
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: flex-end; }
    .signature-block { width: 250px; text-align: left; }
    .sig-line { border-bottom: 1px solid #0f172a; height: 30px; margin-bottom: 8px; }
    .signature-block p { font-size: 11px; color: #475569; }
    .legal { font-size: 9px; color: #94a3b8; max-width: 300px; text-align: left; }

    @media print {
      body { -webkit-print-color-adjust: exact; padding: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    
    <div class="letterhead">
      <div class="letterhead-title">
        <span>Cardiac Monitoring System</span>
        <h1>Clinical AI Report</h1>
      </div>
      <div class="letterhead-meta">
        <p><strong>Report Date:</strong> ${now}</p>
        <p><strong>ThingSpeak Channel:</strong> ${channelId}</p>
        <p><strong>Connection Quality:</strong> ${isConnected ? "Verified Live" : "Stale / Offline"}</p>
      </div>
    </div>

    <div class="patient-block">
      <div class="patient-info">
        <p>Patient Profile</p>
        <h2>${patientDisplayName}</h2>
        <div class="id-badge">ID: ${patientDisplayDetails}</div>
      </div>
      <div class="vitals-score">
        <p>Overall Recovery Score</p>
        <div class="score-circle">${recoveryScore}</div>
      </div>
    </div>

    <h3 class="section-title">Verified Vitals Telemetry</h3>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Live Reading</th>
          <th>Recent Avg</th>
          <th>Min / Max</th>
          <th>Safe Limit (SL) Protocol</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="metric">Oxygen Saturation (SpO₂)</td>
          <td style="font-size: 16px; font-weight: bold;">${safeValue(spo2Stats.latest, "%")}</td>
          <td>${safeValue(spo2Stats.average, "%")}</td>
          <td>${safeValue(spo2Stats.min, "%")} / ${safeValue(spo2Stats.max, "%")}</td>
          <td>Minimum ${ALERT_THRESHOLDS.spo2Low}% required</td>
        </tr>
        <tr>
          <td class="metric">Heart Rate (BPM)</td>
          <td style="font-size: 16px; font-weight: bold;">${safeValue(hrStats.latest)}</td>
          <td>${safeValue(hrStats.average)}</td>
          <td>${safeValue(hrStats.min)} / ${safeValue(hrStats.max)}</td>
          <td>${ALERT_THRESHOLDS.hrLow} - ${ALERT_THRESHOLDS.hrHigh} BPM</td>
        </tr>
        <tr>
          <td class="metric">Body Temperature (°C)</td>
          <td style="font-size: 16px; font-weight: bold;">${safeValue(tempStats.latest, "°")}</td>
          <td>${safeValue(tempStats.average, "°")}</td>
          <td>${safeValue(tempStats.min, "°")} / ${safeValue(tempStats.max, "°")}</td>
          <td>Maximum ${ALERT_THRESHOLDS.tempHigh}°C</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">AI Interpretations & Layperson Insights</h3>
    <div class="insights-list">
      ${insightsHtml}
    </div>

    <div class="footer">
      <div class="legal">
        <p><strong>Strictly Confidential & Proprietary.</strong></p>
        <p>This report merges clinical telemetry with AI-assisted layperson translations. It does not replace formal physician judgment. In a medical emergency, immediately contact local emergency services.</p>
      </div>
      <div class="signature-block">
        <div class="sig-line"></div>
        <p><strong>Attending Physician / Caretaker Signature</strong></p>
        <p>Date: ____________________</p>
      </div>
    </div>

  </div>
  <script>
    window.onload = function() {
      window.print();
    };
  </script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const newWindow = window.open(url, "_blank");
  if (newWindow) {
    newWindow.onbeforeunload = function () {
      URL.revokeObjectURL(url);
    };
  }
};

const convertTemp = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;

  // Accept direct Celsius values when the device already sends temperature.
  if (parsed >= 20 && parsed <= 50) {
    return Number(parsed.toFixed(1));
  }

  // Otherwise, treat field3 as ADC and convert through NTC formula.
  if (parsed <= 0) return null;
  const voltage = parsed * (3.3 / 1023.0);
  if (voltage <= 0) return null;

  const resistance = ((3.3 - voltage) * 10000) / voltage;
  if (!Number.isFinite(resistance) || resistance <= 0) return null;

  const temp = 1.0 / (Math.log(resistance / 10000) / 3950 + 1.0 / (25 + 273.15)) - 273.15;
  return Number.isFinite(temp) ? Number(temp.toFixed(1)) : null;
};

const toNumOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sanitizeSeries = (values, min, max) => {
  let lastValid = null;
  return values.map((value) => {
    if (value !== null && value >= min && value <= max) {
      lastValid = value;
      return value;
    }
    return lastValid;
  });
};

const smoothSeries = (values, windowSize = 3) => {
  return values.map((_, index) => {
    const start = Math.max(0, index - (windowSize - 1));
    const window = values.slice(start, index + 1).filter((value) => Number.isFinite(value));
    if (!window.length) return null;
    const sum = window.reduce((total, value) => total + value, 0);
    return Number((sum / window.length).toFixed(2));
  });
};

const Pill = ({ children, tone = "slate" }) => {
  const tones = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
  };

  return (
    <span className={`inline-flex items-center gap-2 border px-3 py-1.5 rounded-full text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
};

const MetricCard = ({ title, value, unit, subtitle, icon, progressColor, textColor, percent }) => (
  <article className="group relative overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl shadow-indigo-900/10 p-7 transition-all duration-500 hover:shadow-indigo-900/30 hover:border-slate-700 hover:-translate-y-1.5">
    <div className={`absolute inset-x-0 top-0 h-1.5 ${progressColor} opacity-90 group-hover:opacity-100 transition-opacity`} />
    <div className="absolute -right-6 -top-6 w-32 h-32 rounded-full bg-slate-800 opacity-0 group-hover:opacity-40 transition-opacity duration-700 blur-3xl pointer-events-none" />
    <div className="flex items-start justify-between relative z-10">
      <div className="pt-1">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400 group-hover:text-slate-300 transition-colors">{title}</p>
        <p className={`mt-3 text-5xl font-black tracking-tighter drop-shadow-[0_0_8px_rgba(0,0,0,0.8)] transition-colors duration-300 ${textColor}`}>{value}</p>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{unit}</p>
      </div>
      <div className={`h-14 w-14 rounded-2xl ${progressColor} text-slate-950 flex items-center justify-center shadow-lg shadow-current/30 group-hover:scale-110 group-hover:-rotate-3 transition-all duration-500 ease-out`}>
        {icon}
      </div>
    </div>

    <div className="mt-7 relative z-10">
      <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${progressColor} transition-all duration-1000 ease-out`}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
      <p className="mt-3 text-[10px] font-bold tracking-[0.1em] text-slate-500 uppercase">{subtitle}</p>
    </div>
  </article>
);

const TrendCard = ({ title, subTitle, options, series, type = "area", height = 290 }) => (
  <article className="group rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl shadow-indigo-900/10 p-6 pt-7 transition-all duration-500 hover:shadow-indigo-900/20 hover:border-slate-700">
    <div className="mb-6 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-xl font-black tracking-tight text-white group-hover:text-slate-200 transition-colors">{title}</h3>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1.5">{subTitle}</p>
      </div>
      <div className="animate-pulse">
        <Pill tone="emerald">
          <Sparkles size={12} className="mr-1 inline-block pb-0.5" /> Live
        </Pill>
      </div>
    </div>
    <div className="relative -mx-2 -mb-2 z-10 transition-transform duration-500 group-hover:scale-[1.01] origin-bottom">
      <Chart options={options} series={series} type={type} height={height} />
    </div>
  </article>
);

const AlertPopup = ({ alerts, onSnooze }) => (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
    <div className="w-full max-w-3xl rounded-3xl border border-rose-300 bg-white shadow-2xl overflow-hidden">
      <div className="bg-rose-600 px-6 py-5 text-white">
        <p className="text-xs font-bold uppercase tracking-[0.2em]">Critical Alert</p>
        <h1 className="mt-2 text-2xl md:text-3xl font-black">Patient Vitals Need Attention</h1>
        <p className="mt-2 text-sm text-rose-100">Review all alerts before continuing.</p>
      </div>

      <div className="space-y-3 px-6 py-6">
        {alerts.map((alertText) => (
          <p key={alertText} className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">
            {alertText}
          </p>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6 pt-1">
        <button className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white" onClick={onSnooze}>
          Snooze 2 min
        </button>
      </div>
    </div>
  </div>
);

const App = () => {
  const [channelIdInput, setChannelIdInput] = useState(() => localStorage.getItem(STORAGE_KEYS.channelId) || DEFAULT_CHANNEL_ID);
  const [readApiKeyInput, setReadApiKeyInput] = useState(DEFAULT_READ_API_KEY);
  const [refreshSecInput, setRefreshSecInput] = useState(() => Number(localStorage.getItem(STORAGE_KEYS.refreshSec) || DEFAULT_REFRESH_SEC));

  const [activeChannelId, setActiveChannelId] = useState(channelIdInput);
  const [activeRefreshSec, setActiveRefreshSec] = useState(refreshSecInput);
  const [activeReadApiKey, setActiveReadApiKey] = useState(readApiKeyInput);
  const [isConnected, setIsConnected] = useState(false);
  const [useDirectMode, setUseDirectMode] = useState(false);
  const [dataSource, setDataSource] = useState("thingspeak"); // "direct" or "thingspeak"

  const [feeds, setFeeds] = useState([]);
  const [displayFeeds, setDisplayFeeds] = useState([]);
  const feedsRef = useRef(feeds);

  useEffect(() => {
    feedsRef.current = feeds;
    if (feeds.length === 0) {
      setDisplayFeeds([]);
    } else if (dataSource === "direct") {
      setDisplayFeeds([...feeds]);
    }
  }, [feeds, dataSource]);

  useEffect(() => {
    if (!isConnected) return;
    // Skip synthetic interpolation when receiving direct sensor data (updates every 2s)
    if (dataSource === "direct") return;

    const interval = setInterval(() => {
      const currentFeeds = feedsRef.current;
      if (!currentFeeds || currentFeeds.length === 0) return;

      const latestFeed = currentFeeds[currentFeeds.length - 1];

      setDisplayFeeds((prev) => {
        if (prev.length === 0) return currentFeeds;

        const synthetic = { ...latestFeed, created_at: new Date().toISOString() };
        return [...prev, synthetic].slice(-MAX_RESULTS);
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [isConnected, dataSource]);

  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("Not Connected");
  const [error, setError] = useState("");
  const [apiError, setApiError] = useState("");
  const [popupMutedUntilMs, setPopupMutedUntilMs] = useState(0);
  const [isServerSnoozed, setIsServerSnoozed] = useState(false);
  const [isDeviceOffline, setIsDeviceOffline] = useState(false);

  const updateMuteTimer = (untilMs) => {
    setPopupMutedUntilMs(untilMs);
  };

  const [lastAlertSignature, setLastAlertSignature] = useState("");
  const [patientName, setPatientName] = useState("");
  const [patientDetails, setPatientDetails] = useState("");

  // Continuously sync patient info to backend so Twilio knows exactly who is being monitored
  useEffect(() => {
    if (!isConnected || useDirectMode) return;
    
    const timer = setTimeout(() => {
      fetch(`${API_BASE}/api/patient`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientName, patientDetails })
      }).catch(e => console.warn("Failed to sync patient info:", e));
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [patientName, patientDetails, isConnected, useDirectMode]);

  const [showReportModal, setShowReportModal] = useState(false);
  const [aiReport, setAiReport] = useState("");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [sosStatus, setSosStatus] = useState("idle");
  const [lastAutoSosTime, setLastAutoSosTime] = useState(0);
  const [isAlertSystemEnabled, setIsAlertSystemEnabled] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.isAlertSystemEnabled);
    return saved === null ? true : saved === "true";
  });

  // Backend-driven alert state (via WebSocket)
  const [criticalStartTime, setCriticalStartTime] = useState(null);
  const [criticalElapsedMs, setCriticalElapsedMs] = useState(0);
  const [hasPersistedCritical, setHasPersistedCritical] = useState(false);
  const [callStatus, setCallStatus] = useState("idle"); // "idle" | "calling"
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const wsReconnectTimer = useRef(null);

  // ─── WebSocket Connection ───────────────────────────────────────
  useEffect(() => {
    if (useDirectMode) return;

    let isMounted = true;

    const connectWs = () => {
      if (wsRef.current && wsRef.current.readyState <= 1) return; // Already connected/connecting

      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!isMounted) return;
          setWsConnected(true);
          console.log("[WS] Connected to backend");
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);

            switch (data.type) {
              case "INIT_STATE":
                setIsServerSnoozed(data.isServerSnoozed || false);
                if (data.muteUntil) setPopupMutedUntilMs(data.muteUntil);
                if (data.isAlertSystemEnabled !== undefined && Date.now() - lastToggleTime.current > 2000) setIsAlertSystemEnabled(data.isAlertSystemEnabled);
                if (data.isDeviceOffline !== undefined) setIsDeviceOffline(data.isDeviceOffline);
                setCriticalStartTime(data.criticalStartTime);
                setCriticalElapsedMs(data.criticalElapsedMs || 0);
                setHasPersistedCritical(data.hasPersistedCritical || false);
                setCallStatus(data.callStatus || "idle");
                
                // Authoritative monitoring state from server
                if (data.isMonitoring !== undefined) {
                  setIsConnected(data.isMonitoring);
                  if (data.isMonitoring) {
                    setConnectionStatus(data.isDeviceOffline ? "DEVICE OFFLINE" : "Connected (Real-time)");
                    if (data.patientName) setPatientName(data.patientName);
                    if (data.patientDetails) setPatientDetails(data.patientDetails);
                  }
                }
                break;

              case "FEED_UPDATE":
                setFeeds(data.feeds || []);
                if (data.source) setDataSource(data.source);
                if (data.channelId) setActiveChannelId(data.channelId);
                if (data.isAlertSystemEnabled !== undefined && Date.now() - lastToggleTime.current > 2000) setIsAlertSystemEnabled(data.isAlertSystemEnabled);
                if (data.isServerSnoozed !== undefined) setIsServerSnoozed(data.isServerSnoozed);
                if (data.muteUntil !== undefined) setPopupMutedUntilMs(data.muteUntil);
                if (data.isDeviceOffline !== undefined) setIsDeviceOffline(data.isDeviceOffline);
                setError("");
                setApiError("");
                setIsConnected(true);
                setConnectionStatus(
                  data.isDeviceOffline ? "DEVICE OFFLINE (Check Power/WiFi)" :
                    data.source === "direct"
                      ? "Connected (Direct Sensor — Live)"
                      : "Connected (Real-time)"
                );
                break;

              case "ALERT_STATE":
                // This is the KEY: backend sends precise timer state every 1 second
                setCriticalStartTime(data.criticalStartTime);
                setCriticalElapsedMs(data.criticalElapsedMs || 0);
                setHasPersistedCritical(data.hasPersistedCritical || false);
                setIsServerSnoozed(data.isServerSnoozed || false);
                if (data.muteUntil !== undefined) setPopupMutedUntilMs(data.muteUntil);
                if (data.isAlertSystemEnabled !== undefined && Date.now() - lastToggleTime.current > 2000) setIsAlertSystemEnabled(data.isAlertSystemEnabled);
                if (data.isDeviceOffline !== undefined) {
                  setIsDeviceOffline(data.isDeviceOffline);
                  if (data.isDeviceOffline) setConnectionStatus("DEVICE OFFLINE (Check Power/WiFi)");
                  else if (isConnected) setConnectionStatus(dataSource === "direct" ? "Connected (Direct Sensor — Live)" : "Connected (Real-time)");
                }
                setCallStatus(data.callStatus || "idle");
                break;

              case "CALL_DISPATCHED":
                setSosStatus("sending");
                console.log("[WS] Calls dispatched to:", data.recipients);
                break;

              case "CALL_LOOP_STARTED":
                setCallStatus("calling");
                setSosStatus("sending");
                break;

              case "CALL_LOOP_STOPPED":
                setCallStatus("idle");
                setSosStatus("idle");
                break;

              case "CALL_ATTENDED":
                setCallStatus("idle");
                setSosStatus("sent");
                if (data.snoozeUntil) {
                  setPopupMutedUntilMs(data.snoozeUntil);
                  setIsServerSnoozed(true);
                }
                setTimeout(() => setSosStatus("idle"), 5000);
                break;

              case "MONITORING_STARTED":
              case "MONITORING_STOPPED":
                // These are informational; state is synced via ALERT_STATE
                break;

              default:
                break;
            }
          } catch (e) {
            console.warn("[WS] Failed to parse message:", e);
          }
        };

        ws.onclose = () => {
          if (!isMounted) return;
          setWsConnected(false);
          console.log("[WS] Disconnected. Reconnecting in 3s...");
          wsReconnectTimer.current = setTimeout(connectWs, 3000);
        };

        ws.onerror = (err) => {
          console.warn("[WS] Error, will reconnect.");
          ws.close();
        };
      } catch (e) {
        console.error("[WS] Connection failed:", e);
        wsReconnectTimer.current = setTimeout(connectWs, 3000);
      }
    };

    connectWs();

    return () => {
      isMounted = false;
      if (wsReconnectTimer.current) clearTimeout(wsReconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [useDirectMode]); // Only reconnect if mode changes

  const lastToggleTime = useRef(0);
  const toggleAlertSystem = async () => {
    lastToggleTime.current = Date.now();
    const nextState = !isAlertSystemEnabled;
    setIsAlertSystemEnabled(nextState);
    localStorage.setItem(STORAGE_KEYS.isAlertSystemEnabled, String(nextState));

    // Notify backend if not in direct mode
    if (!useDirectMode && isConnected) {
      try {
        await fetch(`${API_BASE}/api/alert-system/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextState }),
        });
      } catch (e) {
        console.warn("Failed to sync alert toggle with backend:", e);
      }
    }
  };

  // ─── Data Fetching: WebSocket primary, HTTP polling fallback ─────
  // In WebSocket mode (default), feeds come from WS push. No polling needed.
  // In Direct Mode (no backend), we poll ThingSpeak directly.
  useEffect(() => {
    if (!isConnected) {
      return undefined;
    }

    // If WebSocket is connected in proxy mode, data arrives via WS push.
    // We only do HTTP polling in direct mode.
    if (!useDirectMode && wsConnected) {
      // Data arrives via WebSocket — no polling needed
      setConnectionStatus(
        dataSource === "direct"
          ? "Connected (Direct Sensor — Live)"
          : "Connected (Real-time)"
      );
      return undefined;
    }

    const fetchData = async () => {
      try {
        if (useDirectMode) {
          const directUrl = buildThingSpeakClientUrl(activeChannelId, activeReadApiKey, MAX_RESULTS);
          const directRes = await fetch(directUrl);
          if (!directRes.ok) {
            throw new Error(`ThingSpeak direct request failed (${directRes.status})`);
          }
          const directData = await directRes.json();
          setFeeds(directData.feeds || []);
          setConnectionStatus("Connected (Direct Mode)");
          setError("");
          setApiError("");
        } else {
          // HTTP fallback when WebSocket is not connected
          try {
            const res = await fetch(`${API_BASE}/api/feeds?results=${MAX_RESULTS}`);
            if (!res.ok) {
              throw new Error(`Proxy error (${res.status}). Switching to Direct Mode.`);
            }
            const data = await res.json();
            setFeeds(data.feeds || []);
            setActiveChannelId(data.channelId || activeChannelId);
            setConnectionStatus("Connected (Polling)");
            setError("");
            setApiError("");

            // Sync alert state from backend HTTP response
            if (data.isAlertSystemEnabled !== undefined) {
              setIsAlertSystemEnabled(data.isAlertSystemEnabled);
            }
            if (data.isServerSnoozed !== undefined) {
              setIsServerSnoozed(data.isServerSnoozed);
            }
            if (data.hasPersistedCritical !== undefined) {
              setHasPersistedCritical(data.hasPersistedCritical);
            }
            if (data.criticalElapsedMs !== undefined) {
              setCriticalElapsedMs(data.criticalElapsedMs);
            }
            if (data.criticalStartTime !== undefined) {
              setCriticalStartTime(data.criticalStartTime);
            }
          } catch (proxyError) {
            console.warn("Proxy connection failed, falling back to Direct Mode:", proxyError.message);
            // Attempt immediate fallback
            const directUrl = buildThingSpeakClientUrl(activeChannelId, activeReadApiKey, MAX_RESULTS);
            const directRes = await fetch(directUrl);
            if (directRes.ok) {
              const directData = await directRes.json();
              setFeeds(directData.feeds || []);
              setConnectionStatus("Connected (Fallback Mode)");
              setUseDirectMode(true); // Persist fallback mode for this session
              setError("");
              setApiError("");
            } else {
              throw new Error("Both Proxy and Direct Mode failed.");
            }
          }
        }
      } catch (error) {
        setConnectionStatus("Connection Failed");
        setError("Unable to fetch data. Check your internet or ThingSpeak Channel status.");
        setApiError("Communication error. Please verify your credentials and network.");
        console.error(error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const safeRefresh = Math.max(5, Number(activeRefreshSec) || DEFAULT_REFRESH_SEC);
    const interval = setInterval(fetchData, safeRefresh * 1000);
    return () => clearInterval(interval);
  }, [activeChannelId, activeReadApiKey, activeRefreshSec, isConnected, useDirectMode, wsConnected]);

  const handleConnect = () => {
    if (!patientName.trim()) {
      setConnectionStatus("Patient Name Required");
      setError("Please enter patient name to proceed.");
      return;
    }

    if (!patientDetails.trim()) {
      setConnectionStatus("Patient ID/Details Required");
      setError("Please enter patient ID or details to proceed.");
      return;
    }

    const matchedPatient = VALID_PATIENTS.find(
      (p) => p.name.toLowerCase() === patientName.trim().toLowerCase() && p.id.toLowerCase() === patientDetails.trim().toLowerCase()
    );

    if (!matchedPatient) {
      setConnectionStatus("Verification Failed");
      setError("Invalid Patient Name or Patient ID. Connection denied.");
      return;
    }

    const nextChannel = channelIdInput.trim();
    const nextKey = readApiKeyInput.trim();
    const nextRefresh = Math.max(5, Number(refreshSecInput) || DEFAULT_REFRESH_SEC);

    if (!nextChannel) {
      setConnectionStatus("Channel ID required");
      return;
    }

    if (!nextKey) {
      setConnectionStatus("Read API Key required");
      setError("Please paste your Read API Key, then click Connect.");
      return;
    }

    if (!READ_KEY_REGEX.test(nextKey)) {
      setConnectionStatus("Invalid API Key");
      setError("Read API Key must be exactly 16 letters/numbers.");
      return;
    }

    const applyConfig = async () => {
      const connectDirectMode = async () => {
        const testUrl = buildThingSpeakClientUrl(nextChannel, nextKey, 1);
        const directResponse = await fetch(testUrl);
        if (!directResponse.ok) {
          throw new Error(`ThingSpeak direct auth failed (${directResponse.status})`);
        }
        const directData = await directResponse.json();
        if (directData.status === "0" || directData.error || !directData.channel) {
          throw new Error("Invalid Channel ID or Read API Key.");
        }

        localStorage.setItem(STORAGE_KEYS.channelId, nextChannel);
        localStorage.setItem(STORAGE_KEYS.refreshSec, String(nextRefresh));

        setActiveChannelId(nextChannel);
        setActiveReadApiKey(nextKey);
        setActiveRefreshSec(nextRefresh);
        setUseDirectMode(true);
        setIsConnected(true);
        setConnectionStatus("Connected (Direct Mode)");
        setError("Server API unavailable. Connected via direct ThingSpeak mode.");
        setApiError("");
      };

      try {
        setConnectionStatus("Verifying...");
        setLoading(true);

        // Update backend config and verify connection
        const response = await fetch(`${API_BASE}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: channelIdInput,
            readApiKey: readApiKeyInput,
            isMonitoring: true,
            isAlertSystemEnabled,
            patientName: patientName.trim(),
            patientDetails: patientDetails.trim(),
          }),
        });

        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }

        if (data.isAlertSystemEnabled !== undefined) {
          setIsAlertSystemEnabled(data.isAlertSystemEnabled);
        }
        if (data.muteUntil !== undefined) {
          setPopupMutedUntilMs(data.muteUntil);
        }

        if (!response.ok || !data.ok) {
          if (response.status >= 500 || response.status === 404 || !data) {
            await connectDirectMode();
            return;
          }
          setConnectionStatus("Authentication Failed");
          setError((data && data.error) || "Connection rejected by server.");
          setApiError((data && data.error) || "Authentication failed. Please verify your credentials.");
          setLoading(false);
          setIsConnected(false);
          return;
        }

        localStorage.setItem(STORAGE_KEYS.refreshSec, String(nextRefresh));

        setActiveChannelId(nextChannel);
        setActiveReadApiKey(nextKey);
        setActiveRefreshSec(nextRefresh);
        setUseDirectMode(false);
        setIsConnected(true);
        setError("");
        setApiError("");
      } catch (error) {
        try {
          await connectDirectMode();
        } catch {
          setConnectionStatus("Connection Failed");
          setError("Connection failed. Please verify API deployment and try again.");
          setApiError("Connection failed. API may not be deployed or network is unavailable.");
          setIsConnected(false);
        }
      } finally {
        setLoading(false);
      }
    };

    if (isConnected) {
      handleStopMonitoring();
      return;
    }

    applyConfig();
  };

  const rawSpo2 = displayFeeds.map((feed) => toNumOrNull(feed.field1));
  const rawHr = displayFeeds.map((feed) => toNumOrNull(feed.field2));
  const rawTemp = displayFeeds.map((feed) => convertTemp(feed.field3));

  const spo2SeriesData = smoothSeries(sanitizeSeries(rawSpo2, 0, 100), 1);
  const hrSeriesData = smoothSeries(sanitizeSeries(rawHr, 0, 220), 1);
  const tempSeriesData = smoothSeries(sanitizeSeries(rawTemp, 0, 50), 1);

  const latestSpo2 = spo2SeriesData[spo2SeriesData.length - 1] ?? 0;
  const latestHr = hrSeriesData[hrSeriesData.length - 1] ?? 0;
  const latestTemp = tempSeriesData[tempSeriesData.length - 1] ?? null;
  const spo2Stats = useMemo(() => getSeriesStats(spo2SeriesData), [spo2SeriesData]);
  const hrStats = useMemo(() => getSeriesStats(hrSeriesData), [hrSeriesData]);
  const tempStats = useMemo(() => getSeriesStats(tempSeriesData), [tempSeriesData]);

  const activeAlerts = useMemo(() => {
    const alerts = [];

    if (apiError) {
      alerts.push(apiError);
    }

    if (!isConnected || !feeds.length) return alerts;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const prefix = `[${timeStr}] `;

    // Check DANGER thresholds first (most critical - RED)
    if (latestSpo2 < DANGER_LIMITS.spo2Low) {
      alerts.push(`${prefix}🔴 DANGER: SpO2 ${latestSpo2.toFixed(0)}% CRITICAL (below ${DANGER_LIMITS.spo2Low}%)`);
    } else if (latestSpo2 < ALERT_THRESHOLDS.spo2Low) {
      alerts.push(`${prefix}⚠️ CAUTION: SpO2 ${latestSpo2.toFixed(0)}% (below ${ALERT_THRESHOLDS.spo2Low}%)`);
    }

    if (latestHr > DANGER_LIMITS.hrHigh) {
      alerts.push(`${prefix}🔴 DANGER: Heart Rate ${latestHr.toFixed(0)} BPM CRITICAL (above ${DANGER_LIMITS.hrHigh} BPM)`);
    } else if (latestHr < DANGER_LIMITS.hrLow) {
      alerts.push(`${prefix}🔴 DANGER: Heart Rate ${latestHr.toFixed(0)} BPM CRITICAL (below ${DANGER_LIMITS.hrLow} BPM)`);
    } else if (latestHr > ALERT_THRESHOLDS.hrHigh) {
      alerts.push(`${prefix}⚠️ CAUTION: Heart Rate ${latestHr.toFixed(0)} BPM (above ${ALERT_THRESHOLDS.hrHigh} BPM)`);
    } else if (latestHr < ALERT_THRESHOLDS.hrLow) {
      alerts.push(`${prefix}⚠️ CAUTION: Heart Rate ${latestHr.toFixed(0)} BPM (below ${ALERT_THRESHOLDS.hrLow} BPM)`);
    }

    if (latestTemp !== null && latestTemp > DANGER_LIMITS.tempHigh) {
      alerts.push(`${prefix}🔴 DANGER: Temperature ${latestTemp.toFixed(1)}°C CRITICAL (above ${DANGER_LIMITS.tempHigh}°C)`);
    } else if (latestTemp !== null && latestTemp < DANGER_LIMITS.tempLow) {
      alerts.push(`${prefix}🔴 DANGER: Temperature ${latestTemp.toFixed(1)}°C CRITICAL (below ${DANGER_LIMITS.tempLow}°C)`);
    } else if (latestTemp !== null && latestTemp > ALERT_THRESHOLDS.tempHigh) {
      alerts.push(`${prefix}⚠️ CAUTION: Temperature ${latestTemp.toFixed(1)}°C (above ${ALERT_THRESHOLDS.tempHigh}°C)`);
    }
    if (latestTemp === null) {
      alerts.push(`${prefix}Temperature: unavailable (sensor/mapping error)`);
    }

    return alerts;
  }, [feeds.length, isConnected, latestHr, latestSpo2, latestTemp, apiError]);

  // 2-minute persistence is now handled by the backend's precision 1-second timer.
  // In direct mode (no backend), we fall back to local timing.
  useEffect(() => {
    if (useDirectMode) {
      // Direct mode fallback: local 1-second timer
      const isCriticalNow = activeAlerts.some(a => a.startsWith("🔴 DANGER"));
      if (isCriticalNow) {
        if (!criticalStartTime) {
          setCriticalStartTime(Date.now());
        }
      } else {
        setCriticalStartTime(null);
        setHasPersistedCritical(false);
        setCriticalElapsedMs(0);
      }
    }
    // In proxy mode, criticalStartTime + hasPersistedCritical are set by WebSocket ALERT_STATE
  }, [activeAlerts, useDirectMode]);

  // Direct mode: 1-second local precision timer
  useEffect(() => {
    if (!useDirectMode || !criticalStartTime) return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - criticalStartTime;
      setCriticalElapsedMs(elapsed);
      if (elapsed >= 30000) { // 30 seconds of continuous critical vitals
        setHasPersistedCritical(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [useDirectMode, criticalStartTime]);

  const isLocalMuted = Date.now() < popupMutedUntilMs;
  const shouldShowAlertPopup = isAlertSystemEnabled && hasPersistedCritical && activeAlerts.length > 0 && !isServerSnoozed && !isLocalMuted;

  const checkVerification = (options = { silent: false }) => {
    if (!isConnected) {
      if (!options.silent) alert("You must be connected to view or generate a report.");
      return false;
    }
    const isVerified = VALID_PATIENTS.some(
      (p) => p.name.toLowerCase() === patientName.trim().toLowerCase() && p.id.toLowerCase() === patientDetails.trim().toLowerCase()
    );
    if (!isVerified) {
      if (!options.silent) alert("Verification failed. Please enter a valid Patient Name and ID and click Connect first.");
      return false;
    }
    return true;
  };

  const handleStopMonitoring = async () => {
    setConnectionStatus("Stopping...");
    try {
      // Try to tell the server to stop
      await fetch(`${API_BASE}/api/stop`, { method: "POST" });
    } catch (e) {
      console.warn("Server stop call failed, stopping locally:", e);
    } finally {
      // ALWAYS stop locally regardless of server response
      setIsConnected(false);
      setHasPersistedCritical(false);
      setCriticalElapsedMs(0);
      setConnectionStatus("Monitoring Stopped");
      setApiError("");
      setPatientName("");
      setPatientDetails("");
    }
  };

  const handleTriggerSOS = async () => {
    if (!checkVerification()) return;
    if (!isAlertSystemEnabled) {
      console.log("SOS Trigger skipped: Alert System is OFF");
      return;
    }

    setSosStatus("sending");
    try {
      if (useDirectMode) {
        // Direct mode simulation
        await new Promise(r => setTimeout(r, 1500));
        setSosStatus("sent");
      } else {
        const res = await fetch(`${API_BASE}/api/sos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientName, patientDetails })
        });
        if (!res.ok) throw new Error("API request failed");
        setSosStatus("sent");
      }
      setTimeout(() => setSosStatus("idle"), 5000);
    } catch {
      setSosStatus("error");
      setTimeout(() => setSosStatus("idle"), 4000);
    }
  };

  const handleViewReport = async () => {
    if (checkVerification()) {
      setShowReportModal(true);
      if (!aiReport && !isGeneratingReport) {
        setIsGeneratingReport(true);
        setAiReport("");
        try {
          const res = await fetch(`${API_BASE}/api/generate-ai-report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channelId: activeChannelId,
              readApiKey: activeReadApiKey,
              patientName,
              patientDetails
            })
          });
          const data = await res.json();
          if (data.ok) {
            setAiReport(data.report);
          } else {
            setAiReport(`⚠️ Report Generation Failed: ${data.error}`);
          }
        } catch (e) {
          setAiReport(`⚠️ Failed to connect to AI engine: ${e.message}`);
        } finally {
          setIsGeneratingReport(false);
        }
      }
    }
  };

  const handleDownloadReport = () => {
    if (checkVerification()) {
      downloadClinicalPdf({
        patientName,
        patientDetails,
        channelId: activeChannelId,
        refreshSec: activeRefreshSec,
        spo2Stats,
        hrStats,
        tempStats,
        activeAlerts,
        isConnected,
        recoveryScore,
      });
    }
  };

  const handleDownloadFromModal = () => {
    if (checkVerification()) {
      downloadClinicalPdf({
        patientName,
        patientDetails,
        channelId: activeChannelId,
        refreshSec: activeRefreshSec,
        spo2Stats,
        hrStats,
        tempStats,
        activeAlerts,
        isConnected,
        recoveryScore,
      });
    }
  };

  useEffect(() => {
    // We want a signature that only changes when the TYPE of alerts change, 
    // not when the specific values (like HR 121 -> 122) change.
    const types = [];
    if (latestSpo2 < DANGER_LIMITS.spo2Low) types.push("SPO_D");
    else if (latestSpo2 < ALERT_THRESHOLDS.spo2Low) types.push("SPO_C");
    if (latestHr > DANGER_LIMITS.hrHigh) types.push("HR_H_D");
    else if (latestHr < DANGER_LIMITS.hrLow) types.push("HR_L_D");
    else if (latestHr > ALERT_THRESHOLDS.hrHigh) types.push("HR_H_C");
    else if (latestHr < ALERT_THRESHOLDS.hrLow) types.push("HR_L_C");
    if (latestTemp !== null && latestTemp > DANGER_LIMITS.tempHigh) types.push("T_H_D");
    else if (latestTemp !== null && latestTemp < DANGER_LIMITS.tempLow) types.push("T_L_D");
    else if (latestTemp !== null && latestTemp > ALERT_THRESHOLDS.tempHigh) types.push("T_H_C");
    if (latestTemp === null) types.push("T_NA");
    if (apiError) types.push("API_E");

    const signature = types.sort().join("|");

    if (!signature) {
      setLastAlertSignature("");
      return;
    }

    if (signature !== lastAlertSignature) {
      setLastAlertSignature(signature);
      // New type of alert detected, reset mute to show the new problem
      setPopupMutedUntilMs(0);
      setIsServerSnoozed(false);
    }
  }, [activeAlerts, lastAlertSignature, latestHr, latestSpo2, latestTemp, apiError]);

  useEffect(() => {
    if (!popupMutedUntilMs) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setPopupMutedUntilMs(0);
    }, Math.max(0, popupMutedUntilMs - Date.now()));

    return () => window.clearTimeout(timeoutId);
  }, [popupMutedUntilMs]);

  const categories = displayFeeds.map((feed) =>
    new Date(feed.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  );

  const baseChartOptions = useMemo(
    () => ({
      chart: {
        toolbar: { show: false },
        zoom: { enabled: false },
        background: "transparent",
        animations: {
          enabled: true,
          easing: 'linear',
          speed: 800,
          dynamicAnimation: { enabled: true, speed: 800 }
        },
        dropShadow: {
          enabled: true,
          color: '#000',
          top: 2,
          left: 0,
          blur: 4,
          opacity: 0.8
        }
      },
      dataLabels: { enabled: false },
      stroke: { curve: "smooth", width: 3, lineCap: "round" },
      markers: {
        size: 0,
        strokeWidth: 2,
        strokeColors: "#fff",
        hover: { size: 6, sizeOffset: 3 },
      },
      fill: { 
        type: "gradient",
        gradient: {
          shadeIntensity: 1,
          opacityFrom: 0.5,
          opacityTo: 0.1,
          stops: [0, 90, 100]
        }
      },
      xaxis: {
        categories,
        labels: {
          rotate: -90,
          hideOverlappingLabels: false,
          trim: false,
          style: {
            colors: "#475569",
            fontSize: "11px",
            fontFamily: "inherit",
            fontWeight: 700,
          },
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
        crosshairs: {
          stroke: {
            color: "#334155",
            width: 1,
            dashArray: 4,
          },
        },
      },
      yaxis: {
        labels: {
          style: {
            colors: "#475569",
            fontSize: "11px",
            fontFamily: "inherit",
            fontWeight: 700,
          },
        },
      },
      grid: {
        borderColor: "#1e293b",
        strokeDashArray: 2,
        position: 'back',
        xaxis: { lines: { show: true } },
        yaxis: { lines: { show: true } },
      },
      tooltip: {
        theme: "dark",
        style: { fontSize: '12px', fontFamily: 'inherit' },
        marker: { show: true },
        x: { show: true }
      },
      noData: {
        text: "Waiting for live data...",
        style: { color: "#475569", fontSize: "13px" },
      },
    }),
    [categories]
  );

  const spo2Series = [
    {
      name: "SpO2",
      data: spo2SeriesData,
    },
  ];

  const hrSeries = [
    {
      name: "BPM",
      data: hrSeriesData,
    },
  ];

  const tempSeries = [
    {
      name: "Temperature",
      data: tempSeriesData,
    },
  ];

  const combinedSeries = [
    { name: "SpO2", data: spo2SeriesData },
    { name: "BPM", data: hrSeriesData },
    { name: "Temp", data: tempSeriesData },
  ];

  const spo2Options = {
    ...baseChartOptions,
    colors: ["#00ffff"],
    yaxis: { ...baseChartOptions.yaxis, min: 0, max: 150, labels: { style: { colors: "#00ffff", fontSize: "11px", fontWeight: 700 } } },
  };

  const hrOptions = {
    ...baseChartOptions,
    colors: ["#00ff00"],
    yaxis: { ...baseChartOptions.yaxis, min: 0, max: 150, labels: { style: { colors: "#00ff00", fontSize: "11px", fontWeight: 700 } } },
  };

  const tempOptions = {
    ...baseChartOptions,
    colors: ["#ff0055"],
    yaxis: { ...baseChartOptions.yaxis, min: 0, max: 150, labels: { style: { colors: "#ff0055", fontSize: "11px", fontWeight: 700 } } },
  };

  const combinedOptions = {
    ...baseChartOptions,
    colors: ["#00ffff", "#00ff00", "#ff0055"],
    stroke: { curve: "smooth", width: 2, lineCap: "round" },
    legend: { show: true, position: "top", labels: { colors: "#94a3b8" } },
    yaxis: [
      {
        min: 0,
        max: 150,
        labels: { style: { colors: "#00ffff", fontSize: "11px", fontWeight: 700 } },
      },
      {
        opposite: true,
        min: 0,
        max: 150,
        labels: { style: { colors: "#00ff00", fontSize: "11px", fontWeight: 700 } },
      },
      {
        opposite: true,
        min: 0,
        max: 150,
        labels: { style: { colors: "#ff0055", fontSize: "11px", fontWeight: 700 } },
      },
    ],
  };

  const lastUpdated = feeds.length ? new Date(feeds[feeds.length - 1].created_at).toLocaleTimeString() : "--:--:--";
  const readingsToday = feeds.length;
  const alertsToday = activeAlerts.length;
  const recoveryScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 -
        (latestSpo2 < ALERT_THRESHOLDS.spo2Low ? (ALERT_THRESHOLDS.spo2Low - latestSpo2) * 3 : 0) -
        (latestHr > ALERT_THRESHOLDS.hrHigh ? (latestHr - ALERT_THRESHOLDS.hrHigh) * 0.8 : 0) -
        (latestHr > 0 && latestHr < ALERT_THRESHOLDS.hrLow ? (ALERT_THRESHOLDS.hrLow - latestHr) * 0.8 : 0) -
        (latestTemp !== null && latestTemp > ALERT_THRESHOLDS.tempHigh ? (latestTemp - ALERT_THRESHOLDS.tempHigh) * 12 : 0)
      )
    )
  );
  const recoveryBand = recoveryScore >= 85 ? "Good" : recoveryScore >= 65 ? "Observe" : "Critical";

  const ReportModal = () => {
    const insights = buildAIInsights({ spo2Stats, hrStats, tempStats });

    return (
      <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
        <div className="w-full max-w-4xl rounded-3xl border border-slate-200 bg-white shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div className="bg-gradient-to-r from-slate-900 to-slate-800 px-6 py-5 text-white flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-300">CARDIAC MONITORING SYSTEM</p>
              <h1 className="mt-1 text-2xl font-black">Doctor Portal Report</h1>
            </div>
            <button
              onClick={() => setShowReportModal(false)}
              className="rounded-lg hover:bg-slate-700 p-2 text-white transition"
            >
              ✕
            </button>
          </div>

          <div className="overflow-y-auto flex-1 p-6 md:p-8 space-y-6">
            {patientName.trim() && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm font-semibold text-blue-900">{patientName}</p>
                {patientDetails.trim() && <p className="text-xs text-blue-700 mt-1">{patientDetails}</p>}
              </div>
            )}

            <div>
              <h2 className="text-lg font-bold text-slate-900 mb-3 flex items-center gap-2">
                ✨ AI Medical Analysis (Last 7 Days)
              </h2>
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 min-h-[150px]">
                {isGeneratingReport ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3 py-10">
                    <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
                    <p className="text-sm font-semibold animate-pulse">Analyzing 1-week ThingSpeak history via Google Gemini...</p>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-slate-700 leading-relaxed">
                    {aiReport || "No AI report available."}
                  </pre>
                )}
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 bg-slate-50 px-6 py-4 flex flex-wrap gap-3 justify-end">
            <button
              onClick={() => setShowReportModal(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 transition"
            >
              Close
            </button>
            <button
              onClick={handleDownloadFromModal}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition"
            >
              <Download size={16} /> Download PDF
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans text-slate-900 selection:bg-indigo-100">
      {showReportModal && <ReportModal />}

      {/* SOS Popup */}
      {sosStatus !== "idle" && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl p-8 text-center animate-in zoom-in duration-300">
            {sosStatus === "sending" && (
              <div className="space-y-6">
                <Siren size={64} className="mx-auto text-rose-500 animate-pulse" />
                <h2 className="text-2xl font-black text-slate-900">Automated Emergency Detection!</h2>
                <p className="text-slate-500 font-medium">Placing Voice Calls to Doctor & Caretaker via Twilio.</p>
                <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-rose-500 animate-[bounce_1s_infinite] w-1/3 rounded-full" />
                </div>
              </div>
            )}
            {sosStatus === "sent" && (
              <div className="space-y-6">
                <CheckCircle2 size={64} className="mx-auto text-emerald-500" />
                <h2 className="text-2xl font-black text-emerald-600">Voice Calls Connected!</h2>
                <div className="text-left bg-slate-50 p-4 rounded-xl border border-slate-200">
                  <p className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-2"><PhoneForwarded size={16} /> Calls dispatching to:</p>
                  <ul className="text-sm text-slate-600 space-y-1 ml-6 list-disc">
                    <li>Attending Doctor (+91-9876543210)</li>
                    <li>Primary Caretaker (+91-9988776655)</li>
                    <li>Local Emergency Response (+91-112)</li>
                  </ul>
                </div>
                <p className="text-xs text-slate-500">Wait length up to 10 minutes before auto-dailing again.</p>
              </div>
            )}
            {sosStatus === "error" && (
              <div className="space-y-6">
                <Siren size={64} className="mx-auto text-rose-800" />
                <h2 className="text-2xl font-black text-rose-700">Dispatch Failed!</h2>
                <p className="text-sm text-rose-600">Network error. Please call the emergency number manually immediately.</p>
              </div>
            )}
          </div>
        </div>
      )}



      {shouldShowAlertPopup ? (
        <AlertPopup
          alerts={activeAlerts}
          onSnooze={async () => {
            const until = Date.now() + 2 * 60 * 1000; // 2 minutes
            setIsServerSnoozed(true);
            setPopupMutedUntilMs(until);
            // Sync snooze with backend to silence SOS phone calls
            if (!useDirectMode && isConnected) {
              try {
                await fetch(`${API_BASE}/api/alert-system/snooze`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ untilMs: until }),
                });
              } catch (e) {
                console.warn("Failed to sync snooze with backend:", e);
              }
            }
          }}
        />
      ) : null}

      <header className="sticky top-4 z-50 mx-4 md:mx-0">
        <div className="flex flex-col md:flex-row items-center justify-between gap-5 rounded-[2.5rem] border border-slate-100/50 bg-white/70 backdrop-blur-3xl p-5 shadow-2xl shadow-slate-200/40">
          <div className="flex items-center gap-5">
            <div className="relative group">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-indigo-500 to-blue-500 opacity-20 blur-sm group-hover:opacity-40 transition-opacity" />
              <div className="relative h-14 w-14 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
                <Stethoscope size={28} className="text-white" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-900">Doctor Portal</h1>
              <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-indigo-500 leading-none mt-1">Cardiac Monitoring System</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <div className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold transition-all duration-300 ${isDeviceOffline ? "bg-amber-50 text-amber-600 border-amber-200 animate-pulse" : (isConnected ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-slate-50 text-slate-500 border border-slate-100")}`}>
              <div className={`h-1.5 w-1.5 rounded-full ${isDeviceOffline ? "bg-amber-500" : (isConnected ? "bg-emerald-500 animate-pulse" : "bg-slate-300")}`} />
              {isDeviceOffline ? "DEVICE OFFLINE" : (isConnected ? "LIVE MONITORING" : "OFFLINE")}
            </div>
            {isConnected && !isDeviceOffline ? (
              <div className="flex items-center gap-2 rounded-xl bg-indigo-50 border border-indigo-100 px-4 py-2 text-indigo-600 text-xs font-bold">
                <Clock size={14} />
                Last update {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-xl bg-[#6366f115] border border-indigo-100 px-4 py-2 text-indigo-600 text-xs font-extrabold">
              <Wifi size={14} />
              Channel {activeChannelId || "---"}
            </div>
            <div className={`flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-bold ${isDeviceOffline ? "bg-amber-50 text-amber-700 border-amber-300" : "bg-slate-50 border-slate-200 text-slate-600"}`}>
              {connectionStatus}
            </div>

            <button
              onClick={toggleAlertSystem}
              className={`flex items-center gap-2 rounded-xl border px-5 py-3 text-xs font-black tracking-wider uppercase transition-all duration-300 shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 ${isAlertSystemEnabled
                ? "bg-rose-500 border-rose-400 text-white"
                : "bg-slate-500 border-slate-400 text-white"
                }`}
            >
              <Siren size={18} className={isAlertSystemEnabled ? "animate-pulse" : ""} />
              Alert System is Turned {isAlertSystemEnabled ? "ON" : "OFF"}
            </button>
            {isServerSnoozed ? (
              <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2 text-amber-800 text-xs font-bold animate-pulse">
                Snooze Mode Active
              </div>
            ) : null}
            {!useDirectMode && (
              <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-[10px] font-bold border ${wsConnected ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-orange-50 text-orange-700 border-orange-200"}`}>
                <div className={`h-1.5 w-1.5 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-orange-400 animate-pulse"}`} />
                {wsConnected ? "WS LIVE" : "WS RECONNECTING"}
              </div>
            )}
            {criticalStartTime && isAlertSystemEnabled && !isServerSnoozed ? (
              <div className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-black border animate-pulse ${hasPersistedCritical ? "bg-rose-100 text-rose-800 border-rose-300" : "bg-amber-50 text-amber-800 border-amber-200"}`}>
                ⏱️ {hasPersistedCritical ? "ALERT ACTIVE" : `Danger: ${Math.floor(criticalElapsedMs / 1000)}s / 5s`}
                {callStatus === "calling" && " | 📞 Calling..."}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleDownloadReport}
              disabled={!isConnected}
              className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${isConnected
                ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                : "border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed"
                }`}
            >
              Download Report
            </button>
            <button
              onClick={handleViewReport}
              disabled={!isConnected}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${isConnected
                ? "bg-slate-900 text-white hover:bg-slate-800"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
                }`}
            >
              View Report
            </button>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm h-fit xl:sticky xl:top-4 xl:self-start xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex items-start gap-3">
            <div className="h-11 w-11 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shadow-inner">
              <User size={20} />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900">{patientName.trim() || "Patient"}</p>
              <p className="text-xs text-slate-500">{patientDetails.trim() || "ID: --"}</p>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">Normal Ranges</p>
            <div className="space-y-2">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 flex items-center justify-between"><span>Heart Rate</span><span>{DANGER_LIMITS.hrLow} - {DANGER_LIMITS.hrHigh} BPM</span></div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 flex items-center justify-between"><span>SpO2</span><span>Minimum {DANGER_LIMITS.spo2Low}%</span></div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 flex items-center justify-between"><span>Temperature</span><span>{DANGER_LIMITS.tempLow} - {DANGER_LIMITS.tempHigh.toFixed(1)} deg C</span></div>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">Quick Stats</p>
            <div className="space-y-2">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm flex justify-between"><span>Readings Today</span><span className="font-bold text-slate-900">{readingsToday}</span></div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm flex justify-between"><span>Alerts Today</span><span className="font-bold text-rose-700">{alertsToday}</span></div>
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm flex justify-between"><span>Recovery Score</span><span className="font-bold text-indigo-700">{recoveryScore}/100</span></div>
            </div>
          </div>

          <section className="rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-2">Connection</p>
            {!patientName.trim() || !patientDetails.trim() ? (
              <p className="mb-2 rounded-lg bg-yellow-50 border border-yellow-200 px-2 py-1 text-[11px] text-yellow-800">Patient info required before Connect.</p>
            ) : null}
            <div className="space-y-2">
              <input
                className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm"
                placeholder="Channel ID"
                value={channelIdInput}
                onChange={(event) => setChannelIdInput(event.target.value)}
              />
              <input
                className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm"
                placeholder="Read API Key"
                value={readApiKeyInput}
                onChange={(event) => setReadApiKeyInput(event.target.value)}
              />
              <input
                className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm"
                type="number"
                min={5}
                placeholder="Refresh Seconds"
                value={refreshSecInput}
                onChange={(event) => setRefreshSecInput(event.target.value)}
              />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Use the Connect button in the Patient Information section.</p>
            {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
          </section>
        </aside>

        <main className="space-y-6">
          <section className="group rounded-3xl border border-slate-100 bg-white/70 backdrop-blur-2xl p-6 shadow-xl shadow-slate-200/50 transition-all duration-500 hover:shadow-2xl hover:shadow-slate-300/40 hover:-translate-y-1">
            <div className="flex items-center gap-3 mb-5">
              <User size={20} className="text-indigo-600" />
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-indigo-900">Patient Information</p>
            </div>
            <div className="flex flex-col md:flex-row gap-4 w-full">
              <input
                type="text"
                placeholder="Patient Name"
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                className="flex-1 border border-slate-200 bg-slate-50 rounded-xl px-4 py-3.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all duration-300 shadow-inner hover:bg-slate-100/50"
              />
              <input
                type="text"
                placeholder="Patient ID"
                value={patientDetails}
                onChange={(e) => setPatientDetails(e.target.value)}
                className="flex-1 border border-slate-200 bg-slate-50 rounded-xl px-4 py-3.5 text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:bg-white outline-none transition-all duration-300 shadow-inner hover:bg-slate-100/50"
              />
              <button
                onClick={handleConnect}
                disabled={!patientName.trim() || !patientDetails.trim()}
                className={`flex-none rounded-xl px-8 py-3.5 text-sm font-black tracking-wide uppercase text-white shadow-lg transition-all duration-300 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed ${isConnected ? "bg-slate-800 shadow-slate-200 hover:shadow-slate-300" : "bg-gradient-to-r from-indigo-600 to-blue-600 shadow-indigo-200 hover:shadow-indigo-300"
                  }`}
              >
                {isConnected ? "Stop Monitoring" : "Start Monitoring"}
              </button>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard
              title="Heart Rate"
              value={`${latestHr.toFixed(0)}`}
              unit="BPM"
              subtitle="Filtered + smoothed from Field 2"
              icon={<Activity size={24} />}
              progressColor={latestHr < DANGER_LIMITS.hrLow || latestHr > DANGER_LIMITS.hrHigh ? "bg-[#ff0055]" : "bg-[#00ff00]"}
              textColor={latestHr < DANGER_LIMITS.hrLow || latestHr > DANGER_LIMITS.hrHigh ? "text-[#ff0055]" : "text-[#00ff00]"}
              percent={latestHr ? Math.min(100, Math.max(0, ((latestHr - 40) / (140 - 40)) * 100)) : 0}
            />
            <MetricCard
              title="SpO2"
              value={`${latestSpo2.toFixed(0)}%`}
              unit="Oxygen Saturation"
              subtitle="Filtered + smoothed from Field 1"
              icon={<Droplets size={24} />}
              progressColor={latestSpo2 < DANGER_LIMITS.spo2Low ? "bg-[#ff0055]" : "bg-[#00ffff]"}
              textColor={latestSpo2 < DANGER_LIMITS.spo2Low ? "text-[#ff0055]" : "text-[#00ffff]"}
              percent={latestSpo2}
            />
            <MetricCard
              title="Body Temperature"
              value={latestTemp === null ? "--" : `${latestTemp.toFixed(1)}°`}
              unit="Celsius"
              subtitle="MATLAB converted + smoothed Field 3"
              icon={<Thermometer size={24} />}
              progressColor={latestTemp !== null && (latestTemp < DANGER_LIMITS.tempLow || latestTemp > DANGER_LIMITS.tempHigh) ? "bg-[#ff0055]" : "bg-emerald-400"}
              textColor={latestTemp !== null && (latestTemp < DANGER_LIMITS.tempLow || latestTemp > DANGER_LIMITS.tempHigh) ? "text-[#ff0055]" : "text-emerald-400"}
              percent={latestTemp === null ? 0 : Math.min(100, Math.max(0, ((latestTemp - 30) / (42 - 30)) * 100))}
            />
            <article className="relative overflow-hidden rounded-2xl border border-cyan-200 bg-gradient-to-br from-slate-900 via-slate-800 to-cyan-900 text-white shadow-sm p-6">
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-200">AI Recovery Score</p>
              <p className="mt-4 text-4xl font-black tracking-tight">{recoveryScore}<span className="text-lg font-bold text-cyan-200">/100</span></p>
              <p className="mt-2 text-sm font-semibold text-cyan-100">{recoveryBand}</p>
              <div className="mt-4 h-2 w-full rounded-full bg-white/20 overflow-hidden">
                <div className="h-full rounded-full bg-cyan-300" style={{ width: `${recoveryScore}%` }} />
              </div>
            </article>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <TrendCard
              title="Heart Rate"
              subTitle="Live trend • Field 2"
              options={hrOptions}
              series={hrSeries}
              type="area"
              height={235}
            />
            <TrendCard
              title="SpO2"
              subTitle="Live trend • Field 1"
              options={spo2Options}
              series={spo2Series}
              type="area"
              height={235}
            />
            <TrendCard
              title="Body Temperature"
              subTitle="Live trend • Field 3"
              options={tempOptions}
              series={tempSeries}
              type="area"
              height={235}
            />
            <TrendCard
              title="Combined Vitals"
              subTitle="SpO2 + BPM + Temp"
              options={combinedOptions}
              series={combinedSeries}
              type="area"
              height={235}
            />
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="text-sm font-extrabold uppercase tracking-[0.14em] text-slate-700">Alert Log</p>
              <p className="text-xs text-slate-500">{alertsToday} active alerts</p>
            </div>
            {activeAlerts.length ? (
              <ul className="space-y-2">
                {activeAlerts.map((alert, idx) => (
                  <li key={idx} className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
                    {alert}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">No alerts - all vitals are within normal range.</p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-300 bg-slate-100 p-4 md:p-5">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-700 mb-2">Critical Danger Thresholds (Fixed Clinical Defaults)</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm text-slate-800">
              <p className="rounded-lg border border-slate-300 bg-white px-3 py-2">SpO2 Danger: below {DANGER_LIMITS.spo2Low}%</p>
              <p className="rounded-lg border border-slate-300 bg-white px-3 py-2">HR Danger: below {DANGER_LIMITS.hrLow} or above {DANGER_LIMITS.hrHigh} BPM</p>
              <p className="rounded-lg border border-slate-300 bg-white px-3 py-2">Temp Danger: below {DANGER_LIMITS.tempLow} or above {DANGER_LIMITS.tempHigh} deg C</p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
};

export default App;

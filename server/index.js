import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log("Twilio integration active.");
  } catch (e) {
    console.error("Failed to initialize Twilio:", e);
  }
}

const app = express();
const PORT = Number(process.env.PORT || 4000);
const isDirectExecution = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

app.use(express.json());

const originalLog = console.log;
console.log = (...args) => {
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  originalLog(`[${timeStr}]`, ...args);
};

const CRITICAL_THRESHOLD_MS = 30000; // 30 seconds of continuous critical vitals before alert

// ─── Shared State ────────────────────────────────────────────────────
const SENSOR_API_KEY = process.env.SENSOR_API_KEY || "cardiac-monitor-2026-secret";
const DIRECT_FEED_BUFFER_SIZE = 30;
const DIRECT_DATA_TIMEOUT_MS = 60000; // Fallback to ThingSpeak after 60s of no direct data

const config = {
  channelId: process.env.THINGSPEAK_CHANNEL_ID || "3281642",
  readApiKey: process.env.THINGSPEAK_READ_API_KEY || "L3VW2XW8YKLYXPM1",
  patientName: "",
  lastAutoSosTime: 0,
  isMonitoring: false,
  isAlertSystemEnabled: true,
  criticalStartTime: null,
  activeCallSids: [],
  isCallLoopRunning: false,
  muteUntil: 0,
  // Cached latest vitals for WebSocket broadcast
  latestVitals: null,
  lastFeedTimestamp: null,
  // Direct sensor data state
  lastDirectDataTime: 0,        // Timestamp of last direct sensor POST
  isDirectMode: false,           // True when receiving direct sensor data
  directFeedBuffer: [],          // Rolling buffer of direct sensor readings (ThingSpeak format)
  isDeviceOffline: false,        // Start as false; let the timer determine offline status
};

// ─── JSON Backup File ────────────────────────────────────────────────
const BACKUP_FILE = path.join(__dirname, "sensor_backup.json");
const BACKUP_MAX_ENTRIES = 4320; // 24 hours at 2s intervals = 43200, keep 4320 (~2.4h at 2s)

const loadBackup = () => {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf-8"));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error("[BACKUP] Failed to load backup:", e.message);
  }
  return [];
};

const saveBackup = (entries) => {
  try {
    const trimmed = entries.slice(-BACKUP_MAX_ENTRIES);
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(trimmed), "utf-8");
  } catch (e) {
    console.error("[BACKUP] Failed to save backup:", e.message);
  }
};

// Debounced backup writer (write at most every 10 seconds)
let backupBuffer = loadBackup();
let backupDirty = false;
setInterval(() => {
  if (backupDirty) {
    saveBackup(backupBuffer);
    backupDirty = false;
  }
}, 10000);

const ALERT_THRESHOLDS = {
  spo2Low: 94,
  hrLow: 60,
  hrHigh: 100,
  tempHigh: 38.0,
};

const DANGER_LIMITS = {
  spo2Low: 90,
  hrLow: 50,
  hrHigh: 120,
  tempLow: 32,
  tempHigh: 39.0,
};

const isValidReadApiKey = (key) => /^[A-Za-z0-9]{16}$/.test(key);

const buildThingSpeakUrl = (channelId, readApiKey, results = 30) => {
  const base = `https://api.thingspeak.com/channels/${channelId}/feeds.json?results=${results}`;
  return readApiKey ? `${base}&api_key=${encodeURIComponent(readApiKey)}` : base;
};

// ─── WebSocket Management ────────────────────────────────────────────
let wss = null;
const wsClients = new Set();

const broadcastToClients = (data) => {
  const message = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (e) {
        console.error("[WS] Send error:", e.message);
      }
    }
  }
};

const setupWebSocket = (server) => {
  wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    console.log(`[WS] Client connected. Total: ${wsClients.size}`);

    // Send current state immediately on connect
    ws.send(JSON.stringify({
      type: "INIT_STATE",
      isMonitoring: config.isMonitoring,
      patientName: config.patientName,
      patientDetails: config.patientDetails,
      isAlertSystemEnabled: config.isAlertSystemEnabled,
      muteUntil: config.muteUntil,
      isServerSnoozed: Date.now() < config.muteUntil,
      criticalStartTime: config.criticalStartTime,
      criticalElapsedMs: config.criticalStartTime ? Date.now() - config.criticalStartTime : 0,
      latestVitals: config.latestVitals,
      callStatus: config.isCallLoopRunning ? "calling" : "idle",
      isDeviceOffline: config.isDeviceOffline,
    }));

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
    });

    ws.on("error", (err) => {
      console.error("[WS] Error:", err.message);
      wsClients.delete(ws);
    });
  });

  console.log("[WS] WebSocket server ready on /api/ws");
};

// ─── Temperature Conversion (same as frontend) ──────────────────────
const convertTemp = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed >= 20 && parsed <= 50) return Number(parsed.toFixed(1));
  if (parsed <= 0) return null;
  const voltage = parsed * (3.3 / 1023.0);
  if (voltage <= 0) return null;
  const resistance = ((3.3 - voltage) * 10000) / voltage;
  if (!Number.isFinite(resistance) || resistance <= 0) return null;
  const temp = 1.0 / (Math.log(resistance / 10000) / 3950 + 1.0 / (25 + 273.15)) - 273.15;
  return Number.isFinite(temp) ? Number(temp.toFixed(1)) : null;
};

// ─── Broadcast Alert State (called every second by timer) ────────────
const broadcastAlertState = () => {
  const now = Date.now();
  const criticalElapsedMs = config.criticalStartTime ? now - config.criticalStartTime : 0;
  const hasPersistedCritical = config.criticalStartTime && criticalElapsedMs >= CRITICAL_THRESHOLD_MS;

  broadcastToClients({
    type: "ALERT_STATE",
    criticalStartTime: config.criticalStartTime,
    criticalElapsedMs,
    hasPersistedCritical: !!hasPersistedCritical,
    isAlertSystemEnabled: config.isAlertSystemEnabled,
    muteUntil: config.muteUntil,
    isServerSnoozed: now < config.muteUntil,
    callStatus: config.isCallLoopRunning ? "calling" : "idle",
    isMonitoring: config.isMonitoring,
    isDeviceOffline: config.isDeviceOffline,
  });
};

// ─── 1-Second Precision Timer ────────────────────────────────────────
// This is the KEY FIX: a dedicated 1-second interval that checks the
// 2-minute threshold with high precision, independent of ThingSpeak polling.
let precisionTimerInterval = null;

const startPrecisionTimer = () => {
  if (precisionTimerInterval) return;

  precisionTimerInterval = setInterval(() => {
    const now = Date.now();

    // Hardware Offline Detection
    if (config.isMonitoring && config.lastFeedTimestamp) {
      const isOffline = (now - new Date(config.lastFeedTimestamp).getTime()) > 60000;
      if (isOffline && !config.isDeviceOffline) {
        console.log(`[MONITOR] 🔴 Device Offline (No data for >60s). Pausing SOS logic.`);
        config.isDeviceOffline = true;
      } else if (!isOffline && config.isDeviceOffline) {
        console.log(`[MONITOR] 🟢 Device Reconnected.`);
        config.isDeviceOffline = false;
      }
    }

    if (!config.criticalStartTime || !config.isMonitoring || !config.isAlertSystemEnabled) {
      broadcastAlertState();
      return;
    }

    const elapsedMs = now - config.criticalStartTime;

    // Broadcast state every second for precise countdown on frontend
    broadcastAlertState();

    // Check if threshold have elapsed — trigger calls (only if ONLINE)
    if (elapsedMs >= CRITICAL_THRESHOLD_MS && !config.isDeviceOffline) {
      if (now < config.muteUntil) return; // Snoozed

      if (!config.isCallLoopRunning) {
        console.log(`[TIMER] ✅ 2-minute threshold reached at exactly ${elapsedMs}ms. Triggering SOS calls.`);
        pollAndRetryCalls();
      }
    }
  }, 1000); // Every 1 second for precision

  console.log("[TIMER] Precision timer started (1s interval).");
};

// ─── Express Routes ──────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, channelId: config.channelId, hasReadApiKey: Boolean(config.readApiKey) });
});

app.post("/api/config", async (req, res) => {
  const { channelId, readApiKey } = req.body || {};

  if (!channelId || typeof channelId !== "string" || !/^\d+$/.test(channelId.trim())) {
    return res.status(400).json({ ok: false, error: "Channel ID must be numeric." });
  }

  if (!readApiKey || typeof readApiKey !== "string" || !isValidReadApiKey(readApiKey.trim())) {
    return res.status(400).json({
      ok: false,
      error: "Invalid Read API Key. Expected exactly 16 alphanumeric characters.",
    });
  }

  const cleanChannelId = channelId.trim();
  const cleanKey = readApiKey.trim();

  // --- Server-side secret comparison (primary gate) ---
  // If the server has a pre-configured authorized API key in .env,
  // the submitted key must match EXACTLY. This is the real authentication
  // for public ThingSpeak channels (which accept any key from ThingSpeak's side).
  const authorizedKey = process.env.THINGSPEAK_READ_API_KEY;
  const authorizedChannelId = process.env.THINGSPEAK_CHANNEL_ID;

  if (authorizedKey && cleanKey !== authorizedKey) {
    return res.status(401).json({ ok: false, error: "Authentication failed. The Read API Key is incorrect." });
  }
  if (authorizedChannelId && cleanChannelId !== authorizedChannelId) {
    return res.status(401).json({ ok: false, error: "Authentication failed. The Channel ID is incorrect." });
  }

  // --- ThingSpeak connectivity check (secondary gate) ---
  // Confirms the channel exists and the key works against ThingSpeak.
  // For PRIVATE channels, ThingSpeak also enforces the key here.
  try {
    const testUrl = `https://api.thingspeak.com/channels/${encodeURIComponent(cleanChannelId)}/feeds.json?results=1&api_key=${encodeURIComponent(cleanKey)}`;
    const tsResponse = await fetch(testUrl);

    if (tsResponse.status === 404) {
      return res.status(400).json({ ok: false, error: "Channel not found. Check your Channel ID." });
    }
    if (!tsResponse.ok) {
      return res.status(400).json({ ok: false, error: `ThingSpeak rejected the request (HTTP ${tsResponse.status}).` });
    }

    let tsData;
    try {
      tsData = await tsResponse.json();
    } catch {
      return res.status(400).json({ ok: false, error: "ThingSpeak returned unreadable data." });
    }

    // ThingSpeak signals auth failure with {"status":"0"} or {"error":"..."}
    if (tsData.status === "0" || tsData.error) {
      return res.status(401).json({ ok: false, error: "Authentication failed. Channel ID or Read API Key is incorrect." });
    }

    if (!tsData.channel) {
      return res.status(400).json({ ok: false, error: "Could not verify channel. Check your Channel ID and API Key." });
    }
  } catch {
    return res.status(503).json({ ok: false, error: "Could not reach ThingSpeak to verify credentials. Check your internet connection." });
  }

  config.channelId = cleanChannelId;
  config.readApiKey = cleanKey;
  config.patientName = (req.body.patientName || "Patient").trim();
  config.patientDetails = (req.body.patientDetails || "").trim();
  config.isMonitoring = true;
  config.criticalStartTime = null; // Reset persistence timer for new monitoring session
  config.latestVitals = null;
  config.lastFeedTimestamp = null;
  if (req.body.isAlertSystemEnabled !== undefined) {
    config.isAlertSystemEnabled = Boolean(req.body.isAlertSystemEnabled);
  }
  if (req.body.patientName) config.patientName = req.body.patientName.trim();
  if (req.body.patientDetails) config.patientDetails = req.body.patientDetails.trim();
  config.criticalStartTime = null; // Reset persistence timer for new monitoring session

  console.log(`Background Monitoring Activated for: ${config.patientName} (Channel: ${config.channelId}, Alerts: ${config.isAlertSystemEnabled ? "ON" : "OFF"})`);

  // Broadcast monitoring started
  broadcastToClients({
    type: "MONITORING_STARTED",
    patientName: config.patientName,
    isAlertSystemEnabled: config.isAlertSystemEnabled,
  });

  return res.json({
    ok: true,
    channelId: config.channelId,
    hasReadApiKey: true,
    isAlertSystemEnabled: config.isAlertSystemEnabled,
    muteUntil: config.muteUntil,
    isServerSnoozed: Date.now() < config.muteUntil
  });
});

app.post("/api/patient", (req, res) => {
  if (req.body.patientName !== undefined) config.patientName = req.body.patientName.trim();
  if (req.body.patientDetails !== undefined) config.patientDetails = req.body.patientDetails.trim();
  console.log(`[PATIENT] Info updated: ${config.patientName} (${config.patientDetails})`);
  res.json({ ok: true, patientName: config.patientName, patientDetails: config.patientDetails });
});

const cancelActiveCalls = () => {
  if (twilioClient && config.activeCallSids && config.activeCallSids.length > 0) {
    console.log(`[SOS] Canceling ${config.activeCallSids.length} active Twilio calls...`);
    config.activeCallSids.forEach(sid => {
      twilioClient.calls(sid).update({ status: 'canceled' })
        .catch(e => console.error(`[SOS] Failed to cancel call ${sid}:`, e.message));
    });
    config.activeCallSids = [];
  }
};

app.post("/api/alert-system/toggle", (req, res) => {
  if (req.body.enabled !== undefined) {
    config.isAlertSystemEnabled = Boolean(req.body.enabled);
  } else {
    config.isAlertSystemEnabled = !config.isAlertSystemEnabled;
  }

  // Reset critical timer when alerts are toggled off
  if (!config.isAlertSystemEnabled) {
    config.criticalStartTime = null;
    cancelActiveCalls();
  }

  console.log(`Global Alert System toggled to: ${config.isAlertSystemEnabled ? "ON" : "OFF"}`);
  broadcastAlertState(); // Push update immediately
  res.json({ ok: true, isAlertSystemEnabled: config.isAlertSystemEnabled });
});

app.post("/api/alert-system/snooze", (req, res) => {
  const { untilMs } = req.body;
  if (typeof untilMs === "number") {
    config.muteUntil = untilMs;
    cancelActiveCalls();
    const minutes = Math.round((untilMs - Date.now()) / 60000);
    console.log(`[SOS] ${config.patientName} snoozed. System muted for ${minutes} minutes (until ${new Date(untilMs).toLocaleTimeString()})`);
    broadcastAlertState(); // Push update immediately
    res.json({ ok: true, muteUntil: config.muteUntil });
  } else {
    res.status(400).json({ error: "Missing untilMs" });
  }
});

app.post("/api/stop", (req, res) => {
  config.isMonitoring = false;
  config.criticalStartTime = null; // Clear all alert state
  config.latestVitals = null;
  cancelActiveCalls();
  console.log(`Background Monitoring Deactivated by User.`);
  broadcastAlertState(); // Push update immediately
  broadcastToClients({ type: "MONITORING_STOPPED" });
  res.json({ ok: true, message: "Monitoring stopped." });
});

// ─── Twilio Voice SOS ────────────────────────────────────────────────
const triggerVoiceSOS = async (patientName, patientDetails) => {
  const doctorPhone = process.env.DOCTOR_PHONE;
  const caretakerPhone = process.env.CARETAKER_PHONE;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  // Only need twilioClient + fromPhone + at least one recipient
  const recipients = [];
  if (doctorPhone) recipients.push({ phone: doctorPhone, label: "Doctor" });
  if (caretakerPhone) recipients.push({ phone: caretakerPhone, label: "Caretaker" });

  if (twilioClient && fromPhone && recipients.length > 0) {
    try {
      const detailsSpeech = patientDetails ? `Patient ID ${patientDetails}.` : "";
      const twimlMessage = `<Response><Say voice="alice" language="en-US">Emergency Alert. Critical vitals detected for patient ${patientName}. ${detailsSpeech} Please check the dashboard immediately. Repeating. Emergency Alert. Critical vitals detected for patient ${patientName}. ${detailsSpeech} Please check the dashboard immediately.</Say><Pause length="2"/><Say voice="alice" language="en-US">This is an automated alert from the Cardiac Monitoring System. Please respond immediately.</Say></Response>`;

      const callOptions = {
        twiml: twimlMessage,
        from: fromPhone,
      };

      console.log(`[SOS] Dispatching calls to: ${recipients.map(r => r.label).join(", ")}...`);

      const results = await Promise.all(
        recipients.map(({ phone, label }) =>
          twilioClient.calls.create({ ...callOptions, to: phone })
            .then(call => {
              console.log(`[SOS] ✅ Call to ${label} (${phone}) initiated. SID: ${call.sid}`);
              return { sid: call.sid, recipient: label };
            })
            .catch(e => {
              console.error(`[SOS] ❌ Call to ${label} FAILED (code: ${e.code}): ${e.message}`);
              if (e.code === 21608) {
                console.error(`[SOS] ⚠️ TWILIO TRIAL: ${phone} is NOT verified. Go to https://www.twilio.com/console/phone-numbers/verified to add it.`);
              }
              return null;
            })
        )
      );

      const successful = results.filter(r => r !== null);
      const sids = successful.map(r => r.sid);

      if (successful.length > 0) {
        console.log(`[SOS] Voice dispatch complete. ${successful.length}/${recipients.length} calls successful.`);
        broadcastToClients({
          type: "CALL_DISPATCHED",
          recipients: successful.map(r => r.recipient),
          sids,
          timestamp: Date.now(),
        });
      } else {
        console.error(`[SOS] All calls failed! Check Twilio configuration.`);
      }

      return sids;
    } catch (error) {
      console.error("Critical error in triggerVoiceSOS:", error);
    }
  } else {
    const missing = [];
    if (!twilioClient) missing.push("twilioClient");
    if (!fromPhone) missing.push("TWILIO_PHONE_NUMBER");
    if (recipients.length === 0) missing.push("DOCTOR_PHONE or CARETAKER_PHONE");
    console.error(`[SOS] Cannot dispatch calls. Missing: ${missing.join(", ")}`);
  }
  return [];
};

const checkCallsFinished = async (sids) => {
  if (!twilioClient || !sids.length) return false;

  try {
    const statuses = await Promise.all(sids.map(sid =>
      twilioClient.calls(sid).fetch()
        .then(call => ({ status: call.status }))
        .catch(() => ({ status: 'unknown' }))
    ));

    const allFinished = statuses.every(s => ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(s.status));
    return allFinished;
  } catch (err) {
    console.error("Error checking call statuses:", err);
    return false;
  }
};

const pollAndRetryCalls = async () => {
  if (config.isCallLoopRunning) return;
  config.isCallLoopRunning = true;
  console.log(`[SOS] Starting high-frequency call status watcher (3s)...`);

  // Broadcast that calls are being made
  broadcastToClients({ type: "CALL_LOOP_STARTED" });

  const pollInterval = setInterval(async () => {
    const now = Date.now();

    // 1. Check if vitals stabilized or system was manually snoozed
    if (!config.criticalStartTime || now < config.muteUntil || !config.isMonitoring) {
      console.log(`[SOS] Vitals stabilized or system snoozed. Stopping call watcher.`);
      clearInterval(pollInterval);
      config.isCallLoopRunning = false;
      config.activeCallSids = [];
      broadcastToClients({ type: "CALL_LOOP_STOPPED", reason: "stabilized" });
      broadcastAlertState();
      return;
    }

    // 2. Check current call status
    if (config.activeCallSids.length > 0) {
      const allFinished = await checkCallsFinished(config.activeCallSids);

      if (allFinished) {
        console.log(`[SOS] Previous calls ended but patient is still in danger. Triggering IMMEDIATE retry...`);
        config.activeCallSids = await triggerVoiceSOS(config.patientName, config.patientDetails);
      }
      // If not finished (still ringing), just wait for next 3s poll
    } else {
      // No active calls yet, trigger them
      config.activeCallSids = await triggerVoiceSOS(config.patientName, config.patientDetails);
    }
  }, 3000); // Check every 3 seconds for immediate reaction
};

// ─── Critical Vitals Detection (shared by both direct and ThingSpeak) ──
const checkCriticalVitals = (spo2, hr, tempConverted) => {
  if (!config.isAlertSystemEnabled || !config.isMonitoring) {
    if (config.criticalStartTime) {
      config.criticalStartTime = null;
      broadcastAlertState();
    }
    return;
  }

  const isCritical =
    (Number.isFinite(spo2) && spo2 < DANGER_LIMITS.spo2Low) ||
    (Number.isFinite(hr) && (hr > DANGER_LIMITS.hrHigh || hr < DANGER_LIMITS.hrLow)) ||
    (Number.isFinite(tempConverted) && (tempConverted > DANGER_LIMITS.tempHigh || tempConverted < DANGER_LIMITS.tempLow));

  if (isCritical) {
    if (!config.criticalStartTime) {
      config.criticalStartTime = Date.now();
      console.log(`[MONITOR] ⚠️ Critical vitals detected for ${config.patientName}. Starting 2-minute precision timer...`);
      console.log(`[MONITOR]   SpO2: ${spo2}, HR: ${hr}, Temp: ${tempConverted}`);
      broadcastAlertState();
    }
  } else {
    if (config.criticalStartTime) {
      console.log(`[MONITOR] ✅ Vitals returned to normal for ${config.patientName}. Resetting persistence timer.`);
      config.criticalStartTime = null;
      broadcastAlertState();
    }
  }
};

// ─── Direct Sensor Data Endpoint ─────────────────────────────────────
// ESP8266 sends data here every 2 seconds, bypassing ThingSpeak entirely.
app.post("/api/sensor-data", (req, res) => {
  const { spo2, heartRate, temperature, apiKey } = req.body || {};

  // Authenticate
  if (apiKey !== SENSOR_API_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid API key" });
  }

  // Validate
  const parsedSpo2 = Number(spo2);
  const parsedHr = Number(heartRate);
  const parsedTemp = Number(temperature);

  if (!Number.isFinite(parsedSpo2) && !Number.isFinite(parsedHr) && !Number.isFinite(parsedTemp)) {
    return res.status(400).json({ ok: false, error: "At least one valid sensor value required" });
  }

  const now = Date.now();
  // ESP8266 already sends temperature in Celsius — use directly
  const tempValue = Number.isFinite(parsedTemp) ? Number(parsedTemp.toFixed(1)) : null;

  // Update state
  config.lastDirectDataTime = now;
  config.isDirectMode = true;
  config.latestVitals = {
    spo2: Number.isFinite(parsedSpo2) ? parsedSpo2 : null,
    hr: Number.isFinite(parsedHr) ? parsedHr : null,
    temp: tempValue,
  };
  config.lastFeedTimestamp = new Date(now).toISOString();

  // Build a ThingSpeak-compatible feed entry
  const feedEntry = {
    created_at: new Date(now).toISOString(),
    entry_id: config.directFeedBuffer.length + 1,
    field1: Number.isFinite(parsedSpo2) ? String(parsedSpo2) : null,
    field2: Number.isFinite(parsedHr) ? String(parsedHr) : null,
    field3: Number.isFinite(parsedTemp) ? String(parsedTemp) : null,
  };

  // Add to rolling buffer
  config.directFeedBuffer.push(feedEntry);
  if (config.directFeedBuffer.length > DIRECT_FEED_BUFFER_SIZE) {
    config.directFeedBuffer = config.directFeedBuffer.slice(-DIRECT_FEED_BUFFER_SIZE);
  }

  // Add to backup
  backupBuffer.push({ ...feedEntry, _ts: now });
  if (backupBuffer.length > BACKUP_MAX_ENTRIES) {
    backupBuffer = backupBuffer.slice(-BACKUP_MAX_ENTRIES);
  }
  backupDirty = true;

  // Broadcast to all WebSocket clients INSTANTLY (only if monitoring is ON)
  if (config.isMonitoring) {
    broadcastToClients({
      type: "FEED_UPDATE",
      feeds: config.directFeedBuffer,
      source: "direct",
      channelId: config.channelId,
      isAlertSystemEnabled: config.isAlertSystemEnabled,
      muteUntil: config.muteUntil,
      isServerSnoozed: now < config.muteUntil,
      latestVitals: config.latestVitals,
      timestamp: now,
    });
  }

  // Run critical vitals detection
  checkCriticalVitals(
    config.latestVitals.spo2,
    config.latestVitals.hr,
    config.latestVitals.temp
  );

  return res.json({ ok: true, timestamp: now });
});

// ─── Ping Endpoint (UptimeRobot keep-alive) ──────────────────────────
app.get("/api/ping", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    isDirectMode: config.isDirectMode,
    isMonitoring: config.isMonitoring,
    lastDirectDataTime: config.lastDirectDataTime,
  });
});

// ─── Backup Download Endpoint ────────────────────────────────────────
app.get("/api/backup", (_req, res) => {
  res.json({
    ok: true,
    entries: backupBuffer.length,
    data: backupBuffer,
  });
});

// ─── Background ThingSpeak Monitor (FALLBACK) ────────────────────────
// Only polls ThingSpeak when no direct sensor data is being received.
// When ESP8266 sends data directly, this is automatically disabled.
const startBackgroundMonitor = () => {
  setInterval(async () => {
    if (!config.isMonitoring || !config.channelId || !config.readApiKey) {
      return;
    }

    // Skip ThingSpeak polling if we're receiving direct sensor data
    const timeSinceDirectData = Date.now() - config.lastDirectDataTime;
    if (config.lastDirectDataTime > 0 && timeSinceDirectData < DIRECT_DATA_TIMEOUT_MS) {
      // Direct mode is active — no need to poll ThingSpeak
      if (!config.isDirectMode) {
        config.isDirectMode = true;
        console.log("[MONITOR] Direct sensor data active. ThingSpeak polling paused.");
      }
      return;
    }

    // If we were in direct mode but haven't received data, fall back
    if (config.isDirectMode && timeSinceDirectData >= DIRECT_DATA_TIMEOUT_MS) {
      config.isDirectMode = false;
      console.log("[MONITOR] No direct sensor data for 60s. Falling back to ThingSpeak polling.");
    }

    try {
      const url = `https://api.thingspeak.com/channels/${config.channelId}/feeds.json?results=30&api_key=${config.readApiKey}`;
      const response = await fetch(url);
      if (!response.ok) return;

      const data = await response.json();
      const feeds = data.feeds || [];
      if (!feeds.length) return;

      const latestFeed = feeds[feeds.length - 1];
      const feedTimestamp = latestFeed.created_at;

      // Parse latest vitals
      const spo2 = parseFloat(latestFeed.field1);
      const hr = parseFloat(latestFeed.field2);
      const tempConverted = convertTemp(latestFeed.field3);

      config.latestVitals = { spo2, hr, temp: tempConverted };
      config.lastFeedTimestamp = feedTimestamp;

      // Broadcast (only if monitoring is ON)
      if (config.isMonitoring) {
        broadcastToClients({
          type: "FEED_UPDATE",
          feeds: tsData.feeds,
          source: "thingspeak",
          channelId: config.channelId,
          isAlertSystemEnabled: config.isAlertSystemEnabled,
          isServerSnoozed: Date.now() < config.muteUntil,
          muteUntil: config.muteUntil,
          latestVitals: config.latestVitals,
          timestamp: Date.now(),
        });
      }

      // Critical vitals detection — only when NOT in direct mode
      // (prevents stale ThingSpeak data from resetting the critical timer
      //  set by real-time direct sensor data)
      if (!config.isDirectMode) {
        checkCriticalVitals(spo2, hr, tempConverted);
      }
    } catch (err) {
      console.error("Background Monitor Error:", err.message);
    }
  }, 1000); // Poll ThingSpeak every 1 second for fast alert detection
};

// Start both the background monitor and the precision timer
startBackgroundMonitor();
startPrecisionTimer();

// ─── Data Feeds (HTTP fallback for when WebSocket is not available) ──
app.get("/api/feeds", async (req, res) => {
  try {
    // If direct mode is active, serve from buffer instead of ThingSpeak
    if (config.isDirectMode && config.directFeedBuffer.length > 0) {
      return res.json({
        ok: true,
        channelId: config.channelId,
        feeds: config.directFeedBuffer,
        source: "direct",
        isAlertSystemEnabled: config.isAlertSystemEnabled,
        muteUntil: config.muteUntil,
        isServerSnoozed: Date.now() < config.muteUntil,
        criticalStartTime: config.criticalStartTime,
        criticalElapsedMs: config.criticalStartTime ? Date.now() - config.criticalStartTime : 0,
        hasPersistedCritical: config.criticalStartTime ? (Date.now() - config.criticalStartTime >= CRITICAL_THRESHOLD_MS) : false,
      });
    }

    const results = Number(req.query.results || 30);
    const safeResults = Number.isFinite(results) ? Math.min(Math.max(results, 1), 200) : 30;
    const url = buildThingSpeakUrl(config.channelId, config.readApiKey, safeResults);

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: "ThingSpeak request failed" });
    }

    const payload = await response.json();
    return res.json({
      ok: true,
      channelId: config.channelId,
      feeds: payload.feeds || [],
      source: "thingspeak",
      isAlertSystemEnabled: config.isAlertSystemEnabled,
      muteUntil: config.muteUntil,
      isServerSnoozed: Date.now() < config.muteUntil,
      criticalStartTime: config.criticalStartTime,
      criticalElapsedMs: config.criticalStartTime ? Date.now() - config.criticalStartTime : 0,
      hasPersistedCritical: config.criticalStartTime ? (Date.now() - config.criticalStartTime >= CRITICAL_THRESHOLD_MS) : false,
    });
  } catch {
    return res.status(500).json({ ok: false, error: "Server failed to fetch data" });
  }
});

app.post("/api/sos", async (req, res) => {
  const { patientName, patientDetails } = req.body || {};

  if (!patientName) {
    return res.status(400).json({ ok: false, error: "Patient name required for SOS." });
  }

  const doctorPhone = process.env.DOCTOR_PHONE;
  const caretakerPhone = process.env.CARETAKER_PHONE;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER;

  // Build recipient list (skip empty numbers)
  const recipients = [];
  if (doctorPhone) recipients.push({ phone: doctorPhone, label: "Doctor" });
  if (caretakerPhone) recipients.push({ phone: caretakerPhone, label: "Caretaker" });

  if (twilioClient && fromPhone && recipients.length > 0) {
    try {
      const twimlMessage = `<Response><Say voice="alice" language="en-US">Emergency Alert. Critical vitals detected for patient ${patientName}. Please check the dashboard immediately.</Say></Response>`;

      const results = await Promise.all(
        recipients.map(({ phone, label }) =>
          twilioClient.calls.create({ twiml: twimlMessage, to: phone, from: fromPhone })
            .then(call => ({ recipient: label, sid: call.sid, ok: true }))
            .catch(e => {
              if (e.code === 21608) console.error(`[TWILIO ERROR] Manual test for ${label} failed: ${phone} is unverified in your Trial account.`);
              return { recipient: label, error: e.message, code: e.code, ok: false };
            })
        )
      );

      console.log(`[SOS] Manual SOS Results for ${patientName}:`, results);

      return res.json({
        ok: true,
        message: "SOS Dispatch Attempted",
        results,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error("Twilio Call Error:", error);
      return res.status(500).json({ ok: false, error: "Twilio telephony error. Check logs." });
    }
  }

  // Fallback to Simulation if environment variables are not setup
  await new Promise(resolve => setTimeout(resolve, 1500));

  return res.json({
    ok: true,
    message: "SOS Dispatched Successfully (Simulated - Configure Twilio for actual Voice calls)",
    recipients: ["Doctor (+91-9876543210)", "Caretaker (+91-9988776655)"],
    timestamp: new Date().toISOString()
  });
});

app.post("/api/generate-ai-report", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "GEMINI_API_KEY is not configured in .env" });
  }

  const { channelId, readApiKey, patientName, patientDetails } = req.body || {};
  if (!channelId || !readApiKey) {
    return res.status(400).json({ ok: false, error: "Missing Channel ID or Read API Key" });
  }

  try {
    // 1. Fetch 1-week historical data from ThingSpeak (average per 60 minutes)
    const tsUrl = `https://api.thingspeak.com/channels/${channelId}/feeds.json?api_key=${readApiKey}&days=7&average=60`;
    const tsRes = await fetch(tsUrl);
    if (!tsRes.ok) throw new Error("Failed to fetch history from ThingSpeak");
    const tsData = await tsRes.json();
    const feeds = tsData.feeds || [];

    if (feeds.length === 0) {
      return res.status(400).json({ ok: false, error: "Not enough historical data to generate a report." });
    }

    // 2. Format data for the AI prompt
    let dataStr = "Timestamp | SpO2 (%) | Heart Rate (BPM) | Temperature (°C)\n";
    feeds.forEach(f => {
      if (f.field1 || f.field2 || f.field3) {
        dataStr += `${new Date(f.created_at).toLocaleString()} | ${f.field1 || "N/A"} | ${f.field2 || "N/A"} | ${f.field3 || "N/A"}\n`;
      }
    });

    const prompt = `You are an expert cardiologist analyzing data from an IoT continuous cardiac monitoring system.
Patient Name: ${patientName || "Unknown"}
Patient ID: ${patientDetails || "Unknown"}
Data timeframe: Last 7 days (1-hour averages).

Here is the data:
${dataStr}

Please provide a highly professional, structured medical analysis report. Include:
1. Patient Overview
2. SpO2 Analysis (Identify hypoxemia trends if any, SpO2 < 90 is critical)
3. Heart Rate Analysis (Identify tachycardia/bradycardia, normal resting is 60-100 BPM)
4. Temperature Analysis (Identify fever/hypothermia, normal is ~36.5-37.5°C)
5. Clinical Recommendations
Make it read like a formal hospital discharge or monitoring summary. Use Markdown formatting. Keep it concise but clinical.`;

    // 3. Call Gemini via REST using the latest flash alias (most reliable)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    const aiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
      })
    });

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      console.error("Gemini API Error:", errTxt);
      if (aiRes.status === 429) {
        throw new Error("Google Gemini API Free-Tier Quota Exceeded. Please wait 60 seconds and try again.");
      } else if (aiRes.status === 503) {
        throw new Error("Google Gemini is experiencing high demand. Please try again in a few moments.");
      }
      throw new Error(`Gemini API failed: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const aiText = aiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiText) throw new Error("Received empty response from AI");

    res.json({ ok: true, report: aiText });
  } catch (error) {
    console.error("[AI REPORT ERROR]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── Call Status Endpoint ────────────────────────────────────────────
app.get("/api/call-status", (_req, res) => {
  res.json({
    ok: true,
    isCallLoopRunning: config.isCallLoopRunning,
    activeCallSids: config.activeCallSids,
    criticalStartTime: config.criticalStartTime,
    criticalElapsedMs: config.criticalStartTime ? Date.now() - config.criticalStartTime : 0,
    hasPersistedCritical: config.criticalStartTime ? (Date.now() - config.criticalStartTime >= CRITICAL_THRESHOLD_MS) : false,
    muteUntil: config.muteUntil,
    isServerSnoozed: Date.now() < config.muteUntil,
  });
});

// ─── Server Startup ──────────────────────────────────────────────────
// Create HTTP server that both Express and WebSocket share
const httpServer = http.createServer(app);
setupWebSocket(httpServer);

if (isDirectExecution) {
  // In production: serve the built frontend from dist/
  const distPath = path.join(__dirname, "..", "dist");
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    // SPA fallback: serve index.html for any non-API route
    app.get("*all", (req, res) => {
      if (!req.path.startsWith("/api/")) {
        res.sendFile(path.join(distPath, "index.html"));
      }
    });
    console.log(`Serving frontend from ${distPath}`);
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Cardiac Monitor running on http://0.0.0.0:${PORT}`);
  });
}

// Export both the Express app and the HTTP server for vite.config.js
export { httpServer };
export default app;

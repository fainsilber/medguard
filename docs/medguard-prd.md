# Product Requirements Document (PRD)

## Project Overview

* **Product Name:** MedGuard PWA (Internal Working Name)
* **Target Audience:** Families and multi-caregiver households managing complex, rapidly changing medication protocols (specifically tailored for pediatric oncology and acute care).
* **Core Value Proposition:** Real-time multi-device sync, strict safety cooldown guards for as-needed (PRN) medications, automated inventory tracking, and full *halachic* compliance for Shabbat and Yom Tov operation.

---

## 1. System Architecture & Tech Stack

```
 ┌─────────────────────────────────────────────────────────────┐
 │                      Client Devices                         │
 │     [ Dad's Phone ]   [ Mom's Phone ]   [ Child's Device ]   │
 │                                                             │
 │  ┌──────────────────────────────────────────────────────┐  │
 │  │             Progressive Web App (PWA)                │  │
 │  │  • Vue.js / React Framework                          │  │
 │  │  • Dexie.js (IndexedDB local database)              │  │
 │  │  • Web Workers & HTML5 Audio API (Local Alarms)      │  │
 │  │  • Service Worker (Web Push & Offline Engine)        │  │
 │  └──────────────────────────┬───────────────────────────┘  │
 └─────────────────────────────┼───────────────────────────────┘
                               │
               WebSocket / REST│(Sync Outbox Queue)
                               ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                      Cloud Backend                          │
 │  • Node.js / Express or NestJS API Server                   │
 │  • PostgreSQL / MongoDB (Central Datastore)                 │
 │  • Redis + BullMQ (Scheduled Push Job Engine)               │
 │  • Web Push Protocol Engine (APNs & FCM Gateways)           │
 │  • @hebcal/core integration (Zmanim API integration)        │
 └─────────────────────────────────────────────────────────────┘

```

---

## 2. Core Functional Requirements

### 2.1 Multi-Caregiver Real-Time Synchronization

* **Shared Patient Profile:** Multiple accounts (e.g., Dad, Mom, Daughter) bind to a single primary Patient ID.
* **Instant State Broadcast:** Tapping `"Mark as Taken"`, `"Snooze"`, or logging a PRN dose broadcasts an update to all connected devices within 1.5 seconds via WebSockets.
* **Audit Logging:** Every log event explicitly records:
`timestamp`, `medicineId`, `doseGiven`, `loggedByUserId`, `deviceType`.
* **Conflict Resolution:** Append-only event streaming for intake logs. Inventory and schedules use Last-Write-Wins (LWW) with high-precision ISO-8601 timestamps.

---

### 2.2 Scheduled Regimens & Dynamic Protocol Changes

* **Flexible Schedules:** Supports daily, interval days (e.g., every 3 days), specific days of the week, or alternating daily doses (e.g., 50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat).
* **Rapid Protocol Edits:** Changing a dose or schedule updates future occurrences without corrupting or modifying past intake records.
* **Short-Term Tapering/Courses:** Ability to set start and end dates (e.g., a 5-day steroid course or 10-day antibiotic protocol).

---

### 2.3 As-Needed (PRN) Intake & Safety Guardrails

* **Cooldown Timers:** Configurable minimum time intervals between doses (e.g., minimum 4 hours between Ondansetron doses).
* **Visual Safety Status:**
* 🟢 **GREEN (Safe to Take):** Interval elapsed. Action button enabled.
* 🔴 **RED / LOCKED (Cooldown Active):** Time remaining is displayed (*"Locked: 1 hr 14 mins remaining"*). Button requires double confirmation with an explicit override warning if bypassed.


* **Daily Dose Caps:** Enforces a maximum quantity limit per 24-hour rolling window (e.g., max 4 doses in 24 hours).
* **Last-Administered Banner:** Displays who gave the last dose and when (*"Last given by Mom at 11:30 (500mg)"*).

---

### 2.4 Inventory Management & Automated Refill Alerts

* **Automatic Stock Deduction:** Every confirmed `"Taken"` log (scheduled or PRN) automatically decrements the respective item in `Inventory`.
* **Low-Stock Alert Thresholds:** Configurable pill/unit thresholds trigger low-stock notifications across all caregiver devices (*"Mercaptopurine: 5 pills remaining — order refill"*).
* **Manual Stock Adjustments:** Ability to log manual stock replenishments or lost/dropped pill adjustments.

---

### 2.5 Shabbat & Yom Tov Autonomous Mode

* **Automated Schedule Ingress/Egress:** Integrates `@hebcal/core` (or Hebcal REST API) using location coordinates to automatically calculate Shabbat/Yom Tov candle-lighting and Havdalah times. Automatically activates Shabbat Mode 18 minutes prior to sunset on Friday/Erev Chag and deactivates after Havdalah.
* **Non-Interactive :**
* **Self-Timing Audio Reminders:** Plays a gentle audio chime for a pre-configured time (e.g., 30–60 seconds) and **automatically stops without requiring user interaction**.
* **Suppression of Caregiver Escalation:** Escalation push alerts for missed doses are automatically paused on Shabbat.
* **Motzei Shabbat Reconciliation Sheet:** Upon Havdalah, the app displays a bulk confirmation interface listing all scheduled doses that occurred during Shabbat/Yom Tov, allowing a single-tap confirmation for all doses taken, plus quick additions for any PRN meds given over Shabbat.

---

## 3. Local Dexie.js (IndexedDB) Database Schema

```javascript
import Dexie from 'dexie';

export const db = new Dexie('MedGuardDB');

db.version(1).stores({
  medicines: 'id, patientId, name, type, syncStatus, updatedAt',
  schedules: 'id, medicineId, patientId, active, syncStatus, updatedAt',
  intakeLogs: 'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus',
  inventory: 'id, medicineId, syncStatus, updatedAt',
  shabbatConfig: 'id, patientId, autoShabbatEnabled, lat, long',
  syncOutbox: '++id, table, entityId, action, createdAt'
});

```

### Type Definitions

```typescript
export interface Medicine {
  id: string; // UUID v4
  patientId: string;
  name: string; // e.g., "Mercaptopurine"
  strength: string; // e.g., "50mg"
  form: 'pill' | 'liquid' | 'injection' | 'topical' | 'other';
  minHoursBetweenDoses?: number; // PRN Cooldown
  maxDailyDoses?: number; // Safety Cap
  instructions?: string; // e.g., "Take on an empty stomach"
  updatedAt: string; // ISO 8601
  syncStatus: 'synced' | 'pending';
}

export interface Schedule {
  id: string;
  medicineId: string;
  patientId: string;
  frequencyType: 'daily' | 'interval_days' | 'specific_days';
  intervalDays?: number;
  daysOfWeek?: number[]; // [0 = Sun, ..., 6 = Sat]
  timesOfDay: string[]; // e.g., ["08:00", "20:00"]
  dosageQuantity: number;
  startDate: string; // YYYY-MM-DD
  endDate?: string;
  active: boolean;
  updatedAt: string;
  syncStatus: 'synced' | 'pending';
}

export interface IntakeLog {
  id: string;
  patientId: string;
  medicineId: string;
  scheduleId?: string; // Null if PRN
  type: 'scheduled' | 'prn';
  status: 'taken' | 'skipped' | 'missed' | 'pending_shabbat';
  scheduledTime?: string; // ISO 8601
  actualTime: string; // ISO 8601
  quantityTaken: number;
  loggedByUserId: string; // ID of Dad, Mom, or Daughter
  notes?: string;
  syncStatus: 'synced' | 'pending';
}

export interface Inventory {
  id: string;
  medicineId: string;
  currentQuantity: number;
  refillThreshold: number;
  unitName: string; // e.g., "pills", "ml"
  lastRefilledAt?: string;
  updatedAt: string;
  syncStatus: 'synced' | 'pending';
}

export interface ShabbatConfig {
  id: string;
  patientId: string;
  autoShabbatEnabled: boolean;
  latitude: number;
  longitude: number;
  candleLightingOffsetMins: number; // Default: 18
  havdalahDegreesOrMins: string; // e.g., "8.5_degrees" or "50_mins"
  chimeDurationSeconds: number; // Default: 45
  displayStayOnMins: number; // Default: 30
}

```

---

## 4. Alarm & Web Push Technical Execution Matrix

| Context | Device State | Mechanism Triggered | User/System Action |
| --- | --- | --- | --- |
| **Standard Mode** | App Open / Active | Web Worker + HTML5 Audio + Banner Notification | Click *"Mark as Taken"* or *"Snooze 15m"* (Syncs to all devices). |
| **Standard Mode** | App Background / Locked | Server Web Push (VAPID via FCM/APNs) | Lock screen action buttons (*"Taken"*, *"Snooze"*). |
| **Standard Mode** | Unacknowledged after 15m (configurable) | Server Escalation Job | High-priority push sent to all linked caregiver devices. |
| **Shabbat Mode** | App Background / Screen Off | Local Scheduled Service Worker | Chime rings 45s and auto-stops. No touch required. |
| **Shabbat Mode** | Post-Shabbat (Havdalah) | App Event Trigger | Screen opens Motzei Shabbat Reconciliation Sheet for bulk logs. |

---

## 5. Phased Milestone Implementation Plan

```
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: Core Offline PWA & Dexie Engine                  │
│  • PWA Setup (Manifest, Service Worker)                     │
│  • Dexie.js Schema & Local Database Layer                   │
│  • CRUD for Medicines, Schedules, PRN Logs, and Inventory   │
├─────────────────────────────────────────────────────────────┤
│  Phase 2: Live Synchronization & Caregiver Backend         │
│  • Node.js + WebSocket Server Implementation               │
│  • Cloud Sync Outbox queue listener & conflict handling     │
│  • Caregiver binding (1 Patient -> N Caregivers)            │
├─────────────────────────────────────────────────────────────┤
│  Phase 3: Hybrid Alarms, Escalation & Web Push             │
│  • Local Web Worker timer engine                            │
│  • VAPID Web Push implementation via BullMQ queue           │
│  • Caregiver missed-dose escalation protocol               │
├─────────────────────────────────────────────────────────────┤
│  Phase 4: Shabbat & Yom Tov Automation                     │
│  • @hebcal/core integration for Zmanim calculation          │
│  • Screen Wake Lock & Auto-off Audio Chime Engine           │
│  • Motzei Shabbat Reconciliation UI Sheet                   │
└─────────────────────────────────────────────────────────────┘

```
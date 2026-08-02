# Product Requirements Document (PRD) — Version 2.0

## Project Overview

* **Product Name:** MedGuard PWA
* **Target Audience:** Multi-caregiver households managing complex, rapidly changing medication protocols (tailored for pediatric oncology and acute care).
* **Core Value Proposition:** Real-time multi-device sync, strict safety cooldown guards for as-needed (PRN) medications, automated inventory tracking, zero-cost cloud deployment, and full *halachic* compliance for Shabbat and Yom Tov operation.

---

## 1. System Architecture & Tech Stack

The architecture leverages a **local-first PWA** synced against a **Cloudflare Workers serverless backend** running entirely within Cloudflare’s free tier.

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                            Client Devices                                   │
 │            [ Dad's Phone ]   [ Mom's Phone ]   [ Child's Phone ]            │
 │                                                                             │
 │  ┌──────────────────────────────────────────────────────────────────────┐  │
 │  │                     Progressive Web App (PWA)                        │  │
 │  │  • React 18 + Vite + TypeScript + Tailwind CSS                       │  │
 │  │  • Dexie.js (IndexedDB local database & offline engine)             │  │
 │  │  • Web Workers & HTML5 Audio API (Local Alarms & Shabbat Chimes)     │  │
 │  │  • Service Worker (Web Push & Offline Engine)                        │  │
 │  └──────────────────────────────────┬───────────────────────────────────┘  │
 └─────────────────────────────────────┼───────────────────────────────────────┘
                                       │
                   WebSocket / HTTP    │ (Sync Outbox Queue)
                                       ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                    Cloudflare Serverless Infrastructure                     │
 │  • Hono Framework (API Gateway running on Cloudflare Workers)              │
 │  • Cloudflare D1 (Serverless SQLite central datastore)                     │
 │  • Durable Objects (Stateful real-time WebSocket sync engine per household) │
 │  • Durable Object Alarms (Scheduled Web Push jobs & missed-dose escalation) │
 │  • Web Push Protocol Engine (VAPID via FCM / APNs gateways)                 │
 │  • @hebcal/core (Location-based Zmanim calculations inside Worker)          │
 └─────────────────────────────────────────────────────────────────────────────┘

```

### Key Architectural Decisions Matrix

| Decision Area | Selected Technology | Technical Rationale & Trade-offs |
| --- | --- | --- |
| **Frontend Stack** | **React 18 + Vite + TS + Tailwind** | Zero learning curve, fast builds, excellent PWA/Dexie integration. |
| **Backend Framework** | **Hono on Cloudflare Workers** | Replaces Express/NestJS. Ultra-lightweight router built specifically for edge V8 isolates. |
| **Central Datastore** | **Cloudflare D1 (SQLite)** | Replaces Postgres/MongoDB. 5 GB storage and 5M daily reads on free tier—more than enough for a household. |
| **Real-time Sync** | **Cloudflare Durable Objects** | One Durable Object instance per household manages WebSocket connections and strongly consistent sync. |
| **Scheduled Jobs** | **Durable Object Alarms** | Replaces Redis + BullMQ. Native scheduled alarms fire callbacks to trigger Web Push notifications. |
| **Hosting & Deployment** | **Cloudflare Pages + Workers** | 100% free hosting for client app (Pages) and backend edge services (Workers). |
| **Authentication** | **Magic Link + Device Token + Household Join Code** | Frictionless 3 AM usage—no complex passwords for parents to remember or reset. |
| **Household Timezone** | **Fixed Household Timezone** | Stored in system config with device-local time used purely for UI display. Prevents travel bugs. |

---

## 2. Core Functional Requirements

### 2.1 Multi-Caregiver Real-Time Synchronization

* **Single Active Household Scope:** A household group connects caregivers (Dad, Mom) to manage a patient profile without role switcher overhead in v1.
* **Instant State Broadcast:** Tapping `"Mark as Taken"`, `"Snooze"`, or logging a PRN dose broadcasts an update to all connected devices within 1.5 seconds via Cloudflare Durable Objects.
* **Audit Trail:** Every log event records: `timestamp`, `medicineId`, `doseGiven`, `loggedByUserId`, `deviceType`.
* **Conflict Resolution:** Client-side Dexie.js appends local log events to a `syncOutbox` queue. The server processes these using Last-Write-Wins (LWW) with high-precision ISO-8601 timestamps.

### 2.2 Scheduled Regimens & Dynamic Protocol Changes

* **Flexible Schedules:** Supports daily, interval days (e.g., every 3 days), specific days of the week, or alternating daily doses (e.g., 50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat).
* **Rapid Protocol Edits:** Modifying a dose updates future scheduled events without mutating historical intake logs.
* **Short-Term Courses:** Supports defined start and end dates (e.g., 5-day steroid tapers or 10-day antibiotic courses).

### 2.3 As-Needed (PRN) Intake & Safety Guardrails

* **Cooldown Timers:** Enforces minimum time intervals between doses (e.g., minimum 4 hours between Ondansetron doses).
* **Visual Safety Status:**
* 🟢 **GREEN (Safe to Take):** Cooldown elapsed. Action enabled.
* 🔴 **RED / LOCKED (Cooldown Active):** Time remaining is displayed (*"Locked: 1 hr 14 mins remaining"*). Manual override requires double-confirmation.


* **Daily Dose Caps:** Enforces a maximum quantity cap per rolling 24-hour window (e.g., max 4 doses in 24 hours).
* **Last-Administered Banner:** Displays who gave the last dose and when (*"Last given by Mom at 11:30 (500mg)"*).

### 2.4 Inventory Management & Automated Refill Alerts

* **Automatic Stock Deduction:** Every confirmed `"Taken"` log (scheduled or PRN) decrements `Inventory` in Dexie and syncs to D1.
* **Low-Stock Alert Thresholds:** Configurable low-stock thresholds trigger notifications across all caregiver devices (*"Mercaptopurine: 5 pills remaining — order refill"*).
* **Manual Stock Adjustments:** Quick override tools for logging manual replenishments or lost pills.

---

## 3. Shabbat & Yom Tov Automation (Simplified Flow)

To keep the system reliable and lightweight, Shabbat Mode operates without screen wake-locks or interactive popups, allowing devices to remain entirely non-interactive throughout Shabbat.

```
                  [ 14:00 Dose Time Reached ]
                               │
             ┌─────────────────┴─────────────────┐
             ▼                                   ▼
   [ Audio Chime Rings ]               [ Server Status Update ]
   (Auto-stops after 45s)              • Set to "Pending Shabbat"
   • No screen wake required           • Pause Missed-Dose Push
   • No touch required                 • Pause Caregiver Escalation
             │                                   │
             └─────────────────┬─────────────────┘
                               ▼
            ┌────────────────────────────────────┐
            │ Post-Shabbat (Motzei Shabbat)      │
            │ Opens Reconciliation Sheet         │
            │ for bulk dose confirmation         │
            └────────────────────────────────────┘

```

* **Automated Schedule Ingress/Egress:** Uses `@hebcal/core` inside Cloudflare Workers to calculate Shabbat/Yom Tov times from household coordinates. Automatically enables Shabbat Mode 18 minutes before sunset on Friday/Erev Chag and disables it after Havdalah.
* **Passive Audio Chime:** Plays a gentle, distinct audio chime via Web Workers for a configurable duration (default: 45 seconds) and **automatically stops without requiring user interaction**.
* **Screen Display:** The device screen remains in its current state (off or locked). No touch interactions, wake-locks, or lockscreen prompts are triggered.
* **Suppression of Caregiver Escalation:** Missed-dose push notifications and escalation alerts are paused during Shabbat.
* **Motzei Shabbat Reconciliation Sheet:** After Havdalah, the app opens a bulk reconciliation screen so caregivers can confirm scheduled doses with one tap and retroactively log any PRN medications given during Shabbat.

---

## 4. Alarm & Web Push Technical Execution Matrix

| Context | Device State | Mechanism Triggered | User / System Action |
| --- | --- | --- | --- |
| **Standard Mode** | App Open / Active | Web Worker + HTML5 Audio + Banner Notification | Click *"Mark as Taken"* or *"Snooze 15m"* (Syncs to all devices via Durable Object). |
| **Standard Mode** | App Background / Locked | Server Web Push (VAPID via FCM/APNs) | Lock screen action buttons (*"Taken"*, *"Snooze"*). |
| **Standard Mode** | Unacknowledged after 15m (configurable) | Durable Object Alarm Escalation Job | High-priority push sent to all linked caregiver devices. |
| **Shabbat Mode** | App Background / Screen Off | Local Scheduled Service Worker / Web Worker | Audio chime rings for 45s and auto-stops. No touch required. |
| **Shabbat Mode** | Post-Shabbat (Havdalah) | App Event Trigger | Screen displays Motzei Shabbat Reconciliation Sheet for bulk logging. |

---

## 5. Local Dexie.js Database Schema

```typescript
import Dexie, { Table } from 'dexie';

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
  loggedByUserId: string; // ID of Dad or Mom
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
}

export interface SyncOutbox {
  id?: number; // Auto-incremented local ID
  table: 'medicines' | 'schedules' | 'intakeLogs' | 'inventory';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: object;
  createdAt: string;
}

export class MedGuardDB extends Dexie {
  medicines!: Table<Medicine>;
  schedules!: Table<Schedule>;
  intakeLogs!: Table<IntakeLog>;
  inventory!: Table<Inventory>;
  shabbatConfig!: Table<ShabbatConfig>;
  syncOutbox!: Table<SyncOutbox>;

  constructor() {
    super('MedGuardDB');
    this.version(1).stores({
      medicines: 'id, patientId, name, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, syncStatus, updatedAt',
      intakeLogs: 'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus',
      inventory: 'id, medicineId, syncStatus, updatedAt',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt'
    });
  }
}

export const db = new MedGuardDB();

```

---

## 6. Phased Implementation Plan

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Phase 1: Core Offline PWA & Dexie Engine                                   │
│  • Vite + React + Tailwind + PWA setup (Manifest, Service Worker)           │
│  • Dexie.js Schema & Local Database Layer                                   │
│  • Full CRUD for Medicines, Schedules, PRN Logs, and Inventory              │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 2: Live Synchronization & Cloudflare Backend                         │
│  • Hono API Server on Cloudflare Workers + D1 database bindings             │
│  • Cloudflare Durable Objects real-time WebSocket sync channel              │
│  • Outbox sync engine listener with Last-Write-Wins conflict handling       │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 3: Hybrid Alarms, Escalation & Web Push                              │
│  • Local Web Worker timer engine for foreground alerts                      │
│  • Durable Object Alarms for scheduled Web Push notifications               │
│  • 15-minute unacknowledged dose caregiver escalation push protocol         │
├─────────────────────────────────────────────────────────────────────────────┤
│  Phase 4: Shabbat & Yom Tov Automation                                      │
│  • @hebcal/core integration for Zmanim calculation in Workers               │
│  • Audio Chime Engine with 45-second auto-stop (no screen wake)             │
│  • Motzei Shabbat Reconciliation UI Sheet for post-Shabbat bulk logging     │
└─────────────────────────────────────────────────────────────────────────────┘

```
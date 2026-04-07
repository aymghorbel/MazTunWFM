────────────────────────────────────────────────────────────────────────────────
INTEGRATION TASK – Append ERP Duty Rotation Module to the
Mazarine Energy Workforce Management Platform
────────────────────────────────────────────────────────────────────────────────

## CONTEXT

You are working on a production React SPA: the **Mazarine Energy Workforce
Management Platform**. This is a single large JSX file (or component tree)
that already contains the following modules accessible from a dark sidebar:

  • Dashboard      – KPI cards, Recharts graphs, field rotation today, leave today
  • Timesheet      – Monthly table, project/activity % slices, submit/recall workflow
  • Schedule       – Field rotation calendar (ON/OFF/EXTRA), weekend accrual markers
  • Requests       – 9 request types, half-day AM/PM, approval routing
  • Balances       – Leave buckets, site accrual rules, team overview
  • HR Reports     – Attendance, leave summary, TS compliance
  • Analytics      – Hours by dept, project allocation pie, budget cards
  • Org Chart      – Interactive tree with RBAC highlight
  • Settings       – Users/RBAC CRUD, rotation plans, projects, activities

**Design system already in use:**
  • Font:    DM Sans (UI), JetBrains Mono (data/numbers)
  • Sidebar: dark navy (#0F1621 or similar), Mazarine orange accent (#E8750A)
  • Cards:   white (#FFFFFF), border #E2E8F0, border-radius 12–14px
  • Background: #F0F2F5
  • Status dots: blue=Office, green=On Site, gray=Off, amber=Field
  • Buttons: orange primary, ghost, outline, danger variants
  • Active nav indicator: orange left border strip + highlighted text


## OBJECTIVE

Add a new top-level module called **"ERP Duty Rota"** to the platform.
It must integrate natively — same sidebar, same component patterns, same
design tokens — rather than being embedded as an iframe or separate page.

The module contains five sub-sections (rendered as inner tab nav):

  1. Dashboard   – Current week duty overview + live status board
  2. Rotation    – Week planner (CRUD weeks, assign members to roles)
  3. Members     – ERP roster with status management
  4. Notify      – Notification composer + emergency broadcast + history
  5. Settings    – Backend URL, SMTP, Twilio, cron schedule config


────────────────────────────────────────────────────────────────────────────────
## STEP 1 — SIDEBAR INTEGRATION
────────────────────────────────────────────────────────────────────────────────

Add the "ERP Duty Rota" entry to the existing sidebar NAV array.
Place it AFTER "Schedule" and BEFORE "Requests" (it relates to operational
rotation, which is adjacent to field schedule).

  Icon:  🔄  (or a shield/emergency icon if the platform uses lucide-react)
  Label: "ERP Duty Rota"
  Key:   "erp_rota"

Do NOT add a separate sidebar section header. It is a peer module.

If the platform has a notification badge system on nav items, add a badge
that shows the number of days until the next rotation handover (Friday EOB).
Example: badge "3d" when 3 days remain. Compute it via:
  const daysUntilFriday = () => { const d = new Date().getDay(); const diff = (5-d+7)%7; return diff===0?7:diff; }


────────────────────────────────────────────────────────────────────────────────
## STEP 2 — DATA MODEL & SHARED STATE
────────────────────────────────────────────────────────────────────────────────

### ERP Members
The ERP members list is a SUBSET of the platform's existing user roster.
Do NOT create a separate, disconnected member store.

Instead:
  a) Read the existing `users` array (from the platform's state/context).
  b) Add an `erpRole` field to the user object (optional, string):
       e.g. "Crisis Management Coordinator", "Field Manager (CPF)", "DSV", "Media", "Reporting Team"
  c) Add a `currentStatus` field (or reuse existing availability/status):
       values: "OFFICE" | "ON_SITE" | "OFF" | "FIELD"
  d) Pre-populate the following 13 members from the existing Mazarine roster
     (add them to the seed users if not already present):

     ID    Name                    Function                      ERP Role                            Phone        Status
     RL    Renaud Laneyrie         Country Manager               Crisis Management Coordinator       29 902 442   OFFICE
     ABA   Afif BelHaj Ali         Drilling Superintendent        Drilling Crisis Coordinator         29 371 944   OFFICE
     AH    Amine Hamza             Production & Projects Mgr      Crisis Management Coordinator       29 696 780   OFFICE
     MhH   Mehdi Hajji             Field Manager                  Field Manager (CPF)                 29 683 812   ON
     MAA   Med Amine Abdelkefi     Field Manager                  Field Manager (CPF)                 27 655 544   ON_SITE
     AN    Arbi Noura              DSV                            DSV                                 29 526 207   OFF
     HM    Hamid Messalti          DSV (Drilling)                 DSV                                 —            ON_SITE
     MH    Mohamed Hamda           Finance Manager                Media                               28 476 039   OFFICE
     IN    Iman Nahlaoui           HR & Communications Mgr        Reporting Team                      25 457 777   OFF
     CB    Chourouk Bouchkara      Legal & Contracts Coord.       Reporting Team                      29 696 213   OFFICE
     MrH   Mariem Hached           Drilling Engineer              Reporting Team                      29 683 810   OFFICE
     AS    Aymen Saddoud           Drilling Engineer              Reporting Team                      29 902 435   OFFICE
     MR    Mariam Rafaoui          Office Administrator           Reporting Team                      29 697 641   OFFICE

### Rotation Weeks
Store in a dedicated `rotationWeeks` state array, separate from existing
schedule/rotation logic (which manages field ON/OFF cycles, not ERP duty).
Persist to localStorage key "maz_erp_weeks".

Pre-load these two weeks from the current bi-weekly plan:
  Week #1:  2026-03-28 → 2026-04-03
    crisisCoord: "RL", drillingCrisisCoord: null,
    cpfContact: "MAA", drillingContact: "HM", media: "MH"

  Week #2:  2026-04-04 → 2026-04-10
    crisisCoord: "AH", drillingCrisisCoord: "ABA",
    cpfContact: "MhH", drillingContact: "AN", media: "MH"

### Notification Log
Separate array, persisted to localStorage key "maz_erp_notif_log".

### Settings
Persist to localStorage key "maz_erp_settings":
  { backendUrl: "http://localhost:3001", reminderDay: "thursday",
    reminderChannel: "email", smtpHost:"", smtpUser:"", smtpPass:"",
    twilioSid:"", twilioToken:"", twilioFrom:"", twilioWa:"" }


────────────────────────────────────────────────────────────────────────────────
## STEP 3 — ACCESS CONTROL (RBAC)
────────────────────────────────────────────────────────────────────────────────

The platform has roles: Admin, HR Manager, Operations Manager, Field Manager,
Employee, Finance, and similar.

Apply these rules to the ERP Duty Rota module:

  VIEW module          : Admin, Operations Manager, HR Manager, Field Manager
  EDIT rotation weeks  : Admin, HR Manager  (write-protect for others)
  EDIT member status   : Admin, HR Manager, Operations Manager
  ADD/DELETE members   : Admin, HR Manager
  SEND notifications   : Admin, HR Manager, Operations Manager
  SEND emergency alert : Admin, Operations Manager
  VIEW notifications   : all roles with module access
  EDIT settings        : Admin only

Use the platform's existing `currentUser.role` check pattern.
Show a lock icon 🔒 with a "Read-only" badge for restricted sections rather
than hiding them entirely, so users know the features exist.


────────────────────────────────────────────────────────────────────────────────
## STEP 4 — MODULE LAYOUT & COMPONENT SPEC
────────────────────────────────────────────────────────────────────────────────

The module renders inside the existing main content area (right of sidebar).

**Top bar:** Reuse the platform's existing TopBar pattern.
  Title:    "ERP Duty Rota"
  Subtitle: "Mazarine Energy Tunisia – Oum Chiah CPF"
  Right:    Date (JetBrains Mono) + avatar strip of active ERP members (max 6)

**Inner tab strip** (below top bar, above content):
  [ 📊 Dashboard | 🔄 Rotation | 👥 Members | 🔔 Notify | ⚙️ Settings ]
  Style: pill tabs on a #F0F2F5 background, white active pill, same pattern
  as any existing inner tab nav in the platform.

**Sub-section: Dashboard**
  Row 1 — 4 KPI cards (reuse platform's KPI card component if one exists):
    • Active Personnel  (count, green)
    • On Site / Field   (count, amber)
    • Off Duty          (count, gray)
    • Days to Handover  (integer, orange)  ← uses daysUntilFriday()

  Row 2 — 2-column grid:
    Left (wider): Current Duty Rotation card
      - Header: week label + date range + "ACTIVE" badge
      - 5 duty slot rows (🎯 Crisis Coord / ⛏️ Drilling Crisis / 🏭 CPF /
        🔩 Drilling Site / 📡 Media), each showing:
          slot icon | slot label | avatar + name + status badge | phone link
      - Critical slots (first two) have amber-tinted background
      - Unassigned slots show red "⚠ Not assigned" warning
    Right: Personnel Status board (scrollable list of all ERP members:
      avatar + name + function + status badge)

  Row 3 — Emergency strip:
    Dark red gradient banner. Left: "Emergency Line" label + "29 324 484" in
    JetBrains Mono large. Right: "🚨 Broadcast Alert" button that navigates
    to the Notify sub-tab.

**Sub-section: Rotation** (week planner)
  - "Add Week" button (Admin/HR only, locked otherwise)
  - Week cards: label, date range, 5 role assignment chips (show avatar+name
    or "Unassigned" in red), Edit/Delete actions (Admin/HR only)
  - Edit modal: 3-col header (label, start date, end date) + 5 select dropdowns
    (one per duty slot, options = ERP member list)
  - Active week card has 2px orange border

**Sub-section: Members** (ERP roster)
  - Search bar + status filter pills (All / Office / On Site / Off)
  - Member cards (3-col grid): avatar | name + function + ERP role | status
    badge | note chip (amber) | phone/email | "Update Status" + Edit + Delete
  - "Update Status" cycles through OFFICE→ON→ON_SITE→OFF→FIELD
  - Add/Edit modal: full name, ID/initials, function, ERP role, phone, email,
    status select, color picker, notes
  - Reuse platform's existing modal/overlay component

**Sub-section: Notify**
  - Sub-sub tabs: "✉ Compose" | "📋 History"
  - Emergency Broadcast button (top-right, red gradient, prominent)
  - Compose: type select (3 templates) + channel select (Email/SMS/WhatsApp/All)
    + recipients select + message preview (read-only, JetBrains Mono)
    + Send button
  - Quick actions panel: 3 preset shortcut buttons
  - Active recipients list: avatar + name + phone
  - History: log rows with icon, subject, metadata (channel · count · time),
    status pill (sent / simulated)
  - Emergency modal: confirm dialog with red styling, member count, hotline,
    Cancel + "Send Now" buttons

**Sub-section: Settings** (Admin only, locked for others)
  - 4 cards in 2-col grid: Backend Connection, Email SMTP, Twilio, Schedule
  - Backend card has "Test Connection" button → GET /api/health
  - Setup guide card at bottom (numbered steps, monospace code snippets)
  - Danger zone card: "Reset All Data" button with confirmation

**Notification dispatch (frontend side):**
  POST `${settings.backendUrl}/api/send-notification`
  Body: { type, channel, recipients:[{name,phone,email}], subject, body }
  On network error: log locally with status "simulated", show warning toast.

**Message templates (inline, no external deps):**
  rotation_reminder → subject + body referencing current/next week dates
  assignment        → subject + body for duty assignment notice
  status_alert      → subject + body for roster status change


────────────────────────────────────────────────────────────────────────────────
## STEP 5 — DESIGN CONSISTENCY RULES
────────────────────────────────────────────────────────────────────────────────

• Reuse every shared component that already exists in the platform:
    Modal/overlay, toast/notification, button variants, input fields,
    select dropdowns, card wrappers, avatar component, badge/pill,
    KPI card, top bar. Do NOT redefine them.

• If no shared component exists for a pattern, implement it inline
  following the platform's existing style conventions exactly.

• Color tokens — use only what is already defined in the platform theme:
    sidebar bg, card bg, border, accent (#E8750A), text-primary, text-muted,
    success green, warning amber, danger red. Do NOT introduce new tokens.

• Typography: DM Sans for all UI text. JetBrains Mono for phone numbers,
  dates, codes, and any numeric data in the duty roster or notifications.

• Spacing: match the platform's card padding (20px), gap (14–16px),
  and border-radius (12px cards, 8px inputs, 999px badges).

• The active navigation indicator style must match the sidebar exactly
  (orange left strip + highlighted text + hover state).


────────────────────────────────────────────────────────────────────────────────
## STEP 6 — INTEGRATION CHECKLIST (verify before finishing)
────────────────────────────────────────────────────────────────────────────────

  [ ] "ERP Duty Rota" appears in sidebar between "Schedule" and "Requests"
  [ ] Days-to-handover badge renders correctly on the nav item
  [ ] Module renders inside the existing content area (no layout breakage)
  [ ] All 5 inner tabs navigate correctly with no shared-state pollution
  [ ] ERP members are drawn from the unified user store (no duplicate state)
  [ ] Pre-seeded weeks and members load on first render
  [ ] localStorage keys are namespaced (maz_erp_*) to avoid collisions
  [ ] RBAC: edit/send/emergency properly locked for non-admin roles
  [ ] Read-only mode shows lock icon, not blank/hidden sections
  [ ] Emergency broadcast modal requires explicit confirmation
  [ ] Notification dispatch gracefully degrades (simulation mode) if backend offline
  [ ] Dashboard emergency strip "Broadcast" button navigates to Notify tab
  [ ] All modals close on backdrop click and × button
  [ ] Toasts auto-dismiss after ~4.5 seconds
  [ ] No new CSS imports, no new font imports (already loaded by platform)
  [ ] Mobile layout: sidebar collapses correctly, cards stack in single column

────────────────────────────────────────────────────────────────────────────────
## DELIVERY FORMAT
────────────────────────────────────────────────────────────────────────────────

Return a single updated JSX file containing the full platform with the
ERP Duty Rota module fully integrated. Mark the new/modified sections with:

  // ── NEW: ERP Duty Rota ── [section name] ──────────────────────

Do not remove, rename, or restructure any existing module.
Do not break existing features (timesheets, schedule, leave requests, etc.).
Keep the file compiling without errors (no missing imports, no undefined refs).
────────────────────────────────────────────────────────────────────────────────

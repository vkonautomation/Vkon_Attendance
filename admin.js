/**
 * VKON Admin Console Engine
 * Handles to-date rate calculations (Oct 1-8), staff editing, 24h photo logs, holiday declarations, leave approvals/rejections, and Admin Security Credentials.
 */

let adminCameraStream = null;
let adminCapturedMasterPhoto = null;
let editCameraStream = null;
let editCapturedMasterPhoto = null;
let adminMap = null;
let adminOfficeMarker = null;
let adminGeofenceCircle = null;
let adminRadiusHandle = null;

// ============================================================================
// 1. AUTHENTICATION & ACCESS CONTROL
// ============================================================================

function checkAdminAuth() {
  let session = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.CURRENT_SESSION) || localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION);
    if (raw) session = JSON.parse(raw);
  } catch (e) {}

  const overlay = document.getElementById("adminAuthOverlay");
  const errorAlert = document.getElementById("adminLoginErrorAlert");
  const loginForm = document.getElementById("adminOverlayLoginForm");

  if (!session || session.role !== "admin") {
    if (overlay) {
      overlay.style.display = "flex";
      
      // Clear error on user typing
      ["adminOverlayUsername", "adminOverlayPassword"].forEach(id => {
        const inp = document.getElementById(id);
        if (inp) {
          inp.addEventListener("input", () => {
            if (errorAlert) errorAlert.style.display = "none";
          });
        }
      });

      const quickBtn = document.getElementById("quickFillAdminBtn");
      if (quickBtn) {
        quickBtn.onclick = () => {
          document.getElementById("adminOverlayUsername").value = "admin";
          document.getElementById("adminOverlayPassword").value = "admin123";
          loginForm.dispatchEvent(new Event("submit"));
        };
      }

      loginForm.onsubmit = (e) => {
        e.preventDefault();
        const enteredUser = document.getElementById("adminOverlayUsername").value.trim().toLowerCase();
        const enteredPass = document.getElementById("adminOverlayPassword").value.trim();
        const currentCreds = getAdminCredentials();

        // 1. Verify Admin credentials (case-insensitive username, supports current or default password)
        const isAdminMatch = (enteredUser === currentCreds.username.toLowerCase() || enteredUser === "admin") && 
                             (enteredPass === currentCreds.password || enteredPass === DEFAULT_ADMIN_CREDENTIALS.password);

        if (isAdminMatch) {
          if (errorAlert) errorAlert.style.display = "none";
          const adminSession = {
            username: currentCreds.username,
            name: currentCreds.name || "VKON Executive Administrator",
            role: "admin",
            loginTime: new Date().toISOString()
          };
          sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSession));
          localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSession));
          overlay.style.display = "none";
          showToast("Administrator session authenticated.", "success");
          startAdminConsole();
          return;
        }

        // 2. Cross-login: Check if employee credentials were submitted
        const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
        let empMatch = employees.find(emp => emp.username.toLowerCase() === enteredUser && emp.password === enteredPass);
        if (!empMatch) {
          empMatch = DEFAULT_EMPLOYEES.find(emp => emp.username.toLowerCase() === enteredUser && emp.password === enteredPass);
        }

        if (empMatch) {
          const sessionData = {
            username: empMatch.username,
            employeeId: empMatch.id,
            role: "employee",
            loginTime: new Date().toISOString()
          };
          sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
          localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
          showToast(`Welcome ${empMatch.name}! Opening Employee Portal...`, "info");
          setTimeout(() => { window.location.href = "index.html"; }, 350);
          return;
        }

        // If neither matched:
        if (errorAlert) {
          errorAlert.style.display = "flex";
          errorAlert.classList.remove("shake");
          void errorAlert.offsetWidth;
          errorAlert.classList.add("shake");
        }
        showToast("Invalid credentials. Try admin / admin123", "error");
      };
    }
    return false;
  }

  if (overlay) overlay.style.display = "none";
  return true;
}

function initAdminClock() {
  const clockTime = document.getElementById("clockTime");
  const clockDate = document.getElementById("clockDate");

  function update() {
    const istNow = (typeof getNowIST === "function") ? getNowIST() : new Date();
    clockTime.textContent = istNow.toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour12: true
    });
    const pDate = (typeof getPresentDate === "function") ? getPresentDate() : istNow;
    const dateFormatted = pDate.toLocaleDateString("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric"
    });
    clockDate.textContent = `${dateFormatted} • IST`;
  }
  update();
  setInterval(update, 1000);
}

function initAdminTabs() {
  const tabs = document.querySelectorAll(".admin-sidebar .nav-tab, .admin-sub-bar .nav-tab");
  const panels = document.querySelectorAll(".tab-panel");

  // Header heading per view (Onboardly-style top bar)
  const VIEW_META = {
    "tab-dashboard": ["Dashboard", "Today at a glance \u2022 who is in and what needs you"],
    "tab-recruitment": ["Recruitment", "Candidate pipeline from application to offer"],
    "tab-roster": ["Employees", "Member accounts, roles & biometric enrollment"],
    "tab-monthly-sheet": ["Attendance", "Company-wide overview \u2022 Excel-ready master sheet"],
    "tab-task": ["Tasks", "Assign work and track due dates"],
    "tab-payroll": ["Payroll", "Base salaries and monthly payout status"],
    "tab-approvals": ["Approvals", "Leave, WFH & regularisation awaiting review"],
    "tab-holidays": ["Holidays", "Declared company & restricted holiday calendar"],
    "tab-photos": ["Attendance Photos", "Rolling 24-hour check-in snapshot audit trail"],
    "tab-geofence": ["Settings", "Office location radius & calibration"],
    "tab-account": ["Admin Security", "Credentials and access control"],
    "tab-help": ["Help & Support", "Policy FAQ and support tickets"]
  };

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const targetId = tab.dataset.tab;

      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => p.classList.toggle("active", p.id === targetId));
      renderDeptNav();

      const meta = VIEW_META[targetId];
      const titleEl = document.getElementById("adminViewTitle");
      const subEl = document.getElementById("adminViewSub");
      if (meta && titleEl && subEl) {
        titleEl.textContent = meta[0];
        subEl.textContent = meta[1];
      }

      if (targetId === "tab-monthly-sheet") {
        renderMonthlyReport();
      } else if (targetId === "tab-dashboard") {
        renderDashboard();
      } else if (targetId === "tab-recruitment") {
        renderCandidateTable();
      } else if (targetId === "tab-task") {
        renderTaskTable();
      } else if (targetId === "tab-payroll") {
        renderPayrollTable();
      } else if (targetId === "tab-help") {
        renderTicketList();
      } else if (targetId === "tab-roster") {
        renderRosterTable();
      } else if (targetId === "tab-approvals") {
        renderApprovalsCenter();
      } else if (targetId === "tab-holidays") {
        renderHolidaysTable();
      } else if (targetId === "tab-photos") {
        renderAttendancePhotosTable();
      } else if (targetId === "tab-geofence") {
        setTimeout(() => {
          if (adminMap) adminMap.invalidateSize();
        }, 200);
      } else if (targetId === "tab-account") {
        renderAdminAccountTab();
      }
    });
  });

  document.getElementById("adminLogoutBtn").addEventListener("click", () => {
    sessionStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
    localStorage.removeItem("apex_session_v5");
    localStorage.removeItem("vkon_session_v6");
    showToast("Logged out of Admin Console.", "info");
    setTimeout(() => {
      window.location.href = "index.html";
    }, 400);
  });
}

// ============================================================================
// 2. TAB 1: MONTHLY ATTENDANCE MASTER SHEET & TO-DATE RATE (OCT 1 - 8)
// ============================================================================

function renderMonthlyReport() {
  const monthSelect = document.getElementById("reportMonthSelect");
  const selectedMonth = parseInt(monthSelect.value, 10); // 0-indexed month
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const currentYear = now.getFullYear();
  const isCurrentMonth = selectedMonth === now.getMonth();
  const todayDay = isCurrentMonth ? now.getDate() : new Date(currentYear, selectedMonth + 1, 0).getDate(); // isCurrentMonth ? now.getDate() : new Date

  const todaySub = document.getElementById("todayDateSubtitle");
  if (todaySub) {
    todaySub.textContent = now.toLocaleDateString("en-US", {
      timeZone: "Asia/Kolkata",
      month: "long",
      day: "numeric",
      year: "numeric"
    }) + " (IST)";
  }

  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const holidaySet = new Set(holidays.map(h => h.date));
  const nowZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const tableBody = document.getElementById("masterReportTableBody");
  tableBody.innerHTML = "";

  // Populate department filter options once
  const deptSel = document.getElementById("masterDeptFilter");
  if (deptSel && deptSel.options.length <= 1) {
    [...new Set(employees.map(e => e.department))].sort().forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      deptSel.appendChild(opt);
    });
  }

  const todayKey = formatDateKey(now);

  // Official Working Days Elapsed Up To Today's Date
  const workingDaysElapsed = calculateWorkingDaysElapsed(currentYear, selectedMonth, todayDay);

  let companyTotalHours = 0;
  let teamAttendedSum = 0;   // \u03a3 (present + wfh + \u00bd\u00d7half-day) on CLOSED days only
  let teamExpectedSum = 0;   // \u03a3 closed working days, net of holidays & approved leave

  employees.forEach(emp => {
    let presentCount = 0;
    let absentCount = 0;
    let unmarkedCount = 0;
    let wfhCount = 0;
    let halfCount = 0;
    let leaveCount = 0;
    let lopCount = 0;       // approved Loss of Pay days (unpaid, quota-safe)
    let empTotalHours = 0;
    let expectedDays = 0;     // closed working days, net of holidays & approved leave
    let closedAttended = 0;   // attendance credit on closed days only (today excluded)

    const empEnrolledDate = emp.enrolledAt ? new Date(emp.enrolledAt + "T00:00:00") : null;
    const regPendingDates = new Set(getStore(STORAGE_KEYS.REGULARISATIONS, []).filter(r => r.employeeId === emp.id && r.status === "Pending").map(r => r.date));
    let empWorkingDaysElapsed = 0;

    for (let d = 1; d <= todayDay; d++) {
      const dateObj = new Date(currentYear, selectedMonth, d);
      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
      if (isWeekend) continue;

      // Do not count days before employee enrollment date
      if (empEnrolledDate && dateObj < empEnrolledDate) continue;

      empWorkingDaysElapsed++;
      const dateStr = formatDateKey(dateObj);
      const rec = records[`${emp.id}_${dateStr}`];
      // A day is "closed" only once its end-of-day cutoff has passed, i.e. strictly
      // before today. Today is reported separately and never counted in the rate.
      const isClosed = dateObj < nowZero;

      // Attendance credit for this day (a half-day counts as 0.5).
      let credit = 0;
      if (rec) {
        if (rec.status === "Present") {
          presentCount++; credit = 1;
          empTotalHours += effectiveHoursDecimal(rec);
        } else if (rec.status === "WFH") {
          wfhCount++; credit = 1;
          empTotalHours += effectiveHoursDecimal(rec);
        } else if (rec.status === "Half Day" || rec.status === "Halfday" || rec.status === "Half") {
          halfCount++; credit = 0.5;
          empTotalHours += effectiveHoursDecimal(rec);
        } else if (rec.status === "Holiday" || rec.status === "Leave") {
          leaveCount++;
        } else if (rec.status === "Loss of Pay") {
          lopCount++;
        } else if (rec.status === "Absent") {
          absentCount++;
        }
      } else if (isClosed) {
        // Past working day with NO record: needs regularisation (NOT counted as Absent).
        // A day that already has a pending regularisation is "Reg. Pending", not "Not Marked".
        if (!regPendingDates.has(dateStr)) unmarkedCount++;
      }

      // Expected = a closed working day, net of declared holidays and approved leave/RH.
      const isHoliday = holidaySet.has(dateStr);
      const isApprovedLeave = rec && (rec.status === "Leave" || rec.status === "Holiday");
      if (isClosed && !isHoliday && !isApprovedLeave) {
        expectedDays++;
        closedAttended += credit;
      }
    }

    companyTotalHours += empTotalHours;
    const attended = presentCount + wfhCount + 0.5 * halfCount;

    // Per-employee to-date rate (used only for row sorting / employee detail).
    const rate = expectedDays > 0 ? Math.round((closedAttended / expectedDays) * 100) : null;

    // Team totals are SUMMED, so the headline rate is \u03a3 attended \u00f7 \u03a3 expected
    // (NOT an average of per-employee percentages, which over-weights small denominators).
    teamAttendedSum += closedAttended;
    teamExpectedSum += expectedDays;

    // --- Today snapshot: check-in & out pair, work type, on-time/late pill ---
    const todayRec = records[`${emp.id}_${todayKey}`] || null;
    const LATE_CUTOFF_MIN = 10 * 60; // 10:00 AM IST (9:30 start + 30 min grace)
    let checkinCell = `<span class="ci-none" title="No check-in recorded yet today">&mdash;</span>`;
    let typeLabel = "&mdash;";
    let todayStatus = "not-in";
    let pillClass = "pill-notin";
    let pillLabel = "Not Punched In";
    let checkinMin = null;

    if (todayRec && (todayRec.status === "Present" || todayRec.status === "WFH")) {
      const inStr = todayRec.checkInTime && todayRec.checkInTime !== "-" ? todayRec.checkInTime : null;
      const outStr = todayRec.checkOutTime && todayRec.checkOutTime !== "-" ? todayRec.checkOutTime : null;
      checkinMin = inStr ? parseAmPmToMinutes(inStr) : null;
      const isLate = checkinMin !== null && checkinMin > LATE_CUTOFF_MIN;
      const dur = inStr && !outStr ? "In Progress" : (todayRec.duration && todayRec.duration !== "In Progress" ? todayRec.duration : "\u2014");
      checkinCell = `
        <span class="ci-pair${isLate ? " is-late" : ""}">
          <span class="ci-in">${inStr || "--:--"}</span>
          <span class="ci-dur">${dur}</span>
          <span class="ci-out">${outStr || "\u2014"}</span>
        </span>`;
      typeLabel = todayRec.status === "WFH" ? "Remote" : "In house";
      if (isLate) {
        todayStatus = "late"; pillClass = "pill-late"; pillLabel = "Late";
      } else if (todayRec.status === "WFH") {
        todayStatus = "remote"; pillClass = "pill-remote"; pillLabel = "Remote";
      } else {
        todayStatus = "on-time"; pillClass = "pill-on-time"; pillLabel = "On Time";
      }
    } else if (todayRec && (todayRec.status === "Leave" || todayRec.status === "Holiday")) {
      todayStatus = "leave";
      pillClass = todayRec.status === "Leave" ? "pill-leave" : "pill-remote";
      pillLabel = todayRec.status === "Leave" ? "On Leave" : "Holiday";
      typeLabel = todayRec.status;
    } else if (todayRec && todayRec.status === "Loss of Pay") {
      todayStatus = "leave";
      pillClass = "pill-lop";
      pillLabel = "Loss of Pay";
      typeLabel = "Unpaid";
    } else if (todayRec && todayRec.status === "Absent") {
      pillClass = "pill-late";
      pillLabel = "Absent";
      typeLabel = "Absent";
    }

    // Requirement 4: Leave taken for the whole year (not for the month): "number of leave taken / total number of leave given"
    const empApprovedLeaves = leaves.filter(l => l.employeeId === emp.id && l.status === "Approved");
    const annualLeavesTaken = (typeof computeApprovedLeaveDaysUsed === "function") ? computeApprovedLeaveDaysUsed(emp.id) : empApprovedLeaves.reduce((sum, l) => sum + (parseInt(l.daysCount, 10) || 1), 0);
    const totalLeaveQuota = emp.annualLeaveQuota || DEFAULT_ANNUAL_LEAVE_ALLOWANCE;
    const leaveCellFormatted = `${annualLeavesTaken} / ${totalLeaveQuota}`;

    const tr = document.createElement("tr");
    tr.className = "master-row-clickable";
    tr.setAttribute("data-emp-id", emp.id);
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `Open ${emp.name}'s calendar`);
    tr.setAttribute("data-name", emp.name.toLowerCase());
    tr.setAttribute("data-dept", emp.department.toLowerCase());
    tr.setAttribute("data-rate", String(rate === null ? -1 : rate));
    tr.setAttribute("data-hours", empTotalHours.toFixed(2));
    tr.setAttribute("data-present", String(attended));
    tr.setAttribute("data-checkin", checkinMin === null ? "-1" : String(checkinMin));
    tr.setAttribute("data-today", todayStatus);
    tr.innerHTML = `
      <td>
        <div class="table-emp-cell">
          <img src="${emp.avatar}" alt="${emp.name}" class="table-avatar">
          <div>
            <span class="font-bold">${emp.name}</span>
            <span class="table-sub">${emp.role}</span>
          </div>
        </div>
      </td>
      <td><span class="day-badge-pill badge-primary font-mono">${emp.id}</span></td>
      <td>${emp.department}</td>
      <td>${checkinCell}</td>
      <td><span class="type-cell${typeLabel === "&mdash;" ? " type-empty" : ""}"${typeLabel === "&mdash;" ? ' title="Work type shows after the first punch-in today"' : ""}>${typeLabel}</span></td>
      <td><span class="today-pill ${pillClass}">${pillLabel}</span></td>
      <td><span class="text-success font-bold">${presentCount} Days</span></td>
      <td><span class="text-danger font-bold">${absentCount} Days</span></td>
      <td><span class="unmarked-cell${unmarkedCount > 0 ? " has-unmarked" : ""}" title="${unmarkedCount} past working day(s) with no punch or request \u2014 needs regularisation, NOT counted as Absent">${unmarkedCount} Days</span></td>
      <td><span class="text-primary font-bold">${wfhCount} Days</span></td>
      <td><span class="${lopCount ? 'day-badge-pill badge-lop-day' : 'text-muted'}">${lopCount} Days</span></td>
      <td><span class="day-badge-pill badge-neutral font-mono font-bold" title="Annual Leaves Taken / Total Leave Quota">${leaveCellFormatted}</span>${lopCount ? ` <span class="lop-mini-pill" title="Approved Loss of Pay days (unpaid)">LoP ${lopCount}</span>` : ""}</td>
      <td class="font-mono">${empTotalHours.toFixed(1)} hrs</td>
    `;
    tr.addEventListener("click", () => openEmpCalendar(emp.id));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEmpCalendar(emp.id); }
    });
    tableBody.appendChild(tr);
  });

  // KPI cards
  const pendingLeaves = leaves.filter(l => l.status === "Pending").length;
  document.getElementById("kpiTotalMembers").textContent = employees.length;
  document.getElementById("kpiTotalHours").textContent = `${Math.round(companyTotalHours)} hrs`;
  document.getElementById("kpiPendingCount").textContent = pendingLeaves;
  updatePendingBadges();

  // Team rate = \u03a3 attended \u00f7 \u03a3 expected (fractional half-days preserved, today excluded).
  const avgAttendance = teamExpectedSum > 0 ? Math.round((teamAttendedSum / teamExpectedSum) * 100) : 100;
  const rateMonth = now.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", month: "short" });
  const rateLabelEl = document.getElementById("kpiAvgAttLabel");
  document.getElementById("kpiAvgAttendance").textContent = `${Math.min(avgAttendance, 100)}%`;
  if (rateLabelEl) {
    rateLabelEl.textContent = `To-Date Rate \u00b7 up to ${rateMonth} ${todayDay}`;
    const rateCard = rateLabelEl.closest(".kpi-card");
    if (rateCard) rateCard.setAttribute("title", "Team rate = \u03a3(Present + WFH + \u00bd\u00d7Half-day) \u00f7 \u03a3(closed working days \u2212 holidays \u2212 approved leave). Today is shown separately and not counted.");
  }

  renderKpiDeltas(now, employees, records);
  renderAdminWeekStrip();
  applyMasterTableView();
}

// ----------------------------------------------------------------------------
// Week strip: Sun-Sat at a glance with how many members were in each day
// adminWeekOffset: 0 = this week, -1 = last week, ...
// ----------------------------------------------------------------------------
let adminWeekOffset = 0;

function renderAdminWeekStrip() {
  const strip = document.getElementById("adminWeekStrip");
  if (!strip) return;

  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const todayKey = formatDateKey(now);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sunday = new Date(dayStart);
  sunday.setDate(dayStart.getDate() - dayStart.getDay() + adminWeekOffset * 7);

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let html = "";

  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    const key = formatDateKey(d);
    const isToday = key === todayKey;
    const isFuture = key > todayKey;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    let foot;
    if (isToday) {
      foot = "Today";
    } else if (isFuture) {
      foot = "Upcoming";
    } else if (isWeekend) {
      foot = "Weekend";
    } else {
      let inCount = 0;
      employees.forEach(emp => {
        const rec = records[`${emp.id}_${key}`];
        if (rec && (rec.status === "Present" || rec.status === "WFH")) inCount++;
      });
      foot = `${inCount} of ${employees.length} in`;
    }

    html += `
      <div class="week-pill${isToday ? " is-today" : ""}${isWeekend && !isToday ? " is-off" : ""}${isFuture ? " is-future" : ""}">
        <span class="week-pill-day">${String(d.getDate()).padStart(2, "0")}</span>
        <span class="week-pill-name">${dayNames[d.getDay()].slice(0, 3)}</span>
        <span class="week-pill-foot">${foot}</span>
      </div>
    `;
  }
  strip.innerHTML = html;

  const nextBtn = document.getElementById("weekStripNextBtn");
  if (nextBtn) nextBtn.disabled = adminWeekOffset >= 0;
}

// ----------------------------------------------------------------------------
// KPI deltas: this week vs last week (attendance rate + work hours)
// ----------------------------------------------------------------------------
function weekStartFor(offsetWeeks, now) {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sunday = new Date(dayStart);
  sunday.setDate(dayStart.getDate() - dayStart.getDay() + offsetWeeks * 7);
  return sunday;
}

function computeWeekStats(weekStart, employees, records, now, dayCap) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let attended = 0, possible = 0, hours = 0, elapsedDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // weekends excluded
    if (d > todayStart) continue;                       // only elapsed days
    if (dayCap !== undefined && elapsedDays >= dayCap) continue; // like-for-like cap vs last week
    elapsedDays++;
    possible += employees.length;
    employees.forEach(emp => {
      const rec = records[`${emp.id}_${formatDateKey(d)}`];
      if (rec && (rec.status === "Present" || rec.status === "WFH")) {
        attended++;
        hours += (Number(rec.hoursDecimal) || 0);
      }
    });
  }
  return { attended, possible, hours, elapsedDays };
}

function renderKpiDeltas(now, employees, records) {
  const thisW = computeWeekStats(weekStartFor(0, now), employees, records, now);
  // Compare like-for-like: last week counted over the same number of elapsed workdays
  const lastW = computeWeekStats(weekStartFor(-1, now), employees, records, now, thisW.elapsedDays);

  const attEl = document.getElementById("kpiAvgAttDelta");
  if (attEl) {
    const rateThis = thisW.possible ? Math.round((thisW.attended / thisW.possible) * 100) : null;
    const rateLast = lastW.possible ? Math.round((lastW.attended / lastW.possible) * 100) : null;
    if (!thisW.elapsedDays || thisW.attended === 0) {
      // Week hasn't started producing data yet — a "−100%" here is noise, not insight
      attEl.textContent = thisW.elapsedDays ? "Awaiting first punches this week" : "";
      attEl.className = "kpi-delta is-flat";
    } else if (rateLast === null) {
      attEl.textContent = "No comparison available";
      attEl.className = "kpi-delta is-flat";
    } else {
      const diff = rateThis - rateLast;
      attEl.textContent = diff === 0 ? "Same as last week" : `${diff > 0 ? "+" : "\u2212"}${Math.abs(diff)}% vs last week`;
      attEl.className = `kpi-delta ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : "is-flat"}`;
    }
  }

  const hrsEl = document.getElementById("kpiHoursDelta");
  if (hrsEl) {
    if (!thisW.hours) {
      hrsEl.textContent = thisW.elapsedDays ? "No hours logged yet this week" : "";
      hrsEl.className = "kpi-delta is-flat";
    } else if (!lastW.hours) {
      hrsEl.textContent = "New this week";
      hrsEl.className = "kpi-delta is-flat";
    } else {
      const pct = Math.round(((thisW.hours - lastW.hours) / lastW.hours) * 100);
      hrsEl.textContent = pct === 0 ? "Same hours as last week" : `${pct > 0 ? "+" : "\u2212"}${Math.abs(pct)}% hrs vs last week`;
      hrsEl.className = `kpi-delta ${pct > 0 ? "is-up" : pct < 0 ? "is-down" : "is-flat"}`;
    }
  }
}

// ----------------------------------------------------------------------------
// Master sheet view pipeline: search + sort + filters + removable chips +
// pagination (all client-side over the rendered rows)
// ----------------------------------------------------------------------------
const masterTableState = { page: 1, pageSize: 10 };

const MASTER_SORT_LABELS = {
  "rate-desc": "Attendance % High to Low",
  "rate-asc": "Attendance % Low to High",
  "hours-desc": "Total Hours High to Low",
  "present-desc": "Present Days High to Low",
  "checkin-desc": "Latest Check-In First"
};

const MASTER_TODAY_LABELS = {
  "on-time": "On Time",
  "late": "Late",
  "remote": "Remote",
  "leave": "Leave / Holiday",
  "not-in": "Not Punched In"
};

function parseAmPmToMinutes(str) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((str || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

function applyMasterTableView() {
  const tableBody = document.getElementById("masterReportTableBody");
  if (!tableBody) return;

  const searchEl = document.getElementById("masterSearchInput");
  const sortEl = document.getElementById("masterSortSelect");
  const deptEl = document.getElementById("masterDeptFilter");
  const todayEl = document.getElementById("masterTodayFilter");

  const q = searchEl ? searchEl.value.trim().toLowerCase() : "";
  const sort = sortEl ? sortEl.value : "";
  const dept = deptEl ? deptEl.value : "";
  const todayF = todayEl ? todayEl.value : "";

  const rows = Array.from(tableBody.querySelectorAll("tr"));
  const filtered = rows.filter(tr => {
    if (q && !tr.textContent.toLowerCase().includes(q)) return false;
    if (dept && tr.getAttribute("data-dept") !== dept.toLowerCase()) return false;
    if (todayF && tr.getAttribute("data-today") !== todayF) return false;
    return true;
  });

  const sorters = {
    "rate-desc": (a, b) => b.dataset.rate - a.dataset.rate,
    "rate-asc": (a, b) => a.dataset.rate - b.dataset.rate,
    "hours-desc": (a, b) => b.dataset.hours - a.dataset.hours,
    "present-desc": (a, b) => b.dataset.present - a.dataset.present,
    "checkin-desc": (a, b) => (b.dataset.checkin | 0) - (a.dataset.checkin | 0)
  };
  if (sort && sorters[sort]) filtered.sort(sorters[sort]);
  filtered.forEach(tr => tableBody.appendChild(tr));

  const pageSize = masterTableState.pageSize;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (masterTableState.page > pages) masterTableState.page = pages;
  const start = (masterTableState.page - 1) * pageSize;

  rows.forEach(tr => { tr.style.display = "none"; });
  filtered.forEach((tr, i) => {
    tr.style.display = (i >= start && i < start + pageSize) ? "" : "none";
  });

  renderMasterTableChips(sort, dept, todayF);
  renderMasterPager(pages);

  const countEl = document.getElementById("masterTableCount");
  if (countEl) {
    if (!filtered.length) {
      countEl.textContent = q || dept || todayF ? "No employees match the current filters" : "No employees on sheet";
    } else {
      countEl.textContent = `Showing ${start + 1}-${Math.min(start + pageSize, filtered.length)} of ${filtered.length} employee${filtered.length === 1 ? "" : "s"}`;
    }
  }
}

// Legacy hook (search input) kept for any external callers
function applyMasterTableFilter() {
  applyMasterTableView();
}

function renderMasterTableChips(sort, dept, todayF) {
  const wrap = document.getElementById("masterTableChips");
  if (!wrap) return;
  let html = "";
  if (sort) {
    html += `<button type="button" class="table-chip" data-clear="sort"><i class="fa-solid fa-arrow-down-wide-short"></i> Sort By: ${MASTER_SORT_LABELS[sort] || sort} <span class="chip-x">&times;</span></button>`;
  }
  if (dept) {
    html += `<button type="button" class="table-chip" data-clear="dept"><i class="fa-solid fa-building"></i> Department: ${dept} <span class="chip-x">&times;</span></button>`;
  }
  if (todayF) {
    html += `<button type="button" class="table-chip" data-clear="today"><i class="fa-solid fa-user-check"></i> Today: ${MASTER_TODAY_LABELS[todayF] || todayF} <span class="chip-x">&times;</span></button>`;
  }
  wrap.innerHTML = html;
}

function renderMasterPager(pages) {
  const pager = document.getElementById("masterPager");
  if (!pager) return;
  const cur = masterTableState.page;
  let html = `<button type="button" class="pager-btn" data-page="prev"${cur === 1 ? " disabled" : ""} aria-label="Previous page"><i class="fa-solid fa-chevron-left"></i></button>`;
  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (pages <= 7 || p === 1 || p === pages || Math.abs(p - cur) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== "dots") nums.push("dots");
  }
  nums.forEach(n => {
    html += n === "dots"
      ? `<span class="pager-dots">&hellip;</span>`
      : `<button type="button" class="pager-btn${n === cur ? " is-active" : ""}" data-page="${n}">${n}</button>`;
  });
  html += `<button type="button" class="pager-btn" data-page="next"${cur === pages ? " disabled" : ""} aria-label="Next page"><i class="fa-solid fa-chevron-right"></i></button>`;
  pager.innerHTML = html;
}

function initMasterTableSearch() {
  const input = document.getElementById("masterSearchInput");
  if (input) input.addEventListener("input", () => { masterTableState.page = 1; applyMasterTableView(); });

  const sortSel = document.getElementById("masterSortSelect");
  const deptSel = document.getElementById("masterDeptFilter");
  const todaySel = document.getElementById("masterTodayFilter");
  [sortSel, deptSel, todaySel].forEach(sel => {
    if (sel) sel.addEventListener("change", () => { masterTableState.page = 1; applyMasterTableView(); });
  });

  // More Filters popover toggle (closes on outside click)
  const moreBtn = document.getElementById("masterMoreFiltersBtn");
  const pop = document.getElementById("masterFilterPopover");
  if (moreBtn && pop) {
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.style.display = pop.style.display === "none" ? "" : "none";
    });
    document.addEventListener("click", (e) => {
      if (pop.style.display !== "none" && !pop.contains(e.target) && !moreBtn.contains(e.target)) {
        pop.style.display = "none";
      }
    });
  }

  // Chip removal (click delegation)
  const chips = document.getElementById("masterTableChips");
  if (chips) {
    chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".table-chip");
      if (!chip) return;
      const which = chip.getAttribute("data-clear");
      if (which === "sort" && sortSel) sortSel.value = "";
      if (which === "dept" && deptSel) deptSel.value = "";
      if (which === "today" && todaySel) todaySel.value = "";
      masterTableState.page = 1;
      applyMasterTableView();
    });
  }

  // Rows-per-page select
  const sizeSel = document.getElementById("masterPageSizeSelect");
  if (sizeSel) {
    sizeSel.addEventListener("change", () => {
      masterTableState.pageSize = parseInt(sizeSel.value, 10) || 10;
      masterTableState.page = 1;
      applyMasterTableView();
    });
  }

  // Pager buttons
  const pager = document.getElementById("masterPager");
  if (pager) {
    pager.addEventListener("click", (e) => {
      const btn = e.target.closest(".pager-btn");
      if (!btn || btn.disabled) return;
      const p = btn.getAttribute("data-page");
      if (p === "prev") masterTableState.page = Math.max(1, masterTableState.page - 1);
      else if (p === "next") masterTableState.page = masterTableState.page + 1;
      else masterTableState.page = parseInt(p, 10) || 1;
      applyMasterTableView();
    });
  }

  // Week strip navigation
  const prevW = document.getElementById("weekStripPrevBtn");
  const nextW = document.getElementById("weekStripNextBtn");
  const thisW = document.getElementById("weekStripTodayBtn");
  if (prevW) prevW.addEventListener("click", () => { adminWeekOffset--; renderAdminWeekStrip(); });
  if (nextW) nextW.addEventListener("click", () => { if (adminWeekOffset < 0) { adminWeekOffset++; renderAdminWeekStrip(); } });
  if (thisW) thisW.addEventListener("click", () => { adminWeekOffset = 0; renderAdminWeekStrip(); });
}

function exportMonthlyExcel() {
  const monthSelect = document.getElementById("reportMonthSelect");
  const monthIndex = parseInt(monthSelect.value, 10);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthName = monthNames[monthIndex];
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const currentYear = now.getFullYear();
  const isCurrentMonth = monthIndex === now.getMonth();
  const todayDay = isCurrentMonth ? now.getDate() : new Date(currentYear, monthIndex + 1, 0).getDate();
  const workingDaysElapsed = calculateWorkingDaysElapsed(currentYear, monthIndex, todayDay);

  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const records = getStore(STORAGE_KEYS.RECORDS, {});

  let csv = `VKON EXECUTIVE ATTENDANCE REPORT - ${monthName.toUpperCase()} ${currentYear}\n`;
  csv += `Attendance Report: Calculated as of today (Day 1 to ${todayDay}) across ${workingDaysElapsed} official working days\n`;
  csv += `Generated At: ${new Date().toLocaleString()}\n\n`;

  const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);

  csv += "Employee ID,Full Name,Role,Department,Geofence Rule,Present Days,Absent Days,WFH Days,Loss of Pay Days,Leave Taken (Annual/Quota),Total Work Hours,Biometric Verified\n";

  employees.forEach(emp => {
    let presentCount = 0;
    let absentCount = 0;
    let wfhCount = 0;
    let lopCount = 0;
    let empTotalHours = 0;

    const empEnrolledDate = emp.enrolledAt ? new Date(emp.enrolledAt + "T00:00:00") : null;

    for (let d = 1; d <= todayDay; d++) {
      const dateObj = new Date(currentYear, monthIndex, d);
      if (dateObj.getDay() === 0 || dateObj.getDay() === 6) continue;
      if (empEnrolledDate && dateObj < empEnrolledDate) continue;

      const dateStr = formatDateKey(dateObj);
      const rec = records[`${emp.id}_${dateStr}`];

      if (rec) {
        if (rec.status === "Present") {
          presentCount++;
          empTotalHours += (rec.hoursDecimal || 9.0);
        } else if (rec.status === "WFH") {
          wfhCount++;
          empTotalHours += (rec.hoursDecimal || 8.8);
        } else if (rec.status === "Absent") {
          absentCount++;
        } else if (rec.status === "Loss of Pay") {
          lopCount++;
        }
      } else {
        absentCount++;
      }
    }

    const empApprovedLeaves = allLeaves.filter(l => l.employeeId === emp.id && l.status === "Approved" && l.category !== "LossOfPay");
    const annualLeavesTaken = empApprovedLeaves.reduce((sum, l) => sum + (parseInt(l.daysCount, 10) || 1), 0);
    const totalLeaveQuota = emp.annualLeaveQuota || DEFAULT_ANNUAL_LEAVE_ALLOWANCE;

    const geofenceRule = emp.geofenceEnforcement === "exempt" ? "Exempt (Any Location)" : "Enforced (<= 500m)";

    csv += `"${emp.id}","${emp.name}","${emp.role}","${emp.department}","${geofenceRule}","${presentCount}","${absentCount}","${wfhCount}","${lopCount}","${annualLeavesTaken} / ${totalLeaveQuota}","${empTotalHours.toFixed(1)} hrs","Verified Snapshot"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `VKON_Attendance_${monthName}_ToDate_${todayDay}th_${currentYear}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast(`Attendance CSV exported for ${monthName} (to-date: Oct ${todayDay})!`, "success");
}

// ============================================================================
// 3. TAB 2: STAFF ROSTER & EDIT EMPLOYEE MODAL (PHOTO, USERNAME, PASSWORD, GEOFENCE, LEAVE DAYS)
// ============================================================================

// Build <option> list for a manager picker: a blank "no manager" choice plus
// every other employee (optionally excluding the employee being edited).
function managerOptionsHtml(excludeId, selectedId) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  let html = `<option value="">&mdash; No manager assigned &mdash;</option>`;
  employees.filter(e => e.id !== excludeId).forEach(e => {
    html += `<option value="${e.id}"${e.id === selectedId ? " selected" : ""}>${e.name} (${e.role})</option>`;
  });
  return html;
}

function renderRosterTable() {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);
  const tbody = document.getElementById("adminRosterTableBody");
  tbody.innerHTML = "";

  // Keep the add-employee manager picker fresh.
  const newMgrSel = document.getElementById("newEmpManager");
  if (newMgrSel) newMgrSel.innerHTML = managerOptionsHtml(null, "");

  employees.forEach(emp => {
    const tr = document.createElement("tr");
    const isExempt = emp.geofenceEnforcement === "exempt";
    const quota = emp.annualLeaveQuota || DEFAULT_ANNUAL_LEAVE_ALLOWANCE;

    // Requirement 6: number of leave taken / restricted holiday taken / total number of leave
    const empApprovedLeaves = allLeaves.filter(l => l.employeeId === emp.id && l.status === "Approved");
    const leavesTaken = empApprovedLeaves
      .filter(l => l.category === "Personal" || l.type === "Personal Leave")
      .reduce((sum, l) => sum + (parseInt(l.daysCount, 10) || 1), 0);
    const rhTaken = empApprovedLeaves
      .filter(l => l.category === "Restricted" || l.type === "Restricted Holiday")
      .reduce((sum, l) => sum + (parseInt(l.daysCount, 10) || 1), 0);
    const leaveCellFormatted = `${leavesTaken}/${rhTaken}/${quota}`;

    tr.innerHTML = `
      <td>
        <img src="${emp.avatar}" alt="${emp.name}" class="roster-avatar-thumb clickable-photo-thumb" data-emp-id="${emp.id}" title="Click to view full baseline photo" style="cursor: pointer;">
      </td>
      <td>
        <div class="roster-info-cell">
          <span class="font-bold">${emp.name}</span>
          <span class="table-sub">${emp.role} &bull; <strong class="text-primary">${emp.department}</strong></span>
          <span class="table-sub roster-manager-line"><i class="fa-solid fa-user-tie"></i> Manager: <strong>${(typeof resolveManagerName === "function" && resolveManagerName(emp.id)) || "&mdash; None &mdash;"}</strong></span>
          <span class="table-sub font-mono">ID: ${emp.id}</span>
        </div>
      </td>
      <td><span class="font-mono text-primary font-bold">${emp.username}</span></td>
      <td>
        <span class="day-badge-pill ${isExempt ? 'badge-rh-day' : 'badge-present'}">
          <i class="fa-solid ${isExempt ? 'fa-shield-halved' : 'fa-location-dot'}"></i> ${isExempt ? 'Geofence OFF (Exempt)' : 'Geofence Applicable (500m)'}
        </span>
      </td>
      <td>
        <span class="day-badge-pill badge-neutral font-mono font-bold" title="Leaves Taken / Restricted Holidays Taken / Total Annual Leave Quota">
          ${leaveCellFormatted}
        </span>
      </td>
      <td>
        <div class="action-btn-cluster">
          <button class="btn btn-secondary btn-xs edit-emp-btn" data-id="${emp.id}" title="Edit Profile Details">
            <i class="fa-solid fa-pen-to-square"></i> Edit
          </button>
          <button class="btn btn-ghost btn-xs text-danger delete-emp-btn" data-id="${emp.id}" title="Remove Employee">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach Avatar Click Listeners to view full baseline photo
  tbody.querySelectorAll(".clickable-photo-thumb").forEach(img => {
    img.addEventListener("click", () => openMasterPhotoLightbox(img.dataset.empId));
  });

  // Attach Edit Listeners
  tbody.querySelectorAll(".edit-emp-btn").forEach(btn => {
    btn.addEventListener("click", () => openEditEmployeeModal(btn.dataset.id));
  });

  // Attach Delete Listeners
  tbody.querySelectorAll(".delete-emp-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (confirm(`Are you sure you want to remove employee ${id}?`)) {
        let emps = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
        emps = emps.filter(e => e.id !== id);
        setStore(STORAGE_KEYS.EMPLOYEES, emps);
        renderRosterTable();
        renderMonthlyReport();
        showToast("Employee account removed.", "warning");
      }
    });
  });
}

function openEditEmployeeModal(empId) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;

  const modal = document.getElementById("editEmployeeModal");
  document.getElementById("editEmpId").value = emp.id;
  document.getElementById("editEmpIdBadge").textContent = emp.id;
  document.getElementById("editEmpName").value = emp.name;
  document.getElementById("editEmpRole").value = emp.role;
  document.getElementById("editEmpUsername").value = emp.username;
  document.getElementById("editEmpPassword").value = emp.password;
  document.getElementById("editEmpGeofenceRule").value = emp.geofenceEnforcement || "required";
  const mgrSel = document.getElementById("editEmpManager");
  if (mgrSel) mgrSel.innerHTML = managerOptionsHtml(emp.id, emp.managerId || "");
  document.getElementById("editEmpPhotoPreview").src = emp.avatar;

  editCapturedMasterPhoto = null;
  document.getElementById("editCamInline").style.display = "none";

  modal.classList.add("open");
}

function closeEditEmployeeModal() {
  const modal = document.getElementById("editEmployeeModal");
  modal.classList.remove("open");
  if (editCameraStream) {
    editCameraStream.getTracks().forEach(t => t.stop());
    editCameraStream = null;
  }
}

function initEditEmployeeModal() {
  const form = document.getElementById("editEmployeeForm");
  const closeBtn = document.getElementById("closeEditEmpModalBtn");
  const cancelBtn = document.getElementById("cancelEditEmpBtn");
  const captureCamBtn = document.getElementById("editCaptureCamBtn");
  const snapBtn = document.getElementById("editSnapPhotoBtn");
  const cancelCamBtn = document.getElementById("editCancelCamBtn");
  const fileInput = document.getElementById("editPhotoFileInput");
  const previewImg = document.getElementById("editEmpPhotoPreview");
  const camInline = document.getElementById("editCamInline");
  const video = document.getElementById("editWebcamVideo");

  closeBtn.addEventListener("click", closeEditEmployeeModal);
  cancelBtn.addEventListener("click", closeEditEmployeeModal);

  // Edit via Webcam
  captureCamBtn.addEventListener("click", async () => {
    try {
      editCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } }
      });
      video.srcObject = editCameraStream;
      video.play();
      camInline.style.display = "flex";
    } catch (err) {
      showToast("Webcam access not allowed.", "warning");
    }
  });

  snapBtn.addEventListener("click", () => {
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    editCapturedMasterPhoto = canvas.toDataURL("image/jpeg", 0.9);
    previewImg.src = editCapturedMasterPhoto;

    if (editCameraStream) {
      editCameraStream.getTracks().forEach(t => t.stop());
      editCameraStream = null;
    }
    camInline.style.display = "none";
    showToast("New Master Photo captured via webcam!", "success");
  });

  cancelCamBtn.addEventListener("click", () => {
    if (editCameraStream) {
      editCameraStream.getTracks().forEach(t => t.stop());
      editCameraStream = null;
    }
    camInline.style.display = "none";
  });

  // Edit via Laptop File Upload
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      editCapturedMasterPhoto = ev.target.result;
      previewImg.src = editCapturedMasterPhoto;
      showToast("New Master Photo uploaded from laptop!", "success");
    };
    reader.readAsDataURL(file);
  });

  // Save Employee Changes
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const empId = document.getElementById("editEmpId").value;
    const name = document.getElementById("editEmpName").value.trim();
    const role = document.getElementById("editEmpRole").value.trim();
    const username = document.getElementById("editEmpUsername").value.trim().toLowerCase();
    const password = document.getElementById("editEmpPassword").value.trim();
    const geofenceRule = document.getElementById("editEmpGeofenceRule").value;
    const mgrSel = document.getElementById("editEmpManager");
    const managerId = mgrSel ? mgrSel.value : "";

    let employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    const emp = employees.find(item => item.id === empId);

    if (emp) {
      emp.name = name;
      emp.role = role;
      emp.username = username;
      emp.password = password;
      emp.geofenceEnforcement = geofenceRule;
      // Never allow an employee to manage themselves.
      emp.managerId = (managerId && managerId !== empId) ? managerId : "";
      if (editCapturedMasterPhoto) {
        emp.avatar = editCapturedMasterPhoto;
      }

      setStore(STORAGE_KEYS.EMPLOYEES, employees);
      closeEditEmployeeModal();
      renderRosterTable();
      renderMonthlyReport();
      showToast(`Employee ${name} (${empId}) profile and baseline photo updated!`, "success");
    }
  });
}

// Enrollment Form (Add New Employee)
function initEnrollmentForm() {
  const form = document.getElementById("addEmployeeForm");
  const captureCamBtn = document.getElementById("adminCaptureCamBtn");
  const snapPhotoBtn = document.getElementById("adminSnapPhotoBtn");
  const cancelCamBtn = document.getElementById("adminCancelCamBtn");
  const fileInput = document.getElementById("adminPhotoFileInput");
  const previewImg = document.getElementById("newEmpPhotoPreview");
  const camInline = document.getElementById("adminCamInline");
  const video = document.getElementById("adminWebcamVideo");

  captureCamBtn.addEventListener("click", async () => {
    try {
      adminCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } }
      });
      video.srcObject = adminCameraStream;
      video.play();
      camInline.style.display = "flex";
    } catch (err) {
      showToast("Cannot access camera on this device.", "warning");
    }
  });

  snapPhotoBtn.addEventListener("click", () => {
    if (!video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    adminCapturedMasterPhoto = canvas.toDataURL("image/jpeg", 0.9);
    previewImg.src = adminCapturedMasterPhoto;
    document.getElementById("photoStatusBadge").innerHTML = `<i class="fa-solid fa-check"></i> Master Photo Captured`;

    if (adminCameraStream) {
      adminCameraStream.getTracks().forEach(t => t.stop());
      adminCameraStream = null;
    }
    camInline.style.display = "none";
    showToast("Master Reference Photo captured successfully!", "success");
  });

  cancelCamBtn.addEventListener("click", () => {
    if (adminCameraStream) {
      adminCameraStream.getTracks().forEach(t => t.stop());
      adminCameraStream = null;
    }
    camInline.style.display = "none";
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      adminCapturedMasterPhoto = ev.target.result;
      previewImg.src = adminCapturedMasterPhoto;
      document.getElementById("photoStatusBadge").innerHTML = `<i class="fa-solid fa-check"></i> Master Photo Uploaded`;
      showToast("Master Reference Photo loaded from laptop!", "success");
    };
    reader.readAsDataURL(file);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("newEmpName").value.trim();
    const role = document.getElementById("newEmpRole").value.trim();
    const dept = document.getElementById("newEmpDept").value;
    const username = document.getElementById("newEmpUsername").value.trim().toLowerCase();
    const password = document.getElementById("newEmpPassword").value.trim();
    const geofenceRule = document.getElementById("newEmpGeofenceRule").value;
    const newMgrSel = document.getElementById("newEmpManager");

    if (!name || !role || !username || !password) return;

    const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    if (employees.some(emp => emp.username === username)) {
      showToast("Username already exists. Choose a different one.", "error");
      return;
    }

    const newId = `EMP${String(employees.length + 1).padStart(3, "0")}`;
    const newEmp = {
      id: newId,
      name: name,
      username: username,
      password: password,
      role: role,
      department: dept,
      geofenceEnforcement: geofenceRule,
      managerId: newMgrSel ? newMgrSel.value : "",
      avatar: adminCapturedMasterPhoto || previewImg.src,
      enrolledAt: formatDateKey(new Date())
    };

    // Ensure newly enrolled member has completely clean slate (no previous present, leave, or absent history)
    const allRecords = getStore(STORAGE_KEYS.RECORDS, {});
    let recordsUpdated = false;
    Object.keys(allRecords).forEach(k => {
      if (k.startsWith(`${newId}_`)) {
        delete allRecords[k];
        recordsUpdated = true;
      }
    });
    if (recordsUpdated) setStore(STORAGE_KEYS.RECORDS, allRecords);

    const allLeavesStore = getStore(STORAGE_KEYS.LEAVES, []);
    const filteredLeaves = allLeavesStore.filter(l => l.employeeId !== newId);
    if (filteredLeaves.length !== allLeavesStore.length) setStore(STORAGE_KEYS.LEAVES, filteredLeaves);

    const allWfhStore = getStore(STORAGE_KEYS.WFH, []);
    const filteredWfh = allWfhStore.filter(w => w.employeeId !== newId);
    if (filteredWfh.length !== allWfhStore.length) setStore(STORAGE_KEYS.WFH, filteredWfh);

    const allRegsStore = getStore(STORAGE_KEYS.REGULARISATIONS, []);
    const filteredRegs = allRegsStore.filter(r => r.employeeId !== newId);
    if (filteredRegs.length !== allRegsStore.length) setStore(STORAGE_KEYS.REGULARISATIONS, filteredRegs);

    employees.push(newEmp);
    setStore(STORAGE_KEYS.EMPLOYEES, employees);

    form.reset();
    adminCapturedMasterPhoto = null;
    renderRosterTable();
    renderMonthlyReport();
    showToast(`Employee ${name} (${newId}) enrolled with master baseline photo! Ready to start work with clean history.`, "success");
  });
}

// ============================================================================
// 4. TAB 3: LEAVE APPROVALS (BOTH APPROVE AND REJECT)
// ============================================================================

function renderApprovalsCenter() {
  renderWfhApprovals();
  renderLeaveApprovals();
  renderRegularisationApprovals();
  updatePendingBadges();
}

// Requirement 7: Show bubble with count only if there is a pending request, otherwise hide bubble
function updatePendingBadges() {
  const wfh = getStore(STORAGE_KEYS.WFH, []);
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);

  const pendingWfh = wfh.filter(w => w.status === "Pending" || w.status === "Cancellation Requested").length;
  const pendingLeaves = leaves.filter(l => l.status === "Pending" || l.status === "Cancellation Requested").length;
  const pendingRegs = regs.filter(r => r.status === "Pending").length;

  const total = pendingWfh + pendingLeaves + pendingRegs;
  
  // Main header tab bubble (only shows number if > 0, hidden if 0)
  const badge = document.getElementById("pendingRequestsBadge");
  if (badge) {
    if (total > 0) {
      badge.textContent = total;
      badge.style.display = "inline-flex";
    } else {
      badge.textContent = "";
      badge.style.display = "none";
    }
  }

  // Side drawer category bubbles (Requirement 7)
  const wfhBadge = document.getElementById("drawerWfhBadge");
  if (wfhBadge) {
    if (pendingWfh > 0) {
      wfhBadge.textContent = pendingWfh;
      wfhBadge.style.display = "inline-flex";
    } else {
      wfhBadge.textContent = "";
      wfhBadge.style.display = "none";
    }
  }

  const leaveBadge = document.getElementById("drawerLeaveBadge");
  if (leaveBadge) {
    if (pendingLeaves > 0) {
      leaveBadge.textContent = pendingLeaves;
      leaveBadge.style.display = "inline-flex";
    } else {
      leaveBadge.textContent = "";
      leaveBadge.style.display = "none";
    }
  }

  const regBadge = document.getElementById("drawerRegBadge");
  if (regBadge) {
    if (pendingRegs > 0) {
      regBadge.textContent = pendingRegs;
      regBadge.style.display = "inline-flex";
    } else {
      regBadge.textContent = "";
      regBadge.style.display = "none";
    }
  }
}

// Requirement 5: Approvals Center Side Drawer switcher
function initApprovalsSideDrawer() {
  const pills = document.querySelectorAll("#approvalsNavPills .approvals-nav-pill");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");

      const targetPanelId = pill.dataset.panel;
      document.querySelectorAll(".approval-panel-view").forEach(panel => {
        panel.classList.remove("active");
      });
      const targetPanel = document.getElementById(targetPanelId);
      if (targetPanel) {
        targetPanel.classList.add("active");
      }
    });
  });
}

// -------------------------------------------------------------
// ROW 1: WORK FROM HOME APPROVALS
// -------------------------------------------------------------
function renderWfhApprovals() {
  const wfhList = getStore(STORAGE_KEYS.WFH, []);
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const tbody = document.getElementById("adminWfhTableBody");
  const emptyMsg = document.getElementById("emptyWfhMsg");

  if (!tbody) return;
  tbody.innerHTML = "";

  if (wfhList.length === 0) {
    if (emptyMsg) emptyMsg.style.display = "flex";
  } else {
    if (emptyMsg) emptyMsg.style.display = "none";
    wfhList.slice().reverse().forEach(w => {
      const emp = employees.find(e => e.id === w.employeeId) || { name: w.employeeName || w.employeeId };
      const tr = document.createElement("tr");

      let statusBadge = "";
      if (w.status === "Approved") {
        statusBadge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-check"></i> Approved</span>`;
      } else if (w.status === "Rejected") {
        statusBadge = `<span class="day-badge-pill badge-absent-day"><i class="fa-solid fa-xmark"></i> Rejected</span>`;
      } else if (w.status === "Cancellation Requested") {
        statusBadge = `<span class="day-badge-pill status-badge-cancel-pending"><i class="fa-solid fa-triangle-exclamation"></i> Cancel Requested</span>`;
      } else if (w.status === "Cancelled") {
        statusBadge = `<span class="day-badge-pill badge-absent-day">Cancelled</span>`;
      } else {
        statusBadge = `<span class="day-badge-pill badge-leave-day"><i class="fa-solid fa-clock"></i> Pending Approval</span>`;
      }

      let actionsHtml = "";
      if (w.status === "Pending") {
        actionsHtml = `
          <div class="action-btn-cluster">
            <button class="btn btn-xs btn-primary approve-wfh-btn" data-id="${w.id}">
              <i class="fa-solid fa-check"></i> Approve
            </button>
            <button class="btn btn-xs btn-ghost text-danger reject-wfh-btn" data-id="${w.id}">
              <i class="fa-solid fa-xmark"></i> Reject
            </button>
          </div>
        `;
      } else if (w.status === "Cancellation Requested") {
        actionsHtml = `
          <div class="action-btn-cluster">
            <button class="btn btn-xs btn-danger approve-wfh-cancel-btn" data-id="${w.id}">
              <i class="fa-solid fa-ban"></i> Approve Cancel
            </button>
            <button class="btn btn-xs btn-ghost reject-wfh-cancel-btn" data-id="${w.id}">
              Keep WFH
            </button>
          </div>
        `;
      } else {
        actionsHtml = `<span class="text-muted font-mono">${w.status}</span>`;
      }

      tr.innerHTML = `
        <td>
          <strong class="font-bold">${emp.name}</strong>
          <span class="table-sub font-mono">${w.employeeId}</span>
        </td>
        <td><strong class="font-mono text-primary">${w.date}</strong></td>
        <td><span class="font-mono">${w.weekKey || '-'}</span></td>
        <td>${statusBadge}</td>
        <td>${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".approve-wfh-btn").forEach(btn => {
      btn.addEventListener("click", () => handleWfhDecision(btn.dataset.id, "Approved"));
    });
    tbody.querySelectorAll(".reject-wfh-btn").forEach(btn => {
      btn.addEventListener("click", () => handleWfhDecision(btn.dataset.id, "Rejected"));
    });
    tbody.querySelectorAll(".approve-wfh-cancel-btn").forEach(btn => {
      btn.addEventListener("click", () => handleWfhDecision(btn.dataset.id, "ApproveCancellation"));
    });
    tbody.querySelectorAll(".reject-wfh-cancel-btn").forEach(btn => {
      btn.addEventListener("click", () => handleWfhDecision(btn.dataset.id, "RejectCancellation"));
    });
  }
}

function handleWfhDecision(id, decision) {
  let wfhList = getStore(STORAGE_KEYS.WFH, []);
  const req = wfhList.find(w => w.id === id);
  if (!req) return;

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === req.employeeId) || { avatar: null };

  if (decision === "Approved") {
    req.status = "Approved";
    records[`${req.employeeId}_${req.date}`] = {
      employeeId: req.employeeId,
      date: req.date,
      status: "WFH",
      checkInTime: "09:00 AM",
      checkOutTime: "06:00 PM",
      duration: "Scheduled Shift",
      hoursDecimal: 9.0,
      distance: 0,
      locationType: "Work From Home (Approved)",
      bioVerified: true,
      selfieUrl: emp.avatar
    };
    setStore(STORAGE_KEYS.RECORDS, records);
    showToast(`WFH request on ${req.date} approved and applied to calendar!`, "success");
  } else if (decision === "Rejected") {
    req.status = "Rejected";
    showToast(`WFH request on ${req.date} rejected.`, "warning");
  } else if (decision === "ApproveCancellation") {
    req.status = "Cancelled";
    if (records[`${req.employeeId}_${req.date}`] && records[`${req.employeeId}_${req.date}`].status === "WFH") {
      delete records[`${req.employeeId}_${req.date}`];
      setStore(STORAGE_KEYS.RECORDS, records);
    }
    showToast(`WFH on ${req.date} cancelled and removed from calendar.`, "info");
  } else if (decision === "RejectCancellation") {
    req.status = "Approved";
    showToast(`Cancellation rejected; WFH on ${req.date} remains approved.`, "info");
  }

  setStore(STORAGE_KEYS.WFH, wfhList);
  if (typeof pushNotification === "function") {
    const WFH_MSG = { Approved: `Your WFH request for ${req.date} was approved.`, Rejected: `Your WFH request for ${req.date} was rejected.`, Cancelled: `Your WFH cancellation for ${req.date} was approved — the day is no longer marked WFH.`, ApprovedAgain: `Your WFH cancellation for ${req.date} was rejected; WFH remains approved.` };
    const msgKey = decision === "ApproveCancellation" ? "Cancelled" : (decision === "RejectCancellation" ? "ApprovedAgain" : decision);
    if (WFH_MSG[msgKey]) pushNotification(req.employeeId, msgKey === "Rejected" ? "rejected" : (msgKey === "Approved" ? "approved" : "info"), msgKey === "Approved" ? "WFH Approved" : (msgKey === "Rejected" ? "WFH Rejected" : "WFH Update"), WFH_MSG[msgKey], "requests");
  }
  renderApprovalsCenter();
  renderMonthlyReport();
}

// -------------------------------------------------------------
// ROW 2: LEAVE APPROVALS
// -------------------------------------------------------------
function renderLeaveApprovals() {
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const leavesTbody = document.getElementById("adminLeavesTableBody");
  const emptyLeaves = document.getElementById("emptyLeavesMsg");

  if (!leavesTbody) return;
  leavesTbody.innerHTML = "";

  if (leaves.length === 0) {
    if (emptyLeaves) emptyLeaves.style.display = "flex";
  } else {
    if (emptyLeaves) emptyLeaves.style.display = "none";
    leaves.slice().reverse().forEach(l => {
      const emp = employees.find(e => e.id === l.employeeId) || { name: l.employeeName || l.employeeId };
      const tr = document.createElement("tr");
      const isRh = l.category === "RH" || l.category === "Restricted";
      const isLop = l.category === "LossOfPay" || (l.type || "").indexOf("Loss of Pay") !== -1;

      let statusBadge = "";
      if (l.status === "Approved") {
        statusBadge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-check"></i> Approved</span>`;
      } else if (l.status === "Rejected") {
        statusBadge = `<span class="day-badge-pill badge-absent-day"><i class="fa-solid fa-xmark"></i> Rejected</span>`;
      } else if (l.status === "Cancellation Requested") {
        statusBadge = `<span class="day-badge-pill status-badge-cancel-pending"><i class="fa-solid fa-triangle-exclamation"></i> Cancel Requested</span>`;
      } else if (l.status === "Cancelled") {
        statusBadge = `<span class="day-badge-pill badge-absent-day">Cancelled</span>`;
      } else {
        statusBadge = `<span class="day-badge-pill badge-leave-day"><i class="fa-solid fa-clock"></i> Pending Approval</span>`;
      }

      let actionsHtml = "";
      if (l.status === "Pending") {
        actionsHtml = `
          <div class="action-btn-cluster">
            <button class="btn btn-xs btn-primary approve-leave-btn" data-id="${l.id}">
              <i class="fa-solid fa-check"></i> Approve
            </button>
            <button class="btn btn-xs btn-ghost text-danger reject-leave-btn" data-id="${l.id}">
              <i class="fa-solid fa-xmark"></i> Reject
            </button>
          </div>
        `;
      } else if (l.status === "Cancellation Requested") {
        actionsHtml = `
          <div class="action-btn-cluster">
            <button class="btn btn-xs btn-danger approve-leave-cancel-btn" data-id="${l.id}">
              <i class="fa-solid fa-ban"></i> Approve Cancel
            </button>
            <button class="btn btn-xs btn-ghost reject-leave-cancel-btn" data-id="${l.id}">
              Keep Leave
            </button>
          </div>
        `;
      } else {
        actionsHtml = `<span class="text-muted font-mono">${l.status}</span>`;
      }

      tr.innerHTML = `
        <td>
          <strong class="font-bold">${emp.name}</strong>
          <span class="table-sub font-mono">${l.employeeId}</span>
        </td>
        <td>
          ${isLop ? '<span class="day-badge-pill badge-lop-day">Loss of Pay</span>' : `<span class="day-badge-pill ${isRh ? 'badge-rh-day' : 'badge-leave-day'}">${isRh ? 'Restricted Holiday (RH)' : 'Personal Leave'}</span>`}
        </td>
        <td><strong class="font-mono">${l.startDate}</strong>${l.startDate !== l.endDate ? ` to <strong class="font-mono">${l.endDate}</strong>` : ''}</td>
        <td><span class="font-bold text-warning">${l.daysCount} Day(s)</span></td>
        <td>${l.reason || '-'}</td>
        <td>${statusBadge}</td>
        <td>${actionsHtml}</td>
      `;
      leavesTbody.appendChild(tr);
    });

    leavesTbody.querySelectorAll(".approve-leave-btn").forEach(btn => {
      btn.addEventListener("click", () => handleLeaveDecision(btn.dataset.id, "Approved"));
    });
    leavesTbody.querySelectorAll(".reject-leave-btn").forEach(btn => {
      btn.addEventListener("click", () => handleLeaveDecision(btn.dataset.id, "Rejected"));
    });
    leavesTbody.querySelectorAll(".approve-leave-cancel-btn").forEach(btn => {
      btn.addEventListener("click", () => handleLeaveDecision(btn.dataset.id, "ApproveCancellation"));
    });
    leavesTbody.querySelectorAll(".reject-leave-cancel-btn").forEach(btn => {
      btn.addEventListener("click", () => handleLeaveDecision(btn.dataset.id, "RejectCancellation"));
    });
  }
}

function handleLeaveDecision(id, decision) {
  let leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const req = leaves.find(l => l.id === id);
  if (!req) return;

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const isRh = req.category === "RH" || req.category === "Restricted";
  const isLop = req.category === "LossOfPay";

  if (decision === "Approved") {
    req.status = "Approved";
    const cur = new Date(req.startDate + "T00:00:00");
    const end = new Date(req.endDate + "T00:00:00");
    while (cur <= end) {
      if (cur.getDay() !== 0 && cur.getDay() !== 6) {
        const dStr = formatDateKey(cur);
        records[`${req.employeeId}_${dStr}`] = {
          employeeId: req.employeeId,
          date: dStr,
          status: isLop ? "Loss of Pay" : "Leave",
          checkInTime: "-",
          checkOutTime: "-",
          duration: isLop ? "Loss of Pay (Unpaid)" : (isRh ? "Restricted Holiday (RH)" : "Personal Leave"),
          hoursDecimal: 0,
          distance: 0,
          locationType: `${isLop ? "Loss of Pay" : (isRh ? "RH" : "Personal Leave")} (Approved)`,
          bioVerified: false,
          selfieUrl: null
        };
      }
      cur.setDate(cur.getDate() + 1);
    }
    setStore(STORAGE_KEYS.RECORDS, records);
    showToast(`Leave request ${id} approved and marked on calendar!`, "success");
  } else if (decision === "Rejected") {
    req.status = "Rejected";
    showToast(`Leave request ${id} rejected.`, "warning");
  } else if (decision === "ApproveCancellation") {
    req.status = "Cancelled";
    const cur = new Date(req.startDate + "T00:00:00");
    const end = new Date(req.endDate + "T00:00:00");
    while (cur <= end) {
      const dStr = formatDateKey(cur);
      if (records[`${req.employeeId}_${dStr}`] && (records[`${req.employeeId}_${dStr}`].status === "Leave" || records[`${req.employeeId}_${dStr}`].status === "Loss of Pay")) {
        delete records[`${req.employeeId}_${dStr}`];
      }
      cur.setDate(cur.getDate() + 1);
    }
    setStore(STORAGE_KEYS.RECORDS, records);
    showToast(`Leave request ${id} cancelled and calendar reverted.`, "info");
  } else if (decision === "RejectCancellation") {
    req.status = "Approved";
    showToast(`Leave cancellation request rejected; leave remains approved.`, "info");
  }

  setStore(STORAGE_KEYS.LEAVES, leaves);
  if (typeof pushNotification === "function") {
    const kind = decision === "Approved" ? "approved" : (decision === "Rejected" ? "rejected" : (decision === "ApproveCancellation" ? "cancelled" : "info"));
    const dates = req.startDate === req.endDate ? req.startDate : `${req.startDate} → ${req.endDate}`;
    const TITLE = { Approved: "Leave Approved", Rejected: "Leave Rejected", ApproveCancellation: "Leave Cancelled", RejectCancellation: "Cancellation Rejected" };
    const TEXT = { Approved: `Your ${req.type || "leave"} request (${dates}) was approved.`, Rejected: `Your ${req.type || "leave"} request (${dates}) was rejected.`, ApproveCancellation: `Your cancellation for ${dates} was approved — the days are back on the floor.`, RejectCancellation: `Your cancellation for ${dates} was rejected; the leave remains approved.` };
    if (TITLE[decision]) pushNotification(req.employeeId, kind, TITLE[decision], TEXT[decision], "requests");
  }
  renderApprovalsCenter();
  renderMonthlyReport();
}

// -------------------------------------------------------------
// ROW 3: ATTENDANCE REGULARISATION APPROVALS
// -------------------------------------------------------------
function renderRegularisationApprovals() {
  const regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const tbody = document.getElementById("adminRegularisationTableBody");
  const emptyMsg = document.getElementById("emptyRegularisationMsg");

  if (!tbody) return;
  tbody.innerHTML = "";

  if (regs.length === 0) {
    if (emptyMsg) emptyMsg.style.display = "flex";
  } else {
    if (emptyMsg) emptyMsg.style.display = "none";
    regs.slice().reverse().forEach(r => {
      const emp = employees.find(e => e.id === r.employeeId) || { name: r.employeeName || r.employeeId };
      const tr = document.createElement("tr");

      let statusBadge = "";
      if (r.status === "Approved") {
        statusBadge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-check"></i> Regularised</span>`;
      } else if (r.status === "Rejected") {
        statusBadge = `<span class="day-badge-pill badge-absent-day"><i class="fa-solid fa-xmark"></i> Rejected</span>`;
      } else if (r.status === "Cancelled") {
        statusBadge = `<span class="day-badge-pill badge-absent-day">Cancelled</span>`;
      } else {
        statusBadge = `<span class="day-badge-pill badge-leave-day"><i class="fa-solid fa-clock"></i> Pending Approval</span>`;
      }

      let actionsHtml = "";
      if (r.status === "Pending") {
        actionsHtml = `
          <div class="action-btn-cluster">
            <button class="btn btn-xs btn-primary approve-reg-btn" data-id="${r.id}">
              <i class="fa-solid fa-check"></i> Approve Regularisation
            </button>
            <button class="btn btn-xs btn-ghost text-danger reject-reg-btn" data-id="${r.id}">
              <i class="fa-solid fa-xmark"></i> Reject
            </button>
          </div>
        `;
      } else {
        actionsHtml = `<span class="text-muted font-mono">${r.status}</span>`;
      }

      tr.innerHTML = `
        <td>
          <strong class="font-bold">${emp.name}</strong>
          <span class="table-sub font-mono">${r.employeeId}</span>
        </td>
        <td><strong class="font-mono text-primary">${r.date}</strong></td>
        <td><span class="badge-mini">${r.type || 'Missed Punch'}</span></td>
        <td><span class="font-mono">${r.inTime || '09:00 AM'} &bull; ${r.outTime || '06:00 PM'}</span></td>
        <td>${r.reason || '-'}</td>
        <td>${statusBadge}</td>
        <td>${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".approve-reg-btn").forEach(btn => {
      btn.addEventListener("click", () => handleRegularisationDecision(btn.dataset.id, "Approved"));
    });
    tbody.querySelectorAll(".reject-reg-btn").forEach(btn => {
      btn.addEventListener("click", () => handleRegularisationDecision(btn.dataset.id, "Rejected"));
    });
  }
}

function handleRegularisationDecision(id, decision) {
  let regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
  const req = regs.find(r => r.id === id);
  if (!req) return;

  req.status = decision;
  setStore(STORAGE_KEYS.REGULARISATIONS, regs);

  if (decision === "Approved") {
    const records = getStore(STORAGE_KEYS.RECORDS, {});
    const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    const emp = employees.find(e => e.id === req.employeeId) || {};

    records[`${req.employeeId}_${req.date}`] = {
      employeeId: req.employeeId,
      date: req.date,
      status: "Present",
      checkInTime: req.inTime || "09:15 AM",
      checkOutTime: req.outTime || "06:15 PM",
      duration: "Regularised Shift (9h 00m)",
      hoursDecimal: 9.0,
      distance: 25,
      locationType: "Office (Regularised by Admin)",
      bioVerified: true,
      regularised: true,
      capturedTimestamp: Date.now(),
      selfieUrl: emp.avatar || null
    };
    setStore(STORAGE_KEYS.RECORDS, records);
    showToast(`Attendance regularised! ${req.employeeName || req.employeeId} marked Present on ${req.date}.`, "success");
  } else {
    showToast(`Regularisation request for ${req.date} rejected.`, "warning");
  }

  if (typeof pushNotification === "function") {
    pushNotification(req.employeeId, decision === "Approved" ? "approved" : "rejected",
      decision === "Approved" ? "Regularisation Approved" : "Regularisation Rejected",
      decision === "Approved" ? `Your regularisation for ${req.date} was approved — you're marked Present.` : `Your regularisation for ${req.date} was rejected.`,
      "requests");
  }
  renderApprovalsCenter();
  renderMonthlyReport();
}

// ============================================================================
// 5. TAB 4: COMPANY HOLIDAYS & LEAVE POLICIES MANAGEMENT
// ============================================================================

function renderHolidaysTable() {
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const tbody = document.getElementById("adminHolidaysTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  holidays.sort((a, b) => a.date.localeCompare(b.date)).forEach(h => {
    const isRh = h.type === "Restricted Holiday";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong class="font-mono">${h.date}</strong></td>
      <td><span class="font-bold">${h.name}</span></td>
      <td>
        <span class="day-badge-pill ${isRh ? 'badge-rh-day' : 'badge-holiday-day'}">
          <i class="fa-solid ${isRh ? 'fa-calendar-star' : 'fa-calendar-check'}"></i> ${h.type || 'Declared Holiday'}
        </span>
      </td>
      <td>
        <button class="btn btn-ghost btn-xs text-danger delete-holiday-btn" data-id="${h.id}" title="Remove Holiday">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".delete-holiday-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      let list = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
      list = list.filter(h => h.id !== id);
      setStore(STORAGE_KEYS.HOLIDAYS, list);
      renderHolidaysTable();
      renderMonthlyReport();
      showToast("Company holiday removed from calendar.", "info");
    });
  });
}

function initHolidayForm() {
  const form = document.getElementById("addHolidayForm");
  const nameInput = document.getElementById("newHolidayName");
  const dateInput = document.getElementById("newHolidayDate");
  const typeSelect = document.getElementById("newHolidayType");

  if (!form) return;
  dateInput.value = "2026-11-01";

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const date = dateInput.value;
    const type = typeSelect.value; // Strictly "Declared Holiday" or "Restricted Holiday"

    if (!name || !date) return;

    let holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
    holidays.push({
      id: `HOL-${Date.now()}`,
      name: name,
      date: date,
      type: type
    });

    setStore(STORAGE_KEYS.HOLIDAYS, holidays);
    form.reset();
    dateInput.value = "2026-11-01";
    renderHolidaysTable();
    renderMonthlyReport();
    showToast(`Added ${type}: "${name}" on ${date}!`, "success");
  });
}

// Company-Wide Central Leave Quotas (Admin updates once for everyone)
function initGlobalLeaveQuotasForm() {
  const form = document.getElementById("globalLeaveQuotasForm");
  const personalInp = document.getElementById("globalPersonalQuotaInput");
  const rhInp = document.getElementById("globalRhQuotaInput");

  if (!form) return;

  const currentQ = getGlobalLeaveQuotas();
  personalInp.value = currentQ.personalLeave;
  rhInp.value = currentQ.restrictedLeave;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pVal = parseInt(personalInp.value, 10) || 14;
    const rhVal = parseInt(rhInp.value, 10) || 2;

    setGlobalLeaveQuotas({ personalLeave: pVal, restrictedLeave: rhVal });
    showToast(`Company-wide leave policy updated: ${pVal} Personal Days / ${rhVal} Restricted Days!`, "success");
  });
}

// Minimum Shift Hours & Punch-Out Restriction Policy Form
function initMinWorkPolicyForm() {
  const form = document.getElementById("minWorkPolicyForm");
  const hoursInput = document.getElementById("policyMinHoursInput");
  const minsInput = document.getElementById("policyMinMinutesInput");
  const previewText = document.getElementById("previewPolicyDurationText");

  if (!form) return;

  const currentPolicy = getMinWorkDurationPolicy();
  if (hoursInput) hoursInput.value = currentPolicy.hours;
  if (minsInput) minsInput.value = currentPolicy.minutes;

  function updatePreview() {
    const h = parseInt(hoursInput.value, 10) || 0;
    const m = parseInt(minsInput.value, 10) || 0;
    if (previewText) {
      previewText.textContent = `${h} hour${h === 1 ? '' : 's'} ${String(m).padStart(2, '0')} minutes`;
    }
  }

  if (hoursInput) hoursInput.addEventListener("input", updatePreview);
  if (minsInput) minsInput.addEventListener("input", updatePreview);
  updatePreview();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const h = parseInt(hoursInput.value, 10) || 8;
    const m = parseInt(minsInput.value, 10) || 0;

    const saved = setMinWorkDurationPolicy(h, m);
    updatePreview();
    showToast(`Minimum shift duration saved: ${saved.hours}h ${String(saved.minutes).padStart(2, '0')}m required before punch-out.`, "success");
  });
}

// ============================================================================
// 6. TAB 5: 24-HOUR ATTENDANCE PHOTOS VIEWER
// ============================================================================

function renderAttendancePhotosTable() {
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const tbody = document.getElementById("attendancePhotosTableBody");
  const emptyMsg = document.getElementById("emptyPhotosMsg");
  if (!tbody) return;
  tbody.innerHTML = "";

  const now = Date.now();
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  // Gather both check-in (selfieUrl) and check-out (outSelfieUrl) photos
  const photoItems = [];

  Object.values(records).forEach(r => {
    const isWithin24h = r.capturedTimestamp && (now - r.capturedTimestamp) <= TWENTY_FOUR_HOURS;
    const isTodayOrRecent = isWithin24h || r.date === formatDateKey(CURRENT_DATE) || r.date === "2026-10-07";

    if (r.selfieUrl && isTodayOrRecent) {
      photoItems.push({
        recordKey: `${r.employeeId}_${r.date}`,
        employeeId: r.employeeId,
        date: r.date,
        time: r.checkInTime || "Check-In",
        photoUrl: r.selfieUrl,
        type: "Check-In",
        distance: r.distance || 40,
        timestamp: r.capturedTimestamp || (now - 3600000)
      });
    }

    if (r.outSelfieUrl && isTodayOrRecent) {
      photoItems.push({
        recordKey: `${r.employeeId}_${r.date}`,
        employeeId: r.employeeId,
        date: r.date,
        time: r.checkOutTime || "Check-Out",
        photoUrl: r.outSelfieUrl,
        type: "Check-Out",
        distance: r.outDistance || r.distance || 45,
        timestamp: (r.capturedTimestamp ? r.capturedTimestamp + 28800000 : now)
      });
    }
  });

  photoItems.sort((a, b) => b.timestamp - a.timestamp);

  if (photoItems.length === 0) {
    if (emptyMsg) emptyMsg.style.display = "flex";
  } else {
    if (emptyMsg) emptyMsg.style.display = "none";
    photoItems.forEach(item => {
      const emp = employees.find(e => e.id === item.employeeId) || { name: item.employeeId, avatar: item.photoUrl };
      const tr = document.createElement("tr");

      // Column 1 (Requirement 4): Photo snapshot, employee name, date & time, GPS distance only
      tr.innerHTML = `
        <td>
          <div class="photo-cell-clickable view-photo-trigger" data-key="${item.recordKey}" data-photo="${encodeURIComponent(item.photoUrl)}" data-type="${item.type}" title="Click to view full photo snapshot" style="cursor: pointer; display: inline-block; position: relative;">
            <img src="${item.photoUrl}" onerror="this.onerror=null;this.src='${emp.avatar}';" alt="${emp.name}" class="roster-avatar-thumb clickable-photo-thumb" style="width:48px;height:48px;border-radius:10px;object-fit:cover;border:2px solid var(--border-color);">
            <span class="photo-zoom-icon" style="position:absolute;bottom:-3px;right:-3px;background:var(--accent-primary);color:#fff;border-radius:50%;width:18px;height:18px;font-size:10px;display:flex;align-items:center;justify-content:center;">
              <i class="fa-solid fa-magnifying-glass-plus"></i>
            </span>
          </div>
        </td>
        <td>
          <strong class="font-bold">${emp.name}</strong>
          <span class="table-sub font-mono">${item.employeeId} &bull; <strong class="text-primary">${item.type}</strong></span>
        </td>
        <td>
          <span class="font-mono font-bold">${item.date}</span>
          <div class="table-sub font-mono">${item.time}</div>
        </td>
        <td>
          <span class="font-mono font-bold text-primary">${item.distance}m</span>
        </td>
        <td style="text-align: center;">
          <button type="button" class="btn-delete-photo" title="Delete Photo" data-key="${item.recordKey}" data-type="${item.type}" data-emp="${emp.name}" data-date="${item.date}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Attach click listeners to open full photo lightbox
    tbody.querySelectorAll(".view-photo-trigger").forEach(el => {
      el.addEventListener("click", () => {
        const photo = decodeURIComponent(el.dataset.photo || "");
        openPhotoLightbox(el.dataset.key, photo, el.dataset.type);
      });
    });

    // Attach click listeners to delete photo button (Requirement 3: bin logo in each row)
    tbody.querySelectorAll(".btn-delete-photo").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const recordKey = btn.dataset.key;
        const photoType = btn.dataset.type; // "Check-In" or "Check-Out"
        const empName = btn.dataset.emp || "employee";
        const date = btn.dataset.date;

        if (confirm(`Delete ${photoType} photo for ${empName} (${date})?`)) {
          const records = getStore(STORAGE_KEYS.RECORDS, {});
          const rec = records[recordKey];
          if (rec) {
            if (photoType === "Check-In") {
              rec.selfieUrl = null;
              rec.photoVerified = false;
            } else if (photoType === "Check-Out") {
              rec.outSelfieUrl = null;
            }
            setStore(STORAGE_KEYS.RECORDS, records);
            showToast(`Deleted ${photoType} photo for ${empName}.`, "success");
            renderAttendancePhotosTable();
          }
        }
      });
    });
  }

  // Column 2 (Requirement 4): Small checklist of working staff right now or today
  renderTodayWorkingChecklist();
}

function renderTodayWorkingChecklist() {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  const todayKey = formatDateKey(new Date());

  const container = document.getElementById("todayStaffChecklist");
  const workingNowEl = document.getElementById("workingNowCount");
  const punchedTodayEl = document.getElementById("punchedTodayCount");
  if (!container) return;

  container.innerHTML = "";

  let workingNowCount = 0;
  let punchedTodayCount = 0;

  // Build checklist items with priority rank as requested:
  // 1) working, 2) working from home, 3) completed, 4) absent, 5) leave taken
  const staffList = employees.map(emp => {
    const rec = records[`${emp.id}_${todayKey}`];
    const hasPunchedIn = Boolean(rec && rec.checkInTime && rec.checkInTime !== "-");
    const hasPunchedOut = Boolean(rec && rec.checkOutTime && rec.checkOutTime !== "-");
    const isWorkingNow = hasPunchedIn && !hasPunchedOut;

    if (isWorkingNow) workingNowCount++;
    if (hasPunchedIn) punchedTodayCount++;

    const isLeave = leaves.some(l => l.employeeId === emp.id && l.status === "Approved" && l.startDate <= todayKey && l.endDate >= todayKey);
    const isWfh = allWfh.some(w => w.employeeId === emp.id && w.date === todayKey && w.status === "Approved");

    let priority = 4;
    let statusBadge = "";
    let cardClass = "checklist-emp-card not-punched";
    let checkboxClass = "checklist-checkbox-indicator unchecked";
    let checkboxIcon = "";

    if (isWorkingNow) {
      priority = 1; // 1) Working
      cardClass = "checklist-emp-card active-shift";
      checkboxClass = "checklist-checkbox-indicator checked-active";
      checkboxIcon = `<i class="fa-solid fa-check"></i>`;
      statusBadge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-spinner fa-spin"></i> Working Now</span>`;
    } else if (isWfh) {
      priority = 2; // 2) Working from home
      cardClass = "checklist-emp-card active-shift";
      checkboxClass = "checklist-checkbox-indicator checked-active";
      checkboxIcon = `<i class="fa-solid fa-house-laptop"></i>`;
      statusBadge = `<span class="day-badge-pill badge-wfh-day"><i class="fa-solid fa-house-laptop"></i> WFH Today</span>`;
    } else if (hasPunchedIn && hasPunchedOut) {
      priority = 3; // 3) Completed
      cardClass = "checklist-emp-card completed-shift";
      checkboxClass = "checklist-checkbox-indicator checked-done";
      checkboxIcon = `<i class="fa-solid fa-check-double"></i>`;
      statusBadge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-circle-check"></i> Shift Done</span>`;
    } else if (isLeave) {
      priority = 5; // 5) Leave taken
      cardClass = "checklist-emp-card not-punched";
      checkboxClass = "checklist-checkbox-indicator unchecked";
      checkboxIcon = `<i class="fa-solid fa-umbrella-beach"></i>`;
      statusBadge = `<span class="day-badge-pill badge-rh-day"><i class="fa-solid fa-umbrella-beach"></i> On Leave</span>`;
    } else {
      priority = 4; // 4) Absent
      cardClass = "checklist-emp-card not-punched";
      checkboxClass = "checklist-checkbox-indicator unchecked";
      checkboxIcon = "";
      if (emp.enrolledAt === todayKey) {
        statusBadge = `<span class="day-badge-pill" style="background:rgba(59,130,246,0.12);color:#3b82f6;"><i class="fa-solid fa-user-clock"></i> New Member</span>`;
      } else {
        statusBadge = `<span class="day-badge-pill" style="background:rgba(239,68,68,0.12);color:#ef4444;"><i class="fa-solid fa-user-xmark"></i> Absent</span>`;
      }
    }

    const inTime = rec?.checkInTime && rec.checkInTime !== "-" ? rec.checkInTime : "--:--";
    const outTime = rec?.checkOutTime && rec.checkOutTime !== "-" ? rec.checkOutTime : (isWorkingNow ? "Active Shift" : (isWfh ? "Remote Shift" : "--:--"));

    return {
      emp,
      rec,
      hasPunchedIn,
      hasPunchedOut,
      isWorkingNow,
      isWfh,
      isLeave,
      priority,
      statusBadge,
      cardClass,
      checkboxClass,
      checkboxIcon,
      inTime,
      outTime
    };
  });

  // Sort strictly by priority: working (1) -> working from home (2) -> completed (3) -> absent (4) -> leave taken (5)
  staffList.sort((a, b) => a.priority - b.priority || a.emp.name.localeCompare(b.emp.name));

  staffList.forEach(item => {
    const el = document.createElement("div");
    el.className = item.cardClass;
    el.innerHTML = `
      <div class="checklist-emp-main">
        <div class="${item.checkboxClass}" title="${item.isWorkingNow ? 'Currently Working' : (item.isWfh ? 'Working From Home' : (item.hasPunchedIn ? 'Completed Shift' : (item.isLeave ? 'On Leave' : 'Absent')))}">
          ${item.checkboxIcon}
        </div>
        <img src="${item.emp.avatar}" alt="${item.emp.name}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;border:1px solid var(--border-color);">
        <div style="min-width:0;">
          <div class="font-bold text-truncate" style="font-size:0.92rem;">${item.emp.name}</div>
          <div class="table-sub font-mono" style="font-size:0.75rem;">${item.emp.id} &bull; ${item.emp.department}</div>
        </div>
      </div>
      <div class="checklist-timing-box">
        <div style="font-size:0.8rem;">
          <span class="text-muted">In:</span> <strong class="font-mono ${item.hasPunchedIn ? 'text-success' : 'text-muted'}">${item.inTime}</strong>
          <span class="text-muted" style="margin-left:6px;">Out:</span> <strong class="font-mono ${item.hasPunchedOut ? 'text-info' : (item.isWorkingNow ? 'text-warning font-bold' : 'text-muted')}">${item.outTime}</strong>
        </div>
        <div>${item.statusBadge}</div>
      </div>
    `;
    container.appendChild(el);
  });

  if (workingNowEl) workingNowEl.textContent = workingNowCount;
  if (punchedTodayEl) punchedTodayEl.textContent = `${punchedTodayCount}/${employees.length}`;
}

// Lightbox: Open Full Resolution Photo Snapshot Modal
function openPhotoLightbox(recordKey, customPhotoUrl = null, eventType = "Check-In") {
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const rec = records[recordKey];
  const photoToDisplay = customPhotoUrl || (rec ? (rec.selfieUrl || rec.outSelfieUrl) : null);
  if (!photoToDisplay) {
    showToast("Photo snapshot not available or already purged.", "warning");
    return;
  }

  const empId = rec ? rec.employeeId : (recordKey.split("_")[0] || "");
  const emp = employees.find(e => e.id === empId) || { name: empId, geofenceEnforcement: "required" };
  const isExempt = emp.geofenceEnforcement === "exempt";

  const modal = document.getElementById("photoLightboxModal");
  document.getElementById("lightboxPhotoImg").src = photoToDisplay;
  document.getElementById("lightboxEmpName").textContent = emp.name;
  document.getElementById("lightboxEmpId").textContent = `${empId} (${eventType})`;
  document.getElementById("lightboxTimestamp").textContent = rec ? `${rec.date} at ${eventType === 'Check-Out' ? (rec.checkOutTime || rec.checkInTime) : rec.checkInTime}` : "Today";
  
  const bioBadge = document.getElementById("lightboxBiometric");
  bioBadge.innerHTML = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-circle-check"></i> Biometric Verified</span>`;

  document.getElementById("lightboxDistance").textContent = `${rec ? rec.distance : 40} meters from office center`;
  document.getElementById("lightboxGeofence").innerHTML = `<span class="day-badge-pill ${isExempt ? 'badge-rh-day' : 'badge-present'}">${isExempt ? 'Geofence OFF (Exempt)' : 'Geofence Applicable (500m)'}</span>`;

  document.getElementById("lightboxRetention").textContent = "Retained in 24h photo storage";

  const downloadBtn = document.getElementById("lightboxDownloadBtn");
  downloadBtn.href = photoToDisplay;
  downloadBtn.download = `${empId}_photo.jpg`;

  modal.classList.add("open");
}

// Lightbox: Open Master Reference Photo
function openMasterPhotoLightbox(empId) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (!emp || !emp.avatar) return;

  const isExempt = emp.geofenceEnforcement === "exempt";
  const modal = document.getElementById("photoLightboxModal");

  document.getElementById("lightboxPhotoImg").src = emp.avatar;
  document.getElementById("lightboxEmpName").textContent = emp.name;
  document.getElementById("lightboxEmpId").textContent = emp.id;
  document.getElementById("lightboxTimestamp").textContent = `Enrolled Baseline Photo (${emp.enrolledAt || '2026-01-10'})`;
  document.getElementById("lightboxBiometric").innerHTML = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-id-badge"></i> Verified Profile Photo</span>`;
  document.getElementById("lightboxDistance").textContent = "Official Reference Record";
  document.getElementById("lightboxGeofence").innerHTML = `<span class="day-badge-pill ${isExempt ? 'badge-rh-day' : 'badge-present'}">${isExempt ? 'Geofence OFF (Exempt)' : 'Geofence Applicable (500m)'}</span>`;
  document.getElementById("lightboxRetention").textContent = "Permanent Master Photo";

  const downloadBtn = document.getElementById("lightboxDownloadBtn");
  downloadBtn.href = emp.avatar;
  downloadBtn.download = `${emp.id}_master_baseline.jpg`;

  modal.classList.add("open");
}

function closePhotoLightbox() {
  const modal = document.getElementById("photoLightboxModal");
  if (modal) modal.classList.remove("open");
}

function initPhotoLightboxModal() {
  const modal = document.getElementById("photoLightboxModal");
  const closeBtn = document.getElementById("closeLightboxModalBtn");
  const footerCloseBtn = document.getElementById("closeLightboxModalFooterBtn");

  if (closeBtn) closeBtn.addEventListener("click", closePhotoLightbox);
  if (footerCloseBtn) footerCloseBtn.addEventListener("click", closePhotoLightbox);

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closePhotoLightbox();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && modal.classList.contains("open")) {
      closePhotoLightbox();
    }
  });
}

// ============================================================================
// EMPLOYEE CALENDAR MODAL (opened by clicking a master-sheet row)
// ============================================================================
const empCalState = { empId: null, viewDate: null };

function openEmpCalendar(empId) {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  empCalState.empId = empId;
  if (!empCalState.viewDate) empCalState.viewDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const modal = document.getElementById("empCalendarModal");
  document.getElementById("empCalTitle").textContent = `${emp.name}'s Calendar`;
  document.getElementById("empCalSub").textContent = `${emp.id} \u2022 ${emp.department}`;
  renderEmpCalendar();
  if (modal) modal.classList.add("open");
}

function closeEmpCalendar() {
  const modal = document.getElementById("empCalendarModal");
  if (modal) modal.classList.remove("open");
}

function renderEmpCalendar() {
  const grid = document.getElementById("empCalGrid");
  const monthEl = document.getElementById("empCalMonth");
  const summaryEl = document.getElementById("empCalSummary");
  if (!grid || !empCalState.empId) return;

  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const nowZero = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const year = empCalState.viewDate.getFullYear();
  const month = empCalState.viewDate.getMonth();
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  monthEl.textContent = `${monthNames[month]} ${year}`;

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const holidayMap = {};
  holidays.forEach(h => { holidayMap[h.date] = h; });
  const regPending = {};
  try {
    getStore(STORAGE_KEYS.REGULARISATIONS, [])
      .filter(r => r.employeeId === empCalState.empId && r.status === "Pending")
      .forEach(r => { regPending[r.date] = r; });
  } catch (e) { /* ignore */ }

  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const emp = employees.find(e => e.id === empCalState.empId);
  const empEnrolledDate = emp && emp.enrolledAt ? new Date(emp.enrolledAt + "T00:00:00") : null;
  const todayKey = formatDateKey(now);

  grid.innerHTML = "";
  const firstDayIndex = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const prevTotal = new Date(year, month, 0).getDate();

  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.innerHTML = `<div class="cell-top-row"><span class="day-number">${prevTotal - i}</span></div>`;
    grid.appendChild(cell);
  }

  let s = { present: 0, wfh: 0, leave: 0, lop: 0, absent: 0, notmarked: 0 };
  for (let d = 1; d <= totalDays; d++) {
    const dateObj = new Date(year, month, d);
    const dateStr = formatDateKey(dateObj);
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
    const isToday = dateStr === todayKey;
    const declaredHoliday = holidayMap[dateStr];
    const rec = records[`${empCalState.empId}_${dateStr}`];

    let badge = "";
    let cellClass = "calendar-day-cell";
    if (isToday) cellClass += " is-today";

    if (declaredHoliday) {
      badge = `<span class="day-badge-pill badge-holiday-day" title="${declaredHoliday.name}"><i class="fa-solid fa-star"></i> ${String(declaredHoliday.name).split(/\s+/)[0]}</span>`;
    } else if (isWeekend) {
      badge = `<span class="day-badge-pill badge-weekend-day"><i class="fa-solid fa-mug-hot"></i> Weekend</span>`;
    } else if (rec) {
      if (rec.status === "Present") {
        s.present++;
        badge = `<span class="day-badge-pill badge-present"><i class="fa-solid fa-circle-check"></i> Present</span>`;
      } else if (rec.status === "WFH") {
        s.wfh++;
        badge = `<span class="day-badge-pill badge-wfh-day"><i class="fa-solid fa-house-laptop"></i> WFH</span>`;
      } else if (rec.status === "Holiday" || rec.status === "Leave") {
        s.leave++;
        const isRh = rec.locationType && rec.locationType.includes("RH");
        badge = `<span class="day-badge-pill ${isRh ? 'badge-rh-day' : 'badge-leave-day'}"><i class="fa-solid ${isRh ? 'fa-calendar-check' : 'fa-umbrella-beach'}"></i> ${isRh ? 'RH' : 'Leave'}</span>`;
      } else if (rec.status === "Loss of Pay") {
        s.lop++;
        badge = `<span class="day-badge-pill badge-lop-day" title="Loss of Pay (Approved) — unpaid"><i class="fa-solid fa-hand-holding-dollar"></i> LoP</span>`;
      } else if (rec.status === "Absent") {
        s.absent++;
        badge = `<span class="day-badge-pill badge-absent-day"><i class="fa-solid fa-circle-xmark"></i> Absent</span>`;
      }
    } else {
      const beforeEnroll = empEnrolledDate && dateObj < empEnrolledDate;
      if (dateObj < nowZero && !beforeEnroll) {
        if (regPending[dateStr]) {
          badge = `<span class="day-badge-pill badge-regpending" title="Regularisation ${regPending[dateStr].id} \u2014 awaiting review"><i class="fa-solid fa-hourglass-half"></i> Reg. Pending</span>`;
        } else {
          s.notmarked++;
          badge = `<span class="day-badge-pill badge-notmarked" title="Closed with no record \u2014 needs regularisation"><i class="fa-solid fa-circle-question"></i> Not Marked</span>`;
        }
      } else if (dateObj > nowZero) {
        badge = `<span class="day-badge-pill badge-upcoming"><i class="fa-solid fa-circle-dot"></i> Upcoming</span>`;
      } else if (isToday) {
        badge = `<span class="day-badge-pill badge-today-active"><i class="fa-solid fa-clock"></i> Today</span>`;
      }
    }

    const cell = document.createElement("div");
    cell.className = cellClass;
    cell.innerHTML = `
      <div class="cell-top-row"><span class="day-number">${d}</span>${isToday ? '<span class="today-marker-chip"><i class="fa-solid fa-star"></i> Today</span>' : ''}</div>
      <div class="cell-content">${badge}</div>
    `;
    grid.appendChild(cell);
  }

  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="emp-cal-chip chip-p"><i class="fa-solid fa-circle-check"></i> Present ${s.present}</span>
      <span class="emp-cal-chip chip-w"><i class="fa-solid fa-house-laptop"></i> WFH ${s.wfh}</span>
      <span class="emp-cal-chip chip-l"><i class="fa-solid fa-umbrella-beach"></i> Leave ${s.leave}</span>
      <span class="emp-cal-chip chip-lop"><i class="fa-solid fa-hand-holding-dollar"></i> LoP ${s.lop}</span>
      <span class="emp-cal-chip chip-n"><i class="fa-solid fa-circle-question"></i> Not marked ${s.notmarked}</span>
      <span class="emp-cal-chip chip-a"><i class="fa-solid fa-circle-xmark"></i> Absent ${s.absent}</span>
    `;
  }
}

function initEmpCalendarModal() {
  const modal = document.getElementById("empCalendarModal");
  const closeBtn = document.getElementById("closeEmpCalBtn");
  const footerBtn = document.getElementById("closeEmpCalFooterBtn");
  const prevBtn = document.getElementById("empCalPrevBtn");
  const nextBtn = document.getElementById("empCalNextBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeEmpCalendar);
  if (footerBtn) footerBtn.addEventListener("click", closeEmpCalendar);
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeEmpCalendar(); });
  if (prevBtn) prevBtn.addEventListener("click", () => { empCalState.viewDate = new Date(empCalState.viewDate.getFullYear(), empCalState.viewDate.getMonth() - 1, 1); renderEmpCalendar(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { empCalState.viewDate = new Date(empCalState.viewDate.getFullYear(), empCalState.viewDate.getMonth() + 1, 1); renderEmpCalendar(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal && modal.classList.contains("open")) closeEmpCalendar();
  });
}

// ============================================================================
// 7. TAB 6: OFFICE GEOFENCE SETTINGS (ADMIN ONLY)
// ============================================================================

function initAdminGeofence() {
  const form = document.getElementById("adminGeofenceForm");
  const nameInput = document.getElementById("adminOfficeName");
  const latInput = document.getElementById("adminOfficeLat");
  const lngInput = document.getElementById("adminOfficeLng");
  const radiusInput = document.getElementById("adminOfficeRadius");
  const radiusVal = document.getElementById("adminRadiusVal");
  const calibrateBtn = document.getElementById("adminCalibrateCurrentGpsBtn");

  const settings = getStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);

  nameInput.value = settings.name;
  latInput.value = settings.lat;
  lngInput.value = settings.lng;
  radiusInput.value = settings.radius;
  radiusVal.textContent = settings.radius;

  radiusInput.addEventListener("input", (e) => {
    radiusVal.textContent = e.target.value;
    if (adminGeofenceCircle) {
      adminGeofenceCircle.setRadius(parseInt(e.target.value, 10));
      const c = adminGeofenceCircle.getLatLng();
      placeRadiusHandle(c.lat, c.lng, adminGeofenceCircle.getRadius());
    }
  });

  calibrateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("GPS not available on this device.", "error");
      return;
    }
    calibrateBtn.disabled = true;
    calibrateBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Fetching your GPS\u2026`;
    const restoreBtn = () => {
      calibrateBtn.disabled = false;
      calibrateBtn.innerHTML = `<i class="fa-solid fa-location-dot"></i> Calibrate to My Current Device GPS`;
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latInput.value = pos.coords.latitude.toFixed(6);
        lngInput.value = pos.coords.longitude.toFixed(6);
        updateAdminMap(parseFloat(latInput.value), parseFloat(lngInput.value), parseInt(radiusInput.value, 10));
        showToast(`Office previewed at your current GPS (\u00b1${Math.round(pos.coords.accuracy)}m). Click Save & Enforce to apply.`, "success");
        restoreBtn();
      },
      (err) => {
        const codes = { 1: "Location permission denied", 2: "Location unavailable", 3: "Location request timed out" };
        showToast(`${codes[err.code] || "Failed to fetch GPS"} \u2014 use the map or place search instead.`, "warning");
        restoreBtn();
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });

  // ---- Address / place search above the map (OpenStreetMap Nominatim, no API key) ----
  const searchInput = document.getElementById("geofencePlaceSearch");
  const searchBtn = document.getElementById("geofenceSearchBtn");
  const resultsBox = document.getElementById("geofenceSearchResults");

  const renderSearchResults = (hits) => {
    if (!resultsBox) return;
    resultsBox.innerHTML = "";
    if (!hits.length) {
      const empty = document.createElement("div");
      empty.className = "map-search-empty";
      empty.textContent = "No matches found. Try a broader query (area + city).";
      resultsBox.appendChild(empty);
    } else {
      hits.forEach((h) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "map-search-item";
        const ic = document.createElement("i");
        ic.className = "fa-solid fa-location-dot";
        const span = document.createElement("span");
        span.textContent = h.display_name;
        row.append(ic, " ", span);
        row.addEventListener("click", () => {
          const la = parseFloat(h.lat);
          const lo = parseFloat(h.lon);
          applyOfficeCenter(la, lo, { pan: false });
          if (adminMap) adminMap.setView([la, lo], 17);
          resultsBox.style.display = "none";
          if (searchInput) searchInput.value = h.display_name.split(",")[0];
          showToast("Pin placed \u2014 fine-tune by dragging, then click Save & Enforce.", "success");
        });
        resultsBox.appendChild(row);
      });
    }
    resultsBox.style.display = "block";
  };

  const runPlaceSearch = async () => {
    const q = ((searchInput && searchInput.value) || "").trim();
    if (q.length < 3) {
      showToast("Type at least 3 characters to search a place.", "warning");
      return;
    }
    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Searching\u2026`;
    }
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const hits = await res.json();
      renderSearchResults(Array.isArray(hits) ? hits : []);
    } catch (err) {
      showToast("Place search failed \u2014 check your network and retry, or set the pin on the map.", "error");
      if (resultsBox) resultsBox.style.display = "none";
    } finally {
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> Search`;
      }
    }
  };

  if (searchBtn) searchBtn.addEventListener("click", runPlaceSearch);
  if (searchInput) searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runPlaceSearch(); }
  });
  document.addEventListener("click", (e) => {
    if (resultsBox && !(e.target && e.target.closest && e.target.closest("#geofenceSearchBar"))) {
      resultsBox.style.display = "none";
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const updated = {
      name: nameInput.value.trim() || DEFAULT_OFFICE.name,
      lat: parseFloat(latInput.value),
      lng: parseFloat(lngInput.value),
      radius: parseInt(radiusInput.value, 10)
    };
    setStore(STORAGE_KEYS.SETTINGS, updated);
    updateAdminMap(updated.lat, updated.lng, updated.radius);
    showToast("Office Geofence coordinates updated and enforced for all employees!", "success");
  });

  initAdminLeafletMap(settings.lat, settings.lng, settings.radius);
}

function initAdminLeafletMap(lat, lng, radius) {
  const mapElement = document.getElementById("adminGeofenceMap");
  if (!mapElement || !window.L) return;

  adminMap = L.map("adminGeofenceMap", { zoomControl: true }).setView([lat, lng], 16);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19
  }).addTo(adminMap);

  const officeIcon = L.divIcon({
    className: "custom-map-icon",
    html: `<div style="background:#6366f1;color:#fff;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;border:2px solid #fff;box-shadow:0 0 14px rgba(99,102,241,0.9);"><i class="fa-solid fa-building"></i></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });

  adminOfficeMarker = L.marker([lat, lng], { icon: officeIcon, draggable: true, title: "Drag to move the office center", alt: "Office geofence center" })
    .addTo(adminMap)
    .bindPopup("<strong>Company Headquarters</strong><br>Drag me \u2014 or click anywhere on the map \u2014 to move the geofence center");

  adminGeofenceCircle = L.circle([lat, lng], {
    color: "#10b981",
    fillColor: "#10b981",
    fillOpacity: 0.15,
    radius: radius,
    weight: 2,
    interactive: false
  }).addTo(adminMap);

  // Draggable edge handle: resizing the circle shouldn't need the keyboard.
  const handleIcon = L.divIcon({
    className: "custom-radius-handle",
    html: `<div style="background:#fff;color:#0f766e;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;border:2px solid #10b981;box-shadow:0 1px 6px rgba(0,0,0,0.35);"><i class="fa-solid fa-arrows-left-right" style="font-size:10px;"></i></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
  adminRadiusHandle = L.marker([lat + radius / 111320, lng], { icon: handleIcon, draggable: true, title: "Drag to resize the geofence radius", alt: "Geofence radius handle" }).addTo(adminMap);

  adminOfficeMarker.on("dragend", () => {
    const p = adminOfficeMarker.getLatLng();
    applyOfficeCenter(p.lat, p.lng, { pan: false });
    showToast("Office center moved \u2014 click Save & Enforce Geofence Coordinates to apply.", "warning");
  });

  adminRadiusHandle.on("drag", () => {
    const c = adminGeofenceCircle.getLatLng();
    const h = adminRadiusHandle.getLatLng();
    const r = clampRadius(calculateDistanceInMeters(c.lat, c.lng, h.lat, h.lng));
    adminGeofenceCircle.setRadius(r);
    syncRadiusInputs(r);
  });

  adminRadiusHandle.on("dragend", () => {
    const c = adminGeofenceCircle.getLatLng();
    placeRadiusHandle(c.lat, c.lng, adminGeofenceCircle.getRadius());
    showToast(`Geofence radius set to ${Math.round(adminGeofenceCircle.getRadius())}m \u2014 click Save & Enforce to apply.`, "warning");
  });

  adminMap.on("click", (e) => {
    applyOfficeCenter(e.latlng.lat, e.latlng.lng, { pan: false });
    showToast("Office pin moved \u2014 click Save & Enforce Geofence Coordinates to apply.", "warning");
  });
}

// Keep the edge handle aligned due-east of the center at the given radius.
function placeRadiusHandle(lat, lng, radius) {
  if (adminRadiusHandle) adminRadiusHandle.setLatLng([lat + radius / 111320, lng]);
}

function clampRadius(meters) {
  return Math.min(2000, Math.max(100, meters || 500));
}

function syncRadiusInputs(r) {
  const radiusInput = document.getElementById("adminOfficeRadius");
  const radiusVal = document.getElementById("adminRadiusVal");
  const rounded = Math.round(r);
  if (radiusInput) radiusInput.value = rounded;
  if (radiusVal) radiusVal.textContent = rounded;
}

// Preview-only: syncs marker/circle/handle + form fields. Saving still enforces.
function applyOfficeCenter(lat, lng, opts) {
  const latInput = document.getElementById("adminOfficeLat");
  const lngInput = document.getElementById("adminOfficeLng");
  if (latInput) latInput.value = Number(lat).toFixed(6);
  if (lngInput) lngInput.value = Number(lng).toFixed(6);
  if (adminOfficeMarker) adminOfficeMarker.setLatLng([lat, lng]);
  const r = adminGeofenceCircle ? adminGeofenceCircle.getRadius() : 500;
  if (adminGeofenceCircle) adminGeofenceCircle.setLatLng([lat, lng]);
  placeRadiusHandle(lat, lng, r);
  if (adminMap && opts && opts.pan) adminMap.panTo([lat, lng], { animate: true });
}

function updateAdminMap(lat, lng, radius) {
  if (!adminMap) return;
  adminOfficeMarker.setLatLng([lat, lng]);
  adminGeofenceCircle.setLatLng([lat, lng]);
  adminGeofenceCircle.setRadius(radius);
  placeRadiusHandle(lat, lng, radius);
  adminMap.setView([lat, lng], 16);
}

// ============================================================================
// 8. TAB 7: ADMIN ACCOUNT & SECURITY CREDENTIALS
// ============================================================================

function renderAdminAccountTab() {
  const currentCreds = getAdminCredentials();
  const displayUser = document.getElementById("displayAdminUsername");
  const displayLastUpdate = document.getElementById("displayAdminLastUpdated");
  const newUsernameInp = document.getElementById("newAdminUsername");

  if (displayUser) displayUser.textContent = currentCreds.username;
  if (displayLastUpdate) displayLastUpdate.textContent = currentCreds.updatedAt || "2026-10-08";
  if (newUsernameInp && !newUsernameInp.value) {
    newUsernameInp.value = currentCreds.username;
  }
}

function initAdminAccountForm() {
  const form = document.getElementById("changeAdminCredentialsForm");
  const successAlert = document.getElementById("adminAccountSuccessAlert");
  const errorAlert = document.getElementById("adminAccountErrorAlert");
  const errorTitle = document.getElementById("adminAccountErrorTitle");
  const errorMsg = document.getElementById("adminAccountErrorMessage");
  const resetBtn = document.getElementById("resetAdminCredsBtn");

  if (!form) return;

  function showAccountError(message, title = "Update Failed") {
    if (successAlert) successAlert.style.display = "none";
    if (errorAlert) {
      if (errorTitle) errorTitle.textContent = title;
      if (errorMsg) errorMsg.textContent = message;
      errorAlert.style.display = "flex";
      errorAlert.classList.remove("shake");
      void errorAlert.offsetWidth;
      errorAlert.classList.add("shake");
    }
  }

  function showAccountSuccess(message = "Credentials updated successfully!") {
    if (errorAlert) errorAlert.style.display = "none";
    if (successAlert) {
      successAlert.style.display = "flex";
      successAlert.querySelector(".alert-content span").textContent = message;
    }
  }

  // Clear alerts on input
  ["currentAdminPassword", "newAdminUsername", "newAdminPassword", "confirmAdminPassword"].forEach(id => {
    const inp = document.getElementById(id);
    if (inp) {
      inp.addEventListener("input", () => {
        if (errorAlert) errorAlert.style.display = "none";
        if (successAlert) successAlert.style.display = "none";
      });
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const currentPass = document.getElementById("currentAdminPassword").value.trim();
    const newUsername = document.getElementById("newAdminUsername").value.trim();
    const newPass = document.getElementById("newAdminPassword").value.trim();
    const confirmPass = document.getElementById("confirmAdminPassword").value.trim();

    const activeCreds = getAdminCredentials();

    // 1. Verify current password
    if (currentPass !== activeCreds.password) {
      showAccountError("The Current Master Password you entered is incorrect. Access denied.", "Verification Failed");
      showToast("Current password incorrect.", "error");
      return;
    }

    // 2. Validate new username
    if (!newUsername || newUsername.length < 3) {
      showAccountError("The new administrator username must be at least 3 characters long.", "Invalid Username");
      return;
    }

    // 3. Validate new password length
    if (!newPass || newPass.length < 6) {
      showAccountError("The new master password must be at least 6 characters long.", "Weak Password");
      return;
    }

    // 4. Validate matching passwords
    if (newPass !== confirmPass) {
      showAccountError("New Master Password and Confirm Password do not match. Please retype carefully.", "Passwords Mismatch");
      return;
    }

    // Save updated credentials
    const updatedCreds = {
      username: newUsername,
      password: newPass,
      name: "VKON Executive Administrator",
      role: "System Administrator",
      updatedAt: new Date().toISOString().split("T")[0]
    };

    setAdminCredentials(updatedCreds);

    // Update active admin session so current user stays logged in with new username
    const currentSession = getStore(STORAGE_KEYS.CURRENT_SESSION, {});
    if (currentSession && currentSession.role === "admin") {
      currentSession.username = newUsername;
      setStore(STORAGE_KEYS.CURRENT_SESSION, currentSession);
    }

    // Update UI elements
    renderAdminAccountTab();
    document.getElementById("currentAdminPassword").value = "";
    document.getElementById("newAdminPassword").value = "";
    document.getElementById("confirmAdminPassword").value = "";

    showAccountSuccess(`Administrator username changed to '${newUsername}' and password successfully updated!`);
    showToast("Admin credentials successfully updated!", "success");
  });

  // Reset to factory defaults
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (confirm("Reset administrator credentials back to factory defaults (admin / admin123)?")) {
        setAdminCredentials(DEFAULT_ADMIN_CREDENTIALS);
        const currentSession = getStore(STORAGE_KEYS.CURRENT_SESSION, {});
        if (currentSession && currentSession.role === "admin") {
          currentSession.username = DEFAULT_ADMIN_CREDENTIALS.username;
          setStore(STORAGE_KEYS.CURRENT_SESSION, currentSession);
        }
        renderAdminAccountTab();
        document.getElementById("currentAdminPassword").value = "";
        document.getElementById("newAdminUsername").value = DEFAULT_ADMIN_CREDENTIALS.username;
        document.getElementById("newAdminPassword").value = "";
        document.getElementById("confirmAdminPassword").value = "";
        showAccountSuccess("Reset to factory defaults: username 'admin', password 'admin123'.");
        showToast("Admin credentials reset to defaults.", "info");
      }
    });
  }
}

// ============================================================================
// 9. CONSOLE INITIALIZATION & BOOTSTRAP
// ============================================================================

let isConsoleStarted = false;

// ============================================================================
// 7.9 EXTRA MENU MODULES — Dashboard, Recruitment, Task, Payroll, Help, Departments
// ============================================================================

const EXTRA_KEYS = {
  RECRUITMENT: "vkon_recruitment_v1",
  TASKS: "vkon_tasks_v1",
  PAY_RATES: "vkon_pay_rates_v1",
  PAY_RUNS: "vkon_pay_runs_v1",
  TICKETS: "vkon_tickets_v1"
};

const DEFAULT_CANDIDATES = [
  { id: "C1001", name: "Rahul Verma", role: "Sr Product Designer", stage: "Interview", addedAt: "2026-10-08" },
  { id: "C1002", name: "Sneha Iyer", role: "Frontend Engineer", stage: "Applied", addedAt: "2026-10-11" },
  { id: "C1003", name: "Devraj Singh", role: "DevOps Engineer", stage: "Offered", addedAt: "2026-10-02" }
];

const CANDIDATE_STAGES = ["Applied", "Screening", "Interview", "Offered", "Hired"];
const TASK_STATUSES = ["Open", "In Progress", "Done"];
const DEPT_DOT_COLORS = ["#ea580c", "#7c3aed", "#0ea5e9", "#22c55e", "#db2777", "#f97316", "#64748b"];
const DEFAULT_PAY_BY_DEPT = { Engineering: 85000, Product: 78000, Operations: 92000, Infrastructure: 88000 };
const LATE_CUTOFF_MIN_DASH = 10 * 60; // 10:00 AM IST grace (matches master sheet)

function switchAdminTab(targetId) {
  const btn = document.querySelector(`.admin-sidebar .nav-tab[data-tab="${targetId}"]`);
  if (btn) btn.click();
}

function setTextSafe(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// --- Department quick-nav (sidebar): live from the roster ---
function renderDeptNav() {
  const list = document.getElementById("deptNavList");
  if (!list) return;
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const counts = {};
  employees.forEach(e => { counts[e.department] = (counts[e.department] || 0) + 1; });
  const depts = Object.keys(counts).sort();
  list.innerHTML = depts.map((d, i) => `
    <button type="button" class="dept-nav-item" data-dept="${d}">
      <span class="dept-dot" style="background:${DEPT_DOT_COLORS[i % DEPT_DOT_COLORS.length]}"></span>
      <span class="dept-name">${d}</span>
      <span class="dept-count">${counts[d]}</span>
    </button>
  `).join("");
}

// --- Dashboard: today at a glance (all values computed from live data) ---
function renderDashboard() {
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const wfhList = getStore(STORAGE_KEYS.WFH, []);
  const regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
  const todayKey = formatDateKey(now);

  setTextSafe("dashDateLabel", now.toLocaleDateString("en-US", {
    timeZone: "Asia/Kolkata", weekday: "long", month: "long", day: "numeric", year: "numeric"
  }));

  let inToday = 0, late = 0, onLeave = 0;
  const rows = [];
  employees.forEach(emp => {
    const rec = records[`${emp.id}_${todayKey}`];
    if (!rec) return;
    if (rec.status === "Present" || rec.status === "WFH") {
      const inMin = rec.checkInTime && rec.checkInTime !== "-" ? parseAmPmToMinutes(rec.checkInTime) : null;
      const isLate = inMin !== null && inMin > LATE_CUTOFF_MIN_DASH;
      inToday++;
      if (isLate) late++;
      rows.push(`
        <tr>
          <td><div class="table-emp-cell"><img src="${emp.avatar}" class="table-avatar" alt="${emp.name}"><span class="font-bold">${emp.name}</span></div></td>
          <td class="font-mono">${rec.checkInTime && rec.checkInTime !== "-" ? rec.checkInTime : "--"}</td>
          <td class="font-mono">${rec.checkOutTime && rec.checkOutTime !== "-" ? rec.checkOutTime : "On shift"}</td>
          <td><span class="type-cell">${rec.status === "WFH" ? "Remote" : "In house"}</span></td>
          <td><span class="today-pill ${isLate ? "pill-late" : "pill-on-time"}">${isLate ? "Late" : "On Time"}</span></td>
        </tr>`);
    } else if (rec.status === "Leave" || rec.status === "Holiday") {
      onLeave++;
    }
  });

  const pending =
    leaves.filter(l => l.status === "Pending").length +
    wfhList.filter(w => w.status === "Pending").length +
    regs.filter(r => r.status === "Pending").length;

  setTextSafe("dashStatPresent", inToday);
  setTextSafe("dashStatLate", late);
  setTextSafe("dashStatLeave", onLeave);
  setTextSafe("dashStatPending", pending);

  const tbody = document.getElementById("dashTodayTableBody");
  if (tbody) {
    tbody.innerHTML = rows.join("");
    const wrap = tbody.closest(".table-responsive");
    if (wrap) wrap.style.display = rows.length ? "" : "none";
  }
  const emptyNote = document.getElementById("dashEmptyToday");
  if (emptyNote) emptyNote.style.display = rows.length ? "none" : "";

  const items = [
    ...leaves.filter(l => l.status === "Pending").map(l => ({ kind: "Leave", who: l.employeeName || l.employeeId, when: l.dates || l.startDate || "", icon: "fa-umbrella-beach" })),
    ...wfhList.filter(w => w.status === "Pending").map(w => ({ kind: "WFH", who: w.employeeName || w.employeeId, when: w.date || "", icon: "fa-house-laptop" })),
    ...regs.filter(r => r.status === "Pending").map(r => ({ kind: "Regularisation", who: r.employeeName || r.employeeId, when: r.date || "", icon: "fa-clock-rotate-left" }))
  ].slice(0, 6);

  const listEl = document.getElementById("dashRecentRequests");
  if (listEl) {
    listEl.innerHTML = items.map(it => `
      <div class="dash-request-item">
        <i class="fa-solid ${it.icon}"></i>
        <span class="dr-kind">${it.kind}</span>
        <span class="dr-who">${it.who}</span>
        <span class="dr-when font-mono">${it.when || ""}</span>
        <button type="button" class="btn btn-ghost btn-sm dr-go" data-go="tab-approvals">Review</button>
      </div>`).join("");
    listEl.style.display = items.length ? "" : "none";
  }
  const emptyReq = document.getElementById("dashEmptyRequests");
  if (emptyReq) emptyReq.style.display = items.length ? "none" : "";
}

// --- Recruitment pipeline ---
function getCandidates() {
  return getStore(EXTRA_KEYS.RECRUITMENT, DEFAULT_CANDIDATES);
}

function renderCandidateTable() {
  const cands = getCandidates();
  const tbody = document.getElementById("candidateTableBody");
  const empty = document.getElementById("emptyCandidateMsg");
  if (!tbody) return;
  tbody.innerHTML = cands.map(c => {
    const stageIdx = CANDIDATE_STAGES.indexOf(c.stage);
    const pill = c.stage === "Hired" ? "pill-on-time" : c.stage === "Offered" ? "pill-remote" : c.stage === "Interview" ? "pill-leave" : "pill-notin";
    return `
    <tr>
      <td class="font-bold">${c.name}</td>
      <td>${c.role}</td>
      <td><span class="today-pill ${pill}">${c.stage}</span></td>
      <td>
        ${stageIdx < CANDIDATE_STAGES.length - 1
          ? `<button type="button" class="btn btn-ghost btn-sm cand-advance" data-id="${c.id}"><i class="fa-solid fa-arrow-right"></i> ${CANDIDATE_STAGES[stageIdx + 1]}</button>`
          : `<span class="text-success font-bold"><i class="fa-solid fa-circle-check"></i> Joined</span>`}
        <button type="button" class="btn btn-ghost btn-sm text-danger cand-remove" data-id="${c.id}" title="Remove this candidate (click twice to confirm)"><i class="fa-solid fa-xmark"></i> Remove</button>
      </td>
    </tr>`;
  }).join("");
  if (empty) empty.style.display = cands.length ? "none" : "";
}

// --- Task board ---
function renderTaskTable() {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const sel = document.getElementById("taskAssigneeSelect");
  if (sel && sel.options.length !== employees.length) {
    sel.innerHTML = employees.map(e => `<option value="${e.id}">${e.name}</option>`).join("");
  }
  const tasks = getStore(EXTRA_KEYS.TASKS, []);
  const todayKey = formatDateKey((typeof getPresentDate === "function") ? getPresentDate() : new Date());
  const tbody = document.getElementById("taskTableBody");
  const empty = document.getElementById("emptyTaskMsg");
  if (!tbody) return;
  tbody.innerHTML = tasks.map(t => {
    const overdue = t.due && t.due < todayKey && t.status !== "Done";
    return `
    <tr>
      <td><span class="font-bold">${t.title}</span>${overdue ? ' <span class="today-pill pill-late">Overdue</span>' : ""}</td>
      <td>${t.assigneeName}</td>
      <td class="font-mono">${t.due || "\u2014"}</td>
      <td>${t.status === "Done"
        ? `<span class="day-badge-pill badge-present"><i class="fa-solid fa-circle-check"></i> Completed${t.completedAt ? ` &middot; ${formatDateKey(new Date(t.completedAt))}` : ""}</span>`
        : `<select class="form-control task-status-select ${t.status === "In Progress" ? "status-inprogress" : "status-open"}" data-id="${t.id}">${TASK_STATUSES.map(s => `<option${s === t.status ? " selected" : ""}>${s}</option>`).join("")}</select>`}</td>
      <td><button type="button" class="btn btn-ghost btn-sm text-danger task-remove" data-id="${t.id}" title="Delete task"><i class="fa-solid fa-trash"></i></button></td>
    </tr>`;
  }).join("");
  if (empty) empty.style.display = tasks.length ? "none" : "";
}

// --- Payroll ---
function getPayRates() {
  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const saved = getStore(EXTRA_KEYS.PAY_RATES, {});
  const rates = {};
  employees.forEach(e => { rates[e.id] = saved[e.id] || DEFAULT_PAY_BY_DEPT[e.department] || 70000; });
  return rates;
}

function renderPayrollTable() {
  const monthEl = document.getElementById("payrollMonthInput");
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (monthEl && !monthEl.value) monthEl.value = defaultMonth;
  const month = monthEl && monthEl.value ? monthEl.value : defaultMonth;

  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
  const rates = getPayRates();
  const runs = getStore(EXTRA_KEYS.PAY_RUNS, {});
  const monthRuns = runs[month] || {};

  const tbody = document.getElementById("payrollTableBody");
  if (!tbody) return;
  tbody.innerHTML = employees.map(e => {
    const paid = monthRuns[e.id];
    return `
    <tr>
      <td><div class="table-emp-cell"><img src="${e.avatar}" class="table-avatar" alt="${e.name}"><span class="font-bold">${e.name}</span></div></td>
      <td>${e.department}</td>
      <td><input type="number" min="0" step="1000" class="form-control pay-rate-input" data-id="${e.id}" value="${rates[e.id]}" aria-label="Base salary for ${e.name}"></td>
      <td><span class="today-pill ${paid ? "pill-on-time" : "pill-notin"}">${paid ? `Paid ${paid.paidOn}` : "Unpaid"}</span></td>
      <td>${paid
        ? `<span class="text-success font-bold"><i class="fa-solid fa-circle-check"></i> Settled</span>`
        : `<button type="button" class="btn btn-ghost btn-sm pay-mark" data-id="${e.id}"><i class="fa-solid fa-money-bill-wave"></i> Mark Paid</button>`}</td>
    </tr>`;
  }).join("");
}

function markEmployeesPaid(ids, wholeRun) {
  const monthEl = document.getElementById("payrollMonthInput");
  const month = monthEl && monthEl.value ? monthEl.value : formatDateKey(new Date()).slice(0, 7);
  const runs = getStore(EXTRA_KEYS.PAY_RUNS, {});
  const monthRuns = runs[month] || (runs[month] = {});
  const day = formatDateKey(new Date()).slice(8);
  ids.forEach(id => {
    if (!monthRuns[id]) monthRuns[id] = { status: "Paid", paidOn: `${day}/${month.slice(5)}` };
  });
  setStore(EXTRA_KEYS.PAY_RUNS, runs);
  renderPayrollTable();
  showToast(wholeRun ? `Payroll run completed for ${month}.` : "Payment marked as paid.", "success");
}

// --- Help & Support tickets ---
function renderTicketList() {
  const tickets = getStore(EXTRA_KEYS.TICKETS, []);
  const list = document.getElementById("ticketList");
  const empty = document.getElementById("emptyTicketMsg");
  if (!list) return;
  list.innerHTML = tickets.slice().reverse().map(t => `
    <div class="dash-request-item">
      <i class="fa-solid fa-ticket"></i>
      <span class="dr-kind">Ticket</span>
      <span class="dr-who">${t.subject}</span>
      <span class="dr-when font-mono">${t.at}</span>
      <span class="today-pill ${t.status === "Open" ? "pill-leave" : "pill-on-time"}">${t.status}</span>
    </div>`).join("");
  list.style.display = tickets.length ? "" : "none";
  if (empty) empty.style.display = tickets.length ? "none" : "";
}

function initExtraModules() {
  renderDeptNav();

  const deptList = document.getElementById("deptNavList");
  if (deptList) {
    deptList.addEventListener("click", (e) => {
      const item = e.target.closest(".dept-nav-item");
      if (!item) return;
      switchAdminTab("tab-monthly-sheet");
      const deptSel = document.getElementById("masterDeptFilter");
      if (deptSel) {
        deptSel.value = item.getAttribute("data-dept");
        masterTableState.page = 1;
        applyMasterTableView();
      }
    });
  }
  const deptAdd = document.getElementById("deptAddBtn");
  if (deptAdd) deptAdd.addEventListener("click", () => switchAdminTab("tab-roster"));

  // Recruitment
  const candForm = document.getElementById("candidateAddForm");
  if (candForm) {
    candForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const nameEl = document.getElementById("candidateNameInput");
      const roleEl = document.getElementById("candidateRoleInput");
      const stageEl = document.getElementById("candidateStageInput");
      const errEl = document.getElementById("candidateFormError");
      const name = (nameEl.value || "").trim();
      const role = (roleEl.value || "").trim();
      const stage = stageEl ? stageEl.value : "Applied";
      const showErr = (msg, el) => {
        if (errEl) { errEl.textContent = msg; errEl.style.display = ""; }
        nameEl.classList.remove("input-invalid");
        roleEl.classList.remove("input-invalid");
        if (el) { el.classList.add("input-invalid"); el.focus(); }
      };
      if (errEl) errEl.style.display = "none";
      nameEl.classList.remove("input-invalid");
      roleEl.classList.remove("input-invalid");
      if (name.length < 2) { showErr("Please enter the candidate's name (at least 2 characters).", nameEl); return; }
      if (role.length < 2) { showErr("Please enter the position / role (at least 2 characters).", roleEl); return; }
      const cands = getCandidates();
      if (cands.some(c => (c.name || "").toLowerCase() === name.toLowerCase())) { showErr(`${name} is already in the pipeline.`, nameEl); return; }
      const todayKey0 = formatDateKey((typeof getPresentDate === "function") ? getPresentDate() : new Date());
      cands.push({ id: "C" + Date.now().toString().slice(-6), name, role, stage, addedAt: todayKey0 });
      setStore(EXTRA_KEYS.RECRUITMENT, cands);
      candForm.reset();
      renderCandidateTable();
      showToast(`Candidate ${name} added at stage \u201c${stage}\u201d.`, "success");
    });
  }
  const candBody = document.getElementById("candidateTableBody");
  if (candBody) {
    candBody.addEventListener("click", (e) => {
      const adv = e.target.closest(".cand-advance");
      const rem = e.target.closest(".cand-remove");
      if (!adv && !rem) return;
      const cands = getCandidates();
      if (adv) {
        const c = cands.find(x => x.id === adv.dataset.id);
        if (c) c.stage = CANDIDATE_STAGES[Math.min(CANDIDATE_STAGES.length - 1, CANDIDATE_STAGES.indexOf(c.stage) + 1)];
        setStore(EXTRA_KEYS.RECRUITMENT, cands);
        renderCandidateTable();
        if (c) showToast(`${c.name} moved to \u201c${c.stage}\u201d.`, "success");
      } else if (rem) {
        // Two-step inline confirm to prevent accidental deletion.
        if (rem.dataset.confirm !== "1") {
          rem.dataset.confirm = "1";
          rem.classList.add("cand-remove-confirm");
          rem.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Confirm?';
          rem.title = "Click again to permanently remove this candidate";
          setTimeout(() => { if (rem.isConnected) renderCandidateTable(); }, 4000);
          return;
        }
        const idx = cands.findIndex(x => x.id === rem.dataset.id);
        const removed = idx > -1 ? cands[idx] : null;
        if (idx > -1) cands.splice(idx, 1);
        setStore(EXTRA_KEYS.RECRUITMENT, cands);
        renderCandidateTable();
        showToast(`Removed ${removed ? removed.name : "candidate"} from the pipeline.`, "success");
      }
    });
  }

  // Tasks
  const taskForm = document.getElementById("taskAddForm");
  if (taskForm) {
    taskForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = document.getElementById("taskTitleInput").value.trim();
      if (!title) return;
      const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
      const assigneeSel = document.getElementById("taskAssigneeSelect");
      const emp = employees.find(x => x.id === assigneeSel.value) || employees[0];
      const tasks = getStore(EXTRA_KEYS.TASKS, []);
      tasks.push({
        id: "T" + Date.now().toString().slice(-7),
        title,
        assigneeId: emp ? emp.id : "",
        assigneeName: emp ? emp.name : "\u2014",
        due: document.getElementById("taskDueInput").value || "",
        status: "Open"
      });
      setStore(EXTRA_KEYS.TASKS, tasks);
      if (typeof pushNotification === "function" && emp) {
        pushNotification(emp.id, "task", "New Task Assigned", `"${title}"${document.getElementById("taskDueInput").value ? ` is due on ${document.getElementById("taskDueInput").value}` : ""}. Check My Tasks for details.`, "tasks");
      }
      document.getElementById("taskTitleInput").value = "";
      renderTaskTable();
      showToast("Task assigned.", "success");
    });
  }
  const taskBody = document.getElementById("taskTableBody");
  if (taskBody) {
    taskBody.addEventListener("change", (e) => {
      const sel = e.target.closest(".task-status-select");
      if (!sel) return;
      const tasks = getStore(EXTRA_KEYS.TASKS, []);
      const t = tasks.find(x => x.id === sel.dataset.id);
      if (t) t.status = sel.value;
      setStore(EXTRA_KEYS.TASKS, tasks);
      renderTaskTable();
    });
    taskBody.addEventListener("click", (e) => {
      const rm = e.target.closest(".task-remove");
      if (!rm) return;
      setStore(EXTRA_KEYS.TASKS, getStore(EXTRA_KEYS.TASKS, []).filter(x => x.id !== rm.dataset.id));
      renderTaskTable();
    });
  }

  // Payroll
  const payrollMonth = document.getElementById("payrollMonthInput");
  if (payrollMonth) payrollMonth.addEventListener("change", renderPayrollTable);
  const payBody = document.getElementById("payrollTableBody");
  if (payBody) {
    payBody.addEventListener("change", (e) => {
      const inp = e.target.closest(".pay-rate-input");
      if (!inp) return;
      const saved = getStore(EXTRA_KEYS.PAY_RATES, {});
      saved[inp.dataset.id] = Math.max(0, parseInt(inp.value, 10) || 0);
      setStore(EXTRA_KEYS.PAY_RATES, saved);
      showToast("Base salary updated.", "success");
    });
    payBody.addEventListener("click", (e) => {
      const btn = e.target.closest(".pay-mark");
      if (!btn) return;
      markEmployeesPaid([btn.dataset.id], false);
    });
  }
  const runBtn = document.getElementById("runPayrollBtn");
  if (runBtn) {
    runBtn.addEventListener("click", () => {
      const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
      markEmployeesPaid(employees.map(e => e.id), true);
    });
  }

  // Help tickets
  const ticketForm = document.getElementById("ticketAddForm");
  if (ticketForm) {
    ticketForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const subject = document.getElementById("ticketSubjectInput").value.trim();
      const msg = document.getElementById("ticketMsgInput").value.trim();
      if (!subject || !msg) return;
      const tickets = getStore(EXTRA_KEYS.TICKETS, []);
      tickets.push({ subject, msg, status: "Open", at: `${formatTimeString(new Date())} \u2022 ${formatDateKey(new Date())}` });
      setStore(EXTRA_KEYS.TICKETS, tickets);
      ticketForm.reset();
      renderTicketList();
      showToast("Support ticket submitted.", "success");
    });
  }

  // Dashboard "Review" shortcuts
  const recent = document.getElementById("dashRecentRequests");
  if (recent) {
    recent.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) switchAdminTab(go.getAttribute("data-go"));
    });
  }
}

// ============================================================================
// 8. BOOTSTRAP
// ============================================================================

function startAdminConsole() {
  if (isConsoleStarted) return;
  isConsoleStarted = true;

  initAdminClock();
  initAdminTabs();
  initMasterTableSearch();
  initExtraModules();
  renderMonthlyReport();
  renderRosterTable();
  initEnrollmentForm();
  initEditEmployeeModal();
  renderApprovalsCenter();
  initApprovalsSideDrawer();
  renderHolidaysTable();
  initHolidayForm();
  initGlobalLeaveQuotasForm();
  initMinWorkPolicyForm();
  renderAttendancePhotosTable();
  initAdminGeofence();
  initPhotoLightboxModal();
  initEmpCalendarModal();
  initAdminAccountForm();
  renderAdminAccountTab();

  const exportBtn = document.getElementById("exportMonthlyExcelBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportMonthlyExcel);

  const monthSelect = document.getElementById("reportMonthSelect");
  if (monthSelect) monthSelect.addEventListener("change", renderMonthlyReport);

  const purgeBtn = document.getElementById("purgeExpiredPhotosBtn");
  if (purgeBtn) {
    purgeBtn.addEventListener("click", () => {
      cleanExpiredPhotos();
      renderAttendancePhotosTable();
      showToast("Expired photos checked and cleaned.", "success");
    });
  }

  initThemeSystem();
  console.log("VKON Executive Admin Console initialized.");
}

window.addEventListener("DOMContentLoaded", () => {
  initThemeSystem();
  if (checkAdminAuth()) {
    startAdminConsole();
  }
});

/**
 * VKON Employee Attendance Portal Engine
 * Handles On-Demand Camera Verification (>= 70% match), Personal & RH Leaves, and Direct WFH
 */

let liveVerifyStream = null;
let currentVerifyMode = "in"; // "in" or "out"
let capturedLiveSelfie = null;
let currentMatchScore = 0;
let isLivePhotoVerified = false;
let gpsWatchId = null; // in-flight watchPosition collector, so refreshes don't stack

const employeeState = {
  currentEmployee: null,
  officeSettings: DEFAULT_OFFICE,
  userLocation: {
    // These are only placeholders. The real device GPS is fetched when the
    // punch modal opens (see startGpsFetch). `located` stays false until a
    // fresh fix is obtained, so a punch can never be trusted on stale coords.
    lat: 12.9718,
    lng: 77.5948,
    distanceMeters: null,
    isWithinGeofence: false,
    located: false,
    accuracy: null
  },
  calendarCurrentDate: (typeof getPresentDate === "function") ? getPresentDate() : new Date() // calendarCurrentDate: new Date()
};

// ============================================================================
// 1. AUTHENTICATION & SESSION MANAGEMENT
// ============================================================================

function showLoginError(message, title = "Invalid Credentials") {
  const alertEl = document.getElementById("loginErrorAlert");
  const titleEl = document.getElementById("loginErrorTitle");
  const msgEl = document.getElementById("loginErrorMessage");
  if (alertEl) {
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    alertEl.style.display = "flex";
    alertEl.classList.remove("shake");
    // trigger reflow for smooth shake animation
    void alertEl.offsetWidth;
    alertEl.classList.add("shake");
  }
}

function clearLoginError() {
  const alertEl = document.getElementById("loginErrorAlert");
  if (alertEl) {
    alertEl.style.display = "none";
  }
}

function initAuthSystem() {
  const authScreen = document.getElementById("authScreen");
  const mainAppWrapper = document.getElementById("mainAppWrapper");
  const tabEmpBtn = document.getElementById("tabEmployeeLoginBtn");
  const tabAdminBtn = document.getElementById("tabAdminLoginBtn");
  const empForm = document.getElementById("employeeLoginForm");
  const adminForm = document.getElementById("adminLoginForm");

  // Clear errors when switching tabs (if tabs exist)
  if (tabEmpBtn && tabAdminBtn) {
    tabEmpBtn.addEventListener("click", () => {
      tabEmpBtn.classList.add("active");
      tabAdminBtn.classList.remove("active");
      if (empForm) empForm.style.display = "flex";
      if (adminForm) adminForm.style.display = "none";
      clearLoginError();
    });

    tabAdminBtn.addEventListener("click", () => {
      tabAdminBtn.classList.add("active");
      tabEmpBtn.classList.remove("active");
      if (adminForm) adminForm.style.display = "flex";
      if (empForm) empForm.style.display = "none";
      clearLoginError();
    });
  }

  // Clear errors dynamically when user types
  ["loginUsername", "loginPassword", "adminUsername", "adminPassword"].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener("input", clearLoginError);
    }
  });

  // Quick fill employee chips
  document.querySelectorAll(".quick-fill-emp-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const u = btn.dataset.user;
      const p = btn.dataset.pass;
      if (u && p) {
        document.getElementById("loginUsername").value = u;
        document.getElementById("loginPassword").value = p;
        if (empForm) empForm.dispatchEvent(new Event("submit"));
      }
    });
  });

  // Quick fill admin chip on index page (if admin form exists)
  const indexAdminBtn = document.getElementById("quickFillIndexAdminBtn");
  if (indexAdminBtn && adminForm) {
    indexAdminBtn.addEventListener("click", () => {
      const adminU = document.getElementById("adminUsername");
      const adminP = document.getElementById("adminPassword");
      if (adminU) adminU.value = "admin";
      if (adminP) adminP.value = "admin123";
      adminForm.dispatchEvent(new Event("submit"));
    });
  }

  // Employee Login Form
  empForm.addEventListener("submit", (e) => {
    e.preventDefault();
    clearLoginError();
    const uname = document.getElementById("loginUsername").value.trim().toLowerCase();
    const pwd = document.getElementById("loginPassword").value.trim();

    // 1. Cross-login: Check if Admin credentials were submitted on employee form
    const adminCreds = getAdminCredentials();
    if ((uname === adminCreds.username.toLowerCase() || uname === "admin") && 
        (pwd === adminCreds.password || pwd === DEFAULT_ADMIN_CREDENTIALS.password)) {
      const adminSessionData = {
        username: adminCreds.username,
        name: adminCreds.name || "VKON Executive Administrator",
        role: "admin",
        loginTime: new Date().toISOString()
      };
      sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSessionData));
      localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSessionData));
      showToast("Admin credentials recognized! Opening Executive Console...", "success");
      setTimeout(() => { window.location.href = "admin.html"; }, 300);
      return;
    }

    // 2. Check employee credentials
    const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
    let found = employees.find(emp => emp.username.toLowerCase() === uname && emp.password === pwd);
    if (!found) {
      found = DEFAULT_EMPLOYEES.find(emp => emp.username.toLowerCase() === uname && emp.password === pwd);
    }

    if (found) {
      const sessionData = {
        username: found.username,
        employeeId: found.id,
        role: "employee",
        loginTime: new Date().toISOString()
      };
      sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
      localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
      authScreen.style.display = "none";
      mainAppWrapper.style.display = "flex";
      loadEmployeeSession(found);
      showToast(`Welcome back, ${found.name}!`, "success");
    } else {
      showLoginError("The employee username or password you entered is incorrect. Default accounts: mukesh / mukesh123, chiranth / chiranth123, priya / priya123", "Invalid Employee Credentials");
      showToast("Invalid credentials. Try mukesh / mukesh123", "error");
    }
  });

  // Admin Login Form (if present)
  if (adminForm) {
    adminForm.addEventListener("submit", (e) => {
      e.preventDefault();
      clearLoginError();
      const uname = document.getElementById("adminUsername").value.trim().toLowerCase();
      const pwd = document.getElementById("adminPassword").value.trim();

      const adminCreds = getAdminCredentials();
      const isAdminMatch = (uname === adminCreds.username.toLowerCase() || uname === "admin") && 
                           (pwd === adminCreds.password || pwd === DEFAULT_ADMIN_CREDENTIALS.password);

      if (isAdminMatch) {
        const adminSessionData = {
          username: adminCreds.username,
          name: adminCreds.name || "VKON Executive Administrator",
          role: "admin",
          loginTime: new Date().toISOString()
        };
        sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSessionData));
        localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(adminSessionData));
        window.location.href = "admin.html";
        return;
      }

      // Cross-check: If employee credentials were submitted on admin form
      const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);
      let found = employees.find(emp => emp.username.toLowerCase() === uname && emp.password === pwd);
      if (!found) {
        found = DEFAULT_EMPLOYEES.find(emp => emp.username.toLowerCase() === uname && emp.password === pwd);
      }
      if (found) {
        const sessionData = {
          username: found.username,
          employeeId: found.id,
          role: "employee",
          loginTime: new Date().toISOString()
        };
        sessionStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
        localStorage.setItem(STORAGE_KEYS.CURRENT_SESSION, JSON.stringify(sessionData));
        authScreen.style.display = "none";
        mainAppWrapper.style.display = "flex";
        loadEmployeeSession(found);
        showToast(`Welcome back, ${found.name}!`, "success");
        return;
      }

      showLoginError("The executive administrator username or password you entered is incorrect. Master credentials: admin / admin123", "Invalid Admin Credentials");
      showToast("Invalid admin credentials. Use admin / admin123", "error");
    });
  }

  // Logout
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      sessionStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
      localStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
      localStorage.removeItem("apex_session_v5");
      localStorage.removeItem("vkon_session_v6");
      showToast("Logged out successfully.", "info");
      checkActiveSession();
    });
  }
}

function checkActiveSession() {
  const authScreen = document.getElementById("authScreen");
  const mainAppWrapper = document.getElementById("mainAppWrapper");
  
  // Prefer sessionStorage for current tab session, fallback to localStorage
  let session = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.CURRENT_SESSION) || localStorage.getItem(STORAGE_KEYS.CURRENT_SESSION);
    if (raw) session = JSON.parse(raw);
  } catch (e) {}

  const employees = getStore(STORAGE_KEYS.EMPLOYEES, DEFAULT_EMPLOYEES);

  if (!session || !session.username || session.role !== "employee") {
    // If not logged in as employee, always show login screen and hide main dashboard
    authScreen.style.display = "flex";
    mainAppWrapper.style.display = "none";
    return;
  }

  const found = employees.find(e => e.username.toLowerCase() === session.username.toLowerCase());
  if (found) {
    authScreen.style.display = "none";
    mainAppWrapper.style.display = "flex";
    loadEmployeeSession(found);
  } else {
    // Session invalid or employee not found -> Show login screen
    sessionStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
    localStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
    authScreen.style.display = "flex";
    mainAppWrapper.style.display = "none";
  }
}

function loadEmployeeSession(emp) {
  if (!emp) return;
  employeeState.currentEmployee = emp;
  employeeState.officeSettings = getStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);

  // Update navbar display strictly for logged-in employee
  const curAvatar = document.getElementById("currentAvatar");
  if (curAvatar) curAvatar.src = emp.avatar;
  const curEmpName = document.getElementById("currentEmpName");
  if (curEmpName) curEmpName.textContent = emp.name;
  const curEmpRole = document.getElementById("currentEmpRole");
  if (curEmpRole) curEmpRole.textContent = `${emp.role} (${emp.department})`;
  // Assigned manager (empty when none is set by the admin).
  const mgrEl = document.getElementById("currentEmpManager");
  if (mgrEl) {
    const mgrName = (typeof resolveManagerName === "function") ? resolveManagerName(emp.id) : "";
    if (mgrName) {
      mgrEl.innerHTML = `<i class="fa-solid fa-user-tie"></i> Manager: <strong>${mgrName}</strong>`;
      mgrEl.classList.remove("mgr-none");
    } else {
      mgrEl.innerHTML = `<i class="fa-solid fa-user-tie"></i> No manager assigned`;
      mgrEl.classList.add("mgr-none");
    }
  }
  const calEmpName = document.getElementById("calendarEmpNameDisplay");
  if (calEmpName) calEmpName.textContent = emp.name;

  // Refresh modules
  try { renderMonthlyCalendar(); } catch (e) { console.error("renderMonthlyCalendar err:", e); }
  try { updatePunchStatus(); } catch (e) { console.error("updatePunchStatus err:", e); }
  try { renderLeaveBox(); } catch (e) { console.error("renderLeaveBox err:", e); }
  try { renderWfhBox(); } catch (e) { console.error("renderWfhBox err:", e); }
  try { renderMyRegularisationsList(); } catch (e) { console.error("renderMyRegularisationsList err:", e); }
  try { renderMyRequests(); } catch (e) { console.error("renderMyRequests err:", e); }
  try { renderMyTasks(); } catch (e) { console.error("renderMyTasks err:", e); }
  // Surface admin decisions (approvals, task assignments) as notifications.
  try { syncAdminUpdates(emp.id); renderNotifications(emp.id); } catch (e) { console.error("notifications err:", e); }
}

// ============================================================================
// 2. CLOCK & THEME
// ============================================================================

function initClock() {
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

function initTheme() {
  initThemeSystem();
}

// ============================================================================
// 3. TOP WINDOW: MONTHLY CALENDAR (SHOWS PREVIOUS RECORDS & HISTORY)
// ============================================================================

function getTodayKey() {
  const p = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  return formatDateKey(p); // return formatDateKey(new Date());
}

function renderMonthlyCalendar() {
  const grid = document.getElementById("calendarDaysGrid");
  const monthTitle = document.getElementById("calendarMonthTitle");
  if (!grid || !employeeState.currentEmployee) return;

  try { renderDashboardStats(); } catch (e) { console.error("renderDashboardStats err:", e); }

  const currentYear = employeeState.calendarCurrentDate.getFullYear();
  const currentMonth = employeeState.calendarCurrentDate.getMonth();

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  monthTitle.textContent = `${monthNames[currentMonth]} ${currentYear}`;
  grid.innerHTML = "";

  const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
  const totalDaysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const prevMonthTotalDays = new Date(currentYear, currentMonth, 0).getDate();

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const holidayMap = {};
  holidays.forEach(h => { holidayMap[h.date] = h; });

  // Dates with a submitted regularisation request awaiting admin review
  const regPendingMap = {};
  try {
    getStore(STORAGE_KEYS.REGULARISATIONS, [])
      .filter(r => employeeState.currentEmployee && r.employeeId === employeeState.currentEmployee.id && r.status === "Pending")
      .forEach(r => { regPendingMap[r.date] = r; });
  } catch (e) { console.warn("reg pending map err:", e); }

  // "9h 05m" style worked-hours label from a punch record
  const fmtHoursLabel = (dec) => `${Math.floor(dec)}h ${String(Math.round((dec - Math.floor(dec)) * 60)).padStart(2, "0")}m`;
  const workedMeta = (record) => {
    const open = (typeof isOpenPunch === "function") && isOpenPunch(record);
    const dec = (typeof effectiveHoursDecimal === "function") ? effectiveHoursDecimal(record) : Number(record.hoursDecimal);
    const hrs = (!open && dec > 0) ? fmtHoursLabel(dec) : null;
    const inT = record.checkInTime && record.checkInTime !== "-" ? record.checkInTime : null;
    const outT = record.checkOutTime && record.checkOutTime !== "-" ? record.checkOutTime : null;
    const span = inT && outT ? `${inT} \u2192 ${outT}` : (inT ? `${inT} \u2192 \u2014` : null);
    if (open) return `<span class="day-meta-text"><span class="meta-hours">In Progress</span>${span ? ` &bull; ${span}` : ""}</span>`;
    if (hrs && span) return `<span class="day-meta-text"><span class="meta-hours">${hrs}</span> &bull; ${span}</span>`;
    if (hrs) return `<span class="day-meta-text"><span class="meta-hours">${hrs}</span></span>`;
    return `<span class="day-meta-text">${span || (inT || "Remote")}</span>`;
  };

  // todayKey = formatDateKey(new Date())
  const todayDateObj = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const todayKey = formatDateKey(todayDateObj);

  // Update calendar header today indicator strictly as per Indian Standard Time (IST)
  const headerDateEl = document.getElementById("calendarTodayHeaderDate");
  if (headerDateEl) {
    const formattedIST = todayDateObj.toLocaleDateString("en-US", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric"
    });
    headerDateEl.innerHTML = `<i class="fa-solid fa-calendar-day"></i> Present Day: ${formattedIST} (IST)`;
  }

  let countPresent = 0;
  let countWfh = 0;
  let countLeave = 0;
  let countLop = 0;
  let countAbsent = 0;
  let countNotMarked = 0;

  // Previous Month Padded Days
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const dayNum = prevMonthTotalDays - i;
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.innerHTML = `
      <div class="cell-top-row">
        <span class="day-number">${dayNum}</span>
      </div>
    `;
    grid.appendChild(cell);
  }

  // Current Month Days
  for (let d = 1; d <= totalDaysInMonth; d++) {
    const dayDate = new Date(currentYear, currentMonth, d);
    const dayOfWeek = dayDate.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const dateStr = formatDateKey(dayDate);
    const isToday = dateStr === todayKey;

    const record = records[`${employeeState.currentEmployee.id}_${dateStr}`];
    const declaredHoliday = holidayMap[dateStr];

    const cell = document.createElement("div");
    cell.className = `calendar-day-cell ${isToday ? "is-today" : ""}`;
    cell.dataset.date = dateStr;

    let badgeHtml = "";

    if (declaredHoliday) {
      const shortName = String(declaredHoliday.name).split(/\s+/)[0];
      badgeHtml = `
        <span class="day-badge-pill badge-holiday-day" title="${declaredHoliday.name}">
          <i class="fa-solid fa-star"></i> <span class="pill-text">${shortName}</span>
        </span>
      `;
    } else if (isWeekend) {
      badgeHtml = `<span class="day-badge-pill badge-weekend-day" title="Weekend"><i class="fa-solid fa-mug-hot"></i> Weekend</span>`;
    } else {
      if (record) {
        if (record.status === "Present") {
          countPresent++;
          badgeHtml = `
            <span class="day-badge-pill badge-present" title="Present"><i class="fa-solid fa-circle-check"></i> Present</span>
            ${workedMeta(record)}
          `;
        } else if (record.status === "WFH") {
          countWfh++;
          badgeHtml = `
            <span class="day-badge-pill badge-wfh-day" title="Work from Home"><i class="fa-solid fa-house-laptop"></i> WFH</span>
            ${workedMeta(record)}
          `;
        } else if (record.status === "Loss of Pay") {
          countLop++;
          badgeHtml = `
            <span class="day-badge-pill badge-lop-day" title="Loss of Pay (Approved)"><i class="fa-solid fa-hand-holding-dollar"></i> LoP</span>
            <span class="day-meta-text">Unpaid</span>
          `;
        } else if (record.status === "Holiday" || record.status === "Leave") {
          countLeave++;
          const isRh = record.locationType && record.locationType.includes("RH");
          badgeHtml = `
            <span class="day-badge-pill ${isRh ? 'badge-rh-day' : 'badge-leave-day'}" title="${isRh ? 'Restricted Holiday' : 'Leave'} (Approved)">
              <i class="fa-solid ${isRh ? 'fa-calendar-check' : 'fa-umbrella-beach'}"></i> ${isRh ? 'RH' : 'Leave'}
            </span>
            <span class="day-meta-text">Approved</span>
          `;
        } else if (record.status === "Absent") {
          countAbsent++;
          badgeHtml = `
            <span class="day-badge-pill badge-absent-day" title="Absent"><i class="fa-solid fa-circle-xmark"></i> Absent</span>
          `;
        }
      } else {
        // Only evaluate past working days that occurred on or after employee enrollment
        const curEmp = employeeState.currentEmployee;
        const empEnrolledDate = curEmp.enrolledAt ? new Date(curEmp.enrolledAt + "T00:00:00") : null;
        const isNewEnrollee = curEmp.id !== "EMP001" && curEmp.id !== "EMP002";
        const isBeforeEnrollment = (isNewEnrollee && !empEnrolledDate) || (empEnrolledDate && dayDate < empEnrolledDate);
        const nowZero = new Date(todayDateObj);
        nowZero.setHours(0, 0, 0, 0);

        if (dayDate < nowZero && !isWeekend && !isBeforeEnrollment) {
          if (regPendingMap[dateStr]) {
            // Request submitted & awaiting admin review — not a plain "Not Marked"
            badgeHtml = `
              <span class="day-badge-pill badge-regpending" title="Regularisation ${regPendingMap[dateStr].id} submitted &mdash; awaiting admin review"><i class="fa-solid fa-hourglass-half"></i> Reg. Pending</span>
              <button type="button" class="cell-reg-view" data-reg-date="${dateStr}" title="View your regularisation request for ${dateStr}"><i class="fa-solid fa-eye"></i> View request</button>
            `;
          } else {
            // No punch, no leave, no WFH, no pending request — needs regularisation
            countNotMarked++;
            badgeHtml = `
              <span class="day-badge-pill badge-notmarked" title="Day closed with no record and no leave &mdash; raise a regularisation if you were working"><i class="fa-solid fa-circle-question"></i> Not Marked</span>
              <button type="button" class="cell-reg-quick" data-reg-date="${dateStr}" title="Request regularisation for ${dateStr}"><i class="fa-solid fa-wand-magic-sparkles"></i> Regularise</button>
            `;
          }
        } else if (isToday && !declaredHoliday && !isWeekend) {
          badgeHtml = `
            <span class="day-badge-pill badge-today-active" title="Today &ndash; ready to punch in"><i class="fa-solid fa-clock"></i> Today (Active)</span>
            <span class="day-meta-text">Ready to Punch</span>
          `;
        } else if (dayDate > nowZero && !isWeekend && !isBeforeEnrollment) {
          // Upcoming working day: tidy subtle placeholder (weekends are labelled above).
          badgeHtml = `<span class="day-future-ph" title="Upcoming working day">&mdash;</span>`;
        }
      }
    }

    cell.innerHTML = `
      <div class="cell-top-row">
        <span class="day-number">${d}</span>
        ${isToday ? '<span class="today-marker-chip"><i class="fa-solid fa-star"></i> Today</span>' : ''}
      </div>
      <div class="cell-content">
        ${badgeHtml}
      </div>
    `;

    cell.addEventListener("click", () => {
      openDayDetailsModal(dateStr, record, isWeekend, declaredHoliday);
    });

    cell.querySelectorAll(".cell-reg-quick").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        quickRegulariseDate(btn.dataset.regDate);
      });
    });

    cell.querySelectorAll(".cell-reg-view").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openRegularisationForDate(btn.dataset.regDate, true);
      });
    });

    grid.appendChild(cell);
  }

  // Update Top Stats
  const statP = document.getElementById("statsPresentCount");
  if (statP) statP.textContent = countPresent;
  const statW = document.getElementById("statsWfhCount");
  if (statW) statW.textContent = countWfh;
  const statL = document.getElementById("statsLeaveCount");
  if (statL) statL.textContent = countLeave;
    const statLop = document.getElementById("statsLopCount");
    if (statLop) {
      // Prefer the authoritative (decimal) LOP day count so half-days show as 0.5.
      let lopVal = countLop;
      try {
        if (employeeState.currentEmployee && typeof computeLopDaysForMonth === "function") {
          const ms = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}`;
          lopVal = computeLopDaysForMonth(employeeState.currentEmployee.id, ms);
        }
      } catch (e) { /* fall back to record count */ }
      statLop.textContent = lopVal;
    }
  const statA = document.getElementById("statsAbsentCount");
  if (statA) statA.textContent = countAbsent;
  const statNM = document.getElementById("statsNotMarkedCount");
  if (statNM) statNM.textContent = countNotMarked;
}

function openDayDetailsModal(dateStr, record, isWeekend, declaredHoliday) {
  const modal = document.getElementById("dayDetailModal");
  const modalDayDate = document.getElementById("modalDayDate");
  const modalDayStatusBadge = document.getElementById("modalDayStatusBadge");
  const modalSelfieImg = document.getElementById("modalSelfieImg");
  const modalEmpName = document.getElementById("modalEmpName");
  const modalPunchInTime = document.getElementById("modalPunchInTime");
  const modalPunchOutTime = document.getElementById("modalPunchOutTime");
  const modalWorkDuration = document.getElementById("modalWorkDuration");
  const modalGpsDistance = document.getElementById("modalGpsDistance");
  const modalBioVerification = document.getElementById("modalBioVerification");

  const formattedDate = new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  if (modalDayDate) modalDayDate.textContent = formattedDate;
  if (modalEmpName && employeeState.currentEmployee) modalEmpName.textContent = employeeState.currentEmployee.name;

  if (declaredHoliday) {
    if (modalDayStatusBadge) modalDayStatusBadge.textContent = `Company Holiday: ${declaredHoliday.name}`;
    if (modalSelfieImg && employeeState.currentEmployee) modalSelfieImg.src = employeeState.currentEmployee.avatar;
    if (modalPunchInTime) modalPunchInTime.textContent = "Official Off";
    if (modalPunchOutTime) modalPunchOutTime.textContent = "Official Off";
    if (modalWorkDuration) modalWorkDuration.textContent = "Holiday";
    if (modalGpsDistance) modalGpsDistance.textContent = "N/A";
    if (modalBioVerification) modalBioVerification.innerHTML = `<span class="text-warning">${declaredHoliday.type || 'Official Company Holiday'}</span>`;
  } else if (record) {
    if (modalDayStatusBadge) modalDayStatusBadge.textContent = record.status;
    if (modalSelfieImg && employeeState.currentEmployee) modalSelfieImg.src = record.selfieUrl || employeeState.currentEmployee.avatar;
    if (modalPunchInTime) modalPunchInTime.textContent = record.checkInTime || "--:--";
    if (modalPunchOutTime) modalPunchOutTime.textContent = record.checkOutTime || "--:--";
    if (modalWorkDuration) modalWorkDuration.textContent = record.duration || "Standard Shift";
    if (modalGpsDistance) modalGpsDistance.textContent = record.distance ? `${record.distance} meters` : "N/A";
    const scoreText = record.matchScore ? ` (${record.matchScore}% Match)` : "";
    if (modalBioVerification) modalBioVerification.innerHTML = `<i class="fa-solid fa-circle-check"></i> Photo Verified${scoreText}`;
  } else if (isWeekend) {
    if (modalDayStatusBadge) modalDayStatusBadge.textContent = "Weekend Rest";
    if (modalSelfieImg && employeeState.currentEmployee) modalSelfieImg.src = employeeState.currentEmployee.avatar;
    if (modalPunchInTime) modalPunchInTime.textContent = "Off Day";
    if (modalPunchOutTime) modalPunchOutTime.textContent = "Off Day";
    if (modalWorkDuration) modalWorkDuration.textContent = "Weekend Rest";
    if (modalGpsDistance) modalGpsDistance.textContent = "Not Tracked";
    if (modalBioVerification) modalBioVerification.innerHTML = `Weekend`;
  } else if (dateStr === getTodayKey()) {
    if (modalDayStatusBadge) {
      modalDayStatusBadge.textContent = "Today (Shift in Progress)";
      modalDayStatusBadge.className = "status-badge status-present";
    }
    if (modalSelfieImg && employeeState.currentEmployee) modalSelfieImg.src = employeeState.currentEmployee.avatar;
    if (modalPunchInTime) modalPunchInTime.textContent = "Ready to Punch";
    if (modalPunchOutTime) modalPunchOutTime.textContent = "--:--";
    if (modalWorkDuration) modalWorkDuration.textContent = "In Progress";
    if (modalGpsDistance) modalGpsDistance.textContent = "Awaiting Check-In";
    if (modalBioVerification) modalBioVerification.innerHTML = `<span class="text-warning"><i class="fa-solid fa-clock"></i> Punch In Pending</span>`;
  } else {
    if (modalDayStatusBadge) {
      modalDayStatusBadge.textContent = "Absent";
      modalDayStatusBadge.className = "status-badge status-absent";
    }
    if (modalSelfieImg && employeeState.currentEmployee) modalSelfieImg.src = employeeState.currentEmployee.avatar;
    if (modalPunchInTime) modalPunchInTime.textContent = "--:--";
    if (modalPunchOutTime) modalPunchOutTime.textContent = "--:--";
    if (modalWorkDuration) modalWorkDuration.textContent = "0 hours";
    if (modalGpsDistance) modalGpsDistance.textContent = "No Record";
    if (modalBioVerification) modalBioVerification.innerHTML = `<span class="text-danger">Not Verified</span>`;
  }

  if (modal) {
    trapFocusActivate(modal);
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeDayDetailsModal() {
  const modal = document.getElementById("dayDetailModal");
  if (modal && modal.classList.contains("open")) {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    trapFocusRelease(modal);
  }
}

function initCalendarNav() {
  const prevBtn = document.getElementById("prevMonthBtn");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      employeeState.calendarCurrentDate.setMonth(employeeState.calendarCurrentDate.getMonth() - 1);
      renderMonthlyCalendar();
    });
  }

  const nextBtn = document.getElementById("nextMonthBtn");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      employeeState.calendarCurrentDate.setMonth(employeeState.calendarCurrentDate.getMonth() + 1);
      renderMonthlyCalendar();
    });
  }

  const jumpBtn = document.getElementById("todayJumpBtn");
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      // employeeState.calendarCurrentDate = new Date();
      employeeState.calendarCurrentDate = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
      renderMonthlyCalendar();
    });
  }

  const modal = document.getElementById("dayDetailModal");
  const closeDayBtn = document.getElementById("closeDayModalBtn");
  if (closeDayBtn && modal) {
    closeDayBtn.addEventListener("click", closeDayDetailsModal);
  }
  const closeFooterBtn = document.getElementById("closeDayModalFooterBtn");
  if (closeFooterBtn && modal) {
    closeFooterBtn.addEventListener("click", closeDayDetailsModal);
  }
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeDayDetailsModal();
    });
  }
}

// ============================================================================
// 4. BOX 1: APPLY FOR LEAVE (PERSONAL LEAVE & RH CATEGORIES)
// ============================================================================

function calculatePersonalLeavesUsed(empId) {
  // Single source of truth: only APPROVED leave counts as "used" (pending \u2260 used).
  return (typeof computeApprovedLeaveDaysUsed === "function")
    ? computeApprovedLeaveDaysUsed(empId)
    : 0;
}

function calculateWorkingDaysBetween(startDateStr, endDateStr) {
  const start = new Date(startDateStr + "T00:00:00");
  const end = new Date(endDateStr + "T00:00:00");
  if (end < start) return 0;

  const holidays = getStore(STORAGE_KEYS.HOLIDAYS, DEFAULT_HOLIDAYS);
  const holidayDates = new Set(holidays.map(h => h.date));

  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    const dStr = formatDateKey(cur);
    if (day !== 0 && day !== 6 && !holidayDates.has(dStr)) {
      count++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function renderLeaveBox() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const quota = getEmployeeLeaveQuota(empId);
  const personalUsed = calculatePersonalLeavesUsed(empId);
  const personalRemaining = Math.max(quota.personalLeave - personalUsed, 0);

  const curYear = employeeState.calendarCurrentDate.getFullYear();
  const curMonth = employeeState.calendarCurrentDate.getMonth();
  const rhUsed = countRhUsedInMonth(empId, curYear, curMonth);
  const rhRemaining = Math.max(quota.restrictedLeave - rhUsed, 0);

  const personalRemainEl = document.getElementById("personalRemainingCount");
  const headerLeaveQuota = document.getElementById("headerLeaveQuota");
  const rhUsedEl = document.getElementById("rhUsedThisMonth");
  const rhRemainEl = document.getElementById("rhRemainingCount");
  const headerRhQuota = document.getElementById("headerRhQuota");

  if (personalRemainEl) personalRemainEl.textContent = personalRemaining;
  if (headerLeaveQuota) headerLeaveQuota.textContent = `${personalRemaining} left of ${quota.personalLeave}`;
  if (rhUsedEl) rhUsedEl.textContent = rhUsed;
  if (rhRemainEl) rhRemainEl.textContent = rhRemaining;
  if (headerRhQuota) headerRhQuota.textContent = `${rhRemaining} left of ${quota.restrictedLeave} /mo`;

  renderMyLeavesStatusList();
}

// Render list of leave requests with Self-Cancel (Pending) & Ask-Admin-Cancel (Approved)
function renderMyLeavesStatusList() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);
  const myLeaves = allLeaves.filter(l => l.employeeId === empId);

  const container = document.getElementById("myLeavesStatusList");
  const countBadge = document.getElementById("myLeavesCountBadge");
  if (!container) return;

  if (countBadge) {
    countBadge.textContent = myLeaves.length === 0 ? "No pending requests" : `${myLeaves.length} Request${myLeaves.length === 1 ? '' : 's'}`;
  }

  container.innerHTML = "";

  if (myLeaves.length === 0) {
    container.innerHTML = `
      <div class="my-leaves-empty" style="text-align: center; padding: 1rem; color: var(--text-muted);">
        <i class="fa-regular fa-calendar-check text-muted"></i>
        <span>You're all set &mdash; no leave requests yet. Apply from "Leave Request" and track status here.</span>
      </div>
    `;
    return;
  }

  myLeaves.slice().reverse().forEach(req => {
    const item = document.createElement("div");
    item.className = "leave-request-card";

    let statusClass = "status-badge-pending";
    let statusIcon = "fa-clock";
    let statusLabel = "Pending Approval";

    if (req.status === "Approved") {
      statusClass = "status-badge-granted";
      statusIcon = "fa-circle-check";
      statusLabel = "Granted (Approved)";
    } else if (req.status === "Rejected") {
      statusClass = "status-badge-rejected";
      statusIcon = "fa-circle-xmark";
      statusLabel = "Rejected";
    } else if (req.status === "Cancellation Requested") {
      statusClass = "status-badge-cancel-pending";
      statusIcon = "fa-triangle-exclamation";
      statusLabel = "Cancellation Pending Admin Approval";
    } else if (req.status === "Cancelled") {
      statusClass = "status-badge-rejected";
      statusIcon = "fa-ban";
      statusLabel = "Cancelled";
    }

    const isRh = req.category === "RH" || req.category === "Restricted";

    let actionBtnHtml = "";
    if (req.status === "Pending") {
      actionBtnHtml = `
        <button type="button" class="btn-cancel-req cancel-leave-req-btn" data-id="${req.id}">
          <i class="fa-solid fa-ban"></i> Cancel Request
        </button>
      `;
    } else if (req.status === "Approved") {
      actionBtnHtml = `
        <button type="button" class="btn-ask-cancel ask-cancel-leave-btn" data-id="${req.id}">
          <i class="fa-solid fa-arrow-rotate-left"></i> Ask Admin to Cancel
        </button>
      `;
    }

    item.innerHTML = `
      <div class="leave-card-top" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div class="leave-type-group" style="display:flex; align-items:center; gap:0.6rem;">
          <span class="day-badge-pill ${isRh ? 'badge-rh-day' : 'badge-leave-day'}">
            ${isRh ? '<i class="fa-solid fa-calendar-star"></i> Restricted Leave' : '<i class="fa-solid fa-umbrella-beach"></i> Personal Leave'}
          </span>
          <span class="leave-card-dates font-mono font-bold">${req.startDate}${req.startDate !== req.endDate ? ' &rarr; ' + req.endDate : ''}</span>
          <span class="leave-card-days">(${req.daysCount} Day${req.daysCount > 1 ? 's' : ''})</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <div class="leave-status-pill ${statusClass}">
            <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
          </div>
          ${actionBtnHtml}
        </div>
      </div>
      ${req.reason ? `<div class="leave-card-reason" style="margin-top:0.4rem; font-size:0.82rem;"><span class="text-muted">Reason:</span> ${req.reason}</div>` : ''}
    `;
    container.appendChild(item);
  });

  // Attach Self-Cancel (Pending) listeners
  container.querySelectorAll(".cancel-leave-req-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      let leaves = getStore(STORAGE_KEYS.LEAVES, []);
      const target = leaves.find(l => l.id === id);
      if (target) {
        target.status = "Cancelled";
        setStore(STORAGE_KEYS.LEAVES, leaves);
        renderLeaveBox();
        renderMonthlyCalendar();
        showToast("Leave request withdrawn.", "info");
      }
    });
  });

  // Attach Ask-Admin-To-Cancel (Approved) listeners
  container.querySelectorAll(".ask-cancel-leave-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      let leaves = getStore(STORAGE_KEYS.LEAVES, []);
      const target = leaves.find(l => l.id === id);
      if (target) {
        target.status = "Cancellation Requested";
        setStore(STORAGE_KEYS.LEAVES, leaves);
        renderLeaveBox();
        showToast("Leave cancellation requested from Admin.", "warning");
      }
    });
  });
}

// Find if an employee has already applied for leave on any date in the selected range
function findConflictingLeaveDate(empId, startDateStr, endDateStr) {
  const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);
  const existingLeaveMap = new Map();
  allLeaves.forEach(req => {
    if (req.employeeId === empId && req.status !== "Rejected" && req.status !== "Cancelled") {
      let cur = new Date(req.startDate + "T00:00:00");
      const end = new Date(req.endDate + "T00:00:00");
      while (cur <= end) {
        existingLeaveMap.set(formatDateKey(cur), req);
        cur.setDate(cur.getDate() + 1);
      }
    }
  });

  let cur = new Date(startDateStr + "T00:00:00");
  const end = new Date(endDateStr + "T00:00:00");
  while (cur <= end) {
    const dKey = formatDateKey(cur);
    if (existingLeaveMap.has(dKey)) {
      return { conflictDate: dKey, existingReq: existingLeaveMap.get(dKey) };
    }
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

function initLeaveBox() {
  const form = document.getElementById("leaveRequestForm");
  const categorySelect = document.getElementById("leaveCategorySelect");
  const startInput = document.getElementById("leaveStartDate");
  const endInput = document.getElementById("leaveEndDate");
  const startLabel = document.getElementById("leaveStartDateLabel");
  const endGroup = document.getElementById("leaveEndDateGroup");
  const daysNoticeText = document.getElementById("leaveDaysCountText");
  const warningBox = document.getElementById("leaveBalanceWarning");
  const warningText = document.getElementById("leaveBalanceWarningText");
  const submitBtn = document.getElementById("submitLeaveBtn");
  const rhGroup = document.getElementById("restrictedHolidayGroup");
  const rhSelect = document.getElementById("restrictedHolidaySelect");
  const reasonInput = document.getElementById("leaveReasonInput");

  if (!form) return;
  startInput.value = "2026-10-14";
  endInput.value = "2026-10-14";

  // Inline validation: date pickers must not allow past dates
  const leaveMinDateKey = getTodayKey();
  startInput.min = leaveMinDateKey;
  endInput.min = leaveMinDateKey;

  function populateRestrictedHolidayOptions() {
    if (!rhSelect) return;
    const rhs = getRestrictedHolidays();
    rhSelect.innerHTML = `<option value="">-- Choose Declared Restricted Holiday --</option>`;
    rhs.forEach(h => {
      rhSelect.innerHTML += `<option value="${h.date}">${h.name} (${h.date})</option>`;
    });
  }
  populateRestrictedHolidayOptions();

  function updateRhLockedDisplay(dateVal) {
    const rhFixedGroup = document.getElementById("rhFixedDateDisplayGroup");
    if (!rhFixedGroup) return;
    const rhs = getRestrictedHolidays();
    const matched = rhs.find(h => h.date === dateVal) || rhs[0];
    if (!matched) return;
    const dObj = new Date(matched.date + "T00:00:00");
    const monthShort = dObj.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
    const dayNum = dObj.getDate();
    const fullDateStr = dObj.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const mEl = document.getElementById("rhCardMonth");
    const dEl = document.getElementById("rhCardDay");
    const tEl = document.getElementById("rhCardTitle");
    const subEl = document.getElementById("rhCardDateSub");

    if (mEl) mEl.textContent = monthShort;
    if (dEl) dEl.textContent = dayNum;
    if (tEl) tEl.textContent = matched.name;
    if (subEl) subEl.textContent = fullDateStr;
  }

  function onCategoryChange() {
    const isRh = categorySelect.value === "Restricted" || categorySelect.value === "RH";
    const lopHalfGroup = document.getElementById("lopHalfDayGroup");
    if (lopHalfGroup) lopHalfGroup.style.display = (categorySelect.value === "LossOfPay") ? "block" : "none";
    const rhLockHint = document.getElementById("rhLockedHint");
    const rhFixedGroup = document.getElementById("rhFixedDateDisplayGroup");
    const datesRow = document.getElementById("leaveDatesRow");

    if (isRh) {
      if (rhGroup) rhGroup.style.display = "block";
      if (rhFixedGroup) rhFixedGroup.style.display = "block";
      if (datesRow) datesRow.style.display = "none";
      if (endGroup) endGroup.style.display = "none";
      if (startLabel) startLabel.textContent = "Restricted Holiday Date";
      populateRestrictedHolidayOptions();

      // Requirement 2: Do not give employee option to change the date. Just show the date.
      startInput.readOnly = true;
      startInput.style.pointerEvents = "none";
      startInput.classList.add("readonly-locked-date");
      endInput.readOnly = true;
      endInput.style.pointerEvents = "none";
      if (rhLockHint) rhLockHint.style.display = "block";

      // Automatically default to the chosen or first available declared Restricted Holiday date
      const rhs = getRestrictedHolidays();
      if (rhs.length > 0) {
        if (!rhSelect.value || !rhs.some(h => h.date === rhSelect.value)) {
          rhSelect.value = rhs[0].date;
        }
        startInput.value = rhSelect.value;
        endInput.value = startInput.value;
        updateRhLockedDisplay(startInput.value);
        const matched = rhs.find(h => h.date === startInput.value);
        if (matched && reasonInput && (!reasonInput.value || reasonInput.value.includes("celebration"))) {
          reasonInput.value = `${matched.name} celebration`;
        }
      }
    } else {
      if (rhGroup) rhGroup.style.display = "none";
      if (rhFixedGroup) rhFixedGroup.style.display = "none";
      if (datesRow) datesRow.style.display = "grid";
      if (endGroup) endGroup.style.display = "block";
      if (startLabel) startLabel.textContent = "Start Date";

      // Unlock date inputs for personal leave
      startInput.readOnly = false;
      startInput.style.pointerEvents = "auto";
      startInput.classList.remove("readonly-locked-date");
      endInput.readOnly = false;
      endInput.style.pointerEvents = "auto";
      if (rhLockHint) rhLockHint.style.display = "none";

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = formatDateKey(tomorrow);
      if (startInput.value === "2026-10-20" || startInput.value === "2026-10-21") {
        startInput.value = tomorrowStr;
        endInput.value = tomorrowStr;
      }
    }
    validateLeaveSelection();
  }

  if (rhSelect) {
    rhSelect.addEventListener("change", () => {
      if (rhSelect.value) {
        startInput.value = rhSelect.value;
        endInput.value = rhSelect.value;
        updateRhLockedDisplay(rhSelect.value);
        const rhs = getRestrictedHolidays();
        const matched = rhs.find(h => h.date === rhSelect.value);
        if (matched && reasonInput && (!reasonInput.value || reasonInput.value.includes("celebration"))) {
          reasonInput.value = `${matched.name} celebration`;
        }
        validateLeaveSelection();
      }
    });
  }

  function validateLeaveSelection() {
    if (!startInput.value || !employeeState.currentEmployee) return;
    const category = categorySelect.value;
    const isRh = category === "Restricted" || category === "RH";
    if (isRh) endInput.value = startInput.value;
    // A Loss of Pay confirmation box is styled differently from an error box.
    if (warningBox && category !== "LossOfPay") warningBox.classList.remove("warning-box-lop");

    // 0. Past-date guard (inline, before any other rule)
    const todayGuardKey = getTodayKey();
    if (startInput.value < todayGuardKey) {
      daysNoticeText.textContent = "Start date cannot be in the past";
      warningText.innerHTML = `<i class="fa-solid fa-calendar-day"></i> Requests can only start from <strong>today</strong> (${todayGuardKey}) onwards.`;
      warningBox.style.display = "flex";
      submitBtn.disabled = true;
      return;
    }

    const workingDays = isRh ? 1 : calculateWorkingDaysBetween(startInput.value, endInput.value);
    const empId = employeeState.currentEmployee.id;
    const quota = getEmployeeLeaveQuota(empId);

    // 1. Strict Duplicate Check
    const conflict = findConflictingLeaveDate(empId, startInput.value, endInput.value);
    if (conflict) {
      daysNoticeText.textContent = `Date unavailable: already applied`;
      warningText.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Duplicate Request: You already applied for leave on <strong>${conflict.conflictDate}</strong> (Status: ${conflict.existingReq.status}).`;
      warningBox.style.display = "flex";
      submitBtn.disabled = true;
      return;
    }

    if (isRh) {
      const curDate = new Date(startInput.value + "T00:00:00");
      const rhUsed = countRhUsedInMonth(empId, curDate.getFullYear(), curDate.getMonth());
      const rhRemaining = Math.max(quota.restrictedLeave - rhUsed, 0);

      daysNoticeText.textContent = `Restricted Holiday: 1 day requested (${rhRemaining} of ${quota.restrictedLeave} remaining this month)`;

      if (rhRemaining <= 0) {
        warningText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Exceeds monthly Restricted Leave allowance! You have ${rhRemaining} Restricted leave days remaining.`;
        warningBox.style.display = "flex";
        submitBtn.disabled = true;
        return;
      }

      warningBox.style.display = "none";
      submitBtn.disabled = false;
    } else if (category === "LossOfPay") {
      // Loss of Pay: unpaid by choice — the paid-leave quota never blocks it,
      // but the employee sees the estimated pay deduction and must confirm.
      const halfEl = document.getElementById("lopHalfDay");
      const isHalf = !!(halfEl && halfEl.checked);
      const lopDays = isHalf ? 0.5 : workingDays;
      const monthStr = startInput.value.slice(0, 7);
      let est = { perDayRate: 0, amount: 0 };
      try { if (typeof estimateLopDeduction === "function") est = estimateLopDeduction(empId, monthStr, lopDays); } catch (e) { /* non-fatal */ }
      daysNoticeText.textContent = `Loss of Pay: ${lopDays} day(s) requested (unpaid \u2014 paid-leave quota untouched)`;
      warningText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> This is an <strong>unpaid</strong> Loss of Pay request. Estimated pay deduction: <strong>\u20b9 ${money2(est.amount)}</strong> (\u20b9 ${money2(est.perDayRate)}/day \u00d7 ${lopDays}). Confirm you want to apply for Loss of Pay.`;
      warningBox.style.display = "flex";
      warningBox.classList.add("warning-box-lop");
      submitBtn.disabled = false;
    } else {
      // Personal Leave Rule
      const personalUsed = calculatePersonalLeavesUsed(empId);
      const personalRemaining = Math.max(quota.personalLeave - personalUsed, 0);

      daysNoticeText.textContent = `Personal Leave: ${workingDays} working day(s) requested (${personalRemaining} days left out of ${quota.personalLeave})`;

      if (workingDays > personalRemaining) {
        warningText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Exceeds personal annual leave quota! You only have ${personalRemaining} days remaining.`;
        warningBox.style.display = "flex";
        submitBtn.disabled = true;
      } else {
        warningBox.style.display = "none";
        submitBtn.disabled = false;
      }
    }
  }

  categorySelect.addEventListener("change", onCategoryChange);
  startInput.addEventListener("change", () => {
    if (categorySelect.value === "Restricted" || categorySelect.value === "RH") {
      endInput.value = startInput.value;
      if (rhSelect) rhSelect.value = startInput.value || "";
    }
    validateLeaveSelection();
  });
  endInput.addEventListener("change", validateLeaveSelection);
  const lopHalfEl = document.getElementById("lopHalfDay");
  if (lopHalfEl) lopHalfEl.addEventListener("change", validateLeaveSelection);
  validateLeaveSelection();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const category = categorySelect.value;
    const isRh = category === "Restricted" || category === "RH";
    const isLop = category === "LossOfPay";
    const lopHalfEl = document.getElementById("lopHalfDay");
    const lopHalf = isLop && !!(lopHalfEl && lopHalfEl.checked);
    const startVal = startInput.value;
    const endVal = (isRh || lopHalf) ? startVal : endInput.value;
    const reasonVal = document.getElementById("leaveReasonInput").value.trim();

    if (!startVal || !endVal || !reasonVal || !employeeState.currentEmployee) return;

    const workingDays = isRh ? 1 : calculateWorkingDaysBetween(startVal, endVal);
    const effDays = lopHalf ? 0.5 : workingDays;
    if (!isRh && !lopHalf && workingDays <= 0) {
      showToast("End date must be on or after start date.", "error");
      return;
    }

    const empId = employeeState.currentEmployee.id;
    const quota = getEmployeeLeaveQuota(empId);

    // Strict duplicate check
    const conflict = findConflictingLeaveDate(empId, startVal, endVal);
    if (conflict) {
      showToast(`Duplicate request blocked: Leave covering ${conflict.conflictDate} already exists!`, "error");
      return;
    }

    if (isRh) {
      const curDate = new Date(startVal + "T00:00:00");
      const rhUsed = countRhUsedInMonth(empId, curDate.getFullYear(), curDate.getMonth());
      if (quota.restrictedLeave - rhUsed <= 0) {
        showToast("Exceeds monthly Restricted Leave allowance.", "error");
        return;
      }
    } else if (!isLop) {
      const personalUsed = calculatePersonalLeavesUsed(empId);
      if (workingDays > (quota.personalLeave - personalUsed)) {
        showToast("Exceeds annual personal leave allowance.", "error");
        return;
      }
    }

    const newLeave = {
      id: `LEV-${Date.now()}`,
      employeeId: empId,
      employeeName: employeeState.currentEmployee.name,
      startDate: startVal,
      endDate: endVal,
      daysCount: effDays,
      lopHalfDay: lopHalf || undefined,
      category: isRh ? "Restricted" : (isLop ? "LossOfPay" : "Personal"),
      type: isRh ? "Restricted Holiday" : (isLop ? "Loss of Pay (Unpaid)" : "Personal Leave"),
      reason: reasonVal,
      status: "Pending", // Awaiting Admin Review
      createdAt: formatDateKey(new Date())
    };

    const allLeaves = getStore(STORAGE_KEYS.LEAVES, []);
    allLeaves.push(newLeave);
    setStore(STORAGE_KEYS.LEAVES, allLeaves);

    form.reset();
    if (isRh) {
      startInput.value = "2026-10-20";
      endInput.value = "2026-10-20";
    } else {
      startInput.value = "2026-10-16";
      endInput.value = "2026-10-16";
    }
    renderLeaveBox();
    try { renderMyRequests(); } catch (e) { console.error(e); }
    showToast(`${isRh ? "Restricted Holiday" : (isLop ? "Loss of Pay" : "Personal Leave")} request for ${startVal} submitted for Admin approval!`, "success");
    closeActionCard("modalCardApplyLeave");
  });
}

// ============================================================================
// 5. BOX 2: MARK PRESENT / PUNCH OUT (STRICT PHOTO >= 70% & GPS)
// ============================================================================

function getElapsedShiftMinutes(record) {
  if (!record || !record.checkInTime || record.checkInTime === "-") return 0;
  if (record.simulatedFullShift) return 9999;
  if (record.capturedTimestamp) {
    return Math.max(0, Math.floor((Date.now() - record.capturedTimestamp) / 60000));
  }
  try {
    const parts = record.checkInTime.trim().split(" ");
    const timeParts = parts[0].split(":").map(Number);
    let h = timeParts[0];
    const m = timeParts[1] || 0;
    const mer = parts[1] ? parts[1].toUpperCase() : "";
    if (mer === "PM" && h < 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    const checkInDate = new Date();
    checkInDate.setHours(h, m, 0, 0);
    const diffMs = Date.now() - checkInDate.getTime();
    return Math.max(0, Math.floor(diffMs / 60000));
  } catch (e) {
    return 0;
  }
}

function updatePunchStatus() {
  if (!employeeState.currentEmployee) return;
  const todayKey = getTodayKey();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const todayRecord = records[`${employeeState.currentEmployee.id}_${todayKey}`];

  const todayDot = document.getElementById("todayDot");
  const todayStatusText = document.getElementById("todayStatusText");
  const punchStateLabel = document.getElementById("punchStateLabel");
  const punchStateSub = document.getElementById("punchStateSub");
  const openInBtn = document.getElementById("openPunchInModalBtn");
  const openOutBtn = document.getElementById("openPunchOutModalBtn");
  const todayMetricsStrip = document.getElementById("todayMetricsStrip");
  const longBtnPill = document.getElementById("longBtnStatusPill");
  const longBtnHint = document.getElementById("longBtnStatusHint");
  const lockNotice = document.getElementById("punchOutLockNotice");
  const lockIcon = document.getElementById("shiftLockIcon");
  const lockText = document.getElementById("punchOutLockText");
  const simWrap = document.getElementById("simulateShiftActionWrap");
  const punchOutSubText = document.getElementById("punchOutSubText");

  if (!todayRecord) {
    if (todayDot) todayDot.className = "status-indicator-dot dot-pending";
    if (todayStatusText) todayStatusText.textContent = "Today: Not Punched In";
    if (punchStateLabel) punchStateLabel.textContent = "Status: Ready to Punch In";
    if (punchStateSub) punchStateSub.textContent = "Camera opens only when you click the button below";
    if (openInBtn) openInBtn.style.display = "flex";
    if (openOutBtn) openOutBtn.style.display = "none";
    if (todayMetricsStrip) todayMetricsStrip.style.display = "none";
    if (lockNotice) lockNotice.style.display = "none";
    if (longBtnPill) {
      longBtnPill.textContent = "Ready to Punch";
      longBtnPill.className = "long-btn-status-pill pill-ready";
    }
    if (longBtnHint) {
      longBtnHint.textContent = "Click to open attendance check-in card • Ready to Mark Present";
    }
  } else if (todayRecord.status === "Present") {
    if (todayMetricsStrip) todayMetricsStrip.style.display = "grid";
    const inDisp = document.getElementById("todayInTimeDisplay");
    if (inDisp) inDisp.textContent = todayRecord.checkInTime || "--:--";
    const outDisp = document.getElementById("todayOutTimeDisplay");
    if (outDisp) outDisp.textContent = todayRecord.checkOutTime || "Active Shift";
    const matchDisp = document.getElementById("todayMatchScoreDisplay");
    if (matchDisp) matchDisp.textContent = todayRecord.matchScore ? `${todayRecord.matchScore}%` : "Passed";

    if (!todayRecord.checkOutTime || todayRecord.checkOutTime === "-") {
      if (todayDot) todayDot.className = "status-indicator-dot dot-present";
      if (todayStatusText) todayStatusText.textContent = `Today: Present (Checked In at ${todayRecord.checkInTime})`;
      if (punchStateLabel) punchStateLabel.textContent = `Active Shift (In at ${todayRecord.checkInTime})`;
      if (punchStateSub) punchStateSub.textContent = "Click below to verify location & photograph to Punch Out";
      if (openInBtn) openInBtn.style.display = "none";
      if (openOutBtn) {
        openOutBtn.style.display = "flex";
        openOutBtn.disabled = false;
      }

      // Check Admin Minimum Shift Policy & Punch-out Restriction
      const minPolicy = getMinWorkDurationPolicy();
      const elapsedMinutes = getElapsedShiftMinutes(todayRecord);
      const reqMinutes = minPolicy.totalMinutes || (minPolicy.hours * 60 + minPolicy.minutes);
      const isDurationMet = Boolean(todayRecord.simulatedFullShift) || (elapsedMinutes >= reqMinutes);

      const workedH = Math.floor(elapsedMinutes / 60);
      const workedM = elapsedMinutes % 60;
      const reqH = minPolicy.hours;
      const reqM = minPolicy.minutes;

      if (!isDurationMet) {
        if (lockNotice) {
          lockNotice.style.display = "flex";
          lockNotice.className = "shift-lock-banner locked";
        }
        if (lockIcon) lockIcon.className = "fa-solid fa-lock text-warning";
        if (lockText) {
          lockText.innerHTML = `<strong>Punch-Out Restricted:</strong> Policy requires at least <strong>${reqH}h ${reqM > 0 ? reqM + 'm' : '00m'}</strong> on duty before punch-out. Worked so far: <strong>${workedH}h ${String(workedM).padStart(2, '0')}m</strong>.`;
        }
        if (simWrap) simWrap.style.display = "block";
        if (punchOutSubText) {
          punchOutSubText.textContent = `Restricted: requires ${reqH}h ${reqM > 0 ? reqM + 'm' : '00m'} duty (${workedH}h ${workedM}m done)`;
        }
        if (longBtnPill) {
          longBtnPill.textContent = `Shift Active (${workedH}h ${workedM}m)`;
          longBtnPill.className = "long-btn-status-pill pill-in";
        }
        if (longBtnHint) {
          longBtnHint.textContent = `Checked in at ${todayRecord.checkInTime} • Punch-out restricted until ${reqH}h completed`;
        }
      } else {
        if (lockNotice) {
          lockNotice.style.display = "flex";
          lockNotice.className = "shift-lock-banner unlocked";
        }
        if (lockIcon) lockIcon.className = "fa-solid fa-lock-open text-success";
        if (lockText) {
          lockText.innerHTML = `<strong>Minimum Shift Completed:</strong> Required <strong>${reqH}h ${reqM > 0 ? reqM + 'm' : '00m'}</strong> fulfilled. You are eligible to Punch Out.`;
        }
        if (simWrap) simWrap.style.display = "none";
        if (punchOutSubText) {
          punchOutSubText.textContent = "Click to capture photo and complete today's shift";
        }
        if (longBtnPill) {
          longBtnPill.textContent = "Ready to Punch Out";
          longBtnPill.className = "long-btn-status-pill pill-ready";
        }
        if (longBtnHint) {
          longBtnHint.textContent = `Shift complete (${reqH}h met) • Click to Punch Out`;
        }
      }
    } else {
      todayDot.className = "status-indicator-dot dot-present";
      todayStatusText.textContent = `Shift Complete (${todayRecord.checkInTime} - ${todayRecord.checkOutTime})`;
      punchStateLabel.textContent = "Shift Completed for Today";
      punchStateSub.textContent = `Total duration logged: ${todayRecord.duration}`;
      openInBtn.style.display = "none";
      openOutBtn.style.display = "flex";
      openOutBtn.disabled = true;
      if (lockNotice) lockNotice.style.display = "none";
      if (longBtnPill) {
        longBtnPill.textContent = "Shift Complete";
        longBtnPill.className = "long-btn-status-pill pill-done";
      }
      if (longBtnHint) {
        longBtnHint.textContent = `Shift completed (${todayRecord.checkInTime} - ${todayRecord.checkOutTime})`;
      }
    }
  } else if (todayRecord.status === "WFH") {
    todayDot.className = "status-indicator-dot dot-wfh";
    todayStatusText.textContent = `Today: Work From Home (${todayRecord.checkInTime || "Approved"})`;
    punchStateLabel.textContent = "Work From Home Logged";
    punchStateSub.textContent = "Remote work assigned under weekly 2-day policy.";
    openInBtn.style.display = "none";
    openOutBtn.style.display = "none";
    if (lockNotice) lockNotice.style.display = "none";
    if (longBtnPill) {
      longBtnPill.textContent = "WFH Today";
      longBtnPill.className = "long-btn-status-pill pill-wfh";
    }
    if (longBtnHint) {
      longBtnHint.textContent = "Work From Home active for today";
    }
  }
}

// On-Demand Camera Photo Capture Modal (Photo snapshot taken and sent to Admin upon confirmation)
function openVerificationModal(mode = "in") {
  if (mode === "out") {
    if (!employeeState.currentEmployee) return;
    const todayKey = getTodayKey();
    const records = getStore(STORAGE_KEYS.RECORDS, {});
    const todayRecord = records[`${employeeState.currentEmployee.id}_${todayKey}`];
    const minPolicy = getMinWorkDurationPolicy();
    const elapsedMinutes = getElapsedShiftMinutes(todayRecord);
    const reqMinutes = minPolicy.totalMinutes || (minPolicy.hours * 60 + minPolicy.minutes);

    if (!todayRecord?.simulatedFullShift && elapsedMinutes < reqMinutes) {
      const workedH = Math.floor(elapsedMinutes / 60);
      const workedM = elapsedMinutes % 60;
      const reqH = minPolicy.hours;
      const reqM = minPolicy.minutes;
      showToast(`Punch-Out restricted: Minimum shift policy requires ${reqH}h ${reqM > 0 ? reqM + 'm' : '00m'} on duty. (Worked: ${workedH}h ${String(workedM).padStart(2, '0')}m)`, "warning");
      playSound("error");
      return;
    }
  }

  currentVerifyMode = mode;
  capturedLiveSelfie = null;
  currentMatchScore = 100;
  isLivePhotoVerified = false;

  const modal = document.getElementById("punchVerificationModal");
  const modalTitle = document.getElementById("verifyModalTitle");
  const modalActionBadge = document.getElementById("verifyActionBadge");
  const confirmBtnText = document.getElementById("confirmBtnText");
  const confirmBtn = document.getElementById("confirmVerificationBtn");
  const snapBtn = document.getElementById("modalSnapPhotoBtn");
  const snapBtnText = document.getElementById("snapBtnText");
  const guidance = document.getElementById("modalVerifyGuidanceText");
  const overlay = document.getElementById("verifyCapturedOverlay");

  // Reset Captured Overlay & Snap previews
  if (overlay) overlay.classList.remove("show");
  const modalLiveAvatar = document.getElementById("modalLiveAvatar");
  if (modalLiveAvatar) modalLiveAvatar.src = "";
  const modalPhotoPill = document.getElementById("modalPhotoPill");
  if (modalPhotoPill) {
    modalPhotoPill.className = "verification-status-pill";
    modalPhotoPill.textContent = "Capture Required";
  }
  const modalPhotoDesc = document.getElementById("modalPhotoDesc");
  if (modalPhotoDesc) {
    modalPhotoDesc.textContent = 'Click "Capture Live Photo" to take photo and confirm attendance';
  }

  // Step 1: Confirm button starts disabled until photo is captured (Requirement 8)
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.classList.remove("btn-punch-in-ready", "btn-punch-out-ready");
    confirmBtn.classList.add("btn-secondary");
  }
  if (snapBtn) {
    snapBtn.disabled = false;
    if (snapBtnText) snapBtnText.textContent = "Capture Live Photo";
    snapBtn.innerHTML = `<i class="fa-solid fa-camera"></i> <span id="snapBtnText">Capture Live Photo</span>`;
  }

  const hud = document.getElementById("verifyBiometricHud");
  if (hud) hud.style.display = "none";

  if (mode === "in") {
    modalTitle.innerHTML = `<i class="fa-solid fa-camera text-primary"></i> Mark Present (Check-In)`;
    modalActionBadge.textContent = "Attendance Photo";
    confirmBtnText.textContent = "Confirm Attendance";
  } else {
    modalTitle.innerHTML = `<i class="fa-solid fa-right-from-bracket text-danger"></i> Punch Out (Clock-Out)`;
    modalActionBadge.textContent = "Clock-Out Photo";
    confirmBtnText.textContent = "Confirm Clock-Out";
  }

  if (guidance) {
    guidance.innerHTML = `Click <strong>Capture Live Photo</strong> to snap your photo and mark attendance.`;
  }

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  trapFocusActivate(modal);

  // Evaluate Geofence Location (with an explicit "fetching" state first)
  startGpsFetch();

  // Start Camera ON-DEMAND immediately
  startModalCamera();
}

function closeVerificationModal() {
  const modal = document.getElementById("punchVerificationModal");
  trapFocusRelease(modal);
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  capturedLiveSelfie = null;
  isLivePhotoVerified = false;
  const confirmBtn = document.getElementById("confirmVerificationBtn");
  if (confirmBtn) {
    confirmBtn.classList.remove("btn-punch-in-ready", "btn-punch-out-ready");
    confirmBtn.classList.add("btn-secondary");
    confirmBtn.disabled = true;
  }
  const modalLiveAvatar = document.getElementById("modalLiveAvatar");
  if (modalLiveAvatar) modalLiveAvatar.src = "";
  stopModalCamera();
}

async function startModalCamera() {
  const video = document.getElementById("verifyWebcamVideo");
  const fallback = document.getElementById("verifyCamFallback");
  const msg = document.getElementById("camFallbackMsg");

  try {
    if (msg) msg.textContent = "Requesting camera permission...";
    liveVerifyStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false
    });
    if (video) {
      video.srcObject = liveVerifyStream;
      video.play();
    }
    if (fallback) fallback.classList.remove("show");
  } catch (err) {
    console.warn("Camera permission error:", err);
    if (fallback) fallback.classList.add("show");
    if (msg) msg.textContent = "Camera permission needed to punch in. Enable the camera for this site, then retry below.";
    showToast("Camera unavailable — allow permission to capture your attendance photo.", "warning");
  }
}

function stopModalCamera() {
  if (liveVerifyStream) {
    liveVerifyStream.getTracks().forEach(track => track.stop());
    liveVerifyStream = null;
  }
}

// ----------------------------------------------------------------------------
// GPS fetch UX: show an explicit "Fetching GPS location..." state, then resolve
// ----------------------------------------------------------------------------
function startGpsFetch() {
  const gpsPill = document.getElementById("modalGpsPill");
  const distVal = document.getElementById("modalDistValue");
  if (gpsPill) {
    gpsPill.className = "verification-status-pill pill-fetching";
    gpsPill.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Fetching GPS location\u2026`;
    gpsPill.style.cursor = "default";
    gpsPill.onclick = null;
  }
  if (distVal) distVal.textContent = "\u2026";
  const fixInfoEl = document.getElementById("modalGpsFixInfo");
  if (fixInfoEl) fixInfoEl.style.display = "none"; // never show a stale fix while re-fetching

  // Require a fresh, real device fix before any punch can be accepted.
  employeeState.userLocation.located = false;
  employeeState.userLocation.isWithinGeofence = false;

  const isExempt = employeeState.currentEmployee && employeeState.currentEmployee.geofenceEnforcement === "exempt";
  // Employees marked Exempt by Admin are allowed everywhere and need no GPS.
  if (isExempt) {
    employeeState.userLocation.located = true;
    setTimeout(() => evaluateModalLocation(), 500);
    return;
  }

  if (!navigator.geolocation) {
    setGpsUnavailable("Geolocation isn't supported on this device, so your location can't be verified.");
    return;
  }

  // Best-sample collection: the FIRST fix is usually a coarse Wi-Fi/IP guess.
  // Keep watching briefly and use the most accurate reading so real GPS can
  // settle in and overwrite it (resolves early once accuracy is GPS-grade).
  if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  const TARGET_ACCURACY_M = 30;
  const MAX_WAIT_MS = 9000;
  let best = null;
  let lastError = null;
  let settled = false;

  const finishFetch = () => {
    if (settled) return;
    settled = true;
    if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    if (best) {
      applyDeviceFix(best);
    } else if (lastError) {
      const codes = { 1: "Location permission was denied", 2: "Your location is currently unavailable", 3: "The location request timed out" };
      setGpsUnavailable(`${codes[lastError.code] || "Could not determine your location"}. Allow location access, then tap \"Retry\" near the office.`);
    } else {
      setGpsUnavailable("Could not get a GPS reading in time. Stay still and tap \"Retry\".");
    }
  };

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!best || pos.coords.accuracy < best.coords.accuracy) {
        best = pos;
        // Live feedback while the receiver refines the fix
        const accPill = document.getElementById("modalGpsPill");
        if (accPill) {
          accPill.className = "verification-status-pill pill-fetching";
          accPill.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> Refining fix (\u00b1${Math.round(pos.coords.accuracy || 0)}m)\u2026`;
        }
      }
      if (best && best.coords.accuracy <= TARGET_ACCURACY_M) finishFetch();
    },
    (err) => { lastError = err; if (!best) finishFetch(); },
    { enableHighAccuracy: true, timeout: MAX_WAIT_MS + 5000, maximumAge: 0 }
  );
  setTimeout(finishFetch, MAX_WAIT_MS);
}

// Apply the most accurate device sample and evaluate the geofence against it.
function applyDeviceFix(pos) {
  employeeState.userLocation.lat = pos.coords.latitude;
  employeeState.userLocation.lng = pos.coords.longitude;
  employeeState.userLocation.accuracy = Math.round(pos.coords.accuracy || 0);
  employeeState.userLocation.located = true;
  console.log("[Geofence] Best GPS fix:", pos.coords.latitude.toFixed(6), pos.coords.longitude.toFixed(6), "accuracy(m):", Math.round(pos.coords.accuracy || 0));
  evaluateModalLocation();
}

// Fail-closed state: no usable location means no punch can proceed (unless exempt).
function setGpsUnavailable(message) {
  const gpsPill = document.getElementById("modalGpsPill");
  const distVal = document.getElementById("modalDistValue");
  const guidance = document.getElementById("modalVerifyGuidanceText");
  employeeState.userLocation.located = false;
  employeeState.userLocation.isWithinGeofence = false;
  employeeState.userLocation.distanceMeters = null;
  if (distVal) distVal.textContent = "\u2014";
  if (gpsPill) {
    gpsPill.className = "verification-status-pill pill-danger";
    gpsPill.innerHTML = `<i class="fa-solid fa-location-crosshairs"></i> Retry location`;
    gpsPill.style.cursor = "pointer";
    gpsPill.onclick = () => startGpsFetch();
    gpsPill.title = "Tap to request your location again";
  }
  if (guidance) guidance.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> ${message}</span>`;
  showToast(message, "error");
  playSound("error");
}

// ----------------------------------------------------------------------------
// Modal accessibility: focus trap + focus restore to the triggering control
// ----------------------------------------------------------------------------
const MODAL_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const modalTriggerMap = new WeakMap();
const modalStack = [];

function trapFocusActivate(modalEl) {
  if (!modalStack.includes(modalEl)) {
    modalTriggerMap.set(modalEl, document.activeElement);
    modalStack.push(modalEl);
  }
  const focusables = modalEl.querySelectorAll(MODAL_FOCUSABLE);
  if (focusables.length) focusables[0].focus();
}

function trapFocusRelease(modalEl) {
  const idx = modalStack.indexOf(modalEl);
  if (idx !== -1) modalStack.splice(idx, 1);
  const trigger = modalTriggerMap.get(modalEl);
  if (trigger && document.contains(trigger) && typeof trigger.focus === "function") trigger.focus();
  modalTriggerMap.delete(modalEl);
}

function frontmostOpenModal() {
  return modalStack.length ? modalStack[modalStack.length - 1] : null;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = frontmostOpenModal();
    if (!modal) return;
    e.preventDefault();
    if (modal.id === "punchVerificationModal") closeVerificationModal();
    else if (modal.id === "dayDetailModal") closeDayDetailsModal();
    else closeActionCard(modal.id);
  } else if (e.key === "Tab") {
    const modal = frontmostOpenModal();
    if (!modal) return;
    const focusables = Array.from(modal.querySelectorAll(MODAL_FOCUSABLE)).filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

function evaluateModalLocation() {
  const settings = getStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);
  employeeState.officeSettings = settings;

  const distance = calculateDistanceInMeters(
    employeeState.userLocation.lat,
    employeeState.userLocation.lng,
    settings.lat,
    settings.lng
  );

  employeeState.userLocation.distanceMeters = distance;

  // Check if this employee has geofence exemption rule configured by Admin
  const isExempt = employeeState.currentEmployee && employeeState.currentEmployee.geofenceEnforcement === "exempt";
  employeeState.userLocation.isWithinGeofence = isExempt ? true : (distance <= settings.radius);

  const distVal = document.getElementById("modalDistValue");
  const gpsPill = document.getElementById("modalGpsPill");
  const hint = document.getElementById("modalOfficeCenterHint");

  if (distVal) distVal.textContent = `${distance}`;
  if (hint) hint.textContent = isExempt ? `${settings.name} (Exempt by Admin - Allowed Everywhere)` : `${settings.name} (${settings.radius}m limit)`;

  if (gpsPill) {
    const accNow = employeeState.userLocation.accuracy;
    const accCoarse = !isExempt && employeeState.userLocation.located && accNow != null && accNow > GPS_ACCURACY_MAX_M;
    if (isExempt) {
      gpsPill.className = "verification-status-pill pill-success";
      gpsPill.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Exempt (${distance}m)`;
    } else if (accCoarse) {
      gpsPill.className = "verification-status-pill pill-warning";
      gpsPill.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Fix \u00b1${accNow}m coarse`;
    } else if (distance <= settings.radius) {
      gpsPill.className = "verification-status-pill pill-success";
      gpsPill.innerHTML = `<i class="fa-solid fa-circle-check"></i> Within ${settings.radius}m`;
    } else {
      gpsPill.className = "verification-status-pill pill-danger";
      gpsPill.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Outside (${distance}m)`;
    }
  }

  // Show exactly what the device reported and when, so real detection is visible.
  const fixInfo = document.getElementById("modalGpsFixInfo");
  if (fixInfo) {
    if (isExempt || !employeeState.userLocation.located) {
      fixInfo.style.display = "none";
    } else {
      const acc = employeeState.userLocation.accuracy;
      let fixHtml = `<i class="fa-solid fa-satellite-dish"></i> Device reported <strong>${Number(employeeState.userLocation.lat).toFixed(5)}, ${Number(employeeState.userLocation.lng).toFixed(5)}</strong>${acc ? ` &plusmn;${acc}m accuracy` : ""} &middot; ${formatTimeString(new Date())}`;
      if (acc && acc > GPS_ACCURACY_MAX_M) {
        fixHtml += ` &middot; <span class="gps-acc-warn"><i class="fa-solid fa-triangle-exclamation"></i> Coarse fix \u2014 punches need \u2264 ${GPS_ACCURACY_MAX_M}m accuracy. Allow <strong>Precise location</strong> for this site, turn off VPN, then Retry.</span>`;
      }
      fixInfo.innerHTML = fixHtml;
      fixInfo.style.display = "block";
    }
  }
}

// Click Photo directly and prepare for confirmation (No AI facial verification threshold hurdle)
async function handleCaptureLivePhoto() {
  const video = document.getElementById("verifyWebcamVideo");
  const canvas = document.getElementById("verifyPhotoCanvas");
  const snapBtn = document.getElementById("modalSnapPhotoBtn");
  const overlay = document.getElementById("verifyCapturedOverlay");
  const capturedImg = document.getElementById("verifyCapturedPhotoImg");
  const guidance = document.getElementById("modalVerifyGuidanceText");
  const confirmBtn = document.getElementById("confirmVerificationBtn");

  // Geofence Rule Check (requires a real, fresh device location fix)
  const settings = getStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);
  const isExempt = employeeState.currentEmployee && employeeState.currentEmployee.geofenceEnforcement === "exempt";
  const located = Boolean(employeeState.userLocation.located);

  if (!isExempt && !located) {
    if (guidance) {
      guidance.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Location not verified yet \u2014 allow location access and wait for the GPS fix before capturing.</span>`;
    }
    showToast("Location not verified. Allow location access, then try again.", "error");
    playSound("error");
    return;
  }

  // Strict accuracy: a coarse fix can't prove presence, in either direction.
  const accNow = employeeState.userLocation.accuracy;
  if (!isExempt && located && accNow != null && accNow > GPS_ACCURACY_MAX_M) {
    if (guidance) {
      guidance.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> GPS fix too coarse (\u00b1${accNow}m) to be trusted. Allow <strong>Precise location</strong>, move near a window, then tap <strong>Retry location</strong> above.</span>`;
    }
    showToast(`GPS fix too coarse (\u00b1${accNow}m). Refine the fix and retry.`, "error");
    playSound("error");
    return;
  }

  const distance = calculateDistanceInMeters(
    employeeState.userLocation.lat,
    employeeState.userLocation.lng,
    settings.lat,
    settings.lng
  );
  employeeState.userLocation.distanceMeters = distance;
  const withinGeofence = isExempt ? true : (located && distance <= settings.radius);

  if (!withinGeofence) {
    if (guidance) {
      guidance.innerHTML = `<span class="text-danger"><i class="fa-solid fa-circle-xmark"></i> Location Rejected: You are ${distance}m away (exceeds ${settings.radius}m office boundary).</span>`;
    }
    showToast(`Check-in rejected: ${distance}m distance exceeds office radius limit.`, "error");
    playSound("error");
    return;
  }

  // Draw snapshot to canvas
  canvas.width = (video && video.videoWidth > 0) ? video.videoWidth : 480;
  canvas.height = (video && video.videoHeight > 0) ? video.videoHeight : 360;
  const ctx = canvas.getContext("2d");

  if (video && video.videoWidth > 0) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } else {
    // Fallback snapshot card if camera stream is mock or denied
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 22px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(employeeState.currentEmployee?.name || "Employee Attendance", canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = "14px Inter, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(new Date().toLocaleString(), canvas.width / 2, canvas.height / 2 + 25);
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  capturedLiveSelfie = dataUrl;
  isLivePhotoVerified = true;
  if (capturedImg) capturedImg.src = dataUrl;
  if (overlay) overlay.classList.add("show");

  const modalLiveAvatar = document.getElementById("modalLiveAvatar");
  if (modalLiveAvatar) modalLiveAvatar.src = dataUrl;
  const modalPhotoPill = document.getElementById("modalPhotoPill");
  if (modalPhotoPill) {
    modalPhotoPill.className = "verification-status-pill pill-success";
    modalPhotoPill.innerHTML = '<i class="fa-solid fa-circle-check"></i> Photo Captured';
  }
  const modalPhotoDesc = document.getElementById("modalPhotoDesc");
  if (modalPhotoDesc) {
    modalPhotoDesc.textContent = "Attendance photo captured successfully. Ready to confirm!";
  }

  if (snapBtn) {
    snapBtn.disabled = false;
    snapBtn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> Retake Photo`;
  }
  
  // Requirement 8: Punch In button turns Green from grey; Punch Out button turns Red
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.classList.remove("btn-secondary");
    if (currentVerifyMode === "in") {
      confirmBtn.classList.add("btn-punch-in-ready");
      confirmBtn.classList.remove("btn-punch-out-ready");
    } else {
      confirmBtn.classList.add("btn-punch-out-ready");
      confirmBtn.classList.remove("btn-punch-in-ready");
    }
  }

  const actionName = currentVerifyMode === "in" ? "Confirm Attendance" : "Confirm Clock-Out";
  if (guidance) {
    guidance.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> Photo snapped! Click <strong>${actionName}</strong> below to mark present.</span>`;
  }

  playSound("success");
  showToast("Photo snapped! Click confirm to mark present.", "success");
}

// Reset photo capture to retake
function handleRetakePhoto() {
  const overlay = document.getElementById("verifyCapturedOverlay");
  const snapBtn = document.getElementById("modalSnapPhotoBtn");
  const confirmBtn = document.getElementById("confirmVerificationBtn");
  const guidance = document.getElementById("modalVerifyGuidanceText");

  capturedLiveSelfie = null;
  isLivePhotoVerified = false;

  if (overlay) overlay.classList.remove("show");
  const modalLiveAvatar = document.getElementById("modalLiveAvatar");
  if (modalLiveAvatar) modalLiveAvatar.src = "";
  const modalPhotoPill = document.getElementById("modalPhotoPill");
  if (modalPhotoPill) {
    modalPhotoPill.className = "verification-status-pill";
    modalPhotoPill.textContent = "Capture Required";
  }
  const modalPhotoDesc = document.getElementById("modalPhotoDesc");
  if (modalPhotoDesc) {
    modalPhotoDesc.textContent = 'Click "Capture Live Photo" to take photo and confirm attendance';
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.classList.remove("btn-punch-in-ready", "btn-punch-out-ready");
    confirmBtn.classList.add("btn-secondary");
  }
  if (snapBtn) {
    snapBtn.disabled = false;
    snapBtn.innerHTML = `<i class="fa-solid fa-camera"></i> <span id="snapBtnText">Capture Live Photo</span>`;
  }
  if (guidance) {
    guidance.innerHTML = `Click <strong>Capture Live Photo</strong> to snap your photograph, then confirm below.`;
  }
}

// Confirm Attendance after Photo is Captured: Immediately marked present and photo sent to Admin
async function handleConfirmVerification() {
  if (!capturedLiveSelfie || !isLivePhotoVerified || typeof capturedLiveSelfie !== "string" || !capturedLiveSelfie.startsWith("data:image")) {
    showToast("Photo required: You must capture your photo to mark attendance.", "warning");
    playSound("error");
    return;
  }

  const confirmBtn = document.getElementById("confirmVerificationBtn");
  if (confirmBtn) confirmBtn.disabled = true;

  const settings = getStore(STORAGE_KEYS.SETTINGS, DEFAULT_OFFICE);
  const distance = calculateDistanceInMeters(
    employeeState.userLocation.lat,
    employeeState.userLocation.lng,
    settings.lat,
    settings.lng
  );
  const isExempt = employeeState.currentEmployee && employeeState.currentEmployee.geofenceEnforcement === "exempt";
  const located = Boolean(employeeState.userLocation.located);
  const accConfirm = employeeState.userLocation.accuracy;
  const accCoarseConfirm = !isExempt && accConfirm != null && accConfirm > GPS_ACCURACY_MAX_M;
  const withinGeofence = isExempt ? true : (located && !accCoarseConfirm && distance <= settings.radius);

  if (!withinGeofence) {
    showToast(accCoarseConfirm ? `Check-in rejected: GPS fix too coarse (\u00b1${accConfirm}m). Retry for a precise fix.` : `Check-in rejected: ${distance}m distance exceeds office radius limit.`, "error");
    playSound("error");
    return;
  }

  const todayKey = getTodayKey();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const now = new Date();
  const timeStr = formatTimeString(now);

  if (currentVerifyMode === "in") {
    // Punch In (Check-In) -> Marked Present immediately, photo goes to Admin
    records[`${employeeState.currentEmployee.id}_${todayKey}`] = {
      employeeId: employeeState.currentEmployee.id,
      date: todayKey,
      status: "Present",
      checkInTime: timeStr,
      checkOutTime: "-",
      duration: "In Progress",
      hoursDecimal: 0,
      distance: distance,
      locationType: isExempt ? `Office (Exempt - ${distance}m)` : `Office (Geofenced \u2264 500m)`,
      bioVerified: true,
      photoVerified: true,
      userPunched: true,
      matchScore: 100,
      capturedTimestamp: Date.now(), // Saved for 24-hour retention in Admin Console
      selfieUrl: capturedLiveSelfie
    };
    setStore(STORAGE_KEYS.RECORDS, records);
    showToast(`Attendance marked Present at ${timeStr}! Photo submitted to Admin Console.`, "success");
  } else {
    // Punch Out (Clock-Out)
    const existing = records[`${employeeState.currentEmployee.id}_${todayKey}`];
    if (existing) {
      existing.checkOutTime = timeStr;
      const minPolicy = getMinWorkDurationPolicy();
      const elapsedM = getElapsedShiftMinutes(existing);
      const hLogged = Math.max(minPolicy.hours, Math.floor(elapsedM / 60));
      const mLogged = Math.max(minPolicy.minutes, elapsedM % 60);
      existing.duration = `${hLogged}h ${String(mLogged).padStart(2, '0')}m`;
      existing.hoursDecimal = Number((hLogged + (mLogged / 60)).toFixed(2));
      existing.outCapturedTimestamp = Date.now();
      existing.outSelfieUrl = capturedLiveSelfie;
      records[`${employeeState.currentEmployee.id}_${todayKey}`] = existing;
      setStore(STORAGE_KEYS.RECORDS, records);
      showToast(`Punched out at ${timeStr}. Shift logged!`, "success");
    }
  }

  playSound("success");
  closeVerificationModal();
  closeActionCard("modalCardMarkPresent");
  updatePunchStatus();
  renderMonthlyCalendar();
}

function initVerificationModal() {
  const openInBtn = document.getElementById("openPunchInModalBtn");
  const openOutBtn = document.getElementById("openPunchOutModalBtn");
  if (openInBtn) openInBtn.addEventListener("click", () => openVerificationModal("in"));
  if (openOutBtn) openOutBtn.addEventListener("click", () => openVerificationModal("out"));

  const closeBtn = document.getElementById("closeVerifyModalBtn");
  const cancelBtn = document.getElementById("cancelVerifyModalBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeVerificationModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeVerificationModal);

  const retryBtn = document.getElementById("verifyRetryCamBtn");
  if (retryBtn) retryBtn.addEventListener("click", startModalCamera);

  const snapBtn = document.getElementById("modalSnapPhotoBtn");
  if (snapBtn) {
    snapBtn.addEventListener("click", () => {
      if (capturedLiveSelfie && isLivePhotoVerified) {
        handleRetakePhoto();
      } else {
        handleCaptureLivePhoto();
      }
    });
  }

  const retakeBtn = document.getElementById("verifyRetakeBtn");
  if (retakeBtn) {
    retakeBtn.addEventListener("click", handleRetakePhoto);
  }

  const confirmBtn = document.getElementById("confirmVerificationBtn");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", handleConfirmVerification);
  }

  // Simulation button for Testing Required Shift Duration fulfillment
  const simShiftBtn = document.getElementById("btnSimulateCompleteShift");
  if (simShiftBtn) {
    simShiftBtn.addEventListener("click", () => {
      if (!employeeState.currentEmployee) return;
      const todayKey = getTodayKey();
      const records = getStore(STORAGE_KEYS.RECORDS, {});
      const key = `${employeeState.currentEmployee.id}_${todayKey}`;
      const rec = records[key];
      if (rec) {
        rec.simulatedFullShift = true;
        records[key] = rec;
        setStore(STORAGE_KEYS.RECORDS, records);
        showToast("Minimum shift requirement satisfied via simulation! You can now Punch Out.", "success");
        updatePunchStatus();
      }
    });
  }

  // Manual re-fetch of the device location (real GPS only — fake preset
  // buttons were removed because they never set `located` and confused UX)
  const gpsRefreshBtn = document.getElementById("modalGpsRefreshBtn");
  if (gpsRefreshBtn) {
    gpsRefreshBtn.addEventListener("click", startGpsFetch);
  }
}

// ============================================================================
// 6. ACTION HUB MODAL CARDS (MARK PRESENT, APPLY LEAVE, WORK FROM HOME)
// ============================================================================

function openActionCard(modalId) {
  ["modalCardMarkPresent", "modalCardApplyLeave", "modalCardWfh"].forEach(id => {
    const el = document.getElementById(id);
    if (el && id !== modalId && el.classList.contains("open")) {
      closeActionCard(id);
    }
  });

  const target = document.getElementById(modalId);
  if (target && !target.classList.contains("open")) {
    trapFocusActivate(target);
    target.classList.add("open");
    target.setAttribute("aria-hidden", "false");
  }
}

function closeActionCard(modalId) {
  const target = document.getElementById(modalId);
  if (target && target.classList.contains("open")) {
    target.classList.remove("open");
    target.setAttribute("aria-hidden", "true");
    trapFocusRelease(target);
  }
}

function initActionHubToggles() {
  const btnMark = document.getElementById("btnToggleMarkPresent");
  const btnLeave = document.getElementById("btnToggleApplyLeave");
  const btnWfh = document.getElementById("btnToggleWfh");

  const closeMark = document.getElementById("closeCardMarkPresentBtn");
  const closeLeave = document.getElementById("closeCardApplyLeaveBtn");
  const closeWfh = document.getElementById("closeCardWfhBtn");

  if (btnMark) btnMark.addEventListener("click", () => openActionCard("modalCardMarkPresent"));
  if (btnLeave) btnLeave.addEventListener("click", () => openActionCard("modalCardApplyLeave"));
  if (btnWfh) btnWfh.addEventListener("click", () => openActionCard("modalCardWfh"));

  if (closeMark) closeMark.addEventListener("click", () => closeActionCard("modalCardMarkPresent"));
  if (closeLeave) closeLeave.addEventListener("click", () => closeActionCard("modalCardApplyLeave"));
  if (closeWfh) closeWfh.addEventListener("click", () => closeActionCard("modalCardWfh"));

  // Click on backdrop background to dismiss
  ["modalCardMarkPresent", "modalCardApplyLeave", "modalCardWfh"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", (e) => {
        if (e.target === el) closeActionCard(id);
      });
    }
  });

  // ESC key handling is centralized in the modal accessibility manager above
}

// ============================================================================
// 7. WORK FROM HOME (ADMIN APPROVAL REQUIRED + CANCELLATION CONTROLS)
// ============================================================================

function countWfhDaysInWeek(empId, weekKey) {
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  return allWfh.filter(w => w.employeeId === empId && w.weekKey === weekKey && (w.status === "Approved" || w.status === "Pending")).length;
}

function countApprovedWfhDaysInWeek(empId, weekKey) {
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  return allWfh.filter(w => w.employeeId === empId && w.weekKey === weekKey && w.status === "Approved").length;
}

function renderWfhBox() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const currentWeekKey = getWeekKey(employeeState.calendarCurrentDate);
  const approvedThisWeek = (typeof countWfhUsedInWeek === "function") ? countWfhUsedInWeek(empId, currentWeekKey) : countApprovedWfhDaysInWeek(empId, currentWeekKey);
  const activeThisWeek = (typeof countWfhUsedInWeek === "function") ? countWfhUsedInWeek(empId, currentWeekKey) : countWfhDaysInWeek(empId, currentWeekKey);

  const counterEl = document.getElementById("wfhQuotaCounter");
  const barEl = document.getElementById("wfhProgressBar");
  const statusText = document.getElementById("wfhStatusText");
  const headerWfhQuota = document.getElementById("headerWfhQuota");

  if (counterEl) counterEl.textContent = `${approvedThisWeek} of ${WEEKLY_WFH_ALLOWANCE} used this week`;
  if (barEl) barEl.style.width = `${(approvedThisWeek / WEEKLY_WFH_ALLOWANCE) * 100}%`;
  if (headerWfhQuota) headerWfhQuota.textContent = `${activeThisWeek} of ${WEEKLY_WFH_ALLOWANCE} used this week`;

  if (statusText) {
    if (activeThisWeek >= WEEKLY_WFH_ALLOWANCE) {
      statusText.textContent = "0 left";
      statusText.className = "q-val text-danger font-bold";
      const warn = document.getElementById("wfhLimitWarning");
      if (warn) warn.style.display = "flex";
    } else {
      statusText.textContent = `${WEEKLY_WFH_ALLOWANCE - activeThisWeek} left`;
      statusText.className = "q-val text-success font-bold";
      const warn = document.getElementById("wfhLimitWarning");
      if (warn) warn.style.display = "none";
    }
  }

  // Requirement 1: Accessible for any week, no past days, no today if already punched in
  const todayKey = getTodayKey();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const todayRecord = records[`${empId}_${todayKey}`];
  const isPunchedInToday = !!(todayRecord && todayRecord.checkInTime && todayRecord.checkInTime !== "-");

  let minDate = todayKey;
  if (isPunchedInToday) {
    const tomorrow = new Date(employeeState.calendarCurrentDate || CURRENT_DATE);
    tomorrow.setDate(tomorrow.getDate() + 1);
    minDate = formatDateKey(tomorrow);
  }

  const dateInput = document.getElementById("wfhDateInput");
  if (dateInput) {
    dateInput.min = minDate;
    dateInput.removeAttribute("max"); // Unrestricted: accessible for any week
    if (!dateInput.value || dateInput.value < minDate) {
      dateInput.value = minDate;
    }
  }

  // Render My WFH Requests tracker with Self-Cancel (Pending) & Ask-Admin-Cancel (Approved)
  const allWfh = getStore(STORAGE_KEYS.WFH, []);
  const empWfh = allWfh.filter(w => w.employeeId === empId);
  const listEl = document.getElementById("myWfhStatusList");
  const countBadge = document.getElementById("myWfhCountBadge");

  if (countBadge) {
    countBadge.textContent = empWfh.length === 0 ? "No pending requests" : `${empWfh.length} Request${empWfh.length === 1 ? '' : 's'}`;
  }

  if (listEl) {
    listEl.innerHTML = "";
    if (empWfh.length === 0) {
      listEl.innerHTML = `
        <div class="my-leaves-empty" style="text-align: center; padding: 1rem; color: var(--text-muted);">
          <i class="fa-solid fa-house-laptop text-muted"></i>
          <span>No WFH days booked &mdash; enjoy the office! Book remote days under the 2-day/week policy.</span>
        </div>
      `;
    } else {
      empWfh.slice().reverse().forEach(item => {
        const card = document.createElement("div");
        card.className = "leave-request-card";

        let statusClass = "status-badge-pending";
        let statusIcon = "fa-clock";
        let statusLabel = "Pending Admin Approval";

        if (item.status === "Approved") {
          statusClass = "status-badge-granted";
          statusIcon = "fa-circle-check";
          statusLabel = "Approved by Admin";
        } else if (item.status === "Rejected") {
          statusClass = "status-badge-rejected";
          statusIcon = "fa-circle-xmark";
          statusLabel = "Rejected";
        } else if (item.status === "Cancellation Requested") {
          statusClass = "status-badge-cancel-pending";
          statusIcon = "fa-triangle-exclamation";
          statusLabel = "Cancellation Pending Admin";
        } else if (item.status === "Cancelled") {
          statusClass = "status-badge-rejected";
          statusIcon = "fa-ban";
          statusLabel = "Cancelled";
        }

        let actionBtnHtml = "";
        if (item.status === "Pending") {
          actionBtnHtml = `
            <button type="button" class="btn-cancel-req cancel-wfh-req-btn" data-id="${item.id}">
              <i class="fa-solid fa-ban"></i> Cancel Request
            </button>
          `;
        } else if (item.status === "Approved") {
          actionBtnHtml = `
            <button type="button" class="btn-ask-cancel ask-cancel-wfh-btn" data-id="${item.id}">
              <i class="fa-solid fa-arrow-rotate-left"></i> Ask Admin to Cancel
            </button>
          `;
        }

        card.innerHTML = `
          <div class="leave-card-top" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            <div class="leave-type-group" style="display:flex; align-items:center; gap:0.6rem;">
              <span class="day-badge-pill badge-wfh-day">
                <i class="fa-solid fa-house-laptop"></i> Work From Home
              </span>
              <span class="leave-card-dates font-mono font-bold">${item.date}</span>
              <span class="leave-card-days">(${item.weekKey || 'Week'})</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <div class="leave-status-pill ${statusClass}">
                <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
              </div>
              ${actionBtnHtml}
            </div>
          </div>
        `;
        listEl.appendChild(card);
      });

      // Self-cancel pending WFH
      listEl.querySelectorAll(".cancel-wfh-req-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          let wfhItems = getStore(STORAGE_KEYS.WFH, []);
          const target = wfhItems.find(w => w.id === id);
          if (target) {
            target.status = "Cancelled";
            setStore(STORAGE_KEYS.WFH, wfhItems);
            renderWfhBox();
            renderMonthlyCalendar();
            showToast("Work From Home request cancelled.", "info");
          }
        });
      });

      // Ask Admin to cancel approved WFH
      listEl.querySelectorAll(".ask-cancel-wfh-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          let wfhItems = getStore(STORAGE_KEYS.WFH, []);
          const target = wfhItems.find(w => w.id === id);
          if (target) {
            target.status = "Cancellation Requested";
            setStore(STORAGE_KEYS.WFH, wfhItems);
            renderWfhBox();
            showToast("WFH cancellation request sent to Admin.", "warning");
          }
        });
      });
    }
  }
}

function initWfhBox() {
  const form = document.getElementById("wfhRequestForm");
  const dateInput = document.getElementById("wfhDateInput");
  if (!form || !dateInput) return;

  function updateWfhQuotaForSelectedDate() {
    if (!employeeState.currentEmployee) return;
    const empId = employeeState.currentEmployee.id;
    const val = dateInput.value;
    if (!val) return;

    const targetDate = new Date(val + "T00:00:00");
    const weekKey = getWeekKey(targetDate);
    const approvedInWeek = countApprovedWfhDaysInWeek(empId, weekKey);
    const activeInWeek = countWfhDaysInWeek(empId, weekKey);

    const counterEl = document.getElementById("wfhQuotaCounter");
    const barEl = document.getElementById("wfhProgressBar");
    const statusText = document.getElementById("wfhStatusText");
    const warn = document.getElementById("wfhLimitWarning");

    if (counterEl) counterEl.textContent = `${approvedInWeek} / 2 Days (${weekKey})`;
    if (barEl) barEl.style.width = `${(approvedInWeek / WEEKLY_WFH_ALLOWANCE) * 100}%`;

    if (statusText) {
      if (activeInWeek >= WEEKLY_WFH_ALLOWANCE) {
        statusText.textContent = "Quota Used";
        statusText.className = "q-val text-danger font-bold";
        if (warn) warn.style.display = "flex";
      } else {
        statusText.textContent = `${WEEKLY_WFH_ALLOWANCE - activeInWeek} Left`;
        statusText.className = "q-val text-success font-bold";
        if (warn) warn.style.display = "none";
      }
    }
  }

  dateInput.addEventListener("change", updateWfhQuotaForSelectedDate);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const dateVal = dateInput.value;

    if (!dateVal || !employeeState.currentEmployee) return;

    const empId = employeeState.currentEmployee.id;
    const todayKey = getTodayKey();
    const records = getStore(STORAGE_KEYS.RECORDS, {});
    const todayRecord = records[`${empId}_${todayKey}`];
    const isPunchedInToday = !!(todayRecord && todayRecord.checkInTime && todayRecord.checkInTime !== "-");

    // Requirement 1: Don't give option for previous days
    if (dateVal < todayKey) {
      showToast("Work From Home cannot be requested for previous days.", "error");
      return;
    }

    // Requirement 1: If employee is already punched in, don't give option for requesting WFH that day
    if (dateVal === todayKey && isPunchedInToday) {
      showToast("You have already punched in today. Work From Home cannot be requested for today.", "error");
      return;
    }

    const targetDate = new Date(dateVal + "T00:00:00");
    const dayOfWeek = targetDate.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      showToast("Work From Home cannot be scheduled on weekends.", "warning");
      return;
    }

    const weekKey = getWeekKey(targetDate);
    const activeInWeek = countWfhDaysInWeek(empId, weekKey);

    if (activeInWeek >= WEEKLY_WFH_ALLOWANCE) {
      showToast(`Policy Limit Exceeded: Only 2 WFH days allowed per week (${weekKey})!`, "error");
      return;
    }

    const allWfh = getStore(STORAGE_KEYS.WFH, []);
    if (allWfh.some(w => w.employeeId === empId && w.date === dateVal && w.status !== "Cancelled" && w.status !== "Rejected")) {
      showToast("A WFH request for this date is already active or approved.", "warning");
      return;
    }

    // Submit for Admin approval (WFH only applies once approved by Admin)
    const newReq = {
      id: `WFH-${Date.now()}`,
      employeeId: empId,
      employeeName: employeeState.currentEmployee.name,
      date: dateVal,
      weekKey: weekKey,
      status: "Pending", // Sent to admin for approval
      createdAt: formatDateKey(new Date())
    };

    allWfh.push(newReq);
    setStore(STORAGE_KEYS.WFH, allWfh);

    form.reset();
    renderWfhBox();
    try { renderMyRequests(); } catch (e) { console.error(e); }
    showToast(`Work From Home request submitted for Admin approval! (Status: Pending)`, "success");
    closeActionCard("modalCardWfh");
  });
}

// ============================================================================
// 8. ATTENDANCE REGULARISATION (EMPLOYEE PORTAL)
// ============================================================================

let regCalendarState = {
  viewDate: (typeof getPresentDate === "function") ? getPresentDate() : new Date(), // viewDate: new Date()
  selectedDateStr: ""
};

function renderRegularisationCalendar() {
  const grid = document.getElementById("regCalendarGrid");
  const monthTitle = document.getElementById("regCalMonthTitle");
  const dateSelect = document.getElementById("regularisationDate");
  if (!grid || !employeeState.currentEmployee) return;

  const viewYear = regCalendarState.viewDate.getFullYear();
  const viewMonth = regCalendarState.viewDate.getMonth();
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  if (monthTitle) monthTitle.textContent = `${monthNames[viewMonth]} ${viewYear}`;
  grid.innerHTML = "";

  // 1. Day Headers (Sun-Sat)
  const daysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  daysShort.forEach(day => {
    const header = document.createElement("div");
    header.className = "reg-cal-day-header";
    header.textContent = day;
    grid.appendChild(header);
  });

  const firstDayIndex = new Date(viewYear, viewMonth, 1).getDay();
  const totalDaysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthTotalDays = new Date(viewYear, viewMonth, 0).getDate();

  const empId = employeeState.currentEmployee.id;
  const holidays = getDeclaredHolidays();
  const holidayMap = {};
  holidays.forEach(h => { holidayMap[h.date] = h; });

  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const wfhList = getStore(STORAGE_KEYS.WFH, []);
  const allRegs = getStore(STORAGE_KEYS.REGULARISATIONS, []);

  const empLeaves = leaves.filter(l => l.employeeId === empId && l.status !== "Rejected" && l.status !== "Cancelled");
  const empWfh = wfhList.filter(w => w.employeeId === empId && w.status !== "Rejected" && w.status !== "Cancelled");
  const empRegs = allRegs.filter(r => r.employeeId === empId && r.status !== "Rejected" && r.status !== "Cancelled");

  const presentZero = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const nowZero = new Date(presentZero);
  nowZero.setHours(0, 0, 0, 0);

  // 2. Previous Month Padded Days
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const dayNum = prevMonthTotalDays - i;
    const cell = document.createElement("div");
    cell.className = "reg-cal-cell other-month";
    cell.innerHTML = `<span class="cell-day-num">${dayNum}</span>`;
    grid.appendChild(cell);
  }

  // 3. Current Month Days
  for (let d = 1; d <= totalDaysInMonth; d++) {
    const dayDate = new Date(viewYear, viewMonth, d);
    const dayOfWeek = dayDate.getDay();
    const dateStr = formatDateKey(dayDate);
    const dayDateZero = new Date(dayDate);
    dayDateZero.setHours(0, 0, 0, 0);

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const declaredHoliday = holidayMap[dateStr];
    const rec = records[`${empId}_${dateStr}`];

    // Restrictions specified by user:
    // 1) weekends
    // 2) work from home allotted
    // 3) already both punched in and punch out days (full present)
    // 4) leave accepted
    // Also: future dates, declared holidays, already regularised
    const isWfh = empWfh.some(w => w.date === dateStr);
    // Leave blocks regularisation whether Approved or still Pending (Rejected/Cancelled
    // were already filtered out of empLeaves) \u2014 mirrors the eligible-dates dropdown.
    const isLeave = empLeaves.some(l => {
      if (l.date && l.date === dateStr) return true;
      if (l.startDate && l.endDate && dateStr >= l.startDate && dateStr <= l.endDate) return true;
      return false;
    });

    const isFullPresent = Boolean(
      rec && rec.status === "Present" &&
      rec.checkInTime && rec.checkInTime !== "-" &&
      rec.checkOutTime && rec.checkOutTime !== "-"
    );

    const isFuture = dayDateZero > nowZero;
    const isTodayReg = dayDateZero.getTime() === nowZero.getTime();
    const isAlreadyReg = empRegs.some(r => r.date === dateStr);

    let isRestricted = false;
    let restrictionType = "";
    let badgeText = "";
    let restrictionReason = "";

    if (isFuture) {
      isRestricted = true;
      restrictionType = "reg-future";
      badgeText = "Future";
      restrictionReason = "Cannot regularise future date";
    } else if (isTodayReg) {
      isRestricted = true;
      restrictionType = "reg-future";
      badgeText = "Today";
      restrictionReason = "Today is still open \u2014 you can regularise from the next day";
    } else if (isWeekend) {
      isRestricted = true;
      restrictionType = "reg-weekend";
      badgeText = "Weekend";
      restrictionReason = "Weekends cannot be regularised";
    } else if (declaredHoliday) {
      isRestricted = true;
      restrictionType = "reg-holiday";
      badgeText = "Holiday";
      restrictionReason = `Company Holiday (${declaredHoliday.name})`;
    } else if (isWfh) {
      isRestricted = true;
      restrictionType = "reg-wfh";
      badgeText = "WFH Allotted";
      restrictionReason = "Work From Home already allotted";
    } else if (isFullPresent) {
      isRestricted = true;
      restrictionType = "reg-present";
      badgeText = "Full Present";
      restrictionReason = "Already completed full present shift";
    } else if (isLeave) {
      isRestricted = true;
      restrictionType = "reg-leave";
      badgeText = "On Leave";
      restrictionReason = "Leave on record (approved or pending) \u2014 cannot regularise";
    } else if (isAlreadyReg) {
      isRestricted = true;
      restrictionType = "reg-already-applied";
      badgeText = "Reg. Pending";
      restrictionReason = "Regularisation already requested";
    }

    const cell = document.createElement("div");
    const isSelected = regCalendarState.selectedDateStr === dateStr;

    if (isRestricted) {
      cell.className = `reg-cal-cell reg-restricted ${restrictionType}`;
      cell.title = `${dateStr}: ${restrictionReason}`;
      cell.innerHTML = `
        <span class="cell-day-num">${d}</span>
        <span class="cell-mini-pill">${badgeText}</span>
      `;
    } else {
      // Eligible Missed Day!
      cell.className = `reg-cal-cell reg-eligible ${isSelected ? "reg-selected" : ""}`;
      cell.title = `Click to select ${dateStr} for Attendance Regularisation`;
      cell.innerHTML = `
        <span class="cell-day-num">${d}</span>
        <span class="cell-mini-pill ${isSelected ? 'pill-selected' : ''}">${isSelected ? '<i class="fa-solid fa-circle-check"></i> Selected' : '<i class="fa-solid fa-triangle-exclamation"></i> Missed'}</span>
      `;

      cell.addEventListener("click", () => {
        regCalendarState.selectedDateStr = dateStr;
        if (dateSelect) {
          dateSelect.value = dateStr;
          dateSelect.dispatchEvent(new Event("change"));
        }
        updateRegSelectedBanner(dateStr, dayDate);
        renderRegularisationCalendar();
      });
    }

    grid.appendChild(cell);
  }

  // Update banner
  if (regCalendarState.selectedDateStr) {
    const selDate = new Date(regCalendarState.selectedDateStr + "T00:00:00");
    updateRegSelectedBanner(regCalendarState.selectedDateStr, selDate);
  } else {
    updateRegSelectedBanner("", null);
  }
}

function updateRegSelectedBanner(dateStr, dateObj) {
  const banner = document.getElementById("regSelectedDateBanner");
  const text = document.getElementById("regSelectedDateText");
  if (!banner || !text) return;

  if (dateStr && dateObj) {
    banner.classList.add("has-selection");
    const formatted = dateObj.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
    text.innerHTML = `Selected Missed Date: <strong>${formatted} (${dateStr})</strong> &bull; Eligible for Regularisation`;
  } else {
    banner.classList.remove("has-selection");
    text.textContent = "Click an eligible missed working day (highlighted in red) in the calendar above.";
  }
}

// Requirement 2: The dates which are considered as leave or work from home or weekend
// should NOT be shown to apply for attendance regularisation
function populateRegularisationEligibleDates() {
  const dateSelect = document.getElementById("regularisationDate");
  if (!dateSelect || !employeeState.currentEmployee) return;

  const empId = employeeState.currentEmployee.id;
  const holidays = getDeclaredHolidays();
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const leaves = getStore(STORAGE_KEYS.LEAVES, []);
  const wfhList = getStore(STORAGE_KEYS.WFH, []);
  const allRegs = getStore(STORAGE_KEYS.REGULARISATIONS, []);

  // Filter approved or pending leaves for this employee
  const empLeaves = leaves.filter(l => l.employeeId === empId && l.status !== "Rejected" && l.status !== "Cancelled");
  // Filter approved or pending WFH for this employee
  const empWfh = wfhList.filter(w => w.employeeId === empId && w.status !== "Rejected" && w.status !== "Cancelled");
  // Filter approved or pending regularisations
  const empRegs = allRegs.filter(r => r.employeeId === empId && r.status !== "Rejected" && r.status !== "Cancelled");

  const baseDate = new Date(employeeState.calendarCurrentDate || CURRENT_DATE);
  const eligibleDates = [];

  // Scan the past 30 days up to the day BEFORE today (today is still open).
  for (let i = 1; i <= 31; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() - i);
    const dayOfWeek = d.getDay();
    const dateStr = formatDateKey(d);

    // Rule: Exclude weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    // Rule: Exclude declared holidays
    if (holidays.some(h => h.date === dateStr)) continue;

    // Rule: Exclude dates considered as leave (Personal or Restricted)
    const isLeave = empLeaves.some(l => {
      if (l.date && l.date === dateStr) return true;
      if (l.startDate && l.endDate && dateStr >= l.startDate && dateStr <= l.endDate) return true;
      return false;
    });
    if (isLeave) continue;

    // Rule: Exclude dates considered as Work From Home
    const isWfh = empWfh.some(w => w.date === dateStr);
    if (isWfh) continue;

    // Rule: Exclude already full present days (both punch in and punch out complete)
    const rec = records[`${empId}_${dateStr}`];
    const isFullPresent = Boolean(
      rec && rec.status === "Present" &&
      rec.checkInTime && rec.checkInTime !== "-" &&
      rec.checkOutTime && rec.checkOutTime !== "-"
    );
    if (isFullPresent) continue;

    // Rule: Exclude dates that already have pending or approved regularisation
    const isAlreadyReg = empRegs.some(r => r.date === dateStr);
    if (isAlreadyReg) continue;

    const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
    eligibleDates.push({ dateStr, dayName });
  }

  const previousValue = dateSelect.value;
  dateSelect.innerHTML = "";

  if (eligibleDates.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No eligible working dates available";
    dateSelect.appendChild(opt);
    dateSelect.disabled = true;
  } else {
    dateSelect.disabled = false;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- Select Missed Working Day --";
    dateSelect.appendChild(placeholder);

    eligibleDates.forEach(item => {
      const opt = document.createElement("option");
      opt.value = item.dateStr;
      opt.textContent = `${item.dateStr} (${item.dayName}) - Working Day`;
      dateSelect.appendChild(opt);
    });

    if (previousValue && eligibleDates.some(e => e.dateStr === previousValue)) {
      dateSelect.value = previousValue;
    } else {
      dateSelect.value = eligibleDates[0].dateStr;
    }
  }

  if (dateSelect.value && !regCalendarState.selectedDateStr) {
    regCalendarState.selectedDateStr = dateSelect.value;
  }
  renderRegularisationCalendar();
}

// Quick action from a "Not Marked" calendar cell: jump to the Regularisation
// view with the date pre-selected in both the mini calendar and the dropdown.
function quickRegulariseDate(dateStr) {
  if (!dateStr) return;
  regCalendarState.viewDate = new Date(dateStr + "T00:00:00");
  regCalendarState.selectedDateStr = dateStr;
  populateRegularisationEligibleDates();

  const dateSelect = document.getElementById("regularisationDate");
  if (dateSelect && Array.from(dateSelect.options).some(o => o.value === dateStr)) {
    dateSelect.value = dateStr;
    dateSelect.dispatchEvent(new Event("change"));
  }

  if (window.__portalSwitchView) window.__portalSwitchView("regularisation");
  const form = document.getElementById("attendanceRegularisationForm");
  if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Jump to the Regularisation view and highlight the existing request for a date.
function openRegularisationForDate(dateStr) {
  if (!dateStr) return;
  if (window.__portalSwitchView) window.__portalSwitchView("regularisation");
  const list = document.getElementById("myRegularisationsList");
  if (!list) return;
  const card = list.querySelector(`.leave-request-card[data-reg-date="${dateStr}"]`);
  const target = card || list;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  if (card) {
    card.classList.add("reg-card-flash");
    setTimeout(() => card.classList.remove("reg-card-flash"), 2200);
  }
}

function renderMyRegularisationsList() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const allRegs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
  const myRegs = allRegs.filter(r => r.employeeId === empId);

  // Keep eligible dates select dropdown in sync with current leaves & WFH
  populateRegularisationEligibleDates();

  const container = document.getElementById("myRegularisationsList");
  const countBadge = document.getElementById("myRegularisationsCountBadge");
  if (!container) return;

  if (countBadge) {
    countBadge.textContent = myRegs.length === 0 ? "Nothing to regularise" : `${myRegs.length} Request${myRegs.length === 1 ? '' : 's'}`;
  }

  container.innerHTML = "";

  if (myRegs.length === 0) {
    container.innerHTML = `
      <div class="my-leaves-empty" style="text-align: center; padding: 1rem; color: var(--text-muted);">
        <i class="fa-solid fa-clipboard-check text-muted"></i>
        <span>All clear &mdash; no regularisation requests. Missed punches you raise will appear here.</span>
      </div>
    `;
    return;
  }

  myRegs.slice().reverse().forEach(req => {
    const card = document.createElement("div");
    card.className = "leave-request-card";
    card.dataset.regDate = req.date;

    let statusClass = "status-badge-pending";
    let statusIcon = "fa-clock";
    let statusLabel = "Pending Admin Approval";

    if (req.status === "Approved") {
      statusClass = "status-badge-granted";
      statusIcon = "fa-circle-check";
      statusLabel = "Approved & Marked Present";
    } else if (req.status === "Rejected") {
      statusClass = "status-badge-rejected";
      statusIcon = "fa-circle-xmark";
      statusLabel = "Rejected";
    } else if (req.status === "Cancelled") {
      statusClass = "status-badge-rejected";
      statusIcon = "fa-ban";
      statusLabel = "Cancelled";
    }

    let actionBtnHtml = "";
    if (req.status === "Pending") {
      actionBtnHtml = `
        <button type="button" class="btn-cancel-req cancel-reg-btn" data-id="${req.id}">
          <i class="fa-solid fa-ban"></i> Cancel Request
        </button>
      `;
    }

    card.innerHTML = `
      <div class="leave-card-top" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div class="leave-type-group" style="display:flex; align-items:center; gap:0.6rem;">
          <span class="day-badge-pill badge-present">
            <i class="fa-solid fa-business-time"></i> ${req.missedType || 'Regularisation'}
          </span>
          <span class="leave-card-dates font-mono font-bold">${req.date}</span>
          <span class="leave-card-days font-mono">(${req.inTime || '09:00'} - ${req.outTime || '18:00'})</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <div class="leave-status-pill ${statusClass}">
            <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
          </div>
          ${actionBtnHtml}
        </div>
      </div>
      ${req.reason ? `<div class="leave-card-reason" style="margin-top:0.4rem; font-size:0.82rem;"><span class="text-muted">Declared Reason:</span> ${req.reason}</div>` : ''}
    `;
    container.appendChild(card);
  });

  // Attach cancel listeners
  container.querySelectorAll(".cancel-reg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      let regs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
      const target = regs.find(r => r.id === id);
      if (target) {
        target.status = "Cancelled";
        setStore(STORAGE_KEYS.REGULARISATIONS, regs);
        renderMyRegularisationsList();
        try { renderMonthlyCalendar(); } catch (e) { console.error(e); }
        showToast("Attendance regularisation request cancelled.", "info");
      }
    });
  });
}

function initAttendanceRegularisation() {
  const form = document.getElementById("attendanceRegularisationForm");
  const dateInput = document.getElementById("regularisationDate");
  const missedSelect = document.getElementById("regularisationType") || document.getElementById("regularisationMissedType");
  const inTimeInput = document.getElementById("regularisationInTime");
  const outTimeInput = document.getElementById("regularisationOutTime");
  const reasonInput = document.getElementById("regularisationReason");
  const prevBtn = document.getElementById("regCalPrevBtn");
  const nextBtn = document.getElementById("regCalNextBtn");

  if (!form || !dateInput) return;

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      regCalendarState.viewDate.setMonth(regCalendarState.viewDate.getMonth() - 1);
      renderRegularisationCalendar();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      regCalendarState.viewDate.setMonth(regCalendarState.viewDate.getMonth() + 1);
      renderRegularisationCalendar();
    });
  }

  populateRegularisationEligibleDates();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!employeeState.currentEmployee) return;

    const dateVal = dateInput.value || regCalendarState.selectedDateStr;
    const missedVal = missedSelect ? missedSelect.value : "Missed Punch-In";
    const inVal = inTimeInput ? inTimeInput.value : "09:15";
    const outVal = outTimeInput ? outTimeInput.value : "18:15";
    const reasonVal = reasonInput ? reasonInput.value.trim() : "";

    if (!dateVal) {
      showToast("Please select an eligible working date for regularisation.", "warning");
      return;
    }

    if (!reasonVal) {
      showToast("Please enter a valid reason for regularisation.", "warning");
      return;
    }

    const allRegs = getStore(STORAGE_KEYS.REGULARISATIONS, []);
    const existing = allRegs.find(r => r.employeeId === employeeState.currentEmployee.id && r.date === dateVal && r.status === "Pending");
    if (existing) {
      showToast("A pending regularisation request already exists for this date.", "warning");
      return;
    }

    const newReq = {
      id: `REG-${Date.now()}`,
      employeeId: employeeState.currentEmployee.id,
      employeeName: employeeState.currentEmployee.name,
      date: dateVal,
      missedType: missedVal,
      inTime: inVal,
      outTime: outVal,
      reason: reasonVal,
      status: "Pending",
      createdAt: formatDateKey(new Date())
    };

    allRegs.push(newReq);
    setStore(STORAGE_KEYS.REGULARISATIONS, allRegs);

    if (reasonInput) reasonInput.value = "";
    renderMyRegularisationsList();
    try { renderMyRequests(); } catch (e) { console.error(e); }
    try { renderMonthlyCalendar(); } catch (e) { console.error(e); }
    showToast(`Attendance Regularisation request for ${dateVal} submitted to Admin!`, "success");
  });
}

// ============================================================================
// 8b. MY REQUESTS (EMPLOYEE PORTAL) — one live tracker for every request the
// employee raised: Leave / Loss of Pay / WFH / Regularisation.
// ============================================================================
function renderMyRequests() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;

  const items = [];

  // Leaves (Personal / Restricted / Loss of Pay)
  getStore(STORAGE_KEYS.LEAVES, []).forEach(l => {
    if (l.employeeId !== empId) return;
    const isLop = l.category === "LossOfPay" || (l.type || "").indexOf("Loss of Pay") !== -1;
    items.push({
      kind: isLop ? "Loss of Pay" : (l.type || "Personal Leave"),
      icon: isLop ? "fa-hand-holding-dollar" : "fa-umbrella-beach",
      dates: l.startDate === l.endDate ? l.startDate : `${l.startDate} \u2192 ${l.endDate}`,
      days: l.daysCount || 1,
      reason: l.reason || "",
      status: l.status || "Pending",
      createdAt: l.createdAt || l.startDate || ""
    });
  });

  // Work From Home requests (one date each)
  getStore(STORAGE_KEYS.WFH, []).forEach(w => {
    if (w.employeeId !== empId) return;
    items.push({
      kind: "Work From Home",
      icon: "fa-house-laptop",
      dates: w.date || "",
      days: 1,
      reason: w.reason || "",
      status: w.status || "Pending",
      createdAt: w.createdAt || w.date || ""
    });
  });

  // Regularisation requests
  getStore(STORAGE_KEYS.REGULARISATIONS, []).forEach(r => {
    if (r.employeeId !== empId) return;
    items.push({
      kind: "Regularisation",
      icon: "fa-clock-rotate-left",
      dates: r.date || "",
      days: 1,
      reason: r.reason || "",
      status: r.status || "Pending",
      createdAt: r.createdAt || r.date || ""
    });
  });

  // Newest first (createdAt is a YYYY-MM-DD key, stable string sort).
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const listEl = document.getElementById("myRequestsList");
  const summaryEl = document.getElementById("myRequestsSummary");
  const emptyEl = document.getElementById("emptyMyRequestsMsg");
  if (!listEl) return;

  if (emptyEl) emptyEl.style.display = items.length ? "none" : "block";
  if (!items.length) { listEl.innerHTML = ""; if (summaryEl) summaryEl.innerHTML = ""; return; }

  const count = st => items.filter(i => i.status === st).length;
  const pendingN = count("Pending") + count("Cancellation Requested");
  const approvedN = count("Approved");
  const rejectedN = count("Rejected") + count("Cancelled");
  if (summaryEl) {
    summaryEl.innerHTML = `
      <span class="mr-chip mr-pending"><i class="fa-solid fa-hourglass-half"></i> Pending ${pendingN}</span>
      <span class="mr-chip mr-approved"><i class="fa-solid fa-circle-check"></i> Approved ${approvedN}</span>
      <span class="mr-chip mr-rejected"><i class="fa-solid fa-circle-xmark"></i> Rejected ${rejectedN}</span>`;
  }

  const STATUS_CLASS = {
    "Pending": "badge-leave-day",
    "Approved": "badge-present",
    "Rejected": "badge-absent-day",
    "Cancelled": "badge-absent-day",
    "Cancellation Requested": "status-badge-cancel-pending"
  };

  listEl.innerHTML = items.map(it => {
    const pillCls = STATUS_CLASS[it.status] || "badge-leave-day";
    const reasonHtml = it.reason ? `<div class="mr-reason" title="${it.reason}">${it.reason}</div>` : "";
    return `
      <div class="my-req-item">
        <div class="mr-icon"><i class="fa-solid ${it.icon}"></i></div>
        <div class="mr-main">
          <div class="mr-kind">${it.kind} <span class="mr-dates">\u00b7 ${it.dates} (${it.days} day${it.days > 1 ? "s" : ""})</span></div>
          ${reasonHtml}
        </div>
        <span class="day-badge-pill ${pillCls}">${it.status}</span>
      </div>`;
  }).join("");
}

// ============================================================================
// 8c. NOTIFICATIONS & MY TASKS — the employee side of admin actions: approval
// decisions arrive as bell notifications, and Task-board items get a real view.
// ============================================================================

// Diff this employee's request statuses against the last seen snapshot and
// raise a notification for every admin decision (covers even an admin that
// decided while this tab was closed — both consoles share localStorage).
function syncAdminUpdates(empId) {
  if (!empId || typeof pushNotification !== "function") return;
  const snaps = getStore(STORAGE_KEYS.ADMIN_DECISION_SNAP, {}) || {};
  const snap = snaps[empId] || {};
  const nowSnap = {};
  const at = new Date().toISOString();

  getStore(STORAGE_KEYS.LEAVES, []).forEach(l => {
    if (l.employeeId !== empId) return;
    const key = `LEAVE:${l.id}`;
    nowSnap[key] = l.status;
    if (snap[key] && snap[key] !== l.status && l.status !== "Pending") {
      pushNotification(empId, l.status === "Approved" ? "approved" : (l.status === "Rejected" ? "rejected" : "cancelled"),
        `${l.status === "Rejected" ? "Leave Rejected" : (l.status === "Cancelled" ? "Leave Cancelled" : "Leave Approved")}`,
        `Your ${l.type || "leave"} request (${l.startDate}${l.endDate !== l.startDate ? " \u2192 " + l.endDate : ""}) is now ${l.status}.`, "requests");
    }
  });
  getStore(STORAGE_KEYS.WFH, []).forEach(w => {
    if (w.employeeId !== empId) return;
    const key = `WFH:${w.id}`;
    nowSnap[key] = w.status;
    if (snap[key] && snap[key] !== w.status && (w.status === "Approved" || w.status === "Rejected")) {
      pushNotification(empId, w.status === "Approved" ? "approved" : "rejected",
        `WFH ${w.status}`, `Your WFH request for ${w.date} is now ${w.status}.`, "requests");
    }
  });
  getStore(STORAGE_KEYS.REGULARISATIONS, []).forEach(r => {
    if (r.employeeId !== empId) return;
    const key = `REG:${r.id}`;
    nowSnap[key] = r.status;
    if (snap[key] && snap[key] !== r.status && (r.status === "Approved" || r.status === "Rejected")) {
      pushNotification(empId, r.status === "Approved" ? "approved" : "rejected",
        `Regularisation ${r.status}`, `Your regularisation for ${r.date} is now ${r.status}.`, "requests");
    }
  });
  getStore("vkon_tasks_v1", []).forEach(t => {
    if (t.assigneeId !== empId) return;
    const key = `TASK:${t.id}`;
    nowSnap[key] = t.status;
    if (!snap[key] && t.status !== "Done") {
      pushNotification(empId, "task", "New Task Assigned", `"${t.title}"${t.due ? ` is due on ${t.due}` : ""}.`, "tasks");
    } else if (snap[key] && snap[key] !== t.status) {
      pushNotification(empId, "info", `Task now ${t.status}`, `"${t.title}" was moved to ${t.status} by the admin.`, "tasks");
    }
  });

  // Drop snapshot entries for deleted requests, then persist.
  Object.keys(snap).forEach(k => { if (!(k in nowSnap)) delete snap[k]; });
  snaps[empId] = nowSnap;
  setStore(STORAGE_KEYS.ADMIN_DECISION_SNAP, snaps);
}

function notifTimeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!then) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function renderNotifications(empId) {
  const badge = document.getElementById("notifBadge");
  const listEl = document.getElementById("notifList");
  const emptyEl = document.getElementById("notifEmpty");
  if (!badge || !listEl) return;
  if (!empId && employeeState.currentEmployee) empId = employeeState.currentEmployee.id;
  if (!empId) return;

  const items = getNotificationsFor(empId).slice().reverse(); // newest first
  const unread = items.filter(n => !n.read).length;
  badge.textContent = unread > 9 ? "9+" : String(unread);
  badge.style.display = unread ? "" : "none";
  if (emptyEl) emptyEl.style.display = items.length ? "none" : "";

  const ICONS = { task: "fa-list-check", approved: "fa-circle-check", rejected: "fa-circle-xmark", cancelled: "fa-rotate-left", info: "fa-circle-info" };
  listEl.innerHTML = items.map(n => `
    <button type="button" class="notif-item notif-${n.kind}${n.read ? "" : " unread"}" data-link="${n.linkView || ""}">
      <i class="fa-solid ${ICONS[n.kind] || ICONS.info}"></i>
      <span class="ni-body">
        <span class="ni-title">${n.title}</span>
        <span class="ni-text">${n.text}</span>
        <span class="ni-when">${notifTimeAgo(n.at)}</span>
      </span>
    </button>`).join("");
}

function initNotifications() {
  const bell = document.getElementById("notifBellBtn");
  const dd = document.getElementById("notifDropdown");
  const markBtn = document.getElementById("notifMarkReadBtn");
  const listEl = document.getElementById("notifList");
  if (!bell || !dd) return;

  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = dd.style.display !== "none";
    dd.style.display = open ? "none" : "";
    bell.setAttribute("aria-expanded", String(!open));
  });
  document.addEventListener("click", (e) => {
    if (dd.style.display === "none") return;
    if (!dd.contains(e.target) && e.target !== bell) { dd.style.display = "none"; bell.setAttribute("aria-expanded", "false"); }
  });
  if (markBtn) {
    markBtn.addEventListener("click", () => {
      if (employeeState.currentEmployee) {
        markNotificationsRead(employeeState.currentEmployee.id);
        renderNotifications(employeeState.currentEmployee.id);
      }
    });
  }
  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const item = e.target.closest(".notif-item");
      if (!item) return;
      const link = item.getAttribute("data-link");
      dd.style.display = "none";
      bell.setAttribute("aria-expanded", "false");
      if (link && typeof window.switchPortalView === "function") window.switchPortalView(link);
    });
  }
}

// My Tasks — the employee's own view of the Admin Task Board. Read the items
// and act on them (Start / Mark Done); the admin's board reflects it instantly.
function renderMyTasks() {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const todayKey = (typeof getPresentDate === "function") ? formatDateKey(getPresentDate()) : formatDateKey(new Date());
  const my = getStore("vkon_tasks_v1", []).filter(t => t.assigneeId === empId);
  const open = my.filter(t => t.status !== "Done");
  const overdue = open.filter(t => t.due && t.due < todayKey);

  const listEl = document.getElementById("myTasksList");
  const summaryEl = document.getElementById("myTasksSummary");
  const emptyEl = document.getElementById("emptyMyTasksMsg");
  if (!listEl) return;

  // One-time delegated listener for the per-task action buttons.
  if (!listEl.dataset.bound) {
    listEl.dataset.bound = "1";
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-task-action]");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-task-action");
      if (action === "done") updateMyTaskStatus(id, "Done");
      else if (action === "start") updateMyTaskStatus(id, "In Progress");
    });
  }

  if (emptyEl) emptyEl.style.display = my.length ? "none" : "block";
  if (summaryEl) {
    const doneN = my.length - open.length;
    summaryEl.innerHTML = my.length ? `
      <span class="mr-chip mr-pending"><i class="fa-solid fa-briefcase"></i> Open ${open.length}</span>
      <span class="mr-chip ${overdue.length ? "mr-rejected" : "mr-approved"}"><i class="fa-solid fa-triangle-exclamation"></i> Overdue ${overdue.length}</span>
      <span class="mr-chip mr-approved"><i class="fa-solid fa-circle-check"></i> Completed ${doneN}</span>` : "";
  }

  const PILL = { "Open": "badge-leave-day", "In Progress": "badge-wfh-day", "Done": "badge-present" };
  const order = { "In Progress": 0, "Open": 1, "Done": 2 };
  const sorted = my.slice().sort((a, b) => (order[a.status] - order[b.status]) || String(a.due || "9999").localeCompare(String(b.due || "9999")));
  listEl.innerHTML = sorted.map(t => {
    const isOverdue = t.due && t.due < todayKey && t.status !== "Done";
    const isDone = t.status === "Done";
    const doneWhen = isDone && t.completedAt ? ` \u00b7 <span class="task-done-tag">Completed ${formatDateKey(new Date(t.completedAt))}</span>` : "";
    const actions = isDone ? ""
      : `<div class="task-actions">${t.status === "Open" ? `<button type="button" class="btn btn-ghost btn-sm task-act-btn task-start" data-task-action="start" data-id="${t.id}" title="Start this task"><i class="fa-solid fa-play"></i> Start</button>` : ""}<button type="button" class="btn btn-primary btn-sm task-act-btn task-done" data-task-action="done" data-id="${t.id}" title="Mark this task as completed"><i class="fa-solid fa-check"></i> Mark Done</button></div>`;
    return `
      <div class="my-task-item${isOverdue ? " overdue" : ""}${isDone ? " completed" : ""}">
        <div class="mr-icon"><i class="fa-solid ${isDone ? "fa-circle-check" : (isOverdue ? "fa-triangle-exclamation" : "fa-list-check")}"></i></div>
        <div class="mr-main">
          <div class="mr-kind">${t.title}</div>
          <div class="mr-dates">${t.due ? `Due ${t.due}` : "No due date"}${isOverdue ? ' \u00b7 <span class="task-overdue-tag">Overdue</span>' : ""}${doneWhen}</div>
        </div>
        <div class="task-right">
          <span class="day-badge-pill ${PILL[t.status] || "badge-neutral"}">${isDone ? "Completed" : t.status}</span>
          ${actions}
        </div>
      </div>`;
  }).join("");
}

// Employee updates the status of one of their own tasks (Start / Mark Done).
function updateMyTaskStatus(taskId, newStatus) {
  if (!employeeState.currentEmployee) return;
  const empId = employeeState.currentEmployee.id;
  const tasks = getStore("vkon_tasks_v1", []);
  const t = tasks.find(x => x.id === taskId && x.assigneeId === empId);
  if (!t) { showToast("Task not found.", "error"); return; }
  if (t.status === newStatus) return;

  t.status = newStatus;
  if (newStatus === "Done") {
    t.completedAt = new Date().toISOString();
    t.completedBy = empId;
  } else {
    delete t.completedAt;
  }
  setStore("vkon_tasks_v1", tasks);

  // Sync the decision snapshot so the employee's own change doesn't bounce back
  // as a self-notification on the next syncAdminUpdates pass.
  const snaps = getStore(STORAGE_KEYS.ADMIN_DECISION_SNAP, {}) || {};
  if (snaps[empId]) {
    snaps[empId][`TASK:${taskId}`] = newStatus;
    setStore(STORAGE_KEYS.ADMIN_DECISION_SNAP, snaps);
  }

  renderMyTasks();
  showToast(newStatus === "Done" ? "Task marked as completed." : "Task marked as in progress.", "success");
}

// ============================================================================
// 9. PORTAL SIDEBAR NAV (dedicated views: Dashboard / Attendance / Regularisation)
// ============================================================================

function initPortalSideNav() {
  const links = Array.from(document.querySelectorAll(".portal-nav-link[data-view]"));
  if (!links.length) return;

  const VIEW_META = {
    dashboard: ["Dashboard", "Your day at a glance \u2022 punch in, leave & WFH"],
    attendance: ["My Attendance & Leaves", "Full calendar history, leave applications & WFH"],
    requests: ["My Requests", "Track every leave, Loss of Pay, WFH & regularisation you raised"],
    tasks: ["My Tasks", "Work assigned to you by the Admin \u2022 due dates & status"],
    regularisation: ["Regularisation Requests", "Raise & track missed-punch fixes"]
  };

  const titleEl = document.getElementById("portalViewTitle");
  const subEl = document.getElementById("portalViewSub");
  const views = Array.from(document.querySelectorAll(".portal-view"));
  const burger = document.getElementById("portalBurgerBtn");
  const overlay = document.getElementById("portalDrawerOverlay");
  const shell = document.querySelector(".portal-shell");

  function closeMobileDrawer() {
    if (shell) shell.classList.remove("portal-nav-open");
    if (burger) burger.setAttribute("aria-expanded", "false");
  }

  // Policy summary: full inline row on Dashboard, collapsed info popover elsewhere.
  const policyZone = document.getElementById("policyZone");
  const policyToggle = document.getElementById("policyToggle");
  function closePolicyPopover() {
    if (policyZone) policyZone.classList.remove("open");
    if (policyToggle) policyToggle.setAttribute("aria-expanded", "false");
  }
  if (policyToggle && policyZone) {
    policyToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = policyZone.classList.toggle("open");
      policyToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (policyZone.classList.contains("open") && !policyZone.contains(e.target)) closePolicyPopover();
    });
  }

  function switchView(viewId) {
    links.forEach(l => l.classList.toggle("active", l.dataset.view === viewId));
    views.forEach(v => v.classList.toggle("portal-view-active", v.dataset.portalView === viewId));
    if (viewId === "requests") {
      try { renderMyRequests(); } catch (e) { console.error(e); }
    }
    if (viewId === "tasks") {
      try { renderMyTasks(); } catch (e) { console.error(e); }
    }
    document.body.classList.toggle("policy-collapsed", viewId !== "dashboard");
    closePolicyPopover();
    const meta = VIEW_META[viewId];
    if (meta && titleEl && subEl) {
      titleEl.textContent = meta[0];
      subEl.textContent = meta[1];
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    closeMobileDrawer();
  }

  // Exposed so notification clicks can deep-link into a view.
  window.switchPortalView = switchView;

  links.forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(link.dataset.view);
    });
  });

  // Mobile burger: slide the sidebar in as an off-canvas drawer
  if (burger) {
    burger.addEventListener("click", () => {
      const open = shell && shell.classList.contains("portal-nav-open");
      if (open) { closeMobileDrawer(); }
      else {
        if (shell) shell.classList.add("portal-nav-open");
        burger.setAttribute("aria-expanded", "true");
      }
    });
  }
  if (overlay) overlay.addEventListener("click", closeMobileDrawer);

  const drawerClose = document.getElementById("portalDrawerCloseBtn");
  if (drawerClose) drawerClose.addEventListener("click", closeMobileDrawer);

  switchView("dashboard");
  window.__portalSwitchView = switchView;
}

// ----------------------------------------------------------------------------
// Dashboard personal stats cards (present days, WFH, leaves, hours)
// ----------------------------------------------------------------------------
function setDashText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ----------------------------------------------------------------------------
// Dashboard: Upcoming Holidays panel (fills otherwise-empty dashboard space)
// ----------------------------------------------------------------------------
function renderUpcomingHolidays() {
  const list = document.getElementById("upcomingHolidaysList");
  const empty = document.getElementById("upcomingHolidaysEmpty");
  if (!list) return;
  // Include BOTH declared and restricted holidays (getDeclaredHolidays() filters to declared only).
  let holidays = [];
  try {
    holidays = getStore(STORAGE_KEYS.HOLIDAYS, (typeof DEFAULT_HOLIDAYS !== "undefined" ? DEFAULT_HOLIDAYS : []));
  } catch (e) {
    holidays = (typeof getDeclaredHolidays === "function") ? getDeclaredHolidays() : [];
  }
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const nowZero = new Date(now); nowZero.setHours(0, 0, 0, 0);
  const upcoming = holidays
    .map(h => ({ name: h.name, type: h.type || "", dObj: new Date(h.date + "T00:00:00") }))
    .filter(h => h.dObj >= nowZero)
    .sort((a, b) => a.dObj - b.dObj)
    .slice(0, 4);
  if (!upcoming.length) { list.innerHTML = ""; if (empty) empty.style.display = ""; return; }
  if (empty) empty.style.display = "none";
  list.innerHTML = upcoming.map(h => {
    const days = Math.round((h.dObj - nowZero) / 86400000);
    const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : `in ${days} days`;
    const dow = h.dObj.toLocaleDateString("en-US", { weekday: "short", timeZone: "Asia/Kolkata" });
    const dm = h.dObj.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    const isRh = /restricted/i.test(h.type);
    return `<li class="uh-item ${isRh ? "uh-rh" : "uh-declared"}">`
      + `<span class="uh-date-badge"><span class="uh-dow">${dow}</span><span class="uh-dm">${dm}</span></span>`
      + `<span class="uh-info"><span class="uh-name">${h.name}</span><span class="uh-type">${isRh ? "Restricted Holiday" : "Declared Holiday"}</span></span>`
      + `<span class="uh-when">${when}</span>`
      + `</li>`;
  }).join("");
}

function renderDashboardStats() {
  if (!employeeState.currentEmployee) return;
  const emp = employeeState.currentEmployee;
  const records = getStore(STORAGE_KEYS.RECORDS, {});
  const now = (typeof getPresentDate === "function") ? getPresentDate() : new Date();
  const year = employeeState.calendarCurrentDate.getFullYear();
  const month = employeeState.calendarCurrentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let present = 0;
  let hours = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const rec = records[`${emp.id}_${formatDateKey(new Date(year, month, d))}`];
    const h = (typeof effectiveHoursDecimal === "function") ? effectiveHoursDecimal(rec) : ((rec && rec.hoursDecimal) || 0);
    if (rec && rec.status === "Present") { present++; hours += h; }
    else if (rec && rec.status === "WFH") { hours += h; }
  }

  const weekKey = getWeekKey(now);
  const wfhUsed = (typeof countWfhUsedInWeek === "function") ? countWfhUsedInWeek(emp.id, weekKey) : 0;
  const wfhRemaining = Math.max((typeof WEEKLY_WFH_ALLOWANCE !== "undefined" ? WEEKLY_WFH_ALLOWANCE : 2) - wfhUsed, 0);

  const quota = getEmployeeLeaveQuota(emp.id);
  const leavesUsed = calculatePersonalLeavesUsed(emp.id);
  const leaveRemaining = Math.max(quota.personalLeave - leavesUsed, 0);

  const monthName = employeeState.calendarCurrentDate.toLocaleDateString("en-US", { month: "long", timeZone: "Asia/Kolkata" });

  setDashText("dashStatDaysPresent", present);
  setDashText("dashStatPresentSub", monthName);
  setDashText("dashStatWfh", `${wfhRemaining} left`);
  setDashText("dashStatWfhSub", `${wfhUsed} used of ${typeof WEEKLY_WFH_ALLOWANCE !== "undefined" ? WEEKLY_WFH_ALLOWANCE : 2} this week`);
  setDashText("dashStatLeaves", `${leaveRemaining} left`);
  setDashText("dashStatLeaveSub", `${leavesUsed} used of ${quota.personalLeave} / year`);
  setDashText("dashStatHours", Math.round(hours));
  setDashText("dashStatHoursSub", monthName);
  try { renderUpcomingHolidays(); } catch (e) { console.error("renderUpcomingHolidays err:", e); }
}

// ============================================================================
// 10. BOOTSTRAP
// ============================================================================

window.addEventListener("DOMContentLoaded", () => {
  try { initClock(); } catch (e) { console.error("Error in initClock:", e); }
  try { initTheme(); } catch (e) { console.error("Error in initTheme:", e); }
  try { initAuthSystem(); } catch (e) { console.error("Error in initAuthSystem:", e); }
  try { initPortalSideNav(); } catch (e) { console.error("Error in initPortalSideNav:", e); }
    try { initNotifications(); } catch (e) { console.error("Error in initNotifications:", e); }
  try { initActionHubToggles(); } catch (e) { console.error("Error in initActionHubToggles:", e); }
  try { initCalendarNav(); } catch (e) { console.error("Error in initCalendarNav:", e); }
  try { initLeaveBox(); } catch (e) { console.error("Error in initLeaveBox:", e); }
  try { initVerificationModal(); } catch (e) { console.error("Error in initVerificationModal:", e); }
  try { initWfhBox(); } catch (e) { console.error("Error in initWfhBox:", e); }
  try { initAttendanceRegularisation(); } catch (e) { console.error("Error in initAttendanceRegularisation:", e); }

  try { checkActiveSession(); } catch (e) { console.error("Error in checkActiveSession:", e); }

  console.log("VKON Employee Portal Initialized.");
});

/**
 * DayPopover — a single, reusable, dark-themed details popover for the
 * attendance calendars (employee portal "My Attendance & Leaves" and the admin
 * employee calendar). Punch details live here, NOT in the day cell, so the cell
 * stays minimal (date + status chip only).
 *
 * Interaction model:
 *   - Desktop (hover-capable): hovering a cell opens the popover after ~150ms;
 *     moving the pointer away, pressing Escape or clicking elsewhere closes it.
 *     A normal click still opens the existing day-details modal (unchanged).
 *   - Keyboard: cells are focusable; focusing one opens the popover, blurring
 *     or Escape closes it.
 *   - Touch: a tap toggles the popover (a second tap, a tap outside or Escape
 *     closes it). Tapping a control inside the cell (Early Out / Regularise /
 *     Override) is left to that control.
 *
 * Only one popover is ever open. It is positioned so it never leaves the
 * viewport (flips above/below and clamps left/right).
 *
 * Content is built from the shared getEffectiveStatus() engine so the popover,
 * the dashboard and the admin sheet always agree. All times are IST.
 *
 * Usage from a render loop:
 *   DayPopover.bind(cellEl, {
 *     dateStr, rec, punch: true|false,
 *     statusLabel, chipClass, icon, detail
 *   });
 * and once at startup: DayPopover.init();
 */
(function () {
  "use strict";

  var OPEN_DELAY = 150;   // ms before a hover/focus opens the popover
  var CLOSE_DELAY = 120;  // ms grace before closing (lets the pointer cross gaps)

  var el = null;
  var current = null;
  var openTimer = null;
  var closeTimer = null;
  var isOpen = false;
  var lastPointerType = "mouse";
  var inited = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDateIST(dateStr) {
    try {
      var p = String(dateStr).split("-");
      var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return d.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric"
      });
    } catch (e) { return dateStr; }
  }

  function row(iconCls, label, val) {
    return '<div class="dp-row"><i class="' + iconCls + '"></i>' +
      '<span class="dp-k">' + esc(label) + '</span><b class="dp-v">' + esc(val) + '</b></div>';
  }

  function buildHtml(p) {
    var chip = p.chipClass || "badge-neutral";
    var head = '<div class="dp-head">' +
      '<span class="dp-date">' + esc(fmtDateIST(p.dateStr)) + '</span>' +
      '<span class="day-badge-pill ' + chip + '">' +
      (p.icon ? '<i class="fa-solid ' + p.icon + '"></i> ' : '') + esc(p.statusLabel || "") +
      '</span></div>';

    var eff = (p.punch && p.rec && typeof getEffectiveStatus === "function") ? getEffectiveStatus(p.rec) : null;
    if (!eff) {
      // Non-punch day (Absent / Not Marked / Weekend / Holiday / Leave / LoP):
      // status only, plus an optional one-line note.
      var note = p.detail ? '<div class="dp-note">' + esc(p.detail) + '</div>' : "";
      return head + note;
    }

    var inV = eff.checkIn || "\u2014";
    var outV = eff.checkOut || (eff.isOpen ? "Not punched out" : "\u2014");
    var workedV = eff.isOpen
      ? "\u2014 (in progress)"
      : (eff.workedHours > 0 && typeof formatMinutesHM === "function" ? formatMinutesHM(eff.workedHours * 60) : "\u2014");

    var body = '<div class="dp-rows">';
    body += row("fa-solid fa-right-to-bracket", "In", inV);
    body += row("fa-solid fa-right-from-bracket", "Out", outV);
    body += row("fa-regular fa-clock", "Worked", workedV);
    if (eff.late.isLate) {
      body += '<div class="dp-flag dp-late"><i class="fa-solid fa-stopwatch"></i> ' + esc(eff.late.label) + '</div>';
    } else {
      body += '<div class="dp-flag dp-ontime"><i class="fa-regular fa-circle-check"></i> On time</div>';
    }
    if (eff.short.isShort) {
      body += '<div class="dp-flag dp-short"><i class="fa-solid fa-arrow-down-long"></i> ' + esc(eff.short.label) + '</div>';
    }
    body += '</div>';

    if (eff.tags && eff.tags.length) {
      body += '<div class="dp-tags">' + eff.tags.map(function (t) {
        return '<span class="dp-tag">' + esc(t.label) + (t.reason ? ' &middot; ' + esc(t.reason) : '') + '</span>';
      }).join("") + '</div>';
    }
    return head + body;
  }

  function ensureEl() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "day-popover";
    el.id = "day-popover";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    // Keep the popover open while the pointer is inside it.
    el.addEventListener("pointerenter", function () { clearTimeout(closeTimer); });
    el.addEventListener("pointerleave", function () { scheduleHide(); });
    return el;
  }

  function position(cell) {
    var r = cell.getBoundingClientRect();
    var pw = el.offsetWidth, ph = el.offsetHeight;
    var gap = 8, m = 8, vw = window.innerWidth, vh = window.innerHeight;

    var top = r.bottom + gap, above = false;
    if (top + ph + m > vh) {
      var a = r.top - gap - ph;
      if (a >= m) { top = a; above = true; }
      else { top = Math.max(m, Math.min(top, vh - ph - m)); }
    }
    var left = r.left + r.width / 2 - pw / 2;
    if (left < m) left = m;
    if (left + pw > vw - m) left = Math.max(m, vw - pw - m);

    el.style.top = Math.round(top) + "px";
    el.style.left = Math.round(left) + "px";
    el.classList.toggle("pop-above", above);
  }

  function show(cell) {
    if (!cell || !cell.__pop) return;
    ensureEl();
    el.innerHTML = buildHtml(cell.__pop);
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
    position(cell);
    if (current && current !== cell) current.removeAttribute("aria-describedby");
    current = cell;
    cell.setAttribute("aria-describedby", "day-popover");
    isOpen = true;
  }

  function hide() {
    if (!isOpen) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
    if (current) current.removeAttribute("aria-describedby");
    current = null;
    isOpen = false;
  }

  function scheduleShow(cell) {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(function () { show(cell); }, OPEN_DELAY);
  }

  function scheduleHide() {
    clearTimeout(openTimer);
    closeTimer = setTimeout(hide, CLOSE_DELAY);
  }

  function toggle(cell) {
    if (current === cell && isOpen) hide();
    else { clearTimeout(openTimer); show(cell); }
  }

  function cellFrom(target) {
    return (target && target.closest) ? target.closest(".calendar-day-cell[data-day-pop]") : null;
  }

  function init() {
    if (inited || typeof document === "undefined") return;
    inited = true;

    // Track the most recent pointer type so we can tell touch taps from clicks.
    document.addEventListener("pointerdown", function (e) {
      lastPointerType = e.pointerType || "mouse";
    }, true);

    // Touch: a tap on a cell toggles the popover and does NOT open the modal.
    // Desktop clicks fall through to the existing day-details modal handler.
    document.addEventListener("click", function (e) {
      if (lastPointerType !== "touch") return;
      if (e.target.closest && e.target.closest(".day-popover")) return; // inside popover
      if (e.target.closest && e.target.closest("button")) { hide(); return; } // cell control
      var cell = cellFrom(e.target);
      if (cell && cell.__pop) {
        e.stopPropagation();
        e.preventDefault();
        toggle(cell);
        return;
      }
      hide(); // tapped elsewhere
    }, true);

    // Escape closes; scrolling or resizing repositions/closes to avoid drift.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { clearTimeout(openTimer); hide(); }
    });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
  }

  // Attach popover behaviour to a rendered day cell.
  function bind(cell, data) {
    if (!cell) return;
    cell.__pop = data;
    cell.setAttribute("data-day-pop", "1");
    if (!cell.hasAttribute("tabindex")) cell.setAttribute("tabindex", "0");
    var label = (data && data.statusLabel) ? (data.dateStr + ": " + data.statusLabel) : (data && data.dateStr) || "";
    if (label && !cell.getAttribute("aria-label")) cell.setAttribute("aria-label", label + ". Details available.");

    cell.addEventListener("pointerenter", function (e) {
      if ((e.pointerType || "mouse") !== "touch") scheduleShow(cell);
    });
    cell.addEventListener("pointerleave", function (e) {
      if ((e.pointerType || "mouse") !== "touch") scheduleHide();
    });
    cell.addEventListener("focus", function () { scheduleShow(cell); });
    cell.addEventListener("blur", function () { scheduleHide(); });
    cell.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(cell); }
      else if (e.key === "Escape") { hide(); }
    });
  }

  window.DayPopover = { init: init, bind: bind, close: hide };
})();

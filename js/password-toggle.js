/**
 * Show / Hide password toggle.
 * Attaches to every .toggle-password button and reveals/hides the password
 * input that shares its .input-icon-wrap. Passwords stay hidden by default.
 */
(function () {
  "use strict";

  function applyState(button, revealed) {
    var input = button.parentElement && button.parentElement.querySelector("input");
    if (!input) return;
    input.type = revealed ? "text" : "password";
    button.setAttribute("aria-pressed", revealed ? "true" : "false");
    button.setAttribute("aria-label", revealed ? "Hide password" : "Show password");
    var icon = button.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-eye", !revealed);
      icon.classList.toggle("fa-eye-slash", revealed);
    }
  }

  function handleClick(event) {
    event.preventDefault();
    var button = event.currentTarget;
    var input = button.parentElement && button.parentElement.querySelector("input");
    if (!input) return;
    applyState(button, input.type === "password");
  }

  function init() {
    var buttons = document.querySelectorAll(".toggle-password");
    buttons.forEach(function (button) {
      if (button.dataset.pwToggleBound === "true") return;
      button.dataset.pwToggleBound = "true";
      // Guarantee hidden-by-default even if markup changed.
      applyState(button, false);
      button.addEventListener("click", handleClick);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* Kanidm /pkg/style.js — original theme handling + OpenSphere Carbon login injector.
   Replaces the stock style.js (no SRI). Loaded on every Kanidm UI page, but the
   injector only acts when the login form (main#main.form-signin) is present. */

/* ---- original Kanidm theme handling (preserved verbatim) ---- */
function getPreferredTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function updateColourScheme() {
  const theme = getPreferredTheme();
  document.documentElement.setAttribute("data-bs-theme", theme);
}
updateColourScheme();
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", updateColourScheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateColourScheme);
document.body.addEventListener("htmx:afterOnLoad", updateColourScheme);

/* ---- OpenSphere Carbon login template injector ---- */
(function () {
  function osCarbonize() {
    // applies to every Kanidm auth form (login, credential reset, update_credentials)
    var main = document.querySelector("main.form-signin");
    if (!main) return;
    var isLogin = main.id === "main"; // vs id="cred-reset-form" etc.

    // keep auth pages light regardless of OS dark mode (Carbon template is light)
    document.documentElement.setAttribute("data-bs-theme", "light");

    var body = document.body;

    // rebrand / set headings ("Kanidm localhost" -> OpenSphere; keep subtitles)
    main.querySelectorAll("h1,h2,h3,h4").forEach(function (h) {
      if (h.dataset.osDone) return;
      h.dataset.osDone = "1";
      if (h.textContent.trim() === "Kanidm localhost") {
        h.textContent = isLogin ? "Log in to OpenSphere" : "OpenSphere";
        h.classList.add("os-h1");
      } else {
        h.classList.add("os-h2");
      }
    });

    // top nav
    if (!document.querySelector(".os-nav")) {
      var nav = document.createElement("header");
      nav.className = "os-nav";
      nav.innerHTML =
        '<div class="os-brand"><strong>OpenSphere</strong>&nbsp;Console</div>' +
        '<nav class="os-navlinks"><a href="#catalog">Catalog</a><a href="#estimator">Cost estimator</a><a href="#docs">Docs</a></nav>';
      body.insertBefore(nav, body.firstChild);
    }

    // right hero panel
    if (!document.querySelector(".os-hero")) {
      var hero = document.createElement("aside");
      hero.className = "os-hero";
      hero.innerHTML =
        '<div class="os-hero-in">' +
        '<p class="os-pre">Welcome to</p>' +
        '<h1 class="os-title">OpenSphere</h1>' +
        '<p class="os-sub">Sign in with an OpenSphere account after your Kanidm credentials have been enrolled.</p>' +
        "</div>";
      body.appendChild(hero);
    }

    var inner = main.querySelector(":scope > div") || main;

    // "Sign in with Kanidm" provider pill — login steps only (not the reset page)
    if (isLogin && !main.querySelector(".os-provider")) {
      var pill = document.createElement("div");
      pill.className = "os-provider";
      pill.innerHTML = "<span>Sign in with</span><strong>Kanidm</strong>";
      inner.insertBefore(pill, inner.firstChild);
    }

    // onboarding line + secondary actions only on the first (username) step
    var isFirstStep = !!main.querySelector("#username");
    if (isFirstStep && !main.querySelector(".os-onboard-line")) {
      var ob = document.createElement("p");
      ob.className = "os-onboard-line";
      ob.innerHTML = 'Don’t have an account? <a href="/ui/reset">Account onboarding</a>';
      var h = main.querySelector("h3");
      if (h && h.parentNode) h.parentNode.insertBefore(ob, h.nextSibling);
    }
    var form = main.querySelector("#login");
    if (isFirstStep && form && !form.querySelector(".os-secondary")) {
      var sec = document.createElement("div");
      sec.className = "os-secondary";
      sec.innerHTML =
        '<span class="os-or">or</span>' +
        '<a class="os-secbtn" href="/ui/reset">Use Kanidm reset token</a>' +
        '<a class="os-secbtn" href="/ui/reset">Set initial credentials</a>';
      form.appendChild(sec);
    }
  }

  function run() {
    try { osCarbonize(); } catch (e) { console.error("os carbonize", e); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
  // re-apply if Kanidm swaps the form via htmx (multi-step login)
  if (document.body) document.body.addEventListener("htmx:afterSwap", run);
})();

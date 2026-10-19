/* Generic survey engine. Everything about a study lives in survey.json.
   URL helpers (for testing only, never give these to participants):
     ?reset=1            forget this device's saved progress and condition
     ?force=PICK-FRESH   force a condition (factor values joined with "-")
     ?lang=ar            start in a language
     ?test=1             do not send data; show a CSV preview at the end            */
(function () {
  "use strict";
  var qs = new URLSearchParams(location.search);
  var app = document.getElementById("app");
  var bar = document.getElementById("bar");
  var cfg, state, STORE, screens, t0 = Date.now(), advTimer = null;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function tx(obj) { // pick text for current language
    if (obj == null) return "";
    if (typeof obj === "string") return obj;
    return obj[state.lang] || obj[cfg.defaultLanguage] || "";
  }
  function ui(k) { return tx(cfg.ui[k]); }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; } }
  function uid() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  /* ---------- conditions ---------- */
  function allCells() {
    var names = Object.keys(cfg.factors), cells = [[]];
    names.forEach(function (n) {
      var next = [];
      cells.forEach(function (c) { cfg.factors[n].forEach(function (v) { next.push(c.concat(v)); }); });
      cells = next;
    });
    return cells.map(function (c) { return c.join("|"); });
  }
  function factorValues(cell) {
    var names = Object.keys(cfg.factors), parts = cell.split("|"), o = {};
    names.forEach(function (n, i) { o[n] = parts[i]; });
    return o;
  }
  function fetchJson(url, opts, ms) {
    var ctl = ("AbortController" in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 8000);
    opts = opts || {};
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r.json(); },
      function (e) { clearTimeout(timer); throw e; });
  }
  function assign() {
    if (state.cell) return Promise.resolve();
    var cells = allCells();
    var forced = qs.get("force");
    if (forced) {
      var f = cells.filter(function (c) { return c.replace(/\|/g, "-").toLowerCase() === forced.toLowerCase(); })[0];
      if (f) { state.cell = f; state.assignedBy = "forced"; save(); return Promise.resolve(); }
    }
    var randomCell = function () {
      var buf = new Uint32Array(1); window.crypto.getRandomValues(buf);
      state.cell = cells[buf[0] % cells.length]; state.assignedBy = "random"; save();
    };
    if (!cfg.endpoint || qs.get("test")) { randomCell(); return Promise.resolve(); }
    var url = cfg.endpoint + "?action=assign&id=" + encodeURIComponent(state.id) +
      "&pending=" + encodeURIComponent(cfg.pendingMinutes || 45) +
      "&cells=" + encodeURIComponent(cells.join(","));
    return fetchJson(url, { method: "GET" }, 8000).then(function (r) {
      if (r && r.ok && cells.indexOf(r.cell) > -1) { state.cell = r.cell; state.assignedBy = "balanced"; save(); }
      else randomCell();
    }).catch(randomCell);
  }

  /* ---------- screens ---------- */
  function setLang(code) {
    var L = cfg.languages.filter(function (l) { return l.code === code; })[0] || cfg.languages[0];
    state.lang = L.code; save();
    document.documentElement.lang = L.code;
    document.documentElement.dir = L.dir;
    document.title = tx(cfg.title);
  }
  function progress() {
    var n = Math.max(1, screens.length - 1);
    bar.style.width = Math.min(100, Math.round(100 * Math.max(0, state.idx) / n)) + "%";
  }
  function langToggle() {
    if (cfg.languages.length < 2) return null;
    var other = cfg.languages.filter(function (l) { return l.code !== state.lang; })[0];
    return el("div", { style: "text-align:end;margin:-14px 0 14px" }, [
      el("button", { type: "button", class: "btn ghost", style: "padding:6px 14px;min-height:36px;font-size:.9rem",
        text: other.label, onclick: function () { setLang(other.code); render(); } })
    ]);
  }
  function stimulusNode(mode) {
    if (!mode || !state.cell) return null;
    var src = cfg.stimuli[state.cell]; if (!src) return null;
    var img = el("img", { src: src, alt: tx(cfg.stimulusAlt), decoding: "async" });
    if (mode === "large") return el("div", { class: "stimulus large" }, [img]);
    img.addEventListener("click", function () { openLightbox(src); });
    return el("div", { class: "stimulus small" }, [img, el("span", { text: ui("tapToEnlarge") })]);
  }
  function openLightbox(src) {
    var lb = document.getElementById("lightbox");
    lb.querySelector("img").src = src;
    var b = document.getElementById("lb-close"); b.textContent = ui("close");
    lb.hidden = false;
    lb.onclick = function () { lb.hidden = true; };
  }

  function render() {
    clearTimeout(advTimer);
    var s = screens[state.idx];
    app.innerHTML = "";
    window.scrollTo(0, 0);
    progress();
    t0 = Date.now();
    var box = el("section", { class: "screen" });
    var lt = langToggle(); if (lt) box.appendChild(lt);
    if (s.type === "end") return renderEnd(box, s);
    if (s.stimulus) { var st = stimulusNode(s.stimulus); if (st) box.appendChild(st); }
    if (s.type === "info") {
      box.appendChild(el("p", { class: "text", text: tx(s.text) }));
    } else {
      box.appendChild(el("h1", { class: "prompt", text: tx(s.prompt) }));
      if (s.type === "choice") box.appendChild(choiceNode(s));
      if (s.type === "scale") box.appendChild(scaleNode(s));
      if (s.type === "number") box.appendChild(numberNode(s));
    }
    var err = el("div", { class: "err", role: "alert" });
    box.appendChild(err);
    var back = state.idx > 0 ? el("button", { type: "button", class: "btn ghost", text: ui("back"), onclick: goBack }) : null;
    var next = el("button", { type: "button", class: "btn", id: "next",
      text: ui(s.button || "next"), onclick: function () { goNext(err); } });
    box.appendChild(el("div", { class: "nav" }, [back, next]));
    app.appendChild(box);
    if (s.type === "number") { var inp = box.querySelector("input"); if (inp && !inp.value) inp.focus({ preventScroll: true }); }
  }

  function answered(s) { return state.answers[s.id] !== undefined && state.answers[s.id] !== ""; }
  function choose(s, value, auto) {
    state.answers[s.id] = value; save();
    var all = app.querySelectorAll(".choice");
    Array.prototype.forEach.call(all, function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === String(value))); });
    var e = app.querySelector(".err"); if (e) e.textContent = "";
    if (auto) { clearTimeout(advTimer); advTimer = setTimeout(function () { goNext(e); }, 260); }
  }
  function choiceNode(s) {
    var wrap = el("div", { class: "choices", role: "group" });
    s.options.forEach(function (o) {
      var b = el("button", { type: "button", class: "choice", "data-v": o.value, text: tx(o.label),
        "aria-pressed": String(state.answers[s.id] === o.value), onclick: function () { choose(s, o.value, true); } });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function scaleNode(s) {
    var sc = cfg.scales[s.scale], wrap = el("div", { role: "group" });
    var row = el("div", { class: "scale" });
    for (var i = sc.min; i <= sc.max; i++) (function (v) {
      row.appendChild(el("button", { type: "button", class: "choice", "data-v": v, text: String(v),
        "aria-label": String(v), "aria-pressed": String(state.answers[s.id] === v),
        onclick: function () { choose(s, v, true); } }));
    })(i);
    wrap.appendChild(row);
    wrap.appendChild(el("div", { class: "scale-labels" }, [
      el("span", { text: "1 – " + tx(sc.minLabel) }), el("span", { style: "text-align:end", text: sc.max + " – " + tx(sc.maxLabel) })
    ]));
    return wrap;
  }
  function numberNode(s) {
    var inp = el("input", { type: "number", inputmode: "numeric", min: s.min, max: s.max, step: 1, "aria-label": tx(s.prompt) });
    if (state.answers[s.id] !== undefined) inp.value = state.answers[s.id];
    inp.addEventListener("input", function () {
      var v = inp.value === "" ? undefined : Number(inp.value);
      if (v === undefined) delete state.answers[s.id]; else state.answers[s.id] = v; save();
    });
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") goNext(app.querySelector(".err")); });
    return inp;
  }

  function spent(s) { state.timings[s.id] = (state.timings[s.id] || 0) + (Date.now() - t0); }
  function goBack() { clearTimeout(advTimer); spent(screens[state.idx]); if (state.idx > 0) { state.idx--; save(); render(); } }
  function goNext(err) {
    clearTimeout(advTimer);
    var s = screens[state.idx];
    if (s.required && !answered(s)) { if (err) err.textContent = ui("required"); return; }
    if (s.type === "number") {
      var v = state.answers[s.id];
      if (typeof v !== "number" || isNaN(v) || v < s.min || v > s.max || Math.floor(v) !== v) { if (err) err.textContent = ui("badNumber"); return; }
    }
    spent(s);
    if (s.endIf && state.answers[s.id] === s.endIf.value) return renderStop(s.endIf.message);
    var go = function () { state.idx++; save(); render(); };
    if (s.assignAfter) {
      var btn = document.getElementById("next"); if (btn) btn.disabled = true;
      app.querySelectorAll(".choice").forEach(function (b) { b.disabled = true; });
      assign().then(go); return;
    }
    go();
  }
  function renderStop(msg) {
    app.innerHTML = ""; bar.style.width = "100%";
    var box = el("section", { class: "screen" });
    var lt = langToggle(); if (lt) box.appendChild(lt);
    box.appendChild(el("p", { class: "text", text: tx(msg) }));
    app.appendChild(box);
  }

  /* ---------- finishing ---------- */
  function payload() {
    var fv = factorValues(state.cell || "|");
    var att = screens.filter(function (s) { return s.attentionCheck !== undefined; })[0];
    var o = {
      surveyId: cfg.id, id: state.id, cell: state.cell, assignedBy: state.assignedBy || "",
      lang: state.lang, startedAt: new Date(state.started).toISOString(), finishedAt: new Date().toISOString(),
      device: window.innerWidth < 700 ? "mobile" : "desktop",
      attentionPass: att ? (state.answers[att.id] === att.attentionCheck ? 1 : 0) : "",
      answers: state.answers, timings: state.timings, factors: fv
    };
    o.durationSec = Math.round((Date.now() - state.started) / 1000);
    return o;
  }
  function csvOf(p) {
    var head = ["surveyId", "id", "cell"].concat(Object.keys(p.factors), ["assignedBy", "lang", "device", "startedAt", "finishedAt", "durationSec", "attentionPass"]);
    var vals = [p.surveyId, p.id, p.cell].concat(Object.keys(p.factors).map(function (k) { return p.factors[k]; }),
      [p.assignedBy, p.lang, p.device, p.startedAt, p.finishedAt, p.durationSec, p.attentionPass]);
    screens.forEach(function (s) {
      if (s.type === "choice" || s.type === "scale" || s.type === "number") {
        head.push(s.id); vals.push(p.answers[s.id] === undefined ? "" : p.answers[s.id]);
        head.push(s.id + "_ms"); vals.push(p.timings[s.id] || "");
      }
    });
    var q = function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; };
    return head.map(q).join(",") + "\n" + vals.map(q).join(",");
  }
  function renderEnd(box, s) {
    bar.style.width = "100%";
    var testing = !cfg.endpoint || qs.get("test");
    var msg = el("p", { class: "text", text: state.saved ? tx(s.text) : ui("saving") });
    box.appendChild(msg);
    app.appendChild(box);
    if (state.saved) return finishedExtras(box, testing);
    var p = payload();
    if (testing) { state.saved = true; state.done = true; save(); msg.textContent = tx(s.text); return finishedExtras(box, true, p); }
    var attempt = function () {
      msg.textContent = ui("saving");
      var old = box.querySelector(".retry"); if (old) old.remove();
      fetchJson(cfg.endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(p) }, 15000)
        .then(function (r) {
          if (!r || !r.ok) throw new Error("rejected");
          state.saved = true; state.done = true; save(); msg.textContent = tx(s.text);
        })
        .catch(function () {
          msg.textContent = ui("saveFailed");
          box.appendChild(el("div", { class: "nav retry" }, [el("button", { type: "button", class: "btn", text: ui("retry"), onclick: attempt })]));
        });
    };
    attempt();
  }
  function finishedExtras(box, testing, p) {
    if (!testing) return;
    p = p || payload();
    var csv = csvOf(p);
    var t = el("div", { class: "test" }, [
      el("strong", { text: ui("testMode") }),
      el("pre", { text: csv }),
      el("button", { type: "button", class: "btn ghost", text: ui("downloadCsv"), onclick: function () {
        var a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "test-response.csv" });
        document.body.appendChild(a); a.click(); a.remove();
      } })
    ]);
    box.appendChild(t);
  }

  /* ---------- start ---------- */
  function languageScreen() {
    document.documentElement.dir = "ltr";
    app.innerHTML = ""; bar.style.width = "0";
    var box = el("section", { class: "screen" }, [
      el("h1", { class: "prompt", text: cfg.languages.map(function (l) { return cfg.ui.chooseLanguage[l.code]; }).join(" / ") })
    ]);
    var wrap = el("div", { class: "langs" });
    cfg.languages.forEach(function (l) {
      wrap.appendChild(el("button", { type: "button", class: "choice", text: l.label, onclick: function () { setLang(l.code); render(); } }));
    });
    box.appendChild(wrap); app.appendChild(box);
  }
  function boot(c) {
    cfg = c; screens = cfg.screens; STORE = "survey:" + cfg.id;
    if (qs.get("reset")) { try { localStorage.removeItem(STORE); } catch (e) {} }
    state = load();
    if (!state || state.surveyId !== cfg.id) {
      state = { surveyId: cfg.id, id: uid(), started: Date.now(), idx: 0, answers: {}, timings: {} };
    }
    var want = qs.get("lang");
    if (want && cfg.languages.some(function (l) { return l.code === want; })) state.lang = want;
    if (state.done && state.saved) {
      setLang(state.lang || cfg.defaultLanguage);
      app.innerHTML = ""; bar.style.width = "100%";
      return app.appendChild(el("p", { class: "text", text: ui("alreadyDone") }));
    }
    if (state.lang) { setLang(state.lang); render(); }
    else if (cfg.languages.length === 1) { setLang(cfg.languages[0].code); render(); }
    else languageScreen();
  }

  fetch("survey.json", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(boot)
    .catch(function () { app.innerHTML = "<p class='loading'>Could not load the survey. Please try again later.</p>"; });
})();

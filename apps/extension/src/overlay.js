/**
 * The extension's own UI on a POS/Admin page: a highlight box, a status bar, and a card.
 *
 * All three modes draw the same furniture — the recorder needs a box and a bar, probe
 * needs a box and a card, preview needs all of it — so there is one implementation and
 * not three. Everything lives inside a closed shadow root: POS stylesheets cannot restyle
 * this, and far more importantly, this cannot restyle POS.
 *
 * Classic script (content scripts cannot load ES modules). The document is injected so
 * the module can be driven by a fake one in tests.
 */

(function (root) {
  "use strict";

  var CSS = [
    ":host { all: initial; }",
    ".box {",
    "  position: fixed; pointer-events: none; z-index: 2147483646;",
    "  border: 2px solid #d92d20; border-radius: 3px;",
    "  background: rgba(217, 45, 32, 0.08); transition: all .05s linear;",
    "}",
    ".box.ok { border-color: #12b76a; background: rgba(18, 183, 106, 0.10); }",
    ".bar {",
    "  position: fixed; inset: auto 12px 12px 12px; z-index: 2147483647;",
    "  pointer-events: none; display: flex; gap: 10px; align-items: center;",
    "  padding: 10px 14px; border-radius: 8px; background: #1d2939; color: #fff;",
    '  font: 500 13px/1.4 system-ui, "Segoe UI", sans-serif;',
    "  box-shadow: 0 6px 24px rgba(0,0,0,.35);",
    "}",
    ".dot { width: 9px; height: 9px; border-radius: 50%; background: #d92d20; flex: none; }",
    ".count { background: #344054; border-radius: 999px; padding: 2px 9px; }",
    ".hint { opacity: .75; font-weight: 400; }",
    ".warn { color: #fda29b; font-weight: 600; }",
    ".card {",
    "  position: fixed; left: 50%; transform: translateX(-50%); width: min(420px, calc(100vw - 32px));",
    "  z-index: 2147483647; background: #fff; color: #101828; border-radius: 10px;",
    "  padding: 14px 16px; box-shadow: 0 12px 40px rgba(16,24,40,.28);",
    '  font: 400 13px/1.5 system-ui, "Segoe UI", sans-serif; border: 1px solid #d0d5dd;',
    "}",
    ".card.bottom { bottom: 16px; }",
    ".card.top { top: 16px; }",
    ".card h4 { margin: 0 0 4px; font-size: 14px; }",
    ".card .meta { color: #667085; font-size: 12px; margin-bottom: 8px; }",
    ".card .body { white-space: pre-wrap; margin-bottom: 10px; }",
    ".card .body:empty { display: none; }",
    ".card .note { border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px; }",
    ".card .note.bad { background: #fef3f2; color: #b42318; }",
    ".card .note.good { background: #ecfdf3; color: #027a48; }",
    ".card .note:empty { display: none; }",
    ".row { display: flex; gap: 8px; flex-wrap: wrap; }",
    ".btn {",
    "  font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer;",
    "  border: 1px solid #d0d5dd; background: #fff; color: #101828;",
    "}",
    ".btn.primary { background: #1570ef; border-color: #1570ef; color: #fff; }",
    ".btn[disabled] { opacity: .45; cursor: not-allowed; }",
  ].join("\n");

  function createOverlay(doc) {
    var host = doc.createElement("div");
    host.id = "circa-tooltip-overlay";
    var shadow = host.attachShadow({ mode: "closed" });

    var style = doc.createElement("style");
    style.textContent = CSS;

    var box = doc.createElement("div");
    box.className = "box";
    box.style.display = "none";

    var bar = doc.createElement("div");
    bar.className = "bar";
    bar.style.display = "none";
    bar.innerHTML =
      '<span class="dot"></span><span class="label"></span>' +
      '<span class="count"></span><span class="hint"></span>';

    var card = doc.createElement("div");
    card.className = "card bottom";
    card.style.display = "none";
    card.innerHTML =
      '<h4 class="title"></h4><div class="meta"></div><div class="body"></div>' +
      '<div class="note"></div><div class="row actions"></div>';

    shadow.append(style, box, bar, card);
    (doc.body || doc.documentElement).appendChild(host);

    var parts = {
      label: bar.querySelector(".label"),
      count: bar.querySelector(".count"),
      hint: bar.querySelector(".hint"),
      title: card.querySelector(".title"),
      meta: card.querySelector(".meta"),
      body: card.querySelector(".body"),
      note: card.querySelector(".note"),
      actions: card.querySelector(".actions"),
    };

    /** Rect of the last highlighted element, so the card can dodge it. */
    var lastRect = null;

    return {
      host: host,

      contains: function (node) {
        return node === host || host.contains(node);
      },

      /** Draw the box over `el`, or hide it when there is nothing to point at. */
      highlight: function (el, tone) {
        if (!el || typeof el.getBoundingClientRect !== "function") return this.hideBox();
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return this.hideBox();
        lastRect = r;
        box.className = tone === "ok" ? "box ok" : "box";
        box.style.display = "block";
        box.style.top = r.top - 2 + "px";
        box.style.left = r.left - 2 + "px";
        box.style.width = r.width + "px";
        box.style.height = r.height + "px";
      },

      hideBox: function () {
        lastRect = null;
        box.style.display = "none";
      },

      setBar: function (info) {
        bar.style.display = "flex";
        parts.label.textContent = info.label || "";
        parts.count.textContent = info.count || "";
        parts.hint.className = info.tone === "warn" ? "warn" : "hint";
        parts.hint.textContent = info.hint || "";
      },

      hideBar: function () {
        bar.style.display = "none";
      },

      /**
       * Show the card. `onAction(id)` fires for whichever button was pressed.
       *
       * The card moves to the top of the viewport when the highlighted element is in the
       * lower half, so the thing being explained is never hidden by the explanation.
       */
      showCard: function (info, onAction) {
        var lower = lastRect && typeof innerHeight === "number" ? lastRect.top > innerHeight / 2 : false;
        card.className = "card " + (lower ? "top" : "bottom");
        card.style.display = "block";
        parts.title.textContent = info.title || "";
        parts.meta.textContent = info.meta || "";
        parts.body.textContent = info.body || "";
        parts.note.className = "note" + (info.noteTone ? " " + info.noteTone : "");
        parts.note.textContent = info.note || "";

        parts.actions.innerHTML = "";
        var actions = info.actions || [];
        for (var i = 0; i < actions.length; i++) {
          (function (action) {
            var button = doc.createElement("button");
            button.className = "btn" + (action.primary ? " primary" : "");
            button.textContent = action.label;
            if (action.disabled) button.setAttribute("disabled", "disabled");
            button.addEventListener("click", function (ev) {
              ev.preventDefault();
              ev.stopPropagation();
              if (!action.disabled && onAction) onAction(action.id);
            });
            parts.actions.appendChild(button);
          })(actions[i]);
        }
      },

      hideCard: function () {
        card.style.display = "none";
      },

      destroy: function () {
        if (host.parentNode) host.parentNode.removeChild(host);
      },
    };
  }

  root.TG_OVERLAY = Object.freeze({ createOverlay: createOverlay });
})(typeof globalThis !== "undefined" ? globalThis : self);

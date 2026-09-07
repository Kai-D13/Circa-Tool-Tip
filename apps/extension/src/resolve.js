/**
 * Step -> the element it points at. ONE definition, used by probe, by preview, and by
 * the tour runtime in Batch 3.
 *
 * This is the piece the v2.4.9 extension had two of: `resolveTarget` in content.js and a
 * second, drifting copy of the same idea. Probing a selector and running a guide have to
 * agree completely, or the probe becomes a lie — it would report "khớp 1 element" for a
 * step the runtime then fails to find.
 *
 * The rules come from the audit, not from taste:
 *
 *   - A selector that matches several elements is NOT a failure. `#basic-button` matches
 *     nine elements on POS, and "Cài Đặt" picks exactly one of them. Text is what makes
 *     an ambiguous selector usable, so it is tried before the candidate is abandoned.
 *   - With intent "exact" and a text anchor, a single match whose text DISAGREES is held
 *     back rather than returned. The page has changed under the guide; another candidate
 *     may still be right, and if none is, the caller is told the text did not match
 *     instead of being silently pointed at the wrong element.
 *   - Hidden elements lose to visible ones. A duplicated id is usually one live control
 *     and several in closed menus.
 *
 * Classic script (content scripts cannot load ES modules). Everything touching the
 * document arrives through the injected `api`, so this is unit-testable.
 */

(function (root) {
  "use strict";

  /** @typedef {{queryAll(sel:string):any[], textOf(el:any):string, isVisible(el:any):boolean}} ResolveApi */

  function normalize(text) {
    var schema = root.GUIDE_SCHEMA;
    if (!schema || typeof schema.normalizeText !== "function") {
      throw new Error("GUIDE_SCHEMA.normalizeText chưa được nạp — không thể so khớp text.");
    }
    return schema.normalizeText(text);
  }

  function selectorsOf(step) {
    var raw = (step && step.selectors) || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = String(raw[i] || "").trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }

  function safeQuery(api, selector) {
    try {
      return api.queryAll(selector) || [];
    } catch (err) {
      // An invalid selector is a data problem, not a crash. The probe reports it.
      return null;
    }
  }

  /** Visible matches when there are any, otherwise everything the selector found. */
  function preferVisible(api, elements) {
    var visible = [];
    for (var i = 0; i < elements.length; i++) {
      if (api.isVisible(elements[i])) visible.push(elements[i]);
    }
    return visible.length ? visible : elements;
  }

  /** The one `via` that means "found something, but do not use it". */
  var MISMATCH = "selector-text-mismatch";

  function hit(element, selector, index, via, count) {
    return { element: element, selector: selector, selectorIndex: index, via: via, count: count };
  }

  /**
   * May this resolution be acted on?
   *
   * `resolveTarget` returns the text-mismatched element on purpose, because the probe has
   * to be able to SAY what it found. But found is not the same as usable: the page changed
   * under the guide, and pointing a tour — let alone an auto-click — at that element is
   * how the wrong button gets pressed.
   *
   * Every caller decides with this one function. Probe, preview and the Batch 3 runtime
   * disagreeing about it is exactly the drift this module exists to prevent.
   */
  function isActionableResolution(target) {
    return !!(target && target.element && target.via !== MISMATCH);
  }

  /**
   * @param {object} step   a draft or release step
   * @param {ResolveApi} api
   * @returns {{element:any, selector:string, selectorIndex:number, via:string, count:number}|null}
   */
  function resolveTarget(step, api) {
    var wanted = normalize((step && step.matchText) || "");
    var intent = (step && step.intent) || "exact";
    var selectors = selectorsOf(step);

    /** A single match whose text disagreed. Used only if nothing better turns up. */
    var mismatched = null;

    for (var i = 0; i < selectors.length; i++) {
      var found = safeQuery(api, selectors[i]);
      if (found === null || !found.length) continue;

      var pool = preferVisible(api, found);

      if (pool.length === 1) {
        if (!wanted || intent !== "exact" || normalize(api.textOf(pool[0])) === wanted) {
          return hit(pool[0], selectors[i], i, "selector", found.length);
        }
        if (!mismatched) mismatched = hit(pool[0], selectors[i], i, MISMATCH, found.length);
        continue;
      }

      if (wanted) {
        var byText = [];
        for (var j = 0; j < pool.length; j++) {
          if (normalize(api.textOf(pool[j])) === wanted) byText.push(pool[j]);
        }
        if (byText.length === 1) return hit(byText[0], selectors[i], i, "text", found.length);
      }

      if (intent === "first_item") return hit(pool[0], selectors[i], i, "first_item", found.length);
      // Several matches and nothing to tell them apart: try the next candidate rather
      // than guessing. Guessing here is how a business auto-click hits the wrong row.
    }

    // Last resort: the text anchor alone, scoped to the tag the step recorded. This is
    // what saves a guide after a redesign moved the element but kept its label.
    if (wanted) {
      var scope = String((step && step.tag) || "").trim() || "*";
      var all = safeQuery(api, scope);
      if (all && all.length) {
        var pool2 = preferVisible(api, all);
        var matches = [];
        for (var k = 0; k < pool2.length; k++) {
          if (normalize(api.textOf(pool2[k])) === wanted) matches.push(pool2[k]);
        }
        if (matches.length === 1) return hit(matches[0], scope, -1, "text-fallback", matches.length);
      }
    }

    return mismatched;
  }

  /**
   * Everything the Portal needs to show about a step's selectors: how many elements each
   * one finds, whether the text anchor agrees, and which candidate the runtime would
   * actually use.
   *
   * `count` is the raw number of matches — the number a person can reproduce in the
   * Console with `document.querySelectorAll(...)`. Filtering it by visibility first would
   * make the report disagree with the browser.
   */
  function probeStep(step, api) {
    var wanted = normalize((step && step.matchText) || "");
    var selectors = selectorsOf(step);
    var candidates = [];

    for (var i = 0; i < selectors.length; i++) {
      var found = safeQuery(api, selectors[i]);
      if (found === null) {
        candidates.push({ selector: selectors[i], count: 0, textMatches: 0, invalid: true });
        continue;
      }
      var textMatches = 0;
      if (wanted) {
        for (var j = 0; j < found.length; j++) {
          if (normalize(api.textOf(found[j])) === wanted) textMatches++;
        }
      }
      candidates.push({ selector: selectors[i], count: found.length, textMatches: textMatches, invalid: false });
    }

    var target = resolveTarget(step, api);

    return {
      ok: isActionableResolution(target),
      candidates: candidates,
      matchText: wanted,
      resolved: target
        ? { selector: target.selector, selectorIndex: target.selectorIndex, via: target.via, count: target.count }
        : null,
      reason: reasonFor(target, candidates, wanted, selectors.length),
    };
  }

  function reasonFor(target, candidates, wanted, selectorCount) {
    if (target && target.via === MISMATCH) {
      return "Selector khớp đúng 1 element nhưng text trên trang đã khác — trang có thể đã đổi.";
    }
    if (target) {
      if (target.via === "text") return "Selector khớp nhiều element, text đã lọc ra đúng 1.";
      if (target.via === "first_item") return "Selector khớp nhiều element, intent first_item lấy phần tử đầu.";
      if (target.via === "text-fallback") return "Không selector nào dùng được; tìm lại bằng text.";
      return "";
    }
    if (!selectorCount) return "Bước này chưa có selector nào.";
    var anyInvalid = candidates.some(function (c) {
      return c.invalid;
    });
    if (anyInvalid) return "Có selector sai cú pháp — trình duyệt không đọc được.";
    var anyFound = candidates.some(function (c) {
      return c.count > 0;
    });
    if (!anyFound) return "Không selector nào tìm thấy element trên trang này.";
    return wanted
      ? "Selector khớp nhiều element và không có element nào đúng text — không xác định được mục tiêu."
      : "Selector khớp nhiều element và bước không có text để lọc — hãy chọn lại phần tử.";
  }

  root.TG_RESOLVE = Object.freeze({
    MISMATCH: MISMATCH,
    isActionableResolution: isActionableResolution,
    selectorsOf: selectorsOf,
    resolveTarget: resolveTarget,
    probeStep: probeStep,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);

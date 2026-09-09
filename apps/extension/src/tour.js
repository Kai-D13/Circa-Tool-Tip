/**
 * What each action MEANS at runtime, and when the extension is allowed to press a button
 * on somebody's behalf.
 *
 * This is the highest-consequence file in the extension. 360 of the 409 steps in the
 * legacy corpus auto-click, 128 of them have no usable text anchor, and 72 are pure
 * structural selectors — so "resolve something and click it" is not a plan, it is how a
 * guide presses the wrong button in a real shop. Every rule here is a refusal.
 *
 * The resolver is NOT reimplemented: `resolveTarget` and `isActionableResolution` come
 * from resolve.js, the same functions the selector probe and the draft preview use. If
 * the probe says a step resolves, the runtime resolves it the same way; if the probe says
 * it does not, the runtime refuses it the same way.
 *
 * Classic script (content scripts cannot load ES modules), pure apart from the injected
 * DOM helpers, so the whole decision table is unit-testable.
 */

(function (root) {
  "use strict";

  /**
   * How the runtime treats each action.
   *
   *   clicks    — the runtime presses the element (either for the user, or after Tiếp)
   *   auto      — the runtime presses it WITHOUT the user asking
   *   waitsUrl  — the step completes only once the browser has arrived somewhere else
   *   needsTarget — a step with no resolvable element cannot proceed
   */
  var BEHAVIOUR = {
    highlight: { clicks: false, auto: false, waitsUrl: false, needsTarget: true },
    manual: { clicks: false, auto: false, waitsUrl: false, needsTarget: false },
    wait_element: { clicks: false, auto: false, waitsUrl: false, needsTarget: true },
    click_next: { clicks: true, auto: false, waitsUrl: false, needsTarget: true },
    click_wait_url: { clicks: true, auto: false, waitsUrl: true, needsTarget: true },
    auto_click_next: { clicks: true, auto: true, waitsUrl: false, needsTarget: true },
    auto_click_wait_url: { clicks: true, auto: true, waitsUrl: true, needsTarget: true },
  };

  function behaviourOf(actionType) {
    // An unknown action degrades to highlight — never to a click. A guide written against
    // a newer schema must be inert here, not adventurous.
    return BEHAVIOUR[String(actionType || "")] || BEHAVIOUR.highlight;
  }

  function isHandledAction(actionType) {
    return Object.prototype.hasOwnProperty.call(BEHAVIOUR, String(actionType || ""));
  }

  /** What the URL matcher needs: the site origins, and which site the guide belongs to. */
  function contextOf(session) {
    return { sites: (session && session.sites) || {}, guideSite: session && session.guide && session.guide.site };
  }

  function stepAt(session, index) {
    var steps = (session && session.guide && session.guide.steps) || [];
    return steps[index] || null;
  }

  function stepCount(session) {
    return ((session && session.guide && session.guide.steps) || []).length;
  }

  function isLastStep(session, index) {
    return index >= stepCount(session) - 1;
  }

  /**
   * Where a wait-url step is trying to get to.
   *
   * `expectedUrl` is empty on all 409 legacy steps, so reading it alone would hang every
   * waiting step — `resolveExpectedUrl` falls back to the next step's pattern, which is
   * what v4 actually did.
   */
  function expectedUrlFor(session, index, schema) {
    var steps = (session && session.guide && session.guide.steps) || [];
    return schema.resolveExpectedUrl(steps, index);
  }

  function expectedSiteFor(session, index) {
    var next = stepAt(session, index + 1);
    var current = stepAt(session, index);
    var override = current && current.action && current.action.expectedSiteOverride;
    return override || (next && next.site) || (current && current.site) || null;
  }

  /* ------------------------------------------------------------- the click gate */

  /**
   * May the runtime press this element by itself?
   *
   * Deliberately stricter than "the step resolved". A user-driven click is the user's
   * decision; an auto-click is ours, and the cost of being wrong is a real order placed
   * in a real shop.
   *
   * @param {object|null} target result of TG_RESOLVE.resolveTarget
   * @param {{isVisible(el):boolean, isEnabled(el):boolean}} api
   */
  function autoClickGate(target, api) {
    var resolve = root.TG_RESOLVE;
    if (!resolve || typeof resolve.isActionableResolution !== "function") {
      throw new Error("TG_RESOLVE chưa được nạp — không thể quyết định có được tự bấm hay không.");
    }

    if (!target || !target.element) {
      return { ok: false, reason: "Không tìm thấy phần tử của bước này trên trang." };
    }
    if (!resolve.isActionableResolution(target)) {
      // The one case resolveTarget returns on purpose but nothing may act on: the
      // selector found exactly one element and its text has changed underneath.
      return { ok: false, reason: "Tìm thấy phần tử nhưng TEXT trên trang đã khác — không tự bấm." };
    }
    if (target.via === "first_item") {
      // "Take the first of several" is a reading aid, never a licence to press one.
      return { ok: false, reason: "Selector khớp nhiều phần tử, chỉ chọn được cái đầu — không tự bấm." };
    }
    if (!api.isVisible(target.element)) {
      return { ok: false, reason: "Phần tử đang ẩn — không tự bấm." };
    }
    if (!api.isEnabled(target.element)) {
      return { ok: false, reason: "Phần tử đang bị vô hiệu hoá — không tự bấm." };
    }
    return { ok: true, reason: "" };
  }

  /**
   * May the runtime advance past this step at all?
   *
   * A step that needs a target and has none stalls with a visible error and a retry
   * button. Silently skipping it would walk the operator through a guide that is missing
   * the thing it was written to teach.
   */
  function stepReadiness(step, target, api) {
    var behaviour = behaviourOf(step && step.action && step.action.type);
    if (!behaviour.needsTarget) return { ok: true, reason: "" };
    if (!target || !target.element) {
      return { ok: false, reason: "Không tìm thấy phần tử của bước này trên trang." };
    }
    if (behaviour.auto) return autoClickGate(target, api);

    var resolve = root.TG_RESOLVE;
    if (!resolve.isActionableResolution(target)) {
      return { ok: false, reason: "Tìm thấy phần tử nhưng TEXT trên trang đã khác." };
    }

    // Visibility and enabled-ness are required for ANY step the runtime clicks, not just
    // the automatic ones. `.click()` on a disabled button does not necessarily throw — it
    // simply does nothing — and the tour would then move to the step after an action that
    // never happened. `first_item` stays allowed here: choosing among several is the
    // user's call when the user is the one pressing Tiếp.
    if (behaviour.clicks) {
      if (!api.isVisible(target.element)) {
        return { ok: false, reason: "Phần tử đang ẩn — không bấm được." };
      }
      if (!api.isEnabled(target.element)) {
        return { ok: false, reason: "Phần tử đang bị vô hiệu hoá — không bấm được." };
      }
    }
    return { ok: true, reason: "" };
  }

  /* ---------------------------------------------------------------- navigation */

  /**
   * The `pending` record written BEFORE a click that may navigate.
   *
   * Written first, always. The page is about to be thrown away, and a step recorded only
   * after the click would be lost exactly when the guide was working.
   */
  function pendingFor(session, index, schema) {
    return {
      fromIndex: index,
      nextIndex: index + 1,
      expectedSite: expectedSiteFor(session, index),
      expectedUrl: expectedUrlFor(session, index, schema),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * After a navigation: has the browser arrived where the pending step was aiming?
   *
   * Matched against the destination RECORDED IN `pending`, not against whatever step now
   * sits at `nextIndex`. Three things break when it is read from the next step instead:
   * an explicit `action.expectedUrl` is ignored, `expectedSiteOverride` stops deciding
   * anything, and a wait-url on the LAST step can never complete because there is no next
   * step to read. The destination was already computed once, at the moment the click was
   * about to happen; that is the answer, and it is the one that was persisted.
   *
   * Still the shared matcher, so `/don-hang` keeps accepting `/don-hang?tab=2`.
   */
  function pendingArrived(session, loc, schema) {
    var pending = session && session.pending;
    if (!pending || !pending.expectedUrl) return false;
    // A step-shaped probe: `stepSite` reads `.site` first, so expectedSite decides, and a
    // null one falls through to the guide's own site via the context.
    var destination = {
      site: pending.expectedSite || undefined,
      urlPattern: pending.expectedUrl,
      navigationUrl: pending.expectedUrl,
    };
    return schema.stepMatchesLocation(destination, loc, contextOf(session));
  }

  /** Arriving at a pending whose next index is past the end means the tour is done. */
  function pendingCompletesTour(session) {
    var pending = session && session.pending;
    return !!pending && pending.nextIndex >= stepCount(session);
  }

  /** Is the browser already where this step lives? */
  function stepMatchesHere(session, index, loc, schema) {
    var step = stepAt(session, index);
    if (!step) return false;
    return schema.stepMatchesLocation(step, loc, contextOf(session));
  }

  /** Absolute URL for a step, resolved against ITS OWN site — POS steps never open on Admin. */
  function urlForStep(session, index, schema) {
    var step = stepAt(session, index);
    if (!step) return "";
    return schema.resolveStepUrl(step, contextOf(session));
  }

  /**
   * Should the runtime navigate to reach this step, and is it allowed to?
   *
   * `navGuard` remembers the URL the runtime last navigated to. Arriving somewhere that
   * still does not match — a login screen on the way to Admin, most often — must not
   * trigger the same navigation again, or POS and Admin bounce between each other
   * forever.
   */
  function navigationDecision(session, index, loc, schema) {
    if (stepMatchesHere(session, index, loc, schema)) return { action: "render" };

    var url = urlForStep(session, index, schema);
    if (!url) return { action: "stall", reason: "Bước này dùng URL động nên không mở thẳng được." };

    var guard = session.navGuard;
    if (guard && guard.url === url) {
      // We already sent the browser here and it did not arrive. Something is in the way.
      return {
        action: "wait",
        url: url,
        reason: "Đã chuyển tới trang của bước nhưng chưa tới nơi — có thể đang ở màn hình đăng nhập.",
      };
    }
    return { action: "navigate", url: url };
  }

  root.TG_TOUR = Object.freeze({
    BEHAVIOUR: BEHAVIOUR,
    behaviourOf: behaviourOf,
    contextOf: contextOf,
    isHandledAction: isHandledAction,
    stepAt: stepAt,
    stepCount: stepCount,
    isLastStep: isLastStep,
    expectedUrlFor: expectedUrlFor,
    expectedSiteFor: expectedSiteFor,
    autoClickGate: autoClickGate,
    stepReadiness: stepReadiness,
    pendingFor: pendingFor,
    pendingArrived: pendingArrived,
    pendingCompletesTour: pendingCompletesTour,
    stepMatchesHere: stepMatchesHere,
    urlForStep: urlForStep,
    navigationDecision: navigationDecision,
  });
})(typeof globalThis !== "undefined" ? globalThis : self);

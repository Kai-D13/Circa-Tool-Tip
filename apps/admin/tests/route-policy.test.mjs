import test from "node:test";
import assert from "node:assert/strict";

import { HOME_PATH, LOGIN_PATH, isPublicPath, resolveRouteAction } from "../lib/auth/route-policy.ts";

test("an anonymous visitor is sent to login from any protected page", () => {
  assert.equal(resolveRouteAction("/guides", false), "redirect-login");
  assert.equal(resolveRouteAction("/guides/triage", false), "redirect-login");
  assert.equal(resolveRouteAction("/", false), "redirect-login");
});

test("public pages stay reachable without a session", () => {
  assert.equal(resolveRouteAction("/login", false), "allow");
  assert.equal(resolveRouteAction("/unauthorized", false), "allow");
  assert.ok(isPublicPath("/login"));
  assert.ok(!isPublicPath("/loginx"));
});

test("a signed-in user is bounced away from the login page", () => {
  assert.equal(resolveRouteAction("/login", true), "redirect-home");
  assert.equal(resolveRouteAction("/guides", true), "allow");
});

test("sign-out is always reachable", () => {
  assert.equal(resolveRouteAction("/auth/signout", false), "allow");
  assert.equal(resolveRouteAction("/auth/signout", true), "allow");
});

test("paths are what the proxy redirects to", () => {
  assert.equal(LOGIN_PATH, "/login");
  assert.equal(HOME_PATH, "/guides");
});

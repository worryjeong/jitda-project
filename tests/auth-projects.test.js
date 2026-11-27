"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("authentication, owner-scoped project CRUD, and persistence", { timeout: 30_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-auth-test-"));
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(temporaryRoot, "server.js"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let serverOutput = "";

  async function startServer() {
    child = spawn(process.execPath, ["server.js"], {
      cwd: temporaryRoot,
      env: { PATH: process.env.PATH || "", PORT: String(port), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test server stopped: ${serverOutput}`);
      try {
        const response = await fetch(`${origin}/api/auth/me`);
        if (response.ok) return;
      } catch {
        // The listener is still starting.
      }
      await delay(40);
    }
    throw new Error(`Test server did not start: ${serverOutput}`);
  }

  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }

  async function request(route, { method = "GET", body, cookie = "", csrf = "", headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (method !== "GET") requestHeaders.origin = origin;
    if (cookie) requestHeaders.cookie = cookie;
    if (csrf) requestHeaders["x-csrf-token"] = csrf;
    let requestBody = body;
    if (body !== undefined && !(body instanceof Blob)) {
      requestHeaders["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
    const response = await fetch(`${origin}${route}`, { method, headers: requestHeaders, body: requestBody });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Keep empty error payloads available to the assertions below.
    }
    return {
      response,
      payload,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie,
    };
  }

  await startServer();
  try {
    assert.equal((await request("/api/projects")).response.status, 401, "project data requires a session");
    assert.equal((await request("/api/analyze", { method: "POST", body: {} })).response.status, 401);
    assert.equal((await request("/api/compare", { method: "POST", body: {} })).response.status, 401);
    assert.equal((await request("/api/transcribe", { method: "POST", body: new Blob(["audio"]) })).response.status, 401);

    const shortPassword = await request("/api/auth/register", {
      method: "POST",
      body: { username: "alpha_user", password: "123456", passwordConfirm: "123456" },
    });
    assert.equal(shortPassword.response.status, 400, "six-character passwords are rejected");

    const registered = await request("/api/auth/register", {
      method: "POST",
      body: { username: "alpha_user", password: "1234567", passwordConfirm: "1234567" },
    });
    assert.equal(registered.response.status, 201, "seven-character passwords are accepted");
    const alphaCookie = registered.cookie;
    const alphaCsrf = registered.payload.csrfToken;
    assert.ok(alphaCookie && alphaCsrf);

    const unconfirmedImport = await request("/api/projects/import-legacy", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { confirmOwnership: false, projects: [] },
    });
    assert.equal(unconfirmedImport.response.status, 400);
    const legacyImport = await request("/api/projects/import-legacy", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        confirmOwnership: true,
        projects: [{ id: "legacy-alpha", name: "이전 프로젝트", client: "테스트 고객", isSample: false }],
      },
    });
    assert.equal(legacyImport.payload.importedCount, 1);
    const repeatedImport = await request("/api/projects/import-legacy", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        confirmOwnership: true,
        projects: [{ id: "legacy-alpha", name: "이전 프로젝트", client: "테스트 고객", isSample: false }],
      },
    });
    assert.equal(repeatedImport.payload.alreadyCompleted, true, "legacy import runs once per account");

    const duplicate = await request("/api/auth/register", {
      method: "POST",
      body: { username: "alpha_user", password: "another7", passwordConfirm: "another7" },
    });
    assert.equal(duplicate.response.status, 409, "duplicate usernames are rejected");

    const missingCsrf = await request("/api/projects", {
      method: "POST",
      cookie: alphaCookie,
      body: { project: { id: "csrf-check", name: "검증", client: "테스트" } },
    });
    assert.equal(missingCsrf.response.status, 403, "state-changing requests require CSRF validation");
    for (const route of ["/api/analyze", "/api/compare", "/api/transcribe"]) {
      const protectedWithoutCsrf = await request(route, {
        method: "POST",
        cookie: alphaCookie,
        body: route.endsWith("transcribe") ? new Blob(["audio"]) : {},
      });
      assert.equal(protectedWithoutCsrf.response.status, 403, `${route} requires CSRF validation`);
    }

    const created = await request("/api/projects", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { project: { id: "project-alpha", name: "알파 프로젝트", client: "테스트 고객", summary: "처음 저장" } },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.project.serverVersion, 1);

    const updated = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        expectedVersion: 1,
        project: { ...created.payload.project, summary: "수정 저장" },
      },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.project.serverVersion, 2);

    const conflict = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        expectedVersion: 1,
        project: { ...created.payload.project, summary: "덮어쓰면 안 됨" },
      },
    });
    assert.equal(conflict.response.status, 409, "stale versions cannot overwrite newer project data");

    const rejectedSave = await request("/api/projects", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        project: {
          id: "too-large",
          name: "너무 큰 프로젝트",
          client: "테스트 고객",
          summary: "x".repeat(5 * 1024 * 1024),
        },
      },
    });
    assert.equal(rejectedSave.response.status, 413, "oversized projects are rejected without a partial save");

    const secondUser = await request("/api/auth/register", {
      method: "POST",
      body: { username: "beta_user", password: "another7", passwordConfirm: "another7" },
    });
    assert.equal(secondUser.response.status, 201);
    const betaCookie = secondUser.cookie;
    const betaCsrf = secondUser.payload.csrfToken;

    const crossAccountLegacyImport = await request("/api/projects/import-legacy", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: {
        confirmOwnership: true,
        projects: [{ id: "legacy-alpha", name: "이전 프로젝트", client: "테스트 고객", isSample: false }],
      },
    });
    assert.equal(crossAccountLegacyImport.payload.importedCount, 0, "legacy projects already owned by another account are not copied");
    assert.equal(crossAccountLegacyImport.payload.skippedCount, 1);

    const betaProjects = await request("/api/projects", { cookie: betaCookie });
    assert.equal(betaProjects.payload.projects.length, 0, "accounts see only their own projects");
    const crossAccountRead = await request("/api/projects/project-alpha", { cookie: betaCookie });
    assert.equal(crossAccountRead.response.status, 404);
    const crossAccountWrite = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { expectedVersion: 2, project: updated.payload.project },
    });
    assert.equal(crossAccountWrite.response.status, 404);

    const logout = await request("/api/auth/logout", { method: "POST", cookie: alphaCookie, csrf: alphaCsrf, body: {} });
    assert.equal(logout.response.status, 200);
    assert.equal((await request("/api/projects", { cookie: alphaCookie })).response.status, 401);

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { username: "alpha_user", password: "1234567" },
    });
    assert.equal(login.response.status, 200);
    const alphaCookieAfterLogin = login.cookie;
    const alphaCsrfAfterLogin = login.payload.csrfToken;

    await stopServer();
    await startServer();
    const persisted = await request("/api/projects", { cookie: alphaCookieAfterLogin });
    assert.equal(persisted.response.status, 200, "sessions and projects survive a server restart");
    assert.equal(persisted.payload.projects.length, 2);
    const persistedAlpha = persisted.payload.projects.find((project) => project.id === "project-alpha");
    assert.equal(persistedAlpha.summary, "수정 저장");
    assert.equal(persistedAlpha.serverVersion, 2);
    assert.ok(persisted.payload.projects.some((project) => project.id === "legacy-alpha"));

    const expiredSessionDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "users.sqlite"));
    expiredSessionDb.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), login.payload.user.id);
    expiredSessionDb.close();
    assert.equal((await request("/api/projects", { cookie: alphaCookieAfterLogin })).response.status, 401);

    const deleteLogin = await request("/api/auth/login", {
      method: "POST",
      body: { username: "alpha_user", password: "1234567" },
    });
    const removed = await request("/api/projects/project-alpha", {
      method: "DELETE",
      cookie: deleteLogin.cookie,
      csrf: deleteLogin.payload.csrfToken,
      body: { expectedVersion: 2 },
    });
    assert.equal(removed.response.status, 200);
    const legacyRemoved = await request("/api/projects/legacy-alpha", {
      method: "DELETE",
      cookie: deleteLogin.cookie,
      csrf: deleteLogin.payload.csrfToken,
      body: { expectedVersion: 1 },
    });
    assert.equal(legacyRemoved.response.status, 200);
    assert.equal((await request("/api/projects", { cookie: deleteLogin.cookie })).payload.projects.length, 0);

    assert.equal((await request("/data/users.sqlite")).response.status, 404, "database files are not publicly served");
  } finally {
    await stopServer();
  }
});

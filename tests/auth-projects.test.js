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
  await fs.copyFile(path.join(__dirname, "..", "extraction-search.js"), path.join(temporaryRoot, "extraction-search.js"));
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
    const searchScript = await fetch(`${origin}/extraction-search.js`);
    assert.equal(searchScript.status, 200, "the dedicated search module is served as an existing static asset");
    assert.match(await searchScript.text(), /function searchProject/u);
    assert.equal((await request("/api/projects")).response.status, 401, "project data requires a session");
    assert.equal((await request("/api/analyze", { method: "POST", body: {} })).response.status, 401);
    assert.equal((await request("/api/compare", { method: "POST", body: {} })).response.status, 401);
    assert.equal((await request("/api/transcribe", { method: "POST", body: new Blob(["audio"]) })).response.status, 401);
    assert.equal((await request("/api/generate-update", { method: "POST", body: {} })).response.status, 401);

    const shortPassword = await request("/api/auth/register", {
      method: "POST",
      body: { username: "alpha_user", password: "123456", passwordConfirm: "123456" },
    });
    assert.equal(shortPassword.response.status, 400, "six-character passwords are rejected");

    const overLimitPassword = await request("/api/auth/register", {
      method: "POST",
      body: { username: "long_password", password: "1234567890123", passwordConfirm: "1234567890123" },
    });
    assert.equal(overLimitPassword.response.status, 400, "new accounts reject passwords longer than twelve characters");

    const twelveCharacterPassword = await request("/api/auth/register", {
      method: "POST",
      body: { username: "twelve_chars", password: "123456789012", passwordConfirm: "123456789012" },
    });
    assert.equal(twelveCharacterPassword.response.status, 201, "twelve-character passwords are accepted");

    const registered = await request("/api/auth/register", {
      method: "POST",
      body: { username: "alpha_user", password: "1234567", passwordConfirm: "1234567" },
    });
    assert.equal(registered.response.status, 201, "seven-character passwords are accepted");
    const alphaCookie = registered.cookie;
    const alphaCsrf = registered.payload.csrfToken;
    assert.ok(alphaCookie && alphaCsrf);
    assert.equal(registered.payload.user.createdAt.length > 0, true);
    assert.equal(registered.payload.user.bio, "");

    const profileWithoutCsrf = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: alphaCookie,
      body: { displayName: "알파 팀", bio: "요구사항을 꼼꼼히 검토합니다." },
    });
    assert.equal(profileWithoutCsrf.response.status, 403, "profile updates require CSRF validation");
    const savedProfile = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { displayName: "알파 팀", bio: "요구사항을 꼼꼼히 검토합니다." },
    });
    assert.equal(savedProfile.response.status, 200);
    assert.equal(savedProfile.payload.user.displayName, "알파 팀");
    assert.equal(savedProfile.payload.user.bio, "요구사항을 꼼꼼히 검토합니다.");
    assert.equal(savedProfile.payload.user.createdAt, registered.payload.user.createdAt);
    const oversizedBio = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { displayName: "알파 팀", bio: "소개".repeat(151) },
    });
    assert.equal(oversizedBio.response.status, 400);
    const currentProfile = await request("/api/auth/me", { cookie: alphaCookie });
    assert.equal(currentProfile.payload.user.displayName, "알파 팀");
    assert.equal(currentProfile.payload.user.bio, "요구사항을 꼼꼼히 검토합니다.");

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
    const legacyHistory = await request("/api/projects/legacy-alpha/changes", { cookie: alphaCookie });
    assert.equal(legacyHistory.response.status, 200);
    assert.equal(legacyHistory.payload.changes.length, 0, "legacy imports do not fabricate past modifier records");
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
    for (const route of ["/api/analyze", "/api/compare", "/api/transcribe", "/api/generate-update"]) {
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
      body: {
        project: {
          id: "project-alpha",
          name: "알파 프로젝트",
          client: "테스트 고객",
          summary: "처음 저장",
          status: "draft",
          analysisRunAt: null,
          analysisRun: false,
          extractionRun: false,
          analysisStale: false,
          extractedRequirements: { source: [], spec: [] },
          documents: [],
          rounds: [],
          requirements: [],
          specTemplate: null,
          analysisInputSignature: "initial-empty-content-signature",
        },
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.project.serverVersion, 1);
    assert.equal(created.payload.project.ownerId, registered.payload.user.id);
    assert.equal(created.payload.project.memberRole, "owner");
    const createdHistory = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(createdHistory.response.status, 200);
    assert.equal(createdHistory.payload.changes.length, 1);
    assert.equal(createdHistory.payload.changes[0].actorUserId, registered.payload.user.id);
    assert.equal(createdHistory.payload.changes[0].actorRole, "owner");
    assert.deepEqual(createdHistory.payload.changes[0].changedFields, ["프로젝트 정보"]);
    assert.ok(createdHistory.payload.changes[0].changedFields.includes("프로젝트 정보"));

    const derivedMetadataOnlySave = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        expectedVersion: 1,
        project: { ...created.payload.project, analysisInputSignature: "recomputed-without-content-change" },
      },
    });
    assert.equal(derivedMetadataOnlySave.response.status, 200);
    assert.equal(derivedMetadataOnlySave.payload.project.serverVersion, 1, "derived-only fields do not create a content version");
    assert.equal((await request("/api/projects/project-alpha/changes", { cookie: alphaCookie })).payload.changes.length, 1);

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
    const ownerHistory = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(ownerHistory.payload.changes.length, 2);
    assert.equal(ownerHistory.payload.changes[0].version, 2);
    assert.deepEqual(ownerHistory.payload.changes[0].changedFields, ["프로젝트 정보"]);

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

    const betaIdentityDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "users.sqlite"));
    betaIdentityDb.prepare("UPDATE users SET display_name = ? WHERE id = ?").run("알파 소유자", registered.payload.user.id);
    betaIdentityDb.prepare("UPDATE users SET display_name = ? WHERE id = ?").run("베타 팀원", secondUser.payload.user.id);
    betaIdentityDb.close();

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

    const ownerTeamBeforeInvite = await request("/api/projects/project-alpha/members", { cookie: alphaCookie });
    assert.equal(ownerTeamBeforeInvite.response.status, 200);
    assert.equal(ownerTeamBeforeInvite.payload.members.length, 1);
    assert.equal(ownerTeamBeforeInvite.payload.members[0].role, "owner");
    assert.equal(ownerTeamBeforeInvite.payload.members[0].displayName, "알파 소유자");

    const betaInvite = await request("/api/projects/project-alpha/invitations", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { username: "beta_user" },
    });
    assert.equal(betaInvite.response.status, 201);
    const pendingOwnerTeam = await request("/api/projects/project-alpha/members", { cookie: alphaCookie });
    assert.equal(pendingOwnerTeam.payload.members.length, 1, "pending invites are not listed as team members");
    assert.equal(pendingOwnerTeam.payload.pendingInvitations[0].username, "beta_user");
    const betaInvitations = await request("/api/invitations", { cookie: betaCookie });
    assert.equal(betaInvitations.response.status, 200);
    assert.equal(betaInvitations.payload.invitations.length, 1);
    assert.equal(betaInvitations.payload.invitations[0].projectName, "알파 프로젝트");
    assert.equal((await request("/api/projects/project-alpha", { cookie: betaCookie })).response.status, 404);

    const acceptedInvitation = await request(`/api/invitations/${betaInvite.payload.invitation.id}/accept`, {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: {},
    });
    assert.equal(acceptedInvitation.response.status, 200);
    const betaAccessibleProjects = await request("/api/projects", { cookie: betaCookie });
    assert.equal(betaAccessibleProjects.payload.projects.length, 1);
    assert.equal(betaAccessibleProjects.payload.projects[0].memberRole, "editor");
    assert.equal(betaAccessibleProjects.payload.projects[0].ownerId, registered.payload.user.id);
    const acceptedTeam = await request("/api/projects/project-alpha/members", { cookie: betaCookie });
    assert.equal(acceptedTeam.response.status, 200);
    assert.equal(acceptedTeam.payload.isOwner, false);
    assert.deepEqual(acceptedTeam.payload.members.map((member) => member.role), ["owner", "editor"]);
    assert.equal(acceptedTeam.payload.members[1].displayName, "베타 팀원");
    assert.deepEqual(acceptedTeam.payload.pendingInvitations, []);
    const editorAnalyzeAccess = await request("/api/analyze", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { projectId: "project-alpha" },
    });
    assert.notEqual(editorAnalyzeAccess.response.status, 404, "accepted editors pass the analysis project-access check");
    const editorCompareAccess = await request("/api/compare", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { projectId: "project-alpha" },
    });
    assert.notEqual(editorCompareAccess.response.status, 404, "accepted editors pass the comparison project-access check");
    const editorTranscribeAccess = await request("/api/transcribe", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      headers: { "x-project-id": "project-alpha" },
      body: new Blob(["audio"]),
    });
    assert.notEqual(editorTranscribeAccess.response.status, 404, "accepted editors pass the transcription project-access check");

    const unauthorizedInvite = await request("/api/projects/project-alpha/invitations", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { username: "alpha_user" },
    });
    assert.equal(unauthorizedInvite.response.status, 403, "only the owner may invite team members");

    const helperUser = await request("/api/auth/register", {
      method: "POST",
      body: { username: "gamma_user", password: "another7", passwordConfirm: "another7" },
    });
    assert.equal(helperUser.response.status, 201);
    const helperInvite = await request("/api/projects/project-alpha/invitations", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { username: "gamma_user" },
    });
    assert.equal(helperInvite.response.status, 201);
    const helperAccepted = await request(`/api/invitations/${helperInvite.payload.invitation.id}/accept`, {
      method: "POST",
      cookie: helperUser.cookie,
      csrf: helperUser.payload.csrfToken,
      body: {},
    });
    assert.equal(helperAccepted.response.status, 200);
    const teamWithTwoEditors = await request("/api/projects/project-alpha/members", { cookie: alphaCookie });
    assert.deepEqual(teamWithTwoEditors.payload.members.map((member) => member.role), ["owner", "editor", "editor"]);

    const editorKickAttempt = await request(`/api/projects/project-alpha/members/${encodeURIComponent(helperUser.payload.user.id)}`, {
      method: "DELETE",
      cookie: betaCookie,
      csrf: betaCsrf,
    });
    assert.equal(editorKickAttempt.response.status, 403, "editors cannot kick other team members");
    const editorDeleteProjectAttempt = await request("/api/projects/project-alpha", {
      method: "DELETE",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { expectedVersion: 3 },
    });
    assert.equal(editorDeleteProjectAttempt.response.status, 403, "editors cannot delete the project");
    const ownerKickAttempt = await request(`/api/projects/project-alpha/members/${encodeURIComponent(registered.payload.user.id)}`, {
      method: "DELETE",
      cookie: alphaCookie,
      csrf: alphaCsrf,
    });
    assert.equal(ownerKickAttempt.response.status, 400, "the owner cannot be kicked");

    const betaSavedProject = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: {
        actorUserId: registered.payload.user.id,
        actorUsername: "forged_owner",
        actorRole: "owner",
        expectedVersion: 2,
        project: { ...updated.payload.project, summary: "팀원이 저장한 변경", updatedAt: "2000-01-01T00:00:00.000Z" },
      },
    });
    assert.equal(betaSavedProject.response.status, 200);
    assert.equal(betaSavedProject.payload.project.serverVersion, 3);
    const betaSaveHistory = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(betaSaveHistory.payload.changes[0].actorUserId, secondUser.payload.user.id);
    assert.equal(betaSaveHistory.payload.changes[0].actorUsername, "beta_user");
    assert.equal(betaSaveHistory.payload.changes[0].actorRole, "editor");
    assert.equal(betaSaveHistory.payload.changes[0].version, 3);
    assert.deepEqual(betaSaveHistory.payload.changes[0].changedFields, ["프로젝트 정보"]);
    assert.notEqual(betaSaveHistory.payload.changes[0].createdAt, "2000-01-01T00:00:00.000Z");

    const noOpSave = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { expectedVersion: 3, project: betaSavedProject.payload.project },
    });
    assert.equal(noOpSave.response.status, 200);
    assert.equal(noOpSave.payload.project.serverVersion, 3, "no-op saves do not increment the version");
    const afterNoOpSave = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(afterNoOpSave.payload.changes.length, 3, "no-op saves do not create history entries");
    const staleEditorSave = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { expectedVersion: 2, project: { ...betaSavedProject.payload.project, summary: "충돌 저장" } },
    });
    assert.equal(staleEditorSave.response.status, 409);
    const afterConflictSave = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(afterConflictSave.payload.changes.length, 3, "version conflicts do not create history entries");

    const testProject = await request("/api/projects", {
      method: "POST",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { project: { id: "history-limit", name: "기록 범위 확인", client: "테스트 고객", summary: "초기" } },
    });
    assert.equal(testProject.response.status, 201);
    const compatibilityDefaults = await request("/api/projects/history-limit", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        expectedVersion: 1,
        project: {
          ...testProject.payload.project,
          documents: [],
          rounds: [],
          extractedRequirements: { source: [], spec: [] },
          requirementReview: { version: 1, items: {} },
          requirementComparison: null,
          specTemplate: null,
          specificationTemplateReview: null,
        },
      },
    });
    assert.equal(compatibilityDefaults.response.status, 200);
    assert.equal(compatibilityDefaults.payload.project.serverVersion, 1, "empty compatibility defaults do not create a content change");
    const afterCompatibilityDefaults = await request("/api/projects/history-limit/changes", { cookie: alphaCookie });
    assert.equal(afterCompatibilityDefaults.payload.changes.length, 1);
    const categoryCheck = await request("/api/projects/history-limit", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: {
        expectedVersion: 1,
        project: {
          ...testProject.payload.project,
          documents: [{ id: "doc-1", kind: "source", content: "고객은 저장 기록을 확인합니다." }],
          requirements: [{ id: "req-1", text: "수정 분야를 구분합니다." }],
          extractedRequirements: { source: [{ id: "req-1", text: "수정 분야를 구분합니다." }], spec: [] },
          requirementReview: { version: 1, items: { "req-1": { status: "confirmed", text: "수정 분야를 구분합니다." } } },
          requirementComparison: { comparedAt: "2026-01-01T00:00:00.000Z", results: [] },
        },
      },
    });
    assert.equal(categoryCheck.response.status, 200);
    assert.equal(categoryCheck.payload.project.serverVersion, 2);
    const categoryHistory = await request("/api/projects/history-limit/changes", { cookie: alphaCookie });
    assert.deepEqual(categoryHistory.payload.changes[0].changedFields, ["문서", "요구사항", "검토·확정", "기획서 비교"]);
    let testProjectVersion = categoryCheck.payload.project.serverVersion;
    let testProjectState = categoryCheck.payload.project;
    for (let index = 1; index <= 51; index += 1) {
      const saved = await request("/api/projects/history-limit", {
        method: "PUT",
        cookie: alphaCookie,
        csrf: alphaCsrf,
        body: { expectedVersion: testProjectVersion, project: { ...testProjectState, summary: `기록 ${index}` } },
      });
      assert.equal(saved.response.status, 200);
      testProjectState = saved.payload.project;
      testProjectVersion = saved.payload.project.serverVersion;
    }
    const limitedHistory = await request("/api/projects/history-limit/changes", { cookie: alphaCookie });
    assert.equal(limitedHistory.payload.changes.length, 50, "history API returns only the newest 50 records");
    assert.equal(limitedHistory.payload.changes[0].version, 53);
    assert.equal(limitedHistory.payload.changes.at(-1).version, 4);

    const projectsDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    projectsDb.exec(`CREATE TRIGGER fail_project_update BEFORE UPDATE ON projects
      WHEN OLD.id = 'project-alpha' BEGIN SELECT RAISE(ABORT, 'forced test failure'); END;`);
    projectsDb.close();
    const failedSave = await request("/api/projects/project-alpha", {
      method: "PUT",
      cookie: alphaCookie,
      csrf: alphaCsrf,
      body: { expectedVersion: 3, project: { ...betaSavedProject.payload.project, summary: "저장 실패 테스트" } },
    });
    assert.equal(failedSave.response.status, 500);
    const dropTriggerDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    dropTriggerDb.exec("DROP TRIGGER fail_project_update");
    dropTriggerDb.close();
    const afterFailedSave = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(afterFailedSave.payload.changes.length, 3, "failed saves do not create history entries");

    const kickBeta = await request(`/api/projects/project-alpha/members/${encodeURIComponent(secondUser.payload.user.id)}`, {
      method: "DELETE",
      cookie: alphaCookie,
      csrf: alphaCsrf,
    });
    assert.equal(kickBeta.response.status, 200);
    assert.equal((await request("/api/projects/project-alpha", { cookie: betaCookie })).response.status, 404);
    assert.equal((await request("/api/projects/project-alpha/changes", { cookie: betaCookie })).response.status, 404);
    assert.equal((await request("/api/projects/project-alpha/members", { cookie: betaCookie })).response.status, 404);
    assert.equal((await request("/api/analyze", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { projectId: "project-alpha" },
    })).response.status, 404);
    assert.equal((await request("/api/compare", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { projectId: "project-alpha" },
    })).response.status, 404);
    assert.equal((await request("/api/transcribe", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      headers: { "x-project-id": "project-alpha" },
      body: new Blob(["audio"]),
    })).response.status, 404);
    assert.equal((await request("/api/generate-update", {
      method: "POST",
      cookie: betaCookie,
      csrf: betaCsrf,
      body: { projectId: "project-alpha" },
    })).response.status, 404);
    const preservedProject = await request("/api/projects/project-alpha", { cookie: alphaCookie });
    assert.equal(preservedProject.response.status, 200);
    assert.equal(preservedProject.payload.project.summary, "팀원이 저장한 변경");
    assert.equal(preservedProject.payload.project.serverVersion, 3, "failed saves leave the project version unchanged");
    const preservedHistory = await request("/api/projects/project-alpha/changes", { cookie: alphaCookie });
    assert.equal(preservedHistory.payload.changes.length, 3);
    assert.equal(preservedHistory.payload.changes[0].actorUserId, secondUser.payload.user.id, "kicking a member keeps their change history");
    const teamAfterKick = await request("/api/projects/project-alpha/members", { cookie: alphaCookie });
    assert.equal(teamAfterKick.payload.members.some((member) => member.id === secondUser.payload.user.id), false);

    const logout = await request("/api/auth/logout", { method: "POST", cookie: alphaCookie, csrf: alphaCsrf, body: {} });
    assert.equal(logout.response.status, 200);
    assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/u, "logout clears the browser session cookie");
    assert.equal((await request("/api/projects", { cookie: alphaCookie })).response.status, 401);
    assert.equal((await request("/api/auth/me", { cookie: alphaCookie })).payload.authenticated, false, "logout revokes the server session");

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { username: "alpha_user", password: "1234567" },
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.payload.user.displayName, "알파 소유자");
    assert.equal(login.payload.user.bio, "요구사항을 꼼꼼히 검토합니다.");
    const alphaCookieAfterLogin = login.cookie;
    const alphaCsrfAfterLogin = login.payload.csrfToken;

    await stopServer();
    await startServer();
    const persisted = await request("/api/projects", { cookie: alphaCookieAfterLogin });
    assert.equal(persisted.response.status, 200, "sessions and projects survive a server restart");
    assert.equal(persisted.payload.projects.length, 3);
    const persistedAlpha = persisted.payload.projects.find((project) => project.id === "project-alpha");
    assert.equal(persistedAlpha.summary, "팀원이 저장한 변경");
    assert.equal(persistedAlpha.serverVersion, 3);
    assert.ok(persisted.payload.projects.some((project) => project.id === "legacy-alpha"));
    assert.equal(persisted.payload.projects.find((project) => project.id === "history-limit").serverVersion, 53);
    const historyAfterRestart = await request("/api/projects/project-alpha/changes", { cookie: alphaCookieAfterLogin });
    assert.equal(historyAfterRestart.response.status, 200);
    assert.equal(historyAfterRestart.payload.changes.length, 3);
    assert.equal(historyAfterRestart.payload.changes[0].actorUserId, secondUser.payload.user.id);
    assert.equal((await request("/api/projects/project-alpha", { cookie: betaCookie })).response.status, 404);
    assert.equal((await request("/api/projects/project-alpha/changes", { cookie: betaCookie })).response.status, 404);

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
      body: { expectedVersion: 3 },
    });
    assert.equal(removed.response.status, 200);
    const legacyRemoved = await request("/api/projects/legacy-alpha", {
      method: "DELETE",
      cookie: deleteLogin.cookie,
      csrf: deleteLogin.payload.csrfToken,
      body: { expectedVersion: 1 },
    });
    assert.equal(legacyRemoved.response.status, 200);
    const historyProjectRemoved = await request("/api/projects/history-limit", {
      method: "DELETE",
      cookie: deleteLogin.cookie,
      csrf: deleteLogin.payload.csrfToken,
      body: { expectedVersion: 53 },
    });
    assert.equal(historyProjectRemoved.response.status, 200);
    assert.equal((await request("/api/projects", { cookie: deleteLogin.cookie })).payload.projects.length, 0);

    assert.equal((await request("/data/users.sqlite")).response.status, 404, "database files are not publicly served");
  } finally {
    await stopServer();
  }
});

test("database schema migration preserves existing accounts and project records", { timeout: 20_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-schema-migration-test-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(temporaryRoot, "server.js"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const ownerId = "preserved-owner-id";
  const username = "preserved_owner";
  const password = "MigrationPass7";
  const createdAt = "2025-04-01T10:00:00.000Z";
  const updatedAt = "2025-04-02T11:30:00.000Z";
  const salt = require("node:crypto").randomBytes(16).toString("base64url");
  const passwordHash = require("node:crypto").scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex");

  const legacyUsersDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "users.sqlite"));
  legacyUsersDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username_key TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  legacyUsersDb.prepare(`
    INSERT INTO users (id, username_key, username, salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ownerId, username, username, salt, passwordHash, createdAt);
  legacyUsersDb.close();

  const storedProject = {
    id: "preexisting-project",
    name: "보존된 프로젝트",
    client: "기존 고객사",
    summary: "마이그레이션 전 자료",
    status: "review",
    createdAt,
    updatedAt,
    documents: [{ id: "old-doc", kind: "source", content: "이전 회의 기록을 보존합니다." }],
    extractedRequirements: { source: [{ id: "old-req", text: "기존 요구사항", evidence: [] }], spec: [] },
    requirements: [{ id: "old-req", text: "기존 요구사항", status: "missing" }],
    requirementReview: { version: 1, items: { "old-req": { status: "confirmed", text: "기존 요구사항" } } },
  };
  const legacyProjectsDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "projects.sqlite"));
  legacyProjectsDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE legacy_imports (
      owner_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacyProjectsDb.prepare(`
    INSERT INTO projects (id, owner_id, version, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(storedProject.id, ownerId, 7, JSON.stringify(storedProject), createdAt, updatedAt);
  legacyProjectsDb.close();

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
      if (child.exitCode !== null) throw new Error(`Migrated test server stopped: ${serverOutput}`);
      try {
        if ((await fetch(`${origin}/api/auth/me`)).ok) return;
      } catch {
        // The migrated database is still being opened.
      }
      await delay(40);
    }
    throw new Error(`Migrated test server did not start: ${serverOutput}`);
  }

  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }

  async function request(route, { method = "GET", body, cookie = "", csrf = "" } = {}) {
    const headers = {};
    if (method !== "GET") headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${origin}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Report response status even if an API returns no JSON body.
    }
    return {
      response,
      payload,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie,
    };
  }

  await startServer();
  try {
    const login = await request("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    assert.equal(login.response.status, 200, "a legacy account can still log in after the display-name column is added");

    const projects = await request("/api/projects", { cookie: login.cookie });
    assert.equal(projects.response.status, 200);
    assert.equal(projects.payload.projects.length, 1);
    assert.equal(projects.payload.projects[0].serverVersion, 7);
    assert.equal(projects.payload.projects[0].name, storedProject.name);
    assert.equal(projects.payload.projects[0].documents[0].content, storedProject.documents[0].content);
    assert.equal(projects.payload.projects[0].requirementReview.items["old-req"].status, "confirmed");
    assert.equal((await request("/api/projects/preexisting-project/changes", { cookie: login.cookie })).payload.changes.length, 0);

    const saved = await request("/api/projects/preexisting-project", {
      method: "PUT",
      cookie: login.cookie,
      csrf: login.payload.csrfToken,
      body: {
        expectedVersion: 7,
        project: { ...projects.payload.projects[0], summary: "기존 자료를 보존한 채 수정" },
      },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.project.serverVersion, 8);
    assert.equal(saved.payload.project.documents[0].content, storedProject.documents[0].content);
    assert.equal(saved.payload.project.requirementReview.items["old-req"].status, "confirmed");

    const changes = await request("/api/projects/preexisting-project/changes", { cookie: login.cookie });
    assert.equal(changes.payload.changes.length, 1);
    assert.equal(changes.payload.changes[0].actorUserId, ownerId);
    assert.equal(changes.payload.changes[0].version, 8);
    assert.deepEqual(changes.payload.changes[0].changedFields, ["프로젝트 정보"]);

    const migratedProjectsDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "projects.sqlite"), { readOnly: true });
    const projectTables = migratedProjectsDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(projectTables.includes("project_notifications"), "the new notification table is added without recreating old project data");
    assert.equal(migratedProjectsDb.prepare("SELECT COUNT(*) AS count FROM project_notifications").get().count, 0, "migration does not fabricate old notifications");
    migratedProjectsDb.close();

    const migratedUsersDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "users.sqlite"), { readOnly: true });
    const columns = migratedUsersDb.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
    assert.ok(columns.includes("display_name"), "the optional display-name column is added by migration");
    assert.ok(columns.includes("bio"), "the optional bio column is added without recreating the account");
    assert.equal(migratedUsersDb.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(ownerId).count, 1);
    migratedUsersDb.close();
  } finally {
    await stopServer();
  }
});

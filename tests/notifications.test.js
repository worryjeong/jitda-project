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

test("project notifications persist per user, enforce access, mark read, and create one on-demand follow-up", { timeout: 30_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-notifications-test-"));
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
      if (child.exitCode !== null) throw new Error(`Notification server stopped: ${serverOutput}`);
      try {
        if ((await fetch(`${origin}/api/auth/me`)).ok) return;
      } catch {
        // Wait for the temporary SQLite database and listener to start.
      }
      await delay(40);
    }
    throw new Error(`Notification server did not start: ${serverOutput}`);
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
      // Preserve status and headers for the assertions.
    }
    return {
      response,
      payload,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie,
    };
  }

  await startServer();
  try {
    assert.equal((await request("/api/notifications")).response.status, 401, "notification list requires authentication");
    const owner = await request("/api/auth/register", {
      method: "POST",
      body: { username: "notify_owner", password: "notify7", passwordConfirm: "notify7" },
    });
    assert.equal(owner.response.status, 201);
    const editor = await request("/api/auth/register", {
      method: "POST",
      body: { username: "notify_editor", password: "notify7", passwordConfirm: "notify7" },
    });
    assert.equal(editor.response.status, 201);
    const outsider = await request("/api/auth/register", {
      method: "POST",
      body: { username: "notify_other", password: "notify7", passwordConfirm: "notify7" },
    });
    assert.equal(outsider.response.status, 201);

    const projectId = "notification-project";
    const created = await request("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { project: { id: projectId, name: "알림 테스트 프로젝트", client: "격리 고객사", summary: "알림 저장과 권한 확인" } },
    });
    assert.equal(created.response.status, 201);
    assert.equal((await request("/api/notifications", { cookie: owner.cookie })).payload.notifications.length, 0);

    const invitation = await request(`/api/projects/${projectId}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { username: "notify_editor" },
    });
    assert.equal(invitation.response.status, 201);
    assert.equal((await request(`/api/projects/${projectId}/invitations`, {
      method: "POST",
      cookie: outsider.cookie,
      csrf: outsider.payload.csrfToken,
      body: { username: "notify_editor" },
    })).response.status, 404);
    const accepted = await request(`/api/invitations/${invitation.payload.invitation.id}/accept`, {
      method: "POST",
      cookie: editor.cookie,
      csrf: editor.payload.csrfToken,
      body: {},
    });
    assert.equal(accepted.response.status, 200);

    const analysisAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const missingText = "장바구니 수량을 표시합니다.";
    const conflictText = "비회원은 주문할 수 없습니다.";
    const resolvedText = "검색을 지원합니다.";
    const failBeforeNotification = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    failBeforeNotification.exec(`CREATE TRIGGER fail_notification_project_save BEFORE UPDATE ON projects
      WHEN OLD.id = '${projectId}' BEGIN SELECT RAISE(ABORT, 'forced notification storage failure'); END;`);
    failBeforeNotification.close();
    const failedAnalysisSave = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 1,
        project: {
          ...created.payload.project,
          analysisRun: true,
          extractionRun: true,
          analysisRunAt: analysisAt,
          analysisStale: false,
          extractedRequirements: { source: [], spec: [] },
          requirements: [{ id: "failed-issue", text: "저장 실패는 완료 알림이 되면 안 됩니다.", status: "missing" }],
        },
      },
    });
    assert.equal(failedAnalysisSave.response.status, 500);
    const dropFailTrigger = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    dropFailTrigger.exec("DROP TRIGGER fail_notification_project_save");
    dropFailTrigger.close();
    assert.equal((await request("/api/notifications", { cookie: owner.cookie })).payload.notifications.length, 0, "a rolled-back save creates no completion notification");

    const analysisSave = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 1,
        project: {
          ...created.payload.project,
          analysisRun: true,
          extractionRun: true,
          analysisStale: false,
          analysisRunAt: analysisAt,
          extractedRequirements: { source: [], spec: [] },
          requirements: [
            { id: "missing-requirement", text: missingText, status: "missing" },
            { id: "conflict-requirement", text: conflictText, status: "conflict" },
            { id: "resolved-requirement", text: resolvedText, status: "reflected" },
          ],
          requirementReview: { version: 1, items: {
            "missing-requirement": { status: "confirmed", text: missingText },
            "conflict-requirement": { status: "confirmed", text: conflictText },
            "resolved-requirement": { status: "confirmed", text: resolvedText },
          } },
        },
      },
    });
    assert.equal(analysisSave.response.status, 200);
    assert.equal(analysisSave.payload.notificationsCreated, 2, "saved analysis notifies the owner and accepted member");
    assert.equal(analysisSave.payload.project.serverVersion, 2);

    const conflictingAnalysisSave = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 1,
        project: { ...analysisSave.payload.project, analysisRunAt: new Date().toISOString() },
      },
    });
    assert.equal(conflictingAnalysisSave.response.status, 409);
    assert.equal((await request("/api/notifications", { cookie: owner.cookie })).payload.notifications.length, 1, "a version conflict cannot create a duplicate analysis alert");

    const ownerAfterAnalysis = await request("/api/notifications", { cookie: owner.cookie });
    const editorAfterAnalysis = await request("/api/notifications", { cookie: editor.cookie });
    const outsiderAfterAnalysis = await request("/api/notifications", { cookie: outsider.cookie });
    assert.equal(ownerAfterAnalysis.response.status, 200);
    assert.equal(ownerAfterAnalysis.payload.userId, owner.payload.user.id);
    assert.equal(ownerAfterAnalysis.payload.notifications.length, 1);
    assert.equal(ownerAfterAnalysis.payload.notifications[0].type, "analysis_completed");
    assert.equal(ownerAfterAnalysis.payload.notifications[0].projectName, "알림 테스트 프로젝트");
    assert.equal(ownerAfterAnalysis.payload.notifications[0].targetPath, `/projects/${projectId}/extract`);
    assert.equal(editorAfterAnalysis.payload.notifications.length, 1, "accepted members see project notifications");
    assert.equal(outsiderAfterAnalysis.payload.notifications.length, 0, "unrelated users do not see project notifications");
    const failedComparison = await request("/api/compare", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { projectId, confirmedRequirements: [], specification: { documentName: "", content: "" } },
    });
    assert.equal(failedComparison.response.status, 400);
    assert.equal((await request("/api/notifications", { cookie: owner.cookie })).payload.notifications.length, 1, "a failed comparison request does not create a completed notice");

    const pendingProject = await request("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { project: { id: "pending-notification-project", name: "대기 초대 권한 확인", client: "격리 고객사", summary: "수락 전 알림 권한" } },
    });
    assert.equal(pendingProject.response.status, 201);
    const pendingInvite = await request("/api/projects/pending-notification-project/invitations", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { username: "notify_editor" },
    });
    assert.equal(pendingInvite.response.status, 201);
    const pendingAnalysis = await request("/api/projects/pending-notification-project", {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 1,
        project: {
          ...pendingProject.payload.project,
          extractionRun: true,
          analysisRun: true,
          analysisRunAt: new Date().toISOString(),
          analysisStale: false,
          extractedRequirements: { source: [], spec: [] },
          requirements: [{ id: "pending-only-issue", text: "수락 전 공유되지 않는 분석", status: "missing" }],
        },
      },
    });
    assert.equal(pendingAnalysis.response.status, 200);
    assert.equal(pendingAnalysis.payload.notificationsCreated, 1, "a pending invite is not a notification recipient");
    assert.equal((await request("/api/notifications", { cookie: editor.cookie })).payload.notifications
      .some((item) => item.projectId === "pending-notification-project"), false);
    const deletePendingProject = await request("/api/projects/pending-notification-project", {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { expectedVersion: 2 },
    });
    assert.equal(deletePendingProject.response.status, 200);

    const noChange = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { expectedVersion: 2, project: analysisSave.payload.project },
    });
    assert.equal(noChange.payload.notificationsCreated, 0, "no-op saves do not create notifications");
    assert.equal((await request("/api/notifications", { cookie: owner.cookie })).payload.notifications.length, 1);

    const compareAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const comparisonSave = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: editor.cookie,
      csrf: editor.payload.csrfToken,
      body: {
        expectedVersion: 2,
        project: {
          ...analysisSave.payload.project,
          requirementComparison: {
            version: 1,
            comparedAt: compareAt,
            confirmedRequirements: [
              { id: "missing-requirement", text: missingText, category: "function" },
              { id: "conflict-requirement", text: conflictText, category: "function" },
            ],
            results: [
              { requirementId: "missing-requirement", status: "누락 의심", reason: "기획서에서 관련 문장을 찾지 못했습니다." },
              { requirementId: "conflict-requirement", status: "충돌", reason: "조건이 다릅니다." },
            ],
            usedFallback: true,
            fallbackMessage: "AI 비교 실패로 규칙 기반 결과를 표시합니다",
          },
          comparisonStale: false,
        },
      },
    });
    assert.equal(comparisonSave.response.status, 200);
    assert.equal(comparisonSave.payload.notificationsCreated, 2, "saved comparison notifies active project members");
    const editorAfterComparison = await request("/api/notifications", { cookie: editor.cookie });
    const comparisonNotice = editorAfterComparison.payload.notifications.find((item) => item.type === "comparison_completed");
    assert.ok(comparisonNotice);
    assert.equal(comparisonNotice.targetPath, `/projects/${projectId}/compare`);
    assert.match(comparisonNotice.body, /규칙 기반/u);
    assert.doesNotMatch(comparisonNotice.body, /AI 분석 결과/u);

    const editorRead = await request(`/api/notifications/${encodeURIComponent(comparisonNotice.id)}/read`, {
      method: "PATCH",
      cookie: editor.cookie,
      csrf: editor.payload.csrfToken,
      body: {},
    });
    assert.equal(editorRead.response.status, 200);
    assert.ok(editorRead.payload.notification.readAt);
    assert.equal(editorRead.payload.unreadCount, 1);

    const crossUserRead = await request(`/api/notifications/${encodeURIComponent(comparisonNotice.id)}/read`, {
      method: "PATCH",
      cookie: outsider.cookie,
      csrf: outsider.payload.csrfToken,
      body: {},
    });
    assert.equal(crossUserRead.response.status, 404, "users cannot read another account's notification");

    const markOwnerAll = await request("/api/notifications/read-all", {
      method: "PATCH",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {},
    });
    assert.equal(markOwnerAll.response.status, 200);
    assert.equal(markOwnerAll.payload.unreadCount, 0);
    assert.equal(markOwnerAll.payload.notifications.every((item) => Boolean(item.readAt)), true);

    const normalCompareAt = new Date().toISOString();
    const normalComparisonSave = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 3,
        project: {
          ...comparisonSave.payload.project,
          requirementComparison: {
            ...comparisonSave.payload.project.requirementComparison,
            comparedAt: normalCompareAt,
            usedFallback: false,
            fallbackMessage: "",
          },
        },
      },
    });
    assert.equal(normalComparisonSave.response.status, 200);
    assert.equal(normalComparisonSave.payload.notificationsCreated, 2, "a regular saved comparison also notifies the project recipients");
    const normalComparisonNotice = (await request("/api/notifications", { cookie: owner.cookie })).payload.notifications
      .find((item) => item.type === "comparison_completed" && !/규칙 기반/u.test(item.body));
    assert.ok(normalComparisonNotice);
    assert.match(normalComparisonNotice.body, /기획서 비교 결과가 저장/u);

    const olderAnalysisCreatedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const oldAnalysisCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const database = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    database.prepare(`
      UPDATE project_notifications SET created_at = ?
      WHERE project_id = ? AND event_key = ? AND event_type = 'analysis_completed'
    `).run(olderAnalysisCreatedAt, projectId, `analysis:${projectId}:2`);
    database.close();

    const analysisAgainAt = new Date().toISOString();
    const newAnalysis = await request(`/api/projects/${projectId}`, {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 4,
        project: {
          ...normalComparisonSave.payload.project,
          analysisRunAt: analysisAgainAt,
          analysisStale: false,
          comparisonStale: true,
          requirements: [
            { id: "missing-requirement", text: missingText, status: "missing" },
            { id: "req-2", text: "삭제 대상으로 표시된 충돌", status: "conflict" },
            { id: "resolved-requirement", text: resolvedText, status: "reflected" },
          ],
          requirementReview: { version: 2, items: {
            "missing-requirement": { status: "confirmed", text: missingText },
            "deleted-conflict": { status: "deleted", text: "삭제 대상으로 표시된 충돌" },
            "resolved-requirement": { status: "confirmed", text: resolvedText },
          } },
        },
      },
    });
    assert.equal(newAnalysis.response.status, 200);
    assert.equal(newAnalysis.payload.notificationsCreated, 2);

    const backdateLatestAnalysis = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    backdateLatestAnalysis.prepare(`
      UPDATE project_notifications SET created_at = ?
      WHERE project_id = ? AND event_key = ? AND event_type = 'analysis_completed'
    `).run(oldAnalysisCreatedAt, projectId, `analysis:${projectId}:5`);
    backdateLatestAnalysis.close();
    const ownerFirstRefresh = await request("/api/notifications", { cookie: owner.cookie });
    const ownerFollowups = ownerFirstRefresh.payload.notifications.filter((item) => item.type === "review_followup");
    assert.equal(ownerFollowups.length, 1, "an unresolved-issue follow-up appears after 24 hours");
    assert.match(ownerFollowups[0].body, /누락 의심 1개/u);
    assert.doesNotMatch(ownerFollowups[0].body, /충돌/u, "deleted conflict items are excluded from follow-ups");
    assert.equal(ownerFollowups[0].targetPath, `/projects/${projectId}/extract`);
    const ownerSecondRefresh = await request("/api/notifications", { cookie: owner.cookie });
    assert.equal(ownerSecondRefresh.payload.notifications.filter((item) => item.type === "review_followup").length, 1, "the same analysis only produces one follow-up");

    const staleProject = await request("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: { project: { id: "stale-notification-project", name: "오래된 결과 테스트", client: "격리 고객사", summary: "오래된 분석 결과" } },
    });
    assert.equal(staleProject.response.status, 201);
    const staleAnalysisAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const staleAnalysisSave = await request("/api/projects/stale-notification-project", {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 1,
        project: {
          ...staleProject.payload.project,
          extractionRun: true,
          analysisRun: true,
          analysisRunAt: staleAnalysisAt,
          analysisStale: false,
          requirements: [{ id: "stale-issue", text: "이전 분석 결과의 미해결 누락", status: "missing" }],
          extractedRequirements: { source: [], spec: [] },
        },
      },
    });
    assert.equal(staleAnalysisSave.payload.notificationsCreated, 1);
    const ageStaleAnalysisEvent = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    ageStaleAnalysisEvent.prepare(`
      UPDATE project_notifications SET created_at = ?
      WHERE project_id = 'stale-notification-project' AND event_key = 'analysis:stale-notification-project:2' AND event_type = 'analysis_completed'
    `).run(oldAnalysisCreatedAt);
    ageStaleAnalysisEvent.close();
    const staleEdit = await request("/api/projects/stale-notification-project", {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
      body: {
        expectedVersion: 2,
        project: { ...staleAnalysisSave.payload.project, analysisStale: true },
      },
    });
    assert.equal(staleEdit.response.status, 200);
    const staleFollowupCheck = await request("/api/notifications", { cookie: owner.cookie });
    assert.equal(staleFollowupCheck.payload.notifications.some((item) => item.projectId === "stale-notification-project" && item.type === "review_followup"), false, "stale analysis does not create a follow-up");

    const editorProjectNotice = (await request("/api/notifications", { cookie: editor.cookie })).payload.notifications
      .find((item) => item.projectId === projectId && item.type === "analysis_completed");
    assert.ok(editorProjectNotice);
    const removed = await request(`/api/projects/${projectId}/members/${encodeURIComponent(editor.payload.user.id)}`, {
      method: "DELETE",
      cookie: owner.cookie,
      csrf: owner.payload.csrfToken,
    });
    assert.equal(removed.response.status, 200);
    const editorAfterRemoval = await request("/api/notifications", { cookie: editor.cookie });
    assert.equal(editorAfterRemoval.payload.notifications.some((item) => item.projectId === projectId), false, "removed members cannot list notifications for that project");
    assert.equal((await request(`/api/notifications/${encodeURIComponent(editorProjectNotice.id)}/read`, {
      method: "PATCH",
      cookie: editor.cookie,
      csrf: editor.payload.csrfToken,
      body: {},
    })).response.status, 404, "removed members cannot mark project notifications read");

    const ownerRowsBeforeRestart = (await request("/api/notifications", { cookie: owner.cookie })).payload.notifications;
    assert.ok(ownerRowsBeforeRestart.some((item) => item.projectId === projectId && item.type === "analysis_completed"));
    await stopServer();
    await startServer();
    const ownerRowsAfterRestart = await request("/api/notifications", { cookie: owner.cookie });
    assert.equal(ownerRowsAfterRestart.response.status, 200);
    assert.equal(ownerRowsAfterRestart.payload.notifications.some((item) => item.type === "review_followup" && item.projectId === projectId), true, "notifications persist across a server restart");
    assert.equal(ownerRowsAfterRestart.payload.notifications.some((item) => item.type === "comparison_completed" && /규칙 기반/u.test(item.body)), true);
    assert.equal(ownerRowsAfterRestart.payload.notifications.some((item) => item.type === "comparison_completed" && /기획서 비교 결과가 저장/u.test(item.body)), true);
    const persistedReadComparison = ownerRowsAfterRestart.payload.notifications.find((item) => item.type === "comparison_completed" && /규칙 기반/u.test(item.body));
    assert.ok(persistedReadComparison?.readAt, "read status persists across a server restart");
  } finally {
    await stopServer();
  }
});

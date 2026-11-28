"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
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

function startIsolatedServer(temporaryRoot, port) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: temporaryRoot,
    env: { PATH: process.env.PATH || "", PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitForServer(server, origin) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Invitation test server stopped: ${server.output()}`);
    try {
      if ((await fetch(`${origin}/api/auth/me`)).ok) return;
    } catch {
      // Wait for the isolated SQLite database and HTTP listener to start.
    }
    await delay(40);
  }
  throw new Error(`Invitation test server did not start: ${server.output()}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await exited;
}

function createRequester(origin) {
  return async function request(route, { method = "GET", body, cookie = "", csrf = "" } = {}) {
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
      // Keep the HTTP status available for failures with no response body.
    }
    return {
      response,
      payload,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || cookie,
    };
  };
}

test("project invitation notifications are recipient-only, stateful, persistent, and isolated", { timeout: 40_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-invitation-notifications-test-"));
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(temporaryRoot, "server.js"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const request = createRequester(origin);
  let server = startIsolatedServer(temporaryRoot, port);
  await waitForServer(server, origin);

  async function register(username) {
    const result = await request("/api/auth/register", {
      method: "POST",
      body: { username, password: "invite77", passwordConfirm: "invite77" },
    });
    assert.equal(result.response.status, 201);
    return { ...result.payload, cookie: result.cookie };
  }

  async function createProject(owner, id, name) {
    const result = await request("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { project: { id, name, client: "격리 고객사", summary: "초대 알림 통합 검증" } },
    });
    assert.equal(result.response.status, 201);
    return result.payload.project;
  }

  async function sendInvitation(owner, projectId, username) {
    return request(`/api/projects/${encodeURIComponent(projectId)}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrfToken,
      body: { username },
    });
  }

  try {
    const accountA = await register("invite_owner");
    const accountB = await register("invite_beta");
    const accountC = await register("invite_charlie");
    const profile = await request("/api/auth/profile", {
      method: "PATCH",
      cookie: accountA.cookie,
      csrf: accountA.csrfToken,
      body: { displayName: "초대하는 사람", bio: "" },
    });
    assert.equal(profile.response.status, 200);

    const acceptedProject = await createProject(accountA, "invite-accept-project", "수락 확인 프로젝트");

    assert.equal((await sendInvitation(accountA, acceptedProject.id, "invite_owner")).response.status, 400, "self-invites are rejected");
    assert.equal((await sendInvitation(accountA, acceptedProject.id, "missing_account")).response.status, 404, "unknown accounts are rejected");
    assert.equal((await request("/api/notifications", { cookie: accountA.cookie })).payload.notifications.length, 0);
    assert.equal((await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications.length, 0);

    const inviteB = await sendInvitation(accountA, acceptedProject.id, "invite_beta");
    assert.equal(inviteB.response.status, 201);
    const pendingInvitationId = inviteB.payload.invitation.id;
    assert.equal((await sendInvitation(accountA, acceptedProject.id, "invite_beta")).response.status, 409, "a duplicate pending invite is rejected");
    assert.equal((await sendInvitation(accountB, acceptedProject.id, "invite_charlie")).response.status, 404, "only the owner can create invitations");
    assert.equal((await request("/api/notifications", { cookie: accountA.cookie })).payload.notifications
      .some((item) => item.invitationId === pendingInvitationId), false, "the inviter does not receive the recipient's invitation alert");

    const betaInitial = await request("/api/notifications?userId=spoofed-account", { cookie: accountB.cookie });
    assert.equal(betaInitial.response.status, 200);
    assert.equal(betaInitial.payload.notifications.length, 1, "only B sees the notification, regardless of a client-supplied userId");
    const pendingNotice = betaInitial.payload.notifications[0];
    assert.equal(pendingNotice.type, "project_invitation");
    assert.equal(pendingNotice.title, "프로젝트 초대가 도착했습니다.");
    assert.equal(pendingNotice.body, "초대하는 사람님이 ‘수락 확인 프로젝트’ 프로젝트에 초대했습니다.");
    assert.equal(pendingNotice.projectName, "수락 확인 프로젝트");
    assert.equal(pendingNotice.inviterName, "초대하는 사람");
    assert.equal(pendingNotice.invitationId, pendingInvitationId);
    assert.equal(pendingNotice.invitationStatus, "pending");
    assert.equal(pendingNotice.canAccept, true);
    assert.equal(pendingNotice.canOpenProject, false);
    assert.equal(pendingNotice.targetPath, "/workspace");
    assert.equal(pendingNotice.readAt, null);
    assert.equal(betaInitial.payload.unreadCount, 1, "the invitation is included in the existing unread badge count");
    assert.equal((await request("/api/notifications", { cookie: accountC.cookie })).payload.notifications.length, 0, "unrelated C does not see B's invitation");

    const invitationListBeforeAccept = await request("/api/invitations", { cookie: accountB.cookie });
    assert.equal(invitationListBeforeAccept.payload.invitations.length, 1);
    assert.equal(invitationListBeforeAccept.payload.invitations[0].status, "pending");
    assert.equal(invitationListBeforeAccept.payload.invitations[0].canAccept, true);
    assert.equal((await request(`/api/projects/${acceptedProject.id}`, { cookie: accountB.cookie })).response.status, 404, "pending invitees cannot read project documents or requirements");
    assert.equal((await request(`/api/projects/${acceptedProject.id}/members`, { cookie: accountB.cookie })).response.status, 404);
    assert.equal((await request("/api/analyze", {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: { projectId: acceptedProject.id },
    })).response.status, 404, "pending invitees cannot run or read analysis through protected APIs");

    for (let refresh = 0; refresh < 3; refresh += 1) {
      const repeated = await request("/api/notifications", { cookie: accountB.cookie });
      assert.equal(repeated.payload.notifications.filter((item) => item.invitationId === pendingInvitationId).length, 1, "refreshes do not duplicate an invitation alert");
    }
    const readPending = await request(`/api/notifications/${encodeURIComponent(pendingNotice.id)}/read`, {
      method: "PATCH",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: { userId: accountC.user.id },
    });
    assert.equal(readPending.response.status, 200);
    assert.equal(readPending.payload.notification.invitationStatus, "pending", "reading only changes the alert's read state");
    assert.ok(readPending.payload.notification.readAt);
    assert.equal(readPending.payload.unreadCount, 0);
    assert.equal((await request(`/api/notifications/${encodeURIComponent(pendingNotice.id)}/read`, {
      method: "PATCH",
      cookie: accountC.cookie,
      csrf: accountC.csrfToken,
      body: {},
    })).response.status, 404, "another account cannot read B's invitation alert");

    const database = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    assert.equal(database.prepare("SELECT status FROM project_invitations WHERE id = ?").get(pendingInvitationId).status, "pending");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM project_memberships WHERE project_id = ? AND user_id = ?")
      .get(acceptedProject.id, accountB.user.id).count, 0, "reading an invitation does not create project membership");
    database.close();

    const accepted = await request(`/api/invitations/${encodeURIComponent(pendingInvitationId)}/accept`, {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: {},
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.payload.status, "accepted");
    const acceptedNotice = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .find((item) => item.invitationId === pendingInvitationId);
    assert.equal(acceptedNotice.invitationStatus, "accepted");
    assert.equal(acceptedNotice.canAccept, false);
    assert.equal(acceptedNotice.canOpenProject, true);
    assert.ok(acceptedNotice.readAt, "accepting also marks the invitation alert read");
    assert.equal((await request(`/api/projects/${acceptedProject.id}`, { cookie: accountB.cookie })).response.status, 200);
    const acceptedListItem = (await request("/api/invitations", { cookie: accountB.cookie })).payload.invitations
      .find((item) => item.id === pendingInvitationId);
    assert.equal(acceptedListItem.status, "accepted");
    assert.equal(acceptedListItem.canAccept, false);
    assert.equal(acceptedListItem.canOpenProject, true);
    assert.equal((await sendInvitation(accountA, acceptedProject.id, "invite_beta")).response.status, 409, "members cannot be invited again");
    assert.equal((await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .filter((item) => item.projectId === acceptedProject.id && item.type === "project_invitation").length, 1, "failed member re-invites do not add another alert");

    const declineProject = await createProject(accountA, "invite-decline-project", "거절 확인 프로젝트");
    const declineInvite = await sendInvitation(accountA, declineProject.id, "invite_beta");
    assert.equal(declineInvite.response.status, 201);
    const declineId = declineInvite.payload.invitation.id;
    const declineNoticeBefore = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .find((item) => item.invitationId === declineId);
    assert.equal(declineNoticeBefore.invitationStatus, "pending");
    const declined = await request(`/api/invitations/${encodeURIComponent(declineId)}/decline`, {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: {},
    });
    assert.equal(declined.response.status, 200);
    assert.equal(declined.payload.status, "declined");
    const declinedNotice = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .find((item) => item.invitationId === declineId);
    assert.equal(declinedNotice.invitationStatus, "declined");
    assert.equal(declinedNotice.canAccept, false);
    assert.ok(declinedNotice.readAt, "declining marks the related invitation alert read");
    assert.equal((await request(`/api/invitations/${encodeURIComponent(declineId)}/accept`, {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: {},
    })).response.status, 404, "declined invitations cannot be accepted");
    assert.equal((await request(`/api/projects/${declineProject.id}`, { cookie: accountB.cookie })).response.status, 404);

    const reinvitedB = await sendInvitation(accountA, declineProject.id, "invite_beta");
    assert.equal(reinvitedB.response.status, 201, "a declined invitation can be sent again as a new invitation");
    const reinvitedId = reinvitedB.payload.invitation.id;
    assert.notEqual(reinvitedId, declineId);
    const declineProjectNotices = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .filter((item) => item.projectId === declineProject.id && item.type === "project_invitation");
    assert.equal(declineProjectNotices.length, 2);
    assert.equal(declineProjectNotices.find((item) => item.invitationId === declineId).invitationStatus, "declined");
    assert.equal(declineProjectNotices.find((item) => item.invitationId === reinvitedId).invitationStatus, "pending");
    const reinviteDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    assert.equal(reinviteDb.prepare("SELECT COUNT(DISTINCT event_key) AS count FROM project_notifications WHERE recipient_id = ? AND project_id = ? AND event_type = 'project_invitation'")
      .get(accountB.user.id, declineProject.id).count, 2, "the two invitation events remain distinct in storage");
    reinviteDb.close();
    assert.equal((await request(`/api/invitations/${encodeURIComponent(reinvitedId)}/accept`, {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: {},
    })).response.status, 200);

    const fallbackNameProject = await createProject(accountC, "invite-fallback-name-project", "아이디 표시 초대 프로젝트");
    const fallbackNameInvite = await sendInvitation(accountC, fallbackNameProject.id, "invite_beta");
    assert.equal(fallbackNameInvite.response.status, 201);
    const fallbackNameNotice = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .find((item) => item.invitationId === fallbackNameInvite.payload.invitation.id);
    assert.equal(fallbackNameNotice.body, "invite_charlie님이 ‘아이디 표시 초대 프로젝트’ 프로젝트에 초대했습니다.", "the inviter username is used when no display name is set");

    const cancelProject = await createProject(accountA, "invite-cancel-project", "취소 확인 프로젝트");
    const cancelInvite = await sendInvitation(accountA, cancelProject.id, "invite_charlie");
    assert.equal(cancelInvite.response.status, 201);
    const cancelId = cancelInvite.payload.invitation.id;
    const canceled = await request(`/api/projects/${cancelProject.id}/invitations/${encodeURIComponent(cancelId)}`, {
      method: "DELETE",
      cookie: accountA.cookie,
      csrf: accountA.csrfToken,
    });
    assert.equal(canceled.response.status, 200);
    assert.equal(canceled.payload.status, "revoked");
    const canceledNotice = (await request("/api/notifications", { cookie: accountC.cookie })).payload.notifications
      .find((item) => item.invitationId === cancelId);
    assert.equal(canceledNotice.invitationStatus, "revoked");
    assert.equal(canceledNotice.canAccept, false);
    assert.ok(canceledNotice.readAt, "sender cancellation marks the recipient's alert read");
    assert.equal((await request(`/api/invitations/${encodeURIComponent(cancelId)}/accept`, {
      method: "POST",
      cookie: accountC.cookie,
      csrf: accountC.csrfToken,
      body: {},
    })).response.status, 404, "a canceled invite cannot be accepted");

    const reinvitedC = await sendInvitation(accountA, cancelProject.id, "invite_charlie");
    assert.equal(reinvitedC.response.status, 201, "a canceled invitation can be reissued as a new invitation");
    const reinvitedCId = reinvitedC.payload.invitation.id;
    assert.notEqual(reinvitedCId, cancelId);
    const charlieCancelProjectNotices = (await request("/api/notifications", { cookie: accountC.cookie })).payload.notifications
      .filter((item) => item.projectId === cancelProject.id);
    assert.equal(charlieCancelProjectNotices.length, 2);
    assert.equal(charlieCancelProjectNotices.find((item) => item.invitationId === cancelId).invitationStatus, "revoked");
    assert.equal(charlieCancelProjectNotices.find((item) => item.invitationId === reinvitedCId).invitationStatus, "pending");

    const deleteProject = await createProject(accountA, "invite-deleted-project", "삭제된 프로젝트 초대");
    const deleteInvite = await sendInvitation(accountA, deleteProject.id, "invite_beta");
    assert.equal(deleteInvite.response.status, 201);
    const deleteInvitationId = deleteInvite.payload.invitation.id;
    const deleted = await request(`/api/projects/${deleteProject.id}`, {
      method: "DELETE",
      cookie: accountA.cookie,
      csrf: accountA.csrfToken,
      body: { expectedVersion: deleteProject.serverVersion },
    });
    assert.equal(deleted.response.status, 200);
    const deletedNotice = (await request("/api/notifications", { cookie: accountB.cookie })).payload.notifications
      .find((item) => item.invitationId === deleteInvitationId);
    assert.equal(deletedNotice.projectName, "삭제된 프로젝트 초대");
    assert.equal(deletedNotice.invitationStatus, "project_deleted");
    assert.equal(deletedNotice.canAccept, false);
    assert.equal(deletedNotice.canOpenProject, false);
    assert.ok(deletedNotice.readAt, "project deletion clears the pending invite badge");
    const deletedListItem = (await request("/api/invitations", { cookie: accountB.cookie })).payload.invitations
      .find((item) => item.id === deleteInvitationId);
    assert.equal(deletedListItem.status, "project_deleted");
    assert.equal(deletedListItem.canAccept, false);
    assert.equal((await request(`/api/projects/${deleteProject.id}`, { cookie: accountB.cookie })).response.status, 404);
    assert.equal((await request(`/api/invitations/${encodeURIComponent(deleteInvitationId)}/accept`, {
      method: "POST",
      cookie: accountB.cookie,
      csrf: accountB.csrfToken,
      body: {},
    })).response.status, 404);

    const rollbackProject = await createProject(accountA, "invite-rollback-project", "초대 롤백 프로젝트");
    const triggerDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    triggerDb.exec(`CREATE TRIGGER fail_invitation_notification BEFORE INSERT ON project_notifications
      WHEN NEW.event_type = 'project_invitation' BEGIN SELECT RAISE(ABORT, 'forced invitation notification failure'); END;`);
    triggerDb.close();
    const failedInvitation = await sendInvitation(accountA, rollbackProject.id, "invite_charlie");
    assert.equal(failedInvitation.response.status, 500, "a notification write failure fails the invitation transaction");
    const rollbackDb = new (require("node:sqlite").DatabaseSync)(path.join(temporaryRoot, "data", "projects.sqlite"));
    rollbackDb.exec("DROP TRIGGER fail_invitation_notification");
    assert.equal(rollbackDb.prepare("SELECT COUNT(*) AS count FROM project_invitations WHERE project_id = ?").get(rollbackProject.id).count, 0, "failed notification storage rolls back the invitation");
    rollbackDb.close();
    assert.equal((await request("/api/notifications", { cookie: accountC.cookie })).payload.notifications
      .some((item) => item.projectId === rollbackProject.id), false);

    const offlineProject = await createProject(accountA, "invite-offline-project", "로그아웃 중 초대 프로젝트");
    const logoutC = await request("/api/auth/logout", {
      method: "POST",
      cookie: accountC.cookie,
      csrf: accountC.csrfToken,
      body: {},
    });
    assert.equal(logoutC.response.status, 200);
    assert.equal((await sendInvitation(accountA, offlineProject.id, "invite_charlie")).response.status, 201);
    assert.equal((await request("/api/notifications", { cookie: logoutC.cookie })).response.status, 401, "logged-out accounts cannot query alerts");

    await stopServer(server);
    server = startIsolatedServer(temporaryRoot, port);
    await waitForServer(server, origin);
    const loginC = await request("/api/auth/login", {
      method: "POST",
      body: { username: "invite_charlie", password: "invite77" },
    });
    assert.equal(loginC.response.status, 200);
    const afterLoginC = await request("/api/notifications", { cookie: loginC.cookie });
    assert.equal(afterLoginC.response.status, 200);
    const offlineNotice = afterLoginC.payload.notifications.find((item) => item.projectId === offlineProject.id);
    assert.equal(offlineNotice.invitationStatus, "pending", "an invite received while logged out appears on the next authenticated refresh");
    assert.equal(offlineNotice.readAt, null);
    assert.equal(afterLoginC.payload.notifications.filter((item) => item.invitationId === reinvitedCId).length, 1);
    const cInvitationHistory = (await request("/api/invitations", { cookie: loginC.cookie })).payload.invitations;
    assert.equal(cInvitationHistory.find((item) => item.id === cancelId).status, "revoked", "read and canceled state survives restart and re-login");
    assert.equal(cInvitationHistory.find((item) => item.id === reinvitedCId).status, "pending");

    const loginB = await request("/api/auth/login", {
      method: "POST",
      body: { username: "invite_beta", password: "invite77" },
    });
    assert.equal(loginB.response.status, 200);
    const afterRestartB = await request("/api/notifications", { cookie: loginB.cookie });
    assert.equal(afterRestartB.payload.notifications.find((item) => item.invitationId === pendingInvitationId).invitationStatus, "accepted");
    assert.ok(afterRestartB.payload.notifications.find((item) => item.invitationId === pendingInvitationId).readAt, "accepted invite read state persists across restart and re-login");
    assert.equal(afterRestartB.payload.notifications.find((item) => item.invitationId === declineId).invitationStatus, "declined");
    assert.equal(afterRestartB.payload.notifications.find((item) => item.invitationId === deleteInvitationId).invitationStatus, "project_deleted");
  } finally {
    await stopServer(server);
  }
});

test("legacy invitation and notification tables migrate without losing stored records", { timeout: 20_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-invitation-migration-test-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(temporaryRoot, "server.js"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const ownerId = "legacy-invite-owner-id";
  const inviteeId = "legacy-invitee-id";
  const password = "legacy77";
  const createdAt = "2025-04-01T10:00:00.000Z";
  const makeLegacyPassword = () => {
    const salt = crypto.randomBytes(16).toString("base64url");
    const hash = crypto.scryptSync(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
    return { salt, hash };
  };
  const legacyUsersDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "users.sqlite"));
  legacyUsersDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username_key TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
  for (const [id, username] of [[ownerId, "legacy_owner"], [inviteeId, "legacy_invitee"]]) {
    const { salt, hash } = makeLegacyPassword();
    legacyUsersDb.prepare(`INSERT INTO users (id, username_key, username, salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, username, username, salt, hash, createdAt);
  }
  legacyUsersDb.close();

  const storedProject = { id: "legacy-invite-project", name: "이전 프로젝트", client: "기존 고객사", summary: "이전 데이터 보존" };
  const legacyProjectsDb = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "projects.sqlite"));
  legacyProjectsDb.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE project_invitations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      invited_user_id TEXT NOT NULL,
      invited_by_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE UNIQUE INDEX project_invitations_pending_idx
      ON project_invitations(project_id, invited_user_id) WHERE status = 'pending';
    CREATE INDEX project_invitations_user_idx ON project_invitations(invited_user_id, status, created_at DESC);
    CREATE TABLE project_notifications (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('analysis_completed', 'comparison_completed', 'review_followup')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      target_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT,
      UNIQUE (recipient_id, event_key)
    );
    CREATE INDEX project_notifications_recipient_recent_idx ON project_notifications(recipient_id, created_at DESC);
    CREATE INDEX project_notifications_project_event_idx ON project_notifications(project_id, event_type, created_at DESC);
  `);
  legacyProjectsDb.prepare(`INSERT INTO projects (id, owner_id, version, data_json, created_at, updated_at)
    VALUES (?, ?, 3, ?, ?, ?)`).run(storedProject.id, ownerId, JSON.stringify(storedProject), createdAt, createdAt);
  legacyProjectsDb.prepare(`INSERT INTO project_invitations (id, project_id, invited_user_id, invited_by_user_id, status, created_at)
    VALUES ('legacy-pending-invitation', ?, ?, ?, 'pending', ?)`).run(storedProject.id, inviteeId, ownerId, createdAt);
  legacyProjectsDb.prepare(`INSERT INTO project_notifications (
    id, recipient_id, project_id, event_key, event_type, title, body, target_path, created_at
  ) VALUES ('legacy-analysis-notice', ?, ?, 'analysis:legacy:3', 'analysis_completed', '기존 분석', '보존된 알림', '/projects/legacy-invite-project/extract', ?)`)
    .run(ownerId, storedProject.id, createdAt);
  legacyProjectsDb.close();

  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const request = createRequester(origin);
  let server = startIsolatedServer(temporaryRoot, port);
  try {
    await waitForServer(server, origin);
    const owner = await request("/api/auth/login", { method: "POST", body: { username: "legacy_owner", password } });
    const invitee = await request("/api/auth/login", { method: "POST", body: { username: "legacy_invitee", password } });
    assert.equal(owner.response.status, 200);
    assert.equal(invitee.response.status, 200);
    const oldNotice = await request("/api/notifications", { cookie: owner.cookie });
    assert.equal(oldNotice.payload.notifications.length, 1);
    assert.equal(oldNotice.payload.notifications[0].title, "기존 분석");
    const oldInvitation = await request("/api/invitations", { cookie: invitee.cookie });
    assert.equal(oldInvitation.payload.invitations.length, 1);
    assert.equal(oldInvitation.payload.invitations[0].id, "legacy-pending-invitation");
    assert.equal(oldInvitation.payload.invitations[0].projectName, storedProject.name);

    const declined = await request("/api/invitations/legacy-pending-invitation/decline", {
      method: "POST",
      cookie: invitee.cookie,
      csrf: invitee.payload.csrfToken,
      body: {},
    });
    assert.equal(declined.response.status, 200, "migrated invitation rows accept the new declined state");
    assert.equal(declined.payload.status, "declined");

    const db = new (require("node:sqlite").DatabaseSync)(path.join(dataDirectory, "projects.sqlite"));
    assert.equal(db.prepare("SELECT title FROM project_notifications WHERE id = 'legacy-analysis-notice'").get().title, "기존 분석");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_list('project_notifications')").get().count, 0, "invitation history can outlive a deleted project");
    assert.equal(db.prepare("SELECT status FROM project_invitations WHERE id = 'legacy-pending-invitation'").get().status, "declined");
    db.close();
  } finally {
    await stopServer(server);
  }
});

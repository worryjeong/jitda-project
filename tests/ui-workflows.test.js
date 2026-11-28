"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");

const indexPath = path.join(__dirname, "..", "index.html");

test("project detail only displays team members; My Page owns team controls", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const teamPanel = html.match(/<section class="detail-panel" aria-labelledby="team-heading">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(teamPanel, "project details include the team display panel");
  assert.match(teamPanel, /id="project-team-list"/u);
  assert.doesNotMatch(teamPanel, /<form|추방|초대 보내기|초대 수락/u);
  assert.match(html, /memberList\.insertAdjacentHTML\("beforeend", '<p class="team-empty">아직 참여 중인 팀원이 없습니다\. <a href="#\/workspace">프로젝트 초대 관리에서 초대를 보내고 관리할 수 있습니다\.<\/a><\/p>'\)/u);

  assert.match(html, /id="mypage-view"/u);
  assert.match(html, /id="mypage-profile-panel"/u);
  assert.match(html, /id="mypage-profile-form"/u);
  assert.match(html, /id="mypage-display-name"/u);
  assert.match(html, /id="mypage-bio"/u);
  assert.match(html, /id="mypage-owned-count"/u);
  assert.match(html, /id="mypage-shared-count"/u);
  assert.match(html, /href="#\/workspace">프로젝트 초대 관리/u);
  assert.match(html, /id="mypage-logout-button"/u);
  assert.match(html, /id="mypage-team-management" hidden/u);
  assert.match(html, /id="pending-invitations-list"/u);
  assert.match(html, /id="mypage-owned-projects"/u);
  assert.match(html, /data-mypage-invite-form/u);
  assert.match(html, /data-remove-member/u);
  assert.match(html, /apiRequest\("\/api\/auth\/profile", \{[\s\S]*?method: "PATCH"/u);
  assert.match(html, /elements\.mypageProfilePanel\.hidden = isWorkspaceRoute/u);
  assert.match(html, /elements\.mypageTeamManagement\.hidden = !isWorkspaceRoute/u);
  assert.match(html, /href="#\/mypage"/u);
});

test("analysis saves are serialized and can rebase once after a version conflict", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  assert.match(html, /const projectSaveQueues = new Map\(\)/u);
  assert.match(html, /async function persistAnalysisProjectWithConflictRecovery/u);
  assert.match(html, /apiRequest\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}`\)/u);
  assert.match(html, /return await persistProject\(liveProject\)/u);
});

test("update plan generation is below comparison results and cites both source types", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const resultsMarkup = html.match(/<div id="comparison-results" hidden>([\s\S]*?)<\/div>\s*<\/section>/u)?.[1];
  assert.ok(resultsMarkup, "comparison page has a results section");
  assert.ok(resultsMarkup.indexOf("id=\"comparison-result-list\"") < resultsMarkup.indexOf("id=\"comparison-update-action\""));
  assert.match(resultsMarkup, /기획서 업데이트안 생성/u);
  assert.match(resultsMarkup, /id="comparison-update-citations"/u);
  assert.match(html, /evidenceExistsInMeetingDocuments\(project, evidence\)\s*\|\|\s*evidenceExistsInSpecificationDocuments\(project, evidence\)/u);
  assert.match(html, /프로젝트 데이터는 계정별로 서버에 저장됩니다\./u);
});

test("home profile links have a visible My Page button and workspace invitation links reuse the existing view", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const profileGroup = html.match(/<div class="profile-action-group"[\s\S]*?<\/div>\s*<\/div>/u)?.[0];
  assert.ok(profileGroup, "home header groups the avatar and My Page button");
  assert.match(profileGroup, /<span class="user-chip" aria-hidden="true">/u);
  assert.doesNotMatch(profileGroup, /user-chip[^>]*href/u);
  assert.match(profileGroup, /id="home-mypage-button" href="#\/mypage">마이페이지/u);
  assert.match(html, /<div class="sidebar-profile-display" id="sidebar-profile-display">/u);
  assert.doesNotMatch(html, /id="sidebar-profile-link" href="#\/mypage"/u);

  assert.match(html, /id="workspace-switcher" href="#\/projects" aria-label="전체 프로젝트 목록으로 이동"/u);
  assert.match(html, /id="sidebar-projects-mobile" href="#\/projects" aria-label="전체 프로젝트 목록으로 이동">계정별 프로젝트<\/a>/u);
  assert.match(html, /id="sidebar-workspace-manage" href="#\/workspace" hidden/u);
  assert.match(html, /id="sidebar-workspace-mobile" href="#\/workspace" hidden/u);
  assert.match(html, /elements\.workspaceManageLink\.hidden = !currentUser/u);
  assert.match(html, /elements\.workspaceManageMobile\.hidden = !currentUser/u);
  assert.match(html, /currentUser && route === "\/projects"/u);
  assert.match(html, /route === "\/mypage" \|\| route === "\/workspace"/u);
  assert.match(html, /link\.setAttribute\("aria-current", "page"\)/u);
  assert.match(html, /\.sidebar-workspace-manage\[aria-current="page"\]/u);
  assert.match(html, /\.sidebar-workspace-mobile\[aria-current="page"\]/u);
});

test("the review guide stays public while a successful login returns to the home page", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  assert.match(html, /if \(!currentUser && route !== "\/guide"\)/u);
  assert.match(html, /if \(route === "\/guide"\)\s*\{[\s\S]*?elements\.guide\.hidden = false/u);
  assert.match(html, /initializeAuthenticatedSession\(session, \{ redirectToHome: true \}\)/u);
  assert.match(html, /if \(options\.redirectToHome\) replaceRoute\("\/"\)/u);
});

test("logout replaces history with the public root and blocks protected routes after session cleanup", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  assert.match(html, /function replaceRoute\(path\)[\s\S]*?window\.history\.replaceState/u);
  assert.match(html, /function clearClientAuthentication\(\)[\s\S]*?currentUser = null;[\s\S]*?csrfToken = "";[\s\S]*?projects = \[\];[\s\S]*?persistedProjectSnapshots\.clear\(\)/u);
  assert.match(html, /async function logoutAndReturnToDashboard\(\)[\s\S]*?apiRequest\("\/api\/auth\/logout"[\s\S]*?finishLogoutNavigation\(\)/u);
  assert.match(html, /function finishLogoutNavigation\(\)[\s\S]*?replaceRoute\("\/"\)[\s\S]*?renderRoute\(\)/u);
  assert.match(html, /if \(!currentUser && route !== "\/guide"\)\s*\{\s*if \(rawRoute && rawRoute !== "\/"\) replaceRoute\("\/"\)/u);
  assert.match(html, /elements\.logoutButton\.addEventListener\("click", logoutAndReturnToDashboard\)/u);
  assert.match(html, /elements\.mypageLogoutButton\.addEventListener\("click", logoutAndReturnToDashboard\)/u);
  assert.match(html, /id="sidebar-logout-mobile"[^>]*hidden/u);
  assert.match(html, /elements\.sidebarLogoutMobile\.hidden = !currentUser/u);
  assert.match(html, /elements\.sidebarLogoutMobile\.addEventListener\("click", logoutAndReturnToDashboard\)/u);
  assert.match(html, /window\.addEventListener\("pageshow", \(event\) =>\s*\{\s*if \(event\.persisted\) bootstrapAuthentication\(\)/u);
});

test("new account passwords are limited to twelve characters and projects page links back to dashboard", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  assert.match(html, /id="register-password"[^>]*minlength="7" maxlength="12"/u);
  assert.match(html, /id="register-password-confirm"[^>]*minlength="7" maxlength="12"/u);
  assert.match(html, /7~12자로 입력해 주세요\./u);
  assert.match(html, /<a class="button-secondary" href="#\/">대시보드로 돌아가기<\/a>/u);
});

test("notification dropdown is accessible, user-scoped, refreshes on supported triggers, and avoids polling timers", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  const markup = html.match(/<div class="notification-wrapper" id="notification-wrapper">([\s\S]*?)<\/div>\s*<div class="profile-action-group"/u)?.[1];
  assert.ok(markup, "dashboard contains the notification control and dropdown panel");
  assert.match(markup, /<button class="utility-icon notification-trigger"[^>]*aria-haspopup="true"[^>]*aria-controls="notification-panel"/u);
  assert.match(markup, /class="notification-panel" id="notification-panel"[^>]*hidden/u);
  assert.match(markup, /data-notification-filter="all"/u);
  assert.match(markup, /data-notification-filter="unread"/u);
  assert.match(markup, /id="notification-mark-all"/u);
  assert.match(html, /count > 99 \? "99\+"/u);
  assert.match(server, /CREATE TABLE IF NOT EXISTS project_notifications/u);
  assert.match(server, /function notificationRowsForUser\(userId\)/u);
  assert.match(server, /n\.recipient_id = \? AND \([\s\S]*?n\.event_type = 'project_invitation'[\s\S]*?p\.owner_id = \? OR m\.user_id = \?/u);
  assert.match(server, /function insertNotificationsForSavedProject/u);
  assert.match(server, /function createDueReviewFollowupForUser/u);
  assert.match(server, /24 \* 60 \* 60 \* 1000/u);
  assert.match(html, /document\.addEventListener\("pointerdown"/u);
  assert.match(html, /window\.addEventListener\("keydown"|document\.addEventListener\("keydown"/u);
  assert.match(html, /await refreshNotifications\(\{ silent: true \}\)/u);
  assert.match(html, /if \(shouldOpen\)\s*\{[\s\S]*?refreshNotifications\(\)/u);
  assert.match(html, /Number\(payload\.notificationsCreated\) > 0\) void refreshNotifications/u);
  assert.doesNotMatch(html, /setInterval\([^)]*notification/iu);
});

test("project invitation alerts reuse the dropdown and focus the matching invitation", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const server = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /event_type TEXT NOT NULL CHECK \(event_type IN \([^)]*project_invitation/u);
  assert.match(server, /function createProjectInvitation\([\s\S]*?BEGIN IMMEDIATE[\s\S]*?INSERT INTO project_invitations[\s\S]*?INSERT INTO project_notifications[\s\S]*?COMMIT/u);
  assert.match(server, /function declineProjectInvitation/u);
  assert.match(server, /function revokeProjectInvitation/u);
  assert.match(server, /function markInvitationNotificationsRead/u);
  assert.match(server, /function notificationRowsForUser\([\s\S]*?i\.status AS invitation_status/u);
  assert.match(server, /n\.event_type = 'project_invitation'/u);
  assert.match(server, /event_type = 'project_invitation'\s+OR EXISTS/u);

  assert.match(html, /notification-type-icon/u);
  assert.match(html, /notification\.type === "project_invitation" \? "✉" : ""/u);
  assert.match(html, /function invitationStatusLabel\([\s\S]*?수락 완료[\s\S]*?거절한 초대[\s\S]*?취소된 초대[\s\S]*?삭제된 프로젝트의 초대/u);
  assert.match(html, /data-decline-invitation=/u);
  assert.match(html, /data-cancel-invitation=/u);
  assert.match(html, /function focusWorkspaceInvitation\([\s\S]*?invitation-highlight[\s\S]*?scrollIntoView/u);
  assert.match(html, /setRoute\(`\/workspace#invitation-\$\{encodeURIComponent\(latestNotification\.invitationId\)\}`\)/u);
  assert.match(html, /latestNotification\.invitationStatus === "accepted" && latestNotification\.canOpenProject/u);
  const clickHandlerStart = html.indexOf('elements.notificationList.addEventListener("click"');
  const clickHandlerEnd = html.indexOf('document.addEventListener("pointerdown"', clickHandlerStart);
  const clickHandler = html.slice(clickHandlerStart, clickHandlerEnd);
  assert.match(clickHandler, /\/api\/notifications\/\$\{encodeURIComponent\(notification\.id\)\}\/read/u);
  assert.doesNotMatch(clickHandler, /\/api\/invitations\/[^\n]*\/accept/u, "opening an alert must not accept the invite");
});

test("public guide, account projects link, and overview copy keep only actual public information", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const guideStart = html.indexOf('<section class="view guide-view" id="guide-view"');
  const guideEnd = html.indexOf("</section>", html.indexOf('id="guide-finish"', guideStart));
  const guide = html.slice(guideStart, guideEnd > guideStart ? guideEnd : undefined);
  assert.match(html, /if \(!currentUser && route !== "\/guide"\)/u);
  assert.match(guide, /회의별로 날짜와 내용을 입력/u);
  assert.match(guide, /원본 업로드 파일 자체를 보관하지 않습니다/u);
  assert.match(guide, /문서·요구사항 검색/u);
  assert.match(guide, /분석 실패나 시간 초과/u);
  assert.match(guide, /확정 요청과 단순 제안/u);
  assert.match(guide, /규칙 기반 판단/u);
  assert.doesNotMatch(guide, /notification_owner|sample-monomarket|users\.sqlite/u);
  const routeStart = html.indexOf("function renderRoute()");
  const routeEnd = html.indexOf("function", routeStart + 20);
  const routeRenderer = html.slice(routeStart, routeEnd);
  assert.match(routeRenderer, /if \(currentUser\)\s*\{\s*renderProjectLists\(\);\s*\}\s*else\s*\{[\s\S]*?elements\.recentList\.replaceChildren\(\)/u);
});

test("the existing project-list search stays within project name, client, and summary fields", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const start = html.indexOf("function renderProjectLists()");
  const end = html.indexOf("function statusBadge", start);
  const renderer = html.slice(start, end);
  assert.match(renderer, /\[project\.name, project\.client, project\.summary\]/u);
  assert.match(renderer, /elements\.allList\.innerHTML = matching\.map/u);
  assert.match(html, /id="project-search" type="search"/u);
});

test("extraction search controls are labeled, ordered beside AI analysis, and use safe DOM text rendering", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const toolbarStart = html.indexOf('<div class="extraction-header-actions"');
  const resultsStart = html.indexOf('<section class="extraction-search-results"', toolbarStart);
  assert.ok(toolbarStart >= 0 && resultsStart > toolbarStart);
  const toolbar = html.slice(toolbarStart, resultsStart);
  const searchInputIndex = toolbar.indexOf('id="extraction-search-input" type="search"');
  const scopeIndex = toolbar.indexOf('id="extraction-search-scope"');
  const clearIndex = toolbar.indexOf('id="extraction-search-clear"');
  const analysisIndex = toolbar.indexOf('id="run-ai-analysis"');
  assert.ok(searchInputIndex >= 0 && searchInputIndex < scopeIndex && scopeIndex < clearIndex && clearIndex < analysisIndex);
  assert.match(toolbar, /<label for="extraction-search-input">문서·요구사항 검색<\/label>/u);
  assert.match(toolbar, /<label for="extraction-search-scope">검색 범위<\/label>/u);
  assert.match(toolbar, /placeholder="내용, 문서명, 날짜 검색"/u);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/u);
  assert.match(html, /검색 결과 더 보기/u);
  assert.match(html, /<script src="\/extraction-search\.js"><\/script>/u);

  const rendererStart = html.indexOf("function appendSearchHighlight");
  const rendererEnd = html.indexOf("function renderExtractionSearchResults", rendererStart);
  const safeRenderer = html.slice(rendererStart, rendererEnd);
  assert.match(safeRenderer, /document\.createElement\("mark"\)/u);
  assert.match(safeRenderer, /textContent\s*=/u);
  assert.doesNotMatch(safeRenderer, /innerHTML|insertAdjacentHTML/u);
  assert.match(html, /window\.setTimeout\(run, 160\)/u);
  assert.match(html, /event\.key !== "Escape"/u);
});

test("extraction shows saved specification text and links update proposals to comparison", async () => {
  const html = await fs.readFile(indexPath, "utf8");
  const rendererStart = html.indexOf("function displaySpecificationText");
  const rendererEnd = html.indexOf("function appendSearchHighlight", rendererStart);
  const specificationRenderer = html.slice(rendererStart, rendererEnd);
  assert.match(specificationRenderer, /function displaySpecificationText\(content\)[\s\S]*?replace\(\/\[\^\\S\\r\\n\]\+\/gu, " "\)/u);
  assert.match(specificationRenderer, /split\(\/\\r\\n\|\\n\|\\r\/u\)\.slice\(0, 10\)/u);
  assert.match(specificationRenderer, /<summary>전체 내용 보기<\/summary>/u);
  assert.match(specificationRenderer, /escapeHtml\(preview\)/u);
  assert.match(specificationRenderer, /escapeHtml\(content\)/u);
  const specificationHelpers = new Function("escapeHtml", `${specificationRenderer}; return { displaySpecificationText, renderSpecificationPreview };`)(
    (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
  );
  const originalText = "청솔   빛축제\r\n두 번째 줄  이어쓰기\n<script>원문</script>";
  assert.equal(specificationHelpers.displaySpecificationText(originalText), "청솔 빛축제\r\n두 번째 줄 이어쓰기\n<script>원문</script>");
  const previewMarkup = specificationHelpers.renderSpecificationPreview({ name: "기획서.pdf", content: originalText });
  assert.match(previewMarkup, /청솔 빛축제/u);
  assert.match(previewMarkup, /&lt;script&gt;원문&lt;\/script&gt;/u);
  assert.doesNotMatch(previewMarkup, /<script>/u, "specification text is displayed as escaped text");

  const extractionStart = html.indexOf("function renderExtraction(project)");
  const extractionEnd = html.indexOf("const reviewStatusLabels", extractionStart);
  const extractionRenderer = html.slice(extractionStart, extractionEnd);
  assert.match(extractionRenderer, /const specDocuments = .*kind === "spec"/u);
  assert.match(extractionRenderer, /if \(hasSpecDocument\) elements\.specExtractionList\.innerHTML = renderSpecificationPreview\(specDocument\)/u);
  assert.match(extractionRenderer, /hasSpecDocument \? `\$\{specDocuments\.length\}개 등록`/u);
  assert.match(extractionRenderer, /기획서 \$\{specDocuments\.length\}개 등록/u);
  assert.match(extractionRenderer, /elements\.specComparisonLink\.href = `#\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/compare`/u);
  assert.match(extractionRenderer, /update \? "저장된 업데이트안 보기" : "기획서 비교로 이동"/u);
  assert.match(extractionRenderer, /elements\.specDraftPanel\.hidden = !draft/u, "projects without a specification retain the AI draft panel");

  const extractionMarkup = html.match(/<section class="view" id="extraction-view"[\s\S]*?<section class="view" id="review-view"/u)?.[0];
  assert.ok(extractionMarkup);
  assert.match(extractionMarkup, /기획서 비교와 업데이트안은 요구사항 확정 후 '기획서 비교' 화면에서 확인할 수 있습니다\./u);
  assert.match(extractionMarkup, /id="spec-comparison-link"/u);
  assert.doesNotMatch(extractionMarkup, /spec-update-content|save-spec-update|아직 추출한 요구사항이 없습니다/u);
  assert.match(html, /comparisonUpdatePreviewContent\.value = updateProposal\?\.content/u);
  assert.match(html, /elements\.comparisonResults\.hidden = !hasSavedResults && !hasUpdateProposal/u);
  assert.match(html, /elements\.comparisonUpdateSave\.addEventListener\("click"/u);
});

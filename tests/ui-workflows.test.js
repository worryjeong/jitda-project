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

  assert.match(html, /id="mypage-view"/u);
  assert.match(html, /id="pending-invitations-list"/u);
  assert.match(html, /id="mypage-owned-projects"/u);
  assert.match(html, /data-mypage-invite-form/u);
  assert.match(html, /data-remove-member/u);
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

  assert.match(html, /id="workspace-switcher" href="#\/workspace"/u);
  assert.match(html, /id="sidebar-workspace-manage" href="#\/workspace" hidden/u);
  assert.match(html, /id="sidebar-workspace-mobile" href="#\/workspace" hidden/u);
  assert.match(html, /elements\.workspaceManageLink\.hidden = !currentUser/u);
  assert.match(html, /elements\.workspaceManageMobile\.hidden = !currentUser/u);
  assert.match(html, /currentUser && route === "\/workspace"/u);
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
  assert.match(html, /if \(options\.redirectToHome\) window\.location\.hash = "\/home"/u);
});

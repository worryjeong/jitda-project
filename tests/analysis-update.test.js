"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
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

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function chatCompletion(analysis) {
  return {
    choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 0 } },
  };
}

test("new-project analysis survives a concurrent save and update generation uses confirmed comparison", { timeout: 30_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "specguard-analysis-race-test-"));
  const dataDirectory = path.join(temporaryRoot, "data");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.copyFile(path.join(__dirname, "..", "server.js"), path.join(temporaryRoot, "server.js"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const providerPort = await unusedPort();
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let analysisProviderStartedResolve;
  const analysisProviderStarted = new Promise((resolve) => { analysisProviderStartedResolve = resolve; });
  let firstAnalysisRequest = true;
  let receivedUpdatePrompt = "";
  const providerServer = http.createServer(async (request, response) => {
    try {
      const body = await readRequestJson(request);
      const formatName = body.response_format?.json_schema?.name || "";
      const user = JSON.parse(body.messages?.at(-1)?.content || "{}");
      let analysis;

      if (formatName === "single_round_requirements") {
        analysisProviderStartedResolve();
        if (firstAnalysisRequest) {
          firstAnalysisRequest = false;
          await delay(4_000);
        }
        const meeting = user.meeting || {};
        const evidenceText = String(meeting.content || "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.");
        analysis = {
          meeting_requirements: [{
            text: "주문 내역을 날짜별로 확인할 수 있어야 합니다.",
            category: "function",
            needs_confirmation: false,
            updated: false,
            change_type: "new",
            previous_id: null,
            previous_text: null,
            evidence: [{ text: evidenceText }],
          }],
        };
      } else if (formatName === "template_generation_chunk") {
        const evidence = user.requirements?.[0]?.evidence?.[0]?.text || "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.";
        analysis = {
          sections: (user.template?.sections || []).map((section) => ({
            target: user.target === "update" ? "update" : "draft",
            section,
            content: "주문 내역을 날짜별로 확인할 수 있습니다.",
            needs_confirmation: false,
            evidence,
            reason: "회의록 요구사항에서 확인했습니다.",
          })),
        };
      } else if (formatName === "specification_update_document") {
        receivedUpdatePrompt = body.messages.map((message) => message.content).join("\n");
        const requirements = user.confirmedRequirements || [];
        const updateLines = requirements.map((requirement) => {
          const action = requirement.comparisonStatus === "반영됨"
            ? "유지"
            : requirement.comparisonStatus === "누락 의심"
              ? "추가"
              : "새 요구사항 기준으로 수정";
          return `- ${action}: ${requirement.text}`;
        });
        analysis = {
          updated_specification: `${user.existingSpecification?.content || "기존 기획서"}\n\n## 비교 결과 반영\n${updateLines.join("\n")}`,
          citations: [
            { section: "날짜별 검색", text: "고객: 주문 내역에서 날짜를 확인해 주세요.", source_kind: "meeting" },
            { section: "주문 내역", text: "주문 목록을 확인할 수 있습니다.", source_kind: "spec" },
          ],
        };
      } else if (formatName === "analysis_specification_comparison") {
        analysis = { spec_requirements: [], comparison: [] };
      } else {
        throw new Error(`Unexpected mock model schema: ${formatName}`);
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(chatCompletion(analysis)));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  providerServer.listen(providerPort, "127.0.0.1");
  await once(providerServer, "listening");
  t.after(async () => new Promise((resolve) => providerServer.close(resolve)));

  let child;
  let serverOutput = "";
  async function startServer() {
    child = spawn(process.execPath, ["server.js"], {
      cwd: temporaryRoot,
      env: {
        PATH: process.env.PATH || "",
        PORT: String(port),
        NODE_ENV: "test",
        SPEC_GUARD_DATA_DIRECTORY: dataDirectory,
        LLM_API_KEY: "test-only-local-mock-key",
        LLM_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test server stopped: ${serverOutput}`);
      try {
        if ((await fetch(`${origin}/api/auth/me`)).ok) return;
      } catch {
        // Wait while the server opens the isolated test database.
      }
      await delay(40);
    }
    throw new Error(`Test server did not start: ${serverOutput}`);
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

  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }

  await startServer();
  try {
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: { username: "analysis_race", password: "TestPass7", passwordConfirm: "TestPass7" },
    });
    assert.equal(registered.response.status, 201);
    const cookie = registered.cookie;
    const csrf = registered.payload.csrfToken;
    const meetingText = "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.";
    const created = await request("/api/projects", {
      method: "POST",
      cookie,
      csrf,
      body: {
        project: {
          id: "analysis-race-project",
          name: "새 프로젝트 즉시 분석 검증",
          client: "격리 테스트 고객사",
          summary: "초기 요약",
          status: "draft",
          documents: [{
            id: "meeting-race-1",
            name: "회의록 1",
            kind: "source",
            type: "text/plain",
            content: meetingText,
            date: "2026-11-27",
            roundId: "round-race-1",
            roundNumber: 1,
          }],
          rounds: [{ id: "round-race-1", roundNumber: 1, date: "2026-11-27" }],
          requirements: [],
          extractedRequirements: { source: [], spec: [] },
          requirementReview: null,
          requirementComparison: null,
          analysisRun: false,
          extractionRun: false,
          analysisStale: false,
        },
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.project.serverVersion, 1, "new projects begin at serverVersion 1");

    const analysisPromise = request("/api/analyze", {
      method: "POST",
      cookie,
      csrf,
      body: {
        projectId: "analysis-race-project",
        project: { name: "새 프로젝트 즉시 분석 검증", client: "격리 테스트 고객사" },
        meetings: [{
          date: "2026-11-27",
          documentName: "회의록 1",
          sourceDocumentId: "meeting-race-1",
          roundId: "round-race-1",
          roundNumber: 1,
          content: meetingText,
          transcript: "",
          transcriptFileName: "",
        }],
        specification: { documentName: "", content: "" },
        specificationTemplate: null,
        previousRequirements: [],
        reviewMemos: [],
      },
    });
    await analysisProviderStarted;
    await delay(3_600);

    const latestAtConcurrentSave = await request("/api/projects/analysis-race-project", { cookie });
    assert.equal(latestAtConcurrentSave.response.status, 200);
    assert.equal(latestAtConcurrentSave.payload.project.serverVersion, 1);
    const concurrentSave = await request("/api/projects/analysis-race-project", {
      method: "PUT",
      cookie,
      csrf,
      body: {
        expectedVersion: 1,
        project: { ...latestAtConcurrentSave.payload.project, summary: "분석 중 완료된 자동 저장" },
      },
    });
    assert.equal(concurrentSave.response.status, 200);
    assert.equal(concurrentSave.payload.project.serverVersion, 2, "a concurrent save advances the server while analysis is running");

    const analysis = await analysisPromise;
    assert.equal(analysis.response.status, 200, JSON.stringify(analysis.payload));
    assert.equal(analysis.payload.meetingRequirements.length, 1);
    assert.ok(analysis.payload.specDraft.includes("주문 내역"));
    assert.equal(analysis.payload.specUpdate, "", "analysis does not produce an update plan for a non-confirmed requirement set");

    const staleClientSave = await request("/api/projects/analysis-race-project", {
      method: "PUT",
      cookie,
      csrf,
      body: {
        expectedVersion: 1,
        project: { ...created.payload.project, requirements: [{ id: "req-1", text: analysis.payload.meetingRequirements[0].text }] },
      },
    });
    assert.equal(staleClientSave.response.status, 409, "the simulated stale client receives the expected conflict");
    const serverFresh = await request("/api/projects/analysis-race-project", { cookie });
    const rebasedSave = await request("/api/projects/analysis-race-project", {
      method: "PUT",
      cookie,
      csrf,
      body: {
        expectedVersion: serverFresh.payload.project.serverVersion,
        project: {
          ...serverFresh.payload.project,
          requirements: [{ id: "req-1", text: analysis.payload.meetingRequirements[0].text }],
          specDraft: { content: analysis.payload.specDraft },
          analysisRun: true,
          extractionRun: true,
        },
      },
    });
    assert.equal(rebasedSave.response.status, 200);
    assert.equal(rebasedSave.payload.project.serverVersion, 3);
    assert.equal(rebasedSave.payload.project.summary, "분석 중 완료된 자동 저장", "rebased analysis results retain the concurrent project change");
    assert.equal((await request("/api/projects/analysis-race-project/changes", { cookie })).payload.changes.length, 3);

    const updateProject = {
      id: "confirmed-update-project",
      name: "확정 요구사항 업데이트 테스트",
      client: "격리 테스트 고객사",
      summary: "기존 기획서 업데이트 검증",
      status: "review",
      documents: [
        { id: "meeting-update", name: "회의 메모", kind: "source", content: "고객: 주문 내역에서 날짜를 확인해 주세요." },
        { id: "spec-update", name: "기존 기획서", kind: "spec", content: "# 주문 서비스\n\n## 주문 내역\n주문 목록을 확인할 수 있습니다.\n\n## 로그인\n비회원도 주문 내역을 볼 수 있습니다." },
      ],
      extractedRequirements: {
        source: [
          { id: "keep-requirement", text: "주문 목록을 확인할 수 있습니다.", category: "function", evidence: [{ text: "주문 목록을 확인할 수 있습니다.", date: "2026-11-27", documentName: "회의 메모", sourceDocumentId: "meeting-update", sourceKind: "meeting" }] },
          { id: "missing-requirement", text: "주문 내역을 날짜별로 검색할 수 있습니다.", category: "function", evidence: [{ text: "고객: 주문 내역에서 날짜를 확인해 주세요.", date: "2026-11-27", documentName: "회의 메모", sourceDocumentId: "meeting-update", sourceKind: "meeting" }] },
          { id: "conflict-requirement", text: "주문 내역은 로그인한 회원만 확인할 수 있습니다.", category: "function", evidence: [{ text: "고객은 로그인한 회원만 주문 내역을 확인하게 해 주세요.", date: "2026-11-27", documentName: "회의 메모", sourceDocumentId: "meeting-update", sourceKind: "meeting" }] },
        ],
        spec: [],
      },
      requirementReview: { version: 1, items: {
        "keep-requirement": { status: "confirmed", text: "주문 목록을 확인할 수 있습니다.", category: "function" },
        "missing-requirement": { status: "confirmed", text: "주문 내역을 날짜별로 검색할 수 있습니다.", category: "function" },
        "conflict-requirement": { status: "confirmed", text: "주문 내역은 로그인한 회원만 확인할 수 있습니다.", category: "function" },
      } },
      requirementComparison: {
        version: 1,
        comparedAt: "2026-11-27T10:00:00.000Z",
        confirmedSignature: JSON.stringify([
          { id: "keep-requirement", text: "주문 목록을 확인할 수 있습니다.", category: "function" },
          { id: "missing-requirement", text: "주문 내역을 날짜별로 검색할 수 있습니다.", category: "function" },
          { id: "conflict-requirement", text: "주문 내역은 로그인한 회원만 확인할 수 있습니다.", category: "function" },
        ]),
        contentSignature: JSON.stringify({
          source: [{
            id: "meeting-update",
            roundId: "",
            date: "2026-11-27",
            content: "고객은 주문 내역에서 날짜를 확인해 주세요.\n고객은 로그인한 회원만 주문 내역을 확인하게 해 주세요.",
            stt: "",
            sttFileName: "",
          }],
          specification: "# 주문 서비스\n\n## 주문 내역\n주문 목록을 확인할 수 있습니다.\n\n## 로그인\n비회원도 주문 내역을 볼 수 있습니다.",
          template: null,
        }),
        confirmedRequirements: [
          { id: "keep-requirement", text: "주문 목록을 확인할 수 있습니다.", category: "function" },
          { id: "missing-requirement", text: "주문 내역을 날짜별로 검색할 수 있습니다.", category: "function" },
          { id: "conflict-requirement", text: "주문 내역은 로그인한 회원만 확인할 수 있습니다.", category: "function" },
        ],
        results: [
          { requirementId: "keep-requirement", status: "반영됨", specQuote: "주문 목록을 확인할 수 있습니다.", reason: "기존에 반영됨" },
          { requirementId: "missing-requirement", status: "누락 의심", specQuote: null, reason: "기존 기획서에서 찾을 수 없음" },
          { requirementId: "conflict-requirement", status: "충돌", specQuote: "비회원도 주문 내역을 볼 수 있습니다.", reason: "접근 조건 충돌" },
        ],
      },
      comparisonStale: false,
      specTemplate: null,
    };
    updateProject.documents = [
      { id: "meeting-update", name: "회의 메모", kind: "source", content: "고객은 주문 내역에서 날짜를 확인해 주세요.\n고객은 로그인한 회원만 주문 내역을 확인하게 해 주세요.", date: "2026-11-27", roundId: "" },
      { id: "spec-update", name: "기존 기획서", kind: "spec", content: "# 주문 서비스\n\n## 주문 내역\n주문 목록을 확인할 수 있습니다.\n\n## 로그인\n비회원도 주문 내역을 볼 수 있습니다." },
    ];
    const createUpdateProject = await request("/api/projects", {
      method: "POST",
      cookie,
      csrf,
      body: { project: updateProject },
    });
    assert.equal(createUpdateProject.response.status, 201);
    const generatedUpdate = await request("/api/generate-update", {
      method: "POST",
      cookie,
      csrf,
      body: { projectId: "confirmed-update-project" },
    });
    assert.equal(generatedUpdate.response.status, 200, JSON.stringify(generatedUpdate.payload));
    assert.ok(generatedUpdate.payload.proposal.content.includes("- 유지: 주문 목록을 확인할 수 있습니다."));
    assert.ok(generatedUpdate.payload.proposal.content.includes("- 추가: 주문 내역을 날짜별로 검색할 수 있습니다."));
    assert.ok(generatedUpdate.payload.proposal.content.includes("- 새 요구사항 기준으로 수정: 주문 내역은 로그인한 회원만 확인할 수 있습니다."));
    assert.deepEqual(generatedUpdate.payload.proposal.citations.map((citation) => [citation.sourceKind, citation.verified]), [
      ["meeting", true],
      ["spec", true],
    ], "update-plan citations are checked against both meeting notes and the existing specification");
    assert.ok(receivedUpdatePrompt.includes("누락 의심"));
    assert.ok(receivedUpdatePrompt.includes("충돌"));

    const staleUpdateProject = await request("/api/projects/confirmed-update-project", { cookie });
    const makeRequirementStale = await request("/api/projects/confirmed-update-project", {
      method: "PUT",
      cookie,
      csrf,
      body: {
        expectedVersion: staleUpdateProject.payload.project.serverVersion,
        project: {
          ...staleUpdateProject.payload.project,
          requirementReview: {
            ...staleUpdateProject.payload.project.requirementReview,
            items: {
              ...staleUpdateProject.payload.project.requirementReview.items,
              "missing-requirement": { ...staleUpdateProject.payload.project.requirementReview.items["missing-requirement"], text: "새 확정 내용입니다." },
            },
          },
          comparisonStale: true,
        },
      },
    });
    assert.equal(makeRequirementStale.response.status, 200);
    const staleUpdate = await request("/api/generate-update", {
      method: "POST",
      cookie,
      csrf,
      body: { projectId: "confirmed-update-project" },
    });
    assert.equal(staleUpdate.response.status, 409, "update generation requires a current comparison for current confirmed requirements");
  } finally {
    await stopServer();
  }
});

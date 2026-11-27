"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");

const port = Number(process.env.PORT || 3000);
const projectId = "analysis-race-preview-project";
const searchProjectId = "extraction-search-preview-project";
const username = "analysis_preview";
const password = "TestPass7";
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "specguard-preview-regression-"));
const stateFile = "/tmp/specguard-preview-regression.json";
const providerState = {
  providerCalls: 0,
  concurrentSaveStarted: false,
  concurrentSaveStatus: null,
  analysisResponseSent: false,
};
let activeProjectId = projectId;

process.env.PORT = String(port);
process.env.NODE_ENV = "test";
process.env.SPEC_GUARD_DATA_DIRECTORY = dataDirectory;
process.env.LLM_API_KEY = "test-only-local-mock-key";

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mockCompletion(analysis) {
  return {
    choices: [{ message: { content: JSON.stringify(analysis) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 90, completion_tokens_details: { reasoning_tokens: 0 } },
  };
}

let sessionCookie = "";
let csrfToken = "";
let appOrigin = "";

async function appRequest(route, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers.origin = appOrigin;
  if (sessionCookie) headers.cookie = sessionCookie;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${appOrigin}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  return { response, payload };
}

async function triggerConcurrentSave(projectName = "") {
  if (providerState.concurrentSaveStarted) return;
  providerState.concurrentSaveStarted = true;
  try {
    if (projectName) {
      const list = await appRequest("/api/projects");
      const target = list.payload.projects?.find((project) => project.name === projectName);
      if (target) activeProjectId = target.id;
    }
    const current = await appRequest(`/api/projects/${encodeURIComponent(activeProjectId)}`);
    if (!current.response.ok) throw new Error(`project GET returned ${current.response.status}`);
    const saved = await appRequest(`/api/projects/${encodeURIComponent(activeProjectId)}`, {
      method: "PUT",
      body: {
        expectedVersion: current.payload.project.serverVersion,
        project: { ...current.payload.project, summary: "분석 중 완료된 자동 저장" },
      },
    });
    providerState.concurrentSaveStatus = {
      projectId: activeProjectId,
      status: saved.response.status,
      version: saved.payload.project?.serverVersion || null,
      summary: saved.payload.project?.summary || "",
    };
  } catch (error) {
    providerState.concurrentSaveStatus = { status: 0, error: error.message };
  }
}

const providerServer = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/__test/status") {
    let project = null;
    try {
      const database = new DatabaseSync(path.join(dataDirectory, "projects.sqlite"), { readOnly: true });
      const row = database.prepare("SELECT version, data_json FROM projects WHERE id = ?").get(activeProjectId);
      if (row) {
        const savedProject = JSON.parse(row.data_json);
        project = {
          version: Number(row.version),
          summary: savedProject.summary || "",
          analysisRun: Boolean(savedProject.analysisRun),
          extractionRun: Boolean(savedProject.extractionRun),
          specDraft: savedProject.specDraft?.content || "",
        };
      }
      database.close();
    } catch {
      project = null;
    }
    sendJson(response, 200, { ...providerState, activeProjectId, project });
    return;
  }

  try {
    const body = await readJson(request);
    providerState.providerCalls += 1;
    const schemaName = body.response_format?.json_schema?.name || "";
    const user = JSON.parse(body.messages?.at(-1)?.content || "{}");
    let analysis;

    if (schemaName === "single_round_requirements") {
      if (!providerState.concurrentSaveStarted) {
          setTimeout(() => { void triggerConcurrentSave(user.project?.name || ""); }, 4_000);
      }
      await delay(5_000);
      const meeting = user.meeting || {};
      const evidence = String(meeting.content || "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.");
      analysis = {
        meeting_requirements: [{
          text: "주문 내역을 날짜별로 확인할 수 있어야 합니다.",
          category: "function",
          needs_confirmation: false,
          updated: false,
          change_type: "new",
          previous_id: null,
          previous_text: null,
          evidence: [{ text: evidence }],
        }],
      };
    } else if (schemaName === "template_generation_chunk") {
      const evidence = user.requirements?.[0]?.evidence?.[0]?.text || "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.";
      analysis = {
        sections: (user.template?.sections || []).map((section) => ({
          target: "draft",
          section,
          content: "주문 내역을 날짜별로 확인할 수 있습니다.",
          needs_confirmation: false,
          evidence,
          reason: "회의록 요구사항에서 확인했습니다.",
        })),
      };
    } else if (schemaName === "specification_update_document") {
      const updateLines = (user.confirmedRequirements || []).map((requirement) => {
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
    } else {
      throw new Error(`Unexpected local mock schema: ${schemaName}`);
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(mockCompletion(analysis)));
    if (schemaName === "template_generation_chunk") providerState.analysisResponseSent = true;
  } catch (error) {
    sendJson(response, 500, { error: { message: error.message } });
  }
});

providerServer.listen(0, "127.0.0.1", () => {
  const providerPort = providerServer.address().port;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${providerPort}/v1`;
  require("../server.js");

  const deadline = Date.now() + 10_000;
  const waitForApplication = async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
        if (response.ok) return;
      } catch {
        await delay(50);
      }
      await delay(50);
    }
    throw new Error("The isolated SpecGuard server did not start.");
  };

  void waitForApplication().then(async () => {
    appOrigin = `http://127.0.0.1:${port}`;
    const account = await appRequest("/api/auth/register", {
      method: "POST",
      body: { username, password, passwordConfirm: password },
    });
    if (account.response.status !== 201) throw new Error(`Test account setup failed: ${account.response.status}`);
    sessionCookie = account.response.headers.get("set-cookie")?.split(";", 1)[0] || "";
    csrfToken = account.payload.csrfToken;
    const meetingText = "고객은 주문 내역을 날짜별로 확인할 수 있어야 합니다.";
    const created = await appRequest("/api/projects", {
      method: "POST",
      body: {
        project: {
          id: projectId,
          name: "새 프로젝트 즉시 분석 검증",
          client: "격리 브라우저 테스트",
          summary: "처음 저장한 프로젝트입니다.",
          status: "draft",
          documents: [{
            id: "meeting-preview-1",
            name: "회의록 1",
            kind: "source",
            type: "text/plain",
            content: meetingText,
            date: "2026-11-27",
            roundId: "round-preview-1",
            roundNumber: 1,
          }],
          rounds: [{ id: "round-preview-1", roundNumber: 1, date: "2026-11-27" }],
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
    if (created.response.status !== 201) throw new Error(`Test project setup failed: ${created.response.status}`);

    const longMeetingText = `${"초기 회의 내용입니다. ".repeat(260)}\nLongTailSearchNeedle 4천 자 이후의 회의 원문입니다.\nXssSearchNeedle <img src=x onerror=\"window.__searchXss=1\">`;
    const searchProject = {
      id: searchProjectId,
      name: "검색 기능 브라우저 검증",
      client: "격리 검색 테스트 고객사",
      summary: "문서와 요구사항 검색 범위를 확인합니다.",
      status: "review",
      documents: [
        {
          id: "search-meeting-current",
          name: "검색 검증 2차 회의록.md",
          kind: "source",
          type: "text/markdown",
          content: longMeetingText,
          stt: { fileName: "동일 전사.wav", transcript: "TranscriptSearchNeedle 상담 통화에서 나온 검색 확인 문장입니다." },
          date: "2026-11-26",
          roundId: "search-round-2",
          roundNumber: 2,
        },
        {
          id: "search-meeting-old",
          name: "검색 검증 이전 메모.txt",
          kind: "source",
          type: "text/plain",
          content: "ArchivedMeetingNeedle 보관된 이전 버전 회의 내용입니다.",
          date: "2026-11-20",
          roundId: "search-round-1",
          roundNumber: 1,
          archivedAt: "2026-11-26T10:00:00.000Z",
        },
        {
          id: "search-meeting-duplicate",
          name: "중복 전사 확인.txt",
          kind: "source",
          type: "text/plain",
          content: "DeduplicatedTranscriptNeedle 본문과 전사가 같은 문장입니다.",
          stt: { fileName: "same.wav", transcript: "DeduplicatedTranscriptNeedle 본문과 전사가 같은 문장입니다." },
          date: "2026-11-25",
          roundId: "search-round-2",
          roundNumber: 2,
        },
        {
          id: "search-spec-current",
          name: "검색 검증 최종 기획서 2026-11-27.md",
          kind: "spec",
          type: "text/markdown",
          content: "SpecOnlySearchNeedle 최종 기획서에서만 검색되는 문장입니다.\n로그인한 사용자는 주문 내역을 조회합니다.",
          date: "2026-11-27",
        },
        {
          id: "search-spec-old",
          name: "검색 검증 이전 기획서.pdf",
          kind: "spec",
          type: "application/pdf",
          content: "ArchivedSpecNeedle 보관된 이전 기획서 내용입니다.",
          date: "2026-11-18",
          archivedAt: "2026-11-27T09:00:00.000Z",
        },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `search-pagination-${index + 1}`,
          name: `결과 페이지 ${index + 1}.txt`,
          kind: "source",
          type: "text/plain",
          content: `PaginationSearchNeedle 결과 항목 ${index + 1}`,
          date: "2026-11-27",
          roundId: "search-round-2",
          roundNumber: 2,
        })),
      ],
      rounds: [
        { id: "search-round-1", roundNumber: 1, date: "2026-11-20" },
        { id: "search-round-2", roundNumber: 2, date: "2026-11-26" },
      ],
      extractedRequirements: {
        source: [{
          id: "search-source-requirement",
          text: "SourceRequirementNeedle 장바구니 항목 수를 보여 주세요.",
          category: "function",
          evidence: [{
            text: "SourceEvidenceNeedle 장바구니 상품 개수를 표시해 주세요.",
            date: "2026-11-26",
            documentName: "검색 검증 2차 회의록.md",
            sourceDocumentId: "search-meeting-current",
            sourceKind: "meeting",
            roundId: "search-round-2",
            roundNumber: 2,
          }],
        }],
        spec: [{
          id: "search-spec-requirement",
          text: "SpecRequirementNeedle 회원은 주문 내역을 확인합니다.",
          category: "function",
          evidence: [{
            text: "SpecEvidenceNeedle 로그인한 사용자는 주문 내역을 조회합니다.",
            date: "2026-11-27",
            documentName: "검색 검증 최종 기획서 2026-11-27.md",
            sourceDocumentId: "search-spec-current",
            sourceKind: "spec",
          }],
        }],
      },
      requirementReview: {
        version: 1,
        items: {
          "search-direct-requirement": {
            directlyAdded: true,
            status: "confirmed",
            text: "DirectSearchNeedle 직접 추가한 테스트 요구사항입니다.",
            category: "other",
            roundId: "search-round-2",
          },
        },
      },
      requirements: [],
      extractionRun: true,
      analysisRun: true,
      specDraft: { content: "DraftSearchNeedle 현재 AI 기획서 초안입니다.", generatedAt: "2026-11-27T09:00:00.000Z" },
      specDraftHistory: [{ content: "OldDraftSearchNeedle 이전 AI 초안입니다.", generatedAt: "2026-11-26T09:00:00.000Z", archivedAt: "2026-11-27T09:00:00.000Z" }],
      specUpdateProposal: { content: "UpdateSearchNeedle 현재 AI 업데이트안입니다.", generatedAt: "2026-11-27T09:30:00.000Z" },
      specUpdateHistory: [{ content: "OldUpdateSearchNeedle 이전 AI 업데이트안입니다.", generatedAt: "2026-11-26T09:30:00.000Z", archivedAt: "2026-11-27T09:30:00.000Z" }],
    };
    const searchCreated = await appRequest("/api/projects", {
      method: "POST",
      body: { project: searchProject },
    });
    if (searchCreated.response.status !== 201) throw new Error(`Search fixture setup failed: ${searchCreated.response.status}`);
    fs.writeFileSync(stateFile, JSON.stringify({ username, password, projectId, searchProjectId, providerPort, dataDirectory }));
  }).catch((error) => {
    console.error(`Mock analysis preview setup failed: ${error.message}`);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  providerServer.close();
  try {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
    fs.rmSync(stateFile, { force: true });
  } catch {
    // The temporary test directory can be cleaned by the caller if needed.
  }
  process.exit(0);
});

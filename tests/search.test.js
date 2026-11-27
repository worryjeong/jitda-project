"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collectSearchItems, searchProject } = require("../extraction-search.js");

function searchFixture() {
  const matchingTranscript = "TranscriptOnlyNeedle 상담 통화 전사 본문입니다.";
  return {
    id: "search-fixture-project",
    documents: [
      {
        id: "meeting-round-1",
        name: "고객 미팅 1차 회의록.md",
        kind: "source",
        date: "2026-04-01",
        roundId: "round-1",
        roundNumber: 1,
        content: "첫 회의에서 장바구니 수량 표시를 요청했습니다. CustomerPortal 검색을 지원합니다.",
        stt: { fileName: "meeting-round-1.m4a", transcript: matchingTranscript },
      },
      {
        id: "meeting-round-2-old",
        name: "이전 고객 메모.txt",
        kind: "source",
        date: "2026-03-15",
        roundId: "round-2-old",
        roundNumber: 2,
        archivedAt: "2026-04-10T10:00:00.000Z",
        content: "보관된 회의에서만 나오는 OldMeetingNeedle 문장입니다.",
      },
      {
        id: "meeting-duplicate-transcript",
        name: "중복 전사 메모.txt",
        kind: "source",
        date: "2026-04-02",
        roundId: "round-2",
        roundNumber: 2,
        content: "ExactDuplicateNeedle 그대로 저장된 내용입니다.",
        stt: { fileName: "duplicate.wav", transcript: "ExactDuplicateNeedle 그대로 저장된 내용입니다." },
      },
      {
        id: "spec-current",
        name: "최종 기획서 2026-04-03.md",
        kind: "spec",
        date: "2026-04-03",
        content: `## 회원 주문
로그인한 사용자는 주문 내역을 확인합니다.
${"긴 설명 문장입니다. ".repeat(280)}
LongContentAfterFourThousandCharactersNeedle 는 본문 끝부분입니다.`,
      },
      {
        id: "spec-old",
        name: "이전 최종 기획서.pdf",
        kind: "spec",
        date: "2026-02-11",
        archivedAt: "2026-04-03T08:30:00.000Z",
        content: "이전 기획서에만 있는 OldSpecNeedle 요구사항입니다.",
      },
    ],
    extractedRequirements: {
      source: [
        {
          id: "source-requirement-1",
          text: "장바구니에 담긴 상품 수를 표시해 주세요.",
          category: "function",
          evidence: [{
            text: "SourceCitationNeedle 장바구니 수량을 보여 주세요.",
            date: "2026-04-01",
            documentName: "고객 미팅 1차 회의록.md",
            sourceDocumentId: "meeting-round-1",
            sourceKind: "meeting",
            roundId: "round-1",
            roundNumber: 1,
          }],
        },
      ],
      spec: [
        {
          id: "spec-requirement-1",
          text: "로그인한 사용자는 주문 내역을 확인합니다.",
          category: "function",
          evidence: [{
            text: "SpecCitationNeedle 로그인한 사용자는 주문 내역을 확인합니다.",
            date: "2026-04-03",
            documentName: "최종 기획서 2026-04-03.md",
            sourceDocumentId: "spec-current",
            sourceKind: "spec",
          }],
        },
      ],
    },
    requirementReview: {
      version: 1,
      items: {
        "direct-added-1": {
          directlyAdded: true,
          text: "DirectRequirementNeedle 수동으로 추가한 조건",
          category: "other",
          status: "confirmed",
          roundId: "round-1",
        },
      },
    },
    extractionRun: false,
    specDraft: {
      content: "CurrentDraftNeedle AI가 만든 현재 기획서 초안입니다.",
      generatedAt: "2026-04-05T09:30:00.000Z",
    },
    specDraftHistory: [{
      content: "PreviousDraftNeedle 예전 AI 초안입니다.",
      generatedAt: "2026-04-04T09:30:00.000Z",
      archivedAt: "2026-04-05T09:30:00.000Z",
    }],
    specUpdateProposal: {
      content: "CurrentUpdateNeedle 현재 기획서 업데이트 제안입니다.",
      generatedAt: "2026-04-06T12:00:00.000Z",
    },
    specUpdateHistory: [{
      content: "PreviousUpdateNeedle 이전 기획서 업데이트안입니다.",
      generatedAt: "2026-04-05T12:00:00.000Z",
      archivedAt: "2026-04-06T12:00:00.000Z",
    }],
    extractionHistory: [{
      analyzedAt: "2026-03-31T10:00:00.000Z",
      extractedRequirements: {
        source: [{ id: "old-requirement", text: "PreviousExtractionNeedle 이전 분석 요구사항입니다.", evidence: [{ text: "이전 분석의 원문 근거입니다." }] }],
        spec: [],
      },
    }],
  };
}

test("search works before AI analysis using meeting notes, names, and dates", () => {
  const project = searchFixture();
  project.extractedRequirements = { source: [], spec: [] };
  project.extractionHistory = [];
  assert.equal(project.extractionRun, false);
  const bodySearch = searchProject(project, "장바구니 수량");
  assert.equal(bodySearch.results.some((item) => item.id === "document:meeting-round-1"), true);
  assert.equal(bodySearch.results.some((item) => item.itemTypeLabel === "요구사항"), false);
  assert.equal(searchProject(project, "회의록.md").results[0].title, "고객 미팅 1차 회의록.md");
  assert.equal(searchProject(project, "2026-04-01", "meeting").results.some((item) => item.id === "document:meeting-round-1"), true);
});

test("search is case-insensitive, trims the query, and safely treats punctuation literally", () => {
  const project = searchFixture();
  assert.equal(searchProject(project, "  customerportal  ").total > 0, true);
  assert.equal(searchProject(project, "[literal.*needle]").total, 0);
  project.documents[0].content += "\n[literal.*needle]";
  const special = searchProject(project, " [literal.*needle] ");
  assert.equal(special.total, 1);
  assert.equal(special.results[0].title, "고객 미팅 1차 회의록.md");
});

test("search covers every round, archived documents, and speech transcripts", () => {
  const project = searchFixture();
  const allRounds = searchProject(project, "회의", "meeting");
  assert.equal(allRounds.results.some((item) => item.id === "document:meeting-round-1"), true);
  assert.equal(allRounds.results.some((item) => item.id === "document:meeting-round-2-old" && item.previousVersion), true);
  const transcript = searchProject(project, "TranscriptOnlyNeedle", "meeting");
  assert.equal(transcript.total, 1);
  assert.match(transcript.results[0].fullContent, /음성 전사/u);
});

test("meeting and specification scopes include only their documents and requirements", () => {
  const project = searchFixture();
  const meetingResults = searchProject(project, "로그인한 사용자는", "meeting");
  assert.equal(meetingResults.total, 0);
  const specResults = searchProject(project, "로그인한 사용자는", "spec");
  assert.equal(specResults.results.some((item) => item.id === "document:spec-current"), true);
  assert.equal(specResults.results.some((item) => item.id === "requirement:현재:spec:spec-requirement-1"), true);
  assert.equal(specResults.results.some((item) => item.group === "meeting"), false);
});

test("search finds extracted requirements and their evidence, document names, dates, and directly added items", () => {
  const project = searchFixture();
  const evidence = searchProject(project, "SourceCitationNeedle", "meeting");
  assert.equal(evidence.total, 1);
  assert.equal(evidence.results[0].itemTypeLabel, "요구사항");
  assert.equal(evidence.results[0].documentName, "고객 미팅 1차 회의록.md");
  assert.match(evidence.results[0].fullContent, /SourceCitationNeedle/u);
  assert.equal(searchProject(project, "2026-04-03", "spec").results.some((item) => item.itemTypeLabel === "요구사항"), true);
  assert.equal(searchProject(project, "DirectRequirementNeedle", "meeting").total, 1);
});

test("search includes current and previous AI drafts and update proposals as generated documents", () => {
  const project = searchFixture();
  for (const [query, previous] of [
    ["CurrentDraftNeedle", false],
    ["PreviousDraftNeedle", true],
    ["CurrentUpdateNeedle", false],
    ["PreviousUpdateNeedle", true],
  ]) {
    const result = searchProject(project, query, "spec");
    assert.equal(result.total, 1, query);
    assert.equal(result.results[0].itemTypeLabel, "생성 문서");
    assert.equal(result.results[0].previousVersion, previous);
  }
});

test("search discovers matches after four thousand characters and previews nearby context", () => {
  const result = searchProject(searchFixture(), "LongContentAfterFourThousandCharactersNeedle", "spec");
  assert.equal(result.total, 1);
  assert.equal(result.results[0].preview.includes("LongContentAfterFourThousandCharactersNeedle"), true);
  assert.equal(result.results[0].preview.length <= 222, true);
  assert.equal(result.results[0].previewMatchIndex >= 0, true);
});

test("empty queries and no-match searches return safe empty results", () => {
  const project = searchFixture();
  assert.deepEqual(searchProject(project, "   "), { query: "", scope: "all", total: 0, results: [] });
  assert.equal(searchProject(project, "no-such-search-result").total, 0);
  assert.equal(searchProject(project, "anything", "unknown-scope").scope, "all");
});

test("identical source text and transcript are included only once in the expanded document", () => {
  const project = searchFixture();
  const duplicate = searchProject(project, "ExactDuplicateNeedle", "meeting");
  assert.equal(duplicate.total, 1);
  assert.equal(duplicate.results[0].fullContent.match(/ExactDuplicateNeedle/gu).length, 1);
});

test("search collection and querying never mutate the stored project", () => {
  const project = searchFixture();
  const before = structuredClone(project);
  collectSearchItems(project);
  searchProject(project, "SourceCitationNeedle");
  assert.deepEqual(project, before);
});

test("the result count represents distinct document or requirement items, not repeated occurrences", () => {
  const project = searchFixture();
  project.documents[0].content += "\n장바구니 수량을 표시합니다. 장바구니 수량을 다시 확인합니다.";
  const result = searchProject(project, "장바구니 수량");
  assert.equal(result.results.filter((item) => item.id === "document:meeting-round-1").length, 1);
  assert.equal(result.results.filter((item) => item.id === "requirement:현재:meeting:source-requirement-1").length, 1);
});

test("search results are paginatable without truncating the collection", () => {
  const project = searchFixture();
  project.documents.push(...Array.from({ length: 25 }, (_, index) => ({
    id: `extra-${index + 1}`,
    name: `검색 항목 ${index + 1}.txt`,
    kind: "source",
    content: `SearchPaginationNeedle 항목 ${index + 1}`,
  })));
  const result = searchProject(project, "SearchPaginationNeedle");
  assert.equal(result.total, 25);
  assert.equal(result.results.length, 25);
  assert.equal(result.results.slice(0, 20).length, 20);
  assert.equal(result.results.slice(20).length, 5);
});

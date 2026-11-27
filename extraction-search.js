"use strict";

(function attachExtractionSearch(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SpecGuardExtractionSearch = api;
})(typeof window !== "undefined" ? window : globalThis, function createExtractionSearch() {
  const validScopes = new Set(["all", "meeting", "spec"]);

  function asText(value) {
    return typeof value === "string" ? value : "";
  }

  function contentOfGeneratedDocument(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return asText(value.content || value.text || value.document || value.body);
  }

  function normalizedSearchText(value) {
    return asText(value).normalize("NFC").toLocaleLowerCase("ko-KR");
  }

  function findTextMatch(value, query) {
    const text = asText(value).normalize("NFC");
    const normalizedQuery = asText(query).trim().normalize("NFC");
    if (!normalizedQuery) return null;
    const index = normalizedSearchText(text).indexOf(normalizedSearchText(normalizedQuery));
    if (index < 0) return null;
    return { index, length: normalizedQuery.length };
  }

  function makeExcerpt(value, match, maximumLength = 220) {
    const text = asText(value).normalize("NFC");
    if (text.length <= maximumLength) {
      return {
        text,
        matchIndex: match ? match.index : -1,
        matchLength: match ? match.length : 0,
        startsWithEllipsis: false,
        endsWithEllipsis: false,
      };
    }

    let start = 0;
    if (match) start = Math.max(0, match.index - Math.floor((maximumLength - match.length) / 2));
    let end = Math.min(text.length, start + maximumLength);
    if (end - start < maximumLength) start = Math.max(0, end - maximumLength);
    const startsWithEllipsis = start > 0;
    const endsWithEllipsis = end < text.length;
    const prefixLength = startsWithEllipsis ? 1 : 0;
    return {
      text: `${startsWithEllipsis ? "…" : ""}${text.slice(start, end)}${endsWithEllipsis ? "…" : ""}`,
      matchIndex: match && match.index >= start && match.index + match.length <= end
        ? match.index - start + prefixLength
        : -1,
      matchLength: match ? match.length : 0,
      startsWithEllipsis,
      endsWithEllipsis,
    };
  }

  function dateText(value) {
    return asText(value).slice(0, 10);
  }

  function makeSearchEntry({
    id,
    group,
    documentKindLabel,
    itemTypeLabel,
    title,
    documentName = "",
    date = "",
    roundNumber = null,
    previousVersion = false,
    fullContent = "",
    fields = [],
  }) {
    const safeFields = fields
      .filter((field) => field && asText(field.value))
      .map((field) => ({
        label: asText(field.label),
        value: asText(field.value).normalize("NFC"),
        role: field.role || "metadata",
        documentName: asText(field.documentName || documentName),
        date: dateText(field.date || date),
        roundNumber: Number.isInteger(field.roundNumber) ? field.roundNumber : roundNumber,
        previousVersion: Boolean(field.previousVersion ?? previousVersion),
      }));
    return {
      id,
      group,
      documentKindLabel,
      itemTypeLabel,
      title: asText(title).normalize("NFC"),
      documentName: asText(documentName).normalize("NFC"),
      date: dateText(date),
      roundNumber: Number.isInteger(roundNumber) ? roundNumber : null,
      previousVersion: Boolean(previousVersion),
      fullContent: asText(fullContent).normalize("NFC"),
      fields: safeFields,
    };
  }

  function projectDocuments(project) {
    return Array.isArray(project?.documents) ? project.documents : [];
  }

  function sourceTranscript(document) {
    return asText(document?.stt?.transcript || document?.transcript);
  }

  function collectDocumentEntries(project) {
    const documents = projectDocuments(project);
    const documentById = new Map();
    documents.forEach((document, index) => {
      documentById.set(asText(document?.id) || `document-${index + 1}`, document);
    });

    const entries = documents.flatMap((document, index) => {
      if (!document || !["source", "spec"].includes(document.kind)) return [];
      const group = document.kind === "source" ? "meeting" : "spec";
      const previousVersion = Boolean(document.archivedAt);
      const date = dateText(document.date || document.createdAt);
      const roundNumber = Number.isInteger(document.roundNumber) ? document.roundNumber : null;
      const name = asText(document.name) || (group === "meeting" ? "회의록·메모" : "최종 기획서");
      const body = asText(document.content);
      const transcript = group === "meeting" ? sourceTranscript(document) : "";
      const contentParts = [];
      if (body) contentParts.push({ label: "문서 원문", value: body, role: "body" });
      if (transcript && transcript !== body) contentParts.push({ label: "음성 전사", value: transcript, role: "body" });
      const fullContent = contentParts.map((part) => `${part.label}\n${part.value}`).join("\n\n");
      const documentName = name;
      const fields = [
        { label: "문서명", value: name, role: "title", documentName, date, roundNumber, previousVersion },
        { label: "날짜", value: date, role: "metadata", documentName, date, roundNumber, previousVersion },
        ...(roundNumber ? [{ label: "회의 차수", value: `${roundNumber}회차`, role: "metadata", documentName, date, roundNumber, previousVersion }] : []),
        ...contentParts.map((part) => ({ ...part, documentName, date, roundNumber, previousVersion })),
      ];
      return [makeSearchEntry({
        id: `document:${asText(document.id) || index}`,
        group,
        documentKindLabel: group === "meeting" ? "회의록·메모" : "기획서",
        itemTypeLabel: "원문",
        title: name,
        documentName,
        date,
        roundNumber,
        previousVersion,
        fullContent,
        fields,
      })];
    });

    return { entries, documentById };
  }

  function evidenceEntries(requirement) {
    if (Array.isArray(requirement?.evidence)) {
      return requirement.evidence.flatMap((evidence) => {
        if (typeof evidence === "string") return evidence.trim() ? [{ text: evidence }] : [];
        return evidence && typeof evidence === "object" && asText(evidence.text).trim() ? [evidence] : [];
      });
    }
    if (typeof requirement?.evidence === "string" && requirement.evidence.trim()) return [{ text: requirement.evidence }];
    return [];
  }

  function collectRequirementEntries(project, documentById) {
    const results = [];
    const addRequirements = (items, group, versionLabel = "현재") => {
      (Array.isArray(items) ? items : []).forEach((requirement, index) => {
        if (!requirement || typeof requirement !== "object") return;
        const title = asText(requirement.text || requirement.requirement || requirement.title);
        if (!title.trim()) return;
        const evidence = evidenceEntries(requirement);
        const evidenceFields = evidence.map((entry, evidenceIndex) => {
          const sourceId = asText(entry.sourceDocumentId);
          const sourceDocument = sourceId ? documentById.get(sourceId) : null;
          const documentName = asText(entry.documentName || sourceDocument?.name);
          const date = dateText(entry.date || sourceDocument?.date);
          const roundNumber = Number.isInteger(entry.roundNumber)
            ? entry.roundNumber
            : Number.isInteger(sourceDocument?.roundNumber) ? sourceDocument.roundNumber : null;
          const previousVersion = Boolean(sourceDocument?.archivedAt || entry.archivedAt);
          return {
            entry,
            evidenceIndex,
            documentName,
            date,
            roundNumber,
            previousVersion,
          };
        });
        const firstEvidence = evidenceFields[0];
        const documentName = firstEvidence?.documentName || "근거 문서 미지정";
        const dates = [...new Set(evidenceFields.map((item) => item.date).filter(Boolean))];
        const date = dates.join(", ");
        const roundNumbers = [...new Set(evidenceFields.map((item) => item.roundNumber).filter(Number.isInteger))];
        const previousVersion = Boolean(versionLabel !== "현재" || (evidenceFields.length && evidenceFields.every((item) => item.previousVersion)));
        const fullContent = [
          `요구사항\n${title}`,
          ...evidenceFields.map(({ entry, documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound }) => {
            const metadata = [sourceName, evidenceDate, Number.isInteger(evidenceRound) ? `${evidenceRound}회차` : ""]
              .filter(Boolean).join(" · ");
            return `원문 근거${metadata ? ` (${metadata})` : ""}\n${asText(entry.text)}`;
          }),
        ].join("\n\n");
        const fields = [
          { label: "요구사항", value: title, role: "title", documentName, date, previousVersion },
          ...evidenceFields.flatMap(({ entry, documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound, previousVersion: evidencePrevious }, evidenceIndex) => [
            { label: "원문 근거", value: asText(entry.text), role: "body", documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound, previousVersion: evidencePrevious, evidenceIndex },
            ...(sourceName ? [{ label: "근거 문서명", value: sourceName, role: "metadata", documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound, previousVersion: evidencePrevious }] : []),
            ...(evidenceDate ? [{ label: "근거 날짜", value: evidenceDate, role: "metadata", documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound, previousVersion: evidencePrevious }] : []),
            ...(Number.isInteger(evidenceRound) ? [{ label: "회의 차수", value: `${evidenceRound}회차`, role: "metadata", documentName: sourceName, date: evidenceDate, roundNumber: evidenceRound, previousVersion: evidencePrevious }] : []),
          ]),
        ];
        results.push(makeSearchEntry({
          id: `requirement:${versionLabel}:${group}:${asText(requirement.id) || index}`,
          group,
          documentKindLabel: group === "meeting" ? "회의록·메모" : "기획서",
          itemTypeLabel: "요구사항",
          title,
          documentName,
          date,
          roundNumber: roundNumbers.at(-1) ?? null,
          previousVersion,
          fullContent,
          fields,
        }));
      });
    };

    addRequirements(project?.extractedRequirements?.source, "meeting");
    addRequirements(project?.extractedRequirements?.spec, "spec");

    const currentIds = new Set([
      ...(Array.isArray(project?.extractedRequirements?.source) ? project.extractedRequirements.source : []),
      ...(Array.isArray(project?.extractedRequirements?.spec) ? project.extractedRequirements.spec : []),
    ].map((item) => asText(item?.id)).filter(Boolean));
    const directItems = Object.entries(project?.requirementReview?.items || {})
      .filter(([id, item]) => item?.directlyAdded && !currentIds.has(id))
      .map(([id, item]) => ({ ...item, id, roundNumber: item.roundNumber || item.roundId }));
    addRequirements(directItems, "meeting");

    (Array.isArray(project?.extractionHistory) ? project.extractionHistory : []).forEach((history, index) => {
      const extracted = history?.extractedRequirements;
      if (!extracted) return;
      addRequirements(extracted.source, "meeting", `이전 분석 ${index + 1}`);
      addRequirements(extracted.spec, "spec", `이전 분석 ${index + 1}`);
    });
    return results;
  }

  function collectGeneratedDocuments(project) {
    const results = [];
    const groups = [
      {
        key: "specDraft",
        historyKey: "specDraftHistory",
        title: "AI 기획서 초안",
      },
      {
        key: "specUpdateProposal",
        historyKey: "specUpdateHistory",
        title: "AI 기획서 업데이트안",
      },
    ];
    groups.forEach(({ key, historyKey, title }) => {
      const current = project?.[key];
      const currentContent = contentOfGeneratedDocument(current);
      if (currentContent.trim()) {
        const generatedAt = current && typeof current === "object" ? asText(current.generatedAt || current.updatedAt) : "";
        const templateFileName = current && typeof current === "object" ? asText(current.templateFileName) : "";
        results.push(makeSearchEntry({
          id: `generated:${key}:current`,
          group: "spec",
          documentKindLabel: "기획서",
          itemTypeLabel: "생성 문서",
          title,
          documentName: templateFileName,
          date: generatedAt,
          fullContent: currentContent,
          fields: [
            { label: "생성 문서", value: title, role: "title", documentName: templateFileName, date: generatedAt },
            ...(templateFileName ? [{ label: "기획서 양식", value: templateFileName, role: "metadata", date: generatedAt }] : []),
            ...(generatedAt ? [{ label: "생성 날짜", value: dateText(generatedAt), role: "metadata", date: generatedAt }] : []),
            { label: "본문", value: currentContent, role: "body", date: generatedAt },
          ],
        }));
      }
      const history = Array.isArray(project?.[historyKey]) ? project[historyKey] : [];
      history.forEach((entry, index) => {
        const content = contentOfGeneratedDocument(entry);
        if (!content.trim()) return;
        const generatedAt = asText(entry.generatedAt || entry.updatedAt || entry.archivedAt);
        const templateFileName = asText(entry.templateFileName);
        results.push(makeSearchEntry({
          id: `generated:${key}:history:${index}`,
          group: "spec",
          documentKindLabel: "기획서",
          itemTypeLabel: "생성 문서",
          title,
          documentName: templateFileName,
          date: generatedAt,
          previousVersion: true,
          fullContent: content,
          fields: [
            { label: "생성 문서", value: title, role: "title", documentName: templateFileName, date: generatedAt, previousVersion: true },
            ...(templateFileName ? [{ label: "기획서 양식", value: templateFileName, role: "metadata", date: generatedAt, previousVersion: true }] : []),
            ...(generatedAt ? [{ label: "생성 날짜", value: dateText(generatedAt), role: "metadata", date: generatedAt, previousVersion: true }] : []),
            { label: "본문", value: content, role: "body", date: generatedAt, previousVersion: true },
          ],
        }));
      });
    });
    return results;
  }

  function collectSearchItems(project) {
    const { entries: documentEntries, documentById } = collectDocumentEntries(project);
    return [
      ...documentEntries,
      ...collectRequirementEntries(project, documentById),
      ...collectGeneratedDocuments(project),
    ];
  }

  function selectedScope(scope) {
    return validScopes.has(scope) ? scope : "all";
  }

  function searchItem(item, query) {
    let matchedField = null;
    let match = null;
    for (const field of item.fields) {
      const fieldMatch = findTextMatch(field.value, query);
      if (!fieldMatch) continue;
      matchedField = field;
      match = fieldMatch;
      break;
    }
    if (!matchedField || !match) return null;

    let previewField = matchedField;
    let previewMatch = match;
    if (matchedField.role === "metadata") {
      previewField = item.fields.find((field) => field.role === "body" && field.value.trim())
        || item.fields.find((field) => field.role === "title" && field.value.trim())
        || matchedField;
      previewMatch = null;
    }
    const excerpt = makeExcerpt(previewField.value, previewMatch);
    return {
      ...item,
      matchFieldLabel: matchedField.label,
      matchFieldValue: matchedField.value,
      matchIndex: match.index,
      matchLength: match.length,
      matchedPreviousVersion: Boolean(matchedField.previousVersion),
      matchedDocumentName: matchedField.documentName || item.documentName,
      matchedDate: matchedField.date || item.date,
      matchedRoundNumber: matchedField.roundNumber ?? item.roundNumber,
      preview: excerpt.text,
      previewMatchIndex: excerpt.matchIndex,
      previewMatchLength: excerpt.matchLength,
      previewMetadataOnly: matchedField.role === "metadata",
    };
  }

  function searchProject(project, query, scope = "all") {
    const normalizedQuery = asText(query).trim().normalize("NFC");
    const normalizedScope = selectedScope(scope);
    if (!normalizedQuery || !project || typeof project !== "object") {
      return { query: normalizedQuery, scope: normalizedScope, total: 0, results: [] };
    }
    const results = collectSearchItems(project)
      .filter((item) => normalizedScope === "all" || item.group === normalizedScope)
      .map((item) => searchItem(item, normalizedQuery))
      .filter(Boolean);
    return { query: normalizedQuery, scope: normalizedScope, total: results.length, results };
  }

  return {
    collectSearchItems,
    findTextMatch,
    makeExcerpt,
    searchProject,
  };
});

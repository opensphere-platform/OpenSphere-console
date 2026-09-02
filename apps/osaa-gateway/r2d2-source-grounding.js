'use strict';

const SOURCE_TOOL_NAMES = new Set([
  'get_opensphere_source_catalog',
  'resolve_opensphere_source_revision',
  'read_opensphere_source',
  'search_opensphere_source',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function sourceRecords(values) {
  return (Array.isArray(values) ? values : [])
    .map((entry) => asObject(entry))
    .filter((entry) => SOURCE_TOOL_NAMES.has(String(entry.tool || '')))
    .map((entry) => ({ ...entry, result: asObject(entry.result) }));
}

function evidenceLineRanges(records) {
  const ranges = [];
  for (const entry of records) {
    if (entry.tool === 'read_opensphere_source') {
      const start = Number(entry.result.startLine);
      const end = Number(entry.result.endLine);
      if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) ranges.push({ start, end });
    }
    if (entry.tool === 'search_opensphere_source') {
      for (const item of Array.isArray(entry.result.items) ? entry.result.items : []) {
        const line = Number(item?.line);
        if (Number.isInteger(line) && line > 0) ranges.push({ start: line, end: line });
      }
    }
  }
  return ranges;
}

function claimedLineRanges(content) {
  const claims = [];
  const patterns = [
    /\b(?:line|lines?|L)\s*[:#]?\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi,
    /\b(\d+)\s*행(?:\s*[-–~]\s*(\d+)\s*행)?/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
        claims.push({ start, end, text: match[0] });
      }
    }
  }
  return claims;
}

function fencedCodeBlocks(content) {
  const blocks = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(String(content || ''))) !== null) {
    const text = normalizeText(match[1]);
    if (text) blocks.push(text);
  }
  return blocks;
}

function sourceTextCorpus(records) {
  const corpus = [];
  for (const entry of records) {
    if (entry.tool === 'read_opensphere_source') {
      const text = normalizeText(entry.result.text);
      if (text) corpus.push(text);
    }
    if (entry.tool === 'search_opensphere_source') {
      for (const item of Array.isArray(entry.result.items) ? entry.result.items : []) {
        const excerpt = normalizeText(item?.excerpt);
        if (excerpt) corpus.push(excerpt);
      }
    }
  }
  return corpus;
}

function verifiedCitation(result, startLine, endLine) {
  const repositoryId = String(result.repositoryId || result.repository?.id || 'unknown');
  const revision = String(result.revision || 'unresolved');
  const path = String(result.path || 'unknown');
  const suffix = Number.isInteger(startLine)
    ? `#L${startLine}${Number.isInteger(endLine) && endLine !== startLine ? `-L${endLine}` : ''}`
    : '';
  return `${repositoryId}@${revision}/${path}${suffix}`;
}

function lineNumberedExcerpt(result, maximumLines, redactText) {
  const start = Number(result.startLine || 1);
  const lines = String(result.text || '').replace(/\r\n/g, '\n').split('\n');
  const visible = lines.slice(0, maximumLines);
  const rendered = visible.map((line, index) => `${start + index} | ${redactText(line)}`).join('\n');
  return { rendered, truncated: lines.length > visible.length };
}

function sourceEvidenceAppendix(records, options = {}) {
  const redactText = typeof options.redactText === 'function' ? options.redactText : (value) => String(value || '');
  const lines = ['### OSCE가 고정한 정본 소스 근거'];
  const catalog = records.find((entry) => entry.tool === 'get_opensphere_source_catalog')?.result;
  if (catalog) {
    lines.push(`- 권위: ${redactText(catalog.authority || 'unknown')} · inventory: \`${redactText(catalog.inventory || 'unknown')}\` · coverage: \`${redactText(catalog.coverage || 'unknown')}\``);
    const inaccessible = (Array.isArray(catalog.repositories) ? catalog.repositories : [])
      .filter((repository) => repository?.accessible === false)
      .map((repository) => `${repository.id}(${repository.blocker || 'inaccessible'})`);
    if (inaccessible.length) lines.push(`- 접근 불가 범위: ${inaccessible.map((value) => `\`${redactText(value)}\``).join(', ')}`);
  }

  const heads = records.filter((entry) => entry.tool === 'resolve_opensphere_source_revision');
  for (const entry of heads.slice(0, 4)) {
    lines.push(`- 확정 revision: \`${redactText(entry.result.repository?.id || entry.arguments?.repositoryId || 'unknown')}@${redactText(entry.result.revision || 'unresolved')}\``);
  }

  const citations = [];
  const reads = records.filter((entry) => entry.tool === 'read_opensphere_source');
  for (const entry of reads.slice(0, 6)) {
    const result = entry.result;
    const start = Number(result.startLine);
    const end = Number(result.endLine);
    const citation = verifiedCitation(result, start, end);
    citations.push(citation);
    lines.push(`- 원문: \`${redactText(citation)}\` · digest \`${redactText(result.digest || 'unavailable')}\``);
    const excerpt = lineNumberedExcerpt(result, 80, redactText);
    lines.push('```text', excerpt.rendered, '```');
    if (excerpt.truncated) lines.push('- 위 표시는 응답 크기 제한으로 80행까지만 표시했습니다. 전체 조회 범위는 citation에 기록돼 있습니다.');
  }

  const searches = records.filter((entry) => entry.tool === 'search_opensphere_source');
  for (const entry of searches.slice(0, 4)) {
    const result = entry.result;
    lines.push(`- 검색: \`${redactText(result.repositoryId || 'unknown')}@${redactText(result.revision || 'unresolved')}\` · query \`${redactText(result.query || '')}\` · complete=\`${result.complete === true}\``);
    for (const item of (Array.isArray(result.items) ? result.items : []).slice(0, 12)) {
      const citation = verifiedCitation({ ...result, path: item.path }, Number(item.line), Number(item.line));
      citations.push(citation);
      lines.push(`  - \`${redactText(citation)}\`: ${redactText(String(item.excerpt || '').replace(/\s+/g, ' ').trim()).slice(0, 360)}`);
    }
  }
  return { markdown: lines.join('\n'), citations: [...new Set(citations)] };
}

function groundCanonicalSourceAnswer(content, values, options = {}) {
  const records = sourceRecords(values);
  if (!records.length) {
    if (options.required === true) return {
      content: '### 정본 소스 답변을 차단했습니다\n\n요청에 필요한 canonical source 도구가 실제 호출되지 않았습니다. 모델의 기억이나 대화 이력으로 소스 사실을 대신하지 않습니다.',
      applied: true,
      state: 'source-evidence-missing',
      evidenceIncomplete: true,
      violations: [{ kind: 'missing-source-tool-evidence', value: 'no canonical source tool result' }],
      citations: [],
    };
    return { content: String(content || ''), applied: false, state: 'not-applicable', violations: [], citations: [] };
  }

  const hasFileEvidence = records.some((entry) => (
    entry.tool === 'read_opensphere_source' && normalizeText(entry.result.text)
  ) || (
    entry.tool === 'search_opensphere_source' && Array.isArray(entry.result.items)
  ));
  if (options.required === true && !hasFileEvidence) {
    const appendix = sourceEvidenceAppendix(records, options);
    return {
      content: [
        '### 정본 소스 답변을 차단했습니다',
        '',
        'catalog 또는 revision 정보만으로는 소스 코드 사실을 입증할 수 없습니다. exact-revision read/search 결과가 없어 모델 설명을 제공하지 않습니다.',
        '',
        appendix.markdown,
      ].join('\n'),
      applied: true,
      state: 'source-file-evidence-missing',
      evidenceIncomplete: true,
      violations: [{ kind: 'missing-source-file-evidence', value: 'no exact-revision read/search result' }],
      citations: appendix.citations,
    };
  }

  const evidenceRanges = evidenceLineRanges(records);
  const corpus = sourceTextCorpus(records);
  const violations = [];
  for (const claim of claimedLineRanges(content)) {
    if (!evidenceRanges.some((range) => claim.start >= range.start && claim.end <= range.end)) {
      violations.push({ kind: 'unsupported-line-citation', value: claim.text });
    }
  }
  for (const block of fencedCodeBlocks(content)) {
    if (!corpus.some((source) => source.includes(block))) {
      violations.push({ kind: 'unsupported-code-quotation', value: block.slice(0, 160) });
    }
  }

  const appendix = sourceEvidenceAppendix(records, options);
  const evidenceIncomplete = records.some((entry) => entry.tool === 'search_opensphere_source' && entry.result.complete !== true)
    || records.some((entry) => entry.tool === 'get_opensphere_source_catalog' && entry.result.coverage !== 'complete');
  if (violations.length) {
    return {
      content: [
        '### 정본과 일치하지 않는 모델 설명을 차단했습니다',
        '',
        `R2D2 초안에서 OSCE가 반환한 근거와 일치하지 않는 코드 또는 행 인용 ${violations.length}건을 감지했습니다. 해당 초안은 사용자에게 사실로 제시하지 않고, 아래의 서버 검증 원문만 제공합니다.`,
        '',
        appendix.markdown,
      ].join('\n'),
      applied: true,
      state: 'model-draft-rejected',
      evidenceIncomplete,
      violations,
      citations: appendix.citations,
    };
  }

  return {
    content: [String(content || '').trim(), appendix.markdown].filter(Boolean).join('\n\n'),
    applied: true,
    state: evidenceIncomplete ? 'verified-with-coverage-gaps' : 'verified',
    evidenceIncomplete,
    violations: [],
    citations: appendix.citations,
  };
}

module.exports = {
  SOURCE_TOOL_NAMES,
  claimedLineRanges,
  fencedCodeBlocks,
  groundCanonicalSourceAnswer,
  sourceEvidenceAppendix,
};

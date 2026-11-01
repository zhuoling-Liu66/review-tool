import type { RunManifest, Severity } from './types.js';

type SarifLevel = 'error' | 'warning' | 'note';

const LEVEL: Record<Severity, SarifLevel> = {
  blocker: 'error',
  important: 'warning',
  minor: 'note',
  nit: 'note',
};

function uri(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function buildSarif(manifest: RunManifest): Record<string, unknown> {
  const categories = [...new Set(manifest.findings.map((finding) => finding.category))];
  const rules = categories.map((category) => ({
    id: `review.${category}`,
    name: category,
    shortDescription: { text: `Review finding: ${category}` },
  }));

  const findingResults = manifest.findings.map((finding) => ({
    ruleId: `review.${finding.category}`,
    level: LEVEL[finding.severity],
    message: {
      text: `${finding.claim}\n\n${finding.evidence}`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: uri(finding.file) },
          region: {
            startLine: finding.line,
            endLine: Math.max(finding.line, finding.endLine),
          },
        },
      },
    ],
    partialFingerprints: {
      reviewToolFingerprint: finding.fingerprint,
    },
    properties: {
      runId: finding.runId,
      severity: finding.severity,
      category: finding.category,
      status: finding.status,
      verification: finding.verification,
      confidence: finding.confidence,
      votes: finding.votes,
      mode: manifest.mode,
      tier: manifest.tier,
    },
  }));

  const checkResults = manifest.checks
    .filter((check) => check.status === 'fail' || check.status === 'error')
    .map((check) => ({
      ruleId: `review.check.${check.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      level: 'error' as const,
      message: { text: `Deterministic check failed: ${check.name} — ${check.summary}` },
      properties: {
        check: check.name,
        command: check.command,
        exitCode: check.exitCode,
        timedOut: check.timedOut,
      },
    }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'review-tool',
            semanticVersion: '0.1.0',
            rules,
          },
        },
        automationDetails: {
          id: manifest.runId,
          description: { text: `${manifest.mode} review, tier ${manifest.tier}` },
        },
        invocations: [
          {
            executionSuccessful: manifest.status === 'completed',
            properties: {
              exitCode: manifest.exitCode,
              status: manifest.status,
              startedAt: manifest.startedAt,
              endedAt: manifest.endedAt,
              configHash: manifest.configHash,
            },
          },
        ],
        results: [...checkResults, ...findingResults],
        properties: {
          runId: manifest.runId,
          mode: manifest.mode,
          tier: manifest.tier,
          multiAgent: manifest.multiAgent,
          baseSha: manifest.git.baseSha,
          headSha: manifest.git.headSha,
          configHash: manifest.configHash,
        },
      },
    ],
  };
}

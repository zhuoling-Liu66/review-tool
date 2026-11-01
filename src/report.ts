import path from 'node:path';
import type { RunManifest } from './types.js';
import { sanitizeUnsafeCharacters } from './util/injection.js';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function relative(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function statusLine(manifest: RunManifest): string {
  const status = manifest.status.replace('_', ' ');
  return `${status} (exit ${manifest.exitCode})`;
}

export function renderMarkdownReport(manifest: RunManifest): string {
  const reported = manifest.findings.filter((finding) => finding.status === 'reported');
  const suppressed = manifest.findings.filter((finding) => finding.status === 'suppressed');
  const needsHuman = manifest.findings.filter((finding) => finding.status === 'needs_human');
  const rejected = manifest.findings.filter((finding) => finding.status === 'rejected');
  const checksFailed = manifest.checks.filter(
    (check) => check.status === 'fail' || check.status === 'error',
  ).length;
  const blocks: string[] = [];

  blocks.push(`# AI Review Report — ${manifest.runId}`);
  blocks.push('');
  blocks.push('| Item | Value |');
  blocks.push('|---|---|');
  blocks.push(`| Status | ${statusLine(manifest)} |`);
  blocks.push(`| Trigger | ${manifest.trigger}${manifest.shadow ? ' (shadow)' : ''} |`);
  blocks.push(`| Tier / mode | ${manifest.tier} / ${manifest.mode} |`);
  blocks.push(`| Base / head | \`${manifest.git.baseSha.slice(0, 12)}\` → \`${manifest.git.headSha.slice(0, 12)}\` |`);
  blocks.push(`| Checks | ${manifest.checks.length} configured, ${checksFailed} failed |`);
  blocks.push(
    `| Findings | ${reported.length} reported, ${needsHuman.length} needs human, ${rejected.length} rejected, ${suppressed.length} suppressed |`,
  );
  blocks.push(
    `| Budget | ${manifest.budget.usedTokens.toLocaleString()} / ${manifest.budget.limitTokens.toLocaleString()} tokens; $${manifest.budget.usedUsd.toFixed(4)}${manifest.budget.priced ? '' : ' (unpriced)'}${manifest.budget.warning ? ' — 80% warning' : ''} |`,
  );
  blocks.push(
    `| Monthly budget | $${manifest.budget.monthlySpentUsd.toFixed(4)} / $${manifest.budget.monthlyLimitUsd.toFixed(2)} (${manifest.budget.monthlyPeriod})${manifest.budget.monthlyBlocked ? ' — HARD STOP' : manifest.budget.monthlyWarning ? ' — 80% warning' : ''} |`,
  );
  blocks.push(`| Config hash | \`${manifest.configHash}\` |`);
  blocks.push(
    `| Approval | ${manifest.approval.required ? (manifest.approval.satisfied ? `satisfied by ${manifest.approval.approver} (${manifest.approval.approverType})` : 'required, not satisfied') : 'not required'} |`,
  );
  blocks.push(
    `| Rounds | ${manifest.rounds.prNumber === null ? 'not tracked (no --pr)' : `${manifest.rounds.number}/${manifest.rounds.max}${manifest.rounds.limited ? ' — limit reached' : ''}`} |`,
  );
  blocks.push(`| Started / ended | ${manifest.startedAt} / ${manifest.endedAt} |`);
  blocks.push('');

  blocks.push('## Policy');
  blocks.push('');
  blocks.push(`- Tier: **${manifest.tier}**; mode: **${manifest.mode}**`);
  blocks.push(`- Reasons: ${manifest.policy.reasons.map((reason) => `\`${reason}\``).join(', ') || '(none)'}`);
  if (manifest.policy.sensitiveHits.length > 0) {
    blocks.push(`- Sensitive paths: ${manifest.policy.sensitiveHits.join(', ')}`);
  }
  const largeDiff = manifest.policy.reasons.find((reason) => reason.startsWith('large_diff:'));
  if (largeDiff) {
    blocks.push(`- **Large diff warning:** ${largeDiff.replace('large_diff:', '')} changed lines; consider splitting this PR.`);
  }
  if (manifest.security.injectionSuspicions.length > 0) {
    blocks.push(
      `- **Injection suspicion:** ${manifest.security.injectionSuspicions.join(', ')}. The reviewer treated code as untrusted; inspect manually.`,
    );
  }
  if (manifest.budget.warning) {
    blocks.push(
      `- **Budget warning:** ${manifest.budget.usedTokens.toLocaleString()} / ${manifest.budget.limitTokens.toLocaleString()} tokens used; consider reducing context or tier.`,
    );
  }
  if (manifest.budget.monthlyBlocked) {
    blocks.push(
      `- **Monthly budget hard stop:** $${manifest.budget.monthlySpentUsd.toFixed(4)} / $${manifest.budget.monthlyLimitUsd.toFixed(2)} spent in ${manifest.budget.monthlyPeriod}; AI review was skipped.`,
    );
  } else if (manifest.budget.monthlyWarning) {
    blocks.push(
      `- **Monthly budget warning:** $${manifest.budget.monthlySpentUsd.toFixed(4)} / $${manifest.budget.monthlyLimitUsd.toFixed(2)} spent in ${manifest.budget.monthlyPeriod}.`,
    );
  }
  if (manifest.approval.required && !manifest.approval.satisfied) {
    blocks.push(
      `- **Approval required:** tier ${manifest.tier}. Record it with \`review approve --run ${manifest.runId}\` (high risk requires --external --as). The run is blocked (exit 3).`,
    );
  } else if (manifest.approval.required && manifest.approval.satisfied) {
    blocks.push(
      `- Approval satisfied: ${manifest.approval.approver} (${manifest.approval.approverType}).`,
    );
  } else if (needsHuman.length > 0) {
    blocks.push('- **Human review is required because a blocker/security finding could not be confirmed or refuted by the lightweight verifier (exit 3).**');
  } else if (manifest.rounds.limited) {
    blocks.push(
      `- **Round limit reached (${manifest.rounds.max}).** Change the approach or reset with \`review reset-rounds --pr ${manifest.rounds.prNumber} --reason "..."\` (exit 3).`,
    );
  } else if (manifest.status === 'awaiting_approval') {
    blocks.push('- **Human approval is required because no reviewable files were available to the AI (exit 3).**');
  }
  blocks.push('');

  blocks.push('## Deterministic checks');
  blocks.push('');
  if (manifest.checks.length === 0) {
    blocks.push('No checks configured.');
  } else {
    blocks.push('| Check | Status | Blocking | Duration | Evidence |');
    blocks.push('|---|---|---|---|---|');
    for (const check of manifest.checks) {
      const evidence = check.logPath ? `[log](${relative(manifest.repoRoot, check.logPath)})` : '—';
      blocks.push(
        `| ${escapeCell(check.name)} | ${check.status} | ${check.blocking ? 'yes' : 'no'} | ${check.durationMs} ms | ${evidence} |`,
      );
    }
    const failed = manifest.checks.filter(
      (check) => check.status === 'fail' || check.status === 'error',
    );
    if (failed.length > 0) {
      blocks.push('');
      blocks.push('Failure details:');
      blocks.push('');
      for (const check of failed) {
        blocks.push(`- **${check.name}**: ${check.summary}`);
      }
    }
  }
  blocks.push('');

  blocks.push('## AI review');
  blocks.push('');
  blocks.push(`- Status: **${manifest.ai.status}**${manifest.ai.reason ? ` — ${manifest.ai.reason}` : ''}`);
  if (manifest.ai.model) blocks.push(`- Model: \`${manifest.ai.model}\``);
  if (manifest.ai.provider) blocks.push(`- Provider: \`${manifest.ai.provider}\``);
  if (manifest.ai.promptHash) blocks.push(`- Prompt hash: \`${manifest.ai.promptHash}\``);
  if (manifest.ai.usage) {
    blocks.push(
      `- Usage: ${manifest.ai.usage.inputTokens.toLocaleString()} in / ${manifest.ai.usage.outputTokens.toLocaleString()} out; $${manifest.ai.usage.costUsd.toFixed(4)}`,
    );
  }
  if (manifest.ai.cacheHits > 0) {
    blocks.push(`- Cache hits: ${manifest.ai.cacheHits} agent call(s) reused without model cost.`);
  }
  blocks.push(
    manifest.mode === 'standard' || manifest.mode === 'deep'
      ? manifest.multiAgent
        ? `- Verification: ${manifest.mode === 'deep' ? 'Deep' : 'Standard'} uses three independent verifier calls per published finding; majority confirm/reject, otherwise Needs human.`
        : `- Verification: multi_agent is off, so ${manifest.mode === 'deep' ? 'Deep' : 'Standard'} ran one Finder and one verifier call per finding.`
      : '- Verification: Quick verifies only blocker/security findings with one lightweight verifier; other findings remain advisory.',
  );
  blocks.push('');

  if (reported.length === 0) {
    blocks.push('No published findings.');
  } else {
    blocks.push('## Findings');
    blocks.push('');
    for (const finding of reported) {
      blocks.push(`### ${finding.id} · ${finding.severity} · ${finding.category}`);
      blocks.push('');
      blocks.push(`\`${finding.file}:${finding.line}${finding.endLine > finding.line ? `-${finding.endLine}` : ''}\``);
      blocks.push('');
      blocks.push(`**Claim:** ${finding.claim}`);
      blocks.push('');
      blocks.push(`**Evidence:** ${finding.evidence}`);
      if (finding.suggestion) {
        blocks.push('');
        blocks.push(`**Suggestion:** ${finding.suggestion}`);
      }
      blocks.push('');
      const verificationDetail =
        finding.verification === 'none'
          ? '**none** (advisory)'
          : `**${finding.verification}**${finding.verificationReason ? ` — ${finding.verificationReason}` : ''}${finding.verifiedBy ? ` (${finding.verifiedBy})` : ''}`;
      blocks.push(
        `Verification: ${verificationDetail} · Votes: C${finding.votes.confirm}/R${finding.votes.reject}/U${finding.votes.uncertain}/NA${finding.votes.unavailable} · Confidence: ${finding.confidence === null ? 'n/a' : finding.confidence.toFixed(2)} · Line in changed range: ${finding.grounding.lineInChangedRange ? 'yes' : 'no'}`,
      );
      blocks.push('');
    }
  }

  if (needsHuman.length > 0) {
    blocks.push('## Needs human');
    blocks.push('');
    blocks.push('These findings could not be confirmed or refuted by the lightweight verifier. Do not merge without resolving them.');
    blocks.push('');
    blocks.push('| ID | Severity | Category | Location | Claim | Verification |');
    blocks.push('|---|---|---|---|---|---|');
    for (const finding of needsHuman) {
      blocks.push(
        `| ${finding.id} | ${finding.severity} | ${finding.category} | ${escapeCell(`${finding.file}:${finding.line}`)} | ${escapeCell(finding.claim)} | ${escapeCell(finding.verificationReason ?? finding.verification)} |`,
      );
    }
    blocks.push('');
  }

  if (rejected.length > 0) {
    blocks.push('## Rejected findings');
    blocks.push('');
    blocks.push('The lightweight verifier refuted these findings; they are kept in the ledger for audit but are not published.');
    blocks.push('');
    for (const finding of rejected) {
      blocks.push(
        `- ${finding.id} · ${finding.file}:${finding.line} — ${finding.verificationReason ?? 'rejected'}`,
      );
    }
    blocks.push('');
  }

  if (suppressed.length > 0) {
    blocks.push('## Suppressed findings');
    blocks.push('');
    blocks.push('These were recorded in the ledger but are below the reporting threshold on this run.');
    blocks.push('');
    blocks.push('| ID | Severity | Category | Location | Claim |');
    blocks.push('|---|---|---|---|---|');
    for (const finding of suppressed) {
      blocks.push(
        `| ${finding.id} | ${finding.severity} | ${finding.category} | ${escapeCell(`${finding.file}:${finding.line}`)} | ${escapeCell(finding.claim)} |`,
      );
    }
    blocks.push('');
  }

  blocks.push('## Artifacts');
  blocks.push('');
  blocks.push(`- Run directory: \`${relative(manifest.repoRoot, manifest.artifactDir)}\``);
  blocks.push(`- Report: \`${relative(manifest.repoRoot, manifest.reportPath)}\``);
  blocks.push(`- Ledger: \`.review/ledger.jsonl\``);
  blocks.push('');

  blocks.push('## M1/M2/M3 limitations');
  blocks.push('');
  blocks.push(
    manifest.mode === 'standard' || manifest.mode === 'deep'
      ? manifest.multiAgent
        ? `- ${manifest.mode === 'deep' ? 'Deep' : 'Standard'} uses ${manifest.mode === 'deep' ? 'four' : 'three'} Finder perspectives and three verifier calls per published finding.`
        : `- ${manifest.mode === 'deep' ? 'Deep' : 'Standard'} ran with multi_agent: off (one Finder, one verifier call) for cost control.`
      : '- Quick uses one Finder; blocker/security findings get one lightweight verifier, while other findings remain advisory.',
  );
  blocks.push('- Approval command and cooldown checks are implemented; local self-attestation cannot prove identity. High-risk external approval is recorded from the provided identity.');
  blocks.push('- SARIF and GitHub comments are exports; the JSONL ledger remains the audit source of truth.');
  blocks.push('- Deterministic checks and human review remain authoritative.');
  blocks.push('');

  return sanitizeUnsafeCharacters(blocks.join('\n')).text;
}

export function renderTerminalSummary(manifest: RunManifest): string {
  const reported = manifest.findings.filter((finding) => finding.status === 'reported');
  const needsHuman = manifest.findings.filter((finding) => finding.status === 'needs_human');
  const rejected = manifest.findings.filter((finding) => finding.status === 'rejected');
  const blockers = reported.filter((finding) => finding.severity === 'blocker').length;
  const failed = manifest.checks.filter(
    (check) => check.status === 'fail' || check.status === 'error',
  ).length;
  const largeDiff = manifest.policy.reasons.find((reason) => reason.startsWith('large_diff:'));
  return [
    `Run ${manifest.runId} ${manifest.status} (exit ${manifest.exitCode})`,
    `Tier/mode: ${manifest.tier}/${manifest.mode}; checks failed: ${failed}`,
    `Findings: ${reported.length} reported (${blockers} blocker), ${needsHuman.length} needs human, ${rejected.length} rejected; AI: ${manifest.ai.status}${manifest.ai.reason ? ` (${manifest.ai.reason})` : ''}`,
    `Budget: ${manifest.budget.usedTokens}/${manifest.budget.limitTokens} tokens; $${manifest.budget.usedUsd.toFixed(4)}${manifest.budget.priced ? '' : ' (unpriced)'}${manifest.budget.warning ? ' [80% WARNING]' : ''}`,
    `Monthly: $${manifest.budget.monthlySpentUsd.toFixed(4)}/$${manifest.budget.monthlyLimitUsd.toFixed(2)}${manifest.budget.monthlyBlocked ? ' [HARD STOP]' : manifest.budget.monthlyWarning ? ' [80% WARNING]' : ''}`,
    ...(largeDiff
      ? [`Large diff: ${largeDiff.replace('large_diff:', '')} changed lines; consider splitting.`]
      : []),
    `Report: ${relative(manifest.repoRoot, manifest.reportPath)}`,
    `Ledger: .review/ledger.jsonl`,
  ].join('\n');
}

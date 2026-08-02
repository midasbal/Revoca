/**
 * Renders an AuditReport (backend/src/audit/reconstruct.ts) as clean,
 * human-readable markdown. The JSON form (the AuditReport object itself)
 * is already machine-readable, this is the companion human-facing format
 * Part 2 of docs/AUDIT_REPORT.md asks for.
 */
import type { AuditReport, PositionReport, TimelineEntry } from "./types.js";

function line(...parts: (string | number)[]): string {
  return parts.join(" ") + "\n";
}

function fmtTimeline(entry: TimelineEntry): string {
  const when = new Date(Number(entry.source.timestamp) * 1000).toISOString();
  const detail = JSON.stringify(entry.detail, (_k, v) =>
    v && typeof v === "object" && "raw" in v && "formatted" in v ? v.formatted : v,
  );
  return `- \`${when}\` **${entry.type}** ${detail} (tx \`${entry.source.txHash}\`, block ${entry.source.blockNumber}, log ${entry.source.logIndex})`;
}

function renderPosition(p: PositionReport): string {
  const out: string[] = [];
  out.push(`### Position: ${p.borrower}\n`);
  if (p.originatedAt) {
    out.push(
      line(
        "Originated:",
        new Date(Number(p.originatedAt.timestamp) * 1000).toISOString(),
        `(tx ${p.originatedAt.txHash})`,
      ),
    );
  }
  out.push("");
  out.push(`**Cross-check:** ${p.crossCheckOk ? "PASS" : "FAIL"}`);
  if (!p.crossCheckOk) {
    for (const d of p.crossCheckDiscrepancies) out.push(`  - ${d}`);
  }
  out.push("");
  out.push("**Reconstructed vs on-chain (as of report block):**\n");
  out.push("| | reconstructed | on-chain |");
  out.push("|---|---|---|");
  out.push(`| principal | ${p.reconstructed.principal.formatted} | ${p.onChain.principal.formatted} |`);
  out.push(`| collateral | ${p.reconstructed.collateral.formatted} | ${p.onChain.collateral.formatted} |`);
  out.push(`| debt (projected) | ${p.reconstructed.debtAsOfReport.formatted} | ${p.onChain.debtAsOfReport.formatted} |`);
  out.push(`| guardian state | ${p.reconstructed.guardianState} | ${p.onChain.guardianState} |`);
  out.push("");

  if (p.complianceObservations.length > 0) {
    out.push("**Compliance observations:**\n");
    for (const o of p.complianceObservations) {
      const when = new Date(Number(o.source.timestamp) * 1000).toISOString();
      out.push(
        `- \`${when}\` attestor ${o.attestor}, tier ${o.tier}/${o.subTier}, country ${o.country}, apassStatus ${o.apassStatus}, nonce ${o.nonce} (tx \`${o.source.txHash}\`)`,
      );
    }
    out.push("");
  }

  if (p.unwinds.length > 0) {
    out.push("**Unwind history:**\n");
    for (const [i, u] of p.unwinds.entries()) {
      out.push(`${i + 1}. Flagged **${u.reason}** at ${new Date(Number(u.flaggedAt.timestamp) * 1000).toISOString()} (tx \`${u.flaggedAt.txHash}\`), grace ends ${new Date(Number(u.graceEndsAt) * 1000).toISOString()}`);
      if (u.reinstatedAt) {
        out.push(`   - Reinstated at ${new Date(Number(u.reinstatedAt.timestamp) * 1000).toISOString()} (tx \`${u.reinstatedAt.txHash}\`)`);
      }
      if (u.unwindStarted) {
        out.push(
          `   - Unwind started at ${new Date(Number(u.unwindStarted.source.timestamp) * 1000).toISOString()}: debt ${u.unwindStarted.debtAtStart.formatted}, collateral ${u.unwindStarted.collateralAtStart.formatted}`,
        );
      }
      for (const step of u.steps) {
        out.push(`   - Step \`${step.step}\`: applied ${step.amount.formatted}, remaining debt ${step.remainingDebt.formatted}`);
      }
      if (u.liquidation) {
        out.push(
          `   - Liquidation: debt repaid ${u.liquidation.debtRepaid.formatted}, collateral seized ${u.liquidation.collateralSeized.formatted}, remaining collateral ${u.liquidation.remainingCollateral.formatted}`,
        );
      }
      if (u.completedAt) {
        out.push(
          `   - Resolved at ${new Date(Number(u.completedAt.source.timestamp) * 1000).toISOString()}, residual collateral returned: ${u.completedAt.residualCollateral.formatted}`,
        );
      }
    }
    out.push("");
  }

  out.push("**Full timeline:**\n");
  for (const t of p.timeline) out.push(fmtTimeline(t));
  out.push("");
  return out.join("\n");
}

export function renderMarkdown(report: AuditReport): string {
  const out: string[] = [];
  out.push(`# Revoca audit report\n`);
  out.push(`Pool: \`${report.meta.pool}\` on chain ${report.meta.chainId}`);
  out.push(`Range: block ${report.meta.fromBlock} to ${report.meta.toBlock}`);
  out.push(`Generated at block ${report.meta.generatedAtBlock}, ${new Date(Number(report.meta.generatedAtTimestamp) * 1000).toISOString()}`);
  out.push(`Asset: ${report.meta.assetSymbol} (\`${report.meta.asset}\`, ${report.meta.assetDecimals} decimals)`);
  out.push("");
  out.push(`**Overall cross-check: ${report.crossCheckOk ? "PASS" : "FAIL"}**`);
  out.push("");

  out.push("## Pool aggregate\n");
  out.push(`- Positions: ${report.aggregate.positionCount}`);
  for (const [state, count] of Object.entries(report.aggregate.byFinalGuardianState)) {
    out.push(`  - ${state}: ${count}`);
  }
  out.push(`- Total interest realized: ${report.aggregate.totalInterestRealized.formatted}`);
  out.push(`- Total collateral seized by liquidation: ${report.aggregate.totalCollateralSeizedByLiquidation.formatted}`);
  out.push(`- Total residual collateral returned: ${report.aggregate.totalResidualCollateralReturned.formatted}`);
  out.push("");

  out.push("## Compliance policy\n");
  out.push(`Cross-check: ${report.policy.crossCheckOk ? "PASS" : "FAIL"}`);
  out.push("");
  out.push("As of report block:\n");
  out.push("```json");
  out.push(JSON.stringify(report.policy.asOfReport, null, 2));
  out.push("```\n");
  if (report.policy.history.length > 0) {
    out.push("Change history:\n");
    for (const h of report.policy.history) {
      const when = new Date(Number(h.source.timestamp) * 1000).toISOString();
      out.push(`- \`${when}\` **${h.type}** ${JSON.stringify(h.detail)} (tx \`${h.source.txHash}\`)`);
    }
    out.push("");
  }

  out.push("## Positions\n");
  for (const p of report.positions) out.push(renderPosition(p));

  return out.join("\n");
}

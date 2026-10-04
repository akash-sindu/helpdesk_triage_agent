import {
  REGRESSION_DIMENSIONS,
  type EvalSnapshot,
  type RegressionCase,
  type RegressionComparison,
  type RegressionDimension,
} from "../../backend/src/regression-metrics.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function percentage(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function caseOutput(testCase: RegressionCase | undefined): string {
  if (!testCase) return "No previous result";
  return JSON.stringify(
    {
      category: testCase.actual.category,
      isHighRisk: testCase.actual.is_high_risk,
      outcome: testCase.actual.outcome,
      citedArticleIds: testCase.actual.cited_article_ids,
      response: testCase.actual.response,
      errors: [
        testCase.actual.classify_error,
        testCase.actual.draft_error,
      ].filter(Boolean),
    },
    null,
    2,
  );
}

function trendSvg(runs: EvalSnapshot[]): string {
  const width = 680;
  const height = 180;
  const padding = 24;
  const plotHeight = 112;
  const points = runs.slice(-7);
  const barWidth = Math.min(
    54,
    (width - padding * 2) / Math.max(points.length, 1) - 8,
  );
  const bars = points
    .map((run, index) => {
      const score = Math.max(0, Math.min(1, run.summary.casePassRate));
      const barHeight = score * plotHeight;
      const x =
        padding +
        index * ((width - padding * 2) / Math.max(points.length, 1)) +
        4;
      const y = padding + plotHeight - barHeight;
      const label = escapeHtml(run.generatedAt.slice(0, 10));
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="#147d73"/><text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle">${Math.round(score * 100)}%</text><text x="${x + barWidth / 2}" y="${padding + plotHeight + 20}" text-anchor="middle">${label}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Case pass rate over recent evaluation runs"><line x1="${padding}" y1="${padding + plotHeight}" x2="${width - padding}" y2="${padding + plotHeight}" stroke="#aebbb7"/><text x="${padding}" y="14">Case pass rate</text>${bars}</svg>`;
}

export function buildHtmlReport(
  current: EvalSnapshot,
  previous: EvalSnapshot | null,
  comparison: RegressionComparison,
  trend: EvalSnapshot[],
): string {
  const oldCases = new Map(
    (previous?.cases ?? []).map((testCase) => [testCase.id, testCase]),
  );
  const currentCases = new Map(
    current.cases.map((testCase) => [testCase.id, testCase]),
  );
  const regressionRows = comparison.regressions
    .map((id) => {
      const oldOutput = caseOutput(oldCases.get(id));
      const newOutput = caseOutput(currentCases.get(id));
      return `<tr><th>${escapeHtml(id)}</th><td><pre>${escapeHtml(oldOutput)}</pre></td><td><pre>${escapeHtml(newOutput)}</pre></td></tr>`;
    })
    .join("");
  const dimensionRows = REGRESSION_DIMENSIONS.map(
    (dimension: RegressionDimension) => {
      const delta = comparison.deltas[dimension];
      return `<tr><th>${escapeHtml(dimension)}</th><td>${percentage(previous?.summary.dimensions[dimension] ?? null)}</td><td>${percentage(current.summary.dimensions[dimension])}</td><td>${delta ? `${delta.delta > 0 ? "+" : ""}${(delta.delta * 100).toFixed(1)} pp` : "N/A"}</td></tr>`;
    },
  ).join("");
  const categoryRows = Object.entries(current.summary.categoryAccuracy)
    .map(([category, accuracy]) => {
      const delta = comparison.categoryDeltas[category];
      return `<tr><th>${escapeHtml(category)}</th><td>${percentage(previous?.summary.categoryAccuracy[category] ?? null)}</td><td>${percentage(accuracy)}</td><td>${delta ? `${delta.delta > 0 ? "+" : ""}${(delta.delta * 100).toFixed(1)} pp` : "N/A"}</td></tr>`;
    })
    .join("");
  const statusColor =
    comparison.status === "critical"
      ? "#b42318"
      : comparison.status === "warning"
        ? "#a15c00"
        : "#147d73";
  const generated = new Date(current.generatedAt).toLocaleString("en-US", {
    timeZone: "UTC",
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Helpdesk prompt regression report</title>
<style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#182522;background:#f4f7f5}body{max-width:1120px;margin:0 auto;padding:32px 20px}h1{font-size:1.8rem;margin:0 0 8px}h2{font-size:1.15rem;margin:30px 0 10px}.meta{color:#53625e;margin:0 0 22px}.status{display:inline-block;padding:5px 9px;color:#fff;background:${statusColor};font-weight:700;text-transform:uppercase;border-radius:3px}.scorecard{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:#cad5d1;border:1px solid #cad5d1}.score{background:#fff;padding:14px}.score strong{display:block;font-size:1.45rem}.score span{color:#53625e;font-size:.86rem}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dfe6e3}thead th{background:#e8efec}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.45 ui-monospace,monospace;max-width:480px}svg{width:min(100%,680px);height:auto;background:#fff}svg text{font:11px ui-sans-serif,system-ui,sans-serif;fill:#53625e}.empty{padding:14px;background:#fff;color:#53625e}@media(max-width:650px){body{padding:20px 12px}th,td{padding:7px}.regressions{display:block;overflow-x:auto}}
</style></head><body>
<h1>Helpdesk prompt regression report</h1><p class="meta"><span class="status">${comparison.status}</span> &nbsp; Run ${escapeHtml(current.runId)} · ${escapeHtml(generated)} UTC · model ${escapeHtml(current.model)} · prompts classify ${escapeHtml(current.promptVersions.classify)}, draft ${escapeHtml(current.promptVersions.draft)}</p>
<div class="scorecard"><div class="score"><strong>${percentage(current.summary.casePassRate)}</strong><span>Case pass rate${previous ? ` · baseline ${percentage(previous.summary.casePassRate)}` : " · no baseline"}</span></div><div class="score"><strong>${percentage(current.summary.dimensions.category_match)}</strong><span>Category accuracy</span></div><div class="score"><strong>${percentage(current.summary.dimensions.risk_match)}</strong><span>Risk detection</span></div><div class="score"><strong>${comparison.riskRegressionIds.length}</strong><span>Risk regressions</span></div><div class="score"><strong>${comparison.regressions.length}</strong><span>Regressed cases</span></div><div class="score"><strong>${comparison.improvements.length}</strong><span>Improved cases</span></div></div>
<h2>Recent trend</h2>${trendSvg(trend)}
<h2>Dimension comparison</h2><table><thead><tr><th>Dimension</th><th>Previous</th><th>Current</th><th>Delta</th></tr></thead><tbody>${dimensionRows}</tbody></table>
<h2>Category accuracy</h2><table><thead><tr><th>Category</th><th>Previous</th><th>Current</th><th>Delta</th></tr></thead><tbody>${categoryRows}</tbody></table>
<h2>Regressed cases</h2>${regressionRows ? `<table class="regressions"><thead><tr><th>Case</th><th>Previous output</th><th>Current output</th></tr></thead><tbody>${regressionRows}</tbody></table>` : `<p class="empty">No pass-to-fail case flips against the previous baseline.</p>`}
<h2>Drift monitor</h2><p>Rolling window: ${comparison.drift.runCount} runs. Dimensions below configured floor: ${comparison.drift.belowFloor.map(escapeHtml).join(", ") || "none"}.</p>
</body></html>`;
}

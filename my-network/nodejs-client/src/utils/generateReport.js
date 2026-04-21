#!/usr/bin/env node

/**
 * Generate FL Training Report from saved global models.
 * Supports:
 *   - 'regression'     datasets (linear): shows weight & bias evolution
 *   - 'classification' datasets (mnist, ...):    shows accuracy & loss from evaluation JSONs
 *
 * To add a new dataset, register it in DATASET_TYPES below.
 *
 * Usage:
 *   node src/utils/generateReport.js [dataset]
 *   node src/utils/generateReport.js mnist
 *   node src/utils/generateReport.js linear
 */

const fs = require('fs');
const path = require('path');

const DATASET = (process.argv[2] || process.env.FL_DATASET || 'linear').toLowerCase();

// Map each known dataset name to its task type.
// 'regression'     → stores scalar [w, b] in modelData; no external evaluation files needed.
// 'classification' → stores full CNN weights; reads per-round evaluation JSONs for accuracy/loss.
const DATASET_TYPES = {
  linear: 'regression',
  mnist:  'classification',
  cifar:  'classification',
};
const TYPE = DATASET_TYPES[DATASET] || 'classification';

const EVALS_DIR  = path.join(__dirname, '..', '..', 'reports', 'evaluations');
const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
const OUTPUT_FILE = path.join(REPORTS_DIR, `fl-training-report-${DATASET}.html`);
const MODELS_DIR = path.join(__dirname, '..', '..', 'models', DATASET);

// ── Data loading ──────────────────────────────────────────────────────────────

function loadGlobalModels() {
  const dirs = [MODELS_DIR, path.join(MODELS_DIR, 'sync'), path.join(MODELS_DIR, 'async')]
    .filter((d) => fs.existsSync(d));
  const pattern = /^global-model-(round|version)-(\d+)\.json$/;

  const models = [];
  for (const dir of dirs) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const m = file.match(pattern);
      if (!m) continue;
      const index = Number(m[2]);
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const model = JSON.parse(content);
      if (!Number.isInteger(model.round) || model.round <= 0) {
        model.round = index;
      }
      if (!Number.isInteger(model.version) || model.version <= 0) {
        model.version = index;
      }
      models.push(model);
    }
  }

  models.sort((a, b) => a.round - b.round);
  return models;
}

/** For linear datasets: extract scalar w and b from each round's modelData. */
function extractLinearParams(models) {
  const rounds = [], weights = [], biases = [], participants = [], samples = [];

  for (const model of models) {
    rounds.push(model.round);
    const params = JSON.parse(model.modelData);
    weights.push(params[0]);
    biases.push(params[1]);
    participants.push(model.participantCount || (model.participants ? model.participants.length : 0));
    samples.push(model.totalSamples || 0);
  }

  return { rounds, weights, biases, participants, samples };
}

/** For all datasets: extract participation statistics per round. */
function extractParticipation(models) {
  const rounds = [], participants = [], samples = [];

  for (const model of models) {
    rounds.push(model.round);
    participants.push(model.participantCount || (model.participants ? model.participants.length : 0));
    samples.push(model.totalSamples || 0);
  }

  return { rounds, participants, samples };
}

/**
 * Load evaluation result files produced by evaluateModel.js.
 * Preferred pattern: reports/evaluations/<dataset>/evaluation-round-<n>.json
 * Legacy pattern:    reports/evaluations/evaluation-<dataset>-round-<n>.json
 */
function loadEvaluations() {
  if (!fs.existsSync(EVALS_DIR)) return [];
  const datasetEvalDir = path.join(EVALS_DIR, DATASET);
  const patternNew = /^evaluation-round-(\d+)\.json$/;
  const patternLegacy = new RegExp(`^evaluation-${DATASET}-round-(\\d+)\\.json$`);
  const evals = [];

  if (fs.existsSync(datasetEvalDir)) {
    for (const file of fs.readdirSync(datasetEvalDir)) {
      if (!patternNew.test(file)) continue;
      try {
        evals.push(JSON.parse(fs.readFileSync(path.join(datasetEvalDir, file), 'utf8')));
      } catch (_) { /* skip malformed files */ }
    }
  }

  // Backward compatibility for existing flat evaluation files.
  for (const file of fs.readdirSync(EVALS_DIR)) {
    if (!patternLegacy.test(file)) continue;
    try {
      evals.push(JSON.parse(fs.readFileSync(path.join(EVALS_DIR, file), 'utf8')));
    } catch (_) { /* skip malformed files */ }
  }

  evals.sort((a, b) => a.round - b.round);
  return evals;
}

// ── HTML generation ───────────────────────────────────────────────────────────

const COMMON_CSS = `
    :root {
      --bg: #0b1020;
      --card: #121a33;
      --text: #eaf0ff;
      --muted: #9fb0d9;
      --primary: #4ecdc4;
      --secondary: #ffd166;
      --accent: #ff6b6b;
      --grid: rgba(255, 255, 255, 0.08);
    }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      background: radial-gradient(circle at top right, #18244a 0%, var(--bg) 45%);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
      box-sizing: border-box;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .card {
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      padding: 24px;
      backdrop-filter: blur(4px);
    }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; }
    h2 { margin: 0 0 16px; font-size: 18px; font-weight: 500; }
    p  { margin: 0; color: var(--muted); line-height: 1.6; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .stat {
      background: rgba(255,255,255,0.02);
      padding: 16px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .stat-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .stat-value { font-size: 24px; font-weight: 600; color: var(--text); }
    .chart-container { position: relative; height: 300px; margin-top: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.06); }
    th { font-weight: 500; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { color: var(--text); font-family: 'Courier New', monospace; }
    .timestamp { font-size: 14px; color: var(--muted); margin-top: 8px; }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 12px;
      font-size: 12px; font-weight: 500;
      background: rgba(78,205,196,0.15); color: var(--primary);
      border: 1px solid rgba(78,205,196,0.3);
    }
    .badge-warn {
      background: rgba(255,209,102,0.15); color: var(--secondary);
      border-color: rgba(255,209,102,0.3);
    }
    .note { font-size: 13px; color: var(--muted); margin-top: 8px; }`;

function generateHTMLReport(models, evals) {
  const datasetLabel = DATASET.toUpperCase();

  if (models.length === 0) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>FL Training Report – ${datasetLabel}</title>
<style>body{font-family:sans-serif;padding:40px;background:#f5f5f5}.error{background:#fff;padding:20px;border-radius:8px;color:#666}</style>
</head><body><div class="error">
  <h1>No Training Data Found</h1>
  <p>No global model files found in <code>models/${DATASET}</code>.</p>
  <p>Run training first: <code>node src/launchClients.js 5 sync ${DATASET}</code></p>
</div></body></html>`;
  }

  const latestModel = models[models.length - 1];
  const participation = extractParticipation(models);

  return TYPE === 'regression'
    ? generateLinearHTML(models, latestModel, participation, evals, datasetLabel)
    : generateClassificationHTML(models, latestModel, participation, evals, datasetLabel);
}

// ── Linear report ─────────────────────────────────────────────────────────────

function generateLinearHTML(models, latestModel, participation, evals, datasetLabel) {
  const data = extractLinearParams(models);
  const evalByRound = {};
  for (const e of evals) {
    evalByRound[e.round] = e.result && e.result.overall ? e.result.overall : null;
  }

  const latestEval = evals.length > 0 ? evals[evals.length - 1] : null;
  const latestMetrics = latestEval && latestEval.result && latestEval.result.overall
    ? latestEval.result.overall : null;
  const hasEvals = evals.length > 0;
  const evalRounds = evals.map((e) => e.round);
  const evalMse = evals.map((e) => e.result && e.result.overall ? +e.result.overall.mse.toFixed(6) : null);
  const evalMae = evals.map((e) => e.result && e.result.overall ? +e.result.overall.mae.toFixed(6) : null);
  const evalR2 = evals.map((e) => e.result && e.result.overall ? +e.result.overall.r2.toFixed(6) : null);

  const tableRows = models.map(m => {
    const params = JSON.parse(m.modelData);
    const ts = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : 'N/A';
    const pInfo = m.participants && m.participants.length > 0
      ? m.participants.join(', ') : (m.participantCount || 'N/A');
    const ev = evalByRound[m.round];
    return `          <tr>
            <td>${m.round}</td>
            <td>${params[0].toFixed(6)}</td>
            <td>${params[1].toFixed(6)}</td>
            <td>${ev ? ev.mse.toFixed(6) : '—'}</td>
            <td>${ev ? ev.mae.toFixed(6) : '—'}</td>
            <td>${ev ? ev.r2.toFixed(6) : '—'}</td>
            <td>${pInfo}</td>
            <td>${m.totalSamples || 'N/A'}</td>
            <td>${ts}</td>
          </tr>`;
  }).join('\n');

  const evalNote = hasEvals
    ? `Evaluation data available for ${evals.length} round(s): ${evalRounds.join(', ')}.
       Run <code>node src/utils/evaluateModel.js ${DATASET} &lt;round&gt;</code> to add more.`
    : `No evaluation data found. Run <code>node src/utils/evaluateModel.js ${DATASET} latest</code> to generate MSE/MAE/R2 metrics.`;

  const evalChartBlock = hasEvals ? `
    <div class="card">
      <h2>🎯 Regression Metrics (Evaluated Rounds)</h2>
      <div class="chart-container"><canvas id="metricsChart"></canvas></div>
    </div>` : `
    <div class="card">
      <h2>🎯 Regression Metrics</h2>
      <p class="note">${evalNote}</p>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FL Training Report – ${datasetLabel}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>${COMMON_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>🔄 Federated Learning Training Report</h1>
      <p>Hierarchical two-layer FL aggregation on Hyperledger Fabric &mdash; Linear Regression (${datasetLabel})</p>
      <div class="timestamp">
        Generated: ${new Date().toLocaleString()} |
        <span class="badge">VPSA Strategy</span>
        <span class="badge" style="margin-left:6px">${datasetLabel}</span>
      </div>
    </div>

    <div class="card">
      <h2>📊 Training Summary</h2>
      <div class="summary-grid">
        <div class="stat"><div class="stat-label">Total Rounds</div><div class="stat-value">${models.length}</div></div>
        <div class="stat"><div class="stat-label">Evaluated Rounds</div><div class="stat-value">${evals.length}</div></div>
        <div class="stat"><div class="stat-label">Latest Weight (w)</div><div class="stat-value">${data.weights[data.weights.length - 1].toFixed(4)}</div></div>
        <div class="stat"><div class="stat-label">Latest Bias (b)</div><div class="stat-value">${data.biases[data.biases.length - 1].toFixed(4)}</div></div>
        ${latestMetrics ? `
        <div class="stat"><div class="stat-label">Latest MSE (Rd ${latestEval.round})</div><div class="stat-value">${latestMetrics.mse.toFixed(4)}</div></div>
        <div class="stat"><div class="stat-label">Latest MAE (Rd ${latestEval.round})</div><div class="stat-value">${latestMetrics.mae.toFixed(4)}</div></div>
        <div class="stat"><div class="stat-label">Latest R² (Rd ${latestEval.round})</div><div class="stat-value" style="color:var(--primary)">${latestMetrics.r2.toFixed(4)}</div></div>
        <div class="stat"><div class="stat-label">Eval Sample Size</div><div class="stat-value">${latestMetrics.sampleCount || 'N/A'}</div></div>` : ''}
        <div class="stat"><div class="stat-label">Participants</div><div class="stat-value">${latestModel.participantCount || latestModel.participants?.length || 'N/A'}</div></div>
        <div class="stat"><div class="stat-label">Total Samples</div><div class="stat-value">${latestModel.totalSamples || 'N/A'}</div></div>
        ${latestModel.participants && latestModel.participants.length > 0 ? `
        <div class="stat" style="grid-column:1/-1">
          <div class="stat-label">Organizations</div>
          <div class="stat-value" style="font-size:16px">${latestModel.participants.join(', ')}</div>
        </div>` : ''}
      </div>
    </div>

    ${evalChartBlock}

    <div class="card">
      <h2>📈 Model Parameters Evolution</h2>
      <div class="chart-container"><canvas id="paramsChart"></canvas></div>
    </div>

    <div class="card">
      <h2>👥 Participation Statistics</h2>
      <div class="chart-container"><canvas id="participationChart"></canvas></div>
    </div>

    <div class="card">
      <h2>📋 Detailed Round History</h2>
      ${!hasEvals ? `<p class="note" style="margin-bottom:12px">${evalNote}</p>` : ''}
      <table>
        <thead><tr><th>Round</th><th>Weight (w)</th><th>Bias (b)</th><th>MSE</th><th>MAE</th><th>R²</th><th>Participants</th><th>Total Samples</th><th>Timestamp</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>

  <script>
    const C = {
      teal: 'rgba(78,205,196,1)', yellow: 'rgba(255,209,102,1)',
      red:  'rgba(255,107,107,1)', blue:  'rgba(159,176,217,1)',
      grid: 'rgba(255,255,255,0.08)'
    };

    ${hasEvals ? `
    new Chart(document.getElementById('metricsChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(evalRounds)},
        datasets: [
          { label: 'MSE', data: ${JSON.stringify(evalMse)},
            borderColor: C.red, backgroundColor: 'rgba(255,107,107,0.08)', tension: 0.3, fill: false, yAxisID: 'yErr' },
          { label: 'MAE', data: ${JSON.stringify(evalMae)},
            borderColor: C.yellow, backgroundColor: 'rgba(255,209,102,0.08)', tension: 0.3, fill: false, yAxisID: 'yErr' },
          { label: 'R²', data: ${JSON.stringify(evalR2)},
            borderColor: C.teal, backgroundColor: 'rgba(78,205,196,0.12)', tension: 0.3, fill: false, yAxisID: 'yR2' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' } } },
        scales: {
          x: { title: { display: true, text: 'Round', color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' } },
          yErr: { type: 'linear', position: 'left',
            title: { display: true, text: 'Error', color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' }, min: 0 },
          yR2: { type: 'linear', position: 'right',
            title: { display: true, text: 'R²', color: '#9fb0d9' }, grid: { display: false }, ticks: { color: '#9fb0d9' }, min: 0, max: 1 }
        }
      }
    });` : '/* no regression evaluation data */'}

    new Chart(document.getElementById('paramsChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(data.rounds)},
        datasets: [
          { label: 'Weight (w)', data: ${JSON.stringify(data.weights)},
            borderColor: C.teal,  backgroundColor: 'rgba(78,205,196,0.1)',  tension: 0.3, fill: true },
          { label: 'Bias (b)',   data: ${JSON.stringify(data.biases)},
            borderColor: C.yellow, backgroundColor: 'rgba(255,209,102,0.1)', tension: 0.3, fill: true }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' } } },
        scales: {
          x: { title: { display: true, text: 'Round',  color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' } },
          y: { title: { display: true, text: 'Value',  color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' } }
        }
      }
    });

    new Chart(document.getElementById('participationChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(participation.rounds)},
        datasets: [
          { label: 'Participants',  data: ${JSON.stringify(participation.participants)},
            backgroundColor: 'rgba(255,107,107,0.7)', borderColor: C.red,  borderWidth: 1, yAxisID: 'y'  },
          { label: 'Total Samples', data: ${JSON.stringify(participation.samples)},
            backgroundColor: 'rgba(159,176,217,0.7)', borderColor: C.blue, borderWidth: 1, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' } } },
        scales: {
          x:  { title: { display: true, text: 'Round',        color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' } },
          y:  { type: 'linear', position: 'left',  title: { display: true, text: 'Participants', color: '#9fb0d9' },
                grid: { color: C.grid }, ticks: { color: '#9fb0d9', stepSize: 1, precision: 0,
                  callback: v => Number.isInteger(v) ? v : undefined } },
          y1: { type: 'linear', position: 'right', title: { display: true, text: 'Samples',      color: '#9fb0d9' },
                grid: { display: false }, ticks: { color: '#9fb0d9' } }
        }
      }
    });
  </script>
</body>
</html>`;
}

// ── Classification report ─────────────────────────────────────────────────────

function generateClassificationHTML(models, latestModel, participation, evals, datasetLabel) {
  // Build a lookup: round → eval result
  const evalByRound = {};
  for (const e of evals) evalByRound[e.round] = e.result && e.result.overall ? e.result.overall : null;

  const latestEval = evals.length > 0 ? evals[evals.length - 1] : null;
  const latestMetrics = latestEval && latestEval.result && latestEval.result.overall
    ? latestEval.result.overall : null;

  const hasEvals = evals.length > 0;

  // Data for accuracy / loss chart (only evaluated rounds)
  const evalRounds    = evals.map(e => e.round);
  const evalAccuracy  = evals.map(e => e.result && e.result.overall ? +(e.result.overall.accuracy * 100).toFixed(2) : null);
  const evalLoss      = evals.map(e => e.result && e.result.overall ? +e.result.overall.loss.toFixed(6)             : null);

  // Data for Precision / Recall / F1 chart (rounds that have extended metrics)
  const hasF1Data     = evals.some(e => e.result && e.result.overall && e.result.overall.f1 !== undefined);
  const evalPrecision = evals.map(e => e.result && e.result.overall && e.result.overall.precision !== undefined
    ? +(e.result.overall.precision * 100).toFixed(2) : null);
  const evalRecall    = evals.map(e => e.result && e.result.overall && e.result.overall.recall !== undefined
    ? +(e.result.overall.recall * 100).toFixed(2) : null);
  const evalF1        = evals.map(e => e.result && e.result.overall && e.result.overall.f1 !== undefined
    ? +(e.result.overall.f1 * 100).toFixed(2) : null);
  const latestPerClass = latestEval && latestEval.result && latestEval.result.perClass
    ? latestEval.result.perClass : null;
  const perClassLabel = DATASET === 'mnist' ? 'Digit' : 'Class';

  // Per-round table rows (all training rounds; merge eval data where available)
  const tableRows = models.map(m => {
    const ts    = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : 'N/A';
    const pInfo = m.participants && m.participants.length > 0
      ? m.participants.join(', ') : (m.participantCount || 'N/A');
    const ev    = evalByRound[m.round];
    const acc   = ev ? (ev.accuracy * 100).toFixed(2) + '%' : '—';
    const loss  = ev ? ev.loss.toFixed(6) : '—';
    const f1    = ev && ev.f1 !== undefined ? (ev.f1 * 100).toFixed(2) + '%' : '—';
    return `          <tr>
            <td>${m.round}</td>
            <td>${acc}</td>
            <td>${loss}</td>
            <td>${f1}</td>
            <td>${pInfo}</td>
            <td>${m.totalSamples || 'N/A'}</td>
            <td>${ts}</td>
          </tr>`;
  }).join('\n');

  const evalNote = hasEvals
    ? `Evaluation data available for ${evals.length} round(s): ${evalRounds.join(', ')}.
       Run <code>node src/utils/evaluateModel.js ${DATASET} &lt;round&gt; 2000</code> to add more.`
    : `No evaluation data found. Run <code>node src/utils/evaluateModel.js ${DATASET} latest 2000</code> to generate accuracy metrics.`;

  const evalChartBlock = hasEvals ? `
    <div class="card">
      <h2>🎯 Accuracy &amp; Loss (Evaluated Rounds)</h2>
      <div class="chart-container"><canvas id="metricsChart"></canvas></div>
    </div>` : `
    <div class="card">
      <h2>🎯 Accuracy &amp; Loss</h2>
      <p class="note">${evalNote}</p>
    </div>`;

  const f1ChartBlock = hasF1Data ? `
    <div class="card">
      <h2>📈 Classification Metrics – Precision / Recall / F1 (Evaluated Rounds)</h2>
      <div class="chart-container"><canvas id="f1Chart"></canvas></div>
    </div>` : '';

  const perClassBlock = latestPerClass ? `
    <div class="card">
      <h2>🔢 Per-Class Breakdown (Round ${latestEval.round})</h2>
      <table>
        <thead><tr><th>${perClassLabel}</th><th>Precision</th><th>Recall</th><th>F1-Score</th><th>Support</th></tr></thead>
        <tbody>
          ${latestPerClass.map(c => `<tr>
            <td>${c.class}</td>
            <td>${(c.precision * 100).toFixed(2)}%</td>
            <td>${(c.recall * 100).toFixed(2)}%</td>
            <td>${(c.f1 * 100).toFixed(2)}%</td>
            <td>${c.support}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FL Training Report – ${datasetLabel}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>${COMMON_CSS}</style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>🔄 Federated Learning Training Report</h1>
      <p>Hierarchical two-layer FL aggregation on Hyperledger Fabric &mdash; Image Classification (${datasetLabel})</p>
      <div class="timestamp">
        Generated: ${new Date().toLocaleString()} |
        <span class="badge">VPSA Strategy</span>
        <span class="badge" style="margin-left:6px">${datasetLabel}</span>
        ${!hasEvals ? '<span class="badge badge-warn" style="margin-left:6px">No Evaluations</span>' : ''}
      </div>
    </div>

    <div class="card">
      <h2>📊 Training Summary</h2>
      <div class="summary-grid">
        <div class="stat"><div class="stat-label">Total Rounds</div><div class="stat-value">${models.length}</div></div>
        <div class="stat"><div class="stat-label">Evaluated Rounds</div><div class="stat-value">${evals.length}</div></div>
        ${latestMetrics ? `
        <div class="stat"><div class="stat-label">Best Accuracy</div><div class="stat-value" style="color:var(--primary)">${(Math.max(...evalAccuracy)).toFixed(2)}%</div></div>
        <div class="stat"><div class="stat-label">Latest Accuracy (Rd ${latestEval.round})</div><div class="stat-value">${(latestMetrics.accuracy * 100).toFixed(2)}%</div></div>
        <div class="stat"><div class="stat-label">Latest Loss (Rd ${latestEval.round})</div><div class="stat-value">${latestMetrics.loss.toFixed(4)}</div></div>
        <div class="stat"><div class="stat-label">Eval Sample Size</div><div class="stat-value">${latestMetrics.sampleCount || 'N/A'}</div></div>
        ${latestMetrics.f1 !== undefined ? `
        <div class="stat"><div class="stat-label">Latest Precision (Rd ${latestEval.round})</div><div class="stat-value">${(latestMetrics.precision * 100).toFixed(2)}%</div></div>
        <div class="stat"><div class="stat-label">Latest Recall (Rd ${latestEval.round})</div><div class="stat-value">${(latestMetrics.recall * 100).toFixed(2)}%</div></div>
        <div class="stat"><div class="stat-label">Latest F1-Score (Rd ${latestEval.round})</div><div class="stat-value" style="color:var(--primary)">${(latestMetrics.f1 * 100).toFixed(2)}%</div></div>` : ''}` : ''}
        <div class="stat"><div class="stat-label">Train Samples / Round</div><div class="stat-value">${latestModel.totalSamples || 'N/A'}</div></div>
        <div class="stat"><div class="stat-label">Participants</div><div class="stat-value">${latestModel.participantCount || latestModel.participants?.length || 'N/A'}</div></div>
        ${latestModel.participants && latestModel.participants.length > 0 ? `
        <div class="stat" style="grid-column:1/-1">
          <div class="stat-label">Organizations</div>
          <div class="stat-value" style="font-size:16px">${latestModel.participants.join(', ')}</div>
        </div>` : ''}
      </div>
    </div>

    ${evalChartBlock}

    ${f1ChartBlock}

    ${perClassBlock}

    <div class="card">
      <h2>👥 Participation Statistics</h2>
      <div class="chart-container"><canvas id="participationChart"></canvas></div>
    </div>

    <div class="card">
      <h2>📋 Detailed Round History</h2>
      ${!hasEvals ? `<p class="note" style="margin-bottom:12px">${evalNote}</p>` : ''}
      <table>
        <thead><tr><th>Round</th><th>Accuracy</th><th>Loss</th><th>Macro F1</th><th>Participants</th><th>Train Samples</th><th>Timestamp</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>

  <script>
    const C = {
      teal: 'rgba(78,205,196,1)', yellow: 'rgba(255,209,102,1)',
      red:  'rgba(255,107,107,1)', blue:  'rgba(159,176,217,1)',
      grid: 'rgba(255,255,255,0.08)'
    };

    ${hasEvals ? `
    // Accuracy & Loss chart (evaluated rounds only) - single axis for stability
    new Chart(document.getElementById('metricsChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(evalRounds)},
        datasets: [
          { label: 'Accuracy (%)', data: ${JSON.stringify(evalAccuracy)},
            borderColor: C.teal,   backgroundColor: 'rgba(78,205,196,0.12)',  tension: 0.3, fill: true, borderWidth: 2 },
          { label: 'Loss',         data: ${JSON.stringify(evalLoss)},
            borderColor: C.yellow, backgroundColor: 'rgba(255,209,102,0.08)', tension: 0.3, fill: false, borderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' }, display: true } },
        scales: {
          x: {
            title: { display: true, text: 'Round', color: '#9fb0d9', font: { size: 12 } },
            grid: { color: C.grid },
            ticks: { color: '#9fb0d9' }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Accuracy (%) / Loss', color: '#9fb0d9', font: { size: 12 } },
            grid: { color: C.grid },
            ticks: { color: '#9fb0d9' },
            min: 0,
            max: 100
          }
        }
      }
    });` : '/* no evaluation data */'}

    ${hasF1Data ? `
    // Precision / Recall / F1 chart (evaluated rounds only)
    new Chart(document.getElementById('f1Chart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(evalRounds)},
        datasets: [
          { label: 'Precision (%)', data: ${JSON.stringify(evalPrecision)},
            borderColor: C.teal,   backgroundColor: 'rgba(78,205,196,0.08)', tension: 0.3, fill: false },
          { label: 'Recall (%)',    data: ${JSON.stringify(evalRecall)},
            borderColor: C.yellow, backgroundColor: 'rgba(255,209,102,0.08)', tension: 0.3, fill: false },
          { label: 'F1-Score (%)', data: ${JSON.stringify(evalF1)},
            borderColor: C.red,    backgroundColor: 'rgba(255,107,107,0.08)', tension: 0.3, fill: false }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' } } },
        scales: {
          x: { title: { display: true, text: 'Round',     color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' } },
          y: { title: { display: true, text: 'Score (%)', color: '#9fb0d9' }, grid: { color: C.grid }, ticks: { color: '#9fb0d9' }, min: 0, max: 100 }
        }
      }
    });` : ''}

    // Participation chart - single axis (showing Train Samples only) for stability
    new Chart(document.getElementById('participationChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(participation.rounds)},
        datasets: [
          { label: 'Train Samples', data: ${JSON.stringify(participation.samples)},
            backgroundColor: 'rgba(159,176,217,0.7)', borderColor: C.blue, borderWidth: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#eaf0ff' }, display: true } },
        scales: {
          x: {
            title: { display: true, text: 'Round', color: '#9fb0d9', font: { size: 12 } },
            grid: { color: C.grid },
            ticks: { color: '#9fb0d9' }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Train Samples', color: '#9fb0d9', font: { size: 12 } },
            grid: { color: C.grid },
            ticks: { color: '#9fb0d9' }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    console.error('❌ Models directory not found:', MODELS_DIR);
    process.exit(1);
  }

  const models = loadGlobalModels();
  if (models.length === 0) {
    console.warn('⚠️  No global model files found. Run training first.');
  }

  const evals = loadEvaluations();
  if (evals.length === 0) {
    console.warn(`⚠️  No evaluation files found in ${EVALS_DIR}/${DATASET} for dataset "${DATASET}".`);
    console.warn(`   Run: node src/utils/evaluateModel.js ${DATASET} latest`);
  } else {
    console.log(`📊 Loaded ${evals.length} evaluation file(s): rounds ${evals.map(e => e.round).join(', ')}`);
  }

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const html = generateHTMLReport(models, evals);
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`✅ Report generated: ${OUTPUT_FILE}`);
  console.log(`\n📂 Open in browser: file://${OUTPUT_FILE}`);
}

main();

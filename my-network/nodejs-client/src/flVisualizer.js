const fs = require('fs');
const path = require('path');

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function asArray(rounds, mapper) {
  return rounds.map(mapper);
}

function generateHtml(result) {
  const labels = JSON.stringify(asArray(result.rounds, (r) => `Round ${r.round}`));
  const mse = JSON.stringify(asArray(result.rounds, (r) => r.mse));
  const weight = JSON.stringify(asArray(result.rounds, (r) => r.globalModel.weight));
  const bias = JSON.stringify(asArray(result.rounds, (r) => r.globalModel.bias));
  const options = JSON.stringify(result.options, null, 2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Federated Learning Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0b1020;
      --card: #121a33;
      --text: #eaf0ff;
      --muted: #9fb0d9;
      --mse: #ff6b6b;
      --w: #4ecdc4;
      --b: #ffd166;
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
      max-width: 1000px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .card {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 16px;
      backdrop-filter: blur(4px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .metric {
      padding: 12px;
      border-radius: 10px;
      background: var(--card);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .metric .value {
      margin-top: 6px;
      font-size: 20px;
      font-weight: 700;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      font-size: 12px;
      color: #d8e4ff;
    }
    canvas {
      width: 100% !important;
      height: 360px !important;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Federated Learning Training Report</h1>
      <p>Task: ${result.task}</p>
    </div>

    <div class="grid">
      <div class="metric">
        <div class="label">Final MSE</div>
        <div class="value">${result.finalMse}</div>
      </div>
      <div class="metric">
        <div class="label">Final Weight</div>
        <div class="value">${result.finalModel.weight}</div>
      </div>
      <div class="metric">
        <div class="label">Final Bias</div>
        <div class="value">${result.finalModel.bias}</div>
      </div>
      <div class="metric">
        <div class="label">Rounds</div>
        <div class="value">${result.rounds.length}</div>
      </div>
    </div>

    <div class="card">
      <canvas id="flChart"></canvas>
    </div>

    <div class="card">
      <h1 style="font-size:18px">Run Options</h1>
      <pre>${options}</pre>
    </div>
  </div>

  <script>
    const labels = ${labels};
    const mse = ${mse};
    const weight = ${weight};
    const bias = ${bias};

    const ctx = document.getElementById('flChart');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'MSE',
            data: mse,
            borderColor: getComputedStyle(document.documentElement).getPropertyValue('--mse').trim(),
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.28,
            yAxisID: 'yLoss'
          },
          {
            label: 'Weight',
            data: weight,
            borderColor: getComputedStyle(document.documentElement).getPropertyValue('--w').trim(),
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.28,
            yAxisID: 'yParam'
          },
          {
            label: 'Bias',
            data: bias,
            borderColor: getComputedStyle(document.documentElement).getPropertyValue('--b').trim(),
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.28,
            yAxisID: 'yParam'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#d8e4ff'
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#cbd7f5' },
            grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() }
          },
          yLoss: {
            type: 'linear',
            position: 'left',
            ticks: { color: '#ff9f9f' },
            title: { display: true, text: 'MSE', color: '#ff9f9f' },
            grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() }
          },
          yParam: {
            type: 'linear',
            position: 'right',
            ticks: { color: '#a8ffe8' },
            title: { display: true, text: 'Model Params', color: '#a8ffe8' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

function writeFlReport(result, outputFilePath) {
  const resolvedPath = path.resolve(outputFilePath);
  ensureParentDir(resolvedPath);
  const html = generateHtml(result);
  fs.writeFileSync(resolvedPath, html, 'utf8');
  return resolvedPath;
}

module.exports = {
  writeFlReport,
};

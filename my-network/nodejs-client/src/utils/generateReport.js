#!/usr/bin/env node

/**
 * Generate FL Training Report from saved global models
 * Reads all global-model-round-*.json files and creates an HTML report
 */

const fs = require('fs');
const path = require('path');

const DATASET = (process.argv[2] || process.env.FL_DATASET || 'simple').toLowerCase();
const MODELS_DIR = path.join(__dirname, '..', '..', 'models', DATASET);
const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
const OUTPUT_FILE = path.join(REPORTS_DIR, `fl-training-report-${DATASET}.html`);

function loadGlobalModels() {
  const files = fs.readdirSync(MODELS_DIR);
  const modelFiles = files.filter(f => f.match(/^global-model-round-\d+\.json$/));
  
  const models = [];
  for (const file of modelFiles) {
    const filepath = path.join(MODELS_DIR, file);
    const content = fs.readFileSync(filepath, 'utf8');
    const model = JSON.parse(content);
    models.push(model);
  }
  
  // Sort by round number
  models.sort((a, b) => a.round - b.round);
  
  return models;
}

function extractModelParameters(models) {
  const rounds = [];
  const weights = [];
  const biases = [];
  const participants = [];
  const samples = [];
  
  for (const model of models) {
    rounds.push(model.round);
    
    // Parse model data [w, b]
    const params = JSON.parse(model.modelData);
    weights.push(params[0]);
    biases.push(params[1]);
    
    // Get participant count from either participantCount field or participants array
    const participantCount = model.participantCount || 
                            (model.participants ? model.participants.length : 0);
    participants.push(participantCount);
    samples.push(model.totalSamples || 0);
  }
  
  return { rounds, weights, biases, participants, samples };
}

function generateHTMLReport(models) {
  if (models.length === 0) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>FL Training Report</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #f5f5f5; }
    .error { background: #fff; padding: 20px; border-radius: 8px; color: #666; }
  </style>
</head>
<body>
  <div class="error">
    <h1>No Training Data Found</h1>
    <p>No global model files found in <code>models/${DATASET}</code>.</p>
    <p>Run training first: <code>node src/launchClients.js 5 sync ${DATASET}</code></p>
  </div>
</body>
</html>`;
  }
  
  const data = extractModelParameters(models);
  const latestModel = models[models.length - 1];
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FL Training Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
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
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 24px;
      backdrop-filter: blur(4px);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      font-weight: 600;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 18px;
      font-weight: 500;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .stat {
      background: rgba(255, 255, 255, 0.02);
      padding: 16px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .stat-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 600;
      color: var(--text);
    }
    .chart-container {
      position: relative;
      height: 300px;
      margin-top: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    th {
      font-weight: 500;
      color: var(--muted);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td {
      color: var(--text);
      font-family: 'Courier New', monospace;
    }
    .timestamp {
      font-size: 14px;
      color: var(--muted);
      margin-top: 8px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      background: rgba(78, 205, 196, 0.15);
      color: var(--primary);
      border: 1px solid rgba(78, 205, 196, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="card">
      <h1>🔄 Federated Learning Training Report</h1>
      <p>Hierarchical two-layer FL aggregation on Hyperledger Fabric</p>
      <div class="timestamp">
        Generated: ${new Date().toLocaleString()} | 
        <span class="badge">VPSA Strategy</span>
      </div>
    </div>

    <!-- Summary Statistics -->
    <div class="card">
      <h2>📊 Training Summary</h2>
      <div class="summary-grid">
        <div class="stat">
          <div class="stat-label">Total Rounds</div>
          <div class="stat-value">${models.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Latest Weight</div>
          <div class="stat-value">${data.weights[data.weights.length - 1].toFixed(4)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Latest Bias</div>
          <div class="stat-value">${data.biases[data.biases.length - 1].toFixed(4)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Participants</div>
          <div class="stat-value">${latestModel.participantCount || latestModel.participants?.length || 'N/A'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Samples</div>
          <div class="stat-value">${latestModel.totalSamples || 'N/A'}</div>
        </div>
        ${latestModel.participants && latestModel.participants.length > 0 ? `
        <div class="stat" style="grid-column: 1 / -1;">
          <div class="stat-label">Participating Organizations</div>
          <div class="stat-value" style="font-size: 16px;">${latestModel.participants.join(', ')}</div>
        </div>` : ''}
      </div>
    </div>

    <!-- Weight & Bias Chart -->
    <div class="card">
      <h2>📈 Model Parameters Evolution</h2>
      <div class="chart-container">
        <canvas id="paramsChart"></canvas>
      </div>
    </div>

    <!-- Participants & Samples Chart -->
    <div class="card">
      <h2>👥 Participation Statistics</h2>
      <div class="chart-container">
        <canvas id="participationChart"></canvas>
      </div>
    </div>

    <!-- Detailed Table -->
    <div class="card">
      <h2>📋 Detailed Round History</h2>
      <table>
        <thead>
          <tr>
            <th>Round</th>
            <th>Weight (w)</th>
            <th>Bias (b)</th>
            <th>Participants</th>
            <th>Total Samples</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
${models.map(m => {
  const params = JSON.parse(m.modelData);
  // Convert Unix timestamp (seconds) to JavaScript Date (milliseconds)
  const timestamp = m.timestamp ? new Date(m.timestamp * 1000).toLocaleString() : 'N/A';
  // Display participants list or count
  const participantInfo = m.participants && m.participants.length > 0 
    ? m.participants.join(', ') 
    : (m.participantCount || 'N/A');
  
  return `          <tr>
            <td>${m.round}</td>
            <td>${params[0].toFixed(6)}</td>
            <td>${params[1].toFixed(6)}</td>
            <td>${participantInfo}</td>
            <td>${m.totalSamples || 'N/A'}</td>
            <td>${timestamp}</td>
          </tr>`;
}).join('\n')}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const chartColors = {
      weight: 'rgba(78, 205, 196, 1)',
      bias: 'rgba(255, 209, 102, 1)',
      participants: 'rgba(255, 107, 107, 1)',
      samples: 'rgba(159, 176, 217, 1)',
      grid: 'rgba(255, 255, 255, 0.08)'
    };

    // Parameters Chart
    new Chart(document.getElementById('paramsChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(data.rounds)},
        datasets: [
          {
            label: 'Weight (w)',
            data: ${JSON.stringify(data.weights)},
            borderColor: chartColors.weight,
            backgroundColor: 'rgba(78, 205, 196, 0.1)',
            tension: 0.3,
            fill: true
          },
          {
            label: 'Bias (b)',
            data: ${JSON.stringify(data.biases)},
            borderColor: chartColors.bias,
            backgroundColor: 'rgba(255, 209, 102, 0.1)',
            tension: 0.3,
            fill: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#eaf0ff' }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Round', color: '#9fb0d9' },
            grid: { color: chartColors.grid },
            ticks: { color: '#9fb0d9' }
          },
          y: {
            title: { display: true, text: 'Value', color: '#9fb0d9' },
            grid: { color: chartColors.grid },
            ticks: { color: '#9fb0d9' }
          }
        }
      }
    });

    // Participation Chart
    new Chart(document.getElementById('participationChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(data.rounds)},
        datasets: [
          {
            label: 'Participants',
            data: ${JSON.stringify(data.participants)},
            backgroundColor: 'rgba(255, 107, 107, 0.7)',
            borderColor: chartColors.participants,
            borderWidth: 1,
            yAxisID: 'y'
          },
          {
            label: 'Total Samples',
            data: ${JSON.stringify(data.samples)},
            backgroundColor: 'rgba(159, 176, 217, 0.7)',
            borderColor: chartColors.samples,
            borderWidth: 1,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#eaf0ff' }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Round', color: '#9fb0d9' },
            grid: { color: chartColors.grid },
            ticks: { 
              color: '#9fb0d9',
              stepSize: 1
            }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Participants', color: '#9fb0d9' },
            grid: { color: chartColors.grid },
            ticks: { 
              color: '#9fb0d9',
              stepSize: 1,
              precision: 0,
              callback: function(value) {
                if (Number.isInteger(value)) {
                  return value;
                }
              }
            }
          },
          y1: {
            type: 'linear',
            position: 'right',
            title: { display: true, text: 'Samples', color: '#9fb0d9' },
            grid: { display: false },
            ticks: { 
              color: '#9fb0d9',
              stepSize: 10
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;
  
  return html;
}

function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    console.error('❌ Models directory not found:', MODELS_DIR);
    process.exit(1);
  }
  
  const models = loadGlobalModels();
  
  if (models.length === 0) {
    console.warn('⚠️  No global model files found. Run training first.');
  }
  
  console.log('📊 Generating HTML report...');
  const html = generateHTMLReport(models);
  
  // Ensure reports directory exists
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  
  fs.writeFileSync(OUTPUT_FILE, html);
  console.log(`✅ Report generated: ${OUTPUT_FILE}`);
  console.log(`\n📂 Open in browser: file://${OUTPUT_FILE}`);
}

main();

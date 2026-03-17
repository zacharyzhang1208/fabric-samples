const fs = require('fs');
const path = require('path');

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createRunId({ dataset, mode, epochs }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${dataset}-${mode}-${epochs}r`;
}

function summarizeDurations(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return null;
  }

  const sorted = [...finiteValues].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const percentile = (p) => {
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(index, 0)];
  };

  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: sum / sorted.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
  };
}

module.exports = {
  ensureDirectory,
  writeJson,
  readJsonIfExists,
  createRunId,
  summarizeDurations,
};
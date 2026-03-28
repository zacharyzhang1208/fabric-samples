#!/usr/bin/env node

/**
 * FL Clients Launcher for Multi-Organization Fabric Network
 * Spawns independent FL client processes with organization-specific credentials
 * Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const {
  createRunId,
  ensureDirectory,
  writeJson,
  readJsonIfExists,
  summarizeDurations,
} = require('./utils/timing');

function pipeChildOutput(child, logStream) {
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      logStream.write(text);
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      logStream.write(text);
    });
  }
}

// Configuration for each client: org, node, port, organization parameters
const CLIENTS = [
  // Bank A - Org1 (2 nodes)
  {
    org: 'A',
    node: 1,
    port: 3001,
    orgDomain: 'org1.example.com',
    orgMspId: 'Org1MSP',
    peerName: 'peer0.org1.example.com',
    peerEndpoint: 'localhost:7051',
  },
  {
    org: 'A',
    node: 2,
    port: 3002,
    orgDomain: 'org1.example.com',
    orgMspId: 'Org1MSP',
    peerName: 'peer0.org1.example.com',
    peerEndpoint: 'localhost:7051',
  },
  // Bank B - Org2 (3 nodes)
  {
    org: 'B',
    node: 1,
    port: 3003,
    orgDomain: 'org2.example.com',
    orgMspId: 'Org2MSP',
    peerName: 'peer0.org2.example.com',
    peerEndpoint: 'localhost:9051',
  },
  {
    org: 'B',
    node: 2,
    port: 3004,
    orgDomain: 'org2.example.com',
    orgMspId: 'Org2MSP',
    peerName: 'peer0.org2.example.com',
    peerEndpoint: 'localhost:9051',
  },
  {
    org: 'B',
    node: 3,
    port: 3005,
    orgDomain: 'org2.example.com',
    orgMspId: 'Org2MSP',
    peerName: 'peer0.org2.example.com',
    peerEndpoint: 'localhost:9051',
  },
];

function launchClient(config, epochs, mode, dataset = 'linear', mnistSamples = 20000, logStream) {
  const org1NodeCount = CLIENTS.filter((c) => c.orgMspId === 'Org1MSP').length;
  const org2NodeCount = CLIENTS.filter((c) => c.orgMspId === 'Org2MSP').length;

  const args = [
    path.join(__dirname, 'flClient.js'),
    '--org', config.org,
    '--node', String(config.node),
    '--port', String(config.port),
    '--org-domain', config.orgDomain,
    '--org-msp-id', config.orgMspId,
    '--peer-name', config.peerName,
    '--peer-endpoint', config.peerEndpoint,
    '--org1-node-count', String(org1NodeCount),
    '--org2-node-count', String(org2NodeCount),
    '--epochs', String(epochs),
    '--mode', mode,
    '--dataset', dataset,
    '--mnist-samples', String(mnistSamples),
  ];

  const clientId = `${config.org}-N${config.node}`;
  console.log(`[LAUNCHER] Spawning ${clientId} on port ${config.port} (${config.peerName})...`);

  const child = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      TF_CPP_MIN_LOG_LEVEL: process.env.TF_CPP_MIN_LOG_LEVEL || '2',
      ASYNC_COMMITTEE_LEADER: process.env.ASYNC_COMMITTEE_LEADER || 'A-N1',
    },
  });

  pipeChildOutput(child, logStream);

  child.on('error', (err) => {
    console.error(`[LAUNCHER] Error spawning ${clientId}:`, err);
  });

  child.on('exit', (code) => {
    if (code === 0) {
      console.log(`[LAUNCHER] ${clientId} exited normally`);
    } else {
      console.warn(`[LAUNCHER] ${clientId} exited with code ${code}`);
    }
  });

  return child;
}

async function main() {
  const epochs = process.argv[2] ? Number(process.argv[2]) : 10;
  const mode = process.argv[3] || 'sync';
  const dataset = process.argv[4] || 'linear';
  const mnistSamples = process.argv[5] ? Number(process.argv[5]) : 20000;
  const runId = createRunId({ dataset, mode, epochs });
  const timingRoot = path.join(__dirname, '..', 'reports', 'timing', runId);
  const logsRoot = path.join(__dirname, '..', 'log');
  const runLogPath = path.join(logsRoot, `${runId}.txt`);
  const runStartedAtMs = Date.now();

  ensureDirectory(path.join(timingRoot, 'clients'));
  ensureDirectory(logsRoot);
  const logStream = fs.createWriteStream(runLogPath, { flags: 'a' });

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const writeRunLog = (level, args) => {
    const rendered = util.format(...args);
    const line = `[${new Date().toISOString()}] [${level}] ${rendered}`;
    logStream.write(line.endsWith('\n') ? line : `${line}\n`);
  };

  console.log = (...args) => {
    originalLog(...args);
    writeRunLog('INFO', args);
  };
  console.warn = (...args) => {
    originalWarn(...args);
    writeRunLog('WARN', args);
  };
  console.error = (...args) => {
    originalError(...args);
    writeRunLog('ERROR', args);
  };

  process.env.FL_TIMING_RUN_ID = runId;
  process.env.FL_TIMING_ROOT = timingRoot;
  console.log(`[LAUNCHER] Run log file: log/${runId}.txt`);

  console.log(`[LAUNCHER] Starting ${CLIENTS.length} FL clients`);
  console.log(`[LAUNCHER] Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes`);
  console.log(`[LAUNCHER] Configuration: epochs=${epochs}, mode=${mode}, dataset=${dataset}`);
  console.log(`[LAUNCHER] Timing run ID: ${runId}`);
  if (dataset === 'mnist') {
    console.log(`[LAUNCHER] MNIST samples: ${mnistSamples}`);
  }
  console.log(`[LAUNCHER] Usage: node launchClients.js [epochs] [mode] [dataset] [mnistSamples]`);
  console.log(`[LAUNCHER] Example: node launchClients.js 10 sync linear\n`);
  
  const { DataLoaderFactory } = require('./dataLoaders');
  const availableDatasets = DataLoaderFactory.getAvailable();
  console.log(`[LAUNCHER] Available datasets: ${availableDatasets.join(', ')}\n`);

  const projectRoot = path.join(__dirname, '..', '..');
  const requiredAdminKeystores = [
    path.join(
      projectRoot,
      'organizations',
      'peerOrganizations',
      'org1.example.com',
      'users',
      'Admin@org1.example.com',
      'msp',
      'keystore'
    ),
    path.join(
      projectRoot,
      'organizations',
      'peerOrganizations',
      'org2.example.com',
      'users',
      'Admin@org2.example.com',
      'msp',
      'keystore'
    ),
  ];

  const missing = requiredAdminKeystores.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.error('[LAUNCHER] Missing Fabric crypto materials:');
    missing.forEach((p) => console.error(`  - ${p}`));
    console.error("[LAUNCHER] Please run from project root: ./deploy.sh --strategy vpsa");
    process.exit(1);
  }

  writeJson(path.join(timingRoot, 'run-summary.json'), {
    runId,
    dataset,
    mode,
    epochs,
    mnistSamples,
    startedAt: new Date(runStartedAtMs).toISOString(),
    startedAtMs: runStartedAtMs,
    status: 'running',
    clients: CLIENTS.map((config) => `${config.org}-N${config.node}`),
  });

  const childExitCodes = {};
  const processes = CLIENTS.map((config) => {
    const child = launchClient(config, epochs, mode, dataset, mnistSamples, logStream);
    const clientId = `${config.org}-N${config.node}`;
    childExitCodes[clientId] = null;
    child.on('exit', (code) => {
      childExitCodes[clientId] = code;
    });
    return child;
  });

  // Wait for all processes to complete
  await Promise.all(
    processes.map(
      (proc) =>
        new Promise((resolve) => {
          proc.on('exit', resolve);
        })
    )
  );

  console.log(`\n[LAUNCHER] All clients completed`);
 
  // Generate evaluation files first so report can include metrics trends.
  console.log(`\n[LAUNCHER] Evaluating saved global models...`);
  const evaluateStartedAtMs = Date.now();
  const evaluateScript = path.join(__dirname, 'utils', 'evaluateModel.js');
  const evaluateArgs = [evaluateScript, dataset, 'all'];
  if (dataset === 'mnist') {
    evaluateArgs.push(String(mnistSamples));
  }
  const evaluateProc = spawn('node', evaluateArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });
  pipeChildOutput(evaluateProc, logStream);
  const evaluateExitCode = await new Promise((resolve) => {
    evaluateProc.on('exit', (code) => resolve(code ?? 1));
  });
  const evaluateEndedAtMs = Date.now();

  if (evaluateExitCode !== 0) {
    console.warn(`[LAUNCHER] Model evaluation exited with code ${evaluateExitCode}. Report may have partial metrics.`);
  }

  // Generate training report
  console.log(`\n[LAUNCHER] Generating training report...`);
  const reportStartedAtMs = Date.now();
  const reportScript = path.join(__dirname, 'utils', 'generateReport.js');
  const reportProc = spawn('node', [reportScript, dataset], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });
  pipeChildOutput(reportProc, logStream);

  const reportExitCode = await new Promise((resolve) => {
    reportProc.on('exit', (code) => resolve(code ?? 1));
  });
  const reportEndedAtMs = Date.now();

  if (reportExitCode !== 0) {
    console.warn(`[LAUNCHER] Report generation exited with code ${reportExitCode}.`);
  }

  const clientTimings = CLIENTS.map((config) => {
    const clientId = `${config.org}-N${config.node}`;
    const filePath = path.join(timingRoot, 'clients', `${clientId}.json`);
    return readJsonIfExists(filePath) || { clientId, status: 'missing' };
  });

  const roundDurations = clientTimings.flatMap((client) =>
    Array.isArray(client.rounds) ? client.rounds.map((round) => round.totalMs) : []
  );
  const submitDurations = clientTimings.flatMap((client) =>
    Array.isArray(client.rounds) ? client.rounds.map((round) => round.submitUpdateMs) : []
  );
  const queryDurations = clientTimings.flatMap((client) =>
    Array.isArray(client.rounds) ? client.rounds.map((round) => round.queryGlobalModelMs) : []
  );
  const runEndedAtMs = Date.now();

  writeJson(path.join(timingRoot, 'run-summary.json'), {
    runId,
    dataset,
    mode,
    epochs,
    mnistSamples,
    startedAt: new Date(runStartedAtMs).toISOString(),
    startedAtMs: runStartedAtMs,
    endedAt: new Date(runEndedAtMs).toISOString(),
    endedAtMs: runEndedAtMs,
    totalMs: runEndedAtMs - runStartedAtMs,
    evaluationMs: evaluateEndedAtMs - evaluateStartedAtMs,
    reportGenerationMs: reportEndedAtMs - reportStartedAtMs,
    evaluateExitCode,
    reportExitCode,
    status: 'completed',
    childExitCodes,
    roundTotalMs: summarizeDurations(roundDurations),
    submitUpdateMs: summarizeDurations(submitDurations),
    queryGlobalModelMs: summarizeDurations(queryDurations),
    clients: clientTimings,
  });

  console.log(`[LAUNCHER] Timing summary written to reports/timing/${runId}/run-summary.json`);

  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  await new Promise((resolve) => logStream.end(resolve));
}

main().catch(async (err) => {
  console.error(err);
});

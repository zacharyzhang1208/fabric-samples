#!/usr/bin/env node

/**
 * FL Clients Launcher for Multi-Organization Fabric Network
 * Spawns independent FL client processes with organization-specific credentials
 * Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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

function launchClient(config, epochs, mode, dataset = 'simple', mnistSamples = 20000) {
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
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      TF_CPP_MIN_LOG_LEVEL: process.env.TF_CPP_MIN_LOG_LEVEL || '2',
    },
  });

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
  const dataset = process.argv[4] || 'simple';
  const mnistSamples = process.argv[5] ? Number(process.argv[5]) : 20000;

  console.log(`[LAUNCHER] Starting ${CLIENTS.length} FL clients`);
  console.log(`[LAUNCHER] Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes`);
  console.log(`[LAUNCHER] Configuration: epochs=${epochs}, mode=${mode}, dataset=${dataset}`);
  if (dataset === 'mnist') {
    console.log(`[LAUNCHER] MNIST samples: ${mnistSamples}`);
  }
  console.log(`[LAUNCHER] Usage: node launchClients.js [epochs] [mode] [dataset] [mnistSamples]`);
  console.log(`[LAUNCHER] Example: node launchClients.js 10 sync mnist 60000\n`);
  
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

  const processes = CLIENTS.map((config) => launchClient(config, epochs, mode, dataset, mnistSamples));

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
  
  // Generate training report
  console.log(`\n[LAUNCHER] Generating training report...`);
  const reportScript = path.join(__dirname, 'utils', 'generateReport.js');
  const reportProc = spawn('node', [reportScript, dataset], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
  
  await new Promise((resolve) => {
    reportProc.on('exit', resolve);
  });
}

main().catch(console.error);

#!/usr/bin/env node

/**
 * FL Clients Launcher for Multi-Organization Fabric Network
 * Spawns independent FL client processes with organization-specific credentials
 * Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes
 */

const { spawn } = require('child_process');
const path = require('path');

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
    peerName: 'peer1.org1.example.com',
    peerEndpoint: 'localhost:7151',
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
    peerName: 'peer1.org2.example.com',
    peerEndpoint: 'localhost:9151',
  },
  {
    org: 'B',
    node: 3,
    port: 3005,
    orgDomain: 'org2.example.com',
    orgMspId: 'Org2MSP',
    peerName: 'peer2.org2.example.com',
    peerEndpoint: 'localhost:9251',
  },
];

function launchClient(config, rounds, epochs) {
  const args = [
    path.join(__dirname, 'flClient.js'),
    '--org', config.org,
    '--node', String(config.node),
    '--port', String(config.port),
    '--org-domain', config.orgDomain,
    '--org-msp-id', config.orgMspId,
    '--peer-name', config.peerName,
    '--peer-endpoint', config.peerEndpoint,
    '--rounds', String(rounds),
    '--epochs', String(epochs),
  ];

  const clientId = `${config.org}-N${config.node}`;
  console.log(`[LAUNCHER] Spawning ${clientId} on port ${config.port} (${config.peerName})...`);

  const child = spawn('node', args, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
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
  const rounds = process.argv[2] ? Number(process.argv[2]) : 3;
  const epochs = process.argv[3] ? Number(process.argv[3]) : 3;

  console.log(`[LAUNCHER] Starting ${CLIENTS.length} FL clients`);
  console.log(`[LAUNCHER] Topology: Bank A (Org1) - 2 nodes, Bank B (Org2) - 3 nodes`);
  console.log(`[LAUNCHER] Configuration: rounds=${rounds}, epochs=${epochs}`);
  console.log(`[LAUNCHER] Each client uses its own organization credentials\n`);

  const processes = CLIENTS.map((config) => launchClient(config, rounds, epochs));

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
}

main().catch(console.error);

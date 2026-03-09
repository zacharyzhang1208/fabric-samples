#!/usr/bin/env node

/**
 * Simple Dataset Generator
 * Generates synthetic linear regression data for FL training
 * Run this before training with simple dataset
 * 
 * Usage: node src/utils/generateSimpleData.js
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data', 'simple');

// Client configurations matching launchClients.js
const CLIENTS = [
  { id: 'A-N1', samples: 20, drift: 0.0 },
  { id: 'A-N2', samples: 20, drift: 0.1 },
  { id: 'B-N1', samples: 20, drift: 0.2 },
  { id: 'B-N2', samples: 20, drift: 0.0 },
  { id: 'B-N3', samples: 20, drift: 0.1 },
];

/**
 * Seeded random number generator for reproducibility
 */
function createRNG(seed) {
  let state = seed;
  return function() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Generate dataset for one client
 */
function generateClientData(clientId, samples, drift) {
  const seed = clientId.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0) || 12345;
  const rand = createRNG(seed);
  
  const xs = [];
  const ys = [];
  
  for (let i = 0; i < samples; i++) {
    const x = rand() * 10 - 5; // Range: [-5, 5]
    const noise = rand() * 2 - 1; // Range: [-1, 1]
    const y = 2 * x + 1 + noise + drift; // y = 2x + 1 + noise + drift
    
    xs.push(x);
    ys.push(y);
  }
  
  return { clientId, sampleCount: samples, drift, xs, ys };
}

/**
 * Generate all client datasets
 */
function generateSimpleDatasets() {
  console.log('\n📊 Simple Dataset Generation\n');
  
  // Create data directory
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`✓ Created directory: ${dataDir}`);
  }
  
  // Generate data for each client
  for (const client of CLIENTS) {
    const data = generateClientData(client.id, client.samples, client.drift);
    const filepath = path.join(dataDir, `${client.id}.json`);
    
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`  ✓ Generated: ${client.id}.json (${client.samples} samples, drift=${client.drift.toFixed(1)})`);
  }
  
  console.log('\n✅ Simple datasets generated successfully!\n');
  console.log('📂 Location:', dataDir);
  console.log('\n💡 You can now run training:\n   node src/launchClients.js 1 sync simple\n');
}

// Run generator
generateSimpleDatasets();

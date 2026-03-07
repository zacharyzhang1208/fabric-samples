#!/usr/bin/env node

/**
 * Independent FL Client for Multi-Organization Fabric Network
 * Each instance represents a peer node in a specific organization
 */

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const tf = require('@tensorflow/tfjs');
const path = require('path');
const fs = require('fs');
const { Gateway } = require('fabric-network');

function buildClientFabricClient(options) {
  /**
   * Returns a dynamically configured FabricClient
   * options: { orgDomain, orgMspId, peerName, peerEndpoint, ordererEndpoint, projectRoot }
   */
  const config = options;

  function readUtf8(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }

  function readFirstFile(dirPath) {
    const files = fs.readdirSync(dirPath);
    if (!files.length) {
      throw new Error(`No files found in directory: ${dirPath}`);
    }
    return path.join(dirPath, files[0]);
  }

  function buildIdentity() {
    const base = path.join(
      config.projectRoot,
      'organizations',
      'peerOrganizations',
      config.orgDomain,
      'users',
      `Admin@${config.orgDomain}`,
      'msp'
    );

    const certPath = path.join(base, 'signcerts', `Admin@${config.orgDomain}-cert.pem`);
    const keyDir = path.join(base, 'keystore');
    const keyPath = readFirstFile(keyDir);

    return {
      credentials: {
        certificate: readUtf8(certPath),
        privateKey: readUtf8(keyPath),
      },
      mspId: config.orgMspId,
      type: 'X.509',
    };
  }

  function buildConnectionProfile() {
    const peerTlsPath = path.join(
      config.projectRoot,
      'organizations',
      'peerOrganizations',
      config.orgDomain,
      'peers',
      config.peerName,
      'tls',
      'ca.crt'
    );

    const ordererTlsPath = path.join(
      config.projectRoot,
      'organizations',
      'ordererOrganizations',
      'example.com',
      'orderers',
      'orderer.example.com',
      'tls',
      'ca.crt'
    );

    return {
      name: 'fl-network-client',
      version: '1.0.0',
      channels: {
        mychannel: {
          peers: {
            [config.peerName]: {},
          },
          orderers: ['orderer.example.com'],
        },
      },
      organizations: {
        [config.orgMspId]: {
          mspid: config.orgMspId,
          peers: [config.peerName],
        },
      },
      peers: {
        [config.peerName]: {
          url: `grpcs://${config.peerEndpoint}`,
          tlsCACerts: {
            pem: readUtf8(peerTlsPath),
          },
          grpcOptions: {
            'ssl-target-name-override': config.peerName,
            hostnameOverride: config.peerName,
          },
        },
      },
      orderers: {
        'orderer.example.com': {
          url: `grpcs://${config.ordererEndpoint}`,
          tlsCACerts: {
            pem: readUtf8(ordererTlsPath),
          },
          grpcOptions: {
            'ssl-target-name-override': 'orderer.example.com',
            hostnameOverride: 'orderer.example.com',
          },
        },
      },
    };
  }

  class FabricClient {
    constructor() {
      this.gateway = new Gateway();
      this.contract = null;
    }

    async connect() {
      const identity = buildIdentity();
      const connectionProfile = buildConnectionProfile();

      await this.gateway.connect(connectionProfile, {
        identity,
        discovery: { enabled: true, asLocalhost: true },
      });

      const network = await this.gateway.getNetwork('mychannel');
      this.contract = network.getContract('simple');
    }

    async set(key, value) {
      if (!this.contract) {
        throw new Error('Client is not connected');
      }
      await this.contract.submitTransaction('Set', key, value);
      return { key, value };
    }

    async get(key) {
      if (!this.contract) {
        throw new Error('Client is not connected');
      }
      const result = await this.contract.evaluateTransaction('Get', key);
      return result.toString();
    }

    async tryGet(key) {
      if (!this.contract) {
        throw new Error('Client is not connected');
      }
      try {
        const result = await this.contract.evaluateTransaction('Get', key);
        return result.toString();
      } catch (err) {
        if (err.message && err.message.includes('does not exist')) {
          return null;
        }
        throw err;
      }
    }

    async disconnect() {
      await this.gateway.disconnect();
    }
  }

  return FabricClient;
}

class FlClient {
  constructor(options) {
    this.org = options.org;
    this.nodeId = options.node;
    this.port = options.port;
    this.clientId = `${this.org}-N${this.nodeId}`;
    
    // Organization parameters
    this.orgDomain = options.orgDomain;
    this.orgMspId = options.orgMspId;
    this.peerName = options.peerName;
    this.peerEndpoint = options.peerEndpoint;
    this.ordererEndpoint = options.ordererEndpoint || 'localhost:7050';
    this.projectRoot = options.projectRoot;
    
    this.FabricClient = buildClientFabricClient({
      orgDomain: this.orgDomain,
      orgMspId: this.orgMspId,
      peerName: this.peerName,
      peerEndpoint: this.peerEndpoint,
      ordererEndpoint: this.ordererEndpoint,
      projectRoot: this.projectRoot,
    });
    
    this.fabricClient = null;
    this.model = null;
    this.localData = null;
  }

  async initialize() {
    console.log(`[${this.clientId}] Initializing... (${this.orgDomain}/${this.peerName})`);
    await this.setupFabricClient();
    this.generateLocalDataset();
    this.buildModel();
  }

  async setupFabricClient() {
    this.fabricClient = new this.FabricClient();
    try {
      await this.fabricClient.connect();
      console.log(`[${this.clientId}] Connected to Fabric (${this.peerName})`);
    } catch (err) {
      console.error(`[${this.clientId}] Failed to connect to Fabric:`, err.message);
      throw err;
    }
  }

  generateLocalDataset() {
    // Client-specific drift: different data distribution per node
    const samples = 20;
    const clientDrift = (this.clientId.charCodeAt(0) % 3) * 0.1; // 0.0, 0.1, 0.2

    const xs = [];
    const ys = [];

    for (let i = 0; i < samples; i++) {
      const x = Math.random() * 10 - 5;
      const y = 2 * x + 1 + (Math.random() * 2 - 1) + clientDrift;
      xs.push(x);
      ys.push(y);
    }

    this.localData = {
      xs: tf.tensor1d(xs),
      ys: tf.tensor1d(ys),
      sampleCount: samples,
    };

    console.log(`[${this.clientId}] Generated local dataset: ${samples} samples (drift=${clientDrift})`);
  }

  buildModel() {
    this.model = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [1],
          units: 1,
          activation: 'linear',
        }),
      ],
    });

    this.model.compile({
      optimizer: tf.train.sgd(0.03),
      loss: 'meanSquaredError',
    });

    console.log(`[${this.clientId}] Model initialized`);
  }

  async train(epochs = 3) {
    console.log(`[${this.clientId}] Training for ${epochs} epochs...`);
    const xs = tf.reshape(this.localData.xs, [-1, 1]);
    await this.model.fit(xs, this.localData.ys, {
      epochs,
      batchSize: 8,
      verbose: 0,
    });
    console.log(`[${this.clientId}] Training complete`);
  }

  getLocalModelUpdate() {
    const weights = this.model.getWeights();
    const w = weights[0].dataSync()[0]; // weight parameter
    const b = weights[1].dataSync()[0]; // bias parameter
    return { weight: w, bias: b };
  }

  async submitUpdateToChain(round) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, skipping submission`);
      return;
    }

    const update = this.getLocalModelUpdate();
    const key = `fl:update:${round}:${this.org}:${this.nodeId}`;
    const value = JSON.stringify({
      round,
      org: this.org,
      node: this.nodeId,
      orgDomain: this.orgDomain,
      peerName: this.peerName,
      weight: update.weight,
      bias: update.bias,
      sampleCount: this.localData.sampleCount,
      timestamp: new Date().toISOString(),
    });

    try {
      await this.fabricClient.set(key, value);
      console.log(`[${this.clientId}] Submitted update to chain: ${key}`);
    } catch (err) {
      console.error(`[${this.clientId}] Failed to submit update:`, err.message);
    }
  }

  async queryGlobalModel(round) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, cannot query`);
      return null;
    }

    const key = `fl:global:${round}`;
    try {
      const value = await this.fabricClient.tryGet(key);
      if (value) {
        const globalModel = JSON.parse(value);
        console.log(`[${this.clientId}] Retrieved global model from chain:`, globalModel);
        return globalModel;
      }
      return null;
    } catch (err) {
      console.log(`[${this.clientId}] Error querying global model: ${err.message}`);
      return null;
    }
  }

  updateModelFromGlobal(globalModel) {
    if (!globalModel) return;

    const weights = this.model.getWeights();
    weights[0].dataSync()[0] = globalModel.weight;
    weights[1].dataSync()[0] = globalModel.bias;

    console.log(`[${this.clientId}] Updated local model from global: w=${globalModel.weight}, b=${globalModel.bias}`);
  }

  async cleanup() {
    if (this.model) {
      this.model.dispose();
    }
    if (this.localData) {
      this.localData.xs.dispose();
      this.localData.ys.dispose();
    }
    if (this.fabricClient) {
      await this.fabricClient.disconnect();
    }
    console.log(`[${this.clientId}] Cleaned up`);
  }
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('org', {
      type: 'string',
      required: true,
      describe: 'Organization shorthand (e.g., A, B)',
    })
    .option('node', {
      type: 'number',
      required: true,
      describe: 'Node ID within organization (e.g., 1, 2)',
    })
    .option('port', {
      type: 'number',
      required: true,
      describe: 'Port number (informational)',
    })
    .option('org-domain', {
      type: 'string',
      required: true,
      describe: 'Organization domain (e.g., org1.example.com)',
    })
    .option('org-msp-id', {
      type: 'string',
      required: true,
      describe: 'Organization MSP ID (e.g., Org1MSP)',
    })
    .option('peer-name', {
      type: 'string',
      required: true,
      describe: 'Peer name (e.g., peer0.org1.example.com)',
    })
    .option('peer-endpoint', {
      type: 'string',
      required: true,
      describe: 'Peer endpoint (e.g., localhost:7051)',
    })
    .option('orderer-endpoint', {
      type: 'string',
      default: 'localhost:7050',
      describe: 'Orderer endpoint',
    })
    .option('project-root', {
      type: 'string',
      default: path.join(__dirname, '..', '..'),
      describe: 'Project root directory',
    })
    .option('rounds', {
      type: 'number',
      default: 3,
      describe: 'Number of FL rounds to participate in',
    })
    .option('epochs', {
      type: 'number',
      default: 3,
      describe: 'Local training epochs per round',
    })
    .parse();

  const client = new FlClient({
    org: argv.org,
    node: argv.node,
    port: argv.port,
    orgDomain: argv['org-domain'],
    orgMspId: argv['org-msp-id'],
    peerName: argv['peer-name'],
    peerEndpoint: argv['peer-endpoint'],
    ordererEndpoint: argv['orderer-endpoint'],
    projectRoot: argv['project-root'],
  });

  try {
    await client.initialize();

    // Simulate FL rounds
    for (let round = 1; round <= argv.rounds; round++) {
      console.log(`\n========== Round ${round} ==========`);

      // Local training
      await client.train(argv.epochs);

      // Small delay to simulate network latency
      await new Promise((r) => setTimeout(r, 1000));

      // Submit update to chain
      await client.submitUpdateToChain(round);

      // Wait for aggregation (in real scenario, other nodes are also submitting)
      console.log(`[${client.clientId}] Waiting for aggregation...`);
      await new Promise((r) => setTimeout(r, 5000));

      // Query global model
      const globalModel = await client.queryGlobalModel(round);
      if (globalModel) {
        client.updateModelFromGlobal(globalModel);
      }
    }

    console.log(`\n[${client.clientId}] All rounds completed`);
  } catch (err) {
    console.error(`[${client.clientId}] Fatal error:`, err);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

main().catch(console.error);

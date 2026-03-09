#!/usr/bin/env node

/**
 * Independent FL Client for Multi-Organization Fabric Network
 * Each instance represents a peer node in a specific organization
 */

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Suppress TensorFlow C++ INFO logs (oneDNN/CPU feature banners).
if (!process.env.TF_CPP_MIN_LOG_LEVEL) {
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
}

const tf = require('@tensorflow/tfjs-node');
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
    if (!fs.existsSync(dirPath)) {
      throw new Error(
        `Missing crypto directory: ${dirPath}. Run './deploy.sh --strategy vpsa' first (or regenerate organizations).`
      );
    }
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

    if (!fs.existsSync(certPath)) {
      throw new Error(
        `Missing admin cert: ${certPath}. Run './deploy.sh --strategy vpsa' first (or regenerate organizations).`
      );
    }

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
        trainingchannel: {
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

      const network = await this.gateway.getNetwork('trainingchannel');
      this.contract = network.getContract('contracts');
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

    async submit(functionName, ...args) {
      if (!this.contract) {
        throw new Error('Client is not connected');
      }
      return this.contract.submitTransaction(functionName, ...args.map(String));
    }

    async evaluate(functionName, ...args) {
      if (!this.contract) {
        throw new Error('Client is not connected');
      }
      return this.contract.evaluateTransaction(functionName, ...args.map(String));
    }

    async initSyncRound(round, expectedParticipants = 2) {
      return this.submit('AggregationContract:InitSyncRound', round, expectedParticipants);
    }

    async initHierarchicalRound(round, expectedOrgs, org1ExpectedNodes, org2ExpectedNodes) {
      return this.submit(
        'AggregationContract:InitHierarchicalRound',
        round,
        expectedOrgs,
        org1ExpectedNodes,
        org2ExpectedNodes
      );
    }

    async submitLocalNodeUpdateSync(collection, round, nodeID, weightsJson, sampleCount) {
      return this.submit(
        'AggregationContract:SubmitLocalNodeUpdateSync',
        collection,
        round,
        nodeID,
        weightsJson,
        sampleCount
      );
    }

    async finalizeOrgSyncRound(round) {
      return this.submit('AggregationContract:FinalizeOrgSyncRound', round);
    }

    async submitLocalUpdateSync(collection, round, weightsJson, sampleCount) {
      return this.submit(
        'AggregationContract:SubmitLocalUpdateSync',
        collection,
        round,
        weightsJson,
        sampleCount
      );
    }

    async finalizeSyncRound(round) {
      return this.submit('AggregationContract:FinalizeSyncRound', round);
    }

    async getRoundStatus(round) {
      const result = await this.evaluate('AggregationContract:GetRoundStatus', round);
      return JSON.parse(result.toString());
    }

    async submitLocalUpdateAsync(collection, weightsJson, sampleCount) {
      return this.submit(
        'AggregationContract:SubmitLocalUpdateAsync',
        collection,
        weightsJson,
        sampleCount
      );
    }

    async getGlobalModel(round) {
      const result = await this.evaluate('AggregationContract:GetGlobalModel', round);
      return JSON.parse(result.toString());
    }

    async getLatestModelVersion() {
      const result = await this.evaluate('AggregationContract:GetLatestModelVersion');
      return Number(result.toString());
    }

    async getGlobalModelByVersion(version) {
      const result = await this.evaluate('AggregationContract:GetGlobalModelByVersion', version);
      return JSON.parse(result.toString());
    }

    async getCurrentRound() {
      const result = await this.evaluate('AggregationContract:GetCurrentRound');
      return Number(result.toString());
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
    this.org1NodeCount = options.org1NodeCount || 2;
    this.org2NodeCount = options.org2NodeCount || 3;
    
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
    this.mode = options.mode || 'sync';
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getErrMessage(err) {
    return String(err && err.message ? err.message : err || '');
  }

  isIdempotentSuccess(msg) {
    return (
      msg.includes('already initialized') ||
      msg.includes('already submitted for round') ||
      msg.includes('already submitted by node') ||
      msg.includes('org round') && msg.includes('already completed') ||
      msg.includes('already completed') ||
      msg.includes('already finalized')
    );
  }

  isRetryable(msg) {
    return (
      msg.includes('MVCC_READ_CONFLICT') ||
      msg.includes('not ready') ||
      msg.includes('org round') && msg.includes('not ready') ||
      (msg.includes('round') && msg.includes('not initialized'))
    );
  }

  isFatalConfigError(msg) {
    return msg.includes('collection') && msg.includes('could not be found');
  }

  isModelNotReady(msg) {
    return msg.includes('global model not found for round');
  }

  async withRetry(label, fn, options = {}) {
    const {
      attempts = 8,
      initialDelayMs = 200,
      maxDelayMs = 2000,
      treatIdempotentAsSuccess = true,
    } = options;

    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = this.getErrMessage(err);

        if (treatIdempotentAsSuccess && this.isIdempotentSuccess(msg)) {
          console.log(`[${this.clientId}] ${label}: idempotent success (${msg})`);
          return null;
        }

        if (this.isFatalConfigError(msg)) {
          throw err;
        }

        if (!this.isRetryable(msg) || attempt === attempts) {
          throw err;
        }

        const jitter = Math.floor(Math.random() * 100);
        await this.sleep(Math.min(delay, maxDelayMs) + jitter);
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }

    return null;
  }

  async trainOneEpoch() {
    console.log(`[${this.clientId}] Training for 1 epoch...`);
    const xs = tf.reshape(this.localData.xs, [-1, 1]);
    await this.model.fit(xs, this.localData.ys, {
      epochs: 1,
      batchSize: 8,
      verbose: 0,
    });
    console.log(`[${this.clientId}] Epoch training complete`);
  }

  getLocalModelUpdate() {
    const weights = this.model.getWeights();
    const w = weights[0].dataSync()[0]; // weight parameter
    const b = weights[1].dataSync()[0]; // bias parameter
    return [w, b];
  }

  async submitUpdateToChain(epoch) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, skipping submission`);
      return;
    }

    const update = this.getLocalModelUpdate();
    const value = JSON.stringify(update);
    const collection = this.orgMspId === 'Org1MSP' ? 'vpsaOrg1Shards' : 'vpsaOrg2Shards';
    const isOrgSubmitter = this.nodeId === 1;
    const nodeID = String(this.nodeId);

    try {
      if (this.mode === 'sync') {
        await this.withRetry(
          `InitHierarchicalRound(${epoch})`,
          () => this.fabricClient.initHierarchicalRound(epoch, 2, this.org1NodeCount, this.org2NodeCount),
          { attempts: 8, initialDelayMs: 150 }
        );

        await this.withRetry(
          `SubmitLocalNodeUpdateSync(${epoch}, node=${nodeID})`,
          () =>
            this.fabricClient.submitLocalNodeUpdateSync(
              collection,
              epoch,
              nodeID,
              value,
              this.localData.sampleCount
            ),
          { attempts: 10, initialDelayMs: 200 }
        );
        console.log(`[${this.clientId}] Submitted node-level SYNC update for epoch ${epoch}`);

        // One representative per organization drives org-level and global finalize calls.
        if (!isOrgSubmitter) {
          return;
        }

        await this.withRetry(
          `FinalizeOrgSyncRound(${epoch})`,
          () => this.fabricClient.finalizeOrgSyncRound(epoch),
          { attempts: 20, initialDelayMs: 250 }
        );
        console.log(`[${this.clientId}] Finalized org-level sync epoch ${epoch}`);

        await this.withRetry(
          `FinalizeSyncRound(${epoch})`,
          () => this.fabricClient.finalizeSyncRound(epoch),
          { attempts: 20, initialDelayMs: 250 }
        );
        console.log(`[${this.clientId}] Finalized sync epoch ${epoch}`);
      } else {
        await this.withRetry(
          'SubmitLocalUpdateAsync',
          () => this.fabricClient.submitLocalUpdateAsync(collection, value, this.localData.sampleCount),
          { attempts: 8, initialDelayMs: 200 }
        );
        console.log(`[${this.clientId}] Submitted ASYNC update`);
      }
    } catch (err) {
      const msg = this.getErrMessage(err);
      if (msg.includes('collection') && msg.includes('could not be found')) {
        console.error(
          `[${this.clientId}] Failed to submit update: training PDC collections missing. ` +
            `Redeploy network with: ./deploy.sh --strategy vpsa`
        );
        return;
      }
      console.error(`[${this.clientId}] Failed to submit update:`, err.message);
    }
  }

  async queryGlobalModel(epoch) {
    if (!this.fabricClient) {
      console.log(`[${this.clientId}] Not connected to Fabric, cannot query`);
      return null;
    }

    const waitForSyncRoundFinalized = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 12; attempt++) {
        try {
          const status = await this.fabricClient.getRoundStatus(epoch);
          if (status && status.aggregationDone) {
            return true;
          }
        } catch (err) {
          lastError = err;
        }

        if (attempt < 12) {
          await this.sleep(1500);
        }
      }

      if (lastError) {
        console.log(`[${this.clientId}] Round status check timed out: ${lastError.message}`);
      }
      return false;
    };

    // Query with retry for sync mode (global model may not be committed on this peer immediately)
    const retryQuerySync = async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          const globalModel = await this.fabricClient.getGlobalModel(epoch);
          console.log(`[${this.clientId}] Retrieved SYNC global model for epoch ${epoch}`);
          return globalModel;
        } catch (err) {
          lastError = err;
          const msg = this.getErrMessage(err);

          if (attempt < 10 && this.isModelNotReady(msg)) {
            console.log(`[${this.clientId}] Query attempt ${attempt} model not ready, retrying in 2s...`);
            await this.sleep(2000);
            continue;
          }

          if (attempt < 10) {
            await this.sleep(1500);
          }
        }
      }
      throw lastError;
    };

    try {
      if (this.mode === 'sync') {
        await waitForSyncRoundFinalized();
        return await retryQuerySync();
      }

      const version = await this.fabricClient.getLatestModelVersion();
      const globalModel = await this.fabricClient.getGlobalModelByVersion(version);
      console.log(`[${this.clientId}] Retrieved ASYNC global model version ${version}`);
      return globalModel;
    } catch (err) {
      console.log(`[${this.clientId}] Error querying global model: ${err.message}`);
      return null;
    }
  }

  updateModelFromGlobal(globalModel) {
    if (!globalModel) return;

    try {
      const parsed = JSON.parse(globalModel.modelData);
      if (!Array.isArray(parsed) || parsed.length < 2) {
        console.log(`[${this.clientId}] Global modelData format invalid, skip local update`);
        return;
      }
      const [w, b] = parsed;
      this.model.setWeights([
        tf.tensor2d([w], [1, 1]),
        tf.tensor1d([b]),
      ]);
      console.log(`[${this.clientId}] Updated local model from global: w=${w}, b=${b}`);
    } catch (err) {
      console.log(`[${this.clientId}] Failed to parse global modelData: ${err.message}`);
    }
  }

  async loadLatestGlobalModel() {
    try {
      console.log(`[${this.clientId}] Checking for latest global model on chain...`);
      const currentRound = await this.fabricClient.getCurrentRound();
      
      if (currentRound === 0) {
        console.log(`[${this.clientId}] No previous training rounds found, starting fresh`);
        return 0; // Return 0 to indicate starting from round 1
      }
      
      console.log(`[${this.clientId}] Found completed round ${currentRound}, loading global model...`);
      const globalModel = await this.fabricClient.getGlobalModel(currentRound);
      
      if (globalModel && globalModel.modelData) {
        this.updateModelFromGlobal(globalModel);
        console.log(`[${this.clientId}] Successfully initialized from round ${currentRound} model`);
        return currentRound; // Return current round number
      } else {
        console.log(`[${this.clientId}] Global model not found for round ${currentRound}, using random initialization`);
        return 0;
      }
    } catch (err) {
      console.warn(`[${this.clientId}] Failed to load latest model: ${err.message}, continuing with random initialization`);
      return 0;
    }
  }

  saveGlobalModelToFile(globalModel, round) {
    try {
      const modelsDir = path.join(this.projectRoot, 'nodejs-client', 'models');
      
      // Ensure models directory exists
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
      }
      
      const filename = `global-model-round-${round}.json`;
      const filepath = path.join(modelsDir, filename);
      
      // Save the complete global model object
      const modelToSave = {
        round: globalModel.round,
        timestamp: globalModel.timestamp,
        modelData: globalModel.modelData,
        participants: globalModel.participants || [],
        participantCount: globalModel.participants ? globalModel.participants.length : 0,
        totalSamples: globalModel.totalSamples || 0
      };
      
      fs.writeFileSync(filepath, JSON.stringify(modelToSave, null, 2));
      console.log(`[${this.clientId}] Global model saved to ${filename}`);
      
      // Also save as "latest" for easy access
      const latestPath = path.join(modelsDir, 'global-model-latest.json');
      fs.writeFileSync(latestPath, JSON.stringify(modelToSave, null, 2));
      
      return filepath;
    } catch (err) {
      console.warn(`[${this.clientId}] Failed to save global model to file: ${err.message}`);
      return null;
    }
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
    .option('epochs', {
      type: 'number',
      default: 10,
      describe: 'Total number of training epochs (each epoch = 1 FL round)',
    })
    .option('mode', {
      type: 'string',
      default: 'sync',
      choices: ['sync', 'async'],
      describe: 'FL mode: sync or async',
    })
    .option('org1-node-count', {
      type: 'number',
      default: 2,
      describe: 'Expected number of participating nodes in Org1',
    })
    .option('org2-node-count', {
      type: 'number',
      default: 3,
      describe: 'Expected number of participating nodes in Org2',
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
    mode: argv.mode,
    org1NodeCount: argv['org1-node-count'],
    org2NodeCount: argv['org2-node-count'],
  });

  try {
    await client.initialize();

    // Try to load latest global model from chain
    const lastCompletedRound = await client.loadLatestGlobalModel();
    const startRound = lastCompletedRound + 1;
    const endRound = lastCompletedRound + argv.epochs;
    
    console.log(`\n[${client.clientId}] Starting training from round ${startRound} to ${endRound}`);

    // FL training: each epoch triggers one round of aggregation
    for (let epoch = 1; epoch <= argv.epochs; epoch++) {
      const currentRound = lastCompletedRound + epoch;
      console.log(`\n========== Epoch ${epoch}/${argv.epochs} (Round ${currentRound}) ==========`);

      // Local training for 1 epoch
      await client.trainOneEpoch();

      // Small delay to simulate network latency
      await new Promise((r) => setTimeout(r, 1000));

      // Submit update to chain (use actual round number)
      await client.submitUpdateToChain(currentRound);

      // Wait for aggregation and finalization
      if (argv.mode === 'sync') {
        console.log(`[${client.clientId}] Waiting for sync aggregation and finalization...`);
        // Give time for FinalizeSyncRound to execute and aggregate results
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Query and apply global model (use actual round number)
      const globalModel = await client.queryGlobalModel(currentRound);
      if (globalModel) {
        client.updateModelFromGlobal(globalModel);
        // Save global model to local file
        client.saveGlobalModelToFile(globalModel, currentRound);
      }
    }

    console.log(`\n[${client.clientId}] All epochs completed (${argv.epochs} FL rounds)`);
  } catch (err) {
    console.error(`[${client.clientId}] Fatal error:`, err);
    process.exit(1);
  } finally {
    await client.cleanup();
  }
}

main().catch(console.error);

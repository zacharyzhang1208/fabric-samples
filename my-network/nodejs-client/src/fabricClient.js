const fs = require('fs');
const path = require('path');
const { Gateway } = require('fabric-network');
const config = require('./config');

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
    name: 'my-network-client',
    version: '1.0.0',
    channels: {
      [config.channelName]: {
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
          'ssl-target-name-override': config.peerHostAlias,
          hostnameOverride: config.peerHostAlias,
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
          'ssl-target-name-override': config.ordererHostAlias,
          hostnameOverride: config.ordererHostAlias,
        },
      },
    },
  };
}

class FabricClient {
  constructor() {
    this.gateway = new Gateway();
    this.network = null;
    this.contract = null;
  }

  async connect() {
    const identity = buildIdentity();
    const connectionProfile = buildConnectionProfile();

    await this.gateway.connect(connectionProfile, {
      identity,
      discovery: { enabled: true, asLocalhost: true },
    });

    this.network = await this.gateway.getNetwork(config.channelName);
    this.contract = this.network.getContract(config.chaincodeName);
  }

  async set(key, value) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    await this.contract.submitTransaction('Set', key, value);
    return { key, value };
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

  async initCentralizedRound(round, expectedParticipants = 2) {
    return this.submit('AggregationContract:InitCentralizedRound', round, expectedParticipants);
  }

  async submitLocalUpdateSync(collection, round, updateData, sampleCount) {
    return this.submit(
      'AggregationContract:SubmitLocalUpdateSync',
      collection,
      round,
      updateData,
      sampleCount
    );
  }

  async submitLocalUpdateCentralized(collection, round, nodeID, updateData, sampleCount) {
    return this.submit(
      'AggregationContract:SubmitLocalUpdateCentralized',
      collection,
      round,
      nodeID,
      updateData,
      sampleCount
    );
  }

  async finalizeSyncRound(round) {
    return this.submit('AggregationContract:FinalizeSyncRound', round);
  }

  async finalizeCentralizedRound(round) {
    return this.submit('AggregationContract:FinalizeCentralizedRound', round);
  }

  async submitLocalUpdateAsync(collection, updateData, sampleCount, baselineVersion = 0) {
    const result = await this.submit(
      'AggregationContract:SubmitLocalUpdateAsync',
      collection,
      updateData,
      sampleCount,
      baselineVersion
    );
    return JSON.parse(result.toString());
  }

  async aggregateAsyncBatch(txIds, minUpdates = 5) {
    const result = await this.submit(
      'AggregationContract:AggregateAsyncBatch',
      JSON.stringify(txIds),
      minUpdates
    );
    return JSON.parse(result.toString());
  }

  async getPendingAsyncUpdates(limit = 0) {
    const result = await this.evaluate('AggregationContract:GetPendingAsyncUpdates', limit);
    return JSON.parse(result.toString());
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

  async getRoundStatus(round) {
    const result = await this.evaluate('AggregationContract:GetRoundStatus', round);
    return JSON.parse(result.toString());
  }

  async getSyncAggregationTiming(round) {
    const result = await this.evaluate('AggregationContract:GetSyncAggregationTiming', round);
    return JSON.parse(result.toString());
  }

  async getCentralizedAggregationTiming(round) {
    const result = await this.evaluate('AggregationContract:GetCentralizedAggregationTiming', round);
    return JSON.parse(result.toString());
  }

  async getAsyncAggregationTiming(version) {
    const result = await this.evaluate('AggregationContract:GetAsyncAggregationTiming', version);
    return JSON.parse(result.toString());
  }

  async get(key) {
    if (!this.contract) {
      throw new Error('Client is not connected');
    }
    const result = await this.contract.evaluateTransaction('Get', key);
    return result.toString();
  }

  async disconnect() {
    await this.gateway.disconnect();
  }
}

module.exports = FabricClient;

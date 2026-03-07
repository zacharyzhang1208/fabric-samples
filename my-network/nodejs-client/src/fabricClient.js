const fs = require('fs');
const path = require('path');
const { Gateway } = require('fabric-network');
const config = require('./config');

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
    this.contract = null;
  }

  async connect() {
    const identity = buildIdentity();
    const connectionProfile = buildConnectionProfile();

    await this.gateway.connect(connectionProfile, {
      identity,
      discovery: { enabled: true, asLocalhost: true },
    });

    const network = await this.gateway.getNetwork(config.channelName);
    this.contract = network.getContract(config.chaincodeName);
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

  async disconnect() {
    await this.gateway.disconnect();
  }
}

module.exports = FabricClient;

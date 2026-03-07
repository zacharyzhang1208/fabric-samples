const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

module.exports = {
  projectRoot,
  channelName: process.env.FABRIC_CHANNEL || 'mychannel',
  chaincodeName: process.env.FABRIC_CHAINCODE || 'simple',
  orgMspId: process.env.FABRIC_MSP_ID || 'Org1MSP',
  peerEndpoint: process.env.FABRIC_PEER_ENDPOINT || 'localhost:7051',
  peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS || 'peer0.org1.example.com',
  ordererEndpoint: process.env.FABRIC_ORDERER_ENDPOINT || 'localhost:7050',
  ordererHostAlias: process.env.FABRIC_ORDERER_HOST_ALIAS || 'orderer.example.com',
  orgDomain: process.env.FABRIC_ORG_DOMAIN || 'org1.example.com',
  peerName: process.env.FABRIC_PEER_NAME || 'peer0.org1.example.com',
};

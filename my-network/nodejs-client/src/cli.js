#!/usr/bin/env node

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const FabricClient = require('./fabricClient');
const { runSimpleFederatedLearning } = require('./federatedLearning');
const { writeFlReport } = require('./flVisualizer');

async function withClient(fn) {
  const client = new FabricClient();
  try {
    await client.connect();
    await fn(client);
  } finally {
    await client.disconnect();
  }
}

yargs(hideBin(process.argv))
  .command(
    'set <key> <value>',
    'Store key-value into chaincode world state',
    (cmd) => {
      cmd
        .positional('key', { type: 'string', describe: 'State key' })
        .positional('value', { type: 'string', describe: 'State value' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const result = await client.set(argv.key, argv.value);
        console.log(`SET success: ${result.key} = ${result.value}`);
      });
    }
  )
  .command(
    'get <key>',
    'Read value from chaincode world state',
    (cmd) => {
      cmd.positional('key', { type: 'string', describe: 'State key' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const value = await client.get(argv.key);
        console.log(`GET result: ${argv.key} = ${value}`);
      });
    }
  )
  .command(
    'fl:run',
    'Run a simple local federated learning simulation (TensorFlow.js)',
    (cmd) => {
      cmd
        .option('rounds', {
          type: 'number',
          default: 5,
          describe: 'Federated rounds',
        })
        .option('clients', {
          type: 'number',
          default: 3,
          describe: 'Number of participating clients',
        })
        .option('samples', {
          type: 'number',
          default: 20,
          describe: 'Samples per client',
        })
        .option('localEpochs', {
          type: 'number',
          default: 3,
          describe: 'Local epochs per round',
        })
        .option('lr', {
          type: 'number',
          default: 0.03,
          describe: 'Learning rate',
        })
        .option('batchSize', {
          type: 'number',
          default: 8,
          describe: 'Batch size for local training',
        })
        .option('chart', {
          type: 'boolean',
          default: true,
          describe: 'Generate HTML chart report after training',
        })
        .option('chartFile', {
          type: 'string',
          default: './reports/fl-report.html',
          describe: 'Output path for generated chart report',
        })
        .option('saveModel', {
          type: 'string',
          describe: 'Save final global model to a JSON file',
        })
        .option('loadModel', {
          type: 'string',
          describe: 'Load initial global model from a JSON file',
        });
    },
    async (argv) => {
      const result = await runSimpleFederatedLearning({
        rounds: argv.rounds,
        clients: argv.clients,
        samples: argv.samples,
        localEpochs: argv.localEpochs,
        batchSize: argv.batchSize,
        learningRate: argv.lr,
        saveModelPath: argv.saveModel,
        loadModelPath: argv.loadModel,
      });

      console.log('FL finished');
      console.log('Mode: multi-process (coordinator + client workers)');
      if (result.loadedFrom) {
        console.log(`Loaded initial model: ${result.loadedFrom}`);
      }
      for (const r of result.rounds) {
        console.log(
          `Round ${r.round}: w=${r.globalModel.weight}, b=${r.globalModel.bias}, mse=${r.mse}`
        );
      }
      console.log(`Final model: w=${result.finalModel.weight}, b=${result.finalModel.bias}`);
      console.log(`Final MSE: ${result.finalMse}`);
      if (result.savedTo) {
        console.log(`Model saved: ${result.savedTo}`);
      }

      if (argv.chart) {
        const reportPath = writeFlReport(result, argv.chartFile);
        console.log(`Chart report generated: ${reportPath}`);
      }
    }
  )
  .demandCommand(1)
  .strict()
  .help()
  .parse();

#!/usr/bin/env node

require('dotenv').config();
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const FabricClient = require('./fabricClient');

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
    'fl-init-sync <round> [expectedParticipants]',
    'Initialize a synchronous FL round on training channel',
    (cmd) => {
      cmd
        .positional('round', { type: 'number', describe: 'Round number' })
        .positional('expectedParticipants', {
          type: 'number',
          default: 2,
          describe: 'Expected participant count',
        });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.initSyncRound(argv.round, argv.expectedParticipants);
        console.log(
          `SYNC round initialized: round=${argv.round}, expectedParticipants=${argv.expectedParticipants}`
        );
      });
    }
  )
  .command(
    'fl-init-centralized <round> [expectedParticipants]',
    'Initialize a centralized FL round on training channel',
    (cmd) => {
      cmd
        .positional('round', { type: 'number', describe: 'Round number' })
        .positional('expectedParticipants', {
          type: 'number',
          default: 5,
          describe: 'Expected total node count',
        });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.initCentralizedRound(argv.round, argv.expectedParticipants);
        console.log(
          `CENTRALIZED round initialized: round=${argv.round}, expectedParticipants=${argv.expectedParticipants}`
        );
      });
    }
  )
  .command(
    'fl-submit-sync <collection> <round> <weightsJson> <sampleCount>',
    'Submit local model update in synchronous FL mode',
    (cmd) => {
      cmd
        .positional('collection', { type: 'string', describe: 'PDC collection name' })
        .positional('round', { type: 'number', describe: 'Round number' })
        .positional('weightsJson', { type: 'string', describe: 'JSON weights, e.g. [0.1,0.2]' })
        .positional('sampleCount', { type: 'number', describe: 'Local sample count' });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.submitLocalUpdateSync(argv.collection, argv.round, argv.weightsJson, argv.sampleCount);
        console.log('SYNC update submitted');
      });
    }
  )
  .command(
    'fl-submit-centralized <collection> <round> <nodeID> <weightsJson> <sampleCount>',
    'Submit local model update in centralized FL mode',
    (cmd) => {
      cmd
        .positional('collection', { type: 'string', describe: 'PDC collection name' })
        .positional('round', { type: 'number', describe: 'Round number' })
        .positional('nodeID', { type: 'string', describe: 'Node identifier' })
        .positional('weightsJson', { type: 'string', describe: 'JSON weights, e.g. [0.1,0.2]' })
        .positional('sampleCount', { type: 'number', describe: 'Local sample count' });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.submitLocalUpdateCentralized(
          argv.collection,
          argv.round,
          argv.nodeID,
          argv.weightsJson,
          argv.sampleCount
        );
        console.log('CENTRALIZED update submitted');
      });
    }
  )
  .command(
    'fl-submit-async <collection> <weightsJson> <sampleCount> [baselineVersion]',
    'Submit local model update in asynchronous FL mode',
    (cmd) => {
      cmd
        .positional('collection', { type: 'string', describe: 'PDC collection name' })
        .positional('weightsJson', { type: 'string', describe: 'JSON weights, e.g. [0.1,0.2]' })
        .positional('sampleCount', { type: 'number', describe: 'Local sample count' })
        .positional('baselineVersion', { type: 'number', default: 0, describe: 'Baseline global model version' });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.submitLocalUpdateAsync(argv.collection, argv.weightsJson, argv.sampleCount, argv.baselineVersion);
        console.log('ASYNC update submitted');
      });
    }
  )
  .command(
    'fl-get-sync-model <round>',
    'Read aggregated sync global model for a round',
    (cmd) => {
      cmd.positional('round', { type: 'number', describe: 'Round number' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const model = await client.getGlobalModel(argv.round);
        console.log(JSON.stringify(model, null, 2));
      });
    }
  )
  .command(
    'fl-get-centralized-model <round>',
    'Read aggregated centralized global model for a round',
    (cmd) => {
      cmd.positional('round', { type: 'number', describe: 'Round number' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const model = await client.getGlobalModel(argv.round);
        console.log(JSON.stringify(model, null, 2));
      });
    }
  )
  .command(
    'fl-finalize-centralized <round>',
    'Finalize a centralized FL round',
    (cmd) => {
      cmd.positional('round', { type: 'number', describe: 'Round number' });
    },
    async (argv) => {
      await withClient(async (client) => {
        await client.finalizeCentralizedRound(argv.round);
        console.log(`CENTRALIZED round finalized: round=${argv.round}`);
      });
    }
  )
  .command(
    'fl-get-centralized-timing <round>',
    'Read centralized aggregation timing for a round',
    (cmd) => {
      cmd.positional('round', { type: 'number', describe: 'Round number' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const timing = await client.getCentralizedAggregationTiming(argv.round);
        console.log(JSON.stringify(timing, null, 2));
      });
    }
  )
  .command(
    'fl-get-latest-async',
    'Read latest async model version',
    () => {},
    async () => {
      await withClient(async (client) => {
        const version = await client.getLatestModelVersion();
        console.log(`latest async version: ${version}`);
      });
    }
  )
  .command(
    'fl-get-async-model <version>',
    'Read async global model by version',
    (cmd) => {
      cmd.positional('version', { type: 'number', describe: 'Model version' });
    },
    async (argv) => {
      await withClient(async (client) => {
        const model = await client.getGlobalModelByVersion(argv.version);
        console.log(JSON.stringify(model, null, 2));
      });
    }
  )
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
  .demandCommand(1)
  .strict()
  .help()
  .parse();

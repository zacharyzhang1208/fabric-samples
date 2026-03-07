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

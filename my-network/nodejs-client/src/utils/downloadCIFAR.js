#!/usr/bin/env node

/**
 * CIFAR-10 Dataset Downloader
 * Downloads CIFAR-10 binary archive and extracts it locally.
 *
 * Usage: node src/utils/downloadCIFAR.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const dataDir = path.join(__dirname, '..', '..', 'data', 'cifar');
const archivePath = path.join(dataDir, 'cifar-10-binary.tar.gz');
const extractDir = dataDir;
const expectedDir = path.join(dataDir, 'cifar-10-batches-bin');
const downloadUrl = 'https://www.cs.toronto.edu/~kriz/cifar-10-binary.tar.gz';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function hasRequiredFiles() {
  if (!fs.existsSync(expectedDir)) {
    return false;
  }

  const required = [
    'data_batch_1.bin',
    'data_batch_2.bin',
    'data_batch_3.bin',
    'data_batch_4.bin',
    'data_batch_5.bin',
    'test_batch.bin',
  ];

  return required.every((name) => fs.existsSync(path.join(expectedDir, name)));
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }

    const file = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close(() => {
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        });
        res.resume();
        return;
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;
      const startedAt = Date.now();
      let lastLogMs = 0;

      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastLogMs < 300) {
          return;
        }
        lastLogMs = now;

        if (total > 0) {
          const percent = ((received / total) * 100).toFixed(1);
          const elapsed = Math.max((now - startedAt) / 1000, 0.001);
          const speedMB = (received / elapsed / 1024 / 1024).toFixed(2);
          process.stdout.write(`\rDownloading CIFAR-10: ${percent}% (${speedMB} MB/s)`);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        process.stdout.write('\n');
        file.close(resolve);
      });
    });

    req.on('error', (err) => {
      file.close(() => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(err);
      });
    });

    file.on('error', (err) => {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      reject(err);
    });
  });
}

function extractArchive(tarPath, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tarPath, '-C', cwd], {
      stdio: 'inherit',
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run tar: ${err.message}`));
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

async function main() {
  ensureDir(dataDir);

  if (hasRequiredFiles()) {
    console.log('CIFAR-10 already available, skipping download.');
    console.log(`Data path: ${expectedDir}`);
    return;
  }

  console.log('Downloading CIFAR-10 binary dataset...');
  await downloadFile(downloadUrl, archivePath);

  console.log('Extracting archive...');
  await extractArchive(archivePath, extractDir);

  if (!hasRequiredFiles()) {
    throw new Error('CIFAR-10 extraction completed but required files are missing.');
  }

  console.log('CIFAR-10 download complete.');
  console.log(`Data path: ${expectedDir}`);
}

main().catch((err) => {
  console.error(`CIFAR-10 download failed: ${err.message}`);
  process.exit(1);
});

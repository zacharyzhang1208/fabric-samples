#!/usr/bin/env node

/**
 * MNIST Dataset Downloader
 * Downloads MNIST dataset once and decompresses locally
 * Run this before starting training to avoid concurrent download issues
 * 
 * Usage: node src/utils/downloadMNIST.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const dataDir = path.join(__dirname, '..', '..', 'data', 'mnist');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.ceil(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isValidMnistFile(filePath, expectedMagic, minSizeBytes = 16) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < minSizeBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    return header.readUInt32BE(0) === expectedMagic;
  } catch (_) {
    return false;
  }
}

// Create data directory if it doesn't exist
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`✓ Created directory: ${dataDir}`);
}

/**
 * Download a file from URL (supports both http:// and https://)
 */
function downloadFile(url, destPath, expectedMagic) {
  return new Promise((resolve, reject) => {
    // Check if decompressed file already exists
    if (isValidMnistFile(destPath, expectedMagic)) {
      console.log(`  ✓ Already cached: ${path.basename(destPath)}`);
      resolve();
      return;
    }

    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
      console.log(`  ! Corrupted cache removed: ${path.basename(destPath)}`);
    }

    console.log(`  ⬇ Downloading: ${path.basename(url)}`);
    
    const gzPath = destPath + '.gz';
    
    // Select http or https based on URL protocol
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    if (fs.existsSync(gzPath)) {
      fs.unlinkSync(gzPath);
    }

    const file = fs.createWriteStream(gzPath);
    const req = protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close(() => {
          if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
          reject(new Error(`Download failed for ${path.basename(url)}: HTTP ${response.statusCode}`));
        });
        response.resume();
        return;
      }

      const totalBytes = Number(response.headers['content-length'] || 0);
      let downloadedBytes = 0;
      const startedAt = Date.now();
      let lastLogAt = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastLogAt < 300) {
          return;
        }
        lastLogAt = now;

        const elapsedSec = Math.max((now - startedAt) / 1000, 0.001);
        const speed = downloadedBytes / elapsedSec;
        const pct = totalBytes > 0 ? ((downloadedBytes / totalBytes) * 100).toFixed(1) : '??.?';
        const etaSec = totalBytes > 0 ? (totalBytes - downloadedBytes) / Math.max(speed, 1) : NaN;

        const progressLine = `    ${pct}% ${formatBytes(downloadedBytes)}/${formatBytes(totalBytes)} @ ${formatBytes(speed)}/s ETA ${formatDuration(etaSec)}`;
        process.stdout.write(`\r${progressLine.padEnd(96, ' ')}`);
      });

      response.pipe(file);
      file.on('finish', () => {
        process.stdout.write('\n');
        file.close(() => {
          try {
            const fd = fs.openSync(gzPath, 'r');
            const header = Buffer.alloc(2);
            fs.readSync(fd, header, 0, 2, 0);
            fs.closeSync(fd);
            // Gzip magic bytes: 1F 8B
            if (header[0] !== 0x1f || header[1] !== 0x8b) {
              fs.unlinkSync(gzPath);
              reject(new Error(`Invalid gzip content for ${path.basename(url)} (received non-gzip payload)`));
              return;
            }
          } catch (err) {
            if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
            reject(err);
            return;
          }

          console.log(`  ✓ Downloaded, decompressing...`);
          const gunzip = zlib.createGunzip();
          const source = fs.createReadStream(gzPath);
          const destination = fs.createWriteStream(destPath);

          const onError = (err) => {
            if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
          };

          source.on('error', onError);
          gunzip.on('error', onError);
          destination.on('error', onError);

          source.pipe(gunzip).pipe(destination).on('finish', () => {
            if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
            console.log(`  ✓ Decompressed: ${path.basename(destPath)}`);
            resolve();
          });
        });
      });
      file.on('error', (err) => {
        if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
        reject(err);
      });
    });

    req.on('error', (err) => {
      if (fs.existsSync(gzPath)) fs.unlinkSync(gzPath);
      reject(err);
    });
  });
}

/**
 * Download all MNIST files
 */
async function downloadMNIST() {
  const baseUrl = 'https://storage.googleapis.com/cvdf-datasets/mnist/';
  const files = [
    { url: baseUrl + 'train-images-idx3-ubyte.gz', path: path.join(dataDir, 'train-images-idx3-ubyte'), magic: 2051 },
    { url: baseUrl + 'train-labels-idx1-ubyte.gz', path: path.join(dataDir, 'train-labels-idx1-ubyte'), magic: 2049 },
    { url: baseUrl + 't10k-images-idx3-ubyte.gz', path: path.join(dataDir, 't10k-images-idx3-ubyte'), magic: 2051 },
    { url: baseUrl + 't10k-labels-idx1-ubyte.gz', path: path.join(dataDir, 't10k-labels-idx1-ubyte'), magic: 2049 },
  ];
  
  try {
    for (const file of files) {
      await downloadFile(file.url, file.path, file.magic);
    }
    console.log('\n✅ MNIST dataset downloaded successfully!\n');
    console.log('📂 Location:', dataDir);
  } catch (error) {
    console.error('\n❌ Error downloading MNIST:', error.message);
    process.exit(1);
  }
}

// Run downloader
downloadMNIST();

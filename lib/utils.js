import winston from 'winston';
import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { URL } from 'url';
import chalk from 'chalk';
import readline from 'readline';

/**
 * Logger configuration
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ level, message, timestamp, stack }) => {
      if (stack) {
        return `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`;
      }
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${chalk.gray(timestamp)} ${level}: ${message}`;
        })
      )
    }),
    new winston.transports.File({ filename: 'scraper-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'scraper.log' })
  ]
});

/**
 * Delay execution for a specified time
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get a random delay within a range
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {number}
 */
export function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Ensure a directory exists
 * @param {string} dirPath - Directory path to create
 */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Normalize a URL to handle variations
 * @param {string} url - URL to normalize
 * @returns {string}
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash unless it's the root path
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    // Sort query parameters for consistency
    parsed.searchParams.sort();
    // Remove hash
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    logger.warn(`Failed to normalize URL: ${url}`);
    return url;
  }
}

/**
 * Check if URL is same origin
 * @param {string} url - URL to check
 * @param {string} baseUrl - Base URL for comparison
 * @returns {boolean}
 */
export function isSameOrigin(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    const base = new URL(baseUrl);
    return parsed.origin === base.origin;
  } catch (error) {
    return false;
  }
}

/**
 * Convert a URL to a safe filesystem path
 * @param {string} url - URL to convert
 * @param {string} baseUrl - Base URL for the site
 * @returns {string}
 */
export function urlToFilePath(url, baseUrl) {
  try {
    const parsed = new URL(url, baseUrl);
    let pathname = parsed.pathname;

    // Remove leading slash
    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }

    // If empty or ends with /, add index.html
    if (!pathname || pathname.endsWith('/')) {
      pathname += 'index.html';
    }

    // If no extension, add .html
    if (!path.extname(pathname)) {
      pathname += '.html';
    }

    // Replace invalid filesystem characters
    pathname = pathname.replace(/[<>:"|?*]/g, '_');

    return pathname;
  } catch (error) {
    logger.error(`Failed to convert URL to file path: ${url}`, error);
    return 'error.html';
  }
}

/**
 * Get relative path from one file to another
 * @param {string} from - Source file path
 * @param {string} to - Destination file path
 * @returns {string}
 */
export function getRelativePath(from, to) {
  const fromDir = path.dirname(from);
  const relative = path.relative(fromDir, to);
  // Convert Windows backslashes to forward slashes for URLs
  return relative.replace(/\\/g, '/');
}

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in ms
 * @returns {Promise<any>}
 */
export async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delayMs = initialDelay * Math.pow(2, i);
        logger.warn(`Attempt ${i + 1} failed, retrying in ${delayMs}ms...`);
        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * Format bytes to human-readable format
 * @param {number} bytes - Number of bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Check if a path matches any pattern in a list
 * @param {string} path - Path to check
 * @param {string[]} patterns - Array of glob-like patterns
 * @returns {boolean}
 */
export function matchesPattern(path, patterns) {
  if (!patterns || patterns.length === 0) return false;

  return patterns.some(pattern => {
    // Simple glob matching (*, **)
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(path);
  });
}

/**
 * Save data to a JSON file atomically
 * @param {string} filePath - Path to save the file
 * @param {any} data - Data to save
 */
export async function saveJsonFile(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);

  // Set restrictive permissions (owner read/write only)
  try {
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    logger.warn(`Could not set restrictive permissions on ${filePath}`);
  }
}

/**
 * Load data from a JSON file
 * @param {string} filePath - Path to the file
 * @returns {Promise<any>}
 */
export async function loadJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Prompt user for confirmation
 * @param {string} message - Message to display
 * @returns {Promise<boolean>}
 */
export async function promptConfirmation(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * Get content type from file extension
 * @param {string} filePath - File path
 * @returns {string}
 */
export function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
  };

  return types[ext] || 'application/octet-stream';
}

/**
 * Create a progress reporter
 * @param {string} label - Label for the progress
 * @returns {Object}
 */
export function createProgressReporter(label) {
  let lastUpdate = Date.now();
  let count = 0;

  return {
    increment() {
      count++;
      const now = Date.now();
      if (now - lastUpdate > 5000) { // Update every 5 seconds
        logger.info(`${label}: ${count} items processed`);
        lastUpdate = now;
      }
    },
    finish() {
      logger.info(`${label}: Completed. Total: ${count} items`);
    }
  };
}

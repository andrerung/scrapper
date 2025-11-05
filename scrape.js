#!/usr/bin/env node

/**
 * Revision Village Website Scraper
 *
 * A production-ready tool to create offline mirrors of authenticated websites.
 *
 * IMPORTANT: This tool requires manual Google authentication.
 * It does NOT automate login or bypass any security measures.
 *
 * Legal Notice:
 * - Use only with explicit permission from the site owner
 * - Respect the site's Terms of Service and robots.txt
 * - Do not use for unauthorized purposes
 */

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { AuthManager } from './lib/auth.js';
import { WebsiteCrawler } from './lib/crawler.js';
import { logger, formatBytes } from './lib/utils.js';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('scrape')
  .description('Clone an authenticated website for offline browsing')
  .version('1.0.0');

/**
 * Auth command - Interactive login
 */
program
  .command('auth')
  .description('Authenticate with the website (launches headful browser for manual Google login)')
  .option('--target <url>', 'Target website URL', 'https://www.revisionvillage.com')
  .option('--clear-creds', 'Clear existing credentials before authenticating')
  .action(async (options) => {
    try {
      const authManager = new AuthManager({
        targetSite: options.target
      });

      // Clear existing credentials if requested
      if (options.clearCreds) {
        await authManager.clearCredentials();
      }

      // Perform authentication
      await authManager.authenticate();

    } catch (error) {
      console.error(chalk.red('\n❌ Authentication failed:'), error.message);
      logger.error('Authentication failed', error);
      process.exit(1);
    }
  });

/**
 * Crawl command - Start crawling with saved credentials
 */
program
  .command('crawl')
  .description('Crawl the website using saved authentication')
  .option('--start <url>', 'Starting URL (relative to base URL)', '/')
  .option('--base-url <url>', 'Base URL of the site', 'https://www.revisionvillage.com')
  .option('--output <dir>', 'Output directory', 'output')
  .option('--max-pages <number>', 'Maximum number of pages to crawl', '1000')
  .option('--concurrency <number>', 'Number of parallel page renders', '4')
  .option('--delay <ms>', 'Delay between requests (ms)', '1000')
  .option('--include <patterns>', 'Include only URLs matching these patterns (comma-separated)', '')
  .option('--exclude <patterns>', 'Exclude URLs matching these patterns (comma-separated)', '')
  .option('--no-respect-robots', 'Ignore robots.txt (use with caution)')
  .option('--wait-for <selector>', 'Wait for this CSS selector before saving page')
  .option('--no-sitemap', 'Disable sitemap usage (crawl by following links instead)')
  .option('--sitemap-url <url>', 'Custom sitemap URL', '')
  .option('--force', 'Force crawl even without explicit confirmation')
  .action(async (options) => {
    try {
      const authManager = new AuthManager();

      // Check if credentials exist
      const hasCredentials = await authManager.hasCredentials();
      if (!hasCredentials) {
        console.error(chalk.red('\n❌ No saved credentials found.'));
        console.log(chalk.yellow('Please run "node scrape.js auth" first to authenticate.\n'));
        process.exit(1);
      }

      // Validate session
      console.log(chalk.cyan('🔍 Validating saved session...\n'));
      const validation = await authManager.validateSession();

      if (!validation.valid) {
        console.error(chalk.red(`\n❌ Session validation failed: ${validation.reason}`));
        console.log(chalk.yellow('Please run "node scrape.js auth" to re-authenticate.\n'));
        process.exit(1);
      }

      console.log(chalk.green('✓ Session is valid!\n'));

      // Parse start URL
      const startUrl = new URL(options.start, options.baseUrl).toString();

      // Parse patterns
      const includePatterns = options.include
        ? options.include.split(',').map(p => p.trim()).filter(Boolean)
        : [];
      const excludePatterns = options.exclude
        ? options.exclude.split(',').map(p => p.trim()).filter(Boolean)
        : [];

      // Create crawler
      const crawler = new WebsiteCrawler(authManager, {
        baseUrl: options.baseUrl,
        outputDir: options.output,
        maxPages: parseInt(options.maxPages, 10),
        concurrency: parseInt(options.concurrency, 10),
        delayMin: parseInt(options.delay, 10) - 200,
        delayMax: parseInt(options.delay, 10) + 200,
        respectRobots: options.respectRobots,
        includePatterns,
        excludePatterns,
        waitForSelector: options.waitFor,
        useSitemap: options.sitemap !== false, // Enabled by default
        sitemapUrl: options.sitemapUrl || undefined
      });

      // Legal warning
      if (!options.force && !crawler.respectRobots) {
        console.log(chalk.yellow('\n⚠️  WARNING: You are ignoring robots.txt'));
        console.log(chalk.yellow('Make sure you have explicit permission to crawl this site.\n'));
      }

      // Start crawling
      await crawler.crawl(startUrl);

    } catch (error) {
      console.error(chalk.red('\n❌ Crawl failed:'), error.message);
      logger.error('Crawl failed', error);
      process.exit(1);
    }
  });

/**
 * Serve command - Serve the mirrored site
 */
program
  .command('serve')
  .description('Serve the mirrored website locally')
  .option('--dir <directory>', 'Directory to serve', 'output')
  .option('--port <number>', 'Port to serve on', '8000')
  .action(async (options) => {
    try {
      const directory = path.resolve(options.dir);

      // Check if directory exists
      try {
        await fs.access(directory);
      } catch {
        console.error(chalk.red(`\n❌ Directory not found: ${directory}`));
        console.log(chalk.yellow('Please run the crawler first to create the mirror.\n'));
        process.exit(1);
      }

      const app = express();

      // Serve static files
      app.use(express.static(directory, {
        extensions: ['html'],
        index: ['index.html']
      }));

      // 404 handler
      app.use((req, res) => {
        res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>404 - Not Found</title>
            <style>
              body { font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
              h1 { color: #e74c3c; }
            </style>
          </head>
          <body>
            <h1>404 - Page Not Found</h1>
            <p>The page you requested was not found in the mirrored site.</p>
            <p><a href="/">Go to home page</a></p>
          </body>
          </html>
        `);
      });

      const port = parseInt(options.port, 10);

      app.listen(port, () => {
        console.log(chalk.bold.green('\n✓ Server started!\n'));
        console.log(chalk.cyan(`🌐 Serving directory: ${directory}`));
        console.log(chalk.cyan(`🔗 Open in browser: ${chalk.bold(`http://localhost:${port}`)}\n`));
        console.log(chalk.gray('Press Ctrl+C to stop the server.\n'));
      });

    } catch (error) {
      console.error(chalk.red('\n❌ Failed to start server:'), error.message);
      logger.error('Server error', error);
      process.exit(1);
    }
  });

/**
 * Status command - Check authentication and mirror status
 */
program
  .command('status')
  .description('Check authentication status and mirror summary')
  .option('--dir <directory>', 'Mirror directory', 'output')
  .action(async (options) => {
    try {
      console.log(chalk.bold.cyan('\n=== STATUS CHECK ===\n'));

      // Check authentication
      const authManager = new AuthManager();
      const hasCredentials = await authManager.hasCredentials();

      if (hasCredentials) {
        console.log(chalk.green('✓ Authentication:'), 'Credentials saved');

        // Validate session
        const validation = await authManager.validateSession();

        if (validation.valid) {
          console.log(chalk.green('✓ Session:'), 'Valid and active');
        } else {
          console.log(chalk.yellow('⚠️  Session:'), `Invalid - ${validation.reason}`);
          console.log(chalk.gray('  Run "node scrape.js auth" to re-authenticate'));
        }
      } else {
        console.log(chalk.yellow('⚠️  Authentication:'), 'No credentials found');
        console.log(chalk.gray('  Run "node scrape.js auth" to authenticate'));
      }

      console.log();

      // Check mirror status
      const directory = path.resolve(options.dir);

      try {
        await fs.access(directory);

        // Read crawl report if it exists
        const reportPath = path.join(directory, 'crawl-report.json');

        try {
          const reportContent = await fs.readFile(reportPath, 'utf8');
          const report = JSON.parse(reportContent);

          console.log(chalk.green('✓ Mirror:'), 'Found');
          console.log(chalk.cyan('  📁 Location:'), directory);
          console.log(chalk.cyan('  📄 Pages:'), report.stats.pagesDownloaded);
          console.log(chalk.cyan('  📦 Assets:'), report.stats.assetsDownloaded);
          console.log(chalk.cyan('  💾 Size:'), formatBytes(report.stats.bytesDownloaded));
          console.log(chalk.cyan('  📅 Last crawl:'), new Date(report.endTime).toLocaleString());

          if (report.errors && report.errors.length > 0) {
            console.log(chalk.yellow('  ⚠️  Errors:'), report.errors.length);
          }
        } catch {
          console.log(chalk.yellow('⚠️  Mirror:'), 'Directory exists but no crawl report found');
        }
      } catch {
        console.log(chalk.gray('ℹ️  Mirror:'), 'Not created yet');
        console.log(chalk.gray('  Run "node scrape.js crawl" to create a mirror'));
      }

      console.log();

    } catch (error) {
      console.error(chalk.red('\n❌ Status check failed:'), error.message);
      logger.error('Status check failed', error);
      process.exit(1);
    }
  });

/**
 * Clear command - Clear saved credentials
 */
program
  .command('clear')
  .description('Clear saved authentication credentials')
  .action(async () => {
    try {
      const authManager = new AuthManager();
      await authManager.clearCredentials();

      console.log(chalk.green('✓ Credentials cleared successfully.\n'));

    } catch (error) {
      console.error(chalk.red('\n❌ Failed to clear credentials:'), error.message);
      logger.error('Clear credentials failed', error);
      process.exit(1);
    }
  });

// Error handling
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error.code !== 'commander.help' && error.code !== 'commander.version') {
    console.error(chalk.red('\n❌ Error:'), error.message);
    process.exit(1);
  }
}

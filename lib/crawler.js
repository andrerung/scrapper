import { promises as fs } from 'fs';
import path from 'path';
import { URL } from 'url';
import chalk from 'chalk';
import * as cheerio from 'cheerio';
import PQueue from 'p-queue';
import mimeTypes from 'mime-types';
import robotsParser from 'robots-parser';
import {
  logger,
  ensureDir,
  normalizeUrl,
  isSameOrigin,
  urlToFilePath,
  getRelativePath,
  retryWithBackoff,
  delay,
  randomDelay,
  formatBytes,
  matchesPattern,
  saveJsonFile
} from './utils.js';

/**
 * WebsiteCrawler handles crawling, downloading assets, and rewriting links
 */
export class WebsiteCrawler {
  constructor(authManager, options = {}) {
    this.authManager = authManager;
    this.baseUrl = options.baseUrl || 'https://www.revisionvillage.com';
    this.outputDir = options.outputDir || 'output';
    this.maxPages = options.maxPages || 1000;
    this.concurrency = options.concurrency || 4;
    this.delayMin = options.delayMin || 800;
    this.delayMax = options.delayMax || 1500;
    this.respectRobots = options.respectRobots !== false;
    this.includePatterns = options.includePatterns || [];
    this.excludePatterns = options.excludePatterns || [];
    this.waitForSelector = options.waitForSelector;
    this.waitForTimeout = options.waitForTimeout || 30000;
    this.useSitemap = options.useSitemap !== false; // Enable by default
    this.sitemapUrl = options.sitemapUrl || new URL('/sitemap.xml', this.baseUrl).toString();

    // State
    this.visited = new Set();
    this.queue = [];
    this.assets = new Map();
    this.errors = [];
    this.robotsRules = null;

    // Stats
    this.stats = {
      pagesDownloaded: 0,
      assetsDownloaded: 0,
      bytesDownloaded: 0,
      errors: 0,
      startTime: null,
      endTime: null
    };
  }

  /**
   * Initialize the crawler
   */
  async initialize() {
    logger.info('Initializing crawler...');

    // Create output directory
    await ensureDir(this.outputDir);
    await ensureDir(path.join(this.outputDir, 'assets'));

    // Load robots.txt if respecting it
    if (this.respectRobots) {
      await this.loadRobotsTxt();
    }

    logger.info(`Output directory: ${this.outputDir}`);
    logger.info(`Max pages: ${this.maxPages}`);
    logger.info(`Concurrency: ${this.concurrency}`);
  }

  /**
   * Load and parse robots.txt
   */
  async loadRobotsTxt() {
    try {
      const robotsUrl = new URL('/robots.txt', this.baseUrl).toString();
      logger.info(`Fetching robots.txt from ${robotsUrl}`);

      const { browser, context, page } = await this.authManager.createAuthenticatedContext();

      try {
        const response = await page.goto(robotsUrl, { timeout: 10000 });
        if (response.ok()) {
          const robotsTxt = await page.content();
          this.robotsRules = robotsParser(robotsUrl, robotsTxt);
          logger.info('Loaded robots.txt rules');
        } else {
          logger.warn('robots.txt not found, proceeding without restrictions');
        }
      } finally {
        await browser.close();
      }
    } catch (error) {
      logger.warn('Could not load robots.txt:', error.message);
    }
  }

  /**
   * Load URLs from sitemap
   */
  async loadSitemapUrls() {
    try {
      console.log(chalk.cyan(`📑 Loading sitemap from ${this.sitemapUrl}...\n`));
      logger.info(`Fetching sitemap from ${this.sitemapUrl}`);

      const { browser, context, page } = await this.authManager.createAuthenticatedContext();

      try {
        const urls = await this.parseSitemapRecursive(page, this.sitemapUrl);

        console.log(chalk.green(`✓ Found ${urls.length} URLs in sitemap\n`));
        logger.info(`Loaded ${urls.length} URLs from sitemap`);

        return urls;
      } finally {
        await browser.close();
      }
    } catch (error) {
      logger.error('Could not load sitemap:', error);
      console.log(chalk.yellow(`⚠️  Failed to load sitemap: ${error.message}`));
      console.log(chalk.gray('Will fall back to crawling from start URL\n'));
      return [];
    }
  }

  /**
   * Parse sitemap recursively (handles sitemap indexes)
   * @param {Page} page - Playwright page
   * @param {string} sitemapUrl - URL of sitemap to parse
   * @returns {Promise<string[]>}
   */
  async parseSitemapRecursive(page, sitemapUrl) {
    try {
      const response = await page.goto(sitemapUrl, { timeout: 30000 });

      if (!response.ok()) {
        logger.warn(`Sitemap returned status ${response.status()}: ${sitemapUrl}`);
        return [];
      }

      const content = await page.content();
      const $ = cheerio.load(content, { xmlMode: true });

      // Check if this is a sitemap index (contains other sitemaps)
      const sitemapElements = $('sitemap > loc');

      if (sitemapElements.length > 0) {
        // This is a sitemap index - recursively load all sitemaps
        console.log(chalk.gray(`  Found sitemap index with ${sitemapElements.length} sitemaps`));
        logger.info(`Sitemap index contains ${sitemapElements.length} sitemaps`);

        const allUrls = [];

        for (let i = 0; i < sitemapElements.length; i++) {
          const nestedSitemapUrl = $(sitemapElements[i]).text().trim();
          console.log(chalk.gray(`  Loading nested sitemap ${i + 1}/${sitemapElements.length}...`));

          const urls = await this.parseSitemapRecursive(page, nestedSitemapUrl);
          allUrls.push(...urls);

          await delay(500); // Small delay between sitemap requests
        }

        return allUrls;
      }

      // This is a regular sitemap - extract URLs
      const urlElements = $('url > loc');
      const urls = [];

      urlElements.each((_, elem) => {
        const url = $(elem).text().trim();
        if (url && isSameOrigin(url, this.baseUrl)) {
          urls.push(url);
        }
      });

      logger.info(`Parsed ${urls.length} URLs from ${sitemapUrl}`);
      return urls;

    } catch (error) {
      logger.error(`Error parsing sitemap ${sitemapUrl}:`, error);
      return [];
    }
  }

  /**
   * Check if URL is allowed by robots.txt
   * @param {string} url
   * @returns {boolean}
   */
  isAllowedByRobots(url) {
    if (!this.respectRobots || !this.robotsRules) {
      return true;
    }

    const userAgent = 'Mozilla/5.0 (compatible; WebsiteScraper/1.0)';
    return this.robotsRules.isAllowed(url, userAgent);
  }

  /**
   * Check if URL should be crawled
   * @param {string} url
   * @returns {boolean}
   */
  shouldCrawl(url) {
    try {
      const normalized = normalizeUrl(url);

      // Already visited
      if (this.visited.has(normalized)) {
        return false;
      }

      // Not same origin
      if (!isSameOrigin(url, this.baseUrl)) {
        return false;
      }

      const parsed = new URL(url);
      const pathname = parsed.pathname;

      // Check include patterns
      if (this.includePatterns.length > 0) {
        if (!matchesPattern(pathname, this.includePatterns)) {
          return false;
        }
      }

      // Check exclude patterns
      if (this.excludePatterns.length > 0) {
        if (matchesPattern(pathname, this.excludePatterns)) {
          return false;
        }
      }

      // Check robots.txt
      if (!this.isAllowedByRobots(url)) {
        logger.warn(`Blocked by robots.txt: ${url}`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error(`Error checking if should crawl ${url}:`, error);
      return false;
    }
  }

  /**
   * Add URL to queue
   * @param {string} url
   */
  addToQueue(url) {
    const normalized = normalizeUrl(url);

    if (this.shouldCrawl(normalized)) {
      this.queue.push(normalized);
      this.visited.add(normalized);
    }
  }

  /**
   * Start crawling
   * @param {string} startUrl - Starting URL
   */
  async crawl(startUrl) {
    console.log(chalk.bold.cyan('\n=== STARTING CRAWL ===\n'));
    console.log(chalk.cyan(`🌐 Base URL: ${this.baseUrl}`));
    console.log(chalk.cyan(`📁 Output directory: ${this.outputDir}`));
    console.log(chalk.cyan(`📄 Max pages: ${this.maxPages}`));
    console.log(chalk.cyan(`⚡ Concurrency: ${this.concurrency}`));
    console.log(chalk.cyan(`📑 Use sitemap: ${this.useSitemap ? 'Yes' : 'No'}\n`));

    this.stats.startTime = Date.now();

    // Initialize
    await this.initialize();

    // Load URLs from sitemap if enabled
    if (this.useSitemap) {
      const sitemapUrls = await this.loadSitemapUrls();

      if (sitemapUrls.length > 0) {
        console.log(chalk.cyan(`➕ Adding ${sitemapUrls.length} URLs from sitemap to queue...\n`));

        // Add all sitemap URLs to queue
        sitemapUrls.forEach(url => this.addToQueue(url));

        console.log(chalk.green(`✓ Queue initialized with ${this.queue.length} URLs\n`));
      } else {
        console.log(chalk.yellow('⚠️  No URLs loaded from sitemap, using start URL\n'));
        this.addToQueue(startUrl);
      }
    } else {
      // Add start URL to queue
      this.addToQueue(startUrl);
    }

    // Create processing queue with concurrency limit
    const processingQueue = new PQueue({ concurrency: this.concurrency });

    // Create authenticated browser context
    const { browser, context } = await this.authManager.createAuthenticatedContext();

    try {
      // Process queue
      while (this.queue.length > 0 && this.stats.pagesDownloaded < this.maxPages) {
        const url = this.queue.shift();

        processingQueue.add(() => this.processPage(context, url));

        // Respect rate limiting
        const delayMs = randomDelay(this.delayMin, this.delayMax);
        await delay(delayMs);
      }

      // Wait for all tasks to complete
      await processingQueue.onIdle();

      console.log(chalk.cyan('\n📦 Downloading remaining assets...\n'));

      // Download all assets
      await this.downloadAllAssets(context);

    } finally {
      await browser.close();
    }

    this.stats.endTime = Date.now();

    // Save crawl report
    await this.saveCrawlReport();

    this.printSummary();
  }

  /**
   * Process a single page
   * @param {BrowserContext} context
   * @param {string} url
   */
  async processPage(context, url) {
    try {
      logger.info(`Processing: ${url}`);

      const page = await context.newPage();

      try {
        // Navigate with retry
        await retryWithBackoff(async () => {
          const response = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: this.waitForTimeout
          });

          if (!response.ok() && response.status() !== 304) {
            throw new Error(`HTTP ${response.status()}`);
          }
        });

        // Wait for specific selector if provided
        if (this.waitForSelector) {
          await page.waitForSelector(this.waitForSelector, {
            timeout: this.waitForTimeout
          }).catch(err => {
            logger.warn(`Selector ${this.waitForSelector} not found on ${url}`);
          });
        }

        // Scroll page to trigger lazy loading
        await this.scrollPageForLazyLoad(page);

        // Wait a bit for any lazy-loaded content to appear
        await delay(1000);

        // Get rendered HTML
        const html = await page.content();

        // Extract links and assets
        const { links, assets } = this.extractLinksAndAssets(html, url);

        // Add new links to queue
        links.forEach(link => this.addToQueue(link));

        // Track assets
        assets.forEach(asset => {
          if (!this.assets.has(asset.url)) {
            this.assets.set(asset.url, asset);
          }
        });

        // Rewrite HTML with local paths
        const rewrittenHtml = this.rewriteHtml(html, url);

        // Save page
        await this.savePage(url, rewrittenHtml);

        this.stats.pagesDownloaded++;

        console.log(chalk.green(`✓ [${this.stats.pagesDownloaded}/${this.maxPages}] ${url}`));

      } finally {
        await page.close();
      }

    } catch (error) {
      this.stats.errors++;
      this.errors.push({ url, error: error.message });
      logger.error(`Error processing ${url}:`, error);
      console.log(chalk.red(`✗ Failed: ${url} - ${error.message}`));
    }
  }

  /**
   * Scroll page to trigger lazy loading
   * @param {Page} page
   */
  async scrollPageForLazyLoad(page) {
    try {
      await page.evaluate(async () => {
        // Scroll to bottom gradually to trigger lazy loading
        const distance = 100; // pixels to scroll each step
        const delayMs = 100;  // delay between scrolls
        const maxScrolls = 50; // maximum number of scroll steps

        for (let i = 0; i < maxScrolls; i++) {
          window.scrollBy(0, distance);
          await new Promise(resolve => setTimeout(resolve, delayMs));

          // Check if we've reached the bottom
          if ((window.innerHeight + window.scrollY) >= document.body.scrollHeight) {
            break;
          }
        }

        // Scroll back to top
        window.scrollTo(0, 0);
      });

      logger.debug('Scrolled page for lazy loading');
    } catch (error) {
      logger.debug('Error scrolling page:', error.message);
    }
  }

  /**
   * Extract URLs from CSS content
   * @param {string} css
   * @param {string} baseUrl
   * @returns {string[]}
   */
  extractUrlsFromCss(css, baseUrl) {
    const urls = [];

    // Match url() in CSS - handles url("..."), url('...'), and url(...)
    const urlRegex = /url\(['"]?([^'")]+)['"]?\)/gi;
    let match;

    while ((match = urlRegex.exec(css)) !== null) {
      try {
        const url = match[1].trim();
        // Skip data URLs
        if (!url.startsWith('data:')) {
          const absolute = new URL(url, baseUrl).toString();
          urls.push(absolute);
        }
      } catch (error) {
        // Invalid URL, skip
      }
    }

    // Match @import statements
    const importRegex = /@import\s+['"]([^'"]+)['"]/gi;
    while ((match = importRegex.exec(css)) !== null) {
      try {
        const url = match[1].trim();
        const absolute = new URL(url, baseUrl).toString();
        urls.push(absolute);
      } catch (error) {
        // Invalid URL, skip
      }
    }

    return urls;
  }

  /**
   * Extract links and assets from HTML
   * @param {string} html
   * @param {string} pageUrl
   * @returns {Object}
   */
  extractLinksAndAssets(html, pageUrl) {
    const $ = cheerio.load(html);
    const links = new Set();
    const assets = [];

    // Extract page links from <a> tags
    $('a[href]').each((_, elem) => {
      try {
        const href = $(elem).attr('href');
        const absolute = new URL(href, pageUrl).toString();

        if (isSameOrigin(absolute, this.baseUrl)) {
          links.add(absolute);
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });

    // Extract links from form actions
    $('form[action]').each((_, elem) => {
      try {
        const action = $(elem).attr('action');
        if (action && action !== '#' && action !== '') {
          const absolute = new URL(action, pageUrl).toString();
          if (isSameOrigin(absolute, this.baseUrl)) {
            links.add(absolute);
          }
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });

    // Extract links from meta refresh
    $('meta[http-equiv="refresh"]').each((_, elem) => {
      try {
        const content = $(elem).attr('content');
        const urlMatch = content.match(/url=(.+)/i);
        if (urlMatch) {
          const url = urlMatch[1].trim();
          const absolute = new URL(url, pageUrl).toString();
          if (isSameOrigin(absolute, this.baseUrl)) {
            links.add(absolute);
          }
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });

    // Extract links from data attributes (common in SPAs)
    $('[data-href], [data-url], [data-link], [data-src]').each((_, elem) => {
      try {
        const dataHref = $(elem).attr('data-href') || $(elem).attr('data-url') ||
                        $(elem).attr('data-link') || $(elem).attr('data-src');
        if (dataHref) {
          const absolute = new URL(dataHref, pageUrl).toString();
          if (isSameOrigin(absolute, this.baseUrl)) {
            links.add(absolute);
          }
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });

    // Extract assets with comprehensive selectors
    const assetSelectors = [
      // Images
      { selector: 'img[src]', attr: 'src', type: 'image' },
      { selector: 'img[srcset]', attr: 'srcset', type: 'image' },
      { selector: 'img[data-src]', attr: 'data-src', type: 'image' },
      { selector: 'img[data-srcset]', attr: 'data-srcset', type: 'image' },

      // Picture elements
      { selector: 'source[srcset]', attr: 'srcset', type: 'image' },
      { selector: 'picture source[srcset]', attr: 'srcset', type: 'image' },

      // Stylesheets
      { selector: 'link[rel="stylesheet"][href]', attr: 'href', type: 'stylesheet' },
      { selector: 'link[rel="preload"][as="style"][href]', attr: 'href', type: 'stylesheet' },

      // Scripts
      { selector: 'script[src]', attr: 'src', type: 'script' },
      { selector: 'script[type="module"][src]', attr: 'src', type: 'script' },

      // Media
      { selector: 'source[src]', attr: 'src', type: 'media' },
      { selector: 'video[src]', attr: 'src', type: 'media' },
      { selector: 'video[poster]', attr: 'poster', type: 'image' },
      { selector: 'audio[src]', attr: 'src', type: 'media' },
      { selector: 'track[src]', attr: 'src', type: 'media' },

      // Icons and favicons
      { selector: 'link[rel="icon"][href]', attr: 'href', type: 'icon' },
      { selector: 'link[rel="apple-touch-icon"][href]', attr: 'href', type: 'icon' },
      { selector: 'link[rel="apple-touch-icon-precomposed"][href]', attr: 'href', type: 'icon' },
      { selector: 'link[rel="shortcut icon"][href]', attr: 'href', type: 'icon' },

      // Fonts
      { selector: 'link[rel="preload"][as="font"][href]', attr: 'href', type: 'font' },

      // Iframes
      { selector: 'iframe[src]', attr: 'src', type: 'iframe' },

      // Objects and embeds
      { selector: 'object[data]', attr: 'data', type: 'object' },
      { selector: 'embed[src]', attr: 'src', type: 'embed' },

      // Manifest
      { selector: 'link[rel="manifest"][href]', attr: 'href', type: 'manifest' }
    ];

    assetSelectors.forEach(({ selector, attr, type }) => {
      $(selector).each((_, elem) => {
        try {
          const value = $(elem).attr(attr);
          if (!value) return;

          if (attr === 'srcset' || attr === 'data-srcset') {
            // Parse srcset
            const srcsetUrls = value.split(',').map(s => s.trim().split(/\s+/)[0]);
            srcsetUrls.forEach(src => {
              if (!src.startsWith('data:')) {
                const absolute = new URL(src, pageUrl).toString();
                assets.push({ url: absolute, type, pageUrl });
              }
            });
          } else {
            if (!value.startsWith('data:') && !value.startsWith('javascript:') && !value.startsWith('#')) {
              const absolute = new URL(value, pageUrl).toString();
              assets.push({ url: absolute, type, pageUrl });
            }
          }
        } catch (error) {
          // Invalid URL, skip
        }
      });
    });

    // Extract inline style background images
    $('[style]').each((_, elem) => {
      try {
        const style = $(elem).attr('style');
        const urls = this.extractUrlsFromCss(style, pageUrl);
        urls.forEach(url => {
          assets.push({ url, type: 'image', pageUrl });
        });
      } catch (error) {
        // Invalid style, skip
      }
    });

    // Extract URLs from <style> tags
    $('style').each((_, elem) => {
      try {
        const css = $(elem).html();
        const urls = this.extractUrlsFromCss(css, pageUrl);
        urls.forEach(url => {
          assets.push({ url, type: 'stylesheet-resource', pageUrl });
        });
      } catch (error) {
        // Invalid CSS, skip
      }
    });

    return {
      links: Array.from(links),
      assets
    };
  }

  /**
   * Rewrite HTML with local asset paths
   * @param {string} html
   * @param {string} pageUrl
   * @returns {string}
   */
  rewriteHtml(html, pageUrl) {
    const $ = cheerio.load(html);

    const pageFilePath = urlToFilePath(pageUrl, this.baseUrl);

    // Rewrite links
    $('a[href]').each((_, elem) => {
      try {
        const href = $(elem).attr('href');
        const absolute = new URL(href, pageUrl).toString();

        if (isSameOrigin(absolute, this.baseUrl)) {
          const targetFilePath = urlToFilePath(absolute, this.baseUrl);
          const relativePath = getRelativePath(pageFilePath, targetFilePath);
          $(elem).attr('href', relativePath);
        }
      } catch (error) {
        // Keep original if invalid
      }
    });

    // Rewrite assets
    const rewriteAsset = (selector, attr) => {
      $(selector).each((_, elem) => {
        try {
          const value = $(elem).attr(attr);
          if (!value || value.startsWith('data:') || value.startsWith('javascript:') || value.startsWith('#')) {
            return;
          }
          const absolute = new URL(value, pageUrl).toString();
          const assetPath = this.getAssetPath(absolute);
          const relativePath = getRelativePath(pageFilePath, assetPath);
          $(elem).attr(attr, relativePath);
        } catch (error) {
          // Keep original if invalid
        }
      });
    };

    // Images
    rewriteAsset('img[src]', 'src');
    rewriteAsset('img[data-src]', 'data-src');
    rewriteAsset('video[poster]', 'poster');

    // Stylesheets and scripts
    rewriteAsset('link[rel="stylesheet"][href]', 'href');
    rewriteAsset('link[rel="preload"][as="style"][href]', 'href');
    rewriteAsset('script[src]', 'src');
    rewriteAsset('script[type="module"][src]', 'src');

    // Media
    rewriteAsset('source[src]', 'src');
    rewriteAsset('video[src]', 'src');
    rewriteAsset('audio[src]', 'src');
    rewriteAsset('track[src]', 'src');

    // Icons
    rewriteAsset('link[rel="icon"][href]', 'href');
    rewriteAsset('link[rel="apple-touch-icon"][href]', 'href');
    rewriteAsset('link[rel="apple-touch-icon-precomposed"][href]', 'href');
    rewriteAsset('link[rel="shortcut icon"][href]', 'href');

    // Fonts
    rewriteAsset('link[rel="preload"][as="font"][href]', 'href');

    // Iframes and embeds
    rewriteAsset('iframe[src]', 'src');
    rewriteAsset('object[data]', 'data');
    rewriteAsset('embed[src]', 'src');

    // Manifest
    rewriteAsset('link[rel="manifest"][href]', 'href');

    // Rewrite srcset and data-srcset
    const rewriteSrcset = (selector, attr) => {
      $(selector).each((_, elem) => {
        try {
          const srcset = $(elem).attr(attr);
          if (!srcset) return;

          const rewritten = srcset.split(',').map(s => {
            const parts = s.trim().split(/\s+/);
            const src = parts[0];
            const descriptor = parts[1] || '';

            if (src.startsWith('data:')) {
              return s;
            }

            try {
              const absolute = new URL(src, pageUrl).toString();
              const assetPath = this.getAssetPath(absolute);
              const relativePath = getRelativePath(pageFilePath, assetPath);
              return descriptor ? `${relativePath} ${descriptor}` : relativePath;
            } catch {
              return s;
            }
          }).join(', ');

          $(elem).attr(attr, rewritten);
        } catch (error) {
          // Keep original if invalid
        }
      });
    };

    rewriteSrcset('img[srcset]', 'srcset');
    rewriteSrcset('img[data-srcset]', 'data-srcset');
    rewriteSrcset('source[srcset]', 'srcset');
    rewriteSrcset('picture source[srcset]', 'srcset');

    // Rewrite inline styles
    $('[style]').each((_, elem) => {
      try {
        const style = $(elem).attr('style');
        const rewritten = this.rewriteCssUrls(style, pageUrl, pageFilePath);
        $(elem).attr('style', rewritten);
      } catch (error) {
        // Keep original if invalid
      }
    });

    // Rewrite <style> tags
    $('style').each((_, elem) => {
      try {
        const css = $(elem).html();
        const rewritten = this.rewriteCssUrls(css, pageUrl, pageFilePath);
        $(elem).html(rewritten);
      } catch (error) {
        // Keep original if invalid
      }
    });

    return $.html();
  }

  /**
   * Rewrite URLs in CSS content
   * @param {string} css
   * @param {string} pageUrl
   * @param {string} pageFilePath
   * @returns {string}
   */
  rewriteCssUrls(css, pageUrl, pageFilePath) {
    // Rewrite url() references
    return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (match, url) => {
      try {
        const trimmed = url.trim();
        if (trimmed.startsWith('data:') || trimmed.startsWith('#')) {
          return match;
        }

        const absolute = new URL(trimmed, pageUrl).toString();
        const assetPath = this.getAssetPath(absolute);
        const relativePath = getRelativePath(pageFilePath, assetPath);

        return `url("${relativePath}")`;
      } catch {
        return match;
      }
    });
  }

  /**
   * Get local path for an asset URL
   * @param {string} url
   * @returns {string}
   */
  getAssetPath(url) {
    try {
      const parsed = new URL(url);
      const ext = path.extname(parsed.pathname) || '.bin';

      // Create a safe filename from the URL
      const hash = Buffer.from(url).toString('base64')
        .replace(/[^a-zA-Z0-9]/g, '')
        .substring(0, 32);

      const filename = `${hash}${ext}`;

      return path.join('assets', filename);
    } catch (error) {
      logger.error(`Error getting asset path for ${url}:`, error);
      return path.join('assets', 'error.bin');
    }
  }

  /**
   * Download all collected assets
   * @param {BrowserContext} context
   */
  async downloadAllAssets(context) {
    const assets = Array.from(this.assets.values());
    const total = assets.length;

    console.log(chalk.cyan(`📦 Downloading ${total} assets...\n`));

    const queue = new PQueue({ concurrency: this.concurrency * 2 });

    let completed = 0;

    const downloadPromises = assets.map(asset =>
      queue.add(async () => {
        await this.downloadAsset(context, asset);
        completed++;

        if (completed % 10 === 0 || completed === total) {
          console.log(chalk.gray(`   Downloaded ${completed}/${total} assets`));
        }
      })
    );

    await Promise.all(downloadPromises);

    console.log(chalk.green(`\n✓ Downloaded ${total} assets\n`));
  }

  /**
   * Download a single asset
   * @param {BrowserContext} context
   * @param {Object} asset
   */
  async downloadAsset(context, asset) {
    try {
      const assetPath = this.getAssetPath(asset.url);
      const fullPath = path.join(this.outputDir, assetPath);

      // Create directory if needed
      await ensureDir(path.dirname(fullPath));

      // Download with retry
      await retryWithBackoff(async () => {
        const page = await context.newPage();

        try {
          const response = await page.goto(asset.url, {
            timeout: 30000,
            waitUntil: 'domcontentloaded'
          });

          if (response.ok()) {
            const buffer = await response.body();
            this.stats.assetsDownloaded++;
            this.stats.bytesDownloaded += buffer.length;

            // Handle CSS files specially
            if (asset.type === 'stylesheet' && asset.url.match(/\.css($|\?)/)) {
              const cssContent = buffer.toString('utf8');

              // Parse CSS for additional assets
              await this.parseCssFile(cssContent, asset.url);

              // Rewrite CSS URLs to point to local assets
              const rewrittenCss = this.rewriteCssUrls(cssContent, asset.url, assetPath);
              await fs.writeFile(fullPath, rewrittenCss, 'utf8');

              logger.debug(`Downloaded and rewrote CSS: ${asset.url} -> ${assetPath}`);
            } else {
              // Save binary assets as-is
              await fs.writeFile(fullPath, buffer);
              logger.debug(`Downloaded asset: ${asset.url} -> ${assetPath}`);
            }
          } else {
            throw new Error(`HTTP ${response.status()}`);
          }
        } finally {
          await page.close();
        }
      }, 2, 1000);

    } catch (error) {
      logger.error(`Failed to download asset ${asset.url}:`, error.message);
      this.errors.push({ url: asset.url, error: error.message, type: 'asset' });
    }
  }

  /**
   * Parse CSS file and extract additional assets
   * @param {string} cssContent
   * @param {string} cssUrl
   */
  async parseCssFile(cssContent, cssUrl) {
    try {
      const urls = this.extractUrlsFromCss(cssContent, cssUrl);

      urls.forEach(url => {
        if (!this.assets.has(url)) {
          // Determine asset type based on extension
          let type = 'stylesheet-resource';
          if (url.match(/\.(woff2?|ttf|eot|otf)($|\?)/i)) {
            type = 'font';
          } else if (url.match(/\.(png|jpe?g|gif|svg|webp|avif|ico)($|\?)/i)) {
            type = 'image';
          } else if (url.match(/\.css($|\?)/i)) {
            type = 'stylesheet';
          }

          this.assets.set(url, { url, type, pageUrl: cssUrl });
          logger.debug(`Found asset in CSS: ${url}`);
        }
      });
    } catch (error) {
      logger.error(`Error parsing CSS file ${cssUrl}:`, error);
    }
  }

  /**
   * Save a page to disk
   * @param {string} url
   * @param {string} html
   */
  async savePage(url, html) {
    const filePath = urlToFilePath(url, this.baseUrl);
    const fullPath = path.join(this.outputDir, filePath);

    await ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, html, 'utf8');

    logger.debug(`Saved page: ${url} -> ${filePath}`);
  }

  /**
   * Save crawl report
   */
  async saveCrawlReport() {
    const report = {
      baseUrl: this.baseUrl,
      startTime: new Date(this.stats.startTime).toISOString(),
      endTime: new Date(this.stats.endTime).toISOString(),
      duration: this.stats.endTime - this.stats.startTime,
      stats: this.stats,
      errors: this.errors,
      pages: Array.from(this.visited)
    };

    await saveJsonFile(path.join(this.outputDir, 'crawl-report.json'), report);

    // Also save errors separately if any
    if (this.errors.length > 0) {
      await saveJsonFile(path.join(this.outputDir, 'errors.json'), this.errors);
    }

    logger.info('Saved crawl report');
  }

  /**
   * Print crawl summary
   */
  printSummary() {
    const duration = this.stats.endTime - this.stats.startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = ((duration % 60000) / 1000).toFixed(0);

    console.log(chalk.bold.cyan('\n=== CRAWL COMPLETE ===\n'));
    console.log(chalk.cyan(`⏱️  Duration: ${minutes}m ${seconds}s`));
    console.log(chalk.cyan(`📄 Pages downloaded: ${this.stats.pagesDownloaded}`));
    console.log(chalk.cyan(`📦 Assets downloaded: ${this.stats.assetsDownloaded}`));
    console.log(chalk.cyan(`💾 Total size: ${formatBytes(this.stats.bytesDownloaded)}`));
    console.log(chalk.cyan(`❌ Errors: ${this.stats.errors}`));
    console.log(chalk.cyan(`📁 Output directory: ${path.resolve(this.outputDir)}\n`));

    if (this.errors.length > 0) {
      console.log(chalk.yellow(`⚠️  There were ${this.errors.length} errors. Check errors.json for details.\n`));
    }

    console.log(chalk.green('✓ Mirror saved successfully!'));
    console.log(chalk.gray('  Run "node scrape.js serve" to preview the mirrored site.\n'));
  }
}

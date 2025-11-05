import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { logger, saveJsonFile, loadJsonFile, delay, promptConfirmation, ensureDir } from './utils.js';

const COOKIES_FILE = 'cookies.json';
const STORAGE_FILE = 'storage.json';
const TARGET_SITE = 'https://www.revisionvillage.com';

/**
 * AuthManager handles authentication flow and session management
 * IMPORTANT: This module DOES NOT automate Google login.
 * It launches a headful browser for MANUAL user login, then saves the session.
 */
export class AuthManager {
  constructor(options = {}) {
    this.targetSite = options.targetSite || TARGET_SITE;
    this.cookiesPath = options.cookiesPath || COOKIES_FILE;
    this.storagePath = options.storagePath || STORAGE_FILE;
    this.headless = false; // Always headful for manual login
  }

  /**
   * Perform manual authentication flow
   * Launches a headful browser and waits for the user to complete Google sign-in manually
   */
  async authenticate() {
    console.log(chalk.bold.cyan('\n=== AUTHENTICATION REQUIRED ===\n'));

    // Legal and ethical confirmation
    console.log(chalk.yellow('⚠️  IMPORTANT LEGAL NOTICE:'));
    console.log(chalk.yellow('This tool will copy content from the website.'));
    console.log(chalk.yellow('You MUST have explicit permission to copy and store this content.'));
    console.log(chalk.yellow('By proceeding, you confirm that:'));
    console.log(chalk.yellow('  1. You own the account or have authorization to use it'));
    console.log(chalk.yellow('  2. You have permission to copy the site content'));
    console.log(chalk.yellow('  3. You will comply with the site\'s Terms of Service'));
    console.log(chalk.yellow('  4. You will not use this tool for unauthorized purposes\n'));

    const confirmed = await promptConfirmation(
      chalk.bold('Do you confirm you have explicit permission to copy this site?')
    );

    if (!confirmed) {
      console.log(chalk.red('\n❌ Permission not confirmed. Exiting.'));
      console.log(chalk.gray('You must have explicit permission before using this tool.\n'));
      process.exit(1);
    }

    console.log(chalk.green('✓ Permission confirmed.\n'));

    console.log(chalk.cyan('📝 Authentication Instructions:'));
    console.log('  1. A browser window will open shortly');
    console.log('  2. Complete the Google sign-in process manually');
    console.log('  3. Complete any 2FA or verification steps if prompted');
    console.log('  4. Wait until you see your authenticated dashboard');
    console.log('  5. Return to this terminal and press Enter\n');

    logger.info('Launching headful browser for manual authentication...');

    // Use a persistent user data directory to create a real browser profile
    // This makes Google see it as a legitimate browser with history and profile
    const userDataDir = path.join(process.cwd(), '.browser-profile');
    await ensureDir(userDataDir);

    console.log(chalk.gray(`Using browser profile directory: ${userDataDir}\n`));

    // Launch with persistent context - this is the key to bypassing Google's detection
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // MUST be headful for manual login
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-automation',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--start-maximized'
      ],
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const page = await context.newPage();

    // Hide webdriver property to avoid Google bot detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      // Add chrome property if missing
      window.chrome = {
        runtime: {},
      };

      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    try {
      // Navigate to the login page
      console.log(chalk.cyan(`\n🌐 Navigating to ${this.targetSite}...\n`));
      await page.goto(this.targetSite, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for user to complete login
      console.log(chalk.bold.yellow('⏳ Please complete the login process in the browser window...'));
      console.log(chalk.gray('   (The browser window should be visible on your screen)\n'));

      await promptConfirmation(chalk.bold('Press Enter after you have successfully logged in'));

      // Verify authentication by checking if we're still on a login page
      console.log(chalk.cyan('\n🔍 Verifying authentication...'));

      const currentUrl = page.url();
      logger.info(`Current URL after login: ${currentUrl}`);

      // Check if user is authenticated (basic check)
      const isAuthenticated = await this.checkAuthentication(page);

      if (!isAuthenticated) {
        console.log(chalk.red('\n❌ Authentication verification failed.'));
        console.log(chalk.yellow('The page does not appear to show an authenticated session.'));
        console.log(chalk.yellow('Please ensure you completed the login process successfully.\n'));

        const retry = await promptConfirmation('Do you want to try again?');
        if (retry) {
          console.log(chalk.cyan('Please complete the login and press Enter...'));
          await promptConfirmation('Press Enter after login');

          const secondCheck = await this.checkAuthentication(page);
          if (!secondCheck) {
            throw new Error('Authentication verification failed after retry');
          }
        } else {
          throw new Error('Authentication not completed');
        }
      }

      console.log(chalk.green('✓ Authentication successful!\n'));

      // Save cookies
      console.log(chalk.cyan('💾 Saving session cookies...'));
      const cookies = await context.cookies();
      await saveJsonFile(this.cookiesPath, cookies);
      console.log(chalk.green(`✓ Cookies saved to ${this.cookiesPath}`));
      console.log(chalk.yellow(`⚠️  Keep this file secure! It contains your authentication session.\n`));

      // Save localStorage and sessionStorage
      console.log(chalk.cyan('💾 Saving browser storage...'));
      const storage = await page.evaluate(() => {
        return {
          localStorage: Object.entries(localStorage),
          sessionStorage: Object.entries(sessionStorage)
        };
      });
      await saveJsonFile(this.storagePath, storage);
      console.log(chalk.green(`✓ Storage saved to ${this.storagePath}\n`));

      logger.info('Authentication completed successfully');

    } catch (error) {
      logger.error('Authentication failed', error);
      throw error;
    } finally {
      await context.close();
    }

    console.log(chalk.bold.green('✓ Authentication complete! You can now run the crawler.\n'));
  }

  /**
   * Check if the current page shows an authenticated session
   * @param {Page} page - Playwright page object
   * @returns {Promise<boolean>}
   */
  async checkAuthentication(page) {
    try {
      // Wait a moment for any redirects
      await delay(2000);

      const url = page.url();
      const content = await page.content();

      // Check if we're NOT on a login/signin page
      const loginIndicators = [
        '/login',
        '/signin',
        '/authenticate',
        'accounts.google.com',
        'Sign in',
        'Log in'
      ];

      const isOnLoginPage = loginIndicators.some(indicator =>
        url.toLowerCase().includes(indicator.toLowerCase()) ||
        content.includes(indicator)
      );

      if (isOnLoginPage) {
        return false;
      }

      // Look for common authenticated indicators
      const authIndicators = [
        'logout',
        'sign out',
        'dashboard',
        'profile',
        'account'
      ];

      const hasAuthIndicator = authIndicators.some(indicator =>
        content.toLowerCase().includes(indicator.toLowerCase())
      );

      return hasAuthIndicator;

    } catch (error) {
      logger.error('Error checking authentication', error);
      return false;
    }
  }

  /**
   * Load saved cookies
   * @returns {Promise<Array>}
   */
  async loadCookies() {
    const cookies = await loadJsonFile(this.cookiesPath);
    if (!cookies) {
      throw new Error(`No saved cookies found at ${this.cookiesPath}. Please run 'auth' command first.`);
    }
    return cookies;
  }

  /**
   * Load saved storage
   * @returns {Promise<Object>}
   */
  async loadStorage() {
    return await loadJsonFile(this.storagePath) || { localStorage: [], sessionStorage: [] };
  }

  /**
   * Check if saved cookies are still valid
   * @returns {Promise<Object>} - { valid: boolean, reason: string }
   */
  async validateSession() {
    try {
      console.log(chalk.cyan('🔍 Validating saved session...\n'));

      const cookies = await this.loadCookies();

      // Check if cookies are expired
      const now = Date.now() / 1000;
      const hasExpiredCookies = cookies.some(cookie =>
        cookie.expires && cookie.expires > 0 && cookie.expires < now
      );

      if (hasExpiredCookies) {
        return {
          valid: false,
          reason: 'Some cookies have expired'
        };
      }

      // Test cookies by making a request
      logger.info('Testing cookies with a real request...');

      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();

      await context.addCookies(cookies);

      // Apply stored localStorage/sessionStorage if available
      const storage = await this.loadStorage();

      const page = await context.newPage();

      // Apply storage before navigation
      if (storage.localStorage.length > 0 || storage.sessionStorage.length > 0) {
        await page.addInitScript((storage) => {
          storage.localStorage.forEach(([key, value]) => {
            localStorage.setItem(key, value);
          });
          storage.sessionStorage.forEach(([key, value]) => {
            sessionStorage.setItem(key, value);
          });
        }, storage);
      }

      try {
        await page.goto(this.targetSite, { waitUntil: 'networkidle', timeout: 30000 });

        const isAuthenticated = await this.checkAuthentication(page);

        await browser.close();

        if (isAuthenticated) {
          console.log(chalk.green('✓ Session is valid!\n'));
          return { valid: true, reason: 'Session is active' };
        } else {
          return {
            valid: false,
            reason: 'Session appears to be logged out'
          };
        }

      } catch (error) {
        await browser.close();
        throw error;
      }

    } catch (error) {
      logger.error('Error validating session', error);
      return {
        valid: false,
        reason: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * Create an authenticated browser context
   * @returns {Promise<{browser, context, page}>}
   */
  async createAuthenticatedContext(options = {}) {
    const cookies = await this.loadCookies();
    const storage = await this.loadStorage();

    const browser = await chromium.launch({
      headless: options.headless !== undefined ? options.headless : true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-automation',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      },
      ...options.contextOptions
    });

    await context.addCookies(cookies);

    // Create a page with storage
    const page = await context.newPage();

    // Hide webdriver detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    // Inject storage before any navigation
    if (storage.localStorage.length > 0 || storage.sessionStorage.length > 0) {
      await page.addInitScript((storage) => {
        storage.localStorage.forEach(([key, value]) => {
          localStorage.setItem(key, value);
        });
        storage.sessionStorage.forEach(([key, value]) => {
          sessionStorage.setItem(key, value);
        });
      }, storage);
    }

    return { browser, context, page };
  }

  /**
   * Clear saved authentication data
   */
  async clearCredentials() {
    console.log(chalk.cyan('🗑️  Clearing saved credentials...\n'));

    try {
      await fs.unlink(this.cookiesPath);
      console.log(chalk.green(`✓ Deleted ${this.cookiesPath}`));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Error deleting ${this.cookiesPath}`, error);
      }
    }

    try {
      await fs.unlink(this.storagePath);
      console.log(chalk.green(`✓ Deleted ${this.storagePath}`));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`Error deleting ${this.storagePath}`, error);
      }
    }

    console.log(chalk.green('\n✓ Credentials cleared successfully.\n'));
  }

  /**
   * Check if authentication files exist
   * @returns {Promise<boolean>}
   */
  async hasCredentials() {
    try {
      await fs.access(this.cookiesPath);
      return true;
    } catch {
      return false;
    }
  }
}

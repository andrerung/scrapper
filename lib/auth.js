import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { logger, saveJsonFile, loadJsonFile, delay, promptConfirmation, promptInput, ensureDir } from './utils.js';

const COOKIES_FILE = 'cookies.json';
const STORAGE_FILE = 'storage.json';
const TARGET_SITE = 'https://www.revisionvillage.com';

/**
 * AuthManager handles authentication flow and session management
 * Uses email/password authentication to log into Revision Village
 */
export class AuthManager {
  constructor(options = {}) {
    this.targetSite = options.targetSite || TARGET_SITE;
    this.cookiesPath = options.cookiesPath || COOKIES_FILE;
    this.storagePath = options.storagePath || STORAGE_FILE;
    this.headless = false;
  }

  /**
   * Perform authentication flow with email and password
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

    // Prompt for credentials
    console.log(chalk.cyan('📝 Please enter your Revision Village credentials:\n'));
    const email = await promptInput(chalk.bold('Email: '));
    const password = await promptInput(chalk.bold('Password: '), true);

    console.log(chalk.gray('\n🔒 Your credentials will not be stored, only session cookies.\n'));

    logger.info('Launching browser for authentication...');

    // Use a persistent user data directory
    const userDataDir = path.join(process.cwd(), '.browser-profile');
    await ensureDir(userDataDir);

    // Launch with persistent context
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // Visible so you can see what's happening
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-automation',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking'
      ],
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const page = await context.newPage();

    // Hide webdriver property
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

    try {
      // Navigate to the login page
      console.log(chalk.cyan(`🌐 Navigating to ${this.targetSite}...\n`));
      await page.goto(this.targetSite, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await delay(2000);

      // Try to find and click login link
      console.log(chalk.cyan('🔍 Looking for login button...\n'));

      try {
        // Wait for login button and click it
        await page.waitForSelector('a:has-text("Log in"), button:has-text("Log in"), a:has-text("Sign in")', { timeout: 5000 });
        await page.click('a:has-text("Log in"), button:has-text("Log in"), a:has-text("Sign in")');
        await delay(2000);
      } catch (e) {
        console.log(chalk.gray('Already on login page or login button not found, continuing...\n'));
      }

      // Fill in email
      console.log(chalk.cyan('📧 Entering email...\n'));
      await page.fill('input[type="email"], input[name="email"], input[name="username"]', email);
      await delay(500);

      // Fill in password
      console.log(chalk.cyan('🔑 Entering password...\n'));
      await page.fill('input[type="password"]', password);
      await delay(500);

      // Submit the form
      console.log(chalk.cyan('🚀 Submitting login form...\n'));

      // Click submit button or press Enter
      try {
        await page.click('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
      } catch (e) {
        // Fallback to pressing Enter
        await page.keyboard.press('Enter');
      }

      // Wait for navigation
      console.log(chalk.cyan('⏳ Waiting for authentication to complete...\n'));
      await delay(5000);

      // Check if we're authenticated
      const isAuthenticated = await this.checkAuthentication(page);

      if (!isAuthenticated) {
        console.log(chalk.yellow('\n⚠️  Authentication verification unclear.'));
        console.log(chalk.yellow('Please check the browser window.\n'));

        await promptConfirmation(chalk.bold('Press Enter if you see your dashboard and are logged in'));

        const secondCheck = await this.checkAuthentication(page);
        if (!secondCheck) {
          console.log(chalk.red('\n❌ Still cannot verify authentication.'));
          console.log(chalk.yellow('Possible reasons:'));
          console.log(chalk.yellow('  - Incorrect email or password'));
          console.log(chalk.yellow('  - 2FA/verification required (complete it in the browser)'));
          console.log(chalk.yellow('  - Login page structure changed\n'));

          const proceed = await promptConfirmation('Do you want to save the session anyway?');
          if (!proceed) {
            throw new Error('Authentication not completed');
          }
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
      console.error(chalk.red('\n❌ Error during authentication:'), error.message);
      console.log(chalk.yellow('\nTroubleshooting:'));
      console.log(chalk.yellow('  1. Check your email and password are correct'));
      console.log(chalk.yellow('  2. Make sure you have access to the website'));
      console.log(chalk.yellow('  3. Complete any 2FA in the browser window'));
      console.log(chalk.yellow('  4. Check if the website login page has changed\n'));
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
      await delay(1000);

      const url = page.url();
      const content = await page.content();

      // Check if we're NOT on a login/signin page
      const loginIndicators = [
        '/login',
        '/signin',
        '/authenticate',
        'Sign in',
        'Log in'
      ];

      const isOnLoginPage = loginIndicators.some(indicator =>
        url.toLowerCase().includes(indicator.toLowerCase())
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
        'account',
        'my account'
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

      const { browser, context, page } = await this.createAuthenticatedContext({ headless: true });

      try {
        await page.goto(this.targetSite, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const isAuthenticated = await this.checkAuthentication(page);

        if (isAuthenticated) {
          console.log(chalk.green('✓ Session is valid!\n'));
          return { valid: true, reason: 'Session is active' };
        } else {
          return {
            valid: false,
            reason: 'Session appears to be logged out'
          };
        }

      } finally {
        await browser.close();
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

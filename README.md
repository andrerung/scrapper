# Revision Village Website Scraper

A production-ready Node.js application for creating offline mirrors of authenticated websites. Specifically designed for sites using Google OAuth authentication.

## ⚠️ IMPORTANT LEGAL NOTICE

**READ THIS CAREFULLY BEFORE USING THIS TOOL**

This software is provided for **authorized use only**. Before using this tool, you MUST:

1. ✅ **Have explicit permission** from the website owner to copy and store content
2. ✅ **Own the account** or have authorization to use it for this purpose
3. ✅ **Comply with the site's Terms of Service** and respect intellectual property rights
4. ✅ **Respect robots.txt** unless you have explicit permission to override it
5. ✅ **Use responsibly** - do not overload servers or cause service disruption

### What This Tool Does NOT Do

- ❌ Does NOT automate Google credential entry
- ❌ Does NOT bypass or circumvent any security measures
- ❌ Does NOT solve CAPTCHAs or other verification challenges
- ❌ Does NOT attempt to hack or exploit any vulnerabilities

### What This Tool DOES

- ✅ Requires **manual login** in a visible browser window
- ✅ Saves session cookies after you log in manually
- ✅ Respects rate limiting and robots.txt (by default)
- ✅ Creates a proper offline mirror with rewritten links

**By using this tool, you confirm that you have the necessary permissions and will use it ethically and legally.**

## 🎯 Features

- **Manual Authentication Flow**: Opens a headful browser for you to complete Google sign-in manually
- **Session Management**: Saves and reuses authentication cookies across crawl sessions
- **Session Validation**: Checks if saved cookies are still valid
- **Smart Crawling**: Respects robots.txt, rate limiting, and same-origin policy
- **Asset Download**: Downloads images, CSS, JavaScript, fonts, and videos
- **Link Rewriting**: Rewrites all links to work offline
- **Concurrent Processing**: Configurable parallel page rendering
- **Error Handling**: Retry logic with exponential backoff
- **Progress Reporting**: Real-time crawl progress and statistics
- **Static Server**: Built-in server to preview the mirrored site
- **Comprehensive Logging**: Detailed logs for debugging

## 📋 Requirements

- **Node.js** >= 18.0.0 (LTS recommended)
- **Operating System**: Windows, macOS, or Linux with display capability
- **Browser**: Chromium (automatically installed by Playwright)
- **Valid account** on the target website with permission to access content

## 🚀 Installation

### 1. Clone or download this repository

```bash
git clone <repository-url>
cd scrapper
```

### 2. Install dependencies

```bash
npm install
```

This will install:
- Playwright (for browser automation)
- Commander (for CLI)
- Chalk (for colored output)
- Winston (for logging)
- Express (for static server)
- And other required dependencies

### 3. Install Playwright browsers

```bash
npx playwright install chromium
```

## 📖 Usage

### Step 1: Authenticate (Manual Google Login)

Before crawling, you need to authenticate with the website:

```bash
node scrape.js auth
```

**What happens:**
1. The tool displays a legal notice and asks for confirmation
2. A browser window opens (this is intentional - not a bug!)
3. You manually complete the Google sign-in process
4. Complete any 2FA or verification steps
5. Press Enter in the terminal when done
6. The tool saves your session cookies

**Important Notes:**
- The browser window MUST be visible (not headless) for manual login
- Take your time - there's no rush
- Complete all verification steps as you normally would
- Do not close the browser until the process completes

### Step 2: Crawl the Website

After authenticating, start crawling:

```bash
node scrape.js crawl
```

**With options:**

```bash
node scrape.js crawl \
  --start / \
  --max-pages 1000 \
  --concurrency 4 \
  --delay 1000 \
  --output output
```

**Available options:**
- `--start <url>` - Starting URL path (default: `/`)
- `--base-url <url>` - Base URL of the site (default: `https://www.revisionvillage.com`)
- `--output <dir>` - Output directory (default: `output`)
- `--max-pages <n>` - Maximum pages to crawl (default: `1000`)
- `--concurrency <n>` - Parallel page renders (default: `4`)
- `--delay <ms>` - Delay between requests (default: `1000`)
- `--include <patterns>` - Include only matching URLs (comma-separated glob patterns)
- `--exclude <patterns>` - Exclude matching URLs (comma-separated glob patterns)
- `--wait-for <selector>` - Wait for CSS selector before saving
- `--no-respect-robots` - Ignore robots.txt (use with explicit permission)

**Examples:**

Crawl specific sections only:
```bash
node scrape.js crawl --include "/courses/*,/lessons/*" --max-pages 500
```

Exclude certain paths:
```bash
node scrape.js crawl --exclude "/admin/*,/api/*"
```

Wait for dynamic content:
```bash
node scrape.js crawl --wait-for ".content-loaded"
```

### Step 3: Preview the Mirrored Site

Serve the mirrored site locally:

```bash
node scrape.js serve
```

**With options:**

```bash
node scrape.js serve --port 8000 --dir output
```

Open your browser to `http://localhost:8000` to view the offline mirror.

**Options:**
- `--port <number>` - Port to serve on (default: `8000`)
- `--dir <directory>` - Directory to serve (default: `output`)

### Step 4: Check Status

Check authentication and mirror status:

```bash
node scrape.js status
```

This shows:
- Authentication status
- Session validity
- Mirror statistics (pages, assets, size)
- Last crawl date
- Any errors encountered

## 🔧 Advanced Usage

### Re-authenticate

If your session expires or cookies become invalid:

```bash
node scrape.js auth
```

Or clear credentials first:

```bash
node scrape.js auth --clear-creds
```

### Clear Saved Credentials

To delete saved session cookies:

```bash
node scrape.js clear
```

### Environment Variables

Create a `.env` file for configuration:

```env
LOG_LEVEL=info
TARGET_SITE=https://www.revisionvillage.com
```

Available log levels: `error`, `warn`, `info`, `debug`

## 📁 Output Structure

After crawling, the output directory contains:

```
output/
├── index.html              # Homepage
├── page1.html              # Crawled pages
├── page2.html
├── subfolder/
│   └── page.html
├── assets/                 # Downloaded assets
│   ├── abc123.css
│   ├── def456.js
│   ├── ghi789.png
│   └── ...
├── crawl-report.json       # Detailed crawl statistics
├── errors.json             # Errors encountered (if any)
```

## 🔍 How It Works

### Authentication Flow

1. **User Confirmation**: Displays legal notice and requires explicit permission confirmation
2. **Headful Browser Launch**: Opens a visible Chromium browser (NOT headless)
3. **Manual Login**: User completes Google OAuth flow manually (including 2FA)
4. **Cookie Capture**: After successful login, saves session cookies and browser storage
5. **Validation**: Verifies authentication by checking page content
6. **Secure Storage**: Saves cookies to `cookies.json` with restrictive file permissions

**Critical Security Note**: This tool NEVER:
- Accesses or stores your Google password
- Automates credential entry
- Bypasses any security measures
- Uses any form of credential stuffing or brute force

### Crawling Flow

1. **Session Validation**: Checks if saved cookies are still valid
2. **Robots.txt**: Loads and respects robots.txt (unless `--no-respect-robots`)
3. **Queue Management**: Maintains a queue of URLs to visit
4. **Concurrent Processing**: Renders multiple pages in parallel (configurable)
5. **Asset Detection**: Extracts images, CSS, JS, fonts, videos from each page
6. **Link Extraction**: Finds internal links to add to the queue
7. **HTML Rewriting**: Converts all links to relative paths for offline use
8. **Asset Download**: Downloads all referenced assets
9. **Progress Tracking**: Reports progress in real-time

### Link Rewriting

The tool rewrites:
- `<a href="...">` - Navigation links
- `<img src="...">` and `<img srcset="...">` - Images
- `<link rel="stylesheet" href="...">` - Stylesheets
- `<script src="...">` - JavaScript files
- `<video>`, `<audio>`, `<source>` - Media files
- Icons and favicons

All absolute URLs are converted to relative paths that work offline.

## 🛠️ Troubleshooting

### "No saved credentials found"

**Solution**: Run `node scrape.js auth` to authenticate first.

### "Session validation failed"

Your cookies have expired. **Solution**: Re-authenticate:

```bash
node scrape.js auth
```

### "Authentication verification failed"

The tool couldn't confirm successful login. **Solutions**:
- Make sure you completed the entire login process
- Wait for the page to fully load after login
- Check that you're not still on a login page
- Try authenticating again

### Browser doesn't open

**Solutions**:
- Ensure you have a display/GUI environment (not pure SSH terminal)
- Install required dependencies: `npx playwright install-deps chromium`
- Try setting: `export DISPLAY=:0` (Linux)

### Downloads are slow

**Solutions**:
- Increase concurrency: `--concurrency 8`
- Reduce delay: `--delay 500`
- Check your internet connection
- The site might be rate-limiting; use a higher delay

### Some assets are missing

**Possible causes**:
- Assets are loaded dynamically via JavaScript after page load
- Use `--wait-for <selector>` to wait for content
- Check `errors.json` for failed downloads
- Some assets might require additional authentication

### "Too many requests" or rate limiting

**Solution**: Increase delay between requests:

```bash
node scrape.js crawl --delay 2000 --concurrency 2
```

## 📊 Logs and Reports

### Log Files

- `scraper.log` - All log messages
- `scraper-error.log` - Errors only

### Reports

- `output/crawl-report.json` - Complete crawl statistics
- `output/errors.json` - Detailed error information

## 🔒 Security Best Practices

1. **Protect Cookie Files**: The `cookies.json` file contains your session. Keep it secure!
   - Don't commit to version control (already in `.gitignore`)
   - Don't share with others
   - Delete when no longer needed

2. **Use on Trusted Networks**: Avoid using on public WiFi

3. **Clear Credentials**: When done, clear saved credentials:
   ```bash
   node scrape.js clear
   ```

4. **Respect Privacy**: Don't share mirrored content if it contains personal information

## 🤝 Contributing

This is a specialized tool for authorized website mirroring. Contributions should:
- Maintain the ethical use requirements
- Not introduce credential automation
- Follow the existing code style
- Include appropriate documentation

## 📄 License

MIT License - See LICENSE file for details

## ⚖️ Legal Disclaimer

This tool is provided "as is" without warranty of any kind. Users are solely responsible for:
- Obtaining necessary permissions before use
- Complying with applicable laws and regulations
- Respecting intellectual property rights
- Following website Terms of Service

The developers assume no liability for misuse of this tool.

## 🙏 Acknowledgments

Built with:
- [Playwright](https://playwright.dev/) - Browser automation
- [Commander.js](https://github.com/tj/commander.js/) - CLI framework
- [Cheerio](https://cheerio.js.org/) - HTML parsing
- [Winston](https://github.com/winstonjs/winston) - Logging

## 📞 Support

For issues, questions, or suggestions:
1. Check this README thoroughly
2. Review log files for errors
3. Open an issue in the repository

---

**Remember**: Always obtain explicit permission before mirroring any website. Use ethically and responsibly.

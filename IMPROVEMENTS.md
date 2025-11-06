# Scraper Improvements - Comprehensive Page & Asset Discovery

## Overview
This update significantly enhances the web scraper's ability to discover and download ALL pages and assets from the target website. The improvements address multiple discovery gaps that were causing pages and resources to be missed.

## Key Improvements

### 1. Enhanced Link Discovery

#### Previously Missed:
- Form actions
- Meta refresh redirects
- Data attributes (data-href, data-url, data-link, data-src)

#### Now Captures:
- ✅ Standard `<a href>` links
- ✅ Form action URLs (`<form action>`)
- ✅ Meta refresh URLs (`<meta http-equiv="refresh">`)
- ✅ Data attributes commonly used in SPAs

**Impact**: Discovers pages that are accessible through forms, redirects, and JavaScript-heavy Single Page Applications.

### 2. Comprehensive Asset Discovery

#### Previously Missed:
- Lazy-loaded images (data-src, data-srcset)
- Video poster images
- Multiple icon formats
- Font preload links
- Picture element sources
- Iframes
- Object/Embed elements
- Web manifest files
- Module scripts
- Preloaded stylesheets

#### Now Captures:
- ✅ All image sources (src, srcset, data-src, data-srcset)
- ✅ Picture element sources with srcset
- ✅ Video posters and all media sources
- ✅ All icon variants (favicon, apple-touch-icon, etc.)
- ✅ Font files via preload links
- ✅ Iframes, objects, and embeds
- ✅ Web app manifests
- ✅ ES6 module scripts
- ✅ Preloaded stylesheets
- ✅ Media track files

**Impact**: Ensures the offline mirror includes ALL visual assets, fonts, and embedded content.

### 3. CSS Asset Discovery & Rewriting

#### New Capabilities:
- ✅ Parses downloaded CSS files to find additional assets
- ✅ Extracts background images from CSS
- ✅ Extracts web fonts from @font-face declarations
- ✅ Follows @import statements to find nested stylesheets
- ✅ Rewrites all URL references in CSS files to point to local assets
- ✅ Handles inline styles in HTML elements
- ✅ Handles `<style>` tags in HTML

**Impact**: Discovers and downloads fonts, background images, and nested stylesheets that were previously invisible to HTML-only parsing.

### 4. Lazy Loading Support

#### New Capability:
- ✅ Automatically scrolls pages from top to bottom
- ✅ Triggers lazy-loaded images and content
- ✅ Gradual scrolling (100px steps) to simulate real browsing
- ✅ Waits for content to load at each scroll position
- ✅ Smart detection of page bottom

**Impact**: Captures lazy-loaded images and content that only appear when scrolling.

### 5. Inline Asset Detection

#### New Capabilities:
- ✅ Extracts URLs from inline `style` attributes
- ✅ Parses `<style>` tags within HTML documents
- ✅ Rewrites inline CSS URLs to local paths

**Impact**: Discovers background images and other resources defined directly in HTML.

### 6. Improved URL Filtering

#### Enhanced Safety:
- ✅ Skips data: URLs (already embedded)
- ✅ Skips javascript: pseudo-URLs
- ✅ Skips empty and # fragment-only URLs
- ✅ Better validation of relative URLs

**Impact**: Prevents errors and unnecessary processing of non-downloadable URLs.

## Technical Details

### New Methods Added:

1. **`extractUrlsFromCss(css, baseUrl)`**
   - Extracts all `url()` references from CSS content
   - Extracts `@import` statements
   - Returns array of absolute URLs

2. **`scrollPageForLazyLoad(page)`**
   - Scrolls page gradually to trigger lazy loading
   - Waits at each scroll position for content to load
   - Scrolls back to top when complete

3. **`parseCssFile(cssContent, cssUrl)`**
   - Parses CSS content for additional assets
   - Automatically categorizes assets (fonts, images, stylesheets)
   - Adds discovered assets to download queue

4. **`rewriteCssUrls(css, pageUrl, pageFilePath)`**
   - Rewrites all `url()` references in CSS
   - Converts absolute URLs to relative local paths
   - Maintains data: and # URLs unchanged

### Enhanced Methods:

1. **`extractLinksAndAssets(html, pageUrl)`**
   - Added form action extraction
   - Added meta refresh extraction
   - Added data attribute extraction
   - Expanded asset selectors from 9 to 19 types
   - Added inline style parsing
   - Added style tag parsing

2. **`rewriteHtml(html, pageUrl)`**
   - Added rewriting for data-src/data-srcset
   - Added rewriting for video posters
   - Added rewriting for iframes, objects, embeds
   - Added rewriting for all icon types
   - Added rewriting for font preloads
   - Added rewriting for manifests
   - Added rewriting for inline styles
   - Added rewriting for style tags

3. **`downloadAsset(context, asset)`**
   - Added CSS file detection
   - Added CSS parsing after download
   - Added CSS URL rewriting before saving
   - Saves rewritten CSS instead of original

## Performance Considerations

- **CSS Parsing**: Only performed on actual .css files, minimal overhead
- **Lazy Loading Scroll**: Adds ~5-10 seconds per page, can be optimized if needed
- **Asset Discovery**: More comprehensive but still efficient with Set-based deduplication
- **Memory**: Asset map now includes more items but still uses efficient Map structure

## Backward Compatibility

All changes are backward compatible:
- Existing command-line options unchanged
- Existing configuration options unchanged
- Enhanced behavior is automatic, no user action required
- Falls back gracefully if new features encounter errors

## Testing Recommendations

1. **Test with sitemap-enabled crawl**: `node scrape.js crawl --sitemap`
2. **Test with sitemap-disabled crawl**: `node scrape.js crawl --no-sitemap`
3. **Compare asset counts**: Check crawl-report.json for increased asset counts
4. **Visual inspection**: Serve the mirror and check for missing images/fonts/styles
5. **Check CSS files**: Verify that downloaded CSS files have rewritten URLs

## Expected Improvements

Sites with the following characteristics will see the biggest improvements:

- ✅ Heavy use of CSS background images (10-100+ more assets)
- ✅ Custom web fonts (5-20+ more assets)
- ✅ Lazy-loaded images (10-1000+ more assets)
- ✅ Form-based navigation (5-50+ more pages)
- ✅ Single Page Application architecture (10-100+ more pages)
- ✅ Inline styles with background images (10-50+ more assets)

## Files Modified

- `lib/crawler.js` - All improvements implemented here

## Lines Added

- Approximately 250+ lines of new code
- 4 new methods
- 4 significantly enhanced methods
- Comprehensive inline documentation

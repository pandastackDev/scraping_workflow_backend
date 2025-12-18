import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium-min';
import { findCompanyWebsite } from './websiteFinder.js';

let browser = null;

// Simple delay helper to replace deprecated page.waitForTimeout
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getBrowser() {
  try {
    if (!browser || !browser.isConnected()) {
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          // Ignore close errors
        }
      }

      // Use serverless-compatible Chromium when running on Vercel / serverless
      const executablePath = await chromium.executablePath();

      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath || undefined,
        headless: chromium.headless
      });
      console.log('Browser instance created/recreated');
    }
    return browser;
  } catch (error) {
    console.error('Error creating browser:', error);
    throw new Error(`Failed to launch browser: ${error.message}`);
  }
}

export async function scrapeExhibitors(url, options = {}) {
  let browser = null;
  let page = null;
  
  try {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided');
    }
    
    browser = await getBrowser();
    if (!browser) {
      throw new Error('Failed to get browser instance');
    }
    
    page = await browser.newPage();
    if (!page) {
      throw new Error('Failed to create new page');
    }
    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log(`Navigating to: ${url}`);
    try {
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
    } catch (navError) {
      console.log('Network idle timeout, trying domcontentloaded...');
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
    }

    // Wait a bit for dynamic content
    await delay(3000);

    // Detect page type and scrape accordingly
    const pageType = detectPageType(url);
    console.log(`Detected page type: ${pageType}`);
    let exhibitors = [];

    switch (pageType) {
      case 'manifest':
        exhibitors = await scrapeManifest(page);
        break;
      case 'mapyourshow':
        exhibitors = await scrapeMapYourShow(page);
        break;
      case 'a2z':
        exhibitors = await scrapeA2Z(page);
        break;
      case 'smallworldlabs':
        exhibitors = await scrapeSmallWorldLabs(page);
        break;
      case 'affiliatesummit':
        exhibitors = await scrapeAffiliateSummit(page);
        break;
      case 'goeshow':
        exhibitors = await scrapeGoShow(page);
        break;
      default:
        exhibitors = await scrapeGeneric(page);
    }

    // Handle pagination if needed (disabled by default for speed)
    if (options.handlePagination === true && pageType !== 'smallworldlabs') {
      exhibitors = await handlePagination(page, exhibitors, pageType, url);
    }
    
    // For SmallWorldLabs, handle pagination separately if explicitly requested
    if (pageType === 'smallworldlabs' && options.handlePagination === true) {
      console.log('Pagination requested for SmallWorldLabs - this may take a while...');
      exhibitors = await handlePagination(page, exhibitors, pageType, url);
    }

    // Send initial exhibitors that already have websites (if streaming)
    if (options.onExhibitorFound && options.findWebsites !== false) {
      const exhibitorsWithWebsite = exhibitors.filter(e => e.website && e.website !== '');
      for (const exhibitor of exhibitorsWithWebsite) {
        options.onExhibitorFound(exhibitor);
      }
    } else if (options.onExhibitorFound && options.findWebsites === false) {
      // If website discovery is disabled, send all exhibitors immediately
      for (const exhibitor of exhibitors) {
        options.onExhibitorFound(exhibitor);
      }
    }

    // Step 2: Find websites for exhibitors that don't have one (FALLBACK METHOD)
    // This uses Google search only if website was not found on the page
    if (options.findWebsites !== false) {
      const exhibitorsWithoutWebsite = exhibitors.filter(e => !e.website || e.website === '');
      const exhibitorsWithWebsite = exhibitors.filter(e => e.website && e.website !== '');
      
      console.log(`Found ${exhibitors.length} exhibitors total:`);
      console.log(`  - ${exhibitorsWithWebsite.length} with websites extracted from page`);
      console.log(`  - ${exhibitorsWithoutWebsite.length} need website discovery via search`);
      
      // Send initial progress update
      if (options.onProgress) {
        options.onProgress({
          message: `Found ${exhibitors.length} exhibitors. ${exhibitorsWithWebsite.length} with websites, ${exhibitorsWithoutWebsite.length} need discovery.`,
          total: exhibitors.length,
          withWebsite: exhibitorsWithWebsite.length,
          needDiscovery: exhibitorsWithoutWebsite.length
        });
      }
      
      if (exhibitorsWithoutWebsite.length > 0) {
        const maxWebsiteSearches = options.maxWebsiteSearches || Math.min(exhibitorsWithoutWebsite.length, 50); // Limit searches
        console.log(`Finding websites via Google search for up to ${maxWebsiteSearches} companies (this may take a while)...`);
        
        if (options.onProgress) {
          options.onProgress({
            message: `Finding websites for ${maxWebsiteSearches} companies...`,
            searching: true,
            current: 0,
            total: maxWebsiteSearches
          });
        }
        
        for (let i = 0; i < Math.min(exhibitorsWithoutWebsite.length, maxWebsiteSearches); i++) {
          const exhibitor = exhibitorsWithoutWebsite[i];
          if (!exhibitor.website || exhibitor.website === '') {
            try {
              console.log(`[${i + 1}/${Math.min(exhibitorsWithoutWebsite.length, maxWebsiteSearches)}] Searching for: ${exhibitor.companyName}`);
              
              // Send progress update
              if (options.onProgress) {
                options.onProgress({
                  message: `Searching for: ${exhibitor.companyName}`,
                  current: i + 1,
                  total: maxWebsiteSearches
                });
              }
              
              exhibitor.website = await findCompanyWebsite(exhibitor.companyName, page);
              if (exhibitor.website) {
                console.log(`  ✓ Found: ${exhibitor.website}`);
              } else {
                console.log(`  ✗ Not found`);
              }
              
              // Send exhibitor update immediately
              if (options.onExhibitorFound) {
                options.onExhibitorFound(exhibitor);
              }
              
              // Small delay to avoid rate limiting (reduced for faster real-time updates)
              await delay(300);
            } catch (err) {
              console.error(`Error finding website for ${exhibitor.companyName}:`, err.message);
              exhibitor.website = '';
              
              // Still send the exhibitor even if website search failed
              if (options.onExhibitorFound) {
                options.onExhibitorFound(exhibitor);
              }
            }
          } else {
            // Already has website, send it immediately
            if (options.onExhibitorFound) {
              options.onExhibitorFound(exhibitor);
            }
          }
        }
        
        if (exhibitorsWithoutWebsite.length > maxWebsiteSearches) {
          console.log(`Skipped website search for ${exhibitorsWithoutWebsite.length - maxWebsiteSearches} companies to save time`);
        }
      } else {
        console.log('All exhibitors already have websites extracted from the page!');
        // All exhibitors already sent above
      }
    } else {
      console.log(`Website discovery disabled (found ${exhibitors.length} exhibitors)`);
      // Send all exhibitors immediately if website discovery is disabled
      if (options.onExhibitorFound) {
        for (const exhibitor of exhibitors) {
          options.onExhibitorFound(exhibitor);
        }
      }
    }

    return exhibitors;
  } catch (error) {
    console.error('Scraping error:', error);
    console.error('Error details:', error.message);
    throw error;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        console.error('Error closing page:', closeError.message);
      }
    }
  }
}

function detectPageType(url) {
  if (url.includes('manife.st')) return 'manifest';
  if (url.includes('mapyourshow.com')) return 'mapyourshow';
  if (url.includes('a2zinc.net')) return 'a2z';
  if (url.includes('smallworldlabs.com')) return 'smallworldlabs';
  if (url.includes('affiliatesummit.com')) return 'affiliatesummit';
  if (url.includes('goeshow.com')) return 'goeshow';
  return 'generic';
}

/**
 * Helper function to extract website URL from a DOM element
 * This is the PRIMARY method - extracts website directly from the page
 * @param {Element} element - The DOM element to search within
 * @param {string} baseUrl - The base URL of the page (for relative links)
 * @returns {string} - The website URL if found, empty string otherwise
 */
function extractWebsiteFromElement(element, baseUrl = '') {
  if (!element) return '';
  
  try {
    // Common selectors for website links
    const websiteSelectors = [
      'a[href*="http"]',           // Any external link
      'a[href*="www."]',           // Links with www
      'a[href*=".com"]',           // Links with .com
      'a[href*=".net"]',            // Links with .net
      'a[href*=".org"]',            // Links with .org
      'a[href*="website"]',         // Links containing "website"
      'a[href*="site"]',            // Links containing "site"
      'a[class*="website"]',        // Links with website in class
      'a[class*="url"]',            // Links with url in class
      'a[title*="website"]',        // Links with website in title
      'a[title*="site"]',           // Links with site in title
      '.website a',                 // Links inside .website container
      '.url a',                     // Links inside .url container
      '[data-website]',             // Elements with data-website attribute
      '[data-url]'                  // Elements with data-url attribute
    ];
    
    // Try each selector
    for (const selector of websiteSelectors) {
      try {
        const link = element.querySelector(selector);
        if (link) {
          let href = link.getAttribute('href') || link.getAttribute('data-website') || link.getAttribute('data-url') || '';
          
          if (href) {
            // Skip internal/exhibitor platform links
            const skipDomains = [
              'mapyourshow.com',
              'a2zinc.net',
              'smallworldlabs.com',
              'affiliatesummit.com',
              'goeshow.com',
              'manife.st',
              'eventmap',
              'exhibitor',
              'booth',
              'profile'
            ];
            
            const hrefLower = href.toLowerCase();
            const isInternal = skipDomains.some(domain => hrefLower.includes(domain));
            
            if (isInternal) continue;
            
            // Convert relative URLs to absolute
            if (href.startsWith('//')) {
              href = 'https:' + href;
            } else if (href.startsWith('/')) {
              href = baseUrl ? new URL(href, baseUrl).href : href;
            }
            
            // Validate it's a proper URL
            if (href.startsWith('http://') || href.startsWith('https://')) {
              // Skip social media and common non-official sites
              const socialDomains = [
                'facebook.com',
                'twitter.com',
                'linkedin.com',
                'instagram.com',
                'youtube.com',
                'pinterest.com',
                'tiktok.com'
              ];
              
              try {
                const url = new URL(href);
                const hostname = url.hostname.toLowerCase().replace('www.', '');
                
                if (socialDomains.some(domain => hostname.includes(domain))) {
                  continue; // Skip social media
                }
                
                return href;
              } catch (e) {
                continue;
              }
            }
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    // If no direct link found, check all links in the element
    const allLinks = element.querySelectorAll('a[href]');
    for (const link of allLinks) {
      try {
        let href = link.getAttribute('href') || '';
        if (!href) continue;
        
        // Skip internal links
        if (href.startsWith('#') || href.startsWith('javascript:')) continue;
        
        // Convert relative to absolute
        if (href.startsWith('//')) {
          href = 'https:' + href;
        } else if (href.startsWith('/') && baseUrl) {
          href = new URL(href, baseUrl).href;
        }
        
        // Check if it's an external website link
        if (href.startsWith('http://') || href.startsWith('https://')) {
          try {
            const url = new URL(href);
            const hostname = url.hostname.toLowerCase().replace('www.', '');
            
            // Skip exhibitor platform domains
            const skipDomains = [
              'mapyourshow.com',
              'a2zinc.net',
              'smallworldlabs.com',
              'affiliatesummit.com',
              'goeshow.com',
              'manife.st'
            ];
            
            if (skipDomains.some(domain => hostname.includes(domain))) {
              continue;
            }
            
            // Skip social media
            const socialDomains = [
              'facebook.com',
              'twitter.com',
              'linkedin.com',
              'instagram.com',
              'youtube.com'
            ];
            
            if (socialDomains.some(domain => hostname.includes(domain))) {
              continue;
            }
            
            // Check link text for website indicators
            const linkText = (link.textContent || '').toLowerCase();
            const isWebsiteLink = linkText.includes('website') ||
                                 linkText.includes('site') ||
                                 linkText.includes('visit') ||
                                 linkText.includes('www.') ||
                                 linkText.includes('.com') ||
                                 linkText.includes('.net') ||
                                 linkText.includes('.org');
            
            // If it looks like a website link or is a direct domain link, return it
            if (isWebsiteLink || hostname.includes('.com') || hostname.includes('.net') || hostname.includes('.org')) {
              return href;
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    return '';
  } catch (error) {
    return '';
  }
}

async function scrapeMapYourShow(page) {
  const exhibitors = [];
  
  // Try multiple selectors for MapYourShow
  const selectors = [
    '.exhibitor-item',
    '.exhibitor-card',
    '.exhibitor-list-item',
    '[class*="exhibitor"]',
    'a[href*="exhibitor"]'
  ];

  let elements = [];
  for (const selector of selectors) {
    elements = await page.$$(selector);
    if (elements.length > 0) break;
  }

  const baseUrl = page.url();
  
  for (const element of elements) {
    try {
      const data = await element.evaluate((el, base) => {
        const companyName = el.textContent?.trim() || 
                           el.querySelector('h3, h4, .name, .company-name')?.textContent?.trim() || 
                           el.getAttribute('title') || '';
        
        // Try to find website link - look for external links
        let website = '';
        const allLinks = el.querySelectorAll('a[href]');
        
        for (const link of allLinks) {
          try {
            let href = link.getAttribute('href') || '';
            if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
            
            // Convert relative to absolute
            if (href.startsWith('//')) {
              href = 'https:' + href;
            } else if (href.startsWith('/') && base) {
              try {
                href = new URL(href, base).href;
              } catch (e) {
                continue;
              }
            }
            
            if (href.startsWith('http://') || href.startsWith('https://')) {
              try {
                const url = new URL(href);
                const hostname = url.hostname.toLowerCase();
                
                // Skip MapYourShow internal links
                if (hostname.includes('mapyourshow.com') || hostname.includes('eventmap')) {
                  continue;
                }
                
                // Skip social media
                const socialDomains = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com'];
                if (socialDomains.some(domain => hostname.includes(domain))) {
                  continue;
                }
                
                // Check if link text suggests it's a website link
                const linkText = (link.textContent || '').toLowerCase();
                const isWebsiteLink = linkText.includes('website') ||
                                     linkText.includes('site') ||
                                     linkText.includes('visit') ||
                                     linkText.includes('www.') ||
                                     hostname.includes('.com') ||
                                     hostname.includes('.net') ||
                                     hostname.includes('.org');
                
                if (isWebsiteLink) {
                  website = href;
                  break;
                }
              } catch (e) {
                continue;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        return { companyName, website };
      }, baseUrl);

      if (data.companyName && data.companyName.length > 1) {
        exhibitors.push({
          companyName: data.companyName,
          website: data.website || '',
          source: 'mapyourshow'
        });
      }
    } catch (err) {
      console.error('Error extracting exhibitor:', err);
    }
  }

  return exhibitors;
}

async function scrapeA2Z(page) {
  const exhibitors = [];
  
  // A2Z typically uses specific classes
  const selectors = [
    '.exhibitor-name',
    '.exhibitor-link',
    'a[href*="Exhibitor"]',
    '[id*="exhibitor"]'
  ];

  let elements = [];
  for (const selector of selectors) {
    elements = await page.$$(selector);
    if (elements.length > 0) break;
  }

  const baseUrl = page.url();
  
  for (const element of elements) {
    try {
      const data = await element.evaluate((el, base) => {
        const companyName = el.textContent?.trim() || 
                            el.querySelector('h3, h4, .name, .company-name')?.textContent?.trim() ||
                            el.getAttribute('title') || 
                            el.getAttribute('alt') || '';
        
        // Try to find website link
        let website = '';
        const websiteLink = el.querySelector('a[href*="http"]:not([href*="a2zinc.net"]):not([href*="EventMap"])') ||
                           el.closest('.exhibitor-item, .exhibitor-card')?.querySelector('a[href*="http"]:not([href*="a2zinc.net"])');
        
        if (websiteLink) {
          website = websiteLink.href || '';
          // Validate it's not an internal link
          try {
            const url = new URL(website);
            const hostname = url.hostname.toLowerCase();
            if (hostname.includes('a2zinc.net') || hostname.includes('eventmap')) {
              website = '';
            }
          } catch (e) {
            website = '';
          }
        }
        
        return { companyName, website };
      }, baseUrl);

      if (data.companyName && data.companyName.length > 1) {
        exhibitors.push({
          companyName: data.companyName,
          website: data.website || '',
          source: 'a2z'
        });
      }
    } catch (err) {
      console.error('Error extracting exhibitor:', err);
    }
  }

  return exhibitors;
}

async function scrapeManifest(page) {
  const exhibitors = [];
  
  console.log('Scraping Manifest.st page...');
  
  // Wait for content to load
  try {
    await page.waitForSelector('body', { timeout: 15000 });
    await delay(2000); // Extra wait for dynamic content
  } catch (err) {
    console.log('Page load timeout, continuing anyway...');
  }
  
  // Manifest.st has company names in <p class="company-name"> separated by <br>
  let exhibitorsData = [];
  try {
    exhibitorsData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Try multiple selectors - convert NodeList to Array for easier manipulation
    let companyNameElements = Array.from(document.querySelectorAll('p.company-name'));
    
    // If not found, try alternative selectors
    if (companyNameElements.length === 0) {
      companyNameElements = Array.from(document.querySelectorAll('.company-name, [class*="company-name"], p[class*="name"]'));
    }
    
    // If still not found, try to find by text content pattern
    if (companyNameElements.length === 0) {
      // Look for paragraphs/divs that contain company names (have <br> tags and multiple lines)
      const allElements = Array.from(document.querySelectorAll('p, div'));
      companyNameElements = allElements.filter(p => {
        return p.innerHTML && 
               p.innerHTML.includes('<br') && 
               p.textContent && 
               p.textContent.trim().length > 10;
      });
    }
    
    // Process each element
    companyNameElements.forEach(element => {
      try {
        // Get all text content and split by <br> tags
        const html = element.innerHTML || '';
        // Split by <br> or <br/> tags
        const companies = html.split(/<br\s*\/?>/i).map(text => {
          // Remove HTML entities and clean up
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = text.trim();
          return tempDiv.textContent || tempDiv.innerText || '';
        }).filter(name => {
          // Filter out empty strings, numbers only, and section headers
          const trimmed = name.trim();
          return trimmed && 
                 trimmed.length > 1 && 
                 trimmed.length < 200 &&
                 !trimmed.match(/^[#\d\s-]+$/) && // Not just numbers/symbols
                 !trimmed.match(/^[A-Z]-[A-Z]$/) && // Not like "A-F" or "Q-Z"
                 !trimmed.match(/^[A-Z]\s*-\s*[A-Z]$/) && // Not like "A - F"
                 !trimmed.match(/^Companies Who Attend Include:$/i) &&
                 !seen.has(trimmed.toLowerCase());
        });
        
        companies.forEach(company => {
          const cleanName = company.trim();
          if (cleanName) {
            seen.add(cleanName.toLowerCase());
            results.push({ name: cleanName, link: '' });
          }
        });
      } catch (err) {
        // Skip this element if there's an error
      }
    });
    
    // If still no results, try to find company names in Bootstrap column divs
    if (results.length === 0) {
      // Try alternative: look for divs with class containing "col" (Bootstrap columns)
      const colElements = Array.from(document.querySelectorAll('.col-lg-4, .col-md-4, [class*="col-"]'));
      colElements.forEach(col => {
        try {
          const text = col.textContent || col.innerText || '';
          const lines = text.split('\n').map(line => line.trim()).filter(line => {
            return line && 
                   line.length > 2 && 
                   line.length < 200 &&
                   !line.match(/^[#\d\s-]+$/) &&
                   !line.match(/^[A-Z]\s*-\s*[A-Z]$/) &&
                   !line.toLowerCase().includes('companies') &&
                   !line.toLowerCase().includes('attending') &&
                   !line.toLowerCase().includes('who attend') &&
                   !line.toLowerCase().includes('include:') &&
                   !seen.has(line.toLowerCase());
          });
          
          lines.forEach(line => {
            seen.add(line.toLowerCase());
            results.push({ name: line, link: '' });
          });
        } catch (err) {
          // Skip this column if there's an error
        }
      });
    }
    
    return results;
    });
  } catch (evalError) {
    console.error('Error in page.evaluate for Manifest:', evalError.message);
    // Try a simpler extraction method as fallback
    try {
      exhibitorsData = await page.evaluate(() => {
        const results = [];
        const seen = new Set();
        // Simple fallback: get all text from body and extract lines
        const bodyText = document.body.innerText || document.body.textContent || '';
        const lines = bodyText.split('\n').map(line => line.trim()).filter(line => {
          return line && 
                 line.length > 2 && 
                 line.length < 200 &&
                 !line.match(/^[#\d\s-]+$/) &&
                 !line.match(/^[A-Z]\s*-\s*[A-Z]$/) &&
                 !line.toLowerCase().includes('companies') &&
                 !line.toLowerCase().includes('attending') &&
                 !line.toLowerCase().includes('who attend') &&
                 !line.toLowerCase().includes('include:') &&
                 !seen.has(line.toLowerCase());
        });
        
        lines.slice(0, 1000).forEach(line => { // Limit to first 1000
          seen.add(line.toLowerCase());
          results.push({ name: line, link: '' });
        });
        
        return results;
      });
    } catch (fallbackError) {
      console.error('Fallback extraction also failed:', fallbackError.message);
      exhibitorsData = [];
    }
  }

  console.log(`Extracted ${exhibitorsData.length} companies from Manifest.st`);

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.name,
      website: item.link || '',
      source: 'manifest'
    });
  });

  return exhibitors;
}

async function scrapeSmallWorldLabs(page) {
  const exhibitors = [];
  
  console.log('Scraping SmallWorldLabs page...');
  
  // Wait for table to load - use shorter timeout and multiple strategies
  try {
    await page.waitForSelector('table.table tbody tr, .generic-table-wrapper tbody tr', { 
      timeout: 20000,
      visible: true 
    });
  } catch (err) {
    console.log('Table not found with standard selector, trying alternative...');
    await page.waitForSelector('tbody tr', { timeout: 10000 }).catch(() => {});
  }
  
  await delay(1000); // Reduced wait time
  
  // SmallWorldLabs uses a table structure with generic-option-link class
  const exhibitorsData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Find all table rows - try multiple selectors
    let rows = document.querySelectorAll('table.table tbody tr');
    if (rows.length === 0) {
      rows = document.querySelectorAll('.generic-table-wrapper tbody tr');
    }
    if (rows.length === 0) {
      rows = document.querySelectorAll('tbody tr');
    }
    
    rows.forEach(row => {
      try {
        // Get all cells in the row
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return; // Skip if not enough columns
        
        // Company name is in the second column (index 1)
        const nameCell = cells[1];
        const nameLink = nameCell ? nameCell.querySelector('a.generic-option-link') : null;
        
        if (nameLink) {
          const name = nameLink.textContent?.trim() || '';
          
          // Get booth number from third column (index 2)
          let booth = '';
          if (cells.length >= 3) {
            const boothCell = cells[2];
            if (boothCell) {
              const boothLink = boothCell.querySelector('a');
              if (boothLink) {
                booth = boothLink.textContent?.trim() || '';
                // Clean up booth text - remove extra spaces
                booth = booth.replace(/\s+/g, ' ').trim();
              }
            }
          }
          
          // Skip if it's a booth number link or empty or invalid
          if (name && 
              name.length > 1 && 
              name.length < 200 &&
              !name.match(/^Booth\s*#?\d+$/i) &&
              !name.match(/^\d+$/) &&
              !name.match(/^Explore$/i) &&
              !name.match(/^Name$/i) &&
              !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            
            // Try to find website link in the row (not a2z or smallworldlabs links)
            let website = '';
            const allLinks = row.querySelectorAll('a[href]');
            for (const link of allLinks) {
              const href = link.getAttribute('href') || '';
              if (href.startsWith('http') && 
                  !href.includes('a2zinc.net') && 
                  !href.includes('smallworldlabs.com') &&
                  !href.includes('EventMap')) {
                website = href;
                break;
              }
            }
            
            results.push({ name, booth, link: website });
          }
        }
      } catch (err) {
        // Skip this row if there's an error
      }
    });
    
    return results;
  });

  console.log(`Extracted ${exhibitorsData.length} companies from SmallWorldLabs`);

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.name,
      booth: item.booth || '',
      website: item.link || '',
      source: 'smallworldlabs'
    });
  });

  return exhibitors;
}

async function scrapeAffiliateSummit(page) {
  const exhibitors = [];
  
  // Affiliate Summit uses specific structure
  await page.waitForSelector('body', { timeout: 10000 });
  
  const exhibitorsData = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll('[class*="exhibitor"], [data-exhibitor]');
    
    items.forEach(item => {
      const name = item.textContent?.trim() || 
                   item.querySelector('h1, h2, h3, h4')?.textContent?.trim() || '';
      const link = item.querySelector('a[href*="http"]')?.href || '';
      
      if (name && name.length > 1) {
        results.push({ name, link });
      }
    });
    
    return results;
  });

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.name,
      website: item.link || '',
      source: 'affiliatesummit'
    });
  });

  return exhibitors;
}

async function scrapeGoShow(page) {
  const exhibitors = [];
  
  await page.waitForSelector('body', { timeout: 10000 });
  
  const exhibitorsData = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll('[class*="exhibitor"], [class*="vendor"]');
    
    items.forEach(item => {
      const name = item.textContent?.trim() || 
                   item.querySelector('h1, h2, h3, h4, .name')?.textContent?.trim() || '';
      const link = item.querySelector('a[href*="http"]')?.href || '';
      
      if (name && name.length > 1) {
        results.push({ name, link });
      }
    });
    
    return results;
  });

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.name,
      website: item.link || '',
      source: 'goeshow'
    });
  });

  return exhibitors;
}

async function scrapeGeneric(page) {
  const exhibitors = [];
  
  await page.waitForSelector('body', { timeout: 10000 });
  
  // Generic scraper - tries to find company names in common patterns
  const baseUrl = page.url();
  const exhibitorsData = await page.evaluate((base) => {
    const results = [];
    const seen = new Set();
    
    // Common non-company words to filter
    const filterWords = ['view', 'more', 'details', 'click', 'read', 'learn', 'see', 'show', 
                         'all', 'next', 'previous', 'page', 'home', 'about', 'contact', 
                         'login', 'register', 'search', 'filter', 'sort'];
    
    // Get current page domain to skip internal links
    let currentDomain = '';
    try {
      currentDomain = new URL(base || window.location.href).hostname.toLowerCase().replace('www.', '');
    } catch (e) {
      currentDomain = window.location.hostname.toLowerCase().replace('www.', '');
    }
    
    // Skip domains (exhibitor platforms)
    const skipDomains = ['mapyourshow.com', 'a2zinc.net', 'smallworldlabs.com', 
                         'affiliatesummit.com', 'goeshow.com', 'manife.st', 'eventmap'];
    
    // Helper to check if link is external website
    function isExternalWebsite(href) {
      if (!href || !href.startsWith('http')) return false;
      try {
        const url = new URL(href);
        const hostname = url.hostname.toLowerCase().replace('www.', '');
        
        // Skip if same domain or exhibitor platform
        if (hostname === currentDomain || skipDomains.some(d => hostname.includes(d))) {
          return false;
        }
        
        // Skip social media
        const socialDomains = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com'];
        if (socialDomains.some(d => hostname.includes(d))) {
          return false;
        }
        
        // Must be a proper domain
        return hostname.includes('.com') || hostname.includes('.net') || 
               hostname.includes('.org') || hostname.includes('.io') || 
               hostname.includes('.co');
      } catch (e) {
        return false;
      }
    }
    
    // Look for common patterns - prioritize more specific selectors
    const selectors = [
      'a[href*="exhibitor"]',
      'a[href*="company"]',
      '[class*="exhibitor"]',
      '[class*="company"]',
      '[class*="vendor"]',
      '[class*="booth"]',
      '[id*="exhibitor"]',
      'table td a',
      'ul li a',
      '.card a',
      '.item a',
      'h2 a',
      'h3 a',
      'h4 a'
    ];
    
    selectors.forEach(selector => {
      try {
        const items = document.querySelectorAll(selector);
        items.forEach(item => {
          const text = item.textContent?.trim() || '';
          let link = item.href?.startsWith('http') ? item.href : 
                     item.querySelector('a[href*="http"]')?.href || '';
          
          // Clean up text - remove extra whitespace
          const cleanText = text.replace(/\s+/g, ' ').trim();
          
          // Filter link - only keep external websites
          if (link && !isExternalWebsite(link)) {
            link = '';
          }
          
          // Filter out common non-company text
          if (cleanText && 
              cleanText.length > 2 && 
              cleanText.length < 100 &&
              !filterWords.includes(cleanText.toLowerCase()) &&
              !cleanText.match(/^[\d\s-()]+$/) && // Not just numbers/symbols
              !seen.has(cleanText.toLowerCase())) {
            seen.add(cleanText.toLowerCase());
            results.push({ name: cleanText, link: link || '' });
          }
        });
      } catch (e) {
        // Continue if selector fails
      }
    });
    
    // If no results, try extracting from list items or table rows
    if (results.length === 0) {
      const listItems = document.querySelectorAll('li, tr, .list-item');
      listItems.forEach(item => {
        const text = item.textContent?.trim().split('\n')[0] || '';
        let link = item.querySelector('a[href*="http"]')?.href || '';
        
        // Filter link
        if (link && !isExternalWebsite(link)) {
          link = '';
        }
        
        if (text && 
            text.length > 2 && 
            text.length < 100 &&
            !filterWords.includes(text.toLowerCase()) &&
            !seen.has(text.toLowerCase())) {
          seen.add(text.toLowerCase());
          results.push({ name: text, link: link || '' });
        }
      });
    }
    
    return results;
  }, baseUrl);

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.name,
      website: item.link || '',
      source: 'generic'
    });
  });

  return exhibitors;
}

async function handlePagination(page, currentExhibitors, pageType, originalUrl) {
  // Set max pages based on page type
  let maxPages = 5;
  if (pageType === 'smallworldlabs') maxPages = 15; // Can have 12+ pages
  if (pageType === 'manifest') maxPages = 20; // Multiple sections
  
  let pageCount = 0;
  
  while (pageCount < maxPages) {
    try {
      // For SmallWorldLabs, check for pagination buttons
      if (pageType === 'smallworldlabs') {
        const paginationInfo = await page.evaluate(() => {
          // Look for pagination controls - try multiple selectors
          const pagination = document.querySelector('.pagination, [class*="pagination"], .page-numbers, [class*="page"]');
          if (!pagination) return { hasNext: false, currentPage: 1 };
          
          // Find all page number buttons/links
          const pageButtons = Array.from(pagination.querySelectorAll('a, button, [class*="page"]'));
          
          // Find current active page
          const activePage = pagination.querySelector('.active, [class*="active"], .current, [class*="current"]');
          const currentPage = activePage ? parseInt(activePage.textContent) || 1 : 1;
          
          // Find next button (could be ">", "Next", or next page number)
          let nextButton = null;
          for (const btn of pageButtons) {
            const text = btn.textContent?.trim() || '';
            const isNext = text === '>' || 
                          text === '>>' || 
                          text.toLowerCase() === 'next' ||
                          (parseInt(text) === currentPage + 1);
            
            if (isNext && 
                btn.offsetParent !== null && 
                !btn.disabled && 
                !btn.classList.contains('disabled') &&
                !btn.classList.contains('active')) {
              nextButton = btn;
              break;
            }
          }
          
          // If no explicit next button, try to find next page number
          if (!nextButton) {
            const nextPageNum = currentPage + 1;
            for (const btn of pageButtons) {
              if (parseInt(btn.textContent) === nextPageNum && 
                  btn.offsetParent !== null) {
                nextButton = btn;
                break;
              }
            }
          }
          
          return { hasNext: !!nextButton, currentPage, nextButton: nextButton ? nextButton.textContent : null };
        });
        
        if (!paginationInfo.hasNext) {
          console.log('No more pages found');
          break;
        }
        
        console.log(`Found pagination, clicking next (page ${paginationInfo.currentPage + 1})...`);
        
        // Try to click next button - use multiple strategies
        try {
          // Strategy 1: Click by page number or next arrow
          const clicked = await page.evaluate((currentPage) => {
            const pagination = document.querySelector('.pagination, [class*="pagination"], .page-numbers');
            if (!pagination) return false;
            
            const nextPageNum = currentPage + 1;
            const buttons = Array.from(pagination.querySelectorAll('a, button, [role="button"]'));
            
            // First try to find next arrow (>, >>, Next)
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if ((text === '>' || text === '>>' || text.toLowerCase() === 'next') &&
                  btn.offsetParent !== null && 
                  !btn.disabled &&
                  !btn.classList.contains('disabled')) {
                btn.click();
                return true;
              }
            }
            
            // If no arrow, try to find next page number
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              const pageNum = parseInt(text);
              if (pageNum === nextPageNum &&
                  btn.offsetParent !== null && 
                  !btn.disabled &&
                  !btn.classList.contains('disabled') &&
                  !btn.classList.contains('active')) {
                btn.click();
                return true;
              }
            }
            
            return false;
          }, paginationInfo.currentPage);
          
          if (clicked) {
            await delay(3000);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await delay(2000);
          } else {
            console.log('Could not find next page button');
            break;
          }
        } catch (err) {
          console.log('Pagination click failed:', err.message);
          break;
        }
      } else {
        // Generic pagination handling
        const hasNext = await page.evaluate(() => {
          const nextButton = document.querySelector(
            'a[aria-label*="next" i], ' +
            'a[aria-label*="Next" i], ' +
            '.next, ' +
            '[class*="next"], ' +
            'button[aria-label*="next" i], ' +
            '[data-page-next]'
          );
          return nextButton && 
                 !nextButton.disabled && 
                 nextButton.offsetParent !== null &&
                 !nextButton.classList.contains('disabled');
        });

        if (!hasNext) {
          break;
        }

        console.log(`Found pagination, clicking next (page ${pageCount + 2})...`);
        
        // Click next button
        await page.click('a[aria-label*="next" i], a[aria-label*="Next" i], .next, [class*="next"], button[aria-label*="next" i]');
        await delay(3000);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      }

      // Scrape current page
      let moreExhibitors = [];
      switch (pageType) {
        case 'manifest':
          moreExhibitors = await scrapeManifest(page);
          break;
        case 'mapyourshow':
          moreExhibitors = await scrapeMapYourShow(page);
          break;
        case 'a2z':
          moreExhibitors = await scrapeA2Z(page);
          break;
        case 'smallworldlabs':
          moreExhibitors = await scrapeSmallWorldLabs(page);
          break;
        case 'affiliatesummit':
          moreExhibitors = await scrapeAffiliateSummit(page);
          break;
        case 'goeshow':
          moreExhibitors = await scrapeGoShow(page);
          break;
        default:
          moreExhibitors = await scrapeGeneric(page);
      }

      if (moreExhibitors.length === 0) {
        break; // No more data, stop pagination
      }

      currentExhibitors = [...currentExhibitors, ...moreExhibitors];
      pageCount++;
    } catch (err) {
      console.log('Pagination error or no more pages:', err.message);
      break;
    }
  }

  return currentExhibitors;
}


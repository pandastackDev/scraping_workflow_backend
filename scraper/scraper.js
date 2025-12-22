import puppeteer from 'puppeteer';
import chromium from '@sparticuz/chromium';
import { findCompanyWebsite } from './websiteFinder.js';

let browser = null;

// Simple delay helper to replace deprecated page.waitForTimeout
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isServerlessEnv() {
  // Vercel / common serverless indicators
  return (
    process.env.VERCEL === '1' ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.SERVERLESS_ENV === '1'
  );
}

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

      if (isServerlessEnv()) {
        // Vercel / serverless: use Sparticuz Chromium
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
      } else {
        // Local/dev: use Puppeteer's bundled Chromium
        browser = await puppeteer.launch({
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
          ]
        });
      }
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
      case 'wpma':
        exhibitors = await scrapeWPMA(page);
        break;
      case 'surfexpo':
        exhibitors = await scrapeSurfExpo(page);
        break;
      default:
        exhibitors = await scrapeGeneric(page);
    }

    // Handle pagination if needed
    // For SmallWorldLabs, enable pagination by default (can be disabled by setting handlePagination: false)
    // For other types, pagination is opt-in (handlePagination: true)
    console.log(`Pagination check - pageType: ${pageType}, handlePagination option: ${options.handlePagination}, typeof: ${typeof options.handlePagination}`);
    if (pageType === 'smallworldlabs') {
      if (options.handlePagination !== false) {
        // Auto-enable pagination for SmallWorldLabs unless explicitly disabled
        console.log(`Auto-enabling pagination for SmallWorldLabs - this may take a while... (found ${exhibitors.length} exhibitors on first page)`);
        exhibitors = await handlePagination(page, exhibitors, pageType, url);
        console.log(`Pagination complete - total exhibitors: ${exhibitors.length}`);
      } else {
        console.log('Pagination disabled for SmallWorldLabs (explicitly set to false)');
      }
    } else if (options.handlePagination === true) {
      // For other page types, pagination is opt-in
      console.log(`Pagination enabled for ${pageType}`);
      exhibitors = await handlePagination(page, exhibitors, pageType, url);
    } else {
      console.log(`Pagination skipped for ${pageType} (not SmallWorldLabs and handlePagination !== true)`);
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
        // Use maxWebsiteSearches option if provided, otherwise search for all exhibitors
        const maxWebsiteSearches = options.maxWebsiteSearches !== undefined 
          ? options.maxWebsiteSearches 
          : exhibitorsWithoutWebsite.length; // No limit by default - search for all
        const actualSearchCount = Math.min(exhibitorsWithoutWebsite.length, maxWebsiteSearches);
        
        console.log(`Finding websites via Google search for ${actualSearchCount} companies (this may take a while)...`);
        
        if (options.onProgress) {
          options.onProgress({
            message: `Finding websites for ${actualSearchCount} companies...`,
            searching: true,
            current: 0,
            total: actualSearchCount
          });
        }
        
        for (let i = 0; i < actualSearchCount; i++) {
          const exhibitor = exhibitorsWithoutWebsite[i];
          if (!exhibitor.website || exhibitor.website === '') {
            try {
              console.log(`[${i + 1}/${actualSearchCount}] Searching for: ${exhibitor.companyName}`);
              
              // Send progress update
              if (options.onProgress) {
                options.onProgress({
                  message: `Searching for: ${exhibitor.companyName}`,
                  current: i + 1,
                  total: actualSearchCount
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
        
        if (exhibitorsWithoutWebsite.length > actualSearchCount) {
          console.log(`Skipped website search for ${exhibitorsWithoutWebsite.length - actualSearchCount} companies (limited by maxWebsiteSearches option)`);
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
  if (url.includes('wpma.com')) return 'wpma';
  if (url.includes('surfexpo.com')) return 'surfexpo';
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
  
  console.log('Scraping A2Z page...');
  
  // Wait for content to load
  try {
    await page.waitForSelector('tbody tr[data-boothid], .exhibitor-name, a[href*="Exhibitor"]', { 
      timeout: 20000,
      visible: true 
    });
  } catch (err) {
    console.log('Content not found with standard selector, trying alternative...');
    await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
  }
  
  await delay(2000); // Wait for dynamic content to load
  
  // First, try to extract from EventMap table structure (if present)
  const eventMapData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Check for EventMap table structure
    const tableRows = document.querySelectorAll('tbody tr[data-boothid]');
    
    if (tableRows.length > 0) {
      console.log(`Found ${tableRows.length} EventMap table rows`);
      
      tableRows.forEach(row => {
        try {
          // Extract company name from td.companyName a.exhibitorName
          const companyNameCell = row.querySelector('td.companyName');
          const companyNameLink = companyNameCell ? companyNameCell.querySelector('a.exhibitorName') : null;
          const companyName = companyNameLink ? companyNameLink.textContent?.trim() : '';
          
          // Extract booth number from td.boothLabel a with data-boothlabels
          const boothLabelCell = row.querySelector('td.boothLabel');
          const boothLabelLink = boothLabelCell ? boothLabelCell.querySelector('a.boothLabel') : null;
          let boothNumber = '';
          if (boothLabelLink) {
            boothNumber = boothLabelLink.getAttribute('data-boothlabels') || 
                         boothLabelLink.textContent?.trim() || '';
          }
          
          // Extract booth ID from row attribute
          const boothId = row.getAttribute('data-boothid') || '';
          
          if (companyName && companyName.length > 1) {
            const uniqueKey = `${boothId}-${companyName.toLowerCase()}`;
            if (!seen.has(uniqueKey)) {
              seen.add(uniqueKey);
              results.push({
                companyName,
                booth: boothNumber,
                boothId
              });
            }
          }
        } catch (err) {
          console.error('Error extracting row data:', err);
        }
      });
    }
    
    return results;
  });

  if (eventMapData.length > 0) {
    console.log(`Extracted ${eventMapData.length} exhibitors from A2Z EventMap table`);
    eventMapData.forEach(item => {
      exhibitors.push({
        companyName: item.companyName,
        booth: item.booth || '',
        website: '', // A2Z EventMap doesn't provide websites in the table
        source: 'a2z'
      });
    });
    return exhibitors;
  }
  
  // Fallback to original A2Z scraper logic for non-EventMap pages
  console.log('EventMap table not found, trying alternative A2Z selectors...');
  
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

async function scrapeWPMA(page) {
  const exhibitors = [];
  
  console.log('Scraping WPMA booth map page...');
  
  // Wait for booth elements to load
  try {
    await page.waitForSelector('#graphic-container div[id^="booth"]', { 
      timeout: 20000,
      visible: true 
    });
  } catch (err) {
    console.log('Booth elements not found with standard selector, trying alternative...');
    await page.waitForSelector('div[id^="booth"]', { timeout: 10000 }).catch(() => {});
  }
  
  await delay(2000); // Wait for dynamic content to load
  
  // Extract exhibitor data from booth elements
  const exhibitorsData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Find all booth divs
    const boothElements = document.querySelectorAll('#graphic-container div[id^="booth"], div[id^="booth"]');
    
    boothElements.forEach(booth => {
      try {
        // Extract booth number from data-bs-title or data-val
        const boothTitle = booth.getAttribute('data-bs-title') || '';
        const boothVal = booth.getAttribute('data-val') || '';
        let boothNumber = '';
        
        // Extract booth number from "Booth #M779" format
        if (boothTitle) {
          const match = boothTitle.match(/Booth\s*#?M?(\d+)/i);
          if (match) {
            boothNumber = match[1];
          }
        }
        
        // Fallback to data-val if no match
        if (!boothNumber && boothVal) {
          boothNumber = boothVal;
        }
        
        // Extract HTML content from data-bs-content
        const contentHtml = booth.getAttribute('data-bs-content') || '';
        if (!contentHtml) return;
        
        // Decode HTML entities and parse content
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = contentHtml;
        
        // Extract company name and location from <strong> tags
        const allStrongTags = tempDiv.querySelectorAll('strong');
        let companyName = '';
        let location = '';
        
        // Company name is usually the first strong tag (skip if it's "Company Description:")
        for (const strongTag of allStrongTags) {
          const text = strongTag.textContent?.trim() || '';
          if (text && !text.toLowerCase().includes('company description')) {
            companyName = text;
            break;
          }
        }
        
        // Location is usually the second strong tag
        if (allStrongTags.length > 1) {
          location = allStrongTags[1].textContent?.trim() || '';
        }
        
        // Fallback: if no strong tags, try parsing from text lines
        if (!companyName || !location) {
          const textContent = tempDiv.textContent || '';
          const cleanText = textContent.replace(/^This booth is registered to\s*/i, '').trim();
          const textLines = cleanText.split(/\n|<br\s*\/?>/i).map(line => line.trim()).filter(line => line);
          
          if (!companyName && textLines.length > 0) {
            companyName = textLines[0];
          }
          if (!location && textLines.length > 1) {
            location = textLines[1];
          }
        }
        
        // Extract company description (text after "Company Description:")
        let description = '';
        const fullText = tempDiv.textContent || '';
        const descriptionMatch = fullText.match(/Company Description:\s*(.+?)(?:\n|$)/is);
        if (descriptionMatch) {
          description = descriptionMatch[1].trim();
          // Clean up description - remove extra whitespace
          description = description.replace(/\s+/g, ' ').trim();
        }
        
        // Extract business types from class names (bus-type-XX)
        const businessTypes = [];
        const classList = booth.classList;
        classList.forEach(className => {
          if (className.startsWith('bus-type-')) {
            const typeId = className.replace('bus-type-', '');
            businessTypes.push(typeId);
          }
        });
        
        // Skip if no company name or already seen
        if (!companyName || companyName.length < 2) return;
        
        const uniqueKey = `${boothNumber}-${companyName.toLowerCase()}`;
        if (seen.has(uniqueKey)) return;
        seen.add(uniqueKey);
        
        // Skip placeholder entries like "Hold", "Beer Garden", "EXHIBITOR SERVICES"
        const skipNames = ['hold', 'beer garden', 'exhibitor services', 'in our backyard', 'leonard petroleum'];
        if (skipNames.some(skip => companyName.toLowerCase().includes(skip))) {
          return;
        }
        
        results.push({
          boothNumber,
          companyName,
          location,
          description,
          businessTypes: businessTypes.join(', ')
        });
      } catch (err) {
        console.error('Error extracting booth data:', err);
      }
    });
    
    return results;
  });

  console.log(`Extracted ${exhibitorsData.length} exhibitors from WPMA booth map`);

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.companyName,
      booth: item.boothNumber ? `M${item.boothNumber}` : '',
      location: item.location || '',
      description: item.description || '',
      businessTypes: item.businessTypes || '',
      website: '', // WPMA doesn't provide websites in booth map
      source: 'wpma'
    });
  });

  return exhibitors;
}

async function scrapeSurfExpo(page) {
  const exhibitors = [];
  
  console.log('Scraping Surf Expo exhibitor list page...');
  
  // Wait for content to load
  try {
    await page.waitForSelector('.et_pb_text_inner h4 strong, h4 strong', { 
      timeout: 20000,
      visible: true 
    });
  } catch (err) {
    console.log('Category headers not found, trying alternative selector...');
    await page.waitForSelector('h4, .et_pb_text', { timeout: 10000 }).catch(() => {});
  }
  
  await delay(2000); // Wait for dynamic content to load
  
  // Extract exhibitor data from the page
  const exhibitorsData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Find all category sections - look for h4 with strong tags
    const categoryHeaders = document.querySelectorAll('.et_pb_text_inner h4 strong, h4 strong');
    
    categoryHeaders.forEach(header => {
      try {
        const categoryName = header.textContent?.trim() || '';
        if (!categoryName) return;
        
        // Find the parent h4 element
        const h4Element = header.closest('h4') || header.parentElement;
        if (!h4Element) return;
        
        // Find the next sibling paragraph that contains company names
        let currentElement = h4Element.nextElementSibling;
        while (currentElement) {
          // Look for paragraph tags
          if (currentElement.tagName === 'P') {
            const paragraph = currentElement;
            const htmlContent = paragraph.innerHTML || '';
            
            // Split by <br> or <br/> tags to get individual company names
            const companyNames = htmlContent
              .split(/<br\s*\/?>/i)
              .map(name => {
                // Create a temporary div to decode HTML entities
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = name.trim();
                return tempDiv.textContent || tempDiv.innerText || '';
              })
              .map(name => name.trim())
              .filter(name => {
                // Filter out empty strings, non-breaking spaces, and invalid entries
                return name && 
                       name.length > 1 && 
                       name.length < 200 &&
                       name !== '&nbsp;' &&
                       !name.match(/^\s*$/) &&
                       !seen.has(`${categoryName}-${name.toLowerCase()}`);
              });
            
            // Add each company name to results
            companyNames.forEach(companyName => {
              const uniqueKey = `${categoryName}-${companyName.toLowerCase()}`;
              seen.add(uniqueKey);
              results.push({
                companyName,
                category: categoryName
              });
            });
            
            // Break after finding the first paragraph (company list)
            break;
          }
          
          // If we hit another h4, we've moved to the next category
          if (currentElement.tagName === 'H4') {
            break;
          }
          
          currentElement = currentElement.nextElementSibling;
        }
      } catch (err) {
        console.error('Error extracting category data:', err);
      }
    });
    
    // Alternative method: if no results, try finding all paragraphs with company lists
    if (results.length === 0) {
      const allParagraphs = document.querySelectorAll('.et_pb_text_inner p, .et_pb_text p');
      let currentCategory = '';
      
      allParagraphs.forEach(paragraph => {
        // Check if there's a category header before this paragraph
        let prevElement = paragraph.previousElementSibling;
        while (prevElement) {
          if (prevElement.tagName === 'H4') {
            const strongTag = prevElement.querySelector('strong');
            if (strongTag) {
              currentCategory = strongTag.textContent?.trim() || '';
            }
            break;
          }
          prevElement = prevElement.previousElementSibling;
        }
        
        const htmlContent = paragraph.innerHTML || '';
        const companyNames = htmlContent
          .split(/<br\s*\/?>/i)
          .map(name => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = name.trim();
            return tempDiv.textContent || tempDiv.innerText || '';
          })
          .map(name => name.trim())
          .filter(name => {
            return name && 
                   name.length > 1 && 
                   name.length < 200 &&
                   name !== '&nbsp;' &&
                   !name.match(/^\s*$/) &&
                   !seen.has(`${currentCategory}-${name.toLowerCase()}`);
          });
        
        companyNames.forEach(companyName => {
          const uniqueKey = `${currentCategory}-${companyName.toLowerCase()}`;
          seen.add(uniqueKey);
          results.push({
            companyName,
            category: currentCategory || 'Unknown'
          });
        });
      });
    }
    
    return results;
  });

  console.log(`Extracted ${exhibitorsData.length} exhibitors from Surf Expo`);

  exhibitorsData.forEach(item => {
    exhibitors.push({
      companyName: item.companyName,
      category: item.category || '',
      website: '', // Surf Expo doesn't provide websites in the list
      source: 'surfexpo'
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
  if (pageType === 'smallworldlabs') maxPages = 100; // Can have many pages (e.g., Surf Expo has 50+ pages)
  if (pageType === 'manifest') maxPages = 20; // Multiple sections
  
  let pageCount = 0;
  
  while (pageCount < maxPages) {
    try {
      // For SmallWorldLabs, check for pagination buttons
      if (pageType === 'smallworldlabs') {
        const paginationInfo = await page.evaluate(() => {
          // Look for pagination controls - SmallWorldLabs uses .pagination.paginator-pagination
          const pagination = document.querySelector('.pagination.paginator-pagination, .pagination, [class*="pagination"]');
          if (!pagination) return { hasNext: false, currentPage: 1, totalPages: 0, nextPageNum: null };
          
          // Find current page - it's a span (not clickable), other pages are <a> tags
          const currentPageSpan = pagination.querySelector('span.pager-num, span[class*="pager-num"], span.pager-item');
          let currentPage = 1;
          if (currentPageSpan) {
            const pageText = currentPageSpan.textContent?.trim();
            const pageMatch = pageText.match(/\d+/);
            if (pageMatch) {
              currentPage = parseInt(pageMatch[0]) || 1;
            }
          } else {
            // Fallback: find active page by class
            const activePage = pagination.querySelector('.active, [class*="active"], .current, [class*="current"]');
            if (activePage) {
              const pageText = activePage.textContent?.trim();
              const pageMatch = pageText.match(/\d+/);
              if (pageMatch) {
                currentPage = parseInt(pageMatch[0]) || 1;
              }
            }
          }
          
          // Find all page number links (exclude spans which are current page)
          const pageLinks = Array.from(pagination.querySelectorAll('a.pager-num, a[class*="pager-num"], a.pager-item'));
          
          // Find next page button - look for .pager-right-next or next page number link
          let nextButton = null;
          let nextPageNum = currentPage + 1;
          
          // Strategy 1: Look for next page number link (currentPage + 1) - this is most reliable
          for (const link of pageLinks) {
            const pageText = link.textContent?.trim();
            const pageMatch = pageText.match(/\d+/);
            if (pageMatch) {
              const pageNum = parseInt(pageMatch[0]);
              if (pageNum === nextPageNum && link.offsetParent !== null && !link.disabled) {
                nextButton = link;
                break;
              }
            }
          }
          
          // Strategy 2: Look for explicit "Next Page" button with aria-label containing "Next Page"
          if (!nextButton) {
            const nextPageBtn = pagination.querySelector('a[aria-label*="Next Page" i], a.pager-right-next, a[class*="pager-right-next"]');
            if (nextPageBtn && nextPageBtn.offsetParent !== null && !nextPageBtn.disabled && 
                !nextPageBtn.classList.contains('disabled')) {
              nextButton = nextPageBtn;
            }
          }
          
          // Strategy 3: Look for ">" arrow button (pager-right-next)
          if (!nextButton) {
            const arrowBtn = pagination.querySelector('a.pager-right-next.pager-item');
            if (arrowBtn && arrowBtn.offsetParent !== null && !arrowBtn.disabled &&
                !arrowBtn.classList.contains('disabled')) {
              nextButton = arrowBtn;
            }
          }
          
          // Calculate total pages from visible page numbers
          const allPageNumbers = Array.from(pagination.querySelectorAll('.pager-num, [class*="pager-num"], .pager-item'))
            .map(el => {
              const text = el.textContent?.trim();
              const match = text?.match(/\d+/);
              return match ? parseInt(match[0]) : null;
            })
            .filter(num => num !== null && !isNaN(num));
          const totalPages = allPageNumbers.length > 0 ? Math.max(...allPageNumbers) : 0;
          
          return { 
            hasNext: !!nextButton, 
            currentPage, 
            totalPages,
            nextPageNum,
            nextButtonText: nextButton ? nextButton.textContent?.trim() : null 
          };
        });
        
        if (!paginationInfo.hasNext) {
          console.log(`No more pages found. Scraped up to page ${paginationInfo.currentPage}${paginationInfo.totalPages > 0 ? ` of ${paginationInfo.totalPages}` : ''}`);
          break;
        }
        
        console.log(`Found pagination, navigating to page ${paginationInfo.nextPageNum}${paginationInfo.totalPages > 0 ? ` of ${paginationInfo.totalPages}` : ''}...`);
        
        // Try to click next button - use multiple strategies
        try {
          const clicked = await page.evaluate((currentPage, nextPageNum) => {
            const pagination = document.querySelector('.pagination.paginator-pagination, .pagination, [class*="pagination"]');
            if (!pagination) return false;
            
            // Strategy 1: Click next page number link (most reliable)
            const pageLinks = Array.from(pagination.querySelectorAll('a.pager-num, a[class*="pager-num"], a.pager-item'));
            for (const link of pageLinks) {
              const pageText = link.textContent?.trim();
              const pageMatch = pageText.match(/\d+/);
              if (pageMatch) {
                const pageNum = parseInt(pageMatch[0]);
                if (pageNum === nextPageNum && link.offsetParent !== null && !link.disabled &&
                    !link.classList.contains('disabled')) {
                  link.click();
                  return true;
                }
              }
            }
            
            // Strategy 2: Click "Next Page" button with aria-label
            const nextPageBtn = pagination.querySelector('a[aria-label*="Next Page" i], a.pager-right-next, a[class*="pager-right-next"]');
            if (nextPageBtn && nextPageBtn.offsetParent !== null && !nextPageBtn.disabled &&
                !nextPageBtn.classList.contains('disabled')) {
              nextPageBtn.click();
              return true;
            }
            
            // Strategy 3: Click ">" arrow button
            const arrowBtn = pagination.querySelector('a.pager-right-next.pager-item');
            if (arrowBtn && arrowBtn.offsetParent !== null && !arrowBtn.disabled &&
                !arrowBtn.classList.contains('disabled')) {
              arrowBtn.click();
              return true;
            }
            
            return false;
          }, paginationInfo.currentPage, paginationInfo.nextPageNum);
          
          if (clicked) {
            // Wait for page to load - SmallWorldLabs uses JavaScript navigation
            await delay(4000); // Wait for JavaScript to execute
            // Wait for table to reload and content to change
            try {
              // Wait for pagination to update (current page should change)
              await page.waitForFunction(
                (expectedPage) => {
                  const pagination = document.querySelector('.pagination.paginator-pagination');
                  if (!pagination) return false;
                  const currentPageSpan = pagination.querySelector('span.pager-num, span[class*="pager-num"], span.pager-item');
                  if (currentPageSpan) {
                    const pageText = currentPageSpan.textContent?.trim();
                    const pageMatch = pageText.match(/\d+/);
                    return pageMatch && parseInt(pageMatch[0]) === expectedPage;
                  }
                  return false;
                },
                { timeout: 20000 },
                paginationInfo.nextPageNum
              );
            } catch (e) {
              console.log('Pagination update check timeout, waiting for table...');
            }
            
            // Wait for table to reload
            try {
              await page.waitForSelector('table.table tbody tr, .generic-table-wrapper tbody tr', { 
                timeout: 20000,
                visible: true 
              });
            } catch (e) {
              console.log('Table reload timeout, continuing anyway...');
            }
            await delay(2000); // Extra wait for content to stabilize
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
      case 'wpma':
        moreExhibitors = await scrapeWPMA(page);
        break;
      case 'surfexpo':
        moreExhibitors = await scrapeSurfExpo(page);
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


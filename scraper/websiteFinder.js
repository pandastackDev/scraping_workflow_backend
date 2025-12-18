import axios from 'axios';

/**
 * Find company website using combination approach:
 * 1. Try pattern matching first (free, fast)
 * 2. Fall back to Google Custom Search API if needed
 * @param {string} companyName - The company name to search for
 * @param {object} _existingPage - Not used, kept for compatibility
 * @returns {Promise<string>} - The website URL if found, empty string otherwise
 */
export async function findCompanyWebsite(companyName, _existingPage = null) {
  if (!companyName || companyName.trim().length < 2) {
    return '';
  }

  try {
    // Clean company name
    const cleanName = companyName.trim();
    
    // Step 1: Try pattern matching first (free, fast)
    const patternUrl = await findCompanyUrl(cleanName);
    if (patternUrl) {
      console.log(`  ✓ Found via pattern matching: ${patternUrl}`);
      return patternUrl;
    }
    
    // Step 2: Fall back to Google API search
    const apiUrl = await findCompanyUrlGoogle(cleanName);
    if (apiUrl) {
      console.log(`  ✓ Found via Google API: ${apiUrl}`);
      return apiUrl;
    }
    
    return '';
  } catch (err) {
    console.error(`Error finding website for ${companyName}:`, err.message);
    return '';
  }
}

/**
 * Combination approach: Try pattern matching first, then API
 * @param {string} companyName - The company name to search for
 * @returns {Promise<string|null>} - The website URL if found, null otherwise
 */
async function findCompanyUrl(companyName) {
  // Try pattern matching first (free)
  const patterns = generateUrlPatterns(companyName);
  for (const url of patterns) {
    if (await checkUrlExists(url)) {
      return url;
    }
  }
  
  // Pattern matching failed, will fall back to API in main function
  return null;
}

/**
 * Generate common URL patterns from company name
 * @param {string} companyName - The company name
 * @returns {string[]} - Array of potential URLs
 */
function generateUrlPatterns(companyName) {
  const clean = companyName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
  
  if (!clean || clean.length < 2) {
    return [];
  }
  
  const variations = [
    clean.replace(/\s+/g, ''),           // "CompanyName"
    clean.replace(/\s+/g, '-'),            // "company-name"
    clean.replace(/\s+/g, ''),             // "companyname"
    clean.split(/\s+/)[0],                // First word only
  ];
  
  // Remove duplicates
  const uniqueVariations = [...new Set(variations)];
  
  const urls = [];
  for (const variant of uniqueVariations) {
    if (variant && variant.length >= 2) {
      urls.push(`https://${variant}.com`);
      urls.push(`https://www.${variant}.com`);
    }
  }
  
  return urls;
}

/**
 * Check if a URL exists and is accessible
 * @param {string} url - The URL to check
 * @returns {Promise<boolean>} - True if URL exists and is accessible
 */
async function checkUrlExists(url) {
  try {
    const response = await axios.head(url, {
      timeout: 5000, // 5 second timeout
      maxRedirects: 5,
      validateStatus: (status) => {
        // Accept 2xx and 3xx status codes (success and redirects)
        return status >= 200 && status < 400;
      }
    });
    
    // If we get a successful response, the URL exists
    return response.status >= 200 && response.status < 400;
  } catch (_error) {
    // URL doesn't exist or is not accessible
    return false;
  }
}

/**
 * Find company URL using Google Custom Search API
 * @param {string} companyName - The company name to search for
 * @returns {Promise<string|null>} - The website URL if found, null otherwise
 */
async function findCompanyUrlGoogle(companyName) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  // Check if API credentials are configured
  if (!apiKey || !searchEngineId) {
    console.warn('Google API credentials not configured. Skipping API search.');
    return null;
  }

  try {
    const searchQuery = `${companyName} official website`;
    
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: apiKey,
        cx: searchEngineId,
        q: searchQuery,
        num: 5 // Get top 5 results to find the best match
      },
      timeout: 10000 // 10 second timeout
    });

    if (response.data.items && response.data.items.length > 0) {
      // Score and filter results to find the best match
      const companyLower = companyName.toLowerCase();
      const companyWords = companyLower.split(/\s+/).filter(w => w.length > 2);
      
      const scoredResults = [];
      
      for (const item of response.data.items) {
        try {
          const url = item.link;
          const title = (item.title || '').toLowerCase();
          const snippet = (item.snippet || '').toLowerCase();
          
          // Skip social media and non-official sites
          const skipDomains = [
            'facebook.com',
            'twitter.com',
            'linkedin.com',
            'instagram.com',
            'youtube.com',
            'pinterest.com',
            'tiktok.com',
            'reddit.com',
            'wikipedia.org',
            'crunchbase.com',
            'bloomberg.com',
            'google.com',
            'youtube.com'
          ];
          
          let shouldSkip = false;
          for (const domain of skipDomains) {
            if (url.includes(domain)) {
              shouldSkip = true;
              break;
            }
          }
          if (shouldSkip) continue;

          // Parse domain
          let domain = '';
          try {
            const urlObj = new URL(url);
            domain = urlObj.hostname.replace('www.', '').toLowerCase();
          } catch (_e) {
            continue;
          }

          // Calculate relevance score
          let score = 0;
          
          // Higher score if company name words appear in domain
          for (const word of companyWords) {
            if (domain.includes(word)) {
              score += 10; // High score for domain match
            }
            if (title.includes(word)) {
              score += 5; // Medium score for title match
            }
            if (snippet.includes(word)) {
              score += 2; // Low score for snippet match
            }
          }
          
          // Bonus for common TLDs (more likely to be official site)
          if (domain.endsWith('.com') || domain.endsWith('.net') || domain.endsWith('.org')) {
            score += 3;
          }
          
          // Penalty for subdomains that aren't www (might be blog, shop, etc.)
          const parts = domain.split('.');
          if (parts.length > 2 && parts[0] !== 'www') {
            score -= 2;
          }
          
          // Penalty for deep paths (prefer root domain)
          const pathDepth = url.split('/').length;
          if (pathDepth > 4) {
            score -= 1;
          }
          
          // Check for "official" indicators
          if (title.includes('official') || snippet.includes('official') || 
              title.includes('homepage') || snippet.includes('homepage')) {
            score += 5;
          }
          
          if (score > 0) {
            scoredResults.push({ url, score, domain });
          }
        } catch (_e) {
          continue;
        }
      }
      
      // Sort by score (highest first) and return the best match
      scoredResults.sort((a, b) => b.score - a.score);
      
      if (scoredResults.length > 0 && scoredResults[0].score >= 5) {
        return scoredResults[0].url;
      }
      
      // Fallback: return first result if no good match found
      if (response.data.items.length > 0) {
        return response.data.items[0].link;
      }
    }
    
    return null;
  } catch (error) {
    // Handle API errors gracefully
    if (error.response) {
      // API returned an error response
      if (error.response.status === 429) {
        console.warn('Google API rate limit exceeded. Skipping API search.');
      } else if (error.response.status === 403) {
        console.warn('Google API access forbidden. Check API key and search engine ID.');
      } else {
        console.warn(`Google API error: ${error.response.status} - ${error.response.statusText}`);
      }
    } else if (error.request) {
      // Request was made but no response received
      console.warn('Google API request timeout or network error.');
    } else {
      // Something else happened
      console.warn(`Google API error: ${error.message}`);
    }
    return null;
  }
}

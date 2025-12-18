import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { scrapeExhibitors } from './scraper/scraper.js';
import { exportToExcel } from './utils/excelExporter.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration to allow frontend on Vercel and local dev
const allowedOrigins = [
  'https://scraping-workflow.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser tools / server-side calls with no origin
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
  })
);

// Explicit preflight handlers for API routes
app.options('/api/scrape', cors());
app.options('/api/export', cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Exhibitor Scraper API is running' });
});

// Test endpoint
app.post('/api/test', async (req, res) => {
  try {
    res.json({ 
      success: true, 
      message: 'Test endpoint working',
      body: req.body 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main scraping endpoint with real-time updates via SSE
app.post('/api/scrape', async (req, res) => {
  // Check if client wants real-time updates
  const useStreaming = req.headers.accept?.includes('text/event-stream') || req.body.stream === true;
  
  if (useStreaming) {
    // Set up Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    
    try {
      const { url, options = {} } = req.body;

      if (!url) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'URL is required' })}\n\n`);
        res.end();
        return;
      }

      console.log(`Starting streaming scrape for: ${url}`);
      
      // Set default options
      const scrapeOptions = {
        findWebsites: options.findWebsites !== undefined ? options.findWebsites : false,
        maxWebsiteSearches: options.maxWebsiteSearches || 10,
        handlePagination: options.handlePagination === true,
        onProgress: (data) => {
          // Send progress update to client
          res.write(`data: ${JSON.stringify({ type: 'progress', ...data })}\n\n`);
        },
        onExhibitorFound: (exhibitor) => {
          // Send each exhibitor as it's found
          res.write(`data: ${JSON.stringify({ type: 'exhibitor', exhibitor })}\n\n`);
        },
        ...options
      };
      
      // Send start message
      res.write(`data: ${JSON.stringify({ type: 'start', url })}\n\n`);
      
      const results = await scrapeExhibitors(url, scrapeOptions);
      
      // Send completion message
      res.write(`data: ${JSON.stringify({ type: 'complete', count: results.length })}\n\n`);
      res.end();
    } catch (error) {
      console.error('Scraping error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || 'Unknown error occurred' })}\n\n`);
      res.end();
    }
  } else {
    // Original non-streaming endpoint
    try {
      const { url, options = {} } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      console.log(`Starting scrape for: ${url}`);
      console.log(`Options:`, JSON.stringify(options));
      
      const scrapeOptions = {
        findWebsites: options.findWebsites !== undefined ? options.findWebsites : false,
        maxWebsiteSearches: options.maxWebsiteSearches || 10,
        handlePagination: options.handlePagination === true,
        ...options
      };
      
      console.log(`Scrape options:`, JSON.stringify(scrapeOptions));
      
      const results = await scrapeExhibitors(url, scrapeOptions);
      
      console.log(`Scraping completed. Found ${results.length} exhibitors.`);
      
      if (!Array.isArray(results)) {
        throw new Error('Scraper returned invalid data format');
      }
      
      res.json({
        success: true,
        data: results,
        count: results.length
      });
    } catch (error) {
      console.error('Scraping error:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      res.status(500).json({
        success: false,
        error: error.message || 'Unknown error occurred',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
});

// Export to Excel endpoint
app.post('/api/export', async (req, res) => {
  try {
    const { data, filename = 'exhibitors' } = req.body;

    if (!data || !Array.isArray(data)) {
      return res.status(400).json({ error: 'Data array is required' });
    }

    const buffer = await exportToExcel(data, filename);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Only start the server if not running as a Vercel serverless function
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

// Export the app for Vercel serverless functions
export default app;


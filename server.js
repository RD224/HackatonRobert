require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// High payload limit configuration to support high-resolution Base64 images (up to 25MB)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(cors());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Check status of API keys configuration
app.get('/api/config-status', (req, res) => {
  const roboflowConfigured = Boolean(
    process.env.ROBOFLOW_API_KEY && 
    process.env.ROBOFLOW_API_KEY !== 'your_roboflow_api_key_here' &&
    process.env.ROBOFLOW_API_KEY !== 'tu_roboflow_api_key_aqui'
  );
  const rapidApiConfigured = Boolean(
    process.env.RAPIDAPI_KEY && 
    process.env.RAPIDAPI_KEY !== 'your_rapidapi_key_here' &&
    process.env.RAPIDAPI_KEY !== 'tu_rapidapi_key_aqui'
  );

  res.json({
    roboflowConfigured,
    rapidApiConfigured,
    ready: roboflowConfigured && rapidApiConfigured
  });
});

// Main Endpoint: Image analysis and chained API pipeline
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided in request payload (imageBase64 is required).'
      });
    }

    const roboflowKey = process.env.ROBOFLOW_API_KEY;
    const rapidApiKey = process.env.RAPIDAPI_KEY;

    // Check credentials readiness
    const isRoboflowMock = !roboflowKey || 
      roboflowKey === 'your_roboflow_api_key_here' || 
      roboflowKey === 'tu_roboflow_api_key_aqui';
      
    const isRapidApiMock = !rapidApiKey || 
      rapidApiKey === 'your_rapidapi_key_here' || 
      rapidApiKey === 'tu_rapidapi_key_aqui';

    if (isRoboflowMock || isRapidApiMock) {
      console.warn('⚠️ One or more API Keys are not configured in .env. Running in Demo Mode.');
    }

    // 1. Clean Base64 (strip data:image/...;base64, prefixes)
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim();

    // -------------------------------------------------------------
    // STEP 1: Inference with Roboflow (API 1)
    // -------------------------------------------------------------
    let roboflowData = null;
    let predictions = [];

    if (!isRoboflowMock) {
      try {
        const roboflowUrl = `https://serverless.roboflow.com/fruits-and-vegetables-yz9mm/1?api_key=${roboflowKey}`;
        
        const roboflowResponse = await axios.post(
          roboflowUrl,
          cleanBase64,
          {
            headers: {
              'Authorization': `Bearer ${roboflowKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 20000 // 20s timeout
          }
        );

        roboflowData = roboflowResponse.data;
        predictions = Array.isArray(roboflowData?.predictions) ? roboflowData.predictions : [];
      } catch (roboflowError) {
        console.error('❌ Error in Roboflow Inference API:', roboflowError.response?.data || roboflowError.message);
        return res.status(502).json({
          success: false,
          error: 'Failed to communicate with Roboflow Inference API.',
          details: roboflowError.response?.data || roboflowError.message
        });
      }
    } else {
      // Mock / Demo Fallback Mode
      console.log('ℹ️ Using mock detection (configure ROBOFLOW_API_KEY in .env for live mode)');
      predictions = [
        { x: 320, y: 240, width: 220, height: 210, class: 'apple', confidence: 0.94 },
        { x: 550, y: 280, width: 190, height: 180, class: 'banana', confidence: 0.89 }
      ];
    }

    // Extract unique normalized ingredient classes in lowercase
    const rawIngredients = predictions.map(p => (p.class ? p.class.toLowerCase().trim() : '')).filter(Boolean);
    const uniqueIngredients = [...new Set(rawIngredients)];

    // If no ingredients detected
    if (uniqueIngredients.length === 0) {
      return res.json({
        success: true,
        predictions: [],
        ingredients: [],
        recipes: [],
        message: 'No fruits or vegetables detected in image. Please try a closer angle or better lighting.',
        processingTimeMs: Date.now() - startTime
      });
    }

    // -------------------------------------------------------------
    // STEP 2: Chaining with RapidAPI Spoonacular (API 2)
    // -------------------------------------------------------------
    let recipes = [];

    if (!isRapidApiMock) {
      try {
        const ingredientsParam = encodeURIComponent(uniqueIngredients.join(','));
        const spoonacularUrl = `https://spoonacular-recipe-food-nutrition-v1.p.rapidapi.com/recipes/findByIngredients?ingredients=${ingredientsParam}&number=6&ranking=1&ignorePantry=true`;

        const rapidApiResponse = await axios.get(spoonacularUrl, {
          headers: {
            'x-rapidapi-key': rapidApiKey,
            'x-rapidapi-host': 'spoonacular-recipe-food-nutrition-v1.p.rapidapi.com'
          },
          timeout: 15000
        });

        recipes = Array.isArray(rapidApiResponse.data) ? rapidApiResponse.data : [];
      } catch (rapidApiError) {
        console.error('❌ Error in Spoonacular RapidAPI:', rapidApiError.response?.data || rapidApiError.message);
        return res.status(502).json({
          success: false,
          error: 'Failed to query Spoonacular on RapidAPI with detected ingredients.',
          details: rapidApiError.response?.data || rapidApiError.message,
          predictions,
          ingredients: uniqueIngredients
        });
      }
    } else {
      // Mock / Demo Fallback Mode
      recipes = [
        {
          id: 632660,
          title: 'Apple & Banana Cinnamon Oatmeal Bowl',
          image: 'https://img.spoonacular.com/recipes/632660-312x231.jpg',
          usedIngredientCount: 2,
          missedIngredientCount: 1,
          likes: 42,
          usedIngredients: [
            { original: '1 fresh sliced apple', name: 'apple' },
            { original: '1 ripe banana', name: 'banana' }
          ],
          missedIngredients: [
            { original: '1/2 cup rolled oats', name: 'rolled oats' }
          ]
        },
        {
          id: 715538,
          title: 'Fruit Salad with Honey Lime Glaze',
          image: 'https://img.spoonacular.com/recipes/715538-312x231.jpg',
          usedIngredientCount: 2,
          missedIngredientCount: 2,
          likes: 128,
          usedIngredients: [
            { original: '2 diced apples', name: 'apple' },
            { original: '2 sliced bananas', name: 'banana' }
          ],
          missedIngredients: [
            { original: '1 tablespoon honey', name: 'honey' },
            { original: '1 fresh lime', name: 'lime' }
          ]
        },
        {
          id: 641803,
          title: 'Morning Energy Green Smoothie with Banana',
          image: 'https://img.spoonacular.com/recipes/641803-312x231.jpg',
          usedIngredientCount: 2,
          missedIngredientCount: 2,
          likes: 85,
          usedIngredients: [
            { original: '1 green apple', name: 'apple' },
            { original: '1 frozen banana', name: 'banana' }
          ],
          missedIngredients: [
            { original: '1 cup baby spinach', name: 'spinach' },
            { original: '1 cup almond milk', name: 'almond milk' }
          ]
        }
      ];
    }

    // -------------------------------------------------------------
    // CONSOLIDATED RESPONSE
    // -------------------------------------------------------------
    const responsePayload = {
      success: true,
      predictions,
      ingredients: uniqueIngredients,
      recipes,
      stats: {
        detectedCount: uniqueIngredients.length,
        boundingBoxesCount: predictions.length,
        recipesFound: recipes.length,
        processingTimeMs: Date.now() - startTime
      },
      meta: {
        isDemoMode: isRoboflowMock || isRapidApiMock
      }
    };

    return res.json(responsePayload);

  } catch (globalError) {
    console.error('💥 Unhandled error in /api/analyze:', globalError);
    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing image.',
      details: globalError.message || 'Unexpected error'
    });
  }
});

// Export app for Vercel Serverless Functions
module.exports = app;

// Start Server locally if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🥑 Smart Chef / Food Scanner started successfully`);
    console.log(`🚀 Server running on: http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}


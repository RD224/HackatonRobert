require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// High payload limit configuration to support high-resolution Base64 images (up to 25MB)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(cors());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper to sanitize and retrieve API Keys from environment
const getGeminiKey = () => (
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
  process.env.gemini_api_key ||
  ''
).trim().replace(/^['"]|['"]$/g, '');

const getRoboflowKey = () => (
  process.env.ROBOFLOW_API_KEY || 
  process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY ||
  process.env.ROBOFLOW_KEY || 
  process.env.roboflow_api_key || 
  ''
).trim().replace(/^['"]|['"]$/g, '');

const getRapidApiKey = () => (
  process.env.RAPIDAPI_KEY || 
  process.env.NEXT_PUBLIC_RAPIDAPI_KEY ||
  process.env.RAPID_API_KEY || 
  process.env.rapidapi_key || 
  ''
).trim().replace(/^['"]|['"]$/g, '');

// Check status of API keys configuration
app.get('/api/config-status', (req, res) => {
  const geminiKey = getGeminiKey();
  const roboflowKey = getRoboflowKey();
  const rapidApiKey = getRapidApiKey();

  const geminiConfigured = Boolean(
    geminiKey && 
    geminiKey !== 'your_gemini_api_key_here' &&
    geminiKey !== 'tu_gemini_api_key_aqui' &&
    geminiKey.length > 10
  );
  const roboflowConfigured = Boolean(
    roboflowKey && 
    roboflowKey !== 'your_roboflow_api_key_here' &&
    roboflowKey !== 'tu_roboflow_api_key_aqui'
  );
  const rapidApiConfigured = Boolean(
    rapidApiKey && 
    rapidApiKey !== 'your_rapidapi_key_here' &&
    rapidApiKey !== 'tu_rapidapi_key_aqui'
  );

  const activeVision = geminiConfigured ? 'gemini' : (roboflowConfigured ? 'roboflow' : 'demo');

  res.json({
    geminiConfigured,
    roboflowConfigured,
    rapidApiConfigured,
    activeVision,
    ready: (geminiConfigured || roboflowConfigured) && rapidApiConfigured,
    missing: [
      !geminiConfigured && !roboflowConfigured ? 'GEMINI_API_KEY or ROBOFLOW_API_KEY' : null,
      !rapidApiConfigured ? 'RAPIDAPI_KEY' : null
    ].filter(Boolean)
  });
});

// Helper: Detect fruits/vegetables using Google Gemini Vision
async function detectWithGemini(cleanBase64, mimeType = 'image/jpeg', imageWidth = 800, imageHeight = 600, geminiKey) {
  const genAI = new GoogleGenerativeAI(geminiKey);
  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];

  const prompt = `You are an expert food vision AI.
Identify all fresh fruits, vegetables, and culinary food items present in this image.
For each item detected:
1. Provide its standard English culinary name (singular, lowercase, e.g. "apple", "banana", "tomato", "carrot", "broccoli", "lemon", "orange", "spinach", "cucumber").
2. Provide an estimated confidence score between 0.85 and 0.99.
3. Provide the bounding box "box_2d" as [ymin, xmin, ymax, xmax] normalized on a 0 to 1000 integer scale.

Respond ONLY with valid JSON in this exact structure:
{
  "ingredients": ["apple", "banana"],
  "predictions": [
    {
      "class": "apple",
      "confidence": 0.96,
      "box_2d": [120, 200, 480, 550]
    }
  ]
}
If no fruits or vegetables are visible, return {"ingredients": [], "predictions": []}.`;

  const imagePart = {
    inlineData: {
      data: cleanBase64,
      mimeType: mimeType || 'image/jpeg'
    }
  };

  let parsed = null;
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });
      const result = await model.generateContent([prompt, imagePart]);
      const text = result.response.text();
      parsed = JSON.parse(text);
      if (parsed) break;
    } catch (err) {
      lastError = err;
      console.warn(`Model ${modelName} unavailable (${err.message}), trying next...`);
    }
  }

  if (!parsed) {
    throw lastError || new Error('All Gemini vision models failed.');
  }

  const w = Number(imageWidth) || 800;
  const h = Number(imageHeight) || 600;

  const rawPredictions = Array.isArray(parsed.predictions) ? parsed.predictions : [];
  const predictions = rawPredictions.map(p => {
    let boxWidth = Math.round(w * 0.35);
    let boxHeight = Math.round(h * 0.35);
    let centerX = Math.round(w / 2);
    let centerY = Math.round(h / 2);

    if (Array.isArray(p.box_2d) && p.box_2d.length === 4) {
      const [ymin, xmin, ymax, xmax] = p.box_2d;
      boxWidth = Math.max(20, Math.round(((xmax - xmin) / 1000) * w));
      boxHeight = Math.max(20, Math.round(((ymax - ymin) / 1000) * h));
      centerX = Math.round(((xmin / 1000) * w) + (boxWidth / 2));
      centerY = Math.round(((ymin / 1000) * h) + (boxHeight / 2));
    }

    let confidence = Number(p.confidence) || 0.95;
    if (confidence > 1) {
      confidence = confidence > 100 ? confidence / 1000 : confidence / 100;
    }

    return {
      x: centerX,
      y: centerY,
      width: boxWidth,
      height: boxHeight,
      class: (p.class || '').toLowerCase().trim(),
      confidence: Math.min(0.99, Math.max(0.5, confidence))
    };
  }).filter(p => p.class);

  const rawIngredients = Array.isArray(parsed.ingredients) && parsed.ingredients.length > 0
    ? parsed.ingredients
    : predictions.map(p => p.class);

  const ingredients = [...new Set(rawIngredients.map(i => (i || '').toLowerCase().trim()).filter(Boolean))];

  return { predictions, ingredients };
}

// Helper: Generate chef-quality recipes specifically featuring the detected ingredients with Gemini
async function generateRecipesWithGemini(ingredients, geminiKey) {
  const genAI = new GoogleGenerativeAI(geminiKey);
  const modelsToTry = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];

  const prompt = `You are a world-class chef.
Create 4 delicious, realistic culinary recipes that prominently feature and celebrate these detected ingredients: ${ingredients.join(', ')}.
Each recipe MUST strictly use these detected ingredients as core components.

Return ONLY a JSON array with this exact structure:
[
  {
    "id": 1001,
    "title": "Mediterranean Dish Name",
    "image": "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&auto=format&fit=crop&q=80",
    "usedIngredientCount": 3,
    "missedIngredientCount": 2,
    "likes": 98,
    "summary": "Short 1-sentence appetizing description highlighting the fresh ingredients.",
    "instructions": [
      "Step 1: Wash and dice the fresh ingredients...",
      "Step 2: Toss in a bowl with olive oil and seasonings...",
      "Step 3: Plate and serve fresh."
    ],
    "usedIngredients": [
      {"name": "ingredient name", "original": "1 cup fresh sliced ingredient"}
    ],
    "missedIngredients": [
      {"name": "staple", "original": "1 tbsp olive oil or seasoning"}
    ]
  }
]`;

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3
        }
      });
      const res = await model.generateContent(prompt);
      const parsed = JSON.parse(res.response.text());
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (err) {
      console.warn(`Chef recipe model ${modelName} error (${err.message}), trying next...`);
    }
  }

  return [];
}

// Helper: Dynamic fallback recipes matching the detected ingredients
function generateDynamicMockRecipes(ingredients) {
  const mainIng = ingredients[0] || 'vegetables';
  const secondIng = ingredients[1] || 'fresh herbs';
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  return [
    {
      id: 9001,
      title: `Fresh Farmhouse ${cap(mainIng)} & ${cap(secondIng)} Medley`,
      image: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&auto=format&fit=crop&q=80',
      usedIngredientCount: ingredients.length,
      missedIngredientCount: 2,
      likes: 112,
      summary: `A vibrant dish celebrating crisp ${mainIng} and flavorful ${secondIng} tossed with light dressing.`,
      instructions: [
        `Rinse and prep your fresh ${ingredients.join(' and ')}.`,
        `Gently toss with a drizzle of olive oil, salt, and cracked pepper.`,
        `Serve fresh or lightly sautéed over medium heat for 5 minutes.`
      ],
      usedIngredients: ingredients.map(ing => ({ name: ing, original: `Fresh ${ing}` })),
      missedIngredients: [
        { name: 'olive oil', original: '1 tbsp extra virgin olive oil' },
        { name: 'sea salt', original: 'Pinch of sea salt' }
      ]
    },
    {
      id: 9002,
      title: `Artisanal Warm ${cap(mainIng)} Sauté with Garlic`,
      image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&auto=format&fit=crop&q=80',
      usedIngredientCount: Math.min(ingredients.length, 2),
      missedIngredientCount: 2,
      likes: 84,
      summary: `Comforting pan-sautéed ${mainIng} infused with garlic and aromatic kitchen herbs.`,
      instructions: [
        `Heat a skillet over medium heat with a touch of oil.`,
        `Add diced ${mainIng} and cook until golden tender.`,
        `Garnish with fresh herbs and serve immediately.`
      ],
      usedIngredients: ingredients.slice(0, 2).map(ing => ({ name: ing, original: `1 cup sliced ${ing}` })),
      missedIngredients: [
        { name: 'garlic', original: '2 minced garlic cloves' },
        { name: 'black pepper', original: 'Freshly ground pepper' }
      ]
    }
  ];
}

// Main Endpoint: Image analysis and chained API pipeline
app.post('/api/analyze', async (req, res) => {
  const startTime = Date.now();
  try {
    const { imageBase64, width = 800, height = 600 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image provided in request payload (imageBase64 is required).'
      });
    }

    const geminiKey = getGeminiKey();
    const roboflowKey = getRoboflowKey();
    const rapidApiKey = getRapidApiKey();

    const isGeminiAvailable = Boolean(
      geminiKey && 
      geminiKey !== 'your_gemini_api_key_here' && 
      geminiKey !== 'tu_gemini_api_key_aqui' && 
      geminiKey.length > 10
    );

    const isRoboflowAvailable = Boolean(
      roboflowKey && 
      roboflowKey !== 'your_roboflow_api_key_here' && 
      roboflowKey !== 'tu_roboflow_api_key_aqui'
    );

    const isRapidApiMock = !rapidApiKey || 
      rapidApiKey === 'your_rapidapi_key_here' || 
      rapidApiKey === 'tu_rapidapi_key_aqui';

    // 1. Detect mime type & clean Base64
    let mimeType = 'image/jpeg';
    const mimeMatch = imageBase64.match(/^data:(image\/[a-zA-Z0-9.+]+);base64,/);
    if (mimeMatch) {
      mimeType = mimeMatch[1];
    }
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+]+;base64,/, '').trim();

    // -------------------------------------------------------------
    // STEP 1: Computer Vision Inference (Gemini Vision -> Roboflow -> Demo)
    // -------------------------------------------------------------
    let predictions = [];
    let uniqueIngredients = [];
    let visionProviderUsed = 'demo';

    if (isGeminiAvailable) {
      // 🥇 PREFERRED: Google Gemini 1.5 Flash Vision
      try {
        console.log('⚡ Running Gemini 1.5 Flash Vision Detection...');
        const geminiResult = await detectWithGemini(cleanBase64, mimeType, width, height, geminiKey);
        predictions = geminiResult.predictions;
        uniqueIngredients = geminiResult.ingredients;
        visionProviderUsed = 'gemini';
        console.log(`✅ Gemini detected ${uniqueIngredients.length} ingredients:`, uniqueIngredients);
      } catch (geminiError) {
        console.error('⚠️ Gemini Vision failed, attempting Roboflow fallback:', geminiError.message);
      }
    }

    // 🥈 FALLBACK: Roboflow Serverless API (if Gemini was unavailable or failed)
    if (uniqueIngredients.length === 0 && isRoboflowAvailable && visionProviderUsed !== 'gemini') {
      try {
        console.log('🔄 Running Roboflow Serverless Inference...');
        // Added confidence=35 & overlap=30 for superior Non-Max Suppression
        const roboflowUrl = `https://serverless.roboflow.com/fruits-and-vegetables-yz9mm/1?api_key=${roboflowKey}&confidence=35&overlap=30`;
        
        const roboflowResponse = await axios.post(
          roboflowUrl,
          cleanBase64,
          {
            headers: {
              'Authorization': `Bearer ${roboflowKey}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 20000
          }
        );

        const roboflowData = roboflowResponse.data;
        predictions = Array.isArray(roboflowData?.predictions) ? roboflowData.predictions : [];
        const rawIngredients = predictions.map(p => (p.class ? p.class.toLowerCase().trim() : '')).filter(Boolean);
        uniqueIngredients = [...new Set(rawIngredients)];
        visionProviderUsed = 'roboflow';
      } catch (roboflowError) {
        console.error('❌ Roboflow API error:', roboflowError.response?.data || roboflowError.message);
      }
    }

    // 🥉 DEMO MODE FALLBACK (if both APIs are unconfigured or returned empty on demo preset)
    if (uniqueIngredients.length === 0 && !isGeminiAvailable && !isRoboflowAvailable) {
      console.log('ℹ️ Running in Smart Demo Mode (fallback mock ingredients)');
      predictions = [
        { x: 320, y: 240, width: 220, height: 210, class: 'apple', confidence: 0.96 },
        { x: 550, y: 280, width: 190, height: 180, class: 'banana', confidence: 0.94 }
      ];
      uniqueIngredients = ['apple', 'banana'];
      visionProviderUsed = 'demo';
    }

    // Extract ingredients if not yet set
    if (uniqueIngredients.length === 0 && predictions.length > 0) {
      uniqueIngredients = [...new Set(predictions.map(p => p.class.toLowerCase().trim()))];
    }

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
    // STEP 2: Chaining with RapidAPI Spoonacular + Gemini Chef Engine
    // -------------------------------------------------------------
    let recipes = [];

    // Prioritize top primary ingredients for optimal Spoonacular query
    const searchIngredients = uniqueIngredients.slice(0, 6);

    if (!isRapidApiMock) {
      try {
        const ingredientsParam = encodeURIComponent(searchIngredients.join(','));
        // ranking=2 prioritizes minimizing missing ingredients (recipes you can cook immediately)
        const spoonacularUrl = `https://spoonacular-recipe-food-nutrition-v1.p.rapidapi.com/recipes/findByIngredients?ingredients=${ingredientsParam}&number=8&ranking=2&ignorePantry=true`;

        const rapidApiResponse = await axios.get(spoonacularUrl, {
          headers: {
            'x-rapidapi-key': rapidApiKey,
            'x-rapidapi-host': 'spoonacular-recipe-food-nutrition-v1.p.rapidapi.com'
          },
          timeout: 12000
        });

        const rawRecipes = Array.isArray(rapidApiResponse.data) ? rapidApiResponse.data : [];

        // Strictly keep recipes that use at least 1 detected ingredient, sorted by highest matching ratio
        recipes = rawRecipes
          .filter(r => (r.usedIngredientCount || 0) > 0)
          .sort((a, b) => (b.usedIngredientCount - a.usedIngredientCount) || (a.missedIngredientCount - b.missedIngredientCount));

      } catch (rapidApiError) {
        console.warn('⚠️ Spoonacular RapidAPI limit or error, falling back to Gemini Chef:', rapidApiError.response?.data || rapidApiError.message);
      }
    }

    // If Spoonacular returned fewer than 3 recipes or failed, use Gemini AI Chef to create recipes strictly containing the detected ingredients
    if (recipes.length < 3 && isGeminiAvailable) {
      console.log('👨‍🍳 Using Gemini AI Chef to generate dishes featuring:', uniqueIngredients);
      const aiRecipes = await generateRecipesWithGemini(uniqueIngredients, geminiKey);
      if (aiRecipes.length > 0) {
        recipes = [...aiRecipes, ...recipes].slice(0, 6);
      }
    }

    // Dynamic fallback if offline and Gemini unavailable
    if (recipes.length === 0) {
      recipes = generateDynamicMockRecipes(uniqueIngredients);
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
        isDemoMode: visionProviderUsed === 'demo' || isRapidApiMock,
        visionProvider: visionProviderUsed
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


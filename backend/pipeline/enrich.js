'use strict';

const fs = require('fs');
const path = require('path');
const { reverseGeocode } = require('../utils/coords');

/**
 * Enrich OSM building data with LLM-generated architectural metadata.
 * If no LLM key is provided, this step is skipped entirely.
 *
 * Modifies the OSM JSON file in place, adding building:levels, building:material,
 * roof:shape, and roof:material tags to buildings that lack them.
 */
async function enrichBuildings(osmFile, bbox, options = {}, onProgress) {
  const { llmKey, llmProvider } = options;

  if (!llmKey) {
    if (onProgress) onProgress('No LLM key provided, skipping building enrichment');
    return { enriched: 0 };
  }

  if (onProgress) onProgress('Reading OSM data for building enrichment...');

  const raw = fs.readFileSync(osmFile, 'utf-8');
  const osm = JSON.parse(raw);

  // Extract buildings that need enrichment
  const buildings = (osm.elements || []).filter(
    (el) => el.tags && el.tags.building && !el.tags['building:levels']
  );

  if (buildings.length === 0) {
    if (onProgress) onProgress('No buildings need enrichment');
    return { enriched: 0 };
  }

  // Get regional context via reverse geocoding
  const centLat = (bbox[0] + bbox[2]) / 2;
  const centLng = (bbox[1] + bbox[3]) / 2;
  const region = await reverseGeocode(centLat, centLng);

  if (onProgress) onProgress(`Enriching ${buildings.length} buildings for region: ${region}`);

  // Prepare building summaries for the LLM (batch in groups of 50)
  const batchSize = 50;
  let totalEnriched = 0;

  for (let i = 0; i < buildings.length; i += batchSize) {
    const batch = buildings.slice(i, i + batchSize);
    const summaries = batch.map((b) => ({
      id: b.id,
      type: b.tags.building,
      name: b.tags.name || null,
      amenity: b.tags.amenity || null,
      shop: b.tags.shop || null,
    }));

    try {
      const enriched = await callLlm(summaries, region, llmKey, llmProvider);

      // Apply enrichments back to OSM data
      const enrichMap = new Map();
      for (const e of enriched) {
        enrichMap.set(e.id, e);
      }

      for (const building of batch) {
        const enrichment = enrichMap.get(building.id);
        if (enrichment) {
          if (enrichment.levels) building.tags['building:levels'] = String(enrichment.levels);
          if (enrichment.material) building.tags['building:material'] = enrichment.material;
          if (enrichment.roofShape) building.tags['roof:shape'] = enrichment.roofShape;
          if (enrichment.roofMaterial) building.tags['roof:material'] = enrichment.roofMaterial;
          totalEnriched++;
        }
      }
    } catch (err) {
      if (onProgress) onProgress(`LLM enrichment batch failed: ${err.message}. Continuing without.`);
    }
  }

  // Write enriched data back
  fs.writeFileSync(osmFile, JSON.stringify(osm, null, 2), 'utf-8');
  if (onProgress) onProgress(`Enriched ${totalEnriched} buildings with architectural metadata`);

  return { enriched: totalEnriched };
}

/**
 * Call the LLM API to get building enrichment data.
 */
async function callLlm(buildings, region, apiKey, provider) {
  const prompt = `You are enriching OpenStreetMap building data for Minecraft world generation.
For each building, add realistic building:levels, building:material, roof:shape, and roof:material tags based on the building type and geographic region.
Regional context: ${region}

Buildings to enrich:
${JSON.stringify(buildings, null, 2)}

Return a JSON array where each object has:
- id: the OSM element id
- levels: integer number of floors (1-50)
- material: one of brick, concrete, wood, stone, metal, glass
- roofShape: one of flat, gabled, hipped, pyramidal, dome, mansard, gambrel
- roofMaterial: one of tiles, slate, metal, thatch, concrete, asphalt

Return ONLY the JSON array, no explanation.`;

  const detectedProvider = provider || detectProvider(apiKey);

  if (detectedProvider === 'openai') {
    return callOpenAI(prompt, apiKey);
  } else if (detectedProvider === 'gemini') {
    return callGemini(prompt, apiKey);
  } else {
    throw new Error(`Unknown LLM provider: ${detectedProvider}`);
  }
}

function detectProvider(key) {
  if (key.startsWith('sk-')) return 'openai';
  if (key.startsWith('AI')) return 'gemini';
  return 'openai';
}

async function callOpenAI(prompt, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status}`);
  const data = await resp.json();
  const text = data.choices[0].message.content.trim();
  return parseJsonResponse(text);
}

async function callGemini(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
  });

  if (!resp.ok) throw new Error(`Gemini API error: ${resp.status}`);
  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text.trim();
  return parseJsonResponse(text);
}

function parseJsonResponse(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Scale building footprints for better visibility at small map scales.
 *
 * At 1:10 (scale=0.1), a 10m building becomes 1 block — invisible.
 * This scales each building's node coordinates outward from its centroid
 * by a factor, so buildings render at an effective larger scale while
 * staying at their correct terrain position.
 *
 * @param {string} osmFile - Path to OSM JSON file (modified in place)
 * @param {number} mapScale - The world scale (e.g. 0.1 for 1:10)
 * @param {number} targetBuildingScale - Desired effective building scale (e.g. 0.2 for 1:5)
 * @param {function} onProgress - Progress callback
 */
function scaleBuildingFootprints(osmFile, mapScale, targetBuildingScale, onProgress) {
  if (mapScale >= 0.5) {
    // Buildings are large enough at 1:2 and above
    if (onProgress) onProgress('Buildings large enough at this scale, no footprint scaling needed');
    return;
  }

  const scaleFactor = targetBuildingScale / mapScale; // e.g. 0.15/0.1 = 1.5
  if (scaleFactor <= 1.0) return;

  if (onProgress) onProgress(`Scaling building footprints ${scaleFactor}x for visibility...`);

  const raw = fs.readFileSync(osmFile, 'utf-8');
  const osm = JSON.parse(raw);

  // Build node lookup
  const nodeMap = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') nodeMap.set(el.id, el);
  }

  // Find buildings
  const buildings = osm.elements.filter(
    (el) => el.type === 'way' && el.tags && el.tags.building
  );

  let maxId = 0;
  for (const el of osm.elements) {
    if (el.type === 'node' && el.id > maxId) maxId = el.id;
  }

  const newNodes = [];
  let scaled = 0;

  for (const b of buildings) {
    const nodeIds = b.nodes || [];
    const coords = [];
    for (const nid of nodeIds) {
      const n = nodeMap.get(nid);
      if (n) coords.push({ lat: n.lat, lon: n.lon });
    }
    if (coords.length < 3) continue;

    // Centroid (exclude closing node if ring)
    const ring = (nodeIds[0] === nodeIds[nodeIds.length - 1] && coords.length > 1)
      ? coords.slice(0, -1) : coords;
    const cLat = ring.reduce((s, c) => s + c.lat, 0) / ring.length;
    const cLon = ring.reduce((s, c) => s + c.lon, 0) / ring.length;

    // Create new scaled nodes
    const newIds = [];
    for (const { lat, lon } of coords) {
      maxId++;
      newNodes.push({
        id: maxId, type: 'node',
        lat: cLat + (lat - cLat) * scaleFactor,
        lon: cLon + (lon - cLon) * scaleFactor,
      });
      newIds.push(maxId);
    }
    b.nodes = newIds;
    scaled++;
  }

  osm.elements.push(...newNodes);
  fs.writeFileSync(osmFile, JSON.stringify(osm), 'utf-8');

  if (onProgress) onProgress(`Scaled ${scaled} building footprints (${newNodes.length} new nodes)`);
}

module.exports = { enrichBuildings, scaleBuildingFootprints };

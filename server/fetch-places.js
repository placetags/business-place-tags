/**
 * fetch-places.js  (v4 — πλέγμα κάλυψης ολόκληρου νομού + recursive quadrant search)
 *
 * ΔΕΝ βασίζεται πια σε λίγα χειροκίνητα "σημεία εκκίνησης". Αντί γι' αυτό,
 * ορίζουμε το γεωγραφικό ορθογώνιο (bounding box) κάθε νομού, και το script
 * φτιάχνει αυτόματα ένα πλέγμα κύκλων που καλύπτει ΟΛΟΚΛΗΡΗ την επιφάνειά του
 * — άρα καμία απόσταση δεν μένει εκτός κάλυψης.
 *
 * Πάνω σε αυτό το πλέγμα, κάθε κύκλος που "γεμίζει" (60/60 αποτελέσματα)
 * σπάει περαιτέρω σε 4 μικρότερα (recursive quadrant search), για να μην
 * χάνεται τίποτα ούτε σε πυκνές περιοχές (κέντρα πόλεων).
 *
 * Κάθε μέρος με rating >= 4.8 παίρνει flag "featured": true.
 *
 * ΕΞΟΔΟΣ: places.json →  places[categoryKey][regionKey] = [{ name, desc, lat, lng, placeId, rating, featured }]
 *
 * ⚠️ ΚΟΣΤΟΣ/ΧΡΟΝΟΣ: Αυτή η έκδοση κάνει ΠΟΛΥ περισσότερα requests από τις
 * προηγούμενες (πλέγμα ολόκληρου νομού, όχι λίγα σημεία). Το script τυπώνει
 * ΠΡΩΤΑ πόσα σημεία πλέγματος θα ψάξει ανά περιοχή, πριν ξεκινήσει τα calls,
 * ώστε να έχεις μια εκτίμηση. Ξεκίνα δοκιμαστικά με μία μόνο περιοχή+κατηγορία.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!API_KEY) {
  console.error('❌ Λείπει το GOOGLE_PLACES_API_KEY στο .env αρχείο.');
  process.exit(1);
}

// ─── Ρυθμίσεις δοκιμής ────────────────────────────────────────────────
// Άλλαξε σε 'chania' κ.λπ. για ΜΟΝΟ μία περιοχή. null = όλες.
const RUN_ONLY_REGION = null;
// Άλλαξε σε 'cafe' κ.λπ. για ΜΟΝΟ μία κατηγορία. null = όλες.
const RUN_ONLY_CATEGORY = null;

// ─── Γεωγραφικά όρια (bounding box) κάθε νομού — προσεγγιστικά, καλύπτουν
// λίγο και θάλασσα γύρω γύρω, δεν πειράζει (απλά επιστρέφει 0 αποτελέσματα εκεί).
const regions = {
  irakleio: { label: 'Ηράκλειο', bbox: { south: 34.92, north: 35.47, west: 24.72, east: 25.72 } },
  chania:   { label: 'Χανιά',    bbox: { south: 35.15, north: 35.70, west: 23.50, east: 24.35 } },
  rethymno: { label: 'Ρέθυμνο',  bbox: { south: 35.05, north: 35.50, west: 24.15, east: 24.85 } },
  lasithi:  { label: 'Λασίθι',   bbox: { south: 34.90, north: 35.35, west: 25.45, east: 26.35 } },
};

// ─── Κατηγορίες
const categories = {
  cafe:   { googleType: 'cafe' },
  food:   { googleType: 'restaurant' },
  sights: { googleType: 'tourist_attraction' },
  fun:    { googleType: 'bar' },
  beach:  { googleType: 'tourist_attraction', keyword: 'beach παραλία' },
};

// ─── Ρυθμίσεις πλέγματος + αναδρομής
const GRID_RADIUS_METERS = 7000;      // ακτίνα κάθε αρχικού κύκλου του πλέγματος
const GRID_SPACING_FACTOR = 1.4;      // πόσο πυκνό είναι το πλέγμα (1.4×radius ≈ χωρίς κενά κάλυψης)
const MIN_RADIUS_METERS = 400;        // κάτω από αυτό, δεν σπάμε άλλο σε αναδρομή
const MAX_DEPTH = 6;                  // ασφαλιστική δικλείδα βάθους αναδρομής
const FEATURED_RATING_THRESHOLD = 4.8;

const DELAY_MS = 250;                 // παύση ανάμεσα σε διαφορετικά calls
const PAGE_TOKEN_DELAY_MS = 2200;     // υποχρεωτική αναμονή πριν λειτουργήσει next_page_token
const MAX_REQUESTS = 8000;            // ασφαλιστική δικλείδα συνολικών requests

let requestCount = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function metersToLatDegrees(m) {
  return m / 111320;
}
function metersToLngDegrees(m, atLat) {
  return m / (111320 * Math.cos((atLat * Math.PI) / 180));
}

/** Φτιάχνει πλέγμα σημείων που καλύπτει ολόκληρο το bounding box. */
function generateGrid(bbox, radiusMeters) {
  const points = [];
  const latStep = metersToLatDegrees(radiusMeters * GRID_SPACING_FACTOR);

  for (let lat = bbox.south; lat <= bbox.north; lat += latStep) {
    const lngStep = metersToLngDegrees(radiusMeters * GRID_SPACING_FACTOR, lat);
    for (let lng = bbox.west; lng <= bbox.east; lng += lngStep) {
      points.push({ lat, lng });
    }
  }
  return points;
}

/** Ένα Nearby Search call (μία σελίδα). */
async function nearbySearchPage(lat, lng, radiusMeters, categoryDef, pageToken) {
  if (requestCount >= MAX_REQUESTS) {
    throw new Error(`Έφτασε το όριο ασφαλείας των ${MAX_REQUESTS} requests — σταματάει το script.`);
  }
  requestCount++;

  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: String(Math.round(radiusMeters)),
    type: categoryDef.googleType,
    key: API_KEY,
    language: 'el',
  });
  if (categoryDef.keyword) params.set('keyword', categoryDef.keyword);
  if (pageToken) params.set('pagetoken', pageToken);

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`;
  const res = await fetch(url);
  return res.json();
}

/** Τραβάει έως 60 αποτελέσματα (3 σελίδες) για ΕΝΑΝ κύκλο. */
async function fetchAllPagesForCircle(lat, lng, radiusMeters, categoryDef) {
  const results = [];
  let pageToken = null;

  for (let page = 0; page < 3; page++) {
    const data = await nearbySearchPage(lat, lng, radiusMeters, categoryDef, pageToken);

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`      ⚠️  ${data.status} — ${data.error_message || ''}`);
      break;
    }

    results.push(...(data.results || []));

    if (data.next_page_token) {
      pageToken = data.next_page_token;
      await sleep(PAGE_TOKEN_DELAY_MS);
    } else {
      break;
    }
  }

  return results;
}

/** Αναδρομική αναζήτηση: σπάει σε 4 τεταρτημόρια όποτε ένας κύκλος "γεμίζει". */
async function recursiveSearch(lat, lng, radiusMeters, categoryDef, depth, seenMap) {
  const results = await fetchAllPagesForCircle(lat, lng, radiusMeters, categoryDef);

  for (const place of results) {
    if (!seenMap.has(place.place_id)) {
      const rating = place.rating ?? null;
      seenMap.set(place.place_id, {
        name: place.name,
        desc: place.vicinity || '',
        lat: place.geometry?.location?.lat,
        lng: place.geometry?.location?.lng,
        placeId: place.place_id,
        rating,
        featured: rating !== null && rating >= FEATURED_RATING_THRESHOLD,
      });
    }
  }

  const isFull = results.length >= 60;
  const canSubdivide = radiusMeters / 2 >= MIN_RADIUS_METERS && depth < MAX_DEPTH;

  if (isFull && canSubdivide) {
    const newRadius = radiusMeters / 2;
    const dLat = metersToLatDegrees(newRadius);
    const dLng = metersToLngDegrees(newRadius, lat);

    const quadrants = [
      [lat + dLat, lng + dLng],
      [lat + dLat, lng - dLng],
      [lat - dLat, lng + dLng],
      [lat - dLat, lng - dLng],
    ];

    for (const [qLat, qLng] of quadrants) {
      await sleep(DELAY_MS);
      await recursiveSearch(qLat, qLng, newRadius, categoryDef, depth + 1, seenMap);
    }
  }
}

async function fetchRegionCategory(region, categoryDef) {
  const gridPoints = generateGrid(region.bbox, GRID_RADIUS_METERS);
  const seenMap = new Map();

  for (const point of gridPoints) {
    await recursiveSearch(point.lat, point.lng, GRID_RADIUS_METERS, categoryDef, 0, seenMap);
    await sleep(DELAY_MS);
  }

  return { places: Array.from(seenMap.values()), gridPointCount: gridPoints.length };
}

async function main() {
  const output = {};
  const regionKeys = RUN_ONLY_REGION ? [RUN_ONLY_REGION] : Object.keys(regions);
  const categoryKeys = RUN_ONLY_CATEGORY ? [RUN_ONLY_CATEGORY] : Object.keys(categories);

  // Εκτίμηση πριν ξεκινήσουμε, ώστε να ξέρεις το μέγεθος του τρεξίματος.
  console.log('📐 Μέγεθος πλέγματος ανά περιοχή (πριν την αναδρομή):');
  for (const regionKey of regionKeys) {
    const grid = generateGrid(regions[regionKey].bbox, GRID_RADIUS_METERS);
    console.log(`   ${regions[regionKey].label}: ${grid.length} αρχικά σημεία πλέγματος`);
  }
  console.log('');

  for (const categoryKey of categoryKeys) {
    output[categoryKey] = {};

    for (const regionKey of regionKeys) {
      const region = regions[regionKey];
      process.stdout.write(`→ ${categoryKey} / ${region.label}... `);

      const { places, gridPointCount } = await fetchRegionCategory(region, categories[categoryKey]);
      output[categoryKey][regionKey] = places;

      const featuredCount = places.filter((p) => p.featured).length;
      console.log(
        `${places.length} μοναδικά μέρη (${featuredCount} featured 4.8+) — ${gridPointCount} αρχικά σημεία, ${requestCount} requests συνολικά μέχρι τώρα`
      );
    }
  }

  fs.writeFileSync('places.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n✅ Αποθηκεύτηκε στο places.json (${requestCount} requests συνολικά)`);
  if (RUN_ONLY_REGION || RUN_ONLY_CATEGORY) {
    console.log('ℹ️  Έτρεξε περιορισμένα (βλ. RUN_ONLY_REGION / RUN_ONLY_CATEGORY). Βάλε null και στα δύο για όλη την Κρήτη, όλες τις κατηγορίες.');
  }
}

main().catch((err) => {
  console.error('❌ Σφάλμα:', err.message);
  process.exit(1);
});
/**
 * server.js
 *
 * Απλός Express server που φορτώνει το places.json ΜΙΑ ΦΟΡΑ στη μνήμη κατά
 * την εκκίνηση, και το σερβίρει δυναμικά μέσω API — έτσι το frontend δεν
 * κατεβάζει ποτέ ολόκληρο το dataset (~12.600 μέρη), μόνο ό,τι ζητάει κάθε φορά.
 *
 * ΧΡΗΣΗ:
 *   1. Βάλε το places.json στον ίδιο φάκελο με αυτό το αρχείο.
 *   2. npm install express
 *   3. node server.js
 *   4. Δοκίμασε στον browser:
 *      http://localhost:3000/api/places?category=cafe&region=chania
 *      http://localhost:3000/api/places?category=cafe&region=chania&featured=true
 *      http://localhost:3000/api/places?category=food&region=irakleio&limit=20&offset=0
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Φόρτωση δεδομένων στη μνήμη, μία φορά, κατά την εκκίνηση.
const DATA_PATH = path.join(__dirname, 'places.json');
let placesData = {};

function loadData() {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  placesData = JSON.parse(raw);
  const totalCount = Object.values(placesData)
    .flatMap((byRegion) => Object.values(byRegion))
    .reduce((sum, arr) => sum + arr.length, 0);
  console.log(`✅ Φορτώθηκαν ${totalCount} μέρη στη μνήμη από places.json`);
}

loadData();

// ─── Επιτρέπει requests από τη σελίδα σου (CORS). Σε production, περιόρισέ το
// στο δικό σου domain αντί για '*'.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

/** Απόσταση σε km ανάμεσα σε δύο σημεία (haversine formula). */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // ακτίνα Γης σε km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Τυχαία ανακάτεμα πίνακα (Fisher-Yates), χωρίς να πειράζει το πρωτότυπο. */
function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * GET /api/places
 * Query params:
 *   category  (υποχρεωτικό)  π.χ. cafe, food, sights, fun, beach
 *   region    (υποχρεωτικό)  π.χ. irakleio, chania, rethymno, lasithi
 *   featured  (προαιρετικό)  'true' → μόνο μέρη με rating >= 4.8 (ταξινομημένα με το καλύτερο πρώτο)
 *   sort      (προαιρετικό)  'random' | 'distance' (default: όπως είναι αποθηκευμένα)
 *   lat, lng  (υποχρεωτικά ΑΝ sort=distance) — η τοποθεσία του χρήστη
 *   limit     (προαιρετικό)  πόσα να επιστρέψει (default 30)
 *   offset    (προαιρετικό)  από πού να ξεκινήσει (για pagination — ΜΗΝ το συνδυάζεις με sort=random,
 *                            αφού η σειρά αλλάζει σε κάθε request)
 */
app.get('/api/places', (req, res) => {
  const { category, region, featured, sort, lat, lng, limit, offset } = req.query;

  if (!category || !region) {
    return res.status(400).json({ error: 'Χρειάζονται τα query params: category, region' });
  }

  const byCategory = placesData[category];
  if (!byCategory) {
    return res.status(404).json({ error: `Άγνωστη κατηγορία: ${category}` });
  }

  let places = byCategory[region] || [];

  if (featured === 'true') {
    places = places.filter((p) => p.featured);
    places = [...places].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  }

  if (sort === 'random') {
    places = shuffle(places);
  } else if (sort === 'distance') {
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    if (Number.isNaN(userLat) || Number.isNaN(userLng)) {
      return res.status(400).json({ error: "Για sort=distance χρειάζονται έγκυρα lat & lng" });
    }
    places = [...places]
      .map((p) => ({ ...p, distanceKm: distanceKm(userLat, userLng, p.lat, p.lng) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  const total = places.length;
  const limitNum = Math.min(parseInt(limit, 10) || 30, 100); // ασφαλιστικό ανώτατο όριο 100
  const offsetNum = parseInt(offset, 10) || 0;

  const page = places.slice(offsetNum, offsetNum + limitNum);

  res.json({
    total,
    limit: limitNum,
    offset: offsetNum,
    hasMore: offsetNum + limitNum < total,
    places: page,
  });
});

/**
 * GET /api/places/featured
 * Επιστρέφει τα featured (4.8+) μέρη μιας περιοχής, σε ΟΛΕΣ τις κατηγορίες μαζί.
 * Χρήσιμο για ένα "Τα καλύτερα της περιοχής" tab.
 */
app.get('/api/places/featured', (req, res) => {
  const { region, limit } = req.query;
  if (!region) {
    return res.status(400).json({ error: 'Χρειάζεται το query param: region' });
  }

  const limitNum = Math.min(parseInt(limit, 10) || 30, 100);
  const results = [];

  for (const [categoryKey, byRegion] of Object.entries(placesData)) {
    const places = byRegion[region] || [];
    for (const place of places) {
      if (place.featured) {
        results.push({ ...place, category: categoryKey });
      }
    }
  }

  // Ταξινόμηση με το υψηλότερο rating πρώτα
  results.sort((a, b) => (b.rating || 0) - (a.rating || 0));

  res.json({ total: results.length, places: results.slice(0, limitNum) });
});

// ─── Endpoint υγείας, χρήσιμο για να ελέγχεις ότι ο server τρέχει.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server τρέχει στο http://localhost:${PORT}`);
});